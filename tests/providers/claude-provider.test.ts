import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../../src/lib/command-runner.js";
import { LockError } from "../../src/lib/lock.js";
import { acquireOauthRefreshLock } from "../../src/lib/oauth-refresh-lock.js";
import { ClaudeUsageProvider, type ClaudeUsageProviderOptions } from "../../src/providers/claude-provider.js";

const ACCESS_TOKEN = "test-access-token";

/** Credentials JSON shape Claude Code persists (keychain blob or file). */
function credentialsJson(token = ACCESS_TOKEN): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token } });
}

/** Build a fully-populated usage body with the four rolling-window buckets. */
function usageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_type: "max",
    five_hour: { utilization: 12, resets_at: "2026-06-22T10:00:00.000Z" },
    seven_day: { utilization: 34, resets_at: "2026-06-28T10:00:00.000Z" },
    seven_day_sonnet: { utilization: 56, resets_at: "2026-06-28T11:00:00.000Z" },
    seven_day_opus: { utilization: 78, resets_at: "2026-06-28T12:00:00.000Z" },
    ...overrides,
  };
}

/** Minimal `Response`-like double honoring the fields the provider touches. */
function fakeResponse(init: {
  ok: boolean;
  status: number;
  body?: unknown;
  retryAfter?: string;
  text?: string;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? (init.retryAfter ?? null) : null,
    },
    json: async () => init.body,
    text: async () => init.text ?? "",
  } as unknown as Response;
}

/** A command runner whose single invocation returns the given result. */
function fakeRunner(result: Partial<CommandResult>): CommandRunner {
  return {
    run: () => ({ exitCode: 0, stdout: "", stderr: "", ...result }),
  };
}

/** A pid in the allowed range that `kill(pid, 0)` reports as `ESRCH`. Signal 0 does not kill. */
function unusedPid(): number {
  for (const pid of [2_147_483_647, 2_147_483_646, 2_147_483_645, 2_147_483_644]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("could not find an unused pid for the dead-holder fixture");
}

/** Runner whose `security` call fails, forcing the credentials-file fallback. */
function failingRunner(): CommandRunner {
  return {
    run: () => ({ exitCode: 1, stdout: "", stderr: "not found" }),
  };
}

/** Provider wired so token resolution and fetch never touch the real host. */
function makeProvider(
  body: unknown,
  overrides: Partial<ClaudeUsageProviderOptions> = {},
): ClaudeUsageProvider {
  return new ClaudeUsageProvider({
    platform: "linux",
    readFile: () => credentialsJson(),
    fetchImpl: (async () => fakeResponse({ ok: true, status: 200, body })) as unknown as typeof fetch,
    ...overrides,
  });
}

describe("ClaudeUsageProvider token resolution", () => {
  it("uses the macOS keychain first", async () => {
    const runner = fakeRunner({ stdout: credentialsJson("keychain-token") });
    const runSpy = vi.spyOn(runner, "run");
    let seenAuth: string | undefined;

    const provider = new ClaudeUsageProvider({
      platform: "darwin",
      commandRunner: runner,
      readFile: () => {
        throw new Error("file should not be read when keychain succeeds");
      },
      fetchImpl: (async (_url: string, opts: RequestInit) => {
        seenAuth = (opts.headers as Record<string, string>).Authorization;
        return fakeResponse({ ok: true, status: 200, body: usageBody() });
      }) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(runSpy).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      expect.anything(),
    );
    expect(seenAuth).toBe("Bearer keychain-token");
  });

  it("falls back to the credentials file when the keychain command fails", async () => {
    let seenAuth: string | undefined;
    const provider = new ClaudeUsageProvider({
      platform: "darwin",
      commandRunner: failingRunner(),
      readFile: () => credentialsJson("file-token"),
      fetchImpl: (async (_url: string, opts: RequestInit) => {
        seenAuth = (opts.headers as Record<string, string>).Authorization;
        return fakeResponse({ ok: true, status: 200, body: usageBody() });
      }) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(seenAuth).toBe("Bearer file-token");
  });

  it("reads the credentials file directly on non-darwin platforms", async () => {
    let seenPath: string | undefined;
    const provider = new ClaudeUsageProvider({
      platform: "linux",
      readFile: (path: string) => {
        seenPath = path;
        return credentialsJson("linux-token");
      },
      homeDir: "/home/tester",
      fetchImpl: (async () =>
        fakeResponse({ ok: true, status: 200, body: usageBody() })) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(seenPath).toBe("/home/tester/.claude/.credentials.json");
  });

  it("honors the configDir override when locating the credentials file", async () => {
    let seenPath: string | undefined;
    const provider = new ClaudeUsageProvider({
      platform: "linux",
      configDir: "/custom/claude",
      readFile: (path: string) => {
        seenPath = path;
        return credentialsJson();
      },
      fetchImpl: (async () =>
        fakeResponse({ ok: true, status: 200, body: usageBody() })) as unknown as typeof fetch,
    });

    await provider.getUsage();
    expect(seenPath).toBe("/custom/claude/.credentials.json");
  });
});

describe("ClaudeUsageProvider bucket mapping", () => {
  it("maps all four buckets to labeled windows with epoch-ms resets", async () => {
    const provider = makeProvider(usageBody());
    const snapshot = await provider.getUsage();

    expect(snapshot).toEqual({
      service: "claude",
      planType: "max",
      windows: [
        { label: "5h", usedPercent: 12, resetsAt: Date.parse("2026-06-22T10:00:00.000Z") },
        { label: "weekly", usedPercent: 34, resetsAt: Date.parse("2026-06-28T10:00:00.000Z") },
        { label: "weekly-sonnet", usedPercent: 56, resetsAt: Date.parse("2026-06-28T11:00:00.000Z") },
        { label: "weekly-opus", usedPercent: 78, resetsAt: Date.parse("2026-06-28T12:00:00.000Z") },
      ],
    });
  });

  it("treats a null bucket (Enterprise) as zero usage with no scheduled reset", async () => {
    const provider = makeProvider(usageBody({ seven_day_opus: null }));
    const snapshot = await provider.getUsage();

    expect(snapshot.windows).toContainEqual({ label: "weekly-opus", usedPercent: 0, resetsAt: 0 });
  });

  it("keeps a bucket's utilization when only its resets_at is null (per-model sub-bucket)", async () => {
    // Live shape: `seven_day_sonnet` reports utilization but no independent
    // reset (`resets_at: null`); it must not invalidate the whole snapshot.
    const provider = makeProvider(
      usageBody({ seven_day_sonnet: { utilization: 0, resets_at: null } }),
    );
    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.windows).toContainEqual({ label: "weekly-sonnet", usedPercent: 0, resetsAt: 0 });
  });

  it("defaults planType to empty string when the body has no tier field", async () => {
    const provider = makeProvider(usageBody({ plan_type: undefined }));
    const snapshot = await provider.getUsage();
    expect(snapshot.planType).toBe("");
  });
});

describe("ClaudeUsageProvider failure modes", () => {
  it("returns an unavailable snapshot when no token is found", async () => {
    const provider = new ClaudeUsageProvider({
      platform: "linux",
      readFile: () => {
        throw new Error("ENOENT");
      },
      fetchImpl: (async () => {
        throw new Error("fetch should not run without a token");
      }) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot).toEqual({
      service: "claude",
      planType: "",
      windows: [],
      unavailableReason: "no Claude Code OAuth token found",
    });
  });

  it("returns an unavailable snapshot on a non-200 response", async () => {
    const provider = makeProvider(undefined, {
      fetchImpl: (async () =>
        fakeResponse({ ok: false, status: 500 })) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.unavailableReason).toContain("500");
  });

  it("does not retry a 429, and reports it as rate-limited", async () => {
    let calls = 0;
    const provider = makeProvider(undefined, {
      fetchImpl: (async () => {
        calls += 1;
        return fakeResponse({ ok: false, status: 429, retryAfter: "0" });
      }) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    // The limiter needs about a minute to recover, far longer than this request's
    // whole budget, so retrying inside the call could only fail again.
    expect(calls).toBe(1);
    expect(snapshot.unavailableKind).toBe("rate-limited");
    expect(snapshot.unavailableReason).toContain("429");
    // `retry-after: 0` is not a usable wait, so no deadline is passed on.
    expect(snapshot.retryAfter).toBeUndefined();
  });

  it("passes on a positive retry-after as an absolute deadline", async () => {
    const now = Date.parse("2026-06-22T09:00:00.000Z");
    const provider = makeProvider(undefined, {
      now: () => now,
      fetchImpl: (async () =>
        fakeResponse({ ok: false, status: 429, retryAfter: "30" })) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.retryAfter).toBe(now + 30_000);
  });

  it("reports an aborted request as a timeout", async () => {
    const provider = makeProvider(undefined, {
      fetchImpl: (async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toContain("timed out");
  });

  it("returns an unavailable snapshot when the body is malformed", async () => {
    const provider = makeProvider("not an object");
    const snapshot = await provider.getUsage();
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.unavailableReason).toBe("malformed usage response");
  });

  it("returns an unavailable snapshot when the body has no recognized buckets", async () => {
    const provider = makeProvider({ plan_type: "max" });
    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBe("usage response had no recognized buckets");
  });

  it("returns an unavailable snapshot when fetch throws", async () => {
    const provider = makeProvider(undefined, {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBe("network down");
  });
});

/**
 * Refresh tests use a temp config directory and injected IO. They must not open
 * the real `~/.claude/.credentials.json`. Tokens below are fixtures.
 */
describe("ClaudeUsageProvider token refresh", () => {
  const NOW = Date.parse("2026-10-13T18:00:00.000Z");
  const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
  const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
  const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  const DEFAULT_SCOPE = [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ].join(" ");

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-oauth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function credentialsPath(): string {
    return join(dir, ".credentials.json");
  }

  function writeOauth(
    oauth: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void {
    writeFileSync(credentialsPath(), JSON.stringify({ ...extra, claudeAiOauth: oauth }), { mode: 0o600 });
  }

  function readRaw(): string {
    return readFileSync(credentialsPath(), "utf8");
  }

  function authorization(init: RequestInit | undefined): string | undefined {
    const headers = init?.headers;
    if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
      return undefined;
    }
    return headers.Authorization;
  }

  function provider(fetchImpl: typeof fetch, overrides: Partial<ClaudeUsageProviderOptions> = {}): ClaudeUsageProvider {
    return new ClaudeUsageProvider({
      platform: "linux",
      configDir: dir,
      now: () => NOW,
      fetchImpl,
      ...overrides,
    });
  }

  /** Routes the two endpoints the provider calls. Any other URL fails the test. */
  function routedFetch(handlers: {
    onToken?: (init: RequestInit) => Response | Promise<Response>;
    onUsage?: (init: RequestInit) => Response | Promise<Response>;
  }): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) {
        if (handlers.onToken === undefined) {
          throw new Error("token endpoint should not be called");
        }
        return handlers.onToken(init ?? {});
      }
      if (url === USAGE_URL) {
        if (handlers.onUsage === undefined) {
          throw new Error("usage endpoint should not be called");
        }
        return handlers.onUsage(init ?? {});
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;
  }

  function usageOk(): Response {
    return fakeResponse({ ok: true, status: 200, body: usageBody() });
  }

  function tokenOk(
    accessToken: string,
    refreshToken: string,
    expiresIn = 28_800,
    extra: Record<string, unknown> = {},
  ): Response {
    return fakeResponse({
      ok: true,
      status: 200,
      body: { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, ...extra },
    });
  }

  it("does not refresh a token that is outside the five-minute window", async () => {
    let usageAuth: string | undefined;
    const reading = provider(routedFetch({
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    }), {
      readFile: () => JSON.stringify({
        claudeAiOauth: { accessToken: "live-access", expiresAt: NOW + 300_001 },
      }),
      statMtime: () => {
        throw new Error("should not stat");
      },
      writeFileAtomic: () => {
        throw new Error("should not write");
      },
    });

    const snapshot = await reading.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer live-access");
  });

  it("refreshes when the token is exactly five minutes from expiry", async () => {
    writeOauth({
      accessToken: "soon-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW + 300_000,
      scopes: ["user:inference"],
    });
    let posts = 0;
    const reading = provider(routedFetch({
      onToken: () => {
        posts += 1;
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        expect(authorization(init)).toBe("Bearer new-access");
        return usageOk();
      },
    }));

    const snapshot = await reading.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(posts).toBe(1);
  });

  it("refreshes an expired token, keeps the other fields, and does not post twice", async () => {
    writeOauth(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-token-1",
        expiresAt: NOW - 1_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
        extraField: "keep",
        refreshTokenExpiresAt: 111,
      },
      { mcpOAuth: { server: "keep" } },
    );
    const posts: unknown[] = [];
    const usageAuths: Array<string | undefined> = [];
    const reading = provider(routedFetch({
      onToken: (init) => {
        posts.push(JSON.parse(String(init.body)));
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        usageAuths.push(authorization(init));
        return usageOk();
      },
    }));

    const first = await reading.getUsage();
    const second = await reading.getUsage();

    expect(first.unavailableReason).toBeUndefined();
    expect(second.unavailableReason).toBeUndefined();
    expect(posts).toEqual([
      {
        grant_type: "refresh_token",
        refresh_token: "refresh-token-1",
        client_id: CLIENT_ID,
        scope: "user:inference user:profile",
      },
    ]);
    expect(usageAuths).toEqual(["Bearer new-access", "Bearer new-access"]);
    const saved = JSON.parse(readRaw()) as {
      mcpOAuth: unknown;
      claudeAiOauth: Record<string, unknown>;
    };
    expect(saved.mcpOAuth).toEqual({ server: "keep" });
    expect(saved.claudeAiOauth.accessToken).toBe("new-access");
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-token-2");
    expect(saved.claudeAiOauth.expiresAt).toBe(NOW + 28_800_000);
    expect(saved.claudeAiOauth.subscriptionType).toBe("max");
    expect(saved.claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x");
    expect(saved.claudeAiOauth.extraField).toBe("keep");
    expect(saved.claudeAiOauth.refreshTokenExpiresAt).toBe(111);
    expect(saved.claudeAiOauth.scopes).toEqual(["user:inference", "user:profile"]);
    expect(saved.claudeAiOauth.clientId).toBeUndefined();
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(false);
    expect(existsSync(join(dir, ".storage-write.lock"))).toBe(false);
    expect(existsSync(join(dir, ".storage-write.lock.owner"))).toBe(false);
    expect(readRaw()).not.toContain("refresh-token-1");
    expect(readRaw()).not.toContain("expired-access");
  });

  it("stores a returned refresh-token expiry", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
      refreshTokenExpiresAt: 111,
    });
    const snapshot = await provider(routedFetch({
      onToken: () => tokenOk("new-access", "refresh-token-2", 28_800, { refresh_token_expires_in: 3600 }),
      onUsage: () => usageOk(),
    })).getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    const saved = JSON.parse(readRaw()) as { claudeAiOauth: { refreshTokenExpiresAt?: number } };
    expect(saved.claudeAiOauth.refreshTokenExpiresAt).toBe(NOW + 3_600_000);
  });

  it("does not post or write while the storage lock is held", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const storage = join(dir, ".storage-write.lock");
    mkdirSync(storage);
    const before = readRaw();
    let posts = 0;
    const snapshot = await provider(routedFetch({
      onToken: () => {
        posts += 1;
        return tokenOk("new-access", "refresh-token-2");
      },
    }), { storageLockRetryMs: [] }).getUsage();

    expect(posts).toBe(0);
    expect(snapshot.unavailableReason).toBe("Claude credential storage lock is already held");
    expect(snapshot.windows).toEqual([]);
    expect(readRaw()).toBe(before);
    expect(existsSync(storage)).toBe(true);
    expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(false);
  });

  it("posts the refresh token re-read after the storage lock is held", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    let posted: string | undefined;
    const snapshot = await provider(routedFetch({
      onToken: (init) => {
        posted = (JSON.parse(String(init.body)) as { refresh_token?: string }).refresh_token;
        return tokenOk("new-access", "refresh-token-3");
      },
      onUsage: (init) => {
        expect(authorization(init)).toBe("Bearer new-access");
        return usageOk();
      },
    }), {
      acquireStorageLock: () => {
        writeOauth({
          accessToken: "expired-access",
          refreshToken: "refresh-token-2",
          expiresAt: NOW - 1,
        });
        return {
          lockPath: join(dir, ".storage-write.lock"),
          compromised: () => false,
          release() {
            return undefined;
          },
        };
      },
    }).getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(posted).toBe("refresh-token-2");
  });

  it("skips the post when the re-read under the storage lock is already fresh", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    let posts = 0;
    let usageAuth: string | undefined;
    const snapshot = await provider(routedFetch({
      onToken: () => {
        posts += 1;
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    }), {
      acquireStorageLock: () => {
        writeOauth({
          accessToken: "sibling-access",
          refreshToken: "sibling-refresh",
          expiresAt: NOW + 3_600_000,
        });
        return {
          lockPath: join(dir, ".storage-write.lock"),
          compromised: () => false,
          release() {
            return undefined;
          },
        };
      },
    }).getUsage();

    expect(posts).toBe(0);
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer sibling-access");
  });

  it("sends a stored client id and the default scopes when the credential names none", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
      clientId: "stored-client",
    });
    let body: Record<string, unknown> | undefined;
    await provider(routedFetch({
      onToken: (init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return tokenOk("new-access", "refresh-token-1", 3600);
      },
      onUsage: () => usageOk(),
    })).getUsage();

    expect(body?.client_id).toBe("stored-client");
    expect(body?.scope).toBe(DEFAULT_SCOPE);
    expect(body?.expires_in).toBeUndefined();
  });

  it("keeps the posted refresh token when the response omits one", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    await provider(routedFetch({
      onToken: () => fakeResponse({
        ok: true,
        status: 200,
        body: { access_token: "new-access", expires_in: 3600 },
      }),
      onUsage: () => usageOk(),
    })).getUsage();

    const saved = JSON.parse(readRaw()) as { claudeAiOauth: { refreshToken: string } };
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-token-1");
  });

  it("does not call usage when the refresh fails, and does not echo the token", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const before = readRaw();
    let usageCalls = 0;
    const snapshot = await provider(routedFetch({
      onToken: () => {
        throw new Error("network down refresh-token-1");
      },
      onUsage: () => {
        usageCalls += 1;
        return usageOk();
      },
    })).getUsage();

    expect(usageCalls).toBe(0);
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.unavailableReason).toContain("Claude OAuth refresh failed");
    expect(snapshot.unavailableReason).not.toContain("refresh-token-1");
    expect(snapshot.unavailableReason).not.toContain("expired-access");
    expect(readRaw()).toBe(before);
  });

  it("does not call usage when the token endpoint rejects the grant", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const before = readRaw();
    const snapshot = await provider(routedFetch({
      onToken: () => fakeResponse({
        ok: false,
        status: 400,
        text: "invalid_grant refresh-token-1",
      }),
    })).getUsage();

    expect(snapshot.unavailableReason).toBe("Claude OAuth refresh failed: HTTP 400");
    expect(snapshot.unavailableReason).not.toContain("refresh-token-1");
    expect(readRaw()).toBe(before);
  });

  it("does not repeat a token-response parse error that quotes the body", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const snapshot = await provider(routedFetch({
      onToken: () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("Unexpected token new-access in JSON at position 0");
        },
      }) as unknown as Response,
    })).getUsage();

    expect(snapshot.unavailableReason).toBe("Claude OAuth refresh response was not JSON");
    expect(JSON.stringify(snapshot)).not.toContain("new-access");
    expect(JSON.stringify(snapshot)).not.toContain("refresh-token-1");
  });

  it("reports a rate-limited refresh and does not call usage with the expired token", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const snapshot = await provider(routedFetch({
      onToken: () => fakeResponse({ ok: false, status: 429, retryAfter: "30" }),
    })).getUsage();

    expect(snapshot.unavailableKind).toBe("rate-limited");
    expect(snapshot.retryAfter).toBe(NOW + 30_000);
    expect(snapshot.unavailableReason).not.toContain("expired-access");
  });

  it("does not call usage when the expired credential has no refresh token", async () => {
    writeOauth({ accessToken: "expired-access", expiresAt: NOW - 1 });
    const snapshot = await provider(routedFetch({})).getUsage();
    expect(snapshot.unavailableReason).toBe("Claude OAuth refresh token missing");
    expect(snapshot.windows).toEqual([]);
  });

  it("skips the refresh when the lock directory is already held", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    mkdirSync(join(dir, ".oauth_refresh.lock"));
    const snapshot = await provider(routedFetch({})).getUsage();

    expect(snapshot.unavailableReason).toBe("Claude OAuth refresh is already in progress");
    expect(snapshot.windows).toEqual([]);
    expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(true);
  });

  it("uses a fresh token it sees after losing the lock, and does not post", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    let usageAuth: string | undefined;
    const snapshot = await provider(routedFetch({
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    }), {
      acquireRefreshLock: () => {
        writeOauth({
          accessToken: "sibling-access",
          refreshToken: "sibling-refresh",
          expiresAt: NOW + 3_600_000,
        });
        throw new LockError("held");
      },
    }).getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer sibling-access");
  });

  it("re-reads under the lock and skips the post when the token is already fresh", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    let usageAuth: string | undefined;
    let locked = false;
    const snapshot = await provider(routedFetch({
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    }), {
      acquireRefreshLock: (lockPath) => {
        writeOauth({
          accessToken: "sibling-access",
          refreshToken: "sibling-refresh",
          expiresAt: NOW + 3_600_000,
        });
        const handle = acquireOauthRefreshLock(lockPath);
        locked = existsSync(lockPath);
        return handle;
      },
    }).getUsage();

    expect(locked).toBe(true);
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer sibling-access");
    expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(false);
  });

  it("does not overwrite a refresh token a sibling saved, and uses the sibling access token", async () => {
    writeOauth(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-token-1",
        expiresAt: NOW - 1,
        extraField: "keep",
      },
      { mcpOAuth: { server: "keep" } },
    );
    const sibling = JSON.stringify({
      mcpOAuth: { server: "keep" },
      claudeAiOauth: {
        accessToken: "sibling-access",
        refreshToken: "sibling-refresh",
        expiresAt: NOW + 3_600_000,
        extraField: "keep",
      },
    });
    let usageAuth: string | undefined;
    const snapshot = await provider(routedFetch({
      onToken: () => {
        writeFileSync(credentialsPath(), sibling);
        return tokenOk("our-access", "our-refresh");
      },
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    })).getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer sibling-access");
    expect(readRaw()).toBe(sibling);
  });

  it("writes over an empty refresh token a sibling left, since that is not a new grant", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    await provider(routedFetch({
      onToken: () => {
        writeOauth({
          accessToken: "expired-access",
          refreshToken: "",
          expiresAt: NOW - 1,
        });
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        expect(authorization(init)).toBe("Bearer new-access");
        return usageOk();
      },
    })).getUsage();

    const saved = JSON.parse(readRaw()) as { claudeAiOauth: { refreshToken: string; accessToken: string } };
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-token-2");
    expect(saved.claudeAiOauth.accessToken).toBe("new-access");
  });

  it("does not write or call usage when the refresh lock is lost during the post", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const before = readRaw();
    let lost = false;
    let usageCalls = 0;
    const snapshot = await provider(routedFetch({
      onToken: () => {
        lost = true;
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: () => {
        usageCalls += 1;
        return usageOk();
      },
    }), {
      acquireRefreshLock: () => ({
        lockPath: join(dir, ".oauth_refresh.lock"),
        compromised: () => lost,
        release() {
          return undefined;
        },
      }),
    }).getUsage();

    expect(usageCalls).toBe(0);
    expect(snapshot.unavailableReason).toBe("Claude OAuth refresh lock was lost");
    expect(snapshot.unavailableReason).not.toContain("refresh-token-1");
    expect(snapshot.unavailableReason).not.toContain("expired-access");
    expect(snapshot.unavailableReason).not.toContain("new-access");
    expect(readRaw()).toBe(before);
  });

  it("uses a fresh on-disk token when the refresh lock is lost during the post", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    let lost = false;
    let usageAuth: string | undefined;
    const sibling = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sibling-access",
        refreshToken: "sibling-refresh",
        expiresAt: NOW + 3_600_000,
      },
    });
    const snapshot = await provider(routedFetch({
      onToken: () => {
        lost = true;
        writeFileSync(credentialsPath(), sibling);
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    }), {
      acquireRefreshLock: () => ({
        lockPath: join(dir, ".oauth_refresh.lock"),
        compromised: () => lost,
        release() {
          return undefined;
        },
      }),
    }).getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer sibling-access");
    expect(readRaw()).toBe(sibling);
  });

  it("reports the mtime of a refresh it wrote, and nothing when the refresh did not write", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const failed = provider(routedFetch({
      onToken: () => fakeResponse({ ok: false, status: 400 }),
    }), { statMtime: () => 1234 });
    await failed.getUsage();
    expect(failed.wroteCredentialRevision()).toBeUndefined();

    const wrote = provider(routedFetch({
      onToken: () => tokenOk("new-access", "refresh-token-2"),
      onUsage: () => usageOk(),
    }), { statMtime: () => 5678 });
    expect(wrote.wroteCredentialRevision()).toBeUndefined();
    await wrote.getUsage();
    expect(wrote.wroteCredentialRevision()).toBe(5678);
  });

  it("records the credential revision before releasing the storage lock", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    let storageReleased = false;
    let statAfterRelease = false;
    const reading = provider(routedFetch({
      onToken: () => tokenOk("new-access", "refresh-token-2"),
      onUsage: () => usageOk(),
    }), {
      acquireStorageLock: () => ({
        lockPath: join(dir, ".storage-write.lock"),
        compromised: () => false,
        release() {
          storageReleased = true;
        },
      }),
      statMtime: () => {
        if (storageReleased) statAfterRelease = true;
        return 4242;
      },
    });

    await reading.getUsage();
    expect(reading.wroteCredentialRevision()).toBe(4242);
    expect(storageReleased).toBe(true);
    expect(statAfterRelease).toBe(false);
  });

  it("does not call usage when the sibling token is also expired", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const sibling = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sibling-expired",
        refreshToken: "sibling-refresh",
        expiresAt: NOW - 1,
      },
    });
    let usageCalls = 0;
    const snapshot = await provider(routedFetch({
      onToken: () => {
        writeFileSync(credentialsPath(), sibling);
        return tokenOk("our-access", "our-refresh");
      },
      onUsage: () => {
        usageCalls += 1;
        return usageOk();
      },
    })).getUsage();

    expect(usageCalls).toBe(0);
    expect(snapshot.unavailableReason).toBe("Claude OAuth credentials changed during refresh");
    expect(snapshot.unavailableReason).not.toContain("sibling-refresh");
    expect(readRaw()).toBe(sibling);
  });

  it("does not refresh while a stale lock directory is still there", async () => {
    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const lockPath = join(dir, ".oauth_refresh.lock");
    mkdirSync(lockPath);
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);
    const before = readRaw();
    const snapshot = await provider(routedFetch({})).getUsage();

    expect(snapshot.unavailableReason).toBe("Claude OAuth refresh is already in progress");
    expect(snapshot.windows).toEqual([]);
    expect(readRaw()).toBe(before);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("refreshes after taking over a lock whose owner process is dead", async () => {
    const scratch = join(dir, ".identity.lock");
    const identityLock = acquireOauthRefreshLock(scratch);
    const identity = JSON.parse(readFileSync(`${scratch}.owner`, "utf8")) as {
      pidDomain: string;
      pidSpace: string;
    };
    identityLock.release();

    writeOauth({
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: NOW - 1,
    });
    const lockPath = join(dir, ".oauth_refresh.lock");
    mkdirSync(lockPath);
    const deadPid = unusedPid();
    writeFileSync(`${lockPath}.owner`, JSON.stringify({
      pid: deadPid,
      pidDomain: identity.pidDomain,
      pidSpace: identity.pidSpace,
      lockBirthtimeMs: statSync(lockPath).birthtimeMs,
    }), { mode: 0o600 });

    let usageAuth: string | undefined;
    const snapshot = await provider(routedFetch({
      onToken: (init) => {
        const body = JSON.parse(String(init.body)) as { refresh_token?: string };
        expect(body.refresh_token).toBe("refresh-token-1");
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    })).getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer new-access");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.owner`)).toBe(false);
    const saved = JSON.parse(readRaw()) as { claudeAiOauth: { refreshToken?: string } };
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-token-2");
  });

  it("lets one of two racing refreshes post, and the other does not call usage", async () => {
    writeOauth(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-token-1",
        expiresAt: NOW - 1,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        extraField: "keep",
      },
      { mcpOAuth: { server: "keep" } },
    );

    let posts = 0;
    const usageAuths: Array<string | undefined> = [];
    let releasePost: () => void = () => undefined;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let markPostStarted: () => void = () => undefined;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });

    const fetchImpl = routedFetch({
      onToken: async (init) => {
        posts += 1;
        const body = JSON.parse(String(init.body)) as { refresh_token?: string };
        expect(body.refresh_token).toBe("refresh-token-1");
        markPostStarted();
        await postGate;
        return tokenOk("new-access", "refresh-token-2");
      },
      onUsage: (init) => {
        usageAuths.push(authorization(init));
        return usageOk();
      },
    });
    const options: ClaudeUsageProviderOptions = {
      platform: "linux",
      configDir: dir,
      now: () => NOW,
      fetchImpl,
    };
    const first = new ClaudeUsageProvider(options).getUsage();
    await postStarted;
    const second = await new ClaudeUsageProvider(options).getUsage();

    expect(posts).toBe(1);
    expect(usageAuths).toEqual([]);
    expect(second.unavailableReason).toBe("Claude OAuth refresh is already in progress");
    expect(second.windows).toEqual([]);
    expect(JSON.stringify(second)).not.toContain("refresh-token-1");
    expect(JSON.stringify(second)).not.toContain("expired-access");

    releasePost();
    const winner = await first;
    expect(winner.unavailableReason).toBeUndefined();
    expect(posts).toBe(1);
    expect(usageAuths).toEqual(["Bearer new-access"]);

    const saved = JSON.parse(readRaw()) as { claudeAiOauth: Record<string, unknown>; mcpOAuth: unknown };
    expect(saved.mcpOAuth).toEqual({ server: "keep" });
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-token-2");
    expect(saved.claudeAiOauth.accessToken).toBe("new-access");
    expect(saved.claudeAiOauth.extraField).toBe("keep");
    expect(saved.claudeAiOauth.subscriptionType).toBe("max");
    expect(readRaw()).not.toContain("refresh-token-1");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(false);

    const later = await new ClaudeUsageProvider(options).getUsage();
    expect(later.unavailableReason).toBeUndefined();
    expect(posts).toBe(1);
    expect(usageAuths).toEqual(["Bearer new-access", "Bearer new-access"]);
  });

  it("falls through to the file when the keychain token is inside the expiry window", async () => {
    writeOauth({
      accessToken: "file-live",
      refreshToken: "refresh-token-1",
      expiresAt: NOW + 3_600_000,
    });
    let usageAuth: string | undefined;
    const snapshot = await provider(routedFetch({
      onUsage: (init) => {
        usageAuth = authorization(init);
        return usageOk();
      },
    }), {
      platform: "darwin",
      commandRunner: fakeRunner({
        stdout: JSON.stringify({
          claudeAiOauth: { accessToken: "keychain-expired", expiresAt: NOW - 1 },
        }),
      }),
      writeFileAtomic: () => {
        throw new Error("should not write");
      },
    }).getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(usageAuth).toBe("Bearer file-live");
  });

  it("reports the credentials file mtime and nothing when the file is missing", () => {
    const reading = new ClaudeUsageProvider({ platform: "linux", configDir: dir });
    expect(reading.credentialRevision()).toBeUndefined();
    writeOauth({ accessToken: "live-access", expiresAt: NOW + 3_600_000 });
    expect(reading.credentialRevision()).toBe(statSync(credentialsPath()).mtimeMs);
  });
});

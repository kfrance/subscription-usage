import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../../src/lib/command-runner.js";
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

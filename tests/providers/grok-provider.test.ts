import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokUsageProvider } from "../../src/providers/grok-provider.js";
import { acquireFileLock } from "../../src/lib/lock.js";

const ISSUER = "https://auth.x.ai";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOP_KEY = `${ISSUER}::${CLIENT_ID}`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Build a temp auth.json with an overridable entry; returns its path + dir. */
function writeAuthFile(entry: Record<string, unknown>): { authPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
  tempDirs.push(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, `${JSON.stringify({ [TOP_KEY]: entry }, null, 2)}\n`, { mode: 0o600 });
  return { authPath, dir };
}

/** A credential entry with extra fields that must survive write-back verbatim. */
function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "access-token-original",
    refresh_token: "refresh-original",
    expires_at: "2999-01-01T00:00:00.000Z",
    oidc_issuer: ISSUER,
    oidc_client_id: CLIENT_ID,
    user_id: "user-123",
    email: "user@example.com",
    team_id: "team-456",
    auth_mode: "personal",
    create_time: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const BILLING_BODY = {
  subscriptionTier: "X Premium+",
  config: {
    creditUsagePercent: 42,
    currentPeriod: { end: "2026-07-01T00:00:00.000Z" },
  },
};

/** Billing shape observed live at 0%, before explicit 1% and 2% readings. */
function zeroUsageConfig(): Record<string, unknown> {
  return {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-12T14:22:51.849236+00:00",
      end: "2026-08-19T14:22:51.849236+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-08-12T14:22:51.849236+00:00",
    billingPeriodEnd: "2026-08-19T14:22:51.849236+00:00",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GrokUsageProvider", () => {
  it("parses auth + billing into a single weekly window", async () => {
    const { authPath } = writeAuthFile(baseEntry());
    const calls: string[] = [];
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async (input) => {
        calls.push(String(input));
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot).toEqual({
      service: "grok",
      planType: "X Premium+",
      windows: [
        { label: "weekly", usedPercent: 42, resetsAt: Date.parse("2026-07-01T00:00:00.000Z") },
      ],
    });
    // A fresh (far-future) token must NOT hit the token endpoint.
    expect(calls).toEqual([BILLING_URL]);
  });

  it("uses aggregate usage instead of the Grok Build product bucket", async () => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      fetchImpl: (async () => jsonResponse({
        config: {
          creditUsagePercent: 97,
          productUsage: [
            { product: "GrokBuild", usagePercent: 87 },
            { product: "Chat", usagePercent: 6 },
            { product: "Imagine", usagePercent: 4 },
          ],
          currentPeriod: { end: "2026-08-12T14:22:00.000Z" },
          subscription_tier: "SuperGrok",
        },
      })) as typeof fetch,
    });

    await expect(provider.getUsage()).resolves.toMatchObject({
      windows: [{
        label: "weekly",
        usedPercent: 97,
        resetsAt: Date.parse("2026-08-12T14:22:00.000Z"),
      }],
    });
  });

  it.each([
    "2026-08-12T14:22:51.849Z",
    "2026-08-12T15:52:51.849Z",
    "2026-08-12T20:22:51.850Z",
    "2026-08-13T14:22:51.849Z",
    "2026-08-19T14:22:51.848Z",
  ])("reads omitted default usage as 0% throughout the active week at %s", async (observedAt) => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse(observedAt),
      fetchImpl: (async () => jsonResponse({ config: zeroUsageConfig() })) as typeof fetch,
    });

    await expect(provider.getUsage()).resolves.toEqual({
      service: "grok",
      planType: "",
      windows: [{
        label: "weekly",
        usedPercent: 0,
        resetsAt: Date.parse("2026-08-19T14:22:51.849Z"),
      }],
    });
  });

  it.each([0, 1, 2])("preserves an explicit %s%% reading with the same zero-credit fields", async (usage) => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-08-13T14:22:51.849Z"),
      fetchImpl: (async () => jsonResponse({
        config: {
          ...zeroUsageConfig(),
          creditUsagePercent: usage,
          productUsage: [{ product: "GrokBuild", usagePercent: usage }],
        },
      })) as typeof fetch,
    });

    await expect(provider.getUsage()).resolves.toMatchObject({
      windows: [{ label: "weekly", usedPercent: usage }],
    });
  });

  it.each([
    "2026-08-12T14:22:51.848Z",
    "2026-08-19T14:22:51.849Z",
    "2026-08-20T14:22:51.849Z",
  ])("does not infer 0% outside the reported period at %s", async (observedAt) => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse(observedAt),
      fetchImpl: (async () => jsonResponse({ config: zeroUsageConfig() })) as typeof fetch,
    });

    await expect(provider.getUsage()).resolves.toMatchObject({
      windows: [],
      unavailableReason: "grok billing missing usage percent",
    });
  });

  it.each([
    ["missing period type", { currentPeriod: {
      start: "2026-08-12T14:22:51.849236+00:00",
      end: "2026-08-19T14:22:51.849236+00:00",
    } }],
    ["missing credit field", { onDemandCap: undefined }],
    ["nonzero credits", { onDemandUsed: { val: 1 } }],
    ["mismatched periods", { billingPeriodStart: "2026-08-13T14:22:51.849Z" }],
    ["null percentage", { creditUsagePercent: null }],
    ["string percentage", { creditUsagePercent: "0" }],
    ["negative percentage", { creditUsagePercent: -1 }],
    ["out-of-range percentage", { creditUsagePercent: 101 }],
    ["malformed product usage", { productUsage: {} }],
    ["missing product percentage", { productUsage: [{ product: "GrokBuild" }] }],
  ])("does not infer 0% from %s", async (_label, overrides) => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-08-13T14:22:51.849Z"),
      fetchImpl: (async () => jsonResponse({
        config: { ...zeroUsageConfig(), ...overrides },
      })) as typeof fetch,
    });

    await expect(provider.getUsage()).resolves.toMatchObject({
      windows: [],
      unavailableReason: "grok billing missing usage percent",
    });
  });

  it("does not refresh when the token is far from expiry", async () => {
    const { authPath } = writeAuthFile(baseEntry({ expires_at: "2026-06-23T06:00:00.000Z" }));
    const urls: string[] = [];
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async (input) => {
        urls.push(String(input));
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    await provider.getUsage();
    expect(urls).not.toContain(TOKEN_URL);
  });

  it("refreshes near expiry and persists rotated credentials, preserving other fields", async () => {
    const { authPath } = writeAuthFile(baseEntry({ expires_at: "2026-06-23T00:05:00.000Z" }));
    const nowMs = Date.parse("2026-06-23T00:00:00.000Z");
    const urls: string[] = [];
    let tokenBody = "";

    const provider = new GrokUsageProvider({
      authPath,
      now: () => nowMs,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url === TOKEN_URL) {
          tokenBody = String(init?.body ?? "");
          // xAI rotates the refresh token on every refresh.
          return jsonResponse({
            access_token: "access-token-NEW",
            refresh_token: "refresh-ROTATED",
            expires_in: 21600,
            token_type: "Bearer",
          });
        }
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(urls[0]).toBe(TOKEN_URL);
    expect(urls).toContain(BILLING_URL);

    // Public-client grant body: no client secret.
    expect(tokenBody).toContain("grant_type=refresh_token");
    expect(tokenBody).toContain("refresh_token=refresh-original");
    expect(tokenBody).toContain(`client_id=${CLIENT_ID}`);
    expect(tokenBody).not.toContain("client_secret");

    const written = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;
    const entry = written[TOP_KEY];
    expect(entry.key).toBe("access-token-NEW");
    expect(entry.refresh_token).toBe("refresh-ROTATED");
    expect(entry.expires_at).toBe(new Date(nowMs + 21600 * 1000).toISOString());

    // The top-level key and all other fields survive untouched.
    expect(Object.keys(written)).toEqual([TOP_KEY]);
    expect(entry.user_id).toBe("user-123");
    expect(entry.email).toBe("user@example.com");
    expect(entry.team_id).toBe("team-456");
    expect(entry.auth_mode).toBe("personal");
    expect(entry.create_time).toBe("2025-01-01T00:00:00.000Z");
    expect(entry.oidc_issuer).toBe(ISSUER);
    expect(entry.oidc_client_id).toBe(CLIENT_ID);

    // File written with restrictive 0600 mode.
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("skips refresh when the auth lock is already held and uses the existing token", async () => {
    const { authPath, dir } = writeAuthFile(baseEntry({ expires_at: "2026-06-23T00:05:00.000Z" }));
    const lockPath = join(dir, "auth.json.lock");
    const heldLock = acquireFileLock(lockPath, "test Grok auth lock");
    const urls: string[] = [];

    const provider = new GrokUsageProvider({
      authPath,
      lockPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url === BILLING_URL) {
          // Existing access token must still be used.
          expect((init?.headers as Record<string, string>).Authorization).toBe(
            "Bearer access-token-original",
          );
        }
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    try {
      const snapshot = await provider.getUsage();
      expect(snapshot.unavailableReason).toBeUndefined();
      expect(urls).not.toContain(TOKEN_URL);
      // auth.json must be left unchanged (no rotated credentials).
      const written = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(written[TOP_KEY].key).toBe("access-token-original");
    } finally {
      heldLock.release();
    }
  });

  it("reloads credentials after acquiring the auth lock", async () => {
    const { authPath } = writeAuthFile(baseEntry({ expires_at: "2026-06-23T00:05:00.000Z" }));
    let reads = 0;
    const urls: string[] = [];
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      readFile: (path) => {
        reads += 1;
        if (reads === 2) {
          writeFileSync(path, JSON.stringify({
            [TOP_KEY]: baseEntry({
              key: "access-token-from-peer",
              refresh_token: "refresh-from-peer",
              expires_at: "2026-06-23T06:00:00.000Z",
            }),
          }));
        }
        return readFileSync(path, "utf8");
      },
      fetchImpl: (async (input, init) => {
        const url = String(input);
        urls.push(url);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer access-token-from-peer",
        );
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(reads).toBe(2);
    expect(urls).toEqual([BILLING_URL]);
  });

  it("leaves auth.json unchanged and reports unavailable when refresh fails", async () => {
    const { authPath } = writeAuthFile(baseEntry({ expires_at: "2026-06-23T00:05:00.000Z" }));
    const before = readFileSync(authPath, "utf8");

    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async (input) => {
        if (String(input) === TOKEN_URL) {
          return new Response("nope", { status: 401 });
        }
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeDefined();
    expect(snapshot.windows).toEqual([]);
    // Byte-for-byte unchanged.
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });

  it("bounds a stalled token refresh request", async () => {
    vi.useFakeTimers();
    const { authPath } = writeAuthFile(baseEntry({ expires_at: "2026-06-23T00:05:00.000Z" }));
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(TOKEN_URL);
        return {
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
        } as Response;
      }) as typeof fetch,
    });

    const usage = provider.getUsage();
    await vi.advanceTimersByTimeAsync(5000);
    const snapshot = await usage;
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.unavailableReason).toContain("grok token response not JSON");
  });

  it("keeps the billing timeout active while decoding the response body", async () => {
    vi.useFakeTimers();
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(BILLING_URL);
        return {
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
        } as Response;
      }) as typeof fetch,
    });

    const usage = provider.getUsage();
    await vi.advanceTimersByTimeAsync(5000);
    const snapshot = await usage;
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.unavailableReason).toContain("grok billing response not JSON");
  });

  it("reports unavailable when the access token is missing and cannot refresh", async () => {
    const { authPath } = writeAuthFile(
      baseEntry({ key: "", refresh_token: "", expires_at: "2026-06-23T00:05:00.000Z" }),
    );
    const urls: string[] = [];
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async (input) => {
        urls.push(String(input));
        return jsonResponse(BILLING_BODY);
      }) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeDefined();
    expect(urls).toEqual([]);
  });

  it("reports unavailable on a non-200 billing response without throwing", async () => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async () => new Response("error", { status: 500 })) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toContain("500");
    expect(snapshot.windows).toEqual([]);
  });

  it("reports unavailable on a malformed billing body", async () => {
    const { authPath } = writeAuthFile(baseEntry());
    const provider = new GrokUsageProvider({
      authPath,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
      fetchImpl: (async () => jsonResponse({ not: "billing" })) as typeof fetch,
    });

    const snapshot = await provider.getUsage();
    expect(snapshot.unavailableReason).toBeDefined();
    expect(snapshot.windows).toEqual([]);
  });
});

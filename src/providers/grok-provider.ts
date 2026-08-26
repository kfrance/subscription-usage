import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { acquireFileLock, LockError, type LockHandle } from "../lib/lock.js";
import {
  httpFailureKind,
  unavailableSnapshot,
  type UsageProvider,
  type UsageSnapshot,
  type UsageUnavailableKind,
} from "../types.js";
import { describeError, isRecord, percentInRange } from "../lib/values.js";

/**
 * Grok exposes usage through two cooperating surfaces:
 *
 *  1. `~/.grok/auth.json`, an OIDC credential file the grok CLI also writes. Its
 *     single entry holds a short-lived access token (`key`, ~6h) plus a
 *     refresh token. xAI is a public OAuth2 client and ROTATES the refresh
 *     token on every refresh, so a refresh is a mandatory read-modify-write of
 *     the auth file — losing the rotated token would lock us out.
 *  2. `cli-chat-proxy.grok.com/v1/billing`, a Bearer-authenticated endpoint that
 *     reports credit utilization for the current (weekly) billing cycle. The
 *     cycle length is not hardcoded here — the reset instant is read straight
 *     from the endpoint's `currentPeriod.end`.
 *
 * This provider mirrors the codex provider's contract: every external surface
 * (fetch, fs, clock, lock) is injectable so tests never touch the network, the
 * real auth file, or a real advisory lock, and it NEVER throws — all failures
 * degrade to `unavailableSnapshot`.
 */

/** Default location of the grok CLI credential file. */
const DEFAULT_AUTH_PATH = join(homedir(), ".grok", "auth.json");
/** Refresh once the access token is within this window of expiry. */
const DEFAULT_NEAR_EXPIRY_MS = 10 * 60 * 1000;
/** Billing request timeout — matches the codex provider's 5s budget. */
const BILLING_TIMEOUT_MS = 5000;
/** Token refresh timeout; keeps a stalled Grok refresh from blocking peers. */
const TOKEN_TIMEOUT_MS = 5000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ZERO_USAGE_INFERENCE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Restrictive mode for the rewritten credential file (owner read/write). */
const AUTH_FILE_MODE = 0o600;

export interface GrokUsageProviderOptions {
  fetchImpl?: typeof fetch;
  /** Defaults to `~/.grok/auth.json`. */
  authPath?: string;
  /** Defaults to `<authPath>.lock`; honored cooperatively with the grok CLI. */
  lockPath?: string;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable reader; defaults to a UTF-8 `readFileSync`. */
  readFile?: (path: string) => string;
  /** Injectable atomic writer; defaults to temp-file + rename at mode 0600. */
  writeFileAtomic?: (path: string, data: string, mode?: number) => void;
  /** Refresh threshold before expiry; defaults to 10 minutes. */
  nearExpiryMs?: number;
}

/** The single entry value stored under the `<issuer>::<client_id>` key. */
interface GrokAuthEntry {
  key?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  oidc_issuer?: unknown;
  oidc_client_id?: unknown;
  [field: string]: unknown;
}

/** Standard OAuth2 token-endpoint response (public-client refresh grant). */
interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class GrokUsageProvider implements UsageProvider {
  readonly service = "grok" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly authPath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly readFile: (path: string) => string;
  private readonly writeFileAtomic: (path: string, data: string, mode?: number) => void;
  private readonly nearExpiryMs: number;

  constructor(options: GrokUsageProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authPath = options.authPath ?? DEFAULT_AUTH_PATH;
    this.lockPath = options.lockPath ?? `${this.authPath}.lock`;
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.writeFileAtomic = options.writeFileAtomic ?? writeFileAtomic;
    this.nearExpiryMs = options.nearExpiryMs ?? DEFAULT_NEAR_EXPIRY_MS;
  }

  async getUsage(): Promise<UsageSnapshot> {
    // Read + parse the credential file. Any structural problem is reported as a
    // known-unavailable state rather than an exception.
    let parsed: { raw: Record<string, unknown>; topKey: string; entry: GrokAuthEntry };
    try {
      parsed = this.readAuth();
    } catch (error) {
      return unavailableSnapshot("grok", `grok auth unreadable: ${describeError(error)}`);
    }

    // Refresh (with mandatory write-back) when the access token is missing or
    // near expiry. A failed refresh leaves the file untouched and aborts.
    let accessToken = typeof parsed.entry.key === "string" ? parsed.entry.key : "";
    if (this.needsRefresh(parsed.entry)) {
      const refreshed = await this.refresh(parsed);
      if (refreshed.unavailableReason) {
        return unavailableSnapshot("grok", refreshed.unavailableReason, refreshed.unavailableKind);
      }
      accessToken = refreshed.accessToken;
    }

    if (!accessToken) {
      return unavailableSnapshot("grok", "grok access token missing");
    }

    return this.fetchBilling(accessToken);
  }

  /** Parse the auth file and isolate its single `<issuer>::<client_id>` entry. */
  private readAuth(): { raw: Record<string, unknown>; topKey: string; entry: GrokAuthEntry } {
    const text = this.readFile(this.authPath);
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw)) {
      throw new Error("auth.json is not an object");
    }
    const topKey = Object.keys(raw)[0];
    if (topKey === undefined) {
      throw new Error("auth.json has no entries");
    }
    const entry = raw[topKey];
    if (!isRecord(entry)) {
      throw new Error("auth.json entry is not an object");
    }
    return { raw, topKey, entry };
  }

  /** True when there is no access token or it expires within the threshold. */
  private needsRefresh(entry: GrokAuthEntry): boolean {
    if (typeof entry.key !== "string" || entry.key.length === 0) {
      return true;
    }
    if (typeof entry.expires_at !== "string") {
      // Unknown expiry — refresh to be safe rather than send a stale token.
      return true;
    }
    const expiresAtMs = Date.parse(entry.expires_at);
    if (Number.isNaN(expiresAtMs)) {
      return true;
    }
    return expiresAtMs - this.now() < this.nearExpiryMs;
  }

  /**
   * Perform an OAuth2 public-client refresh grant and persist the rotated
   * credentials back into the auth file atomically. Cooperates with the grok
   * CLI via an advisory lock: if the lock is already held we SKIP the refresh
   * and fall back to the existing (possibly soon-to-expire) token instead of
   * racing another writer.
   */
  private async refresh(parsed: {
    raw: Record<string, unknown>;
    topKey: string;
    entry: GrokAuthEntry;
  }): Promise<{ accessToken: string; unavailableReason?: string; unavailableKind?: UsageUnavailableKind }> {
    const existingToken = typeof parsed.entry.key === "string" ? parsed.entry.key : "";

    let lock: LockHandle;
    try {
      lock = acquireFileLock(this.lockPath, "Grok auth lock");
    } catch (error) {
      if (error instanceof LockError) {
        // The grok CLI is mid-refresh; proceed with the existing token rather
        // than racing it. If we have no token, surface unavailable.
        return existingToken
          ? { accessToken: existingToken }
          : { accessToken: "", unavailableReason: "grok auth lock held; no usable token" };
      }
      return { accessToken: "", unavailableReason: `grok lock error: ${describeError(error)}` };
    }

    try {
      // Another Grok process may have refreshed between our optimistic read and
      // this lock acquisition. Reload under the flock so rotating refresh tokens
      // are never consumed from a stale snapshot.
      const locked = this.readAuth();
      const { entry } = locked;
      const lockedToken = typeof entry.key === "string" ? entry.key : "";
      if (!this.needsRefresh(entry)) {
        return { accessToken: lockedToken };
      }

      const refreshToken = typeof entry.refresh_token === "string" ? entry.refresh_token : "";
      const issuer = typeof entry.oidc_issuer === "string" ? entry.oidc_issuer : "";
      const clientId = typeof entry.oidc_client_id === "string" ? entry.oidc_client_id : "";
      if (!refreshToken || !issuer || !clientId) {
        return lockedToken
          ? { accessToken: lockedToken }
          : { accessToken: "", unavailableReason: "grok refresh credentials missing" };
      }

      const tokenResponse = await this.requestToken(issuer, refreshToken, clientId);
      if (!tokenResponse.ok) {
        // Leave the file UNCHANGED on failure.
        return {
          accessToken: "",
          unavailableReason: tokenResponse.unavailableReason,
          unavailableKind: tokenResponse.unavailableKind,
        };
      }
      const { accessToken, newRefreshToken, expiresInSec } = tokenResponse;

      // Write back the rotated credentials, preserving every other field and
      // the top-level key verbatim.
      const updatedEntry: GrokAuthEntry = {
        ...entry,
        key: accessToken,
        refresh_token: newRefreshToken,
        expires_at: isoFromEpochMs(this.now() + expiresInSec * 1000),
      };
      const updatedRaw = { ...locked.raw, [locked.topKey]: updatedEntry };
      this.writeFileAtomic(this.authPath, `${JSON.stringify(updatedRaw, null, 2)}\n`, AUTH_FILE_MODE);

      return { accessToken };
    } catch (error) {
      return { accessToken: "", unavailableReason: `grok refresh failed: ${describeError(error)}` };
    } finally {
      lock.release();
    }
  }

  /** POST the public-client refresh grant to `<issuer>/oauth2/token`. */
  private async requestToken(
    issuer: string,
    refreshToken: string,
    clientId: string,
  ): Promise<
    | { ok: true; accessToken: string; newRefreshToken: string; expiresInSec: number }
    | { ok: false; unavailableReason: string; unavailableKind?: UsageUnavailableKind }
  > {
    const tokenUrl = `${issuer.replace(/\/$/, "")}/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        // A rate limit here has to reach the cache, or every command retries the
        // refresh immediately and deepens the limit the cache exists to avoid.
        return {
          ok: false,
          unavailableReason: `grok token endpoint returned ${response.status}`,
          unavailableKind: httpFailureKind(response.status),
        };
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (error) {
        return { ok: false, unavailableReason: `grok token response not JSON: ${describeError(error)}` };
      }

      if (!isRecord(json)) {
        return { ok: false, unavailableReason: "grok token response malformed" };
      }
      const token = json as OAuthTokenResponse;
      const accessToken = typeof token.access_token === "string" ? token.access_token : "";
      const newRefreshToken = typeof token.refresh_token === "string" ? token.refresh_token : "";
      const expiresInSec = typeof token.expires_in === "number" ? token.expires_in : NaN;

      if (!accessToken || !newRefreshToken || !Number.isFinite(expiresInSec)) {
        return { ok: false, unavailableReason: "grok token response missing fields" };
      }

      return { ok: true, accessToken, newRefreshToken, expiresInSec };
    } catch (error) {
      return { ok: false, unavailableReason: `grok token request failed: ${describeError(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Query the billing endpoint and normalize it into a single weekly window. */
  private async fetchBilling(accessToken: string): Promise<UsageSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BILLING_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        return unavailableSnapshot(
          "grok",
          `grok billing returned ${response.status}`,
          httpFailureKind(response.status),
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (error) {
        return unavailableSnapshot("grok", `grok billing response not JSON: ${describeError(error)}`);
      }

      return normalizeBilling(json, this.now());
    } catch (error) {
      return unavailableSnapshot("grok", `grok billing request failed: ${describeError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Map the billing payload to a normalized snapshot, tolerating schema drift. */
function normalizeBilling(json: unknown, observedAt: number): UsageSnapshot {
  if (!isRecord(json) || !isRecord(json.config)) {
    return unavailableSnapshot("grok", "grok billing response malformed");
  }
  const config = json.config;

  // The top-level percentage is the aggregate across Grok Build, Chat, Imagine,
  // and any future product buckets. Use GrokBuild only as a compatibility
  // fallback for older payloads that do not expose the aggregate.
  let usedPercent = percentInRange(config.creditUsagePercent);
  if (usedPercent === undefined && Array.isArray(config.productUsage)) {
    for (const product of config.productUsage) {
      if (isRecord(product) && product.product === "GrokBuild") {
        const productPercent = percentInRange(product.usagePercent);
        if (productPercent !== undefined) {
          usedPercent = productPercent;
        }
      }
    }
  }
  // Grok's protobuf-shaped JSON omits its scalar percentage when that value is
  // the default zero. Accept 0% only for the complete canonical empty-period
  // shape observed from the live endpoint; partial or drifted responses remain
  // unavailable rather than becoming a misleading zero.
  if (usedPercent === undefined && isCanonicalZeroUsagePeriod(config, observedAt)) {
    usedPercent = 0;
  }
  if (usedPercent === undefined) {
    return unavailableSnapshot("grok", "grok billing missing usage percent");
  }

  // The billing-cycle end powers the window reset time.
  const resetsAt = readBillingPeriodEnd(config);
  if (resetsAt === undefined) {
    return unavailableSnapshot("grok", "grok billing missing period end");
  }

  const planType = readPlanType(config) ?? readPlanType(json) ?? "";

  return {
    service: "grok",
    planType,
    windows: [{ label: "weekly", usedPercent, resetsAt }],
  };
}

/** Read the billing-cycle end (`currentPeriod.end` → `billingPeriodEnd`). */
function readBillingPeriodEnd(config: Record<string, unknown>): number | undefined {
  if (isRecord(config.currentPeriod) && typeof config.currentPeriod.end === "string") {
    const ms = Date.parse(config.currentPeriod.end);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  if (typeof config.billingPeriodEnd === "string") {
    const ms = Date.parse(config.billingPeriodEnd);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  return undefined;
}

function readPlanType(source: Record<string, unknown>): string | undefined {
  if (typeof source.subscriptionTier === "string") {
    return source.subscriptionTier;
  }
  return typeof source.subscription_tier === "string" ? source.subscription_tier : undefined;
}

function readCreditValue(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.val === "number" && Number.isFinite(value.val) && value.val >= 0
    ? value.val
    : undefined;
}

function isCanonicalZeroUsagePeriod(
  config: Record<string, unknown>,
  observedAt: number
): boolean {
  if (
    !isRecord(config.currentPeriod) ||
    config.currentPeriod.type !== "USAGE_PERIOD_TYPE_WEEKLY" ||
    typeof config.currentPeriod.start !== "string" ||
    typeof config.currentPeriod.end !== "string" ||
    config.billingPeriodStart !== config.currentPeriod.start ||
    config.billingPeriodEnd !== config.currentPeriod.end ||
    typeof config.isUnifiedBillingUser !== "boolean" ||
    typeof config.topUpMethod !== "string" ||
    readCreditValue(config.onDemandCap) !== 0 ||
    readCreditValue(config.onDemandUsed) !== 0 ||
    readCreditValue(config.prepaidBalance) !== 0
  ) {
    return false;
  }
  const start = Date.parse(config.currentPeriod.start);
  const end = Date.parse(config.currentPeriod.end);
  return (
    !Number.isNaN(start) &&
    !Number.isNaN(end) &&
    end - start === WEEK_MS &&
    observedAt >= start &&
    observedAt - start <= ZERO_USAGE_INFERENCE_WINDOW_MS
  );
}

/** ISO8601 (millisecond precision, `Z`) matching the auth file's format. */
function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}


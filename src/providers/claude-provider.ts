import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ShellCommandRunner, type CommandRunner } from "../lib/command-runner.js";
import {
  httpFailureKind,
  unavailableSnapshot,
  type UsageProvider,
  type UsageSnapshot,
  type UsageUnavailableKind,
  type UsageWindow,
} from "../types.js";
import { isRecord, percentInRange } from "../lib/values.js";

/** Anthropic OAuth usage endpoint (the same source `ccstatusline` reads). */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Required beta header for the OAuth usage endpoint. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** Keychain service name Claude Code stores its OAuth credentials under (macOS). */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Hard ceiling on the usage request. */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Anthropic's usage payload exposes one bucket per rolling window. A bucket is
 * either an object with utilization + reset, or `null` for plans (e.g.
 * Enterprise) that have no scheduled limit on that window. A bucket object may
 * itself carry `resets_at: null` — e.g. a per-model weekly sub-bucket
 * (`seven_day_sonnet`) that reports utilization but has no independent reset.
 */
interface UsageBucket {
  utilization: number;
  resets_at: string | null;
}

/** The four buckets we map, paired with the normalized window label we emit. */
const BUCKET_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "five_hour", label: "5h" },
  { key: "seven_day", label: "weekly" },
  { key: "seven_day_sonnet", label: "weekly-sonnet" },
  { key: "seven_day_opus", label: "weekly-opus" },
];

export interface ClaudeUsageProviderOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real shell (keychain access). */
  commandRunner?: CommandRunner;
  /** Injectable file reader; defaults to `fs.readFileSync`. Throws if missing. */
  readFile?: (path: string) => string;
  /** Home directory; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Overrides `CLAUDE_CONFIG_DIR` / `~/.claude` resolution. */
  configDir?: string;
  /** Defaults to `process.platform`; lets tests force keychain vs. file path. */
  platform?: NodeJS.Platform;
  /** Injectable clock for any time reasoning; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Reads Claude Code's OAuth usage via the same path `ccstatusline` uses: resolve
 * the OAuth access token (keychain on macOS, else the `.credentials.json` file),
 * then call the OAuth usage endpoint and normalize the rolling-window buckets.
 *
 * Every failure mode — missing token, command failure, non-200, fetch throw,
 * malformed body, schema drift — degrades to an unavailable snapshot rather than
 * throwing, matching the other usage providers.
 */
export class ClaudeUsageProvider implements UsageProvider {
  readonly service = "claude" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly commandRunner: CommandRunner;
  private readonly readFile: (path: string) => string;
  private readonly homeDir: string;
  private readonly configDir?: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(options: ClaudeUsageProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.commandRunner = options.commandRunner ?? new ShellCommandRunner();
    this.readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    this.homeDir = options.homeDir ?? homedir();
    this.configDir = options.configDir;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  async getUsage(): Promise<UsageSnapshot> {
    const token = this.resolveToken();
    if (!token) {
      return unavailableSnapshot("claude", "no Claude Code OAuth token found");
    }

    let body: unknown;
    try {
      body = await this.fetchUsage(token);
    } catch (error) {
      const failure = describeFailure(error);
      return unavailableSnapshot("claude", failure.reason, failure.kind, failure.retryAfter);
    }

    return this.parseSnapshot(body);
  }

  /**
   * Token resolution order: macOS keychain first (the canonical store for Claude
   * Code), then the on-disk credentials file as a fallback for non-macOS hosts
   * or when the keychain lookup fails.
   */
  private resolveToken(): string | undefined {
    if (this.platform === "darwin") {
      const fromKeychain = this.tokenFromKeychain();
      if (fromKeychain) {
        return fromKeychain;
      }
    }
    return this.tokenFromCredentialsFile();
  }

  private tokenFromKeychain(): string | undefined {
    let result;
    try {
      result = this.commandRunner.run(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
    } catch {
      return undefined;
    }
    if (result.exitCode !== 0) {
      return undefined;
    }
    return extractAccessToken(result.stdout);
  }

  private tokenFromCredentialsFile(): string | undefined {
    const dir = this.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(this.homeDir, ".claude");
    const path = join(dir, ".credentials.json");
    let raw: string;
    try {
      raw = this.readFile(path);
    } catch {
      return undefined;
    }
    return extractAccessToken(raw);
  }

  /**
   * Issues the usage request with a 5s abort budget and surfaces the outcome.
   *
   * There is deliberately no in-request retry. The endpoint's limiter is
   * sensitive to how closely requests are spaced rather than to their volume, and
   * it needs roughly a minute to recover — far longer than this request's whole
   * budget — so a retry here could never succeed. It also answers a 429 with
   * `retry-after: 0`, which offers no usable wait. Backing off across calls is
   * therefore the caching layer's job: a 429 becomes a `rate-limited` failure
   * carrying a `retryAfter` deadline, and the caller decides when to ask again.
   */
  private async fetchUsage(token: string): Promise<unknown> {
    return this.requestUsage(token, REQUEST_TIMEOUT_MS, async (response) => {
      if (response.ok) {
        return response.json();
      }

      if (response.status === 429) {
        throw new UsageRequestError("usage request failed: HTTP 429", "rate-limited", {
          retryAfter: retryAfterDeadline(response.headers.get("retry-after"), this.now()),
        });
      }

      throw new UsageRequestError(
        `usage request failed: HTTP ${response.status}`,
        httpFailureKind(response.status),
      );
    });
  }

  /**
   * Run the request and consume its body under one deadline.
   *
   * The timer covers `consume` as well as the fetch, because a server that sends
   * headers and then stalls the body would otherwise hold this request open
   * indefinitely: aborting only on headers leaves the read unbounded, and the
   * caller holds the service cache lock while it waits.
   */
  private async requestUsage<T>(
    token: string,
    timeoutMs: number,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
        },
        signal: controller.signal,
      });
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseSnapshot(body: unknown): UsageSnapshot {
    if (!isRecord(body)) {
      return unavailableSnapshot("claude", "malformed usage response");
    }

    const windows: UsageWindow[] = [];
    for (const { key, label } of BUCKET_LABELS) {
      if (!(key in body)) {
        continue;
      }
      const window = toWindow(label, body[key]);
      if (!window) {
        return unavailableSnapshot("claude", `malformed usage bucket: ${key}`);
      }
      windows.push(window);
    }

    if (windows.length === 0) {
      return unavailableSnapshot("claude", "usage response had no recognized buckets");
    }

    return {
      service: "claude",
      planType: extractPlanType(body),
      windows,
    };
  }
}

/** Pull `claudeAiOauth.accessToken` out of either keychain or file JSON. */
function extractAccessToken(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) {
    return undefined;
  }
  const token = parsed.claudeAiOauth.accessToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * Map one raw bucket to a window. A `null` bucket (Enterprise, no scheduled
 * limit) becomes `{ usedPercent: 0, resetsAt: 0 }`, where `resetsAt === 0` is the
 * convention for "no scheduled reset".
 */
function toWindow(label: string, bucket: unknown): UsageWindow | undefined {
  if (bucket === null) {
    return { label, usedPercent: 0, resetsAt: 0 };
  }
  if (!isUsageBucket(bucket)) {
    return undefined;
  }
  // A non-null bucket can still omit a scheduled reset (`resets_at: null`); keep
  // its utilization and use the resetsAt === 0 "no scheduled reset" convention.
  if (bucket.resets_at === null) {
    return { label, usedPercent: bucket.utilization, resetsAt: 0 };
  }
  const resetsAt = Date.parse(bucket.resets_at);
  if (Number.isNaN(resetsAt)) {
    return undefined;
  }
  return { label, usedPercent: bucket.utilization, resetsAt };
}

/** Best-effort plan/tier extraction; "" when the body carries no usable tier. */
function extractPlanType(body: Record<string, unknown>): string {
  for (const key of ["plan_type", "planType", "plan", "tier", "subscription_type"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
}

/** A request failure that carries the structured kind callers branch on. */
class UsageRequestError extends Error {
  readonly kind?: UsageUnavailableKind;
  readonly retryAfter?: number;

  constructor(message: string, kind?: UsageUnavailableKind, options: { retryAfter?: number } = {}) {
    super(message);
    this.name = "UsageRequestError";
    this.kind = kind;
    this.retryAfter = options.retryAfter;
  }
}

/**
 * Turn a `retry-after` header into an absolute epoch-ms deadline. Anthropic sends
 * `retry-after: 0` on this endpoint, which is not a usable wait, so only a
 * strictly positive value produces a deadline; everything else returns undefined
 * and leaves the backoff to the caller.
 */
function retryAfterDeadline(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return now + seconds * 1000;
}

interface UsageFailure {
  reason: string;
  kind?: UsageUnavailableKind;
  retryAfter?: number;
}

function describeFailure(error: unknown): UsageFailure {
  if (error instanceof UsageRequestError) {
    return { reason: error.message, kind: error.kind, retryAfter: error.retryAfter };
  }
  if (error instanceof Error) {
    return error.name === "AbortError"
      ? { reason: `usage request timed out after ${REQUEST_TIMEOUT_MS}ms` }
      : { reason: error.message };
  }
  return { reason: "usage request failed" };
}

/**
 * A bucket is only usable when its utilization is a real percentage.
 *
 * Bounds matter here more than they look: an out-of-range value such as -1 would
 * otherwise be cached as a valid reading, and a negative utilization reads as
 * abundant capacity to the budget rail that decides whether to dispatch work.
 * An unparseable response has to fail closed, not look empty.
 */
function isUsageBucket(value: unknown): value is UsageBucket {
  return (
    isRecord(value) &&
    percentInRange(value.utilization) !== undefined &&
    (typeof value.resets_at === "string" || value.resets_at === null)
  );
}

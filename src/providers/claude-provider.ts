import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic as writeFileAtomicDefault } from "../lib/atomic-file.js";
import { ShellCommandRunner, type CommandRunner } from "../lib/command-runner.js";
import { acquireOauthRefreshLock } from "../lib/oauth-refresh-lock.js";
import { LockError, type LockHandle } from "../lib/lock.js";
import { describeError, finiteNumber, isRecord } from "../lib/values.js";
import {
  httpFailureKind,
  unavailableSnapshot,
  type UsageProvider,
  type UsageSnapshot,
  type UsageUnavailableKind,
  type UsageWindow,
  percentInRange,
} from "../types.js";

/** Anthropic OAuth usage endpoint (the same source `ccstatusline` reads). */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Required beta header for the OAuth usage endpoint. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/**
 * Claude Code's refresh grant. The client id is the public id baked into the
 * Claude Code build, not a secret. A credential that carries its own `clientId`
 * wins over this default.
 */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/**
 * Scopes Claude sends when the stored credential does not name any. A stored
 * list is sent as-is — this default must not be added on top of it.
 */
const DEFAULT_OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;
/** Keychain service name Claude Code stores its OAuth credentials under (macOS). */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Hard ceiling on one usage or token request. */
const REQUEST_TIMEOUT_MS = 5000;
/**
 * Claude refreshes when `now + 5 minutes` has reached `expiresAt`. A missing
 * `expiresAt` is not treated as expired: older credential files omit it, and
 * those tokens are still sent as they are today.
 */
const NEAR_EXPIRY_MS = 300_000;
/** proper-lockfile waits Claude uses between attempts on `.storage-write.lock`. */
const STORAGE_LOCK_RETRY_MS = [100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000, 1000];
/** Owner read/write only. The credentials file holds the OAuth grant. */
const CREDENTIALS_FILE_MODE = 0o600;

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
  /** Injectable atomic writer; defaults to the shared helper. */
  writeFileAtomic?: (path: string, data: string, mode?: number) => void;
  /**
   * Injectable mtime of a file, in epoch ms. Undefined when the file is missing.
   * Defaults to `fs.statSync`. Tests that inject `readFile` should inject this
   * too if they want `credentialRevision` without touching a real path.
   */
  statMtime?: (path: string) => number | undefined;
  /** Injectable Claude refresh lock. Defaults to `mkdir` of `.oauth_refresh.lock`. */
  acquireRefreshLock?: (lockPath: string) => LockHandle;
  /**
   * Injectable Claude credential-write lock. Defaults to a bare `mkdir` of
   * `.storage-write.lock` (proper-lockfile, no owner record).
   */
  acquireStorageLock?: (lockPath: string) => LockHandle;
  /**
   * Waits between storage-lock attempts. Defaults to Claude's 10 retries.
   * An empty list tries once.
   */
  storageLockRetryMs?: readonly number[];
  /** Home directory; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Overrides `CLAUDE_CONFIG_DIR` / `~/.claude` resolution. */
  configDir?: string;
  /** Defaults to `process.platform`; lets tests force keychain vs. file path. */
  platform?: NodeJS.Platform;
  /** Injectable clock for any time reasoning; defaults to `Date.now`. */
  now?: () => number;
}

interface LoadedCredentials {
  raw: Record<string, unknown>;
  oauth: Record<string, unknown>;
}

interface TokenFailure {
  ok: false;
  reason: string;
  kind?: UsageUnavailableKind;
  retryAfter?: number;
}

interface TokenSuccess {
  ok: true;
  token: string;
}

type ResolvedToken = TokenSuccess | TokenFailure;

interface RefreshGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Set only when the token response included a finite `refresh_token_expires_in`. */
  refreshTokenExpiresAt?: number;
}

/**
 * Reads Claude Code's OAuth usage via the same path `ccstatusline` uses: resolve
 * the OAuth access token (keychain on macOS, else the `.credentials.json` file),
 * then call the OAuth usage endpoint and normalize the rolling-window buckets.
 *
 * When the file's access token is inside Claude's five-minute expiry window,
 * this refreshes that same grant before calling usage. The refresh takes
 * Claude's `.oauth_refresh.lock` (a directory, not `flock`), then
 * `.storage-write.lock`, and re-reads under both before it posts. The new
 * tokens are written only when the refresh token on disk is still the one that
 * was posted. A lock that is already held is left alone, and the token
 * endpoint is not called. An expired token is never sent to the usage endpoint.
 *
 * The macOS keychain is read-only here. An expired keychain token falls through
 * to the credentials file; a keychain token with no `expiresAt` is used as-is
 * and the file is not opened.
 *
 * Every failure mode — missing token, command failure, non-200, fetch throw,
 * malformed body, schema drift — degrades to an unavailable snapshot rather than
 * throwing, matching the other usage providers. Failure text never includes a
 * token value.
 */
export class ClaudeUsageProvider implements UsageProvider {
  readonly service = "claude" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly commandRunner: CommandRunner;
  private readonly readFile: (path: string) => string;
  private readonly writeFileAtomic: (path: string, data: string, mode?: number) => void;
  private readonly statMtime: (path: string) => number | undefined;
  private readonly acquireRefreshLock: (lockPath: string) => LockHandle;
  private readonly acquireStorageLock: (lockPath: string) => LockHandle;
  private readonly storageLockRetryMs: readonly number[];
  private readonly homeDir: string;
  private readonly configDir?: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  /** Mtime of the credentials file when this call's refresh wrote it. */
  private ownCredentialWrite: number | undefined;

  constructor(options: ClaudeUsageProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.commandRunner = options.commandRunner ?? new ShellCommandRunner();
    this.readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    this.writeFileAtomic = options.writeFileAtomic ?? writeFileAtomicDefault;
    this.statMtime = options.statMtime ?? defaultStatMtime;
    this.acquireRefreshLock = options.acquireRefreshLock ?? ((path) => acquireOauthRefreshLock(path));
    this.acquireStorageLock = options.acquireStorageLock
      ?? ((path) => acquireOauthRefreshLock(path, { ownerRecord: false }));
    this.storageLockRetryMs = options.storageLockRetryMs ?? STORAGE_LOCK_RETRY_MS;
    this.homeDir = options.homeDir ?? homedir();
    this.configDir = options.configDir;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  async getUsage(): Promise<UsageSnapshot> {
    this.ownCredentialWrite = undefined;
    const resolved = await this.resolveAccessToken();
    if (!resolved.ok) {
      return unavailableSnapshot("claude", resolved.reason, resolved.kind, resolved.retryAfter);
    }

    let body: unknown;
    try {
      body = await this.fetchUsage(resolved.token);
    } catch (error) {
      const failure = describeFailure(error);
      return unavailableSnapshot(
        "claude",
        withoutSecrets(failure.reason, [resolved.token]),
        failure.kind,
        failure.retryAfter,
      );
    }

    return this.parseSnapshot(body);
  }

  /**
   * Mtime of the credentials file. The cache compares it with the last attempt
   * so a backoff from an expired token does not outlive Claude rewriting the
   * file. Errors and a missing file are "no revision", not a failure of the read.
   */
  credentialRevision(): number | undefined {
    return this.fileRevision(this.credentialsPath());
  }

  /** Set only when the refresh that just ran wrote the credentials file. */
  wroteCredentialRevision(): number | undefined {
    return this.ownCredentialWrite;
  }

  /**
   * Token resolution order: an unexpired macOS keychain token first (the
   * canonical store for Claude Code), then the credentials file. A keychain
   * token inside the expiry window is not used; the file is, and it is refreshed
   * there. The keychain itself is never written.
   */
  private async resolveAccessToken(): Promise<ResolvedToken> {
    if (this.platform === "darwin") {
      const keychain = this.tokenFromKeychain();
      if (keychain && !this.needsRefresh(keychain.expiresAt)) {
        return { ok: true, token: keychain.accessToken };
      }
    }
    return this.tokenFromCredentialsFile();
  }

  private tokenFromKeychain(): { accessToken: string; expiresAt?: number } | undefined {
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
    return readAccessGrant(parseCredentials(result.stdout));
  }

  private async tokenFromCredentialsFile(): Promise<ResolvedToken> {
    const path = this.credentialsPath();
    const loaded = this.loadCredentials(path);
    const current = this.tokenIfCurrent(loaded);
    if (current) return current;
    if (!this.needsRefresh(loaded ? finiteNumber(loaded.oauth.expiresAt) : undefined)) {
      return { ok: false, reason: "no Claude Code OAuth token found" };
    }
    return this.refreshCredentials(path);
  }

  /** An access token that is present and outside Claude's expiry window. */
  private tokenIfCurrent(loaded: LoadedCredentials | undefined): TokenSuccess | undefined {
    const grant = readAccessGrant(loaded);
    if (!grant || this.needsRefresh(grant.expiresAt)) return undefined;
    return { ok: true, token: grant.accessToken };
  }

  /** True when Claude itself would refresh: `expiresAt` is known and within 5 minutes. */
  private needsRefresh(expiresAt: number | undefined): boolean {
    return expiresAt !== undefined && this.now() >= expiresAt - NEAR_EXPIRY_MS;
  }

  /**
   * Refresh the grant stored in the credentials file.
   *
   * If Claude (or another reader) already holds either lock, or this process
   * loses the refresh lock before it posts or writes, re-read the file and use
   * that token only when it is outside the expiry window. Otherwise report
   * unavailable and do not call usage. The storage lock is taken before the
   * token POST so a busy credential write cannot discard a rotated refresh
   * token. Under both locks, a re-read that is already fresh skips the POST.
   * The POST's tokens are written only when the on-disk refresh token is still
   * the one that was posted, or is explicitly empty.
   */
  private async refreshCredentials(path: string): Promise<ResolvedToken> {
    let lock: LockHandle;
    try {
      lock = this.acquireRefreshLock(this.refreshLockPath());
    } catch (error) {
      if (error instanceof LockError) {
        return this.tokenIfCurrent(this.loadCredentials(path)) ?? {
          ok: false,
          reason: "Claude OAuth refresh is already in progress",
        };
      }
      return { ok: false, reason: `Claude OAuth refresh lock failed: ${describeError(error)}` };
    }

    let storage: LockHandle | undefined;
    let postedRefreshToken: string | undefined;
    try {
      const beforeStorage = this.prepareRefresh(path, lock);
      if (!beforeStorage.ok) return beforeStorage.result;

      // OAuth first, then storage. Claude's refresh already holds the oauth
      // directory while its credential write waits on `.storage-write.lock`.
      // The opposite order can deadlock that writer. A held storage directory
      // is left in place, and the token endpoint is not called.
      storage = await this.holdStorageLock(path);
      if (!storage) {
        return { ok: false, reason: "Claude credential storage lock is already held" };
      }

      const ready = this.prepareRefresh(path, lock);
      if (!ready.ok) return ready.result;
      if (storage.compromised?.() === true) {
        return { ok: false, reason: "Claude credential storage lock is already held" };
      }

      postedRefreshToken = ready.refreshToken;
      const granted = await this.requestRefresh(postedRefreshToken, ready.oauth);
      if (!granted.ok) {
        return {
          ...granted,
          reason: withoutSecrets(granted.reason, [
            postedRefreshToken,
            nonEmptyString(ready.oauth.accessToken),
          ]),
        };
      }
      const lostBeforeSave = this.afterLostLock(lock, path);
      if (lostBeforeSave) return lostBeforeSave;
      if (storage.compromised?.() === true) {
        return { ok: false, reason: "Claude credential storage lock is already held" };
      }
      const saved = this.saveRefresh(path, postedRefreshToken, granted.grant, lock, storage);
      if (saved.status === "saved") {
        this.ownCredentialWrite = saved.revision;
        return { ok: true, token: granted.grant.accessToken };
      }
      if (saved.status === "lost") {
        return this.afterLostLock(lock, path) ?? {
          ok: false,
          reason: "Claude OAuth refresh lock was lost",
        };
      }
      if (saved.status === "locked") {
        return { ok: false, reason: "Claude credential storage lock is already held" };
      }
      // A sibling changed the refresh token while we held the lock. Keep their
      // write. Use their access token only when it does not itself need a refresh.
      return this.tokenIfCurrent(this.loadCredentials(path)) ?? {
        ok: false,
        reason: "Claude OAuth credentials changed during refresh",
      };
    } catch (error) {
      return {
        ok: false,
        reason: withoutSecrets(`Claude OAuth refresh failed: ${describeError(error)}`, [postedRefreshToken]),
      };
    } finally {
      storage?.release();
      lock.release();
    }
  }

  /**
   * The grant to post, or a finished result when no POST should happen.
   * Called before the storage lock and again once both locks are held.
   */
  private prepareRefresh(
    path: string,
    lock: LockHandle,
  ): { ok: true; refreshToken: string; oauth: Record<string, unknown> } | { ok: false; result: ResolvedToken } {
    const lost = this.afterLostLock(lock, path);
    if (lost) return { ok: false, result: lost };
    const loaded = this.loadCredentials(path);
    const current = this.tokenIfCurrent(loaded);
    if (current) return { ok: false, result: current };
    const refreshToken = loaded ? nonEmptyString(loaded.oauth.refreshToken) : undefined;
    if (!loaded || refreshToken === undefined) {
      return { ok: false, result: { ok: false, reason: "Claude OAuth refresh token missing" } };
    }
    return { ok: true, refreshToken, oauth: loaded.oauth };
  }

  /**
   * A sibling reclaimed the lock. Their token is used only when it is already
   * outside the expiry window; this process does not post or write after that.
   * Checked before `release`, because releasing a directory that is already
   * gone looks the same as losing it.
   */
  private afterLostLock(lock: LockHandle, path: string): ResolvedToken | undefined {
    if (lock.compromised?.() !== true) return undefined;
    return this.tokenIfCurrent(this.loadCredentials(path)) ?? {
      ok: false,
      reason: "Claude OAuth refresh lock was lost",
    };
  }

  /**
   * Write the refreshed grant only if the on-disk refresh token is still the
   * one we posted, or is explicitly empty. Any other value means a sibling
   * won the race; their file is left byte-for-byte alone. Caller holds both
   * locks and releases the storage lock after this returns, so the saved
   * revision is the mtime of this write.
   */
  private saveRefresh(
    path: string,
    postedRefreshToken: string,
    grant: RefreshGrant,
    refreshLock: LockHandle,
    storage: LockHandle,
  ): { status: "saved"; revision: number | undefined } | { status: "changed" | "locked" | "lost" } {
    if (refreshLock.compromised?.() === true) return { status: "lost" };
    if (storage.compromised?.() === true) return { status: "locked" };
    const loaded = this.loadCredentials(path);
    if (!loaded) return { status: "changed" };
    const onDisk = onDiskRefreshToken(loaded.oauth);
    if (onDisk !== "" && onDisk !== postedRefreshToken) return { status: "changed" };
    if (refreshLock.compromised?.() === true) return { status: "lost" };
    if (storage.compromised?.() === true) return { status: "locked" };
    const oauth = {
      ...loaded.oauth,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      ...(grant.refreshTokenExpiresAt === undefined
        ? {}
        : { refreshTokenExpiresAt: grant.refreshTokenExpiresAt }),
    };
    this.writeFileAtomic(
      path,
      `${JSON.stringify({ ...loaded.raw, claudeAiOauth: oauth }, null, 2)}\n`,
      CREDENTIALS_FILE_MODE,
    );
    return { status: "saved", revision: this.fileRevision(path) };
  }

  /** Retry a busy storage lock the way proper-lockfile does. Never deletes one. */
  private async holdStorageLock(credentialsPath: string): Promise<LockHandle | undefined> {
    const lockPath = join(dirname(credentialsPath), ".storage-write.lock");
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.acquireStorageLock(lockPath);
      } catch (error) {
        if (!(error instanceof LockError)) throw error;
        const delay = this.storageLockRetryMs[attempt];
        if (delay === undefined) return undefined;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async requestRefresh(
    refreshToken: string,
    oauth: Record<string, unknown>,
  ): Promise<{ ok: true; grant: RefreshGrant } | TokenFailure> {
    const body = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: nonEmptyString(oauth.clientId) ?? CLAUDE_OAUTH_CLIENT_ID,
      scope: scopesOf(oauth.scopes).join(" "),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          return {
            ok: false,
            reason: "Claude OAuth refresh failed: HTTP 429",
            kind: "rate-limited",
            retryAfter: retryAfterDeadline(response.headers.get("retry-after"), this.now()),
          };
        }
        return { ok: false, reason: `Claude OAuth refresh failed: HTTP ${response.status}` };
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        // The parser's message can quote the body. That body may hold a new
        // access token, which must not land in the snapshot or the call log.
        return { ok: false, reason: "Claude OAuth refresh response was not JSON" };
      }
      if (!isRecord(json)) {
        return { ok: false, reason: "Claude OAuth refresh response was malformed" };
      }
      const accessToken = nonEmptyString(json.access_token);
      const expiresIn = finiteNumber(json.expires_in);
      if (!accessToken || expiresIn === undefined || expiresIn <= 0) {
        return { ok: false, reason: "Claude OAuth refresh response was missing fields" };
      }
      const refreshExpiresIn = finiteNumber(json.refresh_token_expires_in);
      return {
        ok: true,
        grant: {
          accessToken,
          refreshToken: nonEmptyString(json.refresh_token) ?? refreshToken,
          expiresAt: this.now() + expiresIn * 1000,
          refreshTokenExpiresAt: refreshExpiresIn === undefined
            ? undefined
            : this.now() + refreshExpiresIn * 1000,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, reason: `Claude OAuth refresh timed out after ${REQUEST_TIMEOUT_MS}ms` };
      }
      return { ok: false, reason: `Claude OAuth refresh failed: ${describeError(error)}` };
    } finally {
      clearTimeout(timer);
    }
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

  private credentialsPath(): string {
    return join(this.configDirectory(), ".credentials.json");
  }

  private refreshLockPath(): string {
    return join(this.configDirectory(), ".oauth_refresh.lock");
  }

  private configDirectory(): string {
    return this.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(this.homeDir, ".claude");
  }

  private fileRevision(path: string): number | undefined {
    try {
      return finiteNumber(this.statMtime(path));
    } catch {
      return undefined;
    }
  }

  private loadCredentials(path: string): LoadedCredentials | undefined {
    let rawText: string;
    try {
      rawText = this.readFile(path);
    } catch {
      return undefined;
    }
    return parseCredentials(rawText);
  }
}

function defaultStatMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function parseCredentials(rawText: string): LoadedCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) {
    return undefined;
  }
  return { raw: parsed, oauth: parsed.claudeAiOauth };
}

/** A non-empty access token and its finite `expiresAt`, when the file has one. */
function readAccessGrant(
  loaded: LoadedCredentials | undefined,
): { accessToken: string; expiresAt?: number } | undefined {
  if (loaded === undefined) return undefined;
  const accessToken = nonEmptyString(loaded.oauth.accessToken);
  if (accessToken === undefined) return undefined;
  return { accessToken, expiresAt: finiteNumber(loaded.oauth.expiresAt) };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Failure text is logged and cached. A token that leaked into it is removed. */
function withoutSecrets(message: string, secrets: Array<string | undefined>): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

/**
 * The compare-and-swap key. An explicit empty string may be replaced. A missing
 * or non-string value may not: that is not the token we posted.
 */
function onDiskRefreshToken(oauth: Record<string, unknown>): string | undefined {
  if (oauth.refreshToken === "") return "";
  return nonEmptyString(oauth.refreshToken);
}

/** Stored scopes win. The default list is only for a credential that names none. */
function scopesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    const scopes = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (scopes.length > 0) return scopes;
  }
  if (typeof value === "string") {
    const scopes = value.split(" ").filter((item) => item.length > 0);
    if (scopes.length > 0) return scopes;
  }
  return [...DEFAULT_OAUTH_SCOPES];
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

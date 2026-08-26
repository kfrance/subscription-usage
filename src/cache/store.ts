import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { acquireFileLock, type LockHandle } from "../lib/lock.js";
import {
  unavailableSnapshot,
  type UsageProvider,
  type UsageSnapshot,
  type UsageService,
} from "../types.js";

/**
 * A caching decorator for any `UsageProvider`, and the single place the freshness
 * policy for usage readings is decided.
 *
 * It exists because the providers sit behind rate limiters that care about how
 * closely requests are spaced rather than how many are made — Anthropic's OAuth
 * usage endpoint answers two requests seconds apart with a 429 but serves the
 * same requests a minute apart without complaint. The meta loop's commands
 * (`budget`, `record`, `doctor`) are separate processes that each used to fetch
 * live, and the loop runs `record` then `budget` within seconds at every dispatch
 * boundary, so it reliably tripped the limiter on itself.
 *
 * Whether a stored reading may be served is the caller's decision, supplied as a
 * `Freshness` policy. A reading the policy accepts is returned with no request at
 * all, so commands that run back to back share one reading. Anything else fetches
 * live. A failed fetch reports the service unavailable unless the policy asked
 * for `staleOk`, in which case the stored reading comes back tagged with
 * `refreshError`. A caller that gates spending simply never sets `staleOk`, so it
 * can never be handed a reading that makes a service look more spendable than a
 * live read would have.
 *
 * On a rate limit it also persists a `blockedUntil` deadline so the next command
 * skips the request entirely rather than spending another token from an empty
 * bucket, and a per-service lock keeps two processes from fetching at once.
 *
 * Each service owns its own file inside the cache directory, so two commands
 * refreshing different services never write the same file and cannot lose each
 * other's entry.
 *
 * Every cache read and write is best-effort. A missing, unreadable, or corrupt
 * cache file behaves as a cache miss, and a failed write never fails the read —
 * the worst outcome is the uncached behavior that came before.
 */

/** First backoff step after a rate limit; the measured recovery is ~60s. */
const BASE_BACKOFF_MS = 60_000;
/** Backoff ceiling, matching what `ccstatusline` applies to the same endpoint. */
const MAX_BACKOFF_MS = 300_000;
/** Owner read/write only; the cache mirrors subscription usage figures. */
const CACHE_FILE_MODE = 0o600;
const CACHE_VERSION = 1;

/**
 * One service's cache file. `snapshot` is only ever a successful reading, and it
 * carries its own `capturedAt` — the age is a property of the reading itself, so
 * storing it a second time beside the snapshot would only let the two disagree.
 */
interface CacheEntry {
  version: number;
  snapshot?: UsageSnapshot;
  blockedUntil?: number;
  consecutiveFailures?: number;
}

/**
 * What to do with the stored reading, decided by the caller rather than here.
 *
 * The two consumers disagree on purpose. LearnWhale's automation refuses a stale
 * reading because it gates spending, and a reading that understates usage would
 * authorize work there is no capacity for. my-claw prefers a stale panel to an
 * empty one, because nobody spends anything by looking at it. Both are correct
 * for their caller, so neither belongs in the store.
 */
export type FreshnessDecision =
  /** Serve the stored reading without any request. */
  | { use: "cached" }
  /**
   * Fetch live. When `staleOk`, a failed fetch falls back to the stored reading,
   * tagged with `refreshError` so the caller can say the figures are not current.
   */
  | { use: "refresh"; staleOk?: boolean };

/** Decide how a stored reading may be used. `snapshot` is undefined on a miss. */
export type Freshness = (snapshot: UsageSnapshot | undefined, now: number) => FreshnessDecision;

/**
 * The common policy shape: fresh below one age, optionally stale-tolerant below
 * a second, live beyond. `staleCeilingMs` of 0 refuses stale readings entirely.
 */
export function maxAgeFreshness(options: {
  freshMs: number;
  staleCeilingMs?: number;
}): Freshness {
  const staleCeilingMs = options.staleCeilingMs ?? 0;
  return (snapshot, now) => {
    const capturedAt = snapshot?.capturedAt;
    if (capturedAt === undefined) {
      return { use: "refresh" };
    }
    const age = now - capturedAt;
    if (options.freshMs > 0 && age < options.freshMs) {
      return { use: "cached" };
    }
    return { use: "refresh", staleOk: age < staleCeilingMs };
  };
}

/**
 * Where readings live by default.
 *
 * A user-level path, not a repository one, because the point is that separate
 * processes share it: LearnWhale's nightly automation and my-claw's server both
 * run as the same user on the same machine and query the same vendor endpoints
 * for the same accounts. Without a shared location each burns the other's rate
 * limit.
 *
 * Nested under `learnwhale/` rather than sitting beside it because LearnWhale's
 * unattended Codex sandbox grants write access to that directory and nothing
 * else under the state root, and its grant list replaces the user's own rather
 * than merging with it. A sibling directory is read-only there.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AI_USAGE_CACHE_DIR?.trim();
  if (configured) {
    return configured;
  }
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "learnwhale", "ai-usage");
}

export interface CachingUsageProviderOptions {
  /** Directory holding one cache file and one lock file per service. */
  cacheDir: string;
  /** How the caller wants stored readings used. */
  freshness: Freshness;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable reader; defaults to a UTF-8 `readFileSync`. Throws if missing. */
  readFile?: (path: string) => string;
  /** Injectable atomic writer; defaults to temp-file + rename at mode 0600. */
  writeFileAtomic?: (path: string, data: string, mode?: number) => void;
  /** Injectable remover; defaults to a forced `rmSync`. */
  removeFile?: (path: string) => void;
  /** Injectable lock acquisition; defaults to the shared file lock. */
  acquireLock?: (lockPath: string, label: string) => LockHandle;
}

export class CachingUsageProvider implements UsageProvider {
  readonly service: UsageService;

  private readonly inner: UsageProvider;
  private readonly cacheDir: string;
  private readonly freshness: Freshness;
  private readonly now: () => number;
  private readonly readFile: (path: string) => string;
  private readonly writeFileAtomic: (path: string, data: string, mode?: number) => void;
  private readonly removeFile: (path: string) => void;
  private readonly acquireLock: (lockPath: string, label: string) => LockHandle;

  constructor(inner: UsageProvider, options: CachingUsageProviderOptions) {
    this.inner = inner;
    this.service = inner.service;
    this.cacheDir = options.cacheDir;
    this.freshness = options.freshness;
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    this.writeFileAtomic = options.writeFileAtomic ?? writeFileAtomic;
    this.removeFile = options.removeFile ?? ((path: string) => rmSync(path, { force: true }));
    this.acquireLock = options.acquireLock ?? acquireFileLock;
  }

  async getUsage(): Promise<UsageSnapshot> {
    const now = this.now();
    const entry = this.readEntry();

    // Recent enough to reuse outright, as judged by the caller's policy. A
    // policy that always refreshes is what LearnWhale's `record` wants: it diffs
    // a before reading against an after reading, so it needs a live one.
    let decision = this.freshness(entry?.snapshot, now);
    const cached = servableSnapshot(entry, now, decision);
    if (cached) {
      return cached;
    }

    // A live rate limit is still in force; asking again only deepens it.
    if (entry?.blockedUntil !== undefined && entry.blockedUntil > now) {
      const waitSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      return unavailableSnapshot(this.service, `rate limited; not retrying for ${waitSeconds}s`, "rate-limited");
    }

    // Another process is already fetching this service. Joining it would be the
    // very burst this cache exists to prevent, so report unavailable instead of
    // piling on; the next command picks up the reading that process writes.
    let lock: LockHandle;
    try {
      lock = this.acquireLock(this.lockPath(), `${this.service} usage fetch`);
    } catch {
      return unavailableSnapshot(this.service, "another process is reading usage");
    }

    try {
      // The lock holder may have just filled the cache while we waited on it, so
      // re-read rather than trusting the entry from before the lock.
      const current = this.readEntry();
      decision = this.freshness(current?.snapshot, this.now());
      const refreshed = servableSnapshot(current, this.now(), decision);
      if (refreshed) {
        return refreshed;
      }

      let snapshot: UsageSnapshot;
      try {
        snapshot = await this.inner.getUsage();
      } catch (error) {
        snapshot = unavailableSnapshot(this.service, describeError(error));
      }

      if (snapshot.unavailableReason) {
        // Only a rate limit changes what is stored. Any other failure has nothing
        // to persist, and writing the entry back unchanged would rewrite the
        // whole cache file for nothing.
        if (snapshot.unavailableKind === "rate-limited") {
          this.recordRateLimit(snapshot, current);
        }
        // The caller said a stale reading beats no reading. Serve the stored one
        // tagged with what went wrong, so a panel can show figures and say they
        // are not current. Callers that gate spending do not set `staleOk`, so
        // they still see the failure.
        const stale = current?.snapshot;
        if (decision.use === "refresh" && decision.staleOk && isServable(stale, this.now())) {
          return { ...stale, refreshError: snapshot.unavailableReason };
        }
        return snapshot;
      }

      const captured = { ...snapshot, capturedAt: this.now() };
      this.recordSuccess(captured);
      return captured;
    } finally {
      lock.release();
    }
  }

  private lockPath(): string {
    return join(this.cacheDir, `${this.service}.lock`);
  }

  private entryPath(): string {
    return join(this.cacheDir, `${this.service}.json`);
  }

  private readEntry(): CacheEntry | undefined {
    let raw: string;
    try {
      raw = this.readFile(this.entryPath());
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return toCacheEntry(parsed);
  }

  /** A success replaces the entry outright, which also clears the backoff. */
  private recordSuccess(snapshot: UsageSnapshot): void {
    this.writeEntry({ snapshot });
  }

  /**
   * Arm an escalating backoff, keeping the stored reading. That reading is no
   * longer servable in place of this failed read, but it is still the baseline
   * `record` diffs its next "after" reading against. `previous` is the entry
   * already read under the lock, so this never re-reads the file.
   */
  private recordRateLimit(snapshot: UsageSnapshot, previous: CacheEntry | undefined): void {
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    // Honor a server-provided deadline only when it asks us to wait longer than
    // our own floor; this endpoint's `retry-after: 0` must not shorten it.
    const blockedUntil = Math.max(this.now() + backoffMs, snapshot.retryAfter ?? 0);
    this.writeEntry({ ...previous, blockedUntil, consecutiveFailures: failures });
  }

  /**
   * Replace this service's file. Only this service ever writes it, so there is no
   * cross-service merge to lose and no window in which a concurrent command
   * writing a different service can clobber this entry.
   */
  private writeEntry(state: Omit<CacheEntry, "version">): void {
    writeCacheEntry(this.entryPath(), state, this.writeFileAtomic, this.removeFile);
  }
}

/**
 * Persist one service's entry, or remove the file if it cannot be written.
 *
 * The removal is the point. A cache that cannot be written must degrade to the
 * UNCACHED behavior, not to whatever the file held before. Swallowing the error
 * and leaving the old file in place would keep serving a superseded reading as
 * if it were current, and the caller has already been handed the new one, so
 * nothing else would notice.
 */
function writeCacheEntry(
  path: string,
  state: Omit<CacheEntry, "version">,
  write: (path: string, data: string, mode?: number) => void,
  remove: (path: string) => void,
): void {
  try {
    const entry: CacheEntry = { version: CACHE_VERSION, ...state };
    write(path, `${JSON.stringify(entry, null, 2)}\n`, CACHE_FILE_MODE);
  } catch {
    try {
      remove(path);
    } catch {
      // Nothing further to try; the entry expires on its own age soon enough.
    }
  }
}

/** The stored reading, when the policy says to serve it and it is still usable. */
function servableSnapshot(
  entry: CacheEntry | undefined,
  now: number,
  decision: FreshnessDecision,
): UsageSnapshot | undefined {
  if (decision.use !== "cached") {
    return undefined;
  }
  return isServable(entry?.snapshot, now) ? entry?.snapshot : undefined;
}

/**
 * A stored reading is usable at all: it is a real reading rather than a recorded
 * failure, it knows when it was taken, and none of its windows has reset since.
 *
 * The reset check matters independently of age. A reset only ever lowers
 * utilization, so a reading taken before one overstates how much has been spent,
 * and it does so at the exact moment a full window has just become available.
 * Age is not consulted here — that is the caller's policy to decide.
 */
function isServable(snapshot: UsageSnapshot | undefined, now: number): snapshot is UsageSnapshot {
  if (snapshot?.capturedAt === undefined) {
    return false;
  }
  if (snapshot.unavailableReason || snapshot.windows.length === 0) {
    return false;
  }
  return now < earliestReset(snapshot);
}

/**
 * The soonest moment any of the snapshot's windows rolls over. A `resetsAt` of
 * `0` is the "no scheduled reset" convention and never expires the reading; a
 * snapshot made entirely of such windows returns `Infinity`.
 */
function earliestReset(snapshot: UsageSnapshot): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const window of snapshot.windows) {
    if (window.resetsAt > 0) {
      earliest = Math.min(earliest, window.resetsAt);
    }
  }
  return earliest;
}

/**
 * Validate a parsed cache file into an entry, or undefined when it is anything
 * else. A file can be valid JSON and still be structurally wrong — hand-edited,
 * truncated by an older format, or written by a future version — and the cache
 * contract is that such a file behaves as a miss. Casting instead of checking
 * let a shape like `{"version":1,"snapshot":{"capturedAt":1}}` reach the freshness
 * test and throw on a missing `windows`, which wedged the service until someone
 * deleted the file by hand.
 */
function toCacheEntry(parsed: unknown): CacheEntry | undefined {
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) {
    return undefined;
  }
  const entry: CacheEntry = { version: CACHE_VERSION };
  if (typeof parsed.blockedUntil === "number" && Number.isFinite(parsed.blockedUntil)) {
    entry.blockedUntil = parsed.blockedUntil;
  }
  if (typeof parsed.consecutiveFailures === "number" && Number.isFinite(parsed.consecutiveFailures)) {
    entry.consecutiveFailures = parsed.consecutiveFailures;
  }
  if (isCachedSnapshot(parsed.snapshot)) {
    entry.snapshot = parsed.snapshot;
  }
  return entry;
}

/** A stored snapshot must carry the fields the freshness test reads. */
function isCachedSnapshot(value: unknown): value is UsageSnapshot {
  return (
    isRecord(value) &&
    typeof value.service === "string" &&
    Array.isArray(value.windows) &&
    value.windows.every(
      (window) =>
        isRecord(window) &&
        typeof window.label === "string" &&
        typeof window.usedPercent === "number" &&
        typeof window.resetsAt === "number",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface InvalidateOptions
  extends Pick<CachingUsageProviderOptions, "readFile" | "writeFileAtomic" | "removeFile"> {
  /**
   * Drop the reading only if it was captured before this epoch-ms cutoff. The
   * caller passes the moment after which a reading is known to be trustworthy —
   * for a finished dispatch, "now" — so a newer reading written concurrently by
   * another process survives.
   */
  capturedBefore: number;
}

/**
 * Drop a service's cached reading while keeping its backoff state, forcing the
 * next `getUsage` to fetch live or report the service unavailable.
 *
 * This exists for one caller: spend that happened but could not be measured. When
 * a dispatch's "after" read fails and the cache still holds a reading taken
 * before the dispatch finished, that reading is not merely stale, it is known to
 * understate usage. Leaving it in place would let the next budget read authorize
 * another dispatch against capacity that is already spent. Deleting it makes the
 * service fail closed until a real number arrives, which is the behavior the
 * eligibility rail already applies to an unreadable service. The backoff is kept
 * so that invalidating does not turn into an immediate retry storm.
 *
 * The `capturedBefore` cutoff is what makes this safe to run without holding the
 * service lock. A concurrent fetch that succeeds writes a reading captured after
 * the cutoff, which this leaves alone; one that fails leaves the old reading,
 * which this correctly drops. Only a write landing inside the read-then-write
 * window here can still be lost, and that costs one extra live request.
 */
export function invalidateCachedReading(
  cacheDir: string,
  service: UsageService,
  options: InvalidateOptions,
): void {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const write = options.writeFileAtomic ?? writeFileAtomic;
  const remove = options.removeFile ?? ((path: string) => rmSync(path, { force: true }));
  const path = join(cacheDir, `${service}.json`);

  let entry: CacheEntry | undefined;
  try {
    entry = toCacheEntry(JSON.parse(readFile(path)));
  } catch {
    return; // No file, or an unreadable one: already a cache miss.
  }
  if (entry?.snapshot === undefined) {
    return; // Nothing servable is stored, so nothing to drop.
  }
  const { capturedAt } = entry.snapshot;
  if (capturedAt !== undefined && capturedAt >= options.capturedBefore) {
    return; // Someone recorded a trustworthy reading; keep it.
  }

  const { snapshot: _dropped, version: _version, ...kept } = entry;
  writeCacheEntry(path, kept, write, remove);
}

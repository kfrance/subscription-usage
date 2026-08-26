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
import { describeError, isRecord } from "../lib/values.js";

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
  /**
   * Readings captured before this instant are known to be untrustworthy and are
   * never served, whatever the file happens to hold.
   *
   * Invalidation records this rather than only deleting the snapshot, because a
   * deletion is an absence and an absence can be undone. A process holding the
   * service lock reads the entry before its request and writes it back on a rate
   * limit, so a snapshot dropped in between would reappear — and the reading
   * invalidation drops is specifically one known to understate usage, which is
   * the reading that must never come back. A cutoff survives that write; the
   * snapshot beside it can reappear and stays unservable.
   */
  invalidBefore?: number;
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

const defaultReadFile = (path: string): string => readFileSync(path, "utf8");
const defaultRemoveFile = (path: string): void => rmSync(path, { force: true });

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
    this.readFile = options.readFile ?? defaultReadFile;
    this.writeFileAtomic = options.writeFileAtomic ?? writeFileAtomic;
    this.removeFile = options.removeFile ?? defaultRemoveFile;
    this.acquireLock = options.acquireLock ?? acquireFileLock;
  }

  async getUsage(): Promise<UsageSnapshot> {
    const now = this.now();
    const entry = this.readEntry();

    // Recent enough to reuse outright, as judged by the caller's policy. A
    // policy that always refreshes is what LearnWhale's `record` wants: it diffs
    // a before reading against an after reading, so it needs a live one.
    const stored = entry?.snapshot;
    const decision = this.freshness(stored, now);
    if (decision.use === "cached" && isCurrent(stored, now)) {
      return stored;
    }

    // A live rate limit is still in force; asking again only deepens it.
    if (entry?.blockedUntil !== undefined && entry.blockedUntil > now) {
      const waitSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      const reason = `rate limited; not retrying for ${waitSeconds}s`;
      // The backoff says do not ask again; it does not say forget what we know.
      // A caller that accepts stale readings should keep seeing the stored one
      // for the whole backoff, not just on the call that armed it.
      const stale = decision.use === "refresh" && decision.staleOk
        ? staleReading(stored, now)
        : undefined;
      if (stale) {
        return { ...stale, refreshError: reason };
      }
      return unavailableSnapshot(this.service, reason, "rate-limited");
    }

    // Another process is already fetching this service. Joining it would be the
    // very burst this cache exists to prevent, so do not pile on; the next call
    // picks up the reading that process writes.
    //
    // Contention is normal here rather than exceptional, because two
    // applications share this cache, so treat it as a failed refresh rather than
    // as an erasure: a caller that accepts stale readings keeps its stored one.
    let lock: LockHandle;
    try {
      lock = this.acquireLock(this.lockPath(), `${this.service} usage fetch`);
    } catch {
      const reason = "another process is reading usage";
      const stale = decision.use === "refresh" && decision.staleOk
        ? staleReading(stored, now)
        : undefined;
      if (stale) {
        return { ...stale, refreshError: reason };
      }
      return unavailableSnapshot(this.service, reason);
    }

    try {
      // The lock holder may have just filled the cache while we waited on it, so
      // re-read rather than trusting the entry from before the lock.
      // One clock sample for the whole locked section, so the policy and the
      // servability check cannot disagree about what "now" is.
      const lockedNow = this.now();
      const current = this.readEntry();
      const currentSnapshot = current?.snapshot;
      const lockedDecision = this.freshness(currentSnapshot, lockedNow);
      if (lockedDecision.use === "cached" && isCurrent(currentSnapshot, lockedNow)) {
        return currentSnapshot;
      }

      // Another process may have taken a 429 and armed a backoff between the
      // read above and this lock. Re-checking here is what makes the backoff
      // shared: without it a caller that always refreshes would ask the vendor
      // again immediately and deepen the limit the other process just hit.
      if (current?.blockedUntil !== undefined && current.blockedUntil > lockedNow) {
        const waitSeconds = Math.ceil((current.blockedUntil - lockedNow) / 1000);
        const reason = `rate limited; not retrying for ${waitSeconds}s`;
        const stale = lockedDecision.use === "refresh" && lockedDecision.staleOk
          ? staleReading(currentSnapshot, lockedNow)
          : undefined;
        if (stale) {
          return { ...stale, refreshError: reason };
        }
        return unavailableSnapshot(this.service, reason, "rate-limited");
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
        // Re-sample the clock: the request we just awaited may have taken
        // seconds, and the stored reading can have crossed the caller's
        // staleness ceiling or had a window reset while we waited. Judging it by
        // the instant we started would hand back a reading that is no longer
        // eligible at the moment we return it.
        const afterNow = this.now();
        const afterDecision = this.freshness(currentSnapshot, afterNow);
        const stale = afterDecision.use === "refresh" && afterDecision.staleOk
          ? staleReading(currentSnapshot, afterNow)
          : undefined;
        if (stale) {
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
    const entry = toCacheEntry(parsed);
    return entry === undefined ? undefined : withoutInvalidated(entry);
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
    // Re-read rather than trusting the entry from before the request: an
    // invalidation may have landed while it was in flight, and writing the older
    // entry back would restore the reading it dropped.
    const current = this.readEntry() ?? previous;
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    // Honor a server-provided deadline only when it asks us to wait longer than
    // our own floor; this endpoint's `retry-after: 0` must not shorten it.
    const blockedUntil = Math.max(this.now() + backoffMs, snapshot.retryAfter ?? 0);
    this.writeEntry({ ...current, blockedUntil, consecutiveFailures: failures });
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

/**
 * A stored reading is a real reading rather than a recorded failure, and it
 * knows when it was taken. Says nothing about whether its figures still apply.
 */
function isReading(snapshot: UsageSnapshot | undefined): snapshot is UsageSnapshot {
  return (
    snapshot?.capturedAt !== undefined &&
    !snapshot.unavailableReason &&
    snapshot.windows.length > 0
  );
}

/**
 * A stored reading that can stand in for a current one: every window it carries
 * is still the window it was measured against.
 *
 * A reset only ever lowers utilization, so a reading taken before one overstates
 * how much has been spent — and it does so at the exact moment a full window has
 * just become available. Serving that as if it were current would understate
 * capacity to a caller that gates spending, so any reset disqualifies the whole
 * reading here. Age is not consulted; that is the caller's policy to decide.
 */
function isCurrent(snapshot: UsageSnapshot | undefined, now: number): snapshot is UsageSnapshot {
  return isReading(snapshot) && now < earliestReset(snapshot);
}

/**
 * The reading with reset windows removed, for a caller that asked for stale
 * figures, or undefined when nothing usable is left.
 *
 * Windows are independent measurements: a Claude reading carries both a 5-hour
 * and a weekly window, and the 5-hour one resetting says nothing about the
 * weekly one. Discarding the whole reading there would blank a panel that holds
 * a perfectly good weekly figure and explicitly asked to keep showing one. The
 * result is only ever handed back tagged with `refreshError`, so its figures are
 * already presented as not current.
 */
function staleReading(snapshot: UsageSnapshot | undefined, now: number): UsageSnapshot | undefined {
  if (!isReading(snapshot)) {
    return undefined;
  }
  const windows = snapshot.windows.filter((window) => window.resetsAt === 0 || now < window.resetsAt);
  return windows.length > 0 ? { ...snapshot, windows } : undefined;
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
  if (typeof parsed.invalidBefore === "number" && Number.isFinite(parsed.invalidBefore)) {
    entry.invalidBefore = parsed.invalidBefore;
  }
  if (isCachedSnapshot(parsed.snapshot)) {
    entry.snapshot = parsed.snapshot;
  }
  return entry;
}

/**
 * Drop a stored reading the cutoff has superseded, so no path downstream can
 * serve it, treat it as a baseline, or write it back.
 */
function withoutInvalidated(entry: CacheEntry): CacheEntry {
  const capturedAt = entry.snapshot?.capturedAt;
  if (entry.invalidBefore === undefined || capturedAt === undefined) {
    return entry;
  }
  return capturedAt < entry.invalidBefore ? { ...entry, snapshot: undefined } : entry;
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
 * Recording the cutoff is what makes this safe without holding the service lock.
 * A process that holds it read the entry before its request and writes that
 * entry back on a rate limit, so deleting the snapshot alone would let the
 * dropped reading reappear — and this reading in particular is one known to
 * understate usage, so its return would authorize work against capacity already
 * spent. The cutoff is stored beside the snapshot and survives that write-back,
 * which leaves the resurrected reading present but permanently unservable.
 *
 * A concurrent fetch that succeeds writes a reading captured after the cutoff,
 * which is served normally.
 */
export function invalidateCachedReading(
  cacheDir: string,
  service: UsageService,
  options: InvalidateOptions,
): void {
  const readFile = options.readFile ?? defaultReadFile;
  const write = options.writeFileAtomic ?? writeFileAtomic;
  const remove = options.removeFile ?? defaultRemoveFile;
  const path = join(cacheDir, `${service}.json`);

  let entry: CacheEntry | undefined;
  try {
    entry = toCacheEntry(JSON.parse(readFile(path)));
  } catch {
    return; // No file, or an unreadable one: already a cache miss.
  }
  if (entry === undefined) {
    return; // No usable file, so nothing to drop and nothing to write back to.
  }
  const capturedAt = entry.snapshot?.capturedAt;
  if (capturedAt !== undefined && capturedAt >= options.capturedBefore) {
    return; // Someone recorded a trustworthy reading; keep it.
  }
  if (entry.snapshot === undefined && entry.invalidBefore !== undefined
    && entry.invalidBefore >= options.capturedBefore) {
    return; // Already invalidated at least this far forward.
  }

  const { snapshot: _dropped, version: _version, ...kept } = entry;
  writeCacheEntry(path, { ...kept, invalidBefore: options.capturedBefore }, write, remove);
}

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
  percentInRange,
  type UsageWindow,
} from "../types.js";
import { describeError, finiteNumber, isRecord } from "../lib/values.js";

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
export interface FreshnessDecision {
  /** `cached` serves the stored reading without any request; `refresh` fetches. */
  use: "cached" | "refresh";
  /**
   * A failed or skipped fetch may fall back to the stored reading, tagged with
   * `refreshError` so the caller can say the figures are not current.
   *
   * Independent of `use` on purpose. A reading can be young enough to serve and
   * still be rejected as current because one of its windows reset, and when that
   * happens the caller's tolerance for stale figures still applies — otherwise a
   * panel that asked for six hours of stale data loses a valid weekly reading the
   * moment an unrelated five-hour window rolls over.
   */
  staleOk?: boolean;
}

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
    const staleOk = age < staleCeilingMs;
    return options.freshMs > 0 && age < options.freshMs
      ? { use: "cached", staleOk }
      : { use: "refresh", staleOk };
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
    const stored = entry?.snapshot;
    const decision = this.freshness(stored, now);

    // Recent enough to reuse outright, as judged by the caller's policy. A
    // policy that always refreshes is what LearnWhale's `record` wants: it diffs
    // a before reading against an after reading, so it needs a live one.
    if (decision.use === "cached" && isCurrent(stored, now)) {
      return stored;
    }

    const blocked = this.whileBackedOff(entry, decision, stored, now);
    if (blocked) {
      return blocked;
    }

    // Another process is already fetching this service. Joining it would be the
    // very burst this cache exists to prevent, so do not pile on; the next call
    // picks up the reading that process writes. Contention is routine rather
    // than exceptional, because two applications share this cache, so it counts
    // as a failed refresh rather than an erasure.
    let lock: LockHandle;
    try {
      lock = this.acquireLock(this.lockPath(), `${this.service} usage fetch`);
    } catch {
      const reason = "another process is reading usage";
      return this.staleFallback(decision, stored, now, reason)
        ?? unavailableSnapshot(this.service, reason);
    }

    try {
      // One clock sample for the whole locked section, so the policy and the
      // servability check cannot disagree about what "now" is. The entry is
      // re-read because the process we waited on may have just filled it.
      const lockedNow = this.now();
      const current = this.readEntry();
      const currentSnapshot = current?.snapshot;
      const lockedDecision = this.freshness(currentSnapshot, lockedNow);
      if (lockedDecision.use === "cached" && isCurrent(currentSnapshot, lockedNow)) {
        return currentSnapshot;
      }

      // That process may have taken a 429 and armed a backoff while we waited.
      // Re-checking under the lock is what makes the backoff shared: without it a
      // caller that always refreshes would ask the vendor again immediately and
      // deepen the limit the other process just hit.
      const blockedUnderLock = this.whileBackedOff(
        current,
        lockedDecision,
        currentSnapshot,
        lockedNow,
      );
      if (blockedUnderLock) {
        return blockedUnderLock;
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
        // Judge the stored reading at the moment we return it, not the moment we
        // started: the request we just awaited may have taken seconds, and the
        // reading can have crossed the caller's staleness ceiling or had a window
        // reset while we waited.
        const afterNow = this.now();
        return this.staleFallback(
          this.freshness(currentSnapshot, afterNow),
          currentSnapshot,
          afterNow,
          snapshot.unavailableReason,
        ) ?? snapshot;
      }

      // Stamped when the request began, not when it returned. `record`
      // invalidates readings captured before a dispatch it could not measure, and
      // a request that started before that cutoff reflects pre-dispatch usage
      // however long it takes to come back. Stamping the completion time would
      // let such a reading land after the cutoff and be trusted for spending.
      const captured = { ...snapshot, capturedAt: lockedNow };
      this.recordSuccess(captured);
      return captured;
    } finally {
      lock.release();
    }
  }

  /**
   * The stored reading a stale-tolerant caller may still be handed, tagged with
   * what went wrong — or undefined when the policy or the reading itself says no.
   *
   * Every path that fails to produce a live reading ends here, which is the point:
   * "a failed refresh falls back to the stored reading only when the caller opted
   * in, and only to windows that have not reset" is the rule this package is most
   * obliged to get right, and it now has one statement rather than one per exit.
   *
   * The clock is a parameter rather than a `this.now()` call, because the sites do
   * not agree on which instant to judge: the one after an awaited request has to
   * use the moment it returns.
   */
  private staleFallback(
    decision: FreshnessDecision,
    snapshot: UsageSnapshot | undefined,
    now: number,
    refreshError: string,
  ): UsageSnapshot | undefined {
    if (!decision.staleOk) {
      return undefined;
    }
    const stale = staleReading(snapshot, now);
    return stale === undefined ? undefined : { ...stale, refreshError };
  }

  /**
   * The answer while a rate-limit backoff is in force, or undefined when it is
   * not and the caller should carry on.
   *
   * The backoff says do not ask again; it does not say forget what we know, so a
   * caller that accepts stale readings keeps seeing the stored one for the whole
   * backoff rather than only on the call that armed it.
   */
  private whileBackedOff(
    entry: CacheEntry | undefined,
    decision: FreshnessDecision,
    snapshot: UsageSnapshot | undefined,
    now: number,
  ): UsageSnapshot | undefined {
    if (entry?.blockedUntil === undefined || entry.blockedUntil <= now) {
      return undefined;
    }
    const reason = `rate limited; not retrying for ${Math.ceil((entry.blockedUntil - now) / 1000)}s`;
    return this.staleFallback(decision, snapshot, now, reason)
      ?? unavailableSnapshot(this.service, reason, "rate-limited");
  }

  private lockPath(): string {
    return join(this.cacheDir, `${this.service}.lock`);
  }

  private entryPath(): string {
    return entryPath(this.cacheDir, this.service);
  }

  private readEntry(): CacheEntry | undefined {
    const entry = toCacheEntry(readJson(this.entryPath(), this.readFile));
    if (entry === undefined) {
      return undefined;
    }
    return withoutInvalidated(entry, readInvalidBefore(invalidPath(this.cacheDir, this.service), this.readFile));
  }

  /** A success replaces the entry outright, which also clears the backoff. */
  private recordSuccess(snapshot: UsageSnapshot): void {
    this.writeEntry({ snapshot });
  }

  /**
   * Arm an escalating backoff, keeping the stored reading. That reading is no
   * longer servable in place of this failed read, but it is still the baseline
   * `record` diffs its next "after" reading against. `previous` is the entry
   * already read under the lock, so this never re-reads the file — and it does
   * not need to. Every other writer of the entry holds that same lock, and a
   * reading an invalidation disqualified stays unservable however it is written
   * back, because the cutoff that disqualifies it lives in its own file.
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
  return isReading(snapshot) && snapshot.windows.every((window) => windowIsCurrent(window, now));
}

/**
 * The window has not rolled over yet. A `resetsAt` of `0` is the "no scheduled
 * reset" convention and never expires.
 *
 * One definition on purpose: this was spelled two different ways, and the two
 * disagreed about a negative `resetsAt` — one treated it as "never resets" and
 * served the reading as current, the other treated it as long past and dropped
 * the window. `isCachedSnapshot` now rejects a negative outright, so the case
 * cannot reach here, but the rule still belongs in one place.
 */
function windowIsCurrent(window: UsageWindow, now: number): boolean {
  return window.resetsAt === 0 || now < window.resetsAt;
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
  const windows = snapshot.windows.filter((window) => windowIsCurrent(window, now));
  return windows.length > 0 ? { ...snapshot, windows } : undefined;
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
  const blockedUntil = finiteNumber(parsed.blockedUntil);
  if (blockedUntil !== undefined) {
    entry.blockedUntil = blockedUntil;
  }
  const consecutiveFailures = finiteNumber(parsed.consecutiveFailures);
  if (consecutiveFailures !== undefined) {
    entry.consecutiveFailures = consecutiveFailures;
  }
  if (isCachedSnapshot(parsed.snapshot)) {
    entry.snapshot = parsed.snapshot;
  }
  return entry;
}

/**
 * Drop a stored reading that the cutoff has superseded, so no path downstream
 * can serve it, treat it as a baseline, or write it back.
 */
function withoutInvalidated(entry: CacheEntry, invalidBefore: number | undefined): CacheEntry {
  const capturedAt = entry.snapshot?.capturedAt;
  if (invalidBefore === undefined || capturedAt === undefined) {
    return entry;
  }
  return capturedAt < invalidBefore ? { ...entry, snapshot: undefined } : entry;
}

/**
 * Read a service's invalidation cutoff, or undefined when there is none.
 *
 * The cutoff lives in its own file rather than beside the reading, because the
 * whole point is that it survives a writer who is holding a view of the entry
 * from before the invalidation. That writer rewrites the entry file wholesale;
 * it never touches this one, so no interleaving of entry reads and writes can
 * carry the cutoff away with the snapshot it disqualifies.
 */
function readInvalidBefore(path: string, readFile: (path: string) => string): number | undefined {
  const parsed = readJson(path, readFile);
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) {
    return undefined;
  }
  return finiteNumber(parsed.invalidBefore);
}

/**
 * A file's parsed JSON, or undefined for any reason it cannot be read as such.
 *
 * The contract is that a missing, unreadable, or corrupt file behaves as a miss,
 * and it had three separate try/catch spellings enforcing it. Every caller feeds
 * the result to a validator that already handles `undefined`.
 */
function readJson(path: string, readFile: (path: string) => string): unknown {
  try {
    return JSON.parse(readFile(path));
  } catch {
    return undefined;
  }
}

/** Path of a service's cache entry. */
function entryPath(cacheDir: string, service: UsageService): string {
  return join(cacheDir, `${service}.json`);
}

/** Path of the sidecar holding a service's invalidation cutoff — its sibling. */
function invalidPath(cacheDir: string, service: UsageService): string {
  return join(cacheDir, `${service}.invalid.json`);
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
        // The same 0-100 bound every provider applies. A cache file is editable
        // and can be corrupt, and a negative utilization reads as spare capacity
        // to the rail that decides whether to dispatch work, so an out-of-range
        // value has to make the file a miss rather than a reading.
        percentInRange(window.usedPercent) !== undefined &&
        // A negative reset is not a time; the file is corrupt, so it is a miss.
        (finiteNumber(window.resetsAt) ?? -1) >= 0,
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
  const path = entryPath(cacheDir, service);

  const sidecar = invalidPath(cacheDir, service);
  const already = readInvalidBefore(sidecar, readFile);
  if (already !== undefined && already >= options.capturedBefore) {
    return; // Already invalidated at least this far forward.
  }

  let entry: CacheEntry | undefined;
  try {
    entry = toCacheEntry(JSON.parse(readFile(path)));
  } catch {
    entry = undefined; // No file yet, or an unreadable one.
  }
  const capturedAt = entry?.snapshot?.capturedAt;
  if (capturedAt !== undefined && capturedAt >= options.capturedBefore) {
    return; // Someone recorded a trustworthy reading; keep it.
  }

  // The cutoff first: it is what actually disqualifies the reading, and it has
  // to be in place before the deletion in case this process stops here.
  try {
    write(
      sidecar,
      `${JSON.stringify({ version: CACHE_VERSION, invalidBefore: options.capturedBefore }, null, 2)}\n`,
      CACHE_FILE_MODE,
    );
  } catch {
    // The cutoff is what makes a deletion durable, so without it fall back to
    // removing the reading outright. That degrades to a cache miss, which is the
    // fail-closed outcome; leaving a reading known to understate usage in place
    // is the one result that must not happen.
    try {
      remove(path);
    } catch {
      // Nothing further to try.
    }
    return;
  }

  // The entry is deliberately left alone. The cutoff already disqualifies every
  // reading captured before it, so deleting the snapshot would buy nothing — and
  // this runs without the service lock, so a rewrite based on the entry read
  // above would delete a trustworthy reading another process wrote in between,
  // costing a live request against a rate-limited endpoint. A superseded reading
  // stays on disk, unservable, until the next success overwrites it.
}

import { describe, expect, it } from "vitest";
import type { LockHandle } from "../src/lib/lock.js";
import { LockError } from "../src/lib/lock.js";
import {
  unavailableSnapshot,
  type UsageProvider,
  type UsageSnapshot,
} from "../src/types.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCallLog,
  CachingUsageProvider,
  capturedAfterFreshness,
  invalidateCachedReading,
  maxAgeFreshness,
  type CallLogEntry,
  type Freshness,
} from "../src/cache/store.js";

const CACHE_DIR = "/state/usage-cache";
const CLAUDE_PATH = `${CACHE_DIR}/claude.json`;

/** The persisted shape, as the tests read it back off the fake disk. */
interface CacheEntryShape {
  version: number;
  snapshot?: UsageSnapshot;
  blockedUntil?: number;
  consecutiveFailures?: number;
  lastAttemptAt?: number;
}

const T0 = Date.parse("2026-08-26T02:00:00.000Z");
const MINUTE = 60_000;

function goodSnapshot(usedPercent = 13): UsageSnapshot {
  return {
    service: "claude",
    planType: "max",
    windows: [{ label: "5h", usedPercent, resetsAt: T0 + 3 * 60 * MINUTE }],
  };
}

/** Inner provider double that records how many live reads it was asked for. */
function fakeInner(responses: UsageSnapshot[]): UsageProvider & { calls: number } {
  let index = 0;
  return {
    service: "claude" as const,
    calls: 0,
    async getUsage() {
      this.calls += 1;
      // The last response repeats, so a test can hold one steady state.
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next;
    },
  };
}

/** In-memory stand-in for the cache directory, so no test touches the filesystem. */
function fakeDisk(initialClaude?: string) {
  const files = new Map<string, string>();
  if (initialClaude !== undefined) {
    files.set(CLAUDE_PATH, initialClaude);
  }
  return {
    files,
    readFile(path: string): string {
      const contents = files.get(path);
      if (contents === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return contents;
    },
    writeFileAtomic(path: string, data: string): void {
      files.set(path, data);
    },
    entry(service = "claude"): CacheEntryShape | undefined {
      const raw = files.get(`${CACHE_DIR}/${service}.json`);
      return raw === undefined ? undefined : (JSON.parse(raw) as CacheEntryShape);
    },
  };
}

/** Serialize one service's cache file. */
function cacheFile(entry: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, ...entry });
}

/** A cache file holding one good reading of the given age and utilization. */
function cachedReading(capturedAt: number, usedPercent: number, resetsAt?: number): string {
  const snapshot = goodSnapshot(usedPercent);
  const windows = resetsAt === undefined
    ? snapshot.windows
    : snapshot.windows.map((window) => ({ ...window, resetsAt }));
  return cacheFile({ snapshot: { ...snapshot, windows, capturedAt } });
}

function noopLock(): LockHandle {
  return { lockPath: "/state/lock", release: () => undefined };
}

interface HarnessOptions {
  now?: number;
  freshMs?: number;
  staleCeilingMs?: number;
  acquireLock?: () => LockHandle;
  caller?: string;
  logCall?: (entry: CallLogEntry) => void;
}

function makeProvider(
  inner: UsageProvider,
  disk: ReturnType<typeof fakeDisk>,
  options: HarnessOptions = {},
): CachingUsageProvider {
  return new CachingUsageProvider(inner, {
    cacheDir: CACHE_DIR,
    now: () => options.now ?? T0,
    freshness: maxAgeFreshness({
      freshMs: options.freshMs ?? 0,
      staleCeilingMs: options.staleCeilingMs,
    }),
    readFile: (path) => disk.readFile(path),
    writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
    acquireLock: options.acquireLock ?? noopLock,
    caller: options.caller,
    logCall: options.logCall ?? (() => undefined),
  });
}

const RATE_LIMITED = unavailableSnapshot("claude", "usage request failed: HTTP 429", "rate-limited");

describe("CachingUsageProvider freshness", () => {
  it("serves a reading inside the freshness window without a live read", async () => {
    const inner = fakeInner([goodSnapshot()]);
    const disk = fakeDisk(cachedReading(T0 - 30_000, 42));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(0);
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.capturedAt).toBe(T0 - 30_000);
  });

  it("fetches and rewrites the entry once the reading ages past the window", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(1);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
    expect(snapshot.capturedAt).toBe(T0);
    expect(disk.entry()?.snapshot?.capturedAt).toBe(T0);
  });

  it("forces a live read when the freshness window is zero", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cachedReading(T0 - 2 * MINUTE, 42));
    const provider = makeProvider(inner, disk, { freshMs: 0 });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(1);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
  });

  it("expires a young reading once one of its windows has reset", async () => {
    // A reset only ever lowers utilization, so a reading from before it overstates
    // spend at the moment a full window becomes available.
    const reset = T0 + MINUTE;
    const stale: UsageSnapshot = {
      service: "claude",
      planType: "max",
      windows: [{ label: "5h", usedPercent: 96, resetsAt: reset }],
    };
    const disk = fakeDisk(cacheFile({ snapshot: { ...stale, capturedAt: reset - 100_000 } }));
    const inner = fakeInner([goodSnapshot(3)]);
    const provider = makeProvider(inner, disk, { now: reset + 1_000, freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    // Only 101 seconds old, inside the 2-minute window, but past the reset.
    expect(inner.calls).toBe(1);
    expect(snapshot.windows[0]?.usedPercent).toBe(3);
  });

  it("keeps serving a reading whose windows have no scheduled reset", async () => {
    // `resetsAt: 0` is the "no scheduled limit" convention and never expires.
    const unlimited: UsageSnapshot = {
      service: "claude",
      planType: "enterprise",
      windows: [{ label: "5h", usedPercent: 0, resetsAt: 0 }],
    };
    const disk = fakeDisk(cacheFile({ snapshot: { ...unlimited, capturedAt: T0 - 30_000 } }));
    const inner = fakeInner([goodSnapshot(13)]);
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    await provider.getUsage();

    expect(inner.calls).toBe(0);
  });

  it("removes the entry when the replacing write fails", async () => {
    // Degrading to the uncached behavior means no entry, not the previous one:
    // the caller already holds the new reading, so a surviving old file would go
    // on being served as current with nothing to notice.
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const removed: string[] = [];
    const provider = new CachingUsageProvider(fakeInner([goodSnapshot(13)]), {
      cacheDir: CACHE_DIR,
      now: () => T0,
      freshness: maxAgeFreshness({ freshMs: 2 * MINUTE }),
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: () => {
        throw new Error("ENOSPC");
      },
      removeFile: (path) => removed.push(path),
      acquireLock: noopLock,
      logCall: () => undefined,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.windows[0]?.usedPercent).toBe(13);
    // Both writes (the attempt and the reading) failed; each removed the entry.
    expect([...new Set(removed)]).toEqual([CLAUDE_PATH]);
  });

  it("treats a corrupt cache file as a miss rather than failing the read", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk("{ not json");
    const provider = makeProvider(inner, disk);

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(1);
    expect(snapshot.unavailableReason).toBeUndefined();
  });
});

describe("CachingUsageProvider stale readings", () => {
  const rateLimited = unavailableSnapshot("claude", "usage request failed: HTTP 429", "rate-limited");

  it("serves the stored reading when the caller allows stale and the refresh fails", async () => {
    // my-claw's policy. Nobody spends anything by looking at a panel, so real
    // figures with a caveat beat an empty panel.
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(fakeInner([rateLimited]), disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.capturedAt).toBe(T0 - 5 * MINUTE);
    expect(snapshot.refreshError).toContain("429");
  });

  it("reports the failure once the reading passes the stale ceiling", async () => {
    const disk = fakeDisk(cachedReading(T0 - 7 * 60 * MINUTE, 42));
    const provider = makeProvider(fakeInner([rateLimited]), disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toContain("429");
    expect(snapshot.windows).toEqual([]);
  });

  it("does not serve a stale reading to a caller that did not ask for one", async () => {
    // LearnWhale's policy: the reading gates spending, so a stale one that
    // understates usage would authorize work there is no capacity for.
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(fakeInner([rateLimited]), disk, { freshMs: 2 * MINUTE });

    expect((await provider.getUsage()).unavailableReason).toContain("429");
  });

  it("keeps serving the stored reading for the whole rate-limit backoff", async () => {
    // The call that armed the backoff returned the stale reading; every call
    // during the backoff must too, or a stale-tolerant panel blanks out for the
    // backoff's duration and then comes back, which is worse than either state.
    const inner = fakeInner([]);
    const disk = fakeDisk(cacheFile({
      snapshot: { ...goodSnapshot(42), capturedAt: T0 - 5 * MINUTE },
      blockedUntil: T0 + 2 * MINUTE,
      consecutiveFailures: 1,
    }));
    const provider = makeProvider(inner, disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.refreshError).toContain("rate limited");
  });

  it("still reports unavailable during a backoff for a caller that gates spending", async () => {
    const inner = fakeInner([]);
    const disk = fakeDisk(cacheFile({
      snapshot: { ...goodSnapshot(42), capturedAt: T0 - 5 * MINUTE },
      blockedUntil: T0 + 2 * MINUTE,
    }));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toContain("rate limited");
    expect(snapshot.windows).toEqual([]);
  });

  it("keeps serving the stored reading while another process holds the lock", async () => {
    // Contention is routine now that two applications share this cache, so it
    // must not blank a panel that asked for stale figures over none.
    const inner = fakeInner([]);
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(inner, disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
      acquireLock: () => {
        throw new Error("held");
      },
    });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.refreshError).toContain("another process");
  });

  it("respects a backoff another process armed while we waited for the lock", async () => {
    // The pre-lock read saw no backoff; the entry visible under the lock has one.
    // Missing it would send a force-refresh caller straight at a vendor that
    // just rate-limited someone else.
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    let handedOut = false;
    const provider = makeProvider(inner, disk, {
      freshMs: 0,
      acquireLock: () => {
        // Simulate the other process finishing between our read and our lock.
        disk.writeFileAtomic(
          CLAUDE_PATH,
          cacheFile({
            snapshot: { ...goodSnapshot(42), capturedAt: T0 - 5 * MINUTE },
            blockedUntil: T0 + 2 * MINUTE,
          }),
        );
        handedOut = true;
        return { lockPath: `${CACHE_DIR}/claude.lock`, release: () => undefined };
      },
    });

    const snapshot = await provider.getUsage();

    expect(handedOut).toBe(true);
    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toContain("rate limited");
  });

  it("keeps a valid weekly window after the 5h window in the same reading resets", async () => {
    // Claude and Codex report both windows in one reading. The 5h window
    // resetting says nothing about the weekly one, and discarding the whole
    // reading blanked a panel holding a perfectly good weekly figure.
    const inner = fakeInner([unavailableSnapshot("claude", "offline")]);
    const disk = fakeDisk(cacheFile({
      snapshot: {
        service: "claude",
        planType: "max",
        capturedAt: T0 - 30 * MINUTE,
        windows: [
          { label: "5h", usedPercent: 88, resetsAt: T0 - MINUTE },
          { label: "weekly", usedPercent: 21, resetsAt: T0 + 3 * 24 * 60 * MINUTE },
        ],
      },
    }));
    const provider = makeProvider(inner, disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.windows.map((window) => window.label)).toEqual(["weekly"]);
    expect(snapshot.windows[0]?.usedPercent).toBe(21);
    expect(snapshot.refreshError).toContain("offline");
  });

  it("does not serve a partially reset reading as current", async () => {
    // The strict rule still governs the fresh path: a caller that gates spending
    // must never be handed an incomplete window set dressed as a live reading.
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cacheFile({
      snapshot: {
        service: "claude",
        planType: "max",
        capturedAt: T0 - 100_000,
        windows: [
          { label: "5h", usedPercent: 88, resetsAt: T0 - 1_000 },
          { label: "weekly", usedPercent: 21, resetsAt: T0 + 3 * 24 * 60 * MINUTE },
        ],
      },
    }));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(1);
    expect(snapshot.windows.map((window) => window.label)).toEqual(["5h"]);
  });

  it("treats an out-of-range utilization in the cache file as a miss", async () => {
    // Cache files are editable and can be corrupt. A negative utilization reads
    // as spare capacity to the rail that decides whether to dispatch, so it has
    // to fail closed rather than be served as a recent reading.
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cacheFile({
      snapshot: {
        service: "claude",
        planType: "max",
        capturedAt: T0 - 1_000,
        windows: [{ label: "weekly", usedPercent: -1, resetsAt: T0 + 3 * 24 * 60 * MINUTE }],
      },
    }));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(1);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
  });

  it("keeps stale permission when a young reading has a reset window", async () => {
    // The reading is inside the fresh window by age, so the policy says "cached",
    // but one of its windows has rolled over so it cannot be served as current.
    // The caller's six-hour tolerance still applies to what is left of it.
    const inner = fakeInner([unavailableSnapshot("claude", "offline")]);
    const disk = fakeDisk(cacheFile({
      snapshot: {
        service: "claude",
        planType: "max",
        capturedAt: T0 - 100_000,
        windows: [
          { label: "5h", usedPercent: 88, resetsAt: T0 - 1_000 },
          { label: "weekly", usedPercent: 21, resetsAt: T0 + 3 * 24 * 60 * MINUTE },
        ],
      },
    }));
    const provider = makeProvider(inner, disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.windows.map((window) => window.label)).toEqual(["weekly"]);
    expect(snapshot.refreshError).toContain("offline");
  });

  it("still refuses a stale reading whose window has already reset", async () => {
    // A reset only lowers utilization, so a reading taken before one overstates
    // spend. Serving it as stale would be worse than saying nothing.
    const reset = T0 - MINUTE;
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42, reset));
    const provider = makeProvider(fakeInner([rateLimited]), disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    expect((await provider.getUsage()).unavailableReason).toContain("429");
  });
});

describe("CachingUsageProvider failed reads", () => {
  const rateLimited = unavailableSnapshot("claude", "usage request failed: HTTP 429", "rate-limited");

  it("reports the failure rather than serving the cached reading", async () => {
    // The cache never substitutes an older reading for a failed read. Doing so
    // would let the budget authorize work against capacity that a dispatch may
    // already have spent, and would hide a broken credential behind a number
    // that merely looks current.
    const inner = fakeInner([rateLimited]);
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toContain("429");
    expect(snapshot.windows).toEqual([]);
  });

  it("keeps the last good reading in the cache after a failed refresh", async () => {
    // It is no longer servable in place of a live read, but it is still the
    // baseline `record` diffs against.
    const inner = fakeInner([rateLimited]);
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    await provider.getUsage();

    expect(disk.entry()?.snapshot?.capturedAt).toBe(T0 - 5 * MINUTE);
  });

  it("reports unavailable rather than joining another process's fetch", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const provider = makeProvider(inner, disk, {
      freshMs: 2 * MINUTE,
      acquireLock: () => {
        throw new LockError("held by another process");
      },
    });

    const snapshot = await provider.getUsage();

    // Joining the fetch is the burst this cache exists to prevent.
    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toContain("another process");
  });
});

describe("CachingUsageProvider backoff", () => {
  const rateLimited = unavailableSnapshot("claude", "usage request failed: HTTP 429", "rate-limited");

  it("skips the request entirely while a backoff is in force", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(
      cacheFile({
        snapshot: { ...goodSnapshot(42), capturedAt: T0 - 5 * MINUTE },
        blockedUntil: T0 + MINUTE,
      }),
    );
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    // Not asking is the whole point of the backoff; the service is simply
    // unavailable until it lifts.
    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toContain("rate limited");
  });

  it("escalates the backoff on consecutive rate limits and caps it", async () => {
    const expected = [MINUTE, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE];
    const disk = fakeDisk();

    for (const [index, backoff] of expected.entries()) {
      const inner = fakeInner([rateLimited]);
      // Step the clock past each armed backoff so the next attempt is allowed.
      const now = T0 + index * 10 * MINUTE;
      const provider = makeProvider(inner, disk, { now, freshMs: 2 * MINUTE });

      await provider.getUsage();

      expect(inner.calls).toBe(1);
      expect(disk.entry()?.consecutiveFailures).toBe(index + 1);
      expect(disk.entry()?.blockedUntil).toBe(now + backoff);
    }
  });

  it("clears the backoff after a successful read", async () => {
    const disk = fakeDisk(cacheFile({ blockedUntil: T0 - MINUTE, consecutiveFailures: 3 }));
    const provider = makeProvider(fakeInner([goodSnapshot(13)]), disk, { freshMs: 2 * MINUTE });

    await provider.getUsage();

    expect(disk.entry()?.blockedUntil).toBeUndefined();
    expect(disk.entry()?.consecutiveFailures).toBeUndefined();
  });

  it("honors a provider-supplied deadline when it is longer than the floor", async () => {
    const disk = fakeDisk();
    const deadline = T0 + 10 * MINUTE;
    const inner = fakeInner([
      unavailableSnapshot("claude", "usage request failed: HTTP 429", "rate-limited", deadline),
    ]);
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    await provider.getUsage();

    expect(disk.entry()?.blockedUntil).toBe(deadline);
  });

  it("records only the attempt for a failure that is not a rate limit", async () => {
    // The reading and backoff stay as they were; the attempt still counts toward
    // the spacing, because the vendor may have seen it.
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const inner = fakeInner([unavailableSnapshot("claude", "network down")]);
    const provider = makeProvider(inner, disk, { freshMs: 2 * MINUTE });

    await provider.getUsage();
    const again = await makeProvider(inner, disk, { now: T0 + 30_000, freshMs: 2 * MINUTE }).getUsage();

    expect(disk.entry()?.snapshot?.capturedAt).toBe(T0 - 5 * MINUTE);
    expect(disk.entry()?.blockedUntil).toBeUndefined();
    expect(disk.entry()?.lastAttemptAt).toBe(T0);
    expect(inner.calls).toBe(1);
    expect(again.unavailableReason).toContain("next read allowed in 60s");
  });
});

describe("CachingUsageProvider request collapsing", () => {
  it("serves three back-to-back commands from one live read", async () => {
    // This is the meta loop's dispatch boundary: `record` then `budget`, and the
    // session sometimes re-running `budget`, all within a couple of minutes.
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk();

    const first = await makeProvider(inner, disk, { now: T0, freshMs: 2 * MINUTE }).getUsage();
    const second = await makeProvider(inner, disk, { now: T0 + 6_000, freshMs: 2 * MINUTE }).getUsage();
    const third = await makeProvider(inner, disk, { now: T0 + 56_000, freshMs: 2 * MINUTE }).getUsage();

    expect(inner.calls).toBe(1);
    for (const snapshot of [first, second, third]) {
      expect(snapshot.windows[0]?.usedPercent).toBe(13);
      expect(snapshot.capturedAt).toBe(T0);
    }
  });

  it("gives each service its own file so one refresh cannot drop another", async () => {
    const disk = fakeDisk(cachedReading(T0 - 30 * MINUTE, 42));
    const codexInner: UsageProvider = {
      service: "codex",
      getUsage: async () => ({
        service: "codex",
        planType: "pro",
        windows: [{ label: "weekly", usedPercent: 6, resetsAt: T0 + 5 * 24 * 60 * MINUTE }],
      }),
    };
    const provider = new CachingUsageProvider(codexInner, {
      cacheDir: CACHE_DIR,
      now: () => T0,
      freshness: maxAgeFreshness({ freshMs: 2 * MINUTE }),
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
      acquireLock: noopLock,
      logCall: () => undefined,
    });

    await provider.getUsage();

    // Refreshing codex writes only codex.json, so claude.json is untouched
    // byte-for-byte rather than merged and rewritten.
    expect(disk.files.get(CLAUDE_PATH)).toBe(cachedReading(T0 - 30 * MINUTE, 42));
    expect(disk.entry("codex")?.snapshot?.capturedAt).toBe(T0);
  });
});

describe("CachingUsageProvider capture time", () => {
  it("stamps a reading with the moment the request began", async () => {
    // `record` invalidates readings captured before a dispatch it could not
    // measure. A request that started before that cutoff reflects pre-dispatch
    // usage however long it takes to return, so stamping the completion time
    // would let it land after the cutoff and be trusted for spending.
    const disk = fakeDisk();
    let clock = T0;
    const inner: UsageProvider = {
      service: "claude",
      getUsage: async () => {
        clock = T0 + 5 * MINUTE; // the request takes a while
        return goodSnapshot(13);
      },
    };
    const provider = new CachingUsageProvider(inner, {
      cacheDir: CACHE_DIR,
      now: () => clock,
      freshness: maxAgeFreshness({ freshMs: 0 }),
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
      acquireLock: noopLock,
      logCall: () => undefined,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.capturedAt).toBe(T0);
    expect(disk.entry()?.snapshot?.capturedAt).toBe(T0);
  });
});

describe("invalidateCachedReading", () => {
  it("keeps an invalidated reading unservable when a racing writer restores it", async () => {
    // The race this guards: a process holds the lock, reads the entry, and is
    // waiting on the vendor. `record` invalidates the reading because a dispatch
    // happened that could not be measured. The holder then takes a 429 and
    // writes its pre-invalidation entry back, restoring a reading known to
    // understate usage. Deleting the snapshot alone cannot survive that; the
    // cutoff can.
    const disk = fakeDisk(cachedReading(T0 - 5 * MINUTE, 42));
    const staleEntry = disk.files.get(CLAUDE_PATH);

    invalidateCachedReading(CACHE_DIR, "claude", {
      capturedBefore: T0,
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
      removeFile: (path) => void disk.files.delete(path),
    });

    // The racing holder writes its pre-invalidation view back verbatim, snapshot
    // and all — it never saw the cutoff, and it does not write the file holding
    // one, which is the whole point.
    disk.writeFileAtomic(CLAUDE_PATH, staleEntry as string);

    const inner = fakeInner([unavailableSnapshot("claude", "offline")]);
    const provider = makeProvider(inner, disk, {
      freshMs: 2 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toContain("offline");
    expect(snapshot.windows).toEqual([]);
  });

  it("makes the reading unservable while keeping the backoff", async () => {
    const disk = fakeDisk(
      cacheFile({
        snapshot: { ...goodSnapshot(42), capturedAt: T0 - MINUTE },
        blockedUntil: T0 + MINUTE,
        consecutiveFailures: 2,
      }),
    );

    invalidateCachedReading(CACHE_DIR, "claude", {
      capturedBefore: T0,
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
    });

    // The entry file is left alone on purpose: the cutoff is what disqualifies
    // the reading, and rewriting the entry without the service lock would risk
    // deleting a trustworthy reading another process wrote in the meantime.
    expect(disk.entry()?.blockedUntil).toBe(T0 + MINUTE);
    expect(disk.entry()?.consecutiveFailures).toBe(2);

    // What matters is that the reading can no longer be served, backoff or not.
    const inner = fakeInner([unavailableSnapshot("claude", "offline")]);
    const provider = makeProvider(inner, disk, {
      now: T0 + 2 * MINUTE,
      freshMs: 10 * MINUTE,
      staleCeilingMs: 6 * 60 * MINUTE,
    });
    const snapshot = await provider.getUsage();
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.unavailableReason).toContain("offline");
  });

  it("makes the next read fail closed while the backoff is still armed", async () => {
    const disk = fakeDisk(
      cacheFile({
        snapshot: { ...goodSnapshot(42), capturedAt: T0 - MINUTE },
        blockedUntil: T0 + MINUTE,
      }),
    );
    const io = {
      capturedBefore: T0,
      readFile: (path: string) => disk.readFile(path),
      writeFileAtomic: (path: string, data: string) => disk.writeFileAtomic(path, data),
    };

    invalidateCachedReading(CACHE_DIR, "claude", io);

    const inner = fakeInner([goodSnapshot(13)]);
    const snapshot = await makeProvider(inner, disk, { freshMs: 2 * MINUTE }).getUsage();

    // Backoff still blocks the request, and there is no reading left to serve.
    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toContain("rate limited");
    expect(snapshot.windows).toEqual([]);
  });

  it("removes the entry when the invalidating rewrite fails", () => {
    // Otherwise the superseded reading survives and this function reports a
    // fail-closed result it did not actually achieve.
    const disk = fakeDisk(cachedReading(T0 - MINUTE, 42));
    const removed: string[] = [];

    invalidateCachedReading(CACHE_DIR, "claude", {
      capturedBefore: T0,
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: () => {
        throw new Error("EACCES");
      },
      removeFile: (path) => removed.push(path),
    });

    expect(removed).toEqual([CLAUDE_PATH]);
  });

  it("records the cutoff even with no stored reading to drop", () => {
    const disk = fakeDisk();

    expect(() =>
      invalidateCachedReading(CACHE_DIR, "claude", {
        capturedBefore: T0,
        readFile: (path) => disk.readFile(path),
        writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
      }),
    ).not.toThrow();
    // The cutoff is recorded regardless: a concurrent fetch already in flight can
    // still write a reading captured before it, and that reading must not count.
    expect(disk.files.has(`${CACHE_DIR}/claude.invalid.json`)).toBe(true);
  });

  it("keeps a reading another process captured after the cutoff", () => {
    // A concurrent successful refresh writes a trustworthy reading. Dropping it
    // would throw away exactly the number the next budget needs and force
    // another live request seconds later.
    const disk = fakeDisk(cacheFile({ snapshot: { ...goodSnapshot(51), capturedAt: T0 + 1_000 } }));

    invalidateCachedReading(CACHE_DIR, "claude", {
      capturedBefore: T0,
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
    });

    // Assert no cutoff was recorded, not that the entry file is untouched:
    // invalidation stopped writing that file, so the old assertion passed
    // whether or not the guard it was named for still existed.
    expect(disk.files.has(`${CACHE_DIR}/claude.invalid.json`)).toBe(false);

    // And the reading is still served.
    const provider = makeProvider(fakeInner([]), disk, { freshMs: 10 * MINUTE });
    return provider.getUsage().then((snapshot) => {
      expect(snapshot.windows[0]?.usedPercent).toBe(51);
    });
  });
});

describe("CachingUsageProvider spacing and waiting", () => {
  /** A provider on a clock the test moves; `sleep` advances it. */
  function spaced(
    inner: UsageProvider,
    disk: ReturnType<typeof fakeDisk>,
    options: { freshness?: Freshness; maxWaitMs?: number; acquireLock?: () => LockHandle; onSleep?: (ms: number) => void } = {},
  ) {
    const clock = { now: T0, slept: [] as number[] };
    const provider = new CachingUsageProvider(inner, {
      cacheDir: CACHE_DIR,
      now: () => clock.now,
      freshness: options.freshness ?? maxAgeFreshness({ freshMs: 2 * MINUTE }),
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
      acquireLock: options.acquireLock ?? noopLock,
      maxWaitMs: options.maxWaitMs,
      sleep: async (ms) => {
        clock.slept.push(ms);
        clock.now += ms;
        options.onSleep?.(ms);
      },
      logCall: () => undefined,
    });
    return { provider, clock };
  }

  /** A reading another process took, already ruled out by an invalidation. */
  function invalidatedRecentReading(disk: ReturnType<typeof fakeDisk>, attemptedAt: number): void {
    disk.files.set(CLAUDE_PATH, cacheFile({
      snapshot: { ...goodSnapshot(42), capturedAt: attemptedAt },
      lastAttemptAt: attemptedAt,
    }));
    invalidateCachedReading(CACHE_DIR, "claude", {
      capturedBefore: T0 - 1,
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
    });
  }

  it("does not call a service again within 90s of the last attempt, even after an invalidation", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk();
    invalidatedRecentReading(disk, T0 - 30_000);
    const { provider, clock } = spaced(inner, disk);

    const blocked = await provider.getUsage();
    expect(inner.calls).toBe(0);
    expect(blocked.unavailableReason).toContain("next read allowed in 60s");
    expect(blocked.unavailableKind).toBeUndefined();

    clock.now = T0 + 60_000;
    const allowed = await provider.getUsage();
    expect(inner.calls).toBe(1);
    expect(allowed.windows[0]?.usedPercent).toBe(13);
    expect(disk.entry()?.lastAttemptAt).toBe(T0 + 60_000);
  });

  it("spaces calls from an entry written before attempts were recorded by its reading's capture time", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cachedReading(T0 - 30_000, 42));
    const { provider } = spaced(inner, disk, { freshness: maxAgeFreshness({ freshMs: 0 }) });

    expect((await provider.getUsage()).unavailableReason).toContain("next read allowed in 60s");
    expect(inner.calls).toBe(0);
  });

  it("spaces an invalidated old-format entry by its reading's capture time", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cachedReading(T0 - 30_000, 42));
    invalidateCachedReading(CACHE_DIR, "claude", {
      capturedBefore: T0 - 1,
      readFile: (path) => disk.readFile(path),
      writeFileAtomic: (path, data) => disk.writeFileAtomic(path, data),
    });
    const { provider } = spaced(inner, disk);

    expect((await provider.getUsage()).unavailableReason).toContain("next read allowed in 60s");
    expect(inner.calls).toBe(0);
  });

  it("treats a corrupt capture time as no attempt rather than wedging the read", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cacheFile({ snapshot: { ...goodSnapshot(42), capturedAt: "bad" } }));

    const snapshot = await makeProvider(inner, disk, { freshMs: 2 * MINUTE }).getUsage();

    expect(inner.calls).toBe(1);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
  });

  it("records the attempt on a rate limit so the next call waits for both rules", async () => {
    const disk = fakeDisk();
    const { provider } = spaced(fakeInner([RATE_LIMITED]), disk);

    await provider.getUsage();

    expect(disk.entry()?.lastAttemptAt).toBe(T0);
    expect(disk.entry()?.blockedUntil).toBe(T0 + MINUTE);
  });

  it("waits for the next allowed read when the caller opts in", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk();
    invalidatedRecentReading(disk, T0 - 30_000);
    const { provider, clock } = spaced(inner, disk, { maxWaitMs: 2 * MINUTE });

    const snapshot = await provider.getUsage();

    // Checks the shared reading every 5s until the next allowed call, 60s on.
    expect(clock.slept).toEqual(Array(12).fill(5_000));
    expect(inner.calls).toBe(1);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
  });

  it("takes another process's newer reading while waiting, without a call of its own", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk();
    invalidatedRecentReading(disk, T0 - 30_000);
    const { provider, clock } = spaced(inner, disk, {
      freshness: capturedAfterFreshness(T0),
      maxWaitMs: 2 * MINUTE,
      onSleep: () => disk.files.set(CLAUDE_PATH, cacheFile({
        snapshot: { ...goodSnapshot(77), capturedAt: T0 + 10_000 },
        lastAttemptAt: T0 + 10_000,
      })),
    });

    const snapshot = await provider.getUsage();

    expect(inner.calls).toBe(0);
    expect(snapshot.windows[0]?.usedPercent).toBe(77);
    // Found at the first 5s check, not after the 60s left on the spacing.
    expect(clock.slept).toEqual([5_000]);
  });

  it("does not wait when it already holds a stale reading the caller accepts", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk(cacheFile({
      snapshot: { ...goodSnapshot(42), capturedAt: T0 - 30_000 },
      lastAttemptAt: T0 - 30_000,
    }));
    const { provider, clock } = spaced(inner, disk, {
      freshness: maxAgeFreshness({ freshMs: 10_000, staleCeilingMs: 6 * 60 * MINUTE }),
      maxWaitMs: 2 * MINUTE,
    });

    const snapshot = await provider.getUsage();

    expect(clock.slept).toEqual([]);
    expect(inner.calls).toBe(0);
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.refreshError).toContain("next read allowed");
  });

  it("keeps checking until its wait runs out, then gives up", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    const disk = fakeDisk();
    invalidatedRecentReading(disk, T0 - 30_000);
    const { provider, clock } = spaced(inner, disk, { maxWaitMs: 12_000 });

    const snapshot = await provider.getUsage();

    expect(clock.slept).toEqual([5_000, 5_000, 2_000]);
    expect(inner.calls).toBe(0);
    expect(snapshot.unavailableReason).toContain("next read allowed");
  });

  it("waits out another process's fetch and then reads", async () => {
    const inner = fakeInner([goodSnapshot(13)]);
    let attempts = 0;
    const { provider, clock } = spaced(inner, fakeDisk(), {
      maxWaitMs: 2 * MINUTE,
      acquireLock: () => {
        attempts += 1;
        if (attempts === 1) throw new LockError("held by another process");
        return noopLock();
      },
    });

    const snapshot = await provider.getUsage();

    expect(clock.slept).toEqual([1_000]);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
  });
});

describe("capturedAfterFreshness", () => {
  it("serves only a reading captured at or after the cutoff", () => {
    const freshness = capturedAfterFreshness(T0);
    expect(freshness({ ...goodSnapshot(), capturedAt: T0 - 1 }, T0)).toEqual({ use: "refresh" });
    expect(freshness({ ...goodSnapshot(), capturedAt: T0 }, T0)).toEqual({ use: "cached" });
    expect(freshness(undefined, T0)).toEqual({ use: "refresh" });
  });
});

describe("call log", () => {
  it("logs each live call with its caller and outcome, and nothing for a cached read", async () => {
    const logged: CallLogEntry[] = [];
    const disk = fakeDisk();
    const read = (now: number, response: UsageSnapshot) => makeProvider(fakeInner([response]), disk, {
      now,
      freshMs: 2 * MINUTE,
      caller: "meta-loop budget",
      logCall: (entry) => logged.push(entry),
    }).getUsage();

    await read(T0, goodSnapshot(13));
    await read(T0 + MINUTE, goodSnapshot(13));
    await read(T0 + 3 * MINUTE, RATE_LIMITED);

    expect(logged).toEqual([
      { at: new Date(T0).toISOString(), service: "claude", caller: "meta-loop budget", outcome: "ok", ms: 0 },
      {
        at: new Date(T0 + 3 * MINUTE).toISOString(),
        service: "claude",
        caller: "meta-loop budget",
        outcome: "rate-limited",
        ms: 0,
        reason: "usage request failed: HTTP 429",
      },
    ]);
  });

  it("records the attempt before calling, and survives a logger that throws", async () => {
    const disk = fakeDisk();
    let seenAttempt: number | undefined;
    const inner: UsageProvider = {
      service: "claude",
      getUsage: async () => {
        seenAttempt = disk.entry()?.lastAttemptAt;
        return goodSnapshot(13);
      },
    };
    const snapshot = await makeProvider(inner, disk, {
      logCall: () => {
        throw new Error("disk full");
      },
    }).getUsage();

    expect(seenAttempt).toBe(T0);
    expect(snapshot.windows[0]?.usedPercent).toBe(13);
  });

  it("moves a full log aside and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-call-log-"));
    try {
      const path = join(dir, "calls.log");
      const entry: CallLogEntry = { at: "2026-10-10T00:00:00.000Z", service: "claude", caller: "test", outcome: "ok", ms: 1 };
      writeFileSync(path, "x".repeat(200));
      appendCallLog(path, entry, 100);
      expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(200));
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry);
      expect(() => appendCallLog(join(dir, "missing", "calls.log"), entry)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

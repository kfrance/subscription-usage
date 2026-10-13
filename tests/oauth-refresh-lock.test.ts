import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockError } from "../src/lib/lock.js";
import {
  acquireOauthRefreshLock,
  oauthHolderIsGone,
  oauthPidDomain,
  oauthPidSpace,
  oauthPidViewIsTrusted,
  procStatField,
  type OauthHolderProbe,
  type OauthLockProcess,
  type OauthRefreshLockFs,
} from "../src/lib/oauth-refresh-lock.js";

/**
 * The real `mkdir` lock Claude Code uses. A temp directory only — this file
 * never creates `~/.claude/.oauth_refresh.lock`.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oauth-refresh-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireOauthRefreshLock", () => {
  it("creates a directory lock and releases it", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const handle = acquireOauthRefreshLock(path);
    const stat = statSync(path);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.birthtimeMs).toBeGreaterThan(0);
    const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8")) as Record<string, unknown>;
    const namespace = readlinkSync("/proc/self/ns/pid");
    expect(owner.pid).toBe(process.pid);
    expect(owner.procStart).toBe(procStatField(readFileSync(`/proc/${process.pid}/stat`, "utf8"), 19));
    expect(owner.pidDomain).toBe(`linux:${readFileSync("/etc/machine-id", "utf8").trim()}:${namespace}`);
    expect(owner.pidSpace).toBe(`${hostname()}#${namespace}`);
    expect(owner.lockBirthtimeMs).toBe(stat.birthtimeMs);
    expect(owner.legacyLockBirthtimeMs).toBeUndefined();
    expect(statSync(`${path}.owner`).mode & 0o777).toBe(0o600);
    expect(handle.compromised?.()).toBe(false);
    handle.release();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.owner`)).toBe(false);
  });

  it("treats a fresh directory as held and leaves it in place", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const first = acquireOauthRefreshLock(path);
    expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
    expect(statSync(path).isDirectory()).toBe(true);
    first.release();
    const second = acquireOauthRefreshLock(path);
    second.release();
    expect(existsSync(path)).toBe(false);
  });

  it("ignores a repeated release", () => {
    const handle = acquireOauthRefreshLock(join(dir, ".oauth_refresh.lock"));
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  it("a bare directory lock does not write an owner file or take over a dead holder", () => {
    const path = join(dir, ".storage-write.lock");
    const held = acquireOauthRefreshLock(path, { ownerRecord: false, updateMs: 60_000 });
    expect(existsSync(`${path}.owner`)).toBe(false);
    expect(() => acquireOauthRefreshLock(path, { ownerRecord: false })).toThrow(LockError);
    expect(existsSync(path)).toBe(true);
    held.release();
    expect(existsSync(path)).toBe(false);

    mkdirSync(path);
    const birthtimeMs = statSync(path).birthtimeMs;
    writeFileSync(`${path}.owner`, JSON.stringify({
      pid: 2_147_483_647,
      pidDomain: "linux:machine:ns",
      pidSpace: "host#ns",
      lockBirthtimeMs: birthtimeMs,
    }));
    const before = statSync(path).mtimeMs;
    expect(() => acquireOauthRefreshLock(path, { ownerRecord: false })).toThrow(LockError);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(existsSync(`${path}.owner`)).toBe(true);
  });

  it("leaves a stale lock directory in place", () => {
    const path = join(dir, ".oauth_refresh.lock");
    mkdirSync(path);
    const stale = new Date(Date.now() - 61_000);
    utimesSync(path, stale, stale);
    const before = statSync(path).mtimeMs;
    expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("does not delete a regular file sitting at the lock path", () => {
    const path = join(dir, ".oauth_refresh.lock");
    writeFileSync(path, "keep");
    expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
    expect(readFileSync(path, "utf8")).toBe("keep");
  });

  it("heartbeats the lock until release", async () => {
    vi.useFakeTimers();
    try {
      const touches: number[] = [];
      let exists = false;
      const fs: OauthRefreshLockFs = {
        mkdir() {
          exists = true;
        },
        rmdir() {
          exists = false;
        },
        stat() {
          return exists ? { mtimeMs: 0, isDirectory: true } : undefined;
        },
        utimes() {
          touches.push(touches.length);
        },
      };
      const handle = acquireOauthRefreshLock(join(dir, ".oauth_refresh.lock"), {
        fs,
        updateMs: 5_000,
      });
      expect(touches).toEqual([0]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(touches).toEqual([0, 1]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(touches).toEqual([0, 1, 2]);
      handle.release();
      expect(exists).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(touches).toEqual([0, 1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not touch or remove a lock directory a sibling reclaimed", async () => {
    vi.useFakeTimers();
    try {
      let ino = 1;
      let utimes = 0;
      let rmdirs = 0;
      const fs: OauthRefreshLockFs = {
        mkdir() {
          return undefined;
        },
        rmdir() {
          rmdirs += 1;
        },
        stat() {
          return { mtimeMs: 0, isDirectory: true, ino };
        },
        utimes() {
          utimes += 1;
        },
      };
      const handle = acquireOauthRefreshLock(join(dir, ".oauth_refresh.lock"), {
        fs,
        updateMs: 5_000,
      });
      expect(utimes).toBe(1);
      ino = 2;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(utimes).toBe(1);
      expect(handle.compromised?.()).toBe(true);
      handle.release();
      expect(rmdirs).toBe(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(utimes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep a reclaimed directory whose inode was reused", async () => {
    vi.useFakeTimers();
    try {
      let mtimeMs = 10;
      let utimes = 0;
      let rmdirs = 0;
      const fs: OauthRefreshLockFs = {
        mkdir() {
          return undefined;
        },
        rmdir() {
          rmdirs += 1;
        },
        stat() {
          return { mtimeMs, isDirectory: true, ino: 7 };
        },
        utimes() {
          utimes += 1;
          mtimeMs += 1;
        },
      };
      const handle = acquireOauthRefreshLock(join(dir, ".oauth_refresh.lock"), {
        fs,
        updateMs: 5_000,
      });
      expect(utimes).toBe(1);
      // Same inode, different mtime: a new directory, not our last heartbeat.
      mtimeMs = 100;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(utimes).toBe(1);
      expect(handle.compromised?.()).toBe(true);
      handle.release();
      expect(rmdirs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not take a live holder's directory when its mtime is old", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const held = acquireOauthRefreshLock(path, { updateMs: 60_000 });
    const stale = new Date(Date.now() - 120_000);
    utimesSync(path, stale, stale);
    const before = statSync(path);
    try {
      expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
      const after = statSync(path);
      expect(after.ino).toBe(before.ino);
      expect(after.birthtimeMs).toBe(before.birthtimeMs);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      held.release();
    }
  });

  it("takes over a lock whose owner process is dead and writes its own record", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const identity = writtenIdentity();
    mkdirSync(path);
    const birthtimeMs = statSync(path).birthtimeMs;
    writeOwner(path, {
      pid: unusedPid(),
      pidDomain: identity.pidDomain,
      pidSpace: identity.pidSpace,
      lockBirthtimeMs: birthtimeMs,
    });
    const handle = acquireOauthRefreshLock(path);
    const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8")) as { pid: number; lockBirthtimeMs: number };
    expect(owner.pid).toBe(process.pid);
    expect(owner.lockBirthtimeMs).toBe(statSync(path).birthtimeMs);
    expect(owner.lockBirthtimeMs).toBeGreaterThan(0);
    handle.release();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.owner`)).toBe(false);
  });

  it.each([
    ["not json", "not-json"],
    ["pid 1", JSON.stringify({ pid: 1, pidDomain: "d", pidSpace: "s", lockBirthtimeMs: 10 })],
    ["a string pid", JSON.stringify({ pid: "10", pidDomain: "d", pidSpace: "s", lockBirthtimeMs: 10 })],
    ["no domain", JSON.stringify({ pid: 10, pidSpace: "s", lockBirthtimeMs: 10 })],
    ["an overlong procStart", JSON.stringify({
      pid: 10,
      procStart: "x".repeat(65),
      pidDomain: "d",
      pidSpace: "s",
      lockBirthtimeMs: 10,
    })],
  ])("leaves the directory when the owner record is %s", (_label, body) => {
    const path = join(dir, ".oauth_refresh.lock");
    mkdirSync(path);
    writeFileSync(`${path}.owner`, body);
    const before = statSync(path).mtimeMs;
    expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readFileSync(`${path}.owner`, "utf8")).toBe(body);
  });

  it("leaves a dead holder's directory when the pid domain or space differs", () => {
    const identity = writtenIdentity();
    expectHeld(deadOwner({ ...identity, pidDomain: `${identity.pidDomain}-other` }));
    expectHeld(deadOwner({ ...identity, pidSpace: `${identity.pidSpace}-other` }));
  });

  it("leaves a dead holder's directory when the birthtime does not match", () => {
    const path = deadOwner(writtenIdentity());
    const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8")) as { lockBirthtimeMs: number };
    owner.lockBirthtimeMs += 1;
    writeFileSync(`${path}.owner`, JSON.stringify(owner));
    const before = statSync(path).mtimeMs;
    expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("leaves the directory when the pid view is untrusted or the probe throws", () => {
    const record = {
      pid: 50,
      pidDomain: "linux:machine:ns",
      pidSpace: "host#ns",
    };
    expectHeld(deadOwner(record), view({ pidViewTrusted: () => false, holderGone: () => true }));
    expectHeld(deadOwner(record), view({
      holderGone: () => {
        throw new Error("probe failed");
      },
    }));
  });

  it("does not remove the directory when its mtime changes before the removal", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const removed: string[] = [];
    let reads = 0;
    const fs = directoryFs(path, {
      mkdir() {
        const error = new Error("exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      },
      stat(file) {
        if (file !== path) return undefined;
        reads += 1;
        return { mtimeMs: reads === 1 ? 10 : 11, isDirectory: true, birthtimeMs: 50, ino: 3 };
      },
      rmdir(lockPath) {
        removed.push(lockPath);
      },
    });
    expect(() => acquireOauthRefreshLock(path, {
      fs,
      process: view({ holderGone: () => true }),
    })).toThrow(LockError);
    expect(removed).toEqual([]);
  });

  it("does not unlink the owner or remove a directory once its inode changes", () => {
    const path = join(dir, ".oauth_refresh.lock");
    let ino = 1;
    let unlinks = 0;
    let rmdirs = 0;
    const ours = JSON.stringify({
      pid: 4242,
      pidDomain: "linux:machine:ns",
      pidSpace: "host#ns",
      lockBirthtimeMs: 50,
    });
    const fs = directoryFs(path, {
      stat: () => ({ mtimeMs: 4, isDirectory: true, birthtimeMs: 50, ino }),
      readFile: () => ours,
      rmdir() {
        rmdirs += 1;
      },
      unlink() {
        unlinks += 1;
      },
    });
    const handle = acquireOauthRefreshLock(path, { fs, process: view(), updateMs: 60_000 });
    ino = 2;
    expect(handle.compromised?.()).toBe(true);
    handle.release();
    expect(unlinks).toBe(0);
    expect(rmdirs).toBe(0);
  });

  it("does not delete an owner file another holder replaced", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const handle = acquireOauthRefreshLock(path, { updateMs: 60_000 });
    const replacement = JSON.stringify({
      pid: unusedPid(),
      pidDomain: "other",
      pidSpace: "other",
      lockBirthtimeMs: 1,
    });
    writeFileSync(`${path}.owner`, replacement);
    handle.release();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.owner`, "utf8")).toBe(replacement);
  });

  it("does not remove a live holder's legacy lock", () => {
    withLegacy((legacy) => {
      mkdirSync(legacy);
      const path = join(dir, ".oauth_refresh.lock");
      const held = acquireOauthRefreshLock(path, { updateMs: 60_000 });
      const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8")) as Record<string, unknown>;
      owner.legacyLockBirthtimeMs = statSync(legacy).birthtimeMs;
      writeFileSync(`${path}.owner`, JSON.stringify(owner));
      const before = statSync(path).ino;
      try {
        expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
        expect(existsSync(legacy)).toBe(true);
        expect(statSync(path).ino).toBe(before);
      } finally {
        held.release();
      }
    });
  });

  it("removes a matching legacy lock only while taking over a dead holder", () => {
    withLegacy((legacy) => {
      mkdirSync(legacy);
      const identity = writtenIdentity();
      const path = join(dir, ".oauth_refresh.lock");
      mkdirSync(path);
      writeOwner(path, {
        ...identity,
        pid: unusedPid(),
        lockBirthtimeMs: statSync(path).birthtimeMs,
        legacyLockBirthtimeMs: statSync(legacy).birthtimeMs,
      });
      const handle = acquireOauthRefreshLock(path);
      expect(existsSync(legacy)).toBe(false);
      expect(statSync(path).isDirectory()).toBe(true);
      handle.release();
    });
  });

  it("leaves both locks when a legacy lock's birthtime does not match", () => {
    withLegacy((legacy) => {
      mkdirSync(legacy);
      const path = deadOwner(writtenIdentity());
      const before = statSync(path).mtimeMs;
      expect(() => acquireOauthRefreshLock(path)).toThrow(LockError);
      expect(existsSync(legacy)).toBe(true);
      expect(statSync(path).mtimeMs).toBe(before);
    });
  });

  it("keeps the directory when the owner file cannot be written", () => {
    const path = join(dir, ".oauth_refresh.lock");
    const fs = directoryFs(path, {
      writeFile() {
        throw new Error("disk full");
      },
    });
    const handle = acquireOauthRefreshLock(path, { fs, process: view(), updateMs: 60_000 });
    expect(handle.compromised?.()).toBe(false);
    handle.release();
  });
});

describe("oauth owner predicates", () => {
  const probe = (overrides: Partial<OauthHolderProbe> = {}): OauthHolderProbe => ({
    signal: () => "present",
    state: () => "R",
    startTime: () => "100",
    ...overrides,
  });

  it("reads proc fields after the comm that may itself contain parentheses", () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_value, index) => String(index + 1)), "99999"];
    expect(fields[19]).toBe("99999");
    const text = `12 (bash) ${fields.join(" ")}`;
    expect(procStatField(text, 0)).toBe("S");
    expect(procStatField(text, 19)).toBe("99999");
    expect(procStatField("12 (weird) name) Z 1", 0)).toBe("Z");
    expect(procStatField("no paren", 0)).toBeUndefined();
  });

  it("proves a holder gone only for ESRCH, a zombie, or a replaced starttime", () => {
    expect(oauthHolderIsGone({ pid: 1 }, probe({ signal: () => "esrch" }))).toBe(false);
    expect(oauthHolderIsGone({ pid: 1.5 }, probe({ signal: () => "esrch" }))).toBe(false);
    expect(oauthHolderIsGone({ pid: 2_147_483_648 }, probe({ signal: () => "esrch" }))).toBe(false);
    expect(oauthHolderIsGone({ pid: 10 }, probe({ signal: () => "esrch" }))).toBe(true);
    expect(oauthHolderIsGone({ pid: 10, procStart: "100" }, probe({ signal: () => "other" }))).toBe(false);
    expect(oauthHolderIsGone({ pid: 10 }, probe({ state: () => "Z" }))).toBe(true);
    expect(oauthHolderIsGone({ pid: 10 }, probe({ state: () => "X" }))).toBe(true);
    expect(oauthHolderIsGone({ pid: 10, procStart: "100" }, probe({ startTime: () => "200" }))).toBe(true);
    expect(oauthHolderIsGone({ pid: 10, procStart: "100" }, probe({ startTime: () => undefined }))).toBe(false);
    expect(oauthHolderIsGone({ pid: 10 }, probe({ startTime: () => "200" }))).toBe(false);
    expect(oauthHolderIsGone({ pid: 10, procStart: "100" }, probe())).toBe(false);
  });

  it("builds Claude's pid domain and pid space", () => {
    expect(oauthPidDomain({
      platform: "linux",
      hostname: "Host",
      machineId: "abc",
      pidNamespace: "pid:[1]",
    })).toBe("linux:abc:pid:[1]");
    expect(oauthPidDomain({ platform: "win32", hostname: "Host" })).toBe("linux:host");
    expect(oauthPidDomain({ platform: "darwin", hostname: "Host" })).toBe("linux");
    expect(oauthPidSpace({ platform: "linux", hostname: "Host", pidNamespace: "pid:[1]" })).toBe("Host#pid:[1]");
    expect(oauthPidSpace({ platform: "linux", hostname: "Host", pidNamespace: "" })).toBe("Host");
    expect(oauthPidSpace({ platform: "darwin", hostname: "Host", pidNamespace: "pid:[1]" })).toBe("Host");
  });

  it("trusts a Linux pid view only when /proc/self matches and enough pids are listed", () => {
    const pids = (count: number) => Array.from({ length: count }, (_value, index) => String(index + 1));
    const trusted = (overrides: Partial<Parameters<typeof oauthPidViewIsTrusted>[0]> = {}) => oauthPidViewIsTrusted({
      platform: "linux",
      pid: 20,
      readSelf: () => "20",
      listProc: () => pids(16),
      ...overrides,
    });
    expect(trusted()).toBe(true);
    expect(trusted({ listProc: () => pids(15) })).toBe(false);
    expect(trusted({ readSelf: () => "21" })).toBe(false);
    expect(trusted({ readSelf: () => { throw new Error("unreadable"); } })).toBe(false);
    expect(trusted({ platform: "darwin", readSelf: () => "nope", listProc: () => [] })).toBe(true);
  });
});

/** Identity this process just wrote, so a dead-holder fixture matches the local probe. */
function writtenIdentity(): { pidDomain: string; pidSpace: string } {
  const path = join(dir, ".identity.lock");
  const handle = acquireOauthRefreshLock(path, { updateMs: 60_000 });
  try {
    return JSON.parse(readFileSync(`${path}.owner`, "utf8")) as { pidDomain: string; pidSpace: string };
  } finally {
    handle.release();
  }
}

/** A lock directory whose owner is a pid that is not running. Returns the lock path. */
function deadOwner(record: {
  pid?: number;
  pidDomain: string;
  pidSpace: string;
  legacyLockBirthtimeMs?: number;
}): string {
  const path = join(dir, `.dead-${Math.random().toString(16).slice(2)}.lock`);
  mkdirSync(path);
  writeOwner(path, {
    pid: record.pid ?? unusedPid(),
    pidDomain: record.pidDomain,
    pidSpace: record.pidSpace,
    lockBirthtimeMs: statSync(path).birthtimeMs,
    legacyLockBirthtimeMs: record.legacyLockBirthtimeMs,
  });
  return path;
}

function writeOwner(path: string, record: Record<string, unknown>): void {
  const body: Record<string, unknown> = {
    pid: record.pid,
    pidDomain: record.pidDomain,
    pidSpace: record.pidSpace,
    lockBirthtimeMs: record.lockBirthtimeMs,
  };
  if (record.legacyLockBirthtimeMs !== undefined) {
    body.legacyLockBirthtimeMs = record.legacyLockBirthtimeMs;
  }
  writeFileSync(`${path}.owner`, JSON.stringify(body), { mode: 0o600 });
}

function expectHeld(path: string, proc?: OauthLockProcess): void {
  const before = statSync(path);
  expect(() => acquireOauthRefreshLock(path, proc ? { process: proc } : {})).toThrow(LockError);
  const after = statSync(path);
  expect(after.ino).toBe(before.ino);
  expect(after.birthtimeMs).toBe(before.birthtimeMs);
  expect(after.mtimeMs).toBe(before.mtimeMs);
}

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

function view(overrides: Partial<OauthLockProcess> = {}): OauthLockProcess {
  return {
    pid: 4242,
    procStart: () => "100",
    pidDomain: () => "linux:machine:ns",
    pidSpace: () => "host#ns",
    pidViewTrusted: () => true,
    holderGone: () => false,
    ...overrides,
  };
}

function directoryFs(path: string, overrides: Partial<OauthRefreshLockFs>): OauthRefreshLockFs {
  const owner = JSON.stringify({
    pid: 99,
    procStart: "100",
    pidDomain: "linux:machine:ns",
    pidSpace: "host#ns",
    lockBirthtimeMs: 50,
  });
  return {
    mkdir() {
      return undefined;
    },
    rmdir() {
      return undefined;
    },
    stat() {
      return { mtimeMs: 4, isDirectory: true, birthtimeMs: 50, ino: 1 };
    },
    utimes() {
      return undefined;
    },
    readFile(file) {
      return file === `${path}.owner` ? owner : undefined;
    },
    writeFile() {
      return undefined;
    },
    unlink() {
      return undefined;
    },
    realpath(file) {
      return file;
    },
    ...overrides,
  };
}

function withLegacy(body: (legacy: string) => void): void {
  const legacy = `${realpathSync(dir)}.lock`;
  try {
    body(legacy);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
}

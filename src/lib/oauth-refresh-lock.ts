import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { LockError, type LockHandle } from "./lock.js";
import { finiteNumber, isRecord } from "./values.js";

/**
 * Claude Code heartbeats `.oauth_refresh.lock` every 5s (`proper-lockfile`'s
 * `update`). A live holder stays inside Claude's 60s stale window. This module
 * does not copy that age-based delete: a directory is removed only when its
 * sibling `.oauth_refresh.lock.owner` record proves the holder is dead, which
 * is Claude 2.1.296's dead-holder takeover. A crash before the owner write, or
 * any record that does not prove death, leaves the directory in place.
 */
const UPDATE_MS = 5_000;
const PID_DOMAIN_MAX = 512;
const PID_SPACE_MAX = 512;
const PROC_START_MAX = 64;
const PID_MAX = 2_147_483_647;
const PROC_STATE_INDEX = 0;
const PROC_START_INDEX = 19;
const TRUSTED_PID_COUNT = 16;

export interface OauthRefreshLockOptions {
  /** Defaults to 5s, Claude's mtime heartbeat. */
  updateMs?: number;
  /** Injectable filesystem. Defaults to `node:fs`. Tests pass a temp directory either way. */
  fs?: OauthRefreshLockFs;
  /**
   * Identity and dead-holder probe. Defaults to this process, `/proc`, and
   * `process.kill(pid, 0)`. Tests inject this so they never signal a real pid.
   */
  process?: OauthLockProcess;
  /**
   * Write `.oauth_refresh.lock.owner` and take over a proven-dead holder.
   * Set false for Claude's `.storage-write.lock`, a proper-lockfile directory
   * with no owner record. A held directory is then left in place.
   */
  ownerRecord?: boolean;
}

export interface OauthRefreshLockStat {
  mtimeMs: number;
  isDirectory: boolean;
  /**
   * Identity of this directory. A replacement `mkdir` has a different inode, which
   * is how a holder notices that someone reclaimed a stale lock.
   */
  ino?: number;
  /** `birthtimeMs` from `stat`. Absent or `0` means no owner record is written. */
  birthtimeMs?: number;
}

/**
 * The filesystem surface the lock needs. Every method may throw.
 * Owner-file methods are optional so a fake that only models the directory still
 * typechecks. Without `readFile`, a leftover directory cannot be taken over.
 */
export interface OauthRefreshLockFs {
  mkdir(path: string): void;
  rmdir(path: string): void;
  /** Undefined when the path does not exist. */
  stat(path: string): OauthRefreshLockStat | undefined;
  utimes(path: string): void;
  /** Undefined when the path does not exist. */
  readFile?(path: string): string | undefined;
  writeFile?(path: string, data: string): void;
  unlink?(path: string): void;
  /** Undefined when the path does not exist. */
  realpath?(path: string): string | undefined;
}

/** Process identity Claude stores in `.oauth_refresh.lock.owner`, plus the dead-holder probe. */
export interface OauthLockProcess {
  pid: number;
  /** `starttime` from `/proc/<pid>/stat`, or undefined when it cannot be read. */
  procStart(): string | undefined;
  pidDomain(): string;
  pidSpace(): string;
  /** False when `/proc` is not a trustworthy view of local pids. */
  pidViewTrusted(): boolean;
  /**
   * True only when this holder is proven gone: `ESRCH`, a zombie or dead
   * state, or a readable starttime that differs from the recorded one.
   */
  holderGone(holder: { pid: number; procStart?: string }): boolean;
}

interface OwnerRecord {
  pid: number;
  procStart?: string;
  pidDomain: string;
  pidSpace: string;
  lockBirthtimeMs: number;
  legacyLockBirthtimeMs?: number;
}

/**
 * Hold the same refresh lock Claude Code holds.
 *
 * Claude does not use `flock`. It `mkdir`s `~/.claude/.oauth_refresh.lock` and
 * writes `.oauth_refresh.lock.owner` beside it. A file at the lock path is not
 * a lock Claude understands, so it is left untouched. A directory is also left
 * untouched unless that owner record proves the holder is dead and the
 * directory's mtime and birthtime still match the record at the moment of removal.
 */
export function acquireOauthRefreshLock(
  lockPath: string,
  options: OauthRefreshLockOptions = {},
): LockHandle {
  const updateMs = options.updateMs ?? UPDATE_MS;
  const fs = options.fs ?? nodeLockFs();
  const proc = options.process ?? nodeLockProcess();
  const ownerRecord = options.ownerRecord !== false;

  claim(lockPath, fs, proc, ownerRecord);

  let ownedIno: number | undefined;
  let ownedMtime: number | undefined;
  let ownedBirthtime: number | undefined;
  let stolen = false;

  const readStat = (): OauthRefreshLockStat | undefined => {
    try {
      return fs.stat(lockPath);
    } catch {
      return undefined;
    }
  };

  // Remember the directory we created. A later `mkdir` is a different inode, and
  // touching or removing that one would steal someone else's refresh.
  const remember = (info: OauthRefreshLockStat | undefined): void => {
    if (!info?.isDirectory) {
      stolen = true;
      return;
    }
    ownedIno = info.ino;
    ownedMtime = info.mtimeMs;
    ownedBirthtime = info.birthtimeMs;
  };

  remember(readStat());
  if (ownerRecord && !stolen && ownedBirthtime !== undefined && ownedBirthtime > 0) {
    writeOwner(lockPath, ownedBirthtime, fs, proc);
  }

  const stillOwned = (): boolean => {
    if (stolen) return false;
    const info = readStat();
    if (!info?.isDirectory) {
      stolen = true;
      return false;
    }
    // Inode reuse after a stale reclaim can hand back the same number. The mtime
    // is what shows the directory is not the one this holder last touched.
    if (ownedIno !== undefined && info.ino !== ownedIno) {
      stolen = true;
      return false;
    }
    if (ownedMtime !== undefined && info.mtimeMs !== ownedMtime) {
      stolen = true;
      return false;
    }
    return true;
  };

  const touch = (): void => {
    if (!stillOwned()) return;
    try {
      fs.utimes(lockPath);
    } catch {
      stolen = true;
      return;
    }
    const after = readStat();
    if (!after?.isDirectory || (ownedIno !== undefined && after.ino !== ownedIno)) {
      stolen = true;
      return;
    }
    ownedMtime = after.mtimeMs;
  };

  touch();

  const timer = setInterval(() => {
    touch();
    if (stolen) clearInterval(timer);
  }, updateMs);
  timer.unref();

  let released = false;
  return {
    lockPath,
    compromised() {
      return !stillOwned();
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      // A stolen directory and a replacement owner file both stay put.
      if (!stillOwned()) return;
      if (ownerRecord && ownedBirthtime !== undefined && ownedBirthtime > 0) {
        unlinkMatchingOwner(lockPath, { pid: proc.pid, lockBirthtimeMs: ownedBirthtime }, fs);
      }
      if (!stillOwned()) return;
      try {
        fs.rmdir(lockPath);
      } catch {
        // rmdir failed. Age is not used to remove whatever directory is left.
      }
    },
  };
}

function claim(
  lockPath: string,
  fs: OauthRefreshLockFs,
  proc: OauthLockProcess,
  ownerRecord: boolean,
): void {
  if (tryMkdir(lockPath, fs)) return;

  // Missing means it vanished between the collision and the stat. One more try.
  // A non-directory is left alone. A directory is removed only by dead-holder
  // takeover, and only when the owner record still matches at the rmdir.
  // A bare directory lock never takes that path.
  let info: OauthRefreshLockStat | undefined;
  try {
    info = fs.stat(lockPath);
  } catch {
    throw held();
  }
  if (info === undefined && tryMkdir(lockPath, fs)) return;
  if (!info?.isDirectory) throw held();
  if (ownerRecord && takeOverDeadHolder(lockPath, info.mtimeMs, fs, proc)) return;
  throw held();
}

/** True when this call created the directory. */
function tryMkdir(lockPath: string, fs: OauthRefreshLockFs): boolean {
  try {
    fs.mkdir(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

function held(): LockError {
  return new LockError("Claude OAuth refresh lock is already held.");
}

/**
 * Claude writes the owner only when `birthtimeMs > 0`. A failure here does not
 * drop the directory lock: the refresh can still finish, and a missing record
 * only means a later process will not treat this holder as dead.
 */
function writeOwner(
  lockPath: string,
  birthtimeMs: number,
  fs: OauthRefreshLockFs,
  proc: OauthLockProcess,
): void {
  if (!fs.writeFile) return;
  let pidDomain: string;
  let pidSpace: string;
  let procStart: string | undefined;
  try {
    pidDomain = proc.pidDomain();
    pidSpace = proc.pidSpace();
    procStart = proc.procStart();
  } catch {
    return;
  }
  if (typeof pidDomain !== "string" || pidDomain.length > PID_DOMAIN_MAX) return;
  if (typeof pidSpace !== "string" || pidSpace.length > PID_SPACE_MAX) return;
  const start = usableProcStart(procStart);
  const record: Record<string, unknown> = { pid: proc.pid };
  if (start !== undefined) record.procStart = start;
  record.pidDomain = pidDomain;
  record.pidSpace = pidSpace;
  record.lockBirthtimeMs = birthtimeMs;
  try {
    fs.writeFile(ownerPath(lockPath), JSON.stringify(record));
  } catch {
    // The directory lock is already held. Takeover is the only thing that needs the file.
  }
}

/** Unlink the owner only when pid and birthtime still match. Release and takeover must not throw. */
function unlinkMatchingOwner(
  lockPath: string,
  expected: { pid: number; lockBirthtimeMs: number },
  fs: OauthRefreshLockFs,
): void {
  try {
    const current = readOwner(lockPath, fs);
    if (!current) return;
    if (current.pid !== expected.pid || current.lockBirthtimeMs !== expected.lockBirthtimeMs) return;
    fs.unlink?.(ownerPath(lockPath));
  } catch {
    // The next writer replaces this file. Release and takeover both continue.
  }
}

/**
 * Remove a dead holder's directory and create ours. Returns true only when this
 * call now owns the new directory. Any doubt leaves the existing directory in place.
 */
function takeOverDeadHolder(
  lockPath: string,
  watchedMtime: number,
  fs: OauthRefreshLockFs,
  proc: OauthLockProcess,
): boolean {
  const record = prepareTakeover(lockPath, watchedMtime, fs, proc);
  if (!record) {
    try {
      if (fs.stat(lockPath) === undefined) return tryMkdir(lockPath, fs);
    } catch {
      return false;
    }
    return false;
  }
  try {
    if (!sameLock(fs.stat(lockPath), watchedMtime, record.lockBirthtimeMs)) return false;
    fs.rmdir(lockPath);
  } catch {
    return false;
  }
  unlinkMatchingOwner(lockPath, record, fs);
  return tryMkdir(lockPath, fs);
}

function prepareTakeover(
  lockPath: string,
  watchedMtime: number,
  fs: OauthRefreshLockFs,
  proc: OauthLockProcess,
): OwnerRecord | undefined {
  try {
    return vettedDeadOwner(lockPath, watchedMtime, fs, proc);
  } catch {
    return undefined;
  }
}

function vettedDeadOwner(
  lockPath: string,
  watchedMtime: number,
  fs: OauthRefreshLockFs,
  proc: OauthLockProcess,
): OwnerRecord | undefined {
  const record = readOwner(lockPath, fs);
  if (!record) return undefined;
  if (!sameLock(fs.stat(lockPath), watchedMtime, record.lockBirthtimeMs)) return undefined;
  if (record.pidDomain !== proc.pidDomain() || record.pidSpace !== proc.pidSpace()) return undefined;
  if (proc.pidViewTrusted() !== true) return undefined;
  if (!holderIsGone(proc, record)) return undefined;
  if (!legacyLockAllowsTakeover(lockPath, watchedMtime, record, fs)) return undefined;
  if (!sameLock(fs.stat(lockPath), watchedMtime, record.lockBirthtimeMs)) return undefined;
  return record;
}

function holderIsGone(proc: OauthLockProcess, record: OwnerRecord): boolean {
  try {
    return proc.holderGone({ pid: record.pid, procStart: record.procStart }) === true;
  } catch {
    return false;
  }
}

/**
 * Claude's legacy lock is `realpath(configDir) + ".lock"`, a sibling of the
 * config directory. We never acquire it. When it exists, its birthtime has to
 * match `legacyLockBirthtimeMs` or the main lock is left alone. A match is
 * removed before the main directory, and the main directory is rechecked after.
 */
function legacyLockAllowsTakeover(
  lockPath: string,
  watchedMtime: number,
  record: OwnerRecord,
  fs: OauthRefreshLockFs,
): boolean {
  const legacyPath = legacyLockPath(lockPath, fs);
  if (legacyPath === undefined) return false;
  const legacy = fs.stat(legacyPath);
  if (legacy === undefined) return true;
  if (!legacy.isDirectory || legacy.birthtimeMs !== record.legacyLockBirthtimeMs) return false;
  fs.rmdir(legacyPath);
  return sameLock(fs.stat(lockPath), watchedMtime, record.lockBirthtimeMs);
}

function legacyLockPath(lockPath: string, fs: OauthRefreshLockFs): string | undefined {
  if (!fs.realpath) return undefined;
  const parent = fs.realpath(dirname(lockPath));
  if (parent === undefined) return undefined;
  return `${parent}.lock`;
}

function sameLock(
  info: OauthRefreshLockStat | undefined,
  watchedMtime: number,
  birthtimeMs: number,
): boolean {
  return info?.isDirectory === true
    && info.mtimeMs === watchedMtime
    && info.birthtimeMs === birthtimeMs;
}

function readOwner(lockPath: string, fs: OauthRefreshLockFs): OwnerRecord | undefined {
  if (!fs.readFile) return undefined;
  const text = fs.readFile(ownerPath(lockPath));
  if (text === undefined) return undefined;
  return parseOwner(text);
}

function ownerPath(lockPath: string): string {
  return `${lockPath}.owner`;
}

function parseOwner(text: string): OwnerRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isProcessId(value.pid)) return undefined;
  const pidDomain = boundedString(value.pidDomain, PID_DOMAIN_MAX);
  const pidSpace = boundedString(value.pidSpace, PID_SPACE_MAX);
  const lockBirthtimeMs = positiveNumber(value.lockBirthtimeMs);
  if (pidDomain === undefined || pidSpace === undefined || lockBirthtimeMs === undefined) return undefined;
  const record: OwnerRecord = { pid: value.pid, pidDomain, pidSpace, lockBirthtimeMs };
  if ("procStart" in value && value.procStart !== undefined) {
    const procStart = boundedString(value.procStart, PROC_START_MAX);
    if (procStart === undefined || procStart.length === 0) return undefined;
    record.procStart = procStart;
  }
  if ("legacyLockBirthtimeMs" in value && value.legacyLockBirthtimeMs !== undefined) {
    const legacy = positiveNumber(value.legacyLockBirthtimeMs);
    if (legacy === undefined) return undefined;
    record.legacyLockBirthtimeMs = legacy;
  }
  return record;
}

function usableProcStart(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > PROC_START_MAX) return undefined;
  return value;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  return value;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return undefined;
  return number;
}

function isProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 1 && value <= PID_MAX;
}

/** Field `index` from `/proc/<pid>/stat`, counted after the `comm` field. */
export function procStatField(text: string, index: number): string | undefined {
  const mark = text.lastIndexOf(")");
  if (mark < 0 || index < 0) return undefined;
  const value = text.slice(mark + 2).split(" ")[index];
  if (value === undefined || value === "") return undefined;
  return value;
}

export interface OauthHolderProbe {
  signal(pid: number): "present" | "esrch" | "other";
  /** Process state character, such as `R` or `Z`. Undefined when unreadable. */
  state(pid: number): string | undefined;
  /** `starttime` from `/proc/<pid>/stat`. Undefined when unreadable. */
  startTime(pid: number): string | undefined;
}

/**
 * Claude's proven-gone check: `ESRCH`, state `Z` or `X`, or a recorded
 * starttime that is readable now and different. Unreadable starttime is not death.
 */
export function oauthHolderIsGone(
  holder: { pid: number; procStart?: string },
  probe: OauthHolderProbe,
): boolean {
  if (!isProcessId(holder.pid)) return false;
  if (probe.signal(holder.pid) === "esrch") return true;
  const state = probe.state(holder.pid);
  if (state === "Z" || state === "X") return true;
  if (holder.procStart === undefined) return false;
  const current = probe.startTime(holder.pid);
  if (current === undefined || current.length > PROC_START_MAX) return false;
  return current !== holder.procStart;
}

export function oauthPidDomain(parts: {
  platform: NodeJS.Platform;
  hostname: string;
  machineId?: string;
  pidNamespace?: string;
}): string {
  if (parts.platform === "win32") return `linux:${parts.hostname.toLowerCase()}`;
  if (parts.platform !== "linux") return "linux";
  return `linux:${parts.machineId ?? ""}:${parts.pidNamespace ?? ""}`;
}

export function oauthPidSpace(parts: {
  platform: NodeJS.Platform;
  hostname: string;
  pidNamespace?: string;
}): string {
  if (parts.platform !== "linux") return parts.hostname;
  const ns = parts.pidNamespace ?? "";
  return `${parts.hostname}${ns === "" ? "" : `#${ns}`}`;
}

/** On Linux, `/proc/self` must be this pid and `/proc` must list at least 16 pids. */
export function oauthPidViewIsTrusted(view: {
  platform: NodeJS.Platform;
  pid: number;
  readSelf: () => string;
  listProc: () => string[];
}): boolean {
  if (view.platform !== "linux") return true;
  try {
    if (view.readSelf() !== String(view.pid)) return false;
    let numeric = 0;
    for (const name of view.listProc()) {
      if (!/^[0-9]+$/.test(name)) continue;
      numeric += 1;
      if (numeric >= TRUSTED_PID_COUNT) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function nodeLockProcess(): OauthLockProcess {
  return {
    pid: process.pid,
    procStart() {
      return usableProcStart(readProcField(process.pid, PROC_START_INDEX));
    },
    pidDomain() {
      return oauthPidDomain({
        platform: process.platform,
        hostname: hostname(),
        machineId: readMachineId(),
        pidNamespace: readPidNamespace(),
      });
    },
    pidSpace() {
      return oauthPidSpace({
        platform: process.platform,
        hostname: hostname(),
        pidNamespace: readPidNamespace(),
      });
    },
    pidViewTrusted() {
      return oauthPidViewIsTrusted({
        platform: process.platform,
        pid: process.pid,
        readSelf: () => readlinkSync("/proc/self"),
        listProc: () => readdirSync("/proc"),
      });
    },
    holderGone(holder) {
      return oauthHolderIsGone(holder, {
        signal: signalProbe,
        state: (pid) => readProcField(pid, PROC_STATE_INDEX),
        startTime: (pid) => readProcField(pid, PROC_START_INDEX),
      });
    },
  };
}

function readProcField(pid: number, index: number): string | undefined {
  try {
    return procStatField(readFileSync(`/proc/${pid}/stat`, "utf8"), index);
  } catch {
    return undefined;
  }
}

function readMachineId(): string {
  try {
    return readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    return "";
  }
}

function readPidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

/** Signal 0 checks existence. It must not be any other signal. */
function signalProbe(pid: number): "present" | "esrch" | "other" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "esrch" : "other";
  }
}

function nodeLockFs(): OauthRefreshLockFs {
  return {
    mkdir(path) {
      mkdirSync(path);
    },
    rmdir(path) {
      // `rmdir` removes an empty directory. `rm` without `recursive` does not,
      // and a recursive delete could remove something that is not our lock.
      rmdirSync(path);
    },
    stat(path) {
      return ifExists(() => {
        const stat = statSync(path);
        return {
          mtimeMs: stat.mtimeMs,
          isDirectory: stat.isDirectory(),
          ino: stat.ino,
          birthtimeMs: stat.birthtimeMs,
        };
      });
    },
    utimes(path) {
      const touched = new Date();
      utimesSync(path, touched, touched);
    },
    readFile(path) {
      return ifExists(() => readFileSync(path, "utf8"));
    },
    writeFile(path, data) {
      writeFileAtomic(path, data);
    },
    unlink(path) {
      unlinkSync(path);
    },
    realpath(path) {
      return ifExists(() => realpathSync(path));
    },
  };
}

/** ENOENT is absence. Any other error is rethrown, so a permission failure cannot look like a missing lock. */
function ifExists<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

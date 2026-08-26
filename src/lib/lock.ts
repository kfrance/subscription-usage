import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const FLOCK_COMMAND = "/usr/bin/flock";
const LOCK_CONTENTION_EXIT_CODE = 75;
const LOCK_COMMAND_TIMEOUT_MS = 1000;

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockHandle {
  lockPath: string;
  release(): void;
}

/**
 * Acquire the same persistent advisory flock used by Grok for auth.json.lock.
 * The helper child locks an inherited descriptor; Linux associates flock locks
 * with the shared open-file description, so the lock remains held by this
 * process until release closes the original descriptor.
 */
export function acquireFileLock(lockPath: string, label = "Lock"): LockHandle {
  mkdirSync(dirname(lockPath), { recursive: true });
  const fileDescriptor = openSync(lockPath, "a+", 0o600);

  const result = spawnSync(
    FLOCK_COMMAND,
    [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      String(LOCK_CONTENTION_EXIT_CODE),
      "3",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", fileDescriptor],
      encoding: "utf8",
      timeout: LOCK_COMMAND_TIMEOUT_MS,
    },
  );

  if (result.status !== 0 || result.error) {
    closeSync(fileDescriptor);
    if (result.status === LOCK_CONTENTION_EXIT_CODE) {
      throw new LockError(`${label} is already held.`);
    }
    throw result.error ?? new Error(`${label} command failed: ${result.stderr.trim() || result.status}`);
  }

  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      released = true;
      closeSync(fileDescriptor);
    },
  };
}

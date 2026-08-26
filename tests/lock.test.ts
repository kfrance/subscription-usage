import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLock, LockError, type LockHandle } from "../src/lib/lock.js";

/**
 * These exercise the real `flock(2)`, not a fake, because the defect this
 * primitive replaced was entirely about disagreeing with the kernel. The
 * previous implementation wrote a PID into the lock file and compared PIDs,
 * which meant it acquired a lock the kernel already considered held, and
 * refused one the kernel considered free.
 */

let dir: string;
const held: LockHandle[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-lock-"));
});

afterEach(() => {
  while (held.length) held.pop()?.release();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

function take(path: string, label = "Test lock"): LockHandle {
  const handle = acquireFileLock(path, label);
  held.push(handle);
  return handle;
}

/** Hold a real flock from a separate process until the test ends. */
async function holdExternally(path: string): Promise<void> {
  const child = spawn("/usr/bin/flock", ["--exclusive", path, "-c", "echo ready; sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("flock helper exited early")));
  });
}

describe("acquireFileLock", () => {
  it("acquires a lock nobody holds", () => {
    const path = join(dir, "a.lock");
    expect(take(path).lockPath).toBe(path);
  });

  it("creates the parent directory when it does not exist", () => {
    const path = join(dir, "nested", "deeper", "b.lock");
    take(path);
    expect(existsSync(path)).toBe(true);
  });

  it("creates the lock file owner-only", () => {
    const path = join(dir, "c.lock");
    take(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a lock this process already holds", () => {
    const path = join(dir, "d.lock");
    take(path);
    expect(() => acquireFileLock(path, "Second")).toThrow(LockError);
  });

  it("releases so the lock can be taken again", () => {
    const path = join(dir, "e.lock");
    acquireFileLock(path, "First").release();
    expect(() => take(path)).not.toThrow();
  });

  it("ignores a repeated release", () => {
    const handle = acquireFileLock(join(dir, "f.lock"), "Once");
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  it("refuses a lock another process holds, even with a stale pid in the file", async () => {
    // The regression: the old implementation read this pid, found it dead, and
    // reclaimed a lock the kernel still considered held by the live helper.
    const path = join(dir, "g.lock");
    await holdExternally(path);
    writeFileSync(path, "999999\n", "utf8");
    expect(() => acquireFileLock(path, "Contended")).toThrow(LockError);
  });

  it("acquires a leftover lock file that nobody holds", () => {
    // The other half of the regression: an empty file left behind by a crashed
    // process made the old implementation refuse forever, so the service it
    // guarded never refreshed again until someone deleted the file by hand.
    const path = join(dir, "h.lock");
    closeSync(openSync(path, "w"));
    expect(statSync(path).size).toBe(0);
    expect(() => take(path)).not.toThrow();
  });
});

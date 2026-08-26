import { chmodSync, closeSync, constants, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Owner read/write only, the default for the credential and cache files here. */
const DEFAULT_FILE_MODE = 0o600;

/**
 * Write a file so a concurrent reader never observes a partial one: write the
 * content to a temporary file, then `rename` it over the target, which is atomic
 * within a filesystem. The temporary file is a sibling of the target so the
 * rename cannot cross a filesystem boundary, and its name carries the pid and a
 * UUID so two processes writing the same target cannot collide — matching
 * `replaceFileNoFollow` in `automation/refactor/src/safe-files.ts`. It is opened
 * `O_EXCL` and then explicitly `chmod`ed so a permissive umask cannot loosen the
 * mode of a file that may hold credentials or usage figures.
 */
export function writeFileAtomic(path: string, data: string, mode: number = DEFAULT_FILE_MODE): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fileDescriptor = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      writeFileSync(fileDescriptor, data, "utf8");
    } finally {
      closeSync(fileDescriptor);
    }
    // Enforce the mode explicitly so umask cannot loosen it.
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

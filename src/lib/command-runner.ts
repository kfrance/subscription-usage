import { spawnSync } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args?: string[], options?: CommandOptions): CommandResult;
}

export class ShellCommandRunner implements CommandRunner {
  run(command: string, args: string[] = [], options: CommandOptions = {}): CommandResult {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: options.timeoutMs,
    });

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  }
}

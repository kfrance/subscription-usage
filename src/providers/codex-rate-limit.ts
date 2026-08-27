import { spawn } from "node:child_process";
import { isRecord } from "../lib/values.js";
import { percentInRange } from "../types.js";

/**
 * How this probe identifies itself to the Codex app server.
 *
 * Names the package rather than either consumer: both applications share this
 * code now, and the previous value announced one of them to the other's server.
 */
const CLIENT_NAME = "subscription-usage";
const CLIENT_TITLE = "Subscription usage";

export interface CodexRateLimitWindowSnapshot {
  label: "5h" | "weekly";
  usedPercent: number;
  /** Reset time in epoch SECONDS, verbatim from codex (not ms). */
  resetsAt: number;
}

/** Normalized codex rate-limit reading from `account/rateLimits/read`. */
export interface CodexRateLimitSnapshot {
  windows: CodexRateLimitWindowSnapshot[];
  planType: string;
}

export interface CodexRateLimitResult {
  snapshot: CodexRateLimitSnapshot | null;
  unavailableReason?: string;
}

export interface CodexRateLimitOptions {
  codexCommand: string;
  args?: string[];
  timeoutMs?: number;
  handshakeDelayMs?: number;
}

export async function getCodexRateLimits(
  options: CodexRateLimitOptions,
): Promise<CodexRateLimitResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const args = options.args ?? ["app-server"];

  return new Promise((resolve) => {
    const child = spawn(options.codexCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let requestedRateLimits = false;

    const timeout = setTimeout(() => {
      finish({ snapshot: null, unavailableReason: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const snapshot = parseRateLimitSnapshot(stdout);
      if (snapshot) {
        finish({ snapshot });
        return;
      }
      if (hasResponseId(stdout, 2)) {
        finish({
          snapshot: null,
          unavailableReason: "codex app-server returned an unsupported rate-limit response",
        });
        return;
      }
      if (!requestedRateLimits && hasResponseId(stdout, 1)) {
        requestRateLimits();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ snapshot: null, unavailableReason: error.message });
    });
    child.stdin.on("error", () => {
      // Some test doubles and failed app-server launches close stdin before
      // the JSON-RPC requests are written. The stdout/stderr/exit paths still
      // determine the result.
    });
    child.on("close", (code) => {
      if (!settled) {
        const snapshot = parseRateLimitSnapshot(stdout);
        if (snapshot) {
          finish({ snapshot });
          return;
        }
        finish({
          snapshot: null,
          unavailableReason: `codex app-server exited ${code ?? "unknown"}: ${firstLine(stderr || stdout) ?? "no output"}`,
        });
      }
    });

    writeMessage(buildCodexInitializeRequest());
    const rateLimitRequestTimer = setTimeout(requestRateLimits, options.handshakeDelayMs ?? 500);

    function requestRateLimits(): void {
      if (requestedRateLimits) {
        return;
      }
      requestedRateLimits = true;
      if (rateLimitRequestTimer) {
        clearTimeout(rateLimitRequestTimer);
      }
      writeMessage({ jsonrpc: "2.0", method: "initialized" });
      writeMessage({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" });
    }

    function writeMessage(message: Record<string, unknown>): void {
      if (settled || child.stdin.destroyed || child.stdin.writableEnded) {
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // Failed process starts and closed stdin are reported through the
        // normal timeout/exit/error paths.
      }
    }

    function finish(result: CodexRateLimitResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (rateLimitRequestTimer) {
        clearTimeout(rateLimitRequestTimer);
      }
      child.kill("SIGTERM");
      resolve(result);
    }
  });
}

export function buildCodexInitializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: CLIENT_NAME,
        title: CLIENT_TITLE,
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    },
  };
}

export function parseRateLimitSnapshot(stdout: string): CodexRateLimitSnapshot | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || parsed.id !== 2 || !isRecord(parsed.result)) {
      continue;
    }

    const rateLimitsByLimitId = parsed.result.rateLimitsByLimitId;
    const rateLimits =
      isRecord(rateLimitsByLimitId) && isRecord(rateLimitsByLimitId.codex)
        ? rateLimitsByLimitId.codex
        : parsed.result.rateLimits;
    if (!isRecord(rateLimits)) {
      continue;
    }

    const planType = typeof rateLimits.planType === "string" ? rateLimits.planType : parsed.result.planType;
    const legacyPair =
      isRecord(rateLimits.primary) &&
      isRecord(rateLimits.secondary) &&
      rateLimits.primary.windowDurationMins === undefined &&
      rateLimits.secondary.windowDurationMins === undefined;
    const primary = parseRateLimitWindow(rateLimits.primary, legacyPair ? "5h" : undefined);
    const secondary = parseRateLimitWindow(rateLimits.secondary, legacyPair ? "weekly" : undefined);
    if ((rateLimits.primary != null && !primary) || (rateLimits.secondary != null && !secondary)) {
      continue;
    }
    const windows = [primary, secondary].filter(
      (window): window is CodexRateLimitWindowSnapshot => window !== undefined,
    );

    if (windows.length === 0) {
      continue;
    }

    // The plan tier is optional metadata; the windows are the reading. Requiring
    // a tier discarded an otherwise valid response and made the service look
    // unavailable, and every consumer already renders an empty tier as unknown.
    return {
      windows,
      planType: typeof planType === "string" ? planType : "",
    };
  }

  return undefined;
}

function parseRateLimitWindow(
  value: unknown,
  legacyLabel: CodexRateLimitWindowSnapshot["label"] | undefined,
): CodexRateLimitWindowSnapshot | undefined {
  if (!isRecord(value) || !isPercent(value.usedPercent) || !isPositiveInteger(value.resetsAt)) {
    return undefined;
  }

  const duration = value.windowDurationMins;
  const label =
    duration === 5 * 60
      ? "5h"
      : duration === 7 * 24 * 60
        ? "weekly"
        : duration === undefined
          ? legacyLabel
          : undefined;
  if (!label) {
    return undefined;
  }

  return { label, usedPercent: value.usedPercent, resetsAt: value.resetsAt };
}

function hasResponseId(stdout: string, id: number): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (isRecord(parsed) && parsed.id === id && ("result" in parsed || "error" in parsed)) {
      return true;
    }
  }

  return false;
}

function firstLine(value: string): string | undefined {
  return value.split("\n").find((line) => line.trim())?.trim();
}

/**
 * The shared 0-100 bound, narrowed to whole numbers.
 *
 * Codex reports integer percentages, and the parser uses that to reject a
 * drifted payload — so this is a deliberate narrowing of the shared guard rather
 * than a second copy of the range, which is why it defers to `percentInRange`
 * for the bound itself.
 */
function isPercent(value: unknown): value is number {
  return percentInRange(value) !== undefined && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

import {
  getCodexRateLimits,
  type CodexRateLimitOptions,
  type CodexRateLimitResult,
} from "./codex-rate-limit.js";
import { unavailableSnapshot, type UsageProvider, type UsageSnapshot } from "../types.js";

export interface CodexUsageProviderOptions {
  codexCommand: string;
  /** Injectable for tests; defaults to the real `codex app-server` client. */
  getRateLimits?: (options: CodexRateLimitOptions) => Promise<CodexRateLimitResult>;
}

/**
 * Wraps the raw codex rate-limit client (`account/rateLimits/read`) as a
 * normalized usage provider. Codex now labels windows by duration and may
 * return only a weekly window; legacy two-window payloads are still normalized
 * by the raw reader. Reset times are epoch SECONDS, so they are scaled to the
 * epoch-MS contract `UsageWindow.resetsAt` requires.
 */
/** Epoch seconds → epoch ms for the `UsageWindow.resetsAt` contract. */
const SECONDS_TO_MS = 1000;
export class CodexUsageProvider implements UsageProvider {
  readonly service = "codex" as const;

  constructor(private readonly options: CodexUsageProviderOptions) {}

  async getUsage(): Promise<UsageSnapshot> {
    const fetchRateLimits = this.options.getRateLimits ?? getCodexRateLimits;
    const { snapshot, unavailableReason } = await fetchRateLimits({
      codexCommand: this.options.codexCommand,
    });
    if (!snapshot) {
      return unavailableSnapshot("codex", unavailableReason ?? "codex usage unavailable");
    }
    return {
      service: "codex",
      planType: snapshot.planType,
      windows: snapshot.windows.map((window) => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt * SECONDS_TO_MS,
      })),
    };
  }
}

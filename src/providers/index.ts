import { unavailableSnapshot, type UsageProvider, type UsageSnapshot } from "../types.js";
import { describeError } from "../lib/values.js";

/**
 * Read every provider, letting none of them abort the batch.
 *
 * Providers here answer with a snapshot rather than throwing, and this is the
 * belt that makes that true for callers even if one ever does. It lives beside
 * the providers because it enforces their contract: both consumers had written
 * the same function, so a provider that started throwing something new would
 * have been handled in one application and not the other.
 */
export async function fetchSnapshots(providers: UsageProvider[]): Promise<UsageSnapshot[]> {
  return Promise.all(
    providers.map(async (provider) => {
      try {
        return await provider.getUsage();
      } catch (error) {
        return unavailableSnapshot(provider.service, describeError(error));
      }
    }),
  );
}

/**
 * One provider per vendor. Each reads that vendor's own on-disk credentials,
 * calls its usage endpoint, and returns a normalized `UsageSnapshot`.
 *
 * There is no `buildProviders` factory here on purpose. Consumers disagree about
 * which services to construct and which environment variables name the CLI
 * binaries, so each one assembles its own list from these classes.
 */
export { ClaudeUsageProvider, type ClaudeUsageProviderOptions } from "./claude-provider.js";
export { CodexUsageProvider, type CodexUsageProviderOptions } from "./codex-provider.js";
export { CursorUsageProvider, normalizeCursorUsage, type CursorUsageProviderOptions } from "./cursor-provider.js";
export { GrokUsageProvider, type GrokUsageProviderOptions } from "./grok-provider.js";

/**
 * Codex's rate-limit probe. Exported beside the providers because the
 * test-effectiveness loop reads these windows directly to size a batch, rather
 * than through a `UsageSnapshot`.
 */
export {
  buildCodexInitializeRequest,
  getCodexRateLimits,
  parseRateLimitSnapshot,
  type CodexRateLimitOptions,
  type CodexRateLimitResult,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindowSnapshot,
} from "./codex-rate-limit.js";

/**
 * A shared, on-disk cache for usage readings.
 *
 * The store owns the file format, the per-service lock, the rate-limit backoff,
 * and atomic writes. It owns no policy: how old a reading may be, and whether a
 * stale one beats none, is decided by the `Freshness` function each caller
 * supplies.
 */
export {
  CachingUsageProvider,
  defaultCacheDir,
  invalidateCachedReading,
  maxAgeFreshness,
  type CachingUsageProviderOptions,
  type Freshness,
  type FreshnessDecision,
  type InvalidateOptions,
} from "./store.js";

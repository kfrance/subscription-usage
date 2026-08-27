/**
 * Shared usage-provider interface consumed by both the meta loop and
 * `test-effectiveness`. Each provider returns a normalized snapshot of one
 * service's rate-limit windows so the budget core can reason about them
 * uniformly — as `(usedPercent, resetsAt)` pairs — regardless of whether the
 * underlying window is rolling (codex/claude) or a fixed billing cycle (grok's
 * weekly credit window).
 */

export type UsageService = "codex" | "claude" | "grok" | "cursor";

export interface UsageWindow {
  /** e.g. "5h", "weekly", "weekly-opus", "weekly-sonnet". */
  label: string;
  /** 0–100, total utilization (user + automation, unattributed). */
  usedPercent: number;
  /** Absolute epoch ms — exact date AND time the window resets. */
  resetsAt: number;
  /** Absolute epoch ms when a fixed provider window began, when reported. */
  startsAt?: number;
  /** Provider-reported models that consume this pool, when available. */
  models?: string[];
}

/**
 * Why a retrieval failed, when the reason is one a caller acts on. Only a rate
 * limit is: the caching layer arms a backoff for it. Every other failure is fully
 * described by `unavailableReason` and leaves this undefined, so there is no
 * catch-all value to keep in sync across the providers.
 */
export type UsageUnavailableKind = "rate-limited";

export interface UsageSnapshot {
  service: UsageService;
  /** Provider-reported plan/tier identifier; "" when unavailable. */
  planType: string;
  windows: UsageWindow[];
  /** Present when retrieval failed; treated as a known state, never thrown. */
  unavailableReason?: string;
  /** Set only when the failure is one a caller acts on; see `UsageUnavailableKind`. */
  unavailableKind?: UsageUnavailableKind;
  /**
   * Epoch ms the reading was actually taken. Absent means "taken just now" — an
   * uncached provider returns live data, so only a caching layer sets this, and
   * only it can serve a reading older than the moment it was asked for.
   */
  capturedAt?: number;
  /**
   * Epoch ms before which the provider should not be asked again, set when a
   * service reports a rate limit. Advisory: the caching layer persists it.
   */
  retryAfter?: number;
  /**
   * Why the live refresh failed, on a reading served from cache in its place.
   * Present only when the caller opted into stale readings, and the figures are
   * real but not current — display them as such rather than as fresh.
   */
  refreshError?: string;
}

export interface UsageProvider {
  readonly service: UsageService;
  getUsage(): Promise<UsageSnapshot>;
}

/**
 * A percentage in the 0–100 range `UsageWindow.usedPercent` is declared to hold,
 * or undefined when the vendor sent something else — a missing scalar, a string,
 * or a value outside the range. It lives here rather than beside the generic
 * guards because the range is this file's contract, and a guard kept apart from
 * the declaration it enforces is how a fourth spelling of it appears.
 */
export function percentInRange(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

/**
 * Classify an HTTP status. `429` is the transient rate limit the cache backs off
 * from; every other status simply makes the service unavailable for this read.
 */
export function httpFailureKind(status: number): UsageUnavailableKind | undefined {
  return status === 429 ? "rate-limited" : undefined;
}

/** Build the normalized "unavailable" snapshot every provider returns on failure. */
export function unavailableSnapshot(
  service: UsageService,
  reason: string,
  kind?: UsageUnavailableKind,
  retryAfter?: number,
): UsageSnapshot {
  return {
    service,
    planType: "",
    windows: [],
    unavailableReason: reason,
    ...(kind === undefined ? {} : { unavailableKind: kind }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

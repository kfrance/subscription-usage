/**
 * Value guards the providers, the cache, and the inventory reader all need.
 *
 * Every one of these was written separately in each vendor's file before the two
 * repositories were merged, so the package inherited five copies of `isRecord`
 * and four of the error renderer — one of them under a different name, which is
 * how you end up auditing error text and missing a call site. They are internal:
 * `src/lib/index.ts` does not re-export them, so the package's public surface is
 * unchanged.
 */

/** A JSON object, excluding arrays and null, which `typeof` alone admits. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an unknown thrown value as a message safe to interpolate. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A percentage in the 0–100 range `UsageWindow.usedPercent` is documented to
 * hold, or undefined when the vendor sent something else. Vendors do send
 * something else: a missing scalar, a string, or a value outside the range all
 * have to degrade rather than propagate.
 */
export function percentInRange(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

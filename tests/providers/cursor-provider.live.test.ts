import { describe, expect, it } from "vitest";
import { CursorUsageProvider } from "../../src/providers/cursor-provider.js";

/**
 * Reads the real Cursor account, so it is excluded from the default run and
 * belongs to whoever is checking that the vendor's shape has not changed.
 *
 * It is worth keeping despite that cost: Cursor exposes usage only through the
 * dashboard RPC, with no headless command and no published contract, so a silent
 * change to that payload is exactly the failure the unit tests cannot see.
 */
describe("CursorUsageProvider live", () => {
  it("reads the authenticated Cursor billing cycle without spending model quota", async () => {
    const snapshot = await new CursorUsageProvider().getUsage();

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.planType).toMatch(/Ultra/iu);
    const monthly = snapshot.windows.find((window) => window.label === "monthly");
    expect(monthly).toBeDefined();
    expect(monthly?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(monthly?.usedPercent).toBeLessThanOrEqual(100);
    expect(monthly?.startsAt).toBeLessThan(Date.now());
    expect(monthly?.resetsAt).toBeGreaterThan(Date.now());
    expect(snapshot.windows.find((window) => window.label === "monthly-cursor-models")?.usedPercent)
      .toBeGreaterThanOrEqual(0);
    expect(snapshot.windows.find((window) => window.label === "monthly-other-models")?.usedPercent)
      .toBeGreaterThanOrEqual(0);
  });
});

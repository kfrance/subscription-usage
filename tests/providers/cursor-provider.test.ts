import { describe, expect, it } from "vitest";
import { CursorUsageProvider } from "../../src/providers/cursor-provider.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("CursorUsageProvider", () => {
  it("uses dashboard RPCs and normalizes Ultra usage without invoking cursor-agent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new CursorUsageProvider({
      readFile: () => JSON.stringify({ accessToken: "token" }),
      fetchImpl: (async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        return url.endsWith("GetCurrentPeriodUsage")
          ? response({ billingCycleStart: "1787150831000", billingCycleEnd: "1789829231000", planUsage: {
              totalPercentUsed: 1.67, autoPercentUsed: 0.04, apiPercentUsed: 1.19,
            } })
          : response({ planInfo: { planName: "Ultra", billingCycleEnd: "1789829231000" } });
      }) as typeof fetch,
    });
    expect(await provider.getUsage()).toEqual({
      service: "cursor", planType: "Ultra", windows: [
        { label: "monthly", usedPercent: 1.67, resetsAt: 1789829231000, startsAt: 1787150831000 },
        { label: "monthly-cursor-models", usedPercent: 0.04, resetsAt: 1789829231000, startsAt: 1787150831000 },
        { label: "monthly-other-models", usedPercent: 1.19, resetsAt: 1789829231000, startsAt: 1787150831000 },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => (call.init?.headers as Record<string, string>).Authorization === "Bearer token")).toBe(true);
  });

  it("fails closed when auth or responses are unavailable", async () => {
    const missing = new CursorUsageProvider({ readFile: () => "{}" });
    expect((await missing.getUsage()).unavailableReason).toMatch(/no Cursor CLI access token/);
    const failed = new CursorUsageProvider({
      readFile: () => JSON.stringify({ accessToken: "token" }),
      fetchImpl: (async () => response({}, 401)) as typeof fetch,
    });
    expect((await failed.getUsage()).unavailableReason).toMatch(/returned 401/);
  });
});

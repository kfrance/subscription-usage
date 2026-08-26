import { describe, expect, it } from "vitest";
import { CodexUsageProvider } from "../../src/providers/codex-provider.js";
import { parseRateLimitSnapshot } from "../../src/providers/codex-rate-limit.js";

describe("parseRateLimitSnapshot", () => {
  it("extracts the id=2 rateLimits response and preserves epoch-second resets verbatim", () => {
    // resetsAt values are epoch SECONDS, as codex emits them (see live capture).
    const stdout = [
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":12,"resetsAt":1782271009},"secondary":{"usedPercent":31,"resetsAt":1782335927},"planType":"pro"}}}',
    ].join("\n");

    expect(parseRateLimitSnapshot(stdout)).toEqual({
      windows: [
        { label: "5h", usedPercent: 12, resetsAt: 1782271009 },
        { label: "weekly", usedPercent: 31, resetsAt: 1782335927 },
      ],
      planType: "pro",
    });
  });

  it("uses the reported duration when codex returns a single weekly primary window", () => {
    const stdout = JSON.stringify({
      id: 2,
      result: {
        rateLimits: {
          primary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_784_668_005 },
          secondary: null,
          planType: "pro",
        },
      },
    });

    expect(parseRateLimitSnapshot(stdout)).toEqual({
      windows: [{ label: "weekly", usedPercent: 3, resetsAt: 1_784_668_005 }],
      planType: "pro",
    });
  });

  it("rejects a lone window whose nullable duration does not establish its budget label", () => {
    const stdout = JSON.stringify({
      id: 2,
      result: {
        rateLimits: {
          primary: { usedPercent: 3, windowDurationMins: null, resetsAt: 1_784_668_005 },
          secondary: null,
          planType: "pro",
        },
      },
    });

    expect(parseRateLimitSnapshot(stdout)).toBeUndefined();
  });

  it("returns undefined when no valid id=2 response is present", () => {
    expect(parseRateLimitSnapshot('{"jsonrpc":"2.0","id":1,"result":{}}')).toBeUndefined();
    expect(parseRateLimitSnapshot("not json")).toBeUndefined();
  });

  it("rejects out-of-range percentages and non-positive reset times", () => {
    const bad =
      '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":120,"resetsAt":1},"secondary":{"usedPercent":1,"resetsAt":1},"planType":"pro"}}}';
    expect(parseRateLimitSnapshot(bad)).toBeUndefined();
  });
});

describe("CodexUsageProvider", () => {
  it("maps primary→5h and secondary→weekly, scaling epoch-second resets to ms", async () => {
    const provider = new CodexUsageProvider({
      codexCommand: "codex",
      getRateLimits: async () => ({
        snapshot: {
          windows: [
            { label: "5h", usedPercent: 12, resetsAt: 1782271009 },
            { label: "weekly", usedPercent: 31, resetsAt: 1782335927 },
          ],
          planType: "pro",
        },
      }),
    });

    const snapshot = await provider.getUsage();
    expect(snapshot).toEqual({
      service: "codex",
      planType: "pro",
      windows: [
        { label: "5h", usedPercent: 12, resetsAt: 1782271009 * 1000 },
        { label: "weekly", usedPercent: 31, resetsAt: 1782335927 * 1000 },
      ],
    });
  });

  it("normalizes a weekly-only codex snapshot without inventing a 5h window", async () => {
    const provider = new CodexUsageProvider({
      codexCommand: "codex",
      getRateLimits: async () => ({
        snapshot: {
          windows: [{ label: "weekly", usedPercent: 3, resetsAt: 1_784_668_005 }],
          planType: "pro",
        },
      }),
    });

    await expect(provider.getUsage()).resolves.toEqual({
      service: "codex",
      planType: "pro",
      windows: [{ label: "weekly", usedPercent: 3, resetsAt: 1_784_668_005_000 }],
    });
  });

  it("returns an unavailable snapshot when the client cannot read usage", async () => {
    const provider = new CodexUsageProvider({
      codexCommand: "codex",
      getRateLimits: async () => ({ snapshot: null, unavailableReason: "timeout after 5000ms" }),
    });

    const snapshot = await provider.getUsage();
    expect(snapshot).toEqual({
      service: "codex",
      planType: "",
      windows: [],
      unavailableReason: "timeout after 5000ms",
    });
  });

  it("reports a rejected probe as unavailable instead of throwing", async () => {
    // Every provider here answers with a snapshot, never an exception. spawn
    // throws synchronously for an invalid command, so this path is reachable
    // without any injection at all.
    const provider = new CodexUsageProvider({
      codexCommand: "codex",
      getRateLimits: () => Promise.reject(new Error("spawn ENOENT")),
    });

    const snapshot = await provider.getUsage();

    expect(snapshot.unavailableReason).toContain("spawn ENOENT");
    expect(snapshot.windows).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { enabledUsageServices, loadSubscriptionsInventory } from "../src/subscriptions.js";

const manifest = `
schema_version = 1
coordinator_order = ["codex", "cursor"]
[[subscriptions]]
id = "codex"
provider = "openai"
plan = "pro"
enabled = false
automation = true
[[subscriptions]]
id = "cursor"
provider = "cursor"
plan = "ultra"
enabled = true
automation = true
[[subscriptions]]
id = "premium"
provider = "xai"
plan = "premium"
enabled = true
automation = false
[[workers]]
harness = "codex"
model = "gpt"
family = "openai"
subscription = "codex"
usage_service = "codex"
[[workers]]
harness = "cursor"
model = "composer"
family = "cursor"
subscription = "cursor"
usage_service = "cursor"
`;

function load(text: string) {
  return loadSubscriptionsInventory("/subscriptions.toml", { readFile: () => text });
}

describe("enabledUsageServices", () => {
  it("returns only services whose subscription is enabled and grants automation", () => {
    expect([...enabledUsageServices(load(manifest))]).toEqual(["cursor"]);
  });

  it("rejects workers funded by a non-automation subscription", () => {
    const extraWorker =
      `${manifest}\n[[workers]]\nharness="grok"\nmodel="grok"\nfamily="xai"` +
      `\nsubscription="premium"\nusage_service="grok"\n`;
    expect(() => load(extraWorker)).toThrow(/non-automation/);
  });
});

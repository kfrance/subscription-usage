import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { UsageService } from "./types.js";

/** Vendor family a worker's model belongs to. */
export type ModelFamily = "openai" | "anthropic" | "xai" | "cursor";

export const SUBSCRIPTIONS_SCHEMA_VERSION = 1;

const SUPPORTED_HARNESSES = new Set(["codex", "claude", "grok", "cursor"]);
const SUPPORTED_FAMILIES = new Set<ModelFamily>(["openai", "anthropic", "xai", "cursor"]);
const SUPPORTED_USAGE_SERVICES = new Set(["codex", "claude", "grok", "cursor"]);

export interface SubscriptionEntry {
  id: string;
  provider: string;
  plan: string;
  enabled: boolean;
  automation: boolean;
}

/**
 * A trusted worker supplied by an enabled automation subscription.
 *
 * Declared standalone rather than extending a consumer's dispatch type. The meta
 * loop keeps its own `Candidate`, which these fields satisfy structurally, so
 * scheduling concerns stay in the meta loop and never reach this package.
 */
export interface SubscriptionWorker {
  harness: string;
  model: string;
  family?: ModelFamily;
  /** Usage pool that gates this worker; Cursor-hosted vendor models still draw Cursor. */
  usageService?: UsageService;
  subscription: string;
}

export interface SubscriptionsInventory {
  schemaVersion: number;
  coordinatorOrder: string[];
  subscriptions: SubscriptionEntry[];
  /** Workers whose subscription is enabled and grants automation capacity. */
  workers: SubscriptionWorker[];
  /** Complete configured worker list, including workers disabled by subscription state. */
  configuredWorkers: SubscriptionWorker[];
}

/**
 * Load the private, machine-local subscription and worker inventory.
 *
 * The file lists which paid subscriptions exist, which are enabled, which grant
 * automation capacity, and which workers each one supplies. Everything else in
 * this package answers "how much of a subscription is left"; this answers "which
 * subscriptions are there at all".
 */
export function loadSubscriptionsInventory(
  path: string,
  options: { readFile?: (path: string) => string } = {},
): SubscriptionsInventory {
  const readFile = options.readFile ?? ((target: string) => readFileSync(target, "utf8"));
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    throw new Error(`Cannot read subscriptions manifest at ${path}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(`subscriptions manifest at ${path} is not valid TOML: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`subscriptions manifest at ${path} must be a TOML table.`);
  }

  const schemaVersion = parsed.schema_version;
  if (schemaVersion !== SUBSCRIPTIONS_SCHEMA_VERSION) {
    throw new Error(
      `subscriptions manifest at ${path} has unsupported schema_version ${String(schemaVersion)}; ` +
        `expected ${SUBSCRIPTIONS_SCHEMA_VERSION}.`,
    );
  }

  const subscriptions = parseSubscriptions(parsed.subscriptions, path);
  const configuredWorkers = parseWorkers(parsed.workers, path);
  const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));

  for (const worker of configuredWorkers) {
    const subscription = byId.get(worker.subscription);
    if (!subscription) {
      throw new Error(
        `subscriptions manifest at ${path}: worker ${worker.harness}:${worker.model} references unknown ` +
          `subscription "${worker.subscription}".`,
      );
    }
    if (!subscription.automation) {
      throw new Error(
        `subscriptions manifest at ${path}: non-automation subscription "${subscription.id}" cannot fund ` +
          `worker ${worker.harness}:${worker.model}.`,
      );
    }
  }

  const workers = configuredWorkers.filter((worker) => byId.get(worker.subscription)?.enabled);
  for (const subscription of subscriptions) {
    if (subscription.enabled && subscription.automation && !workers.some((worker) => worker.subscription === subscription.id)) {
      throw new Error(
        `subscriptions manifest at ${path}: enabled automation subscription "${subscription.id}" has no worker.`,
      );
    }
  }

  const coordinatorOrder = parseStringArray(parsed.coordinator_order, "coordinator_order", path);
  if (coordinatorOrder.length === 0) {
    throw new Error(`subscriptions manifest at ${path}: coordinator_order must contain at least one harness.`);
  }
  const duplicates = findDuplicates(coordinatorOrder);
  if (duplicates.length > 0) {
    throw new Error(`subscriptions manifest at ${path}: coordinator_order contains duplicates: ${duplicates.join(", ")}.`);
  }
  for (const harness of coordinatorOrder) {
    if (!SUPPORTED_HARNESSES.has(harness)) {
      throw new Error(`subscriptions manifest at ${path}: coordinator_order contains unsupported harness "${harness}".`);
    }
  }
  if (!coordinatorOrder.some((harness) => workers.some((worker) => worker.harness === harness))) {
    throw new Error(
      `subscriptions manifest at ${path}: coordinator_order has no enabled automation worker.`,
    );
  }

  return { schemaVersion, coordinatorOrder, subscriptions, workers, configuredWorkers };
}

function parseSubscriptions(value: unknown, path: string): SubscriptionEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`subscriptions manifest at ${path}: [[subscriptions]] must contain at least one entry.`);
  }
  const subscriptions = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`subscriptions manifest at ${path}: subscriptions[${index}] must be a table.`);
    }
    return {
      id: requiredString(entry.id, `subscriptions[${index}].id`, path),
      provider: requiredString(entry.provider, `subscriptions[${index}].provider`, path),
      plan: requiredString(entry.plan, `subscriptions[${index}].plan`, path),
      enabled: requiredBoolean(entry.enabled, `subscriptions[${index}].enabled`, path),
      automation: requiredBoolean(entry.automation, `subscriptions[${index}].automation`, path),
    };
  });
  const duplicates = findDuplicates(subscriptions.map((subscription) => subscription.id));
  if (duplicates.length > 0) {
    throw new Error(`subscriptions manifest at ${path}: duplicate subscription id(s): ${duplicates.join(", ")}.`);
  }
  return subscriptions;
}

function parseWorkers(value: unknown, path: string): SubscriptionWorker[] {
  if (!Array.isArray(value)) {
    throw new Error(`subscriptions manifest at ${path}: [[workers]] must be an array of tables.`);
  }
  const workers = value.map((entry, index): SubscriptionWorker => {
    if (!isRecord(entry)) {
      throw new Error(`subscriptions manifest at ${path}: workers[${index}] must be a table.`);
    }
    const harness = requiredString(entry.harness, `workers[${index}].harness`, path);
    const family = requiredString(entry.family, `workers[${index}].family`, path) as ModelFamily;
    const usageService = requiredString(entry.usage_service, `workers[${index}].usage_service`, path);
    if (!SUPPORTED_HARNESSES.has(harness)) {
      throw new Error(`subscriptions manifest at ${path}: workers[${index}] has unsupported harness "${harness}".`);
    }
    if (!SUPPORTED_FAMILIES.has(family)) {
      throw new Error(`subscriptions manifest at ${path}: workers[${index}] has unsupported family "${family}".`);
    }
    if (!SUPPORTED_USAGE_SERVICES.has(usageService)) {
      throw new Error(
        `subscriptions manifest at ${path}: workers[${index}] has unsupported usage_service "${usageService}".`,
      );
    }
    return {
      harness,
      model: requiredString(entry.model, `workers[${index}].model`, path),
      family,
      subscription: requiredString(entry.subscription, `workers[${index}].subscription`, path),
      usageService: usageService as SubscriptionWorker["usageService"],
    };
  });
  const duplicates = findDuplicates(workers.map((worker) => `${worker.harness}:${worker.model}`));
  if (duplicates.length > 0) {
    throw new Error(`subscriptions manifest at ${path}: duplicate worker(s): ${duplicates.join(", ")}.`);
  }
  return workers;
}

function parseStringArray(value: unknown, label: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`subscriptions manifest at ${path}: ${label} must be an array of non-empty strings.`);
  }
  return value.map((entry) => (entry as string).trim());
}

function requiredString(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`subscriptions manifest at ${path}: ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredBoolean(value: unknown, label: string, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`subscriptions manifest at ${path}: ${label} must be a boolean.`);
  }
  return value;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Usage services worth querying, derived from the inventory.
 *
 * A service qualifies only when some worker draws on it and that worker's
 * subscription is both enabled and marked as granting automation capacity.
 * Querying a service no worker can use would spend a request against a
 * rate-limited endpoint for an answer nobody acts on.
 */
export function enabledUsageServices(inventory: SubscriptionsInventory): Set<UsageService> {
  const services = new Set<UsageService>();
  for (const worker of inventory.workers) {
    if (worker.usageService) services.add(worker.usageService);
  }
  return services;
}

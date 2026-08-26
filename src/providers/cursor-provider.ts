import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { httpFailureKind, unavailableSnapshot, type UsageProvider, type UsageSnapshot, type UsageWindow } from "../types.js";

const DEFAULT_API_BASE = "https://api2.cursor.sh";
const DEFAULT_TIMEOUT_MS = 10_000;

interface CursorAuth {
  accessToken?: unknown;
}

interface CursorUsagePayload {
  billingCycleStart?: unknown;
  billingCycleEnd?: unknown;
  autoBucketModels?: unknown;
  planUsage?: {
    totalPercentUsed?: unknown;
    /** Cursor dashboard label: Cursor Models. */
    autoPercentUsed?: unknown;
    /** Cursor dashboard label: Other Models. */
    apiPercentUsed?: unknown;
  };
}

interface CursorPlanPayload {
  planInfo?: { planName?: unknown; billingCycleEnd?: unknown };
}

export interface CursorUsageProviderOptions {
  authPath?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Cursor usage provider mirrored in my-claw at
 * `server/src/services/subscription-usage/cursor-provider.ts`.
 *
 * Keep the authenticated RPC, normalization, and fixtures behaviorally aligned
 * when either copy changes. Integration details may differ; never assume where
 * the counterpart repository is checked out.
 *
 * Cursor exposes usage through the same dashboard RPC used by interactive
 * `/usage`; there is no headless usage command. This provider therefore follows
 * the Codex/Grok pattern: it reads harness-managed credentials and calls the
 * provider protocol directly. It never launches or scrapes `cursor-agent`.
 */
export class CursorUsageProvider implements UsageProvider {
  readonly service = "cursor" as const;
  private readonly authPath: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (path: string) => string;
  private readonly timeoutMs: number;

  constructor(options: CursorUsageProviderOptions = {}) {
    const env = options.env ?? process.env;
    const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
    this.authPath = options.authPath ?? join(configHome, "cursor", "auth.json");
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getUsage(): Promise<UsageSnapshot> {
    const accessToken = this.readAccessToken();
    if (!accessToken) {
      return unavailableSnapshot("cursor", "no Cursor CLI access token found");
    }

    try {
      const [usageResponse, planResponse] = await Promise.all([
        this.call("GetCurrentPeriodUsage", accessToken),
        this.call("GetPlanInfo", accessToken),
      ]);
      if (!usageResponse.ok) {
        return unavailableSnapshot(
          "cursor",
          `Cursor usage RPC returned ${usageResponse.status}`,
          httpFailureKind(usageResponse.status),
        );
      }
      if (!planResponse.ok) {
        return unavailableSnapshot(
          "cursor",
          `Cursor plan RPC returned ${planResponse.status}`,
          httpFailureKind(planResponse.status),
        );
      }

      const usage = await readJson<CursorUsagePayload>(usageResponse, "usage");
      const plan = await readJson<CursorPlanPayload>(planResponse, "plan");
      return normalizeCursorUsage(usage, plan);
    } catch (error) {
      return unavailableSnapshot("cursor", `Cursor usage request failed: ${describeError(error)}`);
    }
  }

  private readAccessToken(): string | undefined {
    try {
      const parsed = JSON.parse(this.readFile(this.authPath)) as CursorAuth;
      return typeof parsed.accessToken === "string" && parsed.accessToken.trim()
        ? parsed.accessToken.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private call(method: "GetCurrentPeriodUsage" | "GetPlanInfo", accessToken: string): Promise<Response> {
    return this.fetchImpl(`${this.apiBase}/aiserver.v1.DashboardService/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export function normalizeCursorUsage(
  usage: CursorUsagePayload,
  plan: CursorPlanPayload,
): UsageSnapshot {
  const reset = epochMillis(usage.billingCycleEnd) ?? epochMillis(plan.planInfo?.billingCycleEnd);
  const start = epochMillis(usage.billingCycleStart);
  const total = percentage(usage.planUsage?.totalPercentUsed);
  if (reset === undefined || total === undefined) {
    return unavailableSnapshot("cursor", "Cursor usage response malformed");
  }

  const cycle = { resetsAt: reset, ...(start === undefined ? {} : { startsAt: start }) };
  const windows: UsageWindow[] = [{ label: "monthly", usedPercent: total, ...cycle }];
  const auto = percentage(usage.planUsage?.autoPercentUsed);
  const api = percentage(usage.planUsage?.apiPercentUsed);
  const cursorModels = stringArray(usage.autoBucketModels);
  if (auto !== undefined) {
    windows.push({
      label: "monthly-cursor-models",
      usedPercent: auto,
      ...cycle,
      ...(cursorModels === undefined ? {} : { models: cursorModels }),
    });
  }
  if (api !== undefined) windows.push({ label: "monthly-other-models", usedPercent: api, ...cycle });

  return {
    service: "cursor",
    planType: typeof plan.planInfo?.planName === "string" ? plan.planInfo.planName : "",
    windows,
  };
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(`Cursor ${label} RPC response was not JSON: ${describeError(error)}`, {
      cause: error,
    });
  }
}

function percentage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return undefined;
  }
  return [...new Set(value.map((entry) => (entry as string).trim()))];
}

function epochMillis(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

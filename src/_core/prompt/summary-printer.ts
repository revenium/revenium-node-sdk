import { ReveniumPayload, SummaryFormat } from "../types/index.js";
import { getLogger } from "../config/manager.js";
import { resolveConfig } from "../config/call-config.js";
import { DEFAULT_REVENIUM_BASE_URL, SUMMARY_PRINTER_CONFIG } from "../constants.js";

interface CompletionMetrics {
  id?: string;
  transactionId?: string;
  model?: string;
  provider?: string;
  inputTokenCount?: number;
  outputTokenCount?: number;
  totalTokenCount?: number;
  inputTokenCost?: number;
  outputTokenCost?: number;
  totalCost?: number;
  requestDuration?: number;
}

interface CompletionsApiResponse {
  _embedded?: {
    aICompletionMetricResourceList?: CompletionMetrics[];
  };
}

function delayWithUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

async function fetchCompletionMetrics(
  transactionId: string,
  maxRetries: number = SUMMARY_PRINTER_CONFIG.MAX_RETRIES,
  retryDelay: number = SUMMARY_PRINTER_CONFIG.RETRY_DELAY,
): Promise<CompletionMetrics | null> {
  const config = resolveConfig();
  const logger = getLogger();
  if (!config) return null;
  if (!config.reveniumTeamId) return null;

  const baseUrl = (config.reveniumBaseUrl || DEFAULT_REVENIUM_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/profitstream/v2/api/sources/metrics/ai/completions`;
  const urlWithParams = `${url}?teamId=${encodeURIComponent(config.reveniumTeamId)}&transactionId=${encodeURIComponent(transactionId)}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(urlWithParams, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-api-key": config.reveniumApiKey,
        },
      });

      if (!response.ok) {
        try {
          await response.text();
        } catch {}
        if (attempt < maxRetries - 1) {
          await delayWithUnref(retryDelay);
          continue;
        }
        return null;
      }

      const data = (await response.json()) as CompletionsApiResponse;
      const completions = data._embedded?.aICompletionMetricResourceList;

      if (completions && completions.length > 0) return completions[0];

      if (attempt < maxRetries - 1) {
        await delayWithUnref(retryDelay);
      }
    } catch (error) {
      logger.debug("Failed to fetch trace metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < maxRetries - 1) await delayWithUnref(retryDelay);
    }
  }

  return null;
}

function isSummaryFormat(value: unknown): value is SummaryFormat {
  return value === "human" || value === "json";
}

interface JsonSummary {
  model: string;
  provider: string;
  durationSeconds: number;
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  totalTokenCount: number | null;
  cost: number | null;
  costStatus?: "pending" | "unavailable";
  traceId?: string;
}

function formatJsonSummary(payload: ReveniumPayload, metrics?: CompletionMetrics | null): void {
  const config = resolveConfig();
  const summary: JsonSummary = {
    model: payload.model,
    provider: payload.provider,
    durationSeconds: payload.requestDuration / 1000,
    inputTokenCount: payload.inputTokenCount,
    outputTokenCount: payload.outputTokenCount,
    totalTokenCount: payload.totalTokenCount,
    cost: typeof metrics?.totalCost === "number" ? metrics.totalCost : null,
  };

  if (summary.cost === null) {
    summary.costStatus = config?.reveniumTeamId ? "pending" : "unavailable";
  }

  if (payload.traceId) summary.traceId = payload.traceId;
  console.log(JSON.stringify(summary));
}

function formatTokenCount(count: number | null | undefined): string {
  return typeof count === "number" ? count.toLocaleString() : "unknown";
}

function formatHumanSummary(payload: ReveniumPayload, metrics?: CompletionMetrics | null): void {
  console.log("\n" + "=".repeat(60));
  console.log("REVENIUM USAGE SUMMARY");
  console.log("=".repeat(60));
  console.log(`Model: ${payload.model}`);
  console.log(`Provider: ${payload.provider}`);
  console.log(`Duration: ${(payload.requestDuration / 1000).toFixed(2)}s`);
  console.log(`\nToken Usage:`);
  console.log(`  Input Tokens:  ${formatTokenCount(payload.inputTokenCount)}`);
  console.log(`  Output Tokens: ${formatTokenCount(payload.outputTokenCount)}`);
  console.log(`  Total Tokens:  ${formatTokenCount(payload.totalTokenCount)}`);

  if (typeof metrics?.totalCost === "number") {
    console.log(`\nCost: $${metrics.totalCost.toFixed(6)}`);
  } else {
    const config = resolveConfig();
    if (!config?.reveniumTeamId) {
      console.log(`\nCost: Set REVENIUM_TEAM_ID in .env to see pricing`);
    } else {
      console.log(`\nCost: (pending aggregation)`);
    }
  }

  if (payload.traceId) console.log(`\nTrace ID: ${payload.traceId}`);
  console.log("=".repeat(60) + "\n");
}

function getSummaryFormat(value: boolean | SummaryFormat | undefined): SummaryFormat | null {
  if (!value) return null;
  if (value === true) return "human";
  if (isSummaryFormat(value)) return value;
  return null;
}

export function printUsageSummary(payload: ReveniumPayload): void {
  const config = resolveConfig();
  const format = getSummaryFormat(config?.printSummary);
  if (!format) return;

  const printFn = format === "json" ? formatJsonSummary : formatHumanSummary;

  if (config?.reveniumTeamId && payload.transactionId) {
    fetchCompletionMetrics(payload.transactionId)
      .then((metrics) => {
        try {
          printFn(payload, metrics);
        } catch {}
      })
      .catch(() => {
        try {
          printFn(payload, null);
        } catch {}
      })
      .catch(() => {});
  } else {
    try {
      printFn(payload, null);
    } catch {}
  }
}

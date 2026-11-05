import { getLogger, setConfig } from "../_core/config/manager.js";
import { loadEnvFiles } from "../_core/config/loader.js";
import { withEnvironmentDefaults } from "../_core/config/client-config.js";
import { ReveniumFal } from "./client.js";
import { toReveniumConfig } from "./config.js";
import type { FalConfig } from "./types.js";

let globalClient: ReveniumFal | null = null;

function readFalEnvironment(): Partial<FalConfig> {
  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;

  if (!falApiKey) {
    getLogger().warn(
      "FAL_KEY not found in environment. " +
        "The fal.ai client may use its own env-based auth, " +
        "or requests will fail at runtime.",
    );
  }

  return {
    falApiKey,
    organizationName: process.env.REVENIUM_ORGANIZATION_NAME,
    organizationId: process.env.REVENIUM_ORGANIZATION_ID,
    debug: process.env.REVENIUM_DEBUG === "true",
    failSilent: process.env.REVENIUM_FAIL_SILENT !== "false",
  };
}

export function Initialize(config?: Partial<FalConfig>): void {
  loadEnvFiles();
  const falConfig = config ?? readFalEnvironment();
  const reveniumConfig = withEnvironmentDefaults(toReveniumConfig(falConfig));
  setConfig(reveniumConfig);

  globalClient = new ReveniumFal({ ...falConfig, reveniumApiKey: reveniumConfig.reveniumApiKey });

  getLogger().info("Revenium fal.ai client initialized");
}

export function GetClient(): ReveniumFal {
  if (!globalClient) {
    throw new Error(
      "Revenium fal.ai client not initialized. Call Initialize() first.\n\n" +
        "Example:\n" +
        '  import { Initialize, GetClient } from "@revenium/middleware/fal";\n' +
        "  Initialize();\n" +
        "  const fal = GetClient();",
    );
  }
  return globalClient;
}

export function IsInitialized(): boolean {
  return globalClient !== null;
}

export function Reset(): void {
  globalClient = null;
}

export function Configure(config: Partial<FalConfig>): void {
  Initialize(config);
}

export { ReveniumFal } from "./client.js";

export type { FalConfig, FalUsageMetadata, FalTrackingData } from "./types.js";
export type { MeteredFalQueue } from "./metered-queue.js";

export type { ReveniumConfig, UsageMetadata, Logger, Config } from "../_core/types/index.js";

export {
  detectFromEndpointId,
  correctFromResponse,
  detectMediaType,
} from "./media-type-detector.js";

export { trackFalUsageAsync, sendFalMetrics } from "./tracking.js";

export type {
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "../_core/types/tool-metering.js";

export {
  meterTool,
  reportToolCall,
  setToolContext,
  getToolContext,
  clearToolContext,
  runWithToolContext,
} from "../_core/tool-metering/index.js";

export { flushMeteringBuffer, getBufferStats } from "../_core/metering/buffer.js";
export type { BufferStats } from "../_core/metering/buffer.js";

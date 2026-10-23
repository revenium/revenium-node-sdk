import "./anthropic-augmentation.js";

import { getConfig, getLogger, setConfig } from "../_core/config/manager.js";
import { loadConfigFromEnv } from "../_core/config/loader.js";
import { Config } from "../_core/types/index.js";
import { ENV_VARS } from "../_core/constants.js";
import { patchAnthropic, unpatchAnthropic, isAnthropicPatched } from "./wrapper.js";
import { trackUsageAsync } from "./middleware.js";
import type { AnthropicTrackingData } from "./middleware.js";
import {
  getMeteringCircuitBreaker,
  resetMeteringCircuitBreaker,
} from "../_core/resilience/circuit-breaker.js";

export type { ReveniumConfig, UsageMetadata, Logger, Config } from "../_core/types/index.js";

export type {
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "../_core/types/tool-metering.js";

export { patchAnthropic, unpatchAnthropic, isAnthropicPatched } from "./wrapper.js";

export { trackUsageAsync, extractUsageFromResponse, extractUsageFromStream } from "./middleware.js";

export type { AnthropicTrackingData } from "./middleware.js";

export type { AnthropicProvider } from "./provider-detection.js";

export {
  meterTool,
  reportToolCall,
  setToolContext,
  getToolContext,
  clearToolContext,
  runWithToolContext,
} from "../_core/tool-metering/index.js";

export { setConfig, setLogger, getConfig, getLogger } from "../_core/config/manager.js";

export { flushMeteringBuffer, getBufferStats } from "../_core/metering/buffer.js";
export type { BufferStats } from "../_core/metering/buffer.js";

export interface AnthropicConfig extends Config {
  anthropicApiKey?: string;
  apiTimeout?: number;
}

export function initialize(): void {
  const envConfig = loadConfigFromEnv();
  if (!envConfig) {
    throw new Error(
      "Failed to initialize Revenium middleware: missing required environment variables. " +
        "Set REVENIUM_METERING_API_KEY or call configure() with manual configuration.",
    );
  }

  setConfig(envConfig);
  patchAnthropic();
  getLogger().info("Revenium Anthropic middleware initialized successfully");
}

export function configure(config: Partial<AnthropicConfig>): void {
  setConfig(config as Config);
  patchAnthropic();
  getLogger().info("Revenium Anthropic middleware configured successfully");
}

export function isInitialized(): boolean {
  return isAnthropicPatched() && !!getConfig();
}

export function getStatus(): {
  initialized: boolean;
  patched: boolean;
  hasConfig: boolean;
  circuitBreakerState?: string;
} {
  const stats = getMeteringCircuitBreaker().getStats();
  return {
    initialized: isInitialized(),
    patched: isAnthropicPatched(),
    hasConfig: !!getConfig(),
    circuitBreakerState: stats.state,
  };
}

export function trackAnthropicCall(trackingData: AnthropicTrackingData): void {
  trackUsageAsync(trackingData);
}

export function reset(): void {
  const logger = getLogger();
  try {
    unpatchAnthropic();
    resetMeteringCircuitBreaker();
    logger.debug("Middleware reset completed");
  } catch (error) {
    logger.error("Error during middleware reset", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function hasReveniumApiKeyInEnv(): boolean {
  return !!(process.env[ENV_VARS.REVENIUM_API_KEY] || process.env[ENV_VARS.REVENIUM_API_KEY_ALT]);
}

function autoInitialize(): void {
  try {
    initialize();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    getLogger().warn(
      hasReveniumApiKeyInEnv()
        ? `Revenium metering is not active - no usage records will be sent. Initialization failed: ${reason}`
        : `Revenium metering is not active - no usage records will be sent. Set ${ENV_VARS.REVENIUM_API_KEY} (or ${ENV_VARS.REVENIUM_API_KEY_ALT}) before importing the middleware, or call configure() with a valid key.`,
    );
  }
}

autoInitialize();

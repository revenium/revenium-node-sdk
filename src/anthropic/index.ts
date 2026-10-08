import "./anthropic-augmentation.js";

import { initializeConfig, getConfig, getLogger, setConfig } from "../_core/config/manager.js";
import { Config } from "../_core/types/index.js";
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
  const initialized = initializeConfig();
  if (!initialized) {
    throw new Error(
      "Failed to initialize Revenium middleware: missing required environment variables. " +
        "Set REVENIUM_METERING_API_KEY or call configure() with manual configuration.",
    );
  }

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

function autoInitialize(): void {
  try {
    initialize();
  } catch {
    getLogger().debug("Auto-initialization skipped, manual configuration required");
  }
}

autoInitialize();

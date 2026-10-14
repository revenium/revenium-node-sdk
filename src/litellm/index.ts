import { clearConfig, getConfig, getLogger, setConfig } from "../_core/config/manager.js";
import { loadConfigFromEnv as loadCoreConfigFromEnv } from "../_core/config/loader.js";
import { validateConfig } from "../_core/config/validator.js";
import { ENV_VARS } from "../_core/constants.js";
import { getErrorMessage } from "../_core/resilience/error-handler.js";
import type { Logger, ReveniumConfig } from "../_core/types/index.js";
import {
  patchHttpClient,
  unpatchHttpClient,
  isHttpClientPatched,
  resetHttpClientManager,
  setLiteLLMConfig,
  getLiteLLMConfig,
} from "./http-client.js";
import type { LiteLLMConfig, MiddlewareStatus } from "./types.js";

let isInitialized = false;
let sharedConfigBeforeInstall: ReveniumConfig | null = null;
let installedSharedConfig: ReveniumConfig | null = null;

interface LoadedConfig {
  litellm: LiteLLMConfig;
  shared: ReveniumConfig;
}

function readNonNegativeIntEnv(name: string, logger: Logger): number | undefined {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return undefined;

  const parsed = Number(rawValue);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;

  logger.warn(`Ignoring ${name}="${rawValue}" - expected a non-negative integer`);
  return undefined;
}

function applyDefined(base: ReveniumConfig, overrides: Partial<ReveniumConfig>): ReveniumConfig {
  const merged: ReveniumConfig = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Reflect.set(merged, key, value);
  }

  return merged;
}

function loadConfigFromEnv(): LoadedConfig | null {
  const coreConfig = loadCoreConfigFromEnv();
  const litellmProxyUrl = process.env[ENV_VARS.LITELLM_PROXY_URL];

  if (!coreConfig || !litellmProxyUrl) return null;

  const logger = getLogger();
  const litellm: LiteLLMConfig = {
    reveniumMeteringApiKey: coreConfig.reveniumApiKey,
    reveniumMeteringBaseUrl: coreConfig.reveniumBaseUrl,
    litellmProxyUrl,
    litellmApiKey: process.env[ENV_VARS.LITELLM_API_KEY],
    organizationName: process.env[ENV_VARS.ORGANIZATION_NAME],
    apiTimeout: readNonNegativeIntEnv(ENV_VARS.API_TIMEOUT, logger),
    failSilent: process.env[ENV_VARS.FAIL_SILENT] !== "false",
    maxRetries: readNonNegativeIntEnv(ENV_VARS.MAX_RETRIES, logger),
    printSummary: coreConfig.printSummary,
    teamId: coreConfig.reveniumTeamId,
    capturePrompts: coreConfig.capturePrompts,
  };

  return {
    litellm,
    shared: applyDefined(toSharedConfig(litellm), {
      reveniumEnforcementBaseUrl: coreConfig.reveniumEnforcementBaseUrl,
    }),
  };
}

function toSharedConfig(config: LiteLLMConfig): ReveniumConfig {
  return applyDefined(getConfig() ?? ({} as ReveniumConfig), {
    reveniumApiKey: config.reveniumMeteringApiKey,
    reveniumBaseUrl: config.reveniumMeteringBaseUrl,
    printSummary: config.printSummary,
    reveniumTeamId: config.teamId,
    capturePrompts: config.capturePrompts,
    maxPromptSize: config.maxPromptSize,
    failSilent: config.failSilent,
    maxRetries: config.maxRetries,
  });
}

function install(litellm: LiteLLMConfig, shared: ReveniumConfig, logger: Logger): boolean {
  try {
    validateConfig(shared);
  } catch (error) {
    logger.error("Revenium LiteLLM middleware not initialized - invalid configuration", {
      error: getErrorMessage(error),
    });
    return false;
  }

  if (!patchHttpClient()) {
    logger.error("Failed to patch HTTP client - middleware disabled");
    return false;
  }

  setLiteLLMConfig(litellm);
  sharedConfigBeforeInstall = getConfig();
  setConfig(shared);
  installedSharedConfig = shared;
  isInitialized = true;
  return true;
}

function restoreSharedConfig(): void {
  if (!installedSharedConfig || getConfig() !== installedSharedConfig) return;

  if (sharedConfigBeforeInstall) {
    setConfig(sharedConfigBeforeInstall);
  } else {
    clearConfig();
  }

  installedSharedConfig = null;
  sharedConfigBeforeInstall = null;
}

export function initialize(): boolean {
  const logger = getLogger();
  if (isInitialized && getConfig()) return true;

  const loaded = loadConfigFromEnv();
  if (!loaded) {
    logger.warn(
      "Revenium LiteLLM middleware not initialized - missing configuration. " +
        "Required: REVENIUM_METERING_API_KEY (or REVENIUM_API_KEY) and LITELLM_PROXY_URL",
    );
    return false;
  }

  if (!install(loaded.litellm, loaded.shared, logger)) return false;

  logger.info("Revenium LiteLLM middleware initialized successfully");
  return true;
}

export function configure(config: LiteLLMConfig): boolean {
  return install(config, toSharedConfig(config), getLogger());
}

export function isMiddlewareInitialized(): boolean {
  return isInitialized && isHttpClientPatched();
}

export function getStatus(): MiddlewareStatus {
  const config = getLiteLLMConfig();
  return {
    initialized: isInitialized,
    patched: isHttpClientPatched(),
    hasConfig: !!config,
    proxyUrl: config?.litellmProxyUrl,
  };
}

export function enable(): boolean {
  const logger = getLogger();
  const config = getLiteLLMConfig();
  if (!config) {
    logger.error("Cannot enable middleware without configuration");
    return false;
  }

  const success = patchHttpClient();
  if (success) isInitialized = true;
  return success;
}

export function disable(): boolean {
  const success = unpatchHttpClient();
  if (success) isInitialized = false;
  return success;
}

export function reset(): void {
  isInitialized = false;
  resetHttpClientManager();
  restoreSharedConfig();
}

export type {
  LiteLLMConfig,
  LiteLLMUsageMetadata,
  MiddlewareStatus,
  LiteLLMChatCompletionRequest,
  LiteLLMChatCompletionResponse,
  LiteLLMEmbeddingRequest,
  LiteLLMEmbeddingResponse,
  ProviderPattern,
  ChatMessage,
  MessageRole,
  TokenUsage,
  ResponseChoice,
  ResponseMessage,
} from "./types.js";

export {
  extractModelSource,
  extractProvider,
  extractModelName,
  isValidModelFormat,
  PROVIDER_REGISTRY,
} from "./provider-mapper.js";

export { trackUsageAsync, trackEmbeddingsUsageAsync } from "./tracking.js";

export {
  patchHttpClient,
  unpatchHttpClient,
  isHttpClientPatched,
  resetHttpClientManager,
} from "./http-client.js";

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

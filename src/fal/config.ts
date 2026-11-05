import { snapshotClientConfig } from "../_core/config/client-config.js";
import type { ReveniumConfig } from "../_core/types/index.js";
import type { FalConfig, FalUsageMetadata } from "./types.js";

export function toReveniumConfig(config: FalConfig): ReveniumConfig;
export function toReveniumConfig(config: Partial<FalConfig>): Partial<ReveniumConfig>;
export function toReveniumConfig(config: Partial<FalConfig>): Partial<ReveniumConfig> {
  return {
    reveniumApiKey: config.reveniumApiKey,
    reveniumBaseUrl: config.reveniumBaseUrl,
    debug: config.debug,
    printSummary: config.printSummary,
    reveniumTeamId: config.teamId,
    capturePrompts: config.capturePrompts,
    maxPromptSize: config.maxPromptSize,
    failSilent: config.failSilent,
    maxRetries: config.maxRetries,
    bufferMaxSize: config.bufferMaxSize,
  };
}

export function toClientReveniumConfig(config: FalConfig): ReveniumConfig {
  return snapshotClientConfig(toReveniumConfig(config));
}

export function withConfigDefaults(
  config: FalConfig,
  metadata?: FalUsageMetadata,
): FalUsageMetadata | undefined {
  if (!config.organizationName && !config.organizationId) return metadata;
  return {
    organizationName: config.organizationName || config.organizationId,
    ...metadata,
  };
}

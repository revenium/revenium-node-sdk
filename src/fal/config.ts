import { snapshotClientConfig } from "../_core/config/client-config.js";
import type { ReveniumConfig } from "../_core/types/index.js";
import type { FalConfig } from "./types.js";

export function toReveniumConfig(config: FalConfig): ReveniumConfig {
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
  };
}

export function toClientReveniumConfig(config: FalConfig): ReveniumConfig {
  return snapshotClientConfig(toReveniumConfig(config));
}

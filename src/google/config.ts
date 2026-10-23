import { loadEnvFiles } from "../_core/config/loader.js";
import { getConfig, getLogger, initializeConfig, setConfig } from "../_core/config/manager.js";
import { DEFAULT_REVENIUM_BASE_URL, ENV_VARS } from "../_core/constants.js";
import type { ReveniumConfig } from "../_core/types/index.js";

let initializationAttempted = false;

function hasReveniumKeyInEnvironment(): boolean {
  loadEnvFiles();
  return !!(process.env[ENV_VARS.REVENIUM_API_KEY] || process.env[ENV_VARS.REVENIUM_API_KEY_ALT]);
}

function warnMeteringDisabled(): void {
  const reason = hasReveniumKeyInEnvironment()
    ? `${ENV_VARS.REVENIUM_API_KEY} is set but was rejected - check the key value.`
    : `Set ${ENV_VARS.REVENIUM_API_KEY} (or ${ENV_VARS.REVENIUM_API_KEY_ALT}).`;

  getLogger().warn(
    `Revenium metering is not configured - no usage records will be sent. ${reason}`,
  );
}

export function ensureGoogleConfig(): boolean {
  if (getConfig()) return true;
  if (initializationAttempted) return false;

  initializationAttempted = true;
  if (initializeConfig()) return true;

  warnMeteringDisabled();
  return false;
}

export function initialize(): boolean {
  initializationAttempted = false;

  if (!ensureGoogleConfig()) return false;

  getLogger().info("Revenium Google middleware initialized successfully");
  return true;
}

export function configure(config: ReveniumConfig): boolean {
  try {
    setConfig({
      ...config,
      reveniumBaseUrl: config.reveniumBaseUrl ?? DEFAULT_REVENIUM_BASE_URL,
    });
    return true;
  } catch (error) {
    getLogger().error("Failed to apply Revenium configuration:", error);
    return false;
  }
}

export function isInitialized(): boolean {
  return !!getConfig();
}

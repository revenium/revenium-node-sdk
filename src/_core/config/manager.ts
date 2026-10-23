import { ReveniumConfig, Logger } from "../types/index.js";
import { loadConfigFromEnv } from "./loader.js";
import { validateConfig } from "./validator.js";

export const defaultLogger: Logger = {
  debug: (message: string, ...args: unknown[]) => {
    if (globalConfig?.debug || process.env.REVENIUM_DEBUG === "true") {
      console.debug(`[Revenium Debug] ${message}`, ...args);
    }
  },
  info: (message: string, ...args: unknown[]) => {
    console.info(`[Revenium] ${message}`, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[Revenium Warning] ${message}`, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[Revenium Error] ${message}`, ...args);
  },
};

let globalConfig: ReveniumConfig | null = null;
let globalLogger: Logger = defaultLogger;

export function getConfig(): ReveniumConfig | null {
  return globalConfig;
}

export function setConfig(config: ReveniumConfig): void {
  validateConfig(config);
  globalConfig = { ...config };
  globalLogger.debug("Revenium configuration updated", {
    baseUrl: config.reveniumBaseUrl,
    hasApiKey: !!config.reveniumApiKey,
  });
}

export function getLogger(): Logger {
  return globalLogger;
}

export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

export function initializeConfig(): boolean {
  const envConfig = loadConfigFromEnv();
  if (envConfig) {
    try {
      setConfig(envConfig);
      globalLogger.debug("Revenium middleware initialized from environment variables");
      return true;
    } catch (error) {
      globalLogger.error("Failed to initialize Revenium configuration:", error);
      return false;
    }
  }
  return false;
}

export function clearConfig(): void {
  globalConfig = null;
}

export function resetConfig(): void {
  clearConfig();
  globalLogger = defaultLogger;
}

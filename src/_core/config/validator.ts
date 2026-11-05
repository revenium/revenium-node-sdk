import { ReveniumConfig } from "../types/index.js";

export type ValidatedConfig<T extends ReveniumConfig> = Partial<T> & ReveniumConfig;

export function validateConfig<T extends ReveniumConfig>(
  config: Partial<T>,
): asserts config is ValidatedConfig<T> {
  const { reveniumApiKey, reveniumBaseUrl } = config;

  if (!reveniumApiKey) {
    throw new Error(
      "Revenium API key is required. Set REVENIUM_METERING_API_KEY environment variable or provide reveniumApiKey in config.",
    );
  }

  const validPrefixes = ["hak_", "rev_"];
  if (!validPrefixes.some((prefix) => reveniumApiKey.startsWith(prefix))) {
    throw new Error(
      'Invalid Revenium API key format. Revenium API keys should start with "hak_" or "rev_"',
    );
  }

  if (!reveniumBaseUrl) {
    throw new Error("Revenium base URL is missing.");
  }

  try {
    new URL(reveniumBaseUrl);
  } catch {
    throw new Error(`Invalid Revenium base URL format: ${reveniumBaseUrl}`);
  }
}

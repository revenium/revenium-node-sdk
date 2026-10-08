import { getLogger } from "../_core/config/manager.js";
import { sanitizeCredentials } from "../_core/prompt/extraction.js";

export type AnthropicProvider = "Anthropic" | "Foundry";

export const DIRECT_ANTHROPIC_PROVIDER: AnthropicProvider = "Anthropic";

const FOUNDRY_HOST = "services.ai.azure.com";

function isFoundryHost(hostname: string): boolean {
  return hostname === FOUNDRY_HOST || hostname.endsWith(`.${FOUNDRY_HOST}`);
}

export function detectAnthropicProvider(baseUrl?: string): AnthropicProvider {
  if (!baseUrl) return DIRECT_ANTHROPIC_PROVIDER;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return isFoundryHost(hostname) ? "Foundry" : DIRECT_ANTHROPIC_PROVIDER;
  } catch {
    getLogger().debug(
      `Anthropic base URL could not be parsed, metering as ${DIRECT_ANTHROPIC_PROVIDER}: ${sanitizeCredentials(baseUrl)}`,
    );
    return DIRECT_ANTHROPIC_PROVIDER;
  }
}

import { getLogger } from "../_core/config/manager.js";
import { sanitizeCredentials } from "../_core/prompt/extraction.js";

export type AnthropicProvider = "Anthropic" | "Foundry" | "AWS" | "Google";

export const DIRECT_ANTHROPIC_PROVIDER: AnthropicProvider = "Anthropic";

const FOUNDRY_HOST = "services.ai.azure.com";
const BEDROCK_HOST = /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.(amazonaws\.com|api\.aws)$/;
const VERTEX_HOST = /^(([a-z0-9-]+-)?aiplatform|aiplatform\.[a-z0-9-]+\.rep)\.googleapis\.com$/;

function isFoundryHost(hostname: string): boolean {
  return hostname === FOUNDRY_HOST || hostname.endsWith(`.${FOUNDRY_HOST}`);
}

function labelForHost(hostname: string): AnthropicProvider {
  if (isFoundryHost(hostname)) return "Foundry";
  if (BEDROCK_HOST.test(hostname)) return "AWS";
  if (VERTEX_HOST.test(hostname)) return "Google";
  return DIRECT_ANTHROPIC_PROVIDER;
}

export function detectAnthropicProvider(baseUrl?: string): AnthropicProvider {
  if (!baseUrl) return DIRECT_ANTHROPIC_PROVIDER;

  try {
    return labelForHost(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    getLogger().debug(
      `Anthropic base URL could not be parsed, metering as ${DIRECT_ANTHROPIC_PROVIDER}: ${sanitizeCredentials(baseUrl)}`,
    );
    return DIRECT_ANTHROPIC_PROVIDER;
  }
}

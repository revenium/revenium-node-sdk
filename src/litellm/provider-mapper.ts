import type { ProviderPattern } from "./types.js";

/**
 * Owned by the cache de-fold decision, not by display classification: editing the registry
 * for reporting must not change how cached tokens are priced.
 */
const ANTHROPIC_FAMILY_PATTERNS = ["claude", "anthropic"];

export const PROVIDER_REGISTRY: ProviderPattern[] = [
  {
    source: "OPENAI",
    displayName: "OpenAI",
    patterns: ["gpt-", "davinci", "curie", "babbage", "ada", "text-embedding"],
    prefixes: ["openai"],
  },
  {
    source: "ANTHROPIC",
    displayName: "Anthropic",
    patterns: ANTHROPIC_FAMILY_PATTERNS,
    prefixes: ["anthropic"],
  },
  {
    source: "GOOGLE",
    displayName: "Google Vertex AI",
    patterns: ["gemini", "palm", "bison", "gecko"],
    prefixes: ["vertex_ai", "palm"],
  },
  {
    source: "AZURE",
    displayName: "Azure OpenAI",
    patterns: ["azure"],
    prefixes: ["azure"],
  },
  {
    source: "COHERE",
    displayName: "Cohere",
    patterns: ["command", "cohere"],
    prefixes: ["cohere"],
  },
  {
    source: "HUGGINGFACE",
    displayName: "Hugging Face",
    patterns: ["huggingface"],
    prefixes: ["huggingface"],
  },
  {
    source: "TOGETHER",
    displayName: "Together AI",
    patterns: ["llama", "mistral", "mixtral"],
    prefixes: ["together_ai"],
  },
  {
    source: "OLLAMA",
    displayName: "Ollama",
    patterns: ["ollama"],
    prefixes: ["ollama"],
  },
  {
    source: "MISTRAL",
    displayName: "Mistral",
    patterns: ["mistral"],
    prefixes: ["mistral"],
  },
  {
    source: "GROQ",
    displayName: "Groq",
    patterns: ["groq"],
    prefixes: ["groq"],
  },
];

/**
 * Matches the Anthropic model family regardless of who hosts it: `vertex_ai/claude-*` and
 * `bedrock/anthropic.claude-*` are served by Anthropic's own transformer even though their
 * prefix resolves to another source.
 */
export function isAnthropicModelFamily(model: string): boolean {
  const modelLower = model.toLowerCase();
  return ANTHROPIC_FAMILY_PATTERNS.some((pattern) => modelLower.includes(pattern));
}

function extractProviderPrefix(model: string): string | null {
  const parts = model.split("/");
  return parts.length > 1 ? parts[0].toLowerCase() : null;
}

export function extractModelSource(model: string): string {
  const modelLower = model.toLowerCase();
  const prefix = extractProviderPrefix(model);

  if (prefix) {
    for (const provider of PROVIDER_REGISTRY) {
      if (provider.prefixes.includes(prefix)) return provider.source;
    }
  }

  for (const provider of PROVIDER_REGISTRY) {
    if (provider.patterns.some((pattern) => modelLower.includes(pattern))) return provider.source;
  }

  return "LITELLM";
}

export function extractProvider(model: string): string {
  const modelLower = model.toLowerCase();
  const prefix = extractProviderPrefix(model);

  if (prefix) {
    for (const provider of PROVIDER_REGISTRY) {
      if (provider.prefixes.includes(prefix)) return provider.displayName;
    }
  }

  for (const provider of PROVIDER_REGISTRY) {
    if (provider.patterns.some((pattern) => modelLower.includes(pattern)))
      return provider.displayName;
  }

  return prefix || "Unknown";
}

export function extractModelName(model: string): string {
  return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}

export function isValidModelFormat(model: string): boolean {
  if (!model || typeof model !== "string") return false;
  return model.trim().length > 0 && /^[a-zA-Z0-9/_.-]+$/.test(model.trim());
}

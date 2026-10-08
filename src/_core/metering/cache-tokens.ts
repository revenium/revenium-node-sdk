/**
 * Shared cache-token extraction for metering emitters.
 *
 * Different providers (and different LiteLLM normalization paths) report prompt-cache
 * token counts under different shapes:
 *  - Anthropic-native: top-level `cache_read_input_tokens` / `cache_creation_input_tokens`
 *    on the usage object. These are ADDITIONAL to `input_tokens` (not a subset of it).
 *  - OpenAI-normalized: `prompt_tokens_details.cached_tokens`. This IS a subset of
 *    `prompt_tokens` (cache reads are already counted in the prompt token total).
 *
 * LiteLLM does not consistently normalize every provider into the OpenAI shape --
 * when it proxies Anthropic models it can surface the Anthropic-native fields
 * directly on the usage object, with or without also populating
 * `prompt_tokens_details.cached_tokens`. An emitter that only reads the OpenAI shape
 * silently drops cache accounting for Anthropic-through-LiteLLM traffic.
 *
 * This helper centralizes that extraction so every emitter (LiteLLM, Anthropic, future
 * providers) reads both shapes the same way, instead of re-implementing (and
 * re-forgetting) the Anthropic-native fallback per call site.
 */

export interface UsageCacheTokenFields {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
}

export interface CacheTokenCounts {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

function toDefinedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extracts cache-read and cache-creation token counts from a provider usage object.
 *
 * Tolerant of missing/null/undefined input and of either shape being partially or
 * fully absent. Anthropic-native fields are preferred when present (they are more
 * precise about cache creation vs. read), falling back to the OpenAI-normalized
 * `cached_tokens` field for cache reads. There is no OpenAI-shape equivalent for cache
 * creation, so `cacheCreationTokens` is only ever populated from the Anthropic-native
 * field.
 *
 * Returns `undefined` (never `0`) for a field this usage object doesn't report.
 * A hardcoded `0` positively asserts "zero cache tokens were used," which is a
 * different -- and often incorrect -- claim than "this field wasn't reported."
 * Callers/consumers should treat `undefined` as "unknown," not "zero."
 */
export function extractCacheTokenCounts(
  usage: UsageCacheTokenFields | null | undefined,
): CacheTokenCounts {
  if (!usage) return {};

  const cacheReadTokens =
    toDefinedNumber(usage.cache_read_input_tokens) ??
    toDefinedNumber(usage.prompt_tokens_details?.cached_tokens);

  const cacheCreationTokens = toDefinedNumber(usage.cache_creation_input_tokens);

  return { cacheReadTokens, cacheCreationTokens };
}

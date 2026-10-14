/**
 * Shared cache-token extraction for metering emitters.
 *
 * Different providers (and different LiteLLM normalization paths) report prompt-cache
 * token counts under different shapes:
 *  - Anthropic-native: top-level `cache_read_input_tokens` / `cache_creation_input_tokens`
 *    on the usage object. On the raw Anthropic API these are ADDITIONAL to `input_tokens`
 *    (not a subset of it).
 *  - OpenAI-normalized: `prompt_tokens_details.cached_tokens`. This IS a subset of
 *    `prompt_tokens` (cache reads are already counted in the prompt token total).
 *
 * LiteLLM does not consistently normalize every provider into the OpenAI shape --
 * when it proxies Anthropic models it can surface the Anthropic-native fields
 * directly on the usage object, with or without also populating
 * `prompt_tokens_details.cached_tokens`. An emitter that only reads the OpenAI shape
 * silently drops cache accounting for Anthropic-through-LiteLLM traffic.
 *
 * External contract, LiteLLM's Anthropic transformer (`calculate_usage`): it folds both
 * cache legs into `prompt_tokens` (`prompt_tokens = input_tokens + cache_creation +
 * cache_read`). An emitter that bills `prompt_tokens` as-is therefore charges cached
 * tokens twice, at the uncached rate. The fold is a property of that transformer, not of
 * the field shape: LiteLLM's Gemini transformer populates the same top-level fields
 * WITHOUT folding, because Google already counts cache reads inside `promptTokenCount`.
 * Callers must therefore decide from the provider -- not from field presence -- whether
 * `resolveTokenTotalsExcludingFoldedCache` applies.
 *
 * This helper centralizes that extraction so every emitter (LiteLLM, Anthropic, future
 * providers) reads both shapes the same way, instead of re-implementing (and
 * re-forgetting) the Anthropic-native fallback per call site.
 */

import { getLogger } from "../config/manager.js";

export interface CacheCreationTtlBuckets {
  ephemeral_5m_input_tokens?: number | null;
  ephemeral_1h_input_tokens?: number | null;
}

export interface UsageCacheTokenFields {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: CacheCreationTtlBuckets | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
    cache_creation_token_details?: CacheCreationTtlBuckets | null;
  } | null;
}

export interface CacheTokenCounts {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CacheCreationSplit {
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
}

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function toDefinedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Providers commonly report the same count under two shapes and default the one they
 * don't populate to zero, so a reported non-zero count wins over a reported zero.
 */
export function resolveReportedCount(primary: unknown, fallback: unknown): number | undefined {
  const primaryCount = toDefinedNumber(primary);
  if (primaryCount) return primaryCount;
  return toDefinedNumber(fallback) ?? primaryCount;
}

/**
 * Extracts cache-read and cache-creation token counts from a provider usage object.
 *
 * Tolerant of missing/null/undefined input and of either shape being partially or
 * fully absent. For cache reads a non-zero Anthropic-native `cache_read_input_tokens`
 * wins; a native zero or an absent native field falls back to the OpenAI-normalized
 * `prompt_tokens_details.cached_tokens` (see `resolveReportedCount`). There is no
 * OpenAI-shape equivalent for cache creation, so `cacheCreationTokens` is only ever
 * populated from the Anthropic-native field.
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

  const cacheReadTokens = resolveReportedCount(
    usage.cache_read_input_tokens,
    usage.prompt_tokens_details?.cached_tokens,
  );

  const cacheCreationTokens = toDefinedNumber(usage.cache_creation_input_tokens);

  return { cacheReadTokens, cacheCreationTokens };
}

/**
 * Removes the cache legs an upstream transformer folded into the prompt token count, and
 * recomputes the total from the de-folded input so it matches what is billed.
 * Only call this for providers that actually fold (see the module header).
 */
export function resolveTokenTotalsExcludingFoldedCache(
  totals: TokenTotals,
  cacheTokens: CacheTokenCounts,
): TokenTotals {
  const foldedTokens = (cacheTokens.cacheReadTokens ?? 0) + (cacheTokens.cacheCreationTokens ?? 0);
  if (foldedTokens === 0) return totals;

  if (foldedTokens > totals.promptTokens) {
    getLogger().warn("Reported cache tokens exceed prompt tokens, metering input as zero", {
      promptTokens: totals.promptTokens,
      foldedTokens,
    });
  }

  const promptTokens = Math.max(0, totals.promptTokens - foldedTokens);
  return { ...totals, promptTokens, totalTokens: promptTokens + totals.completionTokens };
}

/**
 * Splits cache-creation tokens by TTL bucket, from the LiteLLM-normalized
 * `prompt_tokens_details.cache_creation_token_details` or the Anthropic-native
 * `cache_creation`. A bucket the provider didn't report stays `undefined` so consumers
 * keep their own fallback rate instead of pricing a synthesized zero.
 */
export function extractCacheCreationSplit(
  usage: UsageCacheTokenFields | null | undefined,
): CacheCreationSplit {
  const normalized = usage?.prompt_tokens_details?.cache_creation_token_details;
  const native = usage?.cache_creation;
  return {
    cacheCreation5mTokens: resolveReportedCount(
      normalized?.ephemeral_5m_input_tokens,
      native?.ephemeral_5m_input_tokens,
    ),
    cacheCreation1hTokens: resolveReportedCount(
      normalized?.ephemeral_1h_input_tokens,
      native?.ephemeral_1h_input_tokens,
    ),
  };
}

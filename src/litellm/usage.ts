import {
  extractCacheTokenCounts,
  extractCacheCreationSplit,
  resolveReportedCount,
  resolveTokenTotalsExcludingFoldedCache,
} from "../_core/metering/cache-tokens.js";
import type { CacheCreationTtlBuckets } from "../_core/metering/cache-tokens.js";
import { isAnthropicModelFamily } from "./provider-mapper.js";
import type { TokenUsage } from "./types.js";

export interface ExtractedUsageTokens {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  reasoningTokens?: number;
}

/**
 * Only LiteLLM's Anthropic transformer adds the cache legs on top of the input tokens, and
 * the Bedrock and Vertex AI Anthropic configs inherit it, so the fold follows the model
 * family rather than the hosting prefix or the shape of the reported fields. Every other
 * provider LiteLLM proxies reports cache reads as a subset of `prompt_tokens`, and the
 * metering backend already subtracts those server-side.
 */
function cacheTokensAreFoldedIntoPromptTokens(model: string): boolean {
  return isAnthropicModelFamily(model);
}

/**
 * A proxy request carries the alias from the `model_list`, while the response carries the
 * model that actually served it, so the alias is only a fallback for the fold decision.
 */
export function resolveMeteredModel(requestModel: string, responseModel?: string): string {
  return responseModel || requestModel;
}

function mergeTtlBuckets(
  previous?: CacheCreationTtlBuckets,
  chunk?: CacheCreationTtlBuckets,
): CacheCreationTtlBuckets | undefined {
  if (!chunk) return previous;
  if (!previous) return chunk;
  return {
    ephemeral_5m_input_tokens: resolveReportedCount(
      chunk.ephemeral_5m_input_tokens,
      previous.ephemeral_5m_input_tokens,
    ),
    ephemeral_1h_input_tokens: resolveReportedCount(
      chunk.ephemeral_1h_input_tokens,
      previous.ephemeral_1h_input_tokens,
    ),
  };
}

function mergePromptTokensDetails(
  previous?: TokenUsage["prompt_tokens_details"],
  chunk?: TokenUsage["prompt_tokens_details"],
): TokenUsage["prompt_tokens_details"] {
  if (!chunk) return previous;
  if (!previous) return chunk;
  return {
    cached_tokens: resolveReportedCount(chunk.cached_tokens, previous.cached_tokens),
    cache_creation_token_details: mergeTtlBuckets(
      previous.cache_creation_token_details,
      chunk.cache_creation_token_details,
    ),
  };
}

function mergeCompletionTokensDetails(
  previous?: TokenUsage["completion_tokens_details"],
  chunk?: TokenUsage["completion_tokens_details"],
): TokenUsage["completion_tokens_details"] {
  if (!chunk) return previous;
  if (!previous) return chunk;
  return {
    reasoning_tokens: resolveReportedCount(chunk.reasoning_tokens, previous.reasoning_tokens),
  };
}

/**
 * Streamed usage arrives across several chunks: the totals of the latest chunk win, while
 * every cache and reasoning count reported earlier survives a chunk that omits it or
 * reports it as zero.
 */
export function mergeReportedUsage(
  previous: TokenUsage | undefined,
  chunk: TokenUsage,
): TokenUsage {
  if (!previous) return chunk;
  return {
    ...previous,
    ...chunk,
    cache_read_input_tokens: resolveReportedCount(
      chunk.cache_read_input_tokens,
      previous.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: resolveReportedCount(
      chunk.cache_creation_input_tokens,
      previous.cache_creation_input_tokens,
    ),
    cache_creation: mergeTtlBuckets(previous.cache_creation, chunk.cache_creation),
    prompt_tokens_details: mergePromptTokensDetails(
      previous.prompt_tokens_details,
      chunk.prompt_tokens_details,
    ),
    completion_tokens_details: mergeCompletionTokensDetails(
      previous.completion_tokens_details,
      chunk.completion_tokens_details,
    ),
  };
}

function extractReasoningTokens(usage: TokenUsage | undefined): number | undefined {
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  return typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
    ? reasoningTokens
    : undefined;
}

export function extractUsageTokens(
  usage: TokenUsage | undefined,
  model: string,
): ExtractedUsageTokens {
  const cacheTokens = extractCacheTokenCounts(usage);
  const reportedTotals = {
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    totalTokens: usage?.total_tokens || 0,
  };

  const totals = cacheTokensAreFoldedIntoPromptTokens(model)
    ? resolveTokenTotalsExcludingFoldedCache(reportedTotals, cacheTokens)
    : reportedTotals;

  return {
    ...totals,
    cachedTokens: cacheTokens.cacheReadTokens,
    cacheCreationTokens: cacheTokens.cacheCreationTokens,
    ...extractCacheCreationSplit(usage),
    reasoningTokens: extractReasoningTokens(usage),
  };
}

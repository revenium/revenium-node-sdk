import { extractCacheTokenCounts } from "../../../src/_core/metering/cache-tokens";

describe("extractCacheTokenCounts", () => {
  it("reads Anthropic-native cache fields", () => {
    const result = extractCacheTokenCounts({
      cache_read_input_tokens: 21808,
      cache_creation_input_tokens: 7880,
    });

    expect(result).toEqual({ cacheReadTokens: 21808, cacheCreationTokens: 7880 });
  });

  it("reads OpenAI-normalized cache_tokens for cache reads", () => {
    const result = extractCacheTokenCounts({
      prompt_tokens_details: { cached_tokens: 33 },
    });

    expect(result).toEqual({ cacheReadTokens: 33, cacheCreationTokens: undefined });
  });

  it("has no OpenAI-shape equivalent for cache creation", () => {
    const result = extractCacheTokenCounts({
      prompt_tokens_details: { cached_tokens: 33 },
    });

    expect(result.cacheCreationTokens).toBeUndefined();
  });

  it("prefers the Anthropic-native cache read field over the OpenAI-normalized one when both are present", () => {
    const result = extractCacheTokenCounts({
      cache_read_input_tokens: 100,
      prompt_tokens_details: { cached_tokens: 99 },
    });

    expect(result.cacheReadTokens).toBe(100);
  });

  it("returns undefined for both fields when usage is undefined", () => {
    expect(extractCacheTokenCounts(undefined)).toEqual({});
  });

  it("returns undefined for both fields when usage is null", () => {
    expect(extractCacheTokenCounts(null)).toEqual({});
  });

  it("returns undefined for both fields when usage reports neither shape", () => {
    const result = extractCacheTokenCounts({});
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheCreationTokens).toBeUndefined();
  });

  it("tolerates null values on the individual cache fields", () => {
    const result = extractCacheTokenCounts({
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      prompt_tokens_details: { cached_tokens: null },
    });

    expect(result).toEqual({ cacheReadTokens: undefined, cacheCreationTokens: undefined });
  });

  it("tolerates a null prompt_tokens_details object", () => {
    const result = extractCacheTokenCounts({
      prompt_tokens_details: null,
    });

    expect(result.cacheReadTokens).toBeUndefined();
  });

  it("preserves genuine zero values rather than treating them as unknown", () => {
    const result = extractCacheTokenCounts({
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    expect(result).toEqual({ cacheReadTokens: 0, cacheCreationTokens: 0 });
  });
});

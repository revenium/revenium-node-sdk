import { createReveniumConfig, createLiteLLMConfig, createMockFetch } from "../../helpers/fixtures";
import type {
  LiteLLMChatCompletionResponse,
  RequestContext,
  TokenUsage,
} from "../../../src/litellm/types";

const originalFetch = global.fetch;

const ANTHROPIC_MODEL = "anthropic/claude-sonnet-4";
const GEMINI_MODEL = "gemini/gemini-2.5-flash";
const VERTEX_CLAUDE_MODEL = "vertex_ai/claude-sonnet-4@20250514";

function responseWithUsage(
  usage: TokenUsage,
  model = ANTHROPIC_MODEL,
): LiteLLMChatCompletionResponse {
  return {
    id: "chatcmpl-cache",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

const anthropicCachedUsage: TokenUsage = {
  prompt_tokens: 3012,
  completion_tokens: 5,
  total_tokens: 3017,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 0,
};

describe("extractUsageFromResponse cache normalization", () => {
  let extractUsageFromResponse: typeof import("../../../src/litellm/tracking").extractUsageFromResponse;

  beforeEach(async () => {
    jest.resetModules();
    extractUsageFromResponse = (await import("../../../src/litellm/tracking"))
      .extractUsageFromResponse;
  });

  it("removes cache reads folded into prompt tokens by LiteLLM", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage(anthropicCachedUsage),
      ANTHROPIC_MODEL,
    );

    expect(usage.promptTokens).toBe(12);
    expect(usage.cachedTokens).toBe(3000);
    expect(usage.totalTokens).toBe(17);
  });

  it("removes cache writes folded into prompt tokens by LiteLLM", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        ...anthropicCachedUsage,
        prompt_tokens: 5012,
        cache_creation_input_tokens: 2000,
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.promptTokens).toBe(12);
    expect(usage.cacheCreationTokens).toBe(2000);
  });

  it("keeps the prompt tokens of a provider that does not fold its cache reads", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage(
        {
          prompt_tokens: 3012,
          completion_tokens: 5,
          total_tokens: 3017,
          cache_read_input_tokens: 3000,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
        GEMINI_MODEL,
      ),
      GEMINI_MODEL,
    );

    expect(usage.promptTokens).toBe(3012);
    expect(usage.totalTokens).toBe(3017);
    expect(usage.cachedTokens).toBe(3000);
  });

  it("removes the folded cache reads of a Claude model served through Vertex AI", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage(anthropicCachedUsage, VERTEX_CLAUDE_MODEL),
      VERTEX_CLAUDE_MODEL,
    );

    expect(usage.promptTokens).toBe(12);
    expect(usage.cachedTokens).toBe(3000);
    expect(usage.totalTokens).toBe(17);
  });

  it("removes the folded cache reads of a Claude call reported in the OpenAI shape", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        prompt_tokens: 3012,
        completion_tokens: 5,
        total_tokens: 3017,
        prompt_tokens_details: { cached_tokens: 3000 },
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.promptTokens).toBe(12);
    expect(usage.totalTokens).toBe(17);
    expect(usage.cachedTokens).toBe(3000);
  });

  it("de-folds a Claude call routed through a proxy alias", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage(anthropicCachedUsage, ANTHROPIC_MODEL),
      "production",
    );

    expect(usage.promptTokens).toBe(12);
    expect(usage.totalTokens).toBe(17);
  });

  it("keeps the prompt tokens of a non-Anthropic model behind a proxy alias", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage(
        {
          prompt_tokens: 3012,
          completion_tokens: 5,
          total_tokens: 3017,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
        GEMINI_MODEL,
      ),
      "production",
    );

    expect(usage.promptTokens).toBe(3012);
  });

  it("leaves a cache-free Anthropic-shaped call unchanged", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        prompt_tokens: 120,
        completion_tokens: 5,
        total_tokens: 125,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.promptTokens).toBe(120);
    expect(usage.totalTokens).toBe(125);
  });

  it("uses the normalized cache read when the Anthropic-native field is zeroed", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        prompt_tokens: 3012,
        completion_tokens: 5,
        total_tokens: 3017,
        cache_read_input_tokens: 0,
        prompt_tokens_details: { cached_tokens: 3000 },
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.cachedTokens).toBe(3000);
    expect(usage.promptTokens).toBe(12);
  });

  it("clamps at zero when reported cache counts exceed prompt tokens", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        cache_read_input_tokens: 4000,
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.promptTokens).toBe(0);
  });

  it("reports the cache creation TTL split when LiteLLM provides it", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        prompt_tokens: 5012,
        completion_tokens: 5,
        total_tokens: 5017,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 2000,
        prompt_tokens_details: {
          cached_tokens: 3000,
          cache_creation_token_details: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 2000,
          },
        },
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.cacheCreation5mTokens).toBe(0);
    expect(usage.cacheCreation1hTokens).toBe(2000);
  });

  it("falls back to the Anthropic-native TTL split when the normalized one is empty", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        ...anthropicCachedUsage,
        prompt_tokens: 5012,
        cache_creation_input_tokens: 2000,
        prompt_tokens_details: { cache_creation_token_details: {} },
        cache_creation: { ephemeral_1h_input_tokens: 2000 },
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.cacheCreation1hTokens).toBe(2000);
  });

  it("leaves both TTL buckets unknown when no split is reported", () => {
    const usage = extractUsageFromResponse(
      responseWithUsage({
        ...anthropicCachedUsage,
        cache_creation_input_tokens: 2000,
      }),
      ANTHROPIC_MODEL,
    );

    expect(usage.cacheCreation5mTokens).toBeUndefined();
    expect(usage.cacheCreation1hTokens).toBeUndefined();
  });

  it("passes reported reasoning tokens through and leaves unreported ones unknown", () => {
    const withReasoning = extractUsageFromResponse(
      responseWithUsage({
        ...anthropicCachedUsage,
        completion_tokens_details: { reasoning_tokens: 512 },
      }),
      ANTHROPIC_MODEL,
    );
    const withoutReasoning = extractUsageFromResponse(
      responseWithUsage(anthropicCachedUsage),
      ANTHROPIC_MODEL,
    );

    expect(withReasoning.reasoningTokens).toBe(512);
    expect(withoutReasoning.reasoningTokens).toBeUndefined();
  });
});

describe("StreamingResponseParser cache normalization", () => {
  let StreamingResponseParser: typeof import("../../../src/litellm/sse-parser").StreamingResponseParser;
  let trackUsageAsync: typeof import("../../../src/litellm/tracking").trackUsageAsync;

  const requestContext: RequestContext = {
    url: "http://localhost:4000/v1/chat/completions",
    method: "POST",
    headers: {},
    body: null,
    startTime: 0,
    metadata: {},
  };

  function streamFromUsageChunks(usageChunks: TokenUsage[]): ReadableStream<Uint8Array> {
    const payload = [
      'data: {"id":"chatcmpl-cache","choices":[{"delta":{"content":"ok"}}]}',
      ...usageChunks.map(
        (usage, index) =>
          `data: {"choices":[{"finish_reason":${
            index === usageChunks.length - 1 ? '"stop"' : "null"
          }}],"usage":${JSON.stringify(usage)}}`,
      ),
      "data: [DONE]",
      "",
    ].join("\n");

    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
  }

  async function trackedUsage(usageChunks: TokenUsage[], model = ANTHROPIC_MODEL) {
    const parser = new StreamingResponseParser("req-stream-cache", model, requestContext, 125);
    await parser.parseStream(streamFromUsageChunks(usageChunks));
    return jest.mocked(trackUsageAsync).mock.calls[0][0];
  }

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock("../../../src/litellm/tracking", () => ({ trackUsageAsync: jest.fn() }));

    StreamingResponseParser = (await import("../../../src/litellm/sse-parser"))
      .StreamingResponseParser;
    trackUsageAsync = (await import("../../../src/litellm/tracking")).trackUsageAsync;
  });

  afterEach(() => {
    jest.dontMock("../../../src/litellm/tracking");
    jest.restoreAllMocks();
  });

  it("removes cache reads and writes folded into prompt tokens", async () => {
    const tracked = await trackedUsage([
      {
        ...anthropicCachedUsage,
        prompt_tokens: 5012,
        cache_creation_input_tokens: 2000,
      },
    ]);

    expect(tracked.promptTokens).toBe(12);
    expect(tracked.totalTokens).toBe(17);
    expect(tracked.cachedTokens).toBe(3000);
    expect(tracked.cacheCreationTokens).toBe(2000);
  });

  it("removes the folded cache tokens when a later usage chunk omits the cache fields", async () => {
    const tracked = await trackedUsage([
      {
        prompt_tokens: 5012,
        completion_tokens: 0,
        total_tokens: 5012,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 2000,
      },
      { prompt_tokens: 5012, completion_tokens: 40, total_tokens: 5052 },
    ]);

    expect(tracked.promptTokens).toBe(12);
    expect(tracked.completionTokens).toBe(40);
    expect(tracked.totalTokens).toBe(52);
    expect(tracked.cachedTokens).toBe(3000);
    expect(tracked.cacheCreationTokens).toBe(2000);
  });

  it("keeps the prompt tokens of a provider that does not fold its cache reads", async () => {
    const tracked = await trackedUsage(
      [
        {
          prompt_tokens: 3012,
          completion_tokens: 5,
          total_tokens: 3017,
          cache_read_input_tokens: 3000,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
      ],
      GEMINI_MODEL,
    );

    expect(tracked.promptTokens).toBe(3012);
    expect(tracked.totalTokens).toBe(3017);
    expect(tracked.cachedTokens).toBe(3000);
  });

  it("removes the folded cache reads of a Claude stream reported in the OpenAI shape", async () => {
    const tracked = await trackedUsage([
      {
        prompt_tokens: 3012,
        completion_tokens: 5,
        total_tokens: 3017,
        prompt_tokens_details: { cached_tokens: 3000 },
      },
    ]);

    expect(tracked.promptTokens).toBe(12);
    expect(tracked.totalTokens).toBe(17);
  });

  it("keeps the TTL split and cache reads a later chunk omits or zeroes", async () => {
    const tracked = await trackedUsage([
      {
        prompt_tokens: 5012,
        completion_tokens: 0,
        total_tokens: 5012,
        cache_creation_input_tokens: 2000,
        prompt_tokens_details: {
          cached_tokens: 3000,
          cache_creation_token_details: { ephemeral_1h_input_tokens: 2000 },
        },
        completion_tokens_details: { reasoning_tokens: 512 },
      },
      {
        prompt_tokens: 5012,
        completion_tokens: 40,
        total_tokens: 5052,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: {},
      },
    ]);

    expect(tracked.promptTokens).toBe(12);
    expect(tracked.cachedTokens).toBe(3000);
    expect(tracked.cacheCreation1hTokens).toBe(2000);
    expect(tracked.reasoningTokens).toBe(512);
  });

  it("leaves a cache-free Anthropic-shaped call unchanged", async () => {
    const tracked = await trackedUsage([
      {
        prompt_tokens: 120,
        completion_tokens: 5,
        total_tokens: 125,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ]);

    expect(tracked.promptTokens).toBe(120);
    expect(tracked.totalTokens).toBe(125);
  });

  it("forwards the TTL split and reasoning tokens", async () => {
    const tracked = await trackedUsage([
      {
        ...anthropicCachedUsage,
        prompt_tokens: 5012,
        cache_creation_input_tokens: 2000,
        prompt_tokens_details: {
          cached_tokens: 3000,
          cache_creation_token_details: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 2000,
          },
        },
        completion_tokens_details: { reasoning_tokens: 512 },
      },
    ]);

    expect(tracked.cacheCreation5mTokens).toBe(0);
    expect(tracked.cacheCreation1hTokens).toBe(2000);
    expect(tracked.reasoningTokens).toBe(512);
  });

  it("leaves the TTL split and reasoning unknown when not reported", async () => {
    const tracked = await trackedUsage([anthropicCachedUsage]);

    expect(tracked.cacheCreation5mTokens).toBeUndefined();
    expect(tracked.cacheCreation1hTokens).toBeUndefined();
    expect(tracked.reasoningTokens).toBeUndefined();
  });
});

describe("LiteLLM non-streaming responses", () => {
  let trackUsageAsync: typeof import("../../../src/litellm/tracking").trackUsageAsync;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock("../../../src/litellm/tracking", () => ({
      ...jest.requireActual("../../../src/litellm/tracking"),
      trackUsageAsync: jest.fn(),
    }));

    const httpClient = await import("../../../src/litellm/http-client");
    trackUsageAsync = (await import("../../../src/litellm/tracking")).trackUsageAsync;

    httpClient.setLiteLLMConfig(createLiteLLMConfig());
    global.fetch = createMockFetch({
      headers: { "content-type": "application/json" },
      jsonBody: {
        id: "chatcmpl-http",
        object: "chat.completion",
        created: 1,
        model: ANTHROPIC_MODEL,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 5012,
          completion_tokens: 40,
          total_tokens: 5052,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 2000,
          prompt_tokens_details: {
            cached_tokens: 3000,
            cache_creation_token_details: { ephemeral_1h_input_tokens: 2000 },
          },
          completion_tokens_details: { reasoning_tokens: 512 },
        },
      },
    }) as unknown as typeof fetch;
    httpClient.patchHttpClient();
  });

  afterEach(async () => {
    const httpClient = await import("../../../src/litellm/http-client");
    httpClient.resetHttpClientManager();
    global.fetch = originalFetch;
    jest.dontMock("../../../src/litellm/tracking");
    jest.restoreAllMocks();
  });

  it("meters the cache and reasoning counts of a proxied completion", async () => {
    await fetch("http://localhost:4000/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: ANTHROPIC_MODEL, messages: [{ role: "user", content: "hi" }] }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 12,
        completionTokens: 40,
        totalTokens: 52,
        cachedTokens: 3000,
        cacheCreationTokens: 2000,
        cacheCreation1hTokens: 2000,
        reasoningTokens: 512,
      }),
    );
  });
});

describe("LiteLLM metering payload for cached Anthropic calls", () => {
  let sendReveniumMetrics: typeof import("../../../src/litellm/tracking").sendReveniumMetrics;
  let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
  let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

  beforeEach(async () => {
    jest.resetModules();
    process.env.AWS_REGION = "us-east-1";

    const manager = await import("../../../src/_core/config/manager");
    const tracking = await import("../../../src/litellm/tracking");
    const httpClient = await import("../../../src/litellm/http-client");

    sendReveniumMetrics = tracking.sendReveniumMetrics;
    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;

    setConfig(createReveniumConfig());
    httpClient.setLiteLLMConfig(createLiteLLMConfig());
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.AWS_REGION;
    resetConfig();
    jest.restoreAllMocks();
  });

  it("meters the de-duplicated input and the 1 hour cache write", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      requestId: "req-cache-001",
      model: ANTHROPIC_MODEL,
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      cachedTokens: 3000,
      cacheCreationTokens: 2000,
      cacheCreation1hTokens: 2000,
      duration: 1500,
      finishReason: "stop",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("inputTokenCount", 12);
    expect(body).toHaveProperty("cacheReadTokenCount", 3000);
    expect(body).toHaveProperty("cacheCreation1hTokenCount", 2000);
    expect(body).not.toHaveProperty("reasoningTokenCount");
  });

  it("meters a reported reasoning count", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      requestId: "req-cache-002",
      model: ANTHROPIC_MODEL,
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      reasoningTokens: 512,
      duration: 1500,
      finishReason: "stop",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("reasoningTokenCount", 512);
  });
});

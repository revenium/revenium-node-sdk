import type { RequestContext } from "../../../src/litellm/types";

jest.mock("../../../src/litellm/tracking", () => ({
  trackUsageAsync: jest.fn(),
}));

let StreamingResponseParser: typeof import("../../../src/litellm/sse-parser").StreamingResponseParser;
let trackUsageAsync: typeof import("../../../src/litellm/tracking").trackUsageAsync;

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("StreamingResponseParser cache token metering", () => {
  beforeEach(async () => {
    jest.resetModules();

    const parserModule = await import("../../../src/litellm/sse-parser");
    const tracking = await import("../../../src/litellm/tracking");

    StreamingResponseParser = parserModule.StreamingResponseParser;
    trackUsageAsync = tracking.trackUsageAsync;

    jest.mocked(trackUsageAsync).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("preserves OpenAI-compatible cached prompt tokens from usage chunks", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-001",
      "openai/gpt-4o-mini",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"id":"chatcmpl-001","choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":44}}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-001",
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedTokens: 44,
        isStreamed: true,
      }),
    );
  });

  it("does not erase cached prompt tokens when a later usage chunk omits details", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-002",
      "openai/gpt-4o-mini",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":44}}}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-002",
        cachedTokens: 44,
      }),
    );
  });

  it("captures Anthropic-native cache fields when LiteLLM surfaces them unnormalized in a streamed chunk", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-003",
      "anthropic/claude-sonnet-4-5",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"cache_read_input_tokens":21808,"cache_creation_input_tokens":7880}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-003",
        cachedTokens: 21808,
        cacheCreationTokens: 7880,
      }),
    );
  });

  it("does not erase cache creation tokens when a later usage chunk omits them", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-004",
      "anthropic/claude-sonnet-4-5",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-004",
        cachedTokens: 100,
        cacheCreationTokens: 50,
      }),
    );
  });

  it("leaves cache fields undefined when no chunk reports them", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-005",
      "openai/gpt-4o-mini",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    const call = jest
      .mocked(trackUsageAsync)
      .mock.calls.find(([arg]) => arg.requestId === "req-stream-005");
    expect(call).toBeDefined();
    expect(call![0].cachedTokens).toBeUndefined();
    expect(call![0].cacheCreationTokens).toBeUndefined();
  });
});

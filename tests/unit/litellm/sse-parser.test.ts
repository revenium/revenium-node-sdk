import { createReveniumConfig, createLiteLLMConfig, createMockFetch } from "../../helpers/fixtures";
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
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":29698,"completion_tokens":20,"total_tokens":29718,"cache_read_input_tokens":21808,"cache_creation_input_tokens":7880}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-003",
        promptTokens: 10,
        totalTokens: 30,
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
        'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":160,"completion_tokens":10,"total_tokens":170,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":160,"completion_tokens":20,"total_tokens":180}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-004",
        promptTokens: 10,
        totalTokens: 30,
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

  it("falls back to the Groq usage when the reported usage carries no totals", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-006",
      "groq/llama-3.3-70b",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}',
        'data: {"choices":[{"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":40,"completion_tokens":12,"total_tokens":52}}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-006",
        promptTokens: 40,
        completionTokens: 12,
        totalTokens: 52,
      }),
    );
  });

  it("meters a Claude stream served behind a proxy alias", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser("req-stream-007", "production", requestContext, 125);

    const stream = streamFromText(
      [
        'data: {"model":"anthropic/claude-sonnet-4","choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3012,"completion_tokens":5,"total_tokens":3017,"cache_read_input_tokens":3000}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await parser.parseStream(stream);

    expect(trackUsageAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-stream-007",
        promptTokens: 12,
        totalTokens: 17,
      }),
    );
  });
});

describe("StreamingResponseParser job attribution", () => {
  let sendReveniumMetrics: typeof import("../../../src/litellm/tracking").sendReveniumMetrics;
  let runWithJobContext: typeof import("../../../src/_core/jobs/job-context").runWithJobContext;
  let mockFetch: jest.Mock;
  const originalFetch = global.fetch;
  const meteringSends: Promise<void>[] = [];

  beforeEach(async () => {
    jest.resetModules();
    process.env.AWS_REGION = "us-east-1";

    const parserModule = await import("../../../src/litellm/sse-parser");
    const tracking = await import("../../../src/litellm/tracking");
    const manager = await import("../../../src/_core/config/manager");
    const httpClient = await import("../../../src/litellm/http-client");
    const jobContext = await import("../../../src/_core/jobs/job-context");

    StreamingResponseParser = parserModule.StreamingResponseParser;
    trackUsageAsync = tracking.trackUsageAsync;
    runWithJobContext = jobContext.runWithJobContext;
    sendReveniumMetrics = jest.requireActual<typeof import("../../../src/litellm/tracking")>(
      "../../../src/litellm/tracking",
    ).sendReveniumMetrics;

    manager.setConfig(createReveniumConfig());
    httpClient.setLiteLLMConfig(createLiteLLMConfig());

    mockFetch = createMockFetch();
    global.fetch = mockFetch;

    jest.mocked(trackUsageAsync).mockImplementation((data) => {
      meteringSends.push(sendReveniumMetrics(data));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.AWS_REGION;
    meteringSends.length = 0;
    jest.restoreAllMocks();
  });

  it("tags a streamed LiteLLM call inside a job context", async () => {
    const requestContext: RequestContext = {
      url: "http://localhost:4000/v1/chat/completions",
      method: "POST",
      headers: {},
      body: null,
      startTime: Date.now(),
      metadata: {},
    };
    const parser = new StreamingResponseParser(
      "req-stream-job-001",
      "openai/gpt-4o-mini",
      requestContext,
      125,
    );

    const stream = streamFromText(
      [
        'data: {"id":"chatcmpl-job","choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    await runWithJobContext({ agenticJobId: "job-stream-1" }, () => parser.parseStream(stream));
    await Promise.all(meteringSends);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      transactionId: "req-stream-job-001",
      agenticJobId: "job-stream-1",
    });
  });
});

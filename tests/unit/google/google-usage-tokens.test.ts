import { createReveniumConfig } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let mockStreamChunks: unknown[] = [];

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: async function* () {
            for (const chunk of mockStreamChunks) {
              yield chunk;
            }
          },
        }),
    },
  })),
}));

jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({})),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let trackGoogleUsageAsync: typeof import("../../../src/google/utils").trackGoogleUsageAsync;
let GoogleGenAIService: typeof import("../../../src/google/genai/service").GoogleGenAIService;
let VertexAIService: typeof import("../../../src/google/vertex/service").VertexAIService;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function meter(
  usageMetadata: Record<string, number>,
  modelSource: "GOOGLE" | "GOOGLE_VERTEX_AI" = "GOOGLE",
): Promise<void> {
  await trackGoogleUsageAsync({
    transactionId: "txn-001",
    model: "gemini-2.5-pro",
    startTime: new Date(1000),
    endTime: new Date(3000),
    response: { usageMetadata },
    operationType: "CHAT",
    isStreaming: false,
    modelSource,
  });
}

async function meterEmbedding(
  response: unknown,
  resolveInputTokens?: () => Promise<number | null>,
): Promise<void> {
  await trackGoogleUsageAsync({
    transactionId: "txn-002",
    model: "text-embedding-004",
    startTime: new Date(1000),
    endTime: new Date(3000),
    response,
    operationType: "EMBED",
    isStreaming: false,
    modelSource: "GOOGLE",
    resolveInputTokens,
  });
}

describe("trackGoogleUsageAsync token metering", () => {
  beforeEach(async () => {
    jest.resetModules();
    mockStreamChunks = [];

    const manager = await import("../../../src/_core/config/manager");
    const apiClient = await import("../../../src/_core/metering/api-client");
    const utils = await import("../../../src/google/utils");
    const service = await import("../../../src/google/genai/service");
    const vertex = await import("../../../src/google/vertex/service");

    VertexAIService = vertex.VertexAIService;
    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;
    sendToRevenium = apiClient.sendToRevenium;
    trackGoogleUsageAsync = utils.trackGoogleUsageAsync;
    GoogleGenAIService = service.GoogleGenAIService;

    setConfig(createReveniumConfig());
    jest.mocked(sendToRevenium).mockClear();
  });

  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  it("meters Gemini thinking tokens inside the output count", async () => {
    await meter({
      promptTokenCount: 13,
      candidatesTokenCount: 512,
      thoughtsTokenCount: 731,
      totalTokenCount: 1256,
    });

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokenCount: 13,
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
        totalTokenCount: 1256,
      }),
    );
  });

  it("leaves a call with no thinking tokens priced as before", async () => {
    await meter({
      promptTokenCount: 10,
      candidatesTokenCount: 40,
      totalTokenCount: 50,
    });

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTokenCount: 40,
        reasoningTokenCount: undefined,
      }),
    );
  });

  it("prices an explicitly zero thinking count as candidates only", async () => {
    await meter({
      promptTokenCount: 10,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 0,
      totalTokenCount: 50,
    });

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTokenCount: 40,
        reasoningTokenCount: 0,
      }),
    );
  });

  it("meters Vertex thinking tokens the same way", async () => {
    await meter(
      {
        promptTokenCount: 13,
        candidatesTokenCount: 512,
        thoughtsTokenCount: 731,
        totalTokenCount: 1256,
      },
      "GOOGLE_VERTEX_AI",
    );

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSource: "GOOGLE_VERTEX_AI",
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
      }),
    );
  });

  it("meters zero when the response carries no usage", async () => {
    await meter({});

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokenCount: 0,
        outputTokenCount: 0,
        totalTokenCount: 0,
      }),
    );
  });

  it("keeps the streamed thinking count when the final chunk omits it", async () => {
    mockStreamChunks = [
      {
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 731,
          totalTokenCount: 944,
        },
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 512,
          totalTokenCount: 1256,
        },
      },
    ];

    const streaming = await new GoogleGenAIService("gemini-2.5-pro").createStreaming(["hi"]);
    for await (const _chunk of streaming.stream) {
      void _chunk;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
        totalTokenCount: 1256,
        isStreamed: true,
      }),
    );
  });

  it("keeps every streamed count when the final chunk carries no usage", async () => {
    mockStreamChunks = [
      {
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 512,
          thoughtsTokenCount: 731,
          cachedContentTokenCount: 8,
          totalTokenCount: 1256,
        },
      },
      {
        candidates: [{ finishReason: "STOP" }],
      },
    ];

    const streaming = await new GoogleGenAIService("gemini-2.5-pro").createStreaming(["hi"]);
    for await (const _chunk of streaming.stream) {
      void _chunk;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokenCount: 13,
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
        cacheReadTokenCount: 8,
        totalTokenCount: 1256,
      }),
    );
  });

  it("keeps every streamed count when the final chunk zeroes all of them", async () => {
    mockStreamChunks = [
      {
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 512,
          thoughtsTokenCount: 731,
          cachedContentTokenCount: 8,
          totalTokenCount: 1256,
        },
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          cachedContentTokenCount: 0,
          totalTokenCount: 0,
        },
      },
    ];

    const streaming = await new GoogleGenAIService("gemini-2.5-pro").createStreaming(["hi"]);
    for await (const _chunk of streaming.stream) {
      void _chunk;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokenCount: 13,
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
        cacheReadTokenCount: 8,
        totalTokenCount: 1256,
      }),
    );
  });

  it("keeps the streamed thinking count when the final chunk reports it as zero", async () => {
    mockStreamChunks = [
      {
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 731,
          cachedContentTokenCount: 8,
          totalTokenCount: 944,
        },
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 512,
          thoughtsTokenCount: 0,
          cachedContentTokenCount: 0,
          totalTokenCount: 1256,
        },
      },
    ];

    const streaming = await new GoogleGenAIService("gemini-2.5-pro").createStreaming(["hi"]);
    for await (const _chunk of streaming.stream) {
      void _chunk;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
        cacheReadTokenCount: 8,
        totalTokenCount: 1256,
      }),
    );
  });

  it("keeps the streamed thinking count on the Vertex streaming path", async () => {
    mockStreamChunks = [
      {
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 731,
          totalTokenCount: 944,
        },
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 512,
          totalTokenCount: 1256,
        },
      },
    ];

    const streaming = await new VertexAIService("gemini-2.5-pro").createStreaming(["hi"]);
    for await (const _chunk of streaming.stream) {
      void _chunk;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSource: "GOOGLE_VERTEX_AI",
        outputTokenCount: 1243,
        reasoningTokenCount: 731,
        totalTokenCount: 1256,
        isStreamed: true,
      }),
    );
  });

  it("keeps a provider-reported embedding usage over the counted input", async () => {
    const resolveInputTokens = jest.fn().mockResolvedValue(5);

    await meterEmbedding({ usageMetadata: { promptTokenCount: 7, totalTokenCount: 9 } }, () =>
      resolveInputTokens(),
    );

    expect(resolveInputTokens).not.toHaveBeenCalled();
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokenCount: 7, totalTokenCount: 9 }),
    );
  });

  it("meters the counted input as the embedding total when the provider reports none", async () => {
    await meterEmbedding({}, async () => 5);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokenCount: 5, totalTokenCount: 5, outputTokenCount: 0 }),
    );
  });

  it("meters an embedding as unknown when no count can be resolved", async () => {
    await meterEmbedding({ usageMetadata: { promptTokenCount: 0 } }, async () => null);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokenCount: null, totalTokenCount: null }),
    );
  });

  it("keeps the per-embedding count Vertex reports over the counted input", async () => {
    const resolveInputTokens = jest.fn().mockResolvedValue(5);

    await meterEmbedding({ embeddings: [{ values: [0.1], statistics: { tokenCount: 11 } }] }, () =>
      resolveInputTokens(),
    );

    expect(resolveInputTokens).not.toHaveBeenCalled();
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokenCount: 11, totalTokenCount: 11 }),
    );
  });

  it("meters an embedding as unknown when no resolver is supplied", async () => {
    await meterEmbedding({});

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokenCount: null, totalTokenCount: null }),
    );
  });

  it("emits the per-call subscriber and environment on the metered payload", async () => {
    await trackGoogleUsageAsync({
      transactionId: "txn-003",
      model: "gemini-2.5-pro",
      startTime: new Date(1000),
      endTime: new Date(3000),
      response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } },
      operationType: "CHAT",
      isStreaming: false,
      modelSource: "GOOGLE",
      usageMetadata: {
        subscriber: { id: "sub-1", email: "a@example.com" },
        environment: "sweep",
      },
    });

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriber: expect.objectContaining({ id: "sub-1", email: "a@example.com" }),
        environment: "sweep",
      }),
    );
  });

  it("emits the per-call region, ticket, trace and skill fields on the metered payload", async () => {
    await trackGoogleUsageAsync({
      transactionId: "txn-004",
      model: "gemini-2.5-pro",
      startTime: new Date(1000),
      endTime: new Date(3000),
      response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } },
      operationType: "CHAT",
      isStreaming: false,
      modelSource: "GOOGLE",
      usageMetadata: {
        region: "us-east-1",
        ticketId: "FRONT-3361",
        traceType: "workflow",
        traceName: "nightly-sweep",
        parentTransactionId: "txn-parent",
        transactionName: "qualify-lead",
        skillName: "lead-qualification",
        skillSource: "projectSettings",
      },
    });

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-east-1",
        ticketId: "FRONT-3361",
        traceType: "workflow",
        traceName: "nightly-sweep",
        parentTransactionId: "txn-parent",
        transactionName: "qualify-lead",
        skillName: "lead-qualification",
        skillSource: "projectSettings",
      }),
    );
  });

  it("still meters the deprecated organizationId and productId aliases", async () => {
    await trackGoogleUsageAsync({
      transactionId: "txn-005",
      model: "gemini-2.5-pro",
      startTime: new Date(1000),
      endTime: new Date(3000),
      response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } },
      operationType: "CHAT",
      isStreaming: false,
      modelSource: "GOOGLE",
      usageMetadata: { organizationId: "org-legacy", productId: "prod-legacy" },
    });

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: "org-legacy",
        productName: "prod-legacy",
      }),
    );
  });

  it("skips the embedding count lookup when Revenium is not configured", async () => {
    const resolveInputTokens = jest.fn().mockResolvedValue(5);
    resetConfig();

    await meterEmbedding({}, () => resolveInputTokens());

    expect(resolveInputTokens).not.toHaveBeenCalled();
  });
});

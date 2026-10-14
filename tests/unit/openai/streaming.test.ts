import OpenAI from "openai";
import { createReveniumConfig } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let CompletionsInterface: typeof import("../../../src/openai/middleware").CompletionsInterface;
let Provider: typeof import("../../../src/openai/provider-detection").Provider;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("StreamingWrapper stop reason metering", () => {
  const usageChunk = {
    choices: [],
    usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
  };

  function contentChunk(): Record<string, unknown> {
    return { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
  }

  function finishChunk(finishReason: string, index = 0): Record<string, unknown> {
    return { choices: [{ index, delta: {}, finish_reason: finishReason }] };
  }

  function buildInterface(create: jest.Mock): InstanceType<typeof CompletionsInterface> {
    return new CompletionsInterface(
      { chat: { completions: { create } } } as unknown as OpenAI,
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );
  }

  function streamOf(chunks: Array<Record<string, unknown>>): jest.Mock {
    return jest.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    });
  }

  async function meterStream(chunks: Array<Record<string, unknown>>): Promise<void> {
    const stream = await buildInterface(streamOf(chunks)).createStreaming({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
    }
    await flushPromises();
  }

  beforeEach(async () => {
    jest.resetModules();

    const manager = await import("../../../src/_core/config/manager");
    const apiClient = await import("../../../src/_core/metering/api-client");
    const middleware = await import("../../../src/openai/middleware");
    const providerDetection = await import("../../../src/openai/provider-detection");

    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;
    sendToRevenium = apiClient.sendToRevenium;
    CompletionsInterface = middleware.CompletionsInterface;
    Provider = providerDetection.Provider;

    setConfig(createReveniumConfig());
    jest.mocked(sendToRevenium).mockClear();
  });

  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  it("meters a streamed chat cut off at the token limit as TOKEN_LIMIT", async () => {
    await meterStream([contentChunk(), finishChunk("length"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "TOKEN_LIMIT", isStreamed: true }),
    );
  });

  it("meters a streamed content-filter stop as CONTENT_FILTER", async () => {
    await meterStream([contentChunk(), finishChunk("content_filter"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "CONTENT_FILTER", isStreamed: true }),
    );
  });

  it("meters a streamed content-filter stop reported in uppercase as CONTENT_FILTER", async () => {
    await meterStream([contentChunk(), finishChunk("CONTENT_FILTER"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "CONTENT_FILTER" }),
    );
  });

  it("meters a streamed normal stop as END", async () => {
    await meterStream([contentChunk(), finishChunk("stop"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "END" }));
  });

  it("meters a stream with no finish reason as END", async () => {
    await meterStream([contentChunk(), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "END" }));
  });

  it("ignores a finish reason reported only on a non-zero choice index and meters END", async () => {
    await meterStream([contentChunk(), finishChunk("length", 1), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "END" }));
  });

  it("meters a finish reason carried by a choice with no index", async () => {
    await meterStream([
      contentChunk(),
      { choices: [{ delta: {}, finish_reason: "length" }] },
      usageChunk,
    ]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "TOKEN_LIMIT" }),
    );
  });

  it("meters the reported finish reason when the caller stops on the finish chunk", async () => {
    const stream = await buildInterface(
      streamOf([contentChunk(), finishChunk("length"), usageChunk]),
    ).createStreaming({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    for await (const chunk of stream) {
      const [choice] = (chunk as OpenAI.ChatCompletionChunk).choices;
      if (choice?.finish_reason) break;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "TOKEN_LIMIT" }),
    );
  });

  it("meters a stream that throws mid-flight as ERROR", async () => {
    const create = jest.fn().mockImplementation(async function* () {
      yield contentChunk();
      yield finishChunk("length");
      throw new Error("stream broke");
    });

    const stream = await buildInterface(create).createStreaming({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    await expect(
      (async () => {
        for await (const chunk of stream) {
          expect(chunk).toBeDefined();
        }
      })(),
    ).rejects.toThrow("stream broke");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "ERROR" }));
  });

  it("meters an abandoned stream as CANCELLED", async () => {
    const stream = await buildInterface(
      streamOf([contentChunk(), finishChunk("length"), usageChunk]),
    ).createStreaming({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
      break;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "CANCELLED" }),
    );
  });
});

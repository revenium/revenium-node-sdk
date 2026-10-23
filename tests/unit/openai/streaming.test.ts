import OpenAI from "openai";
import type { ProviderInfo } from "../../../src/openai/provider-detection";
import { createReveniumConfig } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let CompletionsInterface: typeof import("../../../src/openai/middleware").CompletionsInterface;
let Provider: typeof import("../../../src/openai/provider-detection").Provider;

interface StreamOptions {
  model?: string;
  providerInfo?: ProviderInfo;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("StreamingWrapper metering", () => {
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

  function buildInterface(
    create: jest.Mock,
    providerInfo?: ProviderInfo,
  ): InstanceType<typeof CompletionsInterface> {
    return new CompletionsInterface(
      { chat: { completions: { create } } } as unknown as OpenAI,
      createReveniumConfig(),
      providerInfo ?? { provider: Provider.OPENAI, isAzure: false },
    );
  }

  function streamOf(chunks: Array<Record<string, unknown>>): jest.Mock {
    return jest.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    });
  }

  async function meterStream(
    chunks: Array<Record<string, unknown>>,
    options: StreamOptions = {},
  ): Promise<void> {
    const stream = await buildInterface(streamOf(chunks), options.providerInfo).createStreaming({
      model: options.model ?? "gpt-4.1-nano",
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

  describe("streamed model name", () => {
    const deploymentName = "acme-prod-chat";
    const providerModel = "gpt-4o-2024-08-06";

    const azure = (): ProviderInfo => ({ provider: Provider.AZURE_OPENAI, isAzure: true });

    const meterAzureStream = (chunks: Array<Record<string, unknown>>): Promise<void> =>
      meterStream(chunks, { model: deploymentName, providerInfo: azure() });

    it("meters the model the provider returned, not the Azure deployment name", async () => {
      await meterAzureStream([
        { ...contentChunk(), model: providerModel },
        { ...finishChunk("stop"), model: providerModel },
        { ...usageChunk, model: providerModel },
      ]);

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel, provider: "Azure", isStreamed: true }),
      );
    });

    it("records the same model for streamed and non-streamed chats on one deployment", async () => {
      const completion = jest.fn().mockResolvedValue({
        id: "chatcmpl-1",
        model: providerModel,
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      });

      await buildInterface(completion, azure()).create({
        model: deploymentName,
        messages: [{ role: "user", content: "hello" }],
      });
      await flushPromises();

      await meterAzureStream([
        { ...contentChunk(), model: providerModel },
        { ...finishChunk("stop"), model: providerModel },
        { ...usageChunk, model: providerModel },
      ]);

      const meteredModels = jest
        .mocked(sendToRevenium)
        .mock.calls.map(([payload]) => (payload as { model: string }).model);

      expect(meteredModels).toEqual([providerModel, providerModel]);
    });

    it("meters a plain OpenAI stream under the dated model the chunks report", async () => {
      await meterStream(
        [
          { ...contentChunk(), model: providerModel },
          { ...finishChunk("stop"), model: providerModel },
          { ...usageChunk, model: providerModel },
        ],
        { model: "gpt-4o" },
      );

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel }),
      );
    });

    it("keeps the first model when a later chunk reports a different one", async () => {
      await meterAzureStream([
        { ...contentChunk(), model: providerModel },
        { ...finishChunk("stop"), model: "gpt-4o-mini-2024-07-18" },
        { ...usageChunk, model: "gpt-4o-mini-2024-07-18" },
      ]);

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel }),
      );
    });

    it("skips the leading Azure content-filter chunk and meters the first real model", async () => {
      await meterAzureStream([
        { id: "", model: "", choices: [], prompt_filter_results: [{ prompt_index: 0 }] },
        { ...contentChunk(), model: providerModel },
        { ...finishChunk("stop"), model: providerModel },
        { ...usageChunk, model: providerModel },
      ]);

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel }),
      );
    });

    it("uses the provider model when the caller abandons the stream", async () => {
      const stream = await buildInterface(
        streamOf([
          { ...contentChunk(), model: providerModel },
          { ...finishChunk("stop"), model: providerModel },
          { ...usageChunk, model: providerModel },
        ]),
        azure(),
      ).createStreaming({
        model: deploymentName,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });

      for await (const chunk of stream) {
        expect(chunk).toBeDefined();
        break;
      }
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel, stopReason: "CANCELLED" }),
      );
    });

    it("ignores an empty model on a later chunk", async () => {
      await meterAzureStream([
        { ...contentChunk(), model: providerModel },
        { ...finishChunk("stop"), model: "" },
        { ...usageChunk, model: "" },
      ]);

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel }),
      );
    });

    it("uses the provider model on the error path", async () => {
      const create = jest.fn().mockImplementation(async function* () {
        yield { ...contentChunk(), model: providerModel };
        throw new Error("stream broke");
      });

      const stream = await buildInterface(create, azure()).createStreaming({
        model: deploymentName,
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

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ model: providerModel, stopReason: "ERROR" }),
      );
    });
  });
});

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
    await meterStreamFrom(streamOf(chunks), options);
  }

  function openStream(create: jest.Mock, options: StreamOptions = {}) {
    return buildInterface(create, options.providerInfo).createStreaming({
      model: options.model ?? "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
  }

  async function meterStreamFrom(create: jest.Mock, options: StreamOptions = {}): Promise<void> {
    const stream = await openStream(create, options);

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
      expect.anything(),
    );
  });

  it("meters a streamed content-filter stop as CONTENT_FILTER", async () => {
    await meterStream([contentChunk(), finishChunk("content_filter"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "CONTENT_FILTER", isStreamed: true }),
      expect.anything(),
    );
  });

  it("meters a streamed content-filter stop reported in uppercase as CONTENT_FILTER", async () => {
    await meterStream([contentChunk(), finishChunk("CONTENT_FILTER"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "CONTENT_FILTER" }),
      expect.anything(),
    );
  });

  it("meters a streamed normal stop as END", async () => {
    await meterStream([contentChunk(), finishChunk("stop"), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "END" }),
      expect.anything(),
    );
  });

  it("meters a stream with no finish reason as END", async () => {
    await meterStream([contentChunk(), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "END" }),
      expect.anything(),
    );
  });

  it("ignores a finish reason reported only on a non-zero choice index and meters END", async () => {
    await meterStream([contentChunk(), finishChunk("length", 1), usageChunk]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "END" }),
      expect.anything(),
    );
  });

  it("meters a finish reason carried by a choice with no index", async () => {
    await meterStream([
      contentChunk(),
      { choices: [{ delta: {}, finish_reason: "length" }] },
      usageChunk,
    ]);

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "TOKEN_LIMIT" }),
      expect.anything(),
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
      expect.anything(),
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

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "ERROR" }),
      expect.anything(),
    );
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
      expect.anything(),
    );
  });

  describe("caller-visible stream", () => {
    const meteredUsage = { inputTokenCount: 15, outputTokenCount: 5, totalTokenCount: 20 };

    async function receiveStream(
      create: jest.Mock,
      streamOptions?: OpenAI.ChatCompletionStreamOptions,
    ): Promise<OpenAI.ChatCompletionChunk[]> {
      const stream = await buildInterface(create).createStreaming({
        model: "gpt-4.1-nano",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: streamOptions,
      });

      const received: OpenAI.ChatCompletionChunk[] = [];
      for await (const chunk of stream) {
        received.push(chunk);
      }
      await flushPromises();
      return received;
    }

    it("hides the injected usage chunk from a caller who did not request usage", async () => {
      const received = await receiveStream(
        streamOf([contentChunk(), finishChunk("stop"), usageChunk]),
      );

      let out = "";
      for (const chunk of received) {
        out += chunk.choices[0].delta.content ?? "";
      }

      expect(received).toEqual([contentChunk(), finishChunk("stop")]);
      expect(out).toBe("hi");
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ ...meteredUsage, stopReason: "END" }),
        expect.anything(),
      );
    });

    it("forwards the usage chunk to a caller who requested include_usage alongside other options", async () => {
      const create = streamOf([contentChunk(), finishChunk("stop"), usageChunk]);

      const received = await receiveStream(create, {
        include_usage: true,
        include_obfuscation: false,
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          stream_options: { include_usage: true, include_obfuscation: false },
        }),
      );
      expect(received).toHaveLength(3);
      expect(received[2]).toEqual(usageChunk);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ ...meteredUsage, stopReason: "END" }),
        expect.anything(),
      );
    });

    it("hides the usage chunk from a caller who explicitly disabled include_usage", async () => {
      const create = streamOf([contentChunk(), finishChunk("stop"), usageChunk]);

      const received = await receiveStream(create, { include_usage: false });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ stream_options: { include_usage: true } }),
      );
      expect(received).toEqual([contentChunk(), finishChunk("stop")]);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ ...meteredUsage, stopReason: "END" }),
        expect.anything(),
      );
    });

    it("forwards the Azure content-filter chunk that carries no choices and no usage", async () => {
      const promptFilterChunk = {
        id: "",
        model: "",
        choices: [],
        prompt_filter_results: [{ prompt_index: 0 }],
      };

      const received = await receiveStream(
        streamOf([promptFilterChunk, contentChunk(), finishChunk("stop"), usageChunk]),
      );

      expect(received).toEqual([promptFilterChunk, contentChunk(), finishChunk("stop")]);
    });

    it("keeps the caller's other stream options", async () => {
      const create = streamOf([contentChunk(), finishChunk("stop"), usageChunk]);

      const received = await receiveStream(create, { include_obfuscation: false });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          stream_options: { include_obfuscation: false, include_usage: true },
        }),
      );
      expect(received).toEqual([contentChunk(), finishChunk("stop")]);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ ...meteredUsage, stopReason: "END" }),
        expect.anything(),
      );
    });
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
        expect.anything(),
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
        expect.anything(),
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
        expect.anything(),
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
        expect.anything(),
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
        expect.anything(),
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
        expect.anything(),
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
        expect.anything(),
      );
    });
  });

  describe("streamed timing", () => {
    const headersWaitMs = 500;
    const firstTokenWaitMs = 20;
    let clock: number;

    beforeEach(() => {
      clock = 1_000;
      jest.spyOn(Date, "now").mockImplementation(() => clock);
    });

    function providerAnsweringAfterHeadersWait(
      body: () => AsyncGenerator<Record<string, unknown>>,
    ): jest.Mock {
      return jest.fn().mockImplementation(async () => {
        clock += headersWaitMs;
        return body();
      });
    }

    it.each([
      { name: "OpenAI", isAzure: false },
      { name: "Azure", isAzure: true },
    ])("measures a streamed $name chat from the provider call", async ({ name, isAzure }) => {
      const create = providerAnsweringAfterHeadersWait(async function* () {
        clock += firstTokenWaitMs;
        yield contentChunk();
        yield finishChunk("stop");
        yield usageChunk;
      });
      const providerInfo: ProviderInfo = {
        provider: isAzure ? Provider.AZURE_OPENAI : Provider.OPENAI,
        isAzure,
      };

      await meterStreamFrom(create, { providerInfo });

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({
          requestDuration: headersWaitMs + firstTokenWaitMs,
          timeToFirstToken: headersWaitMs + firstTokenWaitMs,
          provider: name,
          isStreamed: true,
        }),
        expect.anything(),
      );
    });

    it("measures a stream that throws mid-flight from the provider call", async () => {
      const create = providerAnsweringAfterHeadersWait(async function* () {
        yield contentChunk();
        throw new Error("stream broke");
      });

      await expect(meterStreamFrom(create)).rejects.toThrow("stream broke");
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: "ERROR", requestDuration: headersWaitMs }),
        expect.anything(),
      );
    });

    it("measures an abandoned stream from the provider call", async () => {
      const stream = await openStream(
        providerAnsweringAfterHeadersWait(async function* () {
          clock += firstTokenWaitMs;
          yield contentChunk();
          yield contentChunk();
        }),
      );

      for await (const chunk of stream) {
        expect(chunk).toBeDefined();
        break;
      }
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({
          stopReason: "CANCELLED",
          requestDuration: headersWaitMs + firstTokenWaitMs,
          timeToFirstToken: headersWaitMs + firstTokenWaitMs,
        }),
        expect.anything(),
      );
    });
  });
});

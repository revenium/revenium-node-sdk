import { createReveniumConfig } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let ResponsesInterface: typeof import("../../../src/openai/middleware").ResponsesInterface;
let Provider: typeof import("../../../src/openai/provider-detection").Provider;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ResponsesInterface cache token metering", () => {
  beforeEach(async () => {
    jest.resetModules();

    const manager = await import("../../../src/_core/config/manager");
    const apiClient = await import("../../../src/_core/metering/api-client");
    const middleware = await import("../../../src/openai/middleware");
    const providerDetection = await import("../../../src/openai/provider-detection");

    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;
    sendToRevenium = apiClient.sendToRevenium;
    ResponsesInterface = middleware.ResponsesInterface;
    Provider = providerDetection.Provider;

    setConfig(createReveniumConfig());
    jest.mocked(sendToRevenium).mockClear();
  });

  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  it("reads non-streaming cache reads from input token details", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp-001",
      model: "gpt-4o-mini",
      status: "completed",
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 55 },
      },
    });
    const responses = new ResponsesInterface(
      { responses: { create } } as any,
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );

    await responses.create({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp-001",
        inputTokenCount: 120,
        outputTokenCount: 30,
        totalTokenCount: 150,
        cacheReadTokenCount: 55,
      }),
    );
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheCreationTokenCount: undefined,
      }),
    );
  });

  it("uses the legacy top-level cache token fallback for streaming responses", async () => {
    async function* stream() {
      yield {
        type: "response.completed",
        response: {
          id: "resp-stream-001",
          model: "gpt-4o-mini",
          status: "completed",
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
            cached_tokens: 55,
          },
        },
      };
    }

    const create = jest.fn().mockResolvedValue(stream());
    const responses = new ResponsesInterface(
      { responses: { create } } as any,
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );

    const responseStream = await responses.createStreaming({
      model: "gpt-4o-mini",
      input: "hello",
    });

    for await (const _chunk of responseStream as AsyncIterable<unknown>) {
      // Drain the stream so the final usage event is metered.
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp-stream-001",
        cacheReadTokenCount: 55,
      }),
    );
  });
});

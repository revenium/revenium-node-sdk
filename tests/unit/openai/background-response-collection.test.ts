import { createReveniumConfig } from "../../helpers/fixtures";

const mockProviderResponses = {
  create: jest.fn(),
  retrieve: jest.fn(),
};

jest.mock("openai", () => {
  class MockOpenAI {
    responses = mockProviderResponses;
  }

  return { __esModule: true, default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let ReveniumOpenAI: typeof import("../../../src/openai/client").ReveniumOpenAI;
let Provider: typeof import("../../../src/openai/provider-detection").Provider;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("background Responses collection through the wrapper client", () => {
  let client: InstanceType<typeof ReveniumOpenAI>;

  beforeEach(async () => {
    jest.resetModules();

    const manager = await import("../../../src/_core/config/manager");
    const apiClient = await import("../../../src/_core/metering/api-client");
    const clientModule = await import("../../../src/openai/client");
    const providerDetection = await import("../../../src/openai/provider-detection");

    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;
    sendToRevenium = apiClient.sendToRevenium;
    ReveniumOpenAI = clientModule.ReveniumOpenAI;
    Provider = providerDetection.Provider;

    setConfig(createReveniumConfig());
    jest.mocked(sendToRevenium).mockClear();
    mockProviderResponses.create.mockReset();
    mockProviderResponses.retrieve.mockReset();

    client = new ReveniumOpenAI(createReveniumConfig(), Provider.OPENAI);
  });

  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  function queuedJob(): Record<string, unknown> {
    return { id: "resp_stub", model: "o4-mini", status: "queued" };
  }

  function completedJob(): Record<string, unknown> {
    return {
      id: "resp_stub",
      model: "o4-mini",
      status: "completed",
      usage: {
        input_tokens: 333,
        output_tokens: 44,
        total_tokens: 377,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
    };
  }

  it("meters a background job collected through the client exactly once", async () => {
    mockProviderResponses.create.mockResolvedValue(queuedJob());
    mockProviderResponses.retrieve.mockResolvedValue(completedJob());

    await client.responses().create({ model: "o4-mini", input: "hello", background: true });
    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp_stub",
        inputTokenCount: 333,
        outputTokenCount: 44,
      }),
    );
  });

  it("carries reasoning and cached tokens of the collected job", async () => {
    mockProviderResponses.retrieve.mockResolvedValue(completedJob());

    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningTokenCount: 20, cacheReadTokenCount: 100 }),
    );
  });

  it("does not meter a second collection made through the client", async () => {
    mockProviderResponses.retrieve.mockResolvedValue(completedJob());

    await client.responses().retrieve("resp_stub");
    await flushPromises();
    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
  });

  it("keeps the job of the creation scope when the collection runs outside it", async () => {
    const { runWithJobContext } = await import("../../../src/_core/jobs/job-context");
    mockProviderResponses.create.mockResolvedValue(queuedJob());
    mockProviderResponses.retrieve.mockResolvedValue(completedJob());

    await runWithJobContext({ agenticJobId: "job_1" }, async () => {
      await client.responses().create({ model: "o4-mini", input: "hello", background: true });
    });
    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ agenticJobId: "job_1" }));
  });

  it("reuses the captured input of the creation call at collection", async () => {
    mockProviderResponses.create.mockResolvedValue(queuedJob());
    mockProviderResponses.retrieve.mockResolvedValue({
      ...completedJob(),
      output_text: "the answer",
    });

    await client
      .responses()
      .create({ model: "o4-mini", input: "hello", background: true }, { capturePrompts: true });
    await client.responses().retrieve("resp_stub", { capturePrompts: true });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMessages: expect.stringContaining("hello"),
        outputResponse: expect.stringContaining("the answer"),
      }),
    );
  });

  it("timestamps the record at the job start instead of the collection time", async () => {
    const createdAt = Math.floor(Date.parse("2026-10-14T10:00:00.000Z") / 1000);
    mockProviderResponses.retrieve.mockResolvedValue({
      ...completedJob(),
      created_at: createdAt,
      completed_at: createdAt + 30,
    });

    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        requestTime: "2026-10-14T10:00:00.000Z",
        requestDuration: 30000,
      }),
    );
  });

  it("does not meter a collection of a response already metered as a stream", async () => {
    mockProviderResponses.create.mockResolvedValue(
      (async function* () {
        yield { type: "response.completed", response: completedJob() };
      })(),
    );
    mockProviderResponses.retrieve.mockResolvedValue(completedJob());

    const stream = await client
      .responses()
      .create({ model: "o4-mini", input: "hello", stream: true });
    for await (const _chunk of stream as AsyncIterable<unknown>) void _chunk;
    await flushPromises();
    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "resp_stub" }),
    );
  });

  it("reuses the metadata given at create when collecting through the same client", async () => {
    mockProviderResponses.create.mockResolvedValue(queuedJob());
    mockProviderResponses.retrieve.mockResolvedValue(completedJob());

    await client
      .responses()
      .create(
        { model: "o4-mini", input: "hello", background: true },
        { organizationName: "org_1", traceId: "trace_1" },
      );
    await client.responses().retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ organizationName: "org_1", traceId: "trace_1" }),
    );
  });
});

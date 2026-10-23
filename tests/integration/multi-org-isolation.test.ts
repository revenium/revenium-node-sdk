export {};

const mockChatCompletionsCreate = jest.fn();

jest.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockChatCompletionsCreate } };
  }

  return { __esModule: true, default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

const ORG_A_KEY = "hak_org_a_1111111111";
const ORG_B_KEY = "hak_org_b_2222222222";
const BASE_URL = "https://api.revenium.ai";
const SELF_HOSTED_URL = "https://revenium.internal";

type CapturedRequest = { url: string; apiKey: string; body: Record<string, any> };

let setConfig: typeof import("../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../src/_core/config/manager").resetConfig;
let ReveniumOpenAI: typeof import("../../src/openai/client").ReveniumOpenAI;
let Provider: typeof import("../../src/openai/provider-detection").Provider;
let meterTool: typeof import("../../src/_core/tool-metering/index").meterTool;
let runWithCallConfig: typeof import("../../src/_core/config/call-config").runWithCallConfig;

const originalFetch = global.fetch;
let captured: CapturedRequest[];

function captureFetch(): jest.Mock {
  return jest.fn((url: string, init: RequestInit) => {
    captured.push({
      url,
      apiKey: (init.headers as Record<string, string>)["x-api-key"],
      body: JSON.parse(init.body as string),
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
      headers: { get: () => null },
    });
  });
}

function completionResponse(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function chunk(content: string, last = false): Record<string, unknown> {
  return {
    id: "chatcmpl-stream",
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content }, finish_reason: last ? "stop" : null }],
    usage: last ? { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } : undefined,
  };
}

function clientFor(apiKey: string, capturePrompts?: boolean): InstanceType<typeof ReveniumOpenAI> {
  return new ReveniumOpenAI(
    { reveniumApiKey: apiKey, reveniumBaseUrl: BASE_URL, openaiApiKey: "sk-test", capturePrompts },
    Provider.OPENAI,
  );
}

async function flushTracking(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function completionRequests(): CapturedRequest[] {
  return captured.filter((request) => request.url.includes("/ai/completions"));
}

beforeEach(async () => {
  jest.resetModules();
  captured = [];
  global.fetch = captureFetch() as unknown as typeof global.fetch;

  const manager = await import("../../src/_core/config/manager");
  const clientModule = await import("../../src/openai/client");
  const providerDetection = await import("../../src/openai/provider-detection");
  const toolMetering = await import("../../src/_core/tool-metering/index");
  const callConfig = await import("../../src/_core/config/call-config");

  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  ReveniumOpenAI = clientModule.ReveniumOpenAI;
  Provider = providerDetection.Provider;
  meterTool = toolMetering.meterTool;
  runWithCallConfig = callConfig.runWithCallConfig;

  mockChatCompletionsCreate.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  resetConfig();
});

describe("metering several organizations from one process", () => {
  it("two clients with different keys send under their own key", async () => {
    setConfig({ reveniumApiKey: ORG_B_KEY, reveniumBaseUrl: BASE_URL, capturePrompts: true });
    mockChatCompletionsCreate.mockResolvedValue(completionResponse("hello"));

    await clientFor(ORG_A_KEY)
      .chat()
      .completions()
      .create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });

    await flushTracking();

    expect(completionRequests()).toHaveLength(1);
    expect(completionRequests()[0].apiKey).toBe(ORG_A_KEY);
  });

  it("in-flight call keeps the key and capture setting it started with", async () => {
    setConfig({ reveniumApiKey: ORG_A_KEY, reveniumBaseUrl: BASE_URL, capturePrompts: false });

    mockChatCompletionsCreate.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(completionResponse("slow")), 200)),
    );

    const slowCall = clientFor(ORG_A_KEY, false)
      .chat()
      .completions()
      .create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "first" }] });

    await flushTracking();
    setConfig({ reveniumApiKey: ORG_B_KEY, reveniumBaseUrl: BASE_URL, capturePrompts: true });

    mockChatCompletionsCreate.mockResolvedValue(completionResponse("fast"));
    await clientFor(ORG_B_KEY, true)
      .chat()
      .completions()
      .create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "second" }] });

    await slowCall;
    await flushTracking();

    const first = completionRequests().find((request) => request.apiKey === ORG_A_KEY);
    const second = completionRequests().find((request) => request.apiKey === ORG_B_KEY);

    expect(first).toBeDefined();
    expect(first!.body.inputMessages).toBeUndefined();
    expect(second).toBeDefined();
    expect(second!.body.inputMessages).toContain("second");
  });

  it("stream consumed after reconfiguration reports to the originating organization", async () => {
    setConfig({ reveniumApiKey: ORG_A_KEY, reveniumBaseUrl: BASE_URL, capturePrompts: false });

    mockChatCompletionsCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield chunk("part");
        yield chunk("", true);
      },
    });

    const stream = await clientFor(ORG_A_KEY, false)
      .chat()
      .completions()
      .createStreaming({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "stream me" }],
        stream: true,
      });

    setConfig({ reveniumApiKey: ORG_B_KEY, reveniumBaseUrl: BASE_URL, capturePrompts: true });

    for await (const _event of stream) void _event;
    await flushTracking();

    expect(completionRequests()).toHaveLength(1);
    expect(completionRequests()[0].apiKey).toBe(ORG_A_KEY);
    expect(completionRequests()[0].body.inputMessages).toBeUndefined();
  });

  it("a client that only overrides the key keeps the configured host and capture setting", async () => {
    setConfig({
      reveniumApiKey: ORG_B_KEY,
      reveniumBaseUrl: SELF_HOSTED_URL,
      capturePrompts: true,
    });
    mockChatCompletionsCreate.mockResolvedValue(completionResponse("hello"));

    const client = new ReveniumOpenAI(
      { reveniumApiKey: ORG_A_KEY, openaiApiKey: "sk-test" },
      Provider.OPENAI,
    );
    await client
      .chat()
      .completions()
      .create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });

    await flushTracking();

    expect(completionRequests()).toHaveLength(1);
    expect(completionRequests()[0].apiKey).toBe(ORG_A_KEY);
    expect(completionRequests()[0].url.startsWith(SELF_HOSTED_URL)).toBe(true);
    expect(completionRequests()[0].body.inputMessages).toContain("hi");
  });

  it("tool events report under the enclosing call scope", async () => {
    setConfig({ reveniumApiKey: ORG_B_KEY, reveniumBaseUrl: BASE_URL });

    await runWithCallConfig({ reveniumApiKey: ORG_A_KEY, reveniumBaseUrl: BASE_URL }, () =>
      meterTool("search", async () => "done"),
    );

    await flushTracking();

    const toolEvents = captured.filter((request) => request.url.includes("/tool/events"));
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].apiKey).toBe(ORG_A_KEY);
  });
});

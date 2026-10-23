import type { ReveniumPayload } from "../../../src/_core/types/index";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

const originalFetch = global.fetch;

const PROXY_URL = "http://localhost:4000";
const RESPONSE_ID = "chatcmpl-perplexity-dual-001";
const LITELLM_SOURCE = "revenium-litellm-node";
const PERPLEXITY_SOURCE = "revenium-perplexity-node";

const ENV = {
  REVENIUM_METERING_API_KEY: "hak_test_key",
  REVENIUM_METERING_BASE_URL: "https://api.revenium.ai",
  PERPLEXITY_API_KEY: "pplx-test-key",
};

let envSnapshot: NodeJS.ProcessEnv;
let sendToRevenium: jest.Mock;
let litellmInitialize: typeof import("../../../src/litellm/index").initialize;
let litellmReset: typeof import("../../../src/litellm/index").reset;
let perplexityInitialize: typeof import("../../../src/perplexity/client").Initialize;
let perplexityGetClient: typeof import("../../../src/perplexity/client").GetClient;
let perplexityReset: typeof import("../../../src/perplexity/client").Reset;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let resetEnvFilesLoaded: typeof import("../../../src/_core/config/loader").resetEnvFilesLoaded;

function chatCompletionBody(): Record<string, unknown> {
  return {
    id: RESPONSE_ID,
    object: "chat.completion",
    model: "sonar",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
      cost: { input_tokens_cost: 0.011, output_tokens_cost: 0.003, total_cost: 0.014 },
    },
  };
}

function createUpstreamFetch(): jest.Mock {
  return jest.fn((input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request)?.url ?? input);

    if (!url.includes("/chat/completions")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }

    return Promise.resolve(
      new Response(JSON.stringify(chatCompletionBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

async function flushMetering(): Promise<void> {
  for (let attempt = 0; attempt < 50 && sendToRevenium.mock.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function meteredPayloads(): ReveniumPayload[] {
  return sendToRevenium.mock.calls.map(([payload]) => payload as ReveniumPayload);
}

async function chatThroughPerplexity(): Promise<void> {
  await perplexityGetClient()
    .chat()
    .completions()
    .create({ model: "sonar", messages: [{ role: "user", content: "hi" }] });
  await flushMetering();
}

beforeEach(async () => {
  jest.resetModules();
  envSnapshot = { ...process.env };
  delete process.env.LITELLM_PROXY_URL;
  delete process.env.PERPLEXITY_API_BASE_URL;
  Object.assign(process.env, ENV);

  const manager = await import("../../../src/_core/config/manager");
  const loader = await import("../../../src/_core/config/loader");
  const apiClient = await import("../../../src/_core/metering/api-client");
  const litellm = await import("../../../src/litellm/index");
  const perplexity = await import("../../../src/perplexity/client");

  resetConfig = manager.resetConfig;
  resetEnvFilesLoaded = loader.resetEnvFilesLoaded;
  sendToRevenium = jest.mocked(apiClient.sendToRevenium) as unknown as jest.Mock;
  litellmInitialize = litellm.initialize;
  litellmReset = litellm.reset;
  perplexityInitialize = perplexity.Initialize;
  perplexityGetClient = perplexity.GetClient;
  perplexityReset = perplexity.Reset;

  resetEnvFilesLoaded();
  litellmReset();
  perplexityReset();
  sendToRevenium.mockClear();
});

afterEach(() => {
  litellmReset();
  perplexityReset();
  resetConfig();
  global.fetch = originalFetch;
  process.env = envSnapshot;
  jest.restoreAllMocks();
});

describe("LiteLLM and Perplexity middlewares used together", () => {
  it("meters a proxied Perplexity call exactly once, through the proxy-aware middleware", async () => {
    process.env.LITELLM_PROXY_URL = PROXY_URL;
    process.env.PERPLEXITY_API_BASE_URL = `${PROXY_URL}/v1`;
    global.fetch = createUpstreamFetch();

    expect(litellmInitialize()).toBe(true);
    perplexityInitialize();

    await chatThroughPerplexity();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: LITELLM_SOURCE });
  });

  it("keeps the Perplexity cost and the per-call metadata on the single proxied record", async () => {
    process.env.LITELLM_PROXY_URL = PROXY_URL;
    process.env.PERPLEXITY_API_BASE_URL = `${PROXY_URL}/v1`;
    global.fetch = createUpstreamFetch();

    expect(litellmInitialize()).toBe(true);
    perplexityInitialize();

    await perplexityGetClient()
      .chat()
      .completions()
      .create(
        { model: "sonar", messages: [{ role: "user", content: "hi" }] },
        { subscriber: { id: "customer-123" }, productName: "paid-plan" },
      );
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({
      middlewareSource: LITELLM_SOURCE,
      subscriber: { id: "customer-123" },
      productName: "paid-plan",
      inputTokenCost: 0.011,
      outputTokenCost: 0.003,
      totalCost: 0.014,
    });
  });

  it("leaves a Perplexity-only setup untouched", async () => {
    global.fetch = createUpstreamFetch();

    perplexityInitialize();

    await chatThroughPerplexity();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: PERPLEXITY_SOURCE });
  });
});

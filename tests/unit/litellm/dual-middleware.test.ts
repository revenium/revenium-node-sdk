import type { Logger } from "../../../src/_core/types/index";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

const originalFetch = global.fetch;

const PROXY_URL = "http://localhost:4000";
const RESPONSE_ID = "chatcmpl-dual-001";
const LITELLM_SOURCE = "revenium-litellm-node";
const OPENAI_SOURCE = "revenium-openai-node";

const ENV = {
  REVENIUM_METERING_API_KEY: "hak_test_key",
  REVENIUM_METERING_BASE_URL: "https://api.revenium.ai",
  OPENAI_API_KEY: "sk-test-key",
};

let envSnapshot: NodeJS.ProcessEnv;
let sendToRevenium: jest.Mock;
let litellmInitialize: typeof import("../../../src/litellm/index").initialize;
let litellmReset: typeof import("../../../src/litellm/index").reset;
let openaiInitialize: typeof import("../../../src/openai/client").Initialize;
let openaiGetClient: typeof import("../../../src/openai/client").GetClient;
let openaiReset: typeof import("../../../src/openai/client").Reset;
let setLogger: typeof import("../../../src/_core/config/manager").setLogger;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let resetEnvFilesLoaded: typeof import("../../../src/_core/config/loader").resetEnvFilesLoaded;

function chatCompletionBody(): Record<string, unknown> {
  return {
    id: RESPONSE_ID,
    object: "chat.completion",
    model: "gpt-4.1-nano",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  };
}

function streamedChunks(): string {
  const chunks = [
    { id: RESPONSE_ID, model: "gpt-4.1-nano", choices: [{ index: 0, delta: { content: "hi" } }] },
    {
      id: RESPONSE_ID,
      model: "gpt-4.1-nano",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: RESPONSE_ID,
      model: "gpt-4.1-nano",
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function embeddingsBody(): Record<string, unknown> {
  return {
    object: "list",
    model: "text-embedding-3-small",
    data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
    usage: { prompt_tokens: 7, total_tokens: 7 },
  };
}

function createUpstreamFetch(streaming = false): jest.Mock {
  return jest.fn((input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request)?.url ?? input);

    if (url.includes("/embeddings")) {
      return Promise.resolve(
        new Response(JSON.stringify(embeddingsBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    if (!url.includes("/chat/completions")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }

    if (streaming) {
      return Promise.resolve(
        new Response(streamedChunks(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify(chatCompletionBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

function recordWarnings(): string[] {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => undefined,
  };
  setLogger(logger);
  return warnings;
}

async function flushMetering(): Promise<void> {
  for (let attempt = 0; attempt < 50 && sendToRevenium.mock.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function meteredPayloads(): Array<Record<string, unknown>> {
  return sendToRevenium.mock.calls.map(([payload]) => payload as Record<string, unknown>);
}

async function chatThroughOpenAI(): Promise<void> {
  await openaiGetClient()
    .chat()
    .completions()
    .create({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] });
  await flushMetering();
}

beforeEach(async () => {
  jest.resetModules();
  envSnapshot = { ...process.env };
  delete process.env.LITELLM_PROXY_URL;
  delete process.env.OPENAI_BASE_URL;
  Object.assign(process.env, ENV);
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const loader = await import("../../../src/_core/config/loader");
  const apiClient = await import("../../../src/_core/metering/api-client");
  const litellm = await import("../../../src/litellm/index");
  const openai = await import("../../../src/openai/client");

  setLogger = manager.setLogger;
  resetConfig = manager.resetConfig;
  resetEnvFilesLoaded = loader.resetEnvFilesLoaded;
  sendToRevenium = jest.mocked(apiClient.sendToRevenium) as unknown as jest.Mock;
  litellmInitialize = litellm.initialize;
  litellmReset = litellm.reset;
  openaiInitialize = openai.Initialize;
  openaiGetClient = openai.GetClient;
  openaiReset = openai.Reset;

  resetEnvFilesLoaded();
  litellmReset();
  openaiReset();
  sendToRevenium.mockClear();
});

afterEach(() => {
  litellmReset();
  openaiReset();
  resetConfig();
  global.fetch = originalFetch;
  process.env = envSnapshot;
  jest.restoreAllMocks();
});

function initializeBothMiddlewares(streaming = false): jest.Mock {
  process.env.LITELLM_PROXY_URL = PROXY_URL;
  process.env.OPENAI_BASE_URL = `${PROXY_URL}/v1`;

  const upstreamFetch = createUpstreamFetch(streaming);
  global.fetch = upstreamFetch;

  expect(litellmInitialize()).toBe(true);
  openaiInitialize();

  return upstreamFetch;
}

describe("LiteLLM and OpenAI middlewares used together", () => {
  it("meters a proxied OpenAI call exactly once, through the proxy-aware middleware", async () => {
    initializeBothMiddlewares();

    await chatThroughOpenAI();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: LITELLM_SOURCE });
  });

  it("meters a proxied embeddings call exactly once", async () => {
    initializeBothMiddlewares();

    await openaiGetClient().embeddings().create({ model: "text-embedding-3-small", input: "hi" });
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: LITELLM_SOURCE });
  });

  it("meters a call made through the underlying OpenAI client exactly once", async () => {
    initializeBothMiddlewares();

    await openaiGetClient()
      .getUnderlyingClient()
      .chat.completions.create({
        model: "gpt-4.1-nano",
        messages: [{ role: "user", content: "hi" }],
      });
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: LITELLM_SOURCE });
  });

  it("meters exactly once when the OpenAI middleware is initialized before LiteLLM", async () => {
    process.env.OPENAI_BASE_URL = `${PROXY_URL}/v1`;
    global.fetch = createUpstreamFetch();

    openaiInitialize();
    process.env.LITELLM_PROXY_URL = PROXY_URL;
    expect(litellmInitialize()).toBe(true);

    await chatThroughOpenAI();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: LITELLM_SOURCE });
  });

  it("meters a proxied streaming OpenAI call exactly once", async () => {
    initializeBothMiddlewares(true);

    const stream = await openaiGetClient()
      .chat()
      .completions()
      .createStreaming({
        model: "gpt-4.1-nano",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
    }
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({
      middlewareSource: LITELLM_SOURCE,
      isStreamed: true,
    });
  });

  it("warns once naming the metering layer", async () => {
    initializeBothMiddlewares();
    const warnings = recordWarnings();

    await chatThroughOpenAI();
    sendToRevenium.mockClear();
    await chatThroughOpenAI();

    const ownershipWarnings = warnings.filter(
      (message) => message.includes(OPENAI_SOURCE) && message.includes(LITELLM_SOURCE),
    );
    expect(ownershipWarnings).toHaveLength(1);
  });

  it("keeps the per-call metadata on the single proxied record", async () => {
    initializeBothMiddlewares();

    await openaiGetClient()
      .chat()
      .completions()
      .create(
        { model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] },
        {
          subscriber: { id: "customer-123" },
          productName: "paid-plan",
          traceId: "trace-123",
        },
      );
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({
      middlewareSource: LITELLM_SOURCE,
      subscriber: { id: "customer-123" },
      productName: "paid-plan",
      traceId: "trace-123",
    });
  });

  it("keeps the per-call metadata on the single proxied embeddings record", async () => {
    initializeBothMiddlewares();

    await openaiGetClient()
      .embeddings()
      .create(
        { model: "text-embedding-3-small", input: "hi" },
        { subscriber: { id: "customer-123" }, productName: "paid-plan" },
      );
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({
      middlewareSource: LITELLM_SOURCE,
      subscriber: { id: "customer-123" },
      productName: "paid-plan",
    });
  });

  it("still meters a direct OpenAI call that does not go through the proxy", async () => {
    process.env.LITELLM_PROXY_URL = PROXY_URL;
    global.fetch = createUpstreamFetch();

    expect(litellmInitialize()).toBe(true);
    openaiInitialize();

    await chatThroughOpenAI();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: OPENAI_SOURCE });
  });

  it("leaves a LiteLLM-only setup untouched", async () => {
    process.env.LITELLM_PROXY_URL = PROXY_URL;
    global.fetch = createUpstreamFetch();

    expect(litellmInitialize()).toBe(true);

    await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] }),
    });
    await flushMetering();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({ middlewareSource: LITELLM_SOURCE });
  });

  it("leaves an OpenAI-only setup untouched", async () => {
    global.fetch = createUpstreamFetch();

    openaiInitialize();

    await chatThroughOpenAI();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(meteredPayloads()[0]).toMatchObject({
      middlewareSource: OPENAI_SOURCE,
      transactionId: RESPONSE_ID,
    });
  });
});

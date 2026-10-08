import { createReveniumConfig } from "../../helpers/fixtures";

const FOUNDRY_BASE_URL = "https://my-resource.services.ai.azure.com/anthropic";
const DIRECT_BASE_URL = "https://api.anthropic.com";
const REVENIUM_BASE_URL = "https://api.revenium.ai";
const MODEL = "claude-3-5-sonnet-20241022";

const MESSAGE_RESPONSE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

const SSE_EVENTS = [
  {
    type: "message_start",
    message: { ...MESSAGE_RESPONSE, content: [], stop_reason: null },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];

let Anthropic: typeof import("@anthropic-ai/sdk").default;
let patchAnthropic: typeof import("../../../src/anthropic/wrapper").patchAnthropic;
let unpatchAnthropic: typeof import("../../../src/anthropic/wrapper").unpatchAnthropic;
let trackUsageAsync: typeof import("../../../src/anthropic/middleware").trackUsageAsync;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let resetMeteringCircuitBreaker: typeof import("../../../src/_core/resilience/circuit-breaker").resetMeteringCircuitBreaker;

const originalFetch = global.fetch;

function jsonResponse(): Response {
  return new Response(JSON.stringify(MESSAGE_RESPONSE), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(): Response {
  const body = SSE_EVENTS.map(
    (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function installRoutingFetch(providerResponse: () => Response): Record<string, unknown>[] {
  const meteringBodies: Record<string, unknown>[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(REVENIUM_BASE_URL)) {
      meteringBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return providerResponse();
  }) as unknown as typeof fetch;
  return meteringBodies;
}

async function waitForMetering(
  bodies: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100 && bodies.length === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return bodies[0];
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) {
    void chunk;
  }
}

const REQUEST = { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

function meterNonStreamingCall(baseURL: string): Promise<Record<string, unknown>> {
  const bodies = installRoutingFetch(jsonResponse);
  const client = new Anthropic({ apiKey: "sk-ant-test", baseURL });
  return client.messages.create(REQUEST as any).then(() => waitForMetering(bodies));
}

async function meterStreamingCreate(baseURL: string): Promise<Record<string, unknown>> {
  const bodies = installRoutingFetch(sseResponse);
  const client = new Anthropic({ apiKey: "sk-ant-test", baseURL });

  await drain(
    (await client.messages.create({
      ...REQUEST,
      stream: true,
    } as any)) as unknown as AsyncIterable<unknown>,
  );

  return waitForMetering(bodies);
}

async function meterStreamHelper(
  baseURL: string,
): Promise<{ body: Record<string, unknown>; bodies: Record<string, unknown>[] }> {
  const bodies = installRoutingFetch(sseResponse);
  const client = new Anthropic({ apiKey: "sk-ant-test", baseURL });

  await drain(client.messages.stream(REQUEST as any) as unknown as AsyncIterable<unknown>);

  const body = await waitForMetering(bodies);
  await settle();
  return { body, bodies };
}

function differingKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
}

beforeEach(async () => {
  jest.resetModules();
  process.env.AWS_REGION = "us-east-1";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";

  Anthropic = (await import("@anthropic-ai/sdk")).default;
  const manager = await import("../../../src/_core/config/manager");
  const wrapper = await import("../../../src/anthropic/wrapper");
  const middleware = await import("../../../src/anthropic/middleware");
  const circuitBreaker = await import("../../../src/_core/resilience/circuit-breaker");

  patchAnthropic = wrapper.patchAnthropic;
  unpatchAnthropic = wrapper.unpatchAnthropic;
  trackUsageAsync = middleware.trackUsageAsync;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  resetMeteringCircuitBreaker = circuitBreaker.resetMeteringCircuitBreaker;

  setConfig(createReveniumConfig({ reveniumBaseUrl: REVENIUM_BASE_URL }));
  patchAnthropic();
});

afterEach(() => {
  unpatchAnthropic();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  delete process.env.AWS_REGION;
  delete process.env.ANTHROPIC_API_KEY;
  resetMeteringCircuitBreaker();
  resetConfig();
});

describe("messages.create", () => {
  it("labels a Foundry base URL as Foundry", async () => {
    const body = await meterNonStreamingCall(FOUNDRY_BASE_URL);

    expect(body).toMatchObject({ provider: "Foundry", modelSource: "ANTHROPIC" });
  });

  it("labels a direct base URL as Anthropic", async () => {
    const body = await meterNonStreamingCall(DIRECT_BASE_URL);

    expect(body).toMatchObject({ provider: "Anthropic", modelSource: "ANTHROPIC" });
  });
});

describe("messages.create with stream", () => {
  it("labels a Foundry base URL as Foundry", async () => {
    expect(await meterStreamingCreate(FOUNDRY_BASE_URL)).toMatchObject({
      provider: "Foundry",
      modelSource: "ANTHROPIC",
    });
  });

  it("labels a direct base URL as Anthropic", async () => {
    expect(await meterStreamingCreate(DIRECT_BASE_URL)).toMatchObject({
      provider: "Anthropic",
      modelSource: "ANTHROPIC",
    });
  });
});

describe("messages.stream", () => {
  it("labels a Foundry base URL as Foundry exactly once", async () => {
    const { body, bodies } = await meterStreamHelper(FOUNDRY_BASE_URL);

    expect(body).toMatchObject({ provider: "Foundry", modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });

  it("labels a direct base URL as Anthropic exactly once", async () => {
    const { body, bodies } = await meterStreamHelper(DIRECT_BASE_URL);

    expect(body).toMatchObject({ provider: "Anthropic", modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });

  it("keeps the SDK stream helper methods available", async () => {
    const bodies = installRoutingFetch(sseResponse);
    const client = new Anthropic({ apiKey: "sk-ant-test", baseURL: FOUNDRY_BASE_URL });
    const textDeltas: string[] = [];

    const stream = client.messages.stream(REQUEST as any);
    stream.on("text", (text: string) => textDeltas.push(text));
    const { request_id: _requestId } = await stream.withResponse();
    const finalMessage = await stream.finalMessage();

    expect(finalMessage.model).toBe(MODEL);
    expect(textDeltas).toEqual(["Hello"]);
    expect(await stream.finalText()).toBe("Hello");

    await waitForMetering(bodies);
    await settle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ provider: "Foundry", modelSource: "ANTHROPIC" });
  });
});

describe("Anthropic SDK resource surface", () => {
  it("exposes the client base URL the provider label is derived from", () => {
    const client = new Anthropic({ apiKey: "sk-ant-test", baseURL: FOUNDRY_BASE_URL });

    expect(
      (client.messages as unknown as { _client?: { baseURL?: string } })._client?.baseURL,
    ).toBe(FOUNDRY_BASE_URL);
  });
});

describe("trackUsageAsync without a resolved provider", () => {
  it("keeps the direct Anthropic label", async () => {
    const bodies = installRoutingFetch(jsonResponse);

    trackUsageAsync({
      requestId: "req-foundry-fallback",
      model: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      duration: 100,
      isStreamed: false,
      stopReason: "end_turn",
      requestTime: new Date(),
      responseTime: new Date(),
    });

    expect(await waitForMetering(bodies)).toHaveProperty("provider", "Anthropic");
  });
});

describe("payload parity", () => {
  it("differs from a direct call only by provider", async () => {
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    try {
      const { transactionId: foundryTransactionId, ...foundryBody } =
        await meterNonStreamingCall(FOUNDRY_BASE_URL);
      const { transactionId: directTransactionId, ...directBody } =
        await meterNonStreamingCall(DIRECT_BASE_URL);

      expect(foundryTransactionId).not.toEqual(directTransactionId);
      expect(differingKeys(foundryBody, directBody)).toEqual(["provider"]);
      expect(foundryBody.provider).toBe("Foundry");
      expect(directBody.provider).toBe("Anthropic");
    } finally {
      jest.useRealTimers();
    }
  });
});

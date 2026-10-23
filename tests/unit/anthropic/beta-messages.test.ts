import { createReveniumConfig } from "../../helpers/fixtures";

const BASE_URL = "https://api.anthropic.com";
const REVENIUM_BASE_URL = "https://api.revenium.ai";
const MODEL = "claude-3-5-sonnet-20241022";

const MESSAGE_RESPONSE = {
  id: "msg_beta_01",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 7 },
};

const STRUCTURED_RESPONSE = {
  ...MESSAGE_RESPONSE,
  content: [{ type: "text", text: '{"city":"Lisbon"}' }],
};

const TOOL_USE_RESPONSE = {
  ...MESSAGE_RESPONSE,
  id: "msg_beta_tool",
  content: [{ type: "tool_use", id: "toolu_beta_01", name: "echo", input: { value: "hi" } }],
  stop_reason: "tool_use",
};

const ECHO_TOOL = {
  name: "echo",
  description: "Returns the value it is given",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  parse: (input: unknown) => input as { value: string },
  run: ({ value }: { value: string }) => value,
};

const SSE_EVENTS = [
  { type: "message_start", message: { ...MESSAGE_RESPONSE, content: [], stop_reason: null } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  },
  { type: "message_stop" },
];

let Anthropic: typeof import("@anthropic-ai/sdk").default;
let patchAnthropic: typeof import("../../../src/anthropic/wrapper").patchAnthropic;
let unpatchAnthropic: typeof import("../../../src/anthropic/wrapper").unpatchAnthropic;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let resetMeteringCircuitBreaker: typeof import("../../../src/_core/resilience/circuit-breaker").resetMeteringCircuitBreaker;

const originalFetch = global.fetch;

function jsonResponse(payload: Record<string, unknown> = MESSAGE_RESPONSE): () => Response {
  return () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function sseResponseFrom(events: Record<string, unknown>[]): () => Response {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const sseResponse = sseResponseFrom(SSE_EVENTS);

const TOOL_USE_SSE_EVENTS = [
  { type: "message_start", message: { ...TOOL_USE_RESPONSE, content: [], stop_reason: null } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_beta_01", name: "echo", input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"value":"hi"}' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 7 },
  },
  { type: "message_stop" },
];

function sequence(responses: (() => Response)[]): () => Response {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]();
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

function createClient(): import("@anthropic-ai/sdk").default {
  return new Anthropic({ apiKey: "sk-ant-test", baseURL: BASE_URL });
}

const REQUEST = { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

beforeEach(async () => {
  jest.resetModules();
  process.env.AWS_REGION = "us-east-1";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";

  Anthropic = (await import("@anthropic-ai/sdk")).default;
  const manager = await import("../../../src/_core/config/manager");
  const wrapper = await import("../../../src/anthropic/wrapper");
  const circuitBreaker = await import("../../../src/_core/resilience/circuit-breaker");

  patchAnthropic = wrapper.patchAnthropic;
  unpatchAnthropic = wrapper.unpatchAnthropic;
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

describe("beta.messages.create", () => {
  it("meters a non-streaming call once", async () => {
    const bodies = installRoutingFetch(jsonResponse());

    const message = await createClient().beta.messages.create({
      ...REQUEST,
      usageMetadata: { organizationId: "org-beta" },
    } as any);

    expect(message.model).toBe(MODEL);
    expect(await waitForMetering(bodies)).toMatchObject({
      provider: "Anthropic",
      modelSource: "ANTHROPIC",
      inputTokenCount: 11,
      outputTokenCount: 7,
      isStreamed: false,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters a drained streaming call once", async () => {
    const bodies = installRoutingFetch(sseResponse);

    await drain(
      (await createClient().beta.messages.create({
        ...REQUEST,
        stream: true,
      } as any)) as unknown as AsyncIterable<unknown>,
    );

    expect(await waitForMetering(bodies)).toMatchObject({
      provider: "Anthropic",
      modelSource: "ANTHROPIC",
      inputTokenCount: 11,
      outputTokenCount: 7,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once when the result is consumed through withResponse and await", async () => {
    const bodies = installRoutingFetch(jsonResponse());

    const promise = createClient().beta.messages.create(REQUEST as any);
    const { data } = await promise.withResponse();
    const awaited = await promise;

    expect(awaited).toBe(data);
    await waitForMetering(bodies);
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("runs finally and still resolves with the message", async () => {
    const bodies = installRoutingFetch(jsonResponse());
    const cleanup = jest.fn();

    const message = await createClient()
      .beta.messages.create(REQUEST as any)
      .finally(cleanup);

    expect(message.model).toBe(MODEL);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await waitForMetering(bodies);
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("waits for asynchronous finally cleanup before resolving", async () => {
    installRoutingFetch(jsonResponse());
    const order: string[] = [];

    await createClient()
      .beta.messages.create(REQUEST as any)
      .finally(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("cleanup");
      });

    order.push("awaited");
    expect(order).toEqual(["cleanup", "awaited"]);
  });

  it("surfaces a rejection thrown by finally cleanup", async () => {
    installRoutingFetch(jsonResponse());

    await expect(
      createClient()
        .beta.messages.create(REQUEST as any)
        .finally(async () => {
          throw new Error("cleanup failed");
        }),
    ).rejects.toThrow("cleanup failed");
  });

  it("surfaces the provider error through finally and catch", async () => {
    const bodies = installRoutingFetch(
      () => new Response("boom", { status: 429, headers: { "content-type": "text/plain" } }),
    );
    const cleanup = jest.fn();

    const status = await createClient()
      .beta.messages.create({ ...REQUEST, max_retries: 0 } as any, { maxRetries: 0 })
      .finally(cleanup)
      .catch((error: any) => error.status);

    expect(status).toBe(429);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await waitForMetering(bodies)).toMatchObject({ stopReason: "ERROR" });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters a non-streaming call consumed through asResponse", async () => {
    const bodies = installRoutingFetch(jsonResponse());

    const response = await createClient()
      .beta.messages.create(REQUEST as any)
      .asResponse();

    expect(await response.json()).toMatchObject({ id: "msg_beta_01" });
    expect(await waitForMetering(bodies)).toMatchObject({
      inputTokenCount: 11,
      outputTokenCount: 7,
      isStreamed: false,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters a streaming call consumed through asResponse", async () => {
    const bodies = installRoutingFetch(sseResponse);

    const response = await createClient()
      .beta.messages.create({ ...REQUEST, stream: true } as any)
      .asResponse();

    expect(await response.text()).toContain("message_stop");
    expect(await waitForMetering(bodies)).toMatchObject({ isStreamed: true });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once when the stream is drained through tee", async () => {
    const bodies = installRoutingFetch(sseResponse);

    const stream = (await createClient().beta.messages.create({
      ...REQUEST,
      stream: true,
    } as any)) as any;
    const [left, right] = stream.tee();

    await Promise.all([drain(left), drain(right)]);

    expect(await waitForMetering(bodies)).toMatchObject({ isStreamed: true });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once when the stream is drained through toReadableStream", async () => {
    const bodies = installRoutingFetch(sseResponse);

    const stream = (await createClient().beta.messages.create({
      ...REQUEST,
      stream: true,
    } as any)) as any;

    const reader = stream.toReadableStream().getReader();
    while (!(await reader.read()).done) {
      void 0;
    }

    expect(await waitForMetering(bodies)).toMatchObject({ isStreamed: true });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as cancelled when the stream is abandoned before completion", async () => {
    const bodies = installRoutingFetch(sseResponse);

    const stream = (await createClient().beta.messages.create({
      ...REQUEST,
      stream: true,
    } as any)) as unknown as AsyncIterable<unknown>;

    for await (const chunk of stream) {
      void chunk;
      break;
    }

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "CANCELLED",
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("beta.messages.stream", () => {
  it("meters once and keeps the helper surface working", async () => {
    const bodies = installRoutingFetch(sseResponse);
    const textDeltas: string[] = [];

    const stream = createClient().beta.messages.stream(REQUEST as any);
    stream.on("text", (text: string) => textDeltas.push(text));
    const { request_id: _requestId } = await stream.withResponse();
    const finalMessage = await stream.finalMessage();

    expect(finalMessage.model).toBe(MODEL);
    expect(textDeltas).toEqual(["Hello"]);

    expect(await waitForMetering(bodies)).toMatchObject({ isStreamed: true });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("beta.messages.parse", () => {
  it("meters once and still returns the parsed output", async () => {
    const bodies = installRoutingFetch(jsonResponse(STRUCTURED_RESPONSE));

    const message = await createClient().beta.messages.parse({
      ...REQUEST,
      output_format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    } as any);

    expect(message.parsed_output).toEqual({ city: "Lisbon" });
    expect(await waitForMetering(bodies)).toMatchObject({ provider: "Anthropic" });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("beta.messages.toolRunner", () => {
  it("meters a single turn once", async () => {
    const bodies = installRoutingFetch(jsonResponse());

    const runner = createClient().beta.messages.toolRunner({
      ...REQUEST,
      tools: [],
      stream: false,
    } as any);

    expect((await runner.runUntilDone()).model).toBe(MODEL);
    await waitForMetering(bodies);
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters every turn of a non-streaming tool loop exactly once", async () => {
    const bodies = installRoutingFetch(sequence([jsonResponse(TOOL_USE_RESPONSE), jsonResponse()]));

    const runner = createClient().beta.messages.toolRunner({
      ...REQUEST,
      tools: [ECHO_TOOL],
      stream: false,
    } as any);

    expect((await runner.runUntilDone()).stop_reason).toBe("end_turn");
    await settle();
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(2);
    expect(bodies.every((body) => body.isStreamed === false)).toBe(true);
  });

  it("meters every turn of a streaming tool loop exactly once", async () => {
    const bodies = installRoutingFetch(
      sequence([sseResponseFrom(TOOL_USE_SSE_EVENTS), sseResponse]),
    );

    const runner = createClient().beta.messages.toolRunner({
      ...REQUEST,
      tools: [ECHO_TOOL],
      stream: true,
    } as any);

    expect((await runner.runUntilDone()).stop_reason).toBe("end_turn");
    await settle();
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(2);
    expect(bodies.every((body) => body.isStreamed === true)).toBe(true);
  });
});

describe("regular messages.create after the beta patch", () => {
  it("still meters exactly once", async () => {
    const bodies = installRoutingFetch(jsonResponse());

    await createClient().messages.create(REQUEST as any);

    expect(await waitForMetering(bodies)).toMatchObject({
      provider: "Anthropic",
      modelSource: "ANTHROPIC",
      isStreamed: false,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("an SDK without a beta surface", () => {
  it("still patches and meters the regular path", async () => {
    unpatchAnthropic();
    const beta = Object.getOwnPropertyDescriptor(Anthropic, "Beta")!;
    Object.defineProperty(Anthropic, "Beta", { ...beta, value: undefined });
    delete process.env.ANTHROPIC_API_KEY;

    try {
      expect(() => patchAnthropic()).not.toThrow();

      const bodies = installRoutingFetch(jsonResponse());
      await createClient().messages.create(REQUEST as any);

      expect(await waitForMetering(bodies)).toMatchObject({ provider: "Anthropic" });
      await settle();
      expect(bodies).toHaveLength(1);
    } finally {
      Object.defineProperty(Anthropic, "Beta", beta);
    }
  });
});

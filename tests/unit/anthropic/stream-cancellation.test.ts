import { createReveniumConfig } from "../../helpers/fixtures";

const BASE_URL = "https://api.anthropic.com";
const REVENIUM_BASE_URL = "https://api.revenium.ai";
const MODEL = "claude-3-5-sonnet-20241022";

const MESSAGE_RESPONSE = {
  id: "msg_cancel_01",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

const SSE_EVENTS = [
  { type: "message_start", message: { ...MESSAGE_RESPONSE, content: [], stop_reason: null } },
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

const MAX_TOKENS_SSE_EVENTS = SSE_EVENTS.map((event) =>
  event.type === "message_delta"
    ? { ...event, delta: { stop_reason: "max_tokens", stop_sequence: null } }
    : event,
);

const TRUNCATED_SSE_EVENTS = SSE_EVENTS.slice(0, 3);

let Anthropic: typeof import("@anthropic-ai/sdk").default;
let patchAnthropic: typeof import("../../../src/anthropic/wrapper").patchAnthropic;
let unpatchAnthropic: typeof import("../../../src/anthropic/wrapper").unpatchAnthropic;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let resetMeteringCircuitBreaker: typeof import("../../../src/_core/resilience/circuit-breaker").resetMeteringCircuitBreaker;

const originalFetch = global.fetch;

function encodeEvents(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function eventStreamResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseResponseFrom(events: Record<string, unknown>[]): () => Response {
  const body = encodeEvents(events);
  return () => eventStreamResponse(body);
}

const sseResponse = sseResponseFrom(SSE_EVENTS);

function failingAfterEventsSseResponse(events: Record<string, unknown>[]): () => Response {
  const body = encodeEvents(events);

  return () => {
    let delivered = false;

    return eventStreamResponse(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) {
            controller.error(new Error("upstream connection reset"));
            return;
          }
          delivered = true;
          controller.enqueue(new TextEncoder().encode(body));
        },
      }),
    );
  };
}

const failingSseResponse = failingAfterEventsSseResponse(TRUNCATED_SSE_EVENTS);
const failingAfterStopReasonSseResponse = failingAfterEventsSseResponse(SSE_EVENTS.slice(0, 5));

function abortableSseResponse(init?: RequestInit): Response {
  return eventStreamResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(encodeEvents(TRUNCATED_SSE_EVENTS)));
        init?.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("The operation was aborted.", "AbortError")),
        );
      },
    }),
  );
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function installRoutingFetch(
  providerResponse: (init?: RequestInit) => Response,
): Record<string, unknown>[] {
  const meteringBodies: Record<string, unknown>[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(REVENIUM_BASE_URL)) {
      meteringBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return providerResponse(init);
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

async function drain(iterable: AsyncIterable<any>, receivedTypes: string[] = []): Promise<void> {
  for await (const chunk of iterable) {
    receivedTypes.push(chunk?.type);
  }
}

const REQUEST = { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

function createClient(): import("@anthropic-ai/sdk").default {
  return new Anthropic({ apiKey: "sk-ant-test", baseURL: BASE_URL });
}

function startStreamingCreate(): Promise<AsyncIterable<any>> {
  return createClient().messages.create({
    ...REQUEST,
    stream: true,
  } as any) as unknown as Promise<AsyncIterable<any>>;
}

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

describe("messages.create abandoned mid-stream", () => {
  it("meters once as cancelled with the tokens seen so far", async () => {
    const bodies = installRoutingFetch(sseResponse);

    for await (const chunk of await startStreamingCreate()) {
      if (chunk.type === "content_block_delta") break;
    }

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "CANCELLED",
      inputTokenCount: 10,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as cancelled when the request signal is aborted", async () => {
    const bodies = installRoutingFetch(abortableSseResponse);
    const controller = new AbortController();

    const stream = (await createClient().messages.create({ ...REQUEST, stream: true } as any, {
      signal: controller.signal,
    })) as unknown as AsyncIterable<any>;

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta") controller.abort();
    }

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "CANCELLED",
      inputTokenCount: 10,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("keeps the provider stop reason when it arrived before abandonment", async () => {
    const bodies = installRoutingFetch(sseResponseFrom(MAX_TOKENS_SSE_EVENTS));

    for await (const chunk of await startStreamingCreate()) {
      if (chunk.type === "message_delta") break;
    }

    expect(await waitForMetering(bodies)).toMatchObject({ stopReason: "TOKEN_LIMIT" });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as END when drained to completion", async () => {
    const bodies = installRoutingFetch(sseResponse);

    await drain(await startStreamingCreate());

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "END",
      inputTokenCount: 10,
      outputTokenCount: 5,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("messages.create failing mid-stream", () => {
  it("meters once as errored with the tokens delivered before the failure", async () => {
    const bodies = installRoutingFetch(failingSseResponse);
    const receivedTypes: string[] = [];

    await expect(drain(await startStreamingCreate(), receivedTypes)).rejects.toThrow();

    expect(receivedTypes).toEqual(["message_start", "content_block_start", "content_block_delta"]);
    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      inputTokenCount: 10,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters as errored even when the provider stop reason already arrived", async () => {
    const bodies = installRoutingFetch(failingAfterStopReasonSseResponse);
    const receivedTypes: string[] = [];

    await expect(drain(await startStreamingCreate(), receivedTypes)).rejects.toThrow();

    expect(receivedTypes).toContain("message_delta");
    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      inputTokenCount: 10,
      outputTokenCount: 5,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("messages.stream aborted", () => {
  it("meters once as cancelled with the tokens seen so far", async () => {
    const bodies = installRoutingFetch(abortableSseResponse);

    const stream = createClient().messages.stream(REQUEST as any);
    const settled = stream.done().catch(() => undefined);
    stream.on("text", () => stream.abort());

    await settled;

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "CANCELLED",
      inputTokenCount: 10,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as END when drained to completion", async () => {
    const bodies = installRoutingFetch(sseResponse);

    await drain(
      createClient().messages.stream(REQUEST as any) as unknown as AsyncIterable<unknown>,
    );

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "END",
      inputTokenCount: 10,
      outputTokenCount: 5,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("messages.stream failing mid-stream", () => {
  it("meters once as errored and still rejects to the caller", async () => {
    const bodies = installRoutingFetch(failingSseResponse);

    const stream = createClient().messages.stream(REQUEST as any);

    await expect(stream.done()).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as errored when the request is rejected before any event", async () => {
    const bodies = installRoutingFetch(unauthorizedResponse);

    const stream = createClient().messages.stream(REQUEST as any);

    await expect(stream.done()).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      inputTokenCount: 0,
      outputTokenCount: 0,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("messages.create rejected before the stream starts", () => {
  it("meters once as errored on the non-streaming path", async () => {
    const bodies = installRoutingFetch(unauthorizedResponse);

    await expect(createClient().messages.create(REQUEST as any)).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      inputTokenCount: 0,
      outputTokenCount: 0,
      isStreamed: false,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as errored on the streaming path", async () => {
    const bodies = installRoutingFetch(unauthorizedResponse);

    await expect(startStreamingCreate()).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as cancelled when the request is aborted before the provider responds", async () => {
    const bodies = installRoutingFetch(sseResponse);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createClient().messages.create({ ...REQUEST, stream: true } as any, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "CANCELLED",
      inputTokenCount: 0,
      outputTokenCount: 0,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("beta.messages rejected before the stream starts", () => {
  it("meters once as errored on the non-streaming path", async () => {
    const bodies = installRoutingFetch(unauthorizedResponse);

    await expect(createClient().beta.messages.create(REQUEST as any)).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      inputTokenCount: 0,
      outputTokenCount: 0,
      isStreamed: false,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as errored on the streaming path", async () => {
    const bodies = installRoutingFetch(unauthorizedResponse);

    await expect(
      createClient().beta.messages.create({ ...REQUEST, stream: true } as any),
    ).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });

  it("meters once as errored when the stream helper is rejected before any event", async () => {
    const bodies = installRoutingFetch(unauthorizedResponse);

    const stream = createClient().beta.messages.stream(REQUEST as any);

    await expect(stream.done()).rejects.toThrow();

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "ERROR",
      inputTokenCount: 0,
      outputTokenCount: 0,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

describe("beta.messages.stream aborted", () => {
  it("meters once as cancelled with the tokens seen so far", async () => {
    const bodies = installRoutingFetch(abortableSseResponse);

    const stream = createClient().beta.messages.stream(REQUEST as any);
    const settled = stream.done().catch(() => undefined);
    stream.on("text", () => stream.abort());

    await settled;

    expect(await waitForMetering(bodies)).toMatchObject({
      stopReason: "CANCELLED",
      inputTokenCount: 10,
      isStreamed: true,
    });
    await settle();
    expect(bodies).toHaveLength(1);
  });
});

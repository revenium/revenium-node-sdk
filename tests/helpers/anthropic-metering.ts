import { createReveniumConfig } from "./fixtures";

export const REVENIUM_BASE_URL = "https://api.revenium.ai";
export const DIRECT_BASE_URL = "https://api.anthropic.com";
export const MODEL = "claude-3-5-sonnet-20241022";
export const REQUEST = {
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
};

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

type MeteringBody = Record<string, unknown>;
type AnthropicModule = typeof import("@anthropic-ai/sdk").default;
type AnthropicClient = InstanceType<AnthropicModule>;

export interface MeteringResult {
  body: MeteringBody;
  bodies: MeteringBody[];
}

export function jsonResponse(): Response {
  return new Response(JSON.stringify(MESSAGE_RESPONSE), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function sseResponse(): Response {
  const body = SSE_EVENTS.map(
    (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function installRoutingFetch(providerResponse: () => Response): MeteringBody[] {
  const meteringBodies: MeteringBody[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(REVENIUM_BASE_URL)) {
      meteringBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return providerResponse();
  }) as unknown as typeof fetch;
  return meteringBodies;
}

export async function waitForMetering(bodies: MeteringBody[]): Promise<MeteringBody> {
  for (let attempt = 0; attempt < 100 && bodies.length === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (bodies.length === 0) throw new Error("Timed out waiting for a metering request");
  return bodies[0];
}

export async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) {
    void chunk;
  }
}

export function differingKeys(left: MeteringBody, right: MeteringBody): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
}

export type AnthropicClientFactory = () => AnthropicClient | Promise<AnthropicClient>;
export type AnthropicClientSource = string | AnthropicClientFactory;

export interface AnthropicMeteringHarness {
  readonly trackUsageAsync: typeof import("../../src/anthropic/middleware").trackUsageAsync;
  createClient(baseURL: string): AnthropicClient;
  meterNonStreamingCall(client: AnthropicClientSource): Promise<MeteringResult>;
  meterBetaCall(client: AnthropicClientSource): Promise<MeteringResult>;
  meterStreamingCreate(client: AnthropicClientSource): Promise<MeteringResult>;
  meterStreamHelper(client: AnthropicClientSource): Promise<MeteringResult>;
}

export function setupAnthropicMetering(): AnthropicMeteringHarness {
  const originalFetch = global.fetch;
  let Anthropic: AnthropicModule;
  let trackUsageAsync: typeof import("../../src/anthropic/middleware").trackUsageAsync;
  let unpatchAnthropic: typeof import("../../src/anthropic/wrapper").unpatchAnthropic;
  let resetConfig: typeof import("../../src/_core/config/manager").resetConfig;
  let resetMeteringCircuitBreaker: typeof import("../../src/_core/resilience/circuit-breaker").resetMeteringCircuitBreaker;

  const createClient = (baseURL: string): AnthropicClient =>
    new Anthropic({ apiKey: "sk-ant-test", baseURL });

  const resolveClient = (
    source: AnthropicClientSource,
  ): AnthropicClient | Promise<AnthropicClient> =>
    typeof source === "string" ? createClient(source) : source();

  async function collect(
    providerResponse: () => Response,
    call: (client: AnthropicClient) => Promise<void>,
    source: AnthropicClientSource,
  ): Promise<MeteringResult> {
    const bodies = installRoutingFetch(providerResponse);

    await call(await resolveClient(source));

    const body = await waitForMetering(bodies);
    await settle();
    return { body, bodies };
  }

  beforeEach(async () => {
    jest.resetModules();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    Anthropic = (await import("@anthropic-ai/sdk")).default;
    const manager = await import("../../src/_core/config/manager");
    const wrapper = await import("../../src/anthropic/wrapper");
    const middleware = await import("../../src/anthropic/middleware");
    const circuitBreaker = await import("../../src/_core/resilience/circuit-breaker");

    trackUsageAsync = middleware.trackUsageAsync;
    unpatchAnthropic = wrapper.unpatchAnthropic;
    resetConfig = manager.resetConfig;
    resetMeteringCircuitBreaker = circuitBreaker.resetMeteringCircuitBreaker;

    manager.setConfig(createReveniumConfig({ reveniumBaseUrl: REVENIUM_BASE_URL }));
    wrapper.patchAnthropic();
  });

  afterEach(() => {
    unpatchAnthropic();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
    resetMeteringCircuitBreaker();
    resetConfig();
  });

  return {
    get trackUsageAsync() {
      return trackUsageAsync;
    },
    createClient,
    meterNonStreamingCall: (source) =>
      collect(
        jsonResponse,
        async (client) => {
          await client.messages.create(REQUEST as never);
        },
        source,
      ),
    meterBetaCall: (source) =>
      collect(
        jsonResponse,
        async (client) => {
          await client.beta.messages.create(REQUEST as never);
        },
        source,
      ),
    meterStreamingCreate: (source) =>
      collect(
        sseResponse,
        async (client) => {
          await drain(
            (await client.messages.create({
              ...REQUEST,
              stream: true,
            } as never)) as unknown as AsyncIterable<unknown>,
          );
        },
        source,
      ),
    meterStreamHelper: (source) =>
      collect(
        sseResponse,
        async (client) => {
          await drain(
            client.messages.stream(REQUEST as never) as unknown as AsyncIterable<unknown>,
          );
        },
        source,
      ),
  };
}

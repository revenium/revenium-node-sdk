import OpenAI from "openai";
import { createReveniumConfig } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let CompletionsInterface: typeof import("../../../src/perplexity/middleware").CompletionsInterface;
let applyMeteringReply: typeof import("../../../src/_core/enforcement/metering-blocks").applyMeteringReply;

const TOKEN_USAGE = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
const REPORTED_COST = { input_tokens_cost: 0.011, output_tokens_cost: 0.003, total_cost: 0.014 };
const METERED_COST = { inputTokenCost: 0.011, outputTokenCost: 0.003, totalCost: 0.014 };
const METERED_TOKENS = { inputTokenCount: 11, outputTokenCount: 3, totalTokenCount: 14 };
const CHAT_REQUEST = { model: "sonar", messages: [{ role: "user" as const, content: "hi" }] };
const CONTENT_CHUNK = { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
const STOP_CHUNK = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const REPORTED_USAGE_CHUNK = { choices: [], usage: { ...TOKEN_USAGE, cost: REPORTED_COST } };

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function buildCompletions(create: jest.Mock): InstanceType<typeof CompletionsInterface> {
  return new CompletionsInterface(
    { chat: { completions: { create } } } as unknown as OpenAI,
    createReveniumConfig(),
  );
}

function chatCompletion(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-perplexity-metering-001",
    object: "chat.completion",
    model: "sonar",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage,
  };
}

function openStream(chunks: Record<string, unknown>[]): Promise<AsyncIterable<unknown>> {
  const create = jest.fn().mockImplementation(async function* () {
    yield* chunks;
  });
  return buildCompletions(create).createStreaming({ ...CHAT_REQUEST, stream: true });
}

async function meterChat(usage: Record<string, unknown>): Promise<void> {
  const create = jest.fn().mockResolvedValue(chatCompletion(usage));
  await buildCompletions(create).create(CHAT_REQUEST);
  await flushPromises();
}

beforeEach(async () => {
  jest.resetModules();

  const manager = await import("../../../src/_core/config/manager");
  const apiClient = await import("../../../src/_core/metering/api-client");
  const middleware = await import("../../../src/perplexity/middleware");
  const meteringBlocks = await import("../../../src/_core/enforcement/metering-blocks");

  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  sendToRevenium = apiClient.sendToRevenium;
  CompletionsInterface = middleware.CompletionsInterface;
  applyMeteringReply = meteringBlocks.applyMeteringReply;

  setConfig(createReveniumConfig());
});

afterEach(() => {
  resetConfig();
  jest.restoreAllMocks();
});

describe("Perplexity chat metering", () => {
  it("sends the Perplexity-reported cost on a non-streamed chat", async () => {
    await meterChat({ ...TOKEN_USAGE, cost: REPORTED_COST });

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        ...METERED_TOKENS,
        ...METERED_COST,
        isStreamed: false,
        middlewareSource: "revenium-perplexity-node",
      }),
      expect.anything(),
    );
  });

  it("omits the cost when Perplexity does not report one", async () => {
    await meterChat(TOKEN_USAGE);

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(jest.mocked(sendToRevenium).mock.calls[0][0]).not.toHaveProperty("totalCost");
  });

  it("sends the Perplexity-reported cost on a streamed chat", async () => {
    const stream = await openStream([CONTENT_CHUNK, STOP_CHUNK, REPORTED_USAGE_CHUNK]);
    for await (const _chunk of stream) {
      void _chunk;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ ...METERED_TOKENS, ...METERED_COST, isStreamed: true }),
      expect.anything(),
    );
  });

  it("sends the Perplexity-reported cost when the caller stops reading a streamed chat", async () => {
    const stream = await openStream([REPORTED_USAGE_CHUNK, CONTENT_CHUNK, STOP_CHUNK]);
    for await (const _chunk of stream) {
      void _chunk;
      break;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        ...METERED_TOKENS,
        ...METERED_COST,
        isStreamed: true,
        stopReason: "CANCELLED",
      }),
      expect.anything(),
    );
  });
});

describe("Perplexity cost limit directive", () => {
  const blockReply = {
    enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
  };
  const metadata = { subscriber: { id: "sub-1" } };

  async function blockFromMeteredScope(): Promise<void> {
    await flushPromises();
    const [, scope] = (sendToRevenium as jest.Mock).mock.calls[0];
    expect(scope).toMatchObject({ subscriberId: "sub-1", model: "sonar", provider: "Perplexity" });
    applyMeteringReply(createReveniumConfig().reveniumApiKey, scope, performance.now(), blockReply);
  }

  it("refuses the next chat for the scope the record was metered under", async () => {
    const create = jest.fn().mockResolvedValue(chatCompletion(TOKEN_USAGE));
    const completions = buildCompletions(create);

    await completions.create(CHAT_REQUEST, metadata);
    await blockFromMeteredScope();

    await expect(completions.create(CHAT_REQUEST, metadata)).rejects.toThrow("Daily cap reached");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses the next streamed chat for the scope the stream was metered under", async () => {
    const create = jest.fn().mockImplementation(async function* () {
      yield* [CONTENT_CHUNK, STOP_CHUNK];
    });
    const completions = buildCompletions(create);

    for await (const chunk of await completions.createStreaming(
      { ...CHAT_REQUEST, stream: true },
      metadata,
    )) {
      void chunk;
    }
    await blockFromMeteredScope();

    await expect(
      completions.createStreaming({ ...CHAT_REQUEST, stream: true }, metadata),
    ).rejects.toThrow("Daily cap reached");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

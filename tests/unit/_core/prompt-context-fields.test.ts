import { createReveniumConfig, createMockFetch } from "../../helpers/fixtures";
import type { PayloadParams } from "../../../src/_core/metering/payload-builder";
import type { UsageMetadata } from "../../../src/_core/types/index";

let buildPayload: typeof import("../../../src/_core/metering/payload-builder").buildPayload;
let buildAudioPayload: typeof import("../../../src/_core/metering/payload-builder").buildAudioPayload;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const originalFetch = global.fetch;

const PROMPT_CONTEXT_WIRE_FIELDS = [
  "effort",
  "promptId",
  "promptLength",
  "querySource",
  "speed",
  "subagentType",
];

const VALID_PROMPT_CONTEXT: UsageMetadata = {
  effort: "high",
  promptId: "prompt_7f3a-01",
  promptLength: 412,
  querySource: "repl_main_thread:sdk",
  speed: "fast",
  subagentType: "general-purpose.v2",
};

function createParams(usageMetadata?: UsageMetadata): PayloadParams {
  return {
    operationType: "CHAT",
    model: "claude-sonnet-4-20250514",
    startTime: Date.now() - 1000,
    duration: 1000,
    provider: "Anthropic",
    modelSource: "ANTHROPIC",
    middlewareSource: "revenium-anthropic-node",
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    stopReason: "end_turn",
    isStreamed: false,
    usageMetadata,
  };
}

async function meterCompletion(usageMetadata?: UsageMetadata): Promise<Record<string, unknown>> {
  const mockFetch = createMockFetch();
  global.fetch = mockFetch;

  await sendToRevenium(await buildPayload(createParams(usageMetadata)));

  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][0]).toContain("/ai/completions");
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

function silenceWarnings(): jest.SpyInstance {
  return jest.spyOn(console, "warn").mockImplementation(() => undefined);
}

beforeEach(async () => {
  jest.resetModules();
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const payloadBuilder = await import("../../../src/_core/metering/payload-builder");
  const client = await import("../../../src/_core/metering/api-client");

  buildPayload = payloadBuilder.buildPayload;
  buildAudioPayload = payloadBuilder.buildAudioPayload;
  sendToRevenium = client.sendToRevenium;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;

  setConfig(createReveniumConfig());
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  delete process.env.AWS_REGION;
  resetConfig();
});

describe("prompt context on the completions body", () => {
  it("sends all six prompt context fields as camelCase", async () => {
    const body = await meterCompletion(VALID_PROMPT_CONTEXT);

    expect(body).toHaveProperty("effort", "high");
    expect(body).toHaveProperty("promptId", "prompt_7f3a-01");
    expect(body).toHaveProperty("promptLength", 412);
    expect(body).toHaveProperty("querySource", "repl_main_thread:sdk");
    expect(body).toHaveProperty("speed", "fast");
    expect(body).toHaveProperty("subagentType", "general-purpose.v2");
  });

  it("accepts the snake_case aliases and still writes camelCase to the wire", async () => {
    const body = await meterCompletion({
      prompt_id: "prompt-01",
      prompt_length: 99,
      query_source: "sdk",
      subagent_type: "explore",
    });

    expect(body).toHaveProperty("promptId", "prompt-01");
    expect(body).toHaveProperty("promptLength", 99);
    expect(body).toHaveProperty("querySource", "sdk");
    expect(body).toHaveProperty("subagentType", "explore");
    expect(body).not.toHaveProperty("prompt_id");
    expect(body).not.toHaveProperty("prompt_length");
    expect(body).not.toHaveProperty("query_source");
    expect(body).not.toHaveProperty("subagent_type");
  });

  it("prefers the camelCase field when both casings are set", async () => {
    const body = await meterCompletion({ promptId: "from-camel-case", prompt_id: "from-snake" });

    expect(body).toHaveProperty("promptId", "from-camel-case");
  });

  it("drops a rejected camelCase value with a warning instead of falling back to snake_case", async () => {
    const warn = silenceWarnings();

    const body = await meterCompletion({ promptId: "", prompt_id: "from-snake" });

    expect(body).not.toHaveProperty("promptId");
    expect(warn).toHaveBeenCalledWith(expect.any(String), { field: "promptId" });
  });

  it("sends the prompt context on embedding records", async () => {
    const payload = await buildPayload({
      ...createParams(VALID_PROMPT_CONTEXT),
      operationType: "EMBED",
    });

    expect(payload).toMatchObject(VALID_PROMPT_CONTEXT);
  });

  it("sends a promptLength of zero", async () => {
    const body = await meterCompletion({ promptLength: 0 });

    expect(body).toHaveProperty("promptLength", 0);
  });

  it("sends only the prompt context fields the caller set", async () => {
    const body = await meterCompletion({ taskType: "synthesis", effort: "high" });

    expect(body).toHaveProperty("taskType", "synthesis");
    expect(body).toHaveProperty("effort", "high");
    for (const field of PROMPT_CONTEXT_WIRE_FIELDS.filter((field) => field !== "effort")) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("omits every prompt context field from a call without usageMetadata", async () => {
    const withPromptContext = await meterCompletion(VALID_PROMPT_CONTEXT);
    const withoutMetadata = await meterCompletion();

    expect(withPromptContext).toMatchObject(VALID_PROMPT_CONTEXT);
    for (const field of PROMPT_CONTEXT_WIRE_FIELDS) {
      expect(withoutMetadata).not.toHaveProperty(field);
    }
  });
});

describe("prompt context values the platform would reject", () => {
  it("drops the invalid field, warns with the field name only and still sends the record", async () => {
    const warn = silenceWarnings();

    const body = await meterCompletion({ effort: "very high", promptId: "prompt-01" });

    expect(body).not.toHaveProperty("effort");
    expect(body).toHaveProperty("promptId", "prompt-01");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("effort"), { field: "effort" });
    expect(warn.mock.calls[0][0]).not.toContain("very high");
  });

  it("treats null as absent without warning", async () => {
    const warn = silenceWarnings();

    const body = await meterCompletion({ effort: null, speed: "fast" } as unknown as UsageMetadata);

    expect(body).not.toHaveProperty("effort");
    expect(body).toHaveProperty("speed", "fast");
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an empty string with a warning", async () => {
    const warn = silenceWarnings();

    const body = await meterCompletion({ querySource: "" });

    expect(body).not.toHaveProperty("querySource");
    expect(warn).toHaveBeenCalledWith(expect.any(String), { field: "querySource" });
  });

  it("drops a number sent in a text field by an untyped caller", async () => {
    const warn = silenceWarnings();

    const body = await meterCompletion({ speed: 1.5 } as unknown as UsageMetadata);

    expect(body).not.toHaveProperty("speed");
    expect(warn).toHaveBeenCalledWith(expect.any(String), { field: "speed" });
  });

  it.each([
    ["effort", 16],
    ["speed", 16],
    ["promptId", 64],
    ["querySource", 128],
    ["subagentType", 128],
  ])("accepts %s at %i characters and drops it one character over", async (field, maxLength) => {
    silenceWarnings();

    const atLimit = await meterCompletion({ [field]: "x".repeat(maxLength) });
    const overLimit = await meterCompletion({ [field]: "x".repeat(maxLength + 1) });

    expect(atLimit).toHaveProperty(field, "x".repeat(maxLength));
    expect(overLimit).not.toHaveProperty(field);
  });

  it("drops the characters only querySource and subagentType allow from effort, speed and promptId", async () => {
    silenceWarnings();

    const body = await meterCompletion({
      effort: "high.v2",
      speed: "fast:1",
      promptId: "prompt.01",
      querySource: "repl.main:sdk",
    });

    expect(body).not.toHaveProperty("effort");
    expect(body).not.toHaveProperty("speed");
    expect(body).not.toHaveProperty("promptId");
    expect(body).toHaveProperty("querySource", "repl.main:sdk");
  });

  it("accepts promptLength at the backend integer limit", async () => {
    const body = await meterCompletion({ promptLength: 2147483647 });

    expect(body).toHaveProperty("promptLength", 2147483647);
  });

  it.each([2147483648, 1.5, -1])("drops promptLength %p with a warning", async (promptLength) => {
    const warn = silenceWarnings();

    const body = await meterCompletion({ promptLength });

    expect(body).not.toHaveProperty("promptLength");
    expect(warn).toHaveBeenCalledWith(expect.any(String), { field: "promptLength" });
  });
});

describe("prompt context outside completions", () => {
  it("puts the caller's speed and effort on chat records but never on an audio record", async () => {
    const chatPayload = await buildPayload(createParams({ speed: "fast", effort: "high" }));
    const payload = buildAudioPayload(
      "tts",
      {},
      { model: "tts-1", input: "hello", voice: "alloy", speed: 1.25 },
      Date.now() - 1000,
      1000,
      "OpenAI",
      "OPENAI",
      "revenium-openai-node",
      { speed: "fast", effort: "high" },
    );

    expect(chatPayload).toMatchObject({ speed: "fast", effort: "high" });
    expect(payload).not.toHaveProperty("speed");
    expect(payload).not.toHaveProperty("effort");
    expect(payload.attributes).toHaveProperty("speed", 1.25);
  });
});

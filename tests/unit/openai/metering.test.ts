import OpenAI from "openai";
import { createMockFetch, createReveniumConfig } from "../../helpers/fixtures";
import type { UsageMetadata } from "../../../src/_core/types/index";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let CompletionsInterface: typeof import("../../../src/openai/middleware").CompletionsInterface;
let EmbeddingsInterface: typeof import("../../../src/openai/middleware").EmbeddingsInterface;
let ResponsesInterface: typeof import("../../../src/openai/middleware").ResponsesInterface;
let DecisionsInterface: typeof import("../../../src/openai/decisions").DecisionsInterface;
let ReveniumOpenAI: typeof import("../../../src/openai/client").ReveniumOpenAI;
let trackImageUsageAsync: typeof import("../../../src/openai/middleware").trackImageUsageAsync;
let trackAudioUsageAsync: typeof import("../../../src/openai/middleware").trackAudioUsageAsync;
let Provider: typeof import("../../../src/openai/provider-detection").Provider;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function openAIClient(client: Record<string, unknown>): OpenAI {
  return client as unknown as OpenAI;
}

beforeEach(async () => {
  jest.resetModules();

  const manager = await import("../../../src/_core/config/manager");
  const apiClient = await import("../../../src/_core/metering/api-client");
  const middleware = await import("../../../src/openai/middleware");
  const decisions = await import("../../../src/openai/decisions");
  const clientModule = await import("../../../src/openai/client");
  const providerDetection = await import("../../../src/openai/provider-detection");

  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  sendToRevenium = apiClient.sendToRevenium;
  CompletionsInterface = middleware.CompletionsInterface;
  EmbeddingsInterface = middleware.EmbeddingsInterface;
  ResponsesInterface = middleware.ResponsesInterface;
  DecisionsInterface = decisions.DecisionsInterface;
  ReveniumOpenAI = clientModule.ReveniumOpenAI;
  trackImageUsageAsync = middleware.trackImageUsageAsync;
  trackAudioUsageAsync = middleware.trackAudioUsageAsync;
  Provider = providerDetection.Provider;

  setConfig(createReveniumConfig());
});

afterEach(() => {
  resetConfig();
  jest.restoreAllMocks();
});

describe("OpenAI chat metering", () => {
  it("meters a non-streamed chat with the tokens the provider reported", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl-metering-001",
      model: "gpt-4.1-nano-2025-04-14",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    });
    const completions = new CompletionsInterface(
      openAIClient({ chat: { completions: { create } } }),
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );

    await completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
    });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "CHAT",
        model: "gpt-4.1-nano-2025-04-14",
        inputTokenCount: 15,
        outputTokenCount: 5,
        totalTokenCount: 20,
        stopReason: "END",
        isStreamed: false,
      }),
      expect.anything(),
    );
  });
});

describe("OpenAI structured-output parse metering", () => {
  it("meters chat.completions.parse with the tokens the provider reported", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl-parse-001",
      model: "gpt-4.1-nano-2025-04-14",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"answer":"hi"}' },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 5,
        total_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
    const completions = new CompletionsInterface(
      openAIClient({ chat: { completions: { create } } }),
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );

    await completions.parse({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hello" }],
    });
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "chatcmpl-parse-001",
        inputTokenCount: 15,
        outputTokenCount: 5,
        totalTokenCount: 20,
        reasoningTokenCount: 3,
      }),
      expect.anything(),
    );
  });

  it("meters responses.parse once with its response id", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp-parse-001",
      model: "gpt-4o-mini",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 55 },
      },
    });
    const responses = new ResponsesInterface(
      openAIClient({ responses: { create } }),
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );

    await responses.parse({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp-parse-001",
        inputTokenCount: 120,
        cacheReadTokenCount: 55,
      }),
      expect.anything(),
    );
  });
});

describe("OpenAI Decisions metering", () => {
  const decision = {
    model: "gpt-6-luna",
    answers: [{ type: "predicate", name: "is_spam", probability: 0.02 }],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 12 },
      output_tokens_details: { reasoning_tokens: 7 },
    },
  };
  const decisionParams = {
    model: "gpt-6-luna",
    input: "Buy cheap watches now",
    questions: [{ type: "predicate", name: "is_spam", instructions: "Is this spam?" }],
  };

  function decisionsFor(client: Record<string, unknown>) {
    return new DecisionsInterface(openAIClient(client), createReveniumConfig(), {
      provider: Provider.OPENAI,
      isAzure: false,
    });
  }

  it("meters a decision with cached, cache-write and reasoning tokens", async () => {
    const create = jest.fn().mockResolvedValue(decision);

    await decisionsFor({ decisions: { create } }).create(decisionParams);
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "CHAT",
        model: "gpt-6-luna",
        inputTokenCount: 100,
        outputTokenCount: 10,
        totalTokenCount: 110,
        cacheReadTokenCount: 40,
        cacheCreationTokenCount: 12,
        reasoningTokenCount: 7,
        stopReason: "END",
      }),
      expect.anything(),
    );
  });

  it("throws a clear error and sends nothing when the OpenAI SDK has no decisions resource", async () => {
    await decisionsFor({ decisions: { create: jest.fn().mockResolvedValue(decision) } }).create(
      decisionParams,
    );
    await flushPromises();
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    jest.mocked(sendToRevenium).mockClear();

    await expect(decisionsFor({}).create(decisionParams)).rejects.toThrow(
      "Decisions API not available in this OpenAI SDK version (requires openai >= 7.30.0)",
    );
    await flushPromises();

    expect(sendToRevenium).not.toHaveBeenCalled();
  });

  it("records a failed decision as an error with zero tokens", async () => {
    const create = jest.fn().mockRejectedValue(new Error("upstream unavailable"));

    await expect(decisionsFor({ decisions: { create } }).create(decisionParams)).rejects.toThrow(
      "upstream unavailable",
    );
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-luna",
        inputTokenCount: 0,
        outputTokenCount: 0,
        totalTokenCount: 0,
        stopReason: "ERROR",
      }),
      expect.anything(),
    );
  });
});

describe("OpenAI structured outputs and Decisions through the Revenium client and the openai SDK", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function serveOpenAI(body: unknown): void {
    global.fetch = createMockFetch({
      jsonBody: body,
      headers: { "content-type": "application/json" },
    });
  }

  function reveniumClient() {
    return new ReveniumOpenAI(
      { ...createReveniumConfig(), openaiApiKey: "sk-test" },
      Provider.OPENAI,
    );
  }

  const answerFormat = {
    type: "json_schema" as const,
    name: "answer",
    strict: true,
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  };

  function chatCompletion(finishReason: string) {
    return {
      id: "chatcmpl-sdk-parse",
      object: "chat.completion",
      created: 1767225600,
      model: "gpt-4o-2024-08-06",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"answer":"hi"}', refusal: null },
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 21, completion_tokens: 6, total_tokens: 27 },
    };
  }

  it("returns the parsed chat completion and meters its tokens", async () => {
    serveOpenAI(chatCompletion("stop"));

    const completion = await reveniumClient()
      .chat()
      .completions()
      .parse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "json_schema", json_schema: answerFormat },
      });
    await flushPromises();

    expect(completion.choices[0].message.parsed).toEqual({ answer: "hi" });
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "chatcmpl-sdk-parse",
        model: "gpt-4o-2024-08-06",
        inputTokenCount: 21,
        outputTokenCount: 6,
        totalTokenCount: 27,
        stopReason: "END",
      }),
      expect.anything(),
    );
  });

  it("meters the tokens of a chat parse cut at the length limit and rethrows the parse error", async () => {
    serveOpenAI(chatCompletion("length"));

    await expect(
      reveniumClient()
        .chat()
        .completions()
        .parse({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          response_format: { type: "json_schema", json_schema: answerFormat },
        }),
    ).rejects.toThrow("Could not parse response content as the length limit was reached");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "chatcmpl-sdk-parse",
        inputTokenCount: 21,
        outputTokenCount: 6,
        totalTokenCount: 27,
        stopReason: "TOKEN_LIMIT",
      }),
      expect.anything(),
    );
  });

  function parsedResponse(outputText: string) {
    return {
      id: "resp-sdk-parse",
      object: "response",
      created_at: 1767225600,
      status: "completed",
      model: "gpt-4o-mini-2024-07-18",
      output: [
        {
          type: "message",
          id: "msg_1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: outputText, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 16 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 48,
      },
    };
  }

  it("returns the parsed Responses output and meters its tokens", async () => {
    serveOpenAI(parsedResponse('{"answer":"hi"}'));

    const response = await reveniumClient()
      .responses()
      .parse({
        model: "gpt-4o-mini",
        input: "hello",
        text: { format: answerFormat },
      });
    await flushPromises();

    expect(response.output_parsed).toEqual({ answer: "hi" });
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp-sdk-parse",
        inputTokenCount: 40,
        outputTokenCount: 8,
        totalTokenCount: 48,
        cacheReadTokenCount: 16,
      }),
      expect.anything(),
    );
  });

  it("meters the tokens of a Responses parse whose output is not valid JSON and rethrows the parse error", async () => {
    serveOpenAI(parsedResponse('{"answer":'));

    await expect(
      reveniumClient()
        .responses()
        .parse({
          model: "gpt-4o-mini",
          input: "hello",
          text: { format: answerFormat },
        }),
    ).rejects.toThrow(SyntaxError);
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp-sdk-parse",
        inputTokenCount: 40,
        outputTokenCount: 8,
        totalTokenCount: 48,
      }),
      expect.anything(),
    );
  });

  it("refuses a decision when the openai SDK has no decisions resource and sends nothing", async () => {
    serveOpenAI({});
    const client = reveniumClient();
    delete (client.getUnderlyingClient() as { decisions?: unknown }).decisions;

    await expect(
      client.decisions().create({
        model: "gpt-6-luna",
        input: "Buy cheap watches now",
        questions: [{ type: "predicate", name: "is_spam", instructions: "Is this spam?" }],
      }),
    ).rejects.toThrow(
      "Decisions API not available in this OpenAI SDK version (requires openai >= 7.30.0)",
    );
    await flushPromises();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendToRevenium).not.toHaveBeenCalled();
  });
});

describe("OpenAI embeddings metering", () => {
  it("meters an embeddings call with its input tokens", async () => {
    const create = jest.fn().mockResolvedValue({
      object: "list",
      model: "text-embedding-3-small",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
    const embeddings = new EmbeddingsInterface(
      openAIClient({ embeddings: { create } }),
      createReveniumConfig(),
      { provider: Provider.OPENAI, isAzure: false },
    );

    await embeddings.create({ model: "text-embedding-3-small", input: "hello" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "EMBED",
        inputTokenCount: 8,
        totalTokenCount: 8,
      }),
      expect.anything(),
    );
  });
});

describe("OpenAI media record environment defaults", () => {
  const MEDIA_ENV_KEYS = [
    "AWS_REGION",
    "AZURE_REGION",
    "GCP_REGION",
    "REVENIUM_REGION",
    "REVENIUM_TICKET_ID",
  ];
  let savedMediaEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedMediaEnv = Object.fromEntries(MEDIA_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of MEDIA_ENV_KEYS) delete process.env[key];
    process.env.REVENIUM_REGION = "eu-west-1";
    process.env.REVENIUM_TICKET_ID = "ENG-123";
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const key of MEDIA_ENV_KEYS) {
      if (savedMediaEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedMediaEnv[key];
    }
  });

  function trackImageAndSpeech(isAzure: boolean, metadata?: UsageMetadata): void {
    const providerInfo = {
      provider: isAzure ? Provider.AZURE_OPENAI : Provider.OPENAI,
      isAzure,
    };
    trackImageUsageAsync(
      "generation",
      { data: [{ url: "https://example.com/1.png" }] },
      { model: "dall-e-3", prompt: "a cat" },
      Date.now() - 1000,
      1000,
      {},
      providerInfo,
      metadata,
    );
    trackAudioUsageAsync(
      "tts",
      {},
      { model: "tts-1", input: "hello", voice: "alloy" },
      Date.now() - 1000,
      1000,
      {},
      providerInfo,
      metadata,
    );
  }

  async function meterImageAndSpeech(
    isAzure: boolean,
    metadata?: UsageMetadata,
  ): Promise<unknown[]> {
    trackImageAndSpeech(isAzure, metadata);
    await flushPromises();

    return jest
      .mocked(sendToRevenium)
      .mock.calls.map(([payload]) => ({ region: payload.region, ticketId: payload.ticketId }));
  }

  it("reports the environment ticket and server region on OpenAI image and audio records, like chat", async () => {
    const expected = { region: "eu-west-1", ticketId: "ENG-123" };

    expect(await meterImageAndSpeech(false)).toEqual([expected, expected]);
  });

  it("reports the environment ticket but no server region on Azure OpenAI image and audio records", async () => {
    const expected = { region: undefined, ticketId: "ENG-123" };

    expect(await meterImageAndSpeech(true)).toEqual([expected, expected]);
  });

  it("keeps the caller's region on OpenAI image and audio records without looking up the server region", async () => {
    delete process.env.REVENIUM_REGION;
    const regionLookup = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("no instance metadata service"));
    const expected = { region: "europe-west4", ticketId: "ENG-123" };

    expect(await meterImageAndSpeech(false, { region: "europe-west4" })).toEqual([
      expected,
      expected,
    ]);
    expect(regionLookup).not.toHaveBeenCalled();
  });

  it("stamps OpenAI image and audio records when the response arrives, not when the server region lookup ends", async () => {
    delete process.env.REVENIUM_REGION;
    let answerRegionLookup!: () => void;
    const regionLookupAnswered = new Promise<void>((resolve) => {
      answerRegionLookup = resolve;
    });
    jest.spyOn(global, "fetch").mockImplementation(async () => {
      await regionLookupAnswered;
      return { text: async () => "us-west-2" } as Response;
    });
    const responseArrived = new Date("2026-10-29T12:00:00.000Z");
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"], now: responseArrived });

    trackImageAndSpeech(false);
    jest.setSystemTime(responseArrived.getTime() + 900);
    answerRegionLookup();
    await flushPromises();

    const expected = { responseTime: responseArrived.toISOString(), region: "us-west-2" };
    expect(
      jest.mocked(sendToRevenium).mock.calls.map(([payload]) => ({
        responseTime: payload.responseTime,
        region: payload.region,
      })),
    ).toEqual([expected, expected]);
  });
});

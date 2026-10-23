import { Stream } from "openai/core/streaming";
import { createReveniumConfig } from "../../helpers/fixtures";
import {
  isTerminalResponseStatus,
  mapResponsesStatusToStopReason,
  RESPONSES_STOP_REASONS,
  TERMINAL_RESPONSE_EVENTS,
} from "../../../src/openai/responses-stop-reason";
import { isStopReasonSupported } from "../../../src/_core/stop-reason-mapper";
import { getMaxPromptSize } from "../../../src/_core/prompt/extraction";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let setLogger: typeof import("../../../src/_core/config/manager").setLogger;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let ResponsesInterface: typeof import("../../../src/openai/middleware").ResponsesInterface;
let Provider: typeof import("../../../src/openai/provider-detection").Provider;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("mapResponsesStatusToStopReason", () => {
  it.each([
    ["completed", undefined, "stop"],
    ["incomplete", "max_output_tokens", "length"],
    ["incomplete", "max_messages", "completion_limit"],
    ["incomplete", "content_filter", "content_filter"],
    ["incomplete", "steered", "stop"],
    ["incomplete", undefined, "stop"],
    ["incomplete", "some_future_reason", "stop"],
    ["failed", undefined, "error"],
    ["cancelled", undefined, "cancelled"],
    ["COMPLETED", undefined, "stop"],
    ["queued", undefined, "stop"],
    ["in_progress", undefined, "stop"],
  ])("maps status '%s' with reason '%s' to '%s'", (status, reason, expected) => {
    expect(mapResponsesStatusToStopReason(status, reason)).toBe(expected);
  });

  it("returns null without warning when the status is absent", () => {
    const logger = { warn: jest.fn() };

    expect(mapResponsesStatusToStopReason(undefined, undefined, logger)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when an incomplete response carries an unrecognized reason", () => {
    const logger = { warn: jest.fn() };

    mapResponsesStatusToStopReason("incomplete", "some_future_reason", logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ incompleteReason: "some_future_reason", stopReason: "stop" }),
    );
  });

  it("does not warn on a completed response", () => {
    const logger = { warn: jest.fn() };

    mapResponsesStatusToStopReason("completed", undefined, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("emits only stop reasons the shared mapper understands", () => {
    for (const stopReason of RESPONSES_STOP_REASONS) {
      expect(isStopReasonSupported(stopReason)).toBe(true);
    }
  });

  it.each([
    ["completed", true],
    ["incomplete", true],
    ["failed", true],
    ["cancelled", true],
    ["queued", false],
    ["in_progress", false],
    [undefined, true],
  ])("reports status '%s' as terminal: %s", (status, expected) => {
    expect(isTerminalResponseStatus(status)).toBe(expected);
  });

  it("treats every terminal status as a terminal stream event", () => {
    expect([...TERMINAL_RESPONSE_EVENTS].sort()).toEqual([
      "response.cancelled",
      "response.completed",
      "response.failed",
      "response.incomplete",
    ]);
  });
});

describe("ResponsesInterface stop reason metering", () => {
  const warn = jest.fn();

  function buildResponse(
    status: string,
    incompleteReason?: string,
    usage: Record<string, number> | null = { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  ): Record<string, unknown> {
    return {
      id: "resp-stop-001",
      model: "gpt-4o-mini",
      status,
      incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
      usage: usage ?? undefined,
    };
  }

  function buildInterfaceFor(
    responses: Record<string, jest.Mock>,
  ): InstanceType<typeof ResponsesInterface> {
    return new ResponsesInterface({ responses } as any, createReveniumConfig(), {
      provider: Provider.OPENAI,
      isAzure: false,
    });
  }

  function buildInterface(create: jest.Mock): InstanceType<typeof ResponsesInterface> {
    return buildInterfaceFor({ create });
  }

  function buildCollectingInterface(retrieve: jest.Mock): InstanceType<typeof ResponsesInterface> {
    return buildInterfaceFor({ create: jest.fn(), retrieve });
  }

  beforeEach(async () => {
    jest.resetModules();

    const manager = await import("../../../src/_core/config/manager");
    const apiClient = await import("../../../src/_core/metering/api-client");
    const middleware = await import("../../../src/openai/middleware");
    const providerDetection = await import("../../../src/openai/provider-detection");

    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;
    setLogger = manager.setLogger;
    sendToRevenium = apiClient.sendToRevenium;
    ResponsesInterface = middleware.ResponsesInterface;
    Provider = providerDetection.Provider;

    setConfig(createReveniumConfig());
    warn.mockClear();
    setLogger({ debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() });
    jest.mocked(sendToRevenium).mockClear();
  });

  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  const STATUS_TO_STREAM_EVENT: Record<string, string> = {
    completed: "response.completed",
    incomplete: "response.incomplete",
    failed: "response.failed",
  };

  const cases: Array<[string, string | undefined, string]> = [
    ["completed", undefined, "END"],
    ["incomplete", "max_output_tokens", "TOKEN_LIMIT"],
    ["incomplete", "max_messages", "COMPLETION_LIMIT"],
    ["incomplete", "content_filter", "CONTENT_FILTER"],
    ["failed", undefined, "ERROR"],
  ];

  it.each(cases)(
    "meters a non-streaming '%s' response with reason '%s' as '%s'",
    async (status, incompleteReason, expected) => {
      const create = jest.fn().mockResolvedValue(buildResponse(status, incompleteReason));

      await buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" });
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: expected }),
      );
    },
  );

  it.each(cases)(
    "meters a streaming '%s' response with reason '%s' as '%s'",
    async (status, incompleteReason, expected) => {
      const response = buildResponse(status, incompleteReason);

      async function* stream() {
        yield { type: "response.output_text.delta", delta: "hel" };
        yield { type: "response.output_text.delta", delta: "lo" };
        yield { type: STATUS_TO_STREAM_EVENT[status], response };
      }

      const create = jest.fn().mockResolvedValue(stream());
      const responseStream = await buildInterface(create).createStreaming({
        model: "gpt-4o-mini",
        input: "hello",
      });

      for await (const chunk of responseStream as AsyncIterable<unknown>) {
        expect(chunk).toBeDefined();
      }
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: expected }),
      );
    },
  );

  it("accumulates streamed text into the metered output when prompt capture is on", async () => {
    async function* stream() {
      yield { type: "response.output_text.delta", delta: "hel" };
      yield { type: "response.output_text.delta", delta: "lo" };
      yield { type: "response.completed", response: buildResponse("completed") };
    }

    const create = jest.fn().mockResolvedValue(stream());
    const responseStream = await buildInterface(create).createStreaming(
      { model: "gpt-4o-mini", input: "hello" },
      { capturePrompts: true },
    );

    for await (const chunk of responseStream as AsyncIterable<unknown>) {
      expect(chunk).toBeDefined();
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ outputResponse: "hello" }),
    );
  });

  it("meters a failed non-streaming call as ERROR when the provider throws", async () => {
    const create = jest.fn().mockRejectedValue(new Error("upstream failure"));

    await expect(
      buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" }),
    ).rejects.toThrow("upstream failure");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "ERROR", model: "gpt-4o-mini" }),
    );
  });

  it("meters a failed response with no usage as ERROR", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp-stop-002",
      model: "gpt-4o-mini",
      status: "failed",
      incomplete_details: null,
    });

    await buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "ERROR", totalTokenCount: 0 }),
    );
  });

  it("does not meter a background response that is still queued", async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: "resp-stop-003", model: "gpt-4o-mini", status: "queued" });

    await buildInterface(create).create({
      model: "gpt-4o-mini",
      input: "hello",
      background: true,
    });
    await flushPromises();

    expect(sendToRevenium).not.toHaveBeenCalled();
  });

  it("meters a collected background response exactly once", async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "queued" });
    const retrieve = jest.fn().mockResolvedValue({
      id: "resp_stub",
      model: "gpt-4o-mini",
      status: "completed",
      usage: { input_tokens: 333, output_tokens: 44, total_tokens: 377 },
    });
    const responses = buildInterfaceFor({ create, retrieve });

    await responses.create({ model: "gpt-4o-mini", input: "hello", background: true });
    await responses.retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp_stub",
        inputTokenCount: 333,
        outputTokenCount: 44,
        stopReason: "END",
      }),
    );
  });

  it("does not meter a second collection of the same response", async () => {
    const retrieve = jest.fn().mockResolvedValue({
      id: "resp_stub",
      model: "gpt-4o-mini",
      status: "completed",
      usage: { input_tokens: 333, output_tokens: 44, total_tokens: 377 },
    });
    const responses = buildCollectingInterface(retrieve);

    await responses.retrieve("resp_stub");
    await responses.retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
  });

  it("meters a response without a status", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp_stub",
      model: "gpt-4o-mini",
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    });

    await buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "resp_stub",
        inputTokenCount: 12,
        outputTokenCount: 3,
      }),
    );
  });

  it("does not meter a collection of a response already metered by its create", async () => {
    const completed = {
      id: "resp_stub",
      model: "gpt-4o-mini",
      status: "completed",
      usage: { input_tokens: 333, output_tokens: 44, total_tokens: 377 },
    };
    const responses = buildInterfaceFor({
      create: jest.fn().mockResolvedValue(completed),
      retrieve: jest.fn().mockResolvedValue(completed),
    });

    await responses.create({ model: "gpt-4o-mini", input: "hello" });
    await responses.retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
  });

  it("sends the response-derived idempotency key from create as well", async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" });

    await buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "openai-response-resp_stub" }),
    );
  });

  it("carries the metadata given at create into the collected record", async () => {
    const responses = buildInterfaceFor({
      create: jest
        .fn()
        .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "queued" }),
      retrieve: jest
        .fn()
        .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" }),
    });

    await responses.create(
      { model: "gpt-4o-mini", input: "hello", background: true },
      { organizationName: "org_1", traceId: "trace_1" },
    );
    await responses.retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ organizationName: "org_1", traceId: "trace_1" }),
    );
  });

  it("lets collection metadata override the metadata given at create", async () => {
    const responses = buildInterfaceFor({
      create: jest
        .fn()
        .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "queued" }),
      retrieve: jest
        .fn()
        .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" }),
    });

    await responses.create(
      { model: "gpt-4o-mini", input: "hello", background: true },
      { organizationName: "org_1" },
    );
    await responses.retrieve("resp_stub", { organizationName: "org_2" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ organizationName: "org_2" }),
    );
  });

  it("reports the job wall time as the duration of a collected response", async () => {
    const retrieve = jest.fn().mockResolvedValue({
      id: "resp_stub",
      model: "gpt-4o-mini",
      status: "completed",
      created_at: 1_700_000_000,
      completed_at: 1_700_000_030,
    });

    await buildCollectingInterface(retrieve).retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ requestDuration: 30_000 }),
    );
  });

  it("falls back to the collection latency when the job has no timestamps", async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" });

    await buildCollectingInterface(retrieve).retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ requestDuration: expect.any(Number) }),
    );
    const [[payload]] = jest.mocked(sendToRevenium).mock.calls;
    expect(payload.requestDuration).toBeLessThan(5_000);
  });

  it("allows a later collection when the metering delivery failed", async () => {
    jest.mocked(sendToRevenium).mockRejectedValueOnce(new Error("metering down"));
    const retrieve = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" });
    const responses = buildCollectingInterface(retrieve);

    await responses.retrieve("resp_stub");
    await flushPromises();
    await responses.retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(2);
  });

  it("does not meter a response that is still in progress", async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "in_progress" });

    await buildCollectingInterface(retrieve).retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "ERROR"],
    ["cancelled", "CANCELLED"],
  ])("records a collected '%s' background response as '%s'", async (status, expected) => {
    const retrieve = jest.fn().mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status });

    await buildCollectingInterface(retrieve).retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ stopReason: expected }));
  });

  it("does not meter when retrieve itself throws", async () => {
    const retrieve = jest.fn().mockRejectedValue(new Error("collection failure"));

    await expect(buildCollectingInterface(retrieve).retrieve("resp_stub")).rejects.toThrow(
      "collection failure",
    );
    await flushPromises();

    expect(sendToRevenium).not.toHaveBeenCalled();
  });

  it("sends an idempotency key derived from the response id", async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" });

    await buildCollectingInterface(retrieve).retrieve("resp_stub");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "openai-response-resp_stub" }),
    );
  });

  it("keeps an explicit idempotency key supplied by the caller", async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValue({ id: "resp_stub", model: "gpt-4o-mini", status: "completed" });

    await buildCollectingInterface(retrieve).retrieve("resp_stub", {
      idempotencyKey: "caller-key",
    });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "caller-key" }),
    );
  });

  it("reports reasoning tokens on a non-streaming response", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp-stop-004",
      model: "gpt-4o-mini",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        output_tokens_details: { reasoning_tokens: 12 },
      },
    });

    await buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningTokenCount: 12 }),
    );
  });

  it("meters a stream that throws mid-flight as ERROR", async () => {
    async function* stream() {
      yield { type: "response.output_text.delta", delta: "hi" };
      throw new Error("stream broke");
    }

    const create = jest.fn().mockResolvedValue(stream());
    const responseStream = await buildInterface(create).createStreaming({
      model: "gpt-4o-mini",
      input: "hello",
    });

    await expect(
      (async () => {
        for await (const chunk of responseStream as AsyncIterable<unknown>) {
          expect(chunk).toBeDefined();
        }
      })(),
    ).rejects.toThrow("stream broke");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "ERROR" }));
  });

  it("meters an abandoned stream as CANCELLED", async () => {
    async function* stream() {
      yield { type: "response.output_text.delta", delta: "hi" };
      yield { type: "response.completed", response: buildResponse("completed") };
    }

    const create = jest.fn().mockResolvedValue(stream());
    const responseStream = await buildInterface(create).createStreaming({
      model: "gpt-4o-mini",
      input: "hello",
    });

    for await (const chunk of responseStream as AsyncIterable<unknown>) {
      expect(chunk).toBeDefined();
      break;
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "CANCELLED" }),
    );
  });

  it.each(cases)(
    "keeps the '%s' reason '%s' as '%s' when the stream is abandoned after the terminal event",
    async (status, incompleteReason, expected) => {
      const response = buildResponse(status, incompleteReason);

      async function* stream() {
        yield { type: "response.output_text.delta", delta: "hi" };
        yield { type: STATUS_TO_STREAM_EVENT[status], response };
      }

      const create = jest.fn().mockResolvedValue(stream());
      const responseStream = await buildInterface(create).createStreaming({
        model: "gpt-4o-mini",
        input: "hello",
      });

      for await (const chunk of responseStream as AsyncIterable<Record<string, unknown>>) {
        if (chunk.type === STATUS_TO_STREAM_EVENT[status]) break;
      }
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: expected }),
      );
    },
  );

  it("redacts a credential that straddles the capture limit", async () => {
    const secret = `sk-proj-${"B".repeat(48)}`;

    async function* stream() {
      yield { type: "response.output_text.delta", delta: "x".repeat(getMaxPromptSize() - 10) };
      yield { type: "response.output_text.delta", delta: secret };
      yield { type: "response.completed", response: buildResponse("completed") };
    }

    const create = jest.fn().mockResolvedValue(stream());
    const responseStream = await buildInterface(create).createStreaming(
      { model: "gpt-4o-mini", input: "hello" },
      { capturePrompts: true },
    );

    for await (const chunk of responseStream as AsyncIterable<unknown>) {
      expect(chunk).toBeDefined();
    }
    await flushPromises();

    const sent = JSON.stringify(jest.mocked(sendToRevenium).mock.calls);
    expect(sent).not.toContain("sk-proj-B");
  });

  it("reports time to first token on a streamed response", async () => {
    async function* stream() {
      yield { type: "response.output_text.delta", delta: "hi" };
      yield { type: "response.completed", response: buildResponse("completed") };
    }

    const create = jest.fn().mockResolvedValue(stream());
    const responseStream = await buildInterface(create).createStreaming({
      model: "gpt-4o-mini",
      input: "hello",
    });

    for await (const chunk of responseStream as AsyncIterable<unknown>) {
      expect(chunk).toBeDefined();
    }
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ timeToFirstToken: expect.any(Number) }),
    );
  });

  it("meters a streaming request rejected before iteration as ERROR", async () => {
    const create = jest.fn().mockRejectedValue(new Error("stream rejected"));

    await expect(
      buildInterface(create).createStreaming({ model: "gpt-4o-mini", input: "hello" }),
    ).rejects.toThrow("stream rejected");
    await flushPromises();

    expect(sendToRevenium).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "ERROR", model: "gpt-4o-mini" }),
    );
  });

  describe("create with stream: true", () => {
    const streamedUsage = { input_tokens: 333, output_tokens: 44, total_tokens: 377 };

    function buildEventStream(usage: Record<string, number> | null): AsyncGenerator<unknown> {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "hel" };
        yield { type: "response.output_text.delta", delta: "lo" };
        yield {
          type: "response.completed",
          response: buildResponse("completed", undefined, usage),
        };
      })();
    }

    function abortableEventStream(signal: AbortSignal): AsyncGenerator<unknown> {
      return (async function* () {
        for (const delta of ["hel", "lo"]) {
          if (signal.aborted) return;
          yield { type: "response.output_text.delta", delta };
        }
        yield { type: "response.completed", response: buildResponse("completed") };
      })();
    }

    async function drain(stream: unknown): Promise<void> {
      for await (const chunk of stream as AsyncIterable<unknown>) {
        expect(chunk).toBeDefined();
      }
    }

    it("meters the final event usage once when the stream is drained", async () => {
      const create = jest.fn().mockResolvedValue(buildEventStream(streamedUsage));

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });
      await drain(stream);
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokenCount: 333,
          outputTokenCount: 44,
          totalTokenCount: 377,
          isStreamed: true,
          stopReason: "END",
        }),
      );
    });

    it("sends no record before the stream is read", async () => {
      const create = jest.fn().mockResolvedValue(buildEventStream(streamedUsage));

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });
      await flushPromises();

      expect(sendToRevenium).not.toHaveBeenCalled();

      await drain(stream);
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
    });

    it("meters an abandoned stream once as CANCELLED", async () => {
      const create = jest.fn().mockResolvedValue(buildEventStream(streamedUsage));

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });

      for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
        expect(chunk).toBeDefined();
        break;
      }
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: "CANCELLED", isStreamed: true }),
      );
    });

    it("meters a rejection before the stream exists once as ERROR", async () => {
      const create = jest.fn().mockRejectedValue(new Error("stream rejected"));

      await expect(
        buildInterface(create).create({ model: "gpt-4o-mini", input: "hello", stream: true }),
      ).rejects.toThrow("stream rejected");
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: "ERROR", isStreamed: true, model: "gpt-4o-mini" }),
      );
    });

    it("returns the provider stream itself with its controller intact", async () => {
      const controller = new AbortController();
      const providerStream = {
        controller,
        iterator: () => buildEventStream(streamedUsage),
        [Symbol.asyncIterator]() {
          return this.iterator();
        },
      };
      const create = jest.fn().mockResolvedValue(providerStream);

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });

      expect(stream).toBe(providerStream);
      expect(stream.controller).toBe(controller);

      await drain(stream);
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ totalTokenCount: 377, isStreamed: true }),
      );
    });

    it("sends no extra record when the returned stream is iterated again", async () => {
      const providerStream = {
        iterator: () => buildEventStream(streamedUsage),
        [Symbol.asyncIterator]() {
          return this.iterator();
        },
      };
      const create = jest.fn().mockResolvedValue(providerStream);

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });
      await drain(stream);
      await drain(stream);
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ totalTokenCount: 377, stopReason: "END" }),
      );
    });

    it("meters a real OpenAI Stream drained through its own read path", async () => {
      const providerStream = new Stream(
        () => buildEventStream(streamedUsage),
        new AbortController(),
      );
      const create = jest.fn().mockResolvedValue(providerStream);

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });
      await drain(stream);
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokenCount: 333,
          outputTokenCount: 44,
          totalTokenCount: 377,
          isStreamed: true,
          stopReason: "END",
        }),
      );
    });

    it("meters a real OpenAI Stream aborted through its controller as CANCELLED", async () => {
      const controller = new AbortController();
      const providerStream = new Stream(() => abortableEventStream(controller.signal), controller);
      const create = jest.fn().mockResolvedValue(providerStream);

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });

      const seen: unknown[] = [];
      for await (const chunk of stream as AsyncIterable<unknown>) {
        seen.push(chunk);
        controller.abort();
      }
      await flushPromises();

      expect(seen).toHaveLength(1);
      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: "CANCELLED", isStreamed: true }),
      );
    });

    it("meters a terminal event without usage as zero counts with a real stop reason", async () => {
      const create = jest.fn().mockResolvedValue(buildEventStream(null));

      const stream = await buildInterface(create).create({
        model: "gpt-4o-mini",
        input: "hello",
        stream: true,
      });
      await drain(stream);
      await flushPromises();

      expect(sendToRevenium).toHaveBeenCalledTimes(1);
      expect(sendToRevenium).toHaveBeenCalledWith(
        expect.objectContaining({ totalTokenCount: 0, isStreamed: true, stopReason: "END" }),
      );
    });
  });

  it("logs no unknown stop reason warning for a successful response", async () => {
    const create = jest.fn().mockResolvedValue(buildResponse("completed"));

    await buildInterface(create).create({ model: "gpt-4o-mini", input: "hello" });
    await flushPromises();

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Unknown stop reason"));
  });
});

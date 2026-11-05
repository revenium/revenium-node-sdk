import {
  createReveniumConfig,
  createPayload,
  createMockFetch,
  createHungFetch,
} from "../../helpers/fixtures";
import {
  CIRCUIT_BREAKER_CONFIG,
  ENFORCEMENT_CONFIG,
  METERING_REQUEST_TIMEOUT_MS,
} from "../../../src/_core/constants";

let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let getBufferStats: typeof import("../../../src/_core/metering/buffer").getBufferStats;
let flushMeteringBuffer: typeof import("../../../src/_core/metering/buffer").flushMeteringBuffer;
let circuitBreaker: typeof import("../../../src/_core/resilience/circuit-breaker");

beforeEach(async () => {
  jest.resetModules();
  const manager = await import("../../../src/_core/config/manager");
  const client = await import("../../../src/_core/metering/api-client");
  const buffer = await import("../../../src/_core/metering/buffer");
  circuitBreaker = await import("../../../src/_core/resilience/circuit-breaker");
  sendToRevenium = client.sendToRevenium;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  getBufferStats = buffer.getBufferStats;
  flushMeteringBuffer = buffer.flushMeteringBuffer;
});

afterEach(() => {
  resetConfig();
  jest.restoreAllMocks();
});

describe("sendToRevenium", () => {
  it("skips when config is null", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;
    await sendToRevenium(createPayload());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends POST with correct headers including Idempotency-Key", async () => {
    const config = createReveniumConfig();
    setConfig(config);
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToRevenium(createPayload());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/meter/v2/ai/completions");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe(config.reveniumApiKey);
    expect(options.headers["Idempotency-Key"]).toBeDefined();
    expect(options.headers["Idempotency-Key"].length).toBeGreaterThan(0);
  });

  it("routes IMAGE payloads to /ai/images", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToRevenium(createPayload({ operationType: "IMAGE" }));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/ai/images");
  });

  it("routes AUDIO payloads to /ai/audio", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToRevenium(createPayload({ operationType: "AUDIO" }));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/ai/audio");
  });

  it("throws on terminal HTTP error without retry", async () => {
    setConfig(createReveniumConfig());
    global.fetch = createMockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(sendToRevenium(createPayload())).rejects.toThrow("Revenium API error: 401");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes payload as JSON body", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;
    const payload = createPayload({ model: "test-model-123" });

    await sendToRevenium(payload);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("test-model-123");
  });

  it("generates unique Idempotency-Key per call", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToRevenium(createPayload());
    await sendToRevenium(createPayload());

    const key1 = mockFetch.mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = mockFetch.mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).not.toBe(key2);
  });

  it("uses override idempotencyKey from payload when provided", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToRevenium(createPayload({ idempotencyKey: "custom-key-123" }));

    const key = mockFetch.mock.calls[0][1].headers["Idempotency-Key"];
    expect(key).toBe("custom-key-123");
  });

  it("excludes idempotencyKey from JSON body", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToRevenium(createPayload({ idempotencyKey: "custom-key-123" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.idempotencyKey).toBeUndefined();
  });

  it("rejected records never stop good records", async () => {
    setConfig(createReveniumConfig());
    global.fetch = createMockFetch({ ok: false, status: 400, statusText: "Bad Request" });
    for (let i = 0; i < 6; i++) {
      await sendToRevenium(createPayload()).catch(() => {});
    }

    const goodRecordFetch = createMockFetch({ status: 201, statusText: "Created" });
    global.fetch = goodRecordFetch;
    await sendToRevenium(createPayload());

    expect(goodRecordFetch).toHaveBeenCalledTimes(1);
    expect(getBufferStats().totalBuffered).toBe(0);
    expect(circuitBreaker.getMeteringCircuitBreaker().getState()).toBe(
      circuitBreaker.CircuitState.CLOSED,
    );
  });

  it("rate-limited records never stop good records", async () => {
    setConfig(createReveniumConfig({ maxRetries: 0 }));
    global.fetch = createMockFetch({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { "Retry-After": "1" },
    });
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD + 1; i++) {
      await sendToRevenium(createPayload()).catch(() => {});
    }

    const goodRecordFetch = createMockFetch({ status: 201, statusText: "Created" });
    global.fetch = goodRecordFetch;
    await sendToRevenium(createPayload());

    expect(goodRecordFetch).toHaveBeenCalledTimes(1);
    expect(circuitBreaker.getMeteringCircuitBreaker().getState()).toBe(
      circuitBreaker.CircuitState.CLOSED,
    );
  });

  it("recovers from an outage with a single probe while concurrent records are buffered", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 0 }));
    global.fetch = createMockFetch({ ok: false, status: 503, statusText: "Service Unavailable" });
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await sendToRevenium(createPayload()).catch(() => {});
    }
    jest.advanceTimersByTime(CIRCUIT_BREAKER_CONFIG.RECOVERY_TIMEOUT);
    const bufferedDuringOutage = getBufferStats().totalBuffered;

    let releaseProbe: () => void = () => {};
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const createdResponse = createMockFetch({ status: 201, statusText: "Created" });
    const recoveryFetch = jest.fn(() => probeReleased.then(() => createdResponse()));
    global.fetch = recoveryFetch as unknown as typeof fetch;

    const probe = sendToRevenium(createPayload());
    const concurrent = Promise.allSettled([
      sendToRevenium(createPayload()),
      sendToRevenium(createPayload()),
    ]);
    releaseProbe();
    await probe;
    const concurrentOutcomes = await concurrent;

    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect(concurrentOutcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(getBufferStats().totalBuffered).toBe(bufferedDuringOutage + 2);
    jest.useRealTimers();
  });

  it("delivers every record sent during a 503 outage after recovery without eviction", async () => {
    setConfig(createReveniumConfig({ maxRetries: 0 }));
    global.fetch = createMockFetch({ ok: false, status: 503, statusText: "Service Unavailable" });
    const sentTransactionIds = Array.from({ length: 1500 }, (_, i) => `txn-outage-${i}`);
    for (const transactionId of sentTransactionIds) {
      await sendToRevenium(createPayload({ transactionId })).catch(() => {});
    }

    const recoveryFetch = createMockFetch({ status: 201, statusText: "Created" });
    global.fetch = recoveryFetch;
    await flushMeteringBuffer();

    const stats = getBufferStats();
    expect(stats.totalEvicted).toBe(0);
    expect(stats.size).toBe(0);
    expect(stats.totalFlushed).toBe(1500);
    const deliveredTransactionIds = recoveryFetch.mock.calls.map(
      ([, init]: [string, RequestInit]) => JSON.parse(init.body as string).transactionId,
    );
    expect(new Set(deliveredTransactionIds)).toEqual(new Set(sentTransactionIds));
  });

  it("fails a hung request at the metering timeout without an in-line retry and buffers it", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 3 }));
    global.fetch = createHungFetch();

    const promise = sendToRevenium(createPayload());
    const outcome = expect(promise).rejects.toThrow(
      `timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`,
    );
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await outcome;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(getBufferStats().totalBuffered).toBe(1);
    expect(circuitBreaker.getMeteringCircuitBreaker().getStats().recentFailures).toBe(1);
    jest.useRealTimers();
  });

  it("five hung sends open the breaker after a single timeout each", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 3 }));
    global.fetch = createHungFetch();
    const breaker = circuitBreaker.getMeteringCircuitBreaker();

    const sends = Array.from({ length: CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD }, () =>
      sendToRevenium(createPayload()),
    );
    const outcomes = Promise.all(
      sends.map((send) =>
        expect(send).rejects.toThrow(`timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`),
      ),
    );
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await outcomes;
    expect(breaker.getState()).toBe(circuitBreaker.CircuitState.OPEN);
    expect(global.fetch).toHaveBeenCalledTimes(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD);
    expect(getBufferStats().totalBuffered).toBe(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD);

    await expect(sendToRevenium(createPayload())).rejects.toThrow("Circuit breaker is OPEN");
    expect(global.fetch).toHaveBeenCalledTimes(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD);
    jest.useRealTimers();
  });

  it("rejects a hung request with a MeteringTimeoutError carrying the METERING_TIMEOUT code", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 0 }));
    global.fetch = createHungFetch();

    const outcome = expect(sendToRevenium(createPayload())).rejects.toMatchObject({
      name: "MeteringTimeoutError",
      code: "METERING_TIMEOUT",
      message: `Revenium metering request timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`,
    });
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await outcome;
    jest.useRealTimers();
  });

  it("delivers a record abandoned by a timeout once Revenium answers again, keeping its Idempotency-Key", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 3 }));
    const hungFetch = createHungFetch();
    global.fetch = hungFetch;

    const outcome = expect(
      sendToRevenium(createPayload({ transactionId: "txn-hung" })),
    ).rejects.toThrow(`timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`);
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);
    await outcome;
    const [, hungInit] = hungFetch.mock.calls[0] as [string, RequestInit];
    const idempotencyKey = (hungInit.headers as Record<string, string>)["Idempotency-Key"];

    const recoveryFetch = createMockFetch({ status: 201, statusText: "Created" });
    global.fetch = recoveryFetch;
    await flushMeteringBuffer();

    expect(hungFetch).toHaveBeenCalledTimes(1);
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    const [, replayInit] = recoveryFetch.mock.calls[0] as [string, RequestInit];
    expect((replayInit.headers as Record<string, string>)["Idempotency-Key"]).toBe(idempotencyKey);
    expect(JSON.parse(replayInit.body as string).transactionId).toBe("txn-hung");
    expect(getBufferStats()).toMatchObject({ size: 0, totalFlushed: 1 });
    jest.useRealTimers();
  });

  it("keeps the metering timeout running while the error body is read", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 0 }));
    global.fetch = jest.fn((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: { get: () => null },
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    const promise = sendToRevenium(createPayload());
    const outcome = expect(promise).rejects.toThrow(
      `timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`,
    );
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await outcome;
    expect(getBufferStats().totalBuffered).toBe(1);
    jest.useRealTimers();
  });

  it("sends the recovery probe as a single attempt even when retries are configured", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ maxRetries: 3 }));
    const breaker = circuitBreaker.getMeteringCircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await breaker.execute(() => Promise.reject(new Error("outage"))).catch(() => {});
    }
    jest.advanceTimersByTime(CIRCUIT_BREAKER_CONFIG.RECOVERY_TIMEOUT);
    const outageFetch = createMockFetch({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    global.fetch = outageFetch;

    await expect(sendToRevenium(createPayload())).rejects.toThrow("503");

    expect(outageFetch).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe(circuitBreaker.CircuitState.OPEN);
    expect(getBufferStats().totalBuffered).toBe(1);
    jest.useRealTimers();
  });

  it("retries on 429 and reuses same Idempotency-Key", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig());
    let callCount = 0;
    global.fetch = jest.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: () => Promise.resolve("rate limited"),
          headers: { get: (name: string) => (name === "Retry-After" ? "1" : null) },
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        statusText: "Created",
        headers: { get: () => null },
      } as unknown as Response);
    });

    const promise = sendToRevenium(createPayload());

    await jest.advanceTimersByTimeAsync(50_000);

    await promise;
    expect(callCount).toBe(2);

    const key1 = (global.fetch as jest.Mock).mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = (global.fetch as jest.Mock).mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).toBe(key2);
    jest.useRealTimers();
  });

  it("retries on 503 and reuses same Idempotency-Key", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig());
    let callCount = 0;
    global.fetch = jest.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: () => Promise.resolve(""),
          headers: { get: () => null },
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        statusText: "Created",
        headers: { get: () => null },
      } as unknown as Response);
    });

    const promise = sendToRevenium(createPayload());

    await jest.advanceTimersByTimeAsync(50_000);

    await promise;
    expect(callCount).toBe(2);

    const key1 = (global.fetch as jest.Mock).mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = (global.fetch as jest.Mock).mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).toBe(key2);
    jest.useRealTimers();
  });
});

describe("sendToRevenium enforcement directive", () => {
  const scope = { subscriberId: "sub-1", model: "gpt-4o", provider: "OpenAI" };
  const blockReply = {
    enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
  };

  let enforcePreCallRules: typeof import("../../../src/_core/enforcement/evaluator").enforcePreCallRules;
  let CostLimitExceeded: typeof import("../../../src/_core/resilience/error-handler").CostLimitExceeded;

  beforeEach(async () => {
    ({ enforcePreCallRules } = await import("../../../src/_core/enforcement/evaluator"));
    ({ CostLimitExceeded } = await import("../../../src/_core/resilience/error-handler"));
    jest.useFakeTimers();
    setConfig(createReveniumConfig());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function replyWith(body: unknown): void {
    global.fetch = createMockFetch({ status: 201, jsonBody: body });
  }

  function replyWithText(text: string): void {
    global.fetch = createMockFetch({ status: 201, text: () => Promise.resolve(text) });
  }

  async function meterBlocked(): Promise<void> {
    replyWith(blockReply);
    await sendToRevenium(createPayload(), scope);
  }

  it("a 201 carrying a BLOCK directive refuses the next call for the same scope", async () => {
    await meterBlocked();

    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
    let refusal: unknown;
    try {
      enforcePreCallRules(scope);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CostLimitExceeded);
    expect(refusal).toMatchObject({ ruleName: "stub-cap", ruleId: "" });
  });

  it("falls back to the rule name when the directive carries no message", async () => {
    replyWith({ enforcement: { action: "BLOCK", ruleName: "stub-cap", message: null } });
    await sendToRevenium(createPayload(), scope);

    expect(() => enforcePreCallRules(scope)).toThrow("Cost limit exceeded: stub-cap");
  });

  it("does not refuse a different subscriber", async () => {
    await meterBlocked();

    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
    expect(() => enforcePreCallRules({ ...scope, subscriberId: "sub-2" })).not.toThrow();
  });

  it("does not record a block when no scope travels with the record", async () => {
    replyWith(blockReply);
    await sendToRevenium(createPayload());

    expect(() => enforcePreCallRules(scope)).not.toThrow();

    await sendToRevenium(createPayload(), scope);

    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
  });

  it("a later reply without directive lifts the block", async () => {
    await meterBlocked();
    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");

    jest.advanceTimersByTime(1);
    replyWith({ id: "metered" });
    await sendToRevenium(createPayload(), scope);

    expect(() => enforcePreCallRules(scope)).not.toThrow();
  });

  it("a reply for a request sent before the block does not lift it", async () => {
    let answerEarlierRequest: (response: Response) => void = () => undefined;
    const earlierReply = new Promise<Response>((resolve) => {
      answerEarlierRequest = resolve;
    });
    const blockingFetch = createMockFetch({ status: 201, jsonBody: blockReply });
    global.fetch = jest.fn().mockReturnValueOnce(earlierReply).mockImplementation(blockingFetch);

    const earlierRequest = sendToRevenium(createPayload({ transactionId: "earlier" }), scope);
    jest.advanceTimersByTime(1);
    await sendToRevenium(createPayload({ transactionId: "later" }), scope);

    answerEarlierRequest(await createMockFetch({ status: 201, jsonBody: {} })());
    await earlierRequest;

    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
  });

  it("an empty or non-JSON 201 body changes nothing", async () => {
    await meterBlocked();

    jest.advanceTimersByTime(1);
    replyWithText("");
    await expect(sendToRevenium(createPayload(), scope)).resolves.toBeUndefined();
    replyWithText("<html>accepted</html>");
    await expect(sendToRevenium(createPayload(), scope)).resolves.toBeUndefined();

    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
  });

  it("a WARN_ONLY directive does not block", async () => {
    replyWith({ enforcement: { action: "WARN_ONLY", ruleName: "stub-cap", message: "Heads up" } });
    await sendToRevenium(createPayload(), scope);

    expect(() => enforcePreCallRules(scope)).not.toThrow();

    await meterBlocked();

    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
  });

  it("the block expires after 300 s", async () => {
    await meterBlocked();

    jest.advanceTimersByTime(ENFORCEMENT_CONFIG.MAX_RULE_AGE - 1);
    expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");

    jest.advanceTimersByTime(1);
    expect(() => enforcePreCallRules(scope)).not.toThrow();
  });
});

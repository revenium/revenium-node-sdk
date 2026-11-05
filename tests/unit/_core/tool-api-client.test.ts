import { createReveniumConfig, createMockFetch, createHungFetch } from "../../helpers/fixtures";
import { ToolEventPayload } from "../../../src/_core/types/tool-metering";
import { METERING_REQUEST_TIMEOUT_MS } from "../../../src/_core/constants";

let sendToolEvent: typeof import("../../../src/_core/tool-metering/tool-api-client").sendToolEvent;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let getBufferStats: typeof import("../../../src/_core/metering/buffer").getBufferStats;
let resetMeteringBuffer: typeof import("../../../src/_core/metering/buffer").resetMeteringBuffer;

function createToolEventPayload(overrides: Partial<ToolEventPayload> = {}): ToolEventPayload {
  return {
    transactionId: "txn-tool-001",
    toolId: "test-tool",
    durationMs: 100,
    success: true,
    timestamp: new Date().toISOString(),
    middlewareSource: "revenium-node",
    ...overrides,
  };
}

beforeEach(async () => {
  jest.resetModules();
  const manager = await import("../../../src/_core/config/manager");
  const client = await import("../../../src/_core/tool-metering/tool-api-client");
  const buffer = await import("../../../src/_core/metering/buffer");
  sendToolEvent = client.sendToolEvent;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  getBufferStats = buffer.getBufferStats;
  resetMeteringBuffer = buffer.resetMeteringBuffer;
});

afterEach(() => {
  resetMeteringBuffer();
  jest.useRealTimers();
  resetConfig();
  jest.restoreAllMocks();
});

describe("sendToolEvent", () => {
  it("skips when config is null", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;
    await sendToolEvent(createToolEventPayload());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends POST with Idempotency-Key header", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToolEvent(createToolEventPayload());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/meter/v2/tool/events");
    expect(options.headers["Idempotency-Key"]).toBeDefined();
    expect(options.headers["Idempotency-Key"].length).toBeGreaterThan(0);
  });

  it("generates unique Idempotency-Key per call", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToolEvent(createToolEventPayload());
    await sendToolEvent(createToolEventPayload());

    const key1 = mockFetch.mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = mockFetch.mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).not.toBe(key2);
  });

  it("uses override idempotencyKey from payload", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToolEvent(createToolEventPayload({ idempotencyKey: "custom-tool-key-456" }));

    const key = mockFetch.mock.calls[0][1].headers["Idempotency-Key"];
    expect(key).toBe("custom-tool-key-456");
  });

  it("excludes idempotencyKey from JSON body", async () => {
    setConfig(createReveniumConfig());
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendToolEvent(createToolEventPayload({ idempotencyKey: "custom-tool-key-456" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.idempotencyKey).toBeUndefined();
  });

  it("retries on 429 with stable Idempotency-Key", async () => {
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

    const promise = sendToolEvent(createToolEventPayload());

    await jest.advanceTimersByTimeAsync(50_000);

    await promise;
    expect(callCount).toBe(2);

    const key1 = (global.fetch as jest.Mock).mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = (global.fetch as jest.Mock).mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).toBe(key2);
  });

  it("buffers a tool event that met a Revenium outage", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig());
    global.fetch = createMockFetch({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    const outcome = expect(sendToolEvent(createToolEventPayload())).rejects.toThrow("503");
    await jest.advanceTimersByTimeAsync(60_000);

    await outcome;
    expect(getBufferStats().totalBuffered).toBe(1);
  });

  it("fails a hung tool event at the metering timeout without an in-line retry and buffers it", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig());
    global.fetch = createHungFetch();

    const outcome = expect(sendToolEvent(createToolEventPayload())).rejects.toThrow(
      `timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`,
    );
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await outcome;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(getBufferStats().totalBuffered).toBe(1);
  });

  it("fails fast on terminal 401", async () => {
    setConfig(createReveniumConfig());
    global.fetch = createMockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(sendToolEvent(createToolEventPayload())).rejects.toThrow("401");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

import { createReveniumConfig, createHungFetch } from "../../helpers/fixtures";
import { METERING_REQUEST_TIMEOUT_MS } from "../../../src/_core/constants";
import type { Logger } from "../../../src/_core/types";

let trackUsageAsync: typeof import("../../../src/anthropic/middleware").trackUsageAsync;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let setLogger: typeof import("../../../src/_core/config/manager").setLogger;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let resetMeteringCircuitBreaker: typeof import("../../../src/_core/resilience/circuit-breaker").resetMeteringCircuitBreaker;
let logger: jest.Mocked<Logger>;

const originalFetch = global.fetch;
const TIMEOUT_MESSAGE = `Revenium metering request timed out after ${METERING_REQUEST_TIMEOUT_MS} ms`;

function createTrackingData() {
  return {
    requestId: "req-anthropic-timeout",
    model: "claude-3-5-sonnet-20241022",
    inputTokens: 10,
    outputTokens: 5,
    duration: 120,
    isStreamed: false,
    stopReason: "end_turn",
    requestTime: new Date(),
    responseTime: new Date(),
  };
}

beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers();
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const middleware = await import("../../../src/anthropic/middleware");
  const circuitBreaker = await import("../../../src/_core/resilience/circuit-breaker");

  trackUsageAsync = middleware.trackUsageAsync;
  setConfig = manager.setConfig;
  setLogger = manager.setLogger;
  resetConfig = manager.resetConfig;
  resetMeteringCircuitBreaker = circuitBreaker.resetMeteringCircuitBreaker;

  logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  setLogger(logger);
  global.fetch = createHungFetch();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  delete process.env.AWS_REGION;
  resetMeteringCircuitBreaker();
  resetConfig();
});

describe("Anthropic tracking when the metering request hangs", () => {
  it("warns naming the timeout and rejects with MeteringTimeoutError when failSilent is off", async () => {
    setConfig(createReveniumConfig({ failSilent: false, maxRetries: 3 }));

    const outcome = expect(trackUsageAsync(createTrackingData())).rejects.toMatchObject({
      name: "MeteringTimeoutError",
      code: "METERING_TIMEOUT",
      message: TIMEOUT_MESSAGE,
    });
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await outcome;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Anthropic tracking failed", {
      error: TIMEOUT_MESSAGE,
      requestId: "req-anthropic-timeout",
    });
  });

  it("warns naming the timeout and resolves when failSilent is on", async () => {
    setConfig(createReveniumConfig({ failSilent: true, maxRetries: 3 }));

    const tracking = trackUsageAsync(createTrackingData());
    await jest.advanceTimersByTimeAsync(METERING_REQUEST_TIMEOUT_MS);

    await expect(tracking).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Anthropic tracking failed", {
      error: TIMEOUT_MESSAGE,
      requestId: "req-anthropic-timeout",
    });
  });
});

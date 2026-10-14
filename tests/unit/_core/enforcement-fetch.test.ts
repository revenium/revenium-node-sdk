import { initializeConfig, resetConfig, setLogger } from "../../../src/_core/config/manager";
import { ENFORCEMENT_CONFIG, ENV_VARS } from "../../../src/_core/constants";
import {
  startEnforcementPolling,
  stopEnforcementPolling,
} from "../../../src/_core/enforcement/engine";
import { getRules } from "../../../src/_core/enforcement/cache";
import {
  CircuitState,
  getEnforcementCircuitBreaker,
  resetEnforcementCircuitBreaker,
} from "../../../src/_core/resilience/circuit-breaker";
import type { Logger } from "../../../src/_core/types/index";

const TEAM_ID = "Ol3wbl";
const EXPECTED_URL = `https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/${TEAM_ID}`;

function buildRule(ruleId: number) {
  return {
    ruleId,
    name: `rule-${ruleId}`,
    threshold: 0.01,
    currentValue: 1,
    periodType: "DAILY",
    action: "BLOCK",
    breached: true,
    shadowMode: false,
  };
}

function respondWith(status: number, body?: unknown, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name: string) => (name === "Retry-After" ? (retryAfter ?? null) : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

describe("enforcement rules fetch", () => {
  let warn: jest.Mock;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_test";
    process.env[ENV_VARS.REVENIUM_BASE_URL] = "https://api.revenium.ai";
    process.env[ENV_VARS.TEAM_ID] = TEAM_ID;
    delete process.env[ENV_VARS.ENFORCEMENT_BASE_URL];

    resetConfig();
    resetEnforcementCircuitBreaker();
    initializeConfig();

    warn = jest.fn();
    const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() };
    setLogger(logger);

    jest.spyOn(Math, "random").mockReturnValue(0.5);

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    stopEnforcementPolling();
    resetConfig();
    resetEnforcementCircuitBreaker();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env[ENV_VARS.REVENIUM_API_KEY];
    delete process.env[ENV_VARS.REVENIUM_BASE_URL];
    delete process.env[ENV_VARS.TEAM_ID];
  });

  async function pollOnce(): Promise<void> {
    await jest.advanceTimersByTimeAsync(ENFORCEMENT_CONFIG.POLL_INTERVAL);
  }

  it("requests the served enforcement address with README-only configuration", async () => {
    fetchMock.mockResolvedValue(respondWith(200, { rules: [buildRule(1), buildRule(2)] }));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith(EXPECTED_URL, expect.anything());
    expect(getRules()).toHaveLength(2);
  });

  it("caches an empty rule set on 204 without warning", async () => {
    fetchMock.mockResolvedValue(respondWith(204));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith(EXPECTED_URL, expect.anything());
    expect(getRules()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a 404 as a configuration problem on every poll and keeps the breaker closed", async () => {
    fetchMock.mockResolvedValueOnce(respondWith(200, { rules: [buildRule(1)] }));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(getRules()).toHaveLength(1);

    fetchMock.mockResolvedValue(respondWith(404));
    await pollOnce();
    await pollOnce();

    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call[1]).toMatchObject({ url: EXPECTED_URL, status: 404 });
    }
    expect(getRules()).toHaveLength(1);
    expect(getEnforcementCircuitBreaker().getState()).toBe(CircuitState.CLOSED);
  });

  it("warns that cached rules stay in use when a 403 follows a successful poll", async () => {
    fetchMock.mockResolvedValueOnce(respondWith(200, { rules: [buildRule(1)] }));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    fetchMock.mockResolvedValue(respondWith(403));
    await pollOnce();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("loaded by an earlier poll remain in use"),
      expect.objectContaining({ status: 403 }),
    );
  });

  it("warns that calls pass through when a 401 arrives with an empty cache", async () => {
    fetchMock.mockResolvedValue(respondWith(401));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("provider calls pass through"),
      expect.objectContaining({ status: 401 }),
    );
  });

  it("backs off polling for the Retry-After window on 429", async () => {
    fetchMock.mockResolvedValue(respondWith(429, undefined, "60"));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await pollOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("rate limiting"),
      expect.objectContaining({ status: 429 }),
    );
  });

  it("drops the backoff once the endpoint recovers", async () => {
    fetchMock.mockResolvedValueOnce(respondWith(429, undefined, "60"));
    fetchMock.mockResolvedValue(respondWith(200, { rules: [buildRule(1)] }));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await pollOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats a 408 as a transient failure instead of a configuration problem", async () => {
    fetchMock.mockResolvedValue(respondWith(408));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Enforcement rules fetch failed"),
      expect.objectContaining({ error: expect.stringContaining("408") }),
    );
    expect(getEnforcementCircuitBreaker().getStats().failureCount).toBe(1);
  });

  it("keeps 5xx failures on the breaker when a 4xx follows", async () => {
    fetchMock.mockResolvedValueOnce(respondWith(500));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(getEnforcementCircuitBreaker().getStats().failureCount).toBe(1);

    fetchMock.mockResolvedValue(respondWith(404));
    await pollOnce();

    expect(getEnforcementCircuitBreaker().getStats().failureCount).toBe(1);
  });
});

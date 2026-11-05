import {
  getConfig,
  initializeConfig,
  resetConfig,
  setConfig,
  setLogger,
} from "../../../src/_core/config/manager";
import { runWithCallConfig } from "../../../src/_core/config/call-config";
import { ENFORCEMENT_CONFIG, ENV_VARS } from "../../../src/_core/constants";
import {
  startEnforcementPolling,
  stopEnforcementPolling,
} from "../../../src/_core/enforcement/engine";
import { getRules, getSnapshot } from "../../../src/_core/enforcement/cache";
import { enforcePreCallRules } from "../../../src/_core/enforcement/evaluator";
import { applyMeteringReply } from "../../../src/_core/enforcement/metering-blocks";
import { CostLimitExceeded } from "../../../src/_core/resilience/error-handler";
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

  it("warns that provider calls pass through when no team id is configured", async () => {
    setConfig({ ...getConfig()!, reveniumTeamId: undefined });

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("provider calls pass through");
    expect(message).toContain("reveniumTeamId");
    expect(message).toContain(ENV_VARS.TEAM_ID);
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
      expect.stringContaining("refreshed 30 s ago remain in use until they are 300 s old"),
      expect.objectContaining({ status: 403 }),
    );
  });

  it("warns with the refresh age when a 403 follows an empty 204 rule set", async () => {
    fetchMock.mockResolvedValueOnce(respondWith(204));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    fetchMock.mockResolvedValue(respondWith(403));
    await pollOnce();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("refreshed 30 s ago hold no rules, so provider calls pass through"),
      expect.objectContaining({ status: 403 }),
    );
  });

  async function outliveRulesWhileRefreshesFail(): Promise<void> {
    fetchMock.mockResolvedValueOnce(respondWith(200, { rules: [buildRule(1)] }));

    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(() => enforcePreCallRules({})).toThrow(CostLimitExceeded);

    fetchMock.mockResolvedValue(respondWith(503));
    await jest.advanceTimersByTimeAsync(
      ENFORCEMENT_CONFIG.MAX_RULE_AGE + ENFORCEMENT_CONFIG.POLL_INTERVAL,
    );
  }

  it("stops applying cached rules once they are older than MAX_RULE_AGE while refreshes fail", async () => {
    await outliveRulesWhileRefreshesFail();

    expect(getSnapshot().rules).toHaveLength(0);
    expect(() => enforcePreCallRules({})).not.toThrow();
  });

  it("a successful refresh after the bound restores enforcement", async () => {
    await outliveRulesWhileRefreshesFail();
    expect(() => enforcePreCallRules({})).not.toThrow();

    fetchMock.mockResolvedValue(respondWith(200, { rules: [buildRule(1)] }));
    await pollOnce();

    expect(() => enforcePreCallRules({})).toThrow(CostLimitExceeded);
  });

  it("warns that expired rules no longer apply when a 5xx follows the bound", async () => {
    await outliveRulesWhileRefreshesFail();

    expect(warn).toHaveBeenLastCalledWith(
      expect.stringContaining("older than 300 s and no longer applied"),
      expect.objectContaining({ error: expect.stringContaining("503") }),
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

  describe("a block reported on a metering reply", () => {
    const scope = { subscriberId: "sub-1", model: "gpt-4o", provider: "OpenAI" };

    function stubCap(breachedSubscriber: boolean) {
      return {
        ...buildRule(7),
        name: "stub-cap",
        breached: false,
        groupBy: "SUBSCRIBER",
        groupBreakdown: [
          { groupValue: "someone-else", currentValue: 9, breached: breachedSubscriber },
        ],
      };
    }

    async function blockThenRefresh(rulesPayload: unknown): Promise<void> {
      applyMeteringReply("hak_test", scope, performance.now(), {
        enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
      });
      expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");

      fetchMock.mockResolvedValue(respondWith(200, rulesPayload));
      startEnforcementPolling();
      await jest.advanceTimersByTimeAsync(0);
    }

    it("a rules refresh that no longer reports the named rule breached lifts the block", async () => {
      await blockThenRefresh({ rules: [stubCap(false)] });

      expect(() => enforcePreCallRules(scope)).not.toThrow();
    });

    it("a refresh still reporting it breached keeps it", async () => {
      await blockThenRefresh({ rules: [stubCap(true)] });

      expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
    });

    it("a refresh with no rules configured lifts the block", async () => {
      applyMeteringReply("hak_test", scope, performance.now(), {
        enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
      });
      fetchMock.mockResolvedValue(respondWith(204));

      startEnforcementPolling();
      await jest.advanceTimersByTimeAsync(0);

      expect(() => enforcePreCallRules(scope)).not.toThrow();
    });

    it("keeps the block while another rule with the same name is still breached", async () => {
      await blockThenRefresh({ rules: [stubCap(false), { ...stubCap(true), ruleId: 8 }] });

      expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
    });

    it("a refresh that started before the block was sent leaves it in place", async () => {
      let answerFetch: (response: Response) => void = () => {};
      fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answerFetch = resolve)));
      startEnforcementPolling();
      await jest.advanceTimersByTimeAsync(1);

      applyMeteringReply("hak_test", scope, performance.now(), {
        enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
      });
      answerFetch(respondWith(200, { rules: [stubCap(false)] }));
      await jest.advanceTimersByTimeAsync(0);

      expect(getRules()).toHaveLength(1);
      expect(() => enforcePreCallRules(scope)).toThrow("Daily cap reached");
    });

    it("stopping the poller clears the block", () => {
      applyMeteringReply("hak_test", scope, performance.now(), {
        enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
      });

      stopEnforcementPolling();

      expect(() => enforcePreCallRules(scope)).not.toThrow();
    });

    it("falls back to the rule name when the directive message is empty", () => {
      applyMeteringReply("hak_test", scope, performance.now(), {
        enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "" },
      });

      expect(() => enforcePreCallRules(scope)).toThrow("Cost limit exceeded: stub-cap");
    });

    describe("under another Revenium organization", () => {
      const otherOrg = { reveniumApiKey: "hak_other_org" };
      const enforceForOtherOrg = () =>
        runWithCallConfig(otherOrg, () => enforcePreCallRules(scope));

      beforeEach(() => {
        applyMeteringReply(otherOrg.reveniumApiKey, scope, performance.now(), {
          enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
        });
      });

      it("refuses only that organization's calls", () => {
        expect(enforceForOtherOrg).toThrow("Daily cap reached");
        expect(() => enforcePreCallRules(scope)).not.toThrow();
      });

      it("is not lifted by a reply metered under this organization", () => {
        applyMeteringReply("hak_test", scope, performance.now(), {});

        expect(enforceForOtherOrg).toThrow("Daily cap reached");
      });

      it("is not lifted by a rules refresh for this organization's team", async () => {
        fetchMock.mockResolvedValue(respondWith(204));

        startEnforcementPolling();
        await jest.advanceTimersByTimeAsync(0);

        expect(enforceForOtherOrg).toThrow("Daily cap reached");
      });
    });
  });
});

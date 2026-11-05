import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerConfig,
  FailureStrategy,
  getMeteringCircuitBreaker,
  getEnforcementCircuitBreaker,
  executeWithMeteringCircuitBreaker,
  executeWithEnforcementCircuitBreaker,
  resetMeteringCircuitBreaker,
  resetEnforcementCircuitBreaker,
} from "../../../src/_core/resilience/circuit-breaker";
import { HttpError } from "../../../src/_core/resilience/retry";
import { CircuitBreakerOpenError } from "../../../src/_core/resilience/error-handler";

const testConfig: CircuitBreakerConfig = {
  failureThreshold: 3,
  recoveryTimeout: 5000,
  successThreshold: 2,
  timeWindow: 60000,
};

beforeEach(() => {
  jest.useFakeTimers();
  resetMeteringCircuitBreaker();
  resetEnforcementCircuitBreaker();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("CircuitBreaker", () => {
  it("starts in CLOSED state", () => {
    const cb = new CircuitBreaker(testConfig);
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("stays CLOSED on successful executions", async () => {
    const cb = new CircuitBreaker(testConfig);
    await cb.execute(() => Promise.resolve("ok"));
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("transitions to OPEN after threshold failures", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it("rejects immediately when OPEN", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    await expect(cb.execute(() => Promise.resolve("ok"))).rejects.toThrow(
      "Circuit breaker is OPEN",
    );
  });

  it("transitions to HALF_OPEN after recovery timeout", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    jest.advanceTimersByTime(testConfig.recoveryTimeout);

    await cb.execute(() => Promise.resolve("ok"));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it("transitions HALF_OPEN -> CLOSED after success threshold", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }

    jest.advanceTimersByTime(testConfig.recoveryTimeout);

    for (let i = 0; i < testConfig.successThreshold; i++) {
      await cb.execute(() => Promise.resolve("ok"));
    }
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("transitions HALF_OPEN -> OPEN on failure", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }

    jest.advanceTimersByTime(testConfig.recoveryTimeout);

    await cb.execute(() => Promise.reject(new Error("fail again"))).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it("canExecute reflects current state", async () => {
    const cb = new CircuitBreaker(testConfig);
    expect(cb.canExecute()).toBe(true);

    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(cb.canExecute()).toBe(false);

    jest.advanceTimersByTime(testConfig.recoveryTimeout);
    expect(cb.canExecute()).toBe(true);
  });

  it("getStats returns accurate counters", async () => {
    const cb = new CircuitBreaker(testConfig);
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});

    const stats = cb.getStats();
    expect(stats.state).toBe(CircuitState.CLOSED);
    expect(stats.failureCount).toBe(1);
    expect(stats.recentFailures).toBe(1);
  });

  it("reset brings back to initial state", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    cb.reset();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.getStats().failureCount).toBe(0);
  });

  it("tells the function whether it runs as the recovery probe", async () => {
    const cb = new CircuitBreaker(testConfig);
    const observed: boolean[] = [];
    const record = (isProbe: boolean) => {
      observed.push(isProbe);
      return Promise.resolve();
    };

    await cb.execute(record);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    jest.advanceTimersByTime(testConfig.recoveryTimeout);
    await cb.execute(record);

    expect(observed).toEqual([false, true]);
  });

  it("HALF_OPEN admits a single probe", async () => {
    const cb = new CircuitBreaker(testConfig);
    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    jest.advanceTimersByTime(testConfig.recoveryTimeout);

    let resolveProbe: (value: string) => void = () => {};
    const probe = cb.execute(
      () =>
        new Promise<string>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const concurrentCall = jest.fn(() => Promise.resolve("concurrent"));

    expect(cb.canExecute()).toBe(false);
    await expect(cb.execute(concurrentCall)).rejects.toThrow(CircuitBreakerOpenError);
    await expect(cb.execute(concurrentCall)).rejects.toThrow("Circuit breaker is HALF_OPEN");
    expect(concurrentCall).not.toHaveBeenCalled();

    resolveProbe("probe");
    await probe;
    await expect(cb.execute(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("success in CLOSED clears the failure window", async () => {
    const cb = new CircuitBreaker(testConfig);
    const fail = () => cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});

    await fail();
    await fail();
    await cb.execute(() => Promise.resolve("ok"));
    await fail();
    await fail();

    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("respects custom FailureStrategy", async () => {
    const strategy: FailureStrategy = {
      isRetryableError: (err) => {
        return err instanceof Error && err.message.includes("retryable");
      },
      isProviderThrottling: () => false,
    };
    const cb = new CircuitBreaker(testConfig, strategy);

    for (let i = 0; i < testConfig.failureThreshold + 2; i++) {
      await cb.execute(() => Promise.reject(new Error("permanent-failure"))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    for (let i = 0; i < testConfig.failureThreshold; i++) {
      await cb.execute(() => Promise.reject(new Error("retryable"))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });
});

describe("named circuit breakers (metering / enforcement)", () => {
  it("getMeteringCircuitBreaker and getEnforcementCircuitBreaker return distinct instances", () => {
    const metering = getMeteringCircuitBreaker();
    const enforcement = getEnforcementCircuitBreaker();
    expect(metering).not.toBe(enforcement);
  });

  it("each named breaker is a stable singleton across calls", () => {
    expect(getMeteringCircuitBreaker()).toBe(getMeteringCircuitBreaker());
    expect(getEnforcementCircuitBreaker()).toBe(getEnforcementCircuitBreaker());
  });

  it("metering breaker trips OPEN without affecting enforcement breaker", async () => {
    const meteringFailures = 12;
    for (let i = 0; i < meteringFailures; i++) {
      await executeWithMeteringCircuitBreaker(() =>
        Promise.reject(new Error("metering 503")),
      ).catch(() => {});
    }
    expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.OPEN);
    expect(getEnforcementCircuitBreaker().getState()).toBe(CircuitState.CLOSED);
  });

  it("enforcement breaker trips OPEN without affecting metering breaker", async () => {
    const enforcementFailures = 12;
    for (let i = 0; i < enforcementFailures; i++) {
      await executeWithEnforcementCircuitBreaker(() =>
        Promise.reject(new Error("enforcement 503")),
      ).catch(() => {});
    }
    expect(getEnforcementCircuitBreaker().getState()).toBe(CircuitState.OPEN);
    expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.CLOSED);
  });

  it.each([400, 401, 403, 404, 422])(
    "metering breaker stays CLOSED after rejected records (%i)",
    async (status) => {
      for (let i = 0; i < 10; i++) {
        await executeWithMeteringCircuitBreaker(() =>
          Promise.reject(new HttpError("rejected", status)),
        ).catch(() => {});
      }

      expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.CLOSED);
      await expect(executeWithMeteringCircuitBreaker(() => Promise.resolve("ok"))).resolves.toBe(
        "ok",
      );
    },
  );

  it("metering breaker ignores 429", async () => {
    for (let i = 0; i < 10; i++) {
      await executeWithMeteringCircuitBreaker(() =>
        Promise.reject(new HttpError("throttled", 429, 1)),
      ).catch(() => {});
    }

    expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.CLOSED);
  });

  it("metering breaker opens on 503", async () => {
    for (let i = 0; i < 5; i++) {
      await executeWithMeteringCircuitBreaker(() =>
        Promise.reject(new HttpError("unavailable", 503)),
      ).catch(() => {});
    }

    expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.OPEN);
  });

  it("metering breaker probes 5 seconds after the last failure", async () => {
    for (let i = 0; i < 5; i++) {
      await executeWithMeteringCircuitBreaker(() =>
        Promise.reject(new HttpError("unavailable", 503)),
      ).catch(() => {});
    }
    const probe = jest.fn(() => Promise.resolve("probe"));

    jest.advanceTimersByTime(4_999);
    await expect(executeWithMeteringCircuitBreaker(probe)).rejects.toThrow(
      "Circuit breaker is OPEN",
    );

    jest.advanceTimersByTime(1);
    await expect(executeWithMeteringCircuitBreaker(probe)).resolves.toBe("probe");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("resetMeteringCircuitBreaker leaves enforcement breaker untouched", async () => {
    for (let i = 0; i < 12; i++) {
      await executeWithMeteringCircuitBreaker(() => Promise.reject(new Error("m"))).catch(() => {});
      await executeWithEnforcementCircuitBreaker(() => Promise.reject(new Error("e"))).catch(
        () => {},
      );
    }
    expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.OPEN);
    expect(getEnforcementCircuitBreaker().getState()).toBe(CircuitState.OPEN);

    resetMeteringCircuitBreaker();

    expect(getMeteringCircuitBreaker().getState()).toBe(CircuitState.CLOSED);
    expect(getEnforcementCircuitBreaker().getState()).toBe(CircuitState.OPEN);
  });
});

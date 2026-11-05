import { CIRCUIT_BREAKER_CONFIG } from "../constants.js";
import { CircuitBreakerOpenError, EnforcementRequestRejectedError } from "./error-handler.js";
import { HttpError, isRequestRejection } from "./retry.js";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  successThreshold: number;
  timeWindow: number;
}

export interface FailureStrategy {
  isRetryableError(error: unknown): boolean;
  isProviderThrottling(error: unknown): boolean;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD,
  recoveryTimeout: CIRCUIT_BREAKER_CONFIG.RECOVERY_TIMEOUT,
  successThreshold: CIRCUIT_BREAKER_CONFIG.SUCCESS_THRESHOLD,
  timeWindow: CIRCUIT_BREAKER_CONFIG.TIME_WINDOW,
};

const defaultStrategy: FailureStrategy = {
  isRetryableError: () => true,
  isProviderThrottling: () => false,
};

const enforcementFailureStrategy: FailureStrategy = {
  isRetryableError: (error: unknown) => !(error instanceof EnforcementRequestRejectedError),
  isProviderThrottling: () => false,
};

const meteringFailureStrategy: FailureStrategy = {
  isRetryableError: (error: unknown) =>
    !(error instanceof HttpError && isRequestRejection(error.status)),
  isProviderThrottling: () => false,
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private failures: number[] = [];
  private probeInFlight = false;
  private readonly maxFailureHistorySize = CIRCUIT_BREAKER_CONFIG.MAX_FAILURE_HISTORY_SIZE;
  private readonly strategy: FailureStrategy;

  constructor(
    private config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    strategy?: FailureStrategy,
  ) {
    this.strategy = strategy || defaultStrategy;
  }

  async execute<T>(fn: (isProbe: boolean) => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new CircuitBreakerOpenError(this.state);
    }
    const isProbe = this.state !== CircuitState.CLOSED;
    if (isProbe) {
      this.startProbe();
    }

    try {
      const result = await fn(isProbe);
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.strategy.isRetryableError(error)) {
        this.onFailure();
      }
      throw error;
    } finally {
      if (isProbe) {
        this.probeInFlight = false;
      }
    }
  }

  canExecute(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.HALF_OPEN) return !this.probeInFlight;
    return this.shouldAttemptRecovery();
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    recentFailures: number;
    timeUntilRecovery?: number;
  } {
    const now = Date.now();
    const recentFailures = this.failures.filter(
      (timestamp) => now - timestamp < this.config.timeWindow,
    ).length;

    let timeUntilRecovery: number | undefined;
    if (this.state === CircuitState.OPEN) {
      const timeSinceLastFailure = now - this.lastFailureTime;
      timeUntilRecovery = Math.max(0, this.config.recoveryTimeout - timeSinceLastFailure);
    }

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      recentFailures,
      timeUntilRecovery,
    };
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.failures = [];
    this.probeInFlight = false;
  }

  private startProbe(): void {
    if (this.state === CircuitState.OPEN) {
      this.state = CircuitState.HALF_OPEN;
      this.successCount = 0;
    }
    this.probeInFlight = true;
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.failures = [];
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount = 0;
      this.failures = [];
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.failureCount++;
    this.lastFailureTime = now;

    if (this.failures.length >= this.maxFailureHistorySize) {
      this.failures = this.failures.slice(-Math.floor(this.maxFailureHistorySize / 2));
    }

    this.failures.push(now);
    this.cleanupOldFailures();

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      this.successCount = 0;
    } else if (this.state === CircuitState.CLOSED) {
      const recentFailures = this.failures.filter(
        (timestamp) => now - timestamp < this.config.timeWindow,
      ).length;
      if (recentFailures >= this.config.failureThreshold) {
        this.state = CircuitState.OPEN;
      }
    }
  }

  private shouldAttemptRecovery(): boolean {
    return Date.now() - this.lastFailureTime >= this.config.recoveryTimeout;
  }

  private cleanupOldFailures(): void {
    const now = Date.now();
    this.failures = this.failures.filter((timestamp) => now - timestamp < this.config.timeWindow);
  }
}

let meteringCircuitBreaker: CircuitBreaker | null = null;
let enforcementCircuitBreaker: CircuitBreaker | null = null;

export function getMeteringCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>,
  strategy?: FailureStrategy,
): CircuitBreaker {
  if (!meteringCircuitBreaker) {
    const finalConfig = config ? { ...DEFAULT_CIRCUIT_CONFIG, ...config } : DEFAULT_CIRCUIT_CONFIG;
    meteringCircuitBreaker = new CircuitBreaker(finalConfig, strategy ?? meteringFailureStrategy);
  }
  return meteringCircuitBreaker;
}

export function getEnforcementCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>,
): CircuitBreaker {
  if (!enforcementCircuitBreaker) {
    const finalConfig = config ? { ...DEFAULT_CIRCUIT_CONFIG, ...config } : DEFAULT_CIRCUIT_CONFIG;
    enforcementCircuitBreaker = new CircuitBreaker(finalConfig, enforcementFailureStrategy);
  }
  return enforcementCircuitBreaker;
}

export function resetMeteringCircuitBreaker(): void {
  if (meteringCircuitBreaker) {
    meteringCircuitBreaker.reset();
  }
  meteringCircuitBreaker = null;
}

export function resetEnforcementCircuitBreaker(): void {
  if (enforcementCircuitBreaker) {
    enforcementCircuitBreaker.reset();
  }
  enforcementCircuitBreaker = null;
}

export function executeWithMeteringCircuitBreaker<T>(
  fn: (isProbe: boolean) => Promise<T>,
): Promise<T> {
  return getMeteringCircuitBreaker().execute(fn);
}

export function executeWithEnforcementCircuitBreaker<T>(
  fn: (isProbe: boolean) => Promise<T>,
): Promise<T> {
  return getEnforcementCircuitBreaker().execute(fn);
}

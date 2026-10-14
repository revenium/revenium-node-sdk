import { CIRCUIT_BREAKER_CONFIG } from "../constants.js";
import { EnforcementRequestRejectedError } from "./error-handler.js";

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

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private failures: number[] = [];
  private lastCleanupTime: number = 0;
  private readonly maxFailureHistorySize = CIRCUIT_BREAKER_CONFIG.MAX_FAILURE_HISTORY_SIZE;
  private readonly strategy: FailureStrategy;

  constructor(
    private config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    strategy?: FailureStrategy,
  ) {
    this.lastCleanupTime = Date.now();
    this.strategy = strategy || defaultStrategy;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptRecovery()) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error("Circuit breaker is OPEN - failing fast");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.strategy.isRetryableError(error)) {
        this.onFailure();
      }
      throw error;
    }
  }

  canExecute(): boolean {
    if (this.state === CircuitState.CLOSED || this.state === CircuitState.HALF_OPEN) return true;
    if (this.state === CircuitState.OPEN && this.shouldAttemptRecovery()) return true;
    return false;
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
    this.lastCleanupTime = Date.now();
    this.failures = [];
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
      this.performPeriodicCleanup();
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

  private performPeriodicCleanup(): void {
    const now = Date.now();
    if (
      now - this.lastCleanupTime > CIRCUIT_BREAKER_CONFIG.CLEANUP_INTERVAL ||
      this.failures.length > CIRCUIT_BREAKER_CONFIG.CLEANUP_SIZE_THRESHOLD
    ) {
      this.cleanupOldFailures();
      this.lastCleanupTime = now;
    }
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
    meteringCircuitBreaker = new CircuitBreaker(finalConfig, strategy);
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

export function executeWithMeteringCircuitBreaker<T>(fn: () => Promise<T>): Promise<T> {
  return getMeteringCircuitBreaker().execute(fn);
}

export function executeWithEnforcementCircuitBreaker<T>(fn: () => Promise<T>): Promise<T> {
  return getEnforcementCircuitBreaker().execute(fn);
}

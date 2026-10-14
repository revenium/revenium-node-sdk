export class ReveniumError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ReveniumError";
    this.code = code;
    this.context = context;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ReveniumError);
    }
  }
}

export class ConfigurationError extends ReveniumError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFIGURATION_ERROR", context);
    this.name = "ConfigurationError";
  }
}

export class RequestProcessingError extends ReveniumError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "REQUEST_PROCESSING_ERROR", context);
    this.name = "RequestProcessingError";
  }
}

export class ReveniumApiError extends ReveniumError {
  public readonly statusCode?: number;
  public readonly responseBody?: string;

  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    context?: Record<string, unknown>,
  ) {
    super(message, "REVENIUM_API_ERROR", context);
    this.name = "ReveniumApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class ValidationError extends ReveniumError {
  public readonly validationErrors: string[];

  constructor(message: string, validationErrors: string[], context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", context);
    this.name = "ValidationError";
    this.validationErrors = validationErrors;
  }
}

export class StreamProcessingError extends ReveniumError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "STREAM_PROCESSING_ERROR", context);
    this.name = "StreamProcessingError";
  }
}

export class CostLimitExceeded extends ReveniumError {
  // Field names mirror the server's CompiledEnforcementRule (threshold,
  // currentValue, periodType) so SDK + UI + backend parse the same wire
  // shape. `ruleId` is stringified for JSON-safe structured logging.
  public readonly ruleId: string;
  public readonly threshold: number;
  public readonly currentValue: number;
  public readonly periodType: string;

  constructor(
    ruleId: string,
    threshold: number,
    currentValue: number,
    periodType: string,
    context?: Record<string, unknown>,
  ) {
    super(
      `Cost limit exceeded: $${currentValue.toFixed(2)} of $${threshold.toFixed(2)} ${periodType.toLowerCase()} limit reached`,
      "COST_LIMIT_EXCEEDED",
      context,
    );
    this.name = "CostLimitExceeded";
    this.ruleId = ruleId;
    this.threshold = threshold;
    this.currentValue = currentValue;
    this.periodType = periodType;
  }
}

export class EnforcementRequestRejectedError extends ReveniumError {
  public readonly url: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly retryAfterSeconds?: number;

  constructor(url: string, status: number, statusText: string, retryAfterSeconds?: number) {
    super(
      `Enforcement rules endpoint rejected the request: ${status} ${statusText}`,
      "ENFORCEMENT_REQUEST_REJECTED",
      { url, status, statusText },
    );
    this.name = "EnforcementRequestRejectedError";
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown error occurred";
}

export function safeAsyncOperation<T>(
  fn: () => Promise<T>,
  logger: { error: (message: string, meta?: Record<string, unknown>) => void },
  operationName: string,
): Promise<T | undefined> {
  return fn().catch((error) => {
    logger.error(`${operationName} failed safely`, {
      error: getErrorMessage(error),
    });
    return undefined;
  });
}

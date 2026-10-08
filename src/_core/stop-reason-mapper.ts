const STOP_REASON_MAP: Record<string, string> = {
  stop: "END",
  function_call: "END_SEQUENCE",
  tool_calls: "END_SEQUENCE",
  timeout: "TIMEOUT",
  length: "TOKEN_LIMIT",
  max_tokens: "TOKEN_LIMIT",
  cost_limit: "COST_LIMIT",
  completion_limit: "COMPLETION_LIMIT",
  content_filter: "ERROR",
  error: "ERROR",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  end_turn: "END",
  stop_sequence: "END_SEQUENCE",
  tool_use: "END_SEQUENCE",
  pause_turn: "END",
  refusal: "ERROR",
  model_context_window_exceeded: "TOKEN_LIMIT",
};

const DEFAULT_STOP_REASON = "END";

export function mapStopReason(
  providerStopReason: string | null | undefined,
  logger?: { warn: (message: string, ...args: any[]) => void },
): string {
  if (!providerStopReason) return DEFAULT_STOP_REASON;
  const normalizedReason = providerStopReason.toLowerCase();
  const mappedReason = STOP_REASON_MAP[normalizedReason];

  if (!mappedReason) {
    logger?.warn(`Unknown stop reason: ${providerStopReason}, mapping to ${DEFAULT_STOP_REASON}`);
    return DEFAULT_STOP_REASON;
  }

  return mappedReason;
}

export function getSupportedStopReasons(): string[] {
  return Object.keys(STOP_REASON_MAP);
}

export function isStopReasonSupported(reason: string): boolean {
  return reason.toLowerCase() in STOP_REASON_MAP;
}

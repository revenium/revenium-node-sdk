import type { Logger } from "../_core/types/index.js";

const STATUS_TO_STOP_REASON: Record<string, string> = {
  completed: "stop",
  incomplete: "stop",
  failed: "error",
  cancelled: "cancelled",
  queued: "stop",
  in_progress: "stop",
};

const INCOMPLETE_REASON_TO_STOP_REASON: Record<string, string> = {
  max_output_tokens: "length",
  max_messages: "completion_limit",
  content_filter: "content_filter",
  steered: "stop",
};

const INCOMPLETE_STATUS = "incomplete";
const NON_TERMINAL_STATUSES = new Set(["queued", "in_progress"]);

export const TERMINAL_RESPONSE_EVENTS = new Set(
  Object.keys(STATUS_TO_STOP_REASON)
    .filter((status) => !NON_TERMINAL_STATUSES.has(status))
    .map((status) => `response.${status}`),
);

export const RESPONSES_STOP_REASONS: readonly string[] = [
  ...new Set([
    ...Object.values(STATUS_TO_STOP_REASON),
    ...Object.values(INCOMPLETE_REASON_TO_STOP_REASON),
  ]),
];

export function isTerminalResponseStatus(status?: string | null): boolean {
  return !status || !NON_TERMINAL_STATUSES.has(status.toLowerCase());
}

export function mapResponsesStatusToStopReason(
  status?: string | null,
  incompleteReason?: string | null,
  logger?: Pick<Logger, "warn">,
): string | null {
  if (!status) return null;

  const normalizedStatus = status.toLowerCase();
  const statusStopReason = STATUS_TO_STOP_REASON[normalizedStatus];
  if (normalizedStatus !== INCOMPLETE_STATUS) return statusStopReason ?? status;

  const normalizedReason = incompleteReason?.toLowerCase();
  const incompleteStopReason = normalizedReason
    ? INCOMPLETE_REASON_TO_STOP_REASON[normalizedReason]
    : undefined;
  if (incompleteStopReason) return incompleteStopReason;

  logger?.warn("Unknown incomplete reason, mapping to the status default", {
    incompleteReason: incompleteReason ?? "none",
    stopReason: statusStopReason,
  });
  return statusStopReason;
}

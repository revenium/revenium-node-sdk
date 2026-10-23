import { randomUUID } from "crypto";
import { ToolMetadata, ToolCallReport, ToolEventPayload } from "../types/tool-metering.js";
import { getToolContext } from "./tool-context.js";
import { sendToolEvent } from "./tool-api-client.js";
import { getLogger } from "../config/manager.js";
import { resolveAgenticJobFields } from "../metadata/metadata-builder.js";

interface ToolEventPayloadInput {
  toolId: string;
  durationMs: number;
  success: boolean;
  middlewareSource: string;
  errorMessage?: string;
  timestamp?: string;
  fields?: ToolMetadata;
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return (
    value !== null && typeof value === "object" && typeof (value as Promise<T>).then === "function"
  );
}

function extractOutputFields(result: unknown, fields: string[]): Record<string, unknown> {
  if (typeof result !== "object" || result === null) return {};
  const extracted: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in result) {
      extracted[field] = (result as Record<string, unknown>)[field];
    }
  }
  return extracted;
}

function resolveAgenticJobId(fields?: ToolMetadata): string | undefined {
  const perCallJobId = fields?.agenticJobId || fields?.usageMetadata?.agenticJobId;

  return resolveAgenticJobFields({
    agenticJobId: perCallJobId ? String(perCallJobId) : undefined,
  }).agenticJobId;
}

function resolveCostUsd(costUsd?: number): number | undefined {
  if (costUsd === undefined) return undefined;

  if (!Number.isFinite(costUsd) || costUsd < 0) {
    getLogger().warn("costUsd is not a non-negative finite number. Dropping it.", { costUsd });
    return undefined;
  }

  return costUsd;
}

function buildToolEventPayload({
  toolId,
  durationMs,
  success,
  middlewareSource,
  errorMessage,
  timestamp,
  fields,
}: ToolEventPayloadInput): ToolEventPayload {
  const context = getToolContext();

  return {
    transactionId: fields?.transactionId ?? context.transactionId ?? randomUUID(),
    toolId,
    operation: fields?.operation,
    durationMs,
    success,
    timestamp: timestamp ?? new Date().toISOString(),
    errorMessage,
    usageMetadata: fields?.usageMetadata,
    agent: fields?.agent ?? context.agent,
    organizationName: fields?.organizationName ?? context.organizationName,
    productName: fields?.productName ?? context.productName,
    subscriberCredential: fields?.subscriberCredential ?? context.subscriberCredential,
    workflowId: fields?.workflowId ?? context.workflowId,
    traceId: fields?.traceId ?? context.traceId,
    agenticJobId: resolveAgenticJobId(fields),
    costUsd: resolveCostUsd(fields?.costUsd),
    middlewareSource,
  };
}

function dispatchToolEvent(payload: ToolEventPayload): void {
  const logger = getLogger();
  sendToolEvent(payload)
    .then(() => {
      logger.debug("Tool event sent successfully", {
        transactionId: payload.transactionId,
        toolId: payload.toolId,
      });
    })
    .catch((error) => {
      logger.warn("Failed to send tool event", {
        transactionId: payload.transactionId,
        toolId: payload.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function meterTool<T>(
  toolId: string,
  fn: () => T | Promise<T>,
  metadata?: ToolMetadata,
  middlewareSource: string = "revenium-node",
): Promise<T> {
  const startTime = performance.now();

  const handleSuccess = (result: T): T => {
    const durationMs = Math.round(performance.now() - startTime);
    let finalMetadata = metadata;

    if (metadata?.outputFields && metadata.outputFields.length > 0) {
      const extracted = extractOutputFields(result, metadata.outputFields);
      finalMetadata = {
        ...metadata,
        usageMetadata: { ...metadata.usageMetadata, ...extracted },
      };
    }

    dispatchToolEvent(
      buildToolEventPayload({
        toolId,
        durationMs,
        success: true,
        middlewareSource,
        fields: finalMetadata,
      }),
    );
    return result;
  };

  const handleError = (error: unknown): never => {
    const durationMs = Math.round(performance.now() - startTime);
    dispatchToolEvent(
      buildToolEventPayload({
        toolId,
        durationMs,
        success: false,
        middlewareSource,
        errorMessage: error instanceof Error ? error.message : String(error),
        fields: metadata,
      }),
    );
    throw error;
  };

  try {
    const result = fn();
    if (isPromise<T>(result)) {
      return result.then(handleSuccess, handleError);
    }
    return Promise.resolve(handleSuccess(result));
  } catch (error) {
    return Promise.reject(handleError(error));
  }
}

export function reportToolCall(
  toolId: string,
  report: ToolCallReport,
  middlewareSource: string = "revenium-node",
): void {
  dispatchToolEvent(
    buildToolEventPayload({
      toolId,
      durationMs: report.durationMs,
      success: report.success,
      middlewareSource,
      errorMessage: report.errorMessage,
      timestamp: report.timestamp,
      fields: report,
    }),
  );
}

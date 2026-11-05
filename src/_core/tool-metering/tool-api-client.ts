import { randomUUID } from "crypto";
import { ToolEventPayload } from "../types/tool-metering.js";
import { getLogger } from "../config/manager.js";
import { resolveConfig } from "../config/call-config.js";
import { buildReveniumUrl } from "../metering/url-builder.js";
import { DEFAULT_REVENIUM_BASE_URL, API_ENDPOINTS, DEFAULT_CONFIG } from "../constants.js";
import { executeWithMeteringCircuitBreaker } from "../resilience/circuit-breaker.js";
import { withRetry, HttpError, parseRetryAfter } from "../resilience/retry.js";
import { withMeteringTimeout } from "../resilience/request-timeout.js";
import { getMeteringBuffer, shouldBufferError } from "../metering/buffer.js";

export async function sendToolEvent(payload: ToolEventPayload): Promise<void> {
  const config = resolveConfig();
  const logger = getLogger();

  if (!config) {
    logger.warn("Revenium configuration not found, skipping tool event tracking");
    return;
  }

  const url = buildReveniumUrl(
    config.reveniumBaseUrl || DEFAULT_REVENIUM_BASE_URL,
    API_ENDPOINTS.TOOL_EVENTS,
  );

  const { idempotencyKey, ...body } = payload;
  const resolvedIdempotencyKey = idempotencyKey ?? randomUUID();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": config.reveniumApiKey,
    "Idempotency-Key": resolvedIdempotencyKey,
  };
  const serializedBody = JSON.stringify(body);

  logger.debug("Sending tool event to Revenium", {
    url,
    toolId: payload.toolId,
    transactionId: payload.transactionId,
  });

  const postOnce = (): Promise<void> =>
    withMeteringTimeout(async (signal) => {
      const response = await fetch(url, { method: "POST", headers, body: serializedBody, signal });

      if (!response.ok) {
        const responseText = await response.text();
        logger.error("Tool event API error", {
          status: response.status,
          body: responseText,
        });
        throw new HttpError(
          `Revenium tool event API error: ${response.status} ${response.statusText}`,
          response.status,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }
    });

  try {
    await executeWithMeteringCircuitBreaker((isProbe) =>
      withRetry(postOnce, isProbe ? 0 : DEFAULT_CONFIG.MAX_RETRIES),
    );
  } catch (error) {
    if (shouldBufferError(error)) {
      getMeteringBuffer().push({ url, headers, body: serializedBody, createdAt: Date.now() });
    }
    throw error;
  }
}

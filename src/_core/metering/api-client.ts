import { randomUUID } from "crypto";
import { ReveniumPayload } from "../types/index.js";
import { getLogger } from "../config/manager.js";
import { resolveConfig } from "../config/call-config.js";
import { buildReveniumUrl } from "./url-builder.js";
import { DEFAULT_REVENIUM_BASE_URL, API_ENDPOINTS, DEFAULT_CONFIG } from "../constants.js";
import { executeWithMeteringCircuitBreaker } from "../resilience/circuit-breaker.js";
import { withRetry, HttpError, parseRetryAfter } from "../resilience/retry.js";
import { getMeteringBuffer, shouldBufferError } from "./buffer.js";

export async function sendToRevenium(payload: ReveniumPayload): Promise<void> {
  const config = resolveConfig();
  const logger = getLogger();

  if (!config) {
    logger.warn("Revenium configuration not found, skipping tracking");
    return;
  }

  let endpoint: string = API_ENDPOINTS.AI_COMPLETIONS;
  if (payload.operationType === "IMAGE") {
    endpoint = API_ENDPOINTS.AI_IMAGES;
  } else if (payload.operationType === "AUDIO") {
    endpoint = API_ENDPOINTS.AI_AUDIO;
  } else if (payload.operationType === "VIDEO") {
    endpoint = API_ENDPOINTS.AI_VIDEO;
  }

  const url = buildReveniumUrl(config.reveniumBaseUrl || DEFAULT_REVENIUM_BASE_URL, endpoint);

  const { idempotencyKey, ...body } = payload;
  const resolvedIdempotencyKey = idempotencyKey ?? randomUUID();
  const maxRetries = config.maxRetries ?? DEFAULT_CONFIG.MAX_RETRIES;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": config.reveniumApiKey,
    "Idempotency-Key": resolvedIdempotencyKey,
  };
  const serializedBody = JSON.stringify(body);

  logger.debug("Sending Revenium API request", {
    url,
    operationType: payload.operationType,
    transactionId: payload.transactionId,
    model: payload.model,
    totalTokens: payload.totalTokenCount,
  });

  try {
    await executeWithMeteringCircuitBreaker(async () => {
      await withRetry(async () => {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: serializedBody,
        });

        logger.debug("Revenium API response", {
          status: response.status,
          statusText: response.statusText,
          transactionId: payload.transactionId,
          operationType: payload.operationType,
        });

        if (!response.ok) {
          const responseText = await response.text();
          logger.error("Revenium API error response", {
            status: response.status,
            statusText: response.statusText,
            body: responseText,
            transactionId: payload.transactionId,
          });
          throw new HttpError(
            `Revenium API error: ${response.status} ${response.statusText} - ${responseText}`,
            response.status,
            parseRetryAfter(response.headers.get("Retry-After")),
          );
        }

        logger.debug("Revenium tracking successful", {
          transactionId: payload.transactionId,
          operationType: payload.operationType,
        });
      }, maxRetries);
    });
  } catch (error) {
    if (shouldBufferError(error)) {
      getMeteringBuffer().push({ url, headers, body: serializedBody, createdAt: Date.now() });
    }
    throw error;
  }
}

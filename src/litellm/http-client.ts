import { randomUUID } from "crypto";
import { getLogger } from "../_core/config/manager.js";
import {
  trackUsageAsync,
  trackEmbeddingsUsageAsync,
  extractMetadataFromHeaders,
  extractUsageFromResponse,
} from "./tracking.js";
import { StreamingResponseParser } from "./sse-parser.js";
import type {
  LiteLLMConfig,
  RequestBody,
  RequestContext,
  LiteLLMChatCompletionRequest,
  LiteLLMChatCompletionResponse,
  LiteLLMEmbeddingRequest,
  LiteLLMEmbeddingResponse,
} from "./types.js";

const SUPPORTED_ENDPOINTS = [
  "/chat/completions",
  "/v1/chat/completions",
  "/embeddings",
  "/v1/embeddings",
];

let litellmConfig: LiteLLMConfig | null = null;
let isPatched = false;
let originalFetch: typeof globalThis.fetch | null = null;

export function getLiteLLMConfig(): LiteLLMConfig | null {
  return litellmConfig;
}

export function setLiteLLMConfig(config: LiteLLMConfig): void {
  litellmConfig = config;
}

function isLiteLLMProxyRequest(url: string): boolean {
  if (!litellmConfig) return false;
  try {
    const requestUrl = new URL(url);
    const proxyUrl = new URL(litellmConfig.litellmProxyUrl);

    const isSameHost = requestUrl.hostname === proxyUrl.hostname;
    const isSamePort =
      requestUrl.port === proxyUrl.port ||
      ((requestUrl.port === "80" || requestUrl.port === "443") && proxyUrl.port === "");

    let isCorrectEndpoint = false;
    if (SUPPORTED_ENDPOINTS.some((endpoint) => proxyUrl.pathname.endsWith(endpoint))) {
      isCorrectEndpoint = requestUrl.pathname === proxyUrl.pathname;
    } else {
      isCorrectEndpoint = SUPPORTED_ENDPOINTS.some((endpoint) =>
        requestUrl.pathname.endsWith(endpoint),
      );
    }
    return isSameHost && isSamePort && isCorrectEndpoint;
  } catch {
    return false;
  }
}

async function parseRequestBody<T>(requestContext: RequestContext): Promise<T | null> {
  if (!requestContext.body) return null;
  try {
    const bodyText =
      typeof requestContext.body === "string"
        ? requestContext.body
        : await new Response(requestContext.body as string | Blob | ReadableStream).text();
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function extractRequestBody(
  requestContext: RequestContext,
): LiteLLMChatCompletionRequest | undefined {
  try {
    if (typeof requestContext.body === "string") {
      return JSON.parse(requestContext.body);
    } else if (
      typeof requestContext.body === "object" &&
      requestContext.body !== null &&
      "model" in requestContext.body &&
      "messages" in requestContext.body
    ) {
      return requestContext.body as unknown as LiteLLMChatCompletionRequest;
    }
  } catch {
    // skip
  }
  return undefined;
}

async function handleNonStreamingResponse(
  response: Response,
  requestContext: RequestContext,
  requestId: string,
  duration: number,
  model: string,
  responseFormat?: any,
): Promise<void> {
  const logger = getLogger();
  try {
    const responseData = (await response.json()) as LiteLLMChatCompletionResponse;
    const usage = extractUsageFromResponse(responseData);
    const requestBody = extractRequestBody(requestContext);

    trackUsageAsync({
      requestId,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      duration,
      finishReason: usage.finishReason,
      usageMetadata: requestContext.metadata,
      isStreamed: false,
      responseFormat,
      request: requestBody,
      response: responseData,
    });
  } catch (error) {
    logger.error("Error processing non-streaming response", {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
  }
}

async function handleStreamingResponse(
  response: Response,
  requestContext: RequestContext,
  requestId: string,
  duration: number,
  model: string,
  responseFormat?: any,
): Promise<void> {
  const logger = getLogger();
  const requestBody = extractRequestBody(requestContext);

  if (!response.body) {
    trackUsageAsync({
      requestId,
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      duration,
      finishReason: "stop",
      usageMetadata: requestContext.metadata,
      isStreamed: true,
      timeToFirstToken: duration,
      responseFormat,
      request: requestBody,
    });
    return;
  }

  try {
    const streamParser = new StreamingResponseParser(
      requestId,
      model,
      requestContext,
      duration,
      responseFormat,
      requestBody,
    );
    await streamParser.parseStream(response.body);
  } catch (error) {
    logger.error("Error parsing streaming response", {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });

    trackUsageAsync({
      requestId,
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      duration,
      finishReason: "error",
      usageMetadata: requestContext.metadata,
      isStreamed: true,
      timeToFirstToken: duration,
      responseFormat,
      request: requestBody,
    });
  }
}

async function handleEmbeddingResponse(
  response: Response,
  requestContext: RequestContext,
  requestId: string,
  duration: number,
  model: string,
): Promise<void> {
  const logger = getLogger();
  try {
    const responseData = (await response.json()) as LiteLLMEmbeddingResponse;
    const usage = responseData.usage;

    trackEmbeddingsUsageAsync({
      requestId,
      model,
      promptTokens: usage.prompt_tokens,
      totalTokens: usage.total_tokens,
      duration,
      usageMetadata: requestContext.metadata,
    });
  } catch (error) {
    logger.error("Error processing embeddings response", {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
  }
}

async function handleSuccessfulResponse(
  requestContext: RequestContext,
  _originalResponse: Response,
  responseClone: Response,
  requestId: string,
  duration: number,
): Promise<void> {
  const logger = getLogger();
  try {
    const url = new URL(requestContext.url);
    const isEmbeddingsEndpoint =
      url.pathname.endsWith("/embeddings") || url.pathname.endsWith("/v1/embeddings");

    if (isEmbeddingsEndpoint) {
      const requestData = await parseRequestBody<LiteLLMEmbeddingRequest>(requestContext);
      const model = requestData?.model || "unknown";
      await handleEmbeddingResponse(responseClone, requestContext, requestId, duration, model);
    } else {
      const requestData = await parseRequestBody<LiteLLMChatCompletionRequest>(requestContext);
      const isStreaming = requestData?.stream === true;
      const model = requestData?.model || "unknown";
      const responseFormat = requestData?.response_format;

      if (isStreaming) {
        await handleStreamingResponse(
          responseClone,
          requestContext,
          requestId,
          duration,
          model,
          responseFormat,
        );
      } else {
        await handleNonStreamingResponse(
          responseClone,
          requestContext,
          requestId,
          duration,
          model,
          responseFormat,
        );
      }
    }
  } catch (error) {
    logger.error("Error handling LiteLLM response", {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
  }
}

function createPatchedFetch(): typeof fetch {
  return async function patchedFetch(input: any, init?: RequestInit): Promise<Response> {
    const logger = getLogger();
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (!litellmConfig || !isLiteLLMProxyRequest(url)) {
      if (!originalFetch) throw new Error("Original fetch function not available");
      return originalFetch(input, init);
    }

    const rawHeaders = init?.headers ? Object.fromEntries(new Headers(init.headers)) : {};

    const requestContext: RequestContext = {
      url,
      method: init?.method || "GET",
      headers: rawHeaders,
      body: (init?.body as RequestBody) || null,
      startTime: Date.now(),
      metadata: extractMetadataFromHeaders(rawHeaders),
    };

    const requestId = randomUUID();

    try {
      const headers = new Headers(init?.headers);
      if (litellmConfig.litellmApiKey)
        headers.set("Authorization", `Bearer ${litellmConfig.litellmApiKey}`);

      if (!originalFetch) throw new Error("Original fetch function not available");

      const response = await originalFetch(input, { ...init, headers });
      const duration = Date.now() - requestContext.startTime;
      const responseClone = response.clone();

      if (response.ok && requestContext.method === "POST") {
        handleSuccessfulResponse(requestContext, response, responseClone, requestId, duration);
      }

      return response;
    } catch (error) {
      logger.error("LiteLLM Proxy request error", {
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
      throw error;
    }
  };
}

export function patchHttpClient(): boolean {
  const logger = getLogger();
  if (isPatched) return true;

  if (typeof globalThis.fetch !== "function") {
    logger.error("Global fetch function not available");
    return false;
  }

  try {
    originalFetch = globalThis.fetch;
    globalThis.fetch = createPatchedFetch();
    isPatched = true;
    return true;
  } catch (error) {
    logger.error("Failed to patch HTTP client", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function unpatchHttpClient(): boolean {
  const logger = getLogger();
  if (!isPatched) return true;

  if (!originalFetch) {
    logger.error("Original fetch function not stored");
    return false;
  }

  try {
    globalThis.fetch = originalFetch;
    isPatched = false;
    return true;
  } catch (error) {
    logger.error("Failed to unpatch HTTP client", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function isHttpClientPatched(): boolean {
  return isPatched;
}

export function resetHttpClientManager(): void {
  if (isPatched && originalFetch) {
    globalThis.fetch = originalFetch;
  }
  isPatched = false;
  originalFetch = null;
  litellmConfig = null;
}

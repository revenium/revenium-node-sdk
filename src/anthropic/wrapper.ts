import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { getLogger, getConfig } from "../_core/config/manager.js";
import { Config } from "../_core/types/index.js";
import { shouldCapturePrompts } from "../_core/prompt/extraction.js";
import {
  trackUsageAsync,
  extractUsageFromResponse,
  extractUsageFromStream,
  detectVisionContent,
  reconstructResponseFromChunks,
  AnthropicTrackingData,
} from "./middleware.js";
import { AnthropicProvider, detectAnthropicProvider } from "./provider-detection.js";

type AnthropicConfigExtras = Config & { anthropicApiKey?: string };

interface PatchingContext {
  originalMethods: Record<string, any>;
  isPatched: boolean;
  patchedInstances: WeakSet<object>;
}

const patchingContext: PatchingContext = {
  originalMethods: {},
  isPatched: false,
  patchedInstances: new WeakSet(),
};

function getMessagesPrototype(): any {
  try {
    if ((Anthropic as any)?.Messages) return (Anthropic as any).Messages.prototype;

    const anthropicConstructor = Anthropic as any;
    if (anthropicConstructor?._Messages) return anthropicConstructor._Messages.prototype;

    const config = getConfig();
    const apiKey =
      (config as AnthropicConfigExtras)?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error(
        "Unable to access Anthropic Messages prototype: No API key available and direct prototype access failed. " +
          "Provide ANTHROPIC_API_KEY environment variable or pass anthropicApiKey in config.",
      );
    }

    const minimalInstance = new Anthropic({ apiKey });
    return Object.getPrototypeOf(minimalInstance.messages);
  } catch (error) {
    throw new Error(
      `Unable to access Anthropic Messages prototype: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function patchAnthropic(): void {
  const logger = getLogger();

  if (patchingContext.isPatched) {
    logger.debug("Anthropic SDK already patched, skipping duplicate initialization");
    return;
  }

  const messagesPrototype = getMessagesPrototype();
  if (!messagesPrototype) throw new Error("Unable to access Anthropic Messages prototype");

  patchingContext.originalMethods.create = messagesPrototype.create;
  patchingContext.originalMethods.stream = messagesPrototype.stream;

  if (!patchingContext.originalMethods.create) {
    throw new Error("Unable to find original create method");
  }

  messagesPrototype.create = function (this: any, params: any, options?: any): Promise<any> {
    return patchedCreateMethod.call(this, params, options);
  };

  if (patchingContext.originalMethods.stream) {
    messagesPrototype.stream = function (this: any, params: any, options?: any): any {
      return patchedStreamMethod.call(this, params, options);
    };
  }

  patchingContext.isPatched = true;
  logger.info("Anthropic SDK patched successfully");
}

export function unpatchAnthropic(): void {
  const logger = getLogger();

  if (!patchingContext.isPatched) return;

  try {
    const messagesPrototype = getMessagesPrototype();

    if (messagesPrototype && patchingContext.originalMethods.create) {
      messagesPrototype.create = patchingContext.originalMethods.create;
    }

    if (messagesPrototype && patchingContext.originalMethods.stream) {
      messagesPrototype.stream = patchingContext.originalMethods.stream;
    }
  } catch {
    // Ignore errors during unpatch
  }

  patchingContext.isPatched = false;
  patchingContext.originalMethods = {};
  logger.info("Anthropic SDK unpatched successfully");
}

export function isAnthropicPatched(): boolean {
  return patchingContext.isPatched;
}

async function handleStreamingResponse(
  stream: any,
  context: {
    requestId: string;
    requestModel: string;
    metadata: any;
    requestTime: Date;
    startTime: number;
    requestBody: any;
    provider: AnthropicProvider;
  },
) {
  const { requestId, requestModel, metadata, requestTime, startTime, requestBody, provider } =
    context;

  async function* trackingStream() {
    const chunks: any[] = [];
    let firstTokenTime: number | undefined;
    let resolvedModel: string | undefined;

    try {
      for await (const chunk of stream) {
        if (!firstTokenTime && chunk.type === "content_block_delta") {
          firstTokenTime = Date.now();
        }
        if (!resolvedModel && chunk.type === "message_start" && chunk.message?.model) {
          resolvedModel = chunk.message.model;
        }
        chunks.push(chunk);
        yield chunk;
      }

      const duration = Date.now() - startTime;
      const timeToFirstToken = firstTokenTime ? firstTokenTime - startTime : undefined;
      const model = resolvedModel ?? requestModel;

      const usage = extractUsageFromStream(chunks);

      let reconstructedResponse = undefined;
      if (shouldCapturePrompts(metadata)) {
        reconstructedResponse = reconstructResponseFromChunks(chunks, model);
      }

      const trackingData: AnthropicTrackingData = {
        requestId,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreation5mTokens: usage.cacheCreation5mTokens,
        cacheCreation1hTokens: usage.cacheCreation1hTokens,
        reasoningTokens: usage.reasoningTokens,
        duration,
        isStreamed: true,
        stopReason: usage.stopReason,
        metadata,
        requestTime,
        responseTime: new Date(),
        timeToFirstToken,
        requestBody,
        response: reconstructedResponse,
        hasVisionContent: detectVisionContent(requestBody),
        provider,
      };

      trackUsageAsync(trackingData);
    } catch (error) {
      throw error;
    }
  }

  return trackingStream();
}

async function patchedCreateMethod(this: any, params: any, options?: any): Promise<any> {
  const requestId = randomUUID();
  const startTime = Date.now();
  const requestTime = new Date();
  const provider = detectAnthropicProvider(this._client?.baseURL);

  const metadata = params.usageMetadata || {};
  const { usageMetadata: _, ...cleanParams } = params;

  try {
    const originalCreate = patchingContext.originalMethods.create;
    if (!originalCreate) throw new Error("Original create method not available");

    const response = await originalCreate.call(this, cleanParams, options);
    const isStreaming = !!params.stream;

    if (!isStreaming) {
      const duration = Date.now() - startTime;
      const usage = extractUsageFromResponse(response);

      const trackingData: AnthropicTrackingData = {
        requestId,
        model: response.model ?? params.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreation5mTokens: usage.cacheCreation5mTokens,
        cacheCreation1hTokens: usage.cacheCreation1hTokens,
        reasoningTokens: usage.reasoningTokens,
        duration,
        isStreamed: false,
        stopReason: usage.stopReason,
        metadata,
        requestTime,
        responseTime: new Date(),
        hasVisionContent: detectVisionContent(params),
        requestBody: params,
        response,
        provider,
      };

      trackUsageAsync(trackingData);
      return response;
    }

    return handleStreamingResponse(response, {
      requestId,
      requestModel: params.model,
      metadata,
      requestTime,
      startTime,
      requestBody: params,
      provider,
    }) as any;
  } catch (error) {
    throw error;
  }
}

function meterStreamHelper(
  stream: any,
  context: { params: any; metadata: any; provider: AnthropicProvider },
): void {
  const { params, metadata, provider } = context;
  const requestId = randomUUID();
  const startTime = Date.now();
  const requestTime = new Date();
  const chunks: any[] = [];
  let firstTokenTime: number | undefined;

  stream.on("streamEvent", (event: any) => {
    if (!firstTokenTime && event.type === "content_block_delta") {
      firstTokenTime = Date.now();
    }
    chunks.push(event);
  });

  stream.on("finalMessage", (message: any) => {
    const model = message?.model ?? params.model;
    const usage = extractUsageFromStream(chunks);

    const trackingData: AnthropicTrackingData = {
      requestId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreation5mTokens: usage.cacheCreation5mTokens,
      cacheCreation1hTokens: usage.cacheCreation1hTokens,
      reasoningTokens: usage.reasoningTokens,
      duration: Date.now() - startTime,
      isStreamed: true,
      stopReason: usage.stopReason,
      metadata,
      requestTime,
      responseTime: new Date(),
      timeToFirstToken: firstTokenTime ? firstTokenTime - startTime : undefined,
      hasVisionContent: detectVisionContent(params),
      requestBody: params,
      response: shouldCapturePrompts(metadata)
        ? reconstructResponseFromChunks(chunks, model)
        : undefined,
      provider,
    };

    trackUsageAsync(trackingData);
  });
}

function patchedStreamMethod(this: any, params: any, options?: any): any {
  const originalStream = patchingContext.originalMethods.stream;
  if (!originalStream) throw new Error("Original stream method not available");

  const metadata = params.usageMetadata || {};
  const { usageMetadata: _, ...cleanParams } = params;

  const unpatchedResource = Object.create(this, {
    create: { value: patchingContext.originalMethods.create },
  });
  const stream = originalStream.call(unpatchedResource, cleanParams, options);

  meterStreamHelper(stream, {
    params,
    metadata,
    provider: detectAnthropicProvider(this._client?.baseURL),
  });

  return stream;
}

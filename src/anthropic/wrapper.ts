import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/streaming";
import { randomUUID } from "crypto";
import { getLogger, getConfig } from "../_core/config/manager.js";
import { Config, ReveniumConfig } from "../_core/types/index.js";
import { runWithCallConfig } from "../_core/config/call-config.js";
import { shouldCapturePrompts } from "../_core/prompt/extraction.js";
import {
  trackUsageAsync,
  extractUsageFromResponse,
  extractUsageFromStream,
  detectVisionContent,
  reconstructResponseFromChunks,
  AnthropicTrackingData,
  AnthropicUsageCounts,
} from "./middleware.js";
import { AnthropicProvider, detectAnthropicProvider } from "./provider-detection.js";

type AnthropicConfigExtras = Config & { anthropicApiKey?: string };

interface PatchingContext {
  originalMethods: Record<string, any>;
  messagesPrototype?: any;
  betaMessagesPrototype?: any;
  isPatched: boolean;
}

interface AnthropicCallContext {
  requestId: string;
  requestModel: string;
  metadata: any;
  requestTime: Date;
  startTime: number;
  requestBody: any;
  provider: AnthropicProvider;
  config: ReveniumConfig | null;
}

const patchingContext: PatchingContext = {
  originalMethods: {},
  isPatched: false,
};

function resolveAnthropicApiKey(): string | undefined {
  const config = getConfig();
  return (config as AnthropicConfigExtras)?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
}

function getMessagesPrototype(): any {
  try {
    if ((Anthropic as any)?.Messages) return (Anthropic as any).Messages.prototype;

    const anthropicConstructor = Anthropic as any;
    if (anthropicConstructor?._Messages) return anthropicConstructor._Messages.prototype;

    const apiKey = resolveAnthropicApiKey();

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

function getBetaMessagesPrototype(): any {
  try {
    if ((Anthropic as any)?.Beta?.Messages) return (Anthropic as any).Beta.Messages.prototype;

    const apiKey = resolveAnthropicApiKey();
    if (!apiKey) return undefined;

    return Object.getPrototypeOf(new Anthropic({ apiKey }).beta.messages);
  } catch {
    return undefined;
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

  patchingContext.messagesPrototype = messagesPrototype;

  const betaMessagesPrototype = getBetaMessagesPrototype();

  if (betaMessagesPrototype?.create) {
    patchingContext.betaMessagesPrototype = betaMessagesPrototype;
    patchingContext.originalMethods.betaCreate = betaMessagesPrototype.create;
    betaMessagesPrototype.create = function (this: any, params: any, options?: any): any {
      return patchedBetaCreateMethod.call(this, params, options);
    };
  } else {
    logger.debug("Anthropic beta messages surface unavailable, metering regular messages only");
  }

  patchingContext.isPatched = true;
  logger.info("Anthropic SDK patched successfully");
}

export function unpatchAnthropic(): void {
  const logger = getLogger();

  if (!patchingContext.isPatched) return;

  const { messagesPrototype, betaMessagesPrototype, originalMethods } = patchingContext;

  if (messagesPrototype && originalMethods.create) {
    messagesPrototype.create = originalMethods.create;
  }

  if (messagesPrototype && originalMethods.stream) {
    messagesPrototype.stream = originalMethods.stream;
  }

  if (betaMessagesPrototype && originalMethods.betaCreate) {
    betaMessagesPrototype.create = originalMethods.betaCreate;
  }

  patchingContext.isPatched = false;
  patchingContext.originalMethods = {};
  patchingContext.messagesPrototype = undefined;
  patchingContext.betaMessagesPrototype = undefined;
  logger.info("Anthropic SDK unpatched successfully");
}

export function isAnthropicPatched(): boolean {
  return patchingContext.isPatched;
}

function createCallContext(resource: any, params: any): AnthropicCallContext {
  return {
    requestId: randomUUID(),
    requestModel: params.model,
    metadata: params.usageMetadata || {},
    requestTime: new Date(),
    startTime: Date.now(),
    requestBody: params,
    provider: detectAnthropicProvider(resource._client?.baseURL),
    config: getConfig(),
  };
}

function buildTrackingData(
  context: AnthropicCallContext,
  usage: AnthropicUsageCounts,
  details: {
    model: string;
    isStreamed: boolean;
    response: any;
    timeToFirstToken?: number;
  },
): AnthropicTrackingData {
  return {
    requestId: context.requestId,
    model: details.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreation5mTokens: usage.cacheCreation5mTokens,
    cacheCreation1hTokens: usage.cacheCreation1hTokens,
    reasoningTokens: usage.reasoningTokens,
    duration: Date.now() - context.startTime,
    isStreamed: details.isStreamed,
    stopReason: usage.stopReason,
    metadata: context.metadata,
    requestTime: context.requestTime,
    responseTime: new Date(),
    timeToFirstToken: details.timeToFirstToken,
    hasVisionContent: detectVisionContent(context.requestBody),
    requestBody: context.requestBody,
    response: details.response,
    provider: context.provider,
  };
}

function meterMessage(response: any, context: AnthropicCallContext): any {
  runWithCallConfig(context.config, () =>
    trackUsageAsync(
      buildTrackingData(context, extractUsageFromResponse(response), {
        model: response?.model ?? context.requestModel,
        isStreamed: false,
        response,
      }),
    ),
  );
  return response;
}

function meterUnstartedRequest(
  context: AnthropicCallContext,
  isStreamed: boolean,
  error: any,
): void {
  runWithCallConfig(context.config, () =>
    trackUsageAsync(
      buildTrackingData(
        context,
        {
          inputTokens: 0,
          outputTokens: 0,
          stopReason: isAbortError(error) ? "cancelled" : "error",
        },
        { model: context.requestModel, isStreamed, response: undefined },
      ),
    ),
  );
}

function meterStreamChunks(
  chunks: any[],
  context: AnthropicCallContext,
  details: {
    model: string;
    timeToFirstToken?: number;
    fallbackStopReason?: string;
    forcedStopReason?: string;
  },
): void {
  const usage = extractUsageFromStream(chunks);

  runWithCallConfig(context.config, () =>
    trackUsageAsync(
      buildTrackingData(
        context,
        {
          ...usage,
          stopReason: details.forcedStopReason ?? usage.stopReason ?? details.fallbackStopReason,
        },
        {
          model: details.model,
          isStreamed: true,
          timeToFirstToken: details.timeToFirstToken,
          response: shouldCapturePrompts(context.metadata)
            ? reconstructResponseFromChunks(chunks, details.model)
            : undefined,
        },
      ),
    ),
  );
}

interface StreamRecorder {
  record(chunk: any): void;
  meter(fallbackStopReason?: string): void;
  meterError(): void;
}

function createStreamRecorder(context: AnthropicCallContext): StreamRecorder {
  const chunks: any[] = [];
  let firstTokenTime: number | undefined;
  let resolvedModel: string | undefined;
  let metered = false;

  function finalize(stopReasons: { fallback?: string; forced?: string }): void {
    if (metered) return;
    metered = true;

    meterStreamChunks(chunks, context, {
      model: resolvedModel ?? context.requestModel,
      timeToFirstToken: firstTokenTime ? firstTokenTime - context.startTime : undefined,
      fallbackStopReason: stopReasons.fallback,
      forcedStopReason: stopReasons.forced,
    });
  }

  return {
    record(chunk: any): void {
      if (!firstTokenTime && chunk.type === "content_block_delta") {
        firstTokenTime = Date.now();
      }
      if (!resolvedModel && chunk.type === "message_start" && chunk.message?.model) {
        resolvedModel = chunk.message.model;
      }
      chunks.push(chunk);
    },

    meter(fallbackStopReason?: string): void {
      finalize({ fallback: fallbackStopReason });
    },

    meterError(): void {
      finalize({ forced: "error" });
    },
  };
}

function isAbortError(error: any): boolean {
  return error instanceof APIUserAbortError || error?.name === "AbortError";
}

function wasStreamAborted(stream: any): boolean {
  return stream?.controller?.signal?.aborted === true;
}

async function* createTrackingStream(stream: any, context: AnthropicCallContext) {
  const recorder = createStreamRecorder(context);

  try {
    for await (const chunk of stream) {
      recorder.record(chunk);
      yield chunk;
    }
    recorder.meter(wasStreamAborted(stream) ? "cancelled" : undefined);
  } catch (error) {
    if (!isAbortError(error)) recorder.meterError();
    throw error;
  } finally {
    recorder.meter("cancelled");
  }
}

async function patchedCreateMethod(this: any, params: any, options?: any): Promise<any> {
  const originalCreate = patchingContext.originalMethods.create;
  if (!originalCreate) throw new Error("Original create method not available");

  const context = createCallContext(this, params);
  const { usageMetadata: _, ...cleanParams } = params;

  let response: any;
  try {
    response = await originalCreate.call(this, cleanParams, options);
  } catch (error) {
    meterUnstartedRequest(context, !!params.stream, error);
    throw error;
  }

  if (!params.stream) return meterMessage(response, context);

  return createTrackingStream(response, context) as any;
}

function createMemberForwarder(target: any): (property: string | symbol) => any {
  const boundMembers = new Map<string | symbol, any>();

  return (property: string | symbol): any => {
    const value = target[property];
    if (typeof value !== "function") return value;

    if (!boundMembers.has(property)) boundMembers.set(property, value.bind(target));
    return boundMembers.get(property);
  };
}

function instrumentBetaStream(stream: any, context: AnthropicCallContext): any {
  const originalIterator = stream.iterator.bind(stream);

  stream.iterator = () =>
    createTrackingStream(
      { [Symbol.asyncIterator]: originalIterator, controller: stream.controller },
      context,
    );

  return stream;
}

interface BetaMetering {
  instrument(value: any): any;
  meterRawResponse(response: Response): Response;
  recordFailure(error: any): void;
}

async function meterResponseClone(
  response: Response,
  context: AnthropicCallContext,
  isStreaming: boolean,
): Promise<void> {
  try {
    const clone = response.clone();

    if (!isStreaming) {
      meterMessage(await clone.json(), context);
      return;
    }

    const events = Stream.fromSSEResponse<any>(clone, new AbortController());
    for await (const event of createTrackingStream(events, context)) {
      void event;
    }
  } catch (error) {
    getLogger().warn("Unable to meter Anthropic beta raw response", {
      requestId: context.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function createBetaMetering(context: AnthropicCallContext, isStreaming: boolean): BetaMetering {
  let metered = false;
  let instrumented: any;

  return {
    instrument(value: any): any {
      if (metered) return instrumented ?? value;

      metered = true;
      instrumented = isStreaming
        ? instrumentBetaStream(value, context)
        : meterMessage(value, context);
      return instrumented;
    },

    meterRawResponse(response: Response): Response {
      if (!metered) {
        metered = true;
        void meterResponseClone(response, context, isStreaming);
      }
      return response;
    },

    recordFailure(error: any): void {
      if (metered) return;

      metered = true;
      meterUnstartedRequest(context, isStreaming, error);
    },
  };
}

function instrumentBetaPromise(apiPromise: any, metering: BetaMetering): any {
  const forwardMember = createMemberForwarder(apiPromise);

  const rethrowMetered = (error: any): never => {
    metering.recordFailure(error);
    throw error;
  };

  const proxy: any = new Proxy(apiPromise, {
    get(target: any, property: string | symbol) {
      switch (property) {
        case "then":
          return (onFulfilled?: any, onRejected?: any) =>
            target
              .then((value: any) => metering.instrument(value), rethrowMetered)
              .then(onFulfilled, onRejected);
        case "catch":
          return (onRejected?: any) => proxy.then(undefined, onRejected);
        case "finally":
          return (onFinally?: any) => proxy.then().finally(onFinally);
        case "asResponse":
          return () =>
            target
              .asResponse()
              .then((response: Response) => metering.meterRawResponse(response), rethrowMetered);
        case "withResponse":
          return () =>
            target.withResponse().then(
              (result: any) => ({
                ...result,
                data: metering.instrument(result.data),
              }),
              rethrowMetered,
            );
        case "_thenUnwrap":
          return (transform: any) => {
            const unwrapped = target._thenUnwrap((value: any, props: any) =>
              transform(metering.instrument(value), props),
            );
            unwrapped.catch((error: any) => metering.recordFailure(error));
            return unwrapped;
          };
        default:
          return forwardMember(property);
      }
    },
  });

  return proxy;
}

function patchedBetaCreateMethod(this: any, params: any, options?: any): any {
  const originalBetaCreate = patchingContext.originalMethods.betaCreate;
  if (!originalBetaCreate) throw new Error("Original beta create method not available");

  const context = createCallContext(this, params);
  const { usageMetadata: _, ...cleanParams } = params;

  return instrumentBetaPromise(
    originalBetaCreate.call(this, cleanParams, options),
    createBetaMetering(context, !!params.stream),
  );
}

function meterStreamHelper(stream: any, context: AnthropicCallContext): void {
  const recorder = createStreamRecorder(context);

  stream.on("streamEvent", (event: any) => recorder.record(event));
  stream.on("finalMessage", () => recorder.meter());
  stream.on("end", () => {
    if (stream.aborted) {
      recorder.meter("cancelled");
      return;
    }
    if (stream.errored) {
      recorder.meterError();
      return;
    }
    recorder.meter();
  });
}

function patchedStreamMethod(this: any, params: any, options?: any): any {
  const originalStream = patchingContext.originalMethods.stream;
  if (!originalStream) throw new Error("Original stream method not available");

  const context = createCallContext(this, params);
  const { usageMetadata: _, ...cleanParams } = params;

  const unpatchedResource = Object.create(this, {
    create: { value: patchingContext.originalMethods.create },
  });
  const stream = originalStream.call(unpatchedResource, cleanParams, options);

  meterStreamHelper(stream, context);

  return stream;
}

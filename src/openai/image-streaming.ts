import type OpenAI from "openai";
import type { Config, UsageMetadata } from "../_core/types/index.js";
import { runWithCallConfig } from "../_core/config/call-config.js";
import type { ImageOperationSubtype } from "../_core/metering/operation-subtype.js";
import type { ImagePayloadExtra } from "../_core/metering/payload-builder.js";
import type { ProviderInfo } from "./provider-detection.js";
import { ERROR_STOP_REASON } from "../_core/stop-reason-mapper.js";

type ImageStreamEvent = OpenAI.ImageGenStreamEvent | OpenAI.ImageEditStreamEvent;

type CompletedImageEvent = OpenAI.ImageGenCompletedEvent | OpenAI.ImageEditCompletedEvent;

type ImageStreamTracker = (
  operationSubtype: ImageOperationSubtype,
  response: unknown,
  request: unknown,
  startTime: number,
  duration: number,
  config: unknown,
  providerInfo: ProviderInfo,
  metadata: UsageMetadata | undefined,
  extra: ImagePayloadExtra,
) => void;

const COMPLETED_EVENT_TYPES = new Set(["image_generation.completed", "image_edit.completed"]);

const PARTIAL_EVENT_TYPES = new Set(["image_generation.partial_image", "image_edit.partial_image"]);

const UNREPORTED_TOKENS = { input: null, output: null, total: null } as const;

export function isImageStreamRequest(params: { stream?: boolean | null }): boolean {
  return params.stream === true;
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<ImageStreamEvent> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

export function instrumentImageStream(
  stream: AsyncIterable<ImageStreamEvent>,
  operationSubtype: ImageOperationSubtype,
  request: unknown,
  startTime: number,
  config: Config,
  providerInfo: ProviderInfo,
  metadata: UsageMetadata | undefined,
  track: ImageStreamTracker,
): AsyncIterable<ImageStreamEvent> {
  const providerStream = stream as { iterator?: () => AsyncIterator<ImageStreamEvent> };

  if (typeof providerStream.iterator !== "function") {
    return meterImageStream(
      stream,
      operationSubtype,
      request,
      startTime,
      config,
      providerInfo,
      metadata,
      track,
    );
  }

  const originalIterator = providerStream.iterator.bind(providerStream);
  let instrumented = false;
  providerStream.iterator = () => {
    if (instrumented) return originalIterator();
    instrumented = true;
    return meterImageStream(
      { [Symbol.asyncIterator]: originalIterator },
      operationSubtype,
      request,
      startTime,
      config,
      providerInfo,
      metadata,
      track,
    );
  };

  return stream;
}

async function* meterImageStream(
  stream: AsyncIterable<ImageStreamEvent>,
  operationSubtype: ImageOperationSubtype,
  request: unknown,
  startTime: number,
  config: Config,
  providerInfo: ProviderInfo,
  metadata: UsageMetadata | undefined,
  track: ImageStreamTracker,
): AsyncGenerator<ImageStreamEvent> {
  const reportedTokens = { input: 0, output: 0, total: 0 };
  let completedImageCount = 0;
  let usageReported = false;
  let firstImageTime: number | undefined;
  let metered = false;

  const meter = (extra: ImagePayloadExtra = {}) =>
    runWithCallConfig(config, () =>
      track(
        operationSubtype,
        undefined,
        request,
        startTime,
        Date.now() - startTime,
        config,
        providerInfo,
        metadata,
        {
          ...extra,
          completedImageCount,
          isStreamed: true,
          timeToFirstToken: firstImageTime ? firstImageTime - startTime : undefined,
          tokens: usageReported ? { ...reportedTokens } : { ...UNREPORTED_TOKENS },
        },
      ),
    );

  try {
    for await (const event of stream) {
      if (PARTIAL_EVENT_TYPES.has(event.type) || COMPLETED_EVENT_TYPES.has(event.type)) {
        firstImageTime ??= Date.now();
      }
      if (COMPLETED_EVENT_TYPES.has(event.type)) {
        const completed = event as CompletedImageEvent;
        completedImageCount += 1;
        if (completed.usage) {
          usageReported = true;
          reportedTokens.input += completed.usage.input_tokens;
          reportedTokens.output += completed.usage.output_tokens;
          reportedTokens.total += completed.usage.total_tokens;
        }
      }
      yield event;
    }

    metered = true;
    meter();
  } catch (error) {
    metered = true;
    meter({ stopReason: ERROR_STOP_REASON });
    throw error;
  } finally {
    if (!metered) meter({ stopReason: "CANCELLED" });
  }
}

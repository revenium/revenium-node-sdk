import { randomUUID } from "crypto";
import { getLogger } from "../_core/config/manager.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import { buildMetadataFields } from "../_core/metadata/metadata-builder.js";
import {
  getEnvironment,
  getRegion,
  getCredentialAlias,
  getTraceType,
  getTraceName,
  getParentTransactionId,
  getTransactionName,
  getRetryNumber,
  getTicketId,
} from "../_core/metadata/trace-fields.js";
import {
  IMAGE_OPERATION_SUBTYPES,
  VIDEO_OPERATION_SUBTYPES,
  resolveAudioBillingUnit,
  resolveAudioOperationSubtype,
  resolveOperationSubtype,
  type AudioOperationSubtype,
} from "../_core/metering/operation-subtype.js";
import { printUsageSummary } from "../_core/prompt/summary-printer.js";
import type { ReveniumPayload } from "../_core/types/index.js";
import type {
  FalTrackingData,
  FalUsageMetadata,
  FalImageResult,
  FalVideoResult,
  FalAudioResult,
  FalChatResult,
} from "./types.js";

const MIDDLEWARE_SOURCE = "revenium-fal-node";
const PROVIDER = "fal_ai";
const MODEL_SOURCE = "FAL_AI";

function extractModelName(endpointId: string, input?: Record<string, unknown>): string {
  if (typeof input?.model === "string" && input.model) return input.model;
  return endpointId;
}

function buildCommonFields(
  data: FalTrackingData,
  metadata: FalUsageMetadata | undefined,
  operationSubtype?: string,
): Omit<ReveniumPayload, "inputTokenCount" | "outputTokenCount" | "totalTokenCount"> {
  const now = new Date().toISOString();
  const requestTime = new Date(data.startTime).toISOString();
  const metadataFields = buildMetadataFields(metadata);

  return {
    transactionId: data.requestId ? `fal-${data.requestId}` : `fal-${randomUUID()}`,
    operationType: data.operationType,
    costType: "AI",
    model: extractModelName(data.endpointId, data.input),
    provider: PROVIDER,
    modelSource: MODEL_SOURCE,
    middlewareSource: MIDDLEWARE_SOURCE,
    requestTime,
    responseTime: now,
    requestDuration: Math.round(data.duration),
    completionStartTime: now,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: "END",
    isStreamed: data.isStreamed,
    ...metadataFields,
    environment: metadata?.environment || getEnvironment() || undefined,
    credentialAlias: metadata?.credentialAlias || getCredentialAlias() || undefined,
    traceType: metadata?.traceType || getTraceType() || undefined,
    traceName: metadata?.traceName || getTraceName() || undefined,
    parentTransactionId: metadata?.parentTransactionId || getParentTransactionId() || undefined,
    transactionName: metadata?.transactionName || getTransactionName() || undefined,
    retryNumber: metadata?.retryNumber ?? getRetryNumber() ?? undefined,
    operationSubtype: operationSubtype || metadata?.operationSubtype || undefined,
    ticketId: metadata?.ticketId || getTicketId() || undefined,
  };
}

function subtypeFor<T extends string>(
  data: FalTrackingData,
  accepted: readonly T[],
  detected: T,
): T {
  return resolveOperationSubtype(accepted, data.usageMetadata?.operationSubtype, detected);
}

function buildImageTrackingPayload(data: FalTrackingData): ReveniumPayload {
  const result = data.result as FalImageResult;
  const images = result?.images || [];
  const requestedCount = (data.input?.num_images as number) ?? 1;
  const firstImage = images[0];
  const hasValidDimensions = firstImage?.width && firstImage?.height;
  const resolution = hasValidDimensions
    ? `${firstImage.width}x${firstImage.height}`
    : (data.input?.image_size as string) || "unknown";

  const attributes: Record<string, unknown> = {
    billing_unit: "per_image",
    actual_image_count: images.length,
    requested_image_count: requestedCount,
    resolution,
  };

  if (result?.seed !== undefined) attributes.seed = result.seed;
  if (result?.has_nsfw_concepts) attributes.has_nsfw_concepts = result.has_nsfw_concepts;

  return {
    ...buildCommonFields(
      data,
      data.usageMetadata,
      subtypeFor(data, IMAGE_OPERATION_SUBTYPES, "generation"),
    ),
    inputTokenCount: null,
    outputTokenCount: null,
    totalTokenCount: null,
    requestedImageCount: requestedCount,
    actualImageCount: images.length,
    attributes,
  };
}

function buildVideoTrackingPayload(data: FalTrackingData): ReveniumPayload {
  const result = data.result as FalVideoResult;
  const videoDuration =
    (data.input?.duration as number) || (data.result?.duration as number) || undefined;
  const aspectRatio = (data.input?.aspect_ratio as string) || undefined;

  const attributes: Record<string, unknown> = {
    billing_unit: "per_second",
    video_duration_seconds: videoDuration,
  };

  if (aspectRatio) attributes.aspect_ratio = aspectRatio;
  if (result?.video?.url || result?.file_url) attributes.has_output = true;

  return {
    ...buildCommonFields(
      data,
      data.usageMetadata,
      subtypeFor(data, VIDEO_OPERATION_SUBTYPES, "generation"),
    ),
    inputTokenCount: null,
    outputTokenCount: null,
    totalTokenCount: null,
    durationSeconds: videoDuration,
    attributes,
  };
}

const TRANSCRIPTION_ENDPOINTS = /whisper|lava-sr|transcri|speech-to-text|speech_to_text|\bstt\b/;
const TEXT_TO_SPEECH_ENDPOINTS =
  /tts|text-to-speech|text_to_speech|speech|kokoro|chatterbox|parler/;

function classifyAudioSubtype(endpointId: string): AudioOperationSubtype {
  const endpoint = endpointId.toLowerCase();
  if (TRANSCRIPTION_ENDPOINTS.test(endpoint)) return "transcription";
  if (TEXT_TO_SPEECH_ENDPOINTS.test(endpoint)) return "tts";
  return "synthesis";
}

const MEASURED_DURATION_SUBTYPES: readonly AudioOperationSubtype[] = [
  "transcription",
  "translation",
];

function resolveAudioDurationSeconds(
  data: FalTrackingData,
  result: FalAudioResult,
  subtype: AudioOperationSubtype,
): number {
  const measuredDurationSeconds = result?.duration || 0;
  if (measuredDurationSeconds > 0 || MEASURED_DURATION_SUBTYPES.includes(subtype)) {
    return measuredDurationSeconds;
  }
  return (data.input?.duration as number) || 0;
}

function buildAudioTrackingPayload(data: FalTrackingData): ReveniumPayload {
  const result = data.result as FalAudioResult;
  const subtype = resolveAudioOperationSubtype(
    data.usageMetadata?.operationSubtype,
    classifyAudioSubtype(data.endpointId),
  );

  const attributes: Record<string, unknown> = {};
  let durationSeconds: number | undefined;
  let characterCount: number | undefined;

  const inputText =
    (data.input?.text as string) ||
    (data.input?.prompt as string) ||
    (data.input?.input as string) ||
    "";
  const inputCharacterCount = inputText.length;
  const audioDurationSeconds = resolveAudioDurationSeconds(data, result, subtype);
  const billingUnit = resolveAudioBillingUnit(subtype, inputCharacterCount, audioDurationSeconds);

  attributes.billing_unit = billingUnit;
  if (billingUnit === "per_character") {
    characterCount = inputCharacterCount;
    attributes.character_count = characterCount;
  } else {
    durationSeconds = audioDurationSeconds;
    attributes.duration_seconds = durationSeconds;
  }

  return {
    ...buildCommonFields(data, data.usageMetadata, subtype),
    inputTokenCount: null,
    outputTokenCount: null,
    totalTokenCount: null,
    durationSeconds,
    characterCount,
    attributes,
  };
}

function buildChatTrackingPayload(data: FalTrackingData): ReveniumPayload {
  const result = data.result as FalChatResult;
  const usage = result?.usage;

  return {
    ...buildCommonFields(data, data.usageMetadata),
    inputTokenCount: usage?.prompt_tokens ?? null,
    outputTokenCount: usage?.completion_tokens ?? null,
    totalTokenCount: usage?.total_tokens ?? null,
  };
}

function buildPayloadForType(data: FalTrackingData): ReveniumPayload {
  switch (data.operationType) {
    case "IMAGE":
      return buildImageTrackingPayload(data);
    case "VIDEO":
      return buildVideoTrackingPayload(data);
    case "AUDIO":
      return buildAudioTrackingPayload(data);
    case "CHAT":
      return buildChatTrackingPayload(data);
    default:
      return buildImageTrackingPayload(data);
  }
}

export async function sendFalMetrics(data: FalTrackingData): Promise<boolean> {
  const logger = getLogger();
  const region = data.usageMetadata?.region || (await getRegion()) || undefined;
  const payload = buildPayloadForType(data);
  payload.region = region;
  let success = true;

  try {
    await sendToRevenium(payload);
  } catch (error) {
    success = false;
    logger.warn("Fal tracking failed", {
      error: error instanceof Error ? error.message : String(error),
      endpointId: data.endpointId,
    });
  }

  printUsageSummary(payload);
  return success;
}

export function trackFalUsageAsync(data: FalTrackingData): void {
  const logger = getLogger();

  sendFalMetrics(data)
    .then((success) => {
      if (success) {
        logger.debug("Fal tracking completed", { endpointId: data.endpointId });
      }
    })
    .catch((error) => {
      logger.warn("Fal tracking failed completely", {
        error: error instanceof Error ? error.message : String(error),
        endpointId: data.endpointId,
      });
    });
}

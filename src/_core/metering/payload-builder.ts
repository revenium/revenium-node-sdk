import { randomUUID } from "crypto";
import { ReveniumPayload, UsageMetadata } from "../types/index.js";
import { buildMetadataFields } from "../metadata/metadata-builder.js";
import {
  getEnvironment,
  getRegion,
  getCredentialAlias,
  getTraceType,
  getTraceName,
  getTicketId,
  getParentTransactionId,
  getTransactionName,
  getRetryNumber,
  detectOperationSubtype,
} from "../metadata/trace-fields.js";
import {
  IMAGE_OPERATION_SUBTYPES,
  VIDEO_OPERATION_SUBTYPES,
  resolveAudioBillingUnit,
  resolveAudioOperationSubtype,
  resolveOperationSubtype,
  toMeteringBillingUnit,
  type AudioOperationSubtype,
  type ImageOperationSubtype,
  type LegacyAudioOperationSubtype,
  type VideoOperationSubtype,
} from "./operation-subtype.js";
import { ERROR_STOP_REASON } from "../stop-reason-mapper.js";
import { readAudioUsage } from "./audio-usage.js";

const DEFAULT_IMAGE_RESOLUTION = "1024x1024";

export interface PayloadParams {
  operationType: "CHAT" | "EMBED";
  model: string;
  requestId?: string;
  startTime: number;
  duration: number;
  provider: string;
  modelSource: string;
  middlewareSource: string;
  usageMetadata?: UsageMetadata;
  usage: {
    prompt_tokens: number | null;
    completion_tokens?: number;
    total_tokens: number | null;
    reasoning_tokens?: number;
    cached_tokens?: number;
    cache_creation_tokens?: number;
    cache_creation_5m_tokens?: number;
    cache_creation_1h_tokens?: number;
  };
  stopReason: string;
  isStreamed: boolean;
  timeToFirstToken?: number;
  request?: any;
  promptData?: {
    systemPrompt?: string;
    inputMessages?: string;
    outputResponse?: string;
    promptsTruncated: boolean;
  } | null;
  attributes?: Record<string, unknown>;
}

export async function buildPayload(params: PayloadParams): Promise<ReveniumPayload> {
  const now = new Date().toISOString();
  const requestTime = new Date(params.startTime).toISOString();
  const metadataFields = buildMetadataFields(params.usageMetadata);

  const basePayload: ReveniumPayload = {
    transactionId: params.requestId || `${params.operationType.toLowerCase()}-${randomUUID()}`,
    operationType: params.operationType,
    costType: "AI",
    model: params.model,
    provider: params.provider,
    modelSource: params.modelSource,
    middlewareSource: params.middlewareSource,
    requestTime,
    responseTime: now,
    requestDuration: params.duration,
    completionStartTime: now,
    inputTokenCount: params.usage.prompt_tokens,
    outputTokenCount: params.operationType === "EMBED" ? 0 : params.usage.completion_tokens || 0,
    totalTokenCount: params.usage.total_tokens,
    reasoningTokenCount: params.usage.reasoning_tokens ?? undefined,
    cacheCreationTokenCount: params.usage.cache_creation_tokens ?? undefined,
    cacheReadTokenCount: params.usage.cached_tokens ?? undefined,
    cacheCreation5mTokenCount: params.usage.cache_creation_5m_tokens ?? undefined,
    cacheCreation1hTokenCount: params.usage.cache_creation_1h_tokens ?? undefined,
    stopReason: params.stopReason,
    isStreamed: params.isStreamed,
    timeToFirstToken: params.timeToFirstToken,
    ...metadataFields,
    environment: (metadataFields.environment as string) ?? getEnvironment() ?? undefined,
    region: (metadataFields.region as string) ?? (await getRegion()) ?? undefined,
    credentialAlias:
      (metadataFields.credentialAlias as string) ?? getCredentialAlias() ?? undefined,
    traceType: (metadataFields.traceType as string) ?? getTraceType() ?? undefined,
    traceName: (metadataFields.traceName as string) ?? getTraceName() ?? undefined,
    ticketId: (metadataFields.ticketId as string) ?? getTicketId() ?? undefined,
    parentTransactionId:
      (metadataFields.parentTransactionId as string) ?? getParentTransactionId() ?? undefined,
    transactionName:
      (metadataFields.transactionName as string) ?? getTransactionName() ?? undefined,
    retryNumber: (metadataFields.retryNumber as number) ?? getRetryNumber() ?? undefined,
    operationSubtype:
      (metadataFields.operationSubtype as string) ??
      detectOperationSubtype(params.request) ??
      undefined,
    ...(params.attributes &&
      Object.keys(params.attributes).length > 0 && { attributes: params.attributes }),
    ...(params.promptData && {
      systemPrompt: params.promptData.systemPrompt,
      inputMessages: params.promptData.inputMessages,
      outputResponse: params.promptData.outputResponse,
      promptsTruncated: params.promptData.promptsTruncated,
    }),
  };

  return basePayload;
}

export interface ImagePayloadExtra {
  failed?: boolean;
  completedImageCount?: number;
  isStreamed?: boolean;
  timeToFirstToken?: number;
  stopReason?: string;
  tokens?: {
    input: number | null;
    output: number | null;
    total: number | null;
  };
}

export function buildImagePayload(
  detectedSubtype: ImageOperationSubtype,
  response: any,
  request: any,
  startTime: number,
  duration: number,
  provider: string,
  modelSource: string,
  middlewareSource: string,
  usageMetadata?: UsageMetadata,
  extra?: ImagePayloadExtra,
): ReveniumPayload {
  const now = new Date().toISOString();
  const requestTime = new Date(startTime).toISOString();
  const metadataFields = buildMetadataFields(usageMetadata);
  const operationSubtype = resolveOperationSubtype(
    IMAGE_OPERATION_SUBTYPES,
    metadataFields.operationSubtype,
    detectedSubtype,
  );
  const actualImageCount = extra?.failed
    ? 0
    : (extra?.completedImageCount ?? response?.data?.length ?? 0);

  const requestedImageCount = request.n || 1;
  const resolution: string | undefined = response?.size ?? request.size;
  const quality = response?.quality ?? request.quality;
  const style = request.style;

  const attributes: Record<string, unknown> = {
    billing_unit: "per_image",
    actual_image_count: actualImageCount,
    requested_image_count: requestedImageCount,
    resolution: resolution ?? DEFAULT_IMAGE_RESOLUTION,
    quality,
    style,
    response_format: request.response_format || "url",
  };

  if (operationSubtype === "generation") {
    attributes.revised_prompt_provided = response?.data?.[0]?.revised_prompt !== undefined;
  } else if (operationSubtype === "edit") {
    attributes.has_mask = request.mask !== undefined;
  }

  return {
    transactionId: `image-${operationSubtype}-${randomUUID()}`,
    operationType: "IMAGE",
    costType: "AI",
    model: request.model || "dall-e-2",
    provider,
    modelSource,
    middlewareSource,
    requestTime,
    responseTime: now,
    requestDuration: duration,
    completionStartTime: now,
    inputTokenCount: extra?.tokens?.input ?? null,
    outputTokenCount: extra?.tokens?.output ?? null,
    totalTokenCount: extra?.tokens?.total ?? null,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: extra?.failed ? ERROR_STOP_REASON : (extra?.stopReason ?? "END"),
    isStreamed: extra?.isStreamed ?? false,
    timeToFirstToken: extra?.timeToFirstToken,
    ...metadataFields,
    operationSubtype,
    requestedImageCount,
    actualImageCount,
    resolution,
    quality,
    style,
    attributes,
  };
}

export function buildAudioPayload(
  detectedSubtype: AudioOperationSubtype | LegacyAudioOperationSubtype,
  response: any,
  request: any,
  startTime: number,
  duration: number,
  provider: string,
  modelSource: string,
  middlewareSource: string,
  usageMetadata?: UsageMetadata,
): ReveniumPayload {
  const now = new Date().toISOString();
  const requestTime = new Date(startTime).toISOString();
  const metadataFields = buildMetadataFields(usageMetadata);
  const operationSubtype = resolveAudioOperationSubtype(
    metadataFields.operationSubtype,
    detectedSubtype,
  );

  const attributes: Record<string, unknown> = {};
  let durationSeconds: number | undefined;
  let characterCount: number | undefined;
  let inputAudioTokenCount: number | undefined;

  const requestedCharacterCount = typeof request.input === "string" ? request.input.length : 0;
  const audioUsage = readAudioUsage(response);
  const billingUnit = resolveAudioBillingUnit(
    operationSubtype,
    requestedCharacterCount,
    audioUsage.durationSeconds,
    audioUsage.audioTokenCount,
  );
  const producesAudio =
    operationSubtype === "tts" || operationSubtype === "speech" || operationSubtype === "synthesis";

  if (producesAudio) {
    attributes.voice = request.voice;
    attributes.speed = request.speed;
    attributes.response_format = request.response_format || "mp3";
  } else {
    attributes.language = request.language || response.language;
    attributes.response_format = request.response_format || "json";
    attributes.temperature = request.temperature;
    if (operationSubtype === "translation") {
      attributes.target_language = "en";
    }
    if (request.timestamp_granularities) {
      attributes.timestamp_granularities = request.timestamp_granularities;
    }
  }

  if (billingUnit === "per_character") {
    attributes.requested_character_count = requestedCharacterCount;
    characterCount = requestedCharacterCount;
  } else if (billingUnit === "per_token") {
    attributes.audio_token_count = audioUsage.audioTokenCount;
    inputAudioTokenCount = audioUsage.audioTokenCount;
  } else {
    attributes.actual_duration_seconds = audioUsage.durationSeconds;
    durationSeconds = audioUsage.durationSeconds;
  }

  return {
    transactionId: `audio-${operationSubtype}-${randomUUID()}`,
    operationType: "AUDIO",
    costType: "AI",
    model: request.model || "whisper-1",
    provider,
    modelSource,
    middlewareSource,
    requestTime,
    responseTime: now,
    requestDuration: duration,
    completionStartTime: now,
    inputTokenCount: audioUsage.inputTokenCount ?? null,
    outputTokenCount: audioUsage.outputTokenCount ?? null,
    totalTokenCount: audioUsage.totalTokenCount ?? null,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: "END",
    isStreamed: false,
    timeToFirstToken: undefined,
    ...metadataFields,
    operationSubtype,
    billingUnit: toMeteringBillingUnit(billingUnit),
    durationSeconds,
    characterCount,
    inputAudioTokenCount,
    attributes,
  };
}

export interface VideoPayloadExtra {
  videoDurationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  quality?: string;
  frameRate?: number;
  serviceTier?: string;
  region?: string;
  asyncJobId?: string;
  failed?: boolean;
}

export function buildVideoPayload(
  detectedSubtype: VideoOperationSubtype,
  request: any,
  startTime: number,
  duration: number,
  provider: string,
  modelSource: string,
  middlewareSource: string,
  usageMetadata?: UsageMetadata,
  extra?: VideoPayloadExtra,
): ReveniumPayload {
  const now = new Date().toISOString();
  const requestTime = new Date(startTime).toISOString();
  const metadataFields = buildMetadataFields(usageMetadata);
  const operationSubtype = resolveOperationSubtype(
    VIDEO_OPERATION_SUBTYPES,
    metadataFields.operationSubtype,
    detectedSubtype,
  );
  const videoDurationSeconds = extra?.failed ? 0 : extra?.videoDurationSeconds;

  const attributes: Record<string, unknown> = {
    billing_unit: "per_second",
    video_duration_seconds: videoDurationSeconds || 0,
    resolution: extra?.resolution,
    aspect_ratio: extra?.aspectRatio,
    quality: extra?.quality,
    frame_rate: extra?.frameRate,
    service_tier: extra?.serviceTier,
    region: extra?.region,
    async_job_id: extra?.asyncJobId,
  };

  return {
    transactionId: `video-${operationSubtype}-${randomUUID()}`,
    operationType: "VIDEO",
    costType: "AI",
    model: request.model || "veo-001",
    provider,
    modelSource,
    middlewareSource,
    requestTime,
    responseTime: now,
    requestDuration: duration,
    completionStartTime: now,
    inputTokenCount: null,
    outputTokenCount: null,
    totalTokenCount: null,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: extra?.failed ? ERROR_STOP_REASON : "END",
    isStreamed: false,
    timeToFirstToken: undefined,
    ...metadataFields,
    operationSubtype,
    durationSeconds: videoDurationSeconds,
    resolution: extra?.resolution,
    attributes,
  };
}

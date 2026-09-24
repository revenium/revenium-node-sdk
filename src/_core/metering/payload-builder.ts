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
  type AudioOperationSubtype,
  type ImageOperationSubtype,
  type LegacyAudioOperationSubtype,
  type VideoOperationSubtype,
} from "./operation-subtype.js";

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
    prompt_tokens: number;
    completion_tokens?: number;
    total_tokens: number;
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
): ReveniumPayload {
  const now = new Date().toISOString();
  const requestTime = new Date(startTime).toISOString();
  const metadataFields = buildMetadataFields(usageMetadata);
  const operationSubtype = resolveOperationSubtype(
    IMAGE_OPERATION_SUBTYPES,
    metadataFields.operationSubtype,
    detectedSubtype,
  );

  const attributes: Record<string, unknown> = {
    billing_unit: "per_image",
    actual_image_count: response.data?.length || 0,
  };

  if (operationSubtype === "generation") {
    attributes.requested_image_count = request.n || 1;
    attributes.resolution = request.size || "1024x1024";
    attributes.quality = request.quality;
    attributes.style = request.style;
    attributes.response_format = request.response_format || "url";
    attributes.revised_prompt_provided = response.data?.[0]?.revised_prompt !== undefined;
  } else if (operationSubtype === "edit") {
    attributes.requested_image_count = request.n || 1;
    attributes.resolution = request.size || "1024x1024";
    attributes.response_format = request.response_format || "url";
    attributes.has_mask = request.mask !== undefined;
  } else {
    attributes.requested_image_count = request.n || 1;
    attributes.resolution = request.size || "1024x1024";
    attributes.response_format = request.response_format || "url";
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
    inputTokenCount: null,
    outputTokenCount: null,
    totalTokenCount: null,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: "END",
    isStreamed: false,
    timeToFirstToken: undefined,
    ...metadataFields,
    operationSubtype,
    requestedImageCount: request.n || 1,
    actualImageCount: response.data?.length || 0,
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

  const requestedCharacterCount = typeof request.input === "string" ? request.input.length : 0;
  const actualDurationSeconds = typeof response.duration === "number" ? response.duration : 0;
  const billingUnit = resolveAudioBillingUnit(
    operationSubtype,
    requestedCharacterCount,
    actualDurationSeconds,
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

  attributes.billing_unit = billingUnit;
  if (billingUnit === "per_character") {
    attributes.requested_character_count = requestedCharacterCount;
    characterCount = requestedCharacterCount;
  } else {
    attributes.actual_duration_seconds = actualDurationSeconds;
    durationSeconds = actualDurationSeconds;
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
    inputTokenCount: null,
    outputTokenCount: null,
    totalTokenCount: null,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: "END",
    isStreamed: false,
    timeToFirstToken: undefined,
    ...metadataFields,
    operationSubtype,
    durationSeconds,
    characterCount,
    attributes,
  };
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
  extra?: {
    videoDurationSeconds?: number;
    resolution?: string;
    aspectRatio?: string;
    quality?: string;
    frameRate?: number;
    serviceTier?: string;
    region?: string;
    asyncJobId?: string;
    errorReason?: string;
  },
): ReveniumPayload {
  const now = new Date().toISOString();
  const requestTime = new Date(startTime).toISOString();
  const metadataFields = buildMetadataFields(usageMetadata);
  const operationSubtype = resolveOperationSubtype(
    VIDEO_OPERATION_SUBTYPES,
    metadataFields.operationSubtype,
    detectedSubtype,
  );

  const attributes: Record<string, unknown> = {
    billing_unit: "per_second",
    video_duration_seconds: extra?.videoDurationSeconds || 0,
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
    stopReason: extra?.errorReason || "END",
    isStreamed: false,
    timeToFirstToken: undefined,
    ...metadataFields,
    operationSubtype,
    durationSeconds: extra?.videoDurationSeconds,
    attributes,
  };
}

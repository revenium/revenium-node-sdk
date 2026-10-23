import OpenAI from "openai";
import { randomUUID } from "crypto";
import { Config, UsageMetadata, WithUsageMetadata } from "../_core/types/index.js";
import { getLogger } from "../_core/config/manager.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import {
  buildPayload,
  buildImagePayload,
  buildAudioPayload,
  type ImagePayloadExtra,
} from "../_core/metering/payload-builder.js";
import type {
  AudioOperationSubtype,
  ImageOperationSubtype,
  LegacyAudioOperationSubtype,
} from "../_core/metering/operation-subtype.js";
import { mapStopReason } from "../_core/stop-reason-mapper.js";
import { printUsageSummary } from "../_core/prompt/summary-printer.js";
import {
  shouldCapturePrompts,
  sanitizeCredentials,
  extractPrompts,
  getMaxPromptSize,
} from "../_core/prompt/extraction.js";
import { ProviderInfo, getProviderMetadata } from "./provider-detection.js";
import {
  isTerminalResponseStatus,
  mapResponsesStatusToStopReason,
  TERMINAL_RESPONSE_EVENTS,
} from "./responses-stop-reason.js";
import { MeteredResponseLedger } from "./metered-response-ledger.js";
import { isImageStreamRequest, isAsyncIterable, instrumentImageStream } from "./image-streaming.js";
import { StreamingWrapper, type TrackUsageFn } from "./streaming.js";
import { runProviderCall } from "../_core/metering/metering-context.js";
import { runWithCallConfig } from "../_core/config/call-config.js";
import { enforcePreCallRules, type EnforcementCriteria } from "../_core/enforcement/evaluator.js";
import { resolveAgenticJobFields } from "../_core/metadata/metadata-builder.js";

interface ResponsesAPIResult {
  id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    input_tokens_details?: { cached_tokens?: number };
  };
  status?: string;
  created_at?: number;
  completed_at?: number;
  output_text?: string;
  incomplete_details?: { reason?: string } | null;
  [key: string]: unknown;
}

interface ResponsesUsageCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

function extractResponsesUsage(response: ResponsesAPIResult | null): ResponsesUsageCounts {
  const usage = response?.usage ?? {};

  return {
    promptTokens: usage.input_tokens || 0,
    completionTokens: usage.output_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens,
  };
}

function epochSecondsToMillis(epochSeconds?: number): number | undefined {
  return typeof epochSeconds === "number" && Number.isFinite(epochSeconds)
    ? epochSeconds * 1000
    : undefined;
}

function jobDuration(response: ResponsesAPIResult, retrieveDuration: number): number {
  const startedAt = epochSecondsToMillis(response.created_at);
  const completedAt = epochSecondsToMillis(response.completed_at);
  if (startedAt === undefined || completedAt === undefined) return retrieveDuration;

  return Math.max(0, completedAt - startedAt);
}

function withResponseIdempotencyKey(responseId: string, metadata?: UsageMetadata): UsageMetadata {
  return {
    ...metadata,
    idempotencyKey: metadata?.idempotencyKey ?? `openai-response-${responseId}`,
  };
}

type ResponsesStream = AsyncIterable<unknown> & { controller?: AbortController };

interface OpenAIClientWithResponses {
  responses?: {
    create(params: Record<string, unknown>): Promise<ResponsesAPIResult | AsyncIterable<unknown>>;
    retrieve?(responseID: string): Promise<ResponsesAPIResult>;
  };
}

const MIDDLEWARE_SOURCE = "revenium-openai-node";

const skipTracking: TrackUsageFn = () => undefined;

export function trackUsageAsync(trackingData: {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  duration: number;
  startTime?: number;
  finishReason: string | null;
  usageMetadata?: UsageMetadata;
  isStreamed?: boolean;
  timeToFirstToken?: number;
  providerInfo?: ProviderInfo;
  messages?: any[];
  responseContent?: string;
  onDeliveryFailure?: () => void;
}): void {
  const logger = getLogger();

  Promise.resolve()
    .then(() => {
      const providerMeta = trackingData.providerInfo
        ? getProviderMetadata(trackingData.providerInfo)
        : { provider: "OpenAI", modelSource: "OPENAI" };

      const promptData = trackingData.messages
        ? extractPrompts(
            trackingData.messages,
            trackingData.responseContent,
            trackingData.usageMetadata,
          )
        : null;

      const startTime = trackingData.startTime ?? Date.now() - trackingData.duration;

      return buildPayload({
        operationType: "CHAT",
        model: trackingData.model,
        requestId: trackingData.requestId,
        startTime,
        duration: trackingData.duration,
        provider: providerMeta.provider,
        modelSource: providerMeta.modelSource,
        middlewareSource: MIDDLEWARE_SOURCE,
        usageMetadata: trackingData.usageMetadata,
        usage: {
          prompt_tokens: trackingData.promptTokens,
          completion_tokens: trackingData.completionTokens,
          total_tokens: trackingData.totalTokens,
          reasoning_tokens: trackingData.reasoningTokens,
          cached_tokens: trackingData.cachedTokens,
        },
        stopReason: mapStopReason(trackingData.finishReason, logger),
        isStreamed: trackingData.isStreamed || false,
        timeToFirstToken: trackingData.timeToFirstToken,
        request: trackingData.messages ? { messages: trackingData.messages } : undefined,
        promptData,
      });
    })
    .then(async (payload) => {
      try {
        await sendToRevenium(payload);
      } finally {
        printUsageSummary(payload);
      }
    })
    .catch((error) => {
      logger.warn("Usage tracking failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      trackingData.onDeliveryFailure?.();
    });
}

export function trackEmbeddingsUsageAsync(trackingData: {
  transactionId: string;
  model: string;
  promptTokens: number;
  totalTokens: number;
  duration: number;
  usageMetadata?: UsageMetadata;
  requestStartTime: number;
  providerInfo?: ProviderInfo;
}): void {
  const logger = getLogger();
  const providerMeta = trackingData.providerInfo
    ? getProviderMetadata(trackingData.providerInfo)
    : { provider: "OpenAI", modelSource: "OPENAI" };

  buildPayload({
    operationType: "EMBED",
    model: trackingData.model,
    requestId: trackingData.transactionId,
    startTime: trackingData.requestStartTime,
    duration: trackingData.duration,
    provider: providerMeta.provider,
    modelSource: providerMeta.modelSource,
    middlewareSource: MIDDLEWARE_SOURCE,
    usageMetadata: trackingData.usageMetadata,
    usage: {
      prompt_tokens: trackingData.promptTokens,
      total_tokens: trackingData.totalTokens,
    },
    stopReason: "END",
    isStreamed: false,
  })
    .then(async (payload) => {
      try {
        await sendToRevenium(payload);
      } finally {
        printUsageSummary(payload);
      }
    })
    .catch((error) => {
      logger.warn("Embeddings tracking failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function trackImageUsageAsync(
  operationSubtype: ImageOperationSubtype,
  response: any,
  request: any,
  startTime: number,
  duration: number,
  config: any,
  providerInfo: ProviderInfo,
  metadata?: UsageMetadata,
  extra?: ImagePayloadExtra,
): void {
  const logger = getLogger();
  const providerMeta = getProviderMetadata(providerInfo);

  void (async () => {
    try {
      const payload = buildImagePayload(
        operationSubtype,
        response,
        request,
        startTime,
        duration,
        providerMeta.provider,
        providerMeta.modelSource,
        MIDDLEWARE_SOURCE,
        metadata,
        extra,
      );
      try {
        await sendToRevenium(payload);
      } finally {
        printUsageSummary(payload);
      }
    } catch (error) {
      logger.warn("Image tracking failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

export function trackAudioUsageAsync(
  operationSubtype: AudioOperationSubtype | LegacyAudioOperationSubtype,
  response: any,
  request: any,
  startTime: number,
  duration: number,
  config: any,
  providerInfo: ProviderInfo,
  metadata?: UsageMetadata,
): void {
  const logger = getLogger();
  const providerMeta = getProviderMetadata(providerInfo);

  void (async () => {
    try {
      const payload = buildAudioPayload(
        operationSubtype,
        response,
        request,
        startTime,
        duration,
        providerMeta.provider,
        providerMeta.modelSource,
        MIDDLEWARE_SOURCE,
        metadata,
      );
      try {
        await sendToRevenium(payload);
      } finally {
        printUsageSummary(payload);
      }
    } catch (error) {
      logger.warn("Audio tracking failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

function enforcementCriteriaFor(
  providerInfo: ProviderInfo,
  model: string,
  metadata?: UsageMetadata,
): EnforcementCriteria {
  const credential = metadata?.subscriber?.credential;
  return {
    subscriberId: metadata?.subscriber?.id,
    subscriberEmail: metadata?.subscriber?.email,
    productName: metadata?.productName || metadata?.productId,
    model,
    provider: getProviderMetadata(providerInfo).provider,
    agent: metadata?.agent,
    taskType: metadata?.taskType,
    organizationName: metadata?.organizationName || metadata?.organizationId,
    credential: credential?.name ?? credential?.value,
  };
}

export class CompletionsInterface {
  constructor(
    private client: OpenAI,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(
    params: OpenAI.ChatCompletionCreateParamsNonStreaming,
    metadata?: UsageMetadata,
  ): Promise<OpenAI.ChatCompletion> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params, metadata));
  }

  private async meteredCreate(
    params: OpenAI.ChatCompletionCreateParamsNonStreaming,
    metadata?: UsageMetadata,
  ): Promise<OpenAI.ChatCompletion> {
    const startTime = Date.now();
    const requestId = randomUUID();

    enforcePreCallRules(enforcementCriteriaFor(this.providerInfo, params.model, metadata));

    try {
      const { result: response, meteredElsewhere } = await runProviderCall(
        MIDDLEWARE_SOURCE,
        metadata,
        () => this.client.chat.completions.create(params),
      );

      if (meteredElsewhere) return response;

      const duration = Date.now() - startTime;
      const responseContent = response.choices[0]?.message?.content;

      trackUsageAsync({
        requestId: response.id || requestId,
        model: response.model,
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
        reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens,
        cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens,
        duration,
        finishReason: response.choices[0]?.finish_reason || null,
        usageMetadata: metadata,
        isStreamed: false,
        providerInfo: this.providerInfo,
        messages: params.messages,
        responseContent:
          responseContent && shouldCapturePrompts(metadata)
            ? sanitizeCredentials(responseContent)
            : undefined,
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      trackUsageAsync({
        requestId,
        model: params.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        duration,
        finishReason: "error",
        usageMetadata: metadata,
        isStreamed: false,
        providerInfo: this.providerInfo,
        messages: params.messages,
      });
      throw error;
    }
  }

  async createStreaming(
    params: OpenAI.ChatCompletionCreateParamsStreaming,
    metadata?: UsageMetadata,
  ): Promise<StreamingWrapper> {
    return runWithCallConfig(this.config, () => this.meteredCreateStreaming(params, metadata));
  }

  private async meteredCreateStreaming(
    params: OpenAI.ChatCompletionCreateParamsStreaming,
    metadata?: UsageMetadata,
  ): Promise<StreamingWrapper> {
    enforcePreCallRules(enforcementCriteriaFor(this.providerInfo, params.model, metadata));

    const { result: stream, meteredElsewhere } = await runProviderCall(
      MIDDLEWARE_SOURCE,
      metadata,
      () =>
        this.client.chat.completions.create({
          ...params,
          stream: true,
          stream_options: { include_usage: true },
        }),
    );

    return new StreamingWrapper(
      stream,
      this.config,
      this.providerInfo,
      params.model,
      params.messages,
      meteredElsewhere ? skipTracking : trackUsageAsync,
      metadata,
    );
  }
}

export class ChatInterface {
  constructor(
    private client: OpenAI,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  completions(): CompletionsInterface {
    return new CompletionsInterface(this.client, this.config, this.providerInfo);
  }
}

export class EmbeddingsInterface {
  constructor(
    private client: OpenAI,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(
    params: OpenAI.EmbeddingCreateParams,
    metadata?: UsageMetadata,
  ): Promise<OpenAI.CreateEmbeddingResponse> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params, metadata));
  }

  private async meteredCreate(
    params: OpenAI.EmbeddingCreateParams,
    metadata?: UsageMetadata,
  ): Promise<OpenAI.CreateEmbeddingResponse> {
    const startTime = Date.now();
    const requestId = randomUUID();

    const { result: response, meteredElsewhere } = await runProviderCall(
      MIDDLEWARE_SOURCE,
      metadata,
      () => this.client.embeddings.create(params),
    );

    if (meteredElsewhere) return response;

    trackEmbeddingsUsageAsync({
      transactionId: requestId,
      model: response.model,
      promptTokens: response.usage.prompt_tokens,
      totalTokens: response.usage.total_tokens,
      duration: Date.now() - startTime,
      usageMetadata: metadata,
      requestStartTime: startTime,
      providerInfo: this.providerInfo,
    });

    return response;
  }
}

export class ImagesInterface {
  constructor(
    private originalImages: OpenAI.Images,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async generate(params: OpenAI.ImageGenerateParams): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredGenerate(params));
  }

  private async meteredGenerate(params: OpenAI.ImageGenerateParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalImages.generate(cleanParams);

    if (isImageStreamRequest(params) && isAsyncIterable(response)) {
      return instrumentImageStream(
        response,
        "generation",
        params,
        startTime,
        this.config,
        this.providerInfo,
        metadata,
        trackImageUsageAsync,
      );
    }

    trackImageUsageAsync(
      "generation",
      response,
      params,
      startTime,
      Date.now() - startTime,
      this.config,
      this.providerInfo,
      metadata,
    );
    return response;
  }

  async edit(params: OpenAI.ImageEditParams): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredEdit(params));
  }

  private async meteredEdit(params: OpenAI.ImageEditParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalImages.edit(cleanParams);

    if (isImageStreamRequest(params) && isAsyncIterable(response)) {
      return instrumentImageStream(
        response,
        "edit",
        params,
        startTime,
        this.config,
        this.providerInfo,
        metadata,
        trackImageUsageAsync,
      );
    }

    trackImageUsageAsync(
      "edit",
      response,
      params,
      startTime,
      Date.now() - startTime,
      this.config,
      this.providerInfo,
      metadata,
    );
    return response;
  }

  async createVariation(params: OpenAI.ImageCreateVariationParams): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredCreateVariation(params));
  }

  private async meteredCreateVariation(params: OpenAI.ImageCreateVariationParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalImages.createVariation(cleanParams);
    const duration = Date.now() - startTime;
    trackImageUsageAsync(
      "variation",
      response,
      params,
      startTime,
      duration,
      this.config,
      this.providerInfo,
      metadata,
    );
    return response;
  }
}

export class AudioTranscriptionsInterface {
  constructor(
    private originalTranscriptions: OpenAI.Audio.Transcriptions,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(params: OpenAI.Audio.TranscriptionCreateParams): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params));
  }

  private async meteredCreate(params: OpenAI.Audio.TranscriptionCreateParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalTranscriptions.create(
      cleanParams as OpenAI.Audio.TranscriptionCreateParamsNonStreaming,
    );
    const duration = Date.now() - startTime;
    trackAudioUsageAsync(
      "transcription",
      response,
      params,
      startTime,
      duration,
      this.config,
      this.providerInfo,
      metadata,
    );
    return response;
  }
}

export class AudioTranslationsInterface {
  constructor(
    private originalTranslations: OpenAI.Audio.Translations,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(params: OpenAI.Audio.TranslationCreateParams): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params));
  }

  private async meteredCreate(params: OpenAI.Audio.TranslationCreateParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalTranslations.create(cleanParams);
    const duration = Date.now() - startTime;
    trackAudioUsageAsync(
      "translation",
      response,
      params,
      startTime,
      duration,
      this.config,
      this.providerInfo,
      metadata,
    );
    return response;
  }
}

export class AudioSpeechInterface {
  constructor(
    private originalSpeech: OpenAI.Audio.Speech,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(params: OpenAI.Audio.SpeechCreateParams): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params));
  }

  private async meteredCreate(params: OpenAI.Audio.SpeechCreateParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalSpeech.create(cleanParams);
    const duration = Date.now() - startTime;
    trackAudioUsageAsync(
      "tts",
      response,
      params,
      startTime,
      duration,
      this.config,
      this.providerInfo,
      metadata,
    );
    return response;
  }
}

export class ResponsesInterface {
  private readonly ledger = new MeteredResponseLedger();

  constructor(
    private client: OpenAI,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  private inputMessages(params: Record<string, unknown>): unknown[] {
    return Array.isArray(params.input)
      ? params.input
      : [{ role: "user" as const, content: params.input }];
  }

  create(
    params: Record<string, unknown> & { stream: true },
    metadata?: UsageMetadata,
  ): Promise<ResponsesStream>;
  create(
    params: Record<string, unknown> & { stream?: false | null },
    metadata?: UsageMetadata,
  ): Promise<ResponsesAPIResult>;
  create(
    params: Record<string, unknown> & { stream: boolean },
    metadata?: UsageMetadata,
  ): Promise<ResponsesAPIResult | ResponsesStream>;
  async create(
    params: Record<string, unknown>,
    metadata?: UsageMetadata,
  ): Promise<ResponsesAPIResult | ResponsesStream> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params, metadata));
  }

  private async meteredCreate(
    params: Record<string, unknown>,
    metadata?: UsageMetadata,
  ): Promise<ResponsesAPIResult | ResponsesStream> {
    const startTime = Date.now();
    const requestId = randomUUID();
    const isStreamed = Boolean(params.stream);
    const responsesAPI = (this.client as unknown as OpenAIClientWithResponses).responses;
    if (!responsesAPI?.create) {
      throw new Error("Responses API not available in this OpenAI SDK version");
    }

    try {
      const result = await responsesAPI.create(params);

      if (isStreamed) {
        return this.instrumentStream(
          result as ResponsesStream,
          params,
          startTime,
          requestId,
          metadata,
        );
      }

      const response = result as ResponsesAPIResult;

      if (!isTerminalResponseStatus(response.status)) {
        this.deferToCollection(response, params, metadata);
        return response;
      }

      this.meterTerminalResponse({
        response,
        responseId: response.id || requestId,
        model: response.model || (params.model as string),
        duration: Date.now() - startTime,
        metadata,
        messages: this.inputMessages(params),
      });

      return response;
    } catch (error) {
      this.trackFailure(params, requestId, startTime, isStreamed, metadata);
      throw error;
    }
  }

  async retrieve(responseId: string, metadata?: UsageMetadata): Promise<ResponsesAPIResult> {
    return runWithCallConfig(this.config, () => this.meteredRetrieve(responseId, metadata));
  }

  private async meteredRetrieve(
    responseId: string,
    metadata?: UsageMetadata,
  ): Promise<ResponsesAPIResult> {
    const startTime = Date.now();
    const responsesAPI = (this.client as unknown as OpenAIClientWithResponses).responses;
    if (!responsesAPI?.retrieve) {
      throw new Error("Responses API not available in this OpenAI SDK version");
    }

    const response = await responsesAPI.retrieve(responseId);
    if (!isTerminalResponseStatus(response.status)) return response;

    const collectedResponseId = response.id || responseId;
    const pending = this.ledger.contextFor(collectedResponseId);
    const collectionMetadata = { ...pending?.metadata, ...metadata };
    this.meterTerminalResponse({
      response,
      responseId: collectedResponseId,
      model: response.model ?? "",
      duration: jobDuration(response, Date.now() - startTime),
      startTime: epochSecondsToMillis(response.created_at),
      metadata: collectionMetadata,
      messages: pending?.messages ?? [],
      responseContent:
        response.output_text && shouldCapturePrompts(collectionMetadata)
          ? sanitizeCredentials(response.output_text)
          : undefined,
    });

    return response;
  }

  private deferToCollection(
    response: ResponsesAPIResult,
    params: Record<string, unknown>,
    metadata?: UsageMetadata,
  ): void {
    if (response.id) {
      this.ledger.rememberContext(response.id, {
        metadata: { ...resolveAgenticJobFields(metadata), ...metadata },
        messages: shouldCapturePrompts(metadata) ? this.inputMessages(params) : undefined,
      });
    }

    getLogger().info("Background response not metered until collected", {
      responseId: response.id,
      status: response.status,
      collectWith: "responses().retrieve(id)",
    });
  }

  private meterTerminalResponse(metering: {
    response: ResponsesAPIResult;
    responseId: string;
    model: string;
    duration: number;
    startTime?: number;
    metadata?: UsageMetadata;
    messages: unknown[];
    responseContent?: string;
  }): void {
    const { response, responseId } = metering;
    if (!this.ledger.claim(responseId)) return;

    trackUsageAsync({
      requestId: responseId,
      model: metering.model,
      ...extractResponsesUsage(response),
      duration: metering.duration,
      startTime: metering.startTime,
      finishReason: mapResponsesStatusToStopReason(
        response.status,
        response.incomplete_details?.reason,
        getLogger(),
      ),
      usageMetadata: withResponseIdempotencyKey(responseId, metering.metadata),
      isStreamed: false,
      providerInfo: this.providerInfo,
      messages: metering.messages,
      responseContent: metering.responseContent,
      onDeliveryFailure: () => this.ledger.release(responseId),
    });
  }

  private trackFailure(
    params: Record<string, unknown>,
    requestId: string,
    startTime: number,
    isStreamed: boolean,
    metadata?: UsageMetadata,
  ): void {
    trackUsageAsync({
      requestId,
      model: params.model as string,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      duration: Date.now() - startTime,
      finishReason: "error",
      usageMetadata: metadata,
      isStreamed,
      providerInfo: this.providerInfo,
      messages: this.inputMessages(params),
    });
  }

  async createStreaming(
    params: Record<string, unknown>,
    metadata?: UsageMetadata,
  ): Promise<ResponsesStream> {
    return this.create({ ...params, stream: true }, metadata);
  }

  private instrumentStream(
    stream: ResponsesStream,
    params: Record<string, unknown>,
    startTime: number,
    requestId: string,
    metadata?: UsageMetadata,
  ): ResponsesStream {
    const providerStream = stream as { iterator?: () => AsyncIterator<unknown> };

    if (typeof providerStream.iterator !== "function") {
      return this.meterResponseStream(stream, params, startTime, requestId, metadata);
    }

    const originalIterator = providerStream.iterator.bind(providerStream);
    let instrumented = false;
    providerStream.iterator = () => {
      if (instrumented) return originalIterator();
      instrumented = true;
      return this.meterResponseStream(
        { [Symbol.asyncIterator]: originalIterator },
        params,
        startTime,
        requestId,
        metadata,
      );
    };

    return stream;
  }

  private async *meterResponseStream(
    stream: AsyncIterable<unknown>,
    params: Record<string, unknown>,
    startTime: number,
    requestId: string,
    metadata?: UsageMetadata,
  ): AsyncGenerator<unknown> {
    let fullContent = "";
    let finalResponse: ResponsesAPIResult | null = null;
    let metered = false;
    let firstTokenTime: number | undefined;
    const capturePrompts = runWithCallConfig(this.config, () => shouldCapturePrompts(metadata));
    const maxPromptSize = runWithCallConfig(this.config, getMaxPromptSize);

    const track = (finishReason: string | null) =>
      runWithCallConfig(this.config, () => {
        const responseId = finalResponse?.id;
        if (responseId && !this.ledger.claim(responseId)) return;

        trackUsageAsync({
          timeToFirstToken: firstTokenTime ? firstTokenTime - startTime : undefined,
          requestId: responseId || requestId,
          model: finalResponse?.model || (params.model as string),
          ...extractResponsesUsage(finalResponse),
          duration: Date.now() - startTime,
          finishReason,
          usageMetadata: responseId ? withResponseIdempotencyKey(responseId, metadata) : metadata,
          isStreamed: true,
          providerInfo: this.providerInfo,
          messages: this.inputMessages(params),
          responseContent: fullContent ? sanitizeCredentials(fullContent) : undefined,
          onDeliveryFailure: responseId ? () => this.ledger.release(responseId) : undefined,
        });
      });

    const appendOutput = (delta: string) => {
      if (fullContent.length >= maxPromptSize) return;

      fullContent += delta;
      if (fullContent.length > maxPromptSize) {
        fullContent = sanitizeCredentials(fullContent).slice(0, maxPromptSize);
      }
    };

    const resolvedStopReason = () =>
      finalResponse
        ? mapResponsesStatusToStopReason(
            finalResponse.status,
            finalResponse.incomplete_details?.reason,
            getLogger(),
          )
        : "cancelled";

    try {
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        if (chunk.type === "response.output_text.delta" && chunk.delta) {
          firstTokenTime ??= Date.now();
          if (capturePrompts) appendOutput(chunk.delta as string);
        }
        if (TERMINAL_RESPONSE_EVENTS.has(chunk.type as string) && chunk.response) {
          finalResponse = chunk.response as ResponsesAPIResult;
        }
        yield chunk;
      }

      metered = true;
      track(resolvedStopReason());
    } catch (error) {
      metered = true;
      track("error");
      throw error;
    } finally {
      if (!metered) track(resolvedStopReason());
    }
  }
}

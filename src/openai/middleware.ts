import OpenAI from "openai";
import { randomUUID } from "crypto";
import { Config, UsageMetadata, WithUsageMetadata } from "../_core/types/index.js";
import { getLogger } from "../_core/config/manager.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import {
  buildPayload,
  buildImagePayload,
  buildAudioPayload,
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
} from "../_core/prompt/extraction.js";
import { ProviderInfo, getProviderMetadata } from "./provider-detection.js";
import { StreamingWrapper } from "./streaming.js";
import { enforcePreCallRules } from "../_core/enforcement/evaluator.js";

interface ResponsesAPIResult {
  id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    input_tokens_details?: { cached_tokens?: number };
  };
  finish_reason?: string;
  status?: string;
  [key: string]: unknown;
}

interface OpenAIClientWithResponses {
  responses?: {
    create(params: Record<string, unknown>): Promise<ResponsesAPIResult>;
  };
}

const MIDDLEWARE_SOURCE = "revenium-openai-node";

export function trackUsageAsync(trackingData: {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  duration: number;
  finishReason: string | null;
  usageMetadata?: UsageMetadata;
  isStreamed?: boolean;
  timeToFirstToken?: number;
  providerInfo?: ProviderInfo;
  messages?: any[];
  responseContent?: string;
}): void {
  const logger = getLogger();
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

  const startTime = Date.now() - trackingData.duration;

  buildPayload({
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
    const startTime = Date.now();
    const requestId = randomUUID();
    const providerMeta = getProviderMetadata(this.providerInfo);

    enforcePreCallRules({
      subscriberId: metadata?.subscriber?.id,
      productName: metadata?.productName,
      model: params.model,
      provider: providerMeta.provider,
    });

    try {
      const response = await this.client.chat.completions.create(params);
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
    const providerMeta = getProviderMetadata(this.providerInfo);

    enforcePreCallRules({
      subscriberId: metadata?.subscriber?.id,
      productName: metadata?.productName,
      model: params.model,
      provider: providerMeta.provider,
    });

    const stream = await this.client.chat.completions.create({
      ...params,
      stream: true,
      stream_options: { include_usage: true },
    });

    return new StreamingWrapper(
      stream,
      this.config,
      this.providerInfo,
      params.model,
      params.messages,
      trackUsageAsync,
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
    const startTime = Date.now();
    const requestId = randomUUID();

    try {
      const response = await this.client.embeddings.create(params);
      const duration = Date.now() - startTime;

      trackEmbeddingsUsageAsync({
        transactionId: requestId,
        model: response.model,
        promptTokens: response.usage.prompt_tokens,
        totalTokens: response.usage.total_tokens,
        duration,
        usageMetadata: metadata,
        requestStartTime: startTime,
        providerInfo: this.providerInfo,
      });

      return response;
    } catch (error) {
      throw error;
    }
  }
}

export class ImagesInterface {
  constructor(
    private originalImages: OpenAI.Images,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async generate(params: OpenAI.ImageGenerateParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalImages.generate(cleanParams);
    const duration = Date.now() - startTime;
    trackImageUsageAsync(
      "generation",
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

  async edit(params: OpenAI.ImageEditParams): Promise<any> {
    const { usageMetadata: metadata, ...cleanParams } = params as WithUsageMetadata<typeof params>;
    const startTime = Date.now();
    const response = await this.originalImages.edit(cleanParams);
    const duration = Date.now() - startTime;
    trackImageUsageAsync(
      "edit",
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

  async createVariation(params: OpenAI.ImageCreateVariationParams): Promise<any> {
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
  constructor(
    private client: OpenAI,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(
    params: Record<string, unknown>,
    metadata?: UsageMetadata,
  ): Promise<ResponsesAPIResult> {
    const startTime = Date.now();
    const requestId = randomUUID();

    try {
      const responsesAPI = (this.client as unknown as OpenAIClientWithResponses).responses;
      if (!responsesAPI?.create) {
        throw new Error("Responses API not available in this OpenAI SDK version");
      }

      const response = await responsesAPI.create(params);
      const duration = Date.now() - startTime;
      const usage = response.usage;

      if (usage) {
        const inputMessages = Array.isArray(params.input)
          ? params.input
          : [{ role: "user" as const, content: params.input }];

        trackUsageAsync({
          requestId: response.id || requestId,
          model: response.model || (params.model as string),
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          reasoningTokens: usage.reasoning_tokens,
          cachedTokens: usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens,
          duration,
          finishReason: response.finish_reason || "completed",
          usageMetadata: metadata,
          isStreamed: false,
          providerInfo: this.providerInfo,
          messages: inputMessages,
        });
      }

      return response;
    } catch (error) {
      throw error;
    }
  }

  async createStreaming(
    params: Record<string, unknown>,
    metadata?: UsageMetadata,
  ): Promise<AsyncIterable<unknown>> {
    const startTime = Date.now();
    const requestId = randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const responsesAPI = (this.client as unknown as OpenAIClientWithResponses).responses;
    if (!responsesAPI?.create) {
      throw new Error("Responses API not available in this OpenAI SDK version");
    }

    const stream = await responsesAPI.create({ ...params, stream: true });

    return (async function* () {
      let fullContent = "";
      let finalResponse: ResponsesAPIResult | null = null;

      for await (const chunk of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        if (chunk.type === "response.output_text.delta" && chunk.delta) {
          fullContent += chunk.delta;
        }
        if (chunk.type === "response.completed" && chunk.response) {
          finalResponse = chunk.response as ResponsesAPIResult;
        }
        yield chunk;
      }

      const duration = Date.now() - startTime;
      if (finalResponse?.usage) {
        const usage = finalResponse.usage;
        const inputMessages = Array.isArray(params.input)
          ? params.input
          : [{ role: "user" as const, content: params.input }];

        trackUsageAsync({
          requestId: finalResponse.id || requestId,
          model: finalResponse.model || (params.model as string),
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
          cachedTokens: usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens,
          duration,
          finishReason: finalResponse.status || "completed",
          usageMetadata: metadata,
          isStreamed: true,
          providerInfo: self.providerInfo,
          messages: inputMessages,
          responseContent: fullContent,
        });
      }
    })();
  }
}

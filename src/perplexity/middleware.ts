import OpenAI from "openai";
import { randomUUID } from "crypto";
import { Config, UsageMetadata } from "../_core/types/index.js";
import { getLogger } from "../_core/config/manager.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import { buildPayload } from "../_core/metering/payload-builder.js";
import { mapStopReason } from "../_core/stop-reason-mapper.js";
import { printUsageSummary } from "../_core/prompt/summary-printer.js";
import {
  shouldCapturePrompts,
  sanitizeCredentials,
  getMaxPromptSize,
  extractPrompts,
} from "../_core/prompt/extraction.js";
import { runProviderCall } from "../_core/metering/metering-context.js";
import { resolveConfig, runWithCallConfig } from "../_core/config/call-config.js";
import type { PerplexityCost } from "./types.js";

interface PerplexityCompletionResponse {
  id?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: PerplexityCost;
  };
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  [key: string]: unknown;
}

const MIDDLEWARE_SOURCE = "revenium-perplexity-node";

export type TrackUsageFn = typeof trackUsageAsync;

const skipTracking: TrackUsageFn = () => undefined;

export function trackUsageAsync(trackingData: {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  duration: number;
  finishReason: string | null;
  usageMetadata?: UsageMetadata;
  isStreamed?: boolean;
  timeToFirstToken?: number;
  cost?: PerplexityCost;
  responseFormat?: { type: string; json_schema?: { name: string } } | string;
  messages?: any;
  responseContent?: string;
}): void {
  const logger = getLogger();

  const promptData = trackingData.messages
    ? extractPrompts(
        trackingData.messages,
        trackingData.responseContent,
        trackingData.usageMetadata,
      )
    : null;

  const startTime = Date.now() - trackingData.duration;

  const attributes: Record<string, unknown> = {};
  if (trackingData.responseFormat) {
    if (typeof trackingData.responseFormat === "object" && trackingData.responseFormat !== null) {
      const formatType = trackingData.responseFormat.type;
      if (formatType) {
        attributes.response_format_type = formatType;
        if (formatType === "json_schema") {
          const schemaName = trackingData.responseFormat.json_schema?.name;
          if (schemaName) {
            attributes.response_format_schema_name = schemaName;
          }
        }
      }
    } else {
      attributes.response_format = trackingData.responseFormat;
    }
  }

  const costFields = trackingData.cost
    ? {
        inputTokenCost: trackingData.cost.input_tokens_cost,
        outputTokenCost: trackingData.cost.output_tokens_cost,
        totalCost: trackingData.cost.total_cost,
      }
    : {};

  buildPayload({
    operationType: "CHAT",
    model: trackingData.model,
    requestId: trackingData.requestId,
    startTime,
    duration: trackingData.duration,
    provider: "Perplexity",
    modelSource: "PERPLEXITY",
    middlewareSource: MIDDLEWARE_SOURCE,
    usageMetadata: trackingData.usageMetadata,
    usage: {
      prompt_tokens: trackingData.promptTokens,
      completion_tokens: trackingData.completionTokens,
      total_tokens: trackingData.totalTokens,
    },
    stopReason: mapStopReason(trackingData.finishReason, logger),
    isStreamed: trackingData.isStreamed || false,
    timeToFirstToken: trackingData.timeToFirstToken,
    request: trackingData.messages ? { messages: trackingData.messages } : undefined,
    promptData,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
  })
    .then(async (payload) => {
      Object.assign(payload, costFields);
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

export class StreamingWrapper implements AsyncIterable<any> {
  private stream: AsyncIterable<any>;
  private model: string;
  private startTime: number;
  private transactionId: string;
  private metadata?: UsageMetadata;
  private responseFormat?: { type: string; json_schema?: { name: string } } | string;
  private messages: any;
  private accumulatedContent: string = "";
  private trackFn: TrackUsageFn;
  private callConfig: Config | null;
  private capturePrompts: boolean;
  private maxPromptSize: number;

  constructor(
    stream: AsyncIterable<any>,
    model: string,
    startTime: number,
    transactionId: string,
    metadata?: UsageMetadata,
    responseFormat?: { type: string; json_schema?: { name: string } } | string,
    messages?: any,
    trackFn: TrackUsageFn = trackUsageAsync,
    callConfig: Config | null = resolveConfig(),
  ) {
    this.stream = stream;
    this.model = model;
    this.startTime = startTime;
    this.transactionId = transactionId;
    this.metadata = metadata;
    this.responseFormat = responseFormat;
    this.messages = messages || [];
    this.trackFn = trackFn;
    this.callConfig = callConfig;
    this.capturePrompts = runWithCallConfig(callConfig, () => shouldCapturePrompts(metadata));
    this.maxPromptSize = runWithCallConfig(callConfig, getMaxPromptSize);
  }

  private track(trackingData: Parameters<TrackUsageFn>[0]): void {
    runWithCallConfig(this.callConfig, () => this.trackFn(trackingData));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let costData: PerplexityCost | undefined;
    let firstChunkTime: number | null = null;
    let timeToFirstToken = 0;
    let completed = false;
    let lastFinishReason: string | null = null;

    try {
      for await (const chunk of this.stream) {
        if (!firstChunkTime && chunk.choices?.[0]?.delta?.content) {
          firstChunkTime = Date.now();
          timeToFirstToken = firstChunkTime - this.startTime;
        }

        if (chunk.choices?.[0]?.delta?.content && this.capturePrompts) {
          const remaining = this.maxPromptSize - this.accumulatedContent.length;
          if (remaining > 0) {
            this.accumulatedContent += chunk.choices[0].delta.content.slice(0, remaining);
          }
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
          totalTokens = chunk.usage.total_tokens || 0;
          if (chunk.usage.cost) {
            costData = chunk.usage.cost;
          }
        }

        if (chunk.choices?.[0]?.finish_reason) {
          lastFinishReason = chunk.choices[0].finish_reason;
        }

        yield chunk;
      }

      completed = true;
      const duration = Date.now() - this.startTime;

      this.track({
        requestId: this.transactionId,
        model: this.model,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        duration,
        finishReason: lastFinishReason,
        usageMetadata: this.metadata,
        isStreamed: true,
        timeToFirstToken,
        cost: costData,
        responseFormat: this.responseFormat,
        messages: this.messages,
        responseContent: this.accumulatedContent
          ? sanitizeCredentials(this.accumulatedContent)
          : undefined,
      });
    } catch (error: any) {
      completed = true;
      const duration = Date.now() - this.startTime;

      this.track({
        requestId: this.transactionId,
        model: this.model,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        duration,
        finishReason: "error",
        usageMetadata: this.metadata,
        isStreamed: true,
        messages: this.messages,
        responseContent: this.accumulatedContent
          ? sanitizeCredentials(this.accumulatedContent)
          : undefined,
      });

      throw error;
    } finally {
      if (!completed) {
        const duration = Date.now() - this.startTime;

        this.track({
          requestId: this.transactionId,
          model: this.model,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens,
          duration,
          finishReason: "cancelled",
          usageMetadata: this.metadata,
          isStreamed: true,
          timeToFirstToken,
          cost: costData,
          responseFormat: this.responseFormat,
          messages: this.messages,
          responseContent: this.accumulatedContent
            ? sanitizeCredentials(this.accumulatedContent)
            : undefined,
        });
      }
    }
  }
}

export class CompletionsInterface {
  constructor(
    private client: OpenAI,
    private config: Config,
  ) {}

  async create(
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata?: UsageMetadata,
  ): Promise<any> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params, metadata));
  }

  private async meteredCreate(
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata?: UsageMetadata,
  ): Promise<any> {
    const startTime = Date.now();
    const transactionId = randomUUID();

    try {
      const { result: response, meteredElsewhere } = await runProviderCall(
        MIDDLEWARE_SOURCE,
        metadata,
        () => this.client.chat.completions.create(params),
      );

      if (meteredElsewhere) return response;

      const duration = Date.now() - startTime;

      const perplexityResponse = response as unknown as PerplexityCompletionResponse;
      if (perplexityResponse.usage) {
        const usage = perplexityResponse.usage;
        const responseContent = perplexityResponse.choices?.[0]?.message?.content || undefined;

        trackUsageAsync({
          requestId: perplexityResponse.id || transactionId,
          model: params.model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          duration,
          finishReason: perplexityResponse.choices?.[0]?.finish_reason || null,
          usageMetadata: metadata,
          isStreamed: false,
          cost: usage.cost,
          responseFormat: params.response_format,
          messages: params.messages,
          responseContent:
            responseContent && shouldCapturePrompts(metadata)
              ? sanitizeCredentials(responseContent)
              : undefined,
        });
      }

      return response;
    } catch (error: any) {
      const duration = Date.now() - startTime;

      trackUsageAsync({
        requestId: transactionId,
        model: params.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        duration,
        finishReason: "error",
        usageMetadata: metadata,
        isStreamed: false,
        messages: params.messages,
      });

      throw error;
    }
  }

  async createStreaming(
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata?: UsageMetadata,
  ): Promise<StreamingWrapper> {
    return runWithCallConfig(this.config, () => this.meteredCreateStreaming(params, metadata));
  }

  private async meteredCreateStreaming(
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata?: UsageMetadata,
  ): Promise<StreamingWrapper> {
    const startTime = Date.now();
    const transactionId = randomUUID();

    try {
      const { result: stream, meteredElsewhere } = await runProviderCall(
        MIDDLEWARE_SOURCE,
        metadata,
        () =>
          this.client.chat.completions.create({
            ...params,
            stream: true,
          }),
      );

      return new StreamingWrapper(
        stream as AsyncIterable<unknown>,
        params.model,
        startTime,
        transactionId,
        metadata,
        params.response_format,
        params.messages,
        meteredElsewhere ? skipTracking : trackUsageAsync,
        this.config,
      );
    } catch (error: any) {
      const duration = Date.now() - startTime;

      trackUsageAsync({
        requestId: transactionId,
        model: params.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        duration,
        finishReason: "error",
        usageMetadata: metadata,
        isStreamed: true,
        messages: params.messages,
      });

      throw error;
    }
  }
}

export class ChatInterface {
  constructor(
    private client: OpenAI,
    private config: Config,
  ) {}

  completions(): CompletionsInterface {
    return new CompletionsInterface(this.client, this.config);
  }
}

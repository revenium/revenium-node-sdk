import OpenAI from "openai";
import { randomUUID } from "crypto";
import { Config, UsageMetadata } from "../_core/types/index.js";
import { ProviderInfo } from "./provider-detection.js";
import {
  shouldCapturePrompts,
  sanitizeCredentials,
  getMaxPromptSize,
} from "../_core/prompt/extraction.js";
import { runWithCallConfig } from "../_core/config/call-config.js";

export type TrackUsageFn = (data: any) => void;

const isPrimaryChoice = (choice: { index?: number | null }): boolean =>
  choice.index === 0 || choice.index === undefined || choice.index === null;

export class StreamingWrapper implements AsyncIterable<OpenAI.ChatCompletionChunk> {
  private stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
  private config: Config;
  private providerInfo: ProviderInfo;
  private model: string;
  private responseModel?: string;
  private metadata?: UsageMetadata;
  private startTime: number;
  private firstTokenTime?: number;
  private requestId: string;
  private usage: any = {};
  private messages: any[];
  private accumulatedContent: string = "";
  private finishReason: string | null = null;
  private trackFn: TrackUsageFn;
  private capturePrompts: boolean;
  private maxPromptSize: number;

  constructor(
    stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
    config: Config,
    providerInfo: ProviderInfo,
    model: string,
    messages: any[],
    trackFn: TrackUsageFn,
    metadata?: UsageMetadata,
  ) {
    this.stream = stream;
    this.config = config;
    this.providerInfo = providerInfo;
    this.model = model;
    this.messages = messages;
    this.trackFn = trackFn;
    this.metadata = metadata;
    this.startTime = Date.now();
    this.requestId = randomUUID();
    this.capturePrompts = runWithCallConfig(config, () => shouldCapturePrompts(metadata));
    this.maxPromptSize = runWithCallConfig(config, getMaxPromptSize);
  }

  private track(finishReason: string | null, timeToFirstToken?: number): void {
    runWithCallConfig(this.config, () =>
      this.trackFn(this.buildTrackingPayload(finishReason, timeToFirstToken)),
    );
  }

  private buildTrackingPayload(finishReason: string | null, timeToFirstToken?: number) {
    return {
      requestId: this.requestId,
      model: this.responseModel || this.model,
      promptTokens: this.usage.prompt_tokens || 0,
      completionTokens: this.usage.completion_tokens || 0,
      totalTokens: this.usage.total_tokens || 0,
      reasoningTokens: this.usage.completion_tokens_details?.reasoning_tokens,
      cachedTokens: this.usage.prompt_tokens_details?.cached_tokens,
      duration: Date.now() - this.startTime,
      finishReason,
      usageMetadata: this.metadata,
      isStreamed: true,
      timeToFirstToken,
      providerInfo: this.providerInfo,
      messages: this.messages,
      responseContent: this.accumulatedContent
        ? sanitizeCredentials(this.accumulatedContent)
        : undefined,
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<OpenAI.ChatCompletionChunk> {
    let completed = false;

    try {
      for await (const chunk of this.stream) {
        const primaryChoice = chunk.choices.find(isPrimaryChoice);
        const deltaContent = primaryChoice?.delta?.content;

        if (!this.firstTokenTime && deltaContent) {
          this.firstTokenTime = Date.now();
        }

        if (deltaContent && this.capturePrompts) {
          const remaining = this.maxPromptSize - this.accumulatedContent.length;
          if (remaining > 0) {
            this.accumulatedContent += deltaContent.slice(0, remaining);
          }
        }

        if (primaryChoice?.finish_reason) this.finishReason = primaryChoice.finish_reason;

        if (chunk.usage) this.usage = chunk.usage;
        if (chunk.id) this.requestId = chunk.id;
        if (!this.responseModel && chunk.model) this.responseModel = chunk.model;

        yield chunk;
      }

      completed = true;
      const timeToFirstToken = this.firstTokenTime
        ? this.firstTokenTime - this.startTime
        : undefined;

      this.track(this.finishReason, timeToFirstToken);
    } catch (error) {
      completed = true;
      this.track("error");
      throw error;
    } finally {
      if (!completed) {
        const timeToFirstToken = this.firstTokenTime
          ? this.firstTokenTime - this.startTime
          : undefined;
        this.track(this.finishReason ?? "cancelled", timeToFirstToken);
      }
    }
  }
}

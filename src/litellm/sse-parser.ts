import { shouldCapturePrompts, getMaxPromptSize } from "../_core/prompt/extraction.js";
import { extractUsageTokens, mergeReportedUsage, resolveMeteredModel } from "./usage.js";
import type {
  RequestContext,
  LiteLLMChatCompletionRequest,
  LiteLLMChatCompletionResponse,
  TokenUsage,
} from "./types.js";
import { trackUsageAsync } from "./tracking.js";

export class StreamingResponseParser {
  private requestId: string;
  private model: string;
  private requestContext: RequestContext;
  private requestDuration: number;
  private startTime: number;
  private firstTokenTime: number | null = null;
  private reportedUsage?: TokenUsage;
  private finishReason: string | null = null;
  private responseFormat?: any;
  private requestBody?: LiteLLMChatCompletionRequest;
  private capturePrompts: boolean = false;
  private maxPromptSize: number;
  private accumulatedContent: string = "";
  private accumulatedToolCalls: Map<number, any> = new Map();
  private responseId?: string;
  private responseCreated?: number;
  private responseModel?: string;

  constructor(
    requestId: string,
    model: string,
    requestContext: RequestContext,
    requestDuration: number,
    responseFormat?: any,
    requestBody?: LiteLLMChatCompletionRequest,
  ) {
    this.requestId = requestId;
    this.model = model;
    this.requestContext = requestContext;
    this.requestDuration = requestDuration;
    this.startTime = Date.now();
    this.responseFormat = responseFormat;
    this.requestBody = requestBody;
    this.capturePrompts = shouldCapturePrompts(requestContext.metadata);
    this.maxPromptSize = getMaxPromptSize();
  }

  async parseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          this.processSSELine(line);
        }
      }

      if (buffer.trim()) {
        this.processSSELine(buffer);
      }
    } finally {
      reader.releaseLock();
      this.finalizeTracking();
    }
  }

  private processSSELine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;

    if (trimmed.startsWith("data: ")) {
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const chunk = JSON.parse(data);
        this.processStreamChunk(chunk);
      } catch {
        // skip unparseable chunks
      }
    }
  }

  private processStreamChunk(chunk: any): void {
    if (!chunk || typeof chunk !== "object") return;

    if (!this.responseId && chunk.id) this.responseId = chunk.id;
    if (!this.responseCreated && chunk.created) this.responseCreated = chunk.created;
    if (!this.responseModel && chunk.model) this.responseModel = chunk.model;

    if (this.firstTokenTime === null && chunk.choices?.[0]?.delta?.content) {
      this.firstTokenTime = Date.now();
    }

    if (this.capturePrompts && chunk.choices?.[0]?.delta?.content) {
      const remaining = this.maxPromptSize - this.accumulatedContent.length;
      if (remaining > 0) {
        this.accumulatedContent += chunk.choices[0].delta.content.slice(0, remaining);
      }
    }

    const delta = chunk.choices?.[0]?.delta;
    if (this.capturePrompts && delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index;
        if (index === undefined) continue;

        let accumulated = this.accumulatedToolCalls.get(index);
        if (!accumulated) {
          accumulated = {
            index,
            id: toolCallDelta.id,
            type: toolCallDelta.type || "function",
            function: { name: "", arguments: "" },
          };
          this.accumulatedToolCalls.set(index, accumulated);
        }

        if (toolCallDelta.id) accumulated.id = toolCallDelta.id;
        if (toolCallDelta.type) accumulated.type = toolCallDelta.type;
        if (toolCallDelta.function?.name) accumulated.function.name = toolCallDelta.function.name;
        if (toolCallDelta.function?.arguments) {
          const currentSize = accumulated.function.arguments.length;
          const remaining = this.maxPromptSize - currentSize;
          if (remaining > 0) {
            accumulated.function.arguments += toolCallDelta.function.arguments.slice(0, remaining);
          }
        }
      }
    }

    if (chunk.usage) {
      this.reportedUsage = mergeReportedUsage(this.reportedUsage, chunk.usage);
    }

    if (chunk.choices?.[0]?.finish_reason) this.finishReason = chunk.choices[0].finish_reason;

    if (!this.reportedUsage?.total_tokens && chunk.x_groq?.usage) {
      this.reportedUsage = chunk.x_groq.usage;
    }
  }

  private finalizeTracking(): void {
    const usage = extractUsageTokens(
      this.reportedUsage,
      resolveMeteredModel(this.model, this.responseModel),
    );

    const timeToFirstToken = this.firstTokenTime
      ? this.firstTokenTime - this.startTime
      : this.requestDuration;

    let reconstructedResponse: LiteLLMChatCompletionResponse | undefined;
    if (this.capturePrompts && (this.accumulatedContent || this.accumulatedToolCalls.size > 0)) {
      const message: any = {
        role: "assistant",
        content: this.accumulatedContent,
      };

      if (this.accumulatedToolCalls.size > 0) {
        message.tool_calls = Array.from(this.accumulatedToolCalls.values())
          .sort((a, b) => a.index - b.index)
          .map((tc) => {
            const { index: _, ...rest } = tc;
            return rest;
          });
      }

      reconstructedResponse = {
        id: this.responseId || "unknown",
        object: "chat.completion",
        created: this.responseCreated || Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: this.finishReason || "stop",
          },
        ],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
      };
    }

    trackUsageAsync({
      ...usage,
      requestId: this.requestId,
      model: this.model,
      duration: this.requestDuration,
      finishReason: this.finishReason || "stop",
      usageMetadata: this.requestContext.metadata,
      isStreamed: true,
      timeToFirstToken,
      responseFormat: this.responseFormat,
      request: this.requestBody,
      response: reconstructedResponse,
    });
  }
}

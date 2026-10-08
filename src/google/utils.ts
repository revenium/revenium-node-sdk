import { randomUUID } from "crypto";
import { UsageMetadata } from "../_core/types/index.js";
import { getLogger } from "../_core/config/manager.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import { buildPayload } from "../_core/metering/payload-builder.js";
import { printUsageSummary } from "../_core/prompt/summary-printer.js";
import {
  shouldCapturePrompts,
  getMaxPromptSize,
  truncateString,
} from "../_core/prompt/extraction.js";
import { GoogleUsageMetadata } from "./types.js";

const MIDDLEWARE_SOURCE = "revenium-google-node";

const ASPECT_RATIO_TO_RESOLUTION: Record<string, string> = {
  "1:1": "1024x1024",
  "3:4": "768x1024",
  "4:3": "1024x768",
  "9:16": "576x1024",
  "16:9": "1024x576",
};

export function mapAspectRatioToResolution(aspectRatio?: string): string {
  if (!aspectRatio) return "1024x1024";
  return ASPECT_RATIO_TO_RESOLUTION[aspectRatio] ?? "1024x1024";
}

export function mapGoogleFinishReason(finishReason: any, defaultReason: string = "END"): string {
  try {
    if (!finishReason || typeof finishReason !== "string" || finishReason.trim() === "") {
      return defaultReason;
    }

    const normalized = finishReason.trim().toUpperCase();

    switch (normalized) {
      case "STOP":
        return "END";
      case "MAX_TOKENS":
        return "TOKEN_LIMIT";
      case "TOO_MANY_TOOL_CALLS":
        return "COMPLETION_LIMIT";
      case "SAFETY":
      case "LANGUAGE":
      case "RECITATION":
      case "BLOCKLIST":
      case "PROHIBITED_CONTENT":
      case "SPII":
      case "MODEL_ARMOR":
      case "IMAGE_SAFETY":
      case "IMAGE_PROHIBITED_CONTENT":
      case "IMAGE_RECITATION":
      case "MALFORMED_FUNCTION_CALL":
      case "UNEXPECTED_TOOL_CALL":
      case "NO_IMAGE":
        return "ERROR";
      case "CANCELLED":
      case "CANCELED":
        return "CANCELLED";
      case "FINISH_REASON_UNSPECIFIED":
      case "OTHER":
      case "IMAGE_OTHER":
        return defaultReason;
      default:
        getLogger().warn("Unknown Google finish reason, mapping to default", {
          finishReason,
          defaultReason,
        });
        return defaultReason;
    }
  } catch {
    return "END";
  }
}

export function extractFinishReason(response: any): string | undefined {
  try {
    if (!response || typeof response !== "object") return undefined;
    if (
      response.candidates &&
      Array.isArray(response.candidates) &&
      response.candidates.length > 0 &&
      response.candidates[0]?.finishReason
    ) {
      return response.candidates[0].finishReason;
    }
    if (response.finishReason) return response.finishReason;
    return undefined;
  } catch {
    return undefined;
  }
}

export function extractConfidenceScore(response: any): number | undefined {
  try {
    if (!response || typeof response !== "object") return undefined;

    if (
      response.candidates?.[0]?.avgLogprobs !== undefined &&
      typeof response.candidates[0].avgLogprobs === "number"
    ) {
      return Math.min(1.0, Math.max(0.0, Math.exp(response.candidates[0].avgLogprobs)));
    }

    const supports = response.candidates?.[0]?.groundingMetadata?.groundingSupports;
    if (Array.isArray(supports) && supports.length > 0) {
      const allScores: number[] = [];
      for (const support of supports) {
        if (Array.isArray(support.confidenceScores)) {
          for (const score of support.confidenceScores) {
            if (typeof score === "number") allScores.push(score);
          }
        }
      }
      if (allScores.length > 0) {
        const avg = allScores.reduce((sum, s) => sum + s, 0) / allScores.length;
        return Math.min(1.0, Math.max(0.0, avg));
      }
    }

    const searchScore =
      response.candidates?.[0]?.groundingMetadata?.retrievalMetadata
        ?.googleSearchDynamicRetrievalScore;
    if (typeof searchScore === "number") {
      return Math.min(1.0, Math.max(0.0, searchScore));
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function mapGoogleUsageMetadata(meta?: GoogleUsageMetadata): UsageMetadata | undefined {
  if (!meta) return undefined;
  const result: UsageMetadata = {};

  if (meta.traceId) result.traceId = meta.traceId;
  if (meta.taskType) result.taskType = meta.taskType;
  if (meta.organizationName || meta.organizationId)
    result.organizationName = meta.organizationName || meta.organizationId;
  if (meta.productName || meta.productId) result.productName = meta.productName || meta.productId;
  if (meta.subscriptionId) result.subscriptionId = meta.subscriptionId;
  if (meta.agent) result.agent = meta.agent;
  if (meta.responseQualityScore !== undefined)
    result.responseQualityScore = meta.responseQualityScore;
  if (meta.capturePrompts !== undefined) result.capturePrompts = meta.capturePrompts;
  if (meta.agenticJobId) result.agenticJobId = meta.agenticJobId;
  if (meta.agenticJobName) result.agenticJobName = meta.agenticJobName;
  if (meta.agenticJobType) result.agenticJobType = meta.agenticJobType;
  if (meta.agenticJobVersion) result.agenticJobVersion = meta.agenticJobVersion;
  if (meta.operationSubtype) result.operationSubtype = meta.operationSubtype;

  if (meta.subscriberId || meta.subscriberEmail || meta.subscriberCredential) {
    result.subscriber = {
      id: meta.subscriberId,
      email: meta.subscriberEmail,
    };
    if (meta.subscriberCredential) {
      result.subscriber.credential = {
        name: meta.subscriberCredentialName || "apiKey",
        value: meta.subscriberCredential,
      };
    }
  }

  return result;
}

function extractGooglePrompts(
  prompts: string[],
  response: any,
  meta?: GoogleUsageMetadata,
): {
  systemPrompt?: string;
  inputMessages?: string;
  outputResponse?: string;
  promptsTruncated: boolean;
} | null {
  const usageMetadata = mapGoogleUsageMetadata(meta);
  if (!shouldCapturePrompts(usageMetadata)) return null;

  const maxSize = getMaxPromptSize();

  const inputResult = truncateString(prompts.join("\n\n"), maxSize);

  let outputRaw = "";
  if (response?.text) {
    outputRaw = response.text;
  } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
    outputRaw = response.candidates[0].content.parts[0].text;
  }
  const outputResult = truncateString(outputRaw, maxSize);

  if (!inputResult.value && !outputResult.value) return null;

  return {
    inputMessages: inputResult.value || undefined,
    outputResponse: outputResult.value || undefined,
    promptsTruncated: inputResult.truncated || outputResult.truncated,
  };
}

export async function trackGoogleUsageAsync(params: {
  transactionId: string;
  model: string;
  startTime: Date;
  endTime: Date;
  response: any;
  operationType: "CHAT" | "EMBED";
  isStreaming: boolean;
  modelSource: "GOOGLE" | "GOOGLE_VERTEX_AI";
  usageMetadata?: GoogleUsageMetadata;
  prompts?: string[];
  timeToFirstToken?: number;
}): Promise<void> {
  const logger = getLogger();

  const finishReason = extractFinishReason(params.response);
  const stopReason = mapGoogleFinishReason(finishReason, "END");
  const confidenceScore = extractConfidenceScore(params.response);

  const usageMeta = mapGoogleUsageMetadata(params.usageMetadata);
  if (confidenceScore !== undefined && usageMeta) {
    usageMeta.responseQualityScore = params.usageMetadata?.responseQualityScore ?? confidenceScore;
  }

  const promptData = params.prompts
    ? extractGooglePrompts(params.prompts, params.response, params.usageMetadata)
    : null;

  const duration = params.endTime.getTime() - params.startTime.getTime();

  try {
    const payload = await buildPayload({
      operationType: params.operationType,
      model: params.model,
      requestId: params.transactionId,
      startTime: params.startTime.getTime(),
      duration,
      provider: "Google",
      modelSource: params.modelSource,
      middlewareSource: MIDDLEWARE_SOURCE,
      usageMetadata: usageMeta,
      usage: {
        prompt_tokens: params.response?.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: params.response?.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: params.response?.usageMetadata?.totalTokenCount ?? 0,
        reasoning_tokens: params.response?.usageMetadata?.thoughtsTokenCount,
        cached_tokens: params.response?.usageMetadata?.cachedContentTokenCount,
      },
      stopReason,
      isStreamed: params.isStreaming,
      timeToFirstToken: params.timeToFirstToken,
      promptData,
    });

    try {
      await sendToRevenium(payload);
    } finally {
      printUsageSummary(payload);
    }
  } catch (error) {
    logger.warn("Google tracking failed", {
      error: error instanceof Error ? error.message : String(error),
      transactionId: params.transactionId,
    });
  }
}

export function generateTransactionId(): string {
  return randomUUID();
}

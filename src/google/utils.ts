import { randomUUID } from "crypto";
import { Subscriber, UsageMetadata } from "../_core/types/index.js";
import { getConfig, getLogger } from "../_core/config/manager.js";
import { getErrorMessage } from "../_core/resilience/error-handler.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import { resolveReportedCount } from "../_core/metering/cache-tokens.js";
import { buildPayload } from "../_core/metering/payload-builder.js";
import { ERROR_STOP_REASON } from "../_core/stop-reason-mapper.js";
import { printUsageSummary } from "../_core/prompt/summary-printer.js";
import {
  shouldCapturePrompts,
  getMaxPromptSize,
  truncateString,
} from "../_core/prompt/extraction.js";
import {
  GoogleEmbeddingResponseFields,
  GoogleUsageMetadata,
  IGoogleEmbeddingResponse,
} from "./types.js";

const MIDDLEWARE_SOURCE = "revenium-google-node";

const MAX_ERROR_REASON_LENGTH = 255;

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
        return ERROR_STOP_REASON;
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

type GoogleOnlyField = Exclude<keyof GoogleUsageMetadata, keyof UsageMetadata>;

const GOOGLE_ONLY_FIELDS: Record<GoogleOnlyField, true> = {
  subscriberId: true,
  subscriberEmail: true,
  subscriberCredential: true,
  subscriberCredentialName: true,
  modelSource: true,
};

function mergeGoogleSubscriber(meta: GoogleUsageMetadata): Subscriber | undefined {
  const id = meta.subscriber?.id ?? meta.subscriberId;
  const email = meta.subscriber?.email ?? meta.subscriberEmail;
  const credential =
    meta.subscriber?.credential ??
    (meta.subscriberCredential
      ? { name: meta.subscriberCredentialName || "apiKey", value: meta.subscriberCredential }
      : undefined);

  if (!id && !email && !credential) return undefined;
  return { id, email, credential };
}

export function mapGoogleUsageMetadata(meta?: GoogleUsageMetadata): UsageMetadata | undefined {
  if (!meta) return undefined;

  const { subscriber: _subscriber, ...rest } = meta;

  const result: UsageMetadata = Object.fromEntries(
    Object.entries(rest).filter(([field]) => !(field in GOOGLE_ONLY_FIELDS)),
  );

  const subscriber = mergeGoogleSubscriber(meta);
  if (subscriber) result.subscriber = subscriber;

  return result;
}

export function withGoogleErrorReason(
  usageMetadata: UsageMetadata | undefined,
  error: unknown,
): UsageMetadata {
  return {
    ...usageMetadata,
    errorReason: truncateString(getErrorMessage(error), MAX_ERROR_REASON_LENGTH).value,
  };
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

function mergeStreamedUsageMetadata(previous: any, chunk: any): any {
  if (!previous) return chunk;
  if (!chunk) return previous;
  return {
    ...previous,
    ...chunk,
    promptTokenCount: resolveReportedCount(chunk.promptTokenCount, previous.promptTokenCount),
    candidatesTokenCount: resolveReportedCount(
      chunk.candidatesTokenCount,
      previous.candidatesTokenCount,
    ),
    thoughtsTokenCount: resolveReportedCount(chunk.thoughtsTokenCount, previous.thoughtsTokenCount),
    cachedContentTokenCount: resolveReportedCount(
      chunk.cachedContentTokenCount,
      previous.cachedContentTokenCount,
    ),
    totalTokenCount: resolveReportedCount(chunk.totalTokenCount, previous.totalTokenCount),
  };
}

export function mergeStreamedGoogleResponse(previous: any, chunk: any): any {
  if (!previous) return chunk;
  if (!chunk) return previous;
  return Object.assign(Object.create(Object.getPrototypeOf(chunk)), chunk, {
    usageMetadata: mergeStreamedUsageMetadata(previous.usageMetadata, chunk.usageMetadata),
  });
}

function toPositiveCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function countGoogleEmbeddingTokens(
  countTokens: () => Promise<{ totalTokens?: number }>,
): Promise<number | null> {
  try {
    const { totalTokens } = await countTokens();
    return toPositiveCount(totalTokens) ?? null;
  } catch (error) {
    getLogger().warn("Google embedding token count failed", {
      error: getErrorMessage(error),
    });
    return null;
  }
}

function extractReportedEmbeddingTokens(
  response: GoogleEmbeddingResponseFields,
): number | undefined {
  const countedByEmbedding = (response?.embeddings ?? []).reduce(
    (total, embedding) => total + (toPositiveCount(embedding?.statistics?.tokenCount) ?? 0),
    0,
  );
  return (
    toPositiveCount(countedByEmbedding) ??
    toPositiveCount(response?.usageMetadata?.promptTokenCount)
  );
}

async function resolveEmbeddingInputTokens(
  response: GoogleEmbeddingResponseFields,
  resolveInputTokens?: () => Promise<number | null>,
): Promise<number | null> {
  const reported = extractReportedEmbeddingTokens(response);
  if (reported !== undefined) return reported;
  return resolveInputTokens ? resolveInputTokens() : null;
}

export function buildGoogleEmbeddingResponse(
  response: GoogleEmbeddingResponseFields,
): IGoogleEmbeddingResponse {
  const reportedInputTokens = extractReportedEmbeddingTokens(response);
  return {
    embedding: {
      embedding: response.embeddings?.[0]?.values ?? [],
      modelVersion: response.modelVersion ?? "",
      usageMetadata: {
        totalTokenCount: response.usageMetadata?.totalTokenCount ?? reportedInputTokens,
        promptTokenCount: response.usageMetadata?.promptTokenCount ?? reportedInputTokens,
      },
    },
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
  resolveInputTokens?: () => Promise<number | null>;
  error?: unknown;
}): Promise<void> {
  const logger = getLogger();

  const failed = params.error !== undefined;
  const stopReason = failed
    ? ERROR_STOP_REASON
    : mapGoogleFinishReason(extractFinishReason(params.response), "END");
  const confidenceScore = extractConfidenceScore(params.response);

  const providedMeta = mapGoogleUsageMetadata(params.usageMetadata);
  if (confidenceScore !== undefined && providedMeta) {
    providedMeta.responseQualityScore =
      params.usageMetadata?.responseQualityScore ?? confidenceScore;
  }

  const usageMeta = failed ? withGoogleErrorReason(providedMeta, params.error) : providedMeta;

  const promptData = params.prompts
    ? extractGooglePrompts(params.prompts, params.response, params.usageMetadata)
    : null;

  const duration = params.endTime.getTime() - params.startTime.getTime();

  try {
    const reportedUsage = params.response?.usageMetadata;
    const isEmbedding = params.operationType === "EMBED";
    const shouldCountEmbeddingTokens = !failed && getConfig() !== null;
    const inputTokens = isEmbedding
      ? ((await resolveEmbeddingInputTokens(
          params.response,
          shouldCountEmbeddingTokens ? params.resolveInputTokens : undefined,
        )) ?? (failed ? 0 : null))
      : (reportedUsage?.promptTokenCount ?? 0);

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
        prompt_tokens: inputTokens,
        completion_tokens:
          (reportedUsage?.candidatesTokenCount ?? 0) + (reportedUsage?.thoughtsTokenCount ?? 0),
        total_tokens: isEmbedding
          ? (toPositiveCount(reportedUsage?.totalTokenCount) ?? inputTokens)
          : (reportedUsage?.totalTokenCount ?? 0),
        reasoning_tokens: reportedUsage?.thoughtsTokenCount,
        cached_tokens: reportedUsage?.cachedContentTokenCount,
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
      error: getErrorMessage(error),
      transactionId: params.transactionId,
    });
  }
}

export function generateTransactionId(): string {
  return randomUUID();
}

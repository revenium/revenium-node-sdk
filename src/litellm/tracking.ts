import { getLogger } from "../_core/config/manager.js";
import { sendToRevenium } from "../_core/metering/api-client.js";
import { mapStopReason } from "../_core/stop-reason-mapper.js";
import { printUsageSummary } from "../_core/prompt/summary-printer.js";
import { extractPrompts } from "../_core/prompt/extraction.js";
import {
  getEnvironment,
  getRegion,
  getCredentialAlias,
  getTraceType,
  getTraceName,
  getParentTransactionId,
  getTransactionName,
  getRetryNumber,
  detectOperationSubtype,
  getTicketId,
} from "../_core/metadata/trace-fields.js";
import { resolveSkillFields } from "../_core/metadata/metadata-builder.js";
import { extractModelSource, extractProvider, extractModelName } from "./provider-mapper.js";
import { extractCacheTokenCounts } from "../_core/metering/cache-tokens.js";
import type { ReveniumPayload } from "../_core/types/index.js";
import type {
  LiteLLMUsageMetadata,
  LiteLLMChatCompletionRequest,
  LiteLLMChatCompletionResponse,
} from "./types.js";
import { getLiteLLMConfig } from "./http-client.js";

const MIDDLEWARE_SOURCE = "revenium-litellm-node";

function buildSubscriber(metadata?: LiteLLMUsageMetadata) {
  if (
    metadata?.subscriberId &&
    metadata?.subscriberEmail &&
    metadata?.subscriberCredentialName &&
    metadata?.subscriberCredential
  ) {
    return {
      id: metadata.subscriberId,
      email: metadata.subscriberEmail,
      credential: {
        name: metadata.subscriberCredentialName,
        value: metadata.subscriberCredential,
      },
    };
  }
  return undefined;
}

export async function sendReveniumMetrics(data: {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  duration: number;
  finishReason: string | null;
  usageMetadata?: LiteLLMUsageMetadata;
  isStreamed?: boolean;
  timeToFirstToken?: number;
  operationType?: "CHAT" | "EMBED";
  responseFormat?: any;
  request?: LiteLLMChatCompletionRequest;
  response?: LiteLLMChatCompletionResponse;
}): Promise<void> {
  const logger = getLogger();
  const litellmConfig = getLiteLLMConfig();

  if (!litellmConfig) {
    logger.warn("LiteLLM configuration not found, skipping tracking");
    return;
  }

  const now = new Date().toISOString();
  const requestTime = new Date(Date.now() - data.duration).toISOString();
  const operationType = data.operationType || "CHAT";
  const isEmbedding = operationType === "EMBED";

  const subscriber = buildSubscriber(data.usageMetadata);
  const region = data.usageMetadata?.region || (await getRegion()) || undefined;

  const attributes: Record<string, unknown> = {};
  if (data.responseFormat) {
    if (typeof data.responseFormat === "object" && data.responseFormat !== null) {
      const formatType = data.responseFormat.type;
      if (formatType) {
        attributes.response_format_type = formatType;
        if (formatType === "json_schema") {
          const schemaName = data.responseFormat.json_schema?.name;
          if (schemaName) {
            attributes.response_format_schema_name = schemaName;
          }
        }
      }
    } else {
      attributes.response_format = data.responseFormat;
    }
  }

  const promptData =
    data.request && data.response
      ? extractPrompts(
          data.request.messages,
          data.response.choices?.[0]?.message?.content || undefined,
          data.usageMetadata,
        )
      : null;

  const payload: ReveniumPayload = {
    stopReason: isEmbedding ? "END" : mapStopReason(data.finishReason, logger),
    costType: "AI",
    isStreamed: isEmbedding ? false : data.isStreamed || false,
    operationType,
    inputTokenCount: data.promptTokens,
    outputTokenCount: isEmbedding ? 0 : data.completionTokens,
    reasoningTokenCount: data.reasoningTokens || 0,
    cacheCreationTokenCount: data.cacheCreationTokens,
    cacheReadTokenCount: data.cachedTokens,
    totalTokenCount: data.totalTokens,
    model: extractModelName(data.model),
    modelSource: extractModelSource(data.model),
    transactionId: data.requestId,
    responseTime: now,
    requestDuration: Math.round(data.duration),
    provider: extractProvider(data.model),
    requestTime,
    completionStartTime: isEmbedding
      ? now
      : data.isStreamed && data.timeToFirstToken
        ? new Date(Date.now() - (data.duration - data.timeToFirstToken)).toISOString()
        : now,
    timeToFirstToken: isEmbedding ? 0 : data.timeToFirstToken || Math.round(data.duration),
    middlewareSource: MIDDLEWARE_SOURCE,
    traceId: data.usageMetadata?.traceId,
    taskType: data.usageMetadata?.taskType,
    agent: data.usageMetadata?.agent,
    organizationName:
      data.usageMetadata?.organizationName ||
      data.usageMetadata?.organizationId ||
      litellmConfig.organizationName ||
      litellmConfig.organizationId,
    productName: data.usageMetadata?.productName || data.usageMetadata?.productId,
    subscriber,
    subscriptionId: data.usageMetadata?.subscriptionId,
    responseQualityScore: data.usageMetadata?.responseQualityScore,
    environment: data.usageMetadata?.environment || getEnvironment() || undefined,
    operationSubtype: data.usageMetadata?.operationSubtype || detectOperationSubtype() || undefined,
    retryNumber: data.usageMetadata?.retryNumber ?? getRetryNumber() ?? undefined,
    parentTransactionId:
      data.usageMetadata?.parentTransactionId || getParentTransactionId() || undefined,
    transactionName: data.usageMetadata?.transactionName || getTransactionName() || undefined,
    region,
    credentialAlias: data.usageMetadata?.credentialAlias || getCredentialAlias() || undefined,
    traceType: data.usageMetadata?.traceType || getTraceType() || undefined,
    traceName: data.usageMetadata?.traceName || getTraceName() || undefined,
    agenticJobId: data.usageMetadata?.agenticJobId,
    agenticJobName: data.usageMetadata?.agenticJobName,
    agenticJobType: data.usageMetadata?.agenticJobType,
    agenticJobVersion: data.usageMetadata?.agenticJobVersion,
    ticketId: data.usageMetadata?.ticketId || getTicketId() || undefined,
    ...resolveSkillFields(data.usageMetadata),
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    systemPrompt: promptData?.systemPrompt,
    inputMessages: promptData?.inputMessages,
    outputResponse: promptData?.outputResponse,
    promptsTruncated: promptData?.promptsTruncated,
  };

  try {
    await sendToRevenium(payload);
  } catch (error) {
    logger.warn("Revenium tracking failed", {
      error: error instanceof Error ? error.message : String(error),
      requestId: data.requestId,
    });
  }

  printUsageSummary(payload);
}

export function trackUsageAsync(trackingData: Parameters<typeof sendReveniumMetrics>[0]): void {
  const logger = getLogger();

  sendReveniumMetrics(trackingData)
    .then(() => {
      logger.debug("Revenium tracking completed successfully", {
        requestId: trackingData.requestId,
      });
    })
    .catch((error) => {
      logger.warn("Revenium tracking failed completely", {
        error: error instanceof Error ? error.message : String(error),
        requestId: trackingData.requestId,
      });
    });
}

export function trackEmbeddingsUsageAsync(data: {
  requestId: string;
  model: string;
  promptTokens: number;
  totalTokens: number;
  duration: number;
  usageMetadata?: LiteLLMUsageMetadata;
}): void {
  trackUsageAsync({
    ...data,
    completionTokens: 0,
    finishReason: "stop",
    isStreamed: false,
    timeToFirstToken: 0,
    operationType: "EMBED",
  });
}

export function extractMetadataFromHeaders(headers: Record<string, string>): LiteLLMUsageMetadata {
  return {
    subscriberId: headers["x-revenium-subscriber-id"],
    productName: headers["x-revenium-product-name"] || headers["x-revenium-product-id"],
    organizationName:
      headers["x-revenium-organization-name"] || headers["x-revenium-organization-id"],
    traceId: headers["x-revenium-trace-id"],
    taskType: headers["x-revenium-task-type"],
    agent: headers["x-revenium-agent"],
    subscriberEmail: headers["x-revenium-subscriber-email"],
    subscriptionId: headers["x-revenium-subscription-id"],
    subscriberCredentialName: headers["x-revenium-subscriber-credential-name"],
    subscriberCredential: headers["x-revenium-subscriber-credential"],
    environment: headers["x-revenium-environment"],
    operationSubtype: headers["x-revenium-operation-subtype"],
    retryNumber: headers["x-revenium-retry-number"]
      ? parseInt(headers["x-revenium-retry-number"], 10)
      : undefined,
    parentTransactionId: headers["x-revenium-parent-transaction-id"],
    transactionName: headers["x-revenium-transaction-name"],
    region: headers["x-revenium-region"],
    credentialAlias: headers["x-revenium-credential-alias"],
    traceType: headers["x-revenium-trace-type"],
    traceName: headers["x-revenium-trace-name"],
    skillName: headers["x-revenium-skill-name"],
    skillSource: headers["x-revenium-skill-source"],
    skillKind: headers["x-revenium-skill-kind"],
    skillPluginName: headers["x-revenium-skill-plugin-name"],
    skillMarketplaceName: headers["x-revenium-skill-marketplace-name"],
    skillInvocationTrigger: headers["x-revenium-skill-invocation-trigger"],
    capturePrompts: headers["x-revenium-capture-prompts"]
      ? headers["x-revenium-capture-prompts"].toLowerCase() === "true"
      : undefined,
  };
}

export function extractUsageFromResponse(response: LiteLLMChatCompletionResponse): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  finishReason: string | null;
} {
  const usage = response.usage;
  const { cacheReadTokens, cacheCreationTokens } = extractCacheTokenCounts(usage);
  return {
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    totalTokens: usage?.total_tokens || 0,
    cachedTokens: cacheReadTokens,
    cacheCreationTokens,
    finishReason: response.choices?.[0]?.finish_reason || null,
  };
}

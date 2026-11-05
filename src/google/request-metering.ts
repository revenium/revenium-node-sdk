import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from "@google/genai";
import { getLogger } from "../_core/config/manager.js";
import { resolveConfig, runWithCallConfig } from "../_core/config/call-config.js";
import { getErrorMessage } from "../_core/resilience/error-handler.js";
import { enforceCostControls } from "../_core/enforcement/evaluator.js";
import { ReveniumConfig } from "../_core/types/index.js";
import { ensureGoogleConfig } from "./config.js";
import {
  buildGoogleEnforcementCriteria,
  countGoogleEmbeddingTokens,
  generateTransactionId,
  googleContentsToPrompts,
  mergeStreamedGoogleResponse,
  shouldCaptureGooglePrompts,
  trackGoogleUsageAsync,
} from "./utils.js";

export interface MeteredModels {
  apiClient: { isVertexAI(): boolean };
  countTokens(params: CountTokensParameters): Promise<CountTokensResponse>;
}

export type ForwardRequest<P, R> = (params: Omit<P, "usageMetadata">) => Promise<R>;

type MeteredParameters = GenerateContentParameters | EmbedContentParameters;
type TrackedRequest = Parameters<typeof trackGoogleUsageAsync>[0];

type RequestContext = Pick<
  TrackedRequest,
  | "transactionId"
  | "model"
  | "startTime"
  | "modelSource"
  | "usageMetadata"
  | "prompts"
  | "systemPrompt"
  | "enforcementScope"
> & { config: ReveniumConfig | null };

type RequestOutcome = Pick<
  TrackedRequest,
  "operationType" | "isStreaming" | "response" | "error" | "timeToFirstToken" | "resolveInputTokens"
>;

function systemInstructionOf(params: MeteredParameters) {
  return params.config && "systemInstruction" in params.config
    ? params.config.systemInstruction
    : undefined;
}

function capturedPrompts(
  params: MeteredParameters,
): Pick<RequestContext, "prompts" | "systemPrompt"> {
  if (!shouldCaptureGooglePrompts(params.usageMetadata)) return {};
  return {
    prompts: googleContentsToPrompts(params.contents),
    systemPrompt: googleContentsToPrompts(systemInstructionOf(params)).join("\n\n") || undefined,
  };
}

async function openRequest<P extends MeteredParameters>(
  models: MeteredModels,
  params: P,
): Promise<{ context: RequestContext; cleanParams: Omit<P, "usageMetadata"> }> {
  const { usageMetadata, ...cleanParams } = params;
  ensureGoogleConfig();
  const config = resolveConfig();
  const enforcementScope = buildGoogleEnforcementCriteria(params.model, usageMetadata);
  await enforceCostControls(enforcementScope);

  return {
    cleanParams,
    context: {
      transactionId: generateTransactionId(),
      model: params.model,
      startTime: new Date(),
      modelSource: models.apiClient.isVertexAI() ? "GOOGLE_VERTEX_AI" : "GOOGLE",
      usageMetadata,
      ...capturedPrompts(params),
      enforcementScope,
      config,
    },
  };
}

function meter(context: RequestContext, outcome: RequestOutcome): void {
  const { config, ...request } = context;
  void runWithCallConfig(config, () =>
    trackGoogleUsageAsync({ ...request, ...outcome, endTime: new Date() }),
  ).catch((error) => getLogger().warn("Google metering failed", { error: getErrorMessage(error) }));
}

async function forward<P, R>(
  context: RequestContext,
  outcome: Omit<RequestOutcome, "response">,
  original: ForwardRequest<P, R>,
  cleanParams: Omit<P, "usageMetadata">,
): Promise<R> {
  try {
    return await original(cleanParams);
  } catch (error) {
    meter(context, { ...outcome, response: null, error });
    throw error;
  }
}

async function* meterStream(
  stream: AsyncGenerator<GenerateContentResponse>,
  context: RequestContext,
): AsyncGenerator<GenerateContentResponse> {
  let firstTokenTime: number | undefined;
  let mergedResponse: GenerateContentResponse | null = null;
  let metered = false;

  const meterOnce = (error?: unknown): void => {
    if (metered) return;
    metered = true;
    meter(context, {
      operationType: "CHAT",
      isStreaming: true,
      response: mergedResponse,
      timeToFirstToken: firstTokenTime ? firstTokenTime - context.startTime.getTime() : undefined,
      error,
    });
  };

  try {
    for await (const chunk of stream) {
      firstTokenTime ??= Date.now();
      mergedResponse = mergeStreamedGoogleResponse(mergedResponse, chunk);
      yield chunk;
    }
  } catch (error) {
    meterOnce(error);
    throw error;
  } finally {
    meterOnce();
  }
}

async function meterRequest<P extends MeteredParameters, R>(
  models: MeteredModels,
  original: ForwardRequest<P, R>,
  params: P,
  outcome: Omit<RequestOutcome, "response">,
): Promise<R> {
  const { context, cleanParams } = await openRequest(models, params);
  const response = await forward(context, outcome, original, cleanParams);
  meter(context, { ...outcome, response });
  return response;
}

export function meterGenerateContent(
  models: MeteredModels,
  original: ForwardRequest<GenerateContentParameters, GenerateContentResponse>,
  params: GenerateContentParameters,
): Promise<GenerateContentResponse> {
  return meterRequest(models, original, params, { operationType: "CHAT", isStreaming: false });
}

export async function meterGenerateContentStream(
  models: MeteredModels,
  original: ForwardRequest<GenerateContentParameters, AsyncGenerator<GenerateContentResponse>>,
  params: GenerateContentParameters,
): Promise<AsyncGenerator<GenerateContentResponse>> {
  const { context, cleanParams } = await openRequest(models, params);
  const outcome = { operationType: "CHAT", isStreaming: true } as const;
  return meterStream(await forward(context, outcome, original, cleanParams), context);
}

export function meterEmbedContent(
  models: MeteredModels,
  original: ForwardRequest<EmbedContentParameters, EmbedContentResponse>,
  params: EmbedContentParameters,
): Promise<EmbedContentResponse> {
  return meterRequest(models, original, params, {
    operationType: "EMBED",
    isStreaming: false,
    resolveInputTokens: () =>
      countGoogleEmbeddingTokens(() =>
        models.countTokens({ model: params.model, contents: params.contents }),
      ),
  });
}

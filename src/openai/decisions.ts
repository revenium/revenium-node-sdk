import OpenAI from "openai";
import { randomUUID } from "crypto";
import { Config, UsageMetadata } from "../_core/types/index.js";
import { runProviderCall } from "../_core/metering/metering-context.js";
import { runWithCallConfig } from "../_core/config/call-config.js";
import { isCostLimitRefusal } from "../_core/resilience/error-handler.js";
import { enforceCostControls } from "../_core/enforcement/evaluator.js";
import { ProviderInfo } from "./provider-detection.js";
import {
  MIDDLEWARE_SOURCE,
  enforcementScopeFor,
  extractResponsesUsage,
  toInputMessages,
  trackFailedCall,
  trackUsageAsync,
} from "./middleware.js";

type DecisionCreateParams = Record<string, unknown> & { model: string; input: unknown };

interface DecisionProbability<V> {
  value: V;
  probability: number;
}

type DecisionAnswer =
  | { type: "predicate"; name: string | null; probability: number }
  | {
      type: "choice";
      name: string | null;
      choice: string | boolean;
      confidence: number;
      probabilities: DecisionProbability<string | boolean>[];
    }
  | {
      type: "score";
      name: string | null;
      score: number;
      confidence: number;
      probabilities: (DecisionProbability<number> & { label: string })[];
    }
  | { type: "refusal"; name: string | null };

interface DecisionResult {
  answers: DecisionAnswer[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

interface OpenAIClientWithDecisions {
  decisions?: {
    create(params: DecisionCreateParams): Promise<DecisionResult>;
  };
}

export class DecisionsInterface {
  constructor(
    private client: OpenAI,
    private config: Config,
    private providerInfo: ProviderInfo,
  ) {}

  async create(params: DecisionCreateParams, metadata?: UsageMetadata): Promise<DecisionResult> {
    return runWithCallConfig(this.config, () => this.meteredCreate(params, metadata));
  }

  private async meteredCreate(
    params: DecisionCreateParams,
    metadata?: UsageMetadata,
  ): Promise<DecisionResult> {
    const decisionsAPI = (this.client as unknown as OpenAIClientWithDecisions).decisions;
    if (!decisionsAPI?.create) {
      throw new Error(
        "Decisions API not available in this OpenAI SDK version (requires openai >= 7.30.0)",
      );
    }
    const enforcementScope = enforcementScopeFor(this.providerInfo, params.model, metadata);
    await enforceCostControls(enforcementScope);

    const startTime = Date.now();
    const requestId = randomUUID();
    const messages = toInputMessages(params.input);

    try {
      const { result: decision, meteredElsewhere } = await runProviderCall(
        MIDDLEWARE_SOURCE,
        metadata,
        () => decisionsAPI.create(params),
      );

      if (meteredElsewhere) return decision;

      trackUsageAsync({
        requestId,
        model: decision.model || params.model,
        ...extractResponsesUsage(decision),
        cacheCreationTokens: decision.usage?.input_tokens_details?.cache_write_tokens,
        duration: Date.now() - startTime,
        finishReason: "stop",
        usageMetadata: metadata,
        isStreamed: false,
        providerInfo: this.providerInfo,
        messages,
        enforcementScope,
      });

      return decision;
    } catch (error) {
      if (isCostLimitRefusal(error)) throw error;

      trackFailedCall({
        requestId,
        model: params.model,
        startTime,
        usageMetadata: metadata,
        isStreamed: false,
        providerInfo: this.providerInfo,
        messages,
        enforcementScope,
      });
      throw error;
    }
  }
}

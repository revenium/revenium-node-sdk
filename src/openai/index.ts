import "./openai-augmentation.js";

export type { ReveniumConfig, UsageMetadata, Logger, Config } from "../_core/types/index.js";

export {
  Initialize,
  GetClient,
  IsInitialized,
  Reset,
  Configure,
  ReveniumOpenAI,
} from "./client.js";

export type { OpenAIConfig } from "./client.js";

export {
  ChatInterface,
  CompletionsInterface,
  EmbeddingsInterface,
  ResponsesInterface,
  ImagesInterface,
  AudioTranscriptionsInterface,
  AudioTranslationsInterface,
  AudioSpeechInterface,
  trackUsageAsync,
  trackEmbeddingsUsageAsync,
  trackImageUsageAsync,
  trackAudioUsageAsync,
} from "./middleware.js";

export { StreamingWrapper } from "./streaming.js";

export {
  Provider,
  detectProviderFromConfig,
  hasAzureConfig,
  validateAzureConfig,
  getProviderMetadata,
} from "./provider-detection.js";

export type { ProviderInfo } from "./provider-detection.js";

export type { AzureConfig } from "./azure-config.js";

export type {
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "../_core/types/tool-metering.js";

export {
  meterTool,
  reportToolCall,
  setToolContext,
  getToolContext,
  clearToolContext,
  runWithToolContext,
} from "../_core/tool-metering/index.js";

export { CostLimitExceeded } from "../_core/resilience/error-handler.js";

export type { EnforcementRule } from "../_core/enforcement/cache.js";
export type { EnforcementFilter } from "../_core/enforcement/filters.js";

export { flushMeteringBuffer, getBufferStats } from "../_core/metering/buffer.js";
export type { BufferStats } from "../_core/metering/buffer.js";

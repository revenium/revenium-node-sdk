export { GoogleGenAIController } from "./controller.js";
export { GoogleGenAIService } from "./service.js";
export { initialize, configure, isInitialized } from "../config.js";

export type {
  GoogleUsageMetadata,
  IGoogleResponse,
  IGoogleResponseChat,
  IGoogleStreamingResponse,
  IGoogleEmbeddingResponse,
  IGoogleImageResponse,
  IGoogleVideoResponse,
  IImageGenerationRequest,
  IImageEditRequest,
  IImageUpscaleRequest,
  IVideoGenerationRequest,
  IVideoExtendRequest,
  IVideoUpscaleRequest,
  GoogleOperationType,
} from "../types.js";

export {
  mapGoogleFinishReason,
  extractFinishReason,
  extractConfidenceScore,
  generateTransactionId,
  trackGoogleUsageAsync,
} from "../utils.js";

export type { ReveniumConfig, UsageMetadata, Logger, Config } from "../../_core/types/index.js";

export type {
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "../../_core/types/tool-metering.js";

export {
  meterTool,
  reportToolCall,
  setToolContext,
  getToolContext,
  clearToolContext,
  runWithToolContext,
} from "../../_core/tool-metering/index.js";

export { flushMeteringBuffer, getBufferStats } from "../../_core/metering/buffer.js";
export type { BufferStats } from "../../_core/metering/buffer.js";

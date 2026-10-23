import { UsageMetadata } from "../_core/types/index.js";

export interface GoogleUsageMetadata extends UsageMetadata {
  subscriberEmail?: string;
  subscriberId?: string;
  subscriberCredentialName?: string;
  subscriberCredential?: string;
  modelSource?: string;
}

export interface IGoogleResponse {
  text: string;
  modelVersion: string;
  responseId: string;
  usageMetadata: {
    totalTokenCount: number;
    promptTokenCount: number;
    candidatesTokenCount: number;
    promptTokensDetails: any[];
    thoughtsTokenCount: number;
  };
}

export interface IGoogleResponseChat {
  histories: string[];
  responses: IGoogleResponse[];
}

export interface IGoogleStreamingResponse {
  stream: AsyncIterable<any>;
  length: number;
  isStreaming: boolean;
}

export interface GoogleEmbeddingUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
}

export interface GoogleEmbeddingStatistics {
  tokenCount?: number;
}

export interface GoogleEmbeddingResponseFields {
  modelVersion?: string;
  usageMetadata?: GoogleEmbeddingUsageMetadata;
  embeddings?: Array<{ values?: number[]; statistics?: GoogleEmbeddingStatistics }>;
}

export interface IGoogleEmbeddingResponse {
  embedding:
    | number[]
    | {
        embedding: number[];
        modelVersion: string;
        usageMetadata: GoogleEmbeddingUsageMetadata;
      };
}

export interface IImageGenerationRequest {
  model: string;
  prompt: string;
  numberOfImages?: number;
  aspectRatio?: string;
  negativePrompt?: string;
  safetySettings?: any;
  personGeneration?: string;
  addWatermark?: boolean;
  outputOptions?: { mimeType?: string; compressionQuality?: number };
}

export interface IImageEditRequest {
  model: string;
  prompt: string;
  referenceImage: string;
  numberOfImages?: number;
  editMode?: string;
  maskMode?: string;
  mask?: string;
  segmentationClasses?: string[];
  negativePrompt?: string;
  safetySettings?: any;
  personGeneration?: string;
  addWatermark?: boolean;
  outputOptions?: { mimeType?: string; compressionQuality?: number };
}

export interface IImageUpscaleRequest {
  model: string;
  image: string;
  upscaleFactor?: string;
  outputOptions?: { mimeType?: string; compressionQuality?: number };
}

export interface IImageResponse {
  images: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
    gcsUri?: string;
  }>;
  modelVersion?: string;
  raiFilteredReason?: string;
}

export interface IGoogleImageResponse {
  response: IImageResponse;
  transactionId: string;
  model: string;
  operationSubtype: string;
  metadata?: {
    numberOfImages?: number;
    aspectRatio?: string;
    resolution?: string;
    quality?: string;
    serviceTier?: string;
    region?: string;
    asyncJobId?: string;
    batchJobId?: string;
  };
}

export interface IVideoGenerationRequest {
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  frameRate?: number;
  quality?: string;
  negativePrompt?: string;
  referenceImage?: string;
  timeout?: number;
}

export interface IVideoExtendRequest {
  model: string;
  prompt: string;
  referenceVideo: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  frameRate?: number;
  quality?: string;
  timeout?: number;
}

export interface IVideoUpscaleRequest {
  model: string;
  referenceVideo: string;
  resolution?: string;
  timeout?: number;
}

export interface IVideoResponse {
  videos: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
    gcsUri?: string;
  }>;
  modelVersion?: string;
  raiFilteredReason?: string;
  operationId?: string;
}

export interface IGoogleVideoResponse {
  response: IVideoResponse;
  transactionId: string;
  model: string;
  operationSubtype: string;
  metadata?: {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    frameRate?: number;
    quality?: string;
    serviceTier?: string;
    region?: string;
    asyncJobId?: string;
  };
}

export enum GoogleOperationType {
  CHAT = "CHAT",
  EMBED = "EMBED",
  IMAGE = "IMAGE",
  VIDEO = "VIDEO",
}

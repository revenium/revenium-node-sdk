import { loadEnvFiles } from "../../_core/config/loader.js";
import { getLogger } from "../../_core/config/manager.js";
import {
  GoogleUsageMetadata,
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
} from "../types.js";
import { VertexAIService } from "./service.js";

function verifyVertexAIEnvironment(): void {
  loadEnvFiles();
  const logger = getLogger();

  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    throw new Error("GOOGLE_CLOUD_PROJECT environment variable is required for Vertex AI.");
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS environment variable is required for Vertex AI.",
    );
  }

  if (!process.env.GOOGLE_CLOUD_LOCATION) {
    logger.warn("GOOGLE_CLOUD_LOCATION not set, defaulting to us-central1");
  }
}

export class VertexAIController {
  private validateModel(model: string): void {
    if (!model || model.trim() === "") {
      throw new Error("Model parameter is required.");
    }
  }

  public createChat = async (
    prompts: string[],
    model: string,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleResponseChat> => {
    verifyVertexAIEnvironment();
    this.validateModel(model);
    const service = new VertexAIService(model, projectId, location);
    return service.createChat(prompts, usageMetadata);
  };

  public createStreaming = async (
    prompts: string[],
    model: string,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleStreamingResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(model);
    const service = new VertexAIService(model, projectId, location);
    return service.createStreaming(prompts, usageMetadata);
  };

  public createEmbedding = async (
    input: string,
    model: string,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleEmbeddingResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(model);
    const service = new VertexAIService(model, projectId, location);
    return service.createEmbedding(input, usageMetadata);
  };

  public generateImage = async (
    request: IImageGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleImageResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(request.model);
    const service = new VertexAIService(request.model, projectId, location);
    return service.generateImage(request, usageMetadata);
  };

  public editImage = async (
    request: IImageEditRequest,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleImageResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(request.model);
    const service = new VertexAIService(request.model, projectId, location);
    return service.editImage(request, usageMetadata);
  };

  public upscaleImage = async (
    request: IImageUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleImageResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(request.model);
    const service = new VertexAIService(request.model, projectId, location);
    return service.upscaleImage(request, usageMetadata);
  };

  public generateVideo = async (
    request: IVideoGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleVideoResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(request.model);
    const service = new VertexAIService(request.model, projectId, location);
    return service.generateVideo(request, usageMetadata);
  };

  public extendVideo = async (
    request: IVideoExtendRequest,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleVideoResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(request.model);
    const service = new VertexAIService(request.model, projectId, location);
    return service.extendVideo(request, usageMetadata);
  };

  public upscaleVideo = async (
    request: IVideoUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
    projectId?: string,
    location?: string,
  ): Promise<IGoogleVideoResponse> => {
    verifyVertexAIEnvironment();
    this.validateModel(request.model);
    const service = new VertexAIService(request.model, projectId, location);
    return service.upscaleVideo(request, usageMetadata);
  };
}

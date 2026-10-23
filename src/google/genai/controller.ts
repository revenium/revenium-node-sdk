import { loadEnvFiles } from "../../_core/config/loader.js";
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
import { GoogleGenAIService } from "./service.js";

function verifyGoogleGenAIEnvironment(): void {
  loadEnvFiles();

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error(
      "GOOGLE_API_KEY environment variable is required for Google AI. " +
        "Get your API key from https://aistudio.google.com/apikey",
    );
  }
}

export class GoogleGenAIController {
  private validateModel(model: string): void {
    if (!model || model.trim() === "") {
      throw new Error(
        "Model parameter is required. Please specify a model (e.g., 'gemini-2.0-flash-001').",
      );
    }
  }

  public createChat = async (
    prompts: string[],
    model: string,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleResponseChat> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(model);
    const service = new GoogleGenAIService(model);
    return service.createChat(prompts, usageMetadata);
  };

  public createStreaming = async (
    prompts: string[],
    model: string,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleStreamingResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(model);
    const service = new GoogleGenAIService(model);
    return service.createStreaming(prompts, usageMetadata);
  };

  public createEmbedding = async (
    prompt: string,
    model: string,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleEmbeddingResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(model);
    const service = new GoogleGenAIService(model);
    return service.createEmbedding(prompt, usageMetadata);
  };

  public generateImage = async (
    request: IImageGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(request.model);
    const service = new GoogleGenAIService(request.model);
    return service.generateImage(request, usageMetadata);
  };

  public editImage = async (
    request: IImageEditRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(request.model);
    const service = new GoogleGenAIService(request.model);
    return service.editImage(request, usageMetadata);
  };

  public upscaleImage = async (
    request: IImageUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(request.model);
    const service = new GoogleGenAIService(request.model);
    return service.upscaleImage(request, usageMetadata);
  };

  public generateVideo = async (
    request: IVideoGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(request.model);
    const service = new GoogleGenAIService(request.model);
    return service.generateVideo(request, usageMetadata);
  };

  public extendVideo = async (
    request: IVideoExtendRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(request.model);
    const service = new GoogleGenAIService(request.model);
    return service.extendVideo(request, usageMetadata);
  };

  public upscaleVideo = async (
    request: IVideoUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    verifyGoogleGenAIEnvironment();
    this.validateModel(request.model);
    const service = new GoogleGenAIService(request.model);
    return service.upscaleVideo(request, usageMetadata);
  };
}

import { GoogleGenAI, Chat } from "@google/genai";
import { getConfig } from "../../_core/config/manager.js";
import { runWithCallConfig } from "../../_core/config/call-config.js";
import { ensureGoogleConfig } from "../config.js";
import {
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
} from "../types.js";
import { buildGoogleEmbeddingResponse } from "../utils.js";

export class GoogleGenAIService {
  private client: GoogleGenAI;
  private model: string = "gemini-2.0-flash-001";

  constructor(model: string) {
    this.model = model ?? this.model;
    ensureGoogleConfig();
    this.client = new GoogleGenAI({
      apiKey: process.env.GOOGLE_API_KEY ?? "",
    });
  }

  private buildResponseObject(response: any): IGoogleResponse {
    return {
      text: response.text ?? "",
      modelVersion: response.modelVersion ?? "",
      responseId: response.responseId ?? "",
      usageMetadata: {
        totalTokenCount: response.usageMetadata?.totalTokenCount ?? 0,
        promptTokenCount: response.usageMetadata?.promptTokenCount ?? 0,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? 0,
        promptTokensDetails: response.usageMetadata?.promptTokensDetails ?? [],
        thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount ?? 0,
      },
    };
  }

  private extractHistories(chat: Chat): string[] {
    const histories: string[] = [];
    const history = chat.getHistory();
    for (const item of history) {
      histories.push(item?.parts?.[0]?.text ?? "");
    }
    return histories;
  }

  public createChat = async (
    prompts: string[],
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleResponseChat> =>
    runWithCallConfig(getConfig(), async () => {
      const chat = this.client.chats.create({ model: this.model, usageMetadata });
      const responses: IGoogleResponse[] = [];

      for (const prompt of prompts) {
        responses.push(this.buildResponseObject(await chat.sendMessage({ message: prompt })));
      }

      return { histories: this.extractHistories(chat), responses };
    });

  public createStreaming = async (
    prompts: string[],
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleStreamingResponse> =>
    runWithCallConfig(getConfig(), async () => ({
      stream: await this.client.models.generateContentStream({
        model: this.model,
        contents: prompts.join("\n"),
        usageMetadata,
      }),
      length: prompts.length,
      isStreaming: true,
    }));

  public createEmbedding = async (
    prompt: string,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleEmbeddingResponse> =>
    runWithCallConfig(getConfig(), async () =>
      buildGoogleEmbeddingResponse(
        await this.client.models.embedContent({
          model: this.model,
          contents: prompt,
          usageMetadata,
        }),
      ),
    );

  public generateImage = async (
    _request: IImageGenerationRequest,
    _usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    throw new Error(
      "Imagen (image generation) is only available through Vertex AI, not Google AI Studio. " +
        "Please use the google/vertex subpath instead.",
    );
  };

  public editImage = async (
    _request: IImageEditRequest,
    _usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    throw new Error(
      "Imagen (image editing) is only available through Vertex AI, not Google AI Studio. " +
        "Please use the google/vertex subpath instead.",
    );
  };

  public upscaleImage = async (
    _request: IImageUpscaleRequest,
    _usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    throw new Error(
      "Imagen (image upscaling) is only available through Vertex AI, not Google AI Studio. " +
        "Please use the google/vertex subpath instead.",
    );
  };

  public generateVideo = async (
    _request: IVideoGenerationRequest,
    _usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    throw new Error(
      "Veo (video generation) is only available through Vertex AI, not Google AI Studio. " +
        "Please use the google/vertex subpath instead.",
    );
  };

  public extendVideo = async (
    _request: IVideoExtendRequest,
    _usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    throw new Error(
      "Veo (video extension) is only available through Vertex AI, not Google AI Studio. " +
        "Please use the google/vertex subpath instead.",
    );
  };

  public upscaleVideo = async (
    _request: IVideoUpscaleRequest,
    _usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    throw new Error(
      "Veo (video upscaling) is only available through Vertex AI, not Google AI Studio. " +
        "Please use the google/vertex subpath instead.",
    );
  };
}

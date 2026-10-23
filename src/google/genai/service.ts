import { GoogleGenAI, Chat } from "@google/genai";
import { getConfig, getLogger } from "../../_core/config/manager.js";
import { resolveConfig, runWithCallConfig } from "../../_core/config/call-config.js";
import { getErrorMessage } from "../../_core/resilience/error-handler.js";
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
import {
  trackGoogleUsageAsync,
  generateTransactionId,
  mergeStreamedGoogleResponse,
  countGoogleEmbeddingTokens,
  buildGoogleEmbeddingResponse,
} from "../utils.js";

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
      const logger = getLogger();
      const chat = this.client.chats.create({ model: this.model });
      const result: IGoogleResponse[] = [];

      for (const prompt of prompts) {
        const startTime = new Date();
        const transactionId = generateTransactionId();

        const meterChat = (response: any, error?: unknown): void => {
          void trackGoogleUsageAsync({
            transactionId,
            model: this.model,
            startTime,
            endTime: new Date(),
            response,
            operationType: "CHAT",
            isStreaming: false,
            modelSource: "GOOGLE",
            usageMetadata,
            prompts: [prompt],
            error,
          }).catch((e) => logger.warn("Metering send failed", { error: getErrorMessage(e) }));
        };

        let response;
        try {
          response = await chat.sendMessage({ message: prompt });
        } catch (error) {
          meterChat(null, error);
          throw error;
        }

        meterChat(response);
        result.push(this.buildResponseObject(response));
      }

      const histories = this.extractHistories(chat);
      return { histories, responses: result };
    });

  public createStreaming = async (
    prompts: string[],
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleStreamingResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const logger = getLogger();
      const startTime = new Date();
      const transactionId = generateTransactionId();

      const model = this.model;

      const callConfig = resolveConfig();

      const meterStream = (
        response: any,
        timeToFirstToken: number | undefined,
        error?: unknown,
      ): void => {
        void runWithCallConfig(callConfig, () =>
          trackGoogleUsageAsync({
            transactionId,
            model,
            startTime,
            endTime: new Date(),
            response,
            operationType: "CHAT",
            isStreaming: true,
            modelSource: "GOOGLE",
            usageMetadata,
            prompts,
            timeToFirstToken,
            error,
          }),
        ).catch((e) => logger.warn("Streaming metering failed", { error: getErrorMessage(e) }));
      };

      let originalStream;
      try {
        originalStream = await this.client.models.generateContentStream({
          model: this.model,
          contents: prompts.join("\n"),
        });
      } catch (error) {
        meterStream(null, undefined, error);
        throw error;
      }

      let metered = false;

      const wrappedStream: AsyncIterable<any> = {
        [Symbol.asyncIterator]: async function* () {
          let firstTokenTime: Date | undefined;
          let lastResponse: any = null;

          const meterOnce = (error?: unknown) => {
            if (metered) return;
            metered = true;
            meterStream(
              lastResponse,
              firstTokenTime ? firstTokenTime.getTime() - startTime.getTime() : undefined,
              error,
            );
          };

          try {
            for await (const chunk of originalStream) {
              if (!firstTokenTime) {
                firstTokenTime = new Date();
              }
              lastResponse = mergeStreamedGoogleResponse(lastResponse, chunk);
              yield chunk;
            }
          } catch (error) {
            meterOnce(error);
            throw error;
          } finally {
            meterOnce();
          }
        },
      };

      return {
        stream: wrappedStream,
        length: prompts.length,
        isStreaming: true,
      };
    });

  public createEmbedding = async (
    prompt: string,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleEmbeddingResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const logger = getLogger();
      const startTime = new Date();
      const transactionId = generateTransactionId();

      const meterEmbedding = (response: any, error?: unknown): void => {
        void trackGoogleUsageAsync({
          transactionId,
          model: this.model,
          startTime,
          endTime: new Date(),
          response,
          operationType: "EMBED",
          isStreaming: false,
          modelSource: "GOOGLE",
          usageMetadata,
          prompts: [prompt],
          resolveInputTokens: () =>
            countGoogleEmbeddingTokens(() =>
              this.client.models.countTokens({ model: this.model, contents: prompt }),
            ),
          error,
        }).catch((e) => logger.warn("Embedding metering failed", { error: getErrorMessage(e) }));
      };

      let response;
      try {
        response = await this.client.models.embedContent({
          model: this.model,
          contents: prompt,
        });
      } catch (error) {
        meterEmbedding(null, error);
        throw error;
      }

      meterEmbedding(response);

      return buildGoogleEmbeddingResponse(response);
    });

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

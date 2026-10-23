import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { getConfig, getLogger } from "../../_core/config/manager.js";
import { resolveConfig, runWithCallConfig } from "../../_core/config/call-config.js";
import { getErrorMessage } from "../../_core/resilience/error-handler.js";
import { sendToRevenium } from "../../_core/metering/api-client.js";
import {
  buildImagePayload,
  buildVideoPayload,
  VideoPayloadExtra,
} from "../../_core/metering/payload-builder.js";
import {
  ImageOperationSubtype,
  VideoOperationSubtype,
} from "../../_core/metering/operation-subtype.js";
import { ReveniumPayload, UsageMetadata } from "../../_core/types/index.js";
import { printUsageSummary } from "../../_core/prompt/summary-printer.js";
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
  mapGoogleUsageMetadata,
  mapAspectRatioToResolution,
  mergeStreamedGoogleResponse,
  countGoogleEmbeddingTokens,
  buildGoogleEmbeddingResponse,
  withGoogleErrorReason,
} from "../utils.js";

const MIDDLEWARE_SOURCE = "revenium-google-node";

const RETRYABLE_POLL_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

type VideoOperationOutcome =
  | { ok: true; operationName?: string; samples: any[] }
  | { ok: false; operationName?: string; error: unknown };

function extractVideoSamples(result: any): any[] {
  return result.videos ?? result.generatedSamples ?? result.predictions ?? [];
}

function describeVideoOperationFailure(
  pollData: any,
  result: any,
  samples: any[],
): string | undefined {
  const operationError = pollData.error ?? result.error;
  if (operationError) {
    return typeof operationError.message === "string" && operationError.message.length > 0
      ? operationError.message
      : JSON.stringify(operationError);
  }

  if (samples.length) return undefined;

  const filteredReasons = result.raiMediaFilteredReasons;
  if (filteredReasons?.length) {
    return `Video request blocked by responsible AI filters: ${filteredReasons.join("; ")}`;
  }
  return "Video operation completed without returning a video";
}

function toVideoFiles(samples: any[]): { bytesBase64Encoded: any; mimeType: any }[] {
  return samples.map((sample: any) => ({
    bytesBase64Encoded: sample.bytesBase64Encoded ?? sample.video?.bytesBase64Encoded,
    mimeType: sample.mimeType ?? sample.video?.mimeType ?? "video/mp4",
  }));
}

export class VertexAIService {
  private client: GoogleGenAI;
  private model: string = "gemini-2.0-flash-001";
  private projectId: string;
  private location: string;
  private auth: GoogleAuth;

  constructor(model: string, projectId?: string, location?: string) {
    ensureGoogleConfig();
    this.model = model ?? this.model;
    this.projectId = projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
    this.location = location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

    this.client = new GoogleGenAI({
      vertexai: true,
      project: this.projectId,
      location: this.location,
      googleAuthOptions: {
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      },
    } as any);

    this.auth = new GoogleAuth({
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }

  private async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const accessToken = await client.getAccessToken();
    if (!accessToken.token) {
      throw new Error("Failed to obtain access token from Google Auth");
    }
    return accessToken.token;
  }

  private dispatch(payload: ReveniumPayload, label: string): void {
    const logger = getLogger();
    void (async () => {
      try {
        await sendToRevenium(payload);
      } finally {
        printUsageSummary(payload);
      }
    })().catch((error) =>
      logger.warn(`${label} metering failed`, { error: getErrorMessage(error) }),
    );
  }

  private resolveUsageMetadata(
    usageMetadata: GoogleUsageMetadata | undefined,
    error: unknown,
  ): UsageMetadata | undefined {
    const mapped = mapGoogleUsageMetadata(usageMetadata);
    return error === undefined ? mapped : withGoogleErrorReason(mapped, error);
  }

  private meterImage(
    subtype: ImageOperationSubtype,
    request: any,
    startTime: number,
    predictions: any[],
    usageMetadata: GoogleUsageMetadata | undefined,
    error?: unknown,
  ): void {
    this.dispatch(
      buildImagePayload(
        subtype,
        { data: predictions },
        request,
        startTime,
        Date.now() - startTime,
        "Google",
        "GOOGLE_VERTEX_AI",
        MIDDLEWARE_SOURCE,
        this.resolveUsageMetadata(usageMetadata, error),
        { failed: error !== undefined },
      ),
      `Image ${subtype}`,
    );
  }

  private meterVideo(
    subtype: VideoOperationSubtype,
    model: string,
    startTime: number,
    extra: Omit<VideoPayloadExtra, "failed">,
    usageMetadata: GoogleUsageMetadata | undefined,
    error?: unknown,
  ): void {
    this.dispatch(
      buildVideoPayload(
        subtype,
        { model },
        startTime,
        Date.now() - startTime,
        "Google",
        "GOOGLE_VERTEX_AI",
        MIDDLEWARE_SOURCE,
        this.resolveUsageMetadata(usageMetadata, error),
        { ...extra, failed: error !== undefined },
      ),
      `Video ${subtype}`,
    );
  }

  private async awaitVideoOperation(params: {
    apiUrl: string;
    requestBody: unknown;
    timeout: number;
    initErrorLabel: string;
    operationLabel: string;
  }): Promise<VideoOperationOutcome> {
    let operationName: string | undefined;

    try {
      const token = await this.getAccessToken();
      const initResponse = await fetch(params.apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(params.requestBody),
      });

      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        throw new Error(`${params.initErrorLabel}: ${initResponse.status} - ${errorText}`);
      }

      const initData: any = await initResponse.json();
      operationName = initData.name;
      if (!operationName) throw new Error("No operation name returned from Video API");

      const pollUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}`;
      const pollStartTime = Date.now();
      let pollDelay = 2000;

      while (Date.now() - pollStartTime < params.timeout) {
        await new Promise((resolve) => setTimeout(resolve, pollDelay));
        pollDelay = Math.min(pollDelay * 1.5, 30000);

        const pollResponse = await fetch(pollUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!pollResponse.ok) {
          if (RETRYABLE_POLL_STATUSES.has(pollResponse.status)) continue;
          const errorText = await pollResponse.text();
          throw new Error(
            `${params.operationLabel} poll failed: ${pollResponse.status} - ${errorText}`,
          );
        }

        const pollData: any = await pollResponse.json();
        if (!pollData.done) continue;

        const result = pollData.response ?? pollData;
        const samples = extractVideoSamples(result);
        const failure = describeVideoOperationFailure(pollData, result, samples);
        if (failure) throw new Error(failure);

        return { ok: true, operationName, samples };
      }

      throw new Error(`${params.operationLabel} timed out after ${params.timeout}ms`);
    } catch (error) {
      return { ok: false, operationName, error };
    }
  }

  private buildResponseObject(response: any): IGoogleResponse {
    return {
      responseId: generateTransactionId(),
      text: response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      modelVersion: this.model,
      usageMetadata: {
        promptTokenCount: response.usageMetadata?.promptTokenCount ?? 0,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokenCount: response.usageMetadata?.totalTokenCount ?? 0,
        promptTokensDetails: [],
        thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount ?? 0,
      },
    };
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
            modelSource: "GOOGLE_VERTEX_AI",
            usageMetadata,
            prompts: [prompt],
            error,
          }).catch((e) => logger.warn("Vertex metering failed", { error: getErrorMessage(e) }));
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

      const histories: string[] = [];
      const history = chat.getHistory();
      for (const item of history) {
        histories.push(item?.parts?.[0]?.text ?? "");
      }

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
            modelSource: "GOOGLE_VERTEX_AI",
            usageMetadata,
            prompts,
            timeToFirstToken,
            error,
          }),
        ).catch((e) =>
          logger.warn("Vertex streaming metering failed", { error: getErrorMessage(e) }),
        );
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
              if (!firstTokenTime) firstTokenTime = new Date();
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
    input: string,
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
          modelSource: "GOOGLE_VERTEX_AI",
          usageMetadata,
          prompts: [input],
          resolveInputTokens: () =>
            countGoogleEmbeddingTokens(() =>
              this.client.models.countTokens({ model: this.model, contents: input }),
            ),
          error,
        }).catch((e) =>
          logger.warn("Vertex embedding metering failed", { error: getErrorMessage(e) }),
        );
      };

      let response;
      try {
        response = await this.client.models.embedContent({
          model: this.model,
          contents: input,
        });
      } catch (error) {
        meterEmbedding(null, error);
        throw error;
      }

      meterEmbedding(response);

      return buildGoogleEmbeddingResponse(response);
    });

  public generateImage = async (
    request: IImageGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const startTime = Date.now();
      const transactionId = generateTransactionId();

      const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predict`;

      const requestBody = {
        instances: [{ prompt: request.prompt }],
        parameters: {
          sampleCount: request.numberOfImages || 1,
          aspectRatio: request.aspectRatio,
          negativePrompt: request.negativePrompt,
          personGeneration: request.personGeneration,
          addWatermark: request.addWatermark,
          outputOptions: request.outputOptions,
          safetyFilterLevel: request.safetySettings,
        },
      };

      const imageRequest = {
        n: request.numberOfImages || 1,
        model: request.model,
        size: mapAspectRatioToResolution(request.aspectRatio),
        quality: "standard",
      };

      let data: any;
      try {
        const token = await this.getAccessToken();
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Vertex AI Image API error: ${response.status} - ${errorText}`);
        }

        data = await response.json();
      } catch (error) {
        this.meterImage("generation", imageRequest, startTime, [], usageMetadata, error);
        throw error;
      }

      this.meterImage("generation", imageRequest, startTime, data.predictions || [], usageMetadata);

      const images = (data.predictions || []).map((p: any) => ({
        bytesBase64Encoded: p.bytesBase64Encoded,
        mimeType: p.mimeType || "image/png",
      }));

      return {
        response: { images, modelVersion: request.model },
        transactionId,
        model: request.model,
        operationSubtype: "generation",
        metadata: {
          numberOfImages: request.numberOfImages || 1,
          aspectRatio: request.aspectRatio,
          region: this.location,
        },
      };
    });

  public editImage = async (
    request: IImageEditRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const startTime = Date.now();
      const transactionId = generateTransactionId();

      const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predict`;

      const instance: any = {
        prompt: request.prompt,
        image: { bytesBase64Encoded: request.referenceImage },
      };
      if (request.mask) instance.mask = { image: { bytesBase64Encoded: request.mask } };

      const requestBody = {
        instances: [instance],
        parameters: {
          sampleCount: request.numberOfImages || 1,
          editMode: request.editMode,
          negativePrompt: request.negativePrompt,
        },
      };

      const imageRequest = {
        n: request.numberOfImages || 1,
        model: request.model,
        quality: "standard",
      };

      let data: any;
      try {
        const token = await this.getAccessToken();
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Vertex AI Image Edit API error: ${response.status} - ${errorText}`);
        }

        data = await response.json();
      } catch (error) {
        this.meterImage("edit", imageRequest, startTime, [], usageMetadata, error);
        throw error;
      }

      this.meterImage("edit", imageRequest, startTime, data.predictions || [], usageMetadata);

      const images = (data.predictions || []).map((p: any) => ({
        bytesBase64Encoded: p.bytesBase64Encoded,
        mimeType: p.mimeType || "image/png",
      }));

      return {
        response: { images, modelVersion: request.model },
        transactionId,
        model: request.model,
        operationSubtype: "edit",
        metadata: { numberOfImages: request.numberOfImages || 1, region: this.location },
      };
    });

  public upscaleImage = async (
    request: IImageUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const startTime = Date.now();
      const transactionId = generateTransactionId();

      const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predict`;

      const requestBody = {
        instances: [{ image: { bytesBase64Encoded: request.image } }],
        parameters: {
          upscaleConfig: { upscaleFactor: request.upscaleFactor || "x2" },
          outputOptions: request.outputOptions,
        },
      };

      const imageRequest = { n: 1, model: request.model, quality: "standard" };

      let data: any;
      try {
        const token = await this.getAccessToken();
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Vertex AI Image Upscale API error: ${response.status} - ${errorText}`);
        }

        data = await response.json();
      } catch (error) {
        this.meterImage("upscale", imageRequest, startTime, [], usageMetadata, error);
        throw error;
      }

      this.meterImage("upscale", imageRequest, startTime, data.predictions || [], usageMetadata);

      const images = (data.predictions || []).map((p: any) => ({
        bytesBase64Encoded: p.bytesBase64Encoded,
        mimeType: p.mimeType || "image/png",
      }));

      return {
        response: { images, modelVersion: request.model },
        transactionId,
        model: request.model,
        operationSubtype: "upscale",
        metadata: { region: this.location },
      };
    });

  public generateVideo = async (
    request: IVideoGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const startTime = Date.now();
      const transactionId = generateTransactionId();
      const timeout = Math.min(request.timeout || 300000, 3600000);

      const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predictLongRunning`;

      const instance: any = { prompt: request.prompt };
      if (request.referenceImage) instance.image = { bytesBase64Encoded: request.referenceImage };

      const requestBody = {
        instances: [instance],
        parameters: {
          aspectRatio: request.aspectRatio,
          durationSeconds: request.duration,
          resolution: request.resolution,
        },
      };

      const operation = await this.awaitVideoOperation({
        apiUrl,
        requestBody,
        timeout,
        initErrorLabel: "Vertex AI Video API error",
        operationLabel: "Video generation",
      });

      const videoExtra = {
        videoDurationSeconds: request.duration,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        quality: request.quality,
        frameRate: request.frameRate,
        region: this.location,
        asyncJobId: operation.operationName,
      };

      if (!operation.ok) {
        this.meterVideo(
          "generation",
          request.model,
          startTime,
          videoExtra,
          usageMetadata,
          operation.error,
        );
        throw operation.error;
      }

      this.meterVideo("generation", request.model, startTime, videoExtra, usageMetadata);

      const videos = toVideoFiles(operation.samples);

      return {
        response: { videos, modelVersion: request.model, operationId: operation.operationName },
        transactionId,
        model: request.model,
        operationSubtype: "generation",
        metadata: {
          duration: request.duration,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          frameRate: request.frameRate,
          quality: request.quality,
          region: this.location,
          asyncJobId: operation.operationName,
        },
      };
    });

  public extendVideo = async (
    request: IVideoExtendRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const startTime = Date.now();
      const transactionId = generateTransactionId();
      const timeout = Math.min(request.timeout || 300000, 3600000);

      const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predictLongRunning`;

      const requestBody = {
        instances: [
          {
            prompt: request.prompt,
            video: { bytesBase64Encoded: request.referenceVideo },
          },
        ],
        parameters: {
          aspectRatio: request.aspectRatio,
          durationSeconds: request.duration,
          resolution: request.resolution,
        },
      };

      const operation = await this.awaitVideoOperation({
        apiUrl,
        requestBody,
        timeout,
        initErrorLabel: "Vertex AI Video Extend API error",
        operationLabel: "Video extension",
      });

      const videoExtra = {
        videoDurationSeconds: request.duration,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        quality: request.quality,
        frameRate: request.frameRate,
        region: this.location,
        asyncJobId: operation.operationName,
      };

      if (!operation.ok) {
        this.meterVideo(
          "extend",
          request.model,
          startTime,
          videoExtra,
          usageMetadata,
          operation.error,
        );
        throw operation.error;
      }

      this.meterVideo("extend", request.model, startTime, videoExtra, usageMetadata);

      const videos = toVideoFiles(operation.samples);

      return {
        response: { videos, modelVersion: request.model, operationId: operation.operationName },
        transactionId,
        model: request.model,
        operationSubtype: "extend",
        metadata: {
          duration: request.duration,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          frameRate: request.frameRate,
          quality: request.quality,
          region: this.location,
          asyncJobId: operation.operationName,
        },
      };
    });

  public upscaleVideo = async (
    request: IVideoUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> =>
    runWithCallConfig(getConfig(), async () => {
      const startTime = Date.now();
      const transactionId = generateTransactionId();
      const timeout = Math.min(request.timeout || 300000, 3600000);

      const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predictLongRunning`;

      const requestBody = {
        instances: [{ video: { bytesBase64Encoded: request.referenceVideo } }],
        parameters: { resolution: request.resolution },
      };

      const operation = await this.awaitVideoOperation({
        apiUrl,
        requestBody,
        timeout,
        initErrorLabel: "Vertex AI Video Upscale API error",
        operationLabel: "Video upscale",
      });

      const videoExtra = {
        resolution: request.resolution,
        region: this.location,
        asyncJobId: operation.operationName,
      };

      if (!operation.ok) {
        this.meterVideo(
          "upscale",
          request.model,
          startTime,
          videoExtra,
          usageMetadata,
          operation.error,
        );
        throw operation.error;
      }

      this.meterVideo("upscale", request.model, startTime, videoExtra, usageMetadata);

      const videos = toVideoFiles(operation.samples);

      return {
        response: { videos, modelVersion: request.model, operationId: operation.operationName },
        transactionId,
        model: request.model,
        operationSubtype: "upscale",
        metadata: {
          resolution: request.resolution,
          region: this.location,
          asyncJobId: operation.operationName,
        },
      };
    });
}

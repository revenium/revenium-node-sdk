import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { getLogger } from "../../_core/config/manager.js";
import { sendToRevenium } from "../../_core/metering/api-client.js";
import { buildImagePayload, buildVideoPayload } from "../../_core/metering/payload-builder.js";
import { printUsageSummary } from "../../_core/prompt/summary-printer.js";
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
} from "../utils.js";

const MIDDLEWARE_SOURCE = "revenium-google-node";

export class VertexAIService {
  private client: GoogleGenAI;
  private model: string = "gemini-2.0-flash-001";
  private projectId: string;
  private location: string;
  private auth: GoogleAuth;

  constructor(model: string, projectId?: string, location?: string) {
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
  ): Promise<IGoogleResponseChat> => {
    const logger = getLogger();
    const chat = this.client.chats.create({ model: this.model });
    const result: IGoogleResponse[] = [];

    for (const prompt of prompts) {
      const startTime = new Date();
      const transactionId = generateTransactionId();

      try {
        const response = await chat.sendMessage({ message: prompt });
        const endTime = new Date();
        result.push(this.buildResponseObject(response));

        void trackGoogleUsageAsync({
          transactionId,
          model: this.model,
          startTime,
          endTime,
          response,
          operationType: "CHAT",
          isStreaming: false,
          modelSource: "GOOGLE_VERTEX_AI",
          usageMetadata,
          prompts: [prompt],
        }).catch((e) =>
          logger.warn("Vertex metering failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } catch (error) {
        const endTime = new Date();
        void trackGoogleUsageAsync({
          transactionId,
          model: this.model,
          startTime,
          endTime,
          response: { usageMetadata: {} },
          operationType: "CHAT",
          isStreaming: false,
          modelSource: "GOOGLE_VERTEX_AI",
          usageMetadata,
        }).catch(() => {});
        throw error;
      }
    }

    const histories: string[] = [];
    const history = chat.getHistory();
    for (const item of history) {
      histories.push(item?.parts?.[0]?.text ?? "");
    }

    return { histories, responses: result };
  };

  public createStreaming = async (
    prompts: string[],
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleStreamingResponse> => {
    const logger = getLogger();
    const startTime = new Date();
    const transactionId = generateTransactionId();
    const model = this.model;

    const originalStream = await this.client.models.generateContentStream({
      model: this.model,
      contents: prompts.join("\n"),
    });

    const wrappedStream: AsyncIterable<any> = {
      [Symbol.asyncIterator]: async function* () {
        let firstTokenTime: Date | undefined;
        let lastResponse: any = null;

        try {
          for await (const chunk of originalStream) {
            if (!firstTokenTime) firstTokenTime = new Date();
            lastResponse = chunk;
            yield chunk;
          }
        } finally {
          const timeToFirstToken = firstTokenTime
            ? firstTokenTime.getTime() - startTime.getTime()
            : undefined;

          void trackGoogleUsageAsync({
            transactionId,
            model,
            startTime,
            endTime: new Date(),
            response: lastResponse,
            operationType: "CHAT",
            isStreaming: true,
            modelSource: "GOOGLE_VERTEX_AI",
            usageMetadata,
            prompts,
            timeToFirstToken,
          }).catch((e) =>
            logger.warn("Vertex streaming metering failed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      },
    };

    return {
      stream: wrappedStream,
      length: prompts.length,
      isStreaming: true,
    };
  };

  public createEmbedding = async (
    input: string,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleEmbeddingResponse> => {
    const logger = getLogger();
    const startTime = new Date();
    const transactionId = generateTransactionId();

    const response = await this.client.models.embedContent({
      model: this.model,
      contents: input,
    });

    const endTime = new Date();

    void trackGoogleUsageAsync({
      transactionId,
      model: this.model,
      startTime,
      endTime,
      response,
      operationType: "EMBED",
      isStreaming: false,
      modelSource: "GOOGLE_VERTEX_AI",
      usageMetadata,
      prompts: [input],
    }).catch((e) =>
      logger.warn("Vertex embedding metering failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

    const extendedResponse = response as typeof response & {
      modelVersion?: string;
      usageMetadata?: { totalTokenCount?: number; promptTokenCount?: number };
    };
    return {
      embedding: {
        embedding: response.embeddings?.[0]?.values ?? [],
        modelVersion: extendedResponse.modelVersion ?? "",
        usageMetadata: {
          totalTokenCount: extendedResponse.usageMetadata?.totalTokenCount ?? 0,
          promptTokenCount: extendedResponse.usageMetadata?.promptTokenCount ?? 0,
        },
      },
    };
  };

  public generateImage = async (
    request: IImageGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    const logger = getLogger();
    const startTime = Date.now();
    const transactionId = generateTransactionId();
    const token = await this.getAccessToken();

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

    const data: any = await response.json();
    const duration = Date.now() - startTime;
    const usageMeta = mapGoogleUsageMetadata(usageMetadata);

    const imagePayload = buildImagePayload(
      "generation",
      { data: data.predictions || [] },
      {
        n: request.numberOfImages || 1,
        model: request.model,
        size: mapAspectRatioToResolution(request.aspectRatio),
        quality: "standard",
      },
      startTime,
      duration,
      "Google",
      "GOOGLE_VERTEX_AI",
      MIDDLEWARE_SOURCE,
      usageMeta,
    );

    void (async () => {
      try {
        await sendToRevenium(imagePayload);
      } finally {
        printUsageSummary(imagePayload);
      }
    })().catch((e) =>
      logger.warn("Image metering failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

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
  };

  public editImage = async (
    request: IImageEditRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    const logger = getLogger();
    const startTime = Date.now();
    const transactionId = generateTransactionId();
    const token = await this.getAccessToken();

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

    const data: any = await response.json();
    const duration = Date.now() - startTime;
    const usageMeta = mapGoogleUsageMetadata(usageMetadata);

    const imagePayload = buildImagePayload(
      "edit",
      { data: data.predictions || [] },
      {
        n: request.numberOfImages || 1,
        model: request.model,
        size: "1024x1024",
        quality: "standard",
      },
      startTime,
      duration,
      "Google",
      "GOOGLE_VERTEX_AI",
      MIDDLEWARE_SOURCE,
      usageMeta,
    );

    void (async () => {
      try {
        await sendToRevenium(imagePayload);
      } finally {
        printUsageSummary(imagePayload);
      }
    })().catch((e) =>
      logger.warn("Image edit metering failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

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
  };

  public upscaleImage = async (
    request: IImageUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleImageResponse> => {
    const logger = getLogger();
    const startTime = Date.now();
    const transactionId = generateTransactionId();
    const token = await this.getAccessToken();

    const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predict`;

    const requestBody = {
      instances: [{ image: { bytesBase64Encoded: request.image } }],
      parameters: {
        upscaleConfig: { upscaleFactor: request.upscaleFactor || "x2" },
        outputOptions: request.outputOptions,
      },
    };

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

    const data: any = await response.json();
    const duration = Date.now() - startTime;
    const usageMeta = mapGoogleUsageMetadata(usageMetadata);

    const imagePayload = buildImagePayload(
      "upscale",
      { data: data.predictions || [] },
      { n: 1, model: request.model, quality: "standard" },
      startTime,
      duration,
      "Google",
      "GOOGLE_VERTEX_AI",
      MIDDLEWARE_SOURCE,
      usageMeta,
    );

    void (async () => {
      try {
        await sendToRevenium(imagePayload);
      } finally {
        printUsageSummary(imagePayload);
      }
    })().catch((e) =>
      logger.warn("Image upscale metering failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

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
  };

  public generateVideo = async (
    request: IVideoGenerationRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    const logger = getLogger();
    const startTime = Date.now();
    const transactionId = generateTransactionId();
    const token = await this.getAccessToken();
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

    const initResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Vertex AI Video API error: ${initResponse.status} - ${errorText}`);
    }

    const initData: any = await initResponse.json();
    const operationName = initData.name;

    if (!operationName) {
      throw new Error("No operation name returned from Video API");
    }

    const pollUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}`;
    const pollStartTime = Date.now();
    let pollDelay = 2000;
    let videoResult: any = null;

    while (Date.now() - pollStartTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
      pollDelay = Math.min(pollDelay * 1.5, 30000);

      const pollResponse = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!pollResponse.ok) continue;
      const pollData: any = await pollResponse.json();

      if (pollData.done) {
        videoResult = pollData.response || pollData;
        break;
      }
    }

    if (!videoResult) {
      throw new Error(`Video generation timed out after ${timeout}ms`);
    }

    const duration = Date.now() - startTime;
    const usageMeta = mapGoogleUsageMetadata(usageMetadata);

    const videoPayload = buildVideoPayload(
      "generation",
      { model: request.model },
      startTime,
      duration,
      "Google",
      "GOOGLE_VERTEX_AI",
      MIDDLEWARE_SOURCE,
      usageMeta,
      {
        videoDurationSeconds: request.duration,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        quality: request.quality,
        frameRate: request.frameRate,
        region: this.location,
        asyncJobId: operationName,
      },
    );

    void (async () => {
      try {
        await sendToRevenium(videoPayload);
      } finally {
        printUsageSummary(videoPayload);
      }
    })().catch((e) =>
      logger.warn("Video metering failed", { error: e instanceof Error ? e.message : String(e) }),
    );

    const videos = videoResult.predictions
      ? videoResult.predictions.map((p: any) => ({
          bytesBase64Encoded: p.bytesBase64Encoded,
          mimeType: p.mimeType || "video/mp4",
        }))
      : [];

    return {
      response: { videos, modelVersion: request.model, operationId: operationName },
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
        asyncJobId: operationName,
      },
    };
  };

  public extendVideo = async (
    request: IVideoExtendRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    const logger = getLogger();
    const startTime = Date.now();
    const transactionId = generateTransactionId();
    const token = await this.getAccessToken();
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

    const initResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Vertex AI Video Extend API error: ${initResponse.status} - ${errorText}`);
    }

    const initData: any = await initResponse.json();
    const operationName = initData.name;
    if (!operationName) throw new Error("No operation name returned from Video API");

    const pollUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}`;
    const pollStartTime = Date.now();
    let pollDelay = 2000;
    let videoResult: any = null;

    while (Date.now() - pollStartTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
      pollDelay = Math.min(pollDelay * 1.5, 30000);
      const pollResponse = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!pollResponse.ok) continue;
      const pollData: any = await pollResponse.json();
      if (pollData.done) {
        videoResult = pollData.response || pollData;
        break;
      }
    }

    if (!videoResult) throw new Error(`Video extension timed out after ${timeout}ms`);

    const duration = Date.now() - startTime;
    const usageMeta = mapGoogleUsageMetadata(usageMetadata);

    const videoPayload = buildVideoPayload(
      "extend",
      { model: request.model },
      startTime,
      duration,
      "Google",
      "GOOGLE_VERTEX_AI",
      MIDDLEWARE_SOURCE,
      usageMeta,
      {
        videoDurationSeconds: request.duration,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        quality: request.quality,
        frameRate: request.frameRate,
        region: this.location,
        asyncJobId: operationName,
      },
    );

    void (async () => {
      try {
        await sendToRevenium(videoPayload);
      } finally {
        printUsageSummary(videoPayload);
      }
    })().catch((e) =>
      logger.warn("Video extend metering failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

    const videos = videoResult.predictions
      ? videoResult.predictions.map((p: any) => ({
          bytesBase64Encoded: p.bytesBase64Encoded,
          mimeType: p.mimeType || "video/mp4",
        }))
      : [];

    return {
      response: { videos, modelVersion: request.model, operationId: operationName },
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
        asyncJobId: operationName,
      },
    };
  };

  public upscaleVideo = async (
    request: IVideoUpscaleRequest,
    usageMetadata?: GoogleUsageMetadata,
  ): Promise<IGoogleVideoResponse> => {
    const logger = getLogger();
    const startTime = Date.now();
    const transactionId = generateTransactionId();
    const token = await this.getAccessToken();
    const timeout = Math.min(request.timeout || 300000, 3600000);

    const apiUrl = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${request.model}:predictLongRunning`;

    const requestBody = {
      instances: [{ video: { bytesBase64Encoded: request.referenceVideo } }],
      parameters: { resolution: request.resolution },
    };

    const initResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Vertex AI Video Upscale API error: ${initResponse.status} - ${errorText}`);
    }

    const initData: any = await initResponse.json();
    const operationName = initData.name;
    if (!operationName) throw new Error("No operation name returned from Video API");

    const pollUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}`;
    const pollStartTime = Date.now();
    let pollDelay = 2000;
    let videoResult: any = null;

    while (Date.now() - pollStartTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
      pollDelay = Math.min(pollDelay * 1.5, 30000);
      const pollResponse = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!pollResponse.ok) continue;
      const pollData: any = await pollResponse.json();
      if (pollData.done) {
        videoResult = pollData.response || pollData;
        break;
      }
    }

    if (!videoResult) throw new Error(`Video upscale timed out after ${timeout}ms`);

    const duration = Date.now() - startTime;
    const usageMeta = mapGoogleUsageMetadata(usageMetadata);

    const videoPayload = buildVideoPayload(
      "upscale",
      { model: request.model },
      startTime,
      duration,
      "Google",
      "GOOGLE_VERTEX_AI",
      MIDDLEWARE_SOURCE,
      usageMeta,
      {
        resolution: request.resolution,
        region: this.location,
        asyncJobId: operationName,
      },
    );

    void (async () => {
      try {
        await sendToRevenium(videoPayload);
      } finally {
        printUsageSummary(videoPayload);
      }
    })().catch((e) =>
      logger.warn("Video upscale metering failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

    const videos = videoResult.predictions
      ? videoResult.predictions.map((p: any) => ({
          bytesBase64Encoded: p.bytesBase64Encoded,
          mimeType: p.mimeType || "video/mp4",
        }))
      : [];

    return {
      response: { videos, modelVersion: request.model, operationId: operationName },
      transactionId,
      model: request.model,
      operationSubtype: "upscale",
      metadata: {
        resolution: request.resolution,
        region: this.location,
        asyncJobId: operationName,
      },
    };
  };
}

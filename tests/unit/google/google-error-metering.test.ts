import type { Logger } from "../../../src/_core/types/index";
import {
  createGeminiReply,
  createJsonResponse,
  createSseResponse,
  drain,
  stubGoogleAuth,
} from "../../helpers/fixtures";

const originalFetch = global.fetch;

const COMPLETIONS_URL = "https://api.revenium.ai/meter/v2/ai/completions";
const IMAGES_URL = "https://api.revenium.ai/meter/v2/ai/images";
const VIDEO_URL = "https://api.revenium.ai/meter/v2/ai/video";

const PROMPT_TOKENS = 9;
const CANDIDATE_TOKENS = 2;
const TOTAL_TOKENS = 11;
const VIDEO_SECONDS = 8;

const REVENIUM_ENV_KEYS = [
  "REVENIUM_METERING_API_KEY",
  "REVENIUM_METERING_BASE_URL",
  "REVENIUM_API_KEY",
  "REVENIUM_BASE_URL",
  "REVENIUM_MAX_RETRIES",
  "REVENIUM_FAIL_SILENT",
  "REVENIUM_CAPTURE_PROMPTS",
  "REVENIUM_TEAM_ID",
  "REVENIUM_PRINT_SUMMARY",
  "REVENIUM_ENFORCEMENT_BASE_URL",
];

const GOOGLE_ENV_KEYS = [
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

const REVENIUM_ENV = {
  REVENIUM_METERING_API_KEY: "hak_test_key",
  REVENIUM_METERING_BASE_URL: "https://api.revenium.ai",
  REVENIUM_MAX_RETRIES: "0",
};

const GENAI_ENV = {
  ...REVENIUM_ENV,
  GOOGLE_API_KEY: "google-api-key",
};

const VERTEX_ENV = {
  ...REVENIUM_ENV,
  GOOGLE_CLOUD_PROJECT: "test-project",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/credentials.json",
};

const CHAT_RESPONSE = createGeminiReply({
  promptTokenCount: PROMPT_TOKENS,
  candidatesTokenCount: CANDIDATE_TOKENS,
  totalTokenCount: TOTAL_TOKENS,
});

stubGoogleAuth();

let generateReply: () => Response;
let streamReply: () => Response;
let embedReply: () => Response;

let envSnapshot: NodeJS.ProcessEnv;
let setLogger: typeof import("../../../src/_core/config/manager").setLogger;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

function failedResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function googleError(status: number, message: string): Response {
  return createJsonResponse({ error: { code: status, message, status: "FAILED" } }, status);
}

function geminiReply(url: string): Response | undefined {
  if (url.includes(":streamGenerateContent")) return streamReply();
  if (url.includes(":generateContent")) return generateReply();
  if (url.includes(":countTokens")) return createJsonResponse({ totalTokens: PROMPT_TOKENS });
  if (url.includes(":batchEmbedContents") || url.includes("text-embedding-004:predict")) {
    return embedReply();
  }
  return undefined;
}

function interruptedStreamResponse(chunk: unknown, error: unknown): Response {
  const encoder = new TextEncoder();
  const networkChunks = [`data: ${JSON.stringify(chunk)}\n\n`, JSON.stringify({ error })];
  return new Response(
    new ReadableStream({
      pull(controller) {
        const next = networkChunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function createFetchMock(googleResponses: (url: string) => Response | undefined): jest.Mock {
  return jest.fn((url: string) => {
    const googleResponse = geminiReply(url) ?? googleResponses(url);
    return Promise.resolve(googleResponse ?? jsonResponse({}));
  });
}

function providerCalls(fetchMock: jest.Mock, endpoint: string): unknown[][] {
  return fetchMock.mock.calls.filter(([called]) => String(called).includes(endpoint));
}

function successfulGoogleFetch(): jest.Mock {
  return createFetchMock((url) => {
    if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-1" });
    if (url.includes("/operations/")) {
      return jsonResponse({
        done: true,
        response: { videos: [{ bytesBase64Encoded: "video", mimeType: "video/mp4" }] },
      });
    }
    if (url.includes(":predict")) {
      return jsonResponse({
        predictions: [{ bytesBase64Encoded: "image", mimeType: "image/png" }],
      });
    }
    return undefined;
  });
}

function meteringCalls(meteringFetch: jest.Mock, url: string): unknown[][] {
  return meteringFetch.mock.calls.filter(([called]) => called === url);
}

function recordSetupMessages(): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
  };
  setLogger(logger);
  return { warnings, errors };
}

async function waitFor(condition: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(condition()).toBe(true);
}

async function waitForMeteringCalls(
  meteringFetch: jest.Mock,
  expected: number,
  url: string,
): Promise<void> {
  await waitFor(() => meteringCalls(meteringFetch, url).length >= expected);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function readMeteringRequest(meteringFetch: jest.Mock, url: string): Record<string, unknown> {
  const calls = meteringCalls(meteringFetch, url);
  expect(calls).toHaveLength(1);

  const [, requestInit] = calls[0] as [string, RequestInit];
  return JSON.parse(requestInit.body as string);
}

function expectZeroTokens(payload: Record<string, unknown>): void {
  expect(payload.inputTokenCount).toBe(0);
  expect(payload.outputTokenCount).toBe(0);
  expect(payload.totalTokenCount).toBe(0);
}

beforeEach(async () => {
  jest.resetModules();
  generateReply = () => createJsonResponse(CHAT_RESPONSE);
  streamReply = () => createSseResponse([CHAT_RESPONSE]);
  embedReply = () => createJsonResponse({ embeddings: [{ values: [0.1, 0.2] }] });

  envSnapshot = { ...process.env };
  for (const key of [...REVENIUM_ENV_KEYS, ...GOOGLE_ENV_KEYS]) delete process.env[key];

  const manager = await import("../../../src/_core/config/manager");
  const loader = await import("../../../src/_core/config/loader");

  setLogger = manager.setLogger;
  loader.resetEnvFilesLoaded();
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = envSnapshot;
  jest.restoreAllMocks();
});

describe("Google failure metering", () => {
  it("records a Vertex video whose operation fails as an error with no billable seconds", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock((url) => {
      if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-1" });
      if (url.includes("/operations/")) {
        return jsonResponse({
          name: "operations/op-1",
          done: true,
          error: { code: 3, message: "blocked by safety filters" },
        });
      }
      return undefined;
    });
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().generateVideo({
        model: "veo-2.0-generate-001",
        prompt: "a cat",
        duration: VIDEO_SECONDS,
      }),
    ).rejects.toThrow("blocked by safety filters");

    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.durationSeconds).toBe(0);
    expect((payload.attributes as Record<string, unknown>).video_duration_seconds).toBe(0);
    expect((payload.attributes as Record<string, unknown>).async_job_id).toBe("operations/op-1");
    expect(payload.errorReason).toContain("safety");
  }, 20000);

  it("records a Vertex video poll timeout as an error with no billable seconds", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock((url) => {
      if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-1" });
      if (url.includes("/operations/")) return jsonResponse({ done: false });
      return undefined;
    });
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().generateVideo({
        model: "veo-2.0-generate-001",
        prompt: "a cat",
        duration: VIDEO_SECONDS,
        timeout: 1,
      }),
    ).rejects.toThrow("timed out");

    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.durationSeconds).toBe(0);
    expect((payload.attributes as Record<string, unknown>).video_duration_seconds).toBe(0);
    expect(payload.errorReason).toContain("timed out");
  }, 20000);

  it("records a Vertex video filtered by responsible AI as an error with no billable seconds", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock((url) => {
      if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-1" });
      if (url.includes("/operations/")) {
        return jsonResponse({
          name: "operations/op-1",
          done: true,
          response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["unsafe content"] },
        });
      }
      return undefined;
    });
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().generateVideo({
        model: "veo-2.0-generate-001",
        prompt: "a cat",
        duration: VIDEO_SECONDS,
      }),
    ).rejects.toThrow("unsafe content");

    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.durationSeconds).toBe(0);
    expect((payload.attributes as Record<string, unknown>).video_duration_seconds).toBe(0);
    expect(payload.errorReason).toContain("unsafe content");
  }, 20000);

  it("records a non-retryable Vertex video poll failure with its own error reason", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock((url) => {
      if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-1" });
      if (url.includes("/operations/")) return failedResponse(401, "invalid credentials");
      return undefined;
    });
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().generateVideo({
        model: "veo-2.0-generate-001",
        prompt: "a cat",
        duration: VIDEO_SECONDS,
      }),
    ).rejects.toThrow("invalid credentials");

    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.durationSeconds).toBe(0);
    expect(payload.errorReason).toContain("invalid credentials");
  }, 20000);

  it.each([
    [
      "extendVideo",
      { model: "veo-2.0-generate-001", prompt: "a cat", referenceVideo: "video", duration: 8 },
    ],
    ["upscaleVideo", { model: "veo-2.0-generate-001", referenceVideo: "video", resolution: "4k" }],
  ])(
    "records a failed Vertex %s as an error with no billable seconds",
    async (method, request) => {
      Object.assign(process.env, VERTEX_ENV);

      const meteringFetch = createFetchMock((url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-1" });
        if (url.includes("/operations/")) {
          return jsonResponse({
            name: "operations/op-1",
            done: true,
            error: { code: 3, message: "blocked by safety filters" },
          });
        }
        return undefined;
      });
      global.fetch = meteringFetch;

      const { VertexAIController } = await import("../../../src/google/vertex/index");
      const controller = new VertexAIController() as unknown as Record<
        string,
        (request: unknown) => Promise<unknown>
      >;

      await expect(controller[method](request)).rejects.toThrow("blocked by safety filters");

      await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

      const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
      expect(payload.stopReason).toBe("ERROR");
      expect(payload.durationSeconds).toBe(0);
      expect((payload.attributes as Record<string, unknown>).video_duration_seconds).toBe(0);
      expect(payload.errorReason).toContain("safety");
    },
    20000,
  );

  it("records a failed Vertex stream open as an error", async () => {
    Object.assign(process.env, VERTEX_ENV);
    streamReply = () => googleError(503, "vertex model overloaded");

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().createStreaming(["hi"], "gemini-2.0-flash-001"),
    ).rejects.toThrow("vertex model overloaded");

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.modelSource).toBe("GOOGLE_VERTEX_AI");
    expect(payload.errorReason).toContain("vertex model overloaded");
    expect(payload.isStreamed).toBe(true);
  });

  it("records a failed Vertex access token fetch as an image error", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { GoogleAuth } = await import("google-auth-library");
    (GoogleAuth as unknown as jest.Mock).mockImplementation(() => ({
      getClient: () => Promise.reject(new Error("service account key expired")),
    }));

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().generateImage({
        model: "imagen-3.0-generate-002",
        prompt: "a cat",
      }),
    ).rejects.toThrow("service account key expired");

    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);

    const payload = readMeteringRequest(meteringFetch, IMAGES_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.actualImageCount).toBe(0);
    expect(payload.errorReason).toContain("service account key expired");
  });

  it("records a Vertex chat rejected by Google as an error with zero tokens", async () => {
    Object.assign(process.env, VERTEX_ENV);
    generateReply = () => googleError(404, "Not Found");

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001"),
    ).rejects.toThrow("404");

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.modelSource).toBe("GOOGLE_VERTEX_AI");
    expect(payload.errorReason).toContain("404");
    expectZeroTokens(payload);
  });

  it("caps the error reason at the length the metering API accepts", async () => {
    Object.assign(process.env, VERTEX_ENV);
    generateReply = () => googleError(400, "x".repeat(2000));

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001"),
    ).rejects.toThrow();

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect((payload.errorReason as string).length).toBe(255);
  });

  it("records a Vertex video returned under response.videos as a successful video", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    const result = await new VertexAIController().generateVideo({
      model: "veo-3.0-generate-001",
      prompt: "a cat",
      duration: VIDEO_SECONDS,
    });

    expect(result.response.videos).toEqual([
      { bytesBase64Encoded: "video", mimeType: "video/mp4" },
    ]);

    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(payload.stopReason).toBe("END");
    expect(payload.durationSeconds).toBe(VIDEO_SECONDS);
  }, 20000);

  it("records a failed Vertex embedding as an error without counting tokens", async () => {
    Object.assign(process.env, VERTEX_ENV);
    embedReply = () => googleError(503, "embedding backend unavailable");

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().createEmbedding("hi", "text-embedding-004"),
    ).rejects.toThrow("embedding backend unavailable");

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.errorReason).toContain("embedding backend unavailable");
    expectZeroTokens(payload);
    expect(providerCalls(meteringFetch, ":countTokens")).toHaveLength(0);
  });

  it.each([
    ["generateImage", "imagen-3.0-generate-002"],
    ["editImage", "imagen-3.0-capability-001"],
    ["upscaleImage", "imagen-3.0-generate-002"],
  ])("records a failed Vertex %s as an error with no produced image", async (method, model) => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock((url) =>
      url.includes(":predict") ? failedResponse(429, "quota exceeded") : undefined,
    );
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    const controller = new VertexAIController() as unknown as Record<
      string,
      (request: unknown) => Promise<unknown>
    >;

    await expect(
      controller[method]({ model, prompt: "a cat", referenceImage: "img", image: "img" }),
    ).rejects.toThrow("quota exceeded");

    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);

    const payload = readMeteringRequest(meteringFetch, IMAGES_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.actualImageCount).toBe(0);
    expect((payload.attributes as Record<string, unknown>).actual_image_count).toBe(0);
    expect(payload.errorReason).toContain("quota exceeded");
  });

  it("records a failed Gemini chat as an error", async () => {
    Object.assign(process.env, GENAI_ENV);
    generateReply = () => googleError(400, "API key not valid");

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await expect(
      new GoogleGenAIController().createChat(["hi"], "gemini-2.0-flash-001"),
    ).rejects.toThrow("API key not valid");

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.modelSource).toBe("GOOGLE");
    expectZeroTokens(payload);
  });

  it("records a failed Gemini stream open as an error", async () => {
    Object.assign(process.env, GENAI_ENV);
    streamReply = () => googleError(503, "model overloaded");

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await expect(
      new GoogleGenAIController().createStreaming(["hi"], "gemini-2.0-flash-001"),
    ).rejects.toThrow("model overloaded");

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.modelSource).toBe("GOOGLE");
    expect(payload.isStreamed).toBe(true);
  });

  it("records a failed Gemini embedding as an error", async () => {
    Object.assign(process.env, GENAI_ENV);
    embedReply = () => googleError(400, "embedding rejected");

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await expect(
      new GoogleGenAIController().createEmbedding("hi", "text-embedding-004"),
    ).rejects.toThrow("embedding rejected");

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.modelSource).toBe("GOOGLE");
    expectZeroTokens(payload);
  });

  it("records a mid-stream Google failure once as an error", async () => {
    Object.assign(process.env, GENAI_ENV);
    streamReply = () =>
      interruptedStreamResponse(CHAT_RESPONSE, {
        code: 500,
        status: "INTERNAL",
        message: "stream aborted by the model",
      });

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const streaming = await new GoogleGenAIController().createStreaming(
      ["hi"],
      "gemini-2.0-flash-001",
    );

    await expect(drain(streaming.stream)).rejects.toThrow("stream aborted by the model");
    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.errorReason).toContain("stream aborted by the model");
    expect(payload.inputTokenCount).toBe(PROMPT_TOKENS);
    expect(payload.outputTokenCount).toBe(CANDIDATE_TOKENS);
    expect(payload.totalTokenCount).toBe(TOTAL_TOKENS);
  });

  it("keeps an abandoned Google stream out of the error state", async () => {
    Object.assign(process.env, GENAI_ENV);
    streamReply = () => createSseResponse([CHAT_RESPONSE, CHAT_RESPONSE]);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const streaming = await new GoogleGenAIController().createStreaming(
      ["hi"],
      "gemini-2.0-flash-001",
    );

    for await (const chunk of streaming.stream) {
      void chunk;
      break;
    }

    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const payload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(payload.stopReason).toBe("END");
    expect(payload.errorReason).toBeUndefined();
  });

  it("rethrows the Google error when metering transport fails on the error path", async () => {
    Object.assign(process.env, VERTEX_ENV);
    generateReply = () => googleError(404, "Not Found");

    const meteringFetch = createFetchMock((url) =>
      url.includes("api.revenium.ai") ? failedResponse(500, "metering down") : undefined,
    );
    global.fetch = meteringFetch;

    const { warnings } = recordSetupMessages();

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001"),
    ).rejects.toThrow("404");

    await waitFor(
      () => warnings.some((message) => message.includes("Google tracking failed")),
      15000,
    );
  }, 20000);

  it("leaves successful Google chat and video payloads unchanged", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    const controller = new VertexAIController();

    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    const chatPayload = readMeteringRequest(meteringFetch, COMPLETIONS_URL);
    expect(chatPayload.stopReason).toBe("END");
    expect(chatPayload.inputTokenCount).toBe(PROMPT_TOKENS);
    expect(chatPayload.outputTokenCount).toBe(CANDIDATE_TOKENS);
    expect(chatPayload.totalTokenCount).toBe(TOTAL_TOKENS);
    expect(chatPayload.errorReason).toBeUndefined();

    await controller.generateVideo({
      model: "veo-2.0-generate-001",
      prompt: "a cat",
      duration: VIDEO_SECONDS,
    });
    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const videoPayload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(videoPayload.stopReason).toBe("END");
    expect(videoPayload.durationSeconds).toBe(VIDEO_SECONDS);
    expect((videoPayload.attributes as Record<string, unknown>).video_duration_seconds).toBe(
      VIDEO_SECONDS,
    );
    expect(videoPayload.errorReason).toBeUndefined();
  }, 20000);

  it("bills Vertex image and video records in the Vertex location with the environment ticket, not the server region", async () => {
    Object.assign(process.env, VERTEX_ENV, {
      GOOGLE_CLOUD_LOCATION: "europe-west4",
      REVENIUM_REGION: "us-east-1",
      REVENIUM_TICKET_ID: "ENG-123",
    });

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    const controller = new VertexAIController();

    await controller.generateImage({ model: "imagen-3.0-generate-002", prompt: "a cat" });
    await controller.generateVideo({
      model: "veo-2.0-generate-001",
      prompt: "a cat",
      duration: VIDEO_SECONDS,
    });
    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);
    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const expected = { region: "europe-west4", ticketId: "ENG-123" };

    expect(readMeteringRequest(meteringFetch, IMAGES_URL)).toMatchObject(expected);
    expect(readMeteringRequest(meteringFetch, VIDEO_URL)).toMatchObject(expected);
  }, 20000);

  it("sends the Vertex Imagen resolution and quality at the top level of the record", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");

    await new VertexAIController().generateImage({
      model: "imagen-3.0-generate-002",
      prompt: "a cat",
      aspectRatio: "16:9",
    });
    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);

    const payload = readMeteringRequest(meteringFetch, IMAGES_URL);
    expect(payload.resolution).toBe("1024x576");
    expect(payload.quality).toBe("standard");
  }, 20000);

  it("sends no top-level resolution for a Vertex Imagen edit whose output size is unknown", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");

    await new VertexAIController().editImage({
      model: "imagen-3.0-capability-001",
      prompt: "a cat",
      referenceImage: "img",
    });
    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);

    const payload = readMeteringRequest(meteringFetch, IMAGES_URL);
    expect(payload.resolution).toBeUndefined();
    expect(payload.quality).toBe("standard");
    expect((payload.attributes as Record<string, unknown>).resolution).toBe("1024x1024");
  }, 20000);

  it("sends the Vertex Veo resolution at the top level of the record", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = successfulGoogleFetch();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");

    await new VertexAIController().generateVideo({
      model: "veo-2.0-generate-001",
      prompt: "a cat",
      duration: VIDEO_SECONDS,
      resolution: "1080p",
    });
    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const payload = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(payload.resolution).toBe("1080p");
  }, 20000);
});

describe("Google cost limit directive", () => {
  const blockReply = {
    enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
  };
  const metadata = { subscriberId: "sub-1" };

  it("refuses the next Gemini chat for the scope the record was metered under", async () => {
    Object.assign(process.env, GENAI_ENV);
    const meteringFetch = createFetchMock((url) =>
      url === COMPLETIONS_URL ? jsonResponse(blockReply) : undefined,
    );
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const controller = new GoogleGenAIController();

    await controller.createChat(["hi"], "gemini-2.0-flash-001", metadata);
    await waitForMeteringCalls(meteringFetch, 1, COMPLETIONS_URL);

    await expect(controller.createChat(["hi"], "gemini-2.0-flash-001", metadata)).rejects.toThrow(
      "Daily cap reached",
    );
    await expect(
      controller.createChat(["hi"], "gemini-2.0-flash-001", { subscriberId: "sub-2" }),
    ).resolves.toBeDefined();
    expect(providerCalls(meteringFetch, ":generateContent")).toHaveLength(2);
  });

  it("refuses the next Vertex image generation for the scope the record was metered under", async () => {
    Object.assign(process.env, VERTEX_ENV);
    const providerFetch = successfulGoogleFetch();
    const meteringFetch = jest.fn((url: string, init?: RequestInit) =>
      url === IMAGES_URL ? Promise.resolve(jsonResponse(blockReply)) : providerFetch(url, init),
    );
    global.fetch = meteringFetch as unknown as typeof fetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    const controller = new VertexAIController();
    const request = { model: "imagen-3.0-generate-002", prompt: "a cat" };

    await controller.generateImage(request, metadata);
    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);

    await expect(controller.generateImage(request, metadata)).rejects.toThrow("Daily cap reached");
    expect(meteringFetch.mock.calls.filter(([url]) => url.includes(":predict"))).toHaveLength(1);
  });
});

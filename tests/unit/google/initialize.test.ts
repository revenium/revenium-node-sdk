import type { Logger } from "../../../src/_core/types/index";

const originalFetch = global.fetch;

const COMPLETIONS_URL = "https://api.revenium.ai/meter/v2/ai/completions";
const IMAGES_URL = "https://api.revenium.ai/meter/v2/ai/images";
const VIDEO_URL = "https://api.revenium.ai/meter/v2/ai/video";

const SKIPPED_TRACKING_WARNING = "Revenium configuration not found";

const PROMPT_TOKENS = 9;
const CANDIDATE_TOKENS = 2;
const TOTAL_TOKENS = 11;

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

const mockCountTokens = jest.fn();

jest.mock("@google/genai", () => {
  const chatResponse = {
    text: "hi",
    modelVersion: "gemini-2.0-flash-001",
    responseId: "response-1",
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: PROMPT_TOKENS,
      candidatesTokenCount: CANDIDATE_TOKENS,
      totalTokenCount: TOTAL_TOKENS,
    },
  };

  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      chats: {
        create: () => ({
          sendMessage: () => Promise.resolve(chatResponse),
          getHistory: () => [],
        }),
      },
      models: {
        generateContentStream: () =>
          Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield chatResponse;
            },
          }),
        embedContent: () => Promise.resolve({ embeddings: [{ values: [0.1, 0.2] }] }),
        countTokens: mockCountTokens,
      },
    })),
  };
});

jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: () => Promise.resolve({ getAccessToken: () => ({ token: "access-token" }) }),
  })),
}));

let envSnapshot: NodeJS.ProcessEnv;
let getConfig: typeof import("../../../src/_core/config/manager").getConfig;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
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

function createFetchMock(): jest.Mock {
  return jest.fn((url: string) => {
    if (url.includes(":predictLongRunning")) {
      return Promise.resolve(jsonResponse({ name: "operations/op-1" }));
    }
    if (url.includes("/operations/")) {
      return Promise.resolve(
        jsonResponse({
          done: true,
          response: { predictions: [{ bytesBase64Encoded: "video", mimeType: "video/mp4" }] },
        }),
      );
    }
    if (url.includes(":predict")) {
      return Promise.resolve(
        jsonResponse({ predictions: [{ bytesBase64Encoded: "image", mimeType: "image/png" }] }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function meteringCalls(meteringFetch: jest.Mock, url: string = COMPLETIONS_URL): unknown[][] {
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
  url: string = COMPLETIONS_URL,
): Promise<void> {
  await waitFor(() => meteringCalls(meteringFetch, url).length >= expected);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForSkippedMetering(warnings: string[]): Promise<void> {
  await waitFor(() => warnings.some((message) => message.includes(SKIPPED_TRACKING_WARNING)));
}

function readMeteringRequest(
  meteringFetch: jest.Mock,
  url: string = COMPLETIONS_URL,
): {
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  const calls = meteringCalls(meteringFetch, url);
  expect(calls).toHaveLength(1);

  const [, requestInit] = calls[0] as [string, RequestInit & { headers: Record<string, string> }];
  return { headers: requestInit.headers, payload: JSON.parse(requestInit.body as string) };
}

function meteringApiKeys(meteringFetch: jest.Mock, url: string = COMPLETIONS_URL): string[] {
  return meteringCalls(meteringFetch, url).map(([, requestInit]) => {
    const { headers } = requestInit as RequestInit & { headers: Record<string, string> };
    return headers["x-api-key"];
  });
}

function expectChatTokens(payload: Record<string, unknown>): void {
  expect(payload.inputTokenCount).toBe(PROMPT_TOKENS);
  expect(payload.outputTokenCount).toBe(CANDIDATE_TOKENS);
  expect(payload.totalTokenCount).toBe(TOTAL_TOKENS);
}

function expectEmbeddingTokens(payload: Record<string, unknown>, expected: number | null): void {
  expect(payload.inputTokenCount).toBe(expected);
  expect(payload.totalTokenCount).toBe(expected);
  expect(payload.outputTokenCount).toBe(0);
}

async function runFromEnvFileDirectory(
  envValues: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");

  const workingDir = mkdtempSync(join(tmpdir(), "google-dotenv-"));
  const originalCwd = process.cwd();

  writeFileSync(
    join(workingDir, ".env"),
    Object.entries(envValues)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );

  jest.resetModules();

  try {
    process.chdir(workingDir);
    await run();
  } finally {
    process.chdir(originalCwd);
    rmSync(workingDir, { recursive: true, force: true });
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) {
    void chunk;
  }
}

beforeEach(async () => {
  jest.resetModules();
  mockCountTokens.mockReset();
  mockCountTokens.mockResolvedValue({ totalTokens: PROMPT_TOKENS });
  envSnapshot = { ...process.env };
  for (const key of [...REVENIUM_ENV_KEYS, ...GOOGLE_ENV_KEYS]) delete process.env[key];

  const manager = await import("../../../src/_core/config/manager");
  const loader = await import("../../../src/_core/config/loader");

  getConfig = manager.getConfig;
  setConfig = manager.setConfig;
  setLogger = manager.setLogger;

  loader.resetEnvFilesLoaded();
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = envSnapshot;
  jest.restoreAllMocks();
});

describe("Google middleware setup", () => {
  it("sends one metering record from the documented Google AI Studio setup alone", async () => {
    Object.assign(process.env, GENAI_ENV);
    expect(getConfig()).toBeNull();

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await new GoogleGenAIController().createChat(["hi"], "gemini-2.0-flash-001");

    await waitForMeteringCalls(meteringFetch, 1);

    const { headers, payload } = readMeteringRequest(meteringFetch);
    expect(headers["x-api-key"]).toBe("hak_test_key");
    expectChatTokens(payload);
  });

  it("sends one metering record from the documented Vertex AI setup alone", async () => {
    Object.assign(process.env, VERTEX_ENV);
    expect(getConfig()).toBeNull();

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001");

    await waitForMeteringCalls(meteringFetch, 1);

    const { headers, payload } = readMeteringRequest(meteringFetch);
    expect(headers["x-api-key"]).toBe("hak_test_key");
    expectChatTokens(payload);
  });

  it("meters a Google AI Studio streamed chat from the documented setup alone", async () => {
    Object.assign(process.env, GENAI_ENV);

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const streaming = await new GoogleGenAIController().createStreaming(
      ["hi"],
      "gemini-2.0-flash-001",
    );
    await drain(streaming.stream);

    await waitForMeteringCalls(meteringFetch, 1);
    expectChatTokens(readMeteringRequest(meteringFetch).payload);
  });

  it("meters a Google AI Studio embedding from the documented setup alone", async () => {
    Object.assign(process.env, GENAI_ENV);

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await new GoogleGenAIController().createEmbedding("hi", "text-embedding-004");

    await waitForMeteringCalls(meteringFetch, 1);
    expectEmbeddingTokens(readMeteringRequest(meteringFetch).payload, PROMPT_TOKENS);
    expect(mockCountTokens).toHaveBeenCalledTimes(1);
    expect(mockCountTokens).toHaveBeenCalledWith({
      model: "text-embedding-004",
      contents: "hi",
    });
  });

  it("meters a Google AI Studio embedding as unknown when the token count fails", async () => {
    Object.assign(process.env, GENAI_ENV);
    mockCountTokens.mockRejectedValue(new Error("count unavailable"));

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await expect(
      new GoogleGenAIController().createEmbedding("hi", "text-embedding-004"),
    ).resolves.toBeDefined();

    await waitForMeteringCalls(meteringFetch, 1);
    expectEmbeddingTokens(readMeteringRequest(meteringFetch).payload, null);
  });

  it("meters a Google AI Studio embedding as unknown when the token count is zero", async () => {
    Object.assign(process.env, GENAI_ENV);
    mockCountTokens.mockResolvedValue({ totalTokens: 0 });

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    await new GoogleGenAIController().createEmbedding("hi", "text-embedding-004");

    await waitForMeteringCalls(meteringFetch, 1);
    expectEmbeddingTokens(readMeteringRequest(meteringFetch).payload, null);
  });

  it("reports no prompt token count when the Google embedding reply carries no usage", async () => {
    Object.assign(process.env, GENAI_ENV);

    global.fetch = createFetchMock();

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const { embedding } = await new GoogleGenAIController().createEmbedding(
      "hi",
      "text-embedding-004",
    );
    const { usageMetadata } = embedding as Exclude<typeof embedding, number[]>;

    expect(usageMetadata.promptTokenCount).toBeUndefined();
    expect(usageMetadata.totalTokenCount).toBeUndefined();
  });

  it("meters a Vertex AI streamed chat from the documented setup alone", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    const streaming = await new VertexAIController().createStreaming(
      ["hi"],
      "gemini-2.0-flash-001",
    );
    await drain(streaming.stream);

    await waitForMeteringCalls(meteringFetch, 1);
    expectChatTokens(readMeteringRequest(meteringFetch).payload);
  });

  it("meters a Vertex AI embedding from the documented setup alone", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await new VertexAIController().createEmbedding("hi", "text-embedding-004");

    await waitForMeteringCalls(meteringFetch, 1);
    expectEmbeddingTokens(readMeteringRequest(meteringFetch).payload, PROMPT_TOKENS);
    expect(mockCountTokens).toHaveBeenCalledTimes(1);
    expect(mockCountTokens).toHaveBeenCalledWith({
      model: "text-embedding-004",
      contents: "hi",
    });
  });

  it("meters a Vertex AI embedding as unknown when the token count is unsupported", async () => {
    Object.assign(process.env, VERTEX_ENV);
    mockCountTokens.mockRejectedValue(new Error("countTokens is not supported for this model"));

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await expect(
      new VertexAIController().createEmbedding("hi", "text-embedding-004"),
    ).resolves.toBeDefined();

    await waitForMeteringCalls(meteringFetch, 1);
    expectEmbeddingTokens(readMeteringRequest(meteringFetch).payload, null);
  });

  it("meters an Imagen generation from the documented Vertex AI setup alone", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await new VertexAIController().generateImage({
      model: "imagen-3.0-generate-002",
      prompt: "a cat",
    });

    await waitForMeteringCalls(meteringFetch, 1, IMAGES_URL);

    const { headers, payload } = readMeteringRequest(meteringFetch, IMAGES_URL);
    expect(headers["x-api-key"]).toBe("hak_test_key");
    expect(payload.model).toBe("imagen-3.0-generate-002");
  });

  it("meters a Veo generation from the documented Vertex AI setup alone", async () => {
    Object.assign(process.env, VERTEX_ENV);

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { VertexAIController } = await import("../../../src/google/vertex/index");
    await new VertexAIController().generateVideo({
      model: "veo-2.0-generate-001",
      prompt: "a cat",
    });

    await waitForMeteringCalls(meteringFetch, 1, VIDEO_URL);

    const { headers, payload } = readMeteringRequest(meteringFetch, VIDEO_URL);
    expect(headers["x-api-key"]).toBe("hak_test_key");
    expect(payload.model).toBe("veo-2.0-generate-001");
  }, 20000);

  it("meters a Google AI Studio chat when the setup only exists in a .env file", async () => {
    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    await runFromEnvFileDirectory(GENAI_ENV, async () => {
      const { GoogleGenAIController } = await import("../../../src/google/genai/index");
      await new GoogleGenAIController().createChat(["hi"], "gemini-2.0-flash-001");

      await waitForMeteringCalls(meteringFetch, 1);
      expect(readMeteringRequest(meteringFetch).headers["x-api-key"]).toBe("hak_test_key");
    });
  });

  it("meters a Vertex AI chat when the setup only exists in a .env file", async () => {
    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    await runFromEnvFileDirectory(VERTEX_ENV, async () => {
      const { VertexAIController } = await import("../../../src/google/vertex/index");
      await new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001");

      await waitForMeteringCalls(meteringFetch, 1);
      expect(readMeteringRequest(meteringFetch).headers["x-api-key"]).toBe("hak_test_key");
    });
  });

  it("keeps another provider's shared configuration", async () => {
    Object.assign(process.env, GENAI_ENV);
    expect(getConfig()).toBeNull();

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const controller = new GoogleGenAIController();

    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await waitForMeteringCalls(meteringFetch, 1);
    expect(meteringApiKeys(meteringFetch)).toEqual(["hak_test_key"]);

    setConfig({ reveniumApiKey: "hak_other", reveniumBaseUrl: "https://api.revenium.ai" });

    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await waitForMeteringCalls(meteringFetch, 2);

    expect(getConfig()?.reveniumApiKey).toBe("hak_other");
    expect(meteringApiKeys(meteringFetch)).toEqual(["hak_test_key", "hak_other"]);
  });

  it("warns once without throwing when no Revenium key is set", async () => {
    process.env.GOOGLE_API_KEY = "google-api-key";

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;
    const { warnings } = recordSetupMessages();

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const controller = new GoogleGenAIController();
    const response = await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await controller.createChat(["hi"], "gemini-2.0-flash-001");

    await waitForSkippedMetering(warnings);

    expect(response.responses[0].text).toBe("hi");
    expect(meteringCalls(meteringFetch)).toHaveLength(0);
    expect(getConfig()).toBeNull();

    const setupWarnings = warnings.filter((message) =>
      message.includes("REVENIUM_METERING_API_KEY"),
    );
    expect(setupWarnings).toHaveLength(1);
    expect(setupWarnings[0]).toContain("REVENIUM_API_KEY");
  });

  it("logs an error and keeps the Google answer when the Revenium key is malformed", async () => {
    Object.assign(process.env, GENAI_ENV, { REVENIUM_METERING_API_KEY: "badkey" });

    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;
    const { warnings, errors } = recordSetupMessages();

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const response = await new GoogleGenAIController().createChat(["hi"], "gemini-2.0-flash-001");

    await waitForSkippedMetering(warnings);

    expect(response.responses[0].text).toBe("hi");
    expect(getConfig()).toBeNull();
    expect(meteringCalls(meteringFetch)).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("logs the malformed Revenium key once across repeated calls", async () => {
    Object.assign(process.env, GENAI_ENV, { REVENIUM_METERING_API_KEY: "badkey" });

    global.fetch = createFetchMock();
    const { warnings, errors } = recordSetupMessages();

    const { GoogleGenAIController } = await import("../../../src/google/genai/index");
    const controller = new GoogleGenAIController();
    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await controller.createChat(["hi"], "gemini-2.0-flash-001");

    await waitForSkippedMetering(warnings);

    expect(errors).toHaveLength(1);
    const setupWarnings = warnings.filter((message) =>
      message.includes("REVENIUM_METERING_API_KEY"),
    );
    expect(setupWarnings).toHaveLength(1);
    expect(setupWarnings[0]).toContain("was rejected");
  });

  it("initializes on an explicit retry after the Revenium key is corrected", async () => {
    process.env.GOOGLE_API_KEY = "google-api-key";
    global.fetch = createFetchMock();
    recordSetupMessages();

    const { initialize } = await import("../../../src/google/genai/index");
    expect(initialize()).toBe(false);

    Object.assign(process.env, REVENIUM_ENV);

    expect(initialize()).toBe(true);
    expect(getConfig()?.reveniumApiKey).toBe("hak_test_key");
  });

  it("meters with the default base URL when configure receives only a key", async () => {
    const meteringFetch = createFetchMock();
    global.fetch = meteringFetch;
    process.env.GOOGLE_API_KEY = "google-api-key";

    const { configure, GoogleGenAIController } = await import("../../../src/google/genai/index");
    expect(configure({ reveniumApiKey: "hak_valid" })).toBe(true);
    expect(getConfig()?.reveniumBaseUrl).toBe("https://api.revenium.ai");

    await new GoogleGenAIController().createChat(["hi"], "gemini-2.0-flash-001");

    await waitForMeteringCalls(meteringFetch, 1);
    expect(readMeteringRequest(meteringFetch).headers["x-api-key"]).toBe("hak_valid");
  });

  it("reads the Vertex project from a .env file when the service is constructed directly", async () => {
    global.fetch = createFetchMock();

    await runFromEnvFileDirectory(VERTEX_ENV, async () => {
      const { GoogleGenAI } = await import("@google/genai");
      const { VertexAIService } = await import("../../../src/google/vertex/index");
      new VertexAIService("gemini-2.0-flash-001");

      expect(GoogleGenAI).toHaveBeenCalledWith(
        expect.objectContaining({ project: "test-project" }),
      );
    });
  });

  it("logs an error instead of throwing when configure receives a malformed key", async () => {
    const { errors } = recordSetupMessages();

    const { configure } = await import("../../../src/google/genai/index");
    expect(() => configure({ reveniumApiKey: "badkey" })).not.toThrow();

    expect(getConfig()).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("replaces the active configuration when configure receives a valid key", async () => {
    setConfig({ reveniumApiKey: "hak_other", reveniumBaseUrl: "https://api.revenium.ai" });

    const { configure } = await import("../../../src/google/genai/index");
    configure({ reveniumApiKey: "hak_explicit", reveniumBaseUrl: "https://api.revenium.ai" });

    expect(getConfig()?.reveniumApiKey).toBe("hak_explicit");
  });
});

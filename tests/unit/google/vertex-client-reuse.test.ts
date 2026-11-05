import { createMockFetch, createReveniumConfig } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@google/genai", () => ({
  ...jest.requireActual("@google/genai"),
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    chats: {
      create: () => ({
        sendMessage: () => Promise.resolve(CHAT_RESPONSE),
        getHistory: () => [],
      }),
    },
    models: {
      generateContentStream: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: async function* () {
            yield CHAT_RESPONSE;
          },
        }),
      embedContent: () => Promise.resolve({ embeddings: [{ values: [0.1, 0.2] }] }),
      countTokens: () => Promise.resolve({ totalTokens: 3 }),
    },
  })),
}));

jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: () => Promise.resolve({ getAccessToken: () => ({ token: "access-token" }) }),
  })),
}));

const CHAT_RESPONSE = {
  text: "hi",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
};

const GOOGLE_REST_BODY = {
  predictions: [{ bytesBase64Encoded: "image", mimeType: "image/png" }],
  name: "operations/op-1",
  done: true,
  response: { videos: [{ bytesBase64Encoded: "video", mimeType: "video/mp4" }] },
};

const CREDENTIALS_FILE = "/tmp/credentials.json";
const ROTATED_CREDENTIALS_FILE = "/tmp/rotated-credentials.json";

const originalFetch = global.fetch;
let envSnapshot: NodeJS.ProcessEnv;
let googleRestFetch: jest.Mock;

async function loadVertex() {
  const { VertexAIController } = await import("../../../src/google/vertex/index");
  const { GoogleGenAI } = await import("@google/genai");
  const { GoogleAuth } = await import("google-auth-library");
  return {
    VertexAIController,
    GoogleGenAI: GoogleGenAI as unknown as jest.Mock,
    GoogleAuth: GoogleAuth as unknown as jest.Mock,
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) {
    void chunk;
  }
}

beforeEach(async () => {
  jest.resetModules();
  envSnapshot = { ...process.env };
  Object.assign(process.env, {
    GOOGLE_CLOUD_PROJECT: "test-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_APPLICATION_CREDENTIALS: CREDENTIALS_FILE,
  });

  googleRestFetch = createMockFetch({ jsonBody: GOOGLE_REST_BODY });
  global.fetch = googleRestFetch;

  const manager = await import("../../../src/_core/config/manager");
  manager.setConfig(createReveniumConfig());
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = envSnapshot;
  jest.restoreAllMocks();
});

describe("Vertex AI client reuse", () => {
  it("20 controller chat calls build one Vertex client", async () => {
    const { VertexAIController, GoogleGenAI } = await loadVertex();

    for (let call = 0; call < 20; call++) {
      await new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001");
    }

    expect(GoogleGenAI).toHaveBeenCalledTimes(1);
  });

  it("chat, streaming, embedding, image and video reuse one Vertex client and build one GoogleAuth per credentials file", async () => {
    const { VertexAIController, GoogleGenAI, GoogleAuth } = await loadVertex();
    const controller = new VertexAIController();

    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await drain((await controller.createStreaming(["hi"], "gemini-2.5-pro")).stream);
    await controller.createEmbedding("hi", "text-embedding-004");
    await controller.generateImage({ model: "imagen-3.0-generate-002", prompt: "a cat" });
    await controller.generateVideo({ model: "veo-3.0-generate-001", prompt: "a cat", duration: 8 });

    expect(GoogleGenAI).toHaveBeenCalledTimes(1);
    expect(GoogleAuth).toHaveBeenCalledTimes(1);
  }, 20000);

  it("different project and location get their own client and URL", async () => {
    const { VertexAIController, GoogleGenAI, GoogleAuth } = await loadVertex();
    const controller = new VertexAIController();

    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await controller.createChat(
      ["hi"],
      "gemini-2.0-flash-001",
      undefined,
      "other-project",
      "europe-west4",
    );
    await controller.generateImage(
      { model: "imagen-3.0-generate-002", prompt: "a cat" },
      undefined,
      "other-project",
      "europe-west4",
    );

    expect(GoogleGenAI).toHaveBeenCalledTimes(2);
    expect(GoogleGenAI.mock.calls[1][0]).toEqual(
      expect.objectContaining({ project: "other-project", location: "europe-west4" }),
    );
    const imageUrl = googleRestFetch.mock.calls
      .map(([url]) => url as string)
      .find((url) => url.endsWith(":predict"));
    expect(imageUrl).toMatch(
      /^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1\/projects\/other-project\/locations\/europe-west4\//,
    );
    expect(GoogleAuth).toHaveBeenCalledTimes(1);
  });

  it("the same credential file signs in once and a different one signs in again", async () => {
    const { VertexAIController, GoogleAuth } = await loadVertex();

    await new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001");
    await new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = ROTATED_CREDENTIALS_FILE;
    await new VertexAIController().createChat(["hi"], "gemini-2.0-flash-001");

    expect(GoogleAuth.mock.calls.map(([options]) => options.keyFilename)).toEqual([
      CREDENTIALS_FILE,
      ROTATED_CREDENTIALS_FILE,
    ]);
  });
});

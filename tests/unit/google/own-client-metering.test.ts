import type { CallableTool, GoogleGenAI as GoogleGenAIClient, Part } from "@google/genai";
import type { EnforcementRule } from "../../../src/_core/enforcement/cache";
import type { Logger } from "../../../src/_core/types/index";
import {
  createGeminiReply,
  createJsonResponse,
  createReveniumConfig,
  createSseResponse,
  drain,
  installRoutingFetch,
  REVENIUM_BASE_URL,
  settle,
  stubGoogleAuth,
  waitForMetering,
  type MeteringBody,
} from "../../helpers/fixtures";

stubGoogleAuth();

const MODEL = "gemini-3.5-flash-lite";
const EMBEDDING_MODEL = "gemini-embedding-001";
const GOOGLE_API_HOST = "googleapis.com";
const SECOND_COPY_API_KEY = "hak_second_copy_key";

function geminiReply(promptTokenCount: number, candidatesTokenCount: number, parts?: Part[]) {
  return createGeminiReply(
    {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    },
    parts,
  );
}

const originalFetch = global.fetch;
const googleRequests: { url: string; body: Record<string, unknown> }[] = [];
let GoogleGenAI: typeof GoogleGenAIClient;

function routeGoogle(reply: (url: string) => Response) {
  return (url: string, init?: RequestInit): Response => {
    if (!url.includes(GOOGLE_API_HOST)) return new Response(null, { status: 404 });
    googleRequests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return reply(url);
  };
}

function importMiddleware() {
  return import("../../../src/google/genai/index");
}

async function createClient(): Promise<GoogleGenAIClient> {
  await importMiddleware();
  return new GoogleGenAI({ apiKey: "google-api-key" });
}

async function collectMetering(bodies: MeteringBody[], expectedCount = 1): Promise<MeteringBody[]> {
  await waitForMetering(bodies, expectedCount);
  await settle();
  return bodies;
}

function meteringApiKeys(): string[] {
  return (global.fetch as jest.Mock).mock.calls
    .filter(([url]) => String(url).startsWith(REVENIUM_BASE_URL))
    .map(([, init]) => init.headers["x-api-key"]);
}

beforeEach(async () => {
  jest.resetModules();
  googleRequests.length = 0;
  ({ GoogleGenAI } = await import("@google/genai"));
  const manager = await import("../../../src/_core/config/manager");
  manager.setConfig(createReveniumConfig({ capturePrompts: true }));
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  jest.restoreAllMocks();
});

describe("Google GenAI customer client metering", () => {
  it("meters a generateContent call with an image part and a system instruction on the customer's client", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(270, 4))));
    const ai = await createClient();

    await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: "What shape is this?" },
            { inlineData: { mimeType: "image/png", data: "aGk=" } },
          ],
        },
      ],
      config: { systemInstruction: "Answer in five words." },
      usageMetadata: { subscriber: { id: "sub-image" } },
    });

    const [body] = await collectMetering(bodies);
    expect(bodies).toHaveLength(1);
    expect(body).toMatchObject({
      inputTokenCount: 270,
      outputTokenCount: 4,
      model: MODEL,
      modelSource: "GOOGLE",
      systemPrompt: "Answer in five words.",
      inputMessages: "What shape is this?\n[IMAGE]",
      subscriber: { id: "sub-image" },
    });
    expect(googleRequests[0].body).not.toHaveProperty("usageMetadata");
  });

  it("meters each automatic function calling round", async () => {
    const rounds = [
      geminiReply(10, 2, [{ functionCall: { name: "getWeather", args: { city: "Lisbon" } } }]),
      geminiReply(25, 6),
    ];
    const bodies = installRoutingFetch(
      routeGoogle(() => createJsonResponse(rounds[googleRequests.length - 1])),
    );
    const weatherTool: CallableTool = {
      tool: async () => ({ functionDeclarations: [{ name: "getWeather" }] }),
      callTool: async () => [{ functionResponse: { name: "getWeather", response: { temp: 21 } } }],
    };
    const ai = await createClient();

    await ai.models.generateContent({
      model: MODEL,
      contents: "Weather in Lisbon?",
      config: { tools: [weatherTool] },
    });

    await collectMetering(bodies, 2);
    expect(googleRequests).toHaveLength(2);
    expect(bodies.map((body) => [body.inputTokenCount, body.outputTokenCount]).sort()).toEqual([
      [10, 2],
      [25, 6],
    ]);
  });

  it("keeps usageMetadata on a call with tools and generation settings", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(40, 8))));
    const ai = await createClient();

    await ai.models.generateContent({
      model: MODEL,
      contents: "Look up order 42",
      config: {
        tools: [{ functionDeclarations: [{ name: "lookupOrder" }] }],
        temperature: 0.2,
      },
      usageMetadata: { subscriber: { id: "sub-tools" } },
    });

    const [body] = await collectMetering(bodies);
    expect(body).toMatchObject({
      model: MODEL,
      inputTokenCount: 40,
      outputTokenCount: 8,
      subscriber: { id: "sub-tools" },
    });
    expect(googleRequests[0].body).not.toHaveProperty("usageMetadata");
  });

  it("meters a stream and an embedding on the customer's client", async () => {
    const bodies = installRoutingFetch(
      routeGoogle((url) => {
        if (url.includes(":streamGenerateContent")) {
          return createSseResponse([
            { candidates: [{ content: { role: "model", parts: [{ text: "A " }] } }] },
            geminiReply(12, 3),
          ]);
        }
        if (url.includes(":countTokens")) return createJsonResponse({ totalTokens: 5 });
        return createJsonResponse({ embeddings: [{ values: [0.1, 0.2] }] });
      }),
    );
    const ai = await createClient();

    await drain(
      await ai.models.generateContentStream({
        model: MODEL,
        contents: "Hello",
        usageMetadata: { subscriber: { id: "sub-stream" } },
      }),
    );
    await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: "Hello",
      usageMetadata: { subscriber: { id: "sub-embed" } },
    });

    await collectMetering(bodies, 2);
    expect(bodies).toHaveLength(2);
    expect(bodies.find((body) => body.operationType === "CHAT")).toMatchObject({
      isStreamed: true,
      inputTokenCount: 12,
      outputTokenCount: 3,
      subscriber: { id: "sub-stream" },
    });
    expect(bodies.find((body) => body.operationType === "EMBED")).toMatchObject({
      model: EMBEDDING_MODEL,
      inputTokenCount: 5,
      subscriber: { id: "sub-embed" },
    });
    expect(googleRequests.map(({ body }) => body)).not.toContainEqual(
      expect.objectContaining({ usageMetadata: expect.anything() }),
    );
  });

  it("meters a Vertex client as GOOGLE_VERTEX_AI", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(7, 2))));
    await importMiddleware();
    const ai = new GoogleGenAI({
      vertexai: true,
      project: "test-project",
      location: "us-central1",
    });

    await ai.models.generateContent({ model: MODEL, contents: "Hello" });

    const [body] = await collectMetering(bodies);
    expect(googleRequests[0].url).toContain("us-central1-aiplatform.googleapis.com");
    expect(body).toMatchObject({ modelSource: "GOOGLE_VERTEX_AI", inputTokenCount: 7 });
  });

  it("meters a chat created with usageMetadata once per message", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(9, 1))));
    const ai = await createClient();
    const chat = ai.chats.create({
      model: MODEL,
      usageMetadata: { subscriber: { id: "sub-chat" } },
    });

    await chat.sendMessage({ message: "Hi" });
    await chat.sendMessage({ message: "And again" });

    await collectMetering(bodies, 2);
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.subscriber)).toEqual([{ id: "sub-chat" }, { id: "sub-chat" }]);
    expect(googleRequests.map(({ body }) => body)).not.toContainEqual(
      expect.objectContaining({ usageMetadata: expect.anything() }),
    );
  });

  it("meters a streamed chat message with the chat's usageMetadata", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createSseResponse([geminiReply(9, 1)])));
    const ai = await createClient();
    const chat = ai.chats.create({
      model: MODEL,
      usageMetadata: { subscriber: { id: "sub-chat-stream" } },
    });

    await drain(await chat.sendMessageStream({ message: "Hi" }));

    const [body] = await collectMetering(bodies);
    expect(body).toMatchObject({
      isStreamed: true,
      inputTokenCount: 9,
      subscriber: { id: "sub-chat-stream" },
    });
    expect(googleRequests[0].body).not.toHaveProperty("usageMetadata");
  });

  it("sends one record when a second copy of the middleware loads against the same SDK", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(5, 1))));
    const sdk = await import("@google/genai");
    const ai = await createClient();
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@google/genai", () => sdk);
      const secondCopy = await import("../../../src/google/models-patch");
      secondCopy.patchGoogleGenAI();
    });
    jest.dontMock("@google/genai");

    await ai.models.generateContent({
      model: MODEL,
      contents: "Hello",
      usageMetadata: { subscriber: { id: "sub-once" } },
    });

    const [body] = await collectMetering(bodies);
    await settle();
    expect(bodies).toHaveLength(1);
    expect(body).toMatchObject({ subscriber: { id: "sub-once" } });
  });

  it("meters a client created before the middleware was imported", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(5, 1))));
    const ai = new GoogleGenAI({ apiKey: "google-api-key" });
    await importMiddleware();

    await ai.models.generateContent({ model: MODEL, contents: "Hello" });

    const [body] = await collectMetering(bodies);
    expect(body).toMatchObject({ model: MODEL, inputTokenCount: 5 });
  });

  it("records a Google failure on the customer's client as one error with zero tokens and rethrows it", async () => {
    const bodies = installRoutingFetch(
      routeGoogle(() =>
        createJsonResponse(
          { error: { code: 400, message: "Invalid image", status: "INVALID_ARGUMENT" } },
          400,
        ),
      ),
    );
    const ai = await createClient();

    await expect(ai.models.generateContent({ model: MODEL, contents: "Hello" })).rejects.toThrow(
      /Invalid image/,
    );

    const [body] = await collectMetering(bodies);
    expect(bodies).toHaveLength(1);
    expect(body).toMatchObject({ stopReason: "ERROR", inputTokenCount: 0, outputTokenCount: 0 });
  });

  it("refuses a call on the customer's client under a breached BLOCK cost control before Google is called", async () => {
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(5, 1))));
    const ai = await createClient();
    const { setRules, emptyEnforcementSnapshot } =
      await import("../../../src/_core/enforcement/cache");
    const { CostLimitExceeded } = await import("../../../src/_core/resilience/error-handler");
    const breachedBlockRule: EnforcementRule = {
      ruleId: 7,
      threshold: 10,
      currentValue: 42.5,
      periodType: "DAILY",
      action: "BLOCK",
      breached: true,
      shadowMode: false,
      filters: [],
    };
    setRules({ ...emptyEnforcementSnapshot(), rules: [breachedBlockRule] });

    await expect(
      ai.models.generateContent({ model: MODEL, contents: "Hello" }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);

    await settle();
    expect(googleRequests).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it("warns about a missing surface and keeps metering the rest", async () => {
    const warnings: { message: string; meta: unknown }[] = [];
    const manager = await import("../../../src/_core/config/manager");
    manager.setLogger({
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, meta?: unknown) => warnings.push({ message, meta }),
      error: () => undefined,
    } as Logger);
    const { Models } = await import("@google/genai");
    Reflect.deleteProperty(Models.prototype, "generateContentStreamInternal");
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(5, 1))));
    const ai = await createClient();
    const { isGoogleGenAIPatched } = await importMiddleware();

    await ai.models.generateContent({ model: MODEL, contents: "Hello" });

    await collectMetering(bodies);
    expect(bodies).toHaveLength(1);
    expect(warnings).toEqual([
      expect.objectContaining({ meta: { surface: "generateContentStreamInternal" } }),
    ]);
    expect(isGoogleGenAIPatched(ai)).toBe(false);
  });

  it("reports a client from another @google/genai copy as not metered", async () => {
    const ai = await createClient();
    const { isGoogleGenAIPatched } = await importMiddleware();
    let foreignClient!: GoogleGenAIClient;
    await jest.isolateModulesAsync(async () => {
      const foreignSdk = await import("@google/genai");
      foreignClient = new foreignSdk.GoogleGenAI({ apiKey: "google-api-key" });
    });

    expect(isGoogleGenAIPatched(ai)).toBe(true);
    expect(isGoogleGenAIPatched(foreignClient)).toBe(false);
  });

  it("meters a second middleware copy's controller with that copy's configuration", async () => {
    process.env.GOOGLE_API_KEY = "google-api-key";
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(9, 1))));
    const sdk = await import("@google/genai");
    await importMiddleware();
    let secondCopy!: Awaited<ReturnType<typeof importMiddleware>>;
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@google/genai", () => sdk);
      secondCopy = await importMiddleware();
      secondCopy.configure(createReveniumConfig({ reveniumApiKey: SECOND_COPY_API_KEY }));
    });
    jest.dontMock("@google/genai");

    await new secondCopy.GoogleGenAIController().createChat(["Hi"], MODEL);

    await collectMetering(bodies);
    expect(meteringApiKeys()).toEqual([SECOND_COPY_API_KEY]);
  });

  it("the GoogleGenAIController chat sends one record per message with the conversation sent on that turn", async () => {
    process.env.GOOGLE_API_KEY = "google-api-key";
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(9, 1))));
    const { GoogleGenAIController } = await importMiddleware();

    await new GoogleGenAIController().createChat(["Hi", "And again"], MODEL);

    await collectMetering(bodies, 2);
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.inputMessages).sort()).toEqual([
      "Hi",
      "Hi\n\nhi\n\nAnd again",
    ]);
  });

  it("the GoogleGenAIController records GOOGLE_VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is set", async () => {
    process.env.GOOGLE_API_KEY = "google-api-key";
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    const bodies = installRoutingFetch(routeGoogle(() => createJsonResponse(geminiReply(9, 1))));
    const { GoogleGenAIController } = await importMiddleware();

    await new GoogleGenAIController().createChat(["Hi"], MODEL);

    const [body] = await collectMetering(bodies);
    expect(googleRequests[0].url).toContain("aiplatform.googleapis.com");
    expect(body).toMatchObject({ modelSource: "GOOGLE_VERTEX_AI", inputTokenCount: 9 });
  });
});

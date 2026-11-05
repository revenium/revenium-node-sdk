import { generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createReveniumConfig, googleAuthLibraryPaths } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

const TOKEN_LIFETIME_MS = 3_600_000;
const ALREADY_EXPIRING_MS = 1_000;
const TOKEN_SERVICE_LATENCY_MS = 100;
const MAX_CONTROLLER_OVERHEAD_MS = 10;
const TIMED_CALLS = 20;
const OVERLAPPING_CALLS = 10;
const CHAT_AND_IMAGE_SIGN_INS = 2;

const VERTEX_HOST = "-aiplatform.googleapis.com/";

const CHAT_RESPONSE = {
  candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
};

const EMBEDDING_RESPONSE = {
  predictions: [{ embeddings: { values: [0.1, 0.2], statistics: { token_count: 1 } } }],
};

const IMAGE_RESPONSE = {
  predictions: [{ bytesBase64Encoded: "image", mimeType: "image/png" }],
};

const VIDEO_OPERATION = {
  name: "projects/test-project/locations/us-central1/operations/op-1",
  done: true,
  response: { videos: [{ bytesBase64Encoded: "video", mimeType: "video/mp4" }] },
};

type TokenExchange = { email: string };

const originalFetch = global.fetch;
let envSnapshot: NodeJS.ProcessEnv;
let credentialsDir: string;
let vertexFetch: jest.Mock;
let tokenExchanges: TokenExchange[];

function writeServiceAccountKey(name: string): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const path = join(credentialsDir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      project_id: "test-project",
      private_key_id: `${name}-key-id`,
      private_key: privateKey,
      client_email: `${name}@test-project.iam.gserviceaccount.com`,
      client_id: "1234567890",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  return path;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function vertexResponse(url: string): Response {
  if (url.includes(":streamGenerateContent")) {
    return new Response(`data: ${JSON.stringify(CHAT_RESPONSE)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (url.includes(":generateContent")) return jsonResponse(CHAT_RESPONSE);
  if (url.includes(":countTokens")) return jsonResponse({ totalTokens: 3 });
  if (url.includes("text-embedding-004:predict")) return jsonResponse(EMBEDDING_RESPONSE);
  if (url.includes(":predictLongRunning") || url.includes("/operations/")) {
    return jsonResponse(VIDEO_OPERATION);
  }
  if (url.includes(":predict")) return jsonResponse(IMAGE_RESPONSE);
  throw new Error(`Unexpected request to ${url}`);
}

function authorizationOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

function vertexCalls(): [string, RequestInit | undefined][] {
  return vertexFetch.mock.calls
    .map(([url, init]): [string, RequestInit | undefined] => [String(url), init])
    .filter(([url]) => url.includes(VERTEX_HOST));
}

function vertexAuthorizations(): string[] {
  return vertexCalls().map(([, init]) => authorizationOf(init) ?? "missing");
}

function vertexUrls(): string[] {
  return vertexCalls().map(([url]) => url);
}

async function countTokenExchanges(
  expiryFor: (exchange: number) => number,
  tokenServiceLatencyMs = 0,
): Promise<void> {
  for (const libraryPath of googleAuthLibraryPaths()) {
    const { JWT }: typeof import("google-auth-library") = await import(libraryPath);
    const jwtPrototype = JWT.prototype as unknown as {
      refreshTokenNoCache: () => Promise<unknown>;
    };
    jest.spyOn(jwtPrototype, "refreshTokenNoCache").mockImplementation(async function (
      this: InstanceType<typeof JWT>,
    ) {
      const exchange = tokenExchanges.push({ email: this.email ?? "" });
      await new Promise((resolve) => setTimeout(resolve, tokenServiceLatencyMs));
      return {
        res: null,
        tokens: {
          access_token: `token-${exchange}`,
          token_type: "Bearer",
          expiry_date: Date.now() + expiryFor(exchange),
        },
      };
    });
  }
}

async function loadController() {
  const { VertexAIController } = await import("../../../src/google/vertex/index");
  return new VertexAIController();
}

async function medianDurationMs(call: () => Promise<unknown>): Promise<number> {
  const durations: number[] = [];
  for (let index = 0; index < TIMED_CALLS; index++) {
    const startedAt = performance.now();
    await call();
    durations.push(performance.now() - startedAt);
  }
  return durations.sort((left, right) => left - right)[Math.floor(TIMED_CALLS / 2)];
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) {
    void chunk;
  }
}

beforeEach(async () => {
  jest.resetModules();
  envSnapshot = { ...process.env };
  credentialsDir = mkdtempSync(join(tmpdir(), "vertex-credentials-"));
  Object.assign(process.env, {
    GOOGLE_CLOUD_PROJECT: "test-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_APPLICATION_CREDENTIALS: writeServiceAccountKey("primary"),
  });

  tokenExchanges = [];
  vertexFetch = jest.fn((url: string | URL) =>
    String(url).includes(VERTEX_HOST)
      ? Promise.resolve(vertexResponse(String(url)))
      : Promise.reject(new Error(`Unreachable host ${String(url)}`)),
  );
  global.fetch = vertexFetch;

  const manager = await import("../../../src/_core/config/manager");
  manager.setConfig(createReveniumConfig());
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = envSnapshot;
  rmSync(credentialsDir, { recursive: true, force: true });
});

describe("Vertex AI access token reuse with the real Google auth libraries", () => {
  it("20 controller chat calls make exactly one Google token request", async () => {
    await countTokenExchanges(() => TOKEN_LIFETIME_MS);
    const controller = await loadController();

    for (let call = 0; call < 20; call++) {
      await controller.createChat(["hi"], "gemini-2.0-flash-001");
    }

    expect(tokenExchanges).toHaveLength(1);
    expect(vertexAuthorizations()).toEqual(Array(20).fill("Bearer token-1"));
  });

  it("controller chat calls take within a few milliseconds of a reused client while the token service is slow", async () => {
    await countTokenExchanges(() => TOKEN_LIFETIME_MS, TOKEN_SERVICE_LATENCY_MS);
    const { VertexAIService } = await import("../../../src/google/vertex/service");
    const reusedService = new VertexAIService("gemini-2.0-flash-001");
    const controller = await loadController();

    const reusedMedianMs = await medianDurationMs(() => reusedService.createChat(["hi"]));
    const controllerMedianMs = await medianDurationMs(() =>
      controller.createChat(["hi"], "gemini-2.0-flash-001"),
    );

    expect(controllerMedianMs - reusedMedianMs).toBeLessThan(MAX_CONTROLLER_OVERHEAD_MS);
  }, 20000);

  it("repeated chat, streaming, embedding, image and video calls keep reusing the cached tokens", async () => {
    await countTokenExchanges(() => TOKEN_LIFETIME_MS);
    const controller = await loadController();

    for (let round = 0; round < 2; round++) {
      await controller.createChat(["hi"], "gemini-2.0-flash-001");
      await drain((await controller.createStreaming(["hi"], "gemini-2.5-pro")).stream);
      await controller.createEmbedding("hi", "text-embedding-004");
      await controller.generateImage({ model: "imagen-3.0-generate-002", prompt: "a cat" });
      await controller.generateVideo({
        model: "veo-3.0-generate-001",
        prompt: "a cat",
        duration: 8,
      });
    }

    expect(tokenExchanges).toHaveLength(2);
    expect(new Set(vertexAuthorizations())).toEqual(new Set(["Bearer token-1", "Bearer token-2"]));
  }, 20000);

  it.each([
    [
      "chat",
      (controller: Awaited<ReturnType<typeof loadController>>) =>
        controller.createChat(["hi"], "gemini-2.0-flash-001"),
    ],
    [
      "image",
      (controller: Awaited<ReturnType<typeof loadController>>) =>
        controller.generateImage({ model: "imagen-3.0-generate-002", prompt: "a cat" }),
    ],
  ])(
    "an expiring token is replaced once on the next %s call, which succeeds",
    async (_operation, call) => {
      await countTokenExchanges((exchange) =>
        exchange === 1 ? ALREADY_EXPIRING_MS : TOKEN_LIFETIME_MS,
      );
      const controller = await loadController();

      await call(controller);
      await expect(call(controller)).resolves.toBeDefined();
      await call(controller);

      expect(tokenExchanges).toHaveLength(2);
      expect(vertexAuthorizations()).toEqual([
        "Bearer token-1",
        "Bearer token-2",
        "Bearer token-2",
      ]);
    },
  );

  it("overlapping chat and image calls make one token request per sign-in, before the first token and when it expires", async () => {
    await countTokenExchanges(
      (exchange) => (exchange <= CHAT_AND_IMAGE_SIGN_INS ? ALREADY_EXPIRING_MS : TOKEN_LIFETIME_MS),
      TOKEN_SERVICE_LATENCY_MS,
    );
    const controller = await loadController();
    const overlappingCalls = () =>
      Promise.all(
        Array.from({ length: OVERLAPPING_CALLS }).flatMap(() => [
          controller.createChat(["hi"], "gemini-2.0-flash-001"),
          controller.generateImage({ model: "imagen-3.0-generate-002", prompt: "a cat" }),
        ]),
      );

    await overlappingCalls();
    await overlappingCalls();

    expect(tokenExchanges).toHaveLength(2 * CHAT_AND_IMAGE_SIGN_INS);
    expect(vertexCalls()).toHaveLength(4 * OVERLAPPING_CALLS);
  });

  it("a video operation polls with a refreshed token once its starting token expires", async () => {
    await countTokenExchanges((exchange) =>
      exchange === 1 ? ALREADY_EXPIRING_MS : TOKEN_LIFETIME_MS,
    );
    const controller = await loadController();

    await expect(
      controller.generateVideo({ model: "veo-3.0-generate-001", prompt: "a cat", duration: 8 }),
    ).resolves.toBeDefined();

    expect(tokenExchanges).toHaveLength(2);
    expect(vertexAuthorizations()).toEqual(["Bearer token-1", "Bearer token-2"]);
  }, 20000);

  it("each project and location keeps its own client, URL and cached token", async () => {
    await countTokenExchanges(() => TOKEN_LIFETIME_MS);
    const controller = await loadController();

    for (let round = 0; round < 2; round++) {
      await controller.createChat(["hi"], "gemini-2.0-flash-001");
      await controller.createChat(
        ["hi"],
        "gemini-2.0-flash-001",
        undefined,
        "other-project",
        "europe-west4",
      );
    }

    expect(tokenExchanges).toHaveLength(2);
    const [defaultTarget, otherTarget] = vertexUrls();
    expect(defaultTarget).toMatch(
      /^https:\/\/us-central1-aiplatform\.googleapis\.com\/[^/]+\/projects\/test-project\/locations\/us-central1\//,
    );
    expect(otherTarget).toMatch(
      /^https:\/\/europe-west4-aiplatform\.googleapis\.com\/[^/]+\/projects\/other-project\/locations\/europe-west4\//,
    );
    expect(vertexUrls()).toEqual([defaultTarget, otherTarget, defaultTarget, otherTarget]);
  });

  it("pointing GOOGLE_APPLICATION_CREDENTIALS at another key file signs in with that key", async () => {
    await countTokenExchanges(() => TOKEN_LIFETIME_MS);
    const controller = await loadController();
    const rotatedKeyFile = writeServiceAccountKey("rotated");

    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    await controller.createChat(["hi"], "gemini-2.0-flash-001");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = rotatedKeyFile;
    await controller.createChat(["hi"], "gemini-2.0-flash-001");

    expect(tokenExchanges.map(({ email }) => email)).toEqual([
      "primary@test-project.iam.gserviceaccount.com",
      "rotated@test-project.iam.gserviceaccount.com",
    ]);
    expect(vertexAuthorizations()).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import type { GenerateContentResponseUsageMetadata, Part } from "@google/genai";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ReveniumConfig, ReveniumPayload, OperationType } from "../../src/_core/types/index";
import { LiteLLMConfig } from "../../src/litellm/types";
import { ENV_VARS } from "../../src/_core/constants";

export const REVENIUM_BASE_URL = "https://api.revenium.ai";

export type MeteringBody = Record<string, unknown>;

const REVENIUM_ENVIRONMENT_KEYS = [
  ENV_VARS.REVENIUM_API_KEY,
  ENV_VARS.REVENIUM_API_KEY_ALT,
  ENV_VARS.REVENIUM_BASE_URL,
  ENV_VARS.REVENIUM_BASE_URL_ALT,
  ENV_VARS.TEAM_ID,
  ENV_VARS.PRINT_SUMMARY,
  ENV_VARS.ENFORCEMENT_BASE_URL,
  ENV_VARS.CAPTURE_PROMPTS,
];

export function useIsolatedReveniumEnvironment(): void {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    for (const key of REVENIUM_ENVIRONMENT_KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });
}

export function runInWorkingDir(
  files: Record<string, Record<string, string>>,
  run: (workingDir: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "revenium-env-"));
  const workingDir = join(root, "app");
  mkdirSync(workingDir);
  const originalCwd = process.cwd();

  for (const [relativePath, values] of Object.entries(files)) {
    writeFileSync(
      join(root, relativePath),
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }

  try {
    process.chdir(workingDir);
    run(workingDir);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

export function createLiteLLMConfig(overrides: Partial<LiteLLMConfig> = {}): LiteLLMConfig {
  return {
    reveniumMeteringApiKey: "hak_test_key",
    reveniumMeteringBaseUrl: "https://api.revenium.ai",
    litellmProxyUrl: "http://localhost:4000",
    ...overrides,
  };
}

export function createReveniumConfig(overrides: Partial<ReveniumConfig> = {}): ReveniumConfig {
  return {
    reveniumApiKey: "hak_tenant_abc123xyz",
    reveniumBaseUrl: "https://api.revenium.ai",
    ...overrides,
  };
}

export function createPayload(overrides: Partial<ReveniumPayload> = {}): ReveniumPayload {
  return {
    transactionId: "txn-001",
    operationType: "CHAT" as OperationType,
    costType: "AI",
    model: "gpt-4",
    provider: "OpenAI",
    modelSource: "OPENAI",
    middlewareSource: "revenium-openai-node",
    requestTime: new Date().toISOString(),
    responseTime: new Date().toISOString(),
    requestDuration: 1500,
    completionStartTime: new Date().toISOString(),
    inputTokenCount: 100,
    outputTokenCount: 50,
    totalTokenCount: 150,
    reasoningTokenCount: undefined,
    cacheCreationTokenCount: undefined,
    cacheReadTokenCount: undefined,
    stopReason: "END",
    isStreamed: false,
    ...overrides,
  };
}

export function createMockFetch(
  response: Omit<Partial<Response>, "headers"> & {
    headers?: Record<string, string>;
    jsonBody?: unknown;
  } = {},
): jest.Mock {
  const { headers: headerOverrides, jsonBody, ...rest } = response;
  const headerMap = new Map(Object.entries(headerOverrides ?? {}));
  return jest.fn(() => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(jsonBody ?? {}),
      text: () => Promise.resolve(jsonBody === undefined ? "" : JSON.stringify(jsonBody)),
      headers: {
        get: (name: string) => headerMap.get(name) ?? null,
        entries: () => headerMap.entries(),
      },
      clone: () => mockResponse,
      ...rest,
    } as unknown as Response;
    return Promise.resolve(mockResponse);
  });
}

export function createHungFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
}

export function installRoutingFetch(
  providerResponse: (url: string, init?: RequestInit) => Response,
  meteringReply: unknown = {},
): MeteringBody[] {
  const meteringBodies: MeteringBody[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(REVENIUM_BASE_URL)) {
      meteringBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(meteringReply), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return providerResponse(String(url), init);
  }) as unknown as typeof fetch;
  return meteringBodies;
}

export async function waitForMetering(
  bodies: MeteringBody[],
  expectedCount = 1,
): Promise<MeteringBody> {
  for (let attempt = 0; attempt < 100 && bodies.length < expectedCount; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (bodies.length < expectedCount) throw new Error("Timed out waiting for metering requests");
  return bodies[0];
}

export async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) {
    void chunk;
  }
}

export function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createSseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function createGeminiReply(
  usageMetadata: GenerateContentResponseUsageMetadata,
  parts: Part[] = [{ text: "hi" }],
) {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata,
  };
}

export function googleAuthLibraryPaths(): string[] {
  const genaiDirectory = dirname(require.resolve("@google/genai"));
  return [
    ...new Set([
      require.resolve("google-auth-library"),
      require.resolve("google-auth-library", { paths: [genaiDirectory] }),
    ]),
  ];
}

export function stubGoogleAuth(): void {
  for (const libraryPath of googleAuthLibraryPaths()) {
    jest.doMock(libraryPath, () => ({
      GoogleAuth: jest.fn().mockImplementation(() => ({
        getClient: () => Promise.resolve({ getAccessToken: () => ({ token: "access-token" }) }),
        getRequestHeaders: () =>
          Promise.resolve(new Map([["Authorization", "Bearer access-token"]])),
      })),
    }));
  }
}

import { ReveniumConfig, ReveniumPayload, OperationType } from "../../src/_core/types/index";
import { LiteLLMConfig } from "../../src/litellm/types";

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
      headers: { get: (name: string) => headerMap.get(name) ?? null },
      clone: () => mockResponse,
      ...rest,
    } as unknown as Response;
    return Promise.resolve(mockResponse);
  });
}

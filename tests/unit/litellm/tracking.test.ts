import { createReveniumConfig, createMockFetch } from "../../helpers/fixtures";
import type { LiteLLMConfig } from "../../../src/litellm/types";

const originalFetch = global.fetch;

let sendReveniumMetrics: typeof import("../../../src/litellm/tracking").sendReveniumMetrics;
let extractUsageFromResponse: typeof import("../../../src/litellm/tracking").extractUsageFromResponse;
let extractMetadataFromHeaders: typeof import("../../../src/litellm/tracking").extractMetadataFromHeaders;
let setLiteLLMConfig: typeof import("../../../src/litellm/http-client").setLiteLLMConfig;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const testLiteLLMConfig: LiteLLMConfig = {
  reveniumMeteringApiKey: "hak_test_key",
  reveniumMeteringBaseUrl: "https://api.revenium.ai",
  litellmProxyUrl: "http://localhost:4000",
};

const baseMetrics = {
  requestId: "req-001",
  model: "openai/gpt-4",
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  duration: 1500,
  finishReason: "stop",
  isStreamed: false,
};

beforeEach(async () => {
  jest.resetModules();
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const tracking = await import("../../../src/litellm/tracking");
  const httpClient = await import("../../../src/litellm/http-client");

  sendReveniumMetrics = tracking.sendReveniumMetrics;
  extractUsageFromResponse = tracking.extractUsageFromResponse;
  extractMetadataFromHeaders = tracking.extractMetadataFromHeaders;
  setLiteLLMConfig = httpClient.setLiteLLMConfig;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;

  setConfig(createReveniumConfig());
  setLiteLLMConfig(testLiteLLMConfig);
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.AWS_REGION;
  resetConfig();
  jest.restoreAllMocks();
});

describe("sendReveniumMetrics token field names", () => {
  it("sends inputTokenCount not inputTokens", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics(baseMetrics);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("inputTokenCount", 100);
    expect(body).not.toHaveProperty("inputTokens");
  });

  it("sends outputTokenCount not outputTokens", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics(baseMetrics);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("outputTokenCount", 50);
    expect(body).not.toHaveProperty("outputTokens");
  });

  it("sends totalTokenCount not totalTokens", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics(baseMetrics);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("totalTokenCount", 150);
    expect(body).not.toHaveProperty("totalTokens");
  });

  it("preserves zero token counts without dropping fields", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("inputTokenCount", 0);
    expect(body).toHaveProperty("outputTokenCount", 0);
    expect(body).toHaveProperty("totalTokenCount", 0);
  });

  it("sends all three token count fields with correct values", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      promptTokens: 200,
      completionTokens: 75,
      totalTokens: 275,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      inputTokenCount: 200,
      outputTokenCount: 75,
      totalTokenCount: 275,
    });
    expect(body).not.toHaveProperty("inputTokens");
    expect(body).not.toHaveProperty("outputTokens");
    expect(body).not.toHaveProperty("totalTokens");
  });

  it("sets outputTokenCount to 0 for embedding operations", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics, operationType: "EMBED" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("outputTokenCount", 0);
    expect(body).toHaveProperty("operationType", "EMBED");
  });

  it("sends cached prompt tokens as cache read tokens, and omits cache creation when unknown", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics, cachedTokens: 42 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // cacheCreationTokens wasn't provided -- must stay unknown (undefined), not assert 0.
    expect(body).not.toHaveProperty("cacheCreationTokenCount");
    expect(body).toHaveProperty("cacheReadTokenCount", 42);
  });

  it("sends cache creation tokens when provided", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics, cachedTokens: 15, cacheCreationTokens: 7880 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("cacheCreationTokenCount", 7880);
    expect(body).toHaveProperty("cacheReadTokenCount", 15);
  });

  it("omits both cache fields when neither is known", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("cacheCreationTokenCount");
    expect(body).not.toHaveProperty("cacheReadTokenCount");
  });

  it("extracts OpenAI-compatible cached prompt tokens from response usage", () => {
    const usage = extractUsageFromResponse({
      id: "chatcmpl-001",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 33 },
      },
    });

    expect(usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 33,
      finishReason: "stop",
    });
    expect(usage.cacheCreationTokens).toBeUndefined();
  });

  it("extracts Anthropic-native cache fields when LiteLLM surfaces them unnormalized", () => {
    const usage = extractUsageFromResponse({
      id: "chatcmpl-002",
      object: "chat.completion",
      created: 1,
      model: "anthropic/claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        cache_read_input_tokens: 21808,
        cache_creation_input_tokens: 7880,
      } as any,
    });

    expect(usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cachedTokens: 21808,
      cacheCreationTokens: 7880,
      finishReason: "stop",
    });
  });

  it("returns undefined cache fields when usage is missing entirely", () => {
    const usage = extractUsageFromResponse({
      id: "chatcmpl-003",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    expect(usage.cachedTokens).toBeUndefined();
    expect(usage.cacheCreationTokens).toBeUndefined();
  });

  it("tolerates null cache fields on the usage object", () => {
    const usage = extractUsageFromResponse({
      id: "chatcmpl-004",
      object: "chat.completion",
      created: 1,
      model: "anthropic/claude-sonnet-4-5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_input_tokens: null as any,
        cache_creation_input_tokens: null as any,
        prompt_tokens_details: null as any,
      },
    });

    expect(usage.cachedTokens).toBeUndefined();
    expect(usage.cacheCreationTokens).toBeUndefined();
  });
});

describe("sendReveniumMetrics skill attribution", () => {
  it("sends the skill fields as camelCase when set in usageMetadata", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: {
        skillName: "quarterly-report",
        skillSource: "projectSettings",
        skill_kind: "workflow",
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("skillName", "quarterly-report");
    expect(body).toHaveProperty("skillSource", "projectSettings");
    expect(body).toHaveProperty("skillKind", "workflow");
    expect(body).not.toHaveProperty("skill_kind");
  });

  it("omits the skill fields when the caller sets none", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics, usageMetadata: { taskType: "synthesis" } });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("skillName");
    expect(body).not.toHaveProperty("skillSource");
    expect(body).not.toHaveProperty("skillKind");
    expect(body).not.toHaveProperty("skillPluginName");
    expect(body).not.toHaveProperty("skillMarketplaceName");
    expect(body).not.toHaveProperty("skillInvocationTrigger");
  });
});

describe("extractMetadataFromHeaders skill headers", () => {
  it("extracts all six skill headers into camelCase metadata", () => {
    const metadata = extractMetadataFromHeaders({
      "x-revenium-skill-name": "quarterly-report",
      "x-revenium-skill-source": "projectSettings",
      "x-revenium-skill-kind": "workflow",
      "x-revenium-skill-plugin-name": "reporting-tools",
      "x-revenium-skill-marketplace-name": "acme-marketplace",
      "x-revenium-skill-invocation-trigger": "user-slash",
    });

    expect(metadata).toMatchObject({
      skillName: "quarterly-report",
      skillSource: "projectSettings",
      skillKind: "workflow",
      skillPluginName: "reporting-tools",
      skillMarketplaceName: "acme-marketplace",
      skillInvocationTrigger: "user-slash",
    });
  });

  it("leaves the skill fields unset when the headers are absent", () => {
    const metadata = extractMetadataFromHeaders({ "x-revenium-task-type": "synthesis" });

    expect(metadata.taskType).toBe("synthesis");
    expect(metadata.skillName).toBeUndefined();
    expect(metadata.skillSource).toBeUndefined();
    expect(metadata.skillKind).toBeUndefined();
    expect(metadata.skillPluginName).toBeUndefined();
    expect(metadata.skillMarketplaceName).toBeUndefined();
    expect(metadata.skillInvocationTrigger).toBeUndefined();
  });

  it("sends header-supplied skill attribution on the metering body", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-skill-name": "quarterly-report",
        "x-revenium-skill-invocation-trigger": "user-slash",
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveProperty("skillName", "quarterly-report");
    expect(body).toHaveProperty("skillInvocationTrigger", "user-slash");
    expect(body).not.toHaveProperty("skillKind");
  });
});

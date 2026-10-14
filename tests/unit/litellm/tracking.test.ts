import { createReveniumConfig, createLiteLLMConfig, createMockFetch } from "../../helpers/fixtures";

const originalFetch = global.fetch;

let sendReveniumMetrics: typeof import("../../../src/litellm/tracking").sendReveniumMetrics;
let extractUsageFromResponse: typeof import("../../../src/litellm/tracking").extractUsageFromResponse;
let extractMetadataFromHeaders: typeof import("../../../src/litellm/tracking").extractMetadataFromHeaders;
let setLiteLLMConfig: typeof import("../../../src/litellm/http-client").setLiteLLMConfig;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

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
  setLiteLLMConfig(createLiteLLMConfig());
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
    const usage = extractUsageFromResponse(
      {
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
      },
      "openai/gpt-4o-mini",
    );

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
    const usage = extractUsageFromResponse(
      {
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
          prompt_tokens: 29698,
          completion_tokens: 20,
          total_tokens: 29718,
          cache_read_input_tokens: 21808,
          cache_creation_input_tokens: 7880,
        } as any,
      },
      "anthropic/claude-sonnet-4-5",
    );

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
    const usage = extractUsageFromResponse(
      {
        id: "chatcmpl-003",
        object: "chat.completion",
        created: 1,
        model: "openai/gpt-4o-mini",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
      },
      "openai/gpt-4o-mini",
    );

    expect(usage.cachedTokens).toBeUndefined();
    expect(usage.cacheCreationTokens).toBeUndefined();
  });

  it("tolerates null cache fields on the usage object", () => {
    const usage = extractUsageFromResponse(
      {
        id: "chatcmpl-004",
        object: "chat.completion",
        created: 1,
        model: "anthropic/claude-sonnet-4-5",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cache_read_input_tokens: null as any,
          cache_creation_input_tokens: null as any,
          prompt_tokens_details: null as any,
        },
      },
      "anthropic/claude-sonnet-4-5",
    );

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

describe("sendReveniumMetrics stop reason", () => {
  async function meteredStopReason(finishReason: string): Promise<string> {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics, finishReason });

    return JSON.parse(mockFetch.mock.calls[0][1].body).stopReason;
  }

  it("meters a content-filter stop as CONTENT_FILTER", async () => {
    await expect(meteredStopReason("content_filter")).resolves.toBe("CONTENT_FILTER");
  });

  it("meters a token-limit stop as TOKEN_LIMIT", async () => {
    await expect(meteredStopReason("length")).resolves.toBe("TOKEN_LIMIT");
  });
});

describe("sendReveniumMetrics failure handling", () => {
  it("surfaces a failed metering send instead of swallowing it", async () => {
    setConfig(createReveniumConfig({ maxRetries: 0 }));
    global.fetch = createMockFetch({ ok: false, status: 503, statusText: "Service Unavailable" });

    await expect(sendReveniumMetrics(baseMetrics)).rejects.toThrow("Revenium API error: 503");
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

describe("sendReveniumMetrics subscriber attribution", () => {
  it("emits a subscriber from the id alone", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({ "x-revenium-subscriber-id": "user-42" }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subscriber).toEqual({ id: "user-42" });
  });

  it("emits a subscriber from the email alone", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-subscriber-email": "user42@example.com",
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subscriber).toEqual({ email: "user42@example.com" });
  });

  it("emits no subscriber from a credential name with no value", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-subscriber-credential-name": "api-key",
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("subscriber");
  });

  it("merges flat subscriber fields onto a structured subscriber", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: {
        subscriber: { email: "nested@example.com" },
        subscriberId: "user-42",
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subscriber).toEqual({ id: "user-42", email: "nested@example.com" });
  });

  it("emits no subscriber for an empty structured subscriber", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({ ...baseMetrics, usageMetadata: { subscriber: {} } });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("subscriber");
  });

  it("emits a partial subscriber from id and email alone", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-subscriber-id": "user-42",
        "x-revenium-subscriber-email": "user42@example.com",
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subscriber).toEqual({ id: "user-42", email: "user42@example.com" });
    expect(body.subscriber).not.toHaveProperty("credential");
  });

  it("omits credential when only its name is present", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-subscriber-id": "user-42",
        "x-revenium-subscriber-credential-name": "api-key",
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subscriber).toEqual({ id: "user-42" });
  });

  it("emits no subscriber when no identity is supplied", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({ "x-revenium-task-type": "synthesis" }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("subscriber");
  });

  it("emits the structured subscriber supplied as metadata", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: { subscriber: { email: "nested@example.com" } },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subscriber).toEqual({ email: "nested@example.com" });
  });
});

describe("sendReveniumMetrics job and ticket attribution", () => {
  const JOB_ENV_VARS = [
    "REVENIUM_AGENTIC_JOB_ID",
    "REVENIUM_AGENTIC_JOB_NAME",
    "REVENIUM_AGENTIC_JOB_TYPE",
    "REVENIUM_AGENTIC_JOB_VERSION",
  ];

  afterEach(() => {
    for (const name of JOB_ENV_VARS) delete process.env[name];
  });

  it("tags a LiteLLM call made inside a job context", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const { runWithJobContext } = await import("../../../src/_core/jobs/job-context");

    await runWithJobContext(
      {
        agenticJobId: "job-wiring-1",
        agenticJobName: "nightly-summary",
        agenticJobType: "batch",
        agenticJobVersion: "2.1.0",
      },
      () => sendReveniumMetrics(baseMetrics),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      agenticJobId: "job-wiring-1",
      agenticJobName: "nightly-summary",
      agenticJobType: "batch",
      agenticJobVersion: "2.1.0",
    });
  });

  it("tags a LiteLLM call from the job environment variables", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    process.env.REVENIUM_AGENTIC_JOB_ID = "env-job-1";
    process.env.REVENIUM_AGENTIC_JOB_NAME = "env-job-name";
    process.env.REVENIUM_AGENTIC_JOB_TYPE = "scheduled";
    process.env.REVENIUM_AGENTIC_JOB_VERSION = "1.0.0";

    await sendReveniumMetrics(baseMetrics);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      agenticJobId: "env-job-1",
      agenticJobName: "env-job-name",
      agenticJobType: "scheduled",
      agenticJobVersion: "1.0.0",
    });
  });

  it("lets per-request job headers override the job context", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const { runWithJobContext } = await import("../../../src/_core/jobs/job-context");

    await runWithJobContext({ agenticJobId: "context-job", agenticJobType: "batch" }, () =>
      sendReveniumMetrics({
        ...baseMetrics,
        usageMetadata: extractMetadataFromHeaders({ "x-revenium-agentic-job-id": "job-1" }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ agenticJobId: "job-1", agenticJobType: "batch" });
  });

  it("carries the ticket and job headers", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-ticket-id": "ENG-123",
        "x-revenium-agentic-job-id": "job-1",
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ ticketId: "ENG-123", agenticJobId: "job-1" });
  });

  it("drops a job id header the metering API would reject and keeps the job context", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const { runWithJobContext } = await import("../../../src/_core/jobs/job-context");

    await runWithJobContext({ agenticJobId: "context-job" }, () =>
      sendReveniumMetrics({
        ...baseMetrics,
        usageMetadata: extractMetadataFromHeaders({ "x-revenium-agentic-job-id": "run 77" }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.agenticJobId).toBe("context-job");
  });

  it("keeps the job context descriptors when a rejected job id header carries its own", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const { runWithJobContext } = await import("../../../src/_core/jobs/job-context");

    await runWithJobContext({ agenticJobId: "context-job", agenticJobName: "context-name" }, () =>
      sendReveniumMetrics({
        ...baseMetrics,
        usageMetadata: extractMetadataFromHeaders({
          "x-revenium-agentic-job-id": "run 77",
          "x-revenium-agentic-job-name": "header-name",
        }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.agenticJobId).toBe("context-job");
    expect(body.agenticJobName).toBe("context-name");
  });

  it("truncates an oversized ticket id header", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({ "x-revenium-ticket-id": "T".repeat(300) }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.ticketId).toBe("T".repeat(256));
  });

  it("ignores a non-numeric retry number header", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendReveniumMetrics({
      ...baseMetrics,
      usageMetadata: extractMetadataFromHeaders({ "x-revenium-retry-number": "second" }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.retryNumber).toBe(0);
  });

  it("attributes an embeddings call to the subscriber and job in its headers", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const { trackEmbeddingsUsageAsync } = await import("../../../src/litellm/tracking");

    trackEmbeddingsUsageAsync({
      requestId: "req-embed",
      model: "openai/text-embedding-3-small",
      promptTokens: 20,
      totalTokens: 20,
      duration: 100,
      usageMetadata: extractMetadataFromHeaders({
        "x-revenium-subscriber-id": "user-42",
        "x-revenium-agentic-job-id": "job-1",
      }),
    });

    await new Promise((resolve) => setImmediate(resolve));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      operationType: "EMBED",
      agenticJobId: "job-1",
      subscriber: { id: "user-42" },
    });
  });
});

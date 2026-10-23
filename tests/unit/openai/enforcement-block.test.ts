import type OpenAI from "openai";
import { getConfig, initializeConfig, resetConfig } from "../../../src/_core/config/manager";
import { ENV_VARS } from "../../../src/_core/constants";
import { getRules } from "../../../src/_core/enforcement/cache";
import {
  startEnforcementPolling,
  stopEnforcementPolling,
} from "../../../src/_core/enforcement/engine";
import { resetEnforcementCircuitBreaker } from "../../../src/_core/resilience/circuit-breaker";
import { CostLimitExceeded } from "../../../src/_core/resilience/error-handler";
import { CompletionsInterface } from "../../../src/openai/middleware";
import { Provider, type ProviderInfo } from "../../../src/openai/provider-detection";
import type { Config, Credential } from "../../../src/_core/types/index";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

const TEAM_ID = "Ol3wbl";
const SERVED_URL = `https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/${TEAM_ID}`;

const breachedBlockRule = {
  ruleId: 39053,
  name: "B3 readback probe 137",
  threshold: 10,
  currentValue: 42.5,
  periodType: "DAILY",
  action: "BLOCK",
  breached: true,
  shadowMode: false,
};

const perPersonRule = {
  ruleId: 39054,
  name: "per-person cap",
  threshold: 5,
  currentValue: 8.5,
  periodType: "DAILY",
  action: "BLOCK",
  breached: true,
  shadowMode: false,
  groupBy: "SUBSCRIBER",
  groupBreakdown: [
    { groupValue: "alice@example.com", currentValue: 7.5, breached: true },
    { groupValue: "bob@example.com", currentValue: 1, breached: false },
  ],
};

const departmentRule = {
  ruleId: 39055,
  name: "department cap",
  threshold: 5,
  currentValue: 7.5,
  periodType: "DAILY",
  action: "BLOCK",
  breached: true,
  shadowMode: false,
  groupBy: "SUBSCRIBER",
  departmentId: 173,
};

const providerInfo: ProviderInfo = { provider: Provider.OPENAI, isAzure: false };

function respondWith(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

describe("enforcement blocks an OpenAI chat call with README-only configuration", () => {
  let providerCreate: jest.Mock;
  let client: OpenAI;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_test";
    process.env[ENV_VARS.REVENIUM_BASE_URL] = "https://api.dev.hcapp.io";
    process.env[ENV_VARS.TEAM_ID] = TEAM_ID;
    delete process.env[ENV_VARS.ENFORCEMENT_BASE_URL];

    resetConfig();
    resetEnforcementCircuitBreaker();
    initializeConfig();

    servePayload({ rules: [breachedBlockRule] });

    providerCreate = jest.fn().mockResolvedValue({
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    client = { chat: { completions: { create: providerCreate } } } as unknown as OpenAI;
  });

  afterEach(() => {
    stopEnforcementPolling();
    resetConfig();
    resetEnforcementCircuitBreaker();
    jest.useRealTimers();
    delete process.env[ENV_VARS.REVENIUM_API_KEY];
    delete process.env[ENV_VARS.REVENIUM_BASE_URL];
    delete process.env[ENV_VARS.TEAM_ID];
  });

  function servePayload(payload: unknown): void {
    global.fetch = jest.fn((input: unknown) =>
      Promise.resolve(input === SERVED_URL ? respondWith(200, payload) : respondWith(404)),
    ) as unknown as typeof fetch;
  }

  function chatParams(): OpenAI.ChatCompletionCreateParamsNonStreaming {
    return { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  }

  async function loadRules(): Promise<void> {
    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);
  }

  it("loads the team cost controls without an enforcement base override", async () => {
    await loadRules();

    expect(getConfig()?.reveniumEnforcementBaseUrl).toBeUndefined();
    expect(getRules()).toHaveLength(1);
  });

  it("stops a non-streaming chat completion before the provider is called", async () => {
    await loadRules();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);

    await expect(
      completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("stops a streaming chat completion before the provider is called", async () => {
    await loadRules();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);

    await expect(
      completions.createStreaming({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("lets a non-breached person through a per-person cap", async () => {
    servePayload({ rules: [perPersonRule] });
    await loadRules();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);
    await completions.create(chatParams(), { subscriber: { email: "bob@example.com" } });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("stops only the breached person on a per-person cap", async () => {
    servePayload({ rules: [perPersonRule] });
    await loadRules();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);

    await expect(
      completions.create(chatParams(), { subscriber: { email: "alice@example.com" } }),
    ).rejects.toThrow("Cost limit exceeded: $7.50 of $5.00 daily limit reached");
    expect(providerCreate).not.toHaveBeenCalled();
  });

  function serveDepartmentCap(): void {
    servePayload({
      rules: [departmentRule],
      departmentBudgetBlocks: { "bob@example.com": 39055 },
      departmentBudgetBlockBalances: { "bob@example.com": 6.25 },
    });
  }

  it("stops a department-capped person with their own balance", async () => {
    serveDepartmentCap();
    await loadRules();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);

    await expect(
      completions.createStreaming(
        { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true },
        { subscriber: { email: "bob@example.com" } },
      ),
    ).rejects.toThrow("Cost limit exceeded: $6.25 of $5.00 daily limit reached");
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("lets a person outside the department through a department cap", async () => {
    serveDepartmentCap();
    await loadRules();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);
    await completions.create(chatParams(), { subscriber: { email: "carol@example.com" } });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  async function loadFilteredCap(dimension: string, value: string): Promise<CompletionsInterface> {
    servePayload({
      rules: [
        {
          ...breachedBlockRule,
          filters: [{ dimension, operator: "IS", value, values: [] }],
        },
      ],
    });
    await loadRules();

    return new CompletionsInterface(client, getConfig() as Config, providerInfo);
  }

  it("lets the call through when the breached cap is filtered on another provider", async () => {
    const completions = await loadFilteredCap("PROVIDER", "anthropic");

    await expect(completions.create(chatParams())).resolves.toBeDefined();
    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("still blocks when the breached cap is filtered on this provider", async () => {
    const completions = await loadFilteredCap("PROVIDER", "openai");

    await expect(completions.create(chatParams())).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("blocks only the model a model-filtered cap names", async () => {
    const completions = await loadFilteredCap("MODEL", "gpt-4o");

    await expect(completions.create(chatParams())).rejects.toBeInstanceOf(CostLimitExceeded);
    await completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks only the agent an agent-filtered cap names", async () => {
    const completions = await loadFilteredCap("AGENT", "batch-bot");

    await expect(completions.create(chatParams(), { agent: "batch-bot" })).rejects.toBeInstanceOf(
      CostLimitExceeded,
    );
    await completions.create(chatParams(), { agent: "chat-bot" });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("matches a credential-filtered cap on the alias, never on the raw key", async () => {
    const completions = await loadFilteredCap("CREDENTIAL", "sk-proj-secret");

    await completions.create(chatParams(), {
      subscriber: { email: "bob@example.com", credential: { name: "", value: "sk-proj-secret" } },
    });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks only the alias a credential-filtered cap names", async () => {
    const completions = await loadFilteredCap("CREDENTIAL", "prod-key");

    await expect(
      completions.create(chatParams(), {
        subscriber: { credential: { name: "prod-key", value: "sk-proj-secret" } },
      }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    await completions.create(chatParams(), {
      subscriber: { credential: { name: "dev-key", value: "prod-key" } },
    });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("falls back to the credential value when no name field was supplied at all", async () => {
    const completions = await loadFilteredCap("CREDENTIAL", "sk-proj-secret");
    const nameless = (value: string): Credential => ({ value }) as unknown as Credential;

    await expect(
      completions.create(chatParams(), {
        subscriber: { credential: nameless("sk-proj-secret") },
      }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    await completions.create(chatParams(), {
      subscriber: { credential: nameless("sk-proj-other") },
    });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks only the product a product-filtered cap names, read from productId", async () => {
    const completions = await loadFilteredCap("PRODUCT", "assistant");

    await expect(
      completions.create(chatParams(), { productId: "assistant" }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    await completions.create(chatParams(), { productId: "reporting" });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks only the organization an org-filtered cap names, read from organizationId", async () => {
    const completions = await loadFilteredCap("ORGANIZATION", "acme");

    await expect(
      completions.create(chatParams(), { organizationId: "acme" }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    await completions.create(chatParams(), { organizationId: "globex" });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks only the task type a task-filtered cap names", async () => {
    const completions = await loadFilteredCap("TASK_TYPE", "summarize");

    await expect(
      completions.create(chatParams(), { taskType: "summarize" }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    await completions.create(chatParams(), { taskType: "classify" });

    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("lets a streamed call through when the breached cap is filtered on another provider", async () => {
    const completions = await loadFilteredCap("PROVIDER", "anthropic");

    await expect(
      completions.createStreaming({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    ).resolves.toBeDefined();
    expect(providerCreate).toHaveBeenCalledTimes(1);
  });
});

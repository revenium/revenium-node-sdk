import OpenAI from "openai";
import { getConfig, initializeConfig, resetConfig } from "../../../src/_core/config/manager";
import { DEFAULT_CONFIG, DEFAULT_IMAGE_MODEL, ENV_VARS } from "../../../src/_core/constants";
import { getRules } from "../../../src/_core/enforcement/cache";
import {
  startEnforcementPolling,
  stopEnforcementPolling,
} from "../../../src/_core/enforcement/engine";
import { resetEnforcementCircuitBreaker } from "../../../src/_core/resilience/circuit-breaker";
import { CostLimitExceeded } from "../../../src/_core/resilience/error-handler";
import { applyMeteringReply } from "../../../src/_core/enforcement/metering-blocks";
import { sendToRevenium } from "../../../src/_core/metering/api-client";
import {
  CompletionsInterface,
  ImagesInterface,
  ResponsesInterface,
} from "../../../src/openai/middleware";
import { DecisionsInterface } from "../../../src/openai/decisions";
import { Configure, GetClient, Initialize, Reset } from "../../../src/openai/client";
import { Provider, type ProviderInfo } from "../../../src/openai/provider-detection";
import type { Config, Credential } from "../../../src/_core/types/index";
import { createReveniumConfig, useIsolatedReveniumEnvironment } from "../../helpers/fixtures";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

const TEAM_ID = "Ol3wbl";
const SERVED_HOST = "https://api.dev.hcapp.io";
const servedRulesUrl = (teamId: string) =>
  `${SERVED_HOST}/profitstream/v2/api/ai/enforcement-rules/${teamId}`;
const SERVED_URL = servedRulesUrl(TEAM_ID);

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
    process.env[ENV_VARS.REVENIUM_BASE_URL] = SERVED_HOST;
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

  it("releases the first call within the rules fetch timeout when the rules service hangs", async () => {
    global.fetch = jest.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    startEnforcementPolling();

    const completions = new CompletionsInterface(client, getConfig() as Config, providerInfo);
    const call = completions.create(chatParams());
    await jest.advanceTimersByTimeAsync(DEFAULT_CONFIG.API_TIMEOUT - 1);
    expect(providerCreate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toBeDefined();
    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

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

  it("blocks an image generation without a model on a cap filtered to the default image model", async () => {
    await loadFilteredCap("MODEL", DEFAULT_IMAGE_MODEL);
    const generate = jest.fn();
    const images = new ImagesInterface(
      { generate } as unknown as OpenAI.Images,
      getConfig() as Config,
      providerInfo,
    );

    await expect(images.generate({ prompt: "a cat" })).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(generate).not.toHaveBeenCalled();
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

describe("enforcement with Initialize(config) and the team id only in the environment", () => {
  let fetchMock: jest.Mock;

  useIsolatedReveniumEnvironment();

  beforeEach(() => {
    jest.useFakeTimers();
    process.env[ENV_VARS.TEAM_ID] = TEAM_ID;
    process.env[ENV_VARS.ENFORCEMENT_BASE_URL] = SERVED_HOST;

    resetConfig();
    resetEnforcementCircuitBreaker();

    fetchMock = jest.fn((input: unknown) =>
      Promise.resolve(
        String(input).includes("/enforcement-rules/")
          ? respondWith(200, { rules: [breachedBlockRule] })
          : respondWith(404),
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    Reset();
    resetConfig();
    resetEnforcementCircuitBreaker();
    jest.useRealTimers();
  });

  function enforcementRuleRequests(): string[] {
    return fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/enforcement-rules/"));
  }

  it("loads the team cost controls and blocks the next chat call", async () => {
    Initialize({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code" });
    await jest.advanceTimersByTimeAsync(0);

    expect(enforcementRuleRequests()).toEqual([SERVED_URL]);
    await expect(
      GetClient()
        .chat()
        .completions()
        .create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks the first chat call made right after Initialize", async () => {
    Initialize({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code" });

    await expect(
      GetClient()
        .chat()
        .completions()
        .create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([SERVED_URL]);
  });

  it("blocks the first chat call after Configure adds the team id to a running poller", async () => {
    delete process.env[ENV_VARS.TEAM_ID];
    Initialize({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code" });
    await jest.advanceTimersByTimeAsync(0);

    Configure({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code", reveniumTeamId: TEAM_ID });

    await expect(
      GetClient()
        .chat()
        .completions()
        .create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(enforcementRuleRequests()).toEqual([SERVED_URL]);
  });

  it("blocks the first streamed chat call made right after Initialize", async () => {
    Initialize({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code" });

    await expect(
      GetClient()
        .chat()
        .completions()
        .createStreaming({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([SERVED_URL]);
  });

  it("requests the rules for the team id passed in code over the environment", async () => {
    Initialize({
      reveniumApiKey: "hak_code",
      openaiApiKey: "sk-code",
      reveniumTeamId: "team_code",
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(enforcementRuleRequests()).toEqual([servedRulesUrl("team_code")]);
  });

  it("skips the environment team when the code meters under another organization's key", async () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_env_org";
    process.env[ENV_VARS.PRINT_SUMMARY] = "json";

    Initialize({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code" });
    await jest.advanceTimersByTimeAsync(0);

    expect(enforcementRuleRequests()).toEqual([]);
    expect(getConfig()?.printSummary).toBe("json");
  });
});

describe("a BLOCK directive on the metering reply stops the next OpenAI call", () => {
  const blockReply = {
    enforcement: { action: "BLOCK", ruleName: "stub-cap", message: "Daily cap reached" },
  };
  const metadata = { subscriber: { id: "sub-1" } };
  const config = createReveniumConfig();

  afterEach(() => {
    stopEnforcementPolling();
  });

  async function flushPromises(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function blockFromMeteredScope(): Promise<void> {
    await flushPromises();
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
    const [, scope] = (sendToRevenium as jest.Mock).mock.calls[0];
    applyMeteringReply(config.reveniumApiKey, scope, performance.now(), blockReply);
  }

  it("refuses the next chat completion for the scope the record was metered under", async () => {
    const providerCreate = jest.fn().mockResolvedValue({
      id: "chatcmpl-1",
      model: "gpt-4o-2024-08-06",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const client = { chat: { completions: { create: providerCreate } } } as unknown as OpenAI;
    const completions = new CompletionsInterface(client, config, providerInfo);
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };

    await completions.create(params, metadata);
    await blockFromMeteredScope();

    expect((sendToRevenium as jest.Mock).mock.calls[0][1]).toMatchObject({
      subscriberId: "sub-1",
      model: "gpt-4o",
      provider: "OpenAI",
    });
    await expect(completions.create(params, metadata)).rejects.toThrow("Daily cap reached");
    await expect(
      completions.create(params, { subscriber: { id: "sub-2" } }),
    ).resolves.toBeDefined();
    expect(providerCreate).toHaveBeenCalledTimes(2);
  });

  it("refuses the next image generation for the scope the record was metered under", async () => {
    const generate = jest.fn().mockResolvedValue({ created: 1, data: [{ url: "https://img" }] });
    const images = new ImagesInterface(
      { generate } as unknown as OpenAI.Images,
      config,
      providerInfo,
    );
    const params = { model: "gpt-image-1", prompt: "a cat", usageMetadata: metadata };

    await images.generate(params);
    await blockFromMeteredScope();

    await expect(images.generate(params)).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("refuses the next chat parse and records nothing for the refused call", async () => {
    const providerCreate = jest.fn().mockResolvedValue({
      id: "chatcmpl-1",
      model: "gpt-4o-2024-08-06",
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const client = { chat: { completions: { create: providerCreate } } } as unknown as OpenAI;
    const completions = new CompletionsInterface(client, config, providerInfo);
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };

    await completions.parse(params, metadata);
    await blockFromMeteredScope();

    await expect(completions.parse(params, metadata)).rejects.toBeInstanceOf(CostLimitExceeded);
    await flushPromises();
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
  });

  it("refuses the next decision and records nothing for the refused call", async () => {
    const providerCreate = jest.fn().mockResolvedValue({
      model: "gpt-6-luna",
      answers: [{ type: "predicate", name: "is_spam", probability: 0.02 }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const client = { decisions: { create: providerCreate } } as unknown as OpenAI;
    const decisions = new DecisionsInterface(client, config, providerInfo);
    const params = {
      model: "gpt-6-luna",
      input: "Buy cheap watches now",
      questions: [{ type: "predicate", name: "is_spam", instructions: "Is this spam?" }],
    };

    await decisions.create(params, metadata);
    await blockFromMeteredScope();

    await expect(decisions.create(params, metadata)).rejects.toBeInstanceOf(CostLimitExceeded);
    await flushPromises();
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).toHaveBeenCalledTimes(1);
  });
});

describe("a cost limit refusal raised beneath the OpenAI SDK, as by the LiteLLM proxy gate", () => {
  const config = createReveniumConfig();
  const refusal = new OpenAI.APIConnectionError({
    cause: new CostLimitExceeded("", NaN, NaN, "", undefined, {
      ruleName: "stub-cap",
      message: "Daily cap reached",
    }),
  });

  async function flushPromises(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("is not metered as a failed chat completion", async () => {
    const providerCreate = jest.fn().mockRejectedValue(refusal);
    const client = { chat: { completions: { create: providerCreate } } } as unknown as OpenAI;
    const completions = new CompletionsInterface(client, config, providerInfo);

    await expect(
      completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(refusal);
    await flushPromises();

    expect(sendToRevenium).not.toHaveBeenCalled();
  });

  it("is not metered as a failed response", async () => {
    const create = jest.fn().mockRejectedValue(refusal);
    const responses = new ResponsesInterface(
      { responses: { create } } as any,
      config,
      providerInfo,
    );

    await expect(responses.create({ model: "gpt-4o", input: "hi" })).rejects.toBe(refusal);
    await flushPromises();

    expect(sendToRevenium).not.toHaveBeenCalled();
  });

  it("is not metered as a failed decision", async () => {
    const create = jest.fn().mockRejectedValue(refusal);
    const decisions = new DecisionsInterface(
      { decisions: { create } } as unknown as OpenAI,
      config,
      providerInfo,
    );

    await expect(decisions.create({ model: "gpt-6-luna", input: "hi" })).rejects.toBe(refusal);
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(1);
    expect(sendToRevenium).not.toHaveBeenCalled();
  });
});

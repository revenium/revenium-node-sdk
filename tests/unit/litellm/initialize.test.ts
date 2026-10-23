import type { Logger } from "../../../src/_core/types/index";

const originalFetch = global.fetch;

const READ_ME_ENV = {
  REVENIUM_METERING_API_KEY: "hak_test_key",
  REVENIUM_METERING_BASE_URL: "https://api.revenium.ai",
  LITELLM_PROXY_URL: "http://localhost:4000",
};

const METERING_URL = "https://api.revenium.ai/meter/v2/ai/completions";

const RETRY_WINDOW_MS = 2000;

const REVENIUM_ENV_KEYS = [
  "REVENIUM_METERING_API_KEY",
  "REVENIUM_METERING_BASE_URL",
  "REVENIUM_API_KEY",
  "REVENIUM_BASE_URL",
  "LITELLM_PROXY_URL",
  "REVENIUM_MAX_RETRIES",
  "REVENIUM_FAIL_SILENT",
  "REVENIUM_CAPTURE_PROMPTS",
  "REVENIUM_TEAM_ID",
  "REVENIUM_PRINT_SUMMARY",
  "REVENIUM_ENFORCEMENT_BASE_URL",
  "REVENIUM_API_TIMEOUT",
  "REVENIUM_MAX_PROMPT_SIZE",
];

let envSnapshot: NodeJS.ProcessEnv;
let initialize: typeof import("../../../src/litellm/index").initialize;
let configure: typeof import("../../../src/litellm/index").configure;
let reset: typeof import("../../../src/litellm/index").reset;
let getConfig: typeof import("../../../src/_core/config/manager").getConfig;
let setLogger: typeof import("../../../src/_core/config/manager").setLogger;
let isHttpClientPatched: typeof import("../../../src/litellm/http-client").isHttpClientPatched;
let resetEnvFilesLoaded: typeof import("../../../src/_core/config/loader").resetEnvFilesLoaded;

function createProxyFetch(meteringStatus = 200): jest.Mock {
  return jest.fn((input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    const isProxyCall = url.includes("localhost:4000");
    const body = isProxyCall
      ? {
          id: "chatcmpl-1",
          model: "openai/gpt-4",
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        }
      : {};
    const status = isProxyCall ? 200 : meteringStatus;
    return Promise.resolve({
      ok: status < 400,
      status,
      statusText: "OK",
      clone() {
        return this;
      },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    } as unknown as Response);
  });
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

function meteringCalls(proxyFetch: jest.Mock): unknown[][] {
  return proxyFetch.mock.calls.filter(([url]) => url === METERING_URL);
}

async function waitForMeteringCalls(
  proxyFetch: jest.Mock,
  expected: number,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (meteringCalls(proxyFetch).length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function chatThroughProxy(proxyFetch: jest.Mock): Promise<void> {
  await fetch("http://localhost:4000/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-4", messages: [{ role: "user", content: "hi" }] }),
  });

  await waitForMeteringCalls(proxyFetch, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
  jest.resetModules();
  envSnapshot = { ...process.env };
  for (const key of REVENIUM_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, READ_ME_ENV);
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const loader = await import("../../../src/_core/config/loader");
  const litellm = await import("../../../src/litellm/index");
  const httpClient = await import("../../../src/litellm/http-client");

  getConfig = manager.getConfig;
  setLogger = manager.setLogger;
  resetEnvFilesLoaded = loader.resetEnvFilesLoaded;
  initialize = litellm.initialize;
  configure = litellm.configure;
  reset = litellm.reset;
  isHttpClientPatched = httpClient.isHttpClientPatched;

  resetEnvFilesLoaded();
  reset();
});

afterEach(() => {
  reset();
  global.fetch = originalFetch;
  process.env = envSnapshot;
  jest.restoreAllMocks();
});

describe("LiteLLM initialize", () => {
  it("sends one metering record from the README setup alone", async () => {
    expect(getConfig()).toBeNull();

    const proxyFetch = createProxyFetch();
    global.fetch = proxyFetch;

    expect(initialize()).toBe(true);

    await chatThroughProxy(proxyFetch);

    const calls = meteringCalls(proxyFetch);
    expect(calls).toHaveLength(1);

    const [, requestInit] = calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(requestInit.headers["x-api-key"]).toBe("hak_test_key");

    const payload = JSON.parse(requestInit.body as string);
    expect(payload.inputTokenCount).toBe(11);
    expect(payload.outputTokenCount).toBe(3);
    expect(payload.totalTokenCount).toBe(14);
  });

  it("maps the LiteLLM settings into the shared configuration", async () => {
    process.env.REVENIUM_MAX_RETRIES = "7";
    process.env.REVENIUM_FAIL_SILENT = "false";
    process.env.REVENIUM_CAPTURE_PROMPTS = "true";
    process.env.REVENIUM_TEAM_ID = "team-9";
    process.env.REVENIUM_ENFORCEMENT_BASE_URL = "https://enforcement.revenium.ai";

    expect(initialize()).toBe(true);

    expect(getConfig()).toMatchObject({
      reveniumApiKey: "hak_test_key",
      reveniumBaseUrl: "https://api.revenium.ai",
      reveniumEnforcementBaseUrl: "https://enforcement.revenium.ai",
      maxRetries: 7,
      failSilent: false,
      capturePrompts: true,
      reveniumTeamId: "team-9",
    });
  });

  it("sends the metering record once when REVENIUM_MAX_RETRIES is 0", async () => {
    process.env.REVENIUM_MAX_RETRIES = "0";

    const proxyFetch = createProxyFetch(503);
    global.fetch = proxyFetch;

    expect(initialize()).toBe(true);

    await chatThroughProxy(proxyFetch);
    await new Promise((resolve) => setTimeout(resolve, RETRY_WINDOW_MS));

    expect(meteringCalls(proxyFetch)).toHaveLength(1);
  }, 15000);

  it("retries the metering send when REVENIUM_MAX_RETRIES is 1", async () => {
    process.env.REVENIUM_MAX_RETRIES = "1";

    const proxyFetch = createProxyFetch(503);
    global.fetch = proxyFetch;

    expect(initialize()).toBe(true);

    await chatThroughProxy(proxyFetch);
    await waitForMeteringCalls(proxyFetch, 2);

    expect(meteringCalls(proxyFetch)).toHaveLength(2);
  }, 15000);

  it("reports a failed send without rejecting when REVENIUM_FAIL_SILENT is false", async () => {
    process.env.REVENIUM_FAIL_SILENT = "false";
    process.env.REVENIUM_MAX_RETRIES = "0";

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const { errors } = recordSetupMessages();
    const proxyFetch = createProxyFetch(503);
    global.fetch = proxyFetch;

    try {
      expect(initialize()).toBe(true);

      await chatThroughProxy(proxyFetch);
      await new Promise((resolve) => setTimeout(resolve, RETRY_WINDOW_MS));

      expect(errors).toContain("Revenium tracking failed");
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  }, 15000);

  it("restores another provider's shared configuration on reset()", async () => {
    const manager = await import("../../../src/_core/config/manager");
    const existingConfig = {
      reveniumApiKey: "hak_other_provider_key",
      reveniumBaseUrl: "https://api.revenium.ai",
    };
    manager.setConfig(existingConfig);

    expect(initialize()).toBe(true);
    expect(getConfig()?.reveniumApiKey).toBe("hak_test_key");

    reset();

    expect(getConfig()).toMatchObject(existingConfig);
  });

  it("ignores a malformed REVENIUM_MAX_RETRIES instead of dropping the record", async () => {
    process.env.REVENIUM_MAX_RETRIES = "three";

    const proxyFetch = createProxyFetch();
    global.fetch = proxyFetch;

    expect(initialize()).toBe(true);
    expect(getConfig()?.maxRetries).toBeUndefined();

    await chatThroughProxy(proxyFetch);

    expect(meteringCalls(proxyFetch)).toHaveLength(1);
  });

  it("reports an invalid key once at setup and does not patch", async () => {
    process.env.REVENIUM_METERING_API_KEY = "badkey";

    const { errors } = recordSetupMessages();

    expect(initialize()).toBe(false);
    expect(isHttpClientPatched()).toBe(false);
    expect(getConfig()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("invalid configuration");
  });

  it("names every accepted setup variable in the single warning when the proxy URL is missing", async () => {
    delete process.env.LITELLM_PROXY_URL;

    const { warnings } = recordSetupMessages();

    expect(initialize()).toBe(false);
    expect(isHttpClientPatched()).toBe(false);
    expect(getConfig()).toBeNull();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("REVENIUM_METERING_API_KEY");
    expect(warnings[0]).toContain("REVENIUM_API_KEY");
    expect(warnings[0]).toContain("LITELLM_PROXY_URL");
  });

  it("initializes from REVENIUM_API_KEY when the metering-specific key is absent", async () => {
    delete process.env.REVENIUM_METERING_API_KEY;
    delete process.env.REVENIUM_METERING_BASE_URL;
    process.env.REVENIUM_API_KEY = "hak_shared_key";

    const proxyFetch = createProxyFetch();
    global.fetch = proxyFetch;

    expect(initialize()).toBe(true);
    expect(getConfig()?.reveniumApiKey).toBe("hak_shared_key");

    await chatThroughProxy(proxyFetch);

    const calls = meteringCalls(proxyFetch);
    expect(calls).toHaveLength(1);

    const [, requestInit] = calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(requestInit.headers["x-api-key"]).toBe("hak_shared_key");
  });

  it("installs the shared configuration through configure()", async () => {
    expect(
      configure({
        reveniumMeteringApiKey: "hak_configured_key",
        reveniumMeteringBaseUrl: "https://api.revenium.ai",
        litellmProxyUrl: "http://localhost:4000",
        maxRetries: 2,
      }),
    ).toBe(true);

    expect(isHttpClientPatched()).toBe(true);
    expect(getConfig()).toMatchObject({
      reveniumApiKey: "hak_configured_key",
      maxRetries: 2,
    });
  });

  it("rejects an invalid configure() payload without patching", async () => {
    expect(
      configure({
        reveniumMeteringApiKey: "badkey",
        reveniumMeteringBaseUrl: "https://api.revenium.ai",
        litellmProxyUrl: "http://localhost:4000",
      }),
    ).toBe(false);

    expect(isHttpClientPatched()).toBe(false);
    expect(getConfig()).toBeNull();
  });

  it("loads the README setup from a .env file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const workingDir = mkdtempSync(join(tmpdir(), "litellm-dotenv-"));
    const originalCwd = process.cwd();

    delete process.env.REVENIUM_METERING_API_KEY;
    delete process.env.REVENIUM_METERING_BASE_URL;

    writeFileSync(
      join(workingDir, ".env"),
      "REVENIUM_METERING_API_KEY=hak_dotenv_key\nREVENIUM_METERING_BASE_URL=https://api.revenium.ai\n",
    );

    jest.resetModules();

    try {
      process.chdir(workingDir);

      const litellm = await import("../../../src/litellm/index");
      const manager = await import("../../../src/_core/config/manager");

      expect(litellm.initialize()).toBe(true);
      expect(manager.getConfig()?.reveniumApiKey).toBe("hak_dotenv_key");

      litellm.reset();
    } finally {
      process.chdir(originalCwd);
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it("does not pick up the README setup from a .env above the working directory", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const root = mkdtempSync(join(tmpdir(), "litellm-dotenv-parent-"));
    const workingDir = join(root, "app");
    mkdirSync(workingDir);
    const originalCwd = process.cwd();

    delete process.env.REVENIUM_METERING_API_KEY;
    delete process.env.REVENIUM_METERING_BASE_URL;

    writeFileSync(
      join(root, ".env"),
      "REVENIUM_METERING_API_KEY=hak_parent_key\nREVENIUM_METERING_BASE_URL=https://api.revenium.ai\n",
    );

    jest.resetModules();

    try {
      process.chdir(workingDir);

      const litellm = await import("../../../src/litellm/index");
      const manager = await import("../../../src/_core/config/manager");

      expect(litellm.initialize()).toBe(false);
      expect(manager.getConfig()).toBeNull();
      expect(process.env.REVENIUM_METERING_API_KEY).toBeUndefined();

      litellm.reset();
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

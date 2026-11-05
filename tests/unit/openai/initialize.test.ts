import { ENV_VARS } from "../../../src/_core/constants";
import { Provider } from "../../../src/openai/provider-detection";
import { runInWorkingDir, useIsolatedReveniumEnvironment } from "../../helpers/fixtures";

let openai: typeof import("../../../src/openai/client");
let manager: typeof import("../../../src/_core/config/manager");

const AZURE_ENVIRONMENT_KEYS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_VERSION",
];

useIsolatedReveniumEnvironment();

beforeEach(async () => {
  jest.resetModules();
  for (const key of AZURE_ENVIRONMENT_KEYS) delete process.env[key];

  openai = await import("../../../src/openai/client");
  manager = await import("../../../src/_core/config/manager");
});

afterEach(() => {
  openai.Reset();
});

describe("openai Initialize", () => {
  it("routes to Azure from a .env in the working directory on the first call and warns that calls pass through without a team id", () => {
    const warn = jest.fn();
    manager.setLogger({ debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() });

    runInWorkingDir(
      {
        "app/.env": {
          [ENV_VARS.REVENIUM_API_KEY]: "hak_env_file",
          AZURE_OPENAI_ENDPOINT: "https://env-file.openai.azure.com",
          AZURE_OPENAI_API_KEY: "azure-env-file",
          AZURE_OPENAI_API_VERSION: "2024-10-21",
        },
      },
      () => {
        openai.Initialize();

        expect(openai.GetClient().getProviderInfo().provider).toBe(Provider.AZURE_OPENAI);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider calls pass through"));
      },
    );
  });

  it("loads the .env in the working directory on the first call with config", () => {
    delete process.env.OPENAI_API_KEY;

    runInWorkingDir(
      {
        "app/.env": {
          [ENV_VARS.PRINT_SUMMARY]: "json",
          [ENV_VARS.CAPTURE_PROMPTS]: "true",
          OPENAI_API_KEY: "sk-env-file",
        },
      },
      () => {
        openai.Initialize({ reveniumApiKey: "hak_code" });

        expect(manager.getConfig()).toMatchObject({ printSummary: "json", capturePrompts: true });
        expect(openai.GetClient().getUnderlyingClient().apiKey).toBe("sk-env-file");
      },
    );
  });

  it("rejects an invalid metering URL from the environment when config omits it", () => {
    process.env[ENV_VARS.REVENIUM_BASE_URL] = "not a url";

    expect(() =>
      openai.Initialize({ reveniumApiKey: "hak_code", openaiApiKey: "sk-code" }),
    ).toThrow("Invalid Revenium base URL format: not a url");
  });

  it("names the Revenium key when Initialize without config finds none", () => {
    expect(() => openai.Initialize()).toThrow("Revenium API key is required");
  });
});

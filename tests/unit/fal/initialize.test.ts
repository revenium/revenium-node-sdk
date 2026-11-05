import { ENV_VARS } from "../../../src/_core/constants";
import { runInWorkingDir, useIsolatedReveniumEnvironment } from "../../helpers/fixtures";

let Initialize: typeof import("../../../src/fal/index").Initialize;
let getConfig: typeof import("../../../src/_core/config/manager").getConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

jest.mock("@fal-ai/client", () => ({
  createFalClient: () => ({ run: jest.fn(), subscribe: jest.fn(), stream: jest.fn() }),
}));

const ORG_A_KEY = "hak_org_a_key";
const ORG_B_KEY = "hak_org_b_key";

useIsolatedReveniumEnvironment();

beforeEach(async () => {
  jest.resetModules();

  const falModule = await import("../../../src/fal/index");
  const manager = await import("../../../src/_core/config/manager");

  Initialize = falModule.Initialize;
  getConfig = manager.getConfig;
  resetConfig = manager.resetConfig;
});

afterEach(() => {
  resetConfig();
});

describe("fal Initialize", () => {
  it("replaces the process configuration instead of layering over the previous organization", () => {
    Initialize({ reveniumApiKey: ORG_A_KEY, capturePrompts: true, teamId: "team_a" });
    Initialize({ reveniumApiKey: ORG_B_KEY });

    expect(getConfig()?.reveniumApiKey).toBe(ORG_B_KEY);
    expect(getConfig()?.capturePrompts).toBeUndefined();
    expect(getConfig()?.reveniumTeamId).toBeUndefined();
  });

  it("forwards bufferMaxSize to the process configuration", () => {
    Initialize({ reveniumApiKey: ORG_A_KEY, bufferMaxSize: 50000 });

    expect(getConfig()?.bufferMaxSize).toBe(50000);
  });

  it("reads the team id, usage summary and prompt capture from the environment when config omits them", () => {
    process.env[ENV_VARS.TEAM_ID] = "team_env";
    process.env[ENV_VARS.PRINT_SUMMARY] = "json";
    process.env[ENV_VARS.CAPTURE_PROMPTS] = "true";

    Initialize({ reveniumApiKey: ORG_A_KEY });

    expect(getConfig()?.reveniumTeamId).toBe("team_env");
    expect(getConfig()?.printSummary).toBe("json");
    expect(getConfig()?.capturePrompts).toBe(true);
  });

  it("keeps the team id passed in config over the environment", () => {
    process.env[ENV_VARS.TEAM_ID] = "team_env";
    process.env[ENV_VARS.PRINT_SUMMARY] = "json";

    Initialize({ reveniumApiKey: ORG_A_KEY, teamId: "team_code" });

    expect(getConfig()?.reveniumTeamId).toBe("team_code");
    expect(getConfig()?.printSummary).toBe("json");
  });

  it("loads the .env in the working directory on the first call with config", () => {
    delete process.env.FAL_KEY;

    runInWorkingDir(
      { "app/.env": { [ENV_VARS.TEAM_ID]: "team_env_file", FAL_KEY: "fal-env-file" } },
      () => {
        Initialize({ reveniumApiKey: ORG_A_KEY });

        expect(getConfig()?.reveniumTeamId).toBe("team_env_file");
        expect(process.env.FAL_KEY).toBe("fal-env-file");
      },
    );
  });

  it("names the Revenium key when Initialize without config finds none", () => {
    expect(() => Initialize()).toThrow("Revenium API key is required");
  });

  it("reads the fal.ai settings and enforcement address from a .env in the working directory on the first call", () => {
    runInWorkingDir(
      {
        "app/.env": {
          [ENV_VARS.REVENIUM_API_KEY]: ORG_A_KEY,
          [ENV_VARS.FAIL_SILENT]: "false",
          [ENV_VARS.ENFORCEMENT_BASE_URL]: "https://enforcement.env-file.example",
        },
      },
      () => {
        Initialize();

        expect(getConfig()).toMatchObject({
          reveniumApiKey: ORG_A_KEY,
          failSilent: false,
          reveniumEnforcementBaseUrl: "https://enforcement.env-file.example",
        });
      },
    );
  });
});

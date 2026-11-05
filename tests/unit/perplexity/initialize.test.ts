import { ENV_VARS } from "../../../src/_core/constants";
import { runInWorkingDir, useIsolatedReveniumEnvironment } from "../../helpers/fixtures";

let Initialize: typeof import("../../../src/perplexity/client").Initialize;
let GetClient: typeof import("../../../src/perplexity/client").GetClient;
let getConfig: typeof import("../../../src/_core/config/manager").getConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const REVENIUM_KEY = "hak_perplexity_key";
const PERPLEXITY_KEY = "pplx-code-key";

useIsolatedReveniumEnvironment();

beforeEach(async () => {
  jest.resetModules();
  delete process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_BASE_URL;

  const perplexityModule = await import("../../../src/perplexity/client");
  const manager = await import("../../../src/_core/config/manager");

  Initialize = perplexityModule.Initialize;
  GetClient = perplexityModule.GetClient;
  getConfig = manager.getConfig;
  resetConfig = manager.resetConfig;
});

afterEach(() => {
  resetConfig();
});

describe("perplexity Initialize", () => {
  it("reads the team id, usage summary and prompt capture from the environment when config omits them", () => {
    process.env[ENV_VARS.TEAM_ID] = "team_env";
    process.env[ENV_VARS.PRINT_SUMMARY] = "true";
    process.env[ENV_VARS.CAPTURE_PROMPTS] = "true";

    Initialize({ reveniumApiKey: REVENIUM_KEY, perplexityApiKey: PERPLEXITY_KEY });

    expect(getConfig()?.reveniumTeamId).toBe("team_env");
    expect(getConfig()?.printSummary).toBe("human");
    expect(getConfig()?.capturePrompts).toBe(true);
  });

  it("keeps the team id passed in config over the environment", () => {
    process.env[ENV_VARS.TEAM_ID] = "team_env";
    process.env[ENV_VARS.PRINT_SUMMARY] = "true";

    Initialize({
      reveniumApiKey: REVENIUM_KEY,
      perplexityApiKey: PERPLEXITY_KEY,
      reveniumTeamId: "team_code",
    });

    expect(getConfig()?.reveniumTeamId).toBe("team_code");
    expect(getConfig()?.printSummary).toBe("human");
  });

  it("reads the Perplexity key from PERPLEXITY_API_KEY when config omits it", () => {
    process.env.PERPLEXITY_API_KEY = "pplx-env-key";

    Initialize({ reveniumApiKey: REVENIUM_KEY });

    expect(GetClient().getConfig().perplexityApiKey).toBe("pplx-env-key");
  });

  it("reads the Perplexity settings from a .env in the working directory on the first call", () => {
    runInWorkingDir(
      {
        "app/.env": {
          PERPLEXITY_API_KEY: "pplx-env-file",
          PERPLEXITY_API_BASE_URL: "https://perplexity.env-file.example",
        },
      },
      () => {
        Initialize({ reveniumApiKey: REVENIUM_KEY });

        expect(GetClient().getConfig()).toMatchObject({
          perplexityApiKey: "pplx-env-file",
          perplexityBaseUrl: "https://perplexity.env-file.example",
        });
      },
    );
  });

  it("names the Revenium key when Initialize without config finds none", () => {
    process.env.PERPLEXITY_API_KEY = PERPLEXITY_KEY;

    expect(() => Initialize()).toThrow("Revenium API key is required");
  });
});

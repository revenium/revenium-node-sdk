let Initialize: typeof import("../../../src/fal/index").Initialize;
let getConfig: typeof import("../../../src/_core/config/manager").getConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

jest.mock("@fal-ai/client", () => ({
  createFalClient: () => ({ run: jest.fn(), subscribe: jest.fn(), stream: jest.fn() }),
}));

const ORG_A_KEY = "hak_org_a_key";
const ORG_B_KEY = "hak_org_b_key";

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
});

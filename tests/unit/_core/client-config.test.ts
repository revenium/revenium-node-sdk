import { createReveniumConfig, useIsolatedReveniumEnvironment } from "../../helpers/fixtures";
import { ENV_VARS } from "../../../src/_core/constants";
import type { ReveniumConfig } from "../../../src/_core/types";

let snapshotClientConfig: typeof import("../../../src/_core/config/client-config").snapshotClientConfig;
let withEnvironmentDefaults: typeof import("../../../src/_core/config/client-config").withEnvironmentDefaults;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const PROCESS_KEY = "hak_process_key";
const CLIENT_KEY = "hak_client_key";
const ENV_ENFORCEMENT_URL = "https://enforcement.env.example";
const ENV_METERING_URL = "https://metering.env.example";

useIsolatedReveniumEnvironment();

beforeEach(async () => {
  jest.resetModules();

  const clientConfig = await import("../../../src/_core/config/client-config");
  const manager = await import("../../../src/_core/config/manager");

  snapshotClientConfig = clientConfig.snapshotClientConfig;
  withEnvironmentDefaults = clientConfig.withEnvironmentDefaults;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
});

afterEach(() => {
  resetConfig();
});

describe("client config snapshots", () => {
  it("inherits process settings when the client reuses the process key", () => {
    setConfig(
      createReveniumConfig({
        reveniumApiKey: PROCESS_KEY,
        reveniumTeamId: "team_process",
        capturePrompts: true,
      }),
    );

    const snapshot = snapshotClientConfig<ReveniumConfig>({ reveniumApiKey: PROCESS_KEY });

    expect(snapshot.reveniumTeamId).toBe("team_process");
    expect(snapshot.capturePrompts).toBe(true);
  });

  it("drops the process team id when the client meters under another key", () => {
    setConfig(
      createReveniumConfig({
        reveniumApiKey: PROCESS_KEY,
        reveniumTeamId: "team_process",
        capturePrompts: true,
      }),
    );

    const snapshot = snapshotClientConfig<ReveniumConfig>({ reveniumApiKey: CLIENT_KEY });

    expect(snapshot.reveniumTeamId).toBeUndefined();
    expect(snapshot.capturePrompts).toBe(true);
  });

  it("keeps a team id the client sets explicitly", () => {
    setConfig(
      createReveniumConfig({ reveniumApiKey: PROCESS_KEY, reveniumTeamId: "team_process" }),
    );

    const snapshot = snapshotClientConfig<ReveniumConfig>({
      reveniumApiKey: CLIENT_KEY,
      reveniumTeamId: "team_client",
    });

    expect(snapshot.reveniumTeamId).toBe("team_client");
  });
});

describe("environment defaults under code config", () => {
  beforeEach(() => {
    process.env[ENV_VARS.TEAM_ID] = "team_env";
    process.env[ENV_VARS.PRINT_SUMMARY] = "json";
    process.env[ENV_VARS.ENFORCEMENT_BASE_URL] = ENV_ENFORCEMENT_URL;
    process.env[ENV_VARS.REVENIUM_BASE_URL] = ENV_METERING_URL;
  });

  it("fills the settings the code config leaves out from the environment", () => {
    const config = withEnvironmentDefaults<ReveniumConfig>({ reveniumApiKey: CLIENT_KEY });

    expect(config).toMatchObject({
      reveniumApiKey: CLIENT_KEY,
      reveniumTeamId: "team_env",
      printSummary: "json",
      reveniumEnforcementBaseUrl: ENV_ENFORCEMENT_URL,
      reveniumBaseUrl: ENV_METERING_URL,
    });
  });

  it("keeps every value the code config defines over the environment", () => {
    const config = withEnvironmentDefaults<ReveniumConfig>({
      reveniumApiKey: CLIENT_KEY,
      reveniumTeamId: "team_code",
      printSummary: false,
      reveniumEnforcementBaseUrl: "https://enforcement.code.example",
      reveniumBaseUrl: "https://metering.code.example",
    });

    expect(config).toMatchObject({
      reveniumTeamId: "team_code",
      printSummary: false,
      reveniumEnforcementBaseUrl: "https://enforcement.code.example",
      reveniumBaseUrl: "https://metering.code.example",
    });
  });

  it("keeps the environment value when the code config sets a key to undefined", () => {
    const config = withEnvironmentDefaults<ReveniumConfig>({
      reveniumApiKey: CLIENT_KEY,
      reveniumTeamId: undefined,
    });

    expect(config.reveniumTeamId).toBe("team_env");
  });

  it("drops the environment team and enforcement host when the code config meters under another key", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = PROCESS_KEY;

    const config = withEnvironmentDefaults<ReveniumConfig>({ reveniumApiKey: CLIENT_KEY });

    expect(config.reveniumTeamId).toBeUndefined();
    expect(config.reveniumEnforcementBaseUrl).toBeUndefined();
    expect(config).toMatchObject({ printSummary: "json", reveniumBaseUrl: ENV_METERING_URL });
  });

  it("keeps the environment team when the code config repeats the environment key", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = CLIENT_KEY;

    const config = withEnvironmentDefaults<ReveniumConfig>({ reveniumApiKey: CLIENT_KEY });

    expect(config.reveniumTeamId).toBe("team_env");
    expect(config.reveniumEnforcementBaseUrl).toBe(ENV_ENFORCEMENT_URL);
  });
});

import { createReveniumConfig } from "../../helpers/fixtures";
import type { ReveniumConfig } from "../../../src/_core/types";

let snapshotClientConfig: typeof import("../../../src/_core/config/client-config").snapshotClientConfig;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const PROCESS_KEY = "hak_process_key";
const CLIENT_KEY = "hak_client_key";

beforeEach(async () => {
  jest.resetModules();

  const clientConfig = await import("../../../src/_core/config/client-config");
  const manager = await import("../../../src/_core/config/manager");

  snapshotClientConfig = clientConfig.snapshotClientConfig;
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

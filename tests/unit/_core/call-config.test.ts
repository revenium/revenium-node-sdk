import { createReveniumConfig } from "../../helpers/fixtures";

let runWithCallConfig: typeof import("../../../src/_core/config/call-config").runWithCallConfig;
let getCallConfig: typeof import("../../../src/_core/config/call-config").getCallConfig;
let resolveConfig: typeof import("../../../src/_core/config/call-config").resolveConfig;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

beforeEach(async () => {
  jest.resetModules();

  const callConfig = await import("../../../src/_core/config/call-config");
  const manager = await import("../../../src/_core/config/manager");

  runWithCallConfig = callConfig.runWithCallConfig;
  getCallConfig = callConfig.getCallConfig;
  resolveConfig = callConfig.resolveConfig;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
});

afterEach(() => {
  resetConfig();
});

describe("call config resolution", () => {
  it("falls back to the process config when no scope is open", () => {
    const global = createReveniumConfig({ reveniumApiKey: "hak_global_key" });
    setConfig(global);

    expect(getCallConfig()).toBeNull();
    expect(resolveConfig()).toEqual(global);
  });

  it("returns null when neither a scope nor a process config exists", () => {
    expect(resolveConfig()).toBeNull();
  });

  it("prefers the open scope over the process config", () => {
    setConfig(createReveniumConfig({ reveniumApiKey: "hak_global_key" }));
    const scoped = createReveniumConfig({ reveniumApiKey: "hak_scoped_key" });

    runWithCallConfig(scoped, () => {
      expect(resolveConfig()!.reveniumApiKey).toBe("hak_scoped_key");
    });
  });

  it("does not leak a nested scope out of its run", () => {
    const outer = createReveniumConfig({ reveniumApiKey: "hak_outer_key" });
    const inner = createReveniumConfig({ reveniumApiKey: "hak_inner_key" });

    runWithCallConfig(outer, () => {
      runWithCallConfig(inner, () => {
        expect(resolveConfig()!.reveniumApiKey).toBe("hak_inner_key");
      });
      expect(resolveConfig()!.reveniumApiKey).toBe("hak_outer_key");
    });

    expect(getCallConfig()).toBeNull();
  });

  it("keeps the scope across promise continuations", async () => {
    const scoped = createReveniumConfig({ reveniumApiKey: "hak_async_key" });

    await runWithCallConfig(scoped, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(resolveConfig()!.reveniumApiKey).toBe("hak_async_key");
    });
  });

  it("ignores a scope without an API key instead of sending under an empty key", () => {
    const global = createReveniumConfig({ reveniumApiKey: "hak_global_key" });
    setConfig(global);

    runWithCallConfig({ reveniumBaseUrl: "https://api.revenium.ai" } as never, () => {
      expect(resolveConfig()).toEqual(global);
    });
  });

  it("leaves the surrounding resolution untouched when given no config", () => {
    setConfig(createReveniumConfig({ reveniumApiKey: "hak_global_key" }));

    runWithCallConfig(null, () => {
      expect(resolveConfig()!.reveniumApiKey).toBe("hak_global_key");
    });
  });
});

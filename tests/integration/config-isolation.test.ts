describe("config isolation between providers", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("openai config does not leak into fresh module load", async () => {
    const m1 = await import("../../src/_core/config/manager");
    m1.setConfig({
      reveniumApiKey: "hak_openai_config123",
      reveniumBaseUrl: "https://api.revenium.ai",
    });
    expect(m1.getConfig()!.reveniumApiKey).toBe("hak_openai_config123");

    jest.resetModules();

    const m2 = await import("../../src/_core/config/manager");
    expect(m2.getConfig()).toBeNull();
  });

  it("separate provider loads get independent singletons", async () => {
    const m1 = await import("../../src/_core/config/manager");
    m1.setConfig({
      reveniumApiKey: "hak_provider_aaa111",
      reveniumBaseUrl: "https://api.revenium.ai",
    });

    jest.resetModules();

    const m2 = await import("../../src/_core/config/manager");
    m2.setConfig({
      reveniumApiKey: "hak_provider_bbb222",
      reveniumBaseUrl: "https://api.revenium.ai",
    });

    expect(m2.getConfig()!.reveniumApiKey).toBe("hak_provider_bbb222");

    jest.resetModules();

    const m3 = await import("../../src/_core/config/manager");
    expect(m3.getConfig()).toBeNull();
  });
});

describe("call config scope across module reloads", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("shares one store so a mixed CJS and ESM process sees the same scope", async () => {
    const m1 = await import("../../src/_core/config/call-config");

    jest.resetModules();

    const m2 = await import("../../src/_core/config/call-config");

    m1.runWithCallConfig(
      { reveniumApiKey: "hak_scoped_shared", reveniumBaseUrl: "https://api.revenium.ai" },
      () => {
        expect(m2.getCallConfig()!.reveniumApiKey).toBe("hak_scoped_shared");
      },
    );

    expect(m2.getCallConfig()).toBeNull();
  });
});

import { ENV_VARS } from "../../../src/_core/constants";
import type { Logger } from "../../../src/_core/types/index";

const REVENIUM_KEYS = [ENV_VARS.REVENIUM_API_KEY, ENV_VARS.REVENIUM_API_KEY_ALT];

describe("Anthropic auto-initialization", () => {
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    for (const key of REVENIUM_KEYS) delete process.env[key];
    jest.resetModules();
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it("warns at the default log level when no Revenium key is configured", async () => {
    const logger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const manager = await import("../../../src/_core/config/manager");
    manager.setLogger(logger);

    await import("../../../src/anthropic/index");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Set ${ENV_VARS.REVENIUM_API_KEY}`),
    );
    expect(logger.debug).not.toHaveBeenCalled();

    manager.setLogger(manager.defaultLogger);
  });

  it("reports the rejected key format instead of telling the user to set one", async () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "not-a-valid-prefix";

    const logger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const manager = await import("../../../src/_core/config/manager");
    manager.setLogger(logger);

    await import("../../../src/anthropic/index");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid Revenium API key format"),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(`Set ${ENV_VARS.REVENIUM_API_KEY}`),
    );

    manager.setLogger(manager.defaultLogger);
  });

  it("blames the base URL, not the key, when only the base URL is invalid", async () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_valid_key";
    process.env[ENV_VARS.REVENIUM_BASE_URL] = "api.revenium.ai";

    const logger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const manager = await import("../../../src/_core/config/manager");
    manager.setLogger(logger);

    await import("../../../src/anthropic/index");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid Revenium base URL format"),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(`Set ${ENV_VARS.REVENIUM_API_KEY}`),
    );

    manager.setLogger(manager.defaultLogger);
  });
});

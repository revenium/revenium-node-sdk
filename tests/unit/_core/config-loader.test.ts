import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfigFromEnv, resetEnvFilesLoaded } from "../../../src/_core/config/loader";
import { defaultLogger, setLogger } from "../../../src/_core/config/manager";
import { ENV_VARS, DEFAULT_REVENIUM_BASE_URL } from "../../../src/_core/constants";

const ORIGINAL_ENV = process.env;

const ENV_FILE_KEYS = [
  ENV_VARS.REVENIUM_API_KEY,
  ENV_VARS.REVENIUM_API_KEY_ALT,
  ENV_VARS.REVENIUM_BASE_URL,
  ENV_VARS.CAPTURE_PROMPTS,
];

function runInWorkingDir(
  files: Record<string, Record<string, string>>,
  run: (workingDir: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "revenium-env-"));
  const workingDir = join(root, "app");
  mkdirSync(workingDir);
  const originalCwd = process.cwd();

  for (const [relativePath, values] of Object.entries(files)) {
    writeFileSync(
      join(root, relativePath),
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }

  try {
    process.chdir(workingDir);
    run(workingDir);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

beforeEach(() => {
  jest.resetModules();
  resetEnvFilesLoaded();
  process.env = { ...ORIGINAL_ENV };
  for (const key of ENV_FILE_KEYS) delete process.env[key];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  setLogger(defaultLogger);
});

describe("loadConfigFromEnv", () => {
  it("returns null when no API key is set", () => {
    delete process.env[ENV_VARS.REVENIUM_API_KEY];
    delete process.env[ENV_VARS.REVENIUM_API_KEY_ALT];
    expect(loadConfigFromEnv()).toBeNull();
  });

  it("loads config from primary env var", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    const config = loadConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.reveniumApiKey).toBe("hak_tenant_abc");
  });

  it("falls back to alt env var", () => {
    delete process.env[ENV_VARS.REVENIUM_API_KEY];
    process.env[ENV_VARS.REVENIUM_API_KEY_ALT] = "hak_alt_key123";
    const config = loadConfigFromEnv();
    expect(config!.reveniumApiKey).toBe("hak_alt_key123");
  });

  it("uses default base URL when not specified", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    const config = loadConfigFromEnv();
    expect(config!.reveniumBaseUrl).toBe(DEFAULT_REVENIUM_BASE_URL);
  });

  it("reads custom base URL", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    process.env[ENV_VARS.REVENIUM_BASE_URL] = "https://custom.api";
    const config = loadConfigFromEnv();
    expect(config!.reveniumBaseUrl).toBe("https://custom.api");
  });

  it("parses printSummary=json", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    process.env[ENV_VARS.PRINT_SUMMARY] = "json";
    const config = loadConfigFromEnv();
    expect(config!.printSummary).toBe("json");
  });

  it("parses printSummary=true as human", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    process.env[ENV_VARS.PRINT_SUMMARY] = "true";
    const config = loadConfigFromEnv();
    expect(config!.printSummary).toBe("human");
  });

  it("reads reveniumTeamId from REVENIUM_TEAM_ID", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    process.env[ENV_VARS.TEAM_ID] = "team-42";
    const config = loadConfigFromEnv();
    expect(config!.reveniumTeamId).toBe("team-42");
  });

  it("reads reveniumEnforcementBaseUrl from REVENIUM_ENFORCEMENT_BASE_URL", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    process.env[ENV_VARS.ENFORCEMENT_BASE_URL] = "http://localhost:8080/profitstream";
    const config = loadConfigFromEnv();
    expect(config!.reveniumEnforcementBaseUrl).toBe("http://localhost:8080/profitstream");
  });

  it("parses capturePrompts", () => {
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_tenant_abc";
    process.env[ENV_VARS.CAPTURE_PROMPTS] = "true";
    const config = loadConfigFromEnv();
    expect(config!.capturePrompts).toBe(true);
  });
});

describe("loadEnvFiles", () => {
  it("loads a key from the working directory .env", () => {
    runInWorkingDir({ "app/.env": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env_file" } }, () => {
      expect(loadConfigFromEnv()!.reveniumApiKey).toBe("hak_from_env_file");
    });
  });

  it("never reads a .env from the parent of the working directory", () => {
    runInWorkingDir(
      {
        ".env": {
          [ENV_VARS.REVENIUM_API_KEY]: "hak_from_parent",
          [ENV_VARS.REVENIUM_BASE_URL]: "http://attacker.invalid",
        },
      },
      () => {
        expect(loadConfigFromEnv()).toBeNull();
        expect(process.env[ENV_VARS.REVENIUM_BASE_URL]).toBeUndefined();
      },
    );
  });

  it("uses the default base URL when only the parent holds an override", () => {
    runInWorkingDir(
      {
        ".env": { [ENV_VARS.REVENIUM_BASE_URL]: "http://attacker.invalid" },
        "app/.env": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env_file" },
      },
      () => {
        expect(loadConfigFromEnv()!.reveniumBaseUrl).toBe(DEFAULT_REVENIUM_BASE_URL);
      },
    );
  });

  it("lets .env.local win over .env", () => {
    runInWorkingDir(
      {
        "app/.env": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env" },
        "app/.env.local": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env_local" },
      },
      () => {
        expect(loadConfigFromEnv()!.reveniumApiKey).toBe("hak_from_env_local");
      },
    );
  });

  it("lets a real environment variable win over both files", () => {
    runInWorkingDir(
      {
        "app/.env": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env" },
        "app/.env.local": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env_local" },
      },
      () => {
        process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_from_real_env";
        expect(loadConfigFromEnv()!.reveniumApiKey).toBe("hak_from_real_env");
      },
    );
  });

  it("warns once and keeps loading when a .env cannot be read", () => {
    const warn = jest.fn();
    setLogger({ ...defaultLogger, warn });

    runInWorkingDir({}, (workingDir) => {
      mkdirSync(join(workingDir, ".env"));
      process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_from_real_env";

      expect(loadConfigFromEnv()!.reveniumApiKey).toBe("hak_from_real_env");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(".env");
    });
  });

  it("does the file reading only once", () => {
    runInWorkingDir({ "app/.env": { [ENV_VARS.REVENIUM_API_KEY]: "hak_from_env_file" } }, () => {
      expect(loadConfigFromEnv()!.reveniumApiKey).toBe("hak_from_env_file");
      delete process.env[ENV_VARS.REVENIUM_API_KEY];
      expect(loadConfigFromEnv()).toBeNull();
    });
  });
});

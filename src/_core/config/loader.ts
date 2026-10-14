import { ReveniumConfig, SummaryFormat } from "../types/index.js";
import { DEFAULT_REVENIUM_BASE_URL, ENV_VARS } from "../constants.js";

function parsePrintSummaryValue(value: string | undefined): boolean | SummaryFormat {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  if (normalized === "json") return "json";
  if (normalized === "human" || normalized === "true") return "human";
  return false;
}

let envFilesLoaded = false;

function loadEnvFiles(): void {
  if (envFilesLoaded) return;

  try {
    const { config: loadDotenv } = require("dotenv");
    const { existsSync } = require("fs");
    const { join } = require("path");

    const envFiles = [".env.local", ".env"];
    const cwd = process.cwd();
    const searchDirs = [cwd, join(cwd, "..")];

    for (const dir of searchDirs) {
      for (const envFile of envFiles) {
        const envPath = join(dir, envFile);
        if (existsSync(envPath)) {
          loadDotenv({ path: envPath });
        }
      }
    }
  } catch {
    // dotenv not available, rely on process.env
  }

  envFilesLoaded = true;
}

export type EnvReveniumConfig = ReveniumConfig & { reveniumBaseUrl: string };

export function loadConfigFromEnv(): EnvReveniumConfig | null {
  loadEnvFiles();

  const reveniumApiKey =
    process.env[ENV_VARS.REVENIUM_API_KEY] || process.env[ENV_VARS.REVENIUM_API_KEY_ALT];

  const reveniumBaseUrl =
    process.env[ENV_VARS.REVENIUM_BASE_URL] ||
    process.env[ENV_VARS.REVENIUM_BASE_URL_ALT] ||
    DEFAULT_REVENIUM_BASE_URL;

  const printSummary = parsePrintSummaryValue(process.env[ENV_VARS.PRINT_SUMMARY]);
  const reveniumTeamId = process.env[ENV_VARS.TEAM_ID];
  const reveniumEnforcementBaseUrl = process.env[ENV_VARS.ENFORCEMENT_BASE_URL];
  const capturePromptsEnv = process.env[ENV_VARS.CAPTURE_PROMPTS];

  if (!reveniumApiKey) return null;

  const config: EnvReveniumConfig = {
    reveniumApiKey,
    reveniumBaseUrl,
    printSummary,
    reveniumTeamId,
    reveniumEnforcementBaseUrl,
  };

  if (capturePromptsEnv !== undefined) {
    config.capturePrompts = capturePromptsEnv.toLowerCase() === "true";
  }

  return config;
}

export function resetEnvFilesLoaded(): void {
  envFilesLoaded = false;
}

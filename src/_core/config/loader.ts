import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReveniumConfig, SummaryFormat } from "../types/index.js";
import { DEFAULT_REVENIUM_BASE_URL, ENV_VARS } from "../constants.js";
import { parseEnvFile } from "./env-file.js";
import { getLogger } from "./manager.js";

function parsePrintSummaryValue(value: string | undefined): boolean | SummaryFormat {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  if (normalized === "json") return "json";
  if (normalized === "human" || normalized === "true") return "human";
  return false;
}

let envFilesLoaded = false;

const ENV_FILES = [".env.local", ".env"];

function applyEnvFile(path: string): void {
  if (!existsSync(path)) return;

  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf-8")))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnvFiles(): void {
  if (envFilesLoaded) return;
  envFilesLoaded = true;

  try {
    const cwd = process.cwd();
    for (const envFile of ENV_FILES) {
      applyEnvFile(join(cwd, envFile));
    }
  } catch (error) {
    getLogger().warn(
      `Could not load .env files: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type EnvReveniumConfig = ReveniumConfig & { reveniumBaseUrl: string };

type ReveniumEnvironment = Partial<EnvReveniumConfig> & Pick<EnvReveniumConfig, "reveniumBaseUrl">;

export function readReveniumEnvironment(): ReveniumEnvironment {
  loadEnvFiles();

  const environment: ReveniumEnvironment = {
    reveniumApiKey:
      process.env[ENV_VARS.REVENIUM_API_KEY] || process.env[ENV_VARS.REVENIUM_API_KEY_ALT],
    reveniumBaseUrl:
      process.env[ENV_VARS.REVENIUM_BASE_URL] ||
      process.env[ENV_VARS.REVENIUM_BASE_URL_ALT] ||
      DEFAULT_REVENIUM_BASE_URL,
    printSummary: parsePrintSummaryValue(process.env[ENV_VARS.PRINT_SUMMARY]),
    reveniumTeamId: process.env[ENV_VARS.TEAM_ID],
    reveniumEnforcementBaseUrl: process.env[ENV_VARS.ENFORCEMENT_BASE_URL],
  };

  const capturePromptsEnv = process.env[ENV_VARS.CAPTURE_PROMPTS];
  if (capturePromptsEnv !== undefined) {
    environment.capturePrompts = capturePromptsEnv.toLowerCase() === "true";
  }

  return environment;
}

export function loadConfigFromEnv(): EnvReveniumConfig | null {
  const environment = readReveniumEnvironment();
  const { reveniumApiKey } = environment;
  if (!reveniumApiKey) return null;

  return { ...environment, reveniumApiKey };
}

export function resetEnvFilesLoaded(): void {
  envFilesLoaded = false;
}

import { DEFAULT_REVENIUM_BASE_URL } from "../constants.js";
import type { ReveniumConfig } from "../types/index.js";
import { readReveniumEnvironment } from "./loader.js";
import { getConfig } from "./manager.js";
import { validateConfig, type ValidatedConfig } from "./validator.js";

export function applyDefined<T extends object>(base: T, overrides: Partial<T>): T {
  const merged: T = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Reflect.set(merged, key, value);
  }

  return merged;
}

function inheritableBy<T extends Partial<ReveniumConfig>>(source: T, apiKey?: string): T {
  if (!apiKey || !source.reveniumApiKey || apiKey === source.reveniumApiKey) return source;

  const {
    reveniumTeamId: _teamId,
    reveniumEnforcementBaseUrl: _enforcementBaseUrl,
    ...withoutOrganizationIdentity
  } = source;
  return withoutOrganizationIdentity as T;
}

export function withEnvironmentDefaults<T extends ReveniumConfig>(
  config: Partial<T>,
): ValidatedConfig<T> {
  const environment = readReveniumEnvironment() as Partial<T>;
  const resolved = applyDefined(inheritableBy(environment, config.reveniumApiKey), config);
  validateConfig(resolved);
  return resolved;
}

export function snapshotClientConfig<T extends ReveniumConfig>(config: T): T {
  const processConfig = { ...getConfig() } as T;
  const layered = applyDefined(inheritableBy(processConfig, config.reveniumApiKey), config);

  return {
    ...layered,
    reveniumBaseUrl: layered.reveniumBaseUrl || DEFAULT_REVENIUM_BASE_URL,
  };
}

import { DEFAULT_REVENIUM_BASE_URL } from "../constants.js";
import type { ReveniumConfig } from "../types/index.js";
import { getConfig } from "./manager.js";

export function applyDefined<T extends ReveniumConfig>(base: T, overrides: Partial<T>): T {
  const merged: T = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Reflect.set(merged, key, value);
  }

  return merged;
}

function inheritableProcessConfig(clientApiKey?: string): ReveniumConfig {
  const processConfig = { ...getConfig() } as ReveniumConfig;
  if (!clientApiKey || clientApiKey === processConfig.reveniumApiKey) return processConfig;

  const { reveniumTeamId: _teamId, ...withoutOrganizationIdentity } = processConfig;
  return withoutOrganizationIdentity as ReveniumConfig;
}

export function snapshotClientConfig<T extends ReveniumConfig>(config: T): T {
  const layered = applyDefined(inheritableProcessConfig(config.reveniumApiKey) as T, config);

  return {
    ...layered,
    reveniumBaseUrl: layered.reveniumBaseUrl || DEFAULT_REVENIUM_BASE_URL,
  };
}

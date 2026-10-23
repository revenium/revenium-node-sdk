import { AsyncLocalStorage } from "async_hooks";
import { ReveniumConfig } from "../types/index.js";
import { getConfig } from "./manager.js";

const CALL_CONFIG_STORAGE_KEY = Symbol.for("revenium.middleware.callConfig");

function loadCallConfigStorage(): AsyncLocalStorage<ReveniumConfig> {
  const host = globalThis as Record<symbol, AsyncLocalStorage<ReveniumConfig> | undefined>;
  const existing = host[CALL_CONFIG_STORAGE_KEY];
  if (existing) return existing;

  const created = new AsyncLocalStorage<ReveniumConfig>();
  host[CALL_CONFIG_STORAGE_KEY] = created;
  return created;
}

const callConfigStorage = loadCallConfigStorage();

export function runWithCallConfig<T>(config: ReveniumConfig | null | undefined, fn: () => T): T {
  return config ? callConfigStorage.run(config, fn) : fn();
}

export function getCallConfig(): ReveniumConfig | null {
  return callConfigStorage.getStore() ?? null;
}

export function resolveConfig(): ReveniumConfig | null {
  const callConfig = getCallConfig();
  return callConfig?.reveniumApiKey ? callConfig : getConfig();
}

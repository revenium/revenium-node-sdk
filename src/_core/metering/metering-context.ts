import { AsyncLocalStorage } from "async_hooks";
import { getLogger } from "../config/manager.js";
import { UsageMetadata } from "../types/index.js";

export interface MeteringContext {
  meteredBy?: string;
  usageMetadata?: UsageMetadata;
}

interface SharedMeteringState {
  contextStorage: AsyncLocalStorage<MeteringContext>;
  warnedPairs: Set<string>;
}

const SHARED_STATE_KEY = Symbol.for("revenium.middleware.meteringContext");

function loadSharedState(): SharedMeteringState {
  const host = globalThis as Record<symbol, SharedMeteringState | undefined>;
  const existing = host[SHARED_STATE_KEY];
  if (existing) return existing;

  const created: SharedMeteringState = {
    contextStorage: new AsyncLocalStorage<MeteringContext>(),
    warnedPairs: new Set<string>(),
  };
  host[SHARED_STATE_KEY] = created;
  return created;
}

const sharedState = loadSharedState();

function warnMeteringSkippedOnce(skippedSource: string, meteredBy: string): void {
  const pair = `${skippedSource}->${meteredBy}`;
  if (sharedState.warnedPairs.has(pair)) return;
  sharedState.warnedPairs.add(pair);
  getLogger().warn(
    `Usage for this request is metered by ${meteredBy}; ${skippedSource} will not meter it to avoid duplicate records`,
  );
}

export async function runProviderCall<T>(
  source: string,
  usageMetadata: UsageMetadata | undefined,
  call: () => Promise<T>,
): Promise<{ result: T; meteredElsewhere: boolean }> {
  const context: MeteringContext = { usageMetadata };
  const result = await sharedState.contextStorage.run(context, call);

  if (!context.meteredBy) return { result, meteredElsewhere: false };

  warnMeteringSkippedOnce(source, context.meteredBy);
  return { result, meteredElsewhere: true };
}

export function claimMetering(source: string): void {
  const context = sharedState.contextStorage.getStore();
  if (context) context.meteredBy = source;
}

export function getCallUsageMetadata(): UsageMetadata | undefined {
  return sharedState.contextStorage.getStore()?.usageMetadata;
}

export function resetMeteringWarnings(): void {
  sharedState.warnedPairs.clear();
}

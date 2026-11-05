import type { InQueueQueueStatus, QueueClient, Result } from "@fal-ai/client";
import { runWithCallConfig } from "../_core/config/call-config.js";
import { enforceCostControls } from "../_core/enforcement/evaluator.js";
import { resolveAgenticJobFields } from "../_core/metadata/metadata-builder.js";
import type { MeteredRequestLedger } from "../_core/metering/metered-request-ledger.js";
import type { ReveniumConfig } from "../_core/types/index.js";
import { withConfigDefaults } from "./config.js";
import {
  buildFalEnforcementScope,
  retainBilledInput,
  trackFalResult,
  type FalResultCall,
} from "./tracking.js";
import type { FalConfig, FalUsageMetadata } from "./types.js";

type QueueSubmitOptions = Omit<Parameters<QueueClient["submit"]>[1], "input"> & {
  readonly input?: Record<string, any>;
};
type QueueResultOptions = Parameters<QueueClient["result"]>[1] & {
  input?: Record<string, any>;
};

export interface PendingFalJob {
  input: Record<string, unknown>;
  metadata?: FalUsageMetadata;
  submittedAt: number;
}

type FalJobLedger = MeteredRequestLedger<PendingFalJob>;

export type MeteredFalQueue = Omit<QueueClient, "submit" | "result"> & {
  submit(
    endpointId: string,
    options: QueueSubmitOptions,
    usageMetadata?: FalUsageMetadata,
  ): Promise<InQueueQueueStatus>;
  result<T = any>(
    endpointId: string,
    options: QueueResultOptions,
    usageMetadata?: FalUsageMetadata,
  ): Promise<Result<T>>;
};

interface MeteredQueueDependencies {
  ledger: FalJobLedger;
  falConfig: FalConfig;
  reveniumConfig: ReveniumConfig;
}

function snapshotSubmitMetadata(usageMetadata?: FalUsageMetadata): FalUsageMetadata {
  return { ...resolveAgenticJobFields(usageMetadata), ...structuredClone(usageMetadata) };
}

export function meterQueuedResult(
  ledger: FalJobLedger,
  call: FalResultCall & { requestId: string },
): void {
  const { requestId, usageMetadata } = call;
  if (!ledger.claim(requestId)) return;

  trackFalResult({
    ...call,
    usageMetadata: {
      ...usageMetadata,
      idempotencyKey: usageMetadata?.idempotencyKey ?? `fal-${requestId}`,
    },
    onDelivered: () => ledger.forgetContext(requestId),
    onDeliveryFailure: () => ledger.release(requestId),
  });
}

export function createMeteredQueue(
  rawQueue: QueueClient,
  { ledger, falConfig, reveniumConfig }: MeteredQueueDependencies,
): MeteredFalQueue {
  return {
    ...rawQueue,
    submit(endpointId, options, usageMetadata) {
      return runWithCallConfig(reveniumConfig, async () => {
        const metadata = withConfigDefaults(falConfig, usageMetadata);
        await enforceCostControls(buildFalEnforcementScope(endpointId, options.input, metadata));
        const submitted = {
          input: retainBilledInput(options.input),
          metadata: snapshotSubmitMetadata(usageMetadata),
          submittedAt: Date.now(),
        };

        const status = await rawQueue.submit(endpointId, options);
        ledger.rememberContext(status.request_id, submitted);
        return status;
      });
    },
    result(endpointId, { input: billedInput, ...queueOptions }, usageMetadata) {
      return runWithCallConfig(reveniumConfig, async () => {
        const collectionStart = Date.now();
        const collected = await rawQueue.result(endpointId, queueOptions);

        const { requestId } = queueOptions;
        const pending = ledger.contextFor(requestId);
        const metadata = withConfigDefaults(falConfig, { ...pending?.metadata, ...usageMetadata });
        const input = billedInput ?? pending?.input ?? {};
        meterQueuedResult(ledger, {
          endpointId,
          startTime: pending?.submittedAt ?? collectionStart,
          input,
          result: collected.data,
          isStreamed: false,
          requestId,
          usageMetadata: metadata,
          enforcementScope: buildFalEnforcementScope(endpointId, input, metadata),
        });
        return collected;
      });
    },
  };
}

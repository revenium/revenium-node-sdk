import { randomUUID } from "crypto";
import { createFalClient } from "@fal-ai/client";
import type { FalClient } from "@fal-ai/client";
import { getLogger } from "../_core/config/manager.js";
import { validateConfig } from "../_core/config/validator.js";
import { runWithCallConfig } from "../_core/config/call-config.js";
import { enforceCostControls } from "../_core/enforcement/evaluator.js";
import { MeteredRequestLedger } from "../_core/metering/metered-request-ledger.js";
import type { ReveniumConfig } from "../_core/types/index.js";
import { toClientReveniumConfig, withConfigDefaults } from "./config.js";
import {
  createMeteredQueue,
  meterQueuedResult,
  type MeteredFalQueue,
  type PendingFalJob,
} from "./metered-queue.js";
import { buildFalEnforcementScope, trackFalResult } from "./tracking.js";
import type { FalConfig, FalUsageMetadata } from "./types.js";

export class ReveniumFal {
  private client: FalClient;
  private falConfig: FalConfig;
  private reveniumConfig: ReveniumConfig;
  private readonly ledger = new MeteredRequestLedger<PendingFalJob>();
  private readonly meteredQueue: MeteredFalQueue;

  constructor(config: FalConfig, falClientConfig?: Parameters<typeof createFalClient>[0]) {
    this.falConfig = config;
    this.reveniumConfig = toClientReveniumConfig(config);
    validateConfig(this.reveniumConfig);
    this.client = createFalClient({
      ...(config.falApiKey ? { credentials: config.falApiKey } : {}),
      ...falClientConfig,
    });
    this.meteredQueue = createMeteredQueue(this.client.queue, {
      ledger: this.ledger,
      falConfig: this.falConfig,
      reveniumConfig: this.reveniumConfig,
    });
  }

  async run<T = any>(
    endpointId: string,
    options: Record<string, any>,
    usageMetadata?: FalUsageMetadata,
  ): Promise<{ data: T; requestId: string }> {
    return runWithCallConfig(this.reveniumConfig, () =>
      this.meteredRun(endpointId, options, usageMetadata),
    );
  }

  private async meteredRun<T = any>(
    endpointId: string,
    options: Record<string, any>,
    usageMetadata?: FalUsageMetadata,
  ): Promise<{ data: T; requestId: string }> {
    const metadata = withConfigDefaults(this.falConfig, usageMetadata);
    const enforcementScope = buildFalEnforcementScope(endpointId, options.input, metadata);
    await enforceCostControls(enforcementScope);
    const startTime = Date.now();

    const result = await this.client.run(endpointId, options);

    trackFalResult({
      endpointId,
      startTime,
      input: options.input,
      result: result.data,
      isStreamed: false,
      requestId: result.requestId,
      usageMetadata: metadata,
      enforcementScope,
    });

    return result as { data: T; requestId: string };
  }

  async subscribe<T = any>(
    endpointId: string,
    options: Record<string, any>,
    usageMetadata?: FalUsageMetadata,
  ): Promise<{ data: T; requestId: string }> {
    return runWithCallConfig(this.reveniumConfig, () =>
      this.meteredSubscribe(endpointId, options, usageMetadata),
    );
  }

  private async meteredSubscribe<T = any>(
    endpointId: string,
    options: Record<string, any>,
    usageMetadata?: FalUsageMetadata,
  ): Promise<{ data: T; requestId: string }> {
    const metadata = withConfigDefaults(this.falConfig, usageMetadata);
    const enforcementScope = buildFalEnforcementScope(endpointId, options.input, metadata);
    await enforceCostControls(enforcementScope);
    const startTime = Date.now();

    const result = await this.client.subscribe(endpointId, options);

    meterQueuedResult(this.ledger, {
      endpointId,
      startTime,
      input: options.input,
      result: result.data,
      isStreamed: false,
      requestId: result.requestId || randomUUID(),
      usageMetadata: metadata,
      enforcementScope,
    });

    return result as { data: T; requestId: string };
  }

  async stream<T = any>(
    endpointId: string,
    options: Record<string, any>,
    usageMetadata?: FalUsageMetadata,
  ): Promise<any> {
    return runWithCallConfig(this.reveniumConfig, () =>
      this.meteredStream<T>(endpointId, options, usageMetadata),
    );
  }

  private async meteredStream<T = any>(
    endpointId: string,
    options: Record<string, any>,
    usageMetadata?: FalUsageMetadata,
  ): Promise<any> {
    const metadata = withConfigDefaults(this.falConfig, usageMetadata);
    const enforcementScope = buildFalEnforcementScope(endpointId, options.input, metadata);
    await enforceCostControls(enforcementScope);
    const startTime = Date.now();
    const logger = getLogger();

    const falStream = await this.client.stream(endpointId, options);

    falStream.on("done", (finalResult: T) => {
      const rawResult = finalResult as Record<string, unknown>;
      const resultData =
        rawResult?.data && typeof rawResult.data === "object"
          ? (rawResult.data as Record<string, unknown>)
          : rawResult;

      runWithCallConfig(this.reveniumConfig, () =>
        trackFalResult({
          endpointId,
          startTime,
          input: options.input,
          result: resultData,
          isStreamed: true,
          usageMetadata: metadata,
          enforcementScope,
        }),
      );
    });

    falStream.on("error", (error: unknown) => {
      logger.warn("Fal stream error", {
        error: error instanceof Error ? error.message : String(error),
        endpointId,
      });
    });

    return falStream;
  }

  get queue(): MeteredFalQueue {
    return this.meteredQueue;
  }

  get realtime() {
    return this.client.realtime;
  }

  get storage() {
    return this.client.storage;
  }

  getUnderlyingClient(): FalClient {
    return this.client;
  }

  getConfig(): FalConfig {
    return this.falConfig;
  }
}

import { createFalClient } from "@fal-ai/client";
import type { FalClient } from "@fal-ai/client";
import { getLogger } from "../_core/config/manager.js";
import { validateConfig } from "../_core/config/validator.js";
import { runWithCallConfig } from "../_core/config/call-config.js";
import type { ReveniumConfig } from "../_core/types/index.js";
import { toClientReveniumConfig } from "./config.js";
import { detectMediaType } from "./media-type-detector.js";
import { trackFalUsageAsync } from "./tracking.js";
import type { FalConfig, FalUsageMetadata } from "./types.js";

export class ReveniumFal {
  private client: FalClient;
  private falConfig: FalConfig;
  private reveniumConfig: ReveniumConfig;

  constructor(config: FalConfig, falClientConfig?: Parameters<typeof createFalClient>[0]) {
    this.falConfig = config;
    this.reveniumConfig = toClientReveniumConfig(config);
    validateConfig(this.reveniumConfig);
    this.client = createFalClient({
      ...(config.falApiKey ? { credentials: config.falApiKey } : {}),
      ...falClientConfig,
    });
  }

  private mergeConfigDefaults(metadata?: FalUsageMetadata): FalUsageMetadata | undefined {
    if (!this.falConfig.organizationName && !this.falConfig.organizationId) return metadata;
    return {
      organizationName: this.falConfig.organizationName || this.falConfig.organizationId,
      ...metadata,
    };
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
    const startTime = Date.now();

    const result = await this.client.run(endpointId, options);
    const duration = Date.now() - startTime;
    const operationType = detectMediaType(endpointId, result.data);

    trackFalUsageAsync({
      endpointId,
      operationType,
      startTime,
      duration,
      input: (options.input as Record<string, unknown>) || {},
      result: (result.data as Record<string, unknown>) || {},
      isStreamed: false,
      requestId: result.requestId,
      usageMetadata: this.mergeConfigDefaults(usageMetadata),
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
    const startTime = Date.now();

    const result = await this.client.subscribe(endpointId, options);
    const duration = Date.now() - startTime;
    const operationType = detectMediaType(endpointId, result.data);

    trackFalUsageAsync({
      endpointId,
      operationType,
      startTime,
      duration,
      input: (options.input as Record<string, unknown>) || {},
      result: (result.data as Record<string, unknown>) || {},
      isStreamed: false,
      requestId: result.requestId,
      usageMetadata: this.mergeConfigDefaults(usageMetadata),
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
    const startTime = Date.now();
    const logger = getLogger();

    const falStream = await this.client.stream(endpointId, options);

    falStream.on("done", (finalResult: T) => {
      const duration = Date.now() - startTime;
      const rawResult = finalResult as Record<string, unknown>;
      const resultData =
        rawResult?.data && typeof rawResult.data === "object"
          ? (rawResult.data as Record<string, unknown>)
          : rawResult;
      const operationType = detectMediaType(endpointId, resultData);

      runWithCallConfig(this.reveniumConfig, () =>
        trackFalUsageAsync({
          endpointId,
          operationType,
          startTime,
          duration,
          input: (options.input as Record<string, unknown>) || {},
          result: resultData || {},
          isStreamed: true,
          usageMetadata: this.mergeConfigDefaults(usageMetadata),
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

  get queue() {
    return this.client.queue;
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

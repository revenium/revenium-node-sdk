import OpenAI, { AzureOpenAI } from "openai";
import { Config } from "../_core/types/index.js";
import { getLogger, getConfig, setConfig, initializeConfig } from "../_core/config/manager.js";
import { validateConfig } from "../_core/config/validator.js";
import { snapshotClientConfig } from "../_core/config/client-config.js";
import { DEFAULT_REVENIUM_BASE_URL } from "../_core/constants.js";
import { startEnforcementPolling, stopEnforcementPolling } from "../_core/enforcement/engine.js";
import {
  ChatInterface,
  EmbeddingsInterface,
  ResponsesInterface,
  ImagesInterface,
  AudioTranscriptionsInterface,
  AudioTranslationsInterface,
  AudioSpeechInterface,
} from "./middleware.js";
import { Provider, ProviderInfo, detectProviderFromConfig } from "./provider-detection.js";
import { AzureConfig, loadAzureConfigFromEnv } from "./azure-config.js";
import { resetMeteringWarnings } from "../_core/metering/metering-context.js";

const lateBoundGlobalFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);

export interface OpenAIConfig extends Config {
  azure?: AzureConfig;
  openaiApiKey?: string;
}

export class ReveniumOpenAI {
  private client: OpenAI | AzureOpenAI;
  private config: OpenAIConfig;
  private providerInfo: ProviderInfo;
  private responsesInterface?: ResponsesInterface;

  constructor(config: OpenAIConfig, provider: Provider) {
    const logger = getLogger();

    const azure = provider === Provider.AZURE_OPENAI ? config.azure : undefined;
    if (provider === Provider.AZURE_OPENAI && !azure) {
      throw new Error("Azure configuration required for Azure OpenAI provider");
    }

    this.config = snapshotClientConfig(config);
    validateConfig(this.config);

    if (azure) {
      this.client = new AzureOpenAI({
        apiKey: azure.apiKey,
        endpoint: azure.endpoint,
        apiVersion: azure.apiVersion,
        fetch: lateBoundGlobalFetch,
      });

      this.providerInfo = {
        provider: Provider.AZURE_OPENAI,
        isAzure: true,
        azureConfig: azure,
      };
    } else {
      this.client = new OpenAI({ apiKey: config.openaiApiKey, fetch: lateBoundGlobalFetch });
      this.providerInfo = { provider: Provider.OPENAI, isAzure: false };
    }

    logger.info("Revenium OpenAI client created", {
      provider: this.providerInfo.provider,
      isAzure: this.providerInfo.isAzure,
    });
  }

  chat(): ChatInterface {
    return new ChatInterface(this.client, this.config, this.providerInfo);
  }

  embeddings(): EmbeddingsInterface {
    return new EmbeddingsInterface(this.client, this.config, this.providerInfo);
  }

  responses(): ResponsesInterface {
    this.responsesInterface ??= new ResponsesInterface(this.client, this.config, this.providerInfo);
    return this.responsesInterface;
  }

  images(): ImagesInterface {
    return new ImagesInterface(this.client.images, this.config, this.providerInfo);
  }

  audio() {
    return {
      transcriptions: new AudioTranscriptionsInterface(
        this.client.audio.transcriptions,
        this.config,
        this.providerInfo,
      ),
      translations: new AudioTranslationsInterface(
        this.client.audio.translations,
        this.config,
        this.providerInfo,
      ),
      speech: new AudioSpeechInterface(this.client.audio.speech, this.config, this.providerInfo),
    };
  }

  getUnderlyingClient(): OpenAI | AzureOpenAI {
    return this.client;
  }

  getProviderInfo(): ProviderInfo {
    return this.providerInfo;
  }

  getConfig(): OpenAIConfig {
    return this.config;
  }
}

let globalClient: ReveniumOpenAI | null = null;

export function Initialize(config?: Partial<OpenAIConfig>): void {
  let finalConfig: OpenAIConfig;

  if (config) {
    finalConfig = {
      reveniumBaseUrl: DEFAULT_REVENIUM_BASE_URL,
      debug: false,
      ...config,
    } as OpenAIConfig;
  } else {
    const envLoaded = initializeConfig();
    if (!envLoaded) {
      throw new Error(
        "Failed to load configuration from environment variables. " +
          "Ensure REVENIUM_METERING_API_KEY and OPENAI_API_KEY are set.",
      );
    }
    finalConfig = getConfig()! as OpenAIConfig;

    const azureConfig = loadAzureConfigFromEnv();
    if (azureConfig) {
      finalConfig.azure = azureConfig;
    }
  }

  validateConfig(finalConfig);
  setConfig(finalConfig);

  const providerInfo = detectProviderFromConfig(finalConfig);
  globalClient = new ReveniumOpenAI(finalConfig, providerInfo.provider);

  startEnforcementPolling();
}

export function GetClient(): ReveniumOpenAI {
  if (!globalClient) {
    throw new Error(
      "Revenium client not initialized. Call Initialize() first.\n\n" +
        "Example:\n" +
        '  import { Initialize, GetClient } from "@revenium/middleware/openai";\n' +
        "  Initialize();\n" +
        "  const client = GetClient();",
    );
  }
  return globalClient;
}

export function IsInitialized(): boolean {
  return globalClient !== null;
}

export function Reset(): void {
  stopEnforcementPolling();
  resetMeteringWarnings();
  globalClient = null;
}

export function Configure(config: Partial<OpenAIConfig>): void {
  Initialize(config);
}

import { AzureConfig } from "./azure-config.js";

export enum Provider {
  OPENAI = "OPENAI",
  AZURE_OPENAI = "AZURE_OPENAI",
}

export interface ProviderInfo {
  provider: Provider;
  isAzure: boolean;
  endpoint?: string;
  apiVersion?: string;
  azureConfig?: AzureConfig;
}

export interface OpenAIProviderConfig {
  azure?: AzureConfig;
  openaiApiKey?: string;
}

export function detectProviderFromConfig(config: OpenAIProviderConfig): ProviderInfo {
  if (config.azure?.apiKey && config.azure?.endpoint) {
    return {
      provider: Provider.AZURE_OPENAI,
      isAzure: true,
      azureConfig: config.azure,
    };
  }

  return {
    provider: Provider.OPENAI,
    isAzure: false,
  };
}

export function getProviderMetadata(providerInfo: ProviderInfo): {
  provider: string;
  modelSource: string;
} {
  if (providerInfo.isAzure) {
    return { provider: "Azure", modelSource: "AZURE_OPENAI" };
  }
  return { provider: "OpenAI", modelSource: "OPENAI" };
}

export function hasAzureConfig(): boolean {
  return !!(
    process.env.AZURE_OPENAI_ENDPOINT ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_OPENAI_API_KEY
  );
}

export function validateAzureConfig(config: AzureConfig): {
  isValid: boolean;
  missingFields: string[];
  warnings: string[];
} {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (!config.endpoint) missingFields.push("endpoint");
  if (!config.apiKey) missingFields.push("apiKey");
  if (!(config.apiVersion || process.env.OPENAI_API_VERSION)) missingFields.push("apiVersion");

  if (config.endpoint) {
    try {
      new URL(config.endpoint);
      if (!config.endpoint.toLowerCase().includes("azure")) {
        warnings.push("endpoint does not contain 'azure' - please verify");
      }
    } catch {
      missingFields.push("valid endpoint URL");
    }
  }

  return { isValid: missingFields.length === 0, missingFields, warnings };
}

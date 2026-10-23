export interface Credential {
  name: string;
  value: string;
}

export interface Subscriber {
  id?: string;
  email?: string;
  credential?: Credential;
}

export interface UsageMetadata {
  subscriber?: Subscriber;
  organizationName?: string;
  /** @deprecated Use organizationName instead */
  organizationId?: string;
  productName?: string;
  /** @deprecated Use productName instead */
  productId?: string;
  subscriptionId?: string;
  taskType?: string;
  traceId?: string;
  responseQualityScore?: number;
  agent?: string;
  capturePrompts?: boolean;
  agenticJobId?: string;
  agenticJobName?: string;
  agenticJobType?: string;
  agenticJobVersion?: string;
  retryNumber?: number;
  environment?: string;
  region?: string;
  parentTransactionId?: string;
  transactionName?: string;
  traceType?: string;
  traceName?: string;
  ticketId?: string;
  operationSubtype?: string;
  errorReason?: string;
  credentialAlias?: string;
  mediationLatency?: number;
  systemFingerprint?: string;
  temperature?: number;
  idempotencyKey?: string;
  skillName?: string;
  skillSource?: string;
  skillKind?: string;
  skillPluginName?: string;
  skillMarketplaceName?: string;
  skillInvocationTrigger?: string;
  /** snake_case aliases for the skill fields above. */
  skill_name?: string;
  skill_source?: string;
  skill_kind?: string;
  skill_plugin_name?: string;
  skill_marketplace_name?: string;
  skill_invocation_trigger?: string;
}

export type OperationType =
  | "CHAT"
  | "GENERATE"
  | "EMBED"
  | "CLASSIFY"
  | "SUMMARIZE"
  | "TRANSLATE"
  | "IMAGE"
  | "AUDIO"
  | "VIDEO"
  | "OTHER";

export type SummaryFormat = "human" | "json";

export interface ReveniumConfig {
  reveniumApiKey: string;
  reveniumBaseUrl?: string;
  debug?: boolean;
  printSummary?: boolean | SummaryFormat;
  reveniumTeamId?: string;
  reveniumEnforcementBaseUrl?: string;
  capturePrompts?: boolean;
  maxPromptSize?: number;
  failSilent?: boolean;
  maxRetries?: number;
  bufferMaxSize?: number;
  bufferFlushIntervalMs?: number;
}

export type WithUsageMetadata<T> = T & {
  usageMetadata?: UsageMetadata;
};

export type Config = ReveniumConfig;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown> | string): void;
  info(message: string, meta?: Record<string, unknown> | string): void;
  warn(message: string, meta?: Record<string, unknown> | string): void;
  error(message: string, meta?: Record<string, unknown> | string | unknown): void;
}

export interface ReveniumPayload {
  transactionId: string;
  operationType: OperationType;
  costType: "AI";
  model: string;
  provider: string;
  modelSource?: string;
  middlewareSource: string;
  requestTime: string;
  responseTime: string;
  requestDuration: number;
  completionStartTime: string;
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  totalTokenCount: number | null;
  reasoningTokenCount: number | undefined;
  cacheCreationTokenCount: number | undefined;
  cacheReadTokenCount: number | undefined;
  cacheCreation5mTokenCount?: number | undefined;
  cacheCreation1hTokenCount?: number | undefined;
  stopReason: string;
  isStreamed: boolean;
  timeToFirstToken?: number | undefined;
  inputTokenCost?: number;
  outputTokenCost?: number;
  totalCost?: number;
  traceId?: string;
  taskType?: string;
  agent?: string;
  organizationName?: string;
  productName?: string;
  subscriber?: Subscriber;
  subscriptionId?: string;
  responseQualityScore?: number;
  requestedImageCount?: number;
  actualImageCount?: number;
  durationSeconds?: number;
  resolution?: string;
  quality?: string;
  style?: string;
  characterCount?: number;
  billingUnit?: string;
  inputAudioTokenCount?: number;
  outputAudioTokenCount?: number;
  attributes?: Record<string, unknown>;
  environment?: string;
  operationSubtype?: string;
  retryNumber?: number;
  parentTransactionId?: string;
  transactionName?: string;
  region?: string;
  credentialAlias?: string;
  traceType?: string;
  traceName?: string;
  ticketId?: string;
  skillName?: string;
  skillSource?: string;
  skillKind?: string;
  skillPluginName?: string;
  skillMarketplaceName?: string;
  skillInvocationTrigger?: string;
  agenticJobId?: string;
  agenticJobName?: string;
  agenticJobType?: string;
  agenticJobVersion?: string;
  idempotencyKey?: string;
  systemPrompt?: string;
  inputMessages?: string;
  outputResponse?: string;
  promptsTruncated?: boolean;
}

import type { UsageMetadata } from "../_core/types/index.js";

export type MessageRole = "system" | "user" | "assistant" | "function" | "tool";

export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export interface ChatMessage {
  role: MessageRole;
  content?: string | null;
  name?: string;
  function_call?: FunctionCall;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LiteLLMChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  functions?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  function_call?: "none" | "auto" | { name: string };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: "none" | "auto" | { type: "function"; function: { name: string } };
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          schema?: Record<string, unknown>;
          strict?: boolean;
        };
      };
  seed?: number;
  user?: string;
}

export interface ResponseMessage {
  role: "assistant";
  content: string | null;
  function_call?: FunctionCall;
  tool_calls?: ToolCall[];
}

export interface ResponseChoice {
  index: number;
  message: ResponseMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /**
   * Anthropic-native cache fields. LiteLLM does not consistently normalize every
   * provider into the OpenAI-compatible shape above -- when proxying Anthropic
   * models it can surface these directly on the usage object instead of (or in
   * addition to) `prompt_tokens_details.cached_tokens`. These are ADDITIONAL to
   * `prompt_tokens`, not a subset of it (see extractCacheTokenCounts).
   */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LiteLLMChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ResponseChoice[];
  usage?: TokenUsage;
  system_fingerprint?: string;
}

export interface LiteLLMEmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
  dimensions?: number;
  user?: string;
  [key: string]: any;
}

export interface LiteLLMEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  [key: string]: any;
}

export type RequestBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream<Uint8Array>
  | null;

export interface RequestContext {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestBody;
  startTime: number;
  metadata?: LiteLLMUsageMetadata;
}

export interface LiteLLMUsageMetadata extends UsageMetadata {
  taskId?: string;
  subscriberEmail?: string;
  subscriberId?: string;
  subscriberCredentialName?: string;
  subscriberCredential?: string;
  maxPromptSize?: number;
}

export interface LiteLLMConfig {
  reveniumMeteringApiKey: string;
  reveniumMeteringBaseUrl: string;
  litellmProxyUrl: string;
  litellmApiKey?: string;
  organizationName?: string;
  /** @deprecated Use organizationName instead. Wire-emit uses organizationName only. */
  organizationId?: string;
  apiTimeout?: number;
  failSilent?: boolean;
  maxRetries?: number;
  printSummary?: boolean | "human" | "json";
  teamId?: string;
  capturePrompts?: boolean;
  maxPromptSize?: number;
}

export interface MiddlewareStatus {
  initialized: boolean;
  patched: boolean;
  hasConfig: boolean;
  proxyUrl?: string;
}

export interface ProviderPattern {
  source: string;
  displayName: string;
  patterns: string[];
  prefixes: string[];
}

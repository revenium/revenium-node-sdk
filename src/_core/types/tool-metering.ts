export interface ToolContext {
  agent?: string;
  organizationName?: string;
  productName?: string;
  subscriberCredential?: string;
  workflowId?: string;
  traceId?: string;
  transactionId?: string;
}

export interface ToolMetadata extends ToolContext {
  operation?: string;
  outputFields?: string[];
  usageMetadata?: Record<string, unknown>;
  agenticJobId?: string;
  costUsd?: number;
}

export interface ToolEventPayload {
  idempotencyKey?: string;
  transactionId: string;
  toolId: string;
  operation?: string;
  durationMs: number;
  success: boolean;
  timestamp: string;
  errorMessage?: string;
  usageMetadata?: Record<string, unknown>;
  agent?: string;
  organizationName?: string;
  productName?: string;
  subscriberCredential?: string;
  workflowId?: string;
  traceId?: string;
  agenticJobId?: string;
  costUsd?: number;
  middlewareSource: string;
}

export interface ToolCallReport extends Omit<ToolMetadata, "outputFields"> {
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  timestamp?: string;
}

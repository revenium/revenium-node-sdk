export type {
  ReveniumConfig,
  UsageMetadata,
  Logger,
  Config,
  Credential,
  Subscriber,
  ReveniumPayload,
  OperationType,
} from "./_core/types/index.js";

export type {
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "./_core/types/tool-metering.js";

export {
  meterTool,
  reportToolCall,
  setToolContext,
  getToolContext,
  clearToolContext,
  runWithToolContext,
} from "./_core/tool-metering/index.js";

export {
  initializeConfig,
  resetConfig,
  getConfig,
  setConfig,
  getLogger,
} from "./_core/config/manager.js";

export { validateConfig } from "./_core/config/validator.js";

export { mapStopReason } from "./_core/stop-reason-mapper.js";

export type {
  JobOutcome,
  JobOutcomeAmendment,
  JobOutcomeRevisionEntry,
  JobResource,
  ExecutionStatus,
  OutcomeType,
  JobROIResource,
  JobTimelineResource,
  JobTimelineEvent,
  ConversionFunnelResource,
  ListJobsParams,
  ConversionFunnelParams,
  PageInfo,
  PagedResponse,
} from "./_core/types/jobs.js";
export {
  OutcomeAlreadyReportedError,
  OutcomeNotReportedError,
  OutcomeAmendConflictError,
} from "./_core/types/jobs.js";
export {
  reportJobOutcome,
  amendJobOutcome,
  getJobOutcomeHistory,
  listJobs,
  getJob,
  getJobTypes,
  getJobROI,
  getJobTransactions,
  getConversionFunnel,
  JobContext,
  getJobContext,
  setJobContext,
  clearJobContext,
  runWithJobContext,
} from "./_core/jobs/index.js";
export type { JobContextData, JobContextOptions } from "./_core/jobs/index.js";

export { CostLimitExceeded } from "./_core/resilience/error-handler.js";

export { startEnforcementPolling, stopEnforcementPolling } from "./_core/enforcement/engine.js";

export { enforcePreCallRules } from "./_core/enforcement/evaluator.js";

export type { EnforcementRule } from "./_core/enforcement/cache.js";
export type { EnforcementFilter } from "./_core/enforcement/filters.js";

export { flushMeteringBuffer, getBufferStats } from "./_core/metering/buffer.js";
export type { BufferStats } from "./_core/metering/buffer.js";

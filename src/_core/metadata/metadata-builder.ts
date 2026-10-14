import { UsageMetadata } from "../types/index.js";
import { getJobContext } from "../jobs/job-context.js";
import { ENV_VARS } from "../constants.js";
import { getLogger } from "../config/manager.js";

interface MetadataFieldConfig {
  source: keyof UsageMetadata;
  target?: string;
  transform?: (value: unknown) => unknown;
}

const METADATA_FIELD_MAP: MetadataFieldConfig[] = [
  { source: "traceId" },
  { source: "taskType" },
  { source: "agent" },
  { source: "organizationId" },
  { source: "organizationName" },
  { source: "productId" },
  { source: "productName" },
  { source: "subscriber" },
  { source: "subscriptionId" },
  {
    source: "responseQualityScore",
    transform: (value: unknown) => {
      if (typeof value === "number") return Math.max(0, Math.min(1, value));
      return value;
    },
  },
  { source: "agenticJobId" },
  { source: "agenticJobName" },
  { source: "agenticJobType" },
  { source: "agenticJobVersion" },
  { source: "retryNumber" },
  { source: "environment" },
  { source: "region" },
  { source: "parentTransactionId" },
  { source: "transactionName" },
  { source: "traceType" },
  { source: "traceName" },
  { source: "ticketId" },
  { source: "operationSubtype" },
  { source: "errorReason" },
  { source: "credentialAlias" },
  { source: "mediationLatency" },
  { source: "systemFingerprint" },
  { source: "temperature" },
  { source: "idempotencyKey" },
];

const SKILL_FIELD_MAP: Record<string, (keyof UsageMetadata)[]> = {
  skillName: ["skillName", "skill_name"],
  skillSource: ["skillSource", "skill_source"],
  skillKind: ["skillKind", "skill_kind"],
  skillPluginName: ["skillPluginName", "skill_plugin_name"],
  skillMarketplaceName: ["skillMarketplaceName", "skill_marketplace_name"],
  skillInvocationTrigger: ["skillInvocationTrigger", "skill_invocation_trigger"],
};

const SKILL_FIELD_MAX_LENGTHS: Record<string, number> = {
  skillName: 256, // mirrors the backend skill name column limit
  skillSource: 50, // mirrors the backend skill source column limit
  skillKind: 50, // mirrors the backend skill kind column limit
  skillPluginName: 256, // mirrors the backend skill plugin name column limit
  skillMarketplaceName: 256, // mirrors the backend skill marketplace name column limit
  skillInvocationTrigger: 32, // mirrors the backend skill invocation trigger column limit
};

function truncateToLimit(value: unknown, maxLength: number): unknown {
  if (typeof value === "string" && value.length > maxLength) return value.slice(0, maxLength);
  return value;
}

const AGENTIC_JOB_ENV_VARS = {
  agenticJobId: ENV_VARS.AGENTIC_JOB_ID,
  agenticJobName: ENV_VARS.AGENTIC_JOB_NAME,
  agenticJobType: ENV_VARS.AGENTIC_JOB_TYPE,
  agenticJobVersion: ENV_VARS.AGENTIC_JOB_VERSION,
} as const;

type AgenticJobFields = Partial<Pick<UsageMetadata, keyof typeof AGENTIC_JOB_ENV_VARS>>;

const AGENTIC_JOB_FIELDS = Object.keys(AGENTIC_JOB_ENV_VARS) as (keyof AgenticJobFields)[];

const AGENTIC_JOB_ID_PATTERN = /^(?!types$|conversion-funnel$)[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

function getJobFieldsFromEnv(): AgenticJobFields {
  const result: AgenticJobFields = {};

  for (const field of AGENTIC_JOB_FIELDS) {
    const value = process.env[AGENTIC_JOB_ENV_VARS[field]];
    if (value) result[field] = value;
  }

  return result;
}

export function normalizeAgenticJobId(agenticJobId?: string): string | undefined {
  if (!agenticJobId) return undefined;

  if (!AGENTIC_JOB_ID_PATTERN.test(agenticJobId)) {
    getLogger().warn("agentic_job_id is not in the accepted format. Dropping it.", {
      length: agenticJobId.length,
    });
    return undefined;
  }

  return agenticJobId;
}

function pickAgenticJobFields(source: AgenticJobFields): AgenticJobFields {
  const fields: AgenticJobFields = {};

  for (const field of AGENTIC_JOB_FIELDS) {
    const value = source[field];
    if (value) fields[field] = value;
  }

  return fields;
}

export function resolveAgenticJobFields(usageMetadata?: UsageMetadata): AgenticJobFields {
  const sources = [getJobFieldsFromEnv(), getJobContext(), usageMetadata ?? {}];
  const resolved: AgenticJobFields = {};

  for (const source of sources) {
    const fields = pickAgenticJobFields(source);
    if (fields.agenticJobId && !normalizeAgenticJobId(fields.agenticJobId)) continue;

    Object.assign(resolved, fields);
  }

  return resolved;
}

export function resolveSkillFields(usageMetadata?: UsageMetadata): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!usageMetadata) return result;

  for (const [targetField, aliases] of Object.entries(SKILL_FIELD_MAP)) {
    const alias = aliases.find((source) => usageMetadata[source] !== undefined);
    if (alias) {
      result[targetField] = truncateToLimit(
        usageMetadata[alias],
        SKILL_FIELD_MAX_LENGTHS[targetField],
      );
    }
  }

  return result;
}

export function buildMetadataFields(usageMetadata?: UsageMetadata): Record<string, unknown> {
  const jobFields = resolveAgenticJobFields(usageMetadata);
  const merged: UsageMetadata = { ...usageMetadata, ...jobFields };

  if (!usageMetadata && !Object.keys(jobFields).length) {
    return {};
  }

  const result: Record<string, unknown> = {};

  for (const config of METADATA_FIELD_MAP) {
    const value = merged[config.source];
    if (value === undefined) continue;

    if (config.source === "organizationId" || config.source === "productId") {
      continue;
    }

    const transformedValue = config.transform ? config.transform(value) : value;
    const targetField = config.target || config.source;
    result[targetField] = transformedValue;
  }

  if (merged.organizationName || merged.organizationId) {
    result.organizationName = merged.organizationName || merged.organizationId;
  }

  if (merged.productName || merged.productId) {
    result.productName = merged.productName || merged.productId;
  }

  Object.assign(result, resolveSkillFields(merged));

  return result;
}

export function validateMetadata(
  usageMetadata?: UsageMetadata,
  requiredFields: (keyof UsageMetadata)[] = [],
): { isValid: boolean; missingFields: string[]; warnings: string[] } {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (!usageMetadata && requiredFields.length > 0) {
    return {
      isValid: false,
      missingFields: requiredFields as string[],
      warnings: ["No metadata provided"],
    };
  }

  if (usageMetadata) {
    for (const field of requiredFields) {
      if (!usageMetadata[field]) missingFields.push(String(field));
    }

    if (usageMetadata.responseQualityScore) {
      const score = usageMetadata.responseQualityScore;
      if (typeof score !== "number" || score < 0 || score > 1) {
        warnings.push("responseQualityScore should be a number between 0.0 and 1.0");
      }
    }

    if (usageMetadata.subscriber?.email && !usageMetadata.subscriber.email.includes("@")) {
      warnings.push("subscriber.email does not appear to be a valid email address");
    }
  }

  return { isValid: missingFields.length === 0, missingFields, warnings };
}

export function mergeMetadata(...sources: (UsageMetadata | undefined)[]): UsageMetadata {
  const result: UsageMetadata = {};
  for (const source of sources.reverse()) {
    if (source) Object.assign(result, source);
  }
  return result;
}

export function extractMetadata<T extends Record<string, unknown>>(
  params: T & { usageMetadata?: UsageMetadata },
): { metadata: UsageMetadata | undefined; cleanParams: Omit<T, "usageMetadata"> } {
  const { usageMetadata, ...cleanParams } = params;
  return { metadata: usageMetadata, cleanParams: cleanParams as Omit<T, "usageMetadata"> };
}

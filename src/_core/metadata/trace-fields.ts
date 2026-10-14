import { getLogger } from "../config/manager.js";
import { ENV_VARS } from "../constants.js";

const TICKET_ID_MAX_LENGTH = 256;

let cachedRegion: string | null = null;
let regionCached = false;

export function resetRegionCache(): void {
  cachedRegion = null;
  regionCached = false;
}

export function getEnvironment(): string | null {
  const logger = getLogger();
  const env =
    process.env.REVENIUM_ENVIRONMENT || process.env.NODE_ENV || process.env.DEPLOYMENT_ENV || null;

  if (env && env.length > 255) {
    logger.warn("environment exceeds max length of 255 characters. Truncating.");
    return env.substring(0, 255).trim();
  }

  return env ? env.trim() : null;
}

export async function getRegion(): Promise<string | null> {
  if (regionCached) {
    return cachedRegion;
  }

  const envRegion =
    process.env.AWS_REGION ||
    process.env.AZURE_REGION ||
    process.env.GCP_REGION ||
    process.env.REVENIUM_REGION;

  if (envRegion) {
    cachedRegion = envRegion.trim();
    regionCached = true;
    return cachedRegion;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    const response = await fetch("http://169.254.169.254/latest/meta-data/placement/region", {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    cachedRegion = (await response.text()).trim();
    regionCached = true;
    return cachedRegion;
  } catch {
    cachedRegion = null;
    regionCached = true;
    return null;
  }
}

export function getCredentialAlias(): string | null {
  const logger = getLogger();
  const alias = process.env.REVENIUM_CREDENTIAL_ALIAS || null;

  if (alias && alias.length > 255) {
    logger.warn("credentialAlias exceeds max length of 255 characters. Truncating.");
    return alias.substring(0, 255).trim();
  }

  return alias ? alias.trim() : null;
}

export function getTraceType(): string | null {
  const logger = getLogger();
  const traceType = process.env.REVENIUM_TRACE_TYPE;

  if (!traceType) return null;

  if (!/^[a-zA-Z0-9_-]+$/.test(traceType)) {
    logger.warn(
      `Invalid trace_type format: ${traceType}. Must be alphanumeric with hyphens/underscores only.`,
    );
    return null;
  }

  if (traceType.length > 128) {
    logger.warn("trace_type exceeds max length of 128 characters. Truncating.");
    return traceType.substring(0, 128);
  }

  return traceType;
}

export function getTraceName(): string | null {
  const logger = getLogger();
  const traceName = process.env.REVENIUM_TRACE_NAME;

  if (!traceName) return null;

  if (traceName.length > 256) {
    logger.warn("trace_name exceeds max length of 256 characters. Truncating.");
    return traceName.substring(0, 256);
  }

  return traceName;
}

export function normalizeTicketId(ticketId?: string): string | undefined {
  if (!ticketId) return undefined;

  if (ticketId.length > TICKET_ID_MAX_LENGTH) {
    getLogger().warn(
      `ticket_id exceeds max length of ${TICKET_ID_MAX_LENGTH} characters. Truncating.`,
      {
        length: ticketId.length,
        maxLength: TICKET_ID_MAX_LENGTH,
      },
    );
    return ticketId.substring(0, TICKET_ID_MAX_LENGTH);
  }

  return ticketId;
}

export function getTicketId(): string | null {
  return normalizeTicketId(process.env[ENV_VARS.TICKET_ID]) ?? null;
}

export function detectOperationSubtype(requestBody?: any): string | null {
  if (requestBody && (requestBody.tools || requestBody.functions)) {
    return "function_call";
  }
  return null;
}

export function getParentTransactionId(): string | null {
  return process.env.REVENIUM_PARENT_TRANSACTION_ID || null;
}

export function getTransactionName(): string | null {
  return process.env.REVENIUM_TRANSACTION_NAME || null;
}

export function getRetryNumber(): number {
  const retryNum = process.env.REVENIUM_RETRY_NUMBER;
  if (retryNum) {
    const parsed = parseInt(retryNum, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

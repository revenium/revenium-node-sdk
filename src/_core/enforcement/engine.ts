import { stripReveniumServicePrefix } from "../base-url.js";
import { getConfig, getLogger } from "../config/manager.js";
import {
  DEFAULT_REVENIUM_BASE_URL,
  DEFAULT_CONFIG,
  ENFORCEMENT_CONFIG,
  API_ENDPOINTS,
  ENV_VARS,
  HTTP_TOO_MANY_REQUESTS,
  RETRY_CONFIG,
} from "../constants.js";
import { executeWithEnforcementCircuitBreaker } from "../resilience/circuit-breaker.js";
import { EnforcementRequestRejectedError } from "../resilience/error-handler.js";
import { isRequestRejection, parseRetryAfter } from "../resilience/retry.js";
import {
  EnforcementGroupEntry,
  EnforcementRule,
  EnforcementSnapshot,
  emptyEnforcementSnapshot,
  setRules,
  clearCache,
  getRules,
  getRulesAgeMs,
  isFreshRuleAge,
} from "./cache.js";
import { unevaluableFilters, type EnforcementFilter } from "./filters.js";
import { normalizeIdentityKey } from "./identity.js";
import { clearMeteringBlocks, liftBlocksNotReportedBy } from "./metering-blocks.js";

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let warnedMissingTeamId = false;
let backoffDelayMs: number | null = null;
let reportedUnevaluableFilters: ReadonlySet<string> = new Set();
let initialLoad: Promise<void> = Promise.resolve();

const MAX_RULE_AGE_SECONDS = ENFORCEMENT_CONFIG.MAX_RULE_AGE / 1000;

export function buildEnforcementRulesUrl(baseUrl: string, reveniumTeamId: string): string {
  const host = stripReveniumServicePrefix(baseUrl);
  return `${host}${API_ENDPOINTS.ENFORCEMENT_RULES}/${encodeURIComponent(reveniumTeamId)}`;
}

const ACTIONS: ReadonlySet<string> = new Set(["BLOCK", "THROTTLE", "WARN_ONLY"]);
const PERIODS: ReadonlySet<string> = new Set(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY"]);

function toNumber(v: unknown): number | null {
  // Jackson BigDecimal serialization can flip between number and string
  // (`WRITE_BIGDECIMAL_AS_PLAIN`). Accept both.
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseGroupBreakdown(value: unknown): EnforcementGroupEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries: EnforcementGroupEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const currentValue = toNumber(s.currentValue);

    if (
      typeof s.groupValue !== "string" ||
      currentValue === null ||
      typeof s.breached !== "boolean"
    )
      continue;

    entries.push({
      groupValue: s.groupValue,
      displayName: typeof s.displayName === "string" ? s.displayName : undefined,
      currentValue,
      breached: s.breached,
    });
  }
  return entries;
}

function isReadableFilterValue(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

// An IN list the SDK cannot read whole has to stay unevaluable: dropping its bad
// entries would leave an empty list, which constrains nothing and would make a
// breached cap refuse every call.
function parseFilterValues(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
}

function parseFilters(value: unknown): EnforcementFilter[] {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    const s = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const values = parseFilterValues(s.values);
    const unevaluable = !isReadableFilterValue(s.value) || values === null;
    return {
      dimension: typeof s.dimension === "string" ? s.dimension : "",
      operator: typeof s.operator === "string" ? s.operator : "",
      value: typeof s.value === "string" ? s.value : undefined,
      values: values ?? [],
      ...(unevaluable && { unevaluable: true }),
    };
  });
}

function unevaluableFilterKey(
  ruleId: number,
  filters: readonly { dimension: string; operator: string }[],
): string {
  return JSON.stringify([ruleId, filters]);
}

// The poller runs every 30s, so a rule keeps its warning to the poll that first
// saw it and is reported again only once its unevaluable rows change.
function reportUnevaluableFilters(rule: EnforcementRule, reported: Set<string>): void {
  const resolvedByDepartmentBlocks = rule.departmentId !== undefined && rule.groupBy === undefined;
  const unevaluable = unevaluableFilters(rule.filters, resolvedByDepartmentBlocks);
  if (unevaluable.length === 0) return;

  const filters = unevaluable.map(({ dimension, operator }) => ({ dimension, operator }));
  const key = unevaluableFilterKey(rule.ruleId, filters);
  reported.add(key);
  if (reportedUnevaluableFilters.has(key)) return;

  getLogger().warn(
    "Cost control carries filters this SDK cannot evaluate; it blocks nobody client-side and stays enforced server-side",
    { ruleId: rule.ruleId, filters },
  );
}

function parseNormalizedNumberMap(
  source: Record<string, unknown>,
  name: string,
  accepts: (value: number) => boolean,
): Map<string, number> {
  const map = new Map<string, number>();
  const raw = source[name];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = toNumber(value);
    if (parsed === null || !accepts(parsed)) continue;
    map.set(normalizeIdentityKey(key), parsed);
  }
  return map;
}

export function parseEnforcementRulesResponse(data: unknown): EnforcementSnapshot {
  // Server shape is `{ rules: [...] }`; accept a bare array too for forward compatibility.
  const envelope: Record<string, unknown> =
    !Array.isArray(data) && data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  const raw: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(envelope.rules)
      ? envelope.rules
      : [];

  const parsed: EnforcementRule[] = [];
  const reported = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;

    const ruleId = s.ruleId;
    const threshold = toNumber(s.threshold);
    const currentValue = toNumber(s.currentValue);
    const action = s.action;
    const periodType = s.periodType;
    const breached = s.breached;

    if (
      typeof ruleId !== "number" ||
      threshold === null ||
      currentValue === null ||
      typeof action !== "string" ||
      !ACTIONS.has(action) ||
      typeof periodType !== "string" ||
      !PERIODS.has(periodType) ||
      typeof breached !== "boolean"
    ) {
      continue;
    }

    const rule: EnforcementRule = {
      ruleId,
      name: typeof s.name === "string" ? s.name : undefined,
      threshold,
      currentValue,
      periodType: periodType as EnforcementRule["periodType"],
      action: action as EnforcementRule["action"],
      breached,
      shadowMode: typeof s.shadowMode === "boolean" ? s.shadowMode : false,
      filters: parseFilters(s.filters),
      groupBy: typeof s.groupBy === "string" ? s.groupBy : undefined,
      departmentId: typeof s.departmentId === "number" ? s.departmentId : undefined,
      groupBreakdown: parseGroupBreakdown(s.groupBreakdown),
    };

    reportUnevaluableFilters(rule, reported);
    parsed.push(rule);
  }

  reportedUnevaluableFilters = reported;

  return {
    rules: parsed,
    departmentBlocks: parseNormalizedNumberMap(
      envelope,
      "departmentBudgetBlocks",
      Number.isInteger,
    ),
    departmentBlockBalances: parseNormalizedNumberMap(
      envelope,
      "departmentBudgetBlockBalances",
      Number.isFinite,
    ),
  };
}

export function startEnforcementPolling(): void {
  const logger = getLogger();

  initialLoad = fetchRules().catch(reportFetchFailure);

  if (polling) {
    logger.debug(
      "Enforcement polling already running; cost controls refetched for the current config",
    );
    return;
  }

  polling = true;

  initialLoad.finally(() => {
    if (polling) {
      scheduleNextPoll();
    }
  });

  logger.debug("Enforcement polling started", {
    intervalMs: ENFORCEMENT_CONFIG.POLL_INTERVAL,
  });
}

export function stopEnforcementPolling(): void {
  clearMeteringBlocks();
  if (!polling) return;

  polling = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  clearCache();
  initialLoad = Promise.resolve();
  warnedMissingTeamId = false;
  backoffDelayMs = null;
  reportedUnevaluableFilters = new Set();
  getLogger().debug("Enforcement polling stopped");
}

export function isPolling(): boolean {
  return polling;
}

export function waitForInitialRules(): Promise<void> {
  return initialLoad;
}

function scheduleNextPoll(): void {
  // Add +-20% jitter to avoid thundering herd
  const jitter = ENFORCEMENT_CONFIG.POLL_INTERVAL * 0.2 * (Math.random() * 2 - 1);
  const delay = backoffDelayMs ?? ENFORCEMENT_CONFIG.POLL_INTERVAL + jitter;
  backoffDelayMs = null;

  pollTimer = setTimeout(() => {
    fetchRules()
      .catch(reportFetchFailure)
      .finally(() => {
        if (polling) {
          scheduleNextPoll();
        }
      });
  }, delay);

  // Allow the process to exit even if the timer is running
  if (pollTimer && typeof pollTimer === "object" && "unref" in pollTimer) {
    pollTimer.unref();
  }
}

function applySnapshot(
  reveniumApiKey: string,
  snapshot: EnforcementSnapshot,
  fetchStartedAt: number,
): void {
  setRules(snapshot);
  liftBlocksNotReportedBy(reveniumApiKey, snapshot, fetchStartedAt);
}

function reportFetchFailure(error: unknown): void {
  getLogger().warn(`Enforcement rules fetch failed; ${describeCacheImpact()}.`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function describeCacheImpact(): string {
  const ageMs = getRulesAgeMs();
  if (ageMs === null) return "cost controls are not loaded and provider calls pass through";

  const refreshed = `the cost controls refreshed ${Math.ceil(ageMs / 1000)} s ago`;
  if (!isFreshRuleAge(ageMs)) {
    return `${refreshed} are older than ${MAX_RULE_AGE_SECONDS} s and no longer applied, so provider calls pass through`;
  }
  return getRules().length > 0
    ? `${refreshed} remain in use until they are ${MAX_RULE_AGE_SECONDS} s old`
    : `${refreshed} hold no rules, so provider calls pass through`;
}

function reportRejectedRequest(error: EnforcementRequestRejectedError): void {
  const context = {
    url: error.url,
    status: error.status,
    statusText: error.statusText,
  };

  if (error.status === HTTP_TOO_MANY_REQUESTS) {
    getLogger().warn(
      `Enforcement rules endpoint is rate limiting the SDK; ${describeCacheImpact()}. Polling backs off until the limit clears.`,
      context,
    );
    return;
  }

  getLogger().warn(
    `Enforcement rules endpoint rejected the request; ${describeCacheImpact()}. Set ${ENV_VARS.ENFORCEMENT_BASE_URL} to the Revenium host serving the enforcement API, and verify ${ENV_VARS.TEAM_ID} and ${ENV_VARS.REVENIUM_API_KEY}.`,
    context,
  );
}

function applyBackoff(retryAfterSeconds: number | undefined): void {
  const cappedSeconds = Math.min(
    retryAfterSeconds ?? RETRY_CONFIG.MAX_RETRY_AFTER_SECONDS,
    RETRY_CONFIG.MAX_RETRY_AFTER_SECONDS,
  );
  backoffDelayMs = Math.max(cappedSeconds * 1000, ENFORCEMENT_CONFIG.POLL_INTERVAL);
}

async function fetchRules(): Promise<void> {
  const config = getConfig();
  const logger = getLogger();

  if (!config) {
    logger.debug("No config available, skipping enforcement rules fetch");
    return;
  }

  if (!config.reveniumTeamId) {
    if (!warnedMissingTeamId) {
      warnedMissingTeamId = true;
      logger.warn(
        `No team id configured, so cost controls are off and provider calls pass through. Set ${ENV_VARS.TEAM_ID} or pass reveniumTeamId (teamId on fal.ai) in config.`,
      );
    }
    return;
  }

  const enforcementBase =
    config.reveniumEnforcementBaseUrl || config.reveniumBaseUrl || DEFAULT_REVENIUM_BASE_URL;
  const url = buildEnforcementRulesUrl(enforcementBase, config.reveniumTeamId);

  logger.debug("Fetching enforcement rules", { url });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_CONFIG.API_TIMEOUT);
  backoffDelayMs = null;

  try {
    await executeWithEnforcementCircuitBreaker(async () => {
      const fetchStartedAt = performance.now();
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-api-key": config.reveniumApiKey,
        },
        signal: controller.signal,
      });

      if (response.status === 204) {
        applySnapshot(config.reveniumApiKey, emptyEnforcementSnapshot(), fetchStartedAt);
        logger.debug("Enforcement rules: no rules configured (204)");
        return;
      }

      if (isRequestRejection(response.status)) {
        throw new EnforcementRequestRejectedError(
          url,
          response.status,
          response.statusText,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }

      if (!response.ok) {
        throw new Error(`Enforcement rules API error: ${response.status} ${response.statusText}`);
      }

      const data: unknown = await response.json();
      const snapshot = parseEnforcementRulesResponse(data);
      applySnapshot(config.reveniumApiKey, snapshot, fetchStartedAt);
      logger.debug("Enforcement rules updated", { ruleCount: snapshot.rules.length });
    });
  } catch (error) {
    if (!(error instanceof EnforcementRequestRejectedError)) throw error;

    if (error.status === HTTP_TOO_MANY_REQUESTS) {
      applyBackoff(error.retryAfterSeconds);
    }
    reportRejectedRequest(error);
  } finally {
    clearTimeout(timeout);
  }
}

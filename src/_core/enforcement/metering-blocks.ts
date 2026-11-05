import { resolveConfig } from "../config/call-config.js";
import { getLogger } from "../config/manager.js";
import { ENFORCEMENT_CONFIG } from "../constants.js";
import { CostLimitExceeded, type CostLimitDirective } from "../resilience/error-handler.js";
import type { EnforcementSnapshot } from "./cache.js";
import type { EnforcementCriteria } from "./evaluator.js";
import { normalizeIdentityKey } from "./identity.js";

interface MeteringBlock extends CostLimitDirective {
  reveniumApiKey: string;
  sentAt: number;
  expiresAt: number;
}

const blocks = new Map<string, MeteringBlock>();

function scopeKey(reveniumApiKey: string, scope: EnforcementCriteria): string {
  return JSON.stringify([
    reveniumApiKey,
    scope.subscriberId,
    scope.subscriberEmail && normalizeIdentityKey(scope.subscriberEmail),
    scope.productName,
    scope.model,
    scope.provider,
    scope.agent,
    scope.taskType,
    scope.organizationName,
    scope.credential,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isExpired(block: MeteringBlock, now: number): boolean {
  return block.expiresAt <= now;
}

function pruneExpired(now: number): void {
  for (const [key, block] of blocks) {
    if (isExpired(block, now)) blocks.delete(key);
  }
}

function recordBlock(
  reveniumApiKey: string,
  scope: EnforcementCriteria,
  sentAt: number,
  directive: CostLimitDirective,
): void {
  const now = performance.now();
  pruneExpired(now);

  const key = scopeKey(reveniumApiKey, scope);
  const existing = blocks.get(key);
  if (!existing) {
    getLogger().warn("Revenium reported a breached cost limit; matching calls are refused", {
      ruleName: directive.ruleName,
      model: scope.model,
      provider: scope.provider,
    });
  }

  blocks.set(key, {
    ...directive,
    reveniumApiKey,
    sentAt: Math.max(sentAt, existing?.sentAt ?? sentAt),
    expiresAt: now + ENFORCEMENT_CONFIG.MAX_RULE_AGE,
  });
}

function liftBlockSentBefore(
  reveniumApiKey: string,
  scope: EnforcementCriteria,
  sentAt: number,
): void {
  const key = scopeKey(reveniumApiKey, scope);
  const block = blocks.get(key);
  if (block && sentAt > block.sentAt) blocks.delete(key);
}

export function applyMeteringReply(
  reveniumApiKey: string,
  scope: EnforcementCriteria,
  sentAt: number,
  reply: unknown,
): void {
  if (!isRecord(reply)) return;

  const { enforcement } = reply;
  if (isRecord(enforcement) && enforcement.action === "BLOCK") {
    recordBlock(reveniumApiKey, scope, sentAt, {
      ruleName: stringOrNull(enforcement.ruleName),
      message: stringOrNull(enforcement.message),
    });
    return;
  }

  liftBlockSentBefore(reveniumApiKey, scope, sentAt);
}

export function costLimitContext(criteria: EnforcementCriteria): Record<string, unknown> {
  return {
    subscriberId: criteria.subscriberId,
    subscriberEmail: criteria.subscriberEmail,
    productName: criteria.productName,
    model: criteria.model,
    provider: criteria.provider,
  };
}

export function enforceMeteringBlock(criteria: EnforcementCriteria): void {
  const reveniumApiKey = resolveConfig()?.reveniumApiKey;
  if (!reveniumApiKey) return;

  const block = blocks.get(scopeKey(reveniumApiKey, criteria));
  if (!block || isExpired(block, performance.now())) return;

  throw new CostLimitExceeded("", NaN, NaN, "", costLimitContext(criteria), {
    ruleName: block.ruleName,
    message: block.message,
  });
}

function breachedRuleNames({ rules, departmentBlocks }: EnforcementSnapshot): Set<string> {
  const departmentRuleIds = new Set(departmentBlocks.values());
  return new Set(
    rules
      .filter(
        (rule) =>
          rule.breached ||
          rule.groupBreakdown?.some((entry) => entry.breached) ||
          departmentRuleIds.has(rule.ruleId),
      )
      .flatMap((rule) => (rule.name === undefined ? [] : [rule.name])),
  );
}

export function liftBlocksNotReportedBy(
  reveniumApiKey: string,
  snapshot: EnforcementSnapshot,
  fetchStartedAt: number,
): void {
  const breached = breachedRuleNames(snapshot);
  for (const [key, block] of blocks) {
    if (block.reveniumApiKey !== reveniumApiKey || block.sentAt > fetchStartedAt) continue;
    if (block.ruleName === null || !breached.has(block.ruleName)) blocks.delete(key);
  }
}

export function clearMeteringBlocks(): void {
  blocks.clear();
}

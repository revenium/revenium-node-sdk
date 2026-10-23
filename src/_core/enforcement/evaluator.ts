import { getLogger } from "../config/manager.js";
import { CostLimitExceeded } from "../resilience/error-handler.js";
import {
  CachedEnforcementRule,
  CachedEnforcementSnapshot,
  EnforcementRule,
  getSnapshot,
} from "./cache.js";
import { ruleCovers, ruleCoversBeyondDepartment } from "./filters.js";
import { normalizeIdentityKey } from "./identity.js";

export interface EnforcementCriteria {
  subscriberId?: string;
  subscriberEmail?: string;
  productName?: string;
  model?: string;
  provider?: string;
  agent?: string;
  taskType?: string;
  organizationName?: string;
  credential?: string;
}

// Department-block rows are keyed by the normalized identity, while
// groupBreakdown rows keep the exact value the server sent, so a caller has to
// be matched on both forms of each identity it carries.
function callerKeys(criteria: EnforcementCriteria): string[] {
  const keys = new Set<string>();
  for (const identity of [criteria.subscriberId, criteria.subscriberEmail]) {
    if (typeof identity !== "string" || identity.length === 0) continue;
    keys.add(identity);
    keys.add(normalizeIdentityKey(identity));
  }
  return [...keys];
}

function isDecidedByDepartmentBlocksAlone(cached: CachedEnforcementRule): boolean {
  return cached.groupEntries === null && cached.rule.departmentId !== undefined;
}

// One person can own more than one row: the server keys an event by its raw
// subscriber id when it has one and by normalized email otherwise, so
// inconsistent metadata splits their spend. Any breached row blocks, and the
// largest figure is the one reported.
function breachedValueFor(cached: CachedEnforcementRule, keys: readonly string[]): number | null {
  if (!cached.groupEntries) return cached.rule.breached ? cached.rule.currentValue : null;

  let breachedValue: number | null = null;
  for (const key of keys) {
    const entry = cached.groupEntries.get(key);
    if (!entry?.breached) continue;
    if (breachedValue === null || entry.currentValue > breachedValue) {
      breachedValue = entry.currentValue;
    }
  }
  return breachedValue;
}

function applyDecision(
  rule: EnforcementRule,
  currentValue: number,
  criteria: EnforcementCriteria,
): void {
  // Log-only branches: shadowMode dampens any action, and WARN_ONLY /
  // THROTTLE are not client-side-enforceable today (THROTTLE would require
  // a delay primitive). Log them for visibility; the server handles
  // throttling out-of-band.
  if (rule.shadowMode || rule.action === "WARN_ONLY" || rule.action === "THROTTLE") {
    getLogger().warn("Cost limit rule breached (observation only)", {
      ruleId: rule.ruleId,
      threshold: rule.threshold,
      currentValue,
      periodType: rule.periodType,
      action: rule.action,
      shadowMode: rule.shadowMode,
      subscriberId: criteria.subscriberId,
    });
    return;
  }

  if (rule.action !== "BLOCK") return;

  throw new CostLimitExceeded(String(rule.ruleId), rule.threshold, currentValue, rule.periodType, {
    subscriberId: criteria.subscriberId,
    subscriberEmail: criteria.subscriberEmail,
    productName: criteria.productName,
    model: criteria.model,
    provider: criteria.provider,
  });
}

function enforceDepartmentBlock(
  snapshot: CachedEnforcementSnapshot,
  keys: readonly string[],
  criteria: EnforcementCriteria,
): void {
  for (const key of keys) {
    const ruleId = snapshot.departmentBlocks.get(key);
    if (ruleId === undefined) continue;

    const cached = snapshot.rules.find((candidate) => candidate.rule.ruleId === ruleId);
    if (!cached) {
      getLogger().warn("Department budget block references an unknown rule", { ruleId });
      continue;
    }

    if (!ruleCoversBeyondDepartment(cached.rule.filters, criteria)) continue;

    applyDecision(
      cached.rule,
      snapshot.departmentBlockBalances.get(key) ?? cached.rule.currentValue,
      criteria,
    );
  }
}

export function enforcePreCallRules(criteria: EnforcementCriteria): void {
  const snapshot = getSnapshot();
  if (snapshot.rules.length === 0) return;

  const keys = callerKeys(criteria);
  enforceDepartmentBlock(snapshot, keys, criteria);

  for (const cached of snapshot.rules) {
    if (isDecidedByDepartmentBlocksAlone(cached)) continue;

    const currentValue = breachedValueFor(cached, keys);
    if (currentValue === null) continue;
    if (!ruleCovers(cached.rule.filters, criteria)) continue;

    applyDecision(cached.rule, currentValue, criteria);
  }
}

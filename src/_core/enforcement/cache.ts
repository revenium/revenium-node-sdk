import type { EnforcementFilter } from "./filters.js";

export type EnforcementAction = "BLOCK" | "THROTTLE" | "WARN_ONLY";
export type BudgetWindow = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY";

// Field names mirror the server's CompiledEnforcementRule
// (hypercurrent#3877 / #3950) and isotope's apps/web/src/types/budgetRule.ts
// so the on-wire contract is identical across SDK + UI + backend.
export interface EnforcementGroupEntry {
  groupValue: string;
  displayName?: string;
  currentValue: number;
  breached: boolean;
}

export interface EnforcementRule {
  ruleId: number;
  name?: string;
  threshold: number;
  currentValue: number;
  periodType: BudgetWindow;
  action: EnforcementAction;
  breached: boolean;
  shadowMode: boolean;
  filters: EnforcementFilter[];
  groupBy?: string;
  departmentId?: number;
  groupBreakdown?: EnforcementGroupEntry[];
}

export interface EnforcementSnapshot {
  rules: EnforcementRule[];
  departmentBlocks: Map<string, number>;
  departmentBlockBalances: Map<string, number>;
}

export interface CachedEnforcementRule {
  rule: EnforcementRule;
  groupEntries: ReadonlyMap<string, EnforcementGroupEntry> | null;
}

export interface CachedEnforcementSnapshot {
  rules: readonly CachedEnforcementRule[];
  departmentBlocks: ReadonlyMap<string, number>;
  departmentBlockBalances: ReadonlyMap<string, number>;
}

export function emptyEnforcementSnapshot(): EnforcementSnapshot {
  return { rules: [], departmentBlocks: new Map(), departmentBlockBalances: new Map() };
}

const EMPTY_CACHE: CachedEnforcementSnapshot = {
  rules: [],
  departmentBlocks: new Map(),
  departmentBlockBalances: new Map(),
};

let cachedSnapshot: CachedEnforcementSnapshot = EMPTY_CACHE;

function outranks(candidate: EnforcementGroupEntry, incumbent: EnforcementGroupEntry): boolean {
  if (candidate.breached !== incumbent.breached) return candidate.breached;
  return candidate.currentValue > incumbent.currentValue;
}

// A grouped rule without a breakdown carries no per-group figures the SDK can
// act on, so it resolves to an empty map and nobody is blocked: the server
// only builds a breakdown for cost metrics, and its rule-level currentValue is
// the whole scope's, which would refuse every caller.
function foldGroupEntries(
  rule: EnforcementRule,
): ReadonlyMap<string, EnforcementGroupEntry> | null {
  if (!rule.groupBy) return null;

  const entries = new Map<string, EnforcementGroupEntry>();
  for (const entry of rule.groupBreakdown ?? []) {
    const incumbent = entries.get(entry.groupValue);
    if (!incumbent || outranks(entry, incumbent)) entries.set(entry.groupValue, entry);
  }
  return entries;
}

export function getSnapshot(): CachedEnforcementSnapshot {
  return cachedSnapshot;
}

export function getRules(): EnforcementRule[] {
  return cachedSnapshot.rules.map((cached) => cached.rule);
}

export function setRules(snapshot: EnforcementSnapshot): void {
  cachedSnapshot = {
    rules: snapshot.rules.map((rule) => ({ rule, groupEntries: foldGroupEntries(rule) })),
    departmentBlocks: snapshot.departmentBlocks,
    departmentBlockBalances: snapshot.departmentBlockBalances,
  };
}

export function clearCache(): void {
  cachedSnapshot = EMPTY_CACHE;
}

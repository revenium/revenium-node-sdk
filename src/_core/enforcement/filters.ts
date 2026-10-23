// Ported from the platform's EnforcementFilterMatcher.kt: a row this SDK
// cannot evaluate (unknown dimension, unknown operator, DEPARTMENT) makes the
// rule cover nothing, which is the server's own `else -> false`. A null value
// and an empty IN list constrain nothing on both sides.

import type { EnforcementCriteria } from "./evaluator.js";
import { normalizeIdentityKey } from "./identity.js";

export interface EnforcementFilter {
  dimension: string;
  operator: string;
  value?: string;
  values: string[];
  unevaluable?: boolean;
}

type DimensionComparator = (
  criteria: EnforcementCriteria,
  operator: string,
  expected: string,
) => boolean;

interface SubscriberValue {
  value: string;
  fromEmail: boolean;
}

const IN_OPERATOR = "IN";
const DEPARTMENT_DIMENSION = "DEPARTMENT";

const OPERATORS: ReadonlySet<string> = new Set([
  "IS",
  "IS_NOT",
  IN_OPERATOR,
  "CONTAINS",
  "STARTS_WITH",
  "ENDS_WITH",
]);

function compare(actual: string | undefined, operator: string, expected: string): boolean {
  if (!actual) return operator === "IS_NOT";

  switch (operator) {
    case "IS":
      return actual === expected;
    case "IS_NOT":
      return actual !== expected;
    case "CONTAINS":
      return actual.includes(expected);
    case "STARTS_WITH":
      return actual.startsWith(expected);
    case "ENDS_WITH":
      return actual.endsWith(expected);
    default:
      return false;
  }
}

function comparing(
  read: (criteria: EnforcementCriteria) => string | undefined,
): DimensionComparator {
  return (criteria, operator, expected) => compare(read(criteria), operator, expected);
}

function compareProvider(
  criteria: EnforcementCriteria,
  operator: string,
  expected: string,
): boolean {
  return compare(criteria.provider?.toLowerCase(), operator, expected.toLowerCase());
}

// Callers reach this through untyped metadata, so an identity that is not a
// string has to fall through rather than reach a string method and throw.
function readableIdentity(identity: string | undefined): string | null {
  return typeof identity === "string" && identity.trim() !== "" ? identity : null;
}

function subscriberValue(criteria: EnforcementCriteria): SubscriberValue | null {
  const email = readableIdentity(criteria.subscriberEmail);
  if (email) return { value: email, fromEmail: true };

  const id = readableIdentity(criteria.subscriberId);
  return id ? { value: id, fromEmail: false } : null;
}

function compareSubscriber(
  criteria: EnforcementCriteria,
  operator: string,
  expected: string,
): boolean {
  const actual = subscriberValue(criteria);
  if (!actual) return compare(undefined, operator, expected);
  if (!actual.fromEmail) return compare(actual.value, operator, expected);

  if (operator === "IS" || operator === "IS_NOT") {
    return compare(normalizeIdentityKey(actual.value), operator, normalizeIdentityKey(expected));
  }
  return compare(actual.value.toLowerCase(), operator, expected.toLowerCase());
}

const COMPARATORS: ReadonlyMap<string, DimensionComparator> = new Map([
  ["MODEL", comparing((criteria) => criteria.model)],
  ["PRODUCT", comparing((criteria) => criteria.productName)],
  ["AGENT", comparing((criteria) => criteria.agent)],
  ["TASK_TYPE", comparing((criteria) => criteria.taskType)],
  ["ORGANIZATION", comparing((criteria) => criteria.organizationName)],
  ["CREDENTIAL", comparing((criteria) => criteria.credential)],
  ["PROVIDER", compareProvider],
  ["SUBSCRIBER", compareSubscriber],
]);

function comparatorFor(filter: EnforcementFilter): DimensionComparator | null {
  if (filter.unevaluable) return null;

  const compareDimension = COMPARATORS.get(filter.dimension);
  if (!compareDimension || !OPERATORS.has(filter.operator)) return null;
  return compareDimension;
}

function matchesFilter(filter: EnforcementFilter, criteria: EnforcementCriteria): boolean {
  const compareDimension = comparatorFor(filter);
  if (!compareDimension) return false;

  if (filter.operator === IN_OPERATOR) {
    return (
      filter.values.length === 0 ||
      filter.values.some((value) => compareDimension(criteria, "IS", value))
    );
  }

  if (filter.value === undefined) return true;
  return compareDimension(criteria, filter.operator, filter.value);
}

export function ruleCovers(
  filters: readonly EnforcementFilter[],
  criteria: EnforcementCriteria,
): boolean {
  return filters.every((filter) => matchesFilter(filter, criteria));
}

// On a department block the server has already resolved the DEPARTMENT row by
// naming the caller, so only the rows the SDK can evaluate are left to apply.
export function ruleCoversBeyondDepartment(
  filters: readonly EnforcementFilter[],
  criteria: EnforcementCriteria,
): boolean {
  return ruleCovers(
    filters.filter((filter) => filter.dimension !== DEPARTMENT_DIMENSION),
    criteria,
  );
}

// A DEPARTMENT row is only silent when the server decides the rule for us on a
// department block; everywhere else it makes the rule cover nothing, so it is
// reported like any other row the SDK cannot evaluate.
export function unevaluableFilters(
  filters: readonly EnforcementFilter[],
  resolvedByDepartmentBlocks: boolean,
): readonly EnforcementFilter[] {
  return filters.filter(
    (filter) =>
      !comparatorFor(filter) &&
      !(resolvedByDepartmentBlocks && filter.dimension === DEPARTMENT_DIMENSION),
  );
}

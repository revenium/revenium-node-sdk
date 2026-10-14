import {
  clearCache,
  setRules,
  type EnforcementRule,
  type EnforcementSnapshot,
} from "../../../src/_core/enforcement/cache";
import { enforcePreCallRules } from "../../../src/_core/enforcement/evaluator";
import { CostLimitExceeded } from "../../../src/_core/resilience/error-handler";

const perPersonRule: EnforcementRule = {
  ruleId: 201,
  threshold: 5,
  currentValue: 8.5,
  periodType: "DAILY",
  action: "BLOCK",
  breached: true,
  shadowMode: false,
  groupBy: "SUBSCRIBER",
  groupBreakdown: [
    { groupValue: "alice@example.com", currentValue: 7.5, breached: true },
    { groupValue: "bob@example.com", currentValue: 1, breached: false },
  ],
};

const departmentRule: EnforcementRule = {
  ruleId: 301,
  threshold: 5,
  currentValue: 7.5,
  periodType: "DAILY",
  action: "BLOCK",
  breached: true,
  shadowMode: false,
  groupBy: "SUBSCRIBER",
  departmentId: 173,
};

const pooledRule: EnforcementRule = {
  ruleId: 101,
  threshold: 10,
  currentValue: 42.5,
  periodType: "DAILY",
  action: "BLOCK",
  breached: true,
  shadowMode: false,
};

function snapshotOf(rules: EnforcementRule[], departments?: Partial<EnforcementSnapshot>): void {
  setRules({
    rules,
    departmentBlocks: departments?.departmentBlocks ?? new Map(),
    departmentBlockBalances: departments?.departmentBlockBalances ?? new Map(),
  });
}

describe("enforcePreCallRules", () => {
  afterEach(() => {
    clearCache();
  });

  it("lets a non-breached person through a per-person rule", () => {
    snapshotOf([perPersonRule]);

    expect(() => enforcePreCallRules({ subscriberEmail: "bob@example.com" })).not.toThrow();
  });

  it("blocks the breached person with their own figure", () => {
    snapshotOf([perPersonRule]);

    expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).toThrow(
      "Cost limit exceeded: $7.50 of $5.00 daily limit reached",
    );
  });

  it("lets a person outside the department through a department-scoped rule", () => {
    snapshotOf([departmentRule], {
      departmentBlocks: new Map([["bob@example.com", 301]]),
      departmentBlockBalances: new Map([["bob@example.com", 6.25]]),
    });

    expect(() => enforcePreCallRules({ subscriberEmail: "carol@example.com" })).not.toThrow();
  });

  it("blocks a listed person with their own department balance", () => {
    snapshotOf([departmentRule], {
      departmentBlocks: new Map([["bob@example.com", 301]]),
      departmentBlockBalances: new Map([["bob@example.com", 6.25]]),
    });

    expect(() => enforcePreCallRules({ subscriberEmail: "  BOB@example.com " })).toThrow(
      "Cost limit exceeded: $6.25 of $5.00 daily limit reached",
    );
  });

  it("blocks a listed person whose subscriber id differs in case from the block key", () => {
    snapshotOf([departmentRule], {
      departmentBlocks: new Map([["user-abc", 301]]),
      departmentBlockBalances: new Map([["user-abc", 6.25]]),
    });

    expect(() => enforcePreCallRules({ subscriberId: "User-ABC" })).toThrow(
      "Cost limit exceeded: $6.25 of $5.00 daily limit reached",
    );
  });

  it("still blocks on a pooled rule with the rule-level figure", () => {
    snapshotOf([pooledRule]);

    let thrown: unknown;
    try {
      enforcePreCallRules({ subscriberEmail: "carol@example.com" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CostLimitExceeded);
    expect((thrown as CostLimitExceeded).currentValue).toBe(42.5);
  });

  it("matches a caller resolved by subscriber id", () => {
    snapshotOf([
      {
        ...perPersonRule,
        groupBreakdown: [{ groupValue: "sub-42", currentValue: 7.5, breached: true }],
      },
    ]);

    expect(() => enforcePreCallRules({ subscriberId: "sub-42" })).toThrow(
      "Cost limit exceeded: $7.50 of $5.00 daily limit reached",
    );
  });

  it("blocks on a breached key even when another key of the same caller is clear", () => {
    snapshotOf([
      {
        ...perPersonRule,
        groupBreakdown: [
          { groupValue: "sub-42", currentValue: 1, breached: false },
          { groupValue: "alice@example.com", currentValue: 7.5, breached: true },
        ],
      },
    ]);

    expect(() =>
      enforcePreCallRules({ subscriberId: "sub-42", subscriberEmail: "alice@example.com" }),
    ).toThrow("Cost limit exceeded: $7.50 of $5.00 daily limit reached");
  });

  it("keeps the breached row when one group value appears twice", () => {
    snapshotOf([
      {
        ...perPersonRule,
        groupBreakdown: [
          { groupValue: "alice@example.com", currentValue: 7.5, breached: true },
          { groupValue: "alice@example.com", currentValue: 1, breached: false },
        ],
      },
    ]);

    expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).toThrow(
      "Cost limit exceeded: $7.50 of $5.00 daily limit reached",
    );
  });

  it("blocks a breached person on a per-person rule that also carries a departmentId", () => {
    snapshotOf([{ ...perPersonRule, departmentId: 173 }]);

    expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).toThrow(
      "Cost limit exceeded: $7.50 of $5.00 daily limit reached",
    );
  });

  it("lets a non-breached person through a per-person rule that also carries a departmentId", () => {
    snapshotOf([{ ...perPersonRule, departmentId: 173 }]);

    expect(() => enforcePreCallRules({ subscriberEmail: "bob@example.com" })).not.toThrow();
  });

  it("lets everyone through a grouped rule the server sent no breakdown for", () => {
    snapshotOf([{ ...perPersonRule, groupBreakdown: undefined }]);

    expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).not.toThrow();
  });

  it("lets everyone through a grouped rule whose breakdown is empty", () => {
    snapshotOf([{ ...perPersonRule, groupBreakdown: [] }]);

    expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).not.toThrow();
  });

  it("never throws in shadow mode or on WARN_ONLY and THROTTLE", () => {
    const observationOnly: EnforcementRule[] = [
      { ...perPersonRule, ruleId: 1, shadowMode: true },
      { ...perPersonRule, ruleId: 2, action: "WARN_ONLY" },
      { ...perPersonRule, ruleId: 3, action: "THROTTLE" },
    ];

    for (const rule of observationOnly) {
      snapshotOf([rule]);
      expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).not.toThrow();
    }
  });

  it("fails open for an unresolvable caller on a scoped rule", () => {
    snapshotOf([perPersonRule]);

    expect(() => enforcePreCallRules({})).not.toThrow();
  });

  it("passes when a department block references a rule missing from the snapshot", () => {
    snapshotOf([departmentRule], {
      departmentBlocks: new Map([["bob@example.com", 999]]),
      departmentBlockBalances: new Map([["bob@example.com", 6.25]]),
    });

    expect(() => enforcePreCallRules({ subscriberEmail: "bob@example.com" })).not.toThrow();
  });

  it("passes when no rules are cached", () => {
    snapshotOf([]);

    expect(() => enforcePreCallRules({ subscriberEmail: "alice@example.com" })).not.toThrow();
  });
});

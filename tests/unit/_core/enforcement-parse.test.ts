import { parseEnforcementRulesResponse } from "../../../src/_core/enforcement/engine";

describe("parseEnforcementRulesResponse", () => {
  it("parses the server's { rules: [...] } CompiledEnforcementRule payload", () => {
    // Payload captured verbatim from dev backend
    // (GET /profitstream/v2/api/ai/enforcement-rules/XPodpJx), 2026-04-22.
    const payload = {
      rules: [
        {
          ruleId: 202,
          teamId: 1372470220,
          name: "sdk-e2e-smoke-node",
          metricType: "TOTAL_COST",
          operatorType: "GREATER_THAN_OR_EQUAL_TO",
          threshold: 0.01,
          currentValue: 0,
          periodType: "DAILY",
          windowStart: 1776816000,
          windowEnd: 1776902399.999,
          percentUsed: 0,
          breached: false,
          groupBy: null,
          filters: [],
          compiledAt: 1776829860.156,
          shadowMode: false,
          action: "BLOCK",
        },
      ],
    };
    const { rules } = parseEnforcementRulesResponse(payload);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      ruleId: 202,
      name: "sdk-e2e-smoke-node",
      threshold: 0.01,
      currentValue: 0,
      periodType: "DAILY",
      action: "BLOCK",
      breached: false,
      shadowMode: false,
    });
  });

  it("coerces string-BigDecimal threshold/currentValue to number", () => {
    // Jackson `WRITE_BIGDECIMAL_AS_PLAIN` can emit numeric fields as strings.
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        {
          ruleId: 1,
          threshold: "0.0100000000",
          currentValue: "0.0147",
          periodType: "DAILY",
          action: "BLOCK",
          breached: true,
          shadowMode: false,
        },
      ],
    });
    expect(rules[0].threshold).toBe(0.01);
    expect(rules[0].currentValue).toBe(0.0147);
  });

  it("accepts WARN_ONLY and THROTTLE actions", () => {
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        {
          ruleId: 1,
          threshold: 1,
          currentValue: 0,
          periodType: "MONTHLY",
          action: "WARN_ONLY",
          breached: false,
        },
        {
          ruleId: 2,
          threshold: 2,
          currentValue: 1,
          periodType: "QUARTERLY",
          action: "THROTTLE",
          breached: false,
        },
      ],
    });
    expect(rules).toHaveLength(2);
    expect(rules[0].action).toBe("WARN_ONLY");
    expect(rules[1].action).toBe("THROTTLE");
  });

  it("drops rules with out-of-enum action or period", () => {
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        {
          ruleId: 1,
          threshold: 1,
          currentValue: 0,
          periodType: "HOURLY", // removed from canonical BudgetWindow
          action: "BLOCK",
          breached: false,
        },
        {
          ruleId: 2,
          threshold: 1,
          currentValue: 0,
          periodType: "DAILY",
          action: "WARN", // old enum value, now WARN_ONLY on server
          breached: false,
        },
      ],
    });
    expect(rules).toEqual([]);
  });

  it("defaults missing shadowMode to false", () => {
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        {
          ruleId: 1,
          threshold: 1,
          currentValue: 0,
          periodType: "DAILY",
          action: "BLOCK",
          breached: false,
        },
      ],
    });
    expect(rules[0].shadowMode).toBe(false);
  });

  it("accepts a bare array as a forward-compat shape", () => {
    const { rules } = parseEnforcementRulesResponse([
      {
        ruleId: 7,
        threshold: 2,
        currentValue: 3,
        periodType: "WEEKLY",
        action: "BLOCK",
        breached: true,
        shadowMode: false,
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleId).toBe(7);
    expect(rules[0].periodType).toBe("WEEKLY");
  });

  it("returns [] for unknown shapes without throwing", () => {
    expect(parseEnforcementRulesResponse(null).rules).toEqual([]);
    expect(parseEnforcementRulesResponse({}).rules).toEqual([]);
    expect(parseEnforcementRulesResponse({ rules: "nope" }).rules).toEqual([]);
    expect(parseEnforcementRulesResponse("string").rules).toEqual([]);
  });

  it("drops malformed items without failing the whole batch", () => {
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        null,
        "bad",
        { ruleId: "notanumber" },
        {
          ruleId: 1,
          threshold: 1,
          currentValue: 0,
          periodType: "DAILY",
          action: "BLOCK",
          breached: false,
        },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleId).toBe(1);
  });

  it("keeps groupBy, departmentId and groupBreakdown", () => {
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        {
          ruleId: 301,
          threshold: 5,
          currentValue: 7.5,
          periodType: "DAILY",
          action: "BLOCK",
          breached: true,
          groupBy: "SUBSCRIBER",
          departmentId: 173,
          groupBreakdown: [
            {
              groupValue: "alice@example.com",
              displayName: "Alice",
              currentValue: "7.5",
              usagePercent: 150,
              breached: true,
            },
          ],
        },
      ],
    });
    expect(rules[0].groupBy).toBe("SUBSCRIBER");
    expect(rules[0].departmentId).toBe(173);
    expect(rules[0].groupBreakdown).toEqual([
      {
        groupValue: "alice@example.com",
        displayName: "Alice",
        currentValue: 7.5,
        breached: true,
      },
    ]);
  });

  it("drops a malformed breakdown entry without dropping its rule", () => {
    const { rules } = parseEnforcementRulesResponse({
      rules: [
        {
          ruleId: 1,
          threshold: 1,
          currentValue: 0,
          periodType: "DAILY",
          action: "BLOCK",
          breached: false,
          groupBreakdown: [
            null,
            { groupValue: 42, currentValue: 1, breached: true },
            { groupValue: "bob@example.com", currentValue: "nope", breached: true },
            { groupValue: "bob@example.com", currentValue: 1, breached: true },
          ],
        },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].groupBreakdown).toHaveLength(1);
    expect(rules[0].groupBreakdown?.[0].groupValue).toBe("bob@example.com");
  });

  it("normalizes department map keys at ingestion", () => {
    const snapshot = parseEnforcementRulesResponse({
      rules: [],
      departmentBudgetBlocks: { "  BOB@Example.com ": 301 },
      departmentBudgetBlockBalances: { "  BOB@Example.com ": "6.25" },
    });
    expect(snapshot.departmentBlocks.get("bob@example.com")).toBe(301);
    expect(snapshot.departmentBlockBalances.get("bob@example.com")).toBe(6.25);
  });

  it("rejects non-numeric and non-integer department map values", () => {
    const snapshot = parseEnforcementRulesResponse({
      rules: [],
      departmentBudgetBlocks: { "a@example.com": 1.5, "b@example.com": true },
      departmentBudgetBlockBalances: { "a@example.com": Number.NaN, "b@example.com": false },
    });
    expect(snapshot.departmentBlocks.size).toBe(0);
    expect(snapshot.departmentBlockBalances.size).toBe(0);
  });

  it("yields empty department maps for a bare array payload", () => {
    const snapshot = parseEnforcementRulesResponse([]);
    expect(snapshot.departmentBlocks.size).toBe(0);
    expect(snapshot.departmentBlockBalances.size).toBe(0);
  });
});

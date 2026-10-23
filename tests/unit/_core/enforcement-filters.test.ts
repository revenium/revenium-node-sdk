import type { EnforcementCriteria } from "../../../src/_core/enforcement/evaluator";
import { ruleCovers, type EnforcementFilter } from "../../../src/_core/enforcement/filters";

const idOnly: EnforcementCriteria = { subscriberId: "Sub_123" };
const aliceUpper: EnforcementCriteria = {
  subscriberEmail: "Alice@Example.com",
  model: "gpt-4.1-nano",
  provider: "OpenAI",
};
const aliceWithId: EnforcementCriteria = {
  subscriberId: "sub_123",
  subscriberEmail: "alice@example.com",
  model: "gpt-4.1-nano",
  provider: "OpenAI",
};
const full: EnforcementCriteria = {
  model: "gpt-4.1-nano",
  provider: "OpenAI",
  productName: "assistant",
  agent: "batch-bot",
  organizationName: "acme",
  taskType: "summarize",
  credential: "prod-key",
};

function op(dimension: string, operator: string, value?: string): EnforcementFilter {
  return { dimension, operator, value, values: [] };
}

function is(dimension: string, value: string): EnforcementFilter {
  return op(dimension, "IS", value);
}

function anyOf(dimension: string, ...values: string[]): EnforcementFilter {
  return { dimension, operator: "IN", values };
}

describe("ruleCovers", () => {
  it("covers every call when the rule carries no filters", () => {
    expect(ruleCovers([], full)).toBe(true);
    expect(ruleCovers([], {})).toBe(true);
  });

  describe.each<[string, EnforcementFilter, EnforcementCriteria, boolean]>([
    [
      "subscriber IS email, caller sends id and email",
      is("SUBSCRIBER", "alice@example.com"),
      aliceWithId,
      true,
    ],
    [
      "subscriber IS email, caller email differs in case",
      is("SUBSCRIBER", "alice@example.com"),
      aliceUpper,
      true,
    ],
    [
      "subscriber IS email padded and upper case in rule",
      is("SUBSCRIBER", " ALICE@example.com "),
      aliceWithId,
      true,
    ],
    ["subscriber IS id, caller also sends email", is("SUBSCRIBER", "sub_123"), aliceWithId, false],
    ["subscriber IS id, caller sends id only, exact", is("SUBSCRIBER", "Sub_123"), idOnly, true],
    ["subscriber IS id, caller id differs in case", is("SUBSCRIBER", "sub_123"), idOnly, false],
    [
      "subscriber IS_NOT email, same person other case",
      op("SUBSCRIBER", "IS_NOT", "ALICE@example.com"),
      aliceWithId,
      false,
    ],
    [
      "subscriber IS_NOT, anonymous caller",
      op("SUBSCRIBER", "IS_NOT", "alice@example.com"),
      {},
      true,
    ],
    ["subscriber IS, anonymous caller", is("SUBSCRIBER", "alice@example.com"), {}, false],
    [
      "subscriber CONTAINS ignores email case",
      op("SUBSCRIBER", "CONTAINS", "EXAMPLE.COM"),
      aliceUpper,
      true,
    ],
    [
      "subscriber ENDS_WITH on email",
      op("SUBSCRIBER", "ENDS_WITH", "@example.com"),
      aliceWithId,
      true,
    ],
    [
      "subscriber IN email list, case-insensitive",
      anyOf("SUBSCRIBER", "carol@example.com", "ALICE@example.com"),
      aliceWithId,
      true,
    ],
    [
      "subscriber IN, caller not listed",
      anyOf("SUBSCRIBER", "alice@example.com", "carol@example.com"),
      { subscriberEmail: "bob@example.com" },
      false,
    ],
    ["subscriber IN id list, exact", anyOf("SUBSCRIBER", "sub_123"), idOnly, false],
    ["IN with no values constrains nothing", anyOf("MODEL"), full, true],
    ["model IS", is("MODEL", "gpt-4.1-nano"), full, true],
    ["model IS other", is("MODEL", "gpt-4o"), full, false],
    ["model IS_NOT same model", op("MODEL", "IS_NOT", "gpt-4.1-nano"), full, false],
    ["model IS_NOT other model", op("MODEL", "IS_NOT", "gpt-4o"), full, true],
    ["model CONTAINS", op("MODEL", "CONTAINS", "4.1"), full, true],
    ["model STARTS_WITH", op("MODEL", "STARTS_WITH", "gpt-"), full, true],
    ["model ENDS_WITH miss", op("MODEL", "ENDS_WITH", "mini"), full, false],
    ["model comparison is case-sensitive", is("MODEL", "GPT-4.1-nano"), full, false],
    ["model IN", anyOf("MODEL", "gpt-4o", "gpt-4.1-nano"), full, true],
    ["unknown operator never matches", op("MODEL", "MATCHES", "gpt"), full, false],
    ["agent IS", is("AGENT", "batch-bot"), full, true],
    ["agent IS other agent", is("AGENT", "batch-bot"), { agent: "other-bot" }, false],
    ["agent IS, no agent sent", is("AGENT", "batch-bot"), {}, false],
    ["agent IS_NOT, no agent sent", op("AGENT", "IS_NOT", "batch-bot"), {}, true],
    ["product IS", is("PRODUCT", "assistant"), full, true],
    ["organization IS", is("ORGANIZATION", "acme"), full, true],
    ["organization IN miss", anyOf("ORGANIZATION", "globex"), full, false],
    ["task type IS", is("TASK_TYPE", "summarize"), full, true],
    ["credential IS", is("CREDENTIAL", "prod-key"), full, true],
    ["credential IS other", is("CREDENTIAL", "dev-key"), full, false],
    ["provider IS exact", is("PROVIDER", "OpenAI"), full, true],
    ["provider IS ignores case, no alias bucket applies", is("PROVIDER", "OPENAI"), full, true],
    ["provider IS_NOT ignores case", op("PROVIDER", "IS_NOT", "openai"), full, false],
    ["provider IN ignores case", anyOf("PROVIDER", "OPENAI"), full, true],
    ["provider IS another provider", is("PROVIDER", "AZURE"), full, false],
    ["provider IS, no provider sent", is("PROVIDER", "openai"), {}, false],
    ["department filter never matches on the client", is("DEPARTMENT", "173"), full, false],
    ["unknown dimension never matches", is("WORKSPACE", "w1"), full, false],
    ["unknown dimension without a value never matches", op("WORKSPACE", "IS"), full, false],
    ["department IN with no values never matches", anyOf("DEPARTMENT"), full, false],
    ["unknown operator without a value never matches", op("MODEL", "MATCHES"), full, false],
    ["missing operator never matches", op("MODEL", "", "gpt-4.1-nano"), full, false],
    [
      "known dimension and operator without a value constrains nothing",
      op("AGENT", "IS"),
      full,
      true,
    ],
    ["an empty expected value is compared literally", is("AGENT", ""), full, false],
  ])("%s", (_name, filter, criteria, expected) => {
    it(`resolves to ${expected}`, () => {
      expect(ruleCovers([filter], criteria)).toBe(expected);
    });
  });

  it("composes filters with AND", () => {
    const filters = [is("PROVIDER", "openai"), op("MODEL", "IS_NOT", "gpt-4.1-nano")];

    expect(ruleCovers(filters, { provider: "OpenAI", model: "gpt-4o" })).toBe(true);
    expect(ruleCovers(filters, { provider: "OpenAI", model: "gpt-4.1-nano" })).toBe(false);
    expect(ruleCovers(filters, { provider: "Azure", model: "gpt-4o" })).toBe(false);
  });

  it("covers nothing when one row of an otherwise matching rule is unevaluable", () => {
    expect(ruleCovers([is("PROVIDER", "openai"), is("DEPARTMENT", "173")], full)).toBe(false);
  });

  it("covers nothing when the row is marked unevaluable at parse time", () => {
    expect(ruleCovers([{ ...is("MODEL", "gpt-4.1-nano"), unevaluable: true }], full)).toBe(false);
  });

  it("falls back to the subscriber id when the email is not a string", () => {
    const criteria = {
      subscriberEmail: 42 as unknown as string,
      subscriberId: "Sub_123",
    } satisfies EnforcementCriteria;

    expect(ruleCovers([is("SUBSCRIBER", "Sub_123")], criteria)).toBe(true);
    expect(ruleCovers([is("SUBSCRIBER", "carol@example.com")], criteria)).toBe(false);
  });

  it("treats a caller whose identities are both unreadable as anonymous", () => {
    const criteria = {
      subscriberEmail: {} as unknown as string,
      subscriberId: 7 as unknown as string,
    } satisfies EnforcementCriteria;

    expect(ruleCovers([is("SUBSCRIBER", "alice@example.com")], criteria)).toBe(false);
    expect(ruleCovers([op("SUBSCRIBER", "IS_NOT", "alice@example.com")], criteria)).toBe(true);
  });
});

import { MeteredResponseLedger } from "../../../src/openai/metered-response-ledger";

describe("MeteredResponseLedger", () => {
  it("accepts a response id the first time", () => {
    expect(new MeteredResponseLedger().claim("resp_stub")).toBe(true);
  });

  it("rejects a response id already recorded", () => {
    const ledger = new MeteredResponseLedger();
    ledger.claim("resp_stub");

    expect(ledger.claim("resp_stub")).toBe(false);
  });

  it("tracks distinct response ids independently", () => {
    const ledger = new MeteredResponseLedger();
    ledger.claim("resp_one");

    expect(ledger.claim("resp_two")).toBe(true);
  });

  it("keeps separate ledgers isolated from each other", () => {
    new MeteredResponseLedger().claim("resp_stub");

    expect(new MeteredResponseLedger().claim("resp_stub")).toBe(true);
  });

  it("accepts a released response id again", () => {
    const ledger = new MeteredResponseLedger();
    ledger.claim("resp_stub");
    ledger.release("resp_stub");

    expect(ledger.claim("resp_stub")).toBe(true);
  });

  it("accepts the oldest response id again once the cap is exceeded", () => {
    const ledger = new MeteredResponseLedger(2);
    ledger.claim("resp_one");
    ledger.claim("resp_two");

    ledger.claim("resp_three");

    expect(ledger.claim("resp_one")).toBe(true);
    expect(ledger.claim("resp_three")).toBe(false);
  });

  it("returns the context recorded for a response id", () => {
    const ledger = new MeteredResponseLedger();
    ledger.rememberContext("resp_stub", { metadata: { organizationName: "org_1" } });

    expect(ledger.contextFor("resp_stub")).toEqual({ metadata: { organizationName: "org_1" } });
  });

  it("returns the captured input recorded for a response id", () => {
    const ledger = new MeteredResponseLedger();
    ledger.rememberContext("resp_stub", { messages: [{ role: "user", content: "hello" }] });

    expect(ledger.contextFor("resp_stub")?.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("returns no context for an unknown response id", () => {
    expect(new MeteredResponseLedger().contextFor("resp_stub")).toBeUndefined();
  });

  it("drops the oldest context once the cap is exceeded", () => {
    const ledger = new MeteredResponseLedger(2);
    ledger.rememberContext("resp_one", { metadata: { organizationName: "org_1" } });
    ledger.rememberContext("resp_two", { metadata: { organizationName: "org_2" } });

    ledger.rememberContext("resp_three", { metadata: { organizationName: "org_3" } });

    expect(ledger.contextFor("resp_one")).toBeUndefined();
    expect(ledger.contextFor("resp_three")).toEqual({ metadata: { organizationName: "org_3" } });
  });
});

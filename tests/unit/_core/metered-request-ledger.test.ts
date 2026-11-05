import { MeteredRequestLedger } from "../../../src/_core/metering/metered-request-ledger";

type StubContext = { metadata?: { organizationName: string }; messages?: unknown[] };

describe("MeteredRequestLedger", () => {
  it("accepts a response id the first time", () => {
    expect(new MeteredRequestLedger<StubContext>().claim("resp_stub")).toBe(true);
  });

  it("rejects a response id already recorded", () => {
    const ledger = new MeteredRequestLedger<StubContext>();
    ledger.claim("resp_stub");

    expect(ledger.claim("resp_stub")).toBe(false);
  });

  it("tracks distinct response ids independently", () => {
    const ledger = new MeteredRequestLedger<StubContext>();
    ledger.claim("resp_one");

    expect(ledger.claim("resp_two")).toBe(true);
  });

  it("keeps separate ledgers isolated from each other", () => {
    new MeteredRequestLedger<StubContext>().claim("resp_stub");

    expect(new MeteredRequestLedger<StubContext>().claim("resp_stub")).toBe(true);
  });

  it("accepts a released response id again", () => {
    const ledger = new MeteredRequestLedger<StubContext>();
    ledger.claim("resp_stub");
    ledger.release("resp_stub");

    expect(ledger.claim("resp_stub")).toBe(true);
  });

  it("accepts the oldest response id again once the cap is exceeded", () => {
    const ledger = new MeteredRequestLedger<StubContext>(2);
    ledger.claim("resp_one");
    ledger.claim("resp_two");

    ledger.claim("resp_three");

    expect(ledger.claim("resp_one")).toBe(true);
    expect(ledger.claim("resp_three")).toBe(false);
  });

  it("returns the context recorded for a response id", () => {
    const ledger = new MeteredRequestLedger<StubContext>();
    ledger.rememberContext("resp_stub", { metadata: { organizationName: "org_1" } });

    expect(ledger.contextFor("resp_stub")).toEqual({ metadata: { organizationName: "org_1" } });
  });

  it("returns the captured input recorded for a response id", () => {
    const ledger = new MeteredRequestLedger<StubContext>();
    ledger.rememberContext("resp_stub", { messages: [{ role: "user", content: "hello" }] });

    expect(ledger.contextFor("resp_stub")?.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("returns no context for an unknown response id", () => {
    expect(new MeteredRequestLedger<StubContext>().contextFor("resp_stub")).toBeUndefined();
  });

  it("drops the oldest context once the cap is exceeded", () => {
    const ledger = new MeteredRequestLedger<StubContext>(2);
    ledger.rememberContext("resp_one", { metadata: { organizationName: "org_1" } });
    ledger.rememberContext("resp_two", { metadata: { organizationName: "org_2" } });

    ledger.rememberContext("resp_three", { metadata: { organizationName: "org_3" } });

    expect(ledger.contextFor("resp_one")).toBeUndefined();
    expect(ledger.contextFor("resp_three")).toEqual({ metadata: { organizationName: "org_3" } });
  });
});

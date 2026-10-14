import { buildEnforcementRulesUrl } from "../../../src/_core/enforcement/engine";

describe("buildEnforcementRulesUrl", () => {
  it("appends the served enforcement path to a bare host base", () => {
    expect(buildEnforcementRulesUrl("https://api.revenium.ai", "HASHED_ID")).toBe(
      "https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/HASHED_ID",
    );
  });

  it("resolves a /profitstream base to the same address as the bare host", () => {
    const served = "https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/Ol3wbl";

    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io/profitstream", "Ol3wbl")).toBe(
      served,
    );
    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io", "Ol3wbl")).toBe(served);
  });

  it("keeps a single prefix when the base already ends in /profitstream/v2", () => {
    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io/profitstream/v2", "Ol3wbl")).toBe(
      "https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/Ol3wbl",
    );
  });

  it("replaces a metering suffix instead of appending to it", () => {
    expect(buildEnforcementRulesUrl("https://api.revenium.ai/meter/v2", "abc")).toBe(
      "https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/abc",
    );
    expect(buildEnforcementRulesUrl("https://api.revenium.ai/meter", "abc")).toBe(
      "https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("keeps a single prefix when the base ends in a bare /v2", () => {
    expect(buildEnforcementRulesUrl("https://api.revenium.ai/v2", "abc")).toBe(
      "https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("strips a full service path including empty segments", () => {
    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io/profitstream/v2/api", "abc")).toBe(
      "https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/abc",
    );
    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io/profitstream//v2", "abc")).toBe(
      "https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("strips the service path regardless of case", () => {
    expect(buildEnforcementRulesUrl("https://api.revenium.ai/METER/V2", "abc")).toBe(
      "https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("strips trailing slashes from the base URL", () => {
    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io///", "abc")).toBe(
      "https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/abc",
    );
    expect(buildEnforcementRulesUrl("https://api.dev.hcapp.io/profitstream///", "abc")).toBe(
      "https://api.dev.hcapp.io/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("treats the prefix as a path segment, not a substring of the host", () => {
    expect(buildEnforcementRulesUrl("https://profitstream.example.com", "abc")).toBe(
      "https://profitstream.example.com/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("keeps a single-label internal host intact", () => {
    expect(buildEnforcementRulesUrl("http://profitstream", "abc")).toBe(
      "http://profitstream/profitstream/v2/api/ai/enforcement-rules/abc",
    );
    expect(buildEnforcementRulesUrl("http://meter/", "abc")).toBe(
      "http://meter/profitstream/v2/api/ai/enforcement-rules/abc",
    );
    expect(buildEnforcementRulesUrl("http://v2:8080/v2", "abc")).toBe(
      "http://v2:8080/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("keeps a gateway base path intact", () => {
    expect(buildEnforcementRulesUrl("https://gw.corp.com/revenium/api", "abc")).toBe(
      "https://gw.corp.com/revenium/api/profitstream/v2/api/ai/enforcement-rules/abc",
    );
  });

  it("url-encodes the team id", () => {
    expect(buildEnforcementRulesUrl("https://api.revenium.ai", "a/b+c")).toBe(
      "https://api.revenium.ai/profitstream/v2/api/ai/enforcement-rules/a%2Fb%2Bc",
    );
  });
});

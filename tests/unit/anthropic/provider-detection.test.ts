import {
  detectAnthropicProvider,
  DIRECT_ANTHROPIC_PROVIDER,
} from "../../../src/anthropic/provider-detection";

describe("detectAnthropicProvider", () => {
  it.each([
    "https://my-resource.services.ai.azure.com/anthropic/",
    "https://my-resource.services.ai.azure.com",
    "https://services.ai.azure.com",
    "https://MY-RESOURCE.SERVICES.AI.AZURE.COM",
  ])("labels %s as Foundry", (baseUrl) => {
    expect(detectAnthropicProvider(baseUrl)).toBe("Foundry");
  });

  it.each([
    "https://api.anthropic.com",
    "https://my-resource.openai.azure.com/",
    "https://proxy.example.com/?next=services.ai.azure.com",
    "https://services.ai.azure.com.attacker.example",
    "https://my-resource.services.ai.azure.com.evil.net",
    "https://evilservices.ai.azure.com",
    "not a url",
    "",
    undefined,
  ])("labels %s as direct Anthropic", (baseUrl) => {
    expect(detectAnthropicProvider(baseUrl)).toBe(DIRECT_ANTHROPIC_PROVIDER);
  });

  it("keeps the direct label spelled as the wire value the metering API expects", () => {
    expect(DIRECT_ANTHROPIC_PROVIDER).toBe("Anthropic");
  });
});

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
    "https://bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke",
    "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
    "https://bedrock-runtime.us-east-1.api.aws",
    "https://BEDROCK-RUNTIME.US-EAST-1.AMAZONAWS.COM",
  ])("labels %s as AWS", (baseUrl) => {
    expect(detectAnthropicProvider(baseUrl)).toBe("AWS");
  });

  it.each([
    "https://us-east5-aiplatform.googleapis.com/v1",
    "https://aiplatform.googleapis.com/v1",
    "https://aiplatform.us.rep.googleapis.com/v1",
    "https://aiplatform.eu.rep.googleapis.com/v1",
  ])("labels %s as Google", (baseUrl) => {
    expect(detectAnthropicProvider(baseUrl)).toBe("Google");
  });

  it.each([
    "https://api.anthropic.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com.evil.net",
    "https://proxy.example.com/bedrock-runtime",
    "https://evilaiplatform.googleapis.com",
    "https://aiplatform.us.rep.googleapis.com.evil.net",
    "https://aiplatform.us.rep.evil.net",
    "https://us-east5-aiplatform.googleapis.com.evil.net",
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

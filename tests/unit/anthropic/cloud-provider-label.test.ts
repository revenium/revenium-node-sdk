import type { AnthropicClientFactory } from "../../helpers/anthropic-metering";
import {
  DIRECT_BASE_URL,
  differingKeys,
  setupAnthropicMetering,
} from "../../helpers/anthropic-metering";

const BEDROCK_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";
const VERTEX_BASE_URL = "https://us-east5-aiplatform.googleapis.com/v1";

const CLOUD_BASE_URLS: [string, string][] = [
  [BEDROCK_BASE_URL, "AWS"],
  [VERTEX_BASE_URL, "Google"],
];

const createBedrockClient: AnthropicClientFactory = async () => {
  const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
  return new AnthropicBedrock({
    awsRegion: "us-east-1",
    awsAccessKey: "test-access-key",
    awsSecretKey: "test-secret-key",
  }) as never;
};

const createVertexClient =
  (region: string): AnthropicClientFactory =>
  async () => {
    const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
    return new AnthropicVertex({
      region,
      projectId: "test-project",
      authClient: { getRequestHeaders: async () => new Headers() } as never,
    }) as never;
  };

const CLOUD_CLIENTS: [string, string, AnthropicClientFactory][] = [
  ["AnthropicBedrock", "AWS", createBedrockClient],
  ["AnthropicVertex", "Google", createVertexClient("us-east5")],
  ["AnthropicVertex region us", "Google", createVertexClient("us")],
  ["AnthropicVertex region eu", "Google", createVertexClient("eu")],
];

const harness = setupAnthropicMetering();

describe("messages.create", () => {
  it.each(CLOUD_BASE_URLS)("labels %s as %s exactly once", async (baseUrl, provider) => {
    const { body, bodies } = await harness.meterNonStreamingCall(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });
});

describe("messages.create with stream", () => {
  it.each(CLOUD_BASE_URLS)("labels %s as %s exactly once", async (baseUrl, provider) => {
    const { body, bodies } = await harness.meterStreamingCreate(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });
});

describe("messages.stream", () => {
  it.each(CLOUD_BASE_URLS)("labels %s as %s exactly once", async (baseUrl, provider) => {
    const { body, bodies } = await harness.meterStreamHelper(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });
});

describe("beta.messages.create", () => {
  it.each(CLOUD_BASE_URLS)("labels %s as %s exactly once", async (baseUrl, provider) => {
    const { body, bodies } = await harness.meterBetaCall(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });
});

describe("cloud SDK clients", () => {
  it.each(CLOUD_CLIENTS)("meters %s calls as %s exactly once", async (_name, provider, factory) => {
    const { body, bodies } = await harness.meterNonStreamingCall(factory);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });
});

describe("payload parity", () => {
  it("differs from a direct call only by provider", async () => {
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    try {
      const { transactionId: bedrockTransactionId, ...bedrockBody } = (
        await harness.meterNonStreamingCall(BEDROCK_BASE_URL)
      ).body;
      const { transactionId: directTransactionId, ...directBody } = (
        await harness.meterNonStreamingCall(DIRECT_BASE_URL)
      ).body;

      expect(bedrockTransactionId).not.toEqual(directTransactionId);
      expect(differingKeys(bedrockBody, directBody)).toEqual(["provider"]);
      expect(bedrockBody.provider).toBe("AWS");
      expect(directBody.provider).toBe("Anthropic");
    } finally {
      jest.useRealTimers();
    }
  });
});

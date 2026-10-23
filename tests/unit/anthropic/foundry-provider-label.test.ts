import {
  DIRECT_BASE_URL,
  MODEL,
  REQUEST,
  differingKeys,
  installRoutingFetch,
  jsonResponse,
  settle,
  setupAnthropicMetering,
  sseResponse,
  waitForMetering,
} from "../../helpers/anthropic-metering";

const FOUNDRY_BASE_URL = "https://my-resource.services.ai.azure.com/anthropic";

const BASE_URLS: [string, string][] = [
  [FOUNDRY_BASE_URL, "Foundry"],
  [DIRECT_BASE_URL, "Anthropic"],
];

const harness = setupAnthropicMetering();

describe("messages.create", () => {
  it.each(BASE_URLS)("labels %s as %s", async (baseUrl, provider) => {
    const { body } = await harness.meterNonStreamingCall(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
  });
});

describe("messages.create with stream", () => {
  it.each(BASE_URLS)("labels %s as %s", async (baseUrl, provider) => {
    const { body } = await harness.meterStreamingCreate(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
  });
});

describe("messages.stream", () => {
  it.each(BASE_URLS)("labels %s as %s exactly once", async (baseUrl, provider) => {
    const { body, bodies } = await harness.meterStreamHelper(baseUrl);

    expect(body).toMatchObject({ provider, modelSource: "ANTHROPIC" });
    expect(bodies).toHaveLength(1);
  });

  it("keeps the SDK stream helper methods available", async () => {
    const bodies = installRoutingFetch(sseResponse);
    const client = harness.createClient(FOUNDRY_BASE_URL);
    const textDeltas: string[] = [];

    const stream = client.messages.stream(REQUEST as never);
    stream.on("text", (text: string) => textDeltas.push(text));
    await stream.withResponse();
    const finalMessage = await stream.finalMessage();

    expect(finalMessage.model).toBe(MODEL);
    expect(textDeltas).toEqual(["Hello"]);
    expect(await stream.finalText()).toBe("Hello");

    await waitForMetering(bodies);
    await settle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ provider: "Foundry", modelSource: "ANTHROPIC" });
  });
});

describe("Anthropic SDK resource surface", () => {
  it("exposes the client base URL the provider label is derived from", () => {
    const client = harness.createClient(FOUNDRY_BASE_URL);

    expect(
      (client.messages as unknown as { _client?: { baseURL?: string } })._client?.baseURL,
    ).toBe(FOUNDRY_BASE_URL);
  });
});

describe("trackUsageAsync without a resolved provider", () => {
  it("keeps the direct Anthropic label", async () => {
    const bodies = installRoutingFetch(jsonResponse);

    harness.trackUsageAsync({
      requestId: "req-foundry-fallback",
      model: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      duration: 100,
      isStreamed: false,
      stopReason: "end_turn",
      requestTime: new Date(),
      responseTime: new Date(),
    });

    expect(await waitForMetering(bodies)).toHaveProperty("provider", "Anthropic");
  });
});

describe("payload parity", () => {
  it("differs from a direct call only by provider", async () => {
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    try {
      const { transactionId: foundryTransactionId, ...foundryBody } = (
        await harness.meterNonStreamingCall(FOUNDRY_BASE_URL)
      ).body;
      const { transactionId: directTransactionId, ...directBody } = (
        await harness.meterNonStreamingCall(DIRECT_BASE_URL)
      ).body;

      expect(foundryTransactionId).not.toEqual(directTransactionId);
      expect(differingKeys(foundryBody, directBody)).toEqual(["provider"]);
      expect(foundryBody.provider).toBe("Foundry");
      expect(directBody.provider).toBe("Anthropic");
    } finally {
      jest.useRealTimers();
    }
  });
});

import { createReveniumConfig } from "../../helpers/fixtures";
import type { ReveniumPayload, UsageMetadata } from "../../../src/_core/types/index";
import type { ProviderInfo } from "../../../src/openai/provider-detection";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let middleware: typeof import("../../../src/openai/middleware");
let providerInfo: ProviderInfo;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function meteredPayload(): ReveniumPayload {
  return jest.mocked(sendToRevenium).mock.calls[0][0];
}

describe("OpenAI multimodal operationSubtype", () => {
  beforeEach(async () => {
    jest.resetModules();

    const manager = await import("../../../src/_core/config/manager");
    const apiClient = await import("../../../src/_core/metering/api-client");
    const providerDetection = await import("../../../src/openai/provider-detection");

    setConfig = manager.setConfig;
    resetConfig = manager.resetConfig;
    sendToRevenium = apiClient.sendToRevenium;
    middleware = await import("../../../src/openai/middleware");
    providerInfo = { provider: providerDetection.Provider.OPENAI, isAzure: false };

    setConfig(createReveniumConfig({ printSummary: false }));
    jest.mocked(sendToRevenium).mockClear();
  });

  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  async function meterSpeech(usageMetadata?: UsageMetadata): Promise<ReveniumPayload> {
    const create = jest.fn().mockResolvedValue({});
    const speech = new middleware.AudioSpeechInterface(
      { create } as never,
      {} as never,
      providerInfo,
    );

    await speech.create({
      model: "gpt-4o-mini-tts",
      input: "hello",
      voice: "alloy",
      ...(usageMetadata ? { usageMetadata } : {}),
    } as never);
    await flushPromises();

    return meteredPayload();
  }

  it("meters a speech call as tts, priced per character", async () => {
    const payload = await meterSpeech();

    expect(payload.operationType).toBe("AUDIO");
    expect(payload.operationSubtype).toBe("tts");
    expect(payload.characterCount).toBe(5);
    expect(payload.attributes?.billing_unit).toBe("per_character");
  });

  it("lets caller metadata override the speech subtype", async () => {
    expect((await meterSpeech({ operationSubtype: "realtime" })).operationSubtype).toBe("realtime");
  });

  it("keeps tts when the caller override is not accepted", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await meterSpeech({ operationSubtype: "speach" })).operationSubtype).toBe("tts");
  });

  it("accepts the legacy speech_synthesis literal on the public tracker", async () => {
    middleware.trackAudioUsageAsync(
      "speech_synthesis",
      {},
      { model: "tts-1", input: "hello" },
      Date.now() - 1000,
      1000,
      {},
      providerInfo,
    );
    await flushPromises();

    expect(meteredPayload().operationSubtype).toBe("tts");
  });

  it("meters a transcription call as transcription", async () => {
    const create = jest.fn().mockResolvedValue({ text: "hello", duration: 12 });
    const transcriptions = new middleware.AudioTranscriptionsInterface(
      { create } as never,
      {} as never,
      providerInfo,
    );

    await transcriptions.create({ model: "whisper-1", file: {} } as never);
    await flushPromises();

    expect(meteredPayload().operationSubtype).toBe("transcription");
  });

  it.each([
    ["generate", "generation"],
    ["edit", "edit"],
    ["createVariation", "variation"],
  ])("meters images.%s as %s", async (method, expectedSubtype) => {
    const create = jest.fn().mockResolvedValue({ data: [{ url: "https://example.com/1.png" }] });
    const images = new middleware.ImagesInterface(
      { generate: create, edit: create, createVariation: create } as never,
      {} as never,
      providerInfo,
    );

    await (images as unknown as Record<string, (params: unknown) => Promise<unknown>>)[method]({
      model: "dall-e-3",
      prompt: "a cat",
    });
    await flushPromises();

    const payload = meteredPayload();
    expect(payload.operationType).toBe("IMAGE");
    expect(payload.operationSubtype).toBe(expectedSubtype);
  });
});

import { createReveniumConfig } from "../../helpers/fixtures";
import type { ReveniumPayload } from "../../../src/_core/types/index";
import type { ProviderInfo } from "../../../src/openai/provider-detection";

jest.mock("../../../src/_core/metering/api-client", () => ({
  sendToRevenium: jest.fn().mockResolvedValue(undefined),
}));

let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let sendToRevenium: typeof import("../../../src/_core/metering/api-client").sendToRevenium;
let middleware: typeof import("../../../src/openai/middleware");
let providerInfo: ProviderInfo;

const COMPLETION_USAGE = {
  input_tokens: 20,
  output_tokens: 100,
  total_tokens: 120,
};

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function meteredPayloads(): ReveniumPayload[] {
  return jest.mocked(sendToRevenium).mock.calls.map((call) => call[0]);
}

function partialEvent(type: string): Record<string, unknown> {
  return { type, b64_json: "partial", partial_image_index: 0 };
}

function completedEvent(type: string): Record<string, unknown> {
  return { type, b64_json: "final", usage: COMPLETION_USAGE };
}

function streamOf(events: Array<Record<string, unknown>>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function throwingStream(
  events: Array<Record<string, unknown>>,
  error: Error,
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
      throw error;
    },
  };
}

function buildImages(response: unknown): InstanceType<typeof middleware.ImagesInterface> {
  const call = jest.fn().mockResolvedValue(response);
  return new middleware.ImagesInterface(
    { generate: call, edit: call, createVariation: call } as never,
    createReveniumConfig() as never,
    providerInfo,
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const received: unknown[] = [];
  for await (const event of stream) {
    received.push(event);
  }
  return received;
}

describe("OpenAI streamed image metering", () => {
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

  it("counts the completed image on a streamed generate", async () => {
    const images = buildImages(
      streamOf([
        partialEvent("image_generation.partial_image"),
        completedEvent("image_generation.completed"),
      ]),
    );

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
      partial_images: 1,
    } as never);
    await drain(stream);
    await flushPromises();

    const payloads = meteredPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].actualImageCount).toBe(1);
    expect(payloads[0].attributes?.actual_image_count).toBe(1);
    expect(payloads[0].operationSubtype).toBe("generation");
  });

  it("marks the streamed image record as streamed and carries the completion usage", async () => {
    const images = buildImages(
      streamOf([
        partialEvent("image_generation.partial_image"),
        completedEvent("image_generation.completed"),
      ]),
    );

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
    } as never);
    await drain(stream);
    await flushPromises();

    const payload = meteredPayloads()[0];
    expect(payload.isStreamed).toBe(true);
    expect(payload.inputTokenCount).toBe(20);
    expect(payload.outputTokenCount).toBe(100);
    expect(payload.totalTokenCount).toBe(120);
    expect(payload.timeToFirstToken).toBeDefined();
  });

  it("counts a streamed edit the same way", async () => {
    const images = buildImages(streamOf([completedEvent("image_edit.completed")]));

    const stream = await images.edit({
      model: "gpt-image-1",
      image: {},
      prompt: "make it blue",
      stream: true,
    } as never);
    await drain(stream);
    await flushPromises();

    const payload = meteredPayloads()[0];
    expect(payload.actualImageCount).toBe(1);
    expect(payload.operationSubtype).toBe("edit");
  });

  it("meters an abandoned image stream once as CANCELLED", async () => {
    const images = buildImages(
      streamOf([
        partialEvent("image_generation.partial_image"),
        completedEvent("image_generation.completed"),
      ]),
    );

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
    } as never);
    for await (const event of stream) {
      expect(event).toBeDefined();
      break;
    }
    await flushPromises();

    const payloads = meteredPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].stopReason).toBe("CANCELLED");
    expect(payloads[0].actualImageCount).toBe(0);
  });

  it("meters a failing image stream as ERROR and rethrows", async () => {
    const failure = new Error("stream exploded");
    const images = buildImages(
      throwingStream([partialEvent("image_generation.partial_image")], failure),
    );

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
    } as never);

    await expect(drain(stream)).rejects.toThrow("stream exploded");
    await flushPromises();

    const payloads = meteredPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].stopReason).toBe("ERROR");
    expect(payloads[0].actualImageCount).toBe(0);
  });

  it("keeps the completed images when the stream fails after a completion event", async () => {
    const images = buildImages(
      throwingStream(
        [
          partialEvent("image_generation.partial_image"),
          completedEvent("image_generation.completed"),
        ],
        new Error("stream exploded"),
      ),
    );

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
    } as never);

    await expect(drain(stream)).rejects.toThrow("stream exploded");
    await flushPromises();

    const payload = meteredPayloads()[0];
    expect(payload.stopReason).toBe("ERROR");
    expect(payload.actualImageCount).toBe(1);
    expect(payload.attributes?.actual_image_count).toBe(1);
    expect(payload.outputTokenCount).toBe(100);
  });

  it("does not meter a second pass over the same stream", async () => {
    const events = [completedEvent("image_generation.completed")];
    const providerStream = {
      iterator: () =>
        (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      [Symbol.asyncIterator]() {
        return this.iterator();
      },
    };
    const images = buildImages(providerStream);

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
    } as never);
    await drain(stream);
    await drain(stream);
    await flushPromises();

    const payloads = meteredPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].actualImageCount).toBe(1);
    expect(payloads[0].isStreamed).toBe(true);
  });

  it("covers the whole stream in the duration", async () => {
    let now = 1_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const images = buildImages({
      async *[Symbol.asyncIterator]() {
        now += 300;
        yield partialEvent("image_generation.partial_image");
        now += 700;
        yield completedEvent("image_generation.completed");
      },
    });

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      stream: true,
    } as never);
    await drain(stream);
    await flushPromises();

    const payload = meteredPayloads()[0];
    expect(payload.requestDuration).toBe(1000);
    expect(payload.timeToFirstToken).toBe(300);
  });

  it("counts every completed image and sums their usage when n > 1", async () => {
    const images = buildImages(
      streamOf([
        completedEvent("image_generation.completed"),
        completedEvent("image_generation.completed"),
        { type: "image_generation.completed", b64_json: "final" },
      ]),
    );

    const stream = await images.generate({
      model: "gpt-image-1",
      prompt: "a cat",
      n: 3,
      stream: true,
    } as never);
    await drain(stream);
    await flushPromises();

    const payload = meteredPayloads()[0];
    expect(payload.actualImageCount).toBe(3);
    expect(payload.requestedImageCount).toBe(3);
    expect(payload.inputTokenCount).toBe(40);
    expect(payload.outputTokenCount).toBe(200);
    expect(payload.totalTokenCount).toBe(240);
  });

  it("keeps the non-streamed count", async () => {
    const images = buildImages({ data: [{ url: "https://example.com/1.png" }] });

    await images.generate({ model: "dall-e-3", prompt: "a cat" } as never);
    await flushPromises();

    const payload = meteredPayloads()[0];
    expect(payload.actualImageCount).toBe(1);
    expect(payload.isStreamed).toBe(false);
    expect(payload.inputTokenCount).toBeNull();
    expect(payload.outputTokenCount).toBeNull();
    expect(payload.totalTokenCount).toBeNull();
  });
});

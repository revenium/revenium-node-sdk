import { createReveniumConfig, createMockFetch } from "../../helpers/fixtures";

const originalFetch = global.fetch;

let sendFalMetrics: typeof import("../../../src/fal/tracking").sendFalMetrics;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

beforeEach(async () => {
  jest.resetModules();
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const tracking = await import("../../../src/fal/tracking");

  sendFalMetrics = tracking.sendFalMetrics;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;

  setConfig(createReveniumConfig());
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.AWS_REGION;
  resetConfig();
  jest.restoreAllMocks();
});

describe("sendFalMetrics IMAGE tracking", () => {
  it("sends IMAGE payload with correct fields", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/flux/dev",
      operationType: "IMAGE",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "a cat", num_images: 2 },
      result: {
        images: [
          { url: "https://example.com/1.png", width: 1024, height: 1024 },
          { url: "https://example.com/2.png", width: 1024, height: 1024 },
        ],
      },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("IMAGE");
    expect(body.provider).toBe("fal_ai");
    expect(body.modelSource).toBe("FAL_AI");
    expect(body.model).toBe("fal-ai/flux/dev");
    expect(body.middlewareSource).toBe("revenium-fal-node");
    expect(body.inputTokenCount).toBeNull();
    expect(body.outputTokenCount).toBeNull();
    expect(body.totalTokenCount).toBeNull();
    expect(body.actualImageCount).toBe(2);
    expect(body.requestedImageCount).toBe(2);
    expect(body.resolution).toBe("1024x1024");
    expect(body.attributes.resolution).toBe("1024x1024");
    expect(body.operationSubtype).toBe("generation");
    expect(body.attributes.operationSubtype).toBeUndefined();
  });

  it("derives the resolution from an object image_size when the result has no dimensions", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/flux/dev",
      operationType: "IMAGE",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "a cat", image_size: { width: 1280, height: 720 } },
      result: { images: [{ url: "https://example.com/1.png" }] },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.resolution).toBe("1280x720");
    expect(body.attributes.resolution).toBe("1280x720");
  });

  it("omits the resolution when no dimensions are derivable", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/flux/dev",
      operationType: "IMAGE",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "a cat" },
      result: { images: [{ url: "https://example.com/1.png" }] },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.resolution).toBeUndefined();
    expect(body.attributes.resolution).toBe("unknown");
  });

  it("keeps a named image_size preset out of the top-level resolution", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/flux/dev",
      operationType: "IMAGE",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "a cat", image_size: "landscape_16_9" },
      result: { images: [{ url: "https://example.com/1.png" }] },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.resolution).toBeUndefined();
    expect(body.attributes.resolution).toBe("landscape_16_9");
  });

  it("lets caller metadata override the detected IMAGE subtype", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/clarity-upscaler",
      operationType: "IMAGE",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { image_url: "https://example.com/in.png" },
      result: { images: [{ url: "https://example.com/out.png", width: 2048, height: 2048 }] },
      isStreamed: false,
      usageMetadata: { operationSubtype: "upscale" },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("upscale");
  });
});

describe("sendFalMetrics VIDEO tracking", () => {
  it("sends VIDEO payload with duration", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/kling-video/v2/master/text-to-video",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse", duration: 10, aspect_ratio: "16:9", resolution: "720p" },
      result: { video: { url: "https://example.com/video.mp4" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("VIDEO");
    expect(body.provider).toBe("fal_ai");
    expect(body.inputTokenCount).toBeNull();
    expect(body.durationSeconds).toBe(10);
    expect(body.attributes.video_duration_seconds).toBe(10);
    expect(body.attributes.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("720p");
    expect(body.attributes.resolution).toBe("720p");
    expect(body.operationSubtype).toBe("generation");
    expect(body.attributes.operationSubtype).toBeUndefined();
  });

  it("sends the model default length when the caller states none", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/kling-video/v2/master/text-to-video",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse" },
      result: { video: { url: "https://example.com/video.mp4" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(5);
    expect(body.attributes.video_duration_seconds).toBe(5);
  });

  it("parses a string video duration", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/veo3",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse", duration: "6s" },
      result: { video: { url: "https://example.com/video.mp4" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(6);
    expect(typeof body.durationSeconds).toBe("number");
    expect(body.attributes.video_duration_seconds).toBe(6);
  });

  it("prefers the requested length over an unattested result duration", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/veo3",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse", duration: "8s" },
      result: { video: { url: "https://example.com/video.mp4" }, duration: 143.7 },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(8);
  });

  it("falls back to the result duration when the caller requested none", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/some-unlisted-video-model",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse" },
      result: { video: { url: "https://example.com/video.mp4" }, duration: "6s" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(6);
    expect(typeof body.durationSeconds).toBe("number");
  });

  it("applies the veo3 default when no source states a length", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/veo3/fast",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse" },
      result: { video: { url: "https://example.com/video.mp4" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(8);
    expect(body.attributes.video_duration_seconds).toBe(8);
  });

  it("omits the duration only for endpoints without a verified default", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    for (const endpointId of ["fal-ai/some-unlisted-video-model", "fal-ai/veo3"]) {
      await sendFalMetrics({
        endpointId,
        operationType: "VIDEO",
        startTime: Date.now() - 5000,
        duration: 5000,
        input: { prompt: "a running horse", resolution: "720p" },
        result: { video: { url: "https://example.com/video.mp4" } },
        isStreamed: false,
      });
    }

    const unlisted = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(unlisted).not.toHaveProperty("durationSeconds");
    expect(unlisted.attributes).not.toHaveProperty("video_duration_seconds");
    expect(unlisted.resolution).toBe("720p");
    expect(unlisted.operationSubtype).toBe("generation");

    const defaulted = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(defaulted.durationSeconds).toBe(8);
    expect(defaulted.attributes.video_duration_seconds).toBe(8);
  });

  it.each([["auto"], ["2m"], ["500ms"], [""], [{ unit: "s", value: 8 }]])(
    "never sends a length the metering API cannot read for input duration %p",
    async (requestedDuration) => {
      const mockFetch = createMockFetch();
      global.fetch = mockFetch;

      await sendFalMetrics({
        endpointId: "fal-ai/some-unlisted-video-model",
        operationType: "VIDEO",
        startTime: Date.now() - 5000,
        duration: 5000,
        input: { prompt: "a running horse", duration: requestedDuration },
        result: { video: { url: "https://example.com/video.mp4" }, duration: requestedDuration },
        isStreamed: false,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("durationSeconds");
      expect(body.attributes).not.toHaveProperty("video_duration_seconds");
    },
  );

  it("replaces an unreadable length with the model default", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/veo3",
      operationType: "VIDEO",
      startTime: Date.now() - 5000,
      duration: 5000,
      input: { prompt: "a running horse", duration: "auto" },
      result: { video: { url: "https://example.com/video.mp4" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(8);
    expect(typeof body.durationSeconds).toBe("number");
  });
});

describe("sendFalMetrics AUDIO tracking", () => {
  it("sends AUDIO payload for text-to-speech", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/chatterbox/text-to-speech",
      operationType: "AUDIO",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: { text: "Hello world from fal.ai" },
      result: { audio_url: "https://example.com/audio.mp3" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("AUDIO");
    expect(body.provider).toBe("fal_ai");
    expect(body.inputTokenCount).toBeNull();
    expect(body.characterCount).toBe(23);
    expect(body.operationSubtype).toBe("tts");
    expect(body.attributes.operationSubtype).toBeUndefined();
  });

  it("sends AUDIO payload for TTS via prompt field (kokoro)", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/kokoro/american-english",
      operationType: "AUDIO",
      startTime: Date.now() - 1500,
      duration: 1500,
      input: { prompt: "Hello from Revenium!", voice: "af_heart" },
      result: { audio: { url: "https://example.com/audio.wav" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("AUDIO");
    expect(body.characterCount).toBe(20);
    expect(body.operationSubtype).toBe("tts");
    expect(body.billingUnit).toBe("PER_CHARACTER");
  });

  it("sends AUDIO payload for audio generation (music/sfx)", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/stable-audio",
      operationType: "AUDIO",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "epic orchestral soundtrack", duration: 30 },
      result: { audio_url: "https://example.com/music.mp3" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("AUDIO");
    expect(body.durationSeconds).toBe(30);
    expect(body.operationSubtype).toBe("synthesis");
    expect(body.billingUnit).toBe("PER_SECOND");
    expect(body.characterCount).toBeUndefined();
  });

  it.each([
    ["fal-ai/elevenlabs/sound-effects", { duration_seconds: 12 }, 12],
    ["fal-ai/stable-audio", { seconds_total: 30 }, 30],
    ["fal-ai/stable-audio-25", { total_seconds: 47.5 }, 47.5],
  ])("reads the synthesis length from %s input", async (endpointId, durationInput, expected) => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId,
      operationType: "AUDIO",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "epic orchestral soundtrack", ...durationInput },
      result: { audio_url: "https://example.com/music.mp3" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("synthesis");
    expect(body.billingUnit).toBe("PER_SECOND");
    expect(body.durationSeconds).toBe(expected);
    expect(body.attributes.duration_seconds).toBe(expected);
  });

  it("prefers the rendered synthesis length over the requested one", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/stable-audio",
      operationType: "AUDIO",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "epic orchestral soundtrack", seconds_total: 30 },
      result: { audio_url: "https://example.com/music.mp3", duration: 18.5 },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("synthesis");
    expect(body.durationSeconds).toBe(18.5);
    expect(body.attributes.duration_seconds).toBe(18.5);
  });

  it("omits the duration when a synthesis endpoint states none", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/minimax/voice-clone",
      operationType: "AUDIO",
      startTime: Date.now() - 2000,
      duration: 2000,
      input: { prompt: "epic orchestral soundtrack" },
      result: { audio_url: "https://example.com/music.mp3" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("synthesis");
    expect(body.billingUnit).toBe("PER_SECOND");
    expect(body).not.toHaveProperty("durationSeconds");
    expect(body.attributes).not.toHaveProperty("duration_seconds");
  });

  it("sends AUDIO payload for transcription", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/whisper",
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3" },
      result: { text: "Transcribed text", duration: 45.5 },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("AUDIO");
    expect(body.durationSeconds).toBe(45.5);
    expect(body.operationSubtype).toBe("transcription");
    expect(body.billingUnit).toBe("PER_SECOND");
  });

  it("parses a string transcription result duration", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/whisper",
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3" },
      result: { text: "Transcribed text", duration: "45.5s" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(45.5);
    expect(typeof body.durationSeconds).toBe("number");
  });

  it("ignores the requested duration when a transcription result has none", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/whisper",
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3", duration: 120 },
      result: { text: "Transcribed text" },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("transcription");
    expect(body.billingUnit).toBe("PER_SECOND");
    expect(body).not.toHaveProperty("durationSeconds");
    expect(body.attributes).not.toHaveProperty("duration_seconds");
  });

  it("measures a transcription from the last chunk timestamp", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/whisper",
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3" },
      result: {
        text: "Transcribed text",
        chunks: [
          { timestamp: [0.03, 1.95], text: "Transcribed" },
          { timestamp: [1.95, 2.41], text: "text" },
        ],
      },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(2.41);
    expect(body.attributes.duration_seconds).toBe(2.41);
    expect(body.billingUnit).toBe("PER_SECOND");
  });

  it("ignores chunks whose end timestamp is missing", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/whisper",
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3" },
      result: {
        text: "Transcribed text",
        chunks: [{ timestamp: [0.03, 1.95] }, { timestamp: [1.95, null] }, {}],
      },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.durationSeconds).toBe(1.95);
  });

  it("omits the duration when a transcription has no usable chunks", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/whisper",
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3" },
      result: { text: "Transcribed text", chunks: [] },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("durationSeconds");
    expect(body.attributes).not.toHaveProperty("duration_seconds");
  });

  it("measures a transcription forced by a caller subtype override", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/kokoro/american-english",
      operationType: "AUDIO",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: { prompt: "Hello", duration: 120 },
      result: { text: "Hello", chunks: [{ timestamp: [0, 1.2] }] },
      isStreamed: false,
      usageMetadata: { operationSubtype: "transcription" },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("transcription");
    expect(body.durationSeconds).toBe(1.2);
  });

  it("bills a speech endpoint by input characters", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/minimax/speech-02-hd",
      operationType: "AUDIO",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: { text: "Hello world from fal.ai" },
      result: { audio: { url: "https://example.com/audio.mp3" } },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("tts");
    expect(body.billingUnit).toBe("PER_CHARACTER");
    expect(body.characterCount).toBe(23);
  });

  it.each([
    ["fal-ai/elevenlabs/speech-to-text", "transcription"],
    ["fal-ai/minimax/voice-clone", "synthesis"],
    ["fal-ai/dia/v1/voice-clone", "synthesis"],
    ["fal-ai/ace-step/audio-to-audio", "synthesis"],
  ])("classifies %s as %s", async (endpointId, expectedSubtype) => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId,
      operationType: "AUDIO",
      startTime: Date.now() - 3000,
      duration: 3000,
      input: { audio_url: "https://example.com/input.mp3" },
      result: { text: "some text", duration: 300 },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe(expectedSubtype);
    expect(body.durationSeconds).toBe(300);
    expect(body.characterCount).toBeUndefined();
  });

  it("keeps the detected subtype when the caller override is blank", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/kokoro/american-english",
      operationType: "AUDIO",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: { prompt: "Hello" },
      result: { audio: { url: "https://example.com/audio.wav" } },
      isStreamed: false,
      usageMetadata: { operationSubtype: "" },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("tts");
  });

  it("maps a legacy audio_generation override to synthesis", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/kokoro/american-english",
      operationType: "AUDIO",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: { prompt: "Hello", duration: 3 },
      result: { audio: { url: "https://example.com/audio.wav" } },
      isStreamed: false,
      usageMetadata: { operationSubtype: "audio_generation" },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationSubtype).toBe("synthesis");
    expect(body.billingUnit).toBe("PER_SECOND");
    expect(body.durationSeconds).toBe(3);
  });
});

describe("sendFalMetrics CHAT tracking", () => {
  it("sends CHAT payload with token counts", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "openrouter/router",
      operationType: "CHAT",
      startTime: Date.now() - 800,
      duration: 800,
      input: { prompt: "What is AI?", model: "google/gemini-2.5-flash" },
      result: {
        output: "AI is...",
        usage: { prompt_tokens: 40, completion_tokens: 227, total_tokens: 267 },
      },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("CHAT");
    expect(body.provider).toBe("fal_ai");
    expect(body.inputTokenCount).toBe(40);
    expect(body.outputTokenCount).toBe(227);
    expect(body.totalTokenCount).toBe(267);
    expect(body.operationSubtype).toBeUndefined();
  });
});

describe("sendFalMetrics common fields", () => {
  it("always includes required payload fields", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/flux/dev",
      operationType: "IMAGE",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: {},
      result: { images: [] },
      isStreamed: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.transactionId).toMatch(/^fal-/);
    expect(body.costType).toBe("AI");
    expect(body.stopReason).toBe("END");
    expect(body.isStreamed).toBe(false);
    expect(body.requestTime).toBeDefined();
    expect(body.responseTime).toBeDefined();
    expect(body.requestDuration).toBe(1000);
  });

  it("sets isStreamed true for streamed calls", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await sendFalMetrics({
      endpointId: "fal-ai/flux/dev",
      operationType: "IMAGE",
      startTime: Date.now() - 1000,
      duration: 1000,
      input: {},
      result: { images: [] },
      isStreamed: true,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.isStreamed).toBe(true);
  });
});

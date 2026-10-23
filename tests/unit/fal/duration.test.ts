import {
  parseDurationSeconds,
  readStatedDurationSeconds,
  resolveTranscriptDurationSeconds,
  resolveVideoDurationSeconds,
} from "../../../src/fal/duration";

describe("parseDurationSeconds", () => {
  it.each([
    [8, 8],
    ["8", 8],
    ["8s", 8],
    ["8S", 8],
    ["5.5s", 5.5],
    [" 8s ", 8],
  ])("reads %p as %p seconds", (value, expected) => {
    expect(parseDurationSeconds(value)).toBe(expected);
  });

  it.each([
    ["auto"],
    [""],
    ["0s"],
    ["2m"],
    ["500ms"],
    [0],
    [-3],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [{}],
  ])("rejects %p", (value) => {
    expect(parseDurationSeconds(value)).toBeUndefined();
  });
});

describe("readStatedDurationSeconds", () => {
  it.each([
    [{ duration: "8s" }, 8],
    [{ duration_seconds: 12 }, 12],
    [{ seconds_total: 30 }, 30],
    [{ total_seconds: 47.5 }, 47.5],
  ])("reads %p as %p seconds", (source, expected) => {
    expect(readStatedDurationSeconds(source)).toBe(expected);
  });

  it.each([[undefined], [null], ["8s"], [{ duration: "auto" }], [{}]])(
    "returns undefined for %p",
    (source) => {
      expect(readStatedDurationSeconds(source)).toBeUndefined();
    },
  );
});

describe("resolveVideoDurationSeconds", () => {
  it("prefers the requested length over the result duration", () => {
    expect(
      resolveVideoDurationSeconds("fal-ai/veo3", { duration: "8s" }, { duration: 143.7 }),
    ).toBe(8);
  });

  it.each([
    ["fal-ai/veo3", 8],
    ["fal-ai/veo3/fast", 8],
    ["fal-ai/kling-video/v2/master/text-to-video", 5],
    ["fal-ai/kling-video/v1.6/pro/image-to-video", 5],
  ])("defaults %s to %p seconds", (endpointId, expected) => {
    expect(resolveVideoDurationSeconds(endpointId, {}, {})).toBe(expected);
  });

  it.each([
    ["fal-ai/veo3.1"],
    ["fal-ai/veo3x"],
    ["fal-ai/veo3/fast/extend"],
    ["acme/veo3"],
    ["fal-ai/kling-video/lipsync/audio-to-video"],
    ["fal-ai/kling-video/v1/pro/ai-avatar"],
    ["fal-ai/kling-video/v1/pro/extend"],
    ["fal-ai/kling-video/v2/master/text-to-video/extend"],
    ["fal-ai/kling-video/v2.5-turbo/pro/text-to-video"],
    ["fal-ai/kling-video/v3/pro/text-to-video"],
    ["fal-ai/some-unlisted-video-model"],
  ])("omits a default for %s", (endpointId) => {
    expect(resolveVideoDurationSeconds(endpointId, {}, {})).toBeUndefined();
  });
});

describe("resolveTranscriptDurationSeconds", () => {
  it("prefers the stated result duration", () => {
    expect(
      resolveTranscriptDurationSeconds({ duration: 45.5, chunks: [{ timestamp: [0, 2] }] }),
    ).toBe(45.5);
  });

  it("measures the last usable chunk timestamp", () => {
    expect(
      resolveTranscriptDurationSeconds({
        chunks: [
          { timestamp: [0, 1.95] },
          { timestamp: [1.95, 2.41] },
          { timestamp: [2.41, null] },
        ],
      }),
    ).toBe(2.41);
  });

  it("falls back to the start timestamp of an open-ended final chunk", () => {
    expect(
      resolveTranscriptDurationSeconds({
        chunks: [{ timestamp: [0, 1.95] }, { timestamp: [4.2, null] }],
      }),
    ).toBe(4.2);
  });

  it("measures long chunk lists without exhausting the call stack", () => {
    const chunks = Array.from({ length: 200_000 }, (_, index) => ({
      timestamp: [index, index + 1] as [number, number],
    }));

    expect(resolveTranscriptDurationSeconds({ chunks })).toBe(200_000);
  });

  it.each([[undefined], [{}], [{ chunks: [] }]])("omits the duration for %p", (result) => {
    expect(resolveTranscriptDurationSeconds(result)).toBeUndefined();
  });
});

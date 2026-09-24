import { buildImagePayload } from "../../../src/_core/metering/payload-builder";
import { mapAspectRatioToResolution, mapGoogleUsageMetadata } from "../../../src/google/utils";

describe("Vertex image metering payload", () => {
  const baseArgs = {
    startTime: Date.now(),
    duration: 1500,
    provider: "Google",
    modelSource: "GOOGLE_VERTEX_AI",
    middlewareSource: "revenium-google-node",
  };

  describe("generateImage", () => {
    it("maps aspectRatio 3:4 to resolution 768x1024 with quality standard", () => {
      const payload = buildImagePayload(
        "generation",
        { data: [{ bytesBase64Encoded: "abc" }] },
        {
          n: 1,
          model: "imagen-3.0-generate-002",
          size: mapAspectRatioToResolution("3:4"),
          quality: "standard",
        },
        baseArgs.startTime,
        baseArgs.duration,
        baseArgs.provider,
        baseArgs.modelSource,
        baseArgs.middlewareSource,
      );

      expect(payload.attributes!.resolution).toBe("768x1024");
      expect(payload.attributes!.quality).toBe("standard");
      expect(payload.model).toBe("imagen-3.0-generate-002");
      expect(payload.operationType).toBe("IMAGE");
    });

    it("defaults to 1024x1024 when aspectRatio is undefined", () => {
      const payload = buildImagePayload(
        "generation",
        { data: [] },
        {
          n: 1,
          model: "imagen-3.0-generate-002",
          size: mapAspectRatioToResolution(undefined),
          quality: "standard",
        },
        baseArgs.startTime,
        baseArgs.duration,
        baseArgs.provider,
        baseArgs.modelSource,
        baseArgs.middlewareSource,
      );

      expect(payload.attributes!.resolution).toBe("1024x1024");
      expect(payload.attributes!.quality).toBe("standard");
    });

    it.each([
      ["1:1", "1024x1024"],
      ["4:3", "1024x768"],
      ["9:16", "576x1024"],
      ["16:9", "1024x576"],
    ])("maps aspectRatio %s to resolution %s in payload", (aspectRatio, expectedResolution) => {
      const payload = buildImagePayload(
        "generation",
        { data: [{}] },
        {
          n: 1,
          model: "imagen-3.0-generate-002",
          size: mapAspectRatioToResolution(aspectRatio),
          quality: "standard",
        },
        baseArgs.startTime,
        baseArgs.duration,
        baseArgs.provider,
        baseArgs.modelSource,
        baseArgs.middlewareSource,
      );

      expect(payload.attributes!.resolution).toBe(expectedResolution);
    });
  });

  describe("editImage", () => {
    it("sends resolution 1024x1024", () => {
      const payload = buildImagePayload(
        "edit",
        { data: [{ bytesBase64Encoded: "abc" }] },
        { n: 1, model: "imagen-3.0-capability-001", size: "1024x1024", quality: "standard" },
        baseArgs.startTime,
        baseArgs.duration,
        baseArgs.provider,
        baseArgs.modelSource,
        baseArgs.middlewareSource,
      );

      expect(payload.attributes!.resolution).toBe("1024x1024");
      expect(payload.model).toBe("imagen-3.0-capability-001");
    });
  });

  describe("upscaleImage", () => {
    it("sends default resolution 1024x1024 and the upscale subtype", () => {
      const payload = buildImagePayload(
        "upscale",
        { data: [{ bytesBase64Encoded: "abc" }] },
        { n: 1, model: "imagen-3.0-generate-002", quality: "standard" },
        baseArgs.startTime,
        baseArgs.duration,
        baseArgs.provider,
        baseArgs.modelSource,
        baseArgs.middlewareSource,
      );

      expect(payload.attributes!.resolution).toBe("1024x1024");
      expect(payload.model).toBe("imagen-3.0-generate-002");
      expect(payload.operationSubtype).toBe("upscale");
    });

    it("lets Google usage metadata override the detected subtype", () => {
      const payload = buildImagePayload(
        "upscale",
        { data: [{ bytesBase64Encoded: "abc" }] },
        { n: 1, model: "imagen-3.0-generate-002", quality: "standard" },
        baseArgs.startTime,
        baseArgs.duration,
        baseArgs.provider,
        baseArgs.modelSource,
        baseArgs.middlewareSource,
        mapGoogleUsageMetadata({ operationSubtype: "inpainting" }),
      );

      expect(payload.operationSubtype).toBe("inpainting");
    });
  });
});

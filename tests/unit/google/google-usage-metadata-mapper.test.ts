import { mapGoogleUsageMetadata } from "../../../src/google/utils";

describe("mapGoogleUsageMetadata", () => {
  it("maps job fields from GoogleUsageMetadata to UsageMetadata", () => {
    const result = mapGoogleUsageMetadata({
      agenticJobId: "job-123",
      agenticJobName: "lead-qualification",
      agenticJobType: "sales-agent",
      agenticJobVersion: "2.0.0",
    });

    expect(result?.agenticJobId).toBe("job-123");
    expect(result?.agenticJobName).toBe("lead-qualification");
    expect(result?.agenticJobType).toBe("sales-agent");
    expect(result?.agenticJobVersion).toBe("2.0.0");
  });

  it("omits undefined job fields", () => {
    const result = mapGoogleUsageMetadata({
      agenticJobId: "job-456",
    });

    expect(result?.agenticJobId).toBe("job-456");
    expect(result?.agenticJobName).toBeUndefined();
    expect(result?.agenticJobType).toBeUndefined();
    expect(result?.agenticJobVersion).toBeUndefined();
  });

  it("maps operationSubtype so callers can override the detected value", () => {
    expect(mapGoogleUsageMetadata({ operationSubtype: "inpainting" })?.operationSubtype).toBe(
      "inpainting",
    );
    expect(mapGoogleUsageMetadata({ traceId: "t" })?.operationSubtype).toBeUndefined();
  });

  it("returns undefined when no metadata provided", () => {
    expect(mapGoogleUsageMetadata(undefined)).toBeUndefined();
  });
});

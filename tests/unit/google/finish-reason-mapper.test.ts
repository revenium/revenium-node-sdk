import { mapGoogleFinishReason } from "../../../src/google/utils";

describe("mapGoogleFinishReason", () => {
  it.each([
    ["STOP", "END"],
    ["MAX_TOKENS", "TOKEN_LIMIT"],
    ["TOO_MANY_TOOL_CALLS", "COMPLETION_LIMIT"],
    ["SAFETY", "ERROR"],
    ["LANGUAGE", "ERROR"],
    ["MALFORMED_FUNCTION_CALL", "ERROR"],
    ["CANCELLED", "CANCELLED"],
    ["FINISH_REASON_UNSPECIFIED", "END"],
  ])("maps '%s' to '%s'", (input, expected) => {
    expect(mapGoogleFinishReason(input)).toBe(expected);
  });

  it("returns the default for an unknown finish reason", () => {
    expect(mapGoogleFinishReason("SOMETHING_NEW", "END")).toBe("END");
  });

  it("returns the default for an empty finish reason", () => {
    expect(mapGoogleFinishReason("")).toBe("END");
    expect(mapGoogleFinishReason(undefined)).toBe("END");
  });
});

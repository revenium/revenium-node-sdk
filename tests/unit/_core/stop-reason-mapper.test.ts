import {
  mapStopReason,
  getSupportedStopReasons,
  isStopReasonSupported,
} from "../../../src/_core/stop-reason-mapper";

const BACKEND_STOP_REASONS = [
  "END",
  "END_SEQUENCE",
  "TIMEOUT",
  "TOKEN_LIMIT",
  "COST_LIMIT",
  "COMPLETION_LIMIT",
  "CONTENT_FILTER",
  "TOOL_CALL",
  "ERROR",
  "CANCELLED",
];

describe("mapStopReason", () => {
  it.each([
    ["stop", "END"],
    ["end_turn", "END"],
    ["function_call", "END_SEQUENCE"],
    ["tool_calls", "END_SEQUENCE"],
    ["stop_sequence", "END_SEQUENCE"],
    ["tool_use", "END_SEQUENCE"],
    ["timeout", "TIMEOUT"],
    ["length", "TOKEN_LIMIT"],
    ["max_tokens", "TOKEN_LIMIT"],
    ["cost_limit", "COST_LIMIT"],
    ["completion_limit", "COMPLETION_LIMIT"],
    ["content_filter", "CONTENT_FILTER"],
    ["error", "ERROR"],
    ["cancelled", "CANCELLED"],
    ["canceled", "CANCELLED"],
    ["pause_turn", "END"],
    ["refusal", "ERROR"],
    ["model_context_window_exceeded", "TOKEN_LIMIT"],
  ])("maps '%s' to '%s'", (input, expected) => {
    expect(mapStopReason(input)).toBe(expected);
  });

  it("only emits values the backend StopReason enum accepts", () => {
    const emitted = getSupportedStopReasons().map((reason) => mapStopReason(reason));

    expect(BACKEND_STOP_REASONS).toEqual(expect.arrayContaining(emitted));
    expect(emitted).toContain("CONTENT_FILTER");
  });

  it("handles case-insensitive input", () => {
    expect(mapStopReason("STOP")).toBe("END");
    expect(mapStopReason("Tool_Calls")).toBe("END_SEQUENCE");
    expect(mapStopReason("MAX_TOKENS")).toBe("TOKEN_LIMIT");
  });

  it("returns END for null/undefined", () => {
    expect(mapStopReason(null)).toBe("END");
    expect(mapStopReason(undefined)).toBe("END");
  });

  it("returns END for unknown reasons and warns", () => {
    const warn = jest.fn();
    expect(mapStopReason("totally_unknown", { warn })).toBe("END");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unknown stop reason"));
  });
});

describe("getSupportedStopReasons", () => {
  it("returns all known stop reason keys", () => {
    const supported = getSupportedStopReasons();
    expect(supported).toContain("stop");
    expect(supported).toContain("tool_calls");
    expect(supported).toContain("max_tokens");
    expect(supported).toContain("model_context_window_exceeded");
    expect(supported).toContain("pause_turn");
    expect(supported).toContain("refusal");
    expect(supported.length).toBeGreaterThan(10);
  });
});

describe("isStopReasonSupported", () => {
  it("returns true for supported reasons", () => {
    expect(isStopReasonSupported("stop")).toBe(true);
    expect(isStopReasonSupported("STOP")).toBe(true);
  });

  it("returns false for unsupported reasons", () => {
    expect(isStopReasonSupported("xyz")).toBe(false);
  });
});

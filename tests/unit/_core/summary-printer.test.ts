import { createPayload, createReveniumConfig } from "../../helpers/fixtures";

let printUsageSummary: typeof import("../../../src/_core/prompt/summary-printer").printUsageSummary;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let logSpy: jest.SpiedFunction<typeof console.log>;

function printedLines(): string[] {
  return logSpy.mock.calls.map((call) => String(call[0]));
}

function lineStartingWith(prefix: string): string {
  return printedLines().find((line) => line.trimStart().startsWith(prefix)) ?? "";
}

beforeEach(async () => {
  jest.resetModules();
  const manager = await import("../../../src/_core/config/manager");
  const printer = await import("../../../src/_core/prompt/summary-printer");
  printUsageSummary = printer.printUsageSummary;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  resetConfig();
  jest.restoreAllMocks();
});

describe("printUsageSummary human format", () => {
  it("prints unknown for a token count the provider never reported", () => {
    setConfig(createReveniumConfig({ printSummary: "human" }));

    printUsageSummary(
      createPayload({
        operationType: "EMBED",
        inputTokenCount: null,
        outputTokenCount: 0,
        totalTokenCount: null,
      }),
    );

    expect(lineStartingWith("Input Tokens:")).toContain("unknown");
    expect(lineStartingWith("Total Tokens:")).toContain("unknown");
    expect(lineStartingWith("Output Tokens:")).toContain("0");
  });

  it("prints the reported token counts when they are known", () => {
    setConfig(createReveniumConfig({ printSummary: "human" }));

    printUsageSummary(createPayload({ inputTokenCount: 1000, totalTokenCount: 1050 }));

    expect(lineStartingWith("Input Tokens:")).toContain("1,000");
    expect(lineStartingWith("Total Tokens:")).toContain("1,050");
    expect(printedLines().join("\n")).not.toContain("unknown");
  });
});

import { createReveniumConfig, createMockFetch } from "../../helpers/fixtures";

let meterTool: typeof import("../../../src/_core/tool-metering/tool-tracker").meterTool;
let reportToolCall: typeof import("../../../src/_core/tool-metering/tool-tracker").reportToolCall;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;
let runWithJobContext: typeof import("../../../src/_core/jobs/job-context").runWithJobContext;

beforeEach(async () => {
  jest.resetModules();
  const manager = await import("../../../src/_core/config/manager");
  const tracker = await import("../../../src/_core/tool-metering/tool-tracker");
  const jobContext = await import("../../../src/_core/jobs/job-context");
  meterTool = tracker.meterTool;
  reportToolCall = tracker.reportToolCall;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
  runWithJobContext = jobContext.runWithJobContext;

  setConfig(createReveniumConfig());
  global.fetch = createMockFetch();
});

afterEach(() => {
  resetConfig();
  delete process.env.REVENIUM_AGENTIC_JOB_ID;
  jest.restoreAllMocks();
});

async function readDispatchedBody(mockFetch: jest.Mock): Promise<Record<string, unknown>> {
  await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

describe("meterTool", () => {
  it("returns result of sync function", async () => {
    const result = await meterTool("my-tool", () => 42);
    expect(result).toBe(42);
  });

  it("returns result of async function", async () => {
    const result = await meterTool("my-tool", async () => "async-result");
    expect(result).toBe("async-result");
  });

  it("propagates errors from sync function", () => {
    expect(() =>
      meterTool("my-tool", () => {
        throw new Error("sync-fail");
      }),
    ).toThrow("sync-fail");
  });

  it("propagates errors from async function", async () => {
    await expect(
      meterTool("my-tool", async () => {
        throw new Error("async-fail");
      }),
    ).rejects.toThrow("async-fail");
  });

  it("dispatches event after success (fire-and-forget)", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done");
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.toolId).toBe("tool-x");
    expect(body.success).toBe(true);
  });

  it("dispatches event after failure (fire-and-forget)", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    try {
      meterTool("tool-x", () => {
        throw new Error("oops");
      });
    } catch {}
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.success).toBe(false);
    expect(body.errorMessage).toBe("oops");
  });

  it("captures error message on failure", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", async () => {
      throw new Error("specific error");
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.errorMessage).toBe("specific error");
  });

  it("tags the event with the active job context", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await runWithJobContext({ agenticJobId: "job-ctx-1" }, () => meterTool("tool-x", () => "done"));

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-ctx-1");
  });

  it("tags the event from the environment when no job context is active", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;
    process.env.REVENIUM_AGENTIC_JOB_ID = "job-from-env";

    await meterTool("tool-x", () => "done");

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-from-env");
  });

  it("prefers the per-call job id over the active job context", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await runWithJobContext({ agenticJobId: "job-ctx-1" }, () =>
      meterTool("tool-x", () => "done", {
        usageMetadata: { agenticJobId: "job-from-metadata" },
      }),
    );

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-from-metadata");
  });

  it("prefers the per-call job id field over usageMetadata", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", {
      agenticJobId: "job-from-field",
      usageMetadata: { agenticJobId: "job-from-metadata" },
    });

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-from-field");
  });

  it("falls back to usageMetadata when the per-call job id field is empty", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", {
      agenticJobId: "",
      usageMetadata: { agenticJobId: "job-from-metadata" },
    });

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-from-metadata");
  });

  it("sends a non-string per-call job id as a string", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", { usageMetadata: { agenticJobId: 12345 } });

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("12345");
  });

  it("drops a job id the metering API would reject without failing the call", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const result = await meterTool("tool-x", () => "done", { agenticJobId: "types" });

    expect(result).toBe("done");
    expect(await readDispatchedBody(mockFetch)).not.toHaveProperty("agenticJobId");
  });

  it("falls back to the job context when the per-call job id is rejected", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await runWithJobContext({ agenticJobId: "job-ctx-1" }, () =>
      meterTool("tool-x", () => "done", { agenticJobId: "types" }),
    );

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-ctx-1");
  });

  it("keeps the job context when the per-call job id is null", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await runWithJobContext({ agenticJobId: "job-ctx-1" }, () =>
      meterTool("tool-x", () => "done", { usageMetadata: { agenticJobId: null } }),
    );

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-ctx-1");
  });

  it("sends the tool call cost", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", { costUsd: 0.005 });

    expect((await readDispatchedBody(mockFetch)).costUsd).toBe(0.005);
  });

  it("sends a zero cost, which charges the call nothing", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", { costUsd: 0 });

    expect((await readDispatchedBody(mockFetch)).costUsd).toBe(0);
  });

  it("drops a non-finite cost", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", { costUsd: Number.NaN });

    expect(await readDispatchedBody(mockFetch)).not.toHaveProperty("costUsd");
  });

  it("drops a negative cost", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await meterTool("tool-x", () => "done", { costUsd: -1 });

    expect(await readDispatchedBody(mockFetch)).not.toHaveProperty("costUsd");
  });

  it("carries the job id and the cost when the tool call fails", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await expect(
      runWithJobContext({ agenticJobId: "job-ctx-1" }, () =>
        meterTool(
          "tool-x",
          async () => {
            throw new Error("tool exploded");
          },
          { costUsd: 0.005 },
        ),
      ),
    ).rejects.toThrow("tool exploded");

    const body = await readDispatchedBody(mockFetch);
    expect(body.agenticJobId).toBe("job-ctx-1");
    expect(body.costUsd).toBe(0.005);
    expect(body.success).toBe(false);
  });
});

describe("reportToolCall", () => {
  it("dispatches tool event", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    reportToolCall("manual-tool", {
      success: true,
      durationMs: 250,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.toolId).toBe("manual-tool");
    expect(body.durationMs).toBe(250);
    expect(body.success).toBe(true);
  });

  it("carries the job id and the cost", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await runWithJobContext({ agenticJobId: "job-ctx-1" }, () =>
      reportToolCall("manual-tool", { success: true, durationMs: 250, costUsd: 0.005 }),
    );

    const body = await readDispatchedBody(mockFetch);
    expect(body.agenticJobId).toBe("job-ctx-1");
    expect(body.costUsd).toBe(0.005);
  });

  it("prefers the per-call job id over the active job context", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await runWithJobContext({ agenticJobId: "job-ctx-1" }, () =>
      reportToolCall("manual-tool", {
        success: true,
        durationMs: 250,
        agenticJobId: "job-from-report",
      }),
    );

    expect((await readDispatchedBody(mockFetch)).agenticJobId).toBe("job-from-report");
  });
});

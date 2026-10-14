import { createReveniumConfig, createMockFetch } from "../../helpers/fixtures";
import { ENV_VARS } from "../../../src/_core/constants";
import type {
  JobOutcome,
  JobOutcomeAmendment,
  JobOutcomeRevisionEntry,
  JobResource,
  JobROIResource,
  JobTimelineResource,
  ConversionFunnelResource,
  PagedResponse,
} from "../../../src/_core/types/jobs";

let reportJobOutcome: typeof import("../../../src/_core/jobs/job-api-client").reportJobOutcome;
let listJobs: typeof import("../../../src/_core/jobs/job-api-client").listJobs;
let getJob: typeof import("../../../src/_core/jobs/job-api-client").getJob;
let getJobTypes: typeof import("../../../src/_core/jobs/job-api-client").getJobTypes;
let getJobROI: typeof import("../../../src/_core/jobs/job-api-client").getJobROI;
let getJobTransactions: typeof import("../../../src/_core/jobs/job-api-client").getJobTransactions;
let getConversionFunnel: typeof import("../../../src/_core/jobs/job-api-client").getConversionFunnel;
let amendJobOutcome: typeof import("../../../src/_core/jobs/job-api-client").amendJobOutcome;
let getJobOutcomeHistory: typeof import("../../../src/_core/jobs/job-api-client").getJobOutcomeHistory;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const mockJobResource: JobResource = {
  id: "res-1",
  label: "Job job-123",
  resourceType: "JOB",
  agenticJobId: "job-123",
  source: "SDK",
  hasOutcome: true,
  executionStatus: "SUCCESS",
  outcomeType: "CONVERTED",
  outcomeValue: 99.5,
  outcomeCurrency: "USD",
};

const validOutcome: JobOutcome = {
  executionStatus: "SUCCESS",
  outcomeType: "CONVERTED",
  outcomeValue: 99.5,
  outcomeCurrency: "USD",
};

const mockROI: JobROIResource = {
  agenticJobId: "job-123",
  agenticJobName: "test-job",
  agenticJobType: "SUPPORT",
  totalCost: 0.5,
  outcomeValue: 99.5,
  outcomeCurrency: "USD",
  roi: 198,
  executionStatus: "SUCCESS",
  outcomeType: "CONVERTED",
  hasOutcome: true,
  transactionCount: 3,
  inputTokens: 1000,
  outputTokens: 500,
  totalTokens: 1500,
};

const mockTimeline: JobTimelineResource = {
  transactions: [
    {
      transactionId: "txn-1",
      timestamp: "2026-03-17T10:00:00Z",
      model: "gpt-4",
      provider: "OpenAI",
      duration: 1200,
      cost: 0.15,
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      status: "SUCCESS",
    },
  ],
  totalCount: 1,
};

const mockFunnel: ConversionFunnelResource = {
  totalJobs: 100,
  successfulJobs: 80,
  convertedJobs: 60,
  successRate: 0.8,
  conversionRate: 0.6,
};

const mockPagedJobs: PagedResponse<JobResource> = {
  content: [mockJobResource],
  page: { size: 20, totalElements: 1, totalPages: 1, number: 0 },
};

const originalFetch = global.fetch;
const originalTeamId = process.env[ENV_VARS.TEAM_ID];

beforeEach(async () => {
  jest.resetModules();
  delete process.env[ENV_VARS.TEAM_ID];
  const manager = await import("../../../src/_core/config/manager");
  const client = await import("../../../src/_core/jobs/job-api-client");
  reportJobOutcome = client.reportJobOutcome;
  listJobs = client.listJobs;
  getJob = client.getJob;
  getJobTypes = client.getJobTypes;
  getJobROI = client.getJobROI;
  getJobTransactions = client.getJobTransactions;
  getConversionFunnel = client.getConversionFunnel;
  amendJobOutcome = client.amendJobOutcome;
  getJobOutcomeHistory = client.getJobOutcomeHistory;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;
});

afterEach(() => {
  if (originalTeamId === undefined) {
    delete process.env[ENV_VARS.TEAM_ID];
  } else {
    process.env[ENV_VARS.TEAM_ID] = originalTeamId;
  }
  global.fetch = originalFetch;
  resetConfig();
  jest.restoreAllMocks();
});

describe("reportJobOutcome", () => {
  it("sends POST and returns JobResource on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockJobResource),
    });
    global.fetch = mockFetch;

    const result = await reportJobOutcome("job-123", validOutcome);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/job-123/outcome");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("POST");
    expect(options.headers["x-api-key"]).toBe("hak_tenant_abc123xyz");
    expect(JSON.parse(options.body)).toEqual(validOutcome);
    expect(result).toEqual(mockJobResource);
  });

  it("strips /meter/v2 from base URL", async () => {
    setConfig(
      createReveniumConfig({
        reveniumTeamId: "team-1",
        reveniumBaseUrl: "https://api.revenium.ai/meter/v2",
      }),
    );
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockJobResource),
    });
    global.fetch = mockFetch;

    await reportJobOutcome("job-123", validOutcome);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("https://api.revenium.ai/profitstream/");
    expect(url).not.toContain("/meter/v2/profitstream");
  });

  it("does not repeat the service prefix when the base already ends in /profitstream", async () => {
    setConfig(
      createReveniumConfig({
        reveniumTeamId: "team-1",
        reveniumBaseUrl: "https://api.revenium.ai/profitstream",
      }),
    );
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockJobResource),
    });
    global.fetch = mockFetch;

    await reportJobOutcome("job-123", validOutcome);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("https://api.revenium.ai/profitstream/v2/api/jobs/job-123/outcome");
    expect(url).not.toContain("/profitstream/profitstream");
  });

  it("uses teamId parameter over config teamId", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "config-team" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockJobResource),
    });
    global.fetch = mockFetch;

    await reportJobOutcome("job-123", validOutcome, "param-team");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("teamId=param-team");
  });

  it("throws when teamId is missing from both param and config", async () => {
    setConfig(createReveniumConfig());

    await expect(reportJobOutcome("job-123", validOutcome)).rejects.toThrow("teamId is required");
  });

  it("throws when API key is not configured", async () => {
    await expect(reportJobOutcome("job-123", validOutcome, "team-1")).rejects.toThrow(
      "Revenium API key is not configured",
    );
  });

  it("warns and returns gracefully on 409 Conflict", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    global.fetch = createMockFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: () => Promise.resolve(mockJobResource),
    });

    const result = await reportJobOutcome("job-123", validOutcome);

    expect(result).toEqual(mockJobResource);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Job outcome already reported for job job-123"),
    );
    warnSpy.mockRestore();
  });

  it("returns fallback on 409 with invalid JSON body", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    global.fetch = createMockFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    });

    const result = await reportJobOutcome("job-123", validOutcome);

    expect(result.agenticJobId).toBe("job-123");
    expect(result.hasOutcome).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Job outcome already reported for job job-123"),
    );
    warnSpy.mockRestore();
  });

  it("throws with clear message on 404 Not Found", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(reportJobOutcome("job-123", validOutcome)).rejects.toThrow("404");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws on terminal HTTP error without retry", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(reportJobOutcome("job-123", validOutcome)).rejects.toThrow("401");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends Idempotency-Key header", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockJobResource),
    });
    global.fetch = mockFetch;

    await reportJobOutcome("job-123", validOutcome);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Idempotency-Key"]).toBeDefined();
    expect(headers["Idempotency-Key"].length).toBeGreaterThan(0);
  });

  it("retries on 503 with stable Idempotency-Key", async () => {
    jest.useFakeTimers();
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    let callCount = 0;
    global.fetch = jest.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: () => Promise.resolve(""),
          headers: { get: () => null },
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(mockJobResource),
        headers: { get: () => null },
      } as unknown as Response);
    });

    const promise = reportJobOutcome("job-123", validOutcome);

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    }

    await promise;
    expect(callCount).toBe(2);

    const key1 = (global.fetch as jest.Mock).mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = (global.fetch as jest.Mock).mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).toBe(key2);
    jest.useRealTimers();
  });
});

describe("listJobs", () => {
  it("returns paged response on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockPagedJobs),
    });
    global.fetch = mockFetch;

    const result = await listJobs();

    expect(result).toEqual(mockPagedJobs);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("GET");
  });

  it("includes filter params in URL", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockPagedJobs),
    });
    global.fetch = mockFetch;

    await listJobs({ type: "SUPPORT", executionStatus: "SUCCESS", page: 0, size: 10 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("type=SUPPORT");
    expect(url).toContain("executionStatus=SUCCESS");
    expect(url).toContain("page=0");
    expect(url).toContain("size=10");
  });

  it("normalizes Spring HATEOAS _embedded response", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const hateoasResponse = {
      _embedded: { jobResourceList: [mockJobResource] },
      page: { size: 20, totalElements: 1, totalPages: 1, number: 0 },
    };
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(hateoasResponse),
    });
    global.fetch = mockFetch;

    const result = await listJobs();

    expect(result.content).toEqual([mockJobResource]);
    expect(result.page.totalElements).toBe(1);
  });

  it("returns empty content when response has no items", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const emptyResponse = {
      page: { size: 20, totalElements: 0, totalPages: 0, number: 0 },
    };
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(emptyResponse),
    });
    global.fetch = mockFetch;

    const result = await listJobs();

    expect(result.content).toEqual([]);
    expect(result.page.totalElements).toBe(0);
  });

  it("throws when teamId is missing", async () => {
    setConfig(createReveniumConfig());

    await expect(listJobs()).rejects.toThrow("teamId is required");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(listJobs()).rejects.toThrow("not found");
  });
});

describe("getJob", () => {
  it("returns JobResource on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockJobResource),
    });
    global.fetch = mockFetch;

    const result = await getJob("job-123");

    expect(result).toEqual(mockJobResource);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/job-123");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("GET");
  });

  it("throws when teamId is missing", async () => {
    setConfig(createReveniumConfig());

    await expect(getJob("job-123")).rejects.toThrow("teamId is required");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(getJob("job-123")).rejects.toThrow("not found");
  });
});

describe("getJobTypes", () => {
  it("returns string array on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const types = ["SUPPORT", "SALES", "ONBOARDING"];
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(types),
    });
    global.fetch = mockFetch;

    const result = await getJobTypes();

    expect(result).toEqual(types);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/types");
    expect(options.method).toBe("GET");
  });

  it("throws when teamId is missing", async () => {
    setConfig(createReveniumConfig());

    await expect(getJobTypes()).rejects.toThrow("teamId is required");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(getJobTypes()).rejects.toThrow("not found");
  });
});

describe("getJobROI", () => {
  it("returns JobROIResource on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockROI),
    });
    global.fetch = mockFetch;

    const result = await getJobROI("job-123");

    expect(result).toEqual(mockROI);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/job-123/roi");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("GET");
  });

  it("throws when teamId is missing", async () => {
    setConfig(createReveniumConfig());

    await expect(getJobROI("job-123")).rejects.toThrow("teamId is required");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(getJobROI("job-123")).rejects.toThrow("not found");
  });
});

describe("getJobTransactions", () => {
  it("returns JobTimelineResource on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockTimeline),
    });
    global.fetch = mockFetch;

    const result = await getJobTransactions("job-123");

    expect(result).toEqual(mockTimeline);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/job-123/transactions");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("GET");
  });

  it("throws when teamId is missing", async () => {
    setConfig(createReveniumConfig());

    await expect(getJobTransactions("job-123")).rejects.toThrow("teamId is required");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(getJobTransactions("job-123")).rejects.toThrow("not found");
  });
});

describe("getConversionFunnel", () => {
  it("returns ConversionFunnelResource on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockFunnel),
    });
    global.fetch = mockFetch;

    const result = await getConversionFunnel();

    expect(result).toEqual(mockFunnel);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/conversion-funnel");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("GET");
  });

  it("includes filter params in URL", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockFunnel),
    });
    global.fetch = mockFetch;

    await getConversionFunnel({
      startDate: "2026-01-01",
      endDate: "2026-03-17",
      jobType: "SUPPORT",
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("startDate=2026-01-01");
    expect(url).toContain("endDate=2026-03-17");
    expect(url).toContain("jobType=SUPPORT");
  });

  it("throws when teamId is missing", async () => {
    setConfig(createReveniumConfig());

    await expect(getConversionFunnel()).rejects.toThrow("teamId is required");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(getConversionFunnel()).rejects.toThrow("not found");
  });
});

describe("reportJobOutcome structured 409", () => {
  it("throws OutcomeAlreadyReportedError when 409 body has guidance", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const structured409 = {
      status: 409,
      error: "Conflict",
      message: "Outcome already reported",
      details: {
        guidance: "Use PATCH /v2/api/jobs/job-123/outcome to update",
        reportedAt: "2026-06-10T12:00:00Z",
        updateCount: "2",
      },
    };
    global.fetch = createMockFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: () => Promise.resolve(structured409),
    });

    try {
      await reportJobOutcome("job-123", validOutcome);
      fail("Expected OutcomeAlreadyReportedError");
    } catch (err: unknown) {
      const typed = err as { name: string; jobId: string; reportedAt: string; updateCount: number };
      expect(typed.name).toBe("OutcomeAlreadyReportedError");
      expect(typed.jobId).toBe("job-123");
      expect(typed.reportedAt).toBe("2026-06-10T12:00:00Z");
      expect(typed.updateCount).toBe(2);
    }
    warnSpy.mockRestore();
  });

  it("returns fallback when 409 body has no guidance (legacy backend)", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const legacyBody = { id: "res-old", agenticJobId: "job-123", hasOutcome: true };
    global.fetch = createMockFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: () => Promise.resolve(legacyBody),
    });

    const result = await reportJobOutcome("job-123", validOutcome);

    expect(result).toEqual(legacyBody);
    warnSpy.mockRestore();
  });
});

describe("amendJobOutcome", () => {
  const validAmendment: JobOutcomeAmendment = {
    reason: "Customer churned after initial conversion",
    executionStatus: "FAILED",
  };

  it("sends PATCH and returns JobResource on success", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const updatedJob = { ...mockJobResource, executionStatus: "FAILED", outcomeUpdateCount: 1 };
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(updatedJob),
    });
    global.fetch = mockFetch;

    const result = await amendJobOutcome("job-123", validAmendment);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/job-123/outcome");
    expect(url).toContain("teamId=team-1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual(validAmendment);
    expect(result).toEqual(updatedJob);
  });

  it("throws before HTTP call when reason is blank", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    await expect(
      amendJobOutcome("job-123", { reason: "  ", executionStatus: "FAILED" }),
    ).rejects.toThrow("reason is required and must be non-blank");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws OutcomeNotReportedError on 422", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: () => Promise.resolve("Cannot update outcome that has not been reported yet"),
    });

    try {
      await amendJobOutcome("job-123", validAmendment);
      fail("Expected OutcomeNotReportedError");
    } catch (err: unknown) {
      expect((err as Error).name).toBe("OutcomeNotReportedError");
    }
  });

  it("throws OutcomeAmendConflictError on 409", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve("Outcome was updated concurrently"),
    });

    try {
      await amendJobOutcome("job-123", validAmendment);
      fail("Expected OutcomeAmendConflictError");
    } catch (err: unknown) {
      expect((err as Error).name).toBe("OutcomeAmendConflictError");
    }
  });
});

describe("getJobOutcomeHistory", () => {
  it("returns ordered revision entries", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    const mockHistory: JobOutcomeRevisionEntry[] = [
      {
        sequence: 1,
        executionStatus: "SUCCESS",
        outcomeType: "CONVERTED",
        outcomeValue: 99.5,
        outcomeCurrency: "USD",
        outcomeMetadata: null,
        reportedBy: "sdk",
        reportedAt: "2026-06-10T12:00:00Z",
        reason: null,
      },
      {
        sequence: 2,
        executionStatus: "FAILED",
        outcomeType: "CONVERTED",
        outcomeValue: 0,
        outcomeCurrency: "USD",
        outcomeMetadata: null,
        reportedBy: "crm",
        reportedAt: "2026-06-11T08:00:00Z",
        reason: "Customer churned",
      },
    ];
    const mockFetch = createMockFetch({
      json: () => Promise.resolve(mockHistory),
    });
    global.fetch = mockFetch;

    const result = await getJobOutcomeHistory("job-123");

    expect(result).toHaveLength(2);
    expect(result[0].sequence).toBe(1);
    expect(result[1].sequence).toBe(2);
    expect(result[0].reason).toBeNull();
    expect(result[1].reason).toBe("Customer churned");
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/profitstream/v2/api/jobs/job-123/outcome/history");
    expect(options.method).toBe("GET");
  });

  it("throws on 404", async () => {
    setConfig(createReveniumConfig({ reveniumTeamId: "team-1" }));
    global.fetch = createMockFetch({ ok: false, status: 404, statusText: "Not Found" });

    await expect(getJobOutcomeHistory("job-123")).rejects.toThrow("not found");
  });
});

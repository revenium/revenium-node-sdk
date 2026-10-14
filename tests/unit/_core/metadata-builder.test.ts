import {
  buildMetadataFields,
  resolveAgenticJobFields,
  normalizeAgenticJobId,
} from "../../../src/_core/metadata/metadata-builder";
import { runWithJobContext } from "../../../src/_core/jobs/job-context";
import type { UsageMetadata } from "../../../src/_core/types/index";

describe("buildMetadataFields", () => {
  it("passes through all new trace fields from usageMetadata", () => {
    const metadata: UsageMetadata = {
      retryNumber: 3,
      environment: "production",
      region: "us-east-1",
      parentTransactionId: "txn-parent-001",
      transactionName: "synthesis-retry",
      traceType: "workflow",
      traceName: "recommendation-pipeline",
      ticketId: "FRONT-1543",
      operationSubtype: "function_call",
      errorReason: "schema_validation_failed",
      credentialAlias: "prod-key-1",
      mediationLatency: 150,
      systemFingerprint: "fp_abc123",
      temperature: 0.7,
    };

    const result = buildMetadataFields(metadata);

    expect(result.retryNumber).toBe(3);
    expect(result.environment).toBe("production");
    expect(result.region).toBe("us-east-1");
    expect(result.parentTransactionId).toBe("txn-parent-001");
    expect(result.transactionName).toBe("synthesis-retry");
    expect(result.traceType).toBe("workflow");
    expect(result.traceName).toBe("recommendation-pipeline");
    expect(result.ticketId).toBe("FRONT-1543");
    expect(result.operationSubtype).toBe("function_call");
    expect(result.errorReason).toBe("schema_validation_failed");
    expect(result.credentialAlias).toBe("prod-key-1");
    expect(result.mediationLatency).toBe(150);
    expect(result.systemFingerprint).toBe("fp_abc123");
    expect(result.temperature).toBe(0.7);
    expect(result.idempotencyKey).toBeUndefined();
  });

  it("passes through idempotencyKey from usageMetadata", () => {
    const result = buildMetadataFields({ idempotencyKey: "custom-key-123" });
    expect(result.idempotencyKey).toBe("custom-key-123");
  });

  it("preserves retryNumber: 0 as a valid value", () => {
    const metadata: UsageMetadata = { retryNumber: 0 };
    const result = buildMetadataFields(metadata);
    expect(result.retryNumber).toBe(0);
  });

  it("omits undefined fields from result", () => {
    const metadata: UsageMetadata = { environment: "staging" };
    const result = buildMetadataFields(metadata);
    expect(result.environment).toBe("staging");
    expect(result.retryNumber).toBeUndefined();
    expect(result.region).toBeUndefined();
  });

  it("preserves existing fields alongside new ones", () => {
    const metadata: UsageMetadata = {
      traceId: "trace-001",
      taskType: "synthesis",
      agent: "recommender",
      retryNumber: 1,
      parentTransactionId: "txn-parent-001",
    };

    const result = buildMetadataFields(metadata);

    expect(result.traceId).toBe("trace-001");
    expect(result.taskType).toBe("synthesis");
    expect(result.agent).toBe("recommender");
    expect(result.retryNumber).toBe(1);
    expect(result.parentTransactionId).toBe("txn-parent-001");
  });
});

describe("resolveAgenticJobFields", () => {
  const JOB_ENV_VARS = [
    "REVENIUM_AGENTIC_JOB_ID",
    "REVENIUM_AGENTIC_JOB_NAME",
    "REVENIUM_AGENTIC_JOB_TYPE",
    "REVENIUM_AGENTIC_JOB_VERSION",
  ];

  afterEach(() => {
    for (const name of JOB_ENV_VARS) delete process.env[name];
  });

  it("reads the job fields from the environment when nothing else is set", () => {
    process.env.REVENIUM_AGENTIC_JOB_ID = "env-job";
    process.env.REVENIUM_AGENTIC_JOB_NAME = "env-name";

    expect(resolveAgenticJobFields()).toEqual({
      agenticJobId: "env-job",
      agenticJobName: "env-name",
    });
  });

  it("prefers the job context over the environment", () => {
    process.env.REVENIUM_AGENTIC_JOB_ID = "env-job";

    const resolved = runWithJobContext({ agenticJobId: "context-job" }, () =>
      resolveAgenticJobFields(),
    );

    expect(resolved).toEqual({ agenticJobId: "context-job" });
  });

  it("prefers per-call metadata over the job context", () => {
    const resolved = runWithJobContext(
      { agenticJobId: "context-job", agenticJobType: "batch" },
      () => resolveAgenticJobFields({ agenticJobId: "call-job" }),
    );

    expect(resolved).toEqual({ agenticJobId: "call-job", agenticJobType: "batch" });
  });

  it("returns no fields when no source supplies one", () => {
    expect(resolveAgenticJobFields({ traceId: "trace-001" })).toEqual({});
  });

  it("drops an environment job id the metering API would reject", () => {
    process.env.REVENIUM_AGENTIC_JOB_ID = "run 77";
    process.env.REVENIUM_AGENTIC_JOB_NAME = "env-name";

    expect(resolveAgenticJobFields()).toEqual({});
  });

  it("drops a job context id the metering API would reject and falls back to the environment", () => {
    process.env.REVENIUM_AGENTIC_JOB_ID = "env-job";

    const resolved = runWithJobContext({ agenticJobId: "run 77", agenticJobType: "batch" }, () =>
      resolveAgenticJobFields(),
    );

    expect(resolved).toEqual({ agenticJobId: "env-job" });
  });

  it("drops the per-call job descriptors alongside a rejected per-call id", () => {
    const resolved = runWithJobContext(
      { agenticJobId: "context-job", agenticJobType: "batch" },
      () => resolveAgenticJobFields({ agenticJobId: "run 77", agenticJobName: "call-name" }),
    );

    expect(resolved).toEqual({ agenticJobId: "context-job", agenticJobType: "batch" });
  });

  it("keeps the job context when a call passes the field with no value", () => {
    const fields = runWithJobContext({ agenticJobName: "context-name" }, () =>
      buildMetadataFields({ agenticJobName: undefined }),
    );

    expect(fields).toMatchObject({ agenticJobName: "context-name" });
  });
});

describe("normalizeAgenticJobId", () => {
  it("accepts an id the metering API accepts", () => {
    expect(normalizeAgenticJobId("loan-app_123.v2")).toBe("loan-app_123.v2");
  });

  it.each(["run 77", "job/123", "_run-1", "types", "conversion-funnel", "a".repeat(256)])(
    "drops %p",
    (jobId) => {
      expect(normalizeAgenticJobId(jobId)).toBeUndefined();
    },
  );

  it("returns undefined when no id is supplied", () => {
    expect(normalizeAgenticJobId()).toBeUndefined();
  });
});

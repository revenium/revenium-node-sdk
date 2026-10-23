import { UsageMetadata } from "../../../src/_core/types";
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

  it("maps the shared subscriber object", () => {
    const result = mapGoogleUsageMetadata({
      subscriber: { id: "sub-1", email: "a@example.com" },
    });

    expect(result?.subscriber).toEqual({ id: "sub-1", email: "a@example.com" });
  });

  it("maps a per-call environment", () => {
    expect(mapGoogleUsageMetadata({ environment: "sweep" })?.environment).toBe("sweep");
  });

  it("maps the remaining shared per-call fields", () => {
    const result = mapGoogleUsageMetadata({
      region: "us-east-1",
      ticketId: "FRONT-3361",
      traceType: "workflow",
      traceName: "nightly-sweep",
      parentTransactionId: "txn-parent",
      transactionName: "qualify-lead",
      retryNumber: 2,
      skillName: "lead-qualification",
      skill_source: "marketplace",
    });

    expect(result?.region).toBe("us-east-1");
    expect(result?.ticketId).toBe("FRONT-3361");
    expect(result?.traceType).toBe("workflow");
    expect(result?.traceName).toBe("nightly-sweep");
    expect(result?.parentTransactionId).toBe("txn-parent");
    expect(result?.transactionName).toBe("qualify-lead");
    expect(result?.retryNumber).toBe(2);
    expect(result?.skillName).toBe("lead-qualification");
    expect(result?.skill_source).toBe("marketplace");
  });

  it("keeps the flat subscriber fields working", () => {
    const result = mapGoogleUsageMetadata({
      subscriberId: "sub-flat",
      subscriberEmail: "flat@example.com",
      subscriberCredential: "secret",
      subscriberCredentialName: "serviceAccount",
    });

    expect(result?.subscriber).toEqual({
      id: "sub-flat",
      email: "flat@example.com",
      credential: { name: "serviceAccount", value: "secret" },
    });
  });

  it("defaults the flat credential name to apiKey", () => {
    expect(
      mapGoogleUsageMetadata({ subscriberCredential: "secret" })?.subscriber?.credential,
    ).toEqual({ name: "apiKey", value: "secret" });
  });

  it("merges flat fields into a partial subscriber object", () => {
    const merged = mapGoogleUsageMetadata({
      subscriber: { id: "sub-1" },
      subscriberEmail: "a@example.com",
    });

    expect(merged?.subscriber).toEqual({ id: "sub-1", email: "a@example.com" });

    const conflicting = mapGoogleUsageMetadata({
      subscriber: { id: "shared" },
      subscriberId: "flat",
    });

    expect(conflicting?.subscriber?.id).toBe("shared");
  });

  it("does not leak Google-only keys", () => {
    const result = mapGoogleUsageMetadata({
      subscriberId: "sub-1",
      subscriberEmail: "a@example.com",
      subscriberCredential: "secret",
      subscriberCredentialName: "apiKey",
      modelSource: "GOOGLE_VERTEX_AI",
    }) as Record<string, unknown>;

    expect("subscriberId" in result).toBe(false);
    expect("subscriberEmail" in result).toBe(false);
    expect("subscriberCredential" in result).toBe(false);
    expect("subscriberCredentialName" in result).toBe(false);
    expect("modelSource" in result).toBe(false);
  });

  it("keeps empty-string fields instead of dropping them", () => {
    const result = mapGoogleUsageMetadata({ traceId: "", agent: "", environment: "" });

    expect(result?.traceId).toBe("");
    expect(result?.agent).toBe("");
    expect(result?.environment).toBe("");
  });

  it("omits the subscriber entirely when no subscriber field is provided", () => {
    expect(mapGoogleUsageMetadata({ traceId: "t" })?.subscriber).toBeUndefined();
  });

  it("forwards every shared per-call field the metadata type accepts", () => {
    const sharedFields: Required<Omit<UsageMetadata, "subscriber">> = {
      organizationName: "acme",
      organizationId: "org-legacy",
      productName: "checkout",
      productId: "prod-legacy",
      subscriptionId: "sub-plan-1",
      taskType: "chat",
      traceId: "trace-1",
      responseQualityScore: 0.75,
      agent: "support-bot",
      capturePrompts: true,
      agenticJobId: "job-1",
      agenticJobName: "nightly",
      agenticJobType: "sales-agent",
      agenticJobVersion: "2.0.0",
      retryNumber: 3,
      environment: "sweep",
      region: "us-east-1",
      parentTransactionId: "txn-parent",
      transactionName: "qualify-lead",
      traceType: "workflow",
      traceName: "nightly-sweep",
      ticketId: "FRONT-3361",
      operationSubtype: "inpainting",
      errorReason: "none",
      credentialAlias: "primary",
      mediationLatency: 42,
      systemFingerprint: "fp-1",
      temperature: 0.2,
      idempotencyKey: "idem-1",
      skillName: "lead-qualification",
      skillSource: "projectSettings",
      skillKind: "workflow",
      skillPluginName: "revenium",
      skillMarketplaceName: "revenium-tools",
      skillInvocationTrigger: "user-slash",
      skill_name: "lead-qualification",
      skill_source: "marketplace",
      skill_kind: "workflow",
      skill_plugin_name: "revenium",
      skill_marketplace_name: "revenium-tools",
      skill_invocation_trigger: "user-slash",
    };

    expect(mapGoogleUsageMetadata(sharedFields)).toEqual(sharedFields);
  });
});

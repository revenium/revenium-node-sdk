import {
  buildPayload,
  buildImagePayload,
  buildAudioPayload,
  buildVideoPayload,
  PayloadParams,
} from "../../../src/_core/metering/payload-builder";
import {
  AUDIO_OPERATION_SUBTYPES,
  IMAGE_OPERATION_SUBTYPES,
  VIDEO_OPERATION_SUBTYPES,
  type ImageOperationSubtype,
  type VideoOperationSubtype,
} from "../../../src/_core/metering/operation-subtype";
import { ReveniumPayload, UsageMetadata } from "../../../src/_core/types/index";

const ENV_KEYS = [
  "REVENIUM_ENVIRONMENT",
  "REVENIUM_REGION",
  "REVENIUM_CREDENTIAL_ALIAS",
  "REVENIUM_TRACE_TYPE",
  "REVENIUM_TRACE_NAME",
  "REVENIUM_TICKET_ID",
  "REVENIUM_PARENT_TRANSACTION_ID",
  "REVENIUM_TRANSACTION_NAME",
  "REVENIUM_RETRY_NUMBER",
  "NODE_ENV",
  "DEPLOYMENT_ENV",
  "AWS_REGION",
  "AZURE_REGION",
  "GCP_REGION",
];

let savedEnv: Record<string, string | undefined>;

function createParams(overrides: Partial<PayloadParams> = {}): PayloadParams {
  return {
    operationType: "CHAT",
    model: "claude-sonnet-4-20250514",
    startTime: Date.now() - 1000,
    duration: 1000,
    provider: "Anthropic",
    modelSource: "ANTHROPIC",
    middlewareSource: "revenium-anthropic-node",
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    stopReason: "end_turn",
    isStreamed: false,
    ...overrides,
  };
}

beforeEach(async () => {
  jest.resetModules();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const { resetRegionCache } = await import("../../../src/_core/metadata/trace-fields");
  resetRegionCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe("buildPayload precedence", () => {
  it("user-set values override env vars", async () => {
    process.env.REVENIUM_ENVIRONMENT = "from-env";
    process.env.REVENIUM_RETRY_NUMBER = "2";
    process.env.REVENIUM_PARENT_TRANSACTION_ID = "env-parent";
    process.env.REVENIUM_TRANSACTION_NAME = "env-name";
    process.env.REVENIUM_CREDENTIAL_ALIAS = "env-alias";
    process.env.REVENIUM_TRACE_TYPE = "env-trace-type";
    process.env.REVENIUM_TRACE_NAME = "env-trace-name";
    process.env.REVENIUM_TICKET_ID = "env-ticket-id";

    const params = createParams({
      usageMetadata: {
        environment: "user-production",
        retryNumber: 5,
        parentTransactionId: "user-parent-txn",
        transactionName: "user-txn-name",
        credentialAlias: "user-alias",
        traceType: "user-trace-type",
        traceName: "user-trace-name",
        ticketId: "FRONT-123",
      },
    });

    const payload = await buildPayload(params);

    expect(payload.environment).toBe("user-production");
    expect(payload.retryNumber).toBe(5);
    expect(payload.parentTransactionId).toBe("user-parent-txn");
    expect(payload.transactionName).toBe("user-txn-name");
    expect(payload.credentialAlias).toBe("user-alias");
    expect(payload.traceType).toBe("user-trace-type");
    expect(payload.traceName).toBe("user-trace-name");
    expect(payload.ticketId).toBe("FRONT-123");
  });

  it("falls back to env vars when user provides no metadata", async () => {
    process.env.REVENIUM_ENVIRONMENT = "staging";
    process.env.REVENIUM_RETRY_NUMBER = "1";
    process.env.REVENIUM_CREDENTIAL_ALIAS = "env-alias";
    process.env.REVENIUM_TICKET_ID = "BACK-456";

    const params = createParams();
    const payload = await buildPayload(params);

    expect(payload.environment).toBe("staging");
    expect(payload.retryNumber).toBe(1);
    expect(payload.credentialAlias).toBe("env-alias");
    expect(payload.ticketId).toBe("BACK-456");
  });

  it("truncates ticketId env var exceeding 256 characters", async () => {
    process.env.REVENIUM_TICKET_ID = "A".repeat(257);

    const params = createParams();
    const payload = await buildPayload(params);

    expect(payload.ticketId).toHaveLength(256);
  });

  it("preserves retryNumber: 0 from user metadata over env var", async () => {
    process.env.REVENIUM_RETRY_NUMBER = "3";

    const params = createParams({
      usageMetadata: { retryNumber: 0 },
    });

    const payload = await buildPayload(params);

    expect(payload.retryNumber).toBe(0);
  });

  it("carries new fields to the wire payload", async () => {
    const params = createParams({
      usageMetadata: {
        operationSubtype: "function_call",
        errorReason: "schema_validation_failed",
        mediationLatency: 200,
        systemFingerprint: "fp_xyz",
        temperature: 0.3,
      },
    });

    const payload = await buildPayload(params);

    expect(payload.operationSubtype).toBe("function_call");
    expect(payload.environment).toBeUndefined();
    expect(payload.region).toBeUndefined();
  });
});

describe("multimodal operationSubtype", () => {
  const buildImage = (subtype: ImageOperationSubtype, usageMetadata?: UsageMetadata) =>
    buildImagePayload(
      subtype,
      { data: [{ url: "https://example.com/1.png" }] },
      { n: 1, model: "dall-e-3", size: "1024x1024" },
      Date.now() - 1000,
      1000,
      "OpenAI",
      "OPENAI",
      "revenium-openai-node",
      usageMetadata,
    );

  const buildAudio = (
    subtype: Parameters<typeof buildAudioPayload>[0],
    usageMetadata?: UsageMetadata,
  ) =>
    buildAudioPayload(
      subtype,
      { duration: 42 },
      { model: "whisper-1", input: "hello", voice: "alloy" },
      Date.now() - 1000,
      1000,
      "OpenAI",
      "OPENAI",
      "revenium-openai-node",
      usageMetadata,
    );

  const buildVideo = (subtype: VideoOperationSubtype, usageMetadata?: UsageMetadata) =>
    buildVideoPayload(
      subtype,
      { model: "veo-001" },
      Date.now() - 1000,
      1000,
      "Google",
      "GOOGLE_VERTEX_AI",
      "revenium-google-node",
      usageMetadata,
      { videoDurationSeconds: 8 },
    );

  function subtypeCases<T extends string>(
    operationType: string,
    accepted: readonly T[],
    build: (subtype: T, usageMetadata?: UsageMetadata) => ReveniumPayload,
  ) {
    return accepted.map((subtype, index) => ({
      operationType,
      subtype,
      override: accepted[(index + 1) % accepted.length],
      build: (usageMetadata?: UsageMetadata) => build(subtype, usageMetadata),
    }));
  }

  const cases = [
    ...subtypeCases("IMAGE", IMAGE_OPERATION_SUBTYPES, buildImage),
    ...subtypeCases("AUDIO", AUDIO_OPERATION_SUBTYPES, buildAudio),
    ...subtypeCases("VIDEO", VIDEO_OPERATION_SUBTYPES, buildVideo),
  ];

  it.each(cases)(
    "promotes the detected $subtype subtype to the top level of the $operationType payload",
    ({ subtype, build }) => {
      const payload = build();

      expect(payload.operationSubtype).toBe(subtype);
      expect(payload.attributes?.operationSubtype).toBeUndefined();
    },
  );

  it.each(cases)(
    "lets caller metadata override the detected $subtype subtype on $operationType",
    ({ build, override }) => {
      expect(build({ operationSubtype: override }).operationSubtype).toBe(override);
    },
  );

  it.each(cases)(
    "normalizes a caller override on $operationType for $subtype",
    ({ build, override }) => {
      expect(build({ operationSubtype: `  ${override.toUpperCase()} ` }).operationSubtype).toBe(
        override,
      );
    },
  );

  it.each(cases)(
    "keeps the detected $subtype subtype on $operationType when the override is not accepted",
    ({ subtype, build }) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(build({ operationSubtype: "" }).operationSubtype).toBe(subtype);
      expect(build({ operationSubtype: "   " }).operationSubtype).toBe(subtype);
      expect(build({ operationSubtype: "speach" }).operationSubtype).toBe(subtype);
      expect(build({ operationSubtype: 123 as unknown as string }).operationSubtype).toBe(subtype);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("operationSubtype");
      warn.mockRestore();
    },
  );

  it("maps the legacy audio literals to the vocabulary the metering API accepts", () => {
    expect(buildAudio("speech_synthesis").operationSubtype).toBe("tts");
    expect(buildAudio("audio_generation").operationSubtype).toBe("synthesis");
  });

  it("maps a legacy caller override the same way", () => {
    const payload = buildAudio("transcription", { operationSubtype: "speech_synthesis" });

    expect(payload.operationSubtype).toBe("tts");
    expect(payload.attributes?.billing_unit).toBe("per_character");
  });

  it("bills a caller-corrected audio subtype by the unit that subtype implies", () => {
    const payload = buildAudio("transcription", { operationSubtype: "tts" });

    expect(payload.operationSubtype).toBe("tts");
    expect(payload.characterCount).toBe(5);
    expect(payload.durationSeconds).toBeUndefined();
    expect(payload.attributes?.billing_unit).toBe("per_character");
  });

  it("bills a synthesis subtype per second instead of inheriting transcription billing", () => {
    const payload = buildAudio("synthesis");

    expect(payload.attributes?.billing_unit).toBe("per_second");
    expect(payload.durationSeconds).toBe(42);
    expect(payload.characterCount).toBeUndefined();
  });

  it("keeps duration billing when a caller overrides an audio call without text to tts", () => {
    const payload = buildAudioPayload(
      "transcription",
      { duration: 42 },
      { model: "whisper-1" },
      Date.now() - 1000,
      1000,
      "OpenAI",
      "OPENAI",
      "revenium-openai-node",
      { operationSubtype: "tts" },
    );

    expect(payload.operationSubtype).toBe("tts");
    expect(payload.attributes?.billing_unit).toBe("per_second");
    expect(payload.durationSeconds).toBe(42);
    expect(payload.characterCount).toBeUndefined();
  });
});

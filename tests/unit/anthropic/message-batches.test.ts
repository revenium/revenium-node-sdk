import {
  DIRECT_BASE_URL,
  MODEL,
  REQUEST,
  jsonResponse,
  setupAnthropicMetering,
} from "../../helpers/anthropic-metering";
import {
  REVENIUM_BASE_URL,
  createReveniumConfig,
  installRoutingFetch,
  settle,
  waitForMetering,
} from "../../helpers/fixtures";

const BATCH_ID = "msgbatch_01";
const BATCH_ENDED_AT = "2026-11-01T11:00:00.000Z";
const RESULTS_URL = `${DIRECT_BASE_URL}/v1/messages/batches/${BATCH_ID}/results`;

const BATCH = {
  id: BATCH_ID,
  type: "message_batch",
  processing_status: "ended",
  request_counts: { canceled: 1, errored: 1, expired: 1, processing: 0, succeeded: 2 },
  created_at: "2026-11-01T10:00:00Z",
  ended_at: BATCH_ENDED_AT,
  expires_at: "2026-11-02T10:00:00Z",
  archived_at: null,
  cancel_initiated_at: null,
  results_url: RESULTS_URL,
};

function batchMessage(id: string, inputTokens: number, outputTokens: number) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

const SUCCEEDED_LINES = [
  {
    custom_id: "first",
    result: { type: "succeeded", message: batchMessage("msg_batch_01", 12, 4) },
  },
  {
    custom_id: "second",
    result: { type: "succeeded", message: batchMessage("msg_batch_02", 20, 9) },
  },
];

const UNBILLED_LINES = [
  {
    custom_id: "third",
    result: {
      type: "errored",
      error: {
        type: "error",
        error: { type: "invalid_request_error", message: "max_tokens is required" },
      },
    },
  },
  { custom_id: "fourth", result: { type: "canceled" } },
  { custom_id: "fifth", result: { type: "expired" } },
];

function succeededLines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    custom_id: `line-${index}`,
    result: { type: "succeeded", message: batchMessage(`msg_batch_line_${index}`, 1, 1) },
  }));
}

function batchProvider(lines: unknown[]): (url: string) => Response {
  return (url) =>
    url.startsWith(RESULTS_URL)
      ? new Response(lines.map((line) => JSON.stringify(line)).join("\n"), {
          status: 200,
          headers: { "content-type": "application/binary" },
        })
      : new Response(JSON.stringify(BATCH), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
}

async function collectLines(results: Promise<AsyncIterable<unknown>>): Promise<unknown[]> {
  const lines: unknown[] = [];
  for await (const line of await results) lines.push(line);
  return lines;
}

function fetchCalls(): [string, RequestInit & { headers: Record<string, string> }][] {
  return (global.fetch as jest.Mock).mock.calls.map(([url, init]) => [String(url), init]);
}

function meteringHeaders(name: string): string[] {
  return fetchCalls()
    .filter(([url]) => url.startsWith(REVENIUM_BASE_URL))
    .map(([, init]) => init.headers[name]);
}

function meteringIdempotencyKeys(): string[] {
  return meteringHeaders("Idempotency-Key");
}

async function useReveniumConfig(overrides: Parameters<typeof createReveniumConfig>[0]) {
  const { setConfig } = await import("../../../src/_core/config/manager");
  setConfig(createReveniumConfig({ reveniumBaseUrl: REVENIUM_BASE_URL, ...overrides }));
}

function installRejectingMeteringFetch(lines: unknown[]): void {
  const provider = batchProvider(lines);
  global.fetch = jest.fn(async (url: unknown) =>
    String(url).startsWith(REVENIUM_BASE_URL)
      ? new Response("{}", { status: 400, headers: { "content-type": "application/json" } })
      : provider(String(url)),
  ) as unknown as typeof fetch;
}

async function captureUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await run();
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  return rejections;
}

const harness = setupAnthropicMetering();

function fakeOnlyDate(): void {
  jest.useFakeTimers({
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
}

function installHeldMeteringFetch(lines: unknown[]): {
  heldReplies: (() => void)[];
  release(): void;
} {
  const provider = batchProvider(lines);
  const meteringReply = () =>
    new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
  const heldReplies: (() => void)[] = [];
  let holding = true;

  global.fetch = jest.fn(async (url: unknown) => {
    if (!String(url).startsWith(REVENIUM_BASE_URL)) return provider(String(url));
    if (!holding) return meteringReply();
    return new Promise<Response>((resolve) => heldReplies.push(() => resolve(meteringReply())));
  }) as unknown as typeof fetch;

  return {
    heldReplies,
    release() {
      holding = false;
      heldReplies.splice(0).forEach((reply) => reply());
    },
  };
}

describe("messages.batches.results", () => {
  afterEach(() => jest.useRealTimers());

  it("meters each succeeded batch result once at the batch rate", async () => {
    const bodies = installRoutingFetch(batchProvider([...SUCCEEDED_LINES, ...UNBILLED_LINES]));

    const lines = await collectLines(
      harness.createClient(DIRECT_BASE_URL).messages.batches.results(BATCH_ID),
    );
    await waitForMetering(bodies);
    await settle();

    expect(lines).toEqual([...SUCCEEDED_LINES, ...UNBILLED_LINES]);
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pricingTier: "BATCH",
          transactionId: "msg_batch_01",
          inputTokenCount: 12,
          outputTokenCount: 4,
          model: MODEL,
        }),
        expect.objectContaining({
          pricingTier: "BATCH",
          transactionId: "msg_batch_02",
          inputTokenCount: 20,
          outputTokenCount: 9,
          model: MODEL,
        }),
      ]),
    );
  });

  it("dates each batch record at the batch end with no latency", async () => {
    const bodies = installRoutingFetch(batchProvider(SUCCEEDED_LINES.slice(0, 1)));

    await collectLines(harness.createClient(DIRECT_BASE_URL).messages.batches.results(BATCH_ID));
    const body = await waitForMetering(bodies);
    await settle();

    expect(body).toMatchObject({
      requestTime: BATCH_ENDED_AT,
      responseTime: BATCH_ENDED_AT,
      completionStartTime: BATCH_ENDED_AT,
      requestDuration: 0,
    });
  });

  it("sends the same body and Idempotency-Key when the results are read again later", async () => {
    fakeOnlyDate();
    const bodies = installRoutingFetch(batchProvider(SUCCEEDED_LINES));
    const batches = harness.createClient(DIRECT_BASE_URL).messages.batches;

    await collectLines(batches.results(BATCH_ID));
    await settle();
    const firstRead = bodies.splice(0);
    jest.setSystemTime(Date.now() + 60_000);
    await collectLines(batches.results(BATCH_ID));
    await settle();

    expect(firstRead).toHaveLength(2);
    expect(bodies).toEqual(firstRead);
    expect(meteringIdempotencyKeys().sort()).toEqual([
      "anthropic-batch-msg_batch_01",
      "anthropic-batch-msg_batch_01",
      "anthropic-batch-msg_batch_02",
      "anthropic-batch-msg_batch_02",
    ]);
  });

  it("attaches usageMetadata passed to results", async () => {
    const bodies = installRoutingFetch(batchProvider(SUCCEEDED_LINES.slice(0, 1)));

    await collectLines(
      harness.createClient(DIRECT_BASE_URL).messages.batches.results(BATCH_ID, {
        usageMetadata: {
          traceId: "trace-batch",
          subscriber: { id: "subscriber-batch" },
          idempotencyKey: "caller-key",
        },
      }),
    );
    const body = await waitForMetering(bodies);
    await settle();

    expect(body).toMatchObject({
      traceId: "trace-batch",
      subscriber: { id: "subscriber-batch" },
      pricingTier: "BATCH",
    });
    expect(meteringIdempotencyKeys()).toEqual(["anthropic-batch-msg_batch_01"]);
    expect(
      fetchCalls()
        .filter(([url]) => url.startsWith(DIRECT_BASE_URL))
        .map(([url]) => url)
        .filter((url) => url.includes("usageMetadata")),
    ).toEqual([]);
  });

  it("beta.messages.batches.results meters the same way", async () => {
    const bodies = installRoutingFetch(batchProvider(SUCCEEDED_LINES.slice(0, 1)));

    await collectLines(
      harness.createClient(DIRECT_BASE_URL).beta.messages.batches.results(BATCH_ID),
    );
    const body = await waitForMetering(bodies);
    await settle();

    expect(bodies).toHaveLength(1);
    expect(body).toMatchObject({
      pricingTier: "BATCH",
      transactionId: "msg_batch_01",
      inputTokenCount: 12,
      outputTokenCount: 4,
    });
  });

  it("holds the results loop while too many batch records are in flight", async () => {
    const { MAX_IN_FLIGHT_BATCH_RECORDS } = await import("../../../src/anthropic/batch-results");
    const lines = succeededLines(MAX_IN_FLIGHT_BATCH_RECORDS + 5);
    const metering = installHeldMeteringFetch(lines);

    const reading = collectLines(
      harness.createClient(DIRECT_BASE_URL).messages.batches.results(BATCH_ID),
    );
    await settle();
    const sentWhileHeld = metering.heldReplies.length;
    metering.release();

    expect(sentWhileHeld).toBe(MAX_IN_FLIGHT_BATCH_RECORDS);
    expect(await reading).toEqual(lines);
    await settle();
    expect(meteringIdempotencyKeys()).toHaveLength(lines.length);
  });

  it("returns every result and leaves no unhandled rejection when metering fails with failSilent off", async () => {
    const { MAX_IN_FLIGHT_BATCH_RECORDS } = await import("../../../src/anthropic/batch-results");
    await useReveniumConfig({ failSilent: false, maxRetries: 0 });
    const lines = succeededLines(MAX_IN_FLIGHT_BATCH_RECORDS + 5);
    installRejectingMeteringFetch(lines);
    let readLines: unknown[] = [];

    const rejections = await captureUnhandledRejections(async () => {
      readLines = await collectLines(
        harness.createClient(DIRECT_BASE_URL).messages.batches.results(BATCH_ID),
      );
    });

    expect(meteringIdempotencyKeys()).toHaveLength(lines.length);
    expect(readLines).toEqual(lines);
    expect(rejections).toEqual([]);
  });

  it("meters every result under the configuration active when results was called", async () => {
    const bodies = installRoutingFetch(batchProvider(SUCCEEDED_LINES));
    const results = await harness.createClient(DIRECT_BASE_URL).messages.batches.results(BATCH_ID);

    await useReveniumConfig({ reveniumApiKey: "hak_other_org_key" });
    await collectLines(Promise.resolve(results));
    await settle();

    expect(bodies).toHaveLength(2);
    expect(meteringHeaders("x-api-key")).toEqual(["hak_tenant_abc123xyz", "hak_tenant_abc123xyz"]);
  });

  it("messages.create records carry no pricingTier after a batch read", async () => {
    const readBatch = batchProvider(SUCCEEDED_LINES.slice(0, 1));
    const bodies = installRoutingFetch((url) =>
      url.includes("/v1/messages/batches") ? readBatch(url) : jsonResponse(),
    );
    const client = harness.createClient(DIRECT_BASE_URL);

    await collectLines(client.messages.batches.results(BATCH_ID));
    await waitForMetering(bodies);
    await settle();
    await client.messages.create(REQUEST as never);
    await settle();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ pricingTier: "BATCH", transactionId: "msg_batch_01" });
    expect(bodies[1]).toMatchObject({ inputTokenCount: 10, outputTokenCount: 5 });
    expect(bodies[1]).not.toHaveProperty("pricingTier");
  });

  it("unpatchAnthropic restores results", async () => {
    const { unpatchAnthropic } = await import("../../../src/anthropic/wrapper");
    const bodies = installRoutingFetch(batchProvider(SUCCEEDED_LINES));
    const batches = harness.createClient(DIRECT_BASE_URL).messages.batches;

    await collectLines(batches.results(BATCH_ID));
    await waitForMetering(bodies);
    await settle();
    const meteredWhilePatched = bodies.length;

    unpatchAnthropic();
    const lines = await collectLines(batches.results(BATCH_ID));
    await settle();

    expect(meteredWhilePatched).toBe(2);
    expect(lines).toEqual(SUCCEEDED_LINES);
    expect(bodies).toHaveLength(meteredWhilePatched);
  });
});

describe("trackUsageAsync", () => {
  it("resolves once the record is sent, dated at the given responseTime with its pricingTier", async () => {
    const bodies = installRoutingFetch(jsonResponse);

    await harness.trackUsageAsync({
      requestId: "req-tracked-batch",
      model: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      duration: 2000,
      isStreamed: false,
      stopReason: "end_turn",
      requestTime: new Date("2026-11-01T10:59:58.000Z"),
      responseTime: new Date(BATCH_ENDED_AT),
      pricingTier: "STANDARD",
    });

    expect(bodies).toEqual([
      expect.objectContaining({
        transactionId: "req-tracked-batch",
        requestTime: "2026-11-01T10:59:58.000Z",
        responseTime: BATCH_ENDED_AT,
        completionStartTime: BATCH_ENDED_AT,
        requestDuration: 2000,
        pricingTier: "STANDARD",
      }),
    ]);
  });
});

import { initializeConfig, resetConfig, setConfig } from "../../../src/_core/config/manager";
import { ENV_VARS } from "../../../src/_core/constants";
import {
  startEnforcementPolling,
  stopEnforcementPolling,
} from "../../../src/_core/enforcement/engine";
import { runWithJobContext } from "../../../src/_core/jobs/job-context";
import { MeteredRequestLedger } from "../../../src/_core/metering/metered-request-ledger";
import { resetEnforcementCircuitBreaker } from "../../../src/_core/resilience/circuit-breaker";
import { CostLimitExceeded } from "../../../src/_core/resilience/error-handler";
import type { QueueClient } from "@fal-ai/client";
import { ReveniumFal } from "../../../src/fal/client";
import { createMeteredQueue, type PendingFalJob } from "../../../src/fal/metered-queue";
import { createMockFetch, createReveniumConfig } from "../../helpers/fixtures";

const ENDPOINT = "fal-ai/kling-video/v2/master/text-to-video";
const REQUEST_ID = "req-1";
const VIDEO_RESULT = { video: { url: "https://example.com/v.mp4" } };
const JOB_INPUT = { prompt: "a horse running" };
const TIME_FIELDS = ["requestTime", "responseTime", "completionStartTime", "requestDuration"];
const JOB_RUNTIME_MS = 90_000;
const REAL_SCHEDULING_APIS = [
  "nextTick",
  "queueMicrotask",
  "setImmediate",
  "clearImmediate",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "hrtime",
  "performance",
] as const;

const originalFetch = global.fetch;

function falReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "x-fal-request-id": REQUEST_ID },
  });
}

function createFalTransport(resultReply: () => Response = () => falReply(200, VIDEO_RESULT)) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return falReply(200, { request_id: REQUEST_ID, status: "IN_QUEUE", queue_position: 0 });
    }
    if (url.includes(`/requests/${REQUEST_ID}/status`)) {
      return falReply(200, { request_id: REQUEST_ID, status: "COMPLETED" });
    }
    return resultReply();
  });
}

function createClient(falTransport = createFalTransport()): ReveniumFal {
  return new ReveniumFal(
    { reveniumApiKey: "hak_test_key", falApiKey: "fal_test_key" },
    { fetch: falTransport as unknown as typeof fetch },
  );
}

function meteringCalls(meteringTransport: jest.Mock): [string, RequestInit][] {
  return meteringTransport.mock.calls.filter(([url]) => String(url).includes("/ai/"));
}

function recordBody(call: [string, RequestInit]): Record<string, unknown> {
  return JSON.parse(String(call[1].body));
}

function withoutTimeFields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !TIME_FIELDS.includes(key)));
}

async function waitForRecords(meteringTransport: jest.Mock, count: number): Promise<void> {
  for (
    let attempt = 0;
    attempt < 100 && meteringCalls(meteringTransport).length < count;
    attempt++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function submitAndCollect(
  client: ReveniumFal,
  submitMetadata?: Record<string, unknown>,
  resultMetadata?: Record<string, unknown>,
) {
  const { request_id: requestId } = await client.queue.submit(
    ENDPOINT,
    { input: JOB_INPUT },
    submitMetadata,
  );
  return client.queue.result(ENDPOINT, { requestId }, resultMetadata);
}

describe("ReveniumFal.queue metering", () => {
  let meteringTransport: jest.Mock;

  beforeEach(() => {
    process.env.AWS_REGION = "us-east-1";
    setConfig(createReveniumConfig());
    meteringTransport = createMockFetch();
    global.fetch = meteringTransport;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete process.env.AWS_REGION;
    resetConfig();
  });

  it("meters a queued job once its result is collected", async () => {
    const collected = await submitAndCollect(createClient());
    await waitForRecords(meteringTransport, 1);

    const records = meteringCalls(meteringTransport);
    expect(collected.data).toEqual(VIDEO_RESULT);
    expect(records).toHaveLength(1);
    expect(records[0][0]).toContain("/ai/video");
    expect(recordBody(records[0])).toEqual(
      expect.objectContaining({
        transactionId: "fal-req-1",
        model: ENDPOINT,
        durationSeconds: 5,
      }),
    );
    expect((records[0][1].headers as Record<string, string>)["Idempotency-Key"]).toBe("fal-req-1");
  });

  it("sends the same fields as subscribe", async () => {
    await createClient().subscribe(ENDPOINT, { input: JOB_INPUT });
    await waitForRecords(meteringTransport, 1);
    await submitAndCollect(createClient());
    await waitForRecords(meteringTransport, 2);

    const [subscribed, queued] = meteringCalls(meteringTransport).map(recordBody);
    expect(withoutTimeFields(queued)).toEqual(withoutTimeFields(subscribed));
  });

  it("a subscribe record carries the idempotency key of its fal request", async () => {
    await createClient().subscribe(ENDPOINT, { input: JOB_INPUT });
    await waitForRecords(meteringTransport, 1);

    const [record] = meteringCalls(meteringTransport);
    expect((record[1].headers as Record<string, string>)["Idempotency-Key"]).toBe("fal-req-1");
  });

  it("a queued job is timed from its submit", async () => {
    const submittedAt = new Date("2026-11-03T10:00:00.000Z");
    jest.useFakeTimers({ now: submittedAt, doNotFake: [...REAL_SCHEDULING_APIS] });
    const client = createClient();
    const { request_id: requestId } = await client.queue.submit(ENDPOINT, { input: JOB_INPUT });

    jest.setSystemTime(submittedAt.getTime() + JOB_RUNTIME_MS);
    await client.queue.result(ENDPOINT, { requestId });
    await waitForRecords(meteringTransport, 1);

    const body = recordBody(meteringCalls(meteringTransport)[0]);
    expect(body.requestTime).toBe(submittedAt.toISOString());
    expect(body.requestDuration).toBe(JOB_RUNTIME_MS);
  });

  it("collecting the same result twice sends one record", async () => {
    const client = createClient();
    await submitAndCollect(client);
    await waitForRecords(meteringTransport, 1);
    expect(meteringCalls(meteringTransport)).toHaveLength(1);

    await client.queue.result(ENDPOINT, { requestId: REQUEST_ID });
    await waitForRecords(meteringTransport, 2);

    expect(meteringCalls(meteringTransport)).toHaveLength(1);
  });

  it("a failed job rejects and sends nothing", async () => {
    await submitAndCollect(createClient());
    await waitForRecords(meteringTransport, 1);
    expect(meteringCalls(meteringTransport)).toHaveLength(1);

    const failingClient = createClient(
      createFalTransport(() => falReply(500, { detail: "job failed" })),
    );

    await expect(submitAndCollect(failingClient)).rejects.toThrow();
    await waitForRecords(meteringTransport, 2);
    expect(meteringCalls(meteringTransport)).toHaveLength(1);
  });

  it("subscribe then queue.result sends one record", async () => {
    const client = createClient();
    await client.subscribe(ENDPOINT, { input: JOB_INPUT });
    await waitForRecords(meteringTransport, 1);
    await createClient().queue.result(ENDPOINT, { requestId: REQUEST_ID });
    await waitForRecords(meteringTransport, 2);
    expect(meteringCalls(meteringTransport)).toHaveLength(2);

    await client.queue.result(ENDPOINT, { requestId: REQUEST_ID });
    await waitForRecords(meteringTransport, 3);

    expect(meteringCalls(meteringTransport)).toHaveLength(2);
  });

  it("a record that could not be delivered lets the next collection meter the job", async () => {
    meteringTransport.mockImplementationOnce(
      createMockFetch({ ok: false, status: 400, statusText: "Bad Request" }),
    );
    const client = createClient();
    await submitAndCollect(client);
    await waitForRecords(meteringTransport, 1);
    expect(meteringCalls(meteringTransport)).toHaveLength(1);

    await client.queue.result(ENDPOINT, { requestId: REQUEST_ID });
    await waitForRecords(meteringTransport, 2);

    const records = meteringCalls(meteringTransport);
    expect(records).toHaveLength(2);
    expect((records[1][1].headers as Record<string, string>)["Idempotency-Key"]).toBe("fal-req-1");
  });

  it("submit metadata reaches the record and result metadata overrides it field by field", async () => {
    await submitAndCollect(
      createClient(),
      { taskType: "render", subscriber: { id: "sub-a" } },
      { subscriber: { id: "sub-b" } },
    );
    await waitForRecords(meteringTransport, 1);

    const body = recordBody(meteringCalls(meteringTransport)[0]);
    expect(body.taskType).toBe("render");
    expect(body.subscriber).toEqual(expect.objectContaining({ id: "sub-b" }));
  });

  it("a result collected by another process is metered with the collection metadata", async () => {
    await createClient().queue.submit(ENDPOINT, { input: JOB_INPUT });

    await createClient().queue.result(
      ENDPOINT,
      { requestId: REQUEST_ID },
      { subscriber: { id: "sub-b" } },
    );
    await waitForRecords(meteringTransport, 1);

    const records = meteringCalls(meteringTransport);
    expect(records).toHaveLength(1);
    expect(recordBody(records[0]).subscriber).toEqual(expect.objectContaining({ id: "sub-b" }));
    expect((records[0][1].headers as Record<string, string>)["Idempotency-Key"]).toBe("fal-req-1");
  });

  it("a result collected by another process is billed with the input passed to result", async () => {
    const tenSecondJob = { ...JOB_INPUT, duration: "10" } as const;
    await createClient().queue.submit(ENDPOINT, { input: tenSecondJob });

    await createClient().queue.result(ENDPOINT, { requestId: REQUEST_ID, input: tenSecondJob });
    await waitForRecords(meteringTransport, 1);

    expect(recordBody(meteringCalls(meteringTransport)[0]).durationSeconds).toBe(10);
  });

  it("a job submitted inside a job context keeps that job when collected inside another", async () => {
    const client = createClient();
    const { request_id: requestId } = await runWithJobContext({ agenticJobId: "job-a" }, () =>
      client.queue.submit(ENDPOINT, { input: JOB_INPUT }),
    );

    await runWithJobContext({ agenticJobId: "job-b" }, () =>
      client.queue.result(ENDPOINT, { requestId }),
    );
    await waitForRecords(meteringTransport, 1);

    expect(recordBody(meteringCalls(meteringTransport)[0]).agenticJobId).toBe("job-a");
  });

  it("changing the submit metadata after submit leaves the record unchanged", async () => {
    const client = createClient();
    const submitMetadata = { subscriber: { id: "sub-a" } };
    const { request_id: requestId } = await client.queue.submit(
      ENDPOINT,
      { input: JOB_INPUT },
      submitMetadata,
    );

    submitMetadata.subscriber.id = "sub-b";
    await client.queue.result(ENDPOINT, { requestId });
    await waitForRecords(meteringTransport, 1);

    expect(recordBody(meteringCalls(meteringTransport)[0]).subscriber).toEqual(
      expect.objectContaining({ id: "sub-a" }),
    );
  });

  it("a collected job no longer counts toward the pending job limit", async () => {
    let submittedJobs = 0;
    const rawQueue = {
      submit: async () => ({ request_id: `job-${++submittedJobs}`, status: "IN_QUEUE" }),
      result: async (_endpointId: string, { requestId }: { requestId: string }) => ({
        data: VIDEO_RESULT,
        requestId,
      }),
    } as unknown as QueueClient;
    const queue = createMeteredQueue(rawQueue, {
      ledger: new MeteredRequestLedger<PendingFalJob>(2),
      falConfig: { reveniumApiKey: "hak_test_key" },
      reveniumConfig: createReveniumConfig(),
    });
    const tenSecondJob = await queue.submit(ENDPOINT, { input: { ...JOB_INPUT, duration: "10" } });
    const quickJob = await queue.submit(ENDPOINT, { input: JOB_INPUT });
    await queue.result(ENDPOINT, { requestId: quickJob.request_id });
    await waitForRecords(meteringTransport, 1);

    await queue.submit(ENDPOINT, { input: JOB_INPUT });
    await queue.result(ENDPOINT, { requestId: tenSecondJob.request_id });
    await waitForRecords(meteringTransport, 2);

    expect(recordBody(meteringCalls(meteringTransport)[1]).durationSeconds).toBe(10);
  });
});

describe("ReveniumFal.queue cost controls", () => {
  const TEAM_ID = "Ol3wbl";
  const SERVED_HOST = "https://api.dev.hcapp.io";
  const SERVED_URL = `${SERVED_HOST}/profitstream/v2/api/ai/enforcement-rules/${TEAM_ID}`;
  const breachedBlockRule = {
    ruleId: 39053,
    name: "fal queue cap",
    threshold: 10,
    currentValue: 42.5,
    periodType: "DAILY",
    action: "BLOCK",
    breached: true,
    shadowMode: false,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env[ENV_VARS.REVENIUM_API_KEY] = "hak_test";
    process.env[ENV_VARS.REVENIUM_BASE_URL] = SERVED_HOST;
    process.env[ENV_VARS.TEAM_ID] = TEAM_ID;
    delete process.env[ENV_VARS.ENFORCEMENT_BASE_URL];

    resetConfig();
    resetEnforcementCircuitBreaker();
    initializeConfig();

    global.fetch = jest.fn((input: unknown) =>
      Promise.resolve(
        input === SERVED_URL
          ? new Response(JSON.stringify({ rules: [breachedBlockRule] }), { status: 200 })
          : new Response("", { status: 404 }),
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    stopEnforcementPolling();
    resetConfig();
    resetEnforcementCircuitBreaker();
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete process.env[ENV_VARS.REVENIUM_API_KEY];
    delete process.env[ENV_VARS.REVENIUM_BASE_URL];
    delete process.env[ENV_VARS.TEAM_ID];
  });

  it("submit is refused by a breached cost control and never reaches fal", async () => {
    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);
    const falTransport = createFalTransport();

    await expect(
      createClient(falTransport).queue.submit(ENDPOINT, { input: JOB_INPUT }),
    ).rejects.toBeInstanceOf(CostLimitExceeded);
    expect(falTransport).not.toHaveBeenCalled();
  });

  it("result is not refused by a breached cost control and meters the collected job", async () => {
    startEnforcementPolling();
    await jest.advanceTimersByTimeAsync(0);

    const collected = await createClient().queue.result(ENDPOINT, { requestId: REQUEST_ID });
    await jest.advanceTimersByTimeAsync(0);

    const videoRecords = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).includes("/ai/video"),
    );
    expect(collected.data).toEqual(VIDEO_RESULT);
    expect(videoRecords).toHaveLength(1);
  });
});

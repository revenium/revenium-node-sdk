import { createReveniumConfig, createMockFetch } from "../../helpers/fixtures";

const originalFetch = global.fetch;

let ReveniumFal: typeof import("../../../src/fal/client").ReveniumFal;
let setConfig: typeof import("../../../src/_core/config/manager").setConfig;
let resetConfig: typeof import("../../../src/_core/config/manager").resetConfig;

const mockRun = jest.fn();
const mockSubscribe = jest.fn();
const mockStream = jest.fn();

jest.mock("@fal-ai/client", () => ({
  createFalClient: () => ({
    run: mockRun,
    subscribe: mockSubscribe,
    stream: mockStream,
    queue: {},
    realtime: {},
    storage: {},
  }),
}));

beforeEach(async () => {
  jest.resetModules();
  process.env.AWS_REGION = "us-east-1";

  const manager = await import("../../../src/_core/config/manager");
  const clientModule = await import("../../../src/fal/client");

  ReveniumFal = clientModule.ReveniumFal;
  setConfig = manager.setConfig;
  resetConfig = manager.resetConfig;

  setConfig(createReveniumConfig());
  mockRun.mockReset();
  mockSubscribe.mockReset();
  mockStream.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.AWS_REGION;
  resetConfig();
  jest.restoreAllMocks();
});

describe("ReveniumFal.run", () => {
  it("returns the original result unmodified", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const expectedResult = {
      data: { images: [{ url: "https://example.com/1.png", width: 1024, height: 1024 }] },
      requestId: "req-123",
    };
    mockRun.mockResolvedValue(expectedResult);

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    const result = await client.run("fal-ai/flux/dev", { input: { prompt: "a cat" } });

    expect(result).toEqual(expectedResult);
    expect(result.data.images[0].url).toBe("https://example.com/1.png");
  });

  it("calls tracking after successful run", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    mockRun.mockResolvedValue({
      data: { images: [{ url: "test.png", width: 512, height: 512 }] },
      requestId: "req-456",
    });

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    await client.run("fal-ai/flux/dev", { input: { prompt: "test" } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("IMAGE");
    expect(body.provider).toBe("fal_ai");
  });

  it("does not block caller when tracking fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    mockRun.mockResolvedValue({
      data: { images: [] },
      requestId: "req-789",
    });

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    const result = await client.run("fal-ai/flux/dev", { input: {} });

    expect(result.requestId).toBe("req-789");
  });
});

describe("ReveniumFal.subscribe", () => {
  it("returns the original result unmodified", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const expectedResult = {
      data: { video: { url: "https://example.com/v.mp4" } },
      requestId: "req-video-1",
    };
    mockSubscribe.mockResolvedValue(expectedResult);

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    const result = await client.subscribe("fal-ai/kling-video/v2/master/text-to-video", {
      input: { prompt: "a horse running", duration: 5 },
    });

    expect(result).toEqual(expectedResult);
  });

  it("detects video type and tracks correctly", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    mockSubscribe.mockResolvedValue({
      data: { video: { url: "https://example.com/v.mp4" } },
      requestId: "req-video-2",
    });

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    await client.subscribe("fal-ai/kling-video/v2/master/text-to-video", {
      input: { prompt: "test", duration: 10 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("VIDEO");
  });
});

describe("ReveniumFal.stream", () => {
  it("returns the fal stream object with event listeners attached", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const mockFalStream = {
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = handler;
      }),
      [Symbol.asyncIterator]: async function* () {
        yield { partial: "chunk1" };
        yield { partial: "chunk2" };
      },
      done: jest.fn().mockResolvedValue({ output: "final result" }),
    };
    mockStream.mockResolvedValue(mockFalStream);

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    const stream = await client.stream("openrouter/router", {
      input: { prompt: "test", model: "google/gemini-2.5-flash" },
    });

    expect(stream).toBe(mockFalStream);
    expect(mockFalStream.on).toHaveBeenCalledWith("done", expect.any(Function));
    expect(mockFalStream.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("emits metering request when done handler fires", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const mockFalStream = {
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = handler;
      }),
    };
    mockStream.mockResolvedValue(mockFalStream);

    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    await client.stream("openrouter/router", {
      input: { prompt: "test", model: "google/gemini-2.5-flash" },
    });

    listeners["done"]({
      output: "AI is...",
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.operationType).toBe("CHAT");
    expect(body.isStreamed).toBe(true);
    expect(body.inputTokenCount).toBe(10);
    expect(body.outputTokenCount).toBe(50);
  });
});

describe("ReveniumFal passthrough APIs", () => {
  it("exposes queue, realtime, storage from underlying client", () => {
    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    expect(client.queue).toBeDefined();
    expect(client.realtime).toBeDefined();
    expect(client.storage).toBeDefined();
  });

  it("exposes underlying client via getUnderlyingClient", () => {
    const client = new ReveniumFal({ reveniumApiKey: "hak_test_key" });
    expect(client.getUnderlyingClient()).toBeDefined();
  });
});

describe("ReveniumFal organization isolation", () => {
  it("sends usage under the client key while the process holds another", async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch;

    setConfig(createReveniumConfig({ reveniumApiKey: "hak_org_b_2222222222" }));
    mockRun.mockResolvedValue({
      data: { images: [{ url: "a.png", width: 512, height: 512 }] },
      requestId: "req-org-a",
    });

    const client = new ReveniumFal({
      reveniumApiKey: "hak_org_a_1111111111",
      reveniumBaseUrl: "https://api.revenium.ai",
    });
    await client.run("fal-ai/flux/dev", { input: { prompt: "a cat" } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockFetch.mock.calls[0][1].headers["x-api-key"]).toBe("hak_org_a_1111111111");
  });
});

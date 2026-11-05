import {
  withRetry,
  HttpError,
  parseRetryAfter,
  isRetryableStatus,
} from "../../../src/_core/resilience/retry";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function flushRetries(count: number) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
    jest.advanceTimersByTime(120_000);
    await Promise.resolve();
  }
}

describe("withRetry", () => {
  it("returns on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("retries on retryable HttpError (503) and succeeds", async () => {
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls === 1) throw new HttpError("down", 503);
      return Promise.resolve("recovered");
    });

    await flushRetries(3);
    const result = await promise;
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("retries on 429 and succeeds", async () => {
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls <= 2) throw new HttpError("rate limit", 429);
      return Promise.resolve("ok");
    });

    await flushRetries(5);
    const result = await promise;
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries on 408 (Request Timeout)", async () => {
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls === 1) throw new HttpError("timeout", 408);
      return Promise.resolve("ok");
    });

    await flushRetries(3);
    expect(await promise).toBe("ok");
    expect(calls).toBe(2);
  });

  it("fails fast on 401 without retry", async () => {
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      throw new HttpError("unauthorized", 401);
    });

    await expect(promise).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });

  it("fails fast on 400", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new HttpError("bad request", 400);
      }),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("fails fast on 403", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new HttpError("forbidden", 403);
      }),
    ).rejects.toThrow("forbidden");
    expect(calls).toBe(1);
  });

  it("fails fast on 404", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new HttpError("not found", 404);
      }),
    ).rejects.toThrow("not found");
    expect(calls).toBe(1);
  });

  it("fails fast on 422", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new HttpError("unprocessable", 422);
      }),
    ).rejects.toThrow("unprocessable");
    expect(calls).toBe(1);
  });

  it("retries on TypeError (network error)", async () => {
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return Promise.resolve("ok");
    });

    await flushRetries(3);
    expect(await promise).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry an aborted attempt", async () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      return Promise.reject(aborted);
    });

    await expect(promise).rejects.toBe(aborted);
    expect(calls).toBe(1);
  });

  it("honors Retry-After seconds", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls === 1) throw new HttpError("throttled", 429, 2);
      return Promise.resolve("ok");
    });

    await Promise.resolve();
    jest.advanceTimersByTime(1_999);
    await Promise.resolve();
    expect(calls).toBe(1);

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();

    const result = await promise;
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("adds jitter on top of Retry-After, never earlier", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls === 1) throw new HttpError("throttled", 429, 1);
      return Promise.resolve("ok");
    });

    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(calls).toBe(1);

    jest.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(await promise).toBe("ok");
    expect(calls).toBe(2);
  });

  it("clamps Retry-After to 60 seconds", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      if (calls === 1) throw new HttpError("throttled", 429, 120);
      return Promise.resolve("ok");
    });

    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();

    const result = await promise;
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("respects max retries", async () => {
    let calls = 0;
    const promise = withRetry(() => {
      calls++;
      throw new HttpError("down", 503);
    }, 2);

    await flushRetries(5);
    await expect(promise).rejects.toThrow("down");
    expect(calls).toBe(3);
  });

  it("does not retry non-HttpError non-network errors", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new Error("application error");
      }),
    ).rejects.toThrow("application error");
    expect(calls).toBe(1);
  });
});

describe("parseRetryAfter", () => {
  it("returns undefined for null", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5);
  });

  it("parses zero", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns undefined for malformed value", () => {
    expect(parseRetryAfter("invalid")).toBeUndefined();
  });

  it("parses HTTP-date in the future", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter(future)!;
    expect(result).toBeGreaterThan(8);
    expect(result).toBeLessThanOrEqual(11);
  });

  it("returns 0 for HTTP-date in the past", () => {
    const past = new Date(Date.now() - 5_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("returns undefined for empty string", () => {
    expect(parseRetryAfter("")).toBeUndefined();
  });
});

describe("isRetryableStatus", () => {
  it.each([408, 429, 500, 502, 503, 504])("returns true for %d", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 501, 505])("returns false for %d", (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

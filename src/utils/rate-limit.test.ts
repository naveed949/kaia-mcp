import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws if requestsPerSecond is not positive", () => {
    expect(() => createRateLimiter(0)).toThrow("must be positive");
    expect(() => createRateLimiter(-1)).toThrow("must be positive");
  });

  it("acquire() resolves immediately when tokens available", async () => {
    const limiter = createRateLimiter(10);
    const p = limiter.acquire();
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
  });

  it("allows up to requestsPerSecond acquires without waiting", async () => {
    const limiter = createRateLimiter(2);
    const p1 = limiter.acquire();
    const p2 = limiter.acquire();
    await vi.runAllTimersAsync();
    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined]);
  });

  it("excess acquire() waits until token refills", async () => {
    const limiter = createRateLimiter(2); // 2 per second => 1 token every 500ms
    const results: string[] = [];
    limiter.acquire().then(() => results.push("1"));
    limiter.acquire().then(() => results.push("2"));
    limiter.acquire().then(() => results.push("3")); // should wait
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual(["1", "2"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(results).toEqual(["1", "2", "3"]);
  });

  it("refills tokens over time", async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    const p = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeUndefined();
  });
});

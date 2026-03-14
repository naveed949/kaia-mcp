/**
 * Token-bucket rate limiter for RPC and KaiaScan (Phase 10).
 * acquire() waits until a token is available then resolves.
 */

export type RateLimiter = {
  acquire(): Promise<void>;
};

/**
 * Creates a simple token-bucket rate limiter.
 * @param requestsPerSecond - Max requests per second (tokens refill at this rate).
 * @returns Object with acquire() that resolves when a token is available.
 */
export function createRateLimiter(requestsPerSecond: number): RateLimiter {
  if (requestsPerSecond <= 0) {
    throw new Error("requestsPerSecond must be positive");
  }

  let tokens = requestsPerSecond;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(requestsPerSecond, tokens + elapsed * requestsPerSecond);
    lastRefill = now;
  }

  return {
    async acquire(): Promise<void> {
      return new Promise((resolve) => {
        function tryAcquire(): void {
          refill();
          if (tokens >= 1) {
            tokens -= 1;
            resolve();
            return;
          }
          const waitMs = ((1 - tokens) / requestsPerSecond) * 1000;
          setTimeout(tryAcquire, Math.max(1, Math.ceil(waitMs)));
        }
        tryAcquire();
      });
    },
  };
}

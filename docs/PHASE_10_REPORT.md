# Phase 10: Rate limiting + resilience

## Summary

Added token-bucket rate limiting for RPC and KaiaScan, request timeouts, and 429 handling with optional retry so the server is production-resilient.

## Files added/updated

### Added

- **src/utils/rate-limit.ts** – Token-bucket rate limiter: `createRateLimiter(requestsPerSecond)` returns `{ acquire(): Promise<void> }` that waits until a token is available then resolves. Used by RPC and KaiaScan clients.
- **src/utils/rate-limit.test.ts** – Unit tests: acquire allows requests up to limit, excess waits for refill, refill over time; mock timers used.

### Updated

- **src/config.ts** – Added optional `RPC_TIMEOUT_MS` (default 30000) and `KAIASCAN_TIMEOUT_MS` (default 15000). Config type includes `rpcTimeoutMs` and `kaiascanTimeoutMs`.
- **src/clients/rpc.ts** – RPC client now:
  - Uses a shared rate limiter (cached by `rateLimitRpc` value) and calls `acquire()` before each request via custom `fetchFn` passed to viem `http()`.
  - Sets `timeout` to `rpcTimeoutMs` (30s default) on the http transport.
  - Keeps `createRpcClient(network, config)` signature unchanged.
- **src/clients/kaiascan.ts** – KaiaScan client now:
  - Uses a shared rate limiter (cached by `rateLimitKaiascan`) and calls `acquire()` before each `get()`.
  - On 429: retries once after 1.5s delay; if still 429, throws `KaiaScanRateLimitError` (has `status: 429`), which `toMcpError()` maps to `-32003` (Rate limit).
  - Adds fetch timeout via `AbortController` and `KAIASCAN_TIMEOUT_MS` (15s default).
- **.env.example** – Documented optional `RPC_TIMEOUT_MS` and `KAIASCAN_TIMEOUT_MS`.
- **src/config.test.ts** – Backup/restore and default assertions for new timeout env vars.
- **src/clients/rpc.test.ts** – Config override includes `rpcTimeoutMs` and `kaiascanTimeoutMs`.
- **src/clients/kaiascan.test.ts** – Config override includes timeouts; added test that 429 after retry throws `KaiaScanRateLimitError` and that `toMcpError` maps it to `MCP_ERROR_CODES.RateLimit`.

## Config keys

| Key                   | Default | Description                          |
| --------------------- | ------- | ------------------------------------ |
| `RATE_LIMIT_RPC`      | 10      | Max RPC requests per second          |
| `RATE_LIMIT_KAIASCAN` | 5       | Max KaiaScan API requests per second |
| `RPC_TIMEOUT_MS`      | 30000   | RPC request timeout (ms)             |
| `KAIASCAN_TIMEOUT_MS` | 15000   | KaiaScan request timeout (ms)        |

## Behavior

- **RPC**: Every viem HTTP request goes through the RPC limiter’s `acquire()` and is subject to the configured timeout. Existing tests that mock `createRpcClient` are unchanged.
- **KaiaScan**: Every `get()` calls the KaiaScan limiter’s `acquire()`, uses `AbortController` for timeout, and on 429 retries once after 1.5s before throwing a rate-limit error that maps to MCP `-32003`.

## Deliverable

Rate-limited RPC and KaiaScan clients, timeouts, and 429 handling. Build and tests pass (134 tests).

/**
 * RPC client (viem public client) for Kaia mainnet and Kairos (Phase 2).
 * Read-only; rate-limited and timeout (Phase 10).
 */

import { createPublicClient, http, HttpRequestError } from "viem";
import type { Config } from "../config.js";
import type { KaiaNetwork } from "../chains.js";
import { getChain } from "../chains.js";
import { getConfig } from "../config.js";
import { createRateLimiter, type RateLimiter } from "../utils/rate-limit.js";
import {
  MAX_UPSTREAM_RESPONSE_BYTES,
  UpstreamResponseTooLargeError,
  fetchBounded,
} from "../utils/upstream-fetch.js";

const rpcLimiterCache = new Map<number, RateLimiter>();

function getRpcLimiter(requestsPerSecond: number) {
  let limiter = rpcLimiterCache.get(requestsPerSecond);
  if (!limiter) {
    limiter = createRateLimiter(requestsPerSecond);
    rpcLimiterCache.set(requestsPerSecond, limiter);
  }
  return limiter;
}

export type RpcClient = ReturnType<typeof createPublicClient>;

/**
 * An RPC response body over MAX_UPSTREAM_RESPONSE_BYTES, as viem sees it. An
 * HttpRequestError, so viem passes it on as it is. `code` is set only for viem's retry:
 * viem retries any transport error without a numeric code (3 more times by default, each
 * reading the body again), and none with a code it does not know. Callers never see it:
 * describeFailure finds the UpstreamResponseTooLargeError cause (-32005).
 */
class RpcResponseTooLargeError extends HttpRequestError {
  readonly code = 0;

  constructor(cause: UpstreamResponseTooLargeError, url: string) {
    super({ cause, url });
  }
}

/**
 * Creates a viem public client for the given network.
 * Uses getConfig() for RPC URL if config is not provided.
 * Each request is rate-limited and subject to RPC_TIMEOUT_MS (default 30s), which covers
 * reading the response body. A response body over MAX_UPSTREAM_RESPONSE_BYTES is refused
 * (-32005, not retried), and a redirect is not followed (an HTTP error, -32001).
 */
export function createRpcClient(network: KaiaNetwork, config?: Config): RpcClient {
  const c = config ?? getConfig();
  const url = network === "mainnet" ? c.kaiaRpcUrl : c.kaiaKairosRpcUrl;
  const chain = getChain(network);
  const limiter = getRpcLimiter(c.rateLimitRpc);
  const timeoutMs = c.rpcTimeoutMs ?? 30000;

  const transport = http(url, {
    timeout: timeoutMs,
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      await limiter.acquire();
      try {
        return await fetchBounded(input, init, "RPC");
      } catch (err) {
        if (err instanceof UpstreamResponseTooLargeError) {
          throw new RpcResponseTooLargeError(err, String(input));
        }
        throw err;
      }
    },
    // fetchBounded already holds the body under this; viem's own check is then a no-op.
    maxResponseBodySize: MAX_UPSTREAM_RESPONSE_BYTES,
  });

  return createPublicClient({
    chain,
    transport,
    // EIP-3668 offchain lookups (CCIP-read) off. With viem's default, an eth_call that
    // reverts with OffchainLookup makes the server fetch URLs the contract chose (SSRF to
    // internal services or cloud metadata, the response handed back to the caller), and
    // viem decodes the revert's string[] urls with no size bound before kaia's result caps
    // run (issue #11 P-1's amplification). Off, such a revert is an ordinary revert (-32001).
    ccipRead: false,
  });
}

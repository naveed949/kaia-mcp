/**
 * RPC client (viem public client) for Kaia mainnet and Kairos (Phase 2).
 * Read-only; rate-limited and timeout (Phase 10).
 */

import { createPublicClient, http } from "viem";
import type { Config } from "../config.js";
import type { KaiaNetwork } from "../chains.js";
import { getChain } from "../chains.js";
import { getConfig } from "../config.js";
import { createRateLimiter, type RateLimiter } from "../utils/rate-limit.js";

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
 * Creates a viem public client for the given network.
 * Uses getConfig() for RPC URL if config is not provided.
 * Each request is rate-limited and subject to RPC_TIMEOUT_MS (default 30s).
 */
export function createRpcClient(
  network: KaiaNetwork,
  config?: Config
): RpcClient {
  const c = config ?? getConfig();
  const url =
    network === "mainnet" ? c.kaiaRpcUrl : c.kaiaKairosRpcUrl;
  const chain = getChain(network);
  const limiter = getRpcLimiter(c.rateLimitRpc);
  const timeoutMs = c.rpcTimeoutMs ?? 30000;

  const transport = http(url, {
    timeout: timeoutMs,
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      await limiter.acquire();
      return fetch(input, init);
    },
  });

  return createPublicClient({
    chain,
    transport,
  });
}

/**
 * RPC client (viem public client) for Kaia mainnet and Kairos (Phase 2).
 * Read-only; no wallet/private key.
 */

import { createPublicClient, http } from "viem";
import type { Config } from "../config.js";
import type { KaiaNetwork } from "../chains.js";
import { getChain } from "../chains.js";
import { getConfig } from "../config.js";

export type RpcClient = ReturnType<typeof createPublicClient>;

/**
 * Creates a viem public client for the given network.
 * Uses getConfig() for RPC URL if config is not provided.
 */
export function createRpcClient(
  network: KaiaNetwork,
  config?: Config
): RpcClient {
  const c = config ?? getConfig();
  const url =
    network === "mainnet" ? c.kaiaRpcUrl : c.kaiaKairosRpcUrl;
  const chain = getChain(network);
  return createPublicClient({
    chain,
    transport: http(url),
  });
}

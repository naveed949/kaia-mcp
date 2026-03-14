/**
 * Shared validation for addresses and network (Phase 4).
 */

import { getAddress, type Address } from "viem";

export type KaiaNetwork = "mainnet" | "kairos";

const NETWORK_SET = new Set<KaiaNetwork>(["mainnet", "kairos"]);

/**
 * Validates and normalizes an Ethereum-style address (0x + 40 hex chars).
 * Returns the checksummed address or throws.
 */
export function validateAddress(address: unknown): Address {
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("Invalid address: must be a non-empty 0x-prefixed hex string (20 bytes).");
  }
  try {
    return getAddress(address.trim());
  } catch {
    throw new Error("Invalid address: must be a valid 0x-prefixed hex string (20 bytes).");
  }
}

/**
 * Validates network is "mainnet" or "kairos". Returns the value or throws.
 */
export function validateNetwork(network: unknown): KaiaNetwork {
  if (typeof network !== "string" || !network.trim()) {
    return "mainnet";
  }
  const n = network.trim().toLowerCase() as KaiaNetwork;
  if (!NETWORK_SET.has(n)) {
    throw new Error('Invalid network: must be "mainnet" or "kairos".');
  }
  return n;
}

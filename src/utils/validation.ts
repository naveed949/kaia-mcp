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

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

/**
 * Validates a transaction hash (0x + 64 hex chars). Returns trimmed string or throws.
 */
export function validateTxHash(txHash: unknown): `0x${string}` {
  if (typeof txHash !== "string" || !txHash.trim()) {
    throw new Error("Invalid transaction hash: must be 0x followed by 64 hex characters.");
  }
  const h = txHash.trim();
  if (!TX_HASH_REGEX.test(h)) {
    throw new Error("Invalid transaction hash: must be 0x followed by 64 hex characters.");
  }
  return h as `0x${string}`;
}

/**
 * Validates block number (positive integer or hex string) or block hash (0x + 64 hex).
 * Returns bigint for block number or 0x-prefixed hash string for getBlock.
 */
export function validateBlockNumberOrHash(
  blockNumberOrHash: unknown
): bigint | `0x${string}` {
  if (blockNumberOrHash === undefined || blockNumberOrHash === null) {
    throw new Error("Block number or hash is required.");
  }
  if (typeof blockNumberOrHash === "number") {
    if (!Number.isInteger(blockNumberOrHash) || blockNumberOrHash < 0) {
      throw new Error("Invalid block number: must be a non-negative integer.");
    }
    return BigInt(blockNumberOrHash);
  }
  if (typeof blockNumberOrHash === "string") {
    const s = blockNumberOrHash.trim();
    if (TX_HASH_REGEX.test(s)) {
      return s as `0x${string}`;
    }
    if (/^[0-9]+$/.test(s)) {
      return BigInt(s);
    }
    if (s.startsWith("0x") && /^0x[0-9a-fA-F]+$/.test(s)) {
      return BigInt(s);
    }
  }
  throw new Error(
    "Invalid block number or hash: must be a non-negative integer, hex block number (0x...), or block hash (0x + 64 hex)."
  );
}

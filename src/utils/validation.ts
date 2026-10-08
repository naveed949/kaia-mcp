/**
 * Shared validation for addresses and network (Phase 4).
 */

import { BaseError, encodeFunctionData, getAddress, type Abi, type Address } from "viem";
import { InvalidParamsError } from "./errors.js";

export type KaiaNetwork = "mainnet" | "kairos";

const NETWORK_SET = new Set<KaiaNetwork>(["mainnet", "kairos"]);

/**
 * Validates and normalizes an Ethereum-style address (0x + 40 hex chars).
 * Returns the checksummed address or throws.
 */
export function validateAddress(address: unknown): Address {
  if (typeof address !== "string" || !address.trim()) {
    throw new InvalidParamsError(
      "Invalid address: must be a non-empty 0x-prefixed hex string (20 bytes)."
    );
  }
  try {
    return getAddress(address.trim());
  } catch {
    throw new InvalidParamsError(
      "Invalid address: must be a valid 0x-prefixed hex string (20 bytes)."
    );
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
    throw new InvalidParamsError('Invalid network: must be "mainnet" or "kairos".');
  }
  return n;
}

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

/**
 * Validates a transaction hash (0x + 64 hex chars). Returns trimmed string or throws.
 */
export function validateTxHash(txHash: unknown): `0x${string}` {
  if (typeof txHash !== "string" || !txHash.trim()) {
    throw new InvalidParamsError(
      "Invalid transaction hash: must be 0x followed by 64 hex characters."
    );
  }
  const h = txHash.trim();
  if (!TX_HASH_REGEX.test(h)) {
    throw new InvalidParamsError(
      "Invalid transaction hash: must be 0x followed by 64 hex characters."
    );
  }
  return h as `0x${string}`;
}

/**
 * Validates block number (positive integer or hex string) or block hash (0x + 64 hex).
 * Returns bigint for block number or 0x-prefixed hash string for getBlock.
 */
export function validateBlockNumberOrHash(blockNumberOrHash: unknown): bigint | `0x${string}` {
  if (blockNumberOrHash === undefined || blockNumberOrHash === null) {
    throw new InvalidParamsError("Block number or hash is required.");
  }
  if (typeof blockNumberOrHash === "number") {
    if (!Number.isInteger(blockNumberOrHash) || blockNumberOrHash < 0) {
      throw new InvalidParamsError("Invalid block number: must be a non-negative integer.");
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
  throw new InvalidParamsError(
    "Invalid block number or hash: must be a non-negative integer, hex block number (0x...), or block hash (0x + 64 hex)."
  );
}

/**
 * Parses an ABI given as a JSON string or an array of ABI items (read_contract,
 * encode_function_data). Throws InvalidParamsError.
 */
export function parseAbiInput(abi: unknown): Abi {
  if (abi == null || (typeof abi !== "string" && !Array.isArray(abi))) {
    throw new InvalidParamsError("Invalid ABI: must be a JSON string or an array of ABI items.");
  }
  let parsed: unknown;
  if (typeof abi === "string") {
    const trimmed = abi.trim();
    if (!trimmed) throw new InvalidParamsError("Invalid ABI: empty string.");
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new InvalidParamsError("Invalid ABI: not valid JSON.");
    }
  } else {
    parsed = abi;
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidParamsError("Invalid ABI: must be an array of ABI items.");
  }
  return parsed as Abi;
}

/** A non-empty function name, trimmed. Throws InvalidParamsError. */
export function validateFunctionName(functionName: unknown): string {
  if (typeof functionName !== "string" || !functionName.trim()) {
    throw new InvalidParamsError("Invalid functionName: must be a non-empty string.");
  }
  return functionName.trim();
}

/** Optional call arguments: undefined/null, or an array. Throws InvalidParamsError. */
export function validateCallArgs(args: unknown): readonly unknown[] | undefined {
  if (args === undefined || args === null) return undefined;
  if (!Array.isArray(args)) {
    throw new InvalidParamsError("Invalid args: must be an array.");
  }
  return args;
}

/**
 * ABI-encodes a call from caller-supplied abi, functionName and args. Encoding is pure (no
 * I/O), so any failure (a function not on the ABI, an argument that does not fit its type,
 * a malformed ABI item) is the caller's: InvalidParamsError. viem's short message is kept
 * for the caller; other exception text is not passed on.
 */
export function encodeCallData(
  abi: Abi,
  functionName: string,
  args: readonly unknown[] | undefined
): `0x${string}` {
  try {
    return encodeFunctionData({ abi, functionName, args });
  } catch (err) {
    const detail =
      err instanceof BaseError
        ? err.shortMessage
        : "the abi, functionName and args could not be encoded.";
    throw new InvalidParamsError(`Invalid arguments: ${detail}`);
  }
}

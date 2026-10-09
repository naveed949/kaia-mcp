/**
 * Shared validation for addresses and network (Phase 4).
 */

import { getAddress, type Address } from "viem";
import { MAX_ABI_NAME_LENGTH } from "./abi.js";
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

export {
  MAX_ABI_ITEMS,
  MAX_ABI_NAME_LENGTH,
  MAX_ABI_OVERLOADS,
  MAX_ABI_PARAMETERS,
  MAX_ABI_SIGNATURE_CHARS,
  MAX_ABI_TYPE_LENGTH,
  encodeCallData,
  parseAbiInput,
  requireDecodableOutputs,
  resolveAbiFunction,
  validateAbiFunctionTypes,
  type ParsedAbi,
  type ResolvedFunction,
} from "./abi.js";

/** A non-empty function name (or 0x selector), trimmed and length-capped. Throws InvalidParamsError. */
export function validateFunctionName(functionName: unknown): string {
  if (typeof functionName !== "string" || !functionName.trim()) {
    throw new InvalidParamsError("Invalid functionName: must be a non-empty string.");
  }
  const name = functionName.trim();
  if (name.length > MAX_ABI_NAME_LENGTH) {
    throw new InvalidParamsError(
      `Invalid functionName: longer than ${MAX_ABI_NAME_LENGTH} characters.`
    );
  }
  return name;
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
 * A wei amount for estimate_gas: undefined/null/"" (omitted), a non-negative bigint or
 * integer, a decimal digit string, or a 0x-hex string. Decimals ("1.5"), negatives and
 * non-hex text throw InvalidParamsError before any RPC call.
 */
export function validateWeiValue(value: unknown): bigint | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "bigint") {
    if (value < 0n) throw new InvalidParamsError("Invalid value: must be non-negative.");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new InvalidParamsError(
        "Invalid value: must be a non-negative integer, digit string, or 0x-hex."
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    if (/^0x[0-9a-fA-F]+$/i.test(s)) return BigInt(s);
    if (/^[0-9]+$/.test(s)) return BigInt(s);
    throw new InvalidParamsError(
      "Invalid value: must be a non-negative integer, digit string, or 0x-hex."
    );
  }
  throw new InvalidParamsError(
    "Invalid value: must be a non-negative integer, digit string, or 0x-hex."
  );
}

/**
 * Optional call data for estimate_gas: undefined / empty (omitted), or a 0x-prefixed hex
 * string of even length. Non-hex text such as "zz" throws InvalidParamsError before RPC.
 */
export function validateHexData(data: unknown): `0x${string}` | undefined {
  if (data === undefined || data === null || data === "") return undefined;
  if (typeof data !== "string") {
    throw new InvalidParamsError("Invalid data: must be a 0x-prefixed hex string.");
  }
  const s = data.trim();
  if (!s) return undefined;
  const hex = s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new InvalidParamsError("Invalid data: must be a 0x-prefixed hex string of even length.");
  }
  return hex as `0x${string}`;
}

/**
 * An NFT tokenId: a non-empty string or a non-negative integer. Objects (including ones
 * whose `toString` is not a function) throw InvalidParamsError before any KaiaScan call.
 */
export function validateTokenId(tokenId: unknown): string {
  if (tokenId === undefined || tokenId === null) {
    throw new InvalidParamsError("tokenId is required.");
  }
  if (typeof tokenId === "number") {
    if (!Number.isInteger(tokenId) || tokenId < 0) {
      throw new InvalidParamsError(
        "Invalid tokenId: must be a non-negative integer or a non-empty string."
      );
    }
    return String(tokenId);
  }
  if (typeof tokenId === "string") {
    const s = tokenId.trim();
    if (!s) throw new InvalidParamsError("tokenId is required.");
    return s;
  }
  if (typeof tokenId === "bigint") {
    if (tokenId < 0n) {
      throw new InvalidParamsError(
        "Invalid tokenId: must be a non-negative integer or a non-empty string."
      );
    }
    return tokenId.toString();
  }
  throw new InvalidParamsError(
    "Invalid tokenId: must be a non-negative integer or a non-empty string."
  );
}

/**
 * An optional page / size / limit number. Numbers and numeric strings keep the tools'
 * lenient handling (the caller clamps and defaults); any other type (an object, array or
 * boolean) throws InvalidParamsError instead of a raw TypeError from Number().
 */
export function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  throw new InvalidParamsError(`Invalid ${name}: must be a number.`);
}

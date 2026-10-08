/**
 * Shared validation for addresses and network (Phase 4).
 */

import {
  BaseError,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  type Abi,
  type AbiFunction,
  type Address,
} from "viem";
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
 * The ABI function a call names: by name (overloads resolved by `args`, as viem does) or by
 * 4-byte selector. Throws InvalidParamsError when there is none. viem's encodeFunctionData
 * on its own treats any 0x-prefixed name as a raw selector ("0xzz" encodes to garbage),
 * while decoding the result looks the function up properly, so a read_contract would only
 * fail after the RPC call. Resolving once, up front, keeps both sides on the same item.
 */
export function resolveAbiFunction(
  abi: Abi,
  functionName: string,
  args: readonly unknown[] | undefined
): AbiFunction {
  let item: unknown;
  try {
    item = getAbiItem({ abi, name: functionName, args: args as never } as never);
  } catch {
    item = undefined;
  }
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function") {
    throw new InvalidParamsError(`Invalid arguments: Function "${functionName}" not found on ABI.`);
  }
  return item as AbiFunction;
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
    const item = resolveAbiFunction(abi, functionName, args);
    return encodeFunctionData({ abi: [item], functionName: item.name, args } as never);
  } catch (err) {
    if (err instanceof InvalidParamsError) throw err;
    const detail =
      err instanceof BaseError
        ? err.shortMessage
        : "the abi, functionName and args could not be encoded.";
    throw new InvalidParamsError(`Invalid arguments: ${detail}`);
  }
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

/**
 * Confirms every input and output parameter of an ABI function has a type viem can encode
 * and decode (elementary types, arrays of them, and `tuple` with valid `components`).
 * Encoding alone only checks the inputs, so a bogus `outputs` type would otherwise fail
 * after the RPC returns and look like a server fault. `requireOutputs` (read_contract): the
 * function must declare an `outputs` array, which viem decodes the result with.
 */
export function validateAbiFunctionTypes(
  fn: AbiFunction,
  options: { requireOutputs?: boolean } = {}
): void {
  const f = fn as unknown as { inputs?: unknown; outputs?: unknown };
  checkParams(f.inputs, "input");
  if (options.requireOutputs && !Array.isArray(f.outputs)) {
    throw new InvalidParamsError("Invalid ABI: the function has no outputs array.");
  }
  checkParams(f.outputs, "output");
}

function checkParams(params: unknown, kind: "input" | "output"): void {
  if (params === undefined || params === null) return;
  if (!Array.isArray(params)) {
    throw new InvalidParamsError(`Invalid ABI: function ${kind}s must be an array.`);
  }
  for (const p of params) checkParam(p, kind, 0);
}

const MAX_TUPLE_DEPTH = 32;
/**
 * Longest ABI parameter type accepted (`uint256[2][]`, `tuple[]`...; a tuple's members are
 * in `components`, not in the type). Far above any real type, and it bounds the work done
 * on caller text before any RPC call.
 */
export const MAX_ABI_TYPE_LENGTH = 256;

/**
 * `type` without its array suffixes (`T[]`, `T[3]`, `T[][2]` -> `T`): what repeatedly
 * removing a trailing `/\[\d*\]$/` gives, in one backward scan.
 */
function stripArraySuffixes(type: string): string {
  let end = type.length;
  while (end > 0 && type.charCodeAt(end - 1) === 0x5d /* ] */) {
    let i = end - 2;
    while (i >= 0 && type.charCodeAt(i) >= 0x30 && type.charCodeAt(i) <= 0x39) i--;
    if (i < 0 || type.charCodeAt(i) !== 0x5b /* [ */) break;
    end = i;
  }
  return type.slice(0, end);
}

function checkParam(param: unknown, kind: "input" | "output", depth: number): void {
  const bad = (why: string): never => {
    throw new InvalidParamsError(`Invalid ABI: ${kind} parameter ${why}.`);
  };
  if (!param || typeof param !== "object" || Array.isArray(param)) bad("must be an object");
  const { type, components } = param as { type?: unknown; components?: unknown };
  if (typeof type !== "string") return bad("has no type");
  if (type.length > MAX_ABI_TYPE_LENGTH) {
    bad(`has a type longer than ${MAX_ABI_TYPE_LENGTH} characters`);
  }
  const base = stripArraySuffixes(type.trim());
  if (base === "tuple") {
    if (depth >= MAX_TUPLE_DEPTH) bad("nests tuples too deeply");
    if (!Array.isArray(components)) bad('of type "tuple" needs a components array');
    for (const c of components as unknown[]) checkParam(c, kind, depth + 1);
    return;
  }
  if (!isElementaryType(base)) bad(`has unknown type "${type.slice(0, 64)}"`);
}

// viem's own patterns (viem/utils/regex): what encodeAbiParameters / decodeAbiParameters take.
const BYTES_N = /^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])$/;
const INT_N =
  /^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/;

/** An elementary Solidity ABI type viem can encode and decode. */
function isElementaryType(t: string): boolean {
  return (
    t === "address" ||
    t === "bool" ||
    t === "string" ||
    t === "bytes" ||
    BYTES_N.test(t) ||
    INT_N.test(t)
  );
}

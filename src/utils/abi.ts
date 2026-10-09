/**
 * Caller ABIs (read_contract, encode_function_data): parsed into kaia's own strictly typed
 * copy at the boundary, resolved by kaia, and only the one resolved function is handed to
 * viem (PR #9 round 5).
 *
 * Rounds 3 and 4 passed the caller's object graph to viem minus some known-bad shapes, and
 * every verify found another shape: array-like `inputs` (`{"length":1,"0":…}`) reached viem's
 * O(n²) type regex, names given as arrays were joined and hashed, and viem's overload
 * matching costs components × argument values on a tuple overload. viem treats anything
 * with a `length` as an array and anything with a `name` as a name, so a blocklist cannot
 * keep up. Now:
 * - parseAbiInput copies only known fields into fresh plain objects: real arrays (never
 *   array-likes), string names, item types and state mutability from allowlists, and
 *   parameter types from a strict, linear grammar (elementary types and `tuple`, with array
 *   suffixes). Anything else is refused (-32602) or, for a type the grammar does not know
 *   (`function`, `Lib.S storage`, `fixed128x18`), the item is set aside: it cannot be called,
 *   but it does not make the rest of the ABI unusable. Counts, nesting and characters are
 *   capped on the copy, so every string is counted.
 * - resolveAbiFunction finds the function by 4-byte selector (computed from the copy) or by
 *   name, then by argument count, then with a linear port of viem's argument-to-type match
 *   (same choice as viem, without its components × values cost).
 * - viem only ever gets `[fn]`: one fresh, canonical function item.
 */

import {
  BaseError,
  encodeFunctionData,
  keccak256,
  stringToBytes,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import { InvalidParamsError } from "./errors.js";

/**
 * Most items a caller ABI may have. Of 73 real ABIs (Seaport, Uniswap v4, Safe, Kaia system
 * contracts...) the largest has 136; a 4 MB body could hold ~10^6 tiny ones.
 */
export const MAX_ABI_ITEMS = 4096;
/**
 * Most parameters (inputs, outputs and tuple components, at every depth, over all items) a
 * caller ABI may have. The most in those real ABIs is 470 (Seaport 1.6).
 */
export const MAX_ABI_PARAMETERS = 32_768;
/** Longest item or parameter name (and functionName) accepted; real names are well under 100. */
export const MAX_ABI_NAME_LENGTH = 1024;
/**
 * Most characters of item names, parameter names and parameter types a caller ABI may have
 * in all (every one of them a string; nothing else is read). Seaport 1.6 needs about 9 K.
 */
export const MAX_ABI_SIGNATURE_CHARS = 262_144;
/**
 * Most functions one call may choose between (overloads of a name, or functions with one
 * selector). Real ABIs have at most a few (Uniswap v4 PoolManager's `extsload`: 3).
 */
export const MAX_ABI_OVERLOADS = 16;
/**
 * Longest parameter type accepted (`uint256[2][]`, `tuple[]`...; a tuple's members are in
 * `components`, not in the type). The longest in the real ABIs checked is 9 characters.
 */
export const MAX_ABI_TYPE_LENGTH = 256;
/** Deepest tuple nesting accepted (`components` inside `components`...). */
export const MAX_TUPLE_DEPTH = 32;

const ITEM_TYPES = new Set(["function", "event", "error", "constructor", "fallback", "receive"]);
const STATE_MUTABILITIES = new Set(["pure", "view", "nonpayable", "payable"]);
/** A Solidity identifier: what a function name can be (and what viem can format and hash). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One parameter, kaia's copy. `base`/`dims` are the parsed type (`uint8[2][]`: uint8, 2). */
interface Param {
  readonly name?: string;
  readonly type: string;
  readonly base: string;
  readonly dims: number;
  readonly components?: readonly Param[];
}

/** A function from the caller's ABI, copied. `unsupported`: why it cannot be called. */
interface FunctionEntry {
  readonly name: string;
  readonly inputs: readonly Param[] | undefined;
  readonly outputs: readonly Param[] | undefined;
  readonly stateMutability?: string;
  /** Why the inputs cannot be encoded (a type the grammar does not know), if so. */
  readonly unsupported?: string;
  /** Why the outputs cannot be decoded, if so (matters only to read_contract). */
  readonly outputsUnsupported?: string;
  selector?: string;
}

/** A caller ABI after parseAbiInput: kaia's copy of its functions. Nothing else is kept. */
export interface ParsedAbi {
  readonly functions: readonly FunctionEntry[];
}

/** The resolved function: a fresh viem AbiFunction plus what read_contract needs to know. */
export interface ResolvedFunction {
  readonly item: AbiFunction;
  readonly hasOutputs: boolean;
  readonly outputsUnsupported?: string;
}

const invalid = (msg: string): InvalidParamsError => new InvalidParamsError(`Invalid ABI: ${msg}`);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own property only (never one inherited, never a getter on a class instance). */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

type Budget = { params: number; chars: number };

function spend(budget: Budget, s: string): void {
  budget.chars += s.length;
  if (budget.chars > MAX_ABI_SIGNATURE_CHARS) {
    throw invalid(`more than ${MAX_ABI_SIGNATURE_CHARS} characters of names and types.`);
  }
}

/** An optional name: absent, or a string of at most MAX_ABI_NAME_LENGTH characters (counted). */
function readName(v: unknown, what: "item" | "parameter", budget: Budget): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`${what} name must be a string.`);
  if (v.length > MAX_ABI_NAME_LENGTH) {
    throw invalid(`${what} name longer than ${MAX_ABI_NAME_LENGTH} characters.`);
  }
  spend(budget, v);
  return v;
}

// --- The parameter type grammar ---------------------------------------------------------
//
//   type     := base suffix*
//   base     := "address" | "bool" | "string" | "bytes" | "bytes" M | "int" N? | "uint" N?
//             | "tuple"                          (M: 1..32; N: 8..256, a multiple of 8)
//   suffix   := "[" digit* "]"
//
// What viem can encode and decode, and nothing else (no whitespace, no aliases other than
// int/uint, which viem accepts). Checked in one left-to-right pass; no regex backtracking.

/** `type` parsed as base + array suffix count, or undefined when the grammar refuses it. */
export function parseParamType(type: string): { base: string; dims: number } | undefined {
  let end = 0;
  while (end < type.length) {
    const c = type.charCodeAt(end);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) end++;
    else break;
  }
  const base = type.slice(0, end);
  if (!isBaseType(base)) return undefined;
  let dims = 0;
  let i = end;
  while (i < type.length) {
    if (type.charCodeAt(i) !== 0x5b /* [ */) return undefined;
    i++;
    while (i < type.length && type.charCodeAt(i) >= 0x30 && type.charCodeAt(i) <= 0x39) i++;
    if (i >= type.length || type.charCodeAt(i) !== 0x5d /* ] */) return undefined;
    i++;
    dims++;
  }
  return { base, dims };
}

function isBaseType(t: string): boolean {
  switch (t) {
    case "address":
    case "bool":
    case "string":
    case "bytes":
    case "tuple":
    case "int":
    case "uint":
      return true;
  }
  if (t.startsWith("bytes")) return isDecimalIn(t.slice(5), 1, 32, 1);
  if (t.startsWith("uint")) return isDecimalIn(t.slice(4), 8, 256, 8);
  if (t.startsWith("int")) return isDecimalIn(t.slice(3), 8, 256, 8);
  return false;
}

/** `s` is a decimal with no leading zero, in [min, max], a multiple of `step`. */
function isDecimalIn(s: string, min: number, max: number, step: number): boolean {
  if (s.length === 0 || s.length > 3 || s[0] === "0") return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  const n = Number(s);
  return n >= min && n <= max && n % step === 0;
}

// --- Parsing: the caller's JSON into kaia's copy ----------------------------------------

/** Where an unsupported type was found (the first one), for the message. */
type Unsupported = { why?: string };

/**
 * A parameter list: absent, or a real array of plain objects (never an array-like), each
 * with a string `type` of at most MAX_ABI_TYPE_LENGTH characters, an optional string name
 * and, when present, real-array `components` (nested at most MAX_TUPLE_DEPTH deep). A type
 * outside the grammar is recorded in `bad` (the item cannot be called) instead of refused.
 */
function readParams(
  v: unknown,
  field: "inputs" | "outputs" | "components",
  budget: Budget,
  depth: number,
  bad: Unsupported
): Param[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw invalid(`${field} must be an array.`);
  if (depth > MAX_TUPLE_DEPTH) throw invalid("parameter nests tuples too deeply.");
  budget.params += v.length;
  if (budget.params > MAX_ABI_PARAMETERS) {
    throw invalid(`more than ${MAX_ABI_PARAMETERS} parameters.`);
  }
  const out: Param[] = [];
  for (let i = 0; i < v.length; i++) {
    const p: unknown = v[i];
    if (!isPlainObject(p)) throw invalid("every parameter must be an object.");
    const type = own(p, "type");
    if (typeof type !== "string") throw invalid("parameter has no type.");
    if (type.length > MAX_ABI_TYPE_LENGTH) {
      throw invalid(`parameter has a type longer than ${MAX_ABI_TYPE_LENGTH} characters.`);
    }
    const name = readName(own(p, "name"), "parameter", budget);
    spend(budget, type);
    const components = readParams(own(p, "components"), "components", budget, depth + 1, bad);
    const parsed = parseParamType(type);
    if (!parsed) {
      bad.why ??= `has unknown type "${type.slice(0, 64)}"`;
      out.push({ name, type, base: "", dims: 0 });
      continue;
    }
    if (parsed.base === "tuple" && !components) {
      bad.why ??= 'of type "tuple" needs a components array';
    }
    out.push({
      ...(name === undefined ? {} : { name }),
      type,
      base: parsed.base,
      dims: parsed.dims,
      ...(parsed.base === "tuple" && components ? { components } : {}),
    });
  }
  return out;
}

/**
 * Parses a caller ABI (a JSON string or an array of ABI items) into kaia's own copy. Every
 * item must be a plain object with a `type` from the allowlist; only the fields kaia uses are
 * read (`type`, `name`, `inputs`, `outputs`, `stateMutability`, and per parameter `name`,
 * `type`, `components`). Throws InvalidParamsError. Linear in the input.
 */
export function parseAbiInput(abi: unknown): ParsedAbi {
  if (abi == null || (typeof abi !== "string" && !Array.isArray(abi))) {
    throw invalid("must be a JSON string or an array of ABI items.");
  }
  let parsed: unknown;
  if (typeof abi === "string") {
    const trimmed = abi.trim();
    if (!trimmed) throw invalid("empty string.");
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw invalid("not valid JSON.");
    }
  } else {
    parsed = abi;
  }
  if (!Array.isArray(parsed)) throw invalid("must be an array of ABI items.");
  if (parsed.length > MAX_ABI_ITEMS) throw invalid(`more than ${MAX_ABI_ITEMS} items.`);
  const budget: Budget = { params: 0, chars: 0 };
  const functions: FunctionEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item: unknown = parsed[i];
    if (!isPlainObject(item)) throw invalid("every ABI item must be an object.");
    const type = own(item, "type");
    if (typeof type !== "string" || !ITEM_TYPES.has(type)) {
      throw invalid(
        "every item type must be one of function, event, error, constructor, fallback, receive."
      );
    }
    const name = readName(own(item, "name"), "item", budget);
    const sm = own(item, "stateMutability");
    if (sm !== undefined && (typeof sm !== "string" || !STATE_MUTABILITIES.has(sm))) {
      throw invalid("stateMutability must be one of pure, view, nonpayable, payable.");
    }
    const badIn: Unsupported = {};
    const badOut: Unsupported = {};
    const inputs = readParams(own(item, "inputs"), "inputs", budget, 0, badIn);
    const outputs = readParams(own(item, "outputs"), "outputs", budget, 0, badOut);
    if (type !== "function") continue; // counted and checked; never called, never kept
    if (name === undefined) throw invalid("every function needs a name.");
    // `unsupported`: the whole message tail, for when this function is the one called.
    let unsupported = badIn.why ? `input parameter ${badIn.why}` : undefined;
    if (!IDENTIFIER.test(name)) unsupported ??= "name is not a Solidity identifier";
    functions.push({
      name,
      inputs,
      outputs,
      ...(typeof sm === "string" ? { stateMutability: sm } : {}),
      ...(unsupported ? { unsupported } : {}),
      ...(badOut.why ? { outputsUnsupported: badOut.why } : {}),
    });
  }
  return { functions };
}

// --- Selectors -----------------------------------------------------------------------------

/** The canonical type of a parameter in a signature: tuples spelled out, as viem formats it. */
function signatureType(p: Param): string {
  if (p.base !== "tuple") return p.type;
  return `(${(p.components ?? []).map(signatureType).join(",")})${p.type.slice(5)}`;
}

/** `name(type,…)`'s 4-byte selector (computed once per function, from kaia's copy). */
function selectorOf(f: FunctionEntry): string {
  if (f.selector === undefined) {
    const sig = `${f.name}(${(f.inputs ?? []).map(signatureType).join(",")})`;
    f.selector = keccak256(stringToBytes(sig)).slice(0, 10);
  }
  return f.selector;
}

const SELECTOR = /^0[xX][0-9a-fA-F]{8}$/;

// --- Argument-to-type match (viem's getAbiItem rule, linear) -------------------------------

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const isAddressArg = (v: unknown): boolean => typeof v === "string" && ADDRESS.test(v);

/**
 * viem's isArgOfType for one parameter, `dims` array suffixes still to strip. Same result as
 * viem's for kaia's grammar, except that a tuple value is listed once (viem lists it once
 * per component) and one with fewer values than components fails at once: one pass over the
 * argument, however many components the tuple has.
 */
function argFits(arg: unknown, p: Param, dims: number): boolean {
  if (dims > 0) {
    if (!Array.isArray(arg)) return false;
    for (const x of arg) if (!argFits(x, p, dims - 1)) return false;
    return true;
  }
  switch (p.base) {
    case "address":
      return isAddressArg(arg);
    case "bool":
      return typeof arg === "boolean";
    case "string":
      return typeof arg === "string";
    case "tuple": {
      const comps = p.components ?? [];
      if (comps.length === 0) return true;
      if (arg === null || typeof arg !== "object") return false;
      const values = Array.isArray(arg) ? arg : Object.values(arg as Record<string, unknown>);
      if (values.length < comps.length) return false;
      for (let i = 0; i < comps.length; i++) {
        if (!argFits(values[i], comps[i], comps[i].dims)) return false;
      }
      return true;
    }
  }
  if (p.base.startsWith("bytes")) return typeof arg === "string" || arg instanceof Uint8Array;
  return typeof arg === "number" || typeof arg === "bigint"; // int, uint
}

/** viem's getAmbiguousTypes: the two types that make two matching overloads ambiguous. */
function ambiguousTypes(
  a: readonly Param[],
  b: readonly Param[],
  args: unknown
): [string, string] | undefined {
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    const t = b[i];
    if (!t) return undefined;
    const arg =
      args !== null && typeof args === "object" ? (args as Record<number, unknown>)[i] : undefined;
    if (s.type === "tuple" && t.type === "tuple") {
      return ambiguousTypes(s.components ?? [], t.components ?? [], arg);
    }
    const types = [s.type, t.type];
    const has = (x: string) => types.includes(x);
    if (
      (has("address") && has("bytes20")) ||
      (has("address") && (has("string") || has("bytes")) && isAddressArg(arg))
    ) {
      return [s.type, t.type];
    }
  }
  return undefined;
}

function signatureOf(f: FunctionEntry): string {
  return `${f.name}(${(f.inputs ?? []).map(signatureType).join(",")})`;
}

function toViemParam(p: Param): AbiParameter {
  return {
    ...(p.name === undefined ? {} : { name: p.name }),
    type: p.type,
    ...(p.components ? { components: p.components.map(toViemParam) } : {}),
  } as AbiParameter;
}

/** A fresh viem AbiFunction built from kaia's copy: the only ABI object viem ever sees. */
function toViemFunction(f: FunctionEntry): AbiFunction {
  return {
    type: "function",
    name: f.name,
    inputs: (f.inputs ?? []).map(toViemParam),
    outputs: f.outputsUnsupported ? [] : (f.outputs ?? []).map(toViemParam),
    stateMutability: (f.stateMutability ?? "nonpayable") as AbiFunction["stateMutability"],
  };
}

/**
 * The function a call names: by 4-byte selector (`0x` + 8 hex digits, any case) or by name,
 * then chosen among overloads as viem's getAbiItem chooses (argument count, then each
 * argument against its type; of several matches the last, unless viem would call them
 * ambiguous), in linear time. When no overload's types match the args, the first with as
 * many inputs as there are args is used (viem: the first overload, which fails to encode
 * when its input count differs). Throws InvalidParamsError.
 */
export function resolveAbiFunction(
  abi: ParsedAbi,
  functionName: string,
  args: readonly unknown[] | undefined
): ResolvedFunction {
  const notFound = (extra = "") =>
    new InvalidParamsError(
      `Invalid arguments: Function "${functionName.slice(0, 80)}" not found on ABI.${extra}`
    );
  let candidates: FunctionEntry[];
  let skipped: FunctionEntry | undefined;
  if (functionName.startsWith("0x") || functionName.startsWith("0X")) {
    if (!SELECTOR.test(functionName)) {
      throw notFound(" A selector is 0x followed by 8 hex digits.");
    }
    const sel = functionName.toLowerCase();
    candidates = abi.functions.filter((f) => !f.unsupported && selectorOf(f) === sel);
  } else {
    const named = abi.functions.filter((f) => f.name === functionName);
    candidates = named.filter((f) => !f.unsupported);
    skipped = named.find((f) => f.unsupported);
  }
  if (candidates.length === 0) {
    if (skipped) {
      throw invalid(
        `${skipped.unsupported}, so function "${skipped.name.slice(0, 80)}" is not supported (parameter types: address, bool, string, bytes, bytes1-32, int, uint, int8-256, uint8-256, tuple, and arrays of these).`
      );
    }
    throw notFound();
  }
  if (candidates.length > MAX_ABI_OVERLOADS) {
    throw invalid(`more than ${MAX_ABI_OVERLOADS} items match the function name or selector.`);
  }
  const argList = args ?? [];
  let chosen: FunctionEntry | undefined;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    const sameArity = candidates.filter((f) => (f.inputs?.length ?? 0) === argList.length);
    if (argList.length === 0) {
      chosen = sameArity[0];
    } else {
      let matched: FunctionEntry | undefined;
      for (const f of sameArity) {
        const inputs = f.inputs ?? [];
        let fits = true;
        try {
          for (let i = 0; i < inputs.length && fits; i++) {
            fits = argFits(argList[i], inputs[i], inputs[i].dims);
          }
        } catch {
          fits = false; // an argument nested deeper than the stack: it does not fit
        }
        if (!fits) continue;
        if (matched) {
          const amb = ambiguousTypes(inputs, matched.inputs ?? [], argList);
          if (amb) {
            throw new InvalidParamsError(
              `Invalid arguments: the args fit more than one overload of "${f.name}" (${signatureOf(matched)} and ${signatureOf(f)}: "${amb[1]}" vs "${amb[0]}" is ambiguous). Call it by selector instead: ${selectorOf(matched)} or ${selectorOf(f)}.`
            );
          }
        }
        matched = f;
      }
      chosen = matched ?? sameArity[0];
    }
    chosen ??= candidates[0];
  }
  return {
    item: toViemFunction(chosen),
    hasOutputs: chosen.outputs !== undefined,
    ...(chosen.outputsUnsupported ? { outputsUnsupported: chosen.outputsUnsupported } : {}),
  };
}

/**
 * read_contract decodes the result with the function's outputs: they must be declared and
 * every type decodable, checked here rather than after the RPC returns.
 */
export function requireDecodableOutputs(fn: ResolvedFunction): void {
  if (!fn.hasOutputs) throw invalid("the function has no outputs array.");
  if (fn.outputsUnsupported) {
    throw invalid(`output parameter ${fn.outputsUnsupported}.`);
  }
}

/** Longest part of a viem encode error passed on to the caller. */
const MAX_ENCODE_ERROR_DETAIL = 256;

/**
 * ABI-encodes a call to the resolved function. Encoding is pure (no I/O), so any failure
 * (an argument that does not fit its type) is the caller's: InvalidParamsError with viem's
 * short message; other exception text is not passed on.
 */
export function encodeCallData(
  fn: ResolvedFunction,
  args: readonly unknown[] | undefined
): `0x${string}` {
  try {
    return encodeFunctionData({ abi: [fn.item], functionName: fn.item.name, args } as never);
  } catch (err) {
    if (err instanceof InvalidParamsError) throw err;
    const detail =
      err instanceof BaseError
        ? err.shortMessage
        : "the abi, functionName and args could not be encoded.";
    // viem's message quotes the offending argument whole (a 1 MB string, a joined array).
    const cut =
      detail.length > MAX_ENCODE_ERROR_DETAIL
        ? `${detail.slice(0, MAX_ENCODE_ERROR_DETAIL)}…`
        : detail;
    throw new InvalidParamsError(`Invalid arguments: ${cut}`);
  }
}

/**
 * Checks one ABI function's input and output types against the grammar (and, for
 * read_contract, that it declares outputs). Kept for callers holding a raw ABI function;
 * the tools use parseAbiInput, which applies the same rules to every item.
 */
export function validateAbiFunctionTypes(
  fn: AbiFunction,
  options: { requireOutputs?: boolean } = {}
): void {
  const f = fn as unknown as { inputs?: unknown; outputs?: unknown };
  checkList(f.inputs, "input");
  if (options.requireOutputs && !Array.isArray(f.outputs)) {
    throw invalid("the function has no outputs array.");
  }
  checkList(f.outputs, "output");
}

function checkList(params: unknown, kind: "input" | "output"): void {
  if (params === undefined || params === null) return;
  if (!Array.isArray(params)) throw invalid(`function ${kind}s must be an array.`);
  const budget: Budget = { params: 0, chars: 0 };
  const bad: Unsupported = {};
  const prefix = (m: string) => m.replace(/^Invalid ABI: /, `Invalid ABI: ${kind} `);
  try {
    readParams(params, kind === "input" ? "inputs" : "outputs", budget, 0, bad);
  } catch (e) {
    if (e instanceof InvalidParamsError && /^Invalid ABI: parameter /.test(e.message)) {
      throw new InvalidParamsError(prefix(e.message));
    }
    throw e;
  }
  if (bad.why) throw invalid(`${kind} parameter ${bad.why}.`);
}

/**
 * Size caps for read_contract results (issue #11 P-1).
 *
 * The ABI encoding lets many offsets point at the same data: 4,000 elements of a `string[]`
 * or `bytes[]` can all point at one 64 KB string, so a 193 KB eth_call result decodes to
 * 262 MB (and a `bytes[]` one ran the server out of memory). viem's decoder bounds how often
 * one position is re-read (8,192 times), not how much it produces.
 *
 * So before viem decodes anything, checkResultSize walks the result the way viem's
 * decodeAbiParameters does (same offsets, same bounds checks) without building any value,
 * and adds up how long the result's text will be. A payload is counted every time an offset
 * refers to it, so aliasing cannot amplify past the cap, and the walk stops as soon as a cap
 * is passed, so it does at most about MAX_RESULT_CHARS steps whatever the result holds.
 */

import { hexToBytes, type AbiParameter, type Hex } from "viem";

/**
 * Most bytes an eth_call result may have, checked before anything is decoded. The largest
 * result the args cap lets Multicall3 return (aggregate3 of about 9,000 balanceOf calls) is
 * about 1.44 MB; of 130 real ABIs, no getter returns anything near this.
 */
export const MAX_RESULT_BYTES = 2_097_152;
/**
 * Most characters the decoded result's text (JSON, 2-space indent) may have: twice
 * MAX_RESULT_BYTES, so the largest `bytes` value (two hex digits a byte) still fits. Text
 * this long takes viem about 0.2-0.35 s to produce when it is all `bytes` (the slowest kind,
 * per character, apart from addresses).
 */
export const MAX_RESULT_CHARS = 4_194_304;
/**
 * Most addresses a decoded result may hold. viem checksums each distinct one (a keccak
 * hash, about 20 µs here): 16,384 took 0.3-0.38 s and 131,000 (one 4 MB result) 2.6 s.
 */
export const MAX_RESULT_ADDRESSES = 8_192;

export interface ResultLimits {
  readonly bytes: number;
  readonly chars: number;
  readonly addresses: number;
}

export const RESULT_LIMITS: ResultLimits = {
  bytes: MAX_RESULT_BYTES,
  chars: MAX_RESULT_CHARS,
  addresses: MAX_RESULT_ADDRESSES,
};

/**
 * A contract call result over one of the caps above. Server-side (the result comes from the
 * contract or the RPC node, not from the request), so it is not -32602; it answers -32005
 * with this fixed, kaia-authored message naming the limit.
 */
export class ResultTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultTooLargeError";
  }
}

/** Data that viem's decoder would refuse too (an offset or length out of bounds). */
export class ResultDecodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultDecodingError";
  }
}

/**
 * One output type, parsed once (viem re-parses the type string for every element). `size`
 * is the bytes the value takes in place: 32 (an offset) when dynamic.
 */
type Node =
  | { kind: "array"; length: number | null; child: Node; dynamic: boolean; size: number }
  | {
      kind: "tuple";
      fields: readonly Node[];
      keyChars: readonly number[] | null;
      dynamic: boolean;
      size: number;
    }
  | { kind: "address" | "bool" | "string" | "bytes"; dynamic: boolean; size: 32 }
  | { kind: "fixedBytes"; bytes: number; dynamic: false; size: 32 }
  | { kind: "int"; signed: boolean; dynamic: false; size: 32 };

/** viem's getArrayComponents: the last `[N]` or `[]` suffix of a type. */
const ARRAY_SUFFIX = /^(.*)\[(\d+)?\]$/;

function parseNode(p: AbiParameter): Node {
  const m = ARRAY_SUFFIX.exec(p.type);
  if (m) {
    const child = parseNode({ ...p, type: m[1] } as AbiParameter);
    const length = m[2] ? Number(m[2]) : null;
    const dynamic = length === null || child.dynamic;
    return { kind: "array", length, child, dynamic, size: dynamic ? 32 : length! * child.size };
  }
  if (p.type === "tuple") {
    const components = (p as { components?: readonly AbiParameter[] }).components ?? [];
    const fields = components.map(parseNode);
    const dynamic = fields.some((f) => f.dynamic);
    // viem: an unnamed (or empty) tuple decodes to an array, a named one to an object.
    const named = components.length > 0 && components.every((c) => c.name);
    return {
      kind: "tuple",
      fields,
      keyChars: named ? components.map((c) => JSON.stringify(c.name).length + 2) : null,
      dynamic,
      size: dynamic ? 32 : fields.reduce((n, f) => n + f.size, 0),
    };
  }
  if (p.type === "address" || p.type === "bool") {
    return { kind: p.type, dynamic: false, size: 32 };
  }
  if (p.type === "string" || p.type === "bytes") return { kind: p.type, dynamic: true, size: 32 };
  if (p.type.startsWith("bytes")) {
    const bytes = Number.parseInt(p.type.slice(5), 10);
    return { kind: "fixedBytes", bytes, dynamic: false, size: 32 };
  }
  if (p.type.startsWith("uint") || p.type.startsWith("int")) {
    return { kind: "int", signed: p.type.startsWith("int"), dynamic: false, size: 32 };
  }
  // parseAbiInput only lets grammar types through; this is unreachable from read_contract.
  throw new ResultDecodingError(`unsupported output type "${p.type.slice(0, 64)}"`);
}

/**
 * JSON.stringify length of each byte of a string's UTF-8 data, as an upper bound: control
 * characters are escaped (`\n`: 2, `\u0001`: 6), `"` and `\` take 2, and every other byte
 * gives at most one UTF-16 unit (a multi-byte character, or U+FFFD for an invalid byte).
 */
const STRING_BYTE_CHARS = new Uint8Array(256).map((_, b) =>
  b < 0x20 ? ([8, 9, 10, 12, 13].includes(b) ? 2 : 6) : b === 0x22 || b === 0x5c ? 2 : 1
);

/** log10(2): an n-bit magnitude has at most floor(n * log10(2)) + 1 decimal digits. */
const LOG10_2 = 0.30103;

class Walk {
  chars = 0;
  addresses = 0;
  readonly bytes: Uint8Array;
  readonly limits: ResultLimits;

  constructor(bytes: Uint8Array, limits: ResultLimits) {
    this.bytes = bytes;
    this.limits = limits;
  }

  spend(n: number): void {
    this.chars += n;
    if (this.chars > this.limits.chars) {
      throw new ResultTooLargeError(
        `Contract call result is too large: its decoded text is over ${this.limits.chars} characters (the read_contract limit).`
      );
    }
  }

  /** viem's cursor.assertPosition: 0 <= position <= length - 1. */
  at(position: number): void {
    if (!(position >= 0 && position <= this.bytes.length - 1)) {
      throw new ResultDecodingError(
        `position ${position} is out of bounds (result is ${this.bytes.length} bytes)`
      );
    }
  }

  /** viem's readBytes(length) bounds check: the last byte read must be in the data. */
  readable(position: number, length: number): void {
    this.at(position + length - 1);
  }

  /** viem's bytesToNumber on a 32-byte word: a safe integer, or it throws. */
  uint(position: number): number {
    this.readable(position, 32);
    const b = this.bytes;
    for (let i = position; i < position + 25; i++) {
      if (b[i] !== 0) throw new ResultDecodingError(`offset or length at ${position} is too large`);
    }
    let v = 0;
    for (let i = position + 25; i < position + 32; i++) v = v * 256 + b[i];
    if (!Number.isSafeInteger(v)) {
      throw new ResultDecodingError(`offset or length at ${position} is too large`);
    }
    return v;
  }

  /**
   * Walks one value at `position` (viem's cursor position) and returns the bytes it takes in
   * place (viem's `consumed`). `staticPosition` is what offsets are relative to; `level` is
   * the value's indentation level in JSON.stringify(result, null, 2).
   */
  value(node: Node, position: number, staticPosition: number, level: number): number {
    switch (node.kind) {
      case "array":
        return this.array(node, position, staticPosition, level);
      case "tuple":
        return this.tuple(node, position, staticPosition, level);
      case "address":
        this.readable(position, 32);
        if (++this.addresses > this.limits.addresses) {
          throw new ResultTooLargeError(
            `Contract call result is too large: it holds over ${this.limits.addresses} addresses (the read_contract limit).`
          );
        }
        this.spend(44); // "0x" + 40 hex digits, quoted
        return 32;
      case "bool":
        this.readable(position, 32);
        this.spend(this.bytes[position + 31] === 1 ? 4 : 5); // true, false (or viem throws)
        return 32;
      case "int":
        this.readable(position, 32);
        this.spend(this.intChars(position, node.signed));
        return 32;
      case "fixedBytes":
        this.readable(position, node.bytes);
        this.spend(4 + 2 * node.bytes);
        return 32;
      case "string":
      case "bytes":
        return this.dynamicBytes(node.kind, position, staticPosition);
    }
  }

  /** Quoted decimal digits, with sign, of the integer in the word at `position` (upper bound). */
  intChars(position: number, signed: boolean): number {
    const b = this.bytes;
    const negative = signed && b[position] >= 0x80;
    // A negative two's-complement word's magnitude is ~word + 1, at most 2^bits(~word): the
    // same number of digits as 2^bits - 1 (a power of two is never a power of ten).
    const skip = negative ? 0xff : 0;
    let i = position;
    while (i < position + 32 && b[i] === skip) i++;
    let bits = 0;
    if (i < position + 32) {
      const top = negative ? ~b[i] & 0xff : b[i];
      bits = (position + 32 - i - 1) * 8 + (top === 0 ? 0 : 32 - Math.clz32(top));
    }
    return Math.floor(bits * LOG10_2) + 1 + (negative ? 1 : 0) + 2;
  }

  dynamicBytes(kind: "string" | "bytes", position: number, staticPosition: number): number {
    const offset = this.uint(position);
    const start = staticPosition + offset;
    this.at(start);
    const length = this.uint(start);
    if (length > 0) this.readable(start + 32, length);
    if (kind === "bytes") {
      this.spend(4 + 2 * length); // "0x" + two hex digits a byte, quoted
    } else {
      // Quotes and at least one character a byte, charged before the scan, which then reads
      // at most MAX_RESULT_CHARS bytes; then what escaping adds.
      this.spend(2 + length);
      const b = this.bytes;
      const room = this.limits.chars - this.chars;
      let extra = 0;
      for (let i = start + 32, end = start + 32 + length; i < end && extra <= room; i++) {
        extra += STRING_BYTE_CHARS[b[i]] - 1;
      }
      this.spend(extra);
    }
    this.at(staticPosition + 32);
    return 32;
  }

  /** Characters a container adds around `n` entries at `level`, beyond the entries. */
  frame(n: number, level: number): number {
    // "[" + n x ("\n" + indent of level + 1) + (n - 1) commas + "\n" + indent of level + "]"
    return n === 0 ? 2 : 2 + n * (1 + 2 * (level + 1)) + (n - 1) + 1 + 2 * level;
  }

  array(
    node: Extract<Node, { kind: "array" }>,
    position: number,
    staticPosition: number,
    level: number
  ): number {
    const child = node.child;
    if (node.length === null) {
      const offset = this.uint(position);
      const start = staticPosition + offset;
      const startOfData = start + 32;
      this.at(start);
      const length = this.uint(start);
      this.elementsInData(startOfData, length, child.dynamic ? 32 : child.size);
      this.spendFrame(length, level);
      let consumed = 0;
      for (let i = 0; i < length; i++) {
        // viem: i * 32 for a dynamic element, which takes 32 bytes (its offset) in place.
        const p = startOfData + consumed;
        this.at(p);
        consumed += this.value(child, p, startOfData, level + 1);
      }
      this.at(staticPosition + 32);
      return 32;
    }
    const length = node.length;
    if (child.dynamic) {
      const offset = this.uint(position);
      const start = staticPosition + offset;
      this.elementsInData(start, length, 32);
      this.spendFrame(length, level);
      for (let i = 0; i < length; i++) {
        this.at(start + i * 32);
        this.value(child, start + i * 32, start, level + 1);
      }
      this.at(staticPosition + 32);
      return 32;
    }
    // In place, without cursor moves: the last element with any data starts inside it.
    if (child.size > 0) this.elementsInData(position, length, child.size);
    this.spendFrame(length, level);
    let consumed = 0;
    for (let i = 0; i < length; i++) {
      consumed += this.value(child, position + consumed, staticPosition + consumed, level + 1);
    }
    return consumed;
  }

  /**
   * viem moves its cursor to each element of a dynamic array, and of a fixed array of
   * dynamic elements, and fails on the first position past the data (even for zero-width
   * elements). The last element's position is the largest; checked here, before the length
   * is charged, so a bogus length reads as bad data rather than a result over the cap.
   */
  elementsInData(start: number, length: number, stride: number): void {
    if (length > 0) this.at(start + (length - 1) * stride);
  }

  /**
   * Charges an array's frame before its elements are visited: at least 2 characters an
   * element, so a huge length (or a huge fixed length of zero-width elements, `uint8[0][]`)
   * is refused without a loop over it.
   */
  spendFrame(length: number, level: number): void {
    this.spend(this.frame(length, level));
  }

  tuple(
    node: Extract<Node, { kind: "tuple" }>,
    position: number,
    staticPosition: number,
    level: number
  ): number {
    const n = node.fields.length;
    this.spend(this.frame(n, level));
    if (node.keyChars) for (const k of node.keyChars) this.spend(k);
    let consumed = 0;
    if (node.dynamic) {
      const offset = this.uint(position);
      const start = staticPosition + offset;
      for (const field of node.fields) {
        this.at(start + consumed);
        consumed += this.value(field, start + consumed, start, level + 1);
      }
      this.at(staticPosition + 32);
      return 32;
    }
    for (const field of node.fields) {
      consumed += this.value(field, position + consumed, staticPosition, level + 1);
    }
    return consumed;
  }
}

/** Throws ResultTooLargeError when an eth_call result's hex is over MAX_RESULT_BYTES. */
export function checkResultBytes(data: Hex, limits: ResultLimits = RESULT_LIMITS): void {
  const size = Math.ceil((data.length - 2) / 2);
  if (size > limits.bytes) {
    throw new ResultTooLargeError(
      `Contract call result is too large: it is over ${limits.bytes} bytes (the read_contract limit).`
    );
  }
}

/**
 * Checks, before viem decodes `data` with `outputs`, that the decoded result stays within
 * the caps: throws ResultTooLargeError when it would not, and ResultDecodingError where
 * viem's decoder would fail on the data anyway. Returns an upper bound on the length of
 * JSON.stringify(result, replacer, 2) for the value read_contract prints.
 */
export function checkResultSize(
  outputs: readonly AbiParameter[],
  data: Hex,
  limits: ResultLimits = RESULT_LIMITS
): number {
  checkResultBytes(data, limits);
  const bytes = hexToBytes(data);
  const walk = new Walk(bytes, limits);
  const nodes = outputs.map(parseNode);
  // decodeAbiParameters' own checks: no data for outputs, or less than one word.
  if (bytes.length === 0 && nodes.length > 0) {
    throw new ResultDecodingError("the call returned no data");
  }
  if (bytes.length > 0 && bytes.length < 32) {
    throw new ResultDecodingError(`the call returned ${bytes.length} bytes, less than one word`);
  }
  // decodeFunctionResult returns one output bare, several as an array (and none as
  // undefined, printed "null").
  if (nodes.length === 0) return 4;
  if (nodes.length > 1) walk.spend(walk.frame(nodes.length, 0));
  const level = nodes.length > 1 ? 1 : 0;
  // viem's cursor: each output is read at `consumed`, unless that is past the end, when the
  // cursor stays where the last read left it (32 after a dynamic output, whose offset is
  // relative to 0).
  let consumed = 0;
  let cursor = 0;
  for (const node of nodes) {
    if (consumed < bytes.length) {
      walk.at(consumed);
      cursor = consumed;
    }
    const used = walk.value(node, cursor, 0, level);
    cursor = node.dynamic ? 32 : cursor + used;
    consumed += used;
  }
  return walk.chars;
}

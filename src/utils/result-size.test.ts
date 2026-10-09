import { describe, it, expect } from "vitest";
import { decodeFunctionResult, encodeAbiParameters, type AbiParameter, type Hex } from "viem";
import {
  MAX_RESULT_ADDRESSES,
  MAX_RESULT_BYTES,
  MAX_RESULT_CHARS,
  ResultDecodingError,
  ResultTooLargeError,
  checkResultBytes,
  checkResultSize,
} from "./result-size.js";
import { MCP_ERROR_CODES, describeFailure, toMcpError } from "./errors.js";
import { errorCategory } from "../server.js";

const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");

/** read_contract's text for a result (without the "Result:\n" prefix). */
function printed(outputs: readonly AbiParameter[], data: Hex): string {
  const fn = { type: "function", name: "f", inputs: [], outputs, stateMutability: "view" } as const;
  const result = decodeFunctionResult({ abi: [fn], functionName: "f", data } as never) as unknown;
  return result === undefined || result === null
    ? "null"
    : typeof result === "object"
      ? JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
      : String(result);
}

const LIMITS = {
  bytes: MAX_RESULT_BYTES,
  chars: MAX_RESULT_CHARS,
  addresses: MAX_RESULT_ADDRESSES,
};

describe("limits", () => {
  it("are 2 MiB of result, 4 Mi characters of text and 8192 addresses", () => {
    expect(LIMITS).toEqual({ bytes: 2_097_152, chars: 4_194_304, addresses: 8192 });
  });

  it("checkResultBytes counts bytes, not hex digits (an odd digit rounds up)", () => {
    const at = `0x${"00".repeat(1000)}` as Hex;
    expect(() => checkResultBytes(at, { ...LIMITS, bytes: 1000 })).not.toThrow();
    expect(() => checkResultBytes(`${at}0` as Hex, { ...LIMITS, bytes: 1000 })).toThrow(
      ResultTooLargeError
    );
  });
});

describe("the walk is an upper bound on the printed text (and never stricter than viem)", () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: readonly T[]): T => a[ri(a.length)];
  const hex = (n: number) =>
    `0x${Array.from({ length: n }, () => ri(256).toString(16).padStart(2, "0")).join("")}` as Hex;
  const ELEMENTARY = [
    "address", "bool", "string", "bytes", "uint8", "uint48", "uint256",
    "int8", "int40", "int256", "bytes1", "bytes20", "bytes32",
  ]; // prettier-ignore
  type P = { name?: string; type: string; components?: readonly P[] };
  const genType = (depth: number): P => {
    let t: P;
    if (depth < 3 && rnd() < 0.2) {
      const named = rnd() < 0.5;
      t = {
        type: "tuple",
        components: Array.from({ length: ri(4) }, (_, i) => ({
          ...genType(depth + 1),
          name: named ? `f${i}` : rnd() < 0.2 ? `x${i}` : "",
        })),
      };
    } else t = { type: pick(ELEMENTARY) };
    for (const p of [0.4, 0.15]) {
      if (depth < 3 && rnd() < p) t = { ...t, type: `${t.type}[${rnd() < 0.5 ? "" : ri(4)}]` };
    }
    return t;
  };
  const genVal = (p: P): unknown => {
    const m = /^(.*)\[(\d+)?\]$/.exec(p.type);
    if (m) {
      const n = m[2] !== undefined ? Number(m[2]) : ri(4);
      return Array.from({ length: n }, () => genVal({ ...p, type: m[1] }));
    }
    if (p.type === "tuple") {
      const cs = p.components ?? [];
      const vs = cs.map(genVal);
      return cs.length > 0 && cs.every((c) => c.name)
        ? Object.fromEntries(cs.map((c, i) => [c.name, vs[i]]))
        : vs;
    }
    if (p.type === "address") return hex(20);
    if (p.type === "bool") return rnd() < 0.5;
    if (p.type === "string")
      return pick(["", "a", "héllo", '\u0000\n"\\', "日本語", "x".repeat(ri(80))]);
    if (p.type === "bytes") return hex(ri(70));
    const fixed = /^bytes(\d+)$/.exec(p.type);
    if (fixed) return hex(Number(fixed[1]));
    const [, u, bits] = /^(u?)int(\d+)$/.exec(p.type)!;
    const v = BigInt(hex(Number(bits) / 8));
    if (u) return v;
    const half = 1n << BigInt(Number(bits) - 1);
    return rnd() < 0.5 ? -(v % half) - 1n : v % half;
  };
  const mutate = (data: Hex): Hex => {
    const b = data.slice(2);
    const words = Math.floor(b.length / 64);
    if (rnd() < 0.25 && b.length) return `0x${b.slice(0, 2 * ri(b.length / 2))}`;
    if (words === 0) return `0x${b}${"00".repeat(ri(40))}`;
    const w = ri(words);
    const v = pick([0, 32, 64, 96, ri(words) * 32, ri(words * 32 + 64), 2 ** 40, ri(8)]);
    return `0x${b.slice(0, w * 64)}${word(v)}${b.slice(w * 64 + 64)}`;
  };

  it("on 3000 random output lists, valid and corrupted (deterministic)", () => {
    const stats = { valid: 0, corrupted: 0, bothFail: 0, viemOnlyFails: 0 };
    for (let c = 0; c < 3000; c++) {
      const outputs = Array.from({ length: ri(4) }, () => genType(0)) as AbiParameter[];
      const data = encodeAbiParameters(outputs, outputs.map(genVal) as never);
      for (const d of [data, mutate(data), mutate(mutate(data))]) {
        let est: number | undefined;
        let walkError: unknown;
        try {
          est = checkResultSize(outputs, d);
        } catch (e) {
          walkError = e;
        }
        let text: string | undefined;
        try {
          text = printed(outputs, d);
        } catch {
          text = undefined;
        }
        if (d === data && text !== undefined) {
          // Data viem decodes, as encoded: never refused, and the bound holds.
          expect(walkError).toBeUndefined();
          expect(est).toBeGreaterThanOrEqual(text.length);
          stats.valid++;
          continue;
        }
        stats.corrupted++;
        if (walkError !== undefined) {
          // The walk refuses only data viem fails on too (or a result over a cap).
          expect(walkError).toBeInstanceOf(ResultDecodingError);
          expect(text).toBeUndefined();
          stats.bothFail++;
        } else if (text === undefined) {
          stats.viemOnlyFails++; // viem's read limit, a bool that is not 0/1, ...
        } else {
          expect(est).toBeGreaterThanOrEqual(text.length);
        }
      }
    }
    // viem cannot decode a few of its own encodings (a non-empty `uint8[0][]`).
    expect(stats.valid).toBeGreaterThan(2900);
    expect(stats.bothFail).toBeGreaterThan(500);
  });
});

describe("what the walk charges", () => {
  it("is exact for ASCII strings with escapes and quotes", () => {
    const outputs = [{ name: "", type: "string[]" }];
    const data = encodeAbiParameters(outputs, [['a"b\\c', "\n\t\r\b\f", "\u0001\u001f", ""]]);
    expect(checkResultSize(outputs, data)).toBe(printed(outputs, data).length);
  });

  it("charges a multi-byte character one per UTF-8 byte (an upper bound)", () => {
    const outputs = [{ name: "", type: "string" }];
    const data = encodeAbiParameters(outputs, ["日本語é"]); // 11 bytes, 4 UTF-16 units
    expect(printed(outputs, data).length).toBe(4);
    expect(checkResultSize(outputs, data)).toBe(2 + 11);
  });

  it("is exact for addresses, bytes and fixed bytes", () => {
    const outputs = [
      { name: "a", type: "address" },
      { name: "b", type: "bytes" },
      { name: "c", type: "bytes4" },
    ];
    const data = encodeAbiParameters(outputs, [
      "0x000000000000000000000000000000000000dEaD",
      "0x0102",
      "0xdeadbeef",
    ]);
    expect(checkResultSize(outputs, data)).toBe(printed(outputs, data).length);
  });

  it("bounds integers by their bit length, sign included", () => {
    for (const [type, v] of [
      ["int256", -(2n ** 255n)],
      ["int256", -1n],
      ["uint256", 2n ** 256n - 1n],
      ["uint256", 0n],
      ["int8", -128n],
      ["uint256", 10n ** 18n],
    ] as const) {
      const outputs = [{ name: "", type: `${type}[]` }];
      const data = encodeAbiParameters(outputs, [[v, v]]);
      const est = checkResultSize(outputs, data);
      const len = printed(outputs, data).length;
      expect(est).toBeGreaterThanOrEqual(len);
      expect(est - len).toBeLessThanOrEqual(2 * 4); // quotes and one digit, per element
    }
  });

  it("counts an aliased payload once per reference", () => {
    const one = (count: number) =>
      `0x${word(32)}${word(count)}${word(count * 32).repeat(count)}${word(3)}${"616263".padEnd(64, "0")}` as Hex;
    const outputs = [{ name: "", type: "string[]" }];
    // `"abc"` (5) + newline + 2 spaces + comma per element, minus the last comma, + "[\n]".
    expect(checkResultSize(outputs, one(1))).toBe(printed(outputs, one(1)).length);
    expect(checkResultSize(outputs, one(1000))).toBe(printed(outputs, one(1000)).length);
    expect(checkResultSize(outputs, one(1000))).toBe(3 + 1000 * 9 - 1);
  });

  it("refuses at the first character over the text cap, and allows exactly the cap", () => {
    const outputs = [{ name: "", type: "bytes" }];
    const data = encodeAbiParameters(outputs, ["0x0102"]); // printed: "0x0102" = 8
    expect(checkResultSize(outputs, data, { ...LIMITS, chars: 8 })).toBe(8);
    expect(() => checkResultSize(outputs, data, { ...LIMITS, chars: 7 })).toThrow(
      new ResultTooLargeError(
        "Contract call result is too large: its decoded text is over 7 characters (the read_contract limit)."
      )
    );
  });

  it("refuses at the first address over the address cap", () => {
    const outputs = [{ name: "", type: "address[]" }];
    const data = encodeAbiParameters(outputs, [
      ["0x000000000000000000000000000000000000dEaD", "0x000000000000000000000000000000000000bEEF"],
    ]);
    expect(() => checkResultSize(outputs, data, { ...LIMITS, addresses: 2 })).not.toThrow();
    expect(() => checkResultSize(outputs, data, { ...LIMITS, addresses: 1 })).toThrow(
      /over 1 addresses/
    );
  });
});

describe("viem's decoder quirks are mirrored, not tightened", () => {
  it("an output read past the end uses viem's stale cursor (here: 32), not a refusal", () => {
    // (uint256, string, uint256): the string's offset 0 points at the first word, so its
    // length is 0; viem then reads the last uint256 at 32, where the cursor was left.
    const outputs = [
      { name: "a", type: "uint256" },
      { name: "s", type: "string" },
      { name: "b", type: "uint256" },
    ];
    const data = `0x${word(0)}${word(0)}` as Hex;
    expect(printed(outputs, data)).toBe('[\n  "0",\n  "",\n  "0"\n]');
    expect(checkResultSize(outputs, data)).toBeGreaterThanOrEqual(printed(outputs, data).length);
  });

  it("no outputs: no data is fine, 1-31 bytes fail as in viem", () => {
    expect(checkResultSize([], "0x")).toBe(4);
    expect(() => checkResultSize([], "0x01")).toThrow(ResultDecodingError);
    expect(() => printed([], "0x01")).toThrow();
  });

  it("a bogus array length is bad data (as in viem), not a result over the cap", () => {
    const data = `0x${word(32)}${word(2n ** 40n)}${word(1)}` as Hex;
    expect(() => checkResultSize([{ name: "", type: "uint256[]" }], data)).toThrow(
      ResultDecodingError
    );
    expect(() => printed([{ name: "", type: "uint256[]" }], data)).toThrow(/out of bounds/);
  });

  it("an offset that is not a safe integer is bad data (viem: IntegerOutOfRange)", () => {
    const data = `0x${"ff".repeat(32)}` as Hex;
    expect(() => checkResultSize([{ name: "", type: "bytes" }], data)).toThrow(ResultDecodingError);
    expect(() => printed([{ name: "", type: "bytes" }], data)).toThrow();
  });
});

describe("error mapping", () => {
  it("a ResultTooLargeError answers -32005 with its own message, no data", () => {
    const err = new ResultTooLargeError("Contract call result is too large: x.");
    expect(toMcpError(err)).toEqual({
      code: -32005,
      message: "Contract call result is too large: x.",
    });
    expect(MCP_ERROR_CODES.ResultTooLarge).toBe(-32005);
    expect(describeFailure(err)).toEqual({
      code: -32005,
      message: "Contract call result is too large: x.",
      detail: "Contract call result is too large: x.",
    });
    expect(errorCategory(-32005)).toBe("result_too_large");
  });
});

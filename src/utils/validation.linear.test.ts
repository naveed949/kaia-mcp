/**
 * ABI parameter types are caller input (read_contract's `abi`, up to the 4 MB body limit).
 * validateAbiFunctionTypes used to strip array suffixes with a loop of unanchored regex
 * tests, one full scan per suffix, so `uint[][]…[]` cost O(n²): 60 KB took seconds and runs
 * before any RPC call. Types are now capped at MAX_ABI_TYPE_LENGTH characters and the
 * suffixes are stripped with one backward scan.
 */
import { describe, expect, it } from "vitest";
import type { AbiFunction } from "viem";
import { InvalidParamsError } from "./errors.js";
import { MAX_ABI_TYPE_LENGTH, validateAbiFunctionTypes } from "./validation.js";

const fn = (inputs: unknown[], outputs: unknown[] = []) =>
  ({
    type: "function",
    name: "f",
    stateMutability: "view",
    inputs,
    outputs,
  }) as unknown as AbiFunction;

function timeMs(f: () => void): number {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
}

describe("validateAbiFunctionTypes is linear-time on caller types", () => {
  it("a 40 KB array type in outputs is refused quickly (it never reaches the RPC)", () => {
    const type = "uint" + "[]".repeat(20_000);
    let thrown: unknown;
    const ms = timeMs(() => {
      try {
        validateAbiFunctionTypes(fn([], [{ type }]), { requireOutputs: true });
      } catch (e) {
        thrown = e;
      }
    });
    // The old per-suffix regex loop took ~1.9 s on this type.
    expect(ms).toBeLessThan(500);
    expect(thrown).toBeInstanceOf(InvalidParamsError);
    expect((thrown as Error).message).toBe(
      `Invalid ABI: output parameter has a type longer than ${MAX_ABI_TYPE_LENGTH} characters.`
    );
  });

  it("a 4 MB type in inputs, or deep in a tuple, is refused in bounded time", () => {
    // Probe: the old per-suffix regex loop takes ~1.9 s at 40 KB and hours at 4 MB.
    const probe = "uint" + "[]".repeat(20_000);
    const p0 = performance.now();
    try {
      validateAbiFunctionTypes(fn([{ type: probe }]));
    } catch {
      // refused is the expected outcome; only the time matters here
    }
    expect(performance.now() - p0, "40 KB probe (ms)").toBeLessThan(500);
    const huge = "uint" + "[]".repeat(2_000_000);
    const tuple = (inner: unknown) => ({ type: "tuple[]", components: [inner] });
    for (const inputs of [[{ type: huge }], [tuple(tuple({ type: huge }))]]) {
      const ms = timeMs(() =>
        expect(() => validateAbiFunctionTypes(fn(inputs))).toThrow(/longer than 256 characters/)
      );
      expect(ms).toBeLessThan(1000);
    }
  });

  it("the cap is 256 characters and ordinary array types still validate", () => {
    expect(MAX_ABI_TYPE_LENGTH).toBe(256);
    const longest = "uint256" + "[1]".repeat(83); // exactly 256 characters
    expect(longest).toHaveLength(256);
    for (const type of ["uint256[2][][3]", "address[]", "bytes32[4]", "string", longest]) {
      expect(() => validateAbiFunctionTypes(fn([{ type }], [{ type }])), type).not.toThrow();
    }
    expect(() => validateAbiFunctionTypes(fn([{ type: longest + "[1]" }]))).toThrow(
      /longer than 256/
    );
    expect(() =>
      validateAbiFunctionTypes(fn([{ type: "tuple[2][]", components: [{ type: "uint8[]" }] }]))
    ).not.toThrow();
  });

  it("array suffix stripping matches the old regex loop on random short types", () => {
    const oldStrip = (t: string) => {
      let base = t;
      while (/\[\d*\]$/.test(base)) base = base.replace(/\[\d*\]$/, "");
      return base;
    };
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const parts = ["uint", "uint8", "tuple", "[", "]", "[]", "[3]", "1", "0", "x", " ", "٣"];
    for (let i = 0; i < 5000; i++) {
      let t = "";
      const len = 1 + Math.floor(rnd() * 10);
      for (let j = 0; j < len; j++) t += parts[Math.floor(rnd() * parts.length)];
      const base = oldStrip(t.trim());
      const oldOk =
        ["address", "bool", "string", "bytes"].includes(base) ||
        /^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])$/.test(base) ||
        /^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(
          base
        );
      const isTuple = base === "tuple";
      const param = isTuple ? { type: t, components: [] } : { type: t };
      let ok = true;
      try {
        validateAbiFunctionTypes(fn([param]));
      } catch {
        ok = false;
      }
      expect(ok, JSON.stringify(t)).toBe(oldOk || isTuple);
    }
  });
});

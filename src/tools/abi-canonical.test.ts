/**
 * PR #9 round 5. Rounds 3 and 4 passed the caller's ABI object graph to viem minus some
 * known-bad shapes, and each verify found a shape the caps missed: array-like `inputs`
 * (`{"length":1,"0":…}`) reached viem's O(n²) type regex (M-A), selector lookup hashed
 * names given as arrays (M-C), and viem's overload matching cost components × args on a
 * tuple overload (M-B, also on main). Now the ABI is parsed into a fresh, strictly typed
 * copy (real arrays, string names, a linear type grammar, every string counted), overloads
 * are resolved by kaia in linear time, and viem only ever sees the one resolved function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as viem from "viem";
import { handleReadContract } from "./contract.js";
import { handleEncodeFunctionData } from "./wallet.js";
import { createRpcClient } from "../clients/rpc.js";
import { resetConfigCache } from "../config.js";
import { InvalidParamsError } from "../utils/errors.js";
import {
  MAX_ABI_PARAMETERS,
  MAX_ABI_SIGNATURE_CHARS,
  parseAbiInput,
  resolveAbiFunction,
} from "../utils/validation.js";

vi.mock("../clients/rpc.js", () => ({ createRpcClient: vi.fn() }));
vi.mock("viem", async (importOriginal) => {
  const orig = await importOriginal<typeof import("viem")>();
  return {
    ...orig,
    getAbiItem: vi.fn(orig.getAbiItem),
    encodeFunctionData: vi.fn(orig.encodeFunctionData),
    decodeFunctionResult: vi.fn(orig.decodeFunctionResult),
  };
});

const mockCreateRpcClient = vi.mocked(createRpcClient);
const getAbiItemSpy = vi.mocked(viem.getAbiItem);
const encodeSpy = vi.mocked(viem.encodeFunctionData);
const ADDR = "0x1234567890123456789012345678901234567890";
const SEVEN = `0x${"0".repeat(63)}7` as const;

const fi = (
  name: unknown,
  inputs: unknown,
  outputs: unknown = [{ name: "", type: "uint256" }]
) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs,
  outputs,
});
const arrayLike = (...xs: unknown[]) => Object.assign({ length: xs.length }, xs);

type Call = { abi: unknown; functionName: string; args?: unknown[] };
const TOOLS = {
  read_contract: (c: Call) =>
    handleReadContract({ contractAddress: ADDR, network: "mainnet", ...c }),
  encode_function_data: (c: Call) => handleEncodeFunctionData(c),
};
type Tool = keyof typeof TOOLS;
const tools = Object.keys(TOOLS) as Tool[];

async function timed(tool: Tool, call: Call) {
  const t0 = performance.now();
  let thrown: unknown;
  let text: string | undefined;
  try {
    text = (await TOOLS[tool](call)).content[0].text;
  } catch (e) {
    thrown = e;
  }
  return { ms: performance.now() - t0, thrown, text };
}

async function refused(tool: Tool, call: Call, message: RegExp, budgetMs = 500) {
  const r = await timed(tool, call);
  expect(r.thrown, `${tool} should refuse`).toBeInstanceOf(InvalidParamsError);
  expect((r.thrown as Error).message).toMatch(message);
  expect(r.ms, `${tool} took ${Math.round(r.ms)} ms`).toBeLessThan(budgetMs);
  return r.thrown as InvalidParamsError;
}

let call: ReturnType<typeof vi.fn>;
let readContract: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetConfigCache();
  vi.clearAllMocks();
  call = vi.fn().mockResolvedValue({ data: SEVEN });
  readContract = vi.fn().mockResolvedValue(7n);
  mockCreateRpcClient.mockReturnValue({ call, readContract } as unknown as ReturnType<
    typeof createRpcClient
  >);
});

/** Every ABI viem was handed: exactly one fresh function item with only known keys. */
function expectOnlyCanonicalReachedViem(callerAbi: readonly unknown[]) {
  const seen = [
    ...getAbiItemSpy.mock.calls.map((c) => (c[0] as unknown as { abi: unknown[] }).abi),
    ...encodeSpy.mock.calls.map((c) => (c[0] as unknown as { abi: unknown[] }).abi),
  ];
  for (const abi of seen) {
    expect(abi).toHaveLength(1);
    const item = abi[0] as Record<string, unknown>;
    expect(callerAbi.includes(item), "viem got the caller's own object").toBe(false);
    for (const k of Object.keys(item)) {
      expect(["type", "name", "inputs", "outputs", "stateMutability"]).toContain(k);
    }
  }
}

describe("M-A: array-like inputs, outputs and components are refused before viem", () => {
  const big = "a".repeat(65_536);
  const SHAPES: Array<[string, Call]> = [
    [
      "overloaded, array-like inputs with a 64 KB type",
      {
        abi: [fi("f", arrayLike({ name: "", type: big })), fi("f", [{ type: "uint256" }])],
        functionName: "f",
        args: ["x"],
      },
    ],
    [
      "array-like inputs, looked up by selector",
      {
        abi: [fi("f", arrayLike({ name: "", type: "a".repeat(1_000_000) }))],
        functionName: "0x12345678",
        args: [1],
      },
    ],
    [
      "array-like outputs on an item the call does not name",
      {
        abi: [fi("g", [], arrayLike({ type: big })), fi("f", [{ type: "uint256" }])],
        functionName: "f",
        args: [1],
      },
    ],
    [
      "array-like components, overloaded",
      {
        abi: [
          fi("f", [{ type: "tuple", components: arrayLike({ type: big }) }]),
          fi("f", [{ type: "uint256" }]),
        ],
        functionName: "f",
        args: [[1]],
      },
    ],
    [
      "array-like components, looked up by selector",
      {
        abi: [fi("f", [{ type: "tuple", components: arrayLike({ type: "a".repeat(1_000_000) }) }])],
        functionName: "0x12345678",
        args: [[1]],
      },
    ],
    ["inputs given as a string", { abi: [fi("f", "uint256")], functionName: "f", args: [1] }],
  ];
  for (const [name, c] of SHAPES) {
    for (const tool of tools) {
      it(`${tool}: ${name}`, async () => {
        await refused(tool, c, /Invalid ABI: .*must be an array/);
        expect(getAbiItemSpy).not.toHaveBeenCalled();
        expect(mockCreateRpcClient).not.toHaveBeenCalled();
      });
    }
  }
});

describe("M-C: names must be strings, and every name is counted", () => {
  const SHAPES: Array<[string, Call, RegExp]> = [
    [
      "an item name given as an array (selector lookup)",
      {
        abi: [fi(["a".repeat(3_000_000)], [{ type: "uint256" }])],
        functionName: "0x12345678",
        args: [1],
      },
      /name must be a string/,
    ],
    [
      "an item name given as an object",
      {
        abi: [fi({ toString: "f" }, [{ type: "uint256" }]), fi("f", [{ type: "uint256" }])],
        functionName: "f",
        args: [1],
      },
      /name must be a string/,
    ],
    [
      "a parameter name given as an array",
      {
        abi: [fi("g", [{ name: ["p".repeat(3_000_000)], type: "uint256" }])],
        functionName: "0x12345678",
        args: [1],
      },
      /name must be a string/,
    ],
    [
      "a stateMutability that is not on the allowlist",
      {
        abi: [{ ...fi("f", [{ type: "uint256" }]), stateMutability: "s".repeat(3_000_000) }],
        functionName: "0x12345678",
        args: [1],
      },
      /stateMutability/,
    ],
    [
      "an item type that is not on the allowlist",
      { abi: [{ ...fi("f", []), type: ["function"] }], functionName: "f", args: [] },
      /item type/,
    ],
    [
      "a parameter nested one array deeper",
      { abi: [fi("f", [[{ type: "uint256" }]])], functionName: "f", args: [1] },
      /every parameter must be an object/,
    ],
  ];
  for (const [name, c, message] of SHAPES) {
    for (const tool of tools) {
      it(`${tool}: ${name}`, async () => {
        await refused(tool, c, message);
        expect(getAbiItemSpy).not.toHaveBeenCalled();
      });
    }
  }

  it("selector lookup over a large ABI inside the caps stays fast and resolves", async () => {
    // 2000 functions with long names: every selector is computed from the counted, canonical
    // signature, never from caller text the budget did not see.
    const abi = Array.from({ length: 2000 }, (_, i) =>
      fi(`g${i}${"x".repeat(100)}`, [{ type: "uint256" }])
    );
    const target = abi[1999] as { name: string };
    const sel = viem.toFunctionSelector(`${target.name}(uint256)`);
    for (const tool of tools) {
      const r = await timed(tool, { abi, functionName: sel, args: [1] });
      expect(r.thrown).toBeUndefined();
      expect(r.ms).toBeLessThan(500);
    }
    expectOnlyCanonicalReachedViem(abi);
  });
});

describe("M-B: overloads are resolved by kaia in linear time; viem sees one function", () => {
  const tupleOverload = (k: number, n: number): Call => ({
    abi: [
      fi("f", [
        {
          type: "tuple",
          components: Array.from({ length: k }, () => ({ name: "", type: "bool" })),
        },
      ]),
      fi("f", [{ type: "uint256" }]),
    ],
    functionName: "f",
    args: [Array(n).fill(true)],
  });

  for (const tool of tools) {
    it(`${tool}: a 32 K-component tuple overload with a 32 K-value arg (9.6 s before)`, async () => {
      const c = tupleOverload(32_000, 32_000);
      const r = await timed(tool, c);
      expect(r.thrown).toBeUndefined();
      expect(r.ms, `${Math.round(r.ms)} ms`).toBeLessThan(1500);
      expectOnlyCanonicalReachedViem(c.abi as unknown[]);
      if (tool === "encode_function_data") {
        const single = viem.encodeFunctionData({
          abi: [(c.abi as unknown[])[0]] as viem.Abi,
          functionName: "f",
          args: c.args as never,
        });
        expect(r.text).toBe(single);
      }
    });
  }

  it("a tuple arg with far more values than components costs one pass over the arg", async () => {
    const c = tupleOverload(1_000, 32_767);
    const r = await timed("encode_function_data", c);
    expect(r.thrown).toBeUndefined();
    expect(r.ms, `${Math.round(r.ms)} ms`).toBeLessThan(2500);
  });

  it("viem's getAbiItem never chooses between overloads", async () => {
    const abi = [
      fi("f", [{ type: "address" }]),
      fi("f", [{ type: "uint256" }]),
      fi("f", [{ type: "bytes32[]" }]),
      fi("f", [{ type: "address" }, { type: "uint256" }]),
    ];
    const cases: Array<[unknown[], string]> = [
      [[ADDR], "f(address)"],
      [[5], "f(uint256)"],
      [[["0x" + "11".repeat(32)]], "f(bytes32[])"],
      [[ADDR, 1], "f(address,uint256)"],
      // Numbers as strings: viem's check fails every overload and falls back; kaia picks
      // the first overload with as many inputs as args (main: the first overload).
      [["7"], "f(address)"],
    ];
    for (const [args, sig] of cases) {
      const r = await handleEncodeFunctionData({ abi, functionName: "f", args }).catch(
        (e: Error) => e
      );
      if (sig === "f(address)" && args[0] === "7") {
        expect(r).toBeInstanceOf(InvalidParamsError);
        continue;
      }
      expect((r as unknown as { content: [{ text: string }] }).content[0].text.slice(0, 10)).toBe(
        viem.toFunctionSelector(sig)
      );
    }
    expectOnlyCanonicalReachedViem(abi);
  });
});

describe("L-A: read_contract encodes once and decodes with the same function", () => {
  it("the calldata kaia encoded is the calldata sent; the result is decoded from it", async () => {
    const abi = [fi("balanceOf", [{ type: "address" }])];
    const res = await handleReadContract({
      contractAddress: ADDR,
      abi,
      functionName: "balanceOf",
      args: [ADDR],
      network: "mainnet",
    });
    expect(res.content[0].text).toBe("Result:\n7");
    expect(encodeSpy).toHaveBeenCalledTimes(1);
    expectOnlyCanonicalReachedViem(abi);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual({
      to: ADDR,
      data: viem.encodeFunctionData({
        abi: abi as viem.Abi,
        functionName: "balanceOf",
        args: [ADDR],
      }),
    });
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("L-B: unsupported types in other items do not make the ABI unusable", () => {
  const A = ADDR;
  for (const other of ["function", "Lib.S storage", "fixed128x18", "uint7", "tuple"]) {
    it(`a sibling overload with a "${other}" input; the call still resolves f(address)`, async () => {
      const abi = [
        fi("f", [{ type: other }]),
        fi("f", [{ type: "address" }]),
        fi("g", [{ type: other }]),
      ];
      const r = await handleEncodeFunctionData({ abi, functionName: "f", args: [A] });
      expect(r.content[0].text.slice(0, 10)).toBe(viem.toFunctionSelector("f(address)"));
    });
  }

  it("the called function itself with an unsupported type is refused, and says why", async () => {
    for (const tool of tools) {
      await refused(
        tool,
        {
          abi: [fi("f", [{ type: "function" }])],
          functionName: "f",
          args: ["0x" + "11".repeat(24)],
        },
        /input parameter has unknown type "function", so function "f" is not supported/
      );
    }
  });

  it("read_contract: an unsupported output type on the called function is still refused", async () => {
    await refused(
      "read_contract",
      { abi: [fi("f", [], [{ type: "Lib.S storage" }])], functionName: "f", args: [] },
      /output parameter has unknown type/
    );
    // encode_function_data never decodes, so the outputs do not matter to it.
    const r = await handleEncodeFunctionData({
      abi: [fi("f", [], [{ type: "Lib.S storage" }])],
      functionName: "f",
      args: [],
    });
    expect(r.content[0].text).toBe(viem.toFunctionSelector("f()"));
  });
});

describe("nits", () => {
  it("V06: item and parameter names count toward the character budget", async () => {
    // Every type is 5 characters; the names alone are over the budget.
    const n = Math.ceil(MAX_ABI_SIGNATURE_CHARS / 1000) + 1;
    const itemNames = Array.from({ length: n }, (_, i) => fi(`g${i}`.padEnd(1000, "x"), []));
    const paramNames = [
      fi(
        "g",
        Array.from({ length: n }, () => ({ name: "p".repeat(1000), type: "uint8" }))
      ),
    ];
    for (const extra of [itemNames, paramNames]) {
      for (const tool of tools) {
        await refused(
          tool,
          { abi: [fi("f", []), ...extra], functionName: "f", args: [] },
          /more than \d+ characters of names and types/
        );
      }
    }
  });

  it("V17: exactly MAX_ABI_SIGNATURE_CHARS is accepted, one more is refused", async () => {
    // f() (1 char) + g with 1-char-named uint8 params and one padding name.
    const build = (total: number) => {
      const params = Array.from({ length: 200 }, () => ({ name: "", type: "uint8" }));
      const used = 1 + 1 + 200 * 5; // "f", "g", types
      params.push({ name: "p".repeat(Math.min(1024, total - used - 5)), type: "uint8" });
      let left = total - used - 5 - params[200].name.length;
      while (left > 0) {
        const take = Math.min(1024, left);
        params.push({ name: "q".repeat(Math.max(0, take - 5)), type: "uint8" });
        left -= Math.max(5, take);
      }
      return [fi("f", [], []), fi("g", params, [])];
    };
    const count = (abi: ReturnType<typeof build>) =>
      abi.reduce(
        (s, it) =>
          s +
          (it.name as string).length +
          (it.inputs as Array<{ name: string; type: string }>).reduce(
            (t, p) => t + p.name.length + p.type.length,
            0
          ),
        0
      );
    const exact = build(MAX_ABI_SIGNATURE_CHARS);
    expect(count(exact)).toBe(MAX_ABI_SIGNATURE_CHARS);
    const r = await handleEncodeFunctionData({ abi: exact, functionName: "f", args: [] });
    expect(r.content[0].text).toBe(viem.toFunctionSelector("f()"));
    const over = build(MAX_ABI_SIGNATURE_CHARS);
    (over[0] as { name: string }).name = "ff";
    expect(count(over)).toBe(MAX_ABI_SIGNATURE_CHARS + 1);
    await refused(
      "encode_function_data",
      { abi: over, functionName: "ff", args: [] },
      /more than \d+ characters of names and types/
    );
  });

  it("V08: tuples nested exactly 32 deep are accepted, 33 refused (called or not)", async () => {
    const deep = (d: number): Record<string, unknown> => {
      let p: Record<string, unknown> = { type: "uint256" };
      for (let i = 0; i < d; i++) p = { type: "tuple", components: [p] };
      return p;
    };
    const arg = (d: number): unknown => (d === 0 ? 1 : [arg(d - 1)]);
    const ok = await handleEncodeFunctionData({
      abi: [fi("f", [deep(32)])],
      functionName: "f",
      args: [arg(32)],
    });
    expect(ok.content[0].text.startsWith("0x")).toBe(true);
    for (const abi of [[fi("f", [deep(33)])], [fi("g", [deep(33)]), fi("f", [])]]) {
      await refused(
        "encode_function_data",
        { abi, functionName: "f", args: abi.length === 1 ? [arg(33)] : [] },
        /nests tuples too deeply/
      );
    }
  });

  it("an upper-case selector resolves", async () => {
    const abi = [fi("transfer", [{ type: "address" }, { type: "uint256" }])];
    const r = await handleEncodeFunctionData({ abi, functionName: "0xA9059CBB", args: [ADDR, 1] });
    expect(r.content[0].text.slice(0, 10)).toBe("0xa9059cbb");
  });

  it("address vs bytes20 overloads: a clear ambiguity message naming the selectors", async () => {
    const abi = [fi("f", [{ type: "address" }]), fi("f", [{ type: "bytes20" }])];
    const err = await refused(
      "encode_function_data",
      { abi, functionName: "f", args: [ADDR] },
      /ambiguous/
    );
    expect(err.message).toContain(viem.toFunctionSelector("f(address)"));
    expect(err.message).toContain(viem.toFunctionSelector("f(bytes20)"));
    expect(err.message).not.toMatch(/not found/);
  });

  it("M07: exactly MAX_ABI_PARAMETERS parameters are accepted", async () => {
    const wide = (n: number) => ({
      type: "tuple",
      components: Array.from({ length: n }, () => ({ type: "uint8" })),
    });
    // The tuple itself plus its components: MAX_ABI_PARAMETERS in all.
    const abi = [fi("g", [wide(MAX_ABI_PARAMETERS - 1)], []), fi("f", [], [])];
    const r = await handleEncodeFunctionData({ abi, functionName: "f", args: [] });
    expect(r.content[0].text).toBe(viem.toFunctionSelector("f()"));
    await refused(
      "encode_function_data",
      {
        abi: [fi("g", [wide(MAX_ABI_PARAMETERS)], []), fi("f", [], [])],
        functionName: "f",
        args: [],
      },
      /more than \d+ parameters/
    );
  });

  it("an item type outside the allowlist, or a function without a name, is refused", async () => {
    for (const tool of tools) {
      await refused(
        tool,
        { abi: [{ type: "comment", name: "x" }, fi("f", [])], functionName: "f", args: [] },
        /every item type must be one of function, event, error, constructor, fallback, receive/
      );
      await refused(
        tool,
        {
          abi: [{ type: "function", inputs: [], outputs: [] }, fi("f", [])],
          functionName: "f",
          args: [],
        },
        /every function needs a name/
      );
    }
  });

  it("parameter count cap still applies on the canonical form", async () => {
    const abi = [
      fi("f", [
        {
          type: "tuple",
          components: Array.from({ length: MAX_ABI_PARAMETERS }, () => ({ type: "uint8" })),
        },
      ]),
    ];
    await refused(
      "encode_function_data",
      { abi, functionName: "f", args: [[1]] },
      /more than \d+ parameters/
    );
  });
});

describe("overload resolution: kaia's linear port agrees with viem's getAbiItem", () => {
  const sel = (sig: string) => viem.toFunctionSelector(sig);
  const enc = (abi: unknown[], functionName: string, args: unknown[]) =>
    handleEncodeFunctionData({ abi, functionName, args }).then((r) =>
      r.content[0].text.slice(0, 10)
    );

  it("numbers sent as strings fit no overload: the one with as many inputs is used", async () => {
    // main fell back to the first overload (3 inputs) and failed to encode 4 args.
    const abi = [
      fi("safeTransferFrom", [{ type: "address" }, { type: "address" }, { type: "uint256" }], []),
      fi(
        "safeTransferFrom",
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
        []
      ),
    ];
    expect(await enc(abi, "safeTransferFrom", [ADDR, ADDR, "1", "0x"])).toBe(
      sel("safeTransferFrom(address,address,uint256,bytes)")
    );
  });

  it("each argument is checked against its own type", async () => {
    expect(
      await enc([fi("f", [{ type: "uint256" }]), fi("f", [{ type: "address" }])], "f", [5])
    ).toBe(sel("f(uint256)"));
    expect(
      await enc([fi("f", [{ type: "uint256" }]), fi("f", [{ type: "bytes32" }])], "f", [5])
    ).toBe(sel("f(uint256)"));
    expect(
      await enc([fi("f", [{ type: "uint256[]" }]), fi("f", [{ type: "bytes32" }])], "f", [[1, 2]])
    ).toBe(sel("f(uint256[])"));
  });

  it("a tuple function resolves by its selector (tuples spelled out in the signature)", async () => {
    const abi = [
      fi("f", [{ type: "tuple", components: [{ type: "uint256" }, { type: "address" }] }]),
      fi("g", []),
    ];
    expect(await enc(abi, sel("f((uint256,address))"), [[1, ADDR]])).toBe(
      sel("f((uint256,address))")
    );
  });

  it("refused with a reason: unidentifiable names, tuples without components, non-array components", async () => {
    await refused(
      "encode_function_data",
      { abi: [fi("a b", [])], functionName: "a b", args: [] },
      /name is not a Solidity identifier, so function "a b" is not supported/
    );
    await refused(
      "encode_function_data",
      { abi: [fi("f", [{ type: "tuple" }])], functionName: "f", args: [[1]] },
      /input parameter of type "tuple" needs a components array/
    );
    await refused(
      "encode_function_data",
      {
        abi: [fi("f", [{ type: "uint256", components: arrayLike({ type: "uint8" }) }])],
        functionName: "f",
        args: [1],
      },
      /components must be an array/
    );
  });

  it("the type cap is exactly 256 characters", async () => {
    const t256 = "uint8" + "[]".repeat(124) + "[1]"; // 5 + 248 + 3
    expect(t256).toHaveLength(256);
    expect(await enc([fi("g", [{ type: t256 }]), fi("f", [])], "f", [])).toBe(sel("f()"));
    await refused(
      "encode_function_data",
      { abi: [fi("g", [{ type: t256 + "]" }]), fi("f", [])], functionName: "f", args: [] },
      /type longer than 256/
    );
  });

  it("random overload sets: same choice as viem (3000 cases)", () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const TYPES: Array<Record<string, unknown>> = [
      { type: "address" },
      { type: "bool" },
      { type: "string" },
      { type: "bytes" },
      { type: "bytes20" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "int8" },
      { type: "uint8[]" },
      { type: "address[]" },
      { type: "bytes32[2]" },
      { type: "string[]" },
      { type: "tuple", components: [{ type: "uint256" }, { type: "address" }] },
      { type: "tuple[]", components: [{ type: "bool" }] },
    ];
    const ARGS: unknown[] = [
      ADDR,
      "0x1234",
      "hello",
      5,
      5n,
      true,
      [1, 2],
      [ADDR, ADDR],
      { a: 1, b: ADDR },
      [[true]],
      ["0x11"],
      [1, ADDR],
      [],
    ];
    let viemCrashed = 0;
    let ambiguous = 0;
    // Every other case from a pool built for viem's ambiguity rule (address vs bytes20,
    // string or bytes, also inside tuples).
    const AMB_TYPES: Array<Record<string, unknown>> = [
      { type: "address" },
      { type: "bytes20" },
      { type: "string" },
      { type: "bytes" },
      { type: "uint256" },
      { type: "tuple", components: [{ type: "address" }] },
      { type: "tuple", components: [{ type: "bytes20" }] },
    ];
    // Not a one-element array of an address: viem's isAddress stringifies its argument and
    // caches by that string, so its answer for ["0x…"] depends on earlier lookups (kaia: no).
    const AMB_ARGS: unknown[] = [ADDR, "0x12", "s", 1, [ADDR, ADDR], { a: ADDR }];
    for (let n = 0; n < 3000; n++) {
      const focused = n % 2 === 1;
      const types = focused ? AMB_TYPES : TYPES;
      const pool = focused ? AMB_ARGS : ARGS;
      const abi = Array.from({ length: 2 + rnd(4) }, () =>
        fi(
          "f",
          Array.from({ length: focused ? 1 + rnd(2) : rnd(3) }, () => types[rnd(types.length)])
        )
      );
      const args = Array.from(
        { length: focused ? 1 + rnd(2) : rnd(3) },
        () => pool[rnd(pool.length)]
      );
      let viemPick: string | Error;
      try {
        const it = viem.getAbiItem({
          abi: abi as viem.Abi,
          name: "f",
          args,
        } as never) as viem.AbiFunction;
        viemPick = viem.toFunctionSignature(it);
        if (it.inputs.length !== args.length) {
          // viem fell back to the first overload; kaia uses the first with as many inputs.
          const same = abi.find((x) => (x.inputs as unknown[]).length === args.length) ?? abi[0];
          viemPick = viem.toFunctionSignature(same as viem.AbiFunction);
        }
      } catch (e) {
        viemPick = e as Error;
      }
      let kaiaPick: string | Error;
      try {
        kaiaPick = viem.toFunctionSignature(resolveAbiFunction(parseAbiInput(abi), "f", args).item);
      } catch (e) {
        kaiaPick = e as Error;
      }
      const label = JSON.stringify({ abi: abi.map((x) => x.inputs), args }, (_, v: unknown) =>
        typeof v === "bigint" ? `${v}n` : v
      );
      if (viemPick instanceof Error && viemPick.name !== "AbiItemAmbiguityError") {
        // viem itself crashed (e.g. a TypeError on an array where an address goes); main
        // answered those with an internal error. Nothing to agree with.
        viemCrashed++;
        continue;
      }
      if (viemPick instanceof Error) {
        ambiguous++;
        expect(String((kaiaPick as Error).message), label).toMatch(/fit more than one overload/);
      } else {
        expect(kaiaPick, label).toBe(viemPick);
      }
    }
    expect(viemCrashed).toBeLessThan(300);
    expect(ambiguous).toBeGreaterThan(10);
  });
});

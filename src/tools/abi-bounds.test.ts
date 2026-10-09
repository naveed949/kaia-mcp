/**
 * Caller ABIs (read_contract, encode_function_data; up to the 4 MB body limit) are bounded
 * before viem sees any of them (PR #9 verify r3, M-A). viem's getAbiItem tests every
 * parameter type of every same-name overload against an unanchored regex that is O(n²) in
 * the type's length, so one 64 KB type in an overloaded ABI stalled the event loop for
 * seconds before validateAbiFunctionTypes' 256-character cap ever ran (and read_contract
 * resolved the function twice, then let viem's readContract resolve it again over the whole
 * ABI). Now every item's names, parameter types and `components` are capped first, the
 * candidate overloads' input types must be valid before viem compares them, the function is
 * resolved once, and readContract gets just that one item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as viem from "viem";
import { handleReadContract } from "./contract.js";
import { handleEncodeFunctionData } from "./wallet.js";
import { createRpcClient } from "../clients/rpc.js";
import { resetConfigCache } from "../config.js";
import { InvalidParamsError } from "../utils/errors.js";
import {
  MAX_ABI_ITEMS,
  MAX_ABI_NAME_LENGTH,
  MAX_ABI_OVERLOADS,
  MAX_ABI_PARAMETERS,
  MAX_ABI_SIGNATURE_CHARS,
  MAX_ABI_TYPE_LENGTH,
} from "../utils/validation.js";

vi.mock("../clients/rpc.js", () => ({ createRpcClient: vi.fn() }));
vi.mock("viem", async (importOriginal) => {
  const orig = await importOriginal<typeof import("viem")>();
  return { ...orig, getAbiItem: vi.fn(orig.getAbiItem) };
});

const mockCreateRpcClient = vi.mocked(createRpcClient);
const getAbiItemSpy = vi.mocked(viem.getAbiItem);
const ADDR = "0x1234567890123456789012345678901234567890";

type Param = { name?: string; type: string; components?: Param[] };
const fnItem = (name: string, inputs: Param[], outputs: Param[] = [{ type: "uint256" }]) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs,
  outputs,
});
/** Two `f` overloads: the first takes `type`, so viem must compare the args against it. */
const overloaded = (type: string) => [fnItem("f", [{ type }]), fnItem("f", [{ type: "uint256" }])];
const deepTuple = (depth: number): Param => {
  let p: Param = { type: "uint256" };
  for (let i = 0; i < depth; i++) p = { type: "tuple", components: [p] };
  return p;
};

type Call = { abi: unknown; functionName: string; args?: unknown[] };
const TOOLS = {
  read_contract: (c: Call) =>
    handleReadContract({ contractAddress: ADDR, network: "mainnet", ...c }),
  encode_function_data: (c: Call) => handleEncodeFunctionData(c),
};

async function refusedIn(
  tool: keyof typeof TOOLS,
  call: Call,
  budgetMs: number
): Promise<InvalidParamsError> {
  const t0 = performance.now();
  let thrown: unknown;
  try {
    await TOOLS[tool](call);
  } catch (e) {
    thrown = e;
  }
  const ms = performance.now() - t0;
  expect(thrown, `${tool} should refuse`).toBeInstanceOf(InvalidParamsError);
  expect(ms, `${tool} took ${Math.round(ms)} ms`).toBeLessThan(budgetMs);
  return thrown as InvalidParamsError;
}

beforeEach(() => {
  resetConfigCache();
  vi.clearAllMocks();
  mockCreateRpcClient.mockReturnValue({
    call: vi.fn().mockResolvedValue({ data: `0x${"0".repeat(63)}7` }),
  } as unknown as ReturnType<typeof createRpcClient>);
});

describe("M-A: hostile caller ABIs are refused in bounded time, before viem and any RPC", () => {
  // On bb8f099 the 64 KB overloaded type took ~6.7 s (read_contract) / ~3.4 s (encode).
  const SHAPES: Array<[string, Call, RegExp]> = [
    [
      "overloaded 64 KB input type",
      { abi: overloaded("a".repeat(65_536)), functionName: "f", args: ["x"] },
      /type longer than 256 characters/,
    ],
    [
      "overloaded 64 KB input type deep in a tuple",
      {
        abi: [
          fnItem("f", [{ type: "tuple", components: [{ type: "a".repeat(65_536) }] }]),
          fnItem("f", [{ type: "uint256" }]),
        ],
        functionName: "f",
        args: [["x"]],
      },
      /type longer than 256 characters/,
    ],
    [
      "64 KB type in an item the call does not name",
      {
        abi: [fnItem("g", [{ type: "a".repeat(65_536) }]), fnItem("f", [{ type: "uint256" }])],
        functionName: "f",
        args: ["1"],
      },
      /type longer than 256 characters/,
    ],
    [
      "64 KB type looked up by selector",
      {
        abi: [fnItem("g", [{ type: "a".repeat(65_536) }]), fnItem("f", [{ type: "uint256" }])],
        functionName: "0x12345678",
        args: ["1"],
      },
      /type longer than 256 characters/,
    ],
    [
      // Inside every cap; viem would run its O(n²) regex on each 256-character type.
      "overloads with a thousand 256-character bogus types",
      {
        abi: [
          fnItem(
            "f",
            Array.from({ length: 1000 }, () => ({ type: "a".repeat(256) }))
          ),
          fnItem("f", [{ type: "uint256" }]),
        ],
        functionName: "f",
        args: Array(1000).fill("x"),
      },
      // Round 5: the bogus overload is set aside (it cannot be called); the other `f` takes
      // one input, so 1000 args do not fit it.
      /Invalid arguments: /,
    ],
    [
      "a 1 MB function name, overloaded",
      {
        abi: [
          fnItem("f".repeat(1 << 20), [{ type: "uint256" }]),
          fnItem("f".repeat(1 << 20), [{ type: "address" }]),
        ],
        functionName: "f".repeat(1 << 20),
        args: ["1"],
      },
      /name longer than 1024 characters/,
    ],
    [
      "a 1 MB item name the call does not name",
      {
        abi: [
          fnItem("g".repeat(1 << 20), [{ type: "uint256" }]),
          fnItem("f", [{ type: "uint256" }]),
        ],
        functionName: "f",
        args: ["1"],
      },
      /name longer than 1024 characters/,
    ],
    [
      "a 1 MB parameter name",
      {
        abi: [fnItem("f", [{ name: "p".repeat(1 << 20), type: "uint256" }])],
        functionName: "f",
        args: ["1"],
      },
      /name longer than 1024 characters/,
    ],
    [
      "too many ABI items",
      {
        abi: Array.from({ length: MAX_ABI_ITEMS + 1 }, (_, i) =>
          fnItem(`g${i}`, [{ type: "uint256" }])
        ),
        functionName: "g1",
        args: ["1"],
      },
      /more than \d+ items/,
    ],
    [
      "too many parameters in one wide tuple",
      {
        abi: [
          fnItem("f", [
            {
              type: "tuple",
              components: Array.from({ length: MAX_ABI_PARAMETERS }, () => ({ type: "uint8" })),
            },
          ]),
        ],
        functionName: "f",
        args: [[1]],
      },
      /more than \d+ parameters/,
    ],
    [
      // Every type valid and short, but viem would format and keccak a ~4 MB signature
      // (~1.2 s on bb8f099 and before this cap).
      "thousands of long, valid types in one overloaded function",
      {
        abi: [
          fnItem(
            "f",
            Array.from({ length: 14_000 }, () => ({ type: "uint256" + "[1]".repeat(80) }))
          ),
          fnItem("f", [{ type: "uint256" }]),
        ],
        functionName: "f",
        args: Array(14_000).fill("x"),
      },
      /more than \d+ characters of names and types/,
    ],
    [
      "thousands of long, valid types looked up by selector",
      {
        abi: Array.from({ length: 2000 }, (_, i) =>
          fnItem(
            `g${i}`,
            Array.from({ length: 7 }, () => ({ type: "uint256" + "[1]".repeat(80) }))
          )
        ),
        functionName: "0x12345678",
        args: [],
      },
      /more than \d+ characters of names and types/,
    ],
    [
      "64 KB output type in an item the call does not name",
      {
        abi: [
          fnItem("g", [{ type: "uint256" }], [{ type: "a".repeat(65_536) }]),
          fnItem("f", [{ type: "uint256" }]),
        ],
        functionName: "f",
        args: ["1"],
      },
      /type longer than 256 characters/,
    ],
    [
      "tuples nested deeper than 32 in an item the call does not name",
      {
        abi: [fnItem("g", [deepTuple(1_000)]), fnItem("f", [{ type: "uint256" }])],
        functionName: "f",
        args: ["1"],
      },
      /nests tuples too deeply/,
    ],
    [
      "names that use up the character budget (every type short)",
      {
        abi: [
          fnItem("f", [{ type: "uint256" }]),
          fnItem(
            "g",
            Array.from({ length: 300 }, () => ({ name: "n".repeat(1000), type: "uint8" }))
          ),
        ],
        functionName: "f",
        args: ["1"],
      },
      /more than \d+ characters of names and types/,
    ],
    [
      "a parameter whose type is not a string",
      {
        abi: [fnItem("g", [{ type: 5 } as unknown as Param]), fnItem("f", [{ type: "uint256" }])],
        functionName: "f",
        args: ["1"],
      },
      /parameter has no type/,
    ],
    [
      "a parameter that is not an object",
      {
        abi: [fnItem("g", [5 as unknown as Param]), fnItem("f", [{ type: "uint256" }])],
        functionName: "f",
        args: ["1"],
      },
      /every parameter must be an object/,
    ],
    [
      // viem walks a 100 K-element argument once per overload: ~2.4 s here on bb8f099
      // (1000 overloads and 200 K elements: 22 s).
      "a hundred overloads and a 100 K-element array argument",
      {
        abi: Array.from({ length: 100 }, () => fnItem("f", [{ type: "uint8[]" }])),
        functionName: "f",
        args: [Array(100_000).fill(1)],
      },
      /more than 16 items match the function name or selector/,
    ],
    [
      "tuples nested deeper than 32, overloaded",
      {
        abi: [fnItem("f", [deepTuple(1_000)]), fnItem("f", [{ type: "uint256" }])],
        functionName: "f",
        args: [{ a: 1 }],
      },
      /nests tuples too deeply/,
    ],
    [
      "an ABI item that is not an object",
      { abi: [7, fnItem("f", [{ type: "uint256" }])], functionName: "f", args: ["1"] },
      /every ABI item must be an object/,
    ],
  ];

  for (const [name, call, message] of SHAPES) {
    for (const tool of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
      it(`${tool}: ${name}`, async () => {
        const err = await refusedIn(tool, call, 1000);
        expect(err.message).toMatch(message);
        expect(mockCreateRpcClient).not.toHaveBeenCalled();
      });
    }
  }

  it("the caps: 256-character types, 1024-character names, generous item/parameter counts", () => {
    expect(MAX_ABI_TYPE_LENGTH).toBe(256);
    expect(MAX_ABI_NAME_LENGTH).toBe(1024);
    // Real ABIs overload a name at most a few times (Uniswap v4 PoolManager extsload: 3).
    expect(MAX_ABI_OVERLOADS).toBe(16);
    // Real ABIs: Seaport, Uniswap v4 PoolManager, Safe and 52 Kaia system contracts have
    // at most a few hundred items and a few thousand parameters in all.
    expect(MAX_ABI_ITEMS).toBeGreaterThanOrEqual(4096);
    expect(MAX_ABI_PARAMETERS).toBeGreaterThanOrEqual(32_768);
    // Seaport 1.6 (470 parameters, tuples 3 deep) needs about 9 K.
    expect(MAX_ABI_SIGNATURE_CHARS).toBeGreaterThanOrEqual(128 * 1024);
  });

  it("an ABI at the item, parameter and character caps is still resolved in bounded time", async () => {
    // MAX_ABI_ITEMS functions (MAX_ABI_OVERLOADS of them `f`), whose parameters use up the
    // parameter budget and (nearly) the character budget: the most work a bounded ABI can
    // ask of viem's lookup, by name and by selector.
    const perItem = Math.floor(MAX_ABI_PARAMETERS / MAX_ABI_ITEMS) - 1;
    const typeLen = Math.floor(MAX_ABI_SIGNATURE_CHARS / (MAX_ABI_ITEMS * perItem)) - 2;
    const type = "uint8" + "[]".repeat(Math.max(0, Math.floor((typeLen - 5) / 2)));
    const abi = Array.from({ length: MAX_ABI_ITEMS }, (_, i) =>
      fnItem(
        i < MAX_ABI_OVERLOADS ? "f" : `g${i}`,
        Array.from({ length: perItem }, () => ({ type })),
        []
      )
    );
    for (const tool of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
      for (const functionName of ["f", "0x12345678"]) {
        const t0 = performance.now();
        let thrown: unknown;
        await TOOLS[tool]({ abi, functionName, args: Array(perItem).fill([]) }).catch((e) => {
          thrown = e;
        });
        // Refused or not, never by a bound: these are all inside the caps.
        expect(String((thrown as Error | undefined)?.message)).not.toMatch(/more than|longer than/);
        expect(performance.now() - t0, `${tool} ${functionName}`).toBeLessThan(1500);
      }
    }
  });
});

describe("M-A: read_contract resolves the function once", () => {
  const ERC721 = [
    fnItem("safeTransferFrom", [{ type: "address" }, { type: "address" }, { type: "uint256" }], []),
    fnItem(
      "safeTransferFrom",
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      []
    ),
    fnItem("balanceOf", [{ type: "address" }]),
    fnItem("balanceOf", [{ type: "address" }, { type: "uint256" }]),
    { type: "event", name: "Transfer", inputs: [{ type: "address", indexed: true }] },
  ];

  it("kaia resolves the overload (no getAbiItem), and the RPC gets that function's calldata", async () => {
    const res = await handleReadContract({
      contractAddress: ADDR,
      abi: ERC721,
      functionName: "balanceOf",
      args: [ADDR, 5],
      network: "mainnet",
    });
    expect(res.content[0].text).toBe("Result:\n7");
    expect(getAbiItemSpy).not.toHaveBeenCalled();
    const client = mockCreateRpcClient.mock.results[0]?.value as {
      call: ReturnType<typeof vi.fn>;
    };
    expect(client.call).toHaveBeenCalledWith({
      to: ADDR,
      data: viem.encodeFunctionData({
        abi: [ERC721[3]] as viem.Abi,
        functionName: "balanceOf",
        args: [ADDR, 5n],
      }),
    });
  });

  it("overloads and selectors still resolve as viem resolves them", async () => {
    const one = await handleEncodeFunctionData({
      abi: ERC721,
      functionName: "safeTransferFrom",
      args: [ADDR, ADDR, 1, "0x"],
    });
    expect(one.content[0].text.slice(0, 10)).toBe(
      viem.toFunctionSelector("safeTransferFrom(address,address,uint256,bytes)")
    );
    expect(getAbiItemSpy).not.toHaveBeenCalled();
    const sel = viem.toFunctionSelector("balanceOf(address)");
    const two = await handleEncodeFunctionData({ abi: ERC721, functionName: sel, args: [ADDR] });
    expect(two.content[0].text.slice(0, 10)).toBe(sel);
    await expect(
      handleEncodeFunctionData({ abi: ERC721, functionName: "0xdeadbeef", args: [] })
    ).rejects.toThrow(/Function "0xdeadbeef" not found on ABI/);
    await expect(
      handleEncodeFunctionData({ abi: ERC721, functionName: "Transfer", args: [ADDR] })
    ).rejects.toThrow(/Function "Transfer" not found on ABI/);
  });

  it("MAX_ABI_OVERLOADS overloads still resolve; one more is refused", async () => {
    const abi = Array.from({ length: MAX_ABI_OVERLOADS }, (_, i) =>
      fnItem(
        "f",
        Array.from({ length: i + 1 }, () => ({ type: "uint256" }))
      )
    );
    const r = await handleEncodeFunctionData({ abi, functionName: "f", args: [1, 2, 3] });
    expect(r.content[0].text.slice(0, 10)).toBe(
      viem.toFunctionSelector("f(uint256,uint256,uint256)")
    );
    await expect(
      handleEncodeFunctionData({
        abi: [...abi, fnItem("f", [{ type: "address" }])],
        functionName: "f",
        args: [1, 2, 3],
      })
    ).rejects.toThrow(/more than 16 items match/);
  });

  it("a bad type in an overload the args cannot select is not checked (viem skips it too)", async () => {
    const abi = [
      fnItem("f", [{ type: "uint256" }]),
      fnItem("f", [{ type: "nope" }, { type: "x" }]),
    ];
    const r = await handleEncodeFunctionData({ abi, functionName: "f", args: ["1"] });
    expect(r.content[0].text.slice(0, 10)).toBe(viem.toFunctionSelector("f(uint256)"));
    // By selector, only the function with that selector is a candidate: another function
    // with as many inputs and a bad type is not compared, so it is not checked either.
    const sel = viem.toFunctionSelector("f(uint256)");
    const withOther = [fnItem("f", [{ type: "uint256" }]), fnItem("g", [{ type: "nope" }])];
    const s2 = await handleEncodeFunctionData({ abi: withOther, functionName: sel, args: ["1"] });
    expect(s2.content[0].text.slice(0, 10)).toBe(sel);
  });
});

describe("functionName is capped too", () => {
  it("a 1 MB functionName on an ordinary ABI is refused before any lookup", async () => {
    for (const tool of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
      const err = await refusedIn(
        tool,
        { abi: [fnItem("f", [{ type: "uint256" }])], functionName: "f".repeat(1 << 20) },
        1000
      );
      expect(err.message).toBe("Invalid functionName: longer than 1024 characters.");
      expect(getAbiItemSpy).not.toHaveBeenCalled();
    }
  });
});

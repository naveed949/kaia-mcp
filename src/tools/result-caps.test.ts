/**
 * read_contract result-size caps (issue #11 P-1). Literal limits on purpose: this file runs
 * against main too (where every refusal below is missing).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { decodeFunctionResult, encodeAbiParameters, type AbiParameter, type Hex } from "viem";
import { handleReadContract } from "./contract.js";
import { createRpcClient } from "../clients/rpc.js";
import { resetConfigCache } from "../config.js";
import { toMcpError } from "../utils/errors.js";

vi.mock("../clients/rpc.js", () => ({ createRpcClient: vi.fn() }));
const mockCreateRpcClient = vi.mocked(createRpcClient);

const CONTRACT = "0x000000000000000000000000000000000000dEaD";
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const fill = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const addr = (i: number) =>
  `0x${(BigInt(i + 1) * 0x9e3779b97f4a7c15n).toString(16).padStart(40, "0").slice(-40)}`;

/** P-1: a dynamic array of `count` offsets that all point at one `length`-byte payload. */
const aliased = (count: number, length: number, byte = "61"): Hex =>
  `0x${word(32)}${word(count)}${word(count * 32).repeat(count)}${word(length)}${byte.repeat(length)}${"00".repeat((32 - (length % 32)) % 32)}`;

let returned: Hex;
let call: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetConfigCache();
  vi.clearAllMocks();
  call = vi.fn(async () => ({ data: returned }));
  mockCreateRpcClient.mockReturnValue({ call } as unknown as ReturnType<typeof createRpcClient>);
});

const read = (outputs: readonly AbiParameter[]) =>
  handleReadContract({
    contractAddress: CONTRACT,
    functionName: "f",
    abi: [{ type: "function", name: "f", inputs: [], outputs, stateMutability: "view" }],
    args: [],
  }).then((r) => r.content[0].text);

/** What main printed for this result: viem's decode, pretty-printed as read_contract does. */
const mainText = (outputs: readonly AbiParameter[], data: Hex): string => {
  const fn = { type: "function", name: "f", inputs: [], outputs, stateMutability: "view" } as const;
  const result = decodeFunctionResult({ abi: [fn], functionName: "f", data } as never) as unknown;
  const text =
    result === undefined || result === null
      ? "null"
      : typeof result === "object"
        ? JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
        : String(result);
  return `Result:\n${text}`;
};

async function refusal(p: Promise<unknown>) {
  const t0 = performance.now();
  try {
    await p;
  } catch (err) {
    return { ...toMcpError(err), ms: performance.now() - t0 };
  }
  throw new Error("expected a refusal");
}

const TEXT_LIMIT =
  "Contract call result is too large: its decoded text is over 4194304 characters (the read_contract limit).";

describe("read_contract: aliased offsets cannot amplify the result (P-1)", () => {
  it("refuses string[] whose 4000 elements all point at one 2 KB string, fast (-32005)", async () => {
    returned = aliased(4000, 2048); // 194 KB; decodes to 8.2 MB of text on main
    const r = await refusal(read([{ name: "", type: "string[]" }]));
    expect(r).toMatchObject({ code: -32005, message: TEXT_LIMIT });
    expect(r).not.toHaveProperty("data");
    expect(r.ms).toBeLessThan(500);
  });

  it("refuses the same payload as bytes[] (main: 16 MB of hex)", async () => {
    returned = aliased(4000, 2048);
    const r = await refusal(read([{ name: "", type: "bytes[]" }]));
    expect(r).toMatchObject({ code: -32005, message: TEXT_LIMIT });
    expect(r.ms).toBeLessThan(500);
  });

  it("refuses the full P-1 payload (4000 x 64 KB, 193 KB) in well under a second", async () => {
    returned = aliased(4000, 65_536);
    for (const type of ["string[]", "bytes[]"]) {
      const r = await refusal(read([{ name: "", type }]));
      expect(r).toMatchObject({ code: -32005, message: TEXT_LIMIT });
      expect(r.ms).toBeLessThan(500);
    }
  });

  it("counts every reference: 31 x 64 KB of bytes fits, 33 do not", async () => {
    returned = aliased(31, 65_536); // 31 x (2 + 131072 + 2 + indent) ~ 4.06 M characters
    const outputs = [{ name: "", type: "bytes[]" }];
    expect(await read(outputs)).toBe(mainText(outputs, returned));
    returned = aliased(33, 65_536);
    expect(await refusal(read(outputs))).toMatchObject({ code: -32005, message: TEXT_LIMIT });
  });

  it("charges escaped string characters: 400 references to 2 KB of \\u0001 are refused", async () => {
    returned = aliased(400, 2048, "01"); // 400 x 2048 x 6 characters ("\u0001") = 4.9 M
    expect(await refusal(read([{ name: "", type: "string[]" }]))).toMatchObject({
      code: -32005,
      message: TEXT_LIMIT,
    });
  });

  it("refuses a huge length of zero-width elements without looping over it", async () => {
    // main: viem's read limit, -32001. Now the length is charged first: -32005.
    returned = `0x${word(32)}${word(2n ** 53n - 1n)}${word(0)}`;
    const r = await refusal(read([{ name: "", type: "uint8[0][]" }]));
    expect(r).toMatchObject({ code: -32005, message: TEXT_LIMIT });
    expect(r.ms).toBeLessThan(200);
    // With no data where the elements would start, it is bad data, as on main.
    returned = `0x${word(32)}${word(2n ** 53n - 1n)}`;
    expect(await refusal(read([{ name: "", type: "uint8[0][]" }]))).toMatchObject({
      code: -32001,
    });
  });
});

describe("read_contract: raw result size", () => {
  const outputs = [{ name: "", type: "bytes" }];

  it("decodes a 2 MB result (one bytes value) exactly as main and refuses one byte more", async () => {
    returned = encodeAbiParameters(outputs, [`0x${"ab".repeat(2_097_152 - 64)}`]);
    expect((returned.length - 2) / 2).toBe(2_097_152);
    expect(await read(outputs)).toBe(mainText(outputs, returned));
    returned = `${returned}00` as Hex;
    const r = await refusal(read(outputs));
    expect(r).toMatchObject({
      code: -32005,
      message:
        "Contract call result is too large: it is over 2097152 bytes (the read_contract limit).",
    });
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("read_contract: addresses", () => {
  const outputs = [{ name: "", type: "address[]" }];

  it("decodes 8192 addresses exactly as main and refuses 8193", async () => {
    returned = encodeAbiParameters(outputs, [fill(8192, addr)]);
    expect(await read(outputs)).toBe(mainText(outputs, returned));
    returned = encodeAbiParameters(outputs, [fill(8193, addr)]);
    expect(await refusal(read(outputs))).toMatchObject({
      code: -32005,
      message:
        "Contract call result is too large: it holds over 8192 addresses (the read_contract limit).",
    });
  });
});

describe("read_contract: realistic large results are unchanged", () => {
  it("Multicall3 aggregate3 of 9000 balanceOf results (1.44 MB) decodes exactly as main", async () => {
    const outputs = [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ];
    returned = encodeAbiParameters(outputs, [
      fill(9000, (i) => ({ success: i % 7 !== 0, returnData: `0x${word(i * 1e15)}` as Hex })),
    ]);
    expect(await read(outputs)).toBe(mainText(outputs, returned));
  });

  it("Multicall3 aggregate (blockNumber, bytes[]) and a big uint256[] getter decode as main", async () => {
    const agg = [
      { name: "blockNumber", type: "uint256" },
      { name: "returnData", type: "bytes[]" },
    ];
    returned = encodeAbiParameters(agg, [123n, fill(9000, (i) => `0x${word(i)}` as Hex)]);
    expect(await read(agg)).toBe(mainText(agg, returned));
    const arr = [{ name: "", type: "uint256[]" }];
    returned = encodeAbiParameters(arr, [fill(60_000, (i) => BigInt(i) * 10n ** 18n)]);
    expect(await read(arr)).toBe(mainText(arr, returned));
  });

  it("a named tuple with strings, ints and nested arrays decodes as main", async () => {
    const outputs = [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "name", type: "string" },
          { name: "delta", type: "int256" },
          { name: "ids", type: "uint64[2][]" },
          { name: "tag", type: "bytes4" },
        ],
      },
      { name: "ok", type: "bool" },
    ];
    returned = encodeAbiParameters(outputs, [
      {
        owner: addr(1),
        name: 'Kaia "Token" \n\u0001 日本',
        delta: -(2n ** 255n),
        ids: fill(50, (i) => [BigInt(i), 2n ** 64n - 1n]),
        tag: "0x12345678",
      },
      true,
    ]);
    expect(await read(outputs)).toBe(mainText(outputs, returned));
  });
});

describe("read_contract: data viem cannot decode still fails as upstream data (-32001)", () => {
  it("an offset past the end of the result", async () => {
    returned = `0x${word(4096)}`;
    expect(await refusal(read([{ name: "", type: "string" }]))).toMatchObject({
      code: -32001,
      message: "Upstream RPC request failed.",
    });
  });

  it("an array length that runs past the end of the result", async () => {
    returned = `0x${word(32)}${word(1_000_000)}${word(1)}`;
    expect(await refusal(read([{ name: "", type: "uint256[]" }]))).toMatchObject({
      code: -32001,
      message: "Upstream RPC request failed.",
    });
  });
});

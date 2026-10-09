import { describe, it, expect, beforeEach, vi } from "vitest";
import { toFunctionSelector } from "viem";
import { handleEncodeFunctionData } from "./wallet.js";
import { handleReadContract } from "./contract.js";
import { createRpcClient } from "../clients/rpc.js";
import { resetConfigCache } from "../config.js";

vi.mock("../clients/rpc.js", () => ({ createRpcClient: vi.fn() }));
const mockCreateRpcClient = vi.mocked(createRpcClient);

const A = "0x000000000000000000000000000000000000dEaD";
const fn = (name: string, types: string[]) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: types.map((type) => ({ name: "", type })),
  outputs: [{ name: "", type: "uint256" }],
});
const abiOf = (types: string[]) => JSON.stringify([fn("f", types)]);
const encode = (abi: string, args: unknown[], functionName = "f") =>
  handleEncodeFunctionData({ abi, functionName, args }).then((r) => r.content[0].text);
const nest = (depth: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    return { code: (e as { code?: unknown }).code, message: (e as Error).message };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  resetConfigCache();
  vi.clearAllMocks();
  mockCreateRpcClient.mockReturnValue({
    call: vi.fn().mockResolvedValue({ data: `0x${"0".repeat(63)}7` }),
  } as unknown as ReturnType<typeof createRpcClient>);
});

describe("tool argument caps", () => {
  it("encodes 32768 values (an array of 32767 numbers) and refuses one more", async () => {
    const abi = abiOf(["uint256[]"]);
    const data = await encode(abi, [fill(32_767, 1)]);
    expect(data.length).toBe(10 + 64 * 2 + 64 * 32_767);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("f(uint256[])"));
    expect(await refusal(encode(abi, [fill(32_768, 1)]))).toEqual({
      code: -32602,
      message:
        "Invalid args: more than 32768 values (array elements, tuple members and scalars) in all.",
    });
  });

  it("encodes 24000 addresses (1008000 characters)", async () => {
    const data = await encode(abiOf(["address[]"]), [fill(24_000, A)]);
    expect(data.length).toBe(10 + 64 * 2 + 64 * 24_000);
    expect(data.endsWith("dead")).toBe(true);
  });

  it("counts values at every depth and across every argument", async () => {
    const abi = abiOf(["uint256[][]", "uint256[]"]);
    // 2 arguments + 8192 * (1 + 3) = 32770
    expect((await refusal(encode(abi, [fill(8192, [1, 2, 3]), []]))).message).toContain(
      "more than 32768 values"
    );
    // 2 + 8191 * 4 + 2 = 32768: at the cap
    await expect(encode(abi, [fill(8191, [1, 2, 3]), [1, 2]])).resolves.toMatch(/^0x/);
    expect((await refusal(encode(abi, [fill(8191, [1, 2, 3]), [1, 2, 3]]))).message).toContain(
      "more than 32768 values"
    );
  });

  it("accepts arrays nested 32 deep and refuses 33", async () => {
    await expect(encode(abiOf([`uint256${"[]".repeat(32)}`]), [nest(32)])).resolves.toMatch(/^0x/);
    expect(await refusal(encode(abiOf([`uint256${"[]".repeat(33)}`]), [nest(33)]))).toEqual({
      code: -32602,
      message: "Invalid args: arrays and objects nested more than 32 deep.",
    });
  });

  it("accepts 1048576 characters of strings and refuses one more", async () => {
    const abi = abiOf(["string", "bytes"]);
    const half = 524_288;
    const data = await encode(abi, ["a".repeat(half), `0x${"ab".repeat((half - 2) / 2)}`]);
    expect(data.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(
      await refusal(encode(abi, ["a".repeat(half + 1), `0x${"ab".repeat((half - 2) / 2)}`]))
    ).toEqual({
      code: -32602,
      message: "Invalid args: more than 1048576 characters of strings in all.",
    });
  });

  it("counts object keys (named tuple members) as characters", async () => {
    const abi = JSON.stringify([
      {
        type: "function",
        name: "f",
        stateMutability: "view",
        inputs: [{ name: "t", type: "tuple", components: [{ name: "x", type: "uint256" }] }],
        outputs: [],
      },
    ]);
    const key = "k".repeat(1_048_577);
    expect((await refusal(encode(abi, [{ [key]: 1 }]))).message).toContain(
      "more than 1048576 characters"
    );
  });

  it("refuses over-cap args before resolving the function (an unknown name still hits the cap)", async () => {
    expect((await refusal(encode(abiOf(["uint256[]"]), [fill(40_000, 1)], "nope"))).message).toBe(
      "Invalid args: more than 32768 values (array elements, tuple members and scalars) in all."
    );
  });

  it("read_contract refuses over-cap args with no RPC call", async () => {
    const r = await refusal(
      handleReadContract({
        contractAddress: A,
        functionName: "f",
        abi: abiOf(["string"]),
        args: ["a".repeat(2_000_000)],
        network: "kairos",
      })
    );
    expect(r).toEqual({
      code: -32602,
      message: "Invalid args: more than 1048576 characters of strings in all.",
    });
    expect(mockCreateRpcClient).not.toHaveBeenCalled();
  });

  it("refuses in-process shapes JSON cannot carry: sparse arrays, cycles, typed arrays", async () => {
    const abi = abiOf(["uint256[]"]);
    expect((await refusal(encode(abi, [new Array(1e9)]))).message).toContain(
      "more than 32768 values"
    );
    const cyc: unknown[] = [];
    cyc.push(cyc);
    expect((await refusal(encode(abi, [cyc]))).message).toContain("nested more than 32 deep");
    expect((await refusal(encode(abiOf(["bytes"]), [new Uint8Array(600_000)]))).message).toContain(
      "more than 1048576 characters"
    );
  });

  it("refuses the worst over-cap payloads in under 50 ms each", async () => {
    const ovl = JSON.stringify(
      Array.from({ length: 16 }, (_, i) => fn("f", [i === 15 ? "uint256[]" : "bool[]"]))
    );
    const payloads: Array<[string, string, unknown[]]> = [
      ["flat 1.6M-element array", ovl, [fill(1_600_000, 1)]],
      ["1M one-element arrays", abiOf(["uint256[][]"]), [fill(1_000_000, [1])]],
      ["4M-character string", abiOf(["string"]), ["a".repeat(4_000_000)]],
      ["1M one-character strings", abiOf(["string[]"]), [fill(1_000_000, "a")]],
      ["100k-deep nesting", abiOf(["uint256[]"]), [nest(100_000)]],
    ];
    for (const [what, abi, args] of payloads) {
      const t0 = performance.now();
      const r = await refusal(encode(abi, args));
      const ms = performance.now() - t0;
      expect(r.code, what).toBe(-32602);
      expect(r.message, what).toMatch(/^Invalid args: /);
      expect(ms, what).toBeLessThan(50);
    }
  });
});

describe("encode error messages", () => {
  it("cut the echoed argument to a bounded length", async () => {
    const r = await refusal(encode(abiOf(["bool"]), ["x".repeat(100_000)]));
    expect(r.code).toBe(-32602);
    expect(r.message.startsWith('Invalid arguments: Invalid boolean value: "xxx')).toBe(true);
    expect(r.message.endsWith("…")).toBe(true);
    expect(r.message.length).toBeLessThanOrEqual("Invalid arguments: ".length + 257);
  });

  it("leave a short message whole", async () => {
    expect((await refusal(encode(abiOf(["bool"]), [1]))).message).toBe(
      'Invalid arguments: Invalid boolean value: "1" (type: number). Expected: `true` or `false`.'
    );
  });
});

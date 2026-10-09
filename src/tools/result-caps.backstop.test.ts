/**
 * read_contract checks the printed text against the cap again after decoding, so the
 * response can never pass the cap even if the pre-decode walk undercounted. Here the walk
 * is stubbed to count nothing.
 */
import { describe, it, expect, vi } from "vitest";
import type { Hex } from "viem";
import { handleReadContract } from "./contract.js";
import { createRpcClient } from "../clients/rpc.js";
import { toMcpError } from "../utils/errors.js";

vi.mock("../clients/rpc.js", () => ({ createRpcClient: vi.fn() }));
vi.mock("../utils/result-size.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/result-size.js")>()),
  checkResultSize: () => 0,
}));

const word = (n: number) => n.toString(16).padStart(64, "0");

describe("read_contract: the printed text is checked against the cap after decoding", () => {
  it("refuses 4000 references to one 2 KB string (8.2 M characters) with -32005", async () => {
    const data: Hex = `0x${word(32)}${word(4000)}${word(4000 * 32).repeat(4000)}${word(2048)}${"61".repeat(2048)}`;
    vi.mocked(createRpcClient).mockReturnValue({
      call: vi.fn(async () => ({ data })),
    } as unknown as ReturnType<typeof createRpcClient>);
    let caught: unknown;
    try {
      await handleReadContract({
        contractAddress: "0x000000000000000000000000000000000000dEaD",
        functionName: "f",
        abi: [
          {
            type: "function",
            name: "f",
            inputs: [],
            outputs: [{ name: "", type: "string[]" }],
            stateMutability: "view",
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(toMcpError(caught)).toEqual({
      code: -32005,
      message:
        "Contract call result is too large: its decoded text is over 4194304 characters (the read_contract limit).",
    });
  });
});

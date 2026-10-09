/**
 * A tool argument the caller got wrong is a client mistake: JSON-RPC -32602 Invalid params,
 * logged once at info as `Request denied ... category=invalid_params outcome=denied`, with
 * no caller text. A real server fault stays at error: an unexpected exception is -32603
 * (`Tool error ... category=internal`); upstream faults are covered by
 * server.upstream-errors.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { DEMO_CLIENT_ID, SCOPES } from "./auth/constants.js";
import type { AuthContext } from "./auth/types.js";

const getChainId = vi.fn();
const getBalance = vi.fn();
// read_contract sends its calldata with `call` and decodes the result itself (PR #9 r5).
const call = vi.fn();
const estimateGas = vi.fn();
const getGasPrice = vi.fn();
vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({
    getChainId,
    getBalance,
    call,
    estimateGas,
    getGasPrice,
  })),
}));
const kaiascanGet = vi.fn();
vi.mock("./clients/kaiascan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clients/kaiascan.js")>()),
  createKaiaScanClient: vi.fn(() => ({ get: kaiascanGet })),
}));

const MARKER = "CALLER_MARKER_zq";
const PING_ABI = JSON.stringify([
  { type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "view" },
]);
const BALANCE_OF_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
]);
const ADDR = "0x1234567890123456789012345678901234567890";

const ctx: AuthContext = {
  subject: "demo-user",
  clientId: DEMO_CLIENT_ID,
  scopes: [SCOPES.READ, SCOPES.ENCODE],
  expiresAtMs: Date.now() + 600_000,
  tokenFingerprint: "deadbeefcafe",
  tokenId: "11111111-2222-3333-4444-555555555555",
};

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createKaiaMcpServer({ requireAuth: true, getAuthContext: () => ctx });
  await server.connect(serverTransport);
  const client = new Client({ name: "invalid-params", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("tool argument validation -> -32602 at info; server faults -> -32603 at error", () => {
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;
  const lines = () => chunks.join("").split("\n").filter(Boolean);

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    resetConfigCache();
    chunks.length = 0;
    getChainId.mockReset();
    getBalance.mockReset();
    call.mockReset();
    estimateGas.mockReset();
    getGasPrice.mockReset();
    kaiascanGet.mockReset();
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = orig;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  const CASES: Array<[string, string, Record<string, unknown>, RegExp]> = [
    ["encode_function_data", "abi not JSON", { abi: "not json", functionName: "x" }, /Invalid ABI/],
    ["encode_function_data", "abi not array", { abi: "{}", functionName: "x" }, /Invalid ABI/],
    [
      "encode_function_data",
      "functionName empty",
      { abi: PING_ABI, functionName: " " },
      /functionName/,
    ],
    [
      "encode_function_data",
      "args not array",
      { abi: PING_ABI, functionName: "ping", args: 1 },
      /args/,
    ],
    [
      "encode_function_data",
      "function not on ABI (viem)",
      { abi: PING_ABI, functionName: MARKER },
      /Invalid arguments/,
    ],
    [
      "encode_function_data",
      "arg does not fit the ABI (viem)",
      { abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [MARKER] },
      /Invalid arguments/,
    ],
    [
      "encode_function_data",
      "caller text with '429' / 'kaiascan' stays invalid params",
      { abi: PING_ABI, functionName: "x429_kaiascan_ECONNREFUSED" },
      /Invalid arguments/,
    ],
    [
      "encode_function_data",
      "args over the value cap",
      { abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [Array(40_000).fill(1)] },
      /^Invalid args: more than 32768 values/,
    ],
    [
      "read_contract",
      "args over the character cap, before any RPC",
      {
        contractAddress: ADDR,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: ["a".repeat(1_048_577)],
      },
      /^Invalid args: more than 1048576 characters/,
    ],
    ["get_kaia_balance", "bad address", { address: "not-an-address" }, /Invalid address/],
    ["get_kaia_balance", "bad network", { address: ADDR, network: MARKER }, /Invalid network/],
    ["get_transaction", "bad tx hash", { txHash: "zz" }, /Invalid transaction hash/],
    ["get_block", "missing block", {}, /Block number or hash is required/],
    ["get_block_rewards", "bad block string", { blockNumber: "zz" }, /Invalid block number/],
    ["get_block_rewards", "bad block type", { blockNumber: true }, /Invalid block number/],
    ["get_nft_item", "missing tokenId", { contractAddress: ADDR }, /tokenId is required/],
    [
      "read_contract",
      "arg does not fit the ABI, before any RPC",
      { contractAddress: ADDR, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [MARKER] },
      /Invalid arguments/,
    ],
    // L3 (round 2): inputs that used to throw a raw SyntaxError/TypeError (or fail after the
    // upstream call) and log at error. All are rejected before any RPC or KaiaScan call.
    ["estimate_gas", "value not a number", { from: ADDR, value: "abc" }, /Invalid value/],
    ["estimate_gas", "value a decimal", { from: ADDR, value: "1.5" }, /Invalid value/],
    ["estimate_gas", "value negative", { from: ADDR, value: -1 }, /Invalid value/],
    ["estimate_gas", "value an object", { from: ADDR, value: { toString: 1 } }, /Invalid value/],
    ["estimate_gas", "data not hex", { from: ADDR, data: "zz" }, /Invalid data/],
    ["estimate_gas", "data odd length", { from: ADDR, data: "0x123" }, /Invalid data/],
    ["estimate_gas", "data an object", { from: ADDR, data: { toString: 1 } }, /Invalid data/],
    ["estimate_gas", "to an object", { from: ADDR, to: { toString: 1 } }, /Invalid address/],
    [
      "get_nft_item",
      "tokenId an object",
      { contractAddress: ADDR, tokenId: { toString: 1 } },
      /Invalid tokenId/,
    ],
    [
      "get_nft_item",
      "tokenId an array",
      { contractAddress: ADDR, tokenId: [1] },
      /Invalid tokenId/,
    ],
    ["get_nft_item", "tokenId negative", { contractAddress: ADDR, tokenId: -1 }, /Invalid tokenId/],
    [
      "get_nft_item",
      "tokenId fractional",
      { contractAddress: ADDR, tokenId: 1.5 },
      /Invalid tokenId/,
    ],
    [
      "read_contract",
      "bogus output type",
      {
        contractAddress: ADDR,
        functionName: "f",
        abi: [
          {
            type: "function",
            name: "f",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "bogus" }],
          },
        ],
      },
      /Invalid ABI: output parameter has unknown type/,
    ],
    [
      "read_contract",
      "no outputs array",
      {
        contractAddress: ADDR,
        functionName: "f",
        abi: [{ type: "function", name: "f", stateMutability: "view", inputs: [] }],
      },
      /no outputs array/,
    ],
    [
      "read_contract",
      "tuple output without components",
      {
        contractAddress: ADDR,
        functionName: "f",
        abi: [
          {
            type: "function",
            name: "f",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "tuple" }],
          },
        ],
      },
      /components/,
    ],
    [
      "read_contract",
      "output type bytes33",
      {
        contractAddress: ADDR,
        functionName: "f",
        abi: [
          {
            type: "function",
            name: "f",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "bytes33" }],
          },
        ],
      },
      /unknown type/,
    ],
    [
      "get_token_holders",
      "page an object",
      { contractAddress: ADDR, page: { toString: 1 } },
      /Invalid page/,
    ],
    [
      "get_token_transfers",
      "size an array of objects",
      { contractAddress: ADDR, size: [{ toString: 1 }] },
      /Invalid size/,
    ],
    [
      "get_nft_transfers",
      "page an object",
      { contractAddress: ADDR, page: { toString: 1 } },
      /Invalid page/,
    ],
    [
      "get_account_tokens",
      "size an object",
      { address: ADDR, size: { toString: 1 } },
      /Invalid size/,
    ],
    [
      "get_account_nfts",
      "page an object",
      { address: ADDR, page: { toString: 1 } },
      /Invalid page/,
    ],
    [
      "get_account_transactions",
      "limit an object",
      { address: ADDR, limit: { toString: 1 } },
      /Invalid limit/,
    ],
  ];

  for (const [tool, label, args, message] of CASES) {
    it(`${tool}: ${label}`, async () => {
      const client = await connect();
      await expect(client.callTool({ name: tool, arguments: args })).rejects.toMatchObject({
        code: -32602,
        message: expect.stringMatching(message),
      });
      const denied = lines().filter((l) => l.includes("msg=Request denied"));
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatch(
        / level=info msg=Request denied code=-32602 method=tools\/call category=invalid_params errorType=InvalidParamsError outcome=denied$/
      );
      expect(lines().filter((l) => l.includes(" level=error "))).toEqual([]);
      expect(chunks.join("")).not.toContain(MARKER);
      expect(call).not.toHaveBeenCalled();
      expect(getBalance).not.toHaveBeenCalled();
      expect(estimateGas).not.toHaveBeenCalled();
      expect(kaiascanGet).not.toHaveBeenCalled();
    });
  }

  it("valid estimate_gas value/data forms still reach the RPC", async () => {
    estimateGas.mockResolvedValue(21000n);
    getGasPrice.mockResolvedValue(1n);
    const client = await connect();
    for (const [value, data] of [
      ["0x10", "0xabcd"],
      ["16", "abcd"],
      [16, ""],
      [undefined, undefined],
    ] as const) {
      await client.callTool({ name: "estimate_gas", arguments: { from: ADDR, value, data } });
    }
    expect(estimateGas).toHaveBeenCalledTimes(4);
    expect(estimateGas.mock.calls[0][0]).toMatchObject({ value: 16n, data: "0xabcd" });
    expect(estimateGas.mock.calls[1][0]).toMatchObject({ value: 16n, data: "0xabcd" });
    expect(lines().filter((l) => / level=(error|warn) /.test(l))).toEqual([]);
  });

  it("valid ABIs with tuple, array and int-alias outputs pass validation and reach the RPC", async () => {
    call.mockResolvedValue({
      data: encodeAbiParameters(
        parseAbiParameters("(uint256 x,(bytes32[2] z) y)[], int, address[], bytes, string, bool"),
        [[], 1n, [], "0x", "", true]
      ),
    });
    const client = await connect();
    const abi = [
      {
        type: "function",
        name: "f",
        stateMutability: "view",
        inputs: [{ name: "a", type: "uint" }],
        outputs: [
          {
            type: "tuple[]",
            components: [
              { name: "x", type: "uint256" },
              { name: "y", type: "tuple", components: [{ name: "z", type: "bytes32[2]" }] },
            ],
          },
          { type: "int" },
          { type: "address[]" },
          { type: "bytes" },
          { type: "string" },
          { type: "bool" },
        ],
      },
    ];
    await client.callTool({
      name: "read_contract",
      arguments: { contractAddress: ADDR, abi, functionName: "f", args: [1] },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
  });

  it("functionName as a 4-byte selector resolves to the function; a bogus 0x name is -32602", async () => {
    call.mockResolvedValue({ data: `0x${"0".repeat(63)}1` });
    const client = await connect();
    await client.callTool({
      name: "read_contract",
      arguments: {
        contractAddress: ADDR,
        abi: BALANCE_OF_ABI,
        functionName: "0x70a08231",
        args: [ADDR],
      },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(String(call.mock.calls[0][0].data).slice(0, 10)).toBe("0x70a08231"); // balanceOf
    for (const name of ["0x", "0xzz", "0x12345678"]) {
      await expect(
        client.callTool({
          name: "read_contract",
          arguments: {
            contractAddress: ADDR,
            abi: BALANCE_OF_ABI,
            functionName: name,
            args: [ADDR],
          },
        })
      ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/not found on ABI/) });
      await expect(
        client.callTool({
          name: "encode_function_data",
          arguments: { abi: BALANCE_OF_ABI, functionName: name, args: [ADDR] },
        })
      ).rejects.toMatchObject({ code: -32602 });
    }
    expect(call).toHaveBeenCalledTimes(1);
    expect(lines().filter((l) => / level=error /.test(l))).toEqual([]);
  });

  it("numeric strings and numbers for page/size keep their lenient handling", async () => {
    kaiascanGet.mockResolvedValue({ results: [] });
    const client = await connect();
    await client.callTool({
      name: "get_token_holders",
      arguments: { contractAddress: ADDR, page: "2", size: 5 },
    });
    await client.callTool({
      name: "get_token_holders",
      arguments: { contractAddress: ADDR, page: "x", size: null },
    });
    expect(kaiascanGet).toHaveBeenCalledTimes(2);
    expect(kaiascanGet.mock.calls[0][1]).toEqual({ page: "2", size: "5" });
    expect(kaiascanGet.mock.calls[1][1]).toEqual({ page: "1", size: "20" });
  });

  it("an RPC failure stays a server fault: -32603 (or provider code) at error level", async () => {
    getChainId.mockRejectedValue(new Error("boom: unexpected server state"));
    const client = await connect();
    await expect(client.callTool({ name: "get_chain_info", arguments: {} })).rejects.toMatchObject({
      code: -32603,
    });
    const errs = lines().filter((l) => l.includes(" level=error "));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(
      / msg=Tool error code=-32603 method=tools\/call category=internal errorType=Error detail=boom:%20unexpected%20server%20state$/
    );
    expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
  });

  it("a failing eth_call after valid arguments stays a server fault", async () => {
    // Wrapped by getContractError exactly as viem's readContract wraps it, so it is reported
    // as an upstream failure (-32001), not a caller mistake.
    call.mockRejectedValue(new Error("execution reverted for reasons"));
    const client = await connect();
    await expect(
      client.callTool({
        name: "read_contract",
        arguments: {
          contractAddress: ADDR,
          abi: BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [ADDR],
        },
      })
    ).rejects.toMatchObject({ code: -32001 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(lines().filter((l) => l.includes(" level=error msg=Tool error "))).toHaveLength(1);
  });
});

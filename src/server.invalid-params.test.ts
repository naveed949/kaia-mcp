/**
 * A tool argument the caller got wrong is a client mistake: JSON-RPC -32602 Invalid params,
 * logged once at info as `Request denied ... category=invalid_params outcome=denied`, with
 * no caller text. A real server fault (an RPC failure, an unexpected exception) stays
 * -32603 and logs `Tool error` at error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { DEMO_CLIENT_ID, SCOPES } from "./auth/constants.js";
import type { AuthContext } from "./auth/types.js";

const getChainId = vi.fn();
const getBalance = vi.fn();
const readContract = vi.fn();
vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId, getBalance, readContract })),
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
    readContract.mockReset();
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
      expect(readContract).not.toHaveBeenCalled();
      expect(getBalance).not.toHaveBeenCalled();
    });
  }

  it("an RPC failure stays a server fault: -32603 (or provider code) at error level", async () => {
    getChainId.mockRejectedValue(new Error("boom: unexpected server state"));
    const client = await connect();
    await expect(client.callTool({ name: "get_chain_info", arguments: {} })).rejects.toMatchObject({
      code: -32603,
    });
    const errs = lines().filter((l) => l.includes(" level=error "));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/ msg=Tool error code=-32603 category=internal errorType=Error$/);
    expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
  });

  it("a failing readContract after valid arguments stays a server fault", async () => {
    readContract.mockRejectedValue(new Error("execution reverted for reasons"));
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
    ).rejects.toMatchObject({ code: -32603 });
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(lines().filter((l) => l.includes(" level=error msg=Tool error "))).toHaveLength(1);
  });
});

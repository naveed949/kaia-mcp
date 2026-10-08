/**
 * Every tool, every argument, hostile JSON values: with healthy upstreams (a fake RPC node
 * and a fake KaiaScan that always answer), no caller input may produce a server-side
 * failure. Each call either succeeds or is a caller mistake: JSON-RPC -32602 (or an auth
 * denial) with one `level=info msg=Request denied` line. Zero `level=error` lines over the
 * whole sweep, so a raw TypeError/SyntaxError from an unvalidated argument cannot hide.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { listTools } from "./tools/index.js";
import { DEMO_CLIENT_ID, SCOPES } from "./auth/constants.js";
import type { AuthContext } from "./auth/types.js";

const ADDR = "0x1234567890123456789012345678901234567890";
const HASH = "0x" + "ab".repeat(32);
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
];

/** A valid call for each tool; the sweep replaces one argument at a time. */
const BASE: Record<string, Record<string, unknown>> = {
  get_kaia_balance: { address: ADDR },
  get_account_info: { address: ADDR },
  get_account_tokens: { address: ADDR },
  get_account_nfts: { address: ADDR },
  get_transaction: { txHash: HASH },
  get_transaction_receipt: { txHash: HASH },
  get_account_transactions: { address: ADDR },
  estimate_gas: { from: ADDR, to: ADDR, value: "1", data: "0x" },
  get_block_number: {},
  get_block: { blockNumberOrHash: 16 },
  get_block_rewards: { blockNumber: 16 },
  get_token_info: { contractAddress: ADDR },
  get_token_holders: { contractAddress: ADDR },
  get_token_transfers: { contractAddress: ADDR },
  get_token_allowance: { tokenAddress: ADDR, owner: ADDR, spender: ADDR, decimals: 18 },
  get_nft_info: { contractAddress: ADDR },
  get_nft_item: { contractAddress: ADDR, tokenId: "1" },
  get_nft_transfers: { contractAddress: ADDR },
  read_contract: {
    contractAddress: ADDR,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [ADDR],
  },
  get_contract_abi: { contractAddress: ADDR },
  get_contract_source: { contractAddress: ADDR },
  get_gas_price: {},
  get_kaia_price: {},
  get_chain_info: {},
  generate_wallet: {},
  encode_function_data: { abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [ADDR] },
};

const HOSTILE: unknown[] = [
  { toString: 1 },
  [{ toString: 1 }],
  { valueOf: 1, toString: 1 },
  {},
  [],
  true,
  false,
  -1,
  1.5,
  2 ** 60,
  1e308,
  "",
  "   ",
  "zz",
  "0x",
  "0xzz",
  "1.5",
  "-1",
  "x".repeat(5000),
  "\u0000\u202e\n",
  null,
];

// --- fake upstreams -------------------------------------------------------------------
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const block = {
  number: "0x10",
  hash: HASH,
  parentHash: "0x" + "cd".repeat(32),
  nonce: "0x0000000000000000",
  sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: "0x" + "00".repeat(256),
  transactionsRoot: "0x" + "00".repeat(32),
  stateRoot: "0x" + "00".repeat(32),
  receiptsRoot: "0x" + "00".repeat(32),
  miner: "0x" + "11".repeat(20),
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x100",
  gasLimit: "0x1000000",
  gasUsed: "0x0",
  timestamp: "0x6500000",
  transactions: [],
  uncles: [],
  baseFeePerGas: "0x5d21dba00",
};
const tx = {
  hash: HASH,
  nonce: "0x1",
  blockHash: HASH,
  blockNumber: "0x10",
  transactionIndex: "0x0",
  from: "0x" + "11".repeat(20),
  to: "0x" + "22".repeat(20),
  value: "0xde0b6b3a7640000",
  gas: "0x5208",
  gasPrice: "0x5d21dba00",
  input: "0x",
  v: "0x1b",
  r: "0x" + "01".repeat(32),
  s: "0x" + "02".repeat(32),
  type: "0x0",
  chainId: "0x2019",
};
const receipt = {
  transactionHash: HASH,
  transactionIndex: "0x0",
  blockHash: HASH,
  blockNumber: "0x10",
  from: tx.from,
  to: tx.to,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x5d21dba00",
  contractAddress: null,
  logs: [],
  logsBloom: block.logsBloom,
  status: "0x1",
  type: "0x0",
};
function answer(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x2019";
    case "eth_blockNumber":
      return "0x10";
    case "eth_getBalance":
      return "0xde0b6b3a7640000";
    case "eth_gasPrice":
      return "0x5d21dba00";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_call":
      return word(1n);
    case "eth_getBlockByNumber":
    case "eth_getBlockByHash":
      return block;
    case "eth_getTransactionByHash":
      return tx;
    case "eth_getTransactionReceipt":
      return receipt;
    case "kaia_getAccount":
      return { accType: 1, account: { balance: "0x1", nonce: 1, keyType: 1 } };
    default:
      return null;
  }
}
const rpc = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const m = JSON.parse(b) as { id: number; method: string };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer(m.method) }));
  });
});
const realFetch = globalThis.fetch;

const ctx: AuthContext = {
  subject: "demo-user",
  clientId: DEMO_CLIENT_ID,
  scopes: [SCOPES.READ, SCOPES.ENCODE, SCOPES.WALLET],
  expiresAtMs: Date.now() + 3_600_000,
  tokenFingerprint: "deadbeefcafe",
  tokenId: "11111111-2222-3333-4444-555555555555",
};

const chunks: string[] = [];
let orig: typeof process.stderr.write;

beforeAll(async () => {
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  process.env.KAIA_RPC_URL = url;
  process.env.KAIA_KAIROS_RPC_URL = url;
  process.env.RATE_LIMIT_RPC = "100000";
  process.env.RATE_LIMIT_KAIASCAN = "100000";
  process.env.LOG_LEVEL = "debug";
  resetConfigCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.startsWith("https://api.kaiascan.io/")) {
      return new Response(JSON.stringify({ results: [], paging: { total_count: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  });
  orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterAll(async () => {
  process.stderr.write = orig;
  vi.restoreAllMocks();
  await new Promise<void>((r) => rpc.close(() => r()));
  for (const k of [
    "KAIA_RPC_URL",
    "KAIA_KAIROS_RPC_URL",
    "RATE_LIMIT_RPC",
    "RATE_LIMIT_KAIASCAN",
    "LOG_LEVEL",
  ]) {
    delete process.env[k];
  }
  resetConfigCache();
});

describe("all tools: caller input never reaches error level", () => {
  it("the sweep covers every tool kaia lists", () => {
    const names = listTools({ requireAuth: false }).tools.map((t) => t.name);
    // generate_wallet is hidden from the partner list; it is swept anyway.
    for (const n of names) expect(Object.keys(BASE)).toContain(n);
    expect(Object.keys(BASE)).toHaveLength(26);
  });

  for (const tool of Object.keys(BASE)) {
    it(`${tool}: every argument x ${HOSTILE.length} hostile values -> success or -32602 at info`, async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createKaiaMcpServer({ requireAuth: true, getAuthContext: () => ctx });
      await server.connect(serverTransport);
      const client = new Client({ name: "sweep", version: "1.0.0" });
      await client.connect(clientTransport);
      const schema = (
        listTools({ requireAuth: false }).tools.find((t) => t.name === tool) ?? {
          inputSchema: { properties: {} },
        }
      ).inputSchema as { properties?: Record<string, unknown> };
      const props = Object.keys({ ...BASE[tool], ...(schema.properties ?? {}) });
      chunks.length = 0;
      const bad: string[] = [];
      for (const prop of props) {
        for (const value of HOSTILE) {
          const args = { ...BASE[tool], [prop]: value };
          const r = await client.callTool({ name: tool, arguments: args }).then(
            () => ({ ok: true as const }),
            (e: { code?: number }) => ({ ok: false as const, code: e.code })
          );
          if (!r.ok && r.code !== -32602 && r.code !== -32044) {
            bad.push(`${prop}=${JSON.stringify(value).slice(0, 40)} -> ${r.code}`);
          }
        }
      }
      const errors = chunks
        .join("")
        .split("\n")
        .filter((l) => / level=error /.test(l));
      expect(bad).toEqual([]);
      expect(errors).toEqual([]);
      await client.close();
    });
  }
});

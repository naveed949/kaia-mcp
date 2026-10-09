/**
 * Upstream faults (the RPC node or KaiaScan failing) are server-side failures, whatever
 * JSON-RPC code the upstream used: the node answering -32602/-32601/-32600/-32700/-32042
 * is not the caller's mistake. They answer kaia's own upstream codes (-32001 RPC provider,
 * -32004 KaiaScan, -32003 rate limit; never a code the SDK rewrites into -32602) and log
 * one `level=error msg=Tool error` line with an upstream category. The caller only gets a
 * fixed, generic message: never the RPC URL (which often embeds an API key, in its path or
 * query string), the request body, the KaiaScan API key or a stack. The detail stays in the
 * server log, redacted.
 *
 * Real viem clients talk to an in-process fake RPC node; nothing is mocked but KaiaScan's
 * HTTPS endpoint.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { DEMO_CLIENT_ID, SCOPES } from "./auth/constants.js";
import type { AuthContext } from "./auth/types.js";
import { encodeErrorResult } from "viem";

const RPC_KEY = "FAKEKEYpath7Qx9v2mN4bLr8Tz3Wc6Yd";
const RPC_QUERY_KEY = "FAKEQUERYkey5Hs1Jp0Ku7"; // in ?apikey=
const SCAN_KEY = "FAKESCANkey3Gt8Rw2Ze6";
const SECRETS = [RPC_KEY, RPC_QUERY_KEY, SCAN_KEY];
const ADDR = "0x1234567890123456789012345678901234567890";
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
];

const ERR: Record<string, { code: number; message: string }> = {
  "rpc-32602": { code: -32602, message: "invalid argument 0: hex string has length 3" },
  "rpc-32601": { code: -32601, message: "the method does not exist/is not available" },
  "rpc-32600": { code: -32600, message: "invalid request" },
  "rpc-32700": { code: -32700, message: "parse error" },
  "rpc-32042": { code: -32042, message: "foo" },
  "rpc-32603": { code: -32603, message: "internal error" },
  "rpc-32000": { code: -32000, message: "execution reverted" },
  "rpc-32005": { code: -32005, message: "limit exceeded" },
};

/** A Solidity `Error(string)` revert, as a node returns it in `error.data` for eth_call. */
const revertData = (reason: string) =>
  encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "", type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });
const EYJ_REASON = "eyJ".repeat(30_000); // 90 KB: quadratic redaction took 7.2 s on 93ba944
/** Round 3 modes (verify r2 L-1, L-2, M-1): a `code` of any type, optional revert data. */
const ERR3: Record<string, () => { code: unknown; message: string; data?: string }> = {
  "code-url-string": () => ({
    code: `http://127.0.0.1:${rpcPort}/v2/${RPC_KEY}?apikey=${RPC_QUERY_KEY}`,
    message: "x",
  }),
  "code-object": () => ({ code: { key: RPC_KEY }, message: "x" }),
  "code-float": () => ({ code: 1.5, message: "x" }),
  "code-429": () => ({ code: 429, message: "Your app has exceeded its compute units per second" }),
  "code-32007": () => ({ code: -32007, message: "10/second request limit reached" }),
  "text-rate-limit": () => ({ code: -32000, message: "rate limit exceeded, Too Many Requests" }),
  "revert-paused": () => ({
    code: 3,
    message: "execution reverted: paused",
    data: revertData("paused"),
  }),
  "revert-too-many": () => ({
    code: 3,
    message: "execution reverted: Too Many Requests",
    data: revertData("Too Many Requests"),
  }),
  "revert-eyj-90k": () => ({
    code: 3,
    message: `execution reverted: ${EYJ_REASON}`,
    data: revertData(EYJ_REASON),
  }),
};

let mode = "ok";
let rpcPort = 0;
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
function answer(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x2019";
    case "eth_blockNumber":
      return "0x10";
    case "eth_gasPrice":
      return "0x5d21dba00";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_call":
      return word(1n);
    case "kaia_getAccount":
      return { accType: 1, account: { balance: "0x1", nonce: 1 } };
    default:
      return null;
  }
}
const rpc = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (mode === "http500") return void res.writeHead(500).end("boom");
    if (mode === "http503") return void res.writeHead(503).end("unavailable");
    if (mode === "http429") return void res.writeHead(429).end("slow down");
    if (mode === "badjson") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end("{not json");
    }
    if (mode === "reset") return void req.socket.destroy();
    const m = JSON.parse(b) as { id: number; method: string };
    const error = ERR[mode] ?? ERR3[mode]?.();
    const body = error
      ? { jsonrpc: "2.0", id: m.id, error }
      : { jsonrpc: "2.0", id: m.id, result: answer(m.method) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

const ctx: AuthContext = {
  subject: "demo-user",
  clientId: DEMO_CLIENT_ID,
  scopes: [SCOPES.READ, SCOPES.ENCODE],
  expiresAtMs: Date.now() + 600_000,
  tokenFingerprint: "deadbeefcafe",
  tokenId: "11111111-2222-3333-4444-555555555555",
};

/** Every JSON-RPC message the server sent, as raw text. */
const wire: string[] = [];
async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (async (msg: unknown, opts?: unknown) => {
    wire.push(JSON.stringify(msg));
    return send(msg as never, opts as never);
  }) as typeof serverTransport.send;
  const server = createKaiaMcpServer({ requireAuth: true, getAuthContext: () => ctx });
  await server.connect(serverTransport);
  const client = new Client({ name: "upstream-errors", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

const chunks: string[] = [];
let orig: typeof process.stderr.write;
const lines = () => chunks.join("").split("\n").filter(Boolean);

beforeAll(async () => {
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  rpcPort = (rpc.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => rpc.close(() => r()));
});

beforeEach(() => {
  process.env.LOG_LEVEL = "debug";
  const url = `http://127.0.0.1:${rpcPort}/v2/${RPC_KEY}?apikey=${RPC_QUERY_KEY}&x=1`;
  process.env.KAIA_RPC_URL = url;
  process.env.KAIA_KAIROS_RPC_URL = url;
  process.env.KAIASCAN_API_KEY = SCAN_KEY;
  process.env.RPC_TIMEOUT_MS = "3000";
  process.env.RATE_LIMIT_RPC = "1000";
  process.env.RATE_LIMIT_KAIASCAN = "1000";
  resetConfigCache();
  mode = "ok";
  wire.length = 0;
  chunks.length = 0;
  orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = orig;
  vi.restoreAllMocks();
  for (const k of [
    "LOG_LEVEL",
    "KAIA_RPC_URL",
    "KAIA_KAIROS_RPC_URL",
    "KAIASCAN_API_KEY",
    "RPC_TIMEOUT_MS",
    "RATE_LIMIT_RPC",
    "RATE_LIMIT_KAIASCAN",
  ]) {
    delete process.env[k];
  }
  resetConfigCache();
});

/** No secret, URL, request body or stack in anything sent to the caller. */
function expectCallerSafe(): void {
  const sent = wire.join("\n");
  for (const s of SECRETS) expect(sent).not.toContain(s);
  expect(sent).not.toContain(`127.0.0.1:${rpcPort}`);
  expect(sent).not.toMatch(/Request body|"method":"eth_|kaia_getAccount|apikey|URL: | at \S+ \(/);
  expect(sent).not.toMatch(/viem@|Version: /);
}

/** No secret in any log line. */
function expectLogRedacted(): void {
  const out = chunks.join("");
  for (const s of SECRETS) expect(out).not.toContain(s);
}

const RPC_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["get_block_number", { network: "mainnet" }],
  ["get_account_info", { address: ADDR }],
  ["get_kaia_balance", { address: ADDR }],
  ["get_chain_info", {}],
  ["get_gas_price", {}],
  ["estimate_gas", { from: ADDR, to: ADDR, value: "1" }],
  [
    "read_contract",
    { contractAddress: ADDR, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [ADDR] },
  ],
  ["get_token_allowance", { tokenAddress: ADDR, owner: ADDR, spender: ADDR }],
];

describe("M1: an upstream RPC fault is never classified as a caller mistake", () => {
  const MODES = [...Object.keys(ERR), "http500", "http503", "badjson", "reset"];
  for (const m of MODES) {
    for (const [tool, args] of RPC_TOOLS) {
      it(`${m} / ${tool}: -32001 at error (rpc_provider), caller-safe`, async () => {
        mode = m;
        const client = await connect();
        const err = await client.callTool({ name: tool, arguments: args }).then(
          () => {
            throw new Error("expected an error");
          },
          (e: { code: number; message: string }) => e
        );
        expect(err.code).toBe(-32001);
        expect(err.message).toMatch(/^Upstream RPC/);
        expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
        const errs = lines().filter((l) => l.includes(" level=error msg=Tool error "));
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatch(
          / level=error msg=Tool error code=-32001 method=tools\/call category=rpc_provider /
        );
        expectCallerSafe();
        expectLogRedacted();
      });
    }
  }

  it("the upstream's own code and the redacted detail stay in the log only", async () => {
    mode = "rpc-32602";
    const client = await connect();
    await expect(
      client.callTool({ name: "get_block_number", arguments: {} })
    ).rejects.toMatchObject({ code: -32001 });
    const line = lines().find((l) => l.includes("msg=Tool error")) ?? "";
    expect(line).toContain(" upstreamCode=-32602");
    expect(line).toMatch(/ detail=\S+/);
    expectLogRedacted();
  });

  it("HTTP 429 from the RPC provider is -32003 rate_limit at error, caller-safe", async () => {
    mode = "http429";
    const client = await connect();
    await expect(
      client.callTool({ name: "get_block_number", arguments: {} })
    ).rejects.toMatchObject({ code: -32003 });
    const errs = lines().filter((l) => l.includes(" level=error msg=Tool error "));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(" code=-32003 method=tools/call category=rate_limit ");
    expectCallerSafe();
    expectLogRedacted();
  });

  it("an upstream fault behind a resource read is an error too, not a denial", async () => {
    mode = "rpc-32601";
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeScan(() => new Response("{}")));
    const client = await connect();
    await expect(client.readResource({ uri: "kaia://mainnet/status" })).rejects.toMatchObject({
      code: -32001,
    });
    expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
    const errorLines = lines().filter((l) => l.includes(" level=error msg=Tool error "));
    expect(errorLines).toHaveLength(1);
    // The upstream error itself reaches the handler wrapper (not a pre-wrapped ProtocolError),
    // so the log keeps the upstream's code and description.
    expect(errorLines[0]).toMatch(
      / msg=Tool error code=-32001 method=resources\/read category=rpc_provider errorType=\w+ upstreamCode=-32601 detail=\S+$/
    );
    expect(errorLines[0]).not.toContain("errorType=ProtocolError");
    expectCallerSafe();
  });

  it("a KaiaScan fault behind a resource read is -32004 at error with the upstream status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fakeScan(() => new Response("nope", { status: 502 }))
    );
    const client = await connect();
    await expect(client.readResource({ uri: "kaia://mainnet/top-accounts" })).rejects.toMatchObject(
      {
        code: -32004,
        message: "KaiaScan API request failed (top accounts): HTTP 502.",
        data: { upstreamStatus: 502 },
      }
    );
    expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
    const errorLines = lines().filter((l) => l.includes(" level=error msg=Tool error "));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatch(
      / msg=Tool error code=-32004 method=resources\/read category=kaiascan_api errorType=KaiaScanApiError upstreamStatus=502 detail=\S+$/
    );
    expectCallerSafe();
  });
});

describe("round 3: upstream code type (L-1), structured rate limits (L-2), bounded detail (M-1)", () => {
  const RATE_LIMIT_ABI = [
    {
      type: "function",
      name: "rateLimit",
      inputs: [],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
    },
  ];
  const callRateLimit = (client: Client) =>
    client
      .callTool({
        name: "read_contract",
        arguments: {
          contractAddress: ADDR,
          abi: RATE_LIMIT_ABI,
          functionName: "rateLimit",
          args: [],
        },
      })
      .then(
        () => {
          throw new Error("expected an error");
        },
        (e: { code: number; message: string; data?: { upstreamCode?: unknown } }) => e
      );
  const toolErrors = () => lines().filter((l) => l.includes(" level=error msg=Tool error "));

  for (const m of ["code-url-string", "code-object", "code-float"]) {
    it(`${m}: -32001 with no upstreamCode, nothing of the code reaches the caller`, async () => {
      mode = m;
      const client = await connect();
      const err = await client.callTool({ name: "get_block_number", arguments: {} }).then(
        () => {
          throw new Error("expected an error");
        },
        (e: { code: number; data?: unknown }) => e
      );
      expect(err.code).toBe(-32001);
      expect(err.data).toBeUndefined();
      expect(wire.join("\n")).not.toContain("upstreamCode");
      expect(toolErrors()).toHaveLength(1);
      expect(toolErrors()[0]).not.toContain("upstreamCode=");
      expectCallerSafe();
      expectLogRedacted();
    });
  }

  for (const [m, code] of [
    ["code-429", 429],
    ["code-32007", -32007],
  ] as const) {
    it(`${m}: JSON-RPC code ${code} is -32003 rate_limit`, async () => {
      mode = m;
      const client = await connect();
      const err = await callRateLimit(client);
      expect(err).toMatchObject({
        code: -32003,
        message: "Upstream RPC rate limit reached; retry later.",
        data: { upstreamCode: code },
      });
      expect(toolErrors()).toHaveLength(1);
      expect(toolErrors()[0]).toContain(" code=-32003 method=tools/call category=rate_limit ");
      expectCallerSafe();
    });
  }

  for (const m of ["text-rate-limit", "revert-paused", "revert-too-many"]) {
    it(`${m}: rate-limit words or a rateLimit function name are not a rate limit`, async () => {
      mode = m;
      const client = await connect();
      const err = await callRateLimit(client);
      expect(err.code).toBe(-32001);
      expect(err.message).toBe("Upstream RPC request failed.");
      expect(toolErrors()).toHaveLength(1);
      expect(toolErrors()[0]).toContain(" code=-32001 method=tools/call category=rpc_provider ");
      expectCallerSafe();
    });
  }

  it("a 90 KB eyJ… revert reason answers in bounded time with a bounded log line", async () => {
    mode = "revert-eyj-90k";
    const client = await connect();
    const t0 = performance.now();
    const err = await callRateLimit(client);
    const ms = performance.now() - t0;
    expect(err.code).toBe(-32001);
    expect(ms).toBeLessThan(3000);
    expect(toolErrors()).toHaveLength(1);
    expect(toolErrors()[0].length).toBeLessThan(2048);
    expect(toolErrors()[0]).toMatch(/ detail=\S+$/);
    expectCallerSafe();
  }, 60_000);
});

/** Route api.kaiascan.io to `answer`, everything else (the fake RPC) to the real fetch. */
const realFetch = globalThis.fetch;
function fakeScan(
  answer: (url: string) => Response | Promise<Response>
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.kaiascan.io/")) return answer(url);
    return realFetch(input, init);
  };
}

const SCAN_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["get_token_info", { contractAddress: ADDR }],
  ["get_token_holders", { contractAddress: ADDR }],
  ["get_token_transfers", { contractAddress: ADDR }],
  ["get_nft_info", { contractAddress: ADDR }],
  ["get_nft_item", { contractAddress: ADDR, tokenId: "1" }],
  ["get_nft_transfers", { contractAddress: ADDR }],
  ["get_account_tokens", { address: ADDR }],
  ["get_account_nfts", { address: ADDR }],
  ["get_account_transactions", { address: ADDR }],
  ["get_contract_abi", { contractAddress: ADDR }],
  ["get_contract_source", { contractAddress: ADDR }],
  ["get_block_rewards", { blockNumber: 1 }],
  ["get_kaia_price", {}],
];

describe("M1: a KaiaScan failure reaches the caller as -32004, never -32602", () => {
  const FAILURES: Array<[string, (url: string) => Response | Promise<Response>]> = [
    ["HTTP 500", () => new Response("boom", { status: 500, statusText: "Internal Server Error" })],
    ["HTTP 401", () => new Response("no key", { status: 401, statusText: "Unauthorized" })],
    ["not JSON", () => new Response("<html>oops</html>", { status: 200 })],
    [
      "network error",
      (url) => {
        throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${url}`) });
      },
    ],
  ];
  for (const [label, fail] of FAILURES) {
    for (const [tool, args] of SCAN_TOOLS) {
      it(`${label} / ${tool}: -32004 at error (kaiascan_api), caller-safe`, async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(fakeScan(fail));
        const client = await connect();
        const err = await client.callTool({ name: tool, arguments: args }).then(
          () => {
            throw new Error("expected an error");
          },
          (e: { code: number; message: string }) => e
        );
        expect(err.code).toBe(-32004);
        expect(err.message).toMatch(/^KaiaScan API request failed/);
        expect(wire.join("\n")).not.toContain('"code":-32602');
        expect(lines().filter((l) => l.includes("msg=Request denied"))).toEqual([]);
        const errs = lines().filter((l) => l.includes(" level=error msg=Tool error "));
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatch(
          / level=error msg=Tool error code=-32004 method=tools\/call category=kaiascan_api /
        );
        expectCallerSafe();
        expectLogRedacted();
      });
    }
  }
});

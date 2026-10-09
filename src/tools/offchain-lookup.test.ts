/**
 * EIP-3668 offchain lookups (CCIP-read) are off. With viem's default, a contract that
 * reverts with `OffchainLookup(sender, urls, callData, callbackFunction, extraData)` made
 * the server fetch a URL the contract chose (SSRF: internal services, cloud metadata) and
 * pass the response back into a second eth_call, whose result reached the caller. viem
 * also decoded the revert's `string[] urls` with no size bound before kaia's result caps
 * ran, so aliased URLs (issue #11 P-1's amplification) built hundreds of MB of strings.
 * Every tool that runs an eth_call is covered: read_contract and get_token_allowance.
 *
 * Real viem clients (createRpcClient) talk to an in-process fake RPC node; a second local
 * listener stands in for the lookup gateway and records every request it gets.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { encodeErrorResult, type Hex } from "viem";
import { handleReadContract } from "./contract.js";
import { handleGetTokenAllowance } from "./token.js";
import { toMcpError } from "../utils/errors.js";
import { resetConfigCache } from "../config.js";

const SENDER = "0x000000000000000000000000000000000000dEaD"; // the called contract
const CALLBACK = "0xc0ffee00";
const OFFCHAIN_LOOKUP = [
  {
    type: "error",
    name: "OffchainLookup",
    inputs: [
      { name: "sender", type: "address" },
      { name: "urls", type: "string[]" },
      { name: "callData", type: "bytes" },
      { name: "callbackFunction", type: "bytes4" },
      { name: "extraData", type: "bytes" },
    ],
  },
] as const;
const lookupRevert = (urls: string[]): Hex =>
  encodeErrorResult({
    abi: OFFCHAIN_LOOKUP,
    errorName: "OffchainLookup",
    args: [SENDER, urls, "0xdeadbeef", CALLBACK, "0x"],
  });

const word = (n: number) => n.toString(16).padStart(64, "0");
/** P-1's amplification in the revert: `count` url offsets that all point at one string. */
function aliasedLookupRevert(count: number, urlBytes: number): string {
  const urls =
    word(count) + word(count * 32).repeat(count) + word(urlBytes) + "78".repeat(urlBytes);
  const head = 5 * 32;
  const callDataAt = head + urls.length / 2;
  const callData = word(4) + "deadbeef" + "00".repeat(28);
  const extraAt = callDataAt + callData.length / 2;
  return (
    "0x556f1830" +
    word(Number.parseInt(SENDER.slice(2), 16) /* 0xdead */) +
    word(head) +
    word(callDataAt) +
    CALLBACK.slice(2) +
    "00".repeat(28) +
    word(extraAt) +
    urls +
    callData +
    word(0)
  );
}

/** The fake node: eth_call reverts with `revert`, except the lookup's callback. */
let revert = "";
const callbacks: string[] = [];
const rpc = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const m = JSON.parse(b) as { id: number; method: string; params?: [{ data?: string }] };
    let body: unknown = { jsonrpc: "2.0", id: m.id, result: "0x2019" };
    if (m.method === "eth_call") {
      const data = m.params?.[0]?.data ?? "";
      if (data.startsWith(CALLBACK)) {
        callbacks.push(data);
        body = { jsonrpc: "2.0", id: m.id, result: `0x${word(7)}` };
      } else if (revert) {
        body = {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: 3, message: "execution reverted", data: revert },
        };
      } else {
        body = { jsonrpc: "2.0", id: m.id, result: `0x${word(5)}` };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

/** The lookup gateway: records every hit and answers like a real gateway would. */
const gatewayHits: string[] = [];
const gateway = http.createServer((req, res) => {
  gatewayHits.push(`${req.method} ${req.url}`);
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: `0x${"ab".repeat(32)}` }));
});

let rpcUrl = "";
let gatewayUrl = "";
const ENV = ["KAIA_RPC_URL", "KAIA_KAIROS_RPC_URL", "RPC_TIMEOUT_MS", "RATE_LIMIT_RPC"];

beforeAll(async () => {
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => rpc.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
});
beforeEach(() => {
  process.env.KAIA_RPC_URL = rpcUrl;
  process.env.KAIA_KAIROS_RPC_URL = rpcUrl;
  process.env.RPC_TIMEOUT_MS = "5000";
  process.env.RATE_LIMIT_RPC = "1000";
  resetConfigCache();
  revert = "";
  callbacks.length = 0;
  gatewayHits.length = 0;
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  resetConfigCache();
});

const UINT_FN = [
  {
    type: "function",
    name: "f",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
];
const TOOLS: Record<string, () => Promise<{ content: Array<{ text: string }> }>> = {
  read_contract: () =>
    handleReadContract({ contractAddress: SENDER, functionName: "f", abi: UINT_FN, args: [] }),
  get_token_allowance: () =>
    handleGetTokenAllowance({
      tokenAddress: SENDER,
      owner: "0x0000000000000000000000000000000000000001",
      spender: "0x0000000000000000000000000000000000000002",
      network: "mainnet",
    }),
};

async function answer(tool: string): Promise<unknown> {
  try {
    const r = await TOOLS[tool]();
    return { ok: r.content[0].text };
  } catch (err) {
    return toMcpError(err);
  }
}

describe("OffchainLookup reverts are ordinary reverts (no offchain lookup)", () => {
  for (const tool of Object.keys(TOOLS)) {
    it(`${tool}: answers -32001, fetches nothing, and the server keeps answering`, async () => {
      revert = lookupRevert([`${gatewayUrl}/internal/{sender}/{data}`, `${gatewayUrl}/post`]);
      const out = (await answer(tool)) as { code?: number; message?: string };
      // -32001, no request to the URLs the contract named, and no callback eth_call.
      expect({ out, gatewayHits, callbacks }).toEqual({
        // The same answer as any other revert (an Error(string) revert answers this too).
        out: { code: -32001, message: "Upstream RPC request failed.", data: { upstreamCode: 3 } },
        gatewayHits: [],
        callbacks: [],
      });
      expect(out.message).not.toContain(gatewayUrl);

      revert = "";
      expect(await answer(tool)).toEqual({ ok: expect.stringMatching(/5/) });
    });
  }
});

/**
 * P-1 through the revert at full size: 4000 url offsets to one 64 KB string (193 KB of
 * revert data). On main viem decoded it into 262 MB of URLs (and joined them into an error
 * message) and the process ran out of memory. The child runs the real tools and a real
 * client against the fake node above, with a 256 MB heap, so a regression aborts the
 * child, not the test runner.
 */
const ENTRY = `
import { handleReadContract } from ${JSON.stringify(path.resolve("src/tools/contract.ts"))};
import { handleGetTokenAllowance } from ${JSON.stringify(path.resolve("src/tools/token.ts"))};
import { toMcpError } from ${JSON.stringify(path.resolve("src/utils/errors.ts"))};
const SENDER = ${JSON.stringify(SENDER)};
const tools = {
  read_contract: () => handleReadContract({ contractAddress: SENDER, functionName: "f", abi: ${JSON.stringify(UINT_FN)}, args: [] }),
  get_token_allowance: () => handleGetTokenAllowance({ tokenAddress: SENDER, owner: "0x0000000000000000000000000000000000000001", spender: "0x0000000000000000000000000000000000000002", network: "mainnet" }),
};
const t0 = performance.now();
try {
  const r = await tools[process.argv[2]]();
  console.log(JSON.stringify({ ok: true, chars: r.content[0].text.length, ms: performance.now() - t0 }));
} catch (err) {
  const e = toMcpError(err);
  console.log(JSON.stringify({ code: e.code, messageChars: e.message.length, ms: performance.now() - t0 }));
}
`;

describe("OffchainLookup with 4000 aliased 64 KB urls, 256 MB heap", () => {
  let dir: string;
  let bundle: string;
  beforeAll(async () => {
    const cache = path.resolve("node_modules/.cache");
    fs.mkdirSync(cache, { recursive: true });
    dir = fs.mkdtempSync(path.join(cache, "kaia-ccip-"));
    fs.writeFileSync(path.join(dir, "entry.mjs"), ENTRY);
    bundle = path.join(dir, "bundle.mjs");
    await build({
      entryPoints: [path.join(dir, "entry.mjs")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      packages: "external",
      logLevel: "silent",
    });
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const tool of Object.keys(TOOLS)) {
    it(`${tool}: answers -32001, the process survives`, async () => {
      revert = aliasedLookupRevert(4000, 65_536);
      expect(revert.length).toBeLessThan(400_000); // ~193 KB of revert data
      // spawn, not spawnSync: the fake node runs on this process's event loop.
      const child = spawn(process.execPath, ["--max-old-space-size=256", bundle, tool], {
        env: { PATH: process.env.PATH, KAIA_RPC_URL: rpcUrl, KAIA_KAIROS_RPC_URL: rpcUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.resume();
      const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const exit = await new Promise<{ status: number | null; signal: string | null }>((r) =>
        child.on("close", (status, signal) => r({ status, signal }))
      );
      clearTimeout(killer);
      expect(exit).toEqual({ status: 0, signal: null });
      const out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
      expect(out.code).toBe(-32001);
      expect(out.ms).toBeLessThan(2000);
    }, 70_000);
  }
});

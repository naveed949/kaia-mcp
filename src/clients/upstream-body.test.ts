/**
 * Upstream HTTP responses are bounded (issue #15). A hostile or compromised RPC node or
 * KaiaScan endpoint controls the response body: its size (declared or not, compressed or
 * not), how slowly it arrives, and whether it redirects. Real clients (createRpcClient,
 * createKaiaScanClient) talk to a local fake upstream over HTTP; a second path on it stands
 * in for an internal service and records every request it gets.
 *
 * Sizes are chosen against any cap kaia could pick (16 MiB and more is over it; a 2 MiB
 * read_contract result, the largest #14 accepts, is under it), so these run unchanged on
 * main, where they fail.
 */
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcClient } from "./rpc.js";
import { createKaiaScanClient } from "./kaiascan.js";
import { handleReadContract } from "../tools/contract.js";
import { toMcpError } from "../utils/errors.js";
import { resetConfigCache, type Config } from "../config.js";

const MiB = 1 << 20;
const word = (n: number) => n.toString(16).padStart(64, "0");

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
let handler: Handler = () => {};
/** Requests that reached the upstream path, and the "internal" one. */
const hits = { upstream: 0, internal: 0 };
/** Bytes the fake wrote on each response, and when the client closed it. */
const closes: Array<{ written: number; at: number }> = [];

const server = http.createServer((req, res) => {
  // One request per connection: no keep-alive socket outlives a test (afterEach closes them).
  res.setHeader("connection", "close");
  if (req.url?.startsWith("/internal")) {
    hits.internal += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a", data: "internal" }));
    return;
  }
  hits.upstream += 1;
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => handler(req, res, b));
  res.on("close", () => closes.push({ written: res.socket?.bytesWritten ?? -1, at: Date.now() }));
});

let base = "";
const ENV = ["KAIA_RPC_URL", "KAIA_KAIROS_RPC_URL", "RPC_TIMEOUT_MS", "RATE_LIMIT_RPC"];
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  process.env.KAIA_RPC_URL = `${base}/rpc`;
  process.env.KAIA_KAIROS_RPC_URL = `${base}/rpc`;
  process.env.RPC_TIMEOUT_MS = "1500";
  process.env.RATE_LIMIT_RPC = "1000";
  resetConfigCache();
  hits.upstream = 0;
  hits.internal = 0;
  closes.length = 0;
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  resetConfigCache();
  vi.unstubAllGlobals();
});

const json = { "content-type": "application/json" };
const rpcId = (body: string) => (JSON.parse(body) as { id: number }).id;
/** A JSON-RPC result of `hexChars` hex characters after 0x. */
const resultBody = (id: number, hexChars: number) =>
  `{"jsonrpc":"2.0","id":${id},"result":"0x${"0".repeat(hexChars)}"}`;
/** Writes `total` bytes (or forever) in 1 MiB chunks, respecting backpressure. */
function stream(res: http.ServerResponse, total: number, prefix = "", gapMs = 0) {
  const chunk = Buffer.alloc(MiB, 0x30);
  let sent = 0;
  res.write(prefix);
  const next = () => {
    while (!res.destroyed && sent < total) {
      sent += chunk.length;
      if (gapMs) {
        res.write(chunk);
        setTimeout(next, gapMs);
        return;
      }
      if (!res.write(chunk)) {
        res.once("drain", next);
        return;
      }
    }
    if (!res.destroyed && Number.isFinite(total)) res.end();
  };
  next();
}

async function rpcAnswer(): Promise<{ value?: bigint; err?: ReturnType<typeof toMcpError> }> {
  try {
    return { value: await createRpcClient("mainnet").getBlockNumber({ cacheTime: 0 }) };
  } catch (err) {
    return { err: toMcpError(err) };
  }
}

const TOO_LARGE = { code: -32005, message: expect.stringMatching(/response is too large/) };

describe("RPC transport: response body cap", () => {
  it("a normal response still works", async () => {
    handler = (_q, res, b) => {
      res.writeHead(200, json);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId(b), result: "0x2019" }));
    };
    expect(await rpcAnswer()).toEqual({ value: 0x2019n });
    expect(hits.upstream).toBe(1);
  });

  it("refuses a 16 MiB body with Content-Length: -32005, one request (no retry)", async () => {
    handler = (_q, res, b) => {
      const body = resultBody(rpcId(b), 16 * MiB);
      res.writeHead(200, { ...json, "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const t0 = Date.now();
    const out = await rpcAnswer();
    expect(out.err).toEqual(TOO_LARGE);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hits.upstream).toBe(1);
  });

  it("refuses a chunked body (no Content-Length) once it passes the cap, one request", async () => {
    handler = (_q, res) => {
      res.writeHead(200, json);
      stream(res, 64 * MiB, '{"jsonrpc":"2.0","id":1,"result":"0x');
    };
    expect((await rpcAnswer()).err).toEqual(TOO_LARGE);
    expect(hits.upstream).toBe(1);
  });

  it("does not trust Content-Length: a gzip body that declares 16 KB but inflates to 24 MiB", async () => {
    const gz = zlib.gzipSync(resultBody(1, 24 * MiB));
    expect(gz.length).toBeLessThan(64 * 1024);
    handler = (_q, res) => {
      res.writeHead(200, { ...json, "content-encoding": "gzip", "content-length": gz.length });
      res.end(gz);
    };
    expect((await rpcAnswer()).err).toEqual(TOO_LARGE);
    expect(hits.upstream).toBe(1);
  });

  it("a declared Content-Length over the cap is refused before any body arrives, and the connection is closed", async () => {
    handler = (_q, res) => {
      res.writeHead(200, { ...json, "content-length": String(100 * MiB) });
      res.flushHeaders(); // then never send the body
    };
    const t0 = Date.now();
    expect((await rpcAnswer()).err).toEqual(TOO_LARGE);
    expect(Date.now() - t0).toBeLessThan(1000); // not the 1.5 s timeout
    await vi.waitFor(() => expect(closes.length).toBe(1), { timeout: 2000 });
    expect(hits.upstream).toBe(1);
  });

  it("stops reading an endless body: the connection is closed, not drained", async () => {
    handler = (_q, res) => {
      res.writeHead(200, json);
      stream(res, Infinity, '{"jsonrpc":"2.0","id":1,"result":"0x');
    };
    const out = await rpcAnswer();
    expect(out.err).toEqual(TOO_LARGE);
    const refusedAt = Date.now();
    await vi.waitFor(() => expect(closes.length).toBe(1), { timeout: 2000 });
    expect(closes[0].at - refusedAt).toBeLessThan(1000);
    // The socket buffers some MiB in flight; it is far from endless.
    expect(closes[0].written).toBeLessThan(64 * MiB);
    expect(hits.upstream).toBe(1);
  });

  it("after a refused body, the next requests work (keep-alive: no poisoned pooled socket)", async () => {
    let n = 0;
    handler = (_q, res, b) => {
      n += 1;
      res.setHeader("connection", "keep-alive");
      if (n === 1) {
        res.writeHead(200, { ...json, "content-length": String(100 * MiB) });
        res.flushHeaders();
      } else if (n === 2) {
        res.writeHead(200, json);
        stream(res, 64 * MiB, '{"jsonrpc":"2.0","id":1,"result":"0x');
      } else {
        res.writeHead(200, json);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId(b), result: "0x7" }));
      }
    };
    expect((await rpcAnswer()).err).toEqual(TOO_LARGE);
    expect((await rpcAnswer()).err).toEqual(TOO_LARGE);
    for (let i = 0; i < 3; i++) expect(await rpcAnswer()).toEqual({ value: 7n });
    expect(hits.upstream).toBe(5);
  });

  it("a slow drip within the timeout is refused when it passes the cap", async () => {
    handler = (_q, res) => {
      res.writeHead(200, json);
      stream(res, 64 * MiB, '{"jsonrpc":"2.0","id":1,"result":"0x', 25);
    };
    const t0 = Date.now();
    expect((await rpcAnswer()).err).toEqual(TOO_LARGE);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(hits.upstream).toBe(1);
  });

  it("a body that drips past the timeout times out (the timeout covers the body, not just headers)", async () => {
    handler = (_q, res) => {
      res.writeHead(200, json);
      res.write('{"jsonrpc":"2.0","id":1,"result":"0x');
      const t = setInterval(() => res.write("00"), 100);
      res.on("close", () => clearInterval(t));
    };
    process.env.RPC_TIMEOUT_MS = "300";
    resetConfigCache();
    const t0 = Date.now();
    const out = await rpcAnswer();
    // Timeouts keep viem's retries (3 more attempts with backoff), as before.
    expect(out.err).toEqual({ code: -32001, message: "Upstream RPC request timed out." });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(hits.upstream).toBe(4);
  }, 10_000);

  it("does not follow a redirect: -32001 with the 307, the redirect target gets nothing", async () => {
    handler = (_q, res) => {
      res.writeHead(307, { location: `${base}/internal/meta` });
      res.end();
    };
    const out = await rpcAnswer();
    expect(out.err).toEqual({
      code: -32001,
      message: "Upstream RPC request failed.",
      data: { upstreamStatus: 307 },
    });
    expect(hits).toEqual({ upstream: 1, internal: 0 });
  });

  for (const status of [301, 302, 303, 308]) {
    it(`does not follow a ${status} redirect`, async () => {
      handler = (_q, res) => {
        res.writeHead(status, { location: "/internal/x" });
        res.end();
      };
      expect((await rpcAnswer()).err?.code).toBe(-32001);
      expect(hits.internal).toBe(0);
    });
  }
});

describe("read_contract through the capped transport", () => {
  const BYTES_FN = [
    {
      type: "function",
      name: "f",
      inputs: [],
      outputs: [{ name: "", type: "bytes" }],
      stateMutability: "view",
    },
  ];
  const read = () =>
    handleReadContract({
      contractAddress: "0x000000000000000000000000000000000000dEaD",
      functionName: "f",
      abi: BYTES_FN,
      args: [],
      network: "mainnet",
    });

  it("the largest result #14 accepts (one 2 MiB - 64 bytes `bytes` value) prints as before", async () => {
    const n = 2 * MiB - 64;
    const data = "ab".repeat(n);
    const ret = `0x${word(32)}${word(n)}${data}`;
    expect((ret.length - 2) / 2).toBe(2 * MiB);
    handler = (_q, res, b) => {
      res.writeHead(200, json);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId(b), result: ret }));
    };
    const out = await read();
    expect(out.content[0].text).toBe(`Result:\n0x${data}`);
    expect(hits.upstream).toBe(1);
  });

  it("an 8 MiB Error(string) revert reason (16 MiB reply) is refused fast with -32005, one request", async () => {
    const n = 8 * MiB;
    const revert = `0x08c379a0${word(32)}${word(n)}${"41".repeat(n)}`;
    handler = (_q, res, b) => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId(b),
        error: { code: 3, message: "execution reverted", data: revert },
      });
      res.writeHead(200, { ...json, "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const t0 = Date.now();
    let out: unknown;
    try {
      await read();
    } catch (err) {
      out = toMcpError(err);
    }
    expect(out).toEqual(TOO_LARGE);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hits.upstream).toBe(1);
  });
});

describe("KaiaScan client: response body cap", () => {
  const config = (timeoutMs = 1500): Config =>
    ({
      kaiaRpcUrl: `${base}/rpc`,
      kaiaKairosRpcUrl: `${base}/rpc`,
      kaiascanApiKey: "",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 1000,
      rateLimitKaiascan: 1000,
      rpcTimeoutMs: 1500,
      kaiascanTimeoutMs: timeoutMs,
      authMode: "required",
      allowUnsafeWallet: false,
      oauthClientId: "kaia-mcp-demo",
      accessTokenTtlSeconds: 900,
      oauthRequireResource: false,
      allowedOrigins: [],
      oauthPreviousSigningKeyFiles: [],
      introspectionClientId: "kaia-mcp-gateway",
    }) as Config;

  beforeEach(() => {
    // The client's base URL is fixed (https://api.kaiascan.io); send it to the fake instead.
    // The request options (redirect, signal) pass through unchanged.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(String(input).replace("https://api.kaiascan.io", base), init)
    );
  });

  async function scan(
    timeoutMs?: number
  ): Promise<{ data?: unknown; err?: ReturnType<typeof toMcpError> }> {
    try {
      return {
        data: await createKaiaScanClient(config(timeoutMs)).get("/api/v1/blocks/1/rewards"),
      };
    } catch (err) {
      return { err: toMcpError(err) };
    }
  }

  it("a normal response (1 MiB of JSON) still works", async () => {
    const big = { items: "x".repeat(MiB) };
    handler = (_q, res) => {
      res.writeHead(200, json);
      res.end(JSON.stringify(big));
    };
    expect(await scan()).toEqual({ data: big });
  });

  it("refuses a 16 MiB body with Content-Length: -32005", async () => {
    const body = JSON.stringify({ items: "x".repeat(16 * MiB) });
    handler = (_q, res) => {
      res.writeHead(200, { ...json, "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    expect((await scan()).err).toEqual(TOO_LARGE);
    expect(hits.upstream).toBe(1);
  });

  it("refuses a chunked body once it passes the cap, and closes the connection", async () => {
    handler = (_q, res) => {
      res.writeHead(200, json);
      stream(res, Infinity, '{"items":"');
    };
    expect((await scan()).err).toEqual(TOO_LARGE);
    await vi.waitFor(() => expect(closes.length).toBe(1), { timeout: 2000 });
    expect(closes[0].written).toBeLessThan(64 * MiB);
  });

  it("does not trust Content-Length: a 24 MiB gzip bomb declaring ~24 KB is refused", async () => {
    const gz = zlib.gzipSync(JSON.stringify({ items: "x".repeat(24 * MiB) }));
    handler = (_q, res) => {
      res.writeHead(200, { ...json, "content-encoding": "gzip", "content-length": gz.length });
      res.end(gz);
    };
    expect((await scan()).err).toEqual(TOO_LARGE);
  });

  it("a body that drips past the timeout is refused at the timeout", async () => {
    handler = (_q, res) => {
      res.writeHead(200, json);
      res.write('{"items":"');
      const t = setInterval(() => res.write("x"), 100);
      res.on("close", () => clearInterval(t));
    };
    const t0 = Date.now();
    const out = await scan(300);
    expect(out.err?.code).toBe(-32004);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 10_000);

  it("does not follow a redirect: -32004 HTTP 307, the target gets nothing", async () => {
    handler = (_q, res) => {
      res.writeHead(307, { location: `${base}/internal/meta` });
      res.end();
    };
    expect((await scan()).err).toEqual({
      code: -32004,
      message: "KaiaScan API request failed: HTTP 307.",
      data: { upstreamStatus: 307 },
    });
    expect(hits).toEqual({ upstream: 1, internal: 0 });
  });
});

/**
 * A KaiaScan gzip bomb at full size: ~400 KB on the wire that inflates to 400 MiB of JSON.
 * On main the client read it whole (res.json()) and a process with a 256 MB heap aborted,
 * out of memory. The child runs the real client against the fake above with that heap, so
 * a regression aborts the child, not the test runner.
 */
const ENTRY = `
import { createKaiaScanClient } from ${JSON.stringify(path.resolve("src/clients/kaiascan.ts"))};
import { toMcpError } from ${JSON.stringify(path.resolve("src/utils/errors.ts"))};
const base = process.argv[2];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(String(input).replace("https://api.kaiascan.io", base), init);
const t0 = performance.now();
try {
  const data = await createKaiaScanClient().get("/api/v1/blocks/1/rewards");
  console.log(JSON.stringify({ ok: true, chars: JSON.stringify(data).length, ms: performance.now() - t0 }));
} catch (err) {
  const e = toMcpError(err);
  console.log(JSON.stringify({ code: e.code, ms: performance.now() - t0 }));
}
`;

describe("KaiaScan gzip bomb (400 MiB inflated), 256 MB heap", () => {
  let dir: string;
  let bundle: string;
  let bomb: Buffer;
  beforeAll(async () => {
    const cache = path.resolve("node_modules/.cache");
    fs.mkdirSync(cache, { recursive: true });
    dir = fs.mkdtempSync(path.join(cache, "kaia-bomb-"));
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
    // Streamed through gzip 1 MiB at a time: the test process never holds the inflated body.
    const gz = zlib.createGzip({ level: 9 });
    const parts: Buffer[] = [];
    gz.on("data", (c: Buffer) => parts.push(c));
    const done = new Promise((r) => gz.on("end", r));
    gz.write('{"items":"');
    const chunk = Buffer.alloc(MiB, 0x78);
    for (let i = 0; i < 400; i++) gz.write(chunk);
    gz.end('"}');
    await done;
    bomb = Buffer.concat(parts);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("answers -32005 and the process survives", async () => {
    expect(bomb.length).toBeLessThan(1024 * 1024);
    handler = (_q, res) => {
      res.writeHead(200, { ...json, "content-encoding": "gzip", "content-length": bomb.length });
      res.end(bomb);
    };
    // spawn, not spawnSync: the fake upstream runs on this process's event loop.
    const child = spawn(process.execPath, ["--max-old-space-size=256", bundle, base], {
      env: {
        PATH: process.env.PATH,
        KAIA_RPC_URL: `${base}/rpc`,
        KAIA_KAIROS_RPC_URL: `${base}/rpc`,
      },
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
    expect(out.code).toBe(-32005);
    expect(out.ms).toBeLessThan(2000);
  }, 70_000);
});

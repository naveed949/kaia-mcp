/**
 * Oversized and broken request bodies. A body over the limit is answered 413 and the
 * connection is closed, so a keep-alive client never reuses a socket the server has
 * stopped reading (that reuse used to hang until the client timed out). Any other body
 * read failure is not a 413.
 */
import { request, Agent } from "node:http";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { BodyReadError, readBody } from "./auth/http.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

type Outcome =
  | { status: number; connection: string | undefined; ms: number }
  | { error: string; ms: number };

/** One request on `agent`; never waits longer than `timeoutMs`. */
function send(
  agent: Agent,
  url: string,
  body: string,
  opts: { chunked?: boolean; contentType?: string; timeoutMs?: number } = {}
): Promise<Outcome> {
  const { chunked = false, contentType = "application/json", timeoutMs = 4000 } = opts;
  const u = new URL(url);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        agent,
        timeout: timeoutMs,
        headers: {
          "Content-Type": contentType,
          Accept: "application/json, text/event-stream",
          ...(chunked ? {} : { "Content-Length": Buffer.byteLength(body) }),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            connection: res.headers.connection,
            ms: Date.now() - t0,
          })
        );
      }
    );
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ error: e.code ?? e.message, ms: Date.now() - t0 })
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "TIMEOUT", ms: Date.now() - t0 });
    });
    if (chunked) {
      void (async () => {
        const step = 256 * 1024;
        for (let i = 0; i < body.length && !req.destroyed; i += step) {
          req.write(body.slice(i, i + step));
          await new Promise((r) => setImmediate(r));
        }
        if (!req.destroyed) req.end();
      })();
    } else {
      req.end(body);
    }
  });
}

const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

describe("request body limits on a keep-alive connection", () => {
  let handle: KaiaHttpServerHandle | undefined;
  let agent: Agent | undefined;

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "off";
    resetConfigCache();
  });

  afterEach(async () => {
    agent?.destroy();
    agent = undefined;
    await handle?.close();
    handle = undefined;
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  for (const chunked of [false, true]) {
    it(`MCP endpoint: an oversized ${chunked ? "chunked" : "Content-Length"} body gets 413 + Connection: close and the next request does not hang`, async () => {
      handle = await runKaiaMcpServerHttp(0);
      agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const big = "x".repeat(5 * 1024 * 1024);
      const first = await send(agent, handle.mcpUrl, big, { chunked });
      // Either the client saw the 413 (with Connection: close) or the closed socket
      // surfaced as a write error; it must never be a keep-alive 413.
      if ("status" in first) {
        expect(first.status).toBe(413);
        expect(first.connection).toBe("close");
      } else {
        expect(first.error).not.toBe("TIMEOUT");
      }
      const second = await send(agent, handle.mcpUrl, LIST);
      expect(second).toMatchObject({ status: 200 });
      expect(second.ms).toBeLessThan(3000);
    });
  }

  it("OAuth endpoint: an oversized form body is refused and the next request does not hang", async () => {
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
    handle = await runKaiaMcpServerHttp(0);
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const big = "grant_type=x&pad=" + "x".repeat(3 * 1024 * 1024);
    const first = await send(agent, `${handle.issuer}/oauth/token`, big, {
      contentType: "application/x-www-form-urlencoded",
    });
    if ("status" in first) {
      expect(first.status).toBe(413);
      expect(first.connection).toBe("close");
    } else {
      expect(first.error).not.toBe("TIMEOUT");
    }
    const second = await send(agent, `${handle.issuer}/oauth/token`, "grant_type=nope", {
      contentType: "application/x-www-form-urlencoded",
    });
    expect(second).toMatchObject({ status: 400 });
    expect(second.ms).toBeLessThan(3000);
  });

  it("a declared Content-Length over the limit is refused before any body is read", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const u = new URL(handle.mcpUrl);
    const outcome = await new Promise<Outcome>((resolve) => {
      const t0 = Date.now();
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: "/",
          method: "POST",
          timeout: 3000,
          headers: { "Content-Type": "application/json", "Content-Length": 100 * 1024 * 1024 },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              connection: res.headers.connection,
              ms: Date.now() - t0,
            })
          );
        }
      );
      req.on("error", (e: NodeJS.ErrnoException) =>
        resolve({ error: e.code ?? e.message, ms: Date.now() - t0 })
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ error: "TIMEOUT", ms: Date.now() - t0 });
      });
      // Only a few bytes of the declared 100 MiB are ever sent.
      req.write("{}");
    });
    expect(outcome).toMatchObject({ status: 413, connection: "close" });
  });
});

describe("readBody", () => {
  function fakeReq(chunks: Buffer[], fail?: Error): IncomingMessage {
    const stream = Readable.from(
      (async function* () {
        for (const c of chunks) yield c;
        if (fail) throw fail;
      })()
    );
    return stream as unknown as IncomingMessage;
  }

  it("tags a body over the limit as 413", async () => {
    const err = await readBody(fakeReq([Buffer.alloc(10), Buffer.alloc(10)]), 15).catch((e) => e);
    expect(err).toBeInstanceOf(BodyReadError);
    expect(err).toMatchObject({ status: 413 });
  });

  it("does not report a broken stream as too large", async () => {
    const aborted = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const err = await readBody(fakeReq([Buffer.alloc(4)], aborted), 1000).catch((e) => e);
    expect(err).toBeInstanceOf(BodyReadError);
    expect(err).toMatchObject({ status: 400 });
  });

  it("does not resolve a body whose stream closed before it ended", async () => {
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from('{"partial":'));
    setImmediate(() => stream.destroy());
    const err = await readBody(stream as unknown as IncomingMessage, 1000).catch((e) => e);
    expect(err).toBeInstanceOf(BodyReadError);
    expect(err).toMatchObject({ status: 400 });
  });

  it("returns the body under the limit", async () => {
    await expect(readBody(fakeReq([Buffer.from("ab"), Buffer.from("c")]), 3)).resolves.toBe("abc");
  });
});

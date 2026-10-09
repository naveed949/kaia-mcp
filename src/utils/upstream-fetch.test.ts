/**
 * fetchBounded at its boundaries, with a small cap: exactly the cap is read, one byte more
 * is refused, however the body is framed. A local server; real fetch.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_UPSTREAM_RESPONSE_BYTES,
  UpstreamResponseTooLargeError,
  fetchBounded,
  findCause,
} from "./upstream-fetch.js";
import { RESULT_LIMITS } from "./result-size.js";

type Handler = (res: http.ServerResponse) => void;
let handler: Handler = (res) => res.end();
const server = http.createServer((req, res) => {
  res.setHeader("connection", "close");
  req.resume();
  handler(res);
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const CAP = 1000;
const get = () => fetchBounded(url, { method: "GET" }, "RPC", CAP);
/** `n` bytes in chunks of `size`, with or without Content-Length. */
const body =
  (n: number, { size = 300, length = false } = {}): Handler =>
  (res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      ...(length ? { "content-length": n } : {}),
    });
    for (let sent = 0; sent < n; sent += size) res.write("a".repeat(Math.min(size, n - sent)));
    res.end();
  };

describe("fetchBounded boundaries", () => {
  for (const length of [true, false]) {
    const how = length ? "with Content-Length" : "chunked";
    it(`reads a body of exactly the cap (${how}), unchanged`, async () => {
      handler = body(CAP, { length });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).toBe("a".repeat(CAP));
    });

    it(`refuses one byte over the cap (${how})`, async () => {
      handler = body(CAP + 1, { length });
      await expect(get()).rejects.toThrow(UpstreamResponseTooLargeError);
    });
  }

  it("refuses one byte over the cap in a single chunk", async () => {
    handler = body(CAP + 1, { size: CAP + 1 });
    await expect(get()).rejects.toThrow(
      "Upstream RPC response is too large: it is over 1000 bytes"
    );
  });

  it("keeps the status and body of an error answer and of an empty one", async () => {
    handler = (res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"x"}');
    };
    const err = await get();
    expect([err.status, await err.text()]).toEqual([500, '{"error":"x"}']);
    handler = (res) => {
      res.writeHead(204);
      res.end();
    };
    const empty = await get();
    expect([empty.status, await empty.text()]).toEqual([204, ""]);
    handler = (res) => {
      res.writeHead(200, { "content-length": 0 });
      res.end();
    };
    expect(await (await get()).text()).toBe("");
  });

  it("hands back a redirect as itself, without following it", async () => {
    handler = (res) => {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    };
    const res = await get();
    expect([res.status, res.headers.get("location")]).toEqual([302, "/elsewhere"]);
  });
});

describe("MAX_UPSTREAM_RESPONSE_BYTES", () => {
  it("is 8 MiB: twice the hex of the largest read_contract result #14 accepts, which fits", () => {
    expect(MAX_UPSTREAM_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_UPSTREAM_RESPONSE_BYTES).toBe(2 * 2 * RESULT_LIMITS.bytes);
    const largest = JSON.stringify({
      jsonrpc: "2.0",
      id: 999_999,
      result: `0x${"00".repeat(RESULT_LIMITS.bytes)}`,
    }).length;
    expect(largest).toBeLessThan(MAX_UPSTREAM_RESPONSE_BYTES / 1.9);
  });
});

describe("findCause", () => {
  it("finds the error through a chain of causes", () => {
    const inner = new UpstreamResponseTooLargeError("KaiaScan", 1);
    let err: Error = inner;
    for (let i = 0; i < 6; i++) err = new Error(`wrap ${i}`, { cause: err });
    expect(findCause(err, UpstreamResponseTooLargeError)).toBe(inner);
    expect(findCause(new Error("x"), UpstreamResponseTooLargeError)).toBeUndefined();
    expect(findCause(undefined, UpstreamResponseTooLargeError)).toBeUndefined();
  });
});

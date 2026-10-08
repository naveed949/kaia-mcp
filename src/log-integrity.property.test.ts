/**
 * Log integrity, property-style, against a live HTTP server: every caller-controlled field
 * kaia might log (Origin, User-Agent, Authorization, tool / resource / prompt names, method,
 * MCP request headers, OAuth parameters) is fuzzed with hostile values. No log line may gain
 * a key=value pair, carry a raw '=' inside a value, hold a non-printable byte, or be logged
 * at error level because of client input.
 */
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { SCOPES } from "./auth/constants.js";
import { fuzzString, mulberry32, parseLogLine } from "./test-support/log-fuzz.js";
import { INIT_PARAMS, REDIRECT_URI } from "./test-support/mcp-http.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const ITERATIONS = Number(process.env.KAIA_FUZZ_ITERATIONS ?? 40);
const MODERN = "2026-07-28";

type Raw = { method: string; path: string; headers: Record<string, string>; body?: string };

/** One raw HTTP/1.1 request (header values sent as UTF-8 bytes, which fetch would refuse). */
function rawRequest(port: number, r: Raw): Promise<string> {
  return new Promise((resolve) => {
    const body = r.body === undefined ? undefined : Buffer.from(r.body, "utf8");
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      Connection: "close",
      ...r.headers,
      ...(body ? { "Content-Length": String(body.length) } : {}),
    };
    // A raw CR or LF would end the header line in our own request; anything else is sent.
    const head = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, "")}`)
      .join("\r\n");
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        Buffer.concat([
          Buffer.from(`${r.method} ${r.path} HTTP/1.1\r\n`, "latin1"),
          Buffer.from(head + "\r\n\r\n", "utf8"),
          body ?? Buffer.alloc(0),
        ])
      );
    });
    let data = "";
    sock.setTimeout(5000, () => sock.destroy());
    sock.on("data", (d) => {
      data += d.toString("latin1");
      // The SDK answers keep-alive even to Connection: close: stop at the end of the response.
      if (responseComplete(data)) sock.destroy();
    });
    sock.on("close", () => resolve(data));
    sock.on("error", () => resolve(data));
  });
}

function responseComplete(data: string): boolean {
  const end = data.indexOf("\r\n\r\n");
  if (end < 0) return false;
  const head = data.slice(0, end).toLowerCase();
  const body = data.slice(end + 4);
  if (/\r\ntransfer-encoding: chunked/.test(head)) return /(^|\r\n)0\r\n\r\n$/.test(body);
  const len = /\r\ncontent-length: (\d+)/.exec(head);
  if (len) return Buffer.byteLength(body, "latin1") >= Number(len[1]);
  return /^http\/1\.1 (1\d\d|204|304)/.test(head);
}

function envelope(version = MODERN) {
  return {
    [PROTOCOL_VERSION_META_KEY]: version,
    [CLIENT_INFO_META_KEY]: { name: "fuzz", version: "0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const rpc = (method: string, params: unknown, id: unknown = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Each scenario sends one request whose caller-controlled fields carry `v` (and `w`). */
type Scenario = {
  name: string;
  benign: string;
  build: (v: string, w: string, token: string) => Raw;
};

const scenarios: Scenario[] = [
  {
    name: "Origin header (unauthenticated)",
    benign: "http://evil.example",
    build: (v) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Origin: v },
      body: rpc("tools/list", {}),
    }),
  },
  {
    name: "User-Agent and X-Forwarded-For",
    benign: "curl/8",
    build: (v, w, t) => ({
      method: "POST",
      path: "/",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${t}`,
        "User-Agent": v,
        "X-Forwarded-For": w,
        Referer: w,
      },
      body: rpc("tools/list", {}),
    }),
  },
  {
    name: "Authorization header",
    benign: "garbage",
    build: (v) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${v}` },
      body: rpc("tools/list", {}),
    }),
  },
  {
    name: "tools/call name (2025 era)",
    benign: "no_such_tool",
    build: (v, _w, t) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${t}` },
      body: rpc("tools/call", { name: v, arguments: { note: v } }),
    }),
  },
  {
    name: "resources/read uri",
    benign: "kaia://none",
    build: (v, _w, t) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${t}` },
      body: rpc("resources/read", { uri: v }),
    }),
  },
  {
    name: "prompts/get name",
    benign: "no_such_prompt",
    build: (v, _w, t) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${t}` },
      body: rpc("prompts/get", { name: v, arguments: { x: v } }),
    }),
  },
  {
    name: "JSON-RPC method and id",
    benign: "no/such",
    build: (v, w, t) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${t}` },
      body: rpc(v, {}, w),
    }),
  },
  {
    name: "modern Mcp-Name / params.name",
    benign: "x",
    build: (v, w, t) => ({
      method: "POST",
      path: "/",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${t}`,
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": w,
      },
      body: rpc("tools/call", { name: v, arguments: {}, _meta: envelope() }),
    }),
  },
  {
    name: "modern MCP-Protocol-Version / Mcp-Method / _meta version",
    benign: "1999-01-01",
    build: (v, w, t) => ({
      method: "POST",
      path: "/",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${t}`,
        "MCP-Protocol-Version": v,
        "Mcp-Method": w,
      },
      body: rpc("tools/list", { _meta: envelope(v) }),
    }),
  },
  {
    name: "legacy initialize clientInfo / protocolVersion",
    benign: "1999-01-01",
    build: (v, w, t) => ({
      method: "POST",
      path: "/",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${t}` },
      body: rpc("initialize", {
        ...INIT_PARAMS,
        protocolVersion: v,
        clientInfo: { name: w, version: v },
      }),
    }),
  },
  {
    name: "GET /oauth/authorize params",
    benign: "benign",
    build: (v, w) => ({
      method: "GET",
      path: `/oauth/authorize?${qs({ response_type: "code", client_id: v, redirect_uri: w, scope: v, state: w, resource: v, code_challenge: w, code_challenge_method: "S256" })}`,
      headers: {},
    }),
  },
  {
    name: "GET /oauth/authorize with a valid client and crafted scope/state/resource",
    benign: "kaia:read",
    build: (v, w) => ({
      method: "GET",
      path: `/oauth/authorize?${qs({ response_type: "code", client_id: "kaia-mcp-demo", redirect_uri: REDIRECT_URI, scope: v, state: w, code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`,
      headers: {},
    }),
  },
  {
    name: "POST /oauth/consent",
    benign: "benign",
    build: (v, w) => ({
      method: "POST",
      path: "/oauth/consent",
      headers: FORM,
      body: qs({ request_id: v, decision: w }),
    }),
  },
  {
    name: "POST /oauth/token params",
    benign: "benign",
    build: (v, w) => ({
      method: "POST",
      path: "/oauth/token",
      headers: FORM,
      body: qs({
        grant_type: "authorization_code",
        client_id: v,
        code: w,
        code_verifier: v,
        redirect_uri: w,
        resource: v,
      }),
    }),
  },
  {
    name: "POST /oauth/token grant_type / refresh_token",
    benign: "benign",
    build: (v, w) => ({
      method: "POST",
      path: "/oauth/token",
      headers: FORM,
      body: qs({ grant_type: v, refresh_token: w, client_id: "kaia-mcp-demo", device_code: w }),
    }),
  },
  {
    name: "POST /oauth/device",
    benign: "benign",
    build: (v, w) => ({
      method: "POST",
      path: "/oauth/device",
      headers: FORM,
      body: qs({ client_id: v, scope: w, resource: v }),
    }),
  },
  {
    name: "POST /oauth/device with a valid client and crafted scope",
    benign: "kaia:read",
    build: (v) => ({
      method: "POST",
      path: "/oauth/device",
      headers: FORM,
      body: qs({ client_id: "kaia-mcp-demo", scope: v }),
    }),
  },
  {
    name: "POST /oauth/device/verify",
    benign: "ABCD-EFGH",
    build: (v, w) => ({
      method: "POST",
      path: "/oauth/device/verify",
      headers: FORM,
      body: qs({ user_code: v, decision: w }),
    }),
  },
  {
    name: "POST /oauth/revoke and /oauth/introspect",
    benign: "benign",
    build: (v, w) => ({
      method: "POST",
      path: v.length % 2 ? "/oauth/revoke" : "/oauth/introspect",
      headers: { ...FORM, Authorization: `Basic ${w}` },
      body: qs({ token: v, token_type_hint: w }),
    }),
  },
  {
    name: "request path",
    benign: "nothing",
    build: (v, _w, t) => ({
      method: "POST",
      path: `/${[...Buffer.from(v, "utf8")].map((b) => "%" + b.toString(16).padStart(2, "0")).join("")}`,
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${t}` },
      body: rpc("tools/call", { name: v, arguments: {} }),
    }),
  },
];

const PLANTED = [
  /outcome=allowed/,
  /tokenFingerprint=000000000000/,
  /msg=Tool call tool=generate_wallet/,
];

function msgOf(line: string): string {
  const m = /^timestamp=\S+ level=\w+ msg=(.*?)(?= [^ =]+=|$)/.exec(line);
  return m ? m[1] : "";
}

describe("log integrity under fuzzed caller input (live HTTP)", () => {
  let handle: KaiaHttpServerHandle;
  let token: string;
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;
  const lineCounts = new Map<string, number>();

  beforeAll(async () => {
    process.env.LOG_LEVEL = "debug";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    handle = await runKaiaMcpServerHttp(0);
    token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
  });

  afterAll(async () => {
    // Not vacuous: the fuzzed requests did reach code that logs.
    const total = [...lineCounts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(ITERATIONS * 5);
    await handle?.close();
    process.stderr.write = orig;
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  async function linesFor(r: Raw): Promise<string[]> {
    chunks.length = 0;
    await rawRequest(handle.port, r);
    // let any post-response logging land
    await new Promise((res) => setTimeout(res, 5));
    return chunks.join("").split("\n").filter(Boolean);
  }

  for (const sc of scenarios) {
    it(
      sc.name,
      async () => {
        // Shape of each message kaia logs for a benign value on the same path.
        const shapes = new Map<string, Set<string>>();
        for (const l of await linesFor(sc.build(sc.benign, sc.benign, token))) {
          const set = shapes.get(msgOf(l)) ?? new Set<string>();
          set.add(parseLogLine(l).keys.join(","));
          shapes.set(msgOf(l), set);
        }
        const rand = mulberry32(0x5eed ^ (sc.name.length * 7919));
        const problems: string[] = [];
        let logged = 0;
        for (let i = 0; i < ITERATIONS; i++) {
          const v = fuzzString(rand);
          const w = fuzzString(rand);
          for (const line of await linesFor(sc.build(v, w, token))) {
            logged++;
            const p = parseLogLine(line);
            const why: string[] = [];
            if (!p.printableAscii) why.push("non-printable byte");
            if (!/^timestamp=\S+ level=(debug|info|warn|error) msg=/.test(line))
              why.push("bad prefix");
            if (p.equalsCount !== p.keys.length) why.push("raw '=' inside a message or value");
            if (new Set(p.keys).size !== p.keys.length) why.push("duplicate key");
            if (p.keys.some((k) => !/^[A-Za-z][A-Za-z0-9]*$/.test(k)))
              why.push("unexpected key shape");
            const known = shapes.get(msgOf(line));
            if (known && !known.has(p.keys.join(",")))
              why.push(`keys differ from benign: ${[...known].join(" | ")}`);
            for (const re of PLANTED) if (re.test(line)) why.push(`planted ${re.source}`);
            if (/ level=error /.test(line)) why.push("error level from client input");
            if (why.length)
              problems.push(
                `${why.join("; ")}\n    v=${JSON.stringify(v).slice(0, 200)}\n    ${line.slice(0, 400)}`
              );
          }
        }
        expect(problems.slice(0, 5).join("\n"), `${problems.length} problem lines`).toBe("");
        lineCounts.set(sc.name, logged);
      },
      60_000
    );
  }
});

/**
 * HTTP-level log and auth follow-ups:
 * - a foreign Origin is logged capped to ORIGIN_LOG_MAX_BYTES input bytes, so one
 *   unauthenticated request writes a small bounded line whatever the header holds;
 * - a malformed Bearer credential gets the invalid_token challenge (-32043,
 *   error="invalid_token"); no credential at all keeps the bare challenge;
 * - a JWT whose signature is not canonical base64url (`<tok>==`, spare low bits) is
 *   invalid_token, so one token has exactly one accepted spelling and fingerprint;
 * - a JSON body nested deeper than MAX_JSON_DEPTH is 400 -32700 with one info line.
 */
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { SCOPES } from "./auth/constants.js";
import { mcpPost, toolsCall } from "./test-support/mcp-http.js";

const getChainId = vi.fn().mockResolvedValue(8217);
vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId })),
}));

/** Raw request so latin-1 header bytes reach the server exactly as sent. */
function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data })
        );
      }
    );
    req.on("error", reject);
    // A Buffer body keeps Node from sending the headers in the body's (UTF-8) encoding:
    // header strings go out as latin-1, one byte per character.
    req.end(Buffer.from(body, "utf8"));
  });
}

describe("HTTP log and auth follow-ups", () => {
  let handle: KaiaHttpServerHandle | undefined;
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;
  const lines = () => chunks.join("").split("\n").filter(Boolean);

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
    getChainId.mockClear();
    chunks.length = 0;
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    process.stderr.write = orig;
    for (const k of ["KAIA_AUTH_MODE", "LOG_LEVEL"]) delete process.env[k];
    resetConfigCache();
  });

  async function start(): Promise<{ h: KaiaHttpServerHandle; token: string }> {
    handle = await runKaiaMcpServerHttp(0);
    return {
      h: handle,
      token: handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token,
    };
  }

  describe("L3: foreign Origin log line is bounded", () => {
    const HOSTILE: Array<[string, string]> = [
      ["latin-1 0xFF (2 UTF-8 bytes, 6 encoded chars each)", "\u00ff".repeat(4000)],
      ["'%' (3 encoded chars each)", "%".repeat(8000)],
      [
        "forged fields",
        "https://x msg=Tool call tool=generate_wallet outcome=allowed ".repeat(100),
      ],
    ];
    for (const [label, origin] of HOSTILE) {
      it(`${label}: one warn line, origin value at most 64 input bytes`, async () => {
        const { h } = await start();
        chunks.length = 0;
        const res = await rawPost(
          h.localUrl,
          { Origin: origin },
          JSON.stringify(toolsCall(1, "get_chain_info"))
        );
        expect(res.status).toBe(403);
        const warn = lines().filter((l) => l.includes("msg=request refused: Origin not allowed"));
        expect(warn).toHaveLength(1);
        const value = /\borigin=(\S+)/.exec(warn[0])?.[1] ?? "";
        // decode the logged value back to bytes: at most 64 input bytes plus the ellipsis
        const decoded = Buffer.from(decodeURIComponent(value), "utf8");
        expect(decoded.length).toBeLessThanOrEqual(64 + 3);
        expect(value.length).toBeLessThanOrEqual(64 * 3 + 9);
        expect(Buffer.byteLength(warn[0])).toBeLessThanOrEqual(330);
        expect(warn[0]).not.toContain(" outcome=allowed");
        expect(getChainId).not.toHaveBeenCalled();
      });
    }

    it("a short foreign Origin is logged whole", async () => {
      const { h } = await start();
      await rawPost(h.localUrl, { Origin: "https://evil.example.test" }, "{}");
      const warn = lines().find((l) => l.includes("msg=request refused: Origin not allowed"));
      expect(warn).toContain(" origin=https://evil.example.test ");
    });
  });

  describe("L4: malformed Bearer credentials get the invalid_token challenge", () => {
    const MALFORMED: Array<[string, (t: string) => string]> = [
      ["quoted token", (t) => `Bearer "${t}"`],
      ["'%' in token", (t) => `Bearer ${t}%`],
      ["'!' in token", (t) => `Bearer ${t}!`],
      ["trailing comma", (t) => `Bearer ${t},`],
      ["tab separator", (t) => `Bearer\t${t}`],
      ["space then tab", (t) => `Bearer \t${t}`],
      ["NBSP separator (latin-1 0xA0)", (t) => `Bearer\u00a0${t}`],
      ["UTF-8 NBSP separator (0xC2 0xA0)", (t) => `Bearer\u00c2\u00a0${t}`],
      ["comma right after the scheme", (t) => `Bearer,${t}`],
      ["'=' in the middle", () => `Bearer ab=cd`],
      ["trailing junk", (t) => `Bearer ${t} x`],
      ["second credential", (t) => `Bearer ${t}, Bearer ${t}`],
    ];
    for (const [label, header] of MALFORMED) {
      it(`${label}: 401 -32043 with error="invalid_token"`, async () => {
        const { h, token } = await start();
        const res = await rawPost(
          h.localUrl,
          { Authorization: header(token) },
          JSON.stringify(toolsCall(1, "get_chain_info"))
        );
        expect(res.status).toBe(401);
        const www = String(res.headers["www-authenticate"]);
        expect(www).toContain('error="invalid_token"');
        expect(www).toContain("resource_metadata=");
        expect(JSON.parse(res.body).error.code).toBe(-32043);
        expect(getChainId).not.toHaveBeenCalled();
        expect(chunks.join("")).not.toContain("eyJ");
      });
    }

    const NO_CREDENTIAL: Array<[string, Record<string, string>]> = [
      ["missing header", {}],
      ["empty header", { Authorization: "" }],
      ["scheme only", { Authorization: "Bearer" }],
      ["scheme and spaces", { Authorization: "Bearer   " }],
      ["Basic scheme", { Authorization: "Basic dXNlcjpwYXNz" }],
      ["no separator", { Authorization: "Bearerabc" }],
    ];
    for (const [label, headers] of NO_CREDENTIAL) {
      it(`${label}: bare challenge, -32040, no error attribute`, async () => {
        const { h } = await start();
        const res = await rawPost(
          h.localUrl,
          headers,
          JSON.stringify(toolsCall(1, "get_chain_info"))
        );
        expect(res.status).toBe(401);
        const www = String(res.headers["www-authenticate"]);
        expect(www).not.toContain("error=");
        expect(www).toContain("resource_metadata=");
        expect(JSON.parse(res.body).error.code).toBe(-32040);
      });
    }

    it("valid forms still authenticate (case-insensitive scheme, several spaces)", async () => {
      const { h, token } = await start();
      for (const header of [`Bearer ${token}`, `bearer ${token}`, `BEARER   ${token}`]) {
        const res = await rawPost(
          h.localUrl,
          { Authorization: header },
          JSON.stringify(toolsCall(1, "get_chain_info"))
        );
        expect(res.status, header).toBe(200);
      }
    });
  });

  describe("N3: only canonical base64url signatures verify", () => {
    it("<tok>== and a signature with spare low bits set are invalid_token", async () => {
      const { h, token } = await start();
      const ok = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), { token });
      expect(ok.res.status).toBe(200);
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = token.at(-1)!;
      // a 256-byte RS256 signature ends in a char carrying 2 data bits and 4 spare zero bits
      const sibling = alphabet[alphabet.indexOf(last) | 1];
      expect(Buffer.from(token.split(".")[2], "base64url")).toEqual(
        Buffer.from(token.split(".")[2].slice(0, -1) + sibling, "base64url")
      );
      for (const forged of [`${token}==`, `${token}=`, token.slice(0, -1) + sibling]) {
        const r = await mcpPost(h.localUrl, toolsCall(2, "get_chain_info"), { token: forged });
        expect(r.res.status, forged.slice(-4)).toBe(401);
        expect((r.body as { error: { code: number } }).error.code).toBe(-32043);
      }
    });
  });

  describe("N4: deeply nested JSON", () => {
    it("5,000 levels: 400 -32700 and one sanitised info line, nothing reaches the SDK", async () => {
      const { h, token } = await start();
      chunks.length = 0;
      const depth = 5000;
      const body =
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_chain_info","arguments":{"a":' +
        "[".repeat(depth) +
        "]".repeat(depth) +
        "}}}";
      const res = await rawPost(h.localUrl, { Authorization: `Bearer ${token}` }, body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: body is nested too deeply" },
      });
      const logged = lines().filter((l) => !l.includes("msg=MCP request authenticated"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(
        / level=info msg=MCP request rejected code=-32700 cell=json-too-deep tokenFingerprint=[0-9a-f]+$/
      );
      expect(getChainId).not.toHaveBeenCalled();
    });

    it("MAX_JSON_DEPTH levels still pass; one more is refused", async () => {
      const { MAX_JSON_DEPTH } = await import("./server.js");
      const { h, token } = await start();
      // The root object, params and arguments are 3 levels; N arrays under "a" make 3 + N,
      // so N = MAX_JSON_DEPTH - 3 just fits and one more exceeds.
      const fit = MAX_JSON_DEPTH - 3;
      const over = MAX_JSON_DEPTH - 2;
      const okArgs = "[".repeat(fit) + "1" + "]".repeat(fit);
      const deep = "[".repeat(over) + "1" + "]".repeat(over);
      const fine = await rawPost(
        h.localUrl,
        { Authorization: `Bearer ${token}` },
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_chain_info","arguments":{"a":${okArgs}}}}`
      );
      expect(fine.status).toBe(200);
      const tooDeep = await rawPost(
        h.localUrl,
        { Authorization: `Bearer ${token}` },
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_chain_info","arguments":{"a":${deep}}}}`
      );
      expect(tooDeep.status).toBe(400);
    });

    it("brackets inside strings do not count toward depth", async () => {
      const { h, token } = await start();
      const res = await rawPost(
        h.localUrl,
        { Authorization: `Bearer ${token}` },
        JSON.stringify(toolsCall(1, "get_chain_info", { s: '\\"' + "[{".repeat(5000) + '\\"]' }))
      );
      expect(res.status).toBe(200);
    });
  });
});

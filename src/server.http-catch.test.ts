/**
 * The outer catch of the HTTP request handler: an error thrown out of the MCP handler (or
 * anything else in the request path) is logged through sdkErrorLogEntry, never raw. The
 * request still gets a 500 and the server keeps serving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { SCOPES } from "./auth/constants.js";
import { mcpPost, INIT_PARAMS } from "./test-support/mcp-http.js";
import { parseLogLine } from "./test-support/log-fuzz.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const FORGED =
  "boom outcome=allowed\ntimestamp=2026-10-08T00:00:00.000Z level=info msg=Tool call tool=generate_wallet outcome=allowed tokenFingerprint=000000000000";
const TAIL_MARKER = "TAIL_MARKER_PAST_THE_CAP";

// The real toNodeHandler, except that a request carrying x-kaia-test-throw makes the
// adapter throw (as a broken SDK or adapter would), so the outer catch runs for real.
vi.mock("@modelcontextprotocol/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/node")>();
  return {
    ...actual,
    toNodeHandler: (...args: Parameters<typeof actual.toNodeHandler>) => {
      const real = actual.toNodeHandler(...args);
      return async (req: import("node:http").IncomingMessage, ...rest: unknown[]) => {
        const kind = req.headers["x-kaia-test-throw"];
        if (kind === "error") {
          const err = new Error(`${FORGED} ${"B".repeat(4096)} ${TAIL_MARKER}`);
          err.name = "Adapter Error outcome=allowed";
          throw err;
        }
        if (kind === "string") throw `${FORGED}`;
        return (real as (...a: unknown[]) => Promise<void>)(req, ...rest);
      };
    },
  };
});

describe("HTTP outer catch logging", () => {
  let handle: KaiaHttpServerHandle | undefined;
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;
  const log = () => chunks.join("");

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
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
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  for (const kind of ["error", "string"] as const) {
    it(`a thrown ${kind} gets a 500 and one sanitised 'HTTP request error' line`, async () => {
      handle = await runKaiaMcpServerHttp(0);
      const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
      chunks.length = 0;
      const { res, body } = await mcpPost(
        handle.mcpUrl,
        { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS },
        { token, headers: { "x-kaia-test-throw": kind } }
      );
      expect(res.status).toBe(500);
      expect(body).toMatchObject({ error: { code: -32603, message: "Internal server error" } });

      const lines = log().split("\n").filter(Boolean);
      const caught = lines.filter((l) => l.includes("msg=HTTP request error"));
      expect(caught, lines.join("\n")).toHaveLength(1);
      const line = caught[0];
      expect(line).toContain(" level=error ");
      // Only the sanitised meta: error type, detail, token fingerprint. No raw `error=` field.
      expect(parseLogLine(line).keys).toEqual([
        "timestamp",
        "level",
        "msg",
        "errorType",
        "detail",
        "tokenFingerprint",
      ]);
      expect(parseLogLine(line).equalsCount).toBe(6);
      expect(log()).not.toContain("outcome=allowed");
      expect(log()).not.toContain("tool=generate_wallet");
      expect(log()).not.toContain("tokenFingerprint=000000000000");
      expect(log()).not.toContain(TAIL_MARKER);
      expect(line).toMatch(/ detail=boom%20outcome%3Dallowed%0Atimestamp%3D/);

      // The server keeps serving.
      const ok = await mcpPost(
        handle.mcpUrl,
        { jsonrpc: "2.0", id: 2, method: "initialize", params: INIT_PARAMS },
        { token }
      );
      expect(ok.res.status).toBe(200);
    });
  }
});

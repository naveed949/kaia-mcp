/**
 * SDK v2 `onerror` hygiene: the SDK's rejection messages on the 2026-07-28 path echo caller
 * input (params.name, Mcp-Name, Mcp-Method, MCP-Protocol-Version, the `_meta` version).
 * kaia must log only a fixed message, the SDK rejection cell and the JSON-RPC code, so a
 * crafted value can neither forge an audit fragment nor grow the log without bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
} from "@modelcontextprotocol/server";
import { runKaiaMcpServerHttp, sdkErrorLogEntry, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { SCOPES } from "./auth/constants.js";
import { logger } from "./utils/logger.js";
import { mcpPost } from "./test-support/mcp-http.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const MODERN = "2026-07-28";
const FORGED = "x msg=Tool call tool=generate_wallet outcome=allowed tokenFingerprint=000000000000";

function envelope(version: string = MODERN) {
  return {
    [PROTOCOL_VERSION_META_KEY]: version,
    [CLIENT_INFO_META_KEY]: { name: "kaia-test", version: "0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

/** Same counters as the verifier's kaia7-forge.mjs and s1's live_kaia.tool_calls(). */
function forgeCounts(log: string) {
  return {
    outcomeAllowed: (log.match(/outcome=allowed/g) ?? []).length,
    s1ToolCalls: (log.match(/msg=Tool call tool=generate_wallet /g) ?? []).length,
  };
}

describe("SDK onerror log hygiene (2026-07-28 path)", () => {
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

  async function start(): Promise<string> {
    handle = await runKaiaMcpServerHttp(0);
    return handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
  }

  it("a crafted name, Mcp-Name, Mcp-Method or protocol version cannot forge an audit line", async () => {
    const token = await start();
    const call = (name: string) => ({
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name, arguments: {}, _meta: envelope() },
    });
    const base = { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" };
    const cases: Array<{
      label: string;
      body: ReturnType<typeof call>;
      headers: Record<string, string>;
    }> = [
      // body params.name carries the forgery, Mcp-Name disagrees (the verifier's repro)
      { label: "params.name", body: call(FORGED), headers: { ...base, "Mcp-Name": "x" } },
      // Mcp-Name header carries the forgery
      { label: "Mcp-Name", body: call("get_chain_info"), headers: { ...base, "Mcp-Name": FORGED } },
      // Mcp-Method header carries the forgery
      {
        label: "Mcp-Method",
        body: call("get_chain_info"),
        headers: { ...base, "Mcp-Method": FORGED, "Mcp-Name": "get_chain_info" },
      },
      // MCP-Protocol-Version header disagrees with the envelope and carries the forgery
      {
        label: "MCP-Protocol-Version",
        body: call("get_chain_info"),
        headers: { ...base, "MCP-Protocol-Version": FORGED, "Mcp-Name": "get_chain_info" },
      },
      // the _meta envelope version claim carries the forgery (UnsupportedProtocolVersion)
      {
        label: "_meta version",
        body: {
          ...call("get_chain_info"),
          params: { name: "get_chain_info", arguments: {}, _meta: envelope(FORGED) },
        },
        headers: { ...base, "Mcp-Name": "get_chain_info" },
      },
      // header and envelope agree on the crafted version: UnsupportedProtocolVersion -32022
      {
        label: "_meta version + matching header",
        body: {
          ...call("get_chain_info"),
          params: { name: "get_chain_info", arguments: {}, _meta: envelope(FORGED) },
        },
        headers: { ...base, "MCP-Protocol-Version": FORGED, "Mcp-Name": "get_chain_info" },
      },
    ];
    for (const c of cases) {
      chunks.length = 0;
      const before = forgeCounts(log());
      const { res, body } = await mcpPost(handle!.mcpUrl, c.body, { token, headers: c.headers });
      expect(res.status, c.label).toBe(400);
      expect((body as { error: { code: number } }).error.code, c.label).toBeLessThan(0);
      const out = log();
      expect(forgeCounts(out), c.label).toEqual(before);
      expect(out, c.label).not.toContain("generate_wallet");
      expect(out, c.label).not.toContain("tokenFingerprint=000000000000");
      const rejected = out.split("\n").filter((l) => l.includes("msg=MCP request rejected"));
      expect(rejected, c.label).toHaveLength(1);
      // client mistakes are not server errors
      expect(rejected[0], c.label).toContain("level=info");
      // the logged JSON-RPC code is the one the SDK answered with (pins SDK_CELL_CODES)
      expect(rejected[0], c.label).toContain(
        ` code=${(body as { error: { code: number } }).error.code} `
      );
      expect(rejected[0], c.label).toMatch(/ cell=[a-z0-9-]+/);
      expect(out, c.label).not.toMatch(/level=error/);
    }
  });

  it("the logged code matches the SDK's answer for each rejection cell", async () => {
    const token = await start();
    const H = { "MCP-Protocol-Version": MODERN };
    const list = (meta?: unknown) => ({
      jsonrpc: "2.0" as const,
      id: 7,
      method: "tools/list",
      params: meta === undefined ? {} : { _meta: meta },
    });
    const cases: Array<{ cell: string; body: unknown; headers: Record<string, string> }> = [
      { cell: "method-header-missing", body: list(envelope()), headers: H },
      {
        cell: "name-header-missing",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_chain_info", arguments: {}, _meta: envelope() },
        },
        headers: { ...H, "Mcp-Method": "tools/call" },
      },
      {
        cell: "modern-header-without-claim",
        body: list(),
        headers: { ...H, "Mcp-Method": "tools/list" },
      },
      {
        cell: "method-header-mismatch",
        body: list(envelope()),
        headers: { ...H, "Mcp-Method": "prompts/list" },
      },
      { cell: "empty-batch", body: [], headers: {} },
      {
        cell: "batch-with-modern-element",
        body: [list(envelope()), list(envelope())],
        headers: {},
      },
    ];
    for (const c of cases) {
      chunks.length = 0;
      const { res, body } = await mcpPost(handle!.mcpUrl, c.body as never, {
        token,
        headers: c.headers,
      });
      const code = (body as { error?: { code: number } } | undefined)?.error?.code;
      expect(res.status, c.cell).toBe(400);
      const line = log()
        .split("\n")
        .find((l) => l.includes("msg=MCP request rejected"));
      expect(line, c.cell).toContain(` cell=${c.cell} `);
      expect(line, c.cell).toContain(` code=${code} `);
    }
  });

  it("logs the SDK rejection cell and JSON-RPC code for a name/header mismatch", async () => {
    const token = await start();
    await mcpPost(
      handle!.mcpUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: FORGED, arguments: {}, _meta: envelope() },
      },
      {
        token,
        headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "x" },
      }
    );
    const line = log()
      .split("\n")
      .find((l) => l.includes("msg=MCP request rejected"));
    expect(line).toMatch(
      /level=info msg=MCP request rejected code=-32020 cell=name-header-mismatch /
    );
    expect(line).not.toContain("params.name");
    expect(line).not.toContain("Bad Request");
  });

  it("a huge caller name adds a bounded number of log bytes", async () => {
    const token = await start();
    const big = "A".repeat(3 * 1024 * 1024);
    const before = Buffer.byteLength(log());
    for (let i = 0; i < 3; i++) {
      const { res } = await mcpPost(
        handle!.mcpUrl,
        {
          jsonrpc: "2.0",
          id: i,
          method: "tools/call",
          params: { name: big, arguments: {}, _meta: envelope() },
        },
        {
          token,
          headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "x" },
        }
      );
      expect(res.status).toBe(400);
    }
    const grew = Buffer.byteLength(log()) - before;
    // three short fixed-format lines; the 3 MiB names are never echoed
    expect(grew).toBeGreaterThan(0);
    expect(grew).toBeLessThan(3 * 512);
    expect(log()).not.toContain("AAAAAAAAAAAAAAAA");
  });
});

describe("sdkErrorLogEntry", () => {
  it("classifies SDK ladder rejections as client errors with no caller text", () => {
    const e = sdkErrorLogEntry(
      new Error(
        `Rejected inbound request (name-header-mismatch): Bad Request: the body carries params.name="${FORGED}"`
      )
    );
    expect(e.level).toBe("info");
    expect(e.message).toBe("MCP request rejected");
    expect(e.meta).toEqual({ code: -32020, cell: "name-header-mismatch", errorType: "Error" });
    expect(JSON.stringify(e)).not.toContain("generate_wallet");
  });

  it("keeps the JSON-RPC code of a client ProtocolError and drops its message", () => {
    const e = sdkErrorLogEntry(
      new ProtocolError(-32022, `Unsupported protocol version: ${FORGED}`)
    );
    expect(e.level).toBe("info");
    expect(e.meta).toMatchObject({
      code: -32022,
      cell: "protocol-error",
      errorType: "ProtocolError",
    });
    expect(JSON.stringify(e)).not.toContain("generate_wallet");
  });

  it("maps the legacy transport's fixed-prefix rejections to client cells", () => {
    expect(
      sdkErrorLogEntry(new Error(`Bad Request: Unsupported protocol version: ${FORGED}`)).meta
    ).toMatchObject({
      cell: "unsupported-protocol-version",
    });
    expect(sdkErrorLogEntry(new Error("Not Acceptable: Client must accept both")).meta.cell).toBe(
      "not-acceptable"
    );
    expect(
      sdkErrorLogEntry(new Error("Unsupported Media Type: Content-Type must be")).meta.cell
    ).toBe("unsupported-media-type");
    expect(sdkErrorLogEntry(new Error(`Invalid Origin header: ${FORGED}`)).meta.cell).toBe(
      "invalid-host-or-origin"
    );
    for (const msg of ["Not Acceptable: x", `Invalid Origin header: ${FORGED}`]) {
      expect(JSON.stringify(sdkErrorLogEntry(new Error(msg)))).not.toContain("generate_wallet");
    }
  });

  it("an unexpected error is logged at error with only an escaped, capped detail", () => {
    const e = sdkErrorLogEntry(
      new Error(`Received a response for an unknown message ID: ${FORGED}\n${"B".repeat(4096)}`)
    );
    expect(e.level).toBe("error");
    expect(e.message).toBe("MCP transport error");
    // The logger caps and percent-encodes the detail like every other value.
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      logger[e.level](e.message, e.meta);
    } finally {
      process.stderr.write = orig;
    }
    const line = chunks.join("").trimEnd();
    const detail = / detail=(\S*)/.exec(line)?.[1] ?? "";
    expect(detail.startsWith("Received%20a%20response")).toBe(true);
    expect(detail).not.toMatch(/[ =\n]/);
    expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(256 * 3 + 9);
    expect(line).not.toContain("outcome=allowed");
    expect(
      line
        .split(" ")
        .filter((t) => t.includes("="))
        .map((t) => t.split("=")[0])
    ).toEqual(["timestamp", "level", "msg", "errorType", "detail"]);
  });

  it("does not trust a caller-shaped cell", () => {
    const e = sdkErrorLogEntry(
      new Error(`Rejected inbound request (x outcome=allowed): ${FORGED}`)
    );
    expect(e.meta.cell).toBe("unknown");
  });
});

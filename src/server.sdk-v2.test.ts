/**
 * SDK v2 / MCP 2026-07-28: protocol-version negotiation, server/discover,
 * HeaderMismatch (-32020), and tools/list cacheScope:private (per-scope filtering).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { SCOPES } from "./auth/constants.js";
import { INIT_PARAMS, mcpPost } from "./test-support/mcp-http.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const MODERN = "2026-07-28";

function modernEnvelope(extra: Record<string, unknown> = {}) {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: "kaia-test", version: "0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...extra,
  };
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  const h: Record<string, string> = {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": method,
  };
  if (name !== undefined) h["Mcp-Name"] = name;
  return h;
}

describe("SDK v2 MCP 2026-07-28", () => {
  let handle: KaiaHttpServerHandle | undefined;

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("accepts MCP-Protocol-Version 2026-07-28 (SDK v1 used to 400)", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: modernEnvelope() },
      },
      { token, headers: modernHeaders("server/discover") }
    );
    expect(res.status).toBe(200);
    const result = (
      body as { result: { supportedVersions: string[]; ttlMs: number; cacheScope: string } }
    ).result;
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.ttlMs).toBeDefined();
    expect(result.cacheScope).toBeDefined();
  });

  it("server/discover answers without a session and without initialize", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "server/discover",
        params: { _meta: modernEnvelope() },
      },
      { token, headers: modernHeaders("server/discover") }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { supportedVersions: expect.arrayContaining([MODERN]) },
    });
  });

  it("HeaderMismatch -32020 when Mcp-Method disagrees with the body", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "server/discover",
        params: { _meta: modernEnvelope() },
      },
      { token, headers: { ...modernHeaders("tools/list") } }
    );
    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32020 },
    });
  });

  it("HeaderMismatch -32020 when Mcp-Method is absent on a modern request", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "server/discover",
        params: { _meta: modernEnvelope() },
      },
      { token, headers: { "MCP-Protocol-Version": MODERN } }
    );
    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: { code: -32020 },
    });
  });

  it("tools/list on the modern path carries cacheScope private (scoped list)", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: { _meta: modernEnvelope() },
      },
      { token, headers: modernHeaders("tools/list") }
    );
    expect(res.status).toBe(200);
    const result = (
      body as {
        result: { tools: { name: string }[]; cacheScope: string; ttlMs: number };
      }
    ).result;
    expect(result.tools.map((t) => t.name)).toEqual(["encode_function_data"]);
    // Must never be public: the list varies by token scopes.
    expect(result.cacheScope).toBe("private");
    expect(result.ttlMs).toBe(0);
  });

  it("legacy 2025 initialize still works alongside 2026-07-28", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      { jsonrpc: "2.0", id: 6, method: "initialize", params: INIT_PARAMS },
      { token }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(body).toMatchObject({
      result: { serverInfo: { name: "kaia-mcp" } },
    });
  });

  it("modern tools/call with matching Mcp-Name succeeds", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const msg = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "tools/call",
      params: {
        name: "get_chain_info",
        arguments: { network: "mainnet" },
        _meta: modernEnvelope(),
      },
    };
    const { res, body } = await mcpPost(handle.mcpUrl, msg, {
      token,
      headers: modernHeaders("tools/call", "get_chain_info"),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toContain("Chain ID: 8217");
  });

  it("HeaderMismatch -32020 when Mcp-Name disagrees with tools/call params.name", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const msg = {
      jsonrpc: "2.0" as const,
      id: 8,
      method: "tools/call",
      params: {
        name: "get_chain_info",
        arguments: { network: "mainnet" },
        _meta: modernEnvelope(),
      },
    };
    const { res, body } = await mcpPost(handle.mcpUrl, msg, {
      token,
      headers: modernHeaders("tools/call", "encode_function_data"),
    });
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: { code: -32020 } });
  });
});

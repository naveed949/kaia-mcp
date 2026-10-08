/**
 * MCP 2026-07-28 Streamable HTTP: no protocol-level sessions. Every POST is
 * served by a fresh server+transport, Mcp-Session-Id is never minted or echoed (and is
 * ignored when a legacy client sends one), and GET/DELETE on the MCP endpoint are 405.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "./server.js";
import { resetConfigCache } from "./config.js";
import { SCOPES } from "./auth/constants.js";
import { INIT_PARAMS, mcpPost, toolsCall } from "./test-support/mcp-http.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

describe("stateless Streamable HTTP", () => {
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

  it("initialize answers without minting an Mcp-Session-Id", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS },
      { token }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "kaia-mcp" } },
    });
  });

  it("tools/call works as a standalone POST with no initialize and no session header", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      toolsCall(7, "get_chain_info", { network: "mainnet" }),
      { token }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(JSON.stringify(body)).toContain("Chain ID: 8217");
  });

  it("tools/list works standalone and stays filtered to the token's scopes", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] }).access_token;
    const { res, body } = await mcpPost(
      handle.mcpUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { token }
    );
    expect(res.status).toBe(200);
    const names = (body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name
    );
    expect(names).toEqual(["encode_function_data"]);
  });

  it("a legacy Mcp-Session-Id header is ignored, never echoed, and never 404s", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res } = await mcpPost(
      handle.mcpUrl,
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { token, headers: { "Mcp-Session-Id": "11111111-dead-beef-0000-000000000000" } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("the token on each POST is the only authority (no state carried between requests)", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const read = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const enc = handle.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] }).access_token;
    const list = async (token: string) =>
      (
        (await mcpPost(handle!.mcpUrl, { jsonrpc: "2.0", id: 4, method: "tools/list" }, { token }))
          .body as { result: { tools: { name: string }[] } }
      ).result.tools.length;
    expect(await list(enc)).toBe(1);
    expect(await list(read)).toBe(24);
    expect(await list(enc)).toBe(1);
  });

  it.each(["GET", "DELETE"])("%s on the MCP endpoint is 405 with Allow: POST", async (method) => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const res = await fetch(handle.mcpUrl, {
      method,
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        "Mcp-Session-Id": "11111111-dead-beef-0000-000000000000",
      },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("a notification POST is accepted with 202 and no body", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res } = await mcpPost(
      handle.mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { token }
    );
    expect(res.status).toBe(202);
  });

  it("malformed JSON is a 400 JSON-RPC parse error, not a 500", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const res = await fetch(handle.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
  });
});

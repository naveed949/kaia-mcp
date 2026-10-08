/**
 * DNS-rebinding protection (MCP 2026-07-28 Streamable HTTP "Security & Endpoint"): an
 * Origin header that is present and not allow-listed gets 403 before auth or any tool
 * runs; requests without Origin (non-browser clients) pass. CORS no longer answers "*"
 * on the MCP/OAuth surface and advertises the 2026-07-28 request headers, not
 * Mcp-Session-Id. Public discovery documents stay readable cross-origin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { getConfig, resetConfigCache } from "../config.js";
import { SCOPES } from "./constants.js";
import { mcpPost, toolsCall } from "../test-support/mcp-http.js";

const getChainId = vi.fn().mockResolvedValue(8217);
vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId })),
}));

const EVIL = "https://evil.example.test";

describe("Origin validation and CORS", () => {
  let handle: KaiaHttpServerHandle | undefined;

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
    getChainId.mockClear();
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    for (const k of ["KAIA_AUTH_MODE", "LOG_LEVEL", "KAIA_ALLOWED_ORIGINS", "KAIA_PUBLIC_URL"]) {
      delete process.env[k];
    }
    resetConfigCache();
  });

  async function start(): Promise<{ h: KaiaHttpServerHandle; token: string }> {
    handle = await runKaiaMcpServerHttp(0);
    return {
      h: handle,
      token: handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token,
    };
  }

  it("a foreign Origin on an MCP POST is 403 with an id-less JSON-RPC error, and no tool runs", async () => {
    const { h, token } = await start();
    const { res, body } = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), {
      token,
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(403);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden: Origin not allowed" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(getChainId).not.toHaveBeenCalled();
  });

  it("Origin is checked before auth: a foreign Origin without a token is 403, not 401", async () => {
    const { h } = await start();
    const { res } = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), {
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(403);
  });

  it("no Origin header (non-browser client) is allowed", async () => {
    const { h, token } = await start();
    const { res } = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), { token });
    expect(res.status).toBe(200);
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  it("the server's own public origin is allowed by default and echoed (never *)", async () => {
    const { h, token } = await start();
    const { res } = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), {
      token,
      headers: { Origin: h.issuer },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(h.issuer);
    expect(res.headers.get("vary")).toMatch(/Origin/);
    expect(res.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/i);
  });

  it("KAIA_ALLOWED_ORIGINS extends the allow-list", async () => {
    process.env.KAIA_ALLOWED_ORIGINS = "https://app.example.test, http://localhost:6274";
    resetConfigCache();
    const { h, token } = await start();
    for (const origin of ["https://app.example.test", "http://localhost:6274"]) {
      const { res } = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), {
        token,
        headers: { Origin: origin },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    const { res } = await mcpPost(h.localUrl, toolsCall(1, "get_chain_info"), {
      token,
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(403);
  });

  it("preflight from an allowed origin advertises the 2026-07-28 headers and no session header", async () => {
    const { h } = await start();
    const res = await fetch(h.localUrl, {
      method: "OPTIONS",
      headers: {
        Origin: h.issuer,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, mcp-protocol-version, mcp-method",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(h.issuer);
    const allow = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const hdr of [
      "authorization",
      "content-type",
      "mcp-protocol-version",
      "mcp-method",
      "mcp-name",
    ]) {
      expect(allow).toContain(hdr);
    }
    expect(allow).not.toContain("mcp-session-id");
    expect(res.headers.get("access-control-allow-methods")).not.toContain("DELETE");
  });

  it("preflight from a foreign origin is 403", async () => {
    const { h } = await start();
    const res = await fetch(h.localUrl, {
      method: "OPTIONS",
      headers: { Origin: EVIL, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("OAuth endpoints refuse a foreign Origin too (token, consent)", async () => {
    const { h } = await start();
    for (const path of ["/oauth/token", "/oauth/consent", "/oauth/revoke"]) {
      const res = await fetch(`${h.localUrl}${path}`, {
        method: "POST",
        headers: { Origin: EVIL, "Content-Type": "application/x-www-form-urlencoded" },
        body: "x=1",
        redirect: "manual",
      });
      expect(res.status, path).toBe(403);
    }
  });

  it("public discovery documents stay readable from any origin (ACAO *)", async () => {
    const { h } = await start();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/oauth/jwks",
      "/health",
    ]) {
      const res = await fetch(`${h.localUrl}${path}`, { headers: { Origin: EVIL } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
    }
  });

  it("config: KAIA_ALLOWED_ORIGINS entries must be origins; * is refused", () => {
    process.env.KAIA_ALLOWED_ORIGINS = "https://ok.example.test,HTTPS://Upper.Example.test:443";
    resetConfigCache();
    expect(getConfig().allowedOrigins).toEqual([
      "https://ok.example.test",
      "https://upper.example.test",
    ]);
    for (const bad of ["*", "https://x.example.test/path", "not a url"]) {
      process.env.KAIA_ALLOWED_ORIGINS = bad;
      resetConfigCache();
      expect(() => getConfig(), bad).toThrow(/KAIA_ALLOWED_ORIGINS/);
    }
  });
});

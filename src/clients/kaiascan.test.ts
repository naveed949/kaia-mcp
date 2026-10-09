import { describe, it, expect, beforeEach, vi } from "vitest";
import { createKaiaScanClient, KaiaScanRateLimitError } from "./kaiascan.js";
import { resetConfigCache } from "../config.js";
import { toMcpError, MCP_ERROR_CODES } from "../utils/errors.js";

describe("createKaiaScanClient", () => {
  beforeEach(() => {
    resetConfigCache();
    process.env.KAIA_RPC_URL = "https://public-en.node.kaia.io";
    process.env.KAIA_KAIROS_RPC_URL = "https://public-en-kairos.node.kaia.io";
    vi.restoreAllMocks();
  });

  it("returns object with get method", () => {
    const client = createKaiaScanClient();
    expect(typeof client.get).toBe("function");
  });

  it("accepts optional config override", () => {
    const client = createKaiaScanClient({
      kaiaRpcUrl: "https://a.io",
      kaiaKairosRpcUrl: "https://b.io",
      kaiascanApiKey: "key",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 10,
      rateLimitKaiascan: 5,
      rpcTimeoutMs: 30000,
      kaiascanTimeoutMs: 15000,
      authMode: "required",
      allowUnsafeWallet: false,
      oauthClientId: "kaia-mcp-demo",
      accessTokenTtlSeconds: 900,
      oauthRequireResource: false,
      allowedOrigins: [],
      oauthPreviousSigningKeyFiles: [],
      introspectionClientId: "kaia-mcp-gateway",
    });
    expect(typeof client.get).toBe("function");
  });

  it("on 429 after retry throws KaiaScanRateLimitError which toMcpError maps to RateLimit", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount += 1;
        return Promise.resolve({
          status: 429,
          statusText: "Too Many Requests",
          ok: false,
          json: () => Promise.resolve({}),
        } as Response);
      })
    );
    const client = createKaiaScanClient({
      kaiaRpcUrl: "https://a.io",
      kaiaKairosRpcUrl: "https://b.io",
      kaiascanApiKey: "",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 10,
      rateLimitKaiascan: 5,
      rpcTimeoutMs: 30000,
      kaiascanTimeoutMs: 15000,
      authMode: "required",
      allowUnsafeWallet: false,
      oauthClientId: "kaia-mcp-demo",
      accessTokenTtlSeconds: 900,
      oauthRequireResource: false,
      allowedOrigins: [],
      oauthPreviousSigningKeyFiles: [],
      introspectionClientId: "kaia-mcp-gateway",
    });
    await expect(client.get("/api")).rejects.toThrow(KaiaScanRateLimitError);
    // One initial request plus exactly one retry before giving up.
    expect(callCount).toBe(2);
    const err = new KaiaScanRateLimitError();
    expect(toMcpError(err).code).toBe(MCP_ERROR_CODES.RateLimit);
  });

  it("clears its timeout once the response is read or the request fails (no late abort)", async () => {
    const signals: AbortSignal[] = [];
    let fail = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return fail
          ? Promise.reject(new Error("connect refused"))
          : Promise.resolve(new Response('{"ok":1}', { status: 200 }));
      })
    );
    const client = createKaiaScanClient({
      kaiaRpcUrl: "https://a.io",
      kaiaKairosRpcUrl: "https://b.io",
      kaiascanApiKey: "",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 10,
      rateLimitKaiascan: 100,
      rpcTimeoutMs: 30000,
      kaiascanTimeoutMs: 50,
      authMode: "required",
      allowUnsafeWallet: false,
      oauthClientId: "kaia-mcp-demo",
      accessTokenTtlSeconds: 900,
      oauthRequireResource: false,
      allowedOrigins: [],
      oauthPreviousSigningKeyFiles: [],
      introspectionClientId: "kaia-mcp-gateway",
    });
    await expect(client.get("/api")).resolves.toEqual({ ok: 1 });
    fail = true;
    await expect(client.get("/api")).rejects.toThrow();
    // Past the 50 ms timeout: a timer left running would have aborted the signals by now.
    await new Promise((r) => setTimeout(r, 150));
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
  });
});

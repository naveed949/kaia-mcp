/**
 * Golden evals for partner-mode auth. Assertions use literal expected results.
 */

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createKaiaMcpServer, runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { callTool, listTools } from "../tools/index.js";
import {
  getGenerateWalletInvocationCount,
  resetGenerateWalletInvocationCount,
} from "../tools/wallet.js";
import { resetConfigCache } from "../config.js";
import { createDemoOAuthProvider } from "../auth/provider.js";
import { createRpcClient } from "../clients/rpc.js";
import { AUTH_ERRORS, DEMO_CLIENT_ID, SCOPES, insufficientScopeError } from "../auth/constants.js";
import { MCP_ERROR_CODES } from "../utils/errors.js";
import type { AuthContext } from "../auth/types.js";

vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({
    getChainId: vi.fn().mockResolvedValue(8217),
  })),
}));

const BALANCE_OF_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
]);

const ENCODE_ARGS = {
  abi: BALANCE_OF_ABI,
  functionName: "balanceOf",
  args: ["0x1234567890123456789012345678901234567890"],
};

const EXPECTED_BALANCE_OF_CALLDATA =
  "0x70a082310000000000000000000000001234567890123456789012345678901234567890";

const EXPECTED_CHAIN_INFO_TEXT = [
  "Chain ID: 8217",
  "Chain name: Kaia Mainnet",
  "Native currency: KAIA (KAIA, 18 decimals)",
  "Network: mainnet",
].join("\n");

function auth(scopes: string[], expiresAtMs = Date.now() + 60_000): AuthContext {
  return {
    subject: "demo-user",
    clientId: DEMO_CLIENT_ID,
    scopes,
    expiresAtMs,
    tokenFingerprint: "deadbeefcafe",
  };
}

describe("partner-auth golden evals (in-process)", () => {
  beforeEach(() => {
    resetConfigCache();
    delete process.env.KAIA_ALLOW_UNSAFE_WALLET;
    resetConfigCache();
    resetGenerateWalletInvocationCount();
    vi.mocked(createRpcClient).mockReturnValue({
      getChainId: vi.fn().mockResolvedValue(8217),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("allow by scope: kaia:read can call get_chain_info", async () => {
    const result = await callTool(
      "get_chain_info",
      { network: "mainnet" },
      {
        requireAuth: true,
        auth: auth([SCOPES.READ]),
      }
    );
    expect(result).toEqual({
      content: [{ type: "text", text: EXPECTED_CHAIN_INFO_TEXT }],
      _meta: {},
    });
  });

  it("allow by scope: kaia:encode can call encode_function_data", async () => {
    const result = await callTool("encode_function_data", ENCODE_ARGS, {
      requireAuth: true,
      auth: auth([SCOPES.ENCODE]),
    });
    expect(result).toEqual({
      content: [{ type: "text", text: EXPECTED_BALANCE_OF_CALLDATA }],
      _meta: {},
    });
  });

  it("deny by scope: kaia:read cannot call encode_function_data and handler is not reached", async () => {
    const denied = insufficientScopeError("encode_function_data", SCOPES.ENCODE);
    await expect(
      callTool("encode_function_data", ENCODE_ARGS, {
        requireAuth: true,
        auth: auth([SCOPES.READ]),
      })
    ).rejects.toMatchObject({
      name: "AuthError",
      code: denied.code,
      error: denied.error,
      message: denied.message,
    });
  });

  it("expired token: tool call fails closed with token_expired", async () => {
    await expect(
      callTool(
        "get_chain_info",
        { network: "mainnet" },
        {
          requireAuth: true,
          auth: auth([SCOPES.READ], Date.now() - 1),
        }
      )
    ).rejects.toMatchObject({
      name: "AuthError",
      ...AUTH_ERRORS.TOKEN_EXPIRED,
    });
  });

  it("unauthenticated: missing token fails closed with unauthorized", async () => {
    await expect(
      callTool("get_chain_info", { network: "mainnet" }, { requireAuth: true, auth: null })
    ).rejects.toMatchObject({
      name: "AuthError",
      ...AUTH_ERRORS.UNAUTHORIZED,
    });
  });

  it("generate_wallet is omitted from tools/list and does not mint a key", async () => {
    const listed = listTools({ requireAuth: true, auth: auth([SCOPES.READ, SCOPES.WALLET]) });
    expect(listed.tools.map((t) => t.name)).not.toContain("generate_wallet");

    await expect(
      callTool("generate_wallet", {}, { requireAuth: true, auth: auth([SCOPES.WALLET]) })
    ).rejects.toMatchObject({
      name: "AuthError",
      ...AUTH_ERRORS.TOOL_DISABLED,
    });
    expect(getGenerateWalletInvocationCount()).toBe(0);
  });

  it("MCP server maps deny-by-scope to the literal JSON-RPC error", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer({
      requireAuth: true,
      getAuthContext: () => auth([SCOPES.READ]),
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "eval", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      await client.callTool({ name: "encode_function_data", arguments: ENCODE_ARGS });
      throw new Error("expected callTool to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcp = err as McpError;
      expect(mcp.code).toBe(MCP_ERROR_CODES.InsufficientScope);
      expect(mcp.message).toContain(
        "insufficient_scope: encode_function_data requires kaia:encode"
      );
    }
  });
});

describe("partner-auth golden evals (HTTP + demo OIDC)", () => {
  let handle: KaiaHttpServerHandle | undefined;

  beforeEach(() => {
    resetConfigCache();
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    delete process.env.KAIA_ALLOW_UNSAFE_WALLET;
    resetConfigCache();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    delete process.env.KAIA_INTROSPECTION_CLIENT_SECRET;
    resetConfigCache();
  }, 20_000);

  async function start(): Promise<KaiaHttpServerHandle> {
    handle = await runKaiaMcpServerHttp(0);
    return handle;
  }

  it("unauthenticated MCP initialize returns the literal unauthorized body", async () => {
    const http = await start();
    const res = await fetch(http.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "eval", version: "0" },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32040,
        message: "unauthorized: missing access token",
        data: { error: "unauthorized" },
      },
      id: null,
    });
  });

  it("expired token returns the literal token_expired body", async () => {
    const http = await start();
    const tokens = http.oauth.issueAccessToken({
      scopes: [SCOPES.ENCODE],
      expiresAtMs: Date.now() - 5_000,
    });
    const res = await fetch(http.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "eval", version: "0" },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32041,
        message: "token_expired: access token has expired",
        data: { error: "token_expired" },
      },
      id: null,
    });
  });

  it("allow by scope over HTTP: encode_function_data with kaia:encode", async () => {
    const http = await start();
    const tokens = http.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] });
    const transport = new StreamableHTTPClientTransport(new URL(http.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "eval", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "encode_function_data",
        arguments: ENCODE_ARGS,
      });
      expect(result).toEqual({
        content: [{ type: "text", text: EXPECTED_BALANCE_OF_CALLDATA }],
        _meta: {},
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("deny by scope over HTTP: encode_function_data with kaia:read only", async () => {
    const http = await start();
    const tokens = http.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    const transport = new StreamableHTTPClientTransport(new URL(http.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "eval", version: "1.0.0" });
    await client.connect(transport);
    try {
      await client.callTool({ name: "encode_function_data", arguments: ENCODE_ARGS });
      throw new Error("expected callTool to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcp = err as McpError;
      expect(mcp.code).toBe(-32042);
      expect(mcp.message).toContain(
        "insufficient_scope: encode_function_data requires kaia:encode"
      );
    } finally {
      await client.close();
      await transport.close();
    }
  });

  async function initializeWith(http: KaiaHttpServerHandle, token: string): Promise<Response> {
    return fetch(http.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "eval", version: "0" },
        },
      }),
    });
  }

  const INVALID_TOKEN_BODY = {
    jsonrpc: "2.0",
    error: {
      code: -32043,
      message: "invalid_token: access token is invalid or revoked",
      data: { error: "invalid_token" },
    },
    id: null,
  };

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

  it("access token is an RS256 JWT with iss, aud, sub, scope, exp, nbf, iat, jti", async () => {
    const http = await start();
    const { access_token } = http.oauth.issueAccessToken({
      subject: "eval-user",
      scopes: [SCOPES.READ],
    });
    const [h, p] = access_token.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "at+jwt",
      kid: http.oauth.signingKey.kid,
    });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual([
      "aud",
      "client_id",
      "exp",
      "iat",
      "iss",
      "jti",
      "nbf",
      "scope",
      "sub",
    ]);
    expect(claims).toMatchObject({
      iss: http.issuer,
      aud: http.issuer,
      sub: "eval-user",
      scope: "kaia:read",
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
  });

  it("forged token (foreign key, real kid) returns the literal invalid_token body", async () => {
    const http = await start();
    const { access_token } = http.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] });
    const claims = JSON.parse(
      Buffer.from(access_token.split(".")[1], "base64url").toString()
    ) as object;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = `${b64({ alg: "RS256", typ: "at+jwt", kid: http.oauth.signingKey.kid })}.${b64(claims)}`;
    const forged = `${input}.${cryptoSign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
    const res = await initializeWith(http, forged);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it("wrong-audience token signed by the real key returns the literal invalid_token body", async () => {
    const http = await start();
    const other = createDemoOAuthProvider({
      issuer: http.issuer,
      resource: "other-api",
      signingKey: http.oauth.signingKey,
    });
    const res = await initializeWith(
      http,
      other.issueAccessToken({ scopes: [SCOPES.READ] }).access_token
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it("revoked jti returns the literal invalid_token body", async () => {
    const http = await start();
    const { access_token } = http.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    expect((await initializeWith(http, access_token)).status).toBe(200);
    const revoke = await fetch(`${http.issuer}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access_token }),
    });
    expect(revoke.status).toBe(200);
    const res = await initializeWith(http, access_token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it("introspection: unauthenticated 401, active claims, then inactive after revoke", async () => {
    process.env.KAIA_INTROSPECTION_CLIENT_SECRET = "eval-only-secret";
    resetConfigCache();
    const http = await start();
    const { access_token } = http.oauth.issueAccessToken({
      subject: "eval-user",
      scopes: [SCOPES.READ],
    });
    const claims = JSON.parse(
      Buffer.from(access_token.split(".")[1], "base64url").toString()
    ) as Record<string, unknown>;
    const introspect = (authorization?: string) =>
      fetch(`${http.issuer}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: new URLSearchParams({ token: access_token }),
      });
    const gateway = `Basic ${Buffer.from("kaia-mcp-gateway:eval-only-secret").toString("base64")}`;

    const anon = await introspect();
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({
      error: "invalid_client",
      error_description: "introspection requires client authentication",
    });

    expect(await (await introspect(gateway)).json()).toEqual({
      active: true,
      token_type: "Bearer",
      scope: "kaia:read",
      client_id: DEMO_CLIENT_ID,
      sub: "eval-user",
      aud: http.issuer,
      iss: http.issuer,
      exp: claims.exp,
      iat: claims.iat,
      nbf: claims.nbf,
      jti: claims.jti,
    });

    http.oauth.revoke(access_token);
    expect(await (await introspect(gateway)).json()).toEqual({ active: false });
  });
});

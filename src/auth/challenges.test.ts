/**
 * RFC 9728 protected resource metadata and RFC 6750 Bearer challenges, per the MCP
 * 2026-07-28 authorization spec: 401 carries resource_metadata + scope; a token that
 * lacks a tool's scope gets HTTP 403 error="insufficient_scope" naming the scope, with
 * the JSON-RPC -32042 error (s1-tool-gate's contract) still in the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { resetConfigCache } from "../config.js";
import { SCOPES } from "./constants.js";
import { INIT_PARAMS, mcpPost, toolsCall } from "../test-support/mcp-http.js";

vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const ENCODE_ARGS = {
  abi: JSON.stringify([
    {
      type: "function",
      name: "balanceOf",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }],
      stateMutability: "view",
    },
  ]),
  functionName: "balanceOf",
  args: ["0x1234567890123456789012345678901234567890"],
};

/** Parse an RFC 6750 challenge into scheme + params. */
function challenge(header: string | null): { scheme: string; params: Record<string, string> } {
  expect(header).toBeTruthy();
  const [scheme, ...rest] = header!.split(" ");
  const params: Record<string, string> = {};
  for (const m of rest.join(" ").matchAll(/([a-z_]+)="([^"]*)"/g)) params[m[1]] = m[2];
  return { scheme, params };
}

describe("PRM and Bearer challenges", () => {
  let handle: KaiaHttpServerHandle | undefined;
  const stderr: string[] = [];
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
    process.env.KAIA_AUTH_MODE = "required";
    process.env.KAIA_PUBLIC_URL = "https://kaia.example.test";
    resetConfigCache();
    stderr.length = 0;
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = origWrite;
    await handle?.close();
    handle = undefined;
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.KAIA_PUBLIC_URL;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  const PRM_URL = "https://kaia.example.test/.well-known/oauth-protected-resource";

  it("serves RFC 9728 metadata with resource = canonical URI", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const res = await fetch(`${handle.localUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://kaia.example.test",
      authorization_servers: ["https://kaia.example.test"],
      scopes_supported: ["kaia:read", "kaia:encode", "kaia:wallet"],
      bearer_methods_supported: ["header"],
      resource_name: "kaia-mcp",
    });
  });

  it("401 without a token: Bearer challenge with resource_metadata and scope, no error code", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const { res, body } = await mcpPost(handle.localUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: INIT_PARAMS,
    });
    expect(res.status).toBe(401);
    const c = challenge(res.headers.get("www-authenticate"));
    expect(c.scheme).toBe("Bearer");
    expect(c.params.resource_metadata).toBe(PRM_URL);
    expect(c.params.scope).toBe("kaia:read");
    expect(c.params.error).toBeUndefined();
    expect(body).toMatchObject({ error: { code: -32040 } });
  });

  it("401 with an invalid token: error=invalid_token plus resource_metadata and scope", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const { res, body } = await mcpPost(
      handle.localUrl,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: "not-a-jwt" }
    );
    expect(res.status).toBe(401);
    const c = challenge(res.headers.get("www-authenticate"));
    expect(c.params).toMatchObject({
      error: "invalid_token",
      resource_metadata: PRM_URL,
      scope: "kaia:read",
    });
    expect(body).toMatchObject({ error: { code: -32043 } });
  });

  it("403 insufficient_scope challenge for a tool the token cannot call; -32042 body keeps the request id", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(
      handle.localUrl,
      toolsCall(42, "encode_function_data", ENCODE_ARGS),
      { token }
    );
    expect(res.status).toBe(403);
    const c = challenge(res.headers.get("www-authenticate"));
    expect(c.scheme).toBe("Bearer");
    expect(c.params).toMatchObject({
      error: "insufficient_scope",
      scope: "kaia:encode",
      resource_metadata: PRM_URL,
    });
    expect(c.params.error_description).toContain("encode_function_data");
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 42,
      error: {
        code: -32042,
        message: "insufficient_scope: encode_function_data requires kaia:encode",
        data: { error: "insufficient_scope" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("0x70a08231");
    const lines = stderr
      .join("")
      .split("\n")
      .filter((l) => l.includes("msg=Tool call"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tool=encode_function_data outcome=denied");
    expect(lines[0]).toContain("reason=insufficient_scope");
  });

  it("a sufficient scope still answers 200 with the tool result", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] }).access_token;
    const { res, body } = await mcpPost(
      handle.localUrl,
      toolsCall(43, "encode_function_data", ENCODE_ARGS),
      { token }
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toContain("0x70a08231");
  });

  it("generate_wallet while disabled stays a 200 JSON-RPC tool_disabled (-32044), not a 403", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(handle.localUrl, toolsCall(44, "generate_wallet"), {
      token,
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id: 44, error: { code: -32044 } });
  });

  it("an unknown tool is not a scope challenge (200 JSON-RPC error)", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const token = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const { res, body } = await mcpPost(handle.localUrl, toolsCall(45, "no_such_tool"), {
      token,
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id: 45, error: {} });
  });
});

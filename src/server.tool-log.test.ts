/**
 * The per-call "Tool call" audit line is written once, after the authorization
 * decision, and carries the outcome. It never carries arguments or token material.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { DEMO_CLIENT_ID, SCOPES } from "./auth/constants.js";
import type { AuthContext } from "./auth/types.js";

const getChainId = vi.fn().mockResolvedValue(8217);
vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId })),
}));

// Pass-through spy, so a test can make the authorization step throw something unexpected.
vi.mock("./auth/scopes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth/scopes.js")>();
  return { ...actual, authorizeToolCall: vi.fn(actual.authorizeToolCall) };
});
const { authorizeToolCall } = await import("./auth/scopes.js");

const SECRET_ARG = "0x" + "ab".repeat(32);

function auth(scopes: string[]): AuthContext {
  return {
    subject: "demo-user",
    clientId: DEMO_CLIENT_ID,
    scopes,
    expiresAtMs: Date.now() + 60_000,
    tokenFingerprint: "deadbeefcafe",
    tokenId: "11111111-2222-3333-4444-555555555555",
  };
}

async function connect(
  ctx: AuthContext | null | (() => AuthContext | null),
  requireAuth = true
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const getAuthContext = typeof ctx === "function" ? ctx : () => ctx;
  const server = createKaiaMcpServer({ requireAuth, getAuthContext });
  await server.connect(serverTransport);
  const client = new Client({ name: "tool-log", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("Tool call audit log", () => {
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;
  const toolCallLines = () =>
    chunks
      .join("")
      .split("\n")
      .filter((l) => l.includes("msg=Tool call"));

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    delete process.env.KAIA_ALLOW_UNSAFE_WALLET;
    resetConfigCache();
    chunks.length = 0;
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = orig;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("logs one allowed line after the scope check passes", async () => {
    const client = await connect(auth([SCOPES.READ]));
    await client.callTool({
      name: "get_chain_info",
      arguments: { network: "mainnet", note: SECRET_ARG },
    });
    const lines = toolCallLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("msg=Tool call tool=get_chain_info outcome=allowed ");
    expect(lines[0]).toContain("tokenFingerprint=deadbeefcafe");
    expect(lines[0]).not.toMatch(/errorCode=|code=/);
    expect(chunks.join("")).not.toContain(SECRET_ARG);
  });

  it("logs one denied line with -32042 when the scope is missing, and no arguments", async () => {
    const client = await connect(auth([SCOPES.READ]));
    await expect(
      client.callTool({
        name: "encode_function_data",
        arguments: { abi: "[]", functionName: "x", args: [SECRET_ARG] },
      })
    ).rejects.toMatchObject({ code: -32042 });
    const lines = toolCallLines();
    expect(lines).toHaveLength(1);
    // Same stable prefix as an allowed call, so gateways counting lines still see it.
    expect(lines[0]).toContain("msg=Tool call tool=encode_function_data outcome=denied ");
    expect(lines[0]).toContain("errorCode=-32042");
    expect(lines[0]).toContain("reason=insufficient_scope");
    expect(chunks.join("")).not.toContain(SECRET_ARG);
  });

  it("logs denied with -32040 for a missing token and -32044 for generate_wallet", async () => {
    const anon = await connect(null);
    await expect(anon.callTool({ name: "get_chain_info", arguments: {} })).rejects.toMatchObject({
      code: -32040,
    });
    const wallet = await connect(auth([SCOPES.WALLET]));
    await expect(wallet.callTool({ name: "generate_wallet", arguments: {} })).rejects.toMatchObject(
      { code: -32044 }
    );
    const lines = toolCallLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("msg=Tool call tool=get_chain_info outcome=denied ");
    expect(lines[0]).toContain("errorCode=-32040");
    expect(lines[0]).not.toContain("tokenFingerprint=");
    expect(lines[1]).toContain("msg=Tool call tool=generate_wallet outcome=denied ");
    expect(lines[1]).toContain("errorCode=-32044");
    expect(chunks.join("")).not.toContain("Private key");
  });

  it("denies a tool that is not in the scope map: one denied line, reason=unknown_tool, never allowed", async () => {
    for (const requireAuth of [true, false]) {
      chunks.length = 0;
      const client = await connect(auth([SCOPES.READ, SCOPES.ENCODE, SCOPES.WALLET]), requireAuth);
      await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toMatchObject({
        code: -32602,
      });
      const lines = toolCallLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("msg=Tool call tool=no_such_tool outcome=denied ");
      expect(lines[0]).toContain("reason=unknown_tool");
      expect(chunks.join("")).not.toContain("outcome=allowed");
    }
  });

  it("escapes the tool name so a crafted name cannot forge an allowed audit line", async () => {
    const forged =
      "get_chain_info outcome=allowed\ntimestamp=2026-10-08T00:00:00.000Z level=info msg=Tool call tool=get_chain_info outcome=allowed tokenFingerprint=deadbeefcafe\r";
    const client = await connect(auth([SCOPES.READ]));
    await expect(client.callTool({ name: forged, arguments: {} })).rejects.toThrow();
    const out = chunks.join("");
    const lines = toolCallLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("outcome=denied");
    expect(lines[0]).toContain("reason=unknown_tool");
    expect(out).not.toContain("outcome=allowed");
    expect(out).not.toMatch(/msg=Tool call tool=get_chain_info /);
    // No raw control characters anywhere in what was logged for this call.
    // eslint-disable-next-line no-control-regex -- asserts no control characters were logged
    expect(out.replace(/\n$/, "").split("\n").join("")).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("strips control characters from a tool name in the log", async () => {
    const client = await connect(auth([SCOPES.READ]));
    await expect(
      client.callTool({ name: "evil\u0007\u001b[31m\u0000", arguments: {} })
    ).rejects.toThrow();
    const lines = toolCallLines();
    expect(lines).toHaveLength(1);
    // eslint-disable-next-line no-control-regex -- asserts no control characters were logged
    expect(lines[0]).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("an unexpected (non-AuthError) failure during authorization logs one denied line and fails closed", async () => {
    vi.mocked(authorizeToolCall).mockImplementationOnce(() => {
      throw new TypeError("scope map exploded");
    });
    getChainId.mockClear();
    const client = await connect(auth([SCOPES.READ]));
    await expect(client.callTool({ name: "get_chain_info", arguments: {} })).rejects.toMatchObject({
      code: -32603,
      message: "Internal error: authorization failed",
    });
    const lines = toolCallLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("msg=Tool call tool=get_chain_info outcome=denied ");
    expect(lines[0]).toContain("reason=internal_error");
    expect(getChainId).not.toHaveBeenCalled();
    // kaia's own -32603 ProtocolError is a server fault, not a caller mistake: one error line,
    // no "Request denied".
    const out = chunks.join("");
    expect(out).not.toContain("msg=Request denied");
    const errorLines = out.split("\n").filter((l) => l.includes("msg=Tool error"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatch(
      / level=error msg=Tool error code=-32603 method=tools\/call category=internal errorType=ProtocolError detail=Internal%20error:%20authorization%20failed$/
    );
  });

  it("a failing auth-context lookup logs one denied line and fails closed", async () => {
    getChainId.mockClear();
    const client = await connect(() => {
      throw new Error("auth context unavailable");
    });
    await expect(client.callTool({ name: "get_chain_info", arguments: {} })).rejects.toThrow();
    const lines = toolCallLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("msg=Tool call tool=get_chain_info outcome=denied ");
    expect(lines[0]).toContain("reason=internal_error");
    expect(getChainId).not.toHaveBeenCalled();
  });

  it("a bad tool argument logs Request denied (code, category), never the caller's text", async () => {
    const marker = "CALLER_INPUT_MARKER_fn";
    const client = await connect(auth([SCOPES.ENCODE]));
    await expect(
      client.callTool({
        name: "encode_function_data",
        arguments: {
          abi: JSON.stringify([
            { type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "view" },
          ]),
          functionName: marker,
        },
      })
    ).rejects.toThrow(marker);
    const out = chunks.join("");
    expect(out).not.toContain(marker);
    expect(out).not.toContain("msg=Tool error");
    const denied = out.split("\n").filter((l) => l.includes("msg=Request denied"));
    expect(denied).toHaveLength(1);
    // a caller mistake (function not on the ABI): -32602 at info, not a server fault
    expect(denied[0]).toMatch(/ code=-32602 /);
    expect(denied[0]).toContain(" level=info ");
    expect(denied[0]).toContain("category=invalid_params");
  });

  it("a server fault: the caller gets a generic message, the detail stays in the log (encoded)", async () => {
    const marker = "SERVER_FAULT_MARKER";
    getChainId.mockRejectedValueOnce(new Error(`unexpected ${marker} x=1`));
    const client = await connect(auth([SCOPES.READ]));
    const err = await client.callTool({ name: "get_chain_info", arguments: {} }).then(
      () => undefined,
      (e: { code: number; message: string; data?: unknown }) => e
    );
    expect(err).toMatchObject({ code: -32603, message: "Internal error" });
    expect(JSON.stringify(err)).not.toContain(marker);
    const out = chunks.join("");
    const errorLines = out.split("\n").filter((l) => l.includes("msg=Tool error"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatch(
      / level=error msg=Tool error code=-32603 method=tools\/call category=internal errorType=Error detail=unexpected%20SERVER_FAULT_MARKER%20x%3D1$/
    );
  });

  it("resource and prompt errors do not log the caller's uri or name either", async () => {
    const marker = "CALLER_URI_MARKER";
    const client = await connect(auth([SCOPES.READ]));
    await expect(client.readResource({ uri: `kaia://${marker}` })).rejects.toThrow();
    await expect(client.getPrompt({ name: `${marker}_prompt` })).rejects.toThrow();
    const out = chunks.join("");
    expect(out).not.toContain(marker);
    expect(out.split("\n").filter((l) => l.includes("msg=Request denied"))).toHaveLength(2);
  });

  it("unknown tool, resource and prompt names are client mistakes: info, never error, deny audit kept", async () => {
    const client = await connect(auth([SCOPES.READ]));
    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(client.readResource({ uri: "kaia://no-such-resource" })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(client.getPrompt({ name: "no_such_prompt" })).rejects.toMatchObject({
      code: -32602,
    });
    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(
      lines.filter((l) => / level=error /.test(l)),
      lines.join("\n")
    ).toEqual([]);
    expect(lines.filter((l) => l.includes("msg=Tool error"))).toEqual([]);
    // the tools/call deny audit line is unchanged
    expect(toolCallLines()).toHaveLength(1);
    expect(toolCallLines()[0]).toContain(
      " level=info msg=Tool call tool=no_such_tool outcome=denied errorCode=-32602 reason=unknown_tool"
    );
    const denied = lines.filter((l) => l.includes("msg=Request denied"));
    expect(denied).toHaveLength(3);
    for (const [i, method] of ["tools/call", "resources/read", "prompts/get"].entries()) {
      expect(denied[i]).toContain(
        ` level=info msg=Request denied code=-32602 method=${method} category=invalid_params errorType=ProtocolError outcome=denied`
      );
    }
    expect(chunks.join("")).not.toContain("no-such-resource");
    expect(chunks.join("")).not.toContain("no_such_prompt");
  });

  it("an in-band auth denial is a client outcome too (info), while server faults stay at error", async () => {
    const client = await connect(auth([SCOPES.READ]));
    await expect(
      client.callTool({ name: "encode_function_data", arguments: {} })
    ).rejects.toMatchObject({ code: -32042 });
    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines.filter((l) => / level=error /.test(l))).toEqual([]);
    expect(lines.find((l) => l.includes("msg=Request denied"))).toContain(
      " level=info msg=Request denied code=-32042 method=tools/call category=auth "
    );
  });
});

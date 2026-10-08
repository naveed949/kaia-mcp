/**
 * The per-call "Tool call" audit line is written once, after the authorization
 * decision, and carries the outcome. It never carries arguments or token material.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { DEMO_CLIENT_ID, SCOPES } from "./auth/constants.js";
import type { AuthContext } from "./auth/types.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

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

async function connect(ctx: AuthContext | null): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createKaiaMcpServer({ requireAuth: true, getAuthContext: () => ctx });
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
});

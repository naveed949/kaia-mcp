import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";

describe("createKaiaMcpServer", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfigCache();
    const keys = [
      "KAIA_RPC_URL",
      "KAIA_KAIROS_RPC_URL",
      "KAIASCAN_API_KEY",
      "KAIA_DEFAULT_NETWORK",
      "LOG_LEVEL",
      "RATE_LIMIT_RPC",
      "RATE_LIMIT_KAIASCAN",
    ];
    for (const k of keys) {
      envBackup[k] = process.env[k];
    }
    // Minimal env so getConfig() works when logger runs
    process.env.LOG_LEVEL = "error";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("lists at least one tool (get_kaia_balance)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBeGreaterThanOrEqual(1);
    const getBalance = result.tools.find((t) => t.name === "get_kaia_balance");
    expect(getBalance).toBeDefined();
    expect(getBalance?.description).toBeDefined();
    expect(getBalance?.inputSchema?.properties?.address).toBeDefined();
    expect(getBalance?.inputSchema?.properties?.network).toBeDefined();
  });

  it("calling get_kaia_balance returns stub content", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_kaia_balance",
      arguments: { address: "0x1234567890123456789012345678901234567890", network: "mainnet" },
    });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    const textBlock = result.content.find((c) => c.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock?.type).toBe("text");
    expect((textBlock as { text: string }).text).toContain("Balance: 0 (stub)");
    expect((textBlock as { text: string }).text).toContain("mainnet");
  });
});

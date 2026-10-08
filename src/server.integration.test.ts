/**
 * Integration test: full MCP lifecycle over stdio (Phase 11).
 * Run with: RUN_INTEGRATION=1 npm run test:integration
 * Default npm test skips this (RUN_INTEGRATION not set).
 *
 * Optional live test: LIVE_TESTS=1 to run one real RPC and one real KaiaScan call (skipped by default).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createRpcClient } from "./clients/rpc.js";
import { createKaiaScanClient } from "./clients/kaiascan.js";
import { resetConfigCache } from "./config.js";

/**
 * Client.callTool() is typed as a union with the legacy `toolResult` shape, so
 * `content` is not statically known. Parse with the SDK's own schema to get a
 * typed CallToolResult (and assert the wire shape at runtime).
 */
async function callToolResult(
  c: Client,
  params: Parameters<Client["callTool"]>[0]
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await c.callTool(params));
}

const runIntegration = process.env.RUN_INTEGRATION === "1";
const runLiveTests = process.env.LIVE_TESTS === "1";

const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("MCP lifecycle integration", () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  beforeAll(async () => {
    const bin = resolve(process.cwd(), "dist/bin/kaia-mcp.js");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      cwd: process.cwd(),
      env: {
        ...process.env,
        KAIA_RPC_URL: "https://public-en.node.kaia.io",
        KAIA_KAIROS_RPC_URL: "https://public-en-kairos.node.kaia.io",
      },
    });
    client = new Client({ name: "integration-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("initialize returns capabilities", () => {
    const caps = client!.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.tools).toBeDefined();
  });

  it("tools/list returns tools", async () => {
    const result = await client!.listTools();
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThan(20);
    expect(result.tools.some((t) => t.name === "get_block_number")).toBe(true);
  });

  it("tools/call get_block_number returns block number shape", async () => {
    const result = await callToolResult(client!, {
      name: "get_block_number",
      arguments: { network: "mainnet" },
    });
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content!.length).toBeGreaterThan(0);
    expect(result.content![0].type).toBe("text");
  });

  it("resources/list returns resources", async () => {
    const result = await client!.listResources();
    expect(result.resources).toBeDefined();
    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.resources!.length).toBeGreaterThan(0);
  });

  it("prompts/list returns prompts", async () => {
    const result = await client!.listPrompts();
    expect(result.prompts).toBeDefined();
    expect(Array.isArray(result.prompts)).toBe(true);
    expect(result.prompts!.length).toBeGreaterThan(0);
  });
});

const describeLive = runLiveTests ? describe : describe.skip;

describeLive("Live RPC / KaiaScan (optional)", () => {
  beforeAll(() => {
    resetConfigCache();
    process.env.KAIA_RPC_URL = process.env.KAIA_RPC_URL || "https://public-en.node.kaia.io";
    process.env.KAIA_KAIROS_RPC_URL =
      process.env.KAIA_KAIROS_RPC_URL || "https://public-en-kairos.node.kaia.io";
  });

  it("get_block_number returns a positive number", async () => {
    const client = createRpcClient("mainnet");
    const blockNumber = await client.getBlockNumber();
    expect(typeof blockNumber).toBe("bigint");
    expect(blockNumber).toBeGreaterThan(0n);
  });

  it("get_kaia_price returns price info", async () => {
    const client = createKaiaScanClient();
    const data = await client.get<Record<string, unknown>>("api/v1/kaia");
    expect(data).toBeDefined();
    expect(typeof data === "object").toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKaiaMcpServer } from "./server.js";
import { resetConfigCache } from "./config.js";
import { createRpcClient } from "./clients/rpc.js";
import { createKaiaScanClient } from "./clients/kaiascan.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
    request: vi.fn().mockResolvedValue({
      accType: 1,
      balance: "1000000000000000000",
      nonce: "0",
      keyType: 0,
    }),
    getBlockNumber: vi.fn().mockResolvedValue(12345678n),
    getTransaction: vi.fn().mockResolvedValue({
      hash: "0x" + "a".repeat(64),
      from: "0x1234567890123456789012345678901234567890",
      to: "0x0000000000000000000000000000000000000001",
      value: 1000000000000000000n,
      blockNumber: 12345n,
      gas: 21000n,
      gasPrice: 25000000000n,
      input: "0x",
    }),
    getTransactionReceipt: vi.fn().mockResolvedValue({
      transactionHash: "0x" + "a".repeat(64),
      status: "success",
      blockNumber: 12345n,
      gasUsed: 21000n,
      contractAddress: null,
      logs: [],
    }),
    getBlock: vi.fn().mockResolvedValue({
      number: 12345n,
      hash: "0x" + "b".repeat(64),
      parentHash: "0x" + "c".repeat(64),
      timestamp: 1704067200n,
      miner: "0xminer0000000000000000000000000000000000",
      gasUsed: 1000000n,
      gasLimit: 30000000n,
      transactions: [],
    }),
    estimateGas: vi.fn().mockResolvedValue(21000n),
    getGasPrice: vi.fn().mockResolvedValue(25000000000n),
  })),
}));

vi.mock("./clients/kaiascan.js", () => ({
  createKaiaScanClient: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
  })),
}));

describe("createKaiaMcpServer", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
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
    process.env.LOG_LEVEL = "error";
    vi.mocked(createRpcClient).mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
      request: vi.fn().mockResolvedValue({
        accType: 1,
        balance: "1000000000000000000",
        nonce: "0",
        keyType: 0,
      }),
      getBlockNumber: vi.fn().mockResolvedValue(12345678n),
      getTransaction: vi.fn().mockResolvedValue({
        hash: "0x" + "a".repeat(64),
        from: "0x1234567890123456789012345678901234567890",
        to: "0x0000000000000000000000000000000000000001",
        value: 1000000000000000000n,
        blockNumber: 12345n,
        gas: 21000n,
        gasPrice: 25000000000n,
        input: "0x",
      }),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        transactionHash: "0x" + "a".repeat(64),
        status: "success",
        blockNumber: 12345n,
        gasUsed: 21000n,
        contractAddress: null,
        logs: [],
      }),
      getBlock: vi.fn().mockResolvedValue({
        number: 12345n,
        hash: "0x" + "b".repeat(64),
        parentHash: "0x" + "c".repeat(64),
        timestamp: 1704067200n,
        miner: "0xminer0000000000000000000000000000000000",
        gasUsed: 1000000n,
        gasLimit: 30000000n,
        transactions: [],
      }),
      estimateGas: vi.fn().mockResolvedValue(21000n),
      getGasPrice: vi.fn().mockResolvedValue(25000000000n),
    } as unknown as ReturnType<typeof createRpcClient>);
    vi.mocked(createKaiaScanClient).mockReturnValue({
      get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("lists all account, transaction, and block tools (11 total)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBe(11);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "estimate_gas",
      "get_account_info",
      "get_account_nfts",
      "get_account_tokens",
      "get_account_transactions",
      "get_block",
      "get_block_number",
      "get_block_rewards",
      "get_kaia_balance",
      "get_transaction",
      "get_transaction_receipt",
    ]);
    const getBalance = result.tools.find((t) => t.name === "get_kaia_balance");
    expect(getBalance?.description).toBeDefined();
    expect(getBalance?.inputSchema?.properties?.address).toBeDefined();
    expect(getBalance?.inputSchema?.properties?.network).toBeDefined();
  });

  it("calling get_kaia_balance returns formatted balance (KAIA and peb)", async () => {
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
    const text = (textBlock as { text: string }).text;
    expect(text).toContain("KAIA");
    expect(text).toContain("peb");
    expect(text).toContain("mainnet");
  });

  it("calling get_kaia_balance with invalid address throws MCP error (toMcpError)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    await expect(
      client.callTool({
        name: "get_kaia_balance",
        arguments: { address: "not-an-address", network: "mainnet" },
      })
    ).rejects.toThrow(/Invalid address/);
  });

  it("calling get_block_number returns current block number", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_block_number",
      arguments: { network: "mainnet" },
    });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toContain("12345678");
    expect(text).toContain("mainnet");
  });

  it("calling get_transaction_receipt returns receipt summary", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_transaction_receipt",
      arguments: { txHash: "0x" + "a".repeat(64), network: "mainnet" },
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toContain("Success");
    expect(text).toContain("12345");
    expect(text).toContain("21000");
  });
});

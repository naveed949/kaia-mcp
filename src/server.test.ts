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
    getChainId: vi.fn().mockResolvedValue(8217),
    readContract: vi.fn().mockResolvedValue(0n),
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
      getChainId: vi.fn().mockResolvedValue(8217),
      readContract: vi.fn().mockResolvedValue(0n),
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

  it("lists all account, transaction, block, token, NFT, contract, network, and wallet tools (26 total)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBe(26);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "encode_function_data",
      "estimate_gas",
      "generate_wallet",
      "get_account_info",
      "get_account_nfts",
      "get_account_tokens",
      "get_account_transactions",
      "get_block",
      "get_block_number",
      "get_block_rewards",
      "get_chain_info",
      "get_contract_abi",
      "get_contract_source",
      "get_gas_price",
      "get_kaia_balance",
      "get_kaia_price",
      "get_nft_info",
      "get_nft_item",
      "get_nft_transfers",
      "get_token_allowance",
      "get_token_holders",
      "get_token_info",
      "get_token_transfers",
      "get_transaction",
      "get_transaction_receipt",
      "read_contract",
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

  it("calling get_token_info returns token metadata (mocked KaiaScan)", async () => {
    vi.mocked(createKaiaScanClient).mockReturnValue({
      get: vi.fn().mockResolvedValue({
        name: "Test Token",
        symbol: "TST",
        decimal: 18,
        total_supply: 1000000,
        contract_type: "KIP7",
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_token_info",
      arguments: {
        contractAddress: "0x1234567890123456789012345678901234567890",
        network: "mainnet",
      },
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toContain("Test Token");
    expect(text).toContain("TST");
    expect(text).toContain("18");
    expect(text).toContain("1000000");
  });

  it("calling get_nft_info returns NFT collection metadata (mocked KaiaScan)", async () => {
    vi.mocked(createKaiaScanClient).mockReturnValue({
      get: vi.fn().mockResolvedValue({
        name: "Cool NFT",
        symbol: "CNFT",
        total_supply: 5000,
        contract_type: "KIP17",
        holder_count: 100,
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_nft_info",
      arguments: {
        contractAddress: "0x1234567890123456789012345678901234567890",
        network: "mainnet",
      },
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toContain("Cool NFT");
    expect(text).toContain("CNFT");
    expect(text).toContain("5000");
    expect(text).toContain("100");
  });

  it("calling get_gas_price returns peb and Gpeb (mocked RPC)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_gas_price",
      arguments: { network: "mainnet" },
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toContain("25000000000");
    expect(text).toContain("peb");
    expect(text).toContain("KAIA");
  });

  it("calling get_kaia_price returns USD and stats (mocked KaiaScan)", async () => {
    vi.mocked(createKaiaScanClient).mockReturnValue({
      get: vi.fn().mockResolvedValue({
        klay_price: {
          usd_price: 0.13,
          btc_price: 0.00000137,
          usd_price_changes: 2.5,
          market_cap: 500_000_000,
          total_supply: 10_000_000_000,
          volume: 1_000_000,
        },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_kaia_price",
      arguments: { network: "mainnet" },
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toContain("0.13");
    expect(text).toContain("USD price");
  });

  it("calling generate_wallet returns address and privateKey hex", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "generate_wallet",
      arguments: {},
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toMatch(/Address: 0x[a-fA-F0-9]{40}/);
    expect(text).toMatch(/Private key \(hex\): 0x[a-fA-F0-9]{64}/);
  });

  it("listResources returns 5 resources with expected URIs (Phase 8)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listResources();
    expect(result.resources).toBeDefined();
    expect(result.resources.length).toBe(5);
    const uris = result.resources.map((r) => r.uri).sort();
    expect(uris).toEqual([
      "kaia://docs/rpc-methods",
      "kaia://kairos/status",
      "kaia://mainnet/status",
      "kaia://mainnet/tokens/popular",
      "kaia://mainnet/top-accounts",
    ]);
  });

  it("readResource(kaia://docs/rpc-methods) returns RPC docs content", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.readResource({ uri: "kaia://docs/rpc-methods" });
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBeGreaterThanOrEqual(1);
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toMatch(/kaia_|eth_|getBalance/);
  });

  it("listPrompts returns 6 prompts (Phase 9)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listPrompts();
    expect(result.prompts).toBeDefined();
    expect(result.prompts.length).toBe(6);
    const names = result.prompts.map((p) => p.name).sort();
    expect(names).toEqual([
      "analyze-wallet",
      "gas-report",
      "investigate-transaction",
      "nft-lookup",
      "smart-contract-audit",
      "token-research",
    ]);
  });

  it("getPrompt(analyze-wallet) returns messages with templated text", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.getPrompt({
      name: "analyze-wallet",
      arguments: { address: "0xabc", network: "kairos" },
    });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
    const text = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("0xabc");
    expect(text).toContain("kairos");
  });

  it("calling encode_function_data returns hex calldata", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createKaiaMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const abi = JSON.stringify([
      {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
      },
    ]);

    const result = await client.callTool({
      name: "encode_function_data",
      arguments: {
        abi,
        functionName: "balanceOf",
        args: ["0x1234567890123456789012345678901234567890"],
      },
    });
    expect(result.content).toBeDefined();
    const textBlock = result.content?.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    const text = (textBlock as { text: string })?.text;
    expect(text).toMatch(/^0x[a-fA-F0-9]+$/);
  });
});

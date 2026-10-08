import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleGetTransaction,
  handleGetTransactionReceipt,
  handleGetAccountTransactions,
  handleEstimateGas,
} from "./transaction.js";
import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { resetConfigCache } from "../config.js";

vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(),
}));

vi.mock("../clients/kaiascan.js", () => ({
  createKaiaScanClient: vi.fn(),
}));

const mockCreateRpcClient = vi.mocked(createRpcClient);
const mockCreateKaiaScanClient = vi.mocked(createKaiaScanClient);

const validTxHash = "0x" + "a".repeat(64);
const validAddress = "0x1234567890123456789012345678901234567890";

describe("handleGetTransaction", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getTransaction: vi.fn().mockResolvedValue({
        hash: validTxHash,
        from: validAddress,
        to: "0xabcdef1234567890abcdef1234567890abcdef12",
        value: 1000000000000000000n,
        blockNumber: 12345n,
        gas: 21000n,
        gasPrice: 25000000000n,
        input: "0x",
      }),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns human-readable transaction summary for valid txHash", async () => {
    const result = await handleGetTransaction({
      txHash: validTxHash,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(validTxHash);
    expect(text).toContain(validAddress);
    expect(text).toContain("KAIA");
    expect(text).toContain("12345");
    expect(text).toContain("mainnet");
  });

  it("throws clear error for invalid txHash", async () => {
    await expect(
      handleGetTransaction({ txHash: "not-a-hash", network: "mainnet" })
    ).rejects.toThrow(/Invalid transaction hash/);

    await expect(handleGetTransaction({ txHash: "0xshort", network: "mainnet" })).rejects.toThrow(
      /Invalid transaction hash/
    );
  });

  it("returns not found when getTransaction returns null", async () => {
    mockCreateRpcClient.mockReturnValue({
      getTransaction: vi.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof createRpcClient>);

    const result = await handleGetTransaction({ txHash: validTxHash, network: "mainnet" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });
});

describe("handleGetTransactionReceipt", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getTransactionReceipt: vi.fn().mockResolvedValue({
        transactionHash: validTxHash,
        status: "success",
        blockNumber: 12345n,
        gasUsed: 21000n,
        contractAddress: null,
        logs: [],
      }),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns receipt summary with status, blockNumber, gasUsed", async () => {
    const result = await handleGetTransactionReceipt({
      txHash: validTxHash,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Success");
    expect(text).toContain("12345");
    expect(text).toContain("21000");
    expect(text).toContain("mainnet");
  });

  it("throws for invalid txHash", async () => {
    await expect(handleGetTransactionReceipt({ txHash: "0x", network: "mainnet" })).rejects.toThrow(
      /Invalid transaction hash/
    );
  });
});

describe("handleGetAccountTransactions", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        results: [
          {
            transaction_hash: validTxHash,
            from: validAddress,
            to: "0xrecipient00000000000000000000000000000000",
            amount: 1.5,
            datetime: "2025-01-01T00:00:00Z",
            status: { status: "Success" },
          },
        ],
        paging: { total_count: 1, current_page: 1, last: true, total_page: 1 },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns list of tx hash, from, to, value, time, status from KaiaScan", async () => {
    const result = await handleGetAccountTransactions({
      address: validAddress,
      network: "mainnet",
      page: 1,
      limit: 20,
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(validTxHash);
    expect(text).toContain(validAddress);
    expect(text).toContain("Success");
    expect(text).toContain("1.5");
  });

  it("calls KaiaScan with path api/v1/accounts/:address/transactions", async () => {
    const mockGet = vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } });
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<
      typeof createKaiaScanClient
    >);

    await handleGetAccountTransactions({
      address: validAddress,
      network: "mainnet",
      page: 1,
      limit: 10,
    });
    expect(mockGet).toHaveBeenCalledWith(
      `api/v1/accounts/${validAddress}/transactions`,
      expect.objectContaining({ page: "1", size: "10" })
    );
  });

  it("throws on invalid address", async () => {
    await expect(handleGetAccountTransactions({ address: "invalid" })).rejects.toThrow(
      /Invalid address/
    );
  });
});

describe("handleEstimateGas", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      estimateGas: vi.fn().mockResolvedValue(21000n),
      getGasPrice: vi.fn().mockResolvedValue(25000000000n),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns estimated gas and cost in KAIA", async () => {
    const result = await handleEstimateGas({
      from: validAddress,
      to: "0x0000000000000000000000000000000000000001",
      value: "1000000000000000000",
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("21000");
    expect(text).toContain("KAIA");
    expect(text).toContain("mainnet");
  });

  it("throws for invalid from address", async () => {
    await expect(handleEstimateGas({ from: "bad", network: "mainnet" })).rejects.toThrow(
      /Invalid address/
    );
  });
});

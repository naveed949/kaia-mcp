import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleGetTokenInfo,
  handleGetTokenHolders,
  handleGetTokenTransfers,
  handleGetTokenAllowance,
} from "./token.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { createRpcClient } from "../clients/rpc.js";
import { readContract } from "viem";
import { resetConfigCache } from "../config.js";

vi.mock("../clients/kaiascan.js", () => ({
  createKaiaScanClient: vi.fn(),
}));

vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const v = (await importOriginal()) as typeof import("viem");
  return { ...v, readContract: vi.fn() };
});

const mockCreateKaiaScanClient = vi.mocked(createKaiaScanClient);
const mockCreateRpcClient = vi.mocked(createRpcClient);
const mockReadContract = vi.mocked(readContract);

const validContractAddress = "0x1234567890123456789012345678901234567890";

describe("handleGetTokenInfo", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        name: "Test Token",
        symbol: "TST",
        decimal: 18,
        total_supply: 1000000,
        contract_type: "KIP7",
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns token metadata for valid contract address", async () => {
    const result = await handleGetTokenInfo({
      contractAddress: validContractAddress,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Test Token");
    expect(text).toContain("TST");
    expect(text).toContain("18");
    expect(text).toContain("1000000");
    expect(text).toContain("KIP7");
  });

  it("calls KaiaScan with path api/v1/tokens/:contractAddress", async () => {
    const mockGet = vi.fn().mockResolvedValue({ name: "T", symbol: "T", decimal: 18, total_supply: 0 });
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<typeof createKaiaScanClient>);

    await handleGetTokenInfo({ contractAddress: validContractAddress, network: "mainnet" });
    expect(mockGet).toHaveBeenCalledWith(`api/v1/tokens/${validContractAddress}`);
  });

  it("throws for invalid contract address", async () => {
    await expect(
      handleGetTokenInfo({ contractAddress: "not-an-address", network: "mainnet" })
    ).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetTokenHolders", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        results: [
          {
            holder: {
              address: "0xholder1111111111111111111111111111111111",
              amount: 50000,
              percentage: 5,
            },
          },
        ],
        paging: { total_count: 1, current_page: 1, last: true, total_page: 1 },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns list of holders with address and formatted balance", async () => {
    const result = await handleGetTokenHolders({
      contractAddress: validContractAddress,
      network: "mainnet",
      page: 1,
      size: 20,
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0xholder1111111111111111111111111111111111");
    expect(text).toContain("50000");
    expect(text).toContain("5%");
  });

  it("returns message when no holders", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const result = await handleGetTokenHolders({
      contractAddress: validContractAddress,
      network: "mainnet",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No holders found");
  });

  it("throws on invalid contract address", async () => {
    await expect(
      handleGetTokenHolders({ contractAddress: "0xshort" })
    ).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetTokenTransfers", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        results: [
          {
            from: "0xfrom000000000000000000000000000000000000",
            to: "0xto0000000000000000000000000000000000000",
            amount: 100,
            transaction_hash: "0x" + "f".repeat(64),
            datetime: "2024-01-15T12:00:00Z",
          },
        ],
        paging: { total_count: 1, current_page: 1, last: true, total_page: 1 },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns list of transfers with from, to, value, txHash, time", async () => {
    const result = await handleGetTokenTransfers({
      contractAddress: validContractAddress,
      network: "mainnet",
      page: 1,
      size: 20,
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0xfrom000000000000000000000000000000000000");
    expect(text).toContain("0xto0000000000000000000000000000000000000");
    expect(text).toContain("100");
    expect(text).toContain("0x" + "f".repeat(64));
    expect(text).toContain("2024-01-15");
  });

  it("returns message when no transfers", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const result = await handleGetTokenTransfers({
      contractAddress: validContractAddress,
      network: "mainnet",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No transfers found");
  });

  it("throws on invalid contract address", async () => {
    await expect(
      handleGetTokenTransfers({ contractAddress: "invalid" })
    ).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetTokenAllowance", () => {
  const tokenAddress = "0x1234567890123456789012345678901234567890";
  const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const spender = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({} as unknown as ReturnType<typeof createRpcClient>);
    mockReadContract.mockResolvedValue(1000000000000000000n);
  });

  it("returns allowance raw and human-readable for valid args", async () => {
    const result = await handleGetTokenAllowance({
      tokenAddress,
      owner,
      spender,
      network: "mainnet",
      decimals: 18,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Token:");
    expect(text).toContain("Owner:");
    expect(text).toContain("Spender:");
    expect(text).toContain("Allowance (raw): 1000000000000000000");
    expect(text).toContain("Allowance (18 decimals): 1");
    expect(mockCreateRpcClient).toHaveBeenCalledWith("mainnet");
    expect(mockReadContract).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        address: tokenAddress,
        functionName: "allowance",
      })
    );
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    const callArgs = mockReadContract.mock.calls[0]?.[1];
    expect(callArgs).toBeDefined();
    expect(Array.isArray((callArgs as { args?: unknown[] }).args)).toBe(true);
    expect((callArgs as { args: unknown[] }).args).toHaveLength(2);
  });

  it("defaults network to mainnet and decimals to 18", async () => {
    const result = await handleGetTokenAllowance({ tokenAddress, owner, spender });
    expect(mockCreateRpcClient).toHaveBeenCalledWith("mainnet");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Allowance (18 decimals)");
  });

  it("throws for invalid token address", async () => {
    await expect(
      handleGetTokenAllowance({
        tokenAddress: "not-an-address",
        owner,
        spender,
      })
    ).rejects.toThrow(/Invalid address/);
  });

  it("throws for invalid owner", async () => {
    await expect(
      handleGetTokenAllowance({
        tokenAddress,
        owner: "0xbad",
        spender,
      })
    ).rejects.toThrow(/Invalid address/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleGetBlockNumber,
  handleGetBlock,
  handleGetBlockRewards,
} from "./block.js";
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

const validBlockHash = "0x" + "b".repeat(64);

describe("handleGetBlockNumber", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(12345678n),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns current block number for network", async () => {
    const result = await handleGetBlockNumber({ network: "mainnet" });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("12345678");
    expect(text).toContain("mainnet");
  });

  it("uses kairos when network is kairos", async () => {
    await handleGetBlockNumber({ network: "kairos" });
    expect(mockCreateRpcClient).toHaveBeenCalledWith("kairos");
  });
});

describe("handleGetBlock", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getBlock: vi.fn().mockResolvedValue({
        number: 12345n,
        hash: validBlockHash,
        parentHash: "0x" + "c".repeat(64),
        timestamp: 1704067200n,
        miner: "0xminer0000000000000000000000000000000000",
        gasUsed: 1000000n,
        gasLimit: 30000000n,
        transactions: ["0x" + "d".repeat(64)],
      }),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns block summary by block number", async () => {
    const result = await handleGetBlock({
      blockNumberOrHash: 12345,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("12345");
    expect(text).toContain(validBlockHash);
    expect(text).toContain("Miner");
    expect(text).toContain("Transactions: 1");
    expect(text).toContain("mainnet");
  });

  it("returns block summary by block hash", async () => {
    const result = await handleGetBlock({
      blockNumberOrHash: validBlockHash,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("12345");
    expect(text).toContain(validBlockHash);
  });

  it("throws clear error for invalid block number or hash", async () => {
    await expect(
      handleGetBlock({ blockNumberOrHash: "not-valid", network: "mainnet" })
    ).rejects.toThrow(/Invalid block number or hash/);

    await expect(
      handleGetBlock({ blockNumberOrHash: -1, network: "mainnet" })
    ).rejects.toThrow(/Invalid block number/);
  });

  it("returns not found when getBlock returns null", async () => {
    mockCreateRpcClient.mockReturnValue({
      getBlock: vi.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof createRpcClient>);

    const result = await handleGetBlock({ blockNumberOrHash: 99999999, network: "mainnet" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });
});

describe("handleGetBlockRewards", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn()
        .mockResolvedValueOnce({ minted: 9.6, total_fee: 0.5, burnt_fee: 0.25 })
        .mockResolvedValueOnce({
          nearest_block_number: 12345,
          accumulate_burnt_fees: 100,
          accumulate_burnt_kaia: 50,
          kip103_burnt: 0,
          kip160_burnt: 0,
          accumulate_burnt: 150,
        }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns rewards and burns summary from KaiaScan", async () => {
    const result = await handleGetBlockRewards({
      blockNumber: 12345,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("12345");
    expect(text).toContain("9.6");
    expect(text).toContain("Rewards");
    expect(text).toContain("Burns");
  });

  it("calls KaiaScan blocks/:blockNumber/rewards and blocks/:blockNumber/burns", async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({ minted: 1, total_fee: 0, burnt_fee: 0 })
      .mockResolvedValueOnce({});
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<typeof createKaiaScanClient>);

    await handleGetBlockRewards({ blockNumber: 100, network: "mainnet" });
    expect(mockGet).toHaveBeenNthCalledWith(1, "api/v1/blocks/100/rewards");
    expect(mockGet).toHaveBeenNthCalledWith(2, "api/v1/blocks/100/burns");
  });

  it("throws for invalid block number", async () => {
    await expect(
      handleGetBlockRewards({ blockNumber: -1, network: "mainnet" })
    ).rejects.toThrow(/Invalid block number/);
  });

  it("throws when block hash is passed instead of number", async () => {
    await expect(
      handleGetBlockRewards({
        blockNumber: "0x" + "e".repeat(64),
        network: "mainnet",
      })
    ).rejects.toThrow(/block hash not allowed/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleGetGasPrice,
  handleGetKaiaPrice,
  handleGetChainInfo,
} from "./network.js";
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

describe("handleGetGasPrice", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getGasPrice: vi.fn().mockResolvedValue(25000000000n),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns gas price in peb and Gpeb and KAIA", async () => {
    const result = await handleGetGasPrice({ network: "mainnet" });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("25000000000");
    expect(text).toContain("peb");
    expect(text).toContain("Gpeb");
    expect(text).toContain("KAIA");
    expect(text).toContain("mainnet");
  });

  it("uses kairos when network is kairos", async () => {
    await handleGetGasPrice({ network: "kairos" });
    expect(mockCreateRpcClient).toHaveBeenCalledWith("kairos");
  });
});

describe("handleGetKaiaPrice", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
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
  });

  it("returns USD price and other fields from KaiaScan", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      klay_price: {
        usd_price: 0.13,
        btc_price: 0.00000137,
        usd_price_changes: 2.5,
        market_cap: 500_000_000,
        total_supply: 10_000_000_000,
        volume: 1_000_000,
      },
    });
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<typeof createKaiaScanClient>);
    const result = await handleGetKaiaPrice({ network: "mainnet" });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0.13");
    expect(text).toContain("USD price");
    expect(text).toContain("24h change");
    expect(text).toContain("Market cap");
    expect(mockGet).toHaveBeenCalledWith("api/v1/kaia");
  });
});

describe("handleGetChainInfo", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getChainId: vi.fn().mockResolvedValue(8217),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns chainId and name for mainnet", async () => {
    const result = await handleGetChainInfo({ network: "mainnet" });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("8217");
    expect(text).toContain("Kaia");
    expect(text).toContain("mainnet");
  });

  it("uses kairos and returns chainId 1001", async () => {
    mockCreateRpcClient.mockReturnValue({
      getChainId: vi.fn().mockResolvedValue(1001),
    } as unknown as ReturnType<typeof createRpcClient>);
    const result = await handleGetChainInfo({ network: "kairos" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1001");
    expect(text).toContain("kairos");
  });
});

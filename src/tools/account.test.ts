import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleGetKaiaBalance,
  handleGetAccountInfo,
  handleGetAccountTokens,
  handleGetAccountNfts,
} from "./account.js";
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

const validAddress = "0x1234567890123456789012345678901234567890";

describe("handleGetKaiaBalance", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns formatted KAIA and peb for valid address", async () => {
    const result = await handleGetKaiaBalance({
      address: validAddress,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1");
    expect(text).toContain("KAIA");
    expect(text).toContain("1000000000000000000");
    expect(text).toContain("peb");
    expect(text).toContain("mainnet");
  });

  it("uses kairos when network is kairos", async () => {
    await handleGetKaiaBalance({ address: validAddress, network: "kairos" });
    expect(mockCreateRpcClient).toHaveBeenCalledWith("kairos");
  });

  it("throws clear error for invalid address", async () => {
    await expect(
      handleGetKaiaBalance({ address: "not-an-address", network: "mainnet" })
    ).rejects.toThrow(/Invalid address/);

    await expect(handleGetKaiaBalance({ address: "0xshort", network: "mainnet" })).rejects.toThrow(
      /Invalid address/
    );
  });
});

describe("handleGetAccountInfo", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateRpcClient.mockReturnValue({
      request: vi.fn().mockResolvedValue({
        accType: 1,
        balance: "2000000000000000000",
        nonce: "5",
        keyType: 1,
      }),
    } as unknown as ReturnType<typeof createRpcClient>);
  });

  it("returns human-readable account summary from kaia_getAccount", async () => {
    const result = await handleGetAccountInfo({
      address: validAddress,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("EOA");
    expect(text).toContain("2");
    expect(text).toContain("KAIA");
    expect(text).toContain("Nonce: 5");
    expect(text).toContain("AccountKeyPublic");
  });

  it("throws for invalid address", async () => {
    await expect(handleGetAccountInfo({ address: "0xbad", network: "mainnet" })).rejects.toThrow(
      /Invalid address/
    );
  });
});

describe("handleGetAccountTokens", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        results: [
          {
            contract: { contract_address: "0xabc", contract_type: "ERC20" },
            balance: 100.5,
            token_symbol: "USDT",
            token_name: "Tether",
          },
        ],
        paging: { total_count: 1, current_page: 1, last: true, total_page: 1 },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns list of token symbol, contract, balance", async () => {
    const result = await handleGetAccountTokens({
      address: validAddress,
      network: "mainnet",
      page: 1,
      size: 100,
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("USDT");
    expect(text).toContain("100.5");
    expect(text).toContain("0xabc");
  });

  it("returns message when no tokens", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const result = await handleGetAccountTokens({
      address: validAddress,
      network: "mainnet",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No fungible token balances found");
  });

  it("throws on invalid address", async () => {
    await expect(handleGetAccountTokens({ address: "invalid" })).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetAccountNfts", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        results: [
          {
            nft: {
              symbol: "NFT1",
              name: "Collection One",
              contract_address: "0xnft1",
              nft_type: "KIP17",
              token_count: 3,
            },
          },
        ],
        paging: { total_count: 1, current_page: 1, last: true, total_page: 1 },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns list of NFT collections and count", async () => {
    const result = await handleGetAccountNfts({
      address: validAddress,
      network: "mainnet",
      page: 1,
      size: 20,
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("NFT1");
    expect(text).toContain("Collection One");
    expect(text).toContain("0xnft1");
    expect(text).toContain("KIP17");
    expect(text).toContain("3");
  });

  it("returns message when no NFTs", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const result = await handleGetAccountNfts({ address: validAddress });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No NFT inventories found");
  });

  it("throws on invalid address", async () => {
    await expect(handleGetAccountNfts({ address: "0x" })).rejects.toThrow(/Invalid address/);
  });
});

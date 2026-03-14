import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleGetNftInfo,
  handleGetNftItem,
  handleGetNftTransfers,
} from "./nft.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { resetConfigCache } from "../config.js";

vi.mock("../clients/kaiascan.js", () => ({
  createKaiaScanClient: vi.fn(),
}));

const mockCreateKaiaScanClient = vi.mocked(createKaiaScanClient);

const validContractAddress = "0x1234567890123456789012345678901234567890";

describe("handleGetNftInfo", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        name: "Cool NFT Collection",
        symbol: "CNFT",
        total_supply: 10000,
        contract_type: "KIP17",
        holder_count: 500,
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns NFT collection metadata for valid contract address", async () => {
    const result = await handleGetNftInfo({
      contractAddress: validContractAddress,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Cool NFT Collection");
    expect(text).toContain("CNFT");
    expect(text).toContain("10000");
    expect(text).toContain("500");
    expect(text).toContain("KIP17");
  });

  it("calls KaiaScan with path api/v1/nfts/:contractAddress", async () => {
    const mockGet = vi.fn().mockResolvedValue({ name: "N", symbol: "N", total_supply: 0 });
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<typeof createKaiaScanClient>);

    await handleGetNftInfo({ contractAddress: validContractAddress, network: "mainnet" });
    expect(mockGet).toHaveBeenCalledWith(`api/v1/nfts/${validContractAddress}`);
  });

  it("throws for invalid contract address", async () => {
    await expect(
      handleGetNftInfo({ contractAddress: "not-an-address", network: "mainnet" })
    ).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetNftItem", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        contract_type: "KIP17",
        info: {
          token_id: "42",
          token_uri: "ipfs://QmExample",
          symbol: "CNFT",
          name: "Cool NFT #42",
          contract_address: validContractAddress,
        },
        holder: { address: "0xowner0000000000000000000000000000000000" },
        metadata: {
          name: "Cool NFT #42",
          description: "A cool NFT",
          image: "ipfs://QmImage",
        },
        total_transfer: 3,
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns NFT item with owner, tokenId, tokenURI, and metadata for valid contract and tokenId", async () => {
    const result = await handleGetNftItem({
      contractAddress: validContractAddress,
      tokenId: "42",
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0xowner0000000000000000000000000000000000");
    expect(text).toContain("42");
    expect(text).toContain("ipfs://QmExample");
    expect(text).toContain("Cool NFT #42");
    expect(text).toContain("A cool NFT");
    expect(text).toContain("Metadata");
  });

  it("accepts tokenId as number", async () => {
    const result = await handleGetNftItem({
      contractAddress: validContractAddress,
      tokenId: 42,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("42");
  });

  it("calls KaiaScan with path api/v1/nfts/:contractAddress/tokenids/:tokenId", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      info: { token_id: "42", token_uri: "x", contract_address: validContractAddress },
      holder: { address: "0xowner" },
    });
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<typeof createKaiaScanClient>);

    await handleGetNftItem({
      contractAddress: validContractAddress,
      tokenId: "42",
      network: "mainnet",
    });
    expect(mockGet).toHaveBeenCalledWith(
      `api/v1/nfts/${validContractAddress}/tokenids/42`
    );
  });

  it("throws for invalid contract address", async () => {
    await expect(
      handleGetNftItem({
        contractAddress: "bad",
        tokenId: "1",
        network: "mainnet",
      })
    ).rejects.toThrow(/Invalid address/);
  });

  it("throws when tokenId is missing", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
    await expect(
      handleGetNftItem({
        contractAddress: validContractAddress,
        tokenId: "",
        network: "mainnet",
      })
    ).rejects.toThrow(/tokenId is required/);
  });
});

describe("handleGetNftTransfers", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        results: [
          {
            from: "0xfrom000000000000000000000000000000000000",
            to: "0xto0000000000000000000000000000000000000",
            token_id: "1",
            token_count: 1,
            transaction_hash: "0x" + "e".repeat(64),
            datetime: "2024-02-20T08:00:00Z",
          },
        ],
        paging: { total_count: 1, current_page: 1, last: true, total_page: 1 },
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns list of NFT transfers with from, to, tokenId, txHash, time", async () => {
    const result = await handleGetNftTransfers({
      contractAddress: validContractAddress,
      network: "mainnet",
      page: 1,
      size: 20,
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0xfrom000000000000000000000000000000000000");
    expect(text).toContain("0xto0000000000000000000000000000000000000");
    expect(text).toContain("tokenId 1");
    expect(text).toContain("0x" + "e".repeat(64));
    expect(text).toContain("2024-02-20");
  });

  it("returns message when no transfers", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ results: [], paging: { total_count: 0 } }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);

    const result = await handleGetNftTransfers({
      contractAddress: validContractAddress,
      network: "mainnet",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No NFT transfers found");
  });

  it("throws on invalid contract address", async () => {
    await expect(
      handleGetNftTransfers({ contractAddress: "0x" })
    ).rejects.toThrow(/Invalid address/);
  });
});

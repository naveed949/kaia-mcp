import { describe, it, expect, beforeEach, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { handleReadContract, handleGetContractAbi, handleGetContractSource } from "./contract.js";
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

const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

describe("handleReadContract", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    // read_contract encodes once and sends that calldata with `call` (PR #9 round 5).
    mockCreateRpcClient.mockReturnValue({
      call: vi.fn().mockResolvedValue({ data: `0x${(1000000).toString(16).padStart(64, "0")}` }),
    } as unknown as ReturnType<typeof createRpcClient>);
  });
  const balanceOfData = encodeFunctionData({
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: ["0x00000000000000000000000000000000000000aa"],
  });

  it("returns decoded result for valid ABI and args", async () => {
    const result = await handleReadContract({
      contractAddress: validAddress,
      functionName: "balanceOf",
      abi: JSON.stringify(balanceOfAbi),
      args: ["0x00000000000000000000000000000000000000aa"],
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Result:");
    expect(text).toContain("1000000");
    expect(mockCreateRpcClient).toHaveBeenCalledWith("mainnet");
    const client = mockCreateRpcClient.mock.results[0]?.value as {
      call: ReturnType<typeof vi.fn>;
    };
    expect(client.call).toHaveBeenCalledWith({ to: validAddress, data: balanceOfData });
  });

  it("accepts ABI as array", async () => {
    await handleReadContract({
      contractAddress: validAddress,
      functionName: "balanceOf",
      abi: balanceOfAbi,
      args: ["0x00000000000000000000000000000000000000aa"],
      network: "mainnet",
    });
    const client = mockCreateRpcClient.mock.results[0]?.value as {
      call: ReturnType<typeof vi.fn>;
    };
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: validAddress,
        data: balanceOfData,
      })
    );
  });

  it("throws for invalid ABI", async () => {
    await expect(
      handleReadContract({
        contractAddress: validAddress,
        functionName: "balanceOf",
        abi: "not json",
        network: "mainnet",
      })
    ).rejects.toThrow(/Invalid ABI/);
  });

  it("throws for empty ABI string", async () => {
    await expect(
      handleReadContract({
        contractAddress: validAddress,
        functionName: "balanceOf",
        abi: "   ",
        network: "mainnet",
      })
    ).rejects.toThrow(/Invalid ABI/);
  });

  it("throws for invalid contract address", async () => {
    await expect(
      handleReadContract({
        contractAddress: "not-an-address",
        functionName: "balanceOf",
        abi: balanceOfAbi,
        network: "mainnet",
      })
    ).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetContractAbi", () => {
  it("returns ABI from KaiaScan", async () => {
    const mockGet = vi.fn().mockResolvedValue(balanceOfAbi);
    mockCreateKaiaScanClient.mockReturnValue({
      get: mockGet,
    } as unknown as ReturnType<typeof createKaiaScanClient>);
    const result = await handleGetContractAbi({
      contractAddress: validAddress,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("balanceOf");
    expect(mockGet).toHaveBeenCalledWith(`api/v1/contracts/${validAddress}/abi`);
  });

  it("throws for invalid address", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
    await expect(
      handleGetContractAbi({ contractAddress: "bad", network: "mainnet" })
    ).rejects.toThrow(/Invalid address/);
  });
});

describe("handleGetContractSource", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi
        .fn()
        .mockResolvedValue([{ address: validAddress, verified: true, name: "MyContract" }]),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("returns Unverified when no source in response", async () => {
    const result = await handleGetContractSource({
      contractAddress: validAddress,
      network: "mainnet",
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Unverified|Verified contract but source/);
  });

  it("calls KaiaScan with api/v1/contracts and contractAddresses param", async () => {
    const mockGet = vi.fn().mockResolvedValue([]);
    mockCreateKaiaScanClient.mockReturnValue({ get: mockGet } as unknown as ReturnType<
      typeof createKaiaScanClient
    >);
    await handleGetContractSource({
      contractAddress: validAddress,
      network: "mainnet",
    });
    expect(mockGet).toHaveBeenCalledWith("api/v1/contracts", {
      contractAddresses: validAddress,
    });
  });

  it("returns source when source_code present", async () => {
    mockCreateKaiaScanClient.mockReturnValue({
      get: vi.fn().mockResolvedValue([
        {
          address: validAddress,
          verified: true,
          source_code: "pragma solidity ^0.8.0; contract C {}",
        },
      ]),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
    const result = await handleGetContractSource({
      contractAddress: validAddress,
      network: "mainnet",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("pragma solidity");
  });
});

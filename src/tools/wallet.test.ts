import { describe, it, expect, vi } from "vitest";
import { handleGenerateWallet, handleEncodeFunctionData } from "./wallet.js";

describe("handleGenerateWallet", () => {
  it("returns address and privateKey as hex (length 66)", async () => {
    const result = await handleGenerateWallet({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Address: 0x[a-fA-F0-9]{40}/);
    expect(text).toMatch(/Private key \(hex\): 0x[a-fA-F0-9]{64}/);
    const pkMatch = text.match(/Private key \(hex\): (0x[a-fA-F0-9]{64})/);
    expect(pkMatch).toBeTruthy();
    expect(pkMatch![1].length).toBe(66);
  });

  it("includes display network when provided", async () => {
    const result = await handleGenerateWallet({ network: "kairos" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("kairos");
  });

  it("does not require any params", async () => {
    const result = await handleGenerateWallet({});
    expect(result.content[0].type).toBe("text");
  });
});

describe("handleEncodeFunctionData", () => {
  const balanceOfAbi = [
    {
      type: "function",
      name: "balanceOf",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }],
      stateMutability: "view",
    },
  ] as const;

  it("returns hex data for balanceOf(address) with args", async () => {
    const result = await handleEncodeFunctionData({
      abi: JSON.stringify(balanceOfAbi),
      functionName: "balanceOf",
      args: ["0x1234567890123456789012345678901234567890"],
    });
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^0x[a-fA-F0-9]+$/);
    expect(text.length).toBeGreaterThan(10);
  });

  it("accepts ABI as array", async () => {
    const result = await handleEncodeFunctionData({
      abi: balanceOfAbi,
      functionName: "balanceOf",
      args: ["0x0000000000000000000000000000000000000001"],
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^0x[a-fA-F0-9]+$/);
  });

  it("throws for invalid ABI", async () => {
    await expect(
      handleEncodeFunctionData({
        abi: "not json",
        functionName: "balanceOf",
      })
    ).rejects.toThrow(/Invalid ABI/);
  });

  it("throws for empty functionName", async () => {
    await expect(
      handleEncodeFunctionData({
        abi: balanceOfAbi,
        functionName: "  ",
      })
    ).rejects.toThrow(/functionName/);
  });

  it("throws when args is not an array", async () => {
    await expect(
      handleEncodeFunctionData({
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: "not-an-array",
      })
    ).rejects.toThrow(/args.*array/);
  });
});

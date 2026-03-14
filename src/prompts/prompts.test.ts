import { describe, it, expect } from "vitest";
import { listPrompts, getPrompt } from "./index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

describe("listPrompts", () => {
  it("returns 6 prompts with expected names", () => {
    const result = listPrompts();
    expect(result.prompts).toHaveLength(6);
    const names = result.prompts.map((p) => p.name);
    expect(names).toEqual([
      "analyze-wallet",
      "investigate-transaction",
      "token-research",
      "nft-lookup",
      "gas-report",
      "smart-contract-audit",
    ]);
  });

  it("each prompt has expected argument names", () => {
    const result = listPrompts();
    const analyzeWallet = result.prompts.find((p) => p.name === "analyze-wallet");
    expect(analyzeWallet?.arguments?.map((a) => a.name)).toEqual(["address", "network"]);

    const nftLookup = result.prompts.find((p) => p.name === "nft-lookup");
    expect(nftLookup?.arguments?.map((a) => a.name)).toEqual([
      "contractAddress",
      "tokenId",
      "network",
    ]);

    const gasReport = result.prompts.find((p) => p.name === "gas-report");
    expect(gasReport?.arguments?.map((a) => a.name)).toEqual(["network"]);
  });
});

describe("getPrompt", () => {
  it('analyze-wallet with address and network returns one user message with text containing address and network', async () => {
    const result = await getPrompt("analyze-wallet", {
      address: "0x123...",
      network: "kairos",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
    const text = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("0x123...");
    expect(text).toContain("kairos");
  });

  it('nft-lookup with contractAddress and tokenId returns text containing both', async () => {
    const result = await getPrompt("nft-lookup", {
      contractAddress: "0xabc",
      tokenId: "1",
    });
    expect(result.messages).toHaveLength(1);
    const text = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("0xabc");
    expect(text).toContain("1");
  });

  it("unknown prompt name throws McpError", async () => {
    await expect(getPrompt("unknown")).rejects.toThrow(McpError);
    await expect(getPrompt("unknown")).rejects.toThrow(/Unknown prompt/);
  });

  it("missing required argument throws McpError with clear message", async () => {
    await expect(getPrompt("analyze-wallet", {})).rejects.toThrow(McpError);
    await expect(getPrompt("analyze-wallet", {})).rejects.toThrow(/Missing required argument/);
    await expect(getPrompt("analyze-wallet", { address: "" })).rejects.toThrow(McpError);
  });

  it("optional network defaults to mainnet", async () => {
    const result = await getPrompt("analyze-wallet", { address: "0xdef" });
    const text = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("mainnet");
  });

  it("gas-report with no args uses default network", async () => {
    const result = await getPrompt("gas-report", {});
    const text = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("mainnet");
  });
});

/**
 * MCP prompts (Phase 9): reusable prompt templates for Kaia wallet, transaction, token, NFT, gas, and contract workflows.
 */

import type { ListPromptsResult, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_NETWORK = "mainnet";

export interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
  template: (args: Record<string, string>) => string;
}

const PROMPTS: PromptDef[] = [
  {
    name: "analyze-wallet",
    description: "Analyze a Kaia wallet: balance, recent transactions, and token holdings.",
    arguments: [
      { name: "address", description: "Wallet address (0x...)", required: true },
      { name: "network", description: "Network: mainnet or kairos", required: false },
    ],
    template: (args) =>
      `Analyze the wallet ${args.address} on Kaia ${args.network}. Show balance, recent transactions, and token holdings.`,
  },
  {
    name: "investigate-transaction",
    description:
      "Investigate a transaction: status, gas usage, token transfers, and internal transactions.",
    arguments: [{ name: "txHash", description: "Transaction hash (0x...)", required: true }],
    template: (args) =>
      `Investigate transaction ${args.txHash}. Show status, gas usage, token transfers, and internal transactions.`,
  },
  {
    name: "token-research",
    description: "Research a token: supply, holders, recent activity, and transfers.",
    arguments: [
      { name: "contractAddress", description: "Token contract address (0x...)", required: true },
      { name: "network", description: "Network: mainnet or kairos", required: false },
    ],
    template: (args) =>
      `Research the token at ${args.contractAddress}. Show supply, holders, recent activity, and transfers.`,
  },
  {
    name: "nft-lookup",
    description: "Look up an NFT: owner, metadata, and transfer history.",
    arguments: [
      {
        name: "contractAddress",
        description: "NFT collection contract address (0x...)",
        required: true,
      },
      { name: "tokenId", description: "NFT token ID", required: true },
      { name: "network", description: "Network: mainnet or kairos", required: false },
    ],
    template: (args) =>
      `Look up NFT ${args.tokenId} in collection ${args.contractAddress}. Show owner, metadata, and transfer history.`,
  },
  {
    name: "gas-report",
    description: "Generate a gas report: current price, fee history, and recommendations.",
    arguments: [{ name: "network", description: "Network: mainnet or kairos", required: false }],
    template: (args) =>
      `Generate a gas report for Kaia ${args.network}. Show current price, fee history, and recommendations.`,
  },
  {
    name: "smart-contract-audit",
    description: "Review a contract: fetch ABI and source code, identify contract type.",
    arguments: [
      { name: "contractAddress", description: "Contract address (0x...)", required: true },
      { name: "network", description: "Network: mainnet or kairos", required: false },
    ],
    template: (args) =>
      `Review the contract at ${args.contractAddress}. Fetch ABI and source code, identify the contract type.`,
  },
];

/** Returns the list of prompts for MCP prompts/list. */
export function listPrompts(): ListPromptsResult {
  return {
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    })),
  };
}

/**
 * Returns the templated prompt for MCP prompts/get.
 * Substitutes args into the template; uses default for optional args (network -> mainnet).
 * @throws McpError InvalidParams if prompt name is unknown or required arguments are missing.
 */
export async function getPrompt(
  name: string,
  args?: Record<string, string>
): Promise<GetPromptResult> {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }

  const provided = args ?? {};
  const resolved: Record<string, string> = {};

  for (const arg of def.arguments) {
    const value = provided[arg.name];
    if (arg.required) {
      if (value === undefined || value === "") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required argument for prompt "${name}": ${arg.name}`
        );
      }
      resolved[arg.name] = value;
    } else {
      resolved[arg.name] = value !== undefined && value !== "" ? value : DEFAULT_NETWORK;
    }
  }

  const text = def.template(resolved);
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

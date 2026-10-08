/**
 * Block-related tools (Phase 5): block number, block by number/hash, block rewards/burns.
 */

import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { InvalidParamsError } from "../utils/errors.js";
import { validateNetwork, validateBlockNumberOrHash } from "../utils/validation.js";

// --- Tool definitions ---

export const GET_BLOCK_NUMBER = {
  name: "get_block_number",
  description: "Get the current block number for the network.",
  inputSchema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: [],
  },
};

export const GET_BLOCK = {
  name: "get_block",
  description:
    "Get block by number or hash. Returns block number, hash, parentHash, timestamp, miner, gasUsed, gasLimit, transactions count or list.",
  inputSchema: {
    type: "object" as const,
    properties: {
      blockNumberOrHash: {
        type: "string",
        description: "Block number (integer or hex) or block hash (0x + 64 hex)",
      },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      includeTransactions: {
        type: "boolean",
        description: "Include full transaction list (default: false)",
      },
    },
    required: ["blockNumberOrHash"],
  },
};

export const GET_BLOCK_REWARDS = {
  name: "get_block_rewards",
  description:
    "Get block rewards and burns for a block via KaiaScan API (rewards and burns summary).",
  inputSchema: {
    type: "object" as const,
    properties: {
      blockNumber: { type: "number", description: "Block number (integer)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["blockNumber"],
  },
};

export const BLOCK_TOOLS = [GET_BLOCK_NUMBER, GET_BLOCK, GET_BLOCK_REWARDS];

// --- KaiaScan API response shapes ---

interface BlockRewardsResponse {
  minted?: number;
  total_fee?: number;
  burnt_fee?: number;
}

interface BlockBurnsResponse {
  nearest_block_number?: number;
  accumulate_burnt_fees?: number;
  accumulate_burnt_kaia?: number;
  kip103_burnt?: number;
  kip160_burnt?: number;
  accumulate_burnt?: number;
}

// --- Handlers ---

export async function handleGetBlockNumber(args: {
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const network = validateNetwork(args.network);

  const client = createRpcClient(network);
  const blockNumber = await client.getBlockNumber();

  const text = `Current block number on ${network}: ${blockNumber.toString()}`;
  return {
    content: [{ type: "text" as const, text }],
  };
}

export async function handleGetBlock(args: {
  blockNumberOrHash?: unknown;
  network?: unknown;
  includeTransactions?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const blockRef = validateBlockNumberOrHash(args.blockNumberOrHash);
  const network = validateNetwork(args.network);
  const includeTransactions = Boolean(args.includeTransactions);

  const client = createRpcClient(network);

  const block = await client.getBlock({
    ...(typeof blockRef === "bigint" ? { blockNumber: blockRef } : { blockHash: blockRef }),
    includeTransactions,
  });

  if (!block) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Block not found: ${typeof blockRef === "bigint" ? blockRef.toString() : blockRef}`,
        },
      ],
    };
  }

  const txCount = Array.isArray(block.transactions) ? block.transactions.length : 0;
  const lines = [
    `Block: ${block.number?.toString() ?? "—"}`,
    `Hash: ${block.hash ?? "—"}`,
    `Parent: ${block.parentHash ?? "—"}`,
    `Timestamp: ${block.timestamp?.toString() ?? "—"}`,
    `Miner: ${block.miner ?? "—"}`,
    `Gas used: ${block.gasUsed?.toString() ?? "—"}`,
    `Gas limit: ${block.gasLimit?.toString() ?? "—"}`,
    `Transactions: ${txCount}`,
    `Network: ${network}`,
  ];

  if (includeTransactions && Array.isArray(block.transactions) && block.transactions.length > 0) {
    const txList = block.transactions
      .slice(0, 20)
      .map((t) => (typeof t === "string" ? t : (t.hash ?? String(t))))
      .join("\n  ");
    const more =
      block.transactions.length > 20 ? `\n  ... and ${block.transactions.length - 20} more` : "";
    lines.push("Transaction hashes:", `  ${txList}${more}`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * Uses KaiaScan API:
 * - GET /api/v1/blocks/:blockNumber/rewards (minted, total_fee, burnt_fee)
 * - GET /api/v1/blocks/:blockNumber/burns (accumulate_burnt_fees, etc.)
 */
export async function handleGetBlockRewards(args: {
  blockNumber?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let blockNumber: number;
  if (
    typeof args.blockNumber === "number" &&
    Number.isInteger(args.blockNumber) &&
    args.blockNumber >= 0
  ) {
    blockNumber = args.blockNumber;
  } else if (typeof args.blockNumber === "string") {
    const s = args.blockNumber.trim();
    if (s.startsWith("0x") && s.length === 66) {
      throw new InvalidParamsError(
        "Invalid block number: block hash not allowed. Use a block number (integer)."
      );
    }
    const n = s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
    if (!Number.isInteger(n) || n < 0 || isNaN(n)) {
      throw new InvalidParamsError("Invalid block number: must be a non-negative integer.");
    }
    blockNumber = n;
  } else {
    throw new InvalidParamsError("Invalid block number: must be a non-negative integer.");
  }
  validateNetwork(args.network);

  const client = createKaiaScanClient();
  const rewardsPath = `api/v1/blocks/${blockNumber}/rewards`;
  const burnsPath = `api/v1/blocks/${blockNumber}/burns`;

  let rewards: BlockRewardsResponse = {};
  let burns: BlockBurnsResponse = {};

  try {
    rewards = await client.get<BlockRewardsResponse>(rewardsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (block rewards): ${msg}`);
  }

  try {
    burns = await client.get<BlockBurnsResponse>(burnsPath);
  } catch {
    // Burns endpoint may not exist for all blocks; continue with rewards only
    burns = {};
  }

  const lines = [
    `Block ${blockNumber} — Rewards & Burns`,
    ``,
    "Rewards:",
    `  Minted: ${rewards.minted ?? "—"} KAIA`,
    `  Total fee: ${rewards.total_fee ?? "—"} KAIA`,
    `  Burnt fee: ${rewards.burnt_fee ?? "—"} KAIA`,
    ``,
    "Burns (accumulated up to block):",
    `  Accumulate burnt fees: ${burns.accumulate_burnt_fees ?? "—"}`,
    `  Accumulate burnt KAIA: ${burns.accumulate_burnt_kaia ?? "—"}`,
    `  KIP103 burnt: ${burns.kip103_burnt ?? "—"}`,
    `  KIP160 burnt: ${burns.kip160_burnt ?? "—"}`,
    `  Accumulate burnt: ${burns.accumulate_burnt ?? "—"}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

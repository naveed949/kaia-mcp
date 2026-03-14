/**
 * Token-related tools (Phase 6): fungible token (KIP-7 / ERC-20) info, holders, transfers.
 * KaiaScan API: Get Fungible Token, Get Holders Of Fungible Token, Get Transfers Of Fungible Token.
 */

import { createKaiaScanClient } from "../clients/kaiascan.js";
import { validateAddress, validateNetwork } from "../utils/validation.js";

// --- Tool definitions ---

export const GET_TOKEN_INFO = {
  name: "get_token_info",
  description:
    "Get fungible token metadata (name, symbol, decimals, total supply) by contract address. Uses KaiaScan Get Fungible Token (api/v1/tokens/:contractAddress).",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "Token contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["contractAddress"],
  },
};

export const GET_TOKEN_HOLDERS = {
  name: "get_token_holders",
  description:
    "Get top holders of a fungible token. Uses KaiaScan Get Holders Of Fungible Token (api/v1/tokens/:contractAddress/holders).",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "Token contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      page: { type: "number", description: "Page number (default: 1)" },
      size: { type: "number", description: "Page size, max 2000 (default: 20)" },
    },
    required: ["contractAddress"],
  },
};

export const GET_TOKEN_TRANSFERS = {
  name: "get_token_transfers",
  description:
    "Get recent transfers of a fungible token. Uses KaiaScan Get Transfers Of Fungible Token (api/v1/tokens/:contractAddress/transfers).",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "Token contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      page: { type: "number", description: "Page number (default: 1)" },
      size: { type: "number", description: "Page size, max 2000 (default: 20)" },
    },
    required: ["contractAddress"],
  },
};

export const TOKEN_TOOLS = [GET_TOKEN_INFO, GET_TOKEN_HOLDERS, GET_TOKEN_TRANSFERS];

// --- KaiaScan API response shapes ---

interface FungibleTokenResponse {
  name?: string;
  symbol?: string;
  decimal?: number;
  total_supply?: number;
  contract_type?: string;
  total_transfers?: number;
  official_site?: string;
  burn_amount?: number;
  total_burns?: number;
  icon?: string;
}

interface HolderItem {
  holder?: {
    address?: string;
    account_type?: string;
    amount?: number;
    percentage?: number;
    symbol?: string;
    name?: string;
  };
}

interface TokenHoldersResponse {
  results?: HolderItem[];
  paging?: { total_count?: number; current_page?: number; last?: boolean; total_page?: number };
}

interface TokenTransferItem {
  from?: string;
  to?: string;
  amount?: number;
  transaction_hash?: string;
  datetime?: string;
  block_id?: number;
}

interface TokenTransfersResponse {
  results?: TokenTransferItem[];
  paging?: { total_count?: number; current_page?: number; last?: boolean; total_page?: number };
}

// --- Handlers ---

/**
 * Get Fungible Token: GET /api/v1/tokens/:tokenAddress
 */
export async function handleGetTokenInfo(args: {
  contractAddress: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);

  const client = createKaiaScanClient();
  const path = `api/v1/tokens/${contractAddress}`;

  let data: FungibleTokenResponse;
  try {
    data = await client.get<FungibleTokenResponse>(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (fungible token): ${msg}`);
  }

  const name = data?.name ?? "—";
  const symbol = data?.symbol ?? "—";
  const decimals = data?.decimal ?? 0;
  const totalSupply = data?.total_supply ?? 0;
  const contractType = data?.contract_type ?? "—";

  const lines = [
    `Token: ${contractAddress}`,
    `Name: ${name}`,
    `Symbol: ${symbol}`,
    `Decimals: ${decimals}`,
    `Total supply: ${totalSupply}`,
    `Contract type: ${contractType}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * Get Holders Of Fungible Token: GET /api/v1/tokens/:tokenAddress/holders
 * Query: page, size (min 1, max 2000).
 */
export async function handleGetTokenHolders(args: {
  contractAddress: unknown;
  network?: unknown;
  page?: unknown;
  size?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);
  const page = Math.max(1, Number(args.page) || 1);
  const size = Math.min(2000, Math.max(1, Number(args.size) || 20));

  const client = createKaiaScanClient();
  const path = `api/v1/tokens/${contractAddress}/holders`;
  const params: Record<string, string> = { page: String(page), size: String(size) };

  let data: TokenHoldersResponse;
  try {
    data = await client.get<TokenHoldersResponse>(path, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (token holders): ${msg}`);
  }

  const results = data?.results ?? [];
  const paging = data?.paging;
  const total = paging?.total_count ?? results.length;

  if (results.length === 0) {
    const text = `No holders found for token ${contractAddress}.`;
    return { content: [{ type: "text" as const, text }] };
  }

  const lines = results.map((r) => {
    const holder = r?.holder;
    const address = holder?.address ?? "—";
    const balance = holder?.amount ?? 0;
    const pct = holder?.percentage != null ? `${holder.percentage}%` : "—";
    return `- ${address}: ${balance} (${pct})`;
  });

  const header = `Top holders for ${contractAddress} (page ${page}, total ${total}):`;
  const text = [header, ...lines].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

/**
 * Get Transfers Of Fungible Token: GET /api/v1/tokens/:tokenAddress/transfers
 * Query: page, size.
 */
export async function handleGetTokenTransfers(args: {
  contractAddress: unknown;
  network?: unknown;
  page?: unknown;
  size?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);
  const page = Math.max(1, Number(args.page) || 1);
  const size = Math.min(2000, Math.max(1, Number(args.size) || 20));

  const client = createKaiaScanClient();
  const path = `api/v1/tokens/${contractAddress}/transfers`;
  const params: Record<string, string> = { page: String(page), size: String(size) };

  let data: TokenTransfersResponse;
  try {
    data = await client.get<TokenTransfersResponse>(path, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (token transfers): ${msg}`);
  }

  const results = data?.results ?? [];
  const paging = data?.paging;
  const total = paging?.total_count ?? results.length;

  if (results.length === 0) {
    const text = `No transfers found for token ${contractAddress}.`;
    return { content: [{ type: "text" as const, text }] };
  }

  const lines = results.map((r) => {
    const from = r?.from ?? "—";
    const to = r?.to ?? "—";
    const value = r?.amount ?? 0;
    const txHash = r?.transaction_hash ?? "—";
    const time = r?.datetime ?? "—";
    return `- from ${from} → to ${to} | value ${value} | ${txHash} | ${time}`;
  });

  const header = `Token transfers for ${contractAddress} (page ${page}, total ${total}):`;
  const text = [header, ...lines].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

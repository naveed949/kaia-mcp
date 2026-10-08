/**
 * NFT-related tools (Phase 6): non-fungible token (KIP-17 / ERC-721) collection info, single item, transfers.
 * KaiaScan API: Get Non Fungible Token, Get Nft Item / Get Nft Token Item, Get Transfers Of Non Fungible Token.
 */

import { createKaiaScanClient } from "../clients/kaiascan.js";
import { validateAddress, validateNetwork } from "../utils/validation.js";

// --- Tool definitions ---

export const GET_NFT_INFO = {
  name: "get_nft_info",
  description:
    "Get NFT collection metadata (name, symbol, total supply) by contract address. Uses KaiaScan Get Non Fungible Token (api/v1/nfts/:contractAddress).",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "NFT contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["contractAddress"],
  },
};

export const GET_NFT_ITEM = {
  name: "get_nft_item",
  description:
    "Get a single NFT item by contract and token ID (owner, tokenURI, metadata). Uses KaiaScan Get Nft Token Item (api/v1/nfts/:contractAddress/tokenids/:tokenId).",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "NFT contract address (0x...)" },
      tokenId: {
        type: "string",
        description: "NFT token ID (string or number)",
      },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["contractAddress", "tokenId"],
  },
};

export const GET_NFT_TRANSFERS = {
  name: "get_nft_transfers",
  description:
    "Get NFT transfer history for a collection. Uses KaiaScan Get Transfers Of Non Fungible Token (api/v1/nfts/:contractAddress/transfers).",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "NFT contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      page: { type: "number", description: "Page number (default: 1)" },
      size: { type: "number", description: "Page size, max 2000 (default: 20)" },
    },
    required: ["contractAddress"],
  },
};

export const NFT_TOOLS = [GET_NFT_INFO, GET_NFT_ITEM, GET_NFT_TRANSFERS];

// --- KaiaScan API response shapes ---

interface NonFungibleTokenResponse {
  name?: string;
  symbol?: string;
  total_supply?: number;
  contract_type?: string;
  total_transfers?: number;
  holder_count?: number;
  official_site?: string;
  icon?: string;
}

interface NftTokenItemHolder {
  address?: string;
  account_type?: string;
}

interface NftTokenItemInfo {
  token_id?: string;
  token_uri?: string;
  symbol?: string;
  name?: string;
  contract_address?: string;
  total_supply?: number;
}

interface NftTokenItemMetadata {
  name?: string;
  description?: string;
  image?: string;
  image_data?: string;
  external_url?: string;
  animation_url?: string;
  [key: string]: unknown;
}

interface NftTokenItemResponse {
  contract_type?: string;
  info?: NftTokenItemInfo;
  holder?: NftTokenItemHolder;
  metadata?: NftTokenItemMetadata;
  total_transfer?: number;
  total_supply?: number;
}

interface NftTransferItem {
  from?: string;
  to?: string;
  token_id?: string;
  token_count?: number;
  transaction_hash?: string;
  datetime?: string;
  block_id?: number;
}

interface NftTransfersResponse {
  results?: NftTransferItem[];
  paging?: { total_count?: number; current_page?: number; last?: boolean; total_page?: number };
}

// --- Handlers ---

/**
 * Get Non Fungible Token: GET /api/v1/nfts/:tokenAddress
 */
export async function handleGetNftInfo(args: {
  contractAddress?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);

  const client = createKaiaScanClient();
  const path = `api/v1/nfts/${contractAddress}`;

  let data: NonFungibleTokenResponse;
  try {
    data = await client.get<NonFungibleTokenResponse>(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (non-fungible token): ${msg}`);
  }

  const name = data?.name ?? "—";
  const symbol = data?.symbol ?? "—";
  const totalSupply = data?.total_supply ?? 0;
  const contractType = data?.contract_type ?? "—";
  const holderCount = data?.holder_count ?? "—";

  const lines = [
    `NFT collection: ${contractAddress}`,
    `Name: ${name}`,
    `Symbol: ${symbol}`,
    `Total supply: ${totalSupply}`,
    `Holder count: ${holderCount}`,
    `Contract type: ${contractType}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * Get Nft Token Item: GET /api/v1/nfts/:tokenAddress/tokenids/:tokenId
 * tokenId can be string or number (normalized to string for path).
 */
export async function handleGetNftItem(args: {
  contractAddress?: unknown;
  tokenId?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  const tokenId =
    args.tokenId !== undefined && args.tokenId !== null ? String(args.tokenId).trim() : "";
  if (!tokenId) {
    throw new Error("tokenId is required.");
  }
  validateNetwork(args.network);

  const client = createKaiaScanClient();
  const path = `api/v1/nfts/${contractAddress}/tokenids/${encodeURIComponent(tokenId)}`;

  let data: NftTokenItemResponse;
  try {
    data = await client.get<NftTokenItemResponse>(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (NFT item): ${msg}`);
  }

  const info = data?.info;
  const holder = data?.holder;
  const owner = holder?.address ?? "—";
  const tokenIdVal = info?.token_id ?? tokenId;
  const tokenURI = info?.token_uri ?? "—";
  const metadata = data?.metadata;
  const totalTransfer = data?.total_transfer ?? "—";

  const lines = [
    `NFT: ${contractAddress} #${tokenIdVal}`,
    `Owner: ${owner}`,
    `Token ID: ${tokenIdVal}`,
    `Token URI: ${tokenURI}`,
    `Total transfers: ${totalTransfer}`,
  ];

  if (metadata && typeof metadata === "object") {
    const metaParts: string[] = [];
    if (metadata.name != null) metaParts.push(`name: ${metadata.name}`);
    if (metadata.description != null) metaParts.push(`description: ${metadata.description}`);
    if (metadata.image != null) metaParts.push(`image: ${metadata.image}`);
    if (metadata.external_url != null) metaParts.push(`external_url: ${metadata.external_url}`);
    const rest = Object.entries(metadata).filter(
      ([k]) => !["name", "description", "image", "external_url"].includes(k)
    );
    for (const [k, v] of rest) {
      if (v != null && typeof v !== "object") metaParts.push(`${k}: ${v}`);
    }
    if (metaParts.length > 0) {
      lines.push("Metadata:", ...metaParts.map((p) => `  ${p}`));
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * Get Transfers Of Non Fungible Token: GET /api/v1/nfts/:tokenAddress/transfers
 * Query: page, size (optional tokenId to filter).
 */
export async function handleGetNftTransfers(args: {
  contractAddress?: unknown;
  network?: unknown;
  page?: unknown;
  size?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);
  const page = Math.max(1, Number(args.page) || 1);
  const size = Math.min(2000, Math.max(1, Number(args.size) || 20));

  const client = createKaiaScanClient();
  const path = `api/v1/nfts/${contractAddress}/transfers`;
  const params: Record<string, string> = { page: String(page), size: String(size) };

  let data: NftTransfersResponse;
  try {
    data = await client.get<NftTransfersResponse>(path, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (NFT transfers): ${msg}`);
  }

  const results = data?.results ?? [];
  const paging = data?.paging;
  const total = paging?.total_count ?? results.length;

  if (results.length === 0) {
    const text = `No NFT transfers found for ${contractAddress}.`;
    return { content: [{ type: "text" as const, text }] };
  }

  const lines = results.map((r) => {
    const from = r?.from ?? "—";
    const to = r?.to ?? "—";
    const tid = r?.token_id ?? "—";
    const txHash = r?.transaction_hash ?? "—";
    const time = r?.datetime ?? "—";
    return `- from ${from} → to ${to} | tokenId ${tid} | ${txHash} | ${time}`;
  });

  const header = `NFT transfers for ${contractAddress} (page ${page}, total ${total}):`;
  const text = [header, ...lines].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

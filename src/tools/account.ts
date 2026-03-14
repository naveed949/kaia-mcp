/**
 * Account-related tools (Phase 4): balance, account info, tokens, NFTs.
 */

import type { Address } from "viem";
import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { formatKaia, formatPeb } from "../utils/format.js";
import { validateAddress, validateNetwork, type KaiaNetwork } from "../utils/validation.js";

// --- Tool definitions (name, description, inputSchema) ---

export const GET_KAIA_BALANCE = {
  name: "get_kaia_balance",
  description: "Get KAIA balance for an address. Returns formatted KAIA and raw peb.",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: { type: "string", description: "Ethereum-style address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["address"],
  },
};

export const GET_ACCOUNT_INFO = {
  name: "get_account_info",
  description:
    "Get account info (type, balance, nonce, accountKey) for an address via Kaia RPC kaia_getAccount.",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: { type: "string", description: "Ethereum-style address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["address"],
  },
};

export const GET_ACCOUNT_TOKENS = {
  name: "get_account_tokens",
  description: "Get fungible token balances for an address via KaiaScan API.",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: { type: "string", description: "Ethereum-style address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      page: { type: "number", description: "Page number (default: 1)" },
      size: { type: "number", description: "Page size, max 2000 (default: 100)" },
    },
    required: ["address"],
  },
};

export const GET_ACCOUNT_NFTS = {
  name: "get_account_nfts",
  description: "Get NFT inventories for an address via KaiaScan API.",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: { type: "string", description: "Ethereum-style address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      page: { type: "number", description: "Page number (default: 1)" },
      size: { type: "number", description: "Page size, max 2000 (default: 20)" },
    },
    required: ["address"],
  },
};

export const ACCOUNT_TOOLS = [GET_KAIA_BALANCE, GET_ACCOUNT_INFO, GET_ACCOUNT_TOKENS, GET_ACCOUNT_NFTS];

// --- Kaia RPC account response (kaia_getAccount) ---

interface KaiaAccountKey {
  keyType?: number;
  key?: unknown;
}

interface KaiaGetAccountResult {
  accType?: number;
  balance?: string;
  nonce?: string;
  humanReadable?: boolean;
  key?: KaiaAccountKey;
  keyType?: number;
  storageRoot?: string;
  codeHash?: string;
  codeFormat?: string;
  vmVersion?: string;
}

const ACCOUNT_TYPE_NAMES: Record<number, string> = {
  0: "EOA",
  1: "EOA",
  2: "contract",
};

const KEY_TYPE_NAMES: Record<number, string> = {
  0: "AccountKeyLegacy",
  1: "AccountKeyPublic",
  2: "AccountKeyFail",
  3: "AccountKeyWeightedMultiSig",
  4: "AccountKeyRoleBased",
};

// --- KaiaScan API response shapes ---

interface TokenBalanceItem {
  contract?: { contract_address?: string; contract_type?: string };
  balance?: number;
  token_symbol?: string;
  token_name?: string;
}

interface TokenBalancesResponse {
  results?: TokenBalanceItem[];
  paging?: { total_count?: number; current_page?: number; last?: boolean; total_page?: number };
}

interface NftInventoryItem {
  nft?: {
    symbol?: string;
    name?: string;
    contract_address?: string;
    nft_type?: string;
    token_id?: string;
    token_count?: number;
  };
}

interface NftInventoriesResponse {
  results?: NftInventoryItem[];
  paging?: { total_count?: number; current_page?: number; last?: boolean; total_page?: number };
}

// --- Handlers ---

export async function handleGetKaiaBalance(args: {
  address: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const address = validateAddress(args.address) as Address;
  const network = validateNetwork(args.network);

  const client = createRpcClient(network);
  const balance = await client.getBalance({ address, blockTag: "latest" });

  const kaia = formatKaia(balance);
  const peb = formatPeb(balance);
  const text = `Balance: ${kaia} KAIA (${peb} peb) for ${address} on ${network}.`;

  return {
    content: [{ type: "text" as const, text }],
  };
}

export async function handleGetAccountInfo(args: {
  address: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const address = validateAddress(args.address) as Address;
  const network = validateNetwork(args.network);

  const client = createRpcClient(network);
  const raw = await client.request({
    method: "kaia_getAccount" as "eth_getBalance",
    params: [address, "latest"],
  });
  const account = raw as KaiaGetAccountResult;

  const accType = account?.accType;
  const typeName = typeof accType === "number" ? ACCOUNT_TYPE_NAMES[accType] ?? "unknown" : "unknown";
  const balance = account?.balance != null ? BigInt(account.balance) : 0n;
  const nonce = account?.nonce ?? "0";
  const keyType = account?.keyType;
  const keyTypeName =
    typeof keyType === "number" ? KEY_TYPE_NAMES[keyType] ?? `KeyType(${keyType})` : "—";

  const lines = [
    `Account: ${address}`,
    `Network: ${network}`,
    `Type: ${typeName}`,
    `Balance: ${formatKaia(balance)} KAIA (${formatPeb(balance)} peb)`,
    `Nonce: ${nonce}`,
    `Account key type: ${keyTypeName}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

export async function handleGetAccountTokens(args: {
  address: unknown;
  network?: unknown;
  page?: unknown;
  size?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const address = validateAddress(args.address);
  validateNetwork(args.network); // ensure valid; KaiaScan main URL may not distinguish kairos
  const page = Math.max(1, Number(args.page) || 1);
  const size = Math.min(2000, Math.max(1, Number(args.size) || 100));

  const client = createKaiaScanClient();
  const path = `api/v1/accounts/${address}/token-balances`;
  const params: Record<string, string> = { page: String(page), size: String(size) };

  let data: TokenBalancesResponse;
  try {
    data = await client.get<TokenBalancesResponse>(path, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (token balances): ${msg}`);
  }

  const results = data?.results ?? [];
  const paging = data?.paging;
  const total = paging?.total_count ?? results.length;

  if (results.length === 0) {
    const text = `No fungible token balances found for ${address}.`;
    return { content: [{ type: "text" as const, text }] };
  }

  const lines = results.map((r) => {
    const addr = r?.contract?.contract_address ?? "—";
    const type = r?.contract?.contract_type ?? "—";
    const bal = r?.balance ?? 0;
    const sym = r?.token_symbol ?? "—";
    return `- ${sym}: ${bal} (contract: ${addr}, type: ${type})`;
  });

  const header = `Fungible token balances for ${address} (page ${page}, total ${total}):`;
  const text = [header, ...lines].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

export async function handleGetAccountNfts(args: {
  address: unknown;
  network?: unknown;
  page?: unknown;
  size?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const address = validateAddress(args.address);
  validateNetwork(args.network);
  const page = Math.max(1, Number(args.page) || 1);
  const size = Math.min(2000, Math.max(1, Number(args.size) || 20));

  const client = createKaiaScanClient();
  const path = `api/v1/accounts/${address}/nft-inventories`;
  const params: Record<string, string> = { page: String(page), size: String(size) };

  let data: NftInventoriesResponse;
  try {
    data = await client.get<NftInventoriesResponse>(path, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (NFT inventories): ${msg}`);
  }

  const results = data?.results ?? [];
  const paging = data?.paging;
  const total = paging?.total_count ?? results.length;

  if (results.length === 0) {
    const text = `No NFT inventories found for ${address}.`;
    return { content: [{ type: "text" as const, text }] };
  }

  const lines = results.map((r) => {
    const nft = r?.nft;
    const symbol = nft?.symbol ?? "—";
    const name = nft?.name ?? "—";
    const contract = nft?.contract_address ?? "—";
    const nftType = nft?.nft_type ?? "—";
    const count = nft?.token_count ?? "—";
    return `- ${symbol} (${name}): contract ${contract}, type ${nftType}, count ${count}`;
  });

  const header = `NFT inventories for ${address} (page ${page}, total ${total}):`;
  const text = [header, ...lines].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

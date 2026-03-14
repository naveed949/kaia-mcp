/**
 * Network-related tools (Phase 7): gas price, KAIA price, chain info.
 */

import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { getChain } from "../chains.js";
import { formatKaia } from "../utils/format.js";
import { validateNetwork } from "../utils/validation.js";

// --- Tool definitions ---

export const GET_GAS_PRICE = {
  name: "get_gas_price",
  description:
    "Get current gas price from the network. Returns gas price in peb, Gpeb (1e9 peb), and optionally KAIA per unit.",
  inputSchema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: [],
  },
};

export const GET_KAIA_PRICE = {
  name: "get_kaia_price",
  description:
    "Get KAIA price in USD and other stats from KaiaScan. Path: GET /api/v1/kaia. Returns usd_price, btc_price, usd_price_changes (24h), market_cap, total_supply, volume.",
  inputSchema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "mainnet or kairos (optional, for display only)" },
    },
    required: [],
  },
};

export const GET_CHAIN_INFO = {
  name: "get_chain_info",
  description:
    "Get chain info for the network: chainId, chain name, native currency. Uses getChain() and RPC getChainId().",
  inputSchema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: [],
  },
};

export const NETWORK_TOOLS = [GET_GAS_PRICE, GET_KAIA_PRICE, GET_CHAIN_INFO];

// --- KaiaScan API response (GET /api/v1/kaia) ---

interface KlayPrice {
  usd_price?: number;
  btc_price?: number;
  usd_price_changes?: number;
  market_cap?: number;
  total_supply?: number;
  volume?: number;
}

interface KaiaApiResponse {
  summary?: Record<string, unknown>;
  klay_price?: KlayPrice;
}

// --- Handlers ---

export async function handleGetGasPrice(args: {
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const network = validateNetwork(args.network);
  const client = createRpcClient(network);
  const gasPricePeb = await client.getGasPrice();
  const peb = gasPricePeb ?? 0n;
  const Gpeb = Number(peb) / 1e9;
  const kaiaPerUnit = formatKaia(peb);

  const lines = [
    `Gas price: ${peb.toString()} peb`,
    `Gas price: ${Gpeb.toFixed(6)} Gpeb`,
    `KAIA per unit: ${kaiaPerUnit} KAIA`,
    `Network: ${network}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

export async function handleGetKaiaPrice(args: {
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const network = validateNetwork(args.network);
  const client = createKaiaScanClient();
  const path = "api/v1/kaia";

  let data: KaiaApiResponse;
  try {
    data = await client.get<KaiaApiResponse>(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`KaiaScan API error (Kaia price): ${msg}`);
  }

  const price = data?.klay_price;
  const usd = price?.usd_price ?? "—";
  const btc = price?.btc_price ?? "—";
  const change24h = price?.usd_price_changes ?? "—";
  const marketCap = price?.market_cap ?? "—";
  const totalSupply = price?.total_supply ?? "—";
  const volume24h = price?.volume ?? "—";

  const lines = [
    `USD price: ${usd}`,
    `BTC price: ${btc}`,
    `24h change (USD): ${change24h}`,
    `Market cap: ${marketCap}`,
    `Total supply: ${totalSupply}`,
    `24h volume (USD): ${volume24h}`,
    `Network (display): ${network}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

export async function handleGetChainInfo(args: {
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const network = validateNetwork(args.network);
  const chain = getChain(network);
  const client = createRpcClient(network);
  const chainId = await client.getChainId();

  const lines = [
    `Chain ID: ${chainId}`,
    `Chain name: ${chain.name}`,
    `Native currency: ${chain.nativeCurrency?.name ?? "KAIA"} (${chain.nativeCurrency?.symbol ?? "KAIA"}, ${chain.nativeCurrency?.decimals ?? 18} decimals)`,
    `Network: ${network}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

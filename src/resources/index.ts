/**
 * MCP resources (Phase 8): read-only URIs for status, tokens, top accounts, and docs.
 */

import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/server";
import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { getChain } from "../chains.js";
import { formatKaia } from "../utils/format.js";
import { toMcpError } from "../utils/errors.js";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { getPopularMainnetTokens } from "./token-list.js";
import { RPC_METHODS_DOCS } from "./rpc-methods-docs.js";

const RESOURCE_MAINNET_STATUS = "kaia://mainnet/status";
const RESOURCE_KAIROS_STATUS = "kaia://kairos/status";
const RESOURCE_MAINNET_TOKENS_POPULAR = "kaia://mainnet/tokens/popular";
const RESOURCE_MAINNET_TOP_ACCOUNTS = "kaia://mainnet/top-accounts";
const RESOURCE_DOCS_RPC_METHODS = "kaia://docs/rpc-methods";

const ALL_RESOURCES = [
  {
    uri: RESOURCE_MAINNET_STATUS,
    name: "Mainnet status",
    description: "Current mainnet status: block height, gas price, KAIA price (RPC + KaiaScan).",
  },
  {
    uri: RESOURCE_KAIROS_STATUS,
    name: "Kairos testnet status",
    description:
      "Current Kairos testnet status: block height, gas price, KAIA price (RPC + KaiaScan).",
  },
  {
    uri: RESOURCE_MAINNET_TOKENS_POPULAR,
    name: "Popular mainnet tokens",
    description: "List of popular token addresses on mainnet with name, symbol, and address.",
  },
  {
    uri: RESOURCE_MAINNET_TOP_ACCOUNTS,
    name: "Top KAIA accounts",
    description: "Top 100 KAIA holders from KaiaScan (Get Top Accounts).",
  },
  {
    uri: RESOURCE_DOCS_RPC_METHODS,
    name: "RPC methods reference",
    description: "Static reference of Kaia RPC methods (kaia_*, klay_*, eth_*).",
  },
];

/** Returns the list of resources for MCP resources/list. */
export function listResources(): ListResourcesResult {
  return {
    resources: ALL_RESOURCES.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
    })),
    nextCursor: undefined,
    _meta: {},
  };
}

interface KaiaPriceResponse {
  klay_price?: {
    usd_price?: number;
    btc_price?: number;
    usd_price_changes?: number;
    market_cap?: number;
    total_supply?: number;
    volume?: number;
  };
}

interface TopAccountHolder {
  address?: string;
  account_type?: string;
  amount?: number;
  percentage?: number;
}

type TopAccountsResponse = TopAccountHolder[] | { holder?: TopAccountHolder[] };

async function fetchNetworkStatus(network: "mainnet" | "kairos"): Promise<string> {
  const client = createRpcClient(network);
  const scan = createKaiaScanClient();
  const chain = getChain(network);

  const [blockNumber, gasPricePeb, priceData] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice(),
    scan.get<KaiaPriceResponse>("api/v1/kaia").catch(() => ({ klay_price: undefined })),
  ]);

  const peb = gasPricePeb ?? 0n;
  const kaiaPerUnit = formatKaia(peb);
  const price = priceData?.klay_price;
  const usd = price?.usd_price != null ? String(price.usd_price) : "—";

  const lines = [
    `Network: ${network}`,
    `Chain: ${chain.name} (chainId ${chain.id})`,
    `Block height: ${blockNumber?.toString() ?? "—"}`,
    `Gas price: ${peb.toString()} peb (${kaiaPerUnit} KAIA per unit)`,
    `KAIA price (USD): ${usd}`,
  ];
  return lines.join("\n");
}

async function fetchTopAccounts(): Promise<string> {
  const scan = createKaiaScanClient();
  const data = await scan.get<TopAccountsResponse>("api/v1/kaia/top-accounts");
  const list = Array.isArray(data)
    ? data
    : ((data as { holder?: TopAccountHolder[] }).holder ?? []);
  const rows = list.slice(0, 100).map((h, i) => {
    const addr = h?.address ?? "—";
    const typ = h?.account_type ?? "—";
    const amt = h?.amount != null ? String(h.amount) : "—";
    const pct = h?.percentage != null ? `${h.percentage}%` : "—";
    return `${i + 1}. ${addr}  type=${typ}  amount=${amt}  ${pct}`;
  });
  return ["# Top 100 KAIA holders (mainnet)", "", ...rows].join("\n");
}

/**
 * Reads a resource by URI. Returns MCP ReadResourceResult with contents (text or blob).
 * On error, throws ProtocolError so the server handler can return proper JSON-RPC error.
 */
export async function readResource(uri: string): Promise<ReadResourceResult> {
  try {
    const trimmed = (uri ?? "").trim();
    if (!trimmed || !trimmed.startsWith("kaia://")) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Invalid resource URI: ${uri}. Expected kaia://<path>.`
      );
    }

    let text: string;
    let mimeType: string = "text/plain";

    if (trimmed === RESOURCE_MAINNET_STATUS) {
      text = await fetchNetworkStatus("mainnet");
    } else if (trimmed === RESOURCE_KAIROS_STATUS) {
      text = await fetchNetworkStatus("kairos");
    } else if (trimmed === RESOURCE_MAINNET_TOKENS_POPULAR) {
      const tokens = getPopularMainnetTokens();
      text = [
        "# Popular tokens (Kaia mainnet)",
        "",
        ...tokens.map((t) => `${t.name} (${t.symbol}): ${t.address}`),
      ].join("\n");
    } else if (trimmed === RESOURCE_MAINNET_TOP_ACCOUNTS) {
      text = await fetchTopAccounts();
    } else if (trimmed === RESOURCE_DOCS_RPC_METHODS) {
      text = RPC_METHODS_DOCS;
      mimeType = "text/markdown";
    } else {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown resource URI: ${uri}. Use resources/list to see available URIs.`
      );
    }

    return {
      contents: [{ uri: trimmed, mimeType, text }],
      _meta: {},
    };
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    const mcp = toMcpError(err);
    throw new ProtocolError(mcp.code, mcp.message, mcp.data);
  }
}

/**
 * Transaction-related tools (Phase 5): get transaction, receipt, account tx list, estimate gas.
 */

import type { Address } from "viem";
import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { KaiaScanApiError } from "../utils/errors.js";
import { formatKaia } from "../utils/format.js";
import {
  optionalNumber,
  validateAddress,
  validateHexData,
  validateNetwork,
  validateTxHash,
  validateWeiValue,
} from "../utils/validation.js";

const INPUT_TRUNCATE_LEN = 66; // 0x + 32 bytes hex

// --- Tool definitions ---

export const GET_TRANSACTION = {
  name: "get_transaction",
  description:
    "Get a human-readable summary of a transaction by hash (from, to, value, blockNumber, gas, gasPrice, input truncated).",
  inputSchema: {
    type: "object" as const,
    properties: {
      txHash: { type: "string", description: "Transaction hash (0x + 64 hex)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["txHash"],
  },
};

export const GET_TRANSACTION_RECEIPT = {
  name: "get_transaction_receipt",
  description:
    "Get transaction receipt: status, blockNumber, gasUsed, contractAddress (if creation), logs count.",
  inputSchema: {
    type: "object" as const,
    properties: {
      txHash: { type: "string", description: "Transaction hash (0x + 64 hex)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["txHash"],
  },
};

export const GET_ACCOUNT_TRANSACTIONS = {
  name: "get_account_transactions",
  description:
    "Get list of transactions for an account via KaiaScan API (tx hash, from, to, value, time, status).",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: { type: "string", description: "Ethereum-style address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      page: { type: "number", description: "Page number (default: 1)" },
      limit: { type: "number", description: "Records per page, max 2000 (default: 20)" },
    },
    required: ["address"],
  },
};

export const ESTIMATE_GAS = {
  name: "estimate_gas",
  description:
    "Estimate gas for a transaction (from, to optional for contract creation, value, data). Returns estimated gas and optionally KAIA at current gas price.",
  inputSchema: {
    type: "object" as const,
    properties: {
      from: { type: "string", description: "Sender address (0x...)" },
      to: { type: "string", description: "Recipient address (omit for contract creation)" },
      value: { type: "string", description: "Value in peb (hex) or KAIA decimal string" },
      data: { type: "string", description: "Call data (hex, optional)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["from"],
  },
};

export const TRANSACTION_TOOLS = [
  GET_TRANSACTION,
  GET_TRANSACTION_RECEIPT,
  GET_ACCOUNT_TRANSACTIONS,
  ESTIMATE_GAS,
];

// --- KaiaScan account transactions response ---

interface AccountTxItem {
  transaction_hash?: string;
  from?: string;
  to?: string;
  amount?: number;
  datetime?: string;
  status?: { status?: string };
}

interface AccountTransactionsResponse {
  results?: AccountTxItem[];
  paging?: { total_count?: number; current_page?: number; last?: boolean; total_page?: number };
}

// --- Handlers ---

export async function handleGetTransaction(args: {
  txHash?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const hash = validateTxHash(args.txHash);
  const network = validateNetwork(args.network);

  const client = createRpcClient(network);
  const tx = await client.getTransaction({ hash });

  if (!tx) {
    return {
      content: [{ type: "text" as const, text: `Transaction not found: ${hash}` }],
    };
  }

  const value = tx.value ?? 0n;
  const gasPrice = tx.gasPrice ?? 0n;
  const input = tx.input
    ? tx.input.length > INPUT_TRUNCATE_LEN
      ? `${tx.input.slice(0, INPUT_TRUNCATE_LEN)}...`
      : tx.input
    : "0x";

  const lines = [
    `Transaction: ${tx.hash}`,
    `From: ${tx.from}`,
    `To: ${tx.to ?? "(contract creation)"}`,
    `Value: ${formatKaia(value)} KAIA`,
    `Block: ${tx.blockNumber?.toString() ?? "pending"}`,
    `Gas: ${tx.gas?.toString() ?? "—"}`,
    `Gas price: ${gasPrice.toString()} peb`,
    `Input: ${input}`,
    `Network: ${network}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

export async function handleGetTransactionReceipt(args: {
  txHash?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const hash = validateTxHash(args.txHash);
  const network = validateNetwork(args.network);

  const client = createRpcClient(network);
  const receipt = await client.getTransactionReceipt({ hash });

  if (!receipt) {
    return {
      content: [{ type: "text" as const, text: `Receipt not found: ${hash}` }],
    };
  }

  const status =
    receipt.status === "success"
      ? "Success"
      : receipt.status === "reverted"
        ? "Reverted"
        : String(receipt.status);
  const logsCount = receipt.logs?.length ?? 0;

  const lines = [
    `Transaction: ${receipt.transactionHash}`,
    `Status: ${status}`,
    `Block: ${receipt.blockNumber.toString()}`,
    `Gas used: ${receipt.gasUsed.toString()}`,
    `Contract address: ${receipt.contractAddress ?? "(none)"}`,
    `Logs: ${logsCount}`,
    `Network: ${network}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * Uses KaiaScan API: GET /api/v1/accounts/:accountAddress/transactions
 * Query params: page, size (size used as limit, max 2000).
 */
export async function handleGetAccountTransactions(args: {
  address?: unknown;
  network?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const address = validateAddress(args.address);
  validateNetwork(args.network);
  const page = Math.max(1, optionalNumber(args.page, "page") || 1);
  const limit = Math.min(2000, Math.max(1, optionalNumber(args.limit, "limit") || 20));

  const client = createKaiaScanClient();
  const path = `api/v1/accounts/${address}/transactions`;
  const params: Record<string, string> = { page: String(page), size: String(limit) };

  let data: AccountTransactionsResponse;
  try {
    data = await client.get<AccountTransactionsResponse>(path, params);
  } catch (err) {
    throw KaiaScanApiError.wrap("account transactions", err);
  }

  const results = data?.results ?? [];
  const paging = data?.paging;
  const total = paging?.total_count ?? results.length;

  if (results.length === 0) {
    const text = `No transactions found for ${address}.`;
    return { content: [{ type: "text" as const, text }] };
  }

  const lines = results.map((r) => {
    const hash = r?.transaction_hash ?? "—";
    const from = r?.from ?? "—";
    const to = r?.to ?? "—";
    const amount = r?.amount ?? 0;
    const time = r?.datetime ?? "—";
    const status = r?.status?.status ?? "—";
    return `- ${hash} | from ${from} | to ${to} | value ${amount} KAIA | ${time} | ${status}`;
  });

  const header = `Account transactions for ${address} (page ${page}, total ${total}):`;
  const text = [header, ...lines].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

export async function handleEstimateGas(args: {
  from?: unknown;
  to?: unknown;
  value?: unknown;
  data?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Every argument is validated before the RPC call: a bad one is the caller's (-32602).
  const from = validateAddress(args.from) as Address;
  const to =
    args.to === undefined || args.to === null || (typeof args.to === "string" && !args.to.trim())
      ? undefined
      : (validateAddress(args.to) as Address);
  const value = validateWeiValue(args.value);
  const data = validateHexData(args.data);
  const network = validateNetwork(args.network);

  const client = createRpcClient(network);
  const request: { account: Address; to?: Address; value?: bigint; data?: `0x${string}` } = {
    account: from,
  };
  if (to) request.to = to;
  if (value !== undefined) request.value = value;
  if (data) request.data = data;

  const gasEstimate = await client.estimateGas(request);

  let gasPriceWei = 0n;
  try {
    const fee = await client.getGasPrice();
    gasPriceWei = fee ?? 0n;
  } catch {
    // ignore
  }
  const costWei = gasEstimate * gasPriceWei;
  const costKaia = gasPriceWei > 0n ? formatKaia(costWei) : "—";

  const lines = [
    `Estimated gas: ${gasEstimate.toString()} units`,
    `Gas price: ${gasPriceWei.toString()} peb`,
    `Estimated cost: ${costKaia} KAIA`,
    `Network: ${network}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * MCP tools registry — Phase 4 (account) + Phase 5 (transaction, block).
 */

import type { ListToolsResult, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ACCOUNT_TOOLS,
  handleGetKaiaBalance,
  handleGetAccountInfo,
  handleGetAccountTokens,
  handleGetAccountNfts,
} from "./account.js";
import {
  TRANSACTION_TOOLS,
  handleGetTransaction,
  handleGetTransactionReceipt,
  handleGetAccountTransactions,
  handleEstimateGas,
} from "./transaction.js";
import {
  BLOCK_TOOLS,
  handleGetBlockNumber,
  handleGetBlock,
  handleGetBlockRewards,
} from "./block.js";

export { ACCOUNT_TOOLS, GET_KAIA_BALANCE, GET_ACCOUNT_INFO, GET_ACCOUNT_TOKENS, GET_ACCOUNT_NFTS } from "./account.js";
export {
  TRANSACTION_TOOLS,
  GET_TRANSACTION,
  GET_TRANSACTION_RECEIPT,
  GET_ACCOUNT_TRANSACTIONS,
  ESTIMATE_GAS,
} from "./transaction.js";
export { BLOCK_TOOLS, GET_BLOCK_NUMBER, GET_BLOCK, GET_BLOCK_REWARDS } from "./block.js";

const ALL_TOOLS = [...ACCOUNT_TOOLS, ...TRANSACTION_TOOLS, ...BLOCK_TOOLS];

/**
 * Returns the list of registered tools for MCP tools/list.
 */
export function listTools(): ListToolsResult {
  return {
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    nextCursor: undefined,
    _meta: {},
  };
}

/**
 * Dispatches tools/call by name to the appropriate handler. Returns MCP CallToolResult.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const a = args ?? {};
  switch (name) {
    case "get_kaia_balance":
      return { ...(await handleGetKaiaBalance(a)), _meta: {} };
    case "get_account_info":
      return { ...(await handleGetAccountInfo(a)), _meta: {} };
    case "get_account_tokens":
      return { ...(await handleGetAccountTokens(a)), _meta: {} };
    case "get_account_nfts":
      return { ...(await handleGetAccountNfts(a)), _meta: {} };
    case "get_transaction":
      return { ...(await handleGetTransaction(a)), _meta: {} };
    case "get_transaction_receipt":
      return { ...(await handleGetTransactionReceipt(a)), _meta: {} };
    case "get_account_transactions":
      return { ...(await handleGetAccountTransactions(a)), _meta: {} };
    case "estimate_gas":
      return { ...(await handleEstimateGas(a)), _meta: {} };
    case "get_block_number":
      return { ...(await handleGetBlockNumber(a)), _meta: {} };
    case "get_block":
      return { ...(await handleGetBlock(a)), _meta: {} };
    case "get_block_rewards":
      return { ...(await handleGetBlockRewards(a)), _meta: {} };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

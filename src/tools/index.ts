/**
 * MCP tools registry — Phase 4–7 (account, transaction, block, token, NFT, contract, network, wallet).
 */

import type { ListToolsResult, CallToolResult } from "@modelcontextprotocol/server";
import { authorizeToolCall, authorizeToolList, filterToolsByAuth } from "../auth/scopes.js";
import type { ToolAuthOptions } from "../auth/scopes.js";
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
import {
  TOKEN_TOOLS,
  handleGetTokenInfo,
  handleGetTokenHolders,
  handleGetTokenTransfers,
  handleGetTokenAllowance,
} from "./token.js";
import { NFT_TOOLS, handleGetNftInfo, handleGetNftItem, handleGetNftTransfers } from "./nft.js";
import {
  CONTRACT_TOOLS,
  handleReadContract,
  handleGetContractAbi,
  handleGetContractSource,
} from "./contract.js";
import {
  NETWORK_TOOLS,
  handleGetGasPrice,
  handleGetKaiaPrice,
  handleGetChainInfo,
} from "./network.js";
import { WALLET_TOOLS, handleGenerateWallet, handleEncodeFunctionData } from "./wallet.js";
import { InvalidParamsError } from "../utils/errors.js";

export {
  ACCOUNT_TOOLS,
  GET_KAIA_BALANCE,
  GET_ACCOUNT_INFO,
  GET_ACCOUNT_TOKENS,
  GET_ACCOUNT_NFTS,
} from "./account.js";
export {
  TRANSACTION_TOOLS,
  GET_TRANSACTION,
  GET_TRANSACTION_RECEIPT,
  GET_ACCOUNT_TRANSACTIONS,
  ESTIMATE_GAS,
} from "./transaction.js";
export { BLOCK_TOOLS, GET_BLOCK_NUMBER, GET_BLOCK, GET_BLOCK_REWARDS } from "./block.js";
export {
  TOKEN_TOOLS,
  GET_TOKEN_INFO,
  GET_TOKEN_HOLDERS,
  GET_TOKEN_TRANSFERS,
  GET_TOKEN_ALLOWANCE,
} from "./token.js";
export { NFT_TOOLS, GET_NFT_INFO, GET_NFT_ITEM, GET_NFT_TRANSFERS } from "./nft.js";
export {
  CONTRACT_TOOLS,
  READ_CONTRACT,
  GET_CONTRACT_ABI,
  GET_CONTRACT_SOURCE,
} from "./contract.js";
export { NETWORK_TOOLS, GET_GAS_PRICE, GET_KAIA_PRICE, GET_CHAIN_INFO } from "./network.js";
export { WALLET_TOOLS, GENERATE_WALLET, ENCODE_FUNCTION_DATA } from "./wallet.js";

const ALL_TOOLS = [
  ...ACCOUNT_TOOLS,
  ...TRANSACTION_TOOLS,
  ...BLOCK_TOOLS,
  ...TOKEN_TOOLS,
  ...NFT_TOOLS,
  ...CONTRACT_TOOLS,
  ...NETWORK_TOOLS,
  ...WALLET_TOOLS,
];

/**
 * Returns the list of registered tools for MCP tools/list.
 * Partner/default mode omits generate_wallet. Authenticated sessions are filtered by token scopes.
 */
export function listTools(options: ToolAuthOptions = {}): ListToolsResult {
  authorizeToolList(options);
  const allowed = filterToolsByAuth(ALL_TOOLS, options);
  return {
    tools: allowed.map((t) => ({
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
 * Auth and unsafe-wallet checks run before any handler (fail-closed, no side effects).
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> | undefined,
  options: ToolAuthOptions = {}
): Promise<CallToolResult> {
  authorizeToolCall(name, options);
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
    case "get_token_info":
      return { ...(await handleGetTokenInfo(a)), _meta: {} };
    case "get_token_holders":
      return { ...(await handleGetTokenHolders(a)), _meta: {} };
    case "get_token_transfers":
      return { ...(await handleGetTokenTransfers(a)), _meta: {} };
    case "get_token_allowance":
      return { ...(await handleGetTokenAllowance(a)), _meta: {} };
    case "get_nft_info":
      return { ...(await handleGetNftInfo(a)), _meta: {} };
    case "get_nft_item":
      return { ...(await handleGetNftItem(a)), _meta: {} };
    case "get_nft_transfers":
      return { ...(await handleGetNftTransfers(a)), _meta: {} };
    case "read_contract":
      return { ...(await handleReadContract(a)), _meta: {} };
    case "get_contract_abi":
      return { ...(await handleGetContractAbi(a)), _meta: {} };
    case "get_contract_source":
      return { ...(await handleGetContractSource(a)), _meta: {} };
    case "get_gas_price":
      return { ...(await handleGetGasPrice(a)), _meta: {} };
    case "get_kaia_price":
      return { ...(await handleGetKaiaPrice(a)), _meta: {} };
    case "get_chain_info":
      return { ...(await handleGetChainInfo(a)), _meta: {} };
    case "generate_wallet":
      return { ...(await handleGenerateWallet(a)), _meta: {} };
    case "encode_function_data":
      return { ...(await handleEncodeFunctionData(a)), _meta: {} };
    default:
      throw new InvalidParamsError(`Unknown tool: ${name}`);
  }
}

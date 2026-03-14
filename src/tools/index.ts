/**
 * MCP tools registry — Phase 4: list and call account tools.
 */

import type { ListToolsResult, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ACCOUNT_TOOLS,
  handleGetKaiaBalance,
  handleGetAccountInfo,
  handleGetAccountTokens,
  handleGetAccountNfts,
} from "./account.js";

export { ACCOUNT_TOOLS, GET_KAIA_BALANCE, GET_ACCOUNT_INFO, GET_ACCOUNT_TOKENS, GET_ACCOUNT_NFTS } from "./account.js";

/**
 * Returns the list of registered tools for MCP tools/list.
 */
export function listTools(): ListToolsResult {
  return {
    tools: ACCOUNT_TOOLS.map((t) => ({
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

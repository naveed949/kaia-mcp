import { AuthError, MCP_ERROR_CODES } from "../utils/errors.js";
import { getConfig } from "../config.js";
import { AUTH_ERRORS, SCOPES, insufficientScopeError } from "./constants.js";
import type { AuthContext } from "./types.js";

const READ_TOOLS = [
  "get_kaia_balance",
  "get_account_info",
  "get_account_tokens",
  "get_account_nfts",
  "get_transaction",
  "get_transaction_receipt",
  "get_account_transactions",
  "estimate_gas",
  "get_block_number",
  "get_block",
  "get_block_rewards",
  "get_token_info",
  "get_token_holders",
  "get_token_transfers",
  "get_token_allowance",
  "get_nft_info",
  "get_nft_item",
  "get_nft_transfers",
  "read_contract",
  "get_contract_abi",
  "get_contract_source",
  "get_gas_price",
  "get_kaia_price",
  "get_chain_info",
] as const;

export const TOOL_SCOPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(READ_TOOLS.map((name) => [name, SCOPES.READ])),
  encode_function_data: SCOPES.ENCODE,
  generate_wallet: SCOPES.WALLET,
};

export function requiredScopeForTool(toolName: string): string | undefined {
  return TOOL_SCOPES[toolName];
}

export function isToolAllowedByScope(toolName: string, scopes: readonly string[]): boolean {
  const required = requiredScopeForTool(toolName);
  if (!required) return false;
  return scopes.includes(required);
}

export type ToolAuthOptions = {
  requireAuth?: boolean;
  auth?: AuthContext | null;
};

function assertAuthPresent(options: ToolAuthOptions): AuthContext {
  if (!options.auth) {
    throw new AuthError(AUTH_ERRORS.UNAUTHORIZED);
  }
  if (options.auth.expiresAtMs <= Date.now()) {
    throw new AuthError(AUTH_ERRORS.TOKEN_EXPIRED);
  }
  return options.auth;
}

/**
 * Fail-closed gate run before any tool handler. Throws AuthError; never invokes the tool.
 */
export function authorizeToolCall(toolName: string, options: ToolAuthOptions = {}): void {
  if (toolName === "generate_wallet" && !getConfig().allowUnsafeWallet) {
    throw new AuthError(AUTH_ERRORS.TOOL_DISABLED);
  }

  if (!options.requireAuth) return;

  const auth = assertAuthPresent(options);
  const required = requiredScopeForTool(toolName);
  if (!required) return;
  if (!auth.scopes.includes(required)) {
    throw new AuthError(insufficientScopeError(toolName, required));
  }
}

export function authorizeToolList(options: ToolAuthOptions = {}): void {
  if (!options.requireAuth) return;
  assertAuthPresent(options);
}

export function filterToolsByAuth<T extends { name: string }>(
  tools: readonly T[],
  options: ToolAuthOptions = {}
): T[] {
  let out = tools.filter((t) => t.name !== "generate_wallet" || getConfig().allowUnsafeWallet);
  if (options.requireAuth) {
    const auth = assertAuthPresent(options);
    out = out.filter((t) => isToolAllowedByScope(t.name, auth.scopes));
  }
  return out;
}

export { MCP_ERROR_CODES };

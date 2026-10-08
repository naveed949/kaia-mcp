import { MCP_ERROR_CODES } from "../utils/errors.js";

export const DEMO_CLIENT_ID = "kaia-mcp-demo";
export const DEMO_SUBJECT = "demo-user";

export const SCOPES = {
  READ: "kaia:read",
  ENCODE: "kaia:encode",
  WALLET: "kaia:wallet",
} as const;

export type KaiaScope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: readonly KaiaScope[] = [SCOPES.READ, SCOPES.ENCODE, SCOPES.WALLET];

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
export const DEFAULT_AUDIENCE = "kaia-mcp";
export const DEFAULT_INTROSPECTION_CLIENT_ID = "kaia-mcp-gateway";
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 86_400;
export const AUTH_CODE_TTL_SECONDS = 600;
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

export const DEMO_REDIRECT_URIS = [
  "http://127.0.0.1/callback",
  "http://localhost/callback",
  "http://127.0.0.1/cb",
  "http://localhost/cb",
] as const;

export const AUTH_ERRORS = {
  UNAUTHORIZED: {
    code: MCP_ERROR_CODES.Unauthorized,
    error: "unauthorized",
    message: "unauthorized: missing access token",
  },
  TOKEN_EXPIRED: {
    code: MCP_ERROR_CODES.TokenExpired,
    error: "token_expired",
    message: "token_expired: access token has expired",
  },
  INVALID_TOKEN: {
    code: MCP_ERROR_CODES.InvalidToken,
    error: "invalid_token",
    message: "invalid_token: access token is invalid or revoked",
  },
  TOOL_DISABLED: {
    code: MCP_ERROR_CODES.ToolDisabled,
    error: "tool_disabled",
    message:
      "tool_disabled: generate_wallet is not available in partner mode; set KAIA_ALLOW_UNSAFE_WALLET=1 for local development only",
  },
} as const;

export function insufficientScopeError(
  toolName: string,
  scope: string
): {
  code: number;
  error: "insufficient_scope";
  message: string;
} {
  return {
    code: MCP_ERROR_CODES.InsufficientScope,
    error: "insufficient_scope",
    message: `insufficient_scope: ${toolName} requires ${scope}`,
  };
}

export const WWW_AUTHENTICATE_REALM = "kaia-mcp";

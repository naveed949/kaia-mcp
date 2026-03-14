/**
 * Map thrown errors to MCP/JSON-RPC error codes (Phase 3).
 */

export const MCP_ERROR_CODES = {
  Parse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RpcProviderError: -32001,
  KaiaScanApiError: -32002,
  RateLimit: -32003,
} as const;

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);

function isNetworkLike(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "FetchError" || name === "TypeError") {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch|network|failed|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return true;
  }
  return false;
}

function isRateLimitLike(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    if (status === 429) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|429|too many requests/i.test(msg);
}

function isKaiaScanApiLike(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /kaiascan|api\.kaia|scan\.kaia/i.test(msg) || msg.includes("KaiaScan");
}

export interface McpErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Maps any thrown value to an MCP/JSON-RPC error shape.
 * Use for tools/list and tools/call handlers so uncaught errors return proper JSON-RPC errors.
 */
export function toMcpError(err: unknown): McpErrorShape {
  const message = err instanceof Error ? err.message : String(err ?? "Internal error");
  const safeMessage = message || "Internal error";

  if (isRateLimitLike(err))
    return { code: MCP_ERROR_CODES.RateLimit, message: safeMessage, data: err };

  if (isNetworkLike(err))
    return { code: MCP_ERROR_CODES.RpcProviderError, message: safeMessage, data: err };

  if (isKaiaScanApiLike(err))
    return { code: MCP_ERROR_CODES.KaiaScanApiError, message: safeMessage, data: err };

  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: number }).code;
    if (typeof code === "number" && code <= -32000 && code >= -32768)
      return { code, message: safeMessage, data: err };
  }

  return { code: MCP_ERROR_CODES.InternalError, message: safeMessage, data: err };
}

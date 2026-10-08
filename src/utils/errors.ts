/**
 * Map thrown errors to MCP/JSON-RPC error codes (Phase 3).
 *
 * Only errors kaia raises itself about the request (InvalidParamsError, AuthError, and the
 * SDK ProtocolErrors kaia's handlers throw) can be caller mistakes. Anything that comes
 * back from an upstream (the RPC node, KaiaScan) is a server-side failure, whatever JSON-RPC
 * code the upstream used: a node answering -32602 to a request kaia built is not the
 * caller's fault. Upstream failures answer kaia's own codes with a fixed message; the
 * upstream's text (which can carry the RPC URL, and with it an API key, plus the request
 * body) is never sent to the caller. See describeFailure for what is logged instead.
 */

import { BaseError, HttpRequestError, RpcRequestError, TimeoutError } from "viem";

export const MCP_ERROR_CODES = {
  Parse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RpcProviderError: -32001,
  /**
   * -32004, not -32002: MCP SDK v2 rewrites -32002 (the retired ResourceNotFound) to -32602
   * Invalid params on the wire, which would present a KaiaScan outage as a caller mistake.
   */
  KaiaScanApiError: -32004,
  RateLimit: -32003,
  Unauthorized: -32040,
  TokenExpired: -32041,
  InsufficientScope: -32042,
  InvalidToken: -32043,
  ToolDisabled: -32044,
} as const;

export class AuthError extends Error {
  readonly code: number;
  readonly error: string;

  constructor(shape: { code: number; error: string; message: string }) {
    super(shape.message);
    this.name = "AuthError";
    this.code = shape.code;
    this.error = shape.error;
  }
}

/**
 * A tool, resource or prompt argument the caller got wrong (a bad address, ABI, function
 * name or argument list). Maps to JSON-RPC -32602 Invalid params and is logged at info as a
 * client mistake, never as a server fault. Throw it only for input validation, before any
 * upstream call: anything that depends on the server's own state or an upstream service
 * stays a server-side failure.
 */
export class InvalidParamsError extends Error {
  readonly code = MCP_ERROR_CODES.InvalidParams;

  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

/**
 * A KaiaScan request that failed: an HTTP error status, a network error or timeout, or a
 * body that is not JSON. `operation` names the call for the caller ("token holders");
 * `status` is the HTTP status when there was one. The cause is kept for the log only.
 */
export class KaiaScanApiError extends Error {
  readonly operation?: string;
  readonly status?: number;

  constructor(options: { operation?: string; status?: number; cause?: unknown } = {}) {
    const what = options.operation ? ` (${options.operation})` : "";
    const status = options.status !== undefined ? `: HTTP ${options.status}` : "";
    super(`KaiaScan API request failed${what}${status}`, { cause: options.cause });
    this.name = "KaiaScanApiError";
    this.operation = options.operation;
    this.status = options.status;
  }

  /** Re-label a KaiaScan failure with the operation that hit it (keeps status and cause). */
  static wrap(operation: string, err: unknown): KaiaScanApiError {
    if (err instanceof KaiaScanRateLimitError) return new KaiaScanRateLimitError({ operation });
    if (err instanceof KaiaScanApiError) {
      return new KaiaScanApiError({ operation, status: err.status, cause: err.cause });
    }
    return new KaiaScanApiError({ operation, cause: err });
  }
}

/** KaiaScan still answered 429 after one retry. */
export class KaiaScanRateLimitError extends KaiaScanApiError {
  constructor(options: { operation?: string } = {}) {
    super({ operation: options.operation, status: 429 });
    this.name = "KaiaScanRateLimitError";
  }
}

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
  return false;
}

export interface McpErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/** Where a server-side failure came from, for the log line (never sent to the caller). */
export type FailureDescription = {
  /** kaia's JSON-RPC code for it. */
  code: number;
  /** The fixed text the caller gets. */
  message: string;
  /** The upstream JSON-RPC error code, when the RPC node answered with one. */
  upstreamCode?: number;
  /** The upstream HTTP status, when there was one. */
  upstreamStatus?: number;
  /**
   * The upstream's own short description (viem's shortMessage and details, KaiaScan's
   * status, the network error code), for operators. Never the request body or the RPC URL;
   * the logger redacts URL paths, query strings and credentials on top of that.
   */
  detail: string;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "[unprintable]";
  }
}

/** viem's description of an RPC failure, without the URL and request body it also carries. */
function viemDetail(err: BaseError): string {
  const parts = [err.shortMessage];
  const inner = err.walk((e) => e instanceof BaseError && e.details !== undefined);
  const details = inner instanceof BaseError ? inner.details : err.details;
  if (details && details !== err.shortMessage) parts.push(details);
  return parts.join(" | ");
}

const RATE_LIMIT_TEXT = /\b(rate.?limit(ed)?|too many requests)\b/i;

function describeRpc(err: BaseError): FailureDescription {
  let upstreamCode: number | undefined;
  let upstreamStatus: number | undefined;
  err.walk((e) => {
    if (upstreamStatus === undefined && e instanceof HttpRequestError && e.status !== undefined) {
      upstreamStatus = e.status;
    }
    if (upstreamCode === undefined && e instanceof RpcRequestError) {
      upstreamCode = e.code;
    }
    return false;
  });
  if (upstreamCode === undefined) {
    const coded = err.walk(
      (e) => typeof (e as { code?: unknown }).code === "number" && e !== err
    ) as { code?: number } | null;
    const own = (err as unknown as { code?: unknown }).code;
    upstreamCode =
      typeof coded?.code === "number" ? coded.code : typeof own === "number" ? own : undefined;
  }
  const detail = viemDetail(err);
  const timedOut = err.walk((e) => e instanceof TimeoutError) !== null;
  if (upstreamStatus === 429 || RATE_LIMIT_TEXT.test(detail)) {
    return {
      code: MCP_ERROR_CODES.RateLimit,
      message: "Upstream RPC rate limit reached; retry later.",
      upstreamCode,
      upstreamStatus,
      detail,
    };
  }
  return {
    code: MCP_ERROR_CODES.RpcProviderError,
    message: timedOut ? "Upstream RPC request timed out." : "Upstream RPC request failed.",
    upstreamCode,
    upstreamStatus,
    detail,
  };
}

/**
 * Classify a server-side failure (anything that is not an AuthError or InvalidParamsError):
 * kaia's code, the generic caller message and the log-only detail.
 */
export function describeFailure(err: unknown): FailureDescription {
  if (err instanceof KaiaScanApiError) {
    const cause = err.cause;
    const causeText =
      cause === undefined
        ? ""
        : ` | ${errorMessage(cause)}${
            (cause as { cause?: { code?: unknown } })?.cause?.code
              ? ` (${String((cause as { cause: { code: unknown } }).cause.code)})`
              : ""
          }`;
    if (err instanceof KaiaScanRateLimitError) {
      return {
        code: MCP_ERROR_CODES.RateLimit,
        message: "KaiaScan API rate limit reached; retry later.",
        upstreamStatus: 429,
        detail: err.message,
      };
    }
    return {
      code: MCP_ERROR_CODES.KaiaScanApiError,
      message: `${err.message}.`,
      upstreamStatus: err.status,
      detail: `${err.message}${causeText}`,
    };
  }
  if (err instanceof BaseError) return describeRpc(err);
  if (err && typeof err === "object" && (err as { status?: unknown }).status === 429) {
    return {
      code: MCP_ERROR_CODES.RateLimit,
      message: "Upstream rate limit reached; retry later.",
      upstreamStatus: 429,
      detail: errorMessage(err),
    };
  }
  if (isNetworkLike(err)) {
    return {
      code: MCP_ERROR_CODES.RpcProviderError,
      message: "Upstream request failed.",
      detail: `${(err as { code: string }).code} | ${errorMessage(err)}`,
    };
  }
  return {
    code: MCP_ERROR_CODES.InternalError,
    message: "Internal error",
    detail: err === undefined || err === null ? "Internal error" : errorMessage(err),
  };
}

/**
 * Maps any thrown value to the MCP/JSON-RPC error shape sent to the caller.
 * - AuthError and InvalidParamsError keep their code and kaia-authored message.
 * - Every other error gets a fixed, generic message for its class (no upstream text, no
 *   URL, no request body, no stack) and no `data`, apart from the upstream's numeric
 *   JSON-RPC code or HTTP status when there is one.
 */
export function toMcpError(err: unknown): McpErrorShape {
  if (err instanceof AuthError) {
    return { code: err.code, message: err.message, data: { error: err.error } };
  }

  // Before anything else: the caller's own text (a function name containing "429" or
  // "kaiascan") must not turn a validation error into a rate-limit or upstream one.
  if (err instanceof InvalidParamsError) {
    return { code: MCP_ERROR_CODES.InvalidParams, message: err.message || "Invalid params" };
  }

  const f = describeFailure(err);
  const data: Record<string, number> = {};
  if (f.upstreamCode !== undefined) data.upstreamCode = f.upstreamCode;
  if (f.upstreamStatus !== undefined) data.upstreamStatus = f.upstreamStatus;
  return Object.keys(data).length
    ? { code: f.code, message: f.message, data }
    : { code: f.code, message: f.message };
}

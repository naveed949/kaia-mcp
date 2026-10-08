import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Server,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  type AuthInfo,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { getConfig } from "./config.js";
import { AuthError, MCP_ERROR_CODES, toMcpError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { listTools, callTool } from "./tools/index.js";
import { authorizeToolCall, requiredScopeForTool, type ToolAuthOptions } from "./auth/scopes.js";
import { listResources, readResource } from "./resources/index.js";
import { listPrompts, getPrompt } from "./prompts/index.js";
import {
  bearerFromHeader,
  createDemoOAuthProvider,
  type DemoOAuthProvider,
} from "./auth/provider.js";
import { SigningKey } from "./auth/jwt.js";
import {
  FileRevocationStore,
  MemoryRevocationStore,
  type RevocationStore,
} from "./auth/revocation-store.js";
import {
  applyCors,
  authenticateRequest,
  checkOrigin,
  readBody,
  BodyReadError,
  closeConnection,
  tryHandleAuxRequest,
  writeAuthFailure,
  writeInsufficientScope,
} from "./auth/http.js";
import type { AuthContext } from "./auth/types.js";

const SERVER_NAME = "kaia-mcp";
const SERVER_VERSION = "0.1.0";

/** Per-request auth for the createMcpHandler factory (concurrent-safe). */
const authStore = new AsyncLocalStorage<AuthContext | null>();

export type CreateKaiaMcpServerOptions = {
  requireAuth?: boolean;
  getAuthContext?: () => AuthContext | null;
};

/** Coarse class of a JSON-RPC error code, for logs that must not carry the raw message. */
export function errorCategory(code: number): string {
  if (code <= MCP_ERROR_CODES.Unauthorized && code >= MCP_ERROR_CODES.ToolDisabled) return "auth";
  switch (code) {
    case MCP_ERROR_CODES.RpcProviderError:
      return "rpc_provider";
    case MCP_ERROR_CODES.KaiaScanApiError:
      return "kaiascan_api";
    case MCP_ERROR_CODES.RateLimit:
      return "rate_limit";
    case MCP_ERROR_CODES.InvalidParams:
      return "invalid_params";
    case MCP_ERROR_CODES.MethodNotFound:
      return "method_not_found";
    case MCP_ERROR_CODES.InvalidRequest:
      return "invalid_request";
    case MCP_ERROR_CODES.InternalError:
      return "internal";
    default:
      return "other";
  }
}

/** JSON-RPC codes the SDK uses for a request the client got wrong (not a server fault). */
const CLIENT_PROTOCOL_CODES: ReadonlySet<number> = new Set<number>([
  ProtocolErrorCode.ParseError,
  ProtocolErrorCode.InvalidRequest,
  ProtocolErrorCode.MethodNotFound,
  ProtocolErrorCode.InvalidParams,
  -32020, // HeaderMismatch (SEP-2243)
  ProtocolErrorCode.MissingRequiredClientCapability,
  ProtocolErrorCode.UnsupportedProtocolVersion,
]);

/**
 * "Rejected ... (<cell>): <message that may echo caller input>" from createMcpHandler, and
 * the stdio entry's form of the 2025-era rejection ("... on a modern-only stdio connection").
 */
const SDK_REJECTION =
  /^Rejected (?:inbound request|2025-era request on a modern-only (?:endpoint|stdio connection)) \(([^)]{0,200})\):/;
const SDK_CELL_SHAPE = /^[a-z0-9-]{1,64}$/;

/**
 * JSON-RPC code the SDK answers with for each rejection cell (its onerror text carries the
 * cell but not the code). Pinned against the live SDK by server.sdk-error-log.test.ts; a
 * cell missing here is still logged, just without `code`.
 */
const SDK_CELL_CODES: Readonly<Record<string, number>> = {
  // SEP-2243 HeaderMismatch family
  "version-header-missing": -32020,
  "method-header-missing": -32020,
  "name-header-missing": -32020,
  "name-header-invalid-encoding": -32020,
  "name-header-mismatch": -32020,
  "header-body-version-mismatch": -32020,
  "method-header-mismatch": -32020,
  "initialize-with-modern-header": -32020,
  "notification-header-body-version-mismatch": -32020,
  "notification-method-header-mismatch": -32020,
  "param-header-missing": -32020,
  "param-header-invalid-encoding": -32020,
  "param-header-mismatch": -32020,
  // envelope / shape
  "envelope-invalid": ProtocolErrorCode.InvalidParams,
  "notification-envelope-invalid": ProtocolErrorCode.InvalidParams,
  "modern-header-without-claim": ProtocolErrorCode.InvalidParams,
  "empty-batch": ProtocolErrorCode.InvalidRequest,
  "batch-with-modern-element": ProtocolErrorCode.InvalidRequest,
  "batch-with-invalid-element": ProtocolErrorCode.InvalidRequest,
  "invalid-json-rpc-body": ProtocolErrorCode.InvalidRequest,
  // 2025-era request on a modern-only endpoint or stdio connection
  "modern-only-missing-envelope": ProtocolErrorCode.UnsupportedProtocolVersion,
  "modern-only-batch-not-supported": ProtocolErrorCode.InvalidRequest,
  "modern-only-response-post": ProtocolErrorCode.InvalidRequest,
  "modern-only-method-not-allowed": -32000,
};

/**
 * The exact messages the stdio entry reports when it drops a client message it cannot use
 * (a response before the era is negotiated, a notification with a bad envelope or
 * revision). Notifications get no JSON-RPC answer, so the code is the one the SDK gives
 * the same problem on a request. A message with no caller part must equal the SDK text;
 * one that ends in caller input is matched on the SDK's whole fixed part, up to and
 * including its separator, and the rest is never logged. Any other "Discarded ..."
 * message (a future SDK wording, the server-side probe timeout) is not a known client
 * mistake and stays at error. server.stdio-log.test.ts pins these against the SDK.
 */
const SDK_STDIO_DISCARDS: ReadonlyArray<
  readonly [match: "exact" | "prefix", text: string, cell: string, code: number]
> = [
  [
    "exact",
    "Discarded a JSON-RPC response received before the connection negotiated an era",
    "response-before-negotiation",
    ProtocolErrorCode.InvalidRequest,
  ],
  [
    "prefix",
    "Discarded a notification with a malformed envelope: ",
    "notification-envelope-invalid",
    ProtocolErrorCode.InvalidParams,
  ],
  [
    "prefix",
    "Discarded a notification claiming unsupported protocol revision ",
    "notification-unsupported-revision",
    ProtocolErrorCode.UnsupportedProtocolVersion,
  ],
];

/**
 * Rejections from the SDK's legacy (2025) transport, matched on their fixed SDK prefix
 * only; the rest of those messages can carry a header value, so it is never logged.
 */
const SDK_CLIENT_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["Bad Request: Unsupported protocol version", "unsupported-protocol-version"],
  ["Not Acceptable:", "not-acceptable"],
  ["Unsupported Media Type:", "unsupported-media-type"],
  ["Payload Too Large:", "payload-too-large"],
  ["Invalid Request:", "invalid-request"],
  ["Bad Request:", "bad-request"],
  ["Parse error", "parse-error"],
  ["Method not allowed", "method-not-allowed"],
  ["Invalid Host header", "invalid-host-or-origin"],
  ["Invalid Origin header", "invalid-host-or-origin"],
];

export type SdkErrorLogEntry = {
  level: "info" | "error";
  message: string;
  meta: { cell?: string; code?: number; errorType: string; detail?: string };
};

/**
 * What to log for an error the MCP SDK hands to `onerror` (HTTP handler and stdio), and
 * for an error caught by the HTTP request handler itself.
 *
 * SDK messages routinely echo caller input: the 2026-07-28 ladder puts `params.name`,
 * `Mcp-Name`, `Mcp-Method`, `MCP-Protocol-Version` and the `_meta` version into its
 * rejection text, and the legacy transport echoes header values. Logging that verbatim let
 * a token holder forge audit fragments (`msg=Tool call tool=... outcome=allowed`) and write
 * megabytes per request. So the raw message is never logged:
 * - a client-caused rejection logs a fixed message, the SDK's rejection cell (only if it has
 *   the SDK's own `[a-z0-9-]` shape) and the JSON-RPC code, at info;
 * - anything else logs at error with the error type, code, and a `detail` holding the
 *   message, which the logger caps and percent-encodes like every other value.
 */
export function sdkErrorLogEntry(err: unknown): SdkErrorLogEntry {
  const message = err instanceof Error ? err.message : String(err);
  const errorType = err instanceof Error ? err.name : typeof err;
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode : undefined;
  const withCode = <M extends SdkErrorLogEntry["meta"]>(meta: M): M =>
    code === undefined ? meta : { code, ...meta };

  const rejected = SDK_REJECTION.exec(message);
  if (rejected) {
    const cell = SDK_CELL_SHAPE.test(rejected[1]) ? rejected[1] : "unknown";
    const cellCode = Object.hasOwn(SDK_CELL_CODES, cell) ? SDK_CELL_CODES[cell] : code;
    const meta = cellCode === undefined ? { cell, errorType } : { code: cellCode, cell, errorType };
    return { level: "info", message: "MCP request rejected", meta };
  }
  if (err instanceof ProtocolError && CLIENT_PROTOCOL_CODES.has(err.code)) {
    return {
      level: "info",
      message: "MCP request rejected",
      meta: { code: err.code, cell: "protocol-error", errorType },
    };
  }
  for (const [match, text, cell, cellCode] of SDK_STDIO_DISCARDS) {
    if (match === "exact" ? message === text : message.startsWith(text)) {
      return {
        level: "info",
        message: "MCP request rejected",
        meta: { code: cellCode, cell, errorType },
      };
    }
  }
  for (const [prefix, cell] of SDK_CLIENT_PREFIXES) {
    if (message.startsWith(prefix)) {
      return {
        level: "info",
        message: "MCP request rejected",
        meta: withCode({ cell, errorType }),
      };
    }
  }
  if (err instanceof SyntaxError || errorType.endsWith("ZodError")) {
    const cell = err instanceof SyntaxError ? "parse-error" : "invalid-message";
    return { level: "info", message: "MCP request rejected", meta: withCode({ cell, errorType }) };
  }
  return {
    level: "error",
    message: "MCP transport error",
    meta: withCode({ errorType, detail: message }),
  };
}

/** onerror for the SDK handler and stdio transport: never logs raw SDK text. */
function logSdkError(err: unknown): void {
  const entry = sdkErrorLogEntry(err);
  // Inside an HTTP request the auth context is in ALS: tie the rejection to the token.
  const tokenFingerprint = authStore.getStore()?.tokenFingerprint;
  logger[entry.level](entry.message, { ...entry.meta, tokenFingerprint });
}

/**
 * Handler error codes that mean the client asked for something it cannot have (an unknown
 * tool, resource or prompt name, bad arguments, a missing or under-scoped token): logged
 * at info as a denial, not at error. Everything else is a server-side fault.
 */
const CLIENT_HANDLER_CODES: ReadonlySet<number> = new Set<number>([
  MCP_ERROR_CODES.Parse,
  MCP_ERROR_CODES.InvalidRequest,
  MCP_ERROR_CODES.MethodNotFound,
  MCP_ERROR_CODES.InvalidParams,
  MCP_ERROR_CODES.Unauthorized,
  MCP_ERROR_CODES.TokenExpired,
  MCP_ERROR_CODES.InsufficientScope,
  MCP_ERROR_CODES.InvalidToken,
  MCP_ERROR_CODES.ToolDisabled,
]);

function wrapToolHandler<T, R>(
  method: string,
  handler: (req: T) => R | Promise<R>
): (req: T, extra: unknown) => Promise<R> {
  return async (req: T, _extra: unknown) => {
    try {
      return await Promise.resolve(handler(req));
    } catch (err) {
      const mcp =
        err instanceof ProtocolError ? { code: err.code, data: err.data } : toMcpError(err);
      // Code and category only: tool, resource and prompt error messages routinely echo
      // caller input (e.g. 'Function "X" not found on ABI', an unknown uri or name).
      const errorType = err instanceof Error ? err.name : typeof err;
      if (CLIENT_HANDLER_CODES.has(mcp.code)) {
        logger.info("Request denied", {
          method,
          code: mcp.code,
          category: errorCategory(mcp.code),
          errorType,
          outcome: "denied",
        });
      } else {
        logger.error("Tool error", {
          code: mcp.code,
          category: errorCategory(mcp.code),
          errorType,
        });
      }
      if (err instanceof ProtocolError) throw err;
      const shape = toMcpError(err);
      throw new ProtocolError(shape.code, shape.message, shape.data);
    }
  };
}

/**
 * Creates and returns the Kaia MCP server instance.
 * Registers account tools and tools/list + tools/call handlers with error mapping.
 *
 * Cache hints (SEP-2549): tools/list is always cacheScope "private" because the list is
 * filtered by the caller's token scopes — never advertise a shared/public cache for it.
 * ttlMs is fixed at 0 (immediately stale) for every list; there is no setting to change it.
 * Only methods kaia serves get a hint (it registers no resource templates).
 */
export function createKaiaMcpServer(options: CreateKaiaMcpServerOptions = {}): Server {
  const requireAuth = Boolean(options.requireAuth);
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      cacheHints: {
        "tools/list": { ttlMs: 0, cacheScope: "private" },
        "prompts/list": { ttlMs: 0, cacheScope: "public" },
        "resources/list": { ttlMs: 0, cacheScope: "public" },
      },
    }
  );

  const authOpts = () => ({
    requireAuth,
    auth: options.getAuthContext?.() ?? null,
  });

  server.setRequestHandler(
    "tools/list",
    wrapToolHandler("tools/list", () => listTools(authOpts()))
  );

  server.setRequestHandler(
    "tools/call",
    wrapToolHandler("tools/call", async (request) => {
      const { name, arguments: args } = request.params;
      // One audit line per call, written after the authorization decision and carrying its
      // outcome. Never logs arguments or token material (only the sha256 fingerprint). The
      // tool name is caller input; the logger caps and percent-encodes it.
      let opts: ToolAuthOptions | undefined;
      try {
        opts = authOpts();
        authorizeToolCall(name, opts);
        // Fail closed: a name outside the scope map is never "allowed", with or without auth.
        if (requiredScopeForTool(name) === undefined) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }
      } catch (err) {
        const denial =
          err instanceof AuthError
            ? { errorCode: err.code, reason: err.error }
            : err instanceof ProtocolError && err.code === ProtocolErrorCode.InvalidParams
              ? { errorCode: err.code, reason: "unknown_tool" }
              : { errorCode: MCP_ERROR_CODES.InternalError, reason: "internal_error" };
        logger.info("Tool call", {
          tool: name,
          outcome: "denied",
          // Not `code`: the logger hoists `code` ahead of `tool`, and gateways (s1-tool-gate's
          // live e2e) match the stable prefix "msg=Tool call tool=<name> " for every call.
          ...denial,
          tokenFingerprint: opts?.auth?.tokenFingerprint,
        });
        if (denial.reason === "internal_error") {
          // Do not hand internal exception text to the caller.
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            "Internal error: authorization failed"
          );
        }
        throw err;
      }
      logger.info("Tool call", {
        tool: name,
        outcome: "allowed",
        tokenFingerprint: opts.auth?.tokenFingerprint,
      });
      return callTool(name, (args ?? {}) as Record<string, unknown>, opts);
    })
  );

  server.setRequestHandler(
    "resources/list",
    wrapToolHandler("resources/list", () => listResources())
  );

  server.setRequestHandler(
    "resources/read",
    wrapToolHandler("resources/read", async (request) => {
      const uri = request.params?.uri ?? "";
      return readResource(uri);
    })
  );

  server.setRequestHandler(
    "prompts/list",
    wrapToolHandler("prompts/list", () => listPrompts())
  );

  server.setRequestHandler(
    "prompts/get",
    wrapToolHandler("prompts/get", async (request) => {
      const name = request.params?.name ?? "";
      const args = request.params?.arguments;
      return getPrompt(name, args);
    })
  );

  return server;
}

/**
 * Runs the Kaia MCP server over stdio (for CLI use).
 * Validates config at startup (fail-fast on bad env).
 * Stdio is local-process only: OAuth is not applied. generate_wallet stays disabled unless the unsafe flag is set.
 * Uses serveStdio so the connection can speak 2026-07-28 (server/discover) or fall back to
 * the 2025 initialize handshake. `transport` defaults to the process's stdio (tests pass a
 * StdioServerTransport over in-memory streams).
 */
export async function runKaiaMcpServer(
  options: { transport?: Transport } = {}
): Promise<StdioServerHandle> {
  getConfig();
  logger.info("Starting Kaia MCP server (stdio)");
  return serveStdio(() => createKaiaMcpServer({ requireAuth: false }), {
    onerror: logSdkError,
    ...(options.transport ? { transport: options.transport } : {}),
  });
}

/**
 * Ensure the incoming request carries the Accept types the MCP SDK requires (both
 * application/json and text/event-stream on POST). Many MCP clients (Cursor, curl, etc.)
 * omit these, and the SDK's 2025-era (legacy) transport answers 406 without them.
 *
 * toNodeHandler builds the web Request from `req.headers`, so patching that object is
 * enough.
 */
function normalizeAcceptHeader(req: IncomingMessage): void {
  const current = req.headers["accept"] ?? "";
  const missing: string[] = [];

  if (!current.includes("application/json")) missing.push("application/json");
  if (!current.includes("text/event-stream")) missing.push("text/event-stream");

  if (missing.length === 0) return;

  req.headers["accept"] = current ? `${current}, ${missing.join(", ")}` : missing.join(", ");
}

export type KaiaHttpServerHandle = {
  port: number;
  /** OAuth issuer and canonical resource URI: KAIA_PUBLIC_URL, or http://127.0.0.1:<port>. */
  issuer: string;
  /** Public MCP endpoint URL (same as `issuer`; the MCP endpoint is served at /). */
  mcpUrl: string;
  /** Where this process actually listens: http://127.0.0.1:<port>. */
  localUrl: string;
  close: () => Promise<void>;
  oauth: DemoOAuthProvider;
};

/** Largest MCP POST body accepted (the SDK's own default limit). */
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Deepest JSON nesting accepted in an MCP POST body. A tools/call's `arguments` object is
 * level 3, so this leaves 61 levels for argument values. Without it a body of a few thousand
 * nested arrays overflowed the SDK's recursive validation, which answered 500 and never
 * reached onerror, so nothing was logged.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * True when `raw` nests objects/arrays deeper than `max`. One linear pass over the text,
 * skipping string contents (and escapes in them); run before JSON.parse.
 */
export function jsonNestingExceeds(raw: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) {
        i++; // backslash: skip the escaped character
      } else if (c === 0x22) {
        inString = false;
      }
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return false;
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

type AuthedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

function toAuthInfo(token: string, context: AuthContext): AuthInfo {
  return {
    token,
    clientId: context.clientId,
    scopes: [...context.scopes],
    expiresAt: Math.floor(context.expiresAtMs / 1000),
  };
}

/**
 * Runs the Kaia MCP server over Streamable HTTP on the given port, via SDK v2
 * `createMcpHandler` (protocol 2026-07-28, with `legacy: 'stateless'` for 2025-era
 * clients). There are no protocol-level sessions: every POST gets a fresh server from
 * the factory, so `Mcp-Session-Id` is never minted or echoed and any instance behind a
 * load balancer can answer any request. GET and DELETE on the MCP endpoint are 405.
 * HeaderMismatch (-32020) for Mcp-Method / Mcp-Name / MCP-Protocol-Version is enforced
 * by the SDK on the modern path. Validates config at startup.
 *
 * Partner default (KAIA_AUTH_MODE=required): every MCP request must carry a Bearer
 * access token, and that request's token is the only authority for it. Token scopes are
 * mapped onto the allowed-tool registry. Missing, expired, or revoked tokens fail closed
 * with no tool side effects.
 */
export async function runKaiaMcpServerHttp(port: number): Promise<KaiaHttpServerHandle> {
  const { createServer } = await import("node:http");

  const config = getConfig();
  const authMode = config.authMode;
  logger.info("Starting Kaia MCP server (HTTP)", { port, authMode });

  // Load key material and the revocation denylist before binding the port, so an
  // unreadable or corrupt store refuses startup instead of serving with an empty list.
  const signingKey = config.oauthSigningKeyFile
    ? SigningKey.fromFileOrCreate(config.oauthSigningKeyFile)
    : SigningKey.generate();
  const previousSigningKeys = config.oauthPreviousSigningKeyFiles.map((file) => {
    try {
      return SigningKey.fromFile(file);
    } catch (err) {
      throw new Error(`previous signing key ${file} is unreadable`, { cause: err });
    }
  });
  // A file store holds a lock on its file until close(): every exit path below that does
  // not hand the store to a running server must release it.
  const revocationStore: RevocationStore = config.oauthRevocationFile
    ? FileRevocationStore.open(config.oauthRevocationFile)
    : new MemoryRevocationStore();

  const runtime: { provider?: DemoOAuthProvider } = {};
  /** The public origin is appended once the port is bound (it may default to it). */
  const allowedOrigins: string[] = [...config.allowedOrigins];

  const mcpHandler = createMcpHandler(
    () =>
      createKaiaMcpServer({
        requireAuth: authMode === "required",
        getAuthContext: () => authStore.getStore() ?? null,
      }),
    {
      // Default: serve 2026-07-28 and fall back to per-request 2025-era initialize.
      legacy: "stateless",
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
      onerror: logSdkError,
    }
  );
  const nodeHandler = toNodeHandler(mcpHandler, { maxRequestBodySize: MAX_MCP_BODY_BYTES });

  /**
   * HTTP-level scope check for tools/call (MCP 2026-07-28 runtime insufficient scope):
   * a valid token lacking the tool's scope gets 403 + Bearer error="insufficient_scope"
   * before any server is built. Only the insufficient-scope outcome of the same
   * authorizeToolCall gate is handled here; tool_disabled, unknown tools and the rest
   * stay in-band JSON-RPC errors from the handler (which re-checks everything anyway).
   * A batch is refused whole on its first under-scoped call.
   */
  function rejectInsufficientScope(
    res: ServerResponse,
    parsedBody: unknown,
    auth: AuthContext | null
  ): boolean {
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const { method, params, id } = msg as { method?: unknown; params?: unknown; id?: unknown };
      if (method !== "tools/call" || !params || typeof params !== "object") continue;
      const name = (params as { name?: unknown }).name;
      if (typeof name !== "string") continue;
      try {
        authorizeToolCall(name, { requireAuth: true, auth });
      } catch (err) {
        if (!(err instanceof AuthError) || err.code !== MCP_ERROR_CODES.InsufficientScope) continue;
        logger.info("Tool call", {
          tool: name,
          outcome: "denied",
          errorCode: err.code,
          reason: err.error,
          tokenFingerprint: auth?.tokenFingerprint,
        });
        writeInsufficientScope(res, {
          id: typeof id === "string" || typeof id === "number" ? id : null,
          scope: requiredScopeForTool(name) ?? "",
          message: err.message,
          resourceMetadataUrl: runtime.provider!.resourceMetadataUrl,
        });
        return true;
      }
    }
    return false;
  }

  const httpServer = createServer(async (req, res) => {
    // Origin first: a foreign browser origin is refused before auth or any handler runs.
    if (!checkOrigin(req, res, allowedOrigins)) return;
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let auth: AuthContext | null = null;
    try {
      const handled = await tryHandleAuxRequest(req, res, {
        provider: runtime.provider!,
        authMode,
        unsafeWallet: config.allowUnsafeWallet,
      });
      if (handled) return;

      // MCP 2026-07-28 Streamable HTTP is POST only: no standalone GET stream and no
      // session to DELETE. (createMcpHandler would also 405 these; we answer before auth.)
      if (req.method !== "POST") {
        jsonRpcError(res, 405, -32000, "Method not allowed: the MCP endpoint accepts POST only", {
          Allow: "POST",
        });
        return;
      }

      normalizeAcceptHeader(req);

      let authInfo: AuthInfo | undefined;
      if (authMode === "required") {
        const header = req.headers.authorization;
        const result = authenticateRequest(req, runtime.provider!);
        if (!result.ok) {
          writeAuthFailure(res, result, runtime.provider!.resourceMetadataUrl);
          return;
        }
        auth = result.context;
        const token = bearerFromHeader(Array.isArray(header) ? undefined : header);
        if (token) authInfo = toAuthInfo(token, result.context);
        logger.debug("MCP request authenticated", {
          tokenFingerprint: result.context.tokenFingerprint,
          scopes: result.context.scopes.join(" "),
        });
      }

      let raw: string;
      try {
        raw = await readBody(req, MAX_MCP_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof BodyReadError)) throw err;
        closeConnection(res);
        if (err.status === 413) {
          jsonRpcError(res, 413, -32600, "Invalid Request: body is too large");
        } else {
          jsonRpcError(res, 400, -32600, "Invalid Request: body could not be read");
        }
        return;
      }
      if (jsonNestingExceeds(raw, MAX_JSON_DEPTH)) {
        logger.info("MCP request rejected", {
          code: ProtocolErrorCode.ParseError,
          cell: "json-too-deep",
          tokenFingerprint: auth?.tokenFingerprint,
        });
        jsonRpcError(res, 400, -32700, "Parse error: body is nested too deeply");
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error: body is not valid JSON");
        return;
      }

      if (authMode === "required" && rejectInsufficientScope(res, parsedBody, auth)) return;

      const authedReq = req as AuthedIncomingMessage;
      if (authInfo) authedReq.auth = authInfo;

      await authStore.run(auth, () => nodeHandler(authedReq, res, parsedBody));
    } catch (err) {
      // The error may come from inside the SDK handler: same no-raw-text rule as onerror.
      const entry = sdkErrorLogEntry(err);
      logger.error("HTTP request error", {
        ...entry.meta,
        tokenFingerprint: auth?.tokenFingerprint,
      });
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  const actualPort = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolve(bound);
    });
  }).catch((err: unknown) => {
    revocationStore.close?.();
    throw err;
  });

  const localUrl = `http://127.0.0.1:${actualPort}`;
  const issuer = config.publicUrl ?? localUrl;
  if (!allowedOrigins.includes(issuer)) allowedOrigins.push(issuer);
  try {
    runtime.provider = createDemoOAuthProvider({
      issuer,
      clientId: config.oauthClientId,
      accessTokenTtlSeconds: config.accessTokenTtlSeconds,
      resource: issuer,
      legacyAudience: config.oauthLegacyAudience,
      requireResource: config.oauthRequireResource,
      signingKey,
      previousSigningKeys,
      revocationStore,
      introspectionClient: config.introspectionClientSecret
        ? { clientId: config.introspectionClientId, clientSecret: config.introspectionClientSecret }
        : undefined,
    });
  } catch (err) {
    httpServer.close();
    revocationStore.close?.();
    throw err;
  }

  logger.info("HTTP server listening", {
    port: actualPort,
    issuer,
    authMode,
    resource: runtime.provider.resource,
    legacyAudience: runtime.provider.legacyAudience ?? "none",
    requireResource: runtime.provider.requireResource,
    kid: runtime.provider.signingKey.kid,
    previousKids: runtime.provider.previousSigningKeys.map((k) => k.kid).join(",") || "none",
    introspection: runtime.provider.introspectionEnabled,
    revocationStore: config.oauthRevocationFile ? "file" : "memory",
    sdk: "v2-createMcpHandler",
    protocol: "2026-07-28+legacy-stateless",
  });

  return {
    port: actualPort,
    issuer,
    mcpUrl: issuer,
    localUrl,
    oauth: runtime.provider!,
    close: async () => {
      // A failed handler close is logged, not propagated: the HTTP server, its connections
      // and the revocation store lock must still be released, with no unhandled rejection.
      try {
        await mcpHandler.close();
      } catch (err) {
        logger.warn("MCP handler close failed", sdkErrorLogEntry(err).meta);
      }
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          revocationStore.close?.();
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

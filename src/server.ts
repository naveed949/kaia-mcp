import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig } from "./config.js";
import { AuthError, MCP_ERROR_CODES, toMcpError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { listTools, callTool } from "./tools/index.js";
import { authorizeToolCall, requiredScopeForTool, type ToolAuthOptions } from "./auth/scopes.js";
import { listResources, readResource } from "./resources/index.js";
import { listPrompts, getPrompt } from "./prompts/index.js";
import { createDemoOAuthProvider, type DemoOAuthProvider } from "./auth/provider.js";
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
  tryHandleAuxRequest,
  writeAuthFailure,
  writeInsufficientScope,
} from "./auth/http.js";
import type { AuthContext } from "./auth/types.js";

const SERVER_NAME = "kaia-mcp";
const SERVER_VERSION = "0.1.0";

export type CreateKaiaMcpServerOptions = {
  requireAuth?: boolean;
  getAuthContext?: () => AuthContext | null;
};

/**
 * A caller-supplied name, safe for one key=value log field: names made only of
 * [A-Za-z0-9_.-] (every real tool) pass through unchanged; anything else is
 * percent-encoded byte by byte (UTF-8), so spaces, '=', CR/LF and control characters
 * can never appear raw, and it is capped at 128 bytes.
 */
export function logSafeName(value: unknown): string {
  const s = typeof value === "string" ? value : String(value);
  if (/^[A-Za-z0-9_.-]{1,128}$/.test(s)) return s;
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes.subarray(0, 128)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9_.-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return bytes.length > 128 ? `${out}%E2%80%A6` : out;
}

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

function wrapToolHandler<T, R>(
  handler: (req: T) => R | Promise<R>
): (req: T, extra: unknown) => Promise<R> {
  return async (req: T, _extra: unknown) => {
    try {
      return await Promise.resolve(handler(req));
    } catch (err) {
      const mcp = err instanceof McpError ? { code: err.code, data: err.data } : toMcpError(err);
      // Code and category only: tool, resource and prompt error messages routinely echo
      // caller input (e.g. 'Function "X" not found on ABI', an unknown uri or name).
      logger.error("Tool error", {
        code: mcp.code,
        category: errorCategory(mcp.code),
        errorType: logSafeName(err instanceof Error ? err.name : typeof err),
      });
      if (err instanceof McpError) throw err;
      const shape = toMcpError(err);
      throw new McpError(shape.code, shape.message, shape.data);
    }
  };
}

/**
 * Creates and returns the Kaia MCP server instance.
 * Registers account tools (get_kaia_balance, get_account_info, get_account_tokens, get_account_nfts) and tools/list + tools/call handlers with error mapping.
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
    }
  );

  const authOpts = () => ({
    requireAuth,
    auth: options.getAuthContext?.() ?? null,
  });

  server.setRequestHandler(
    ListToolsRequestSchema,
    wrapToolHandler(() => listTools(authOpts()))
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    wrapToolHandler(async (request) => {
      const { name, arguments: args } = request.params;
      // One audit line per call, written after the authorization decision and carrying its
      // outcome. Never logs arguments or token material (only the sha256 fingerprint). The
      // tool name is caller input, so it is logged through logSafeName.
      const tool = logSafeName(name);
      let opts: ToolAuthOptions | undefined;
      try {
        opts = authOpts();
        authorizeToolCall(name, opts);
        // Fail closed: a name outside the scope map is never "allowed", with or without auth.
        if (requiredScopeForTool(name) === undefined) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }
      } catch (err) {
        const denial =
          err instanceof AuthError
            ? { errorCode: err.code, reason: err.error }
            : err instanceof McpError && err.code === ErrorCode.InvalidParams
              ? { errorCode: err.code, reason: "unknown_tool" }
              : { errorCode: MCP_ERROR_CODES.InternalError, reason: "internal_error" };
        logger.info("Tool call", {
          tool,
          outcome: "denied",
          // Not `code`: the logger hoists `code` ahead of `tool`, and gateways (s1-tool-gate's
          // live e2e) match the stable prefix "msg=Tool call tool=<name> " for every call.
          ...denial,
          tokenFingerprint: opts?.auth?.tokenFingerprint,
        });
        if (denial.reason === "internal_error") {
          // Do not hand internal exception text to the caller.
          throw new McpError(ErrorCode.InternalError, "Internal error: authorization failed");
        }
        throw err;
      }
      logger.info("Tool call", {
        tool,
        outcome: "allowed",
        tokenFingerprint: opts.auth?.tokenFingerprint,
      });
      return callTool(name, (args ?? {}) as Record<string, unknown>, opts);
    })
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    wrapToolHandler(() => listResources())
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    wrapToolHandler(async (request) => {
      const uri = request.params?.uri ?? "";
      return readResource(uri);
    })
  );

  server.setRequestHandler(
    ListPromptsRequestSchema,
    wrapToolHandler(() => listPrompts())
  );

  server.setRequestHandler(
    GetPromptRequestSchema,
    wrapToolHandler(async (request) => {
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
 */
export async function runKaiaMcpServer(): Promise<void> {
  getConfig();
  logger.info("Starting Kaia MCP server (stdio)");
  const server = createKaiaMcpServer({ requireAuth: false });
  const transport = new StdioServerTransport();
  server.onerror = (err) => logger.error("Server transport error", { error: err });
  await server.connect(transport);
}

/**
 * Ensure the incoming request carries the Accept types the MCP SDK
 * requires (text/event-stream for GET; both application/json and
 * text/event-stream for POST). Many MCP clients (Cursor, curl, etc.)
 * omit these, which causes the SDK to return 406.
 *
 * The SDK's transport uses @hono/node-server which reads rawHeaders,
 * so we must patch both the parsed headers object and the raw array.
 */
function normalizeAcceptHeader(req: IncomingMessage): void {
  const current = (req.headers["accept"] as string | undefined) ?? "";
  const missing: string[] = [];

  if (!current.includes("application/json")) missing.push("application/json");
  if (!current.includes("text/event-stream")) missing.push("text/event-stream");

  if (missing.length === 0) return;

  const patched = current ? `${current}, ${missing.join(", ")}` : missing.join(", ");

  req.headers["accept"] = patched;

  let found = false;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "accept") {
      req.rawHeaders[i + 1] = patched;
      found = true;
      break;
    }
  }
  if (!found) {
    req.rawHeaders.push("Accept", patched);
  }
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

/**
 * Runs the Kaia MCP server over Streamable HTTP on the given port, stateless per MCP
 * 2026-07-28: there are no protocol-level sessions. Every POST gets a fresh server and
 * transport (`sessionIdGenerator: undefined`), so `Mcp-Session-Id` is never minted or
 * echoed (a legacy client's header is ignored) and any instance behind a load balancer
 * can answer any request. GET and DELETE on the MCP endpoint are 405. Validates config
 * at startup.
 *
 * Partner default (KAIA_AUTH_MODE=required): every MCP request must carry a Bearer
 * access token, and that request's token is the only authority for it. Token scopes are
 * mapped onto the allowed-tool registry. Missing, expired, or revoked tokens fail closed
 * with no tool side effects.
 */
export async function runKaiaMcpServerHttp(port: number): Promise<KaiaHttpServerHandle> {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

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
  const revocationStore: RevocationStore = config.oauthRevocationFile
    ? FileRevocationStore.open(config.oauthRevocationFile)
    : new MemoryRevocationStore();

  const runtime: { provider?: DemoOAuthProvider } = {};
  /** The public origin is appended once the port is bound (it may default to it). */
  const allowedOrigins: string[] = [...config.allowedOrigins];

  /** One JSON-RPC POST: a fresh server+transport, torn down when the response ends. */
  async function serveMcpPost(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext | null,
    parsedBody: unknown
  ): Promise<void> {
    const server = createKaiaMcpServer({
      requireAuth: authMode === "required",
      getAuthContext: () => auth,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    server.onerror = (err) => logger.error("Server transport error", { error: err });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

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
          tool: logSafeName(name),
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

    try {
      const handled = await tryHandleAuxRequest(req, res, {
        provider: runtime.provider!,
        authMode,
        unsafeWallet: config.allowUnsafeWallet,
      });
      if (handled) return;

      // MCP 2026-07-28 Streamable HTTP is POST only: no standalone GET stream and no
      // session to DELETE.
      if (req.method !== "POST") {
        jsonRpcError(res, 405, -32000, "Method not allowed: the MCP endpoint accepts POST only", {
          Allow: "POST",
        });
        return;
      }

      normalizeAcceptHeader(req);

      let auth: AuthContext | null = null;
      if (authMode === "required") {
        const result = authenticateRequest(req, runtime.provider!);
        if (!result.ok) {
          writeAuthFailure(res, result, runtime.provider!.resourceMetadataUrl);
          return;
        }
        auth = result.context;
        logger.debug("MCP request authenticated", {
          tokenFingerprint: result.context.tokenFingerprint,
          scopes: result.context.scopes.join(" "),
        });
      }

      let raw: string;
      try {
        raw = await readBody(req, MAX_MCP_BODY_BYTES);
      } catch {
        jsonRpcError(res, 413, -32600, "Invalid Request: body is too large");
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

      await serveMcpPost(req, res, auth, parsedBody);
    } catch (err) {
      logger.error("HTTP request error", { error: err });
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
  });

  const localUrl = `http://127.0.0.1:${actualPort}`;
  const issuer = config.publicUrl ?? localUrl;
  if (!allowedOrigins.includes(issuer)) allowedOrigins.push(issuer);
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
  });

  return {
    port: actualPort,
    issuer,
    mcpUrl: issuer,
    localUrl,
    oauth: runtime.provider!,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (typeof httpServer.closeAllConnections === "function") {
          httpServer.closeAllConnections();
        }
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

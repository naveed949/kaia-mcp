import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage } from "node:http";
import { getConfig } from "./config.js";
import { AuthError, toMcpError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { listTools, callTool } from "./tools/index.js";
import { authorizeToolCall } from "./auth/scopes.js";
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
  tryHandleAuxRequest,
  writeAuthFailure,
} from "./auth/http.js";
import type { AuthContext } from "./auth/types.js";

const SERVER_NAME = "kaia-mcp";
const SERVER_VERSION = "0.1.0";

export type CreateKaiaMcpServerOptions = {
  requireAuth?: boolean;
  getAuthContext?: () => AuthContext | null;
};

function wrapToolHandler<T, R>(
  handler: (req: T) => R | Promise<R>
): (req: T, extra: unknown) => Promise<R> {
  return async (req: T, _extra: unknown) => {
    try {
      return await Promise.resolve(handler(req));
    } catch (err) {
      const mcp = toMcpError(err);
      logger.error("Tool error", { error: err, code: mcp.code });
      throw new McpError(mcp.code, mcp.message, mcp.data);
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
      const opts = authOpts();
      // One audit line per call, written after the authorization decision and carrying its
      // outcome. Never logs arguments or token material (only the sha256 fingerprint).
      const tokenFingerprint = opts.auth?.tokenFingerprint;
      try {
        authorizeToolCall(name, opts);
      } catch (err) {
        if (err instanceof AuthError) {
          logger.info("Tool call", {
            tool: name,
            outcome: "denied",
            // Not `code`: the logger hoists `code` ahead of `tool`, and gateways (s1-tool-gate's
            // live e2e) match the stable prefix "msg=Tool call tool=<name> " for every call.
            errorCode: err.code,
            reason: err.error,
            tokenFingerprint,
          });
        }
        throw err;
      }
      logger.info("Tool call", { tool: name, outcome: "allowed", tokenFingerprint });
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
  issuer: string;
  mcpUrl: string;
  close: () => Promise<void>;
  oauth: DemoOAuthProvider;
};

/**
 * Runs the Kaia MCP server over Streamable HTTP on the given port.
 * Creates a per-session transport+server pair so multiple clients can
 * connect concurrently. Validates config at startup.
 *
 * Partner default (KAIA_AUTH_MODE=required): every MCP request must carry a
 * Bearer access token. Token scopes are mapped onto the allowed-tool registry
 * for that session. Missing, expired, or revoked tokens fail closed with no
 * tool side effects.
 */
export async function runKaiaMcpServerHttp(port: number): Promise<KaiaHttpServerHandle> {
  const { randomUUID } = await import("node:crypto");
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
  const revocationStore: RevocationStore = config.oauthRevocationFile
    ? FileRevocationStore.open(config.oauthRevocationFile)
    : new MemoryRevocationStore();

  type SessionEntry = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: Server;
    setAuth: (ctx: AuthContext | null) => void;
  };
  const sessions = new Map<string, SessionEntry>();

  const runtime: { provider?: DemoOAuthProvider } = {};

  function createSession(initialAuth: AuthContext | null): SessionEntry {
    let auth = initialAuth;
    const server = createKaiaMcpServer({
      requireAuth: authMode === "required",
      getAuthContext: () => auth,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        logger.info("Session initialized", { sessionId, tokenFingerprint: auth?.tokenFingerprint });
        sessions.set(sessionId, entry);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        logger.info("Session closed", { sessionId: sid });
        sessions.delete(sid);
      }
    };
    server.onerror = (err) => logger.error("Server transport error", { error: err });
    const entry: SessionEntry = {
      transport,
      server,
      setAuth: (ctx) => {
        auth = ctx;
      },
    };
    return entry;
  }

  const httpServer = createServer(async (req, res) => {
    applyCors(res);
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

      normalizeAcceptHeader(req);

      let sessionAuth: AuthContext | null = null;
      if (authMode === "required") {
        const result = authenticateRequest(req, runtime.provider!);
        if (!result.ok) {
          writeAuthFailure(res, result);
          return;
        }
        sessionAuth = result.context;
        logger.debug("MCP request authenticated", {
          tokenFingerprint: result.context.tokenFingerprint,
          scopes: result.context.scopes.join(" "),
        });
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        sessions.get(sessionId)!.setAuth(sessionAuth);
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "POST" && !sessionId) {
        const entry = createSession(sessionAuth);
        await entry.server.connect(entry.transport);
        await entry.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET" && sessionId && !sessions.has(sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Session not found" },
            id: null,
          })
        );
        return;
      }

      if (req.method === "DELETE" && sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request" },
          id: null,
        })
      );
    } catch (err) {
      logger.error("HTTP request error", { error: err });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
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

  const issuer = `http://127.0.0.1:${actualPort}`;
  runtime.provider = createDemoOAuthProvider({
    issuer,
    clientId: config.oauthClientId,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    audience: config.oauthAudience,
    signingKey,
    revocationStore,
    introspectionClient: config.introspectionClientSecret
      ? { clientId: config.introspectionClientId, clientSecret: config.introspectionClientSecret }
      : undefined,
  });

  logger.info("HTTP server listening", {
    port: actualPort,
    issuer,
    authMode,
    audience: runtime.provider.audience,
    kid: runtime.provider.signingKey.kid,
    introspection: runtime.provider.introspectionEnabled,
    revocationStore: config.oauthRevocationFile ? "file" : "memory",
  });

  return {
    port: actualPort,
    issuer,
    mcpUrl: issuer,
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

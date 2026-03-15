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
import { toMcpError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { listTools, callTool } from "./tools/index.js";
import { listResources, readResource } from "./resources/index.js";
import { listPrompts, getPrompt } from "./prompts/index.js";

const SERVER_NAME = "kaia-mcp";
const SERVER_VERSION = "0.1.0";

function wrapToolHandler<T, R>(
  handler: (req: T) => R | Promise<R>
): (req: T, extra: unknown) => Promise<R> {
  return async (req: T, extra: unknown) => {
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
export function createKaiaMcpServer(): Server {
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

  server.setRequestHandler(ListToolsRequestSchema, wrapToolHandler(() => listTools()));

  server.setRequestHandler(
    CallToolRequestSchema,
    wrapToolHandler(async (request) => {
      const { name, arguments: args } = request.params;
      return callTool(name, (args ?? {}) as Record<string, unknown>);
    })
  );

  server.setRequestHandler(ListResourcesRequestSchema, wrapToolHandler(() => listResources()));

  server.setRequestHandler(
    ReadResourceRequestSchema,
    wrapToolHandler(async (request) => {
      const uri = request.params?.uri ?? "";
      return readResource(uri);
    })
  );

  server.setRequestHandler(ListPromptsRequestSchema, wrapToolHandler(() => listPrompts()));

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
 */
export async function runKaiaMcpServer(): Promise<void> {
  getConfig();
  logger.info("Starting Kaia MCP server (stdio)");
  const server = createKaiaMcpServer();
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

/**
 * Runs the Kaia MCP server over Streamable HTTP on the given port.
 * Creates a per-session transport+server pair so multiple clients can
 * connect concurrently. Validates config at startup.
 */
export async function runKaiaMcpServerHttp(port: number): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  getConfig();
  logger.info("Starting Kaia MCP server (HTTP)", { port });

  type SessionEntry = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: Server;
  };
  const sessions = new Map<string, SessionEntry>();

  function createSession(): SessionEntry {
    const server = createKaiaMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        logger.info("Session initialized", { sessionId });
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
    const entry: SessionEntry = { transport, server };
    return entry;
  }

  const httpServer = createServer(async (req, res) => {
    normalizeAcceptHeader(req);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "POST" && !sessionId) {
        const entry = createSession();
        await entry.server.connect(entry.transport);
        await entry.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET" && sessionId && !sessions.has(sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null }));
        return;
      }

      if (req.method === "DELETE" && sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }));
    } catch (err) {
      logger.error("HTTP request error", { error: err });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });

  httpServer.listen(port, () => {
    logger.info("HTTP server listening", { port });
  });
}

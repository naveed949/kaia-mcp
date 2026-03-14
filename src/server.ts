import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "./config.js";
import { toMcpError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { listTools, callTool } from "./tools/index.js";

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
 * Runs the Kaia MCP server over Streamable HTTP on the given port.
 * Uses stateless transport (no session ID). Validates config at startup.
 */
export async function runKaiaMcpServerHttp(port: number): Promise<void> {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  getConfig();
  logger.info("Starting Kaia MCP server (HTTP)", { port });

  const server = createKaiaMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  server.onerror = (err) => logger.error("Server transport error", { error: err });
  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    transport.handleRequest(req, res).catch((err) => {
      logger.error("HTTP request error", { error: err });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  httpServer.listen(port, () => {
    logger.info("HTTP server listening", { port });
  });
}

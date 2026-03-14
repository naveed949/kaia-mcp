import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "./config.js";

const SERVER_NAME = "kaia-mcp";
const SERVER_VERSION = "0.1.0";

/**
 * Creates and returns the Kaia MCP server instance.
 * Tools and resources are registered in later phases.
 */
export function createKaiaMcpServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        // Tools and resources will be added in Phase 2+
      },
    }
  );
  return server;
}

/**
 * Runs the Kaia MCP server over stdio (for CLI use).
 * Validates config at startup (fail-fast on bad env).
 */
export async function runKaiaMcpServer(): Promise<void> {
  getConfig(); // fail-fast on invalid env
  const server = createKaiaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

#!/usr/bin/env node
/**
 * CLI entry: run the Kaia MCP server over stdio.
 * Usage: node dist/bin/kaia-mcp.js (or npm run start / kaia-mcp)
 */

import { runKaiaMcpServer } from "../server.js";

runKaiaMcpServer().catch((err) => {
  console.error("kaia-mcp error:", err);
  process.exit(1);
});

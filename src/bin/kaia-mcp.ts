#!/usr/bin/env node
/**
 * CLI entry: run the Kaia MCP server over stdio or HTTP.
 * Usage:
 *   kaia-mcp [--transport stdio]     (default: stdio)
 *   kaia-mcp --transport http [--port 3100]
 *   kaia-mcp --help
 */

import { runKaiaMcpServer, runKaiaMcpServerHttp } from "../server.js";
import { logger } from "../utils/logger.js";

const HELP = `Usage:
  kaia-mcp [--transport stdio]     Run over stdio (default)
  kaia-mcp --transport http [--port PORT]   Run Streamable HTTP server (default port: 3100)
  kaia-mcp --help                 Show this message

Options:
  --transport <stdio|http>  Transport: stdio or http (default: stdio)
  --port <number>           HTTP port when --transport http (default: 3100)

HTTP partner mode (default KAIA_AUTH_MODE=required) mounts a demo OIDC/OAuth
provider on the same port (PKCE + device flow). MCP requests must send
Authorization: Bearer <access_token>. Set KAIA_AUTH_MODE=off only for local
unauthenticated HTTP. generate_wallet is disabled unless KAIA_ALLOW_UNSAFE_WALLET=1.
See docs/AUTH.md.
`;

function parseArgv(argv: string[]): { transport: "stdio" | "http"; port: number } {
  let transport: "stdio" | "http" = "stdio";
  let port = 3100;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stderr.write(HELP);
      process.exit(0);
    }
    if (arg === "--transport") {
      const value = argv[i + 1];
      if (value === "stdio" || value === "http") {
        transport = value;
        i++;
      } else {
        process.stderr.write("Error: --transport requires stdio or http\n");
        process.exit(1);
      }
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      const n = value ? parseInt(value, 10) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        process.stderr.write("Error: --port requires a number 1-65535\n");
        process.exit(1);
      }
      port = n;
      i++;
      continue;
    }
  }

  return { transport, port };
}

async function main(): Promise<void> {
  const { transport, port } = parseArgv(process.argv.slice(2));

  if (transport === "stdio") {
    await runKaiaMcpServer();
    return;
  }

  await runKaiaMcpServerHttp(port);
}

main().catch((err) => {
  logger.error("kaia-mcp failed", { error: err });
  process.exit(1);
});

# Phase 3 Report: Server Core

## Summary

Phase 3 (Server core) is implemented. All deliverables are in place; `npm run build` and `npm test` pass.

## What Was Done

### 1. `src/utils/logger.ts`

- Structured logger writing **only to stderr** (stdout left clean for MCP stdio).
- Uses `getConfig().logLevel` for filtering; methods: `debug`, `info`, `warn`, `error`.
- Format: key=value style with `timestamp`, `level`, `msg`, and optional `error`/`code` and other fields.
- No extra dependencies; uses existing project and Node.

### 2. `src/utils/errors.ts`

- **`toMcpError(err: unknown): { code, message, data? }`** maps any throwable to MCP/JSON-RPC error shape.
- Standard codes: Parse (-32700), Invalid request (-32600), Method not found (-32601), Invalid params (-32602), Internal error (-32603).
- Custom codes: RPC provider (-32001), KaiaScan API (-32002), Rate limit (-32003).
- Network/viem-style errors (e.g. `code === 'ECONNREFUSED'`, `ETIMEDOUT`) → -32001.
- Fetch/API-style and “KaiaScan” message patterns → -32002; 429/rate-limit → -32003.
- Uses `Error.message` when present, otherwise a generic “Internal error”.

### 3. `src/server.ts`

- **`createKaiaMcpServer()`**: Builds server with `capabilities.tools` set and registers:
  - **tools/list**: returns a single stub tool `get_kaia_balance` with `inputSchema`: `address` (string, required), `network` (string, optional).
  - **tools/call**: for `get_kaia_balance` returns stub text `"Balance: 0 (stub) for <address> on <network>"`; unknown tool name is turned into an error via `toMcpError` and thrown as SDK `McpError`.
- All tool handlers are wrapped in a try/catch that maps thrown errors with `toMcpError` and rethrows `new McpError(code, message, data)` so the SDK returns proper JSON-RPC errors.
- Startup and transport errors logged with the new logger (stderr only).
- **`runKaiaMcpServerHttp(port)`** added: runs the same server over Streamable HTTP on the given port using the SDK’s Node.js Streamable HTTP transport.

### 4. CLI and HTTP transport (`src/bin/kaia-mcp.ts`)

- **Argv parsing**: `--transport stdio` (default) | `--transport http`, and `--port <number>` (default 3100) for HTTP.
- **`--help`**: Prints usage (transport and port options).
- **stdio**: Calls existing `runKaiaMcpServer()`.
- **http**: Calls `runKaiaMcpServerHttp(port)` which:
  - Uses **`@modelcontextprotocol/sdk/server/streamableHttp.js`** → **`StreamableHTTPServerTransport`** (Node.js wrapper around `WebStandardStreamableHTTPServerTransport`).
  - Creates a Node `http.createServer` that forwards `(req, res)` to `transport.handleRequest(req, res)`.
  - Stateless mode (`sessionIdGenerator: undefined`).
- Top-level failures logged with the project logger and exit(1).

### 5. Tests

- **`src/utils/errors.test.ts`**: Unit tests for `toMcpError`:
  - Unknown throwable → Internal error.
  - `Error` with message → that message, Internal error code.
  - `err.code === 'ECONNREFUSED'` / `ETIMEDOUT` → -32001 (RPC provider).
  - 429/rate-limit style → -32003 (Rate limit).
  - `null`/`undefined` → Internal error with generic message.
- **`src/server.test.ts`**: Integration-style tests using SDK **`InMemoryTransport.createLinkedPair()`**:
  - Server connected to one transport, Client to the other; client runs initialize then **tools/list** → assert at least one tool and presence of `get_kaia_balance` with expected `inputSchema`.
  - **tools/call** for `get_kaia_balance` with `address` and `network` → assert response content contains stub text (`"Balance: 0 (stub)"` and network).

## SDK Findings

- **Streamable HTTP**: The SDK exposes **`StreamableHTTPServerTransport`** in **`@modelcontextprotocol/sdk/server/streamableHttp.js`**. It takes Node.js `IncomingMessage` and `ServerResponse` and delegates to `WebStandardStreamableHTTPServerTransport` (Web Standard Request/Response). Usage: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` for stateless; then `transport.handleRequest(req, res)` per request. No need to defer HTTP; it is implemented in Phase 3.
- **Tools**: Server registers handlers with `server.setRequestHandler(ListToolsRequestSchema, ...)` and `server.setRequestHandler(CallToolRequestSchema, ...)`. Schemas and `McpError` are imported from **`@modelcontextprotocol/sdk/types.js`** (package export `"*": "./dist/esm/*"` so `@modelcontextprotocol/sdk/types` resolves).
- **Errors**: Throwing **`McpError(code, message, data)`** from handlers produces correct JSON-RPC error responses. Our `toMcpError` returns a shape that we pass into `new McpError(mcp.code, mcp.message, mcp.data)`.

## Build and Test

- **Build**: `npm run build` — success.
- **Tests**: `npm test` — 22 tests passing (7 files), including all Phase 3 tests.

## Logging

All logging goes to **stderr** only; MCP stdio protocol on stdout is unchanged.

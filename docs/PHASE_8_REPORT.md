# Phase 8 Report: MCP Resources

Phase 8 adds MCP **resources**: read-only URIs that clients can list and read. The server advertises `capabilities.resources = {}` and handles `resources/list` and `resources/read`.

## Resource URIs

| URI                               | Name                   | Description                                                                                                  |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **kaia://mainnet/status**         | Mainnet status         | Current mainnet block height, gas price (peb/KAIA), and KAIA price (USD).                                    |
| **kaia://kairos/status**          | Kairos testnet status  | Same as mainnet but for Kairos testnet (block height, gas price, KAIA price).                                |
| **kaia://mainnet/tokens/popular** | Popular mainnet tokens | List of popular token addresses on mainnet with name, symbol, and contract address (e.g. WKAIA, USDT, USDC). |
| **kaia://mainnet/top-accounts**   | Top KAIA accounts      | Top 100 KAIA holders from KaiaScan (Get Top Accounts).                                                       |
| **kaia://docs/rpc-methods**       | RPC methods reference  | Static markdown reference of Kaia RPC methods (kaia*\*, klay*_, eth\__).                                     |

## What Each Resource Returns

- **kaia://mainnet/status** and **kaia://kairos/status**  
  Plain text: network name, chain ID, block height, gas price in peb and KAIA per unit, and KAIA USD price.  
  **APIs:** RPC (`getBlockNumber`, `getGasPrice`) and KaiaScan `GET /api/v1/kaia` for price.

- **kaia://mainnet/tokens/popular**  
  Plain text: header plus one line per token: `Name (SYMBOL): 0x...`.  
  **APIs:** None (hardcoded list in `src/resources/token-list.ts`).

- **kaia://mainnet/top-accounts**  
  Plain text: header “Top 100 KAIA holders (mainnet)” and numbered lines with address, type, amount, percentage.  
  **APIs:** KaiaScan `GET /api/v1/kaia/top-accounts`.

- **kaia://docs/rpc-methods**  
  Markdown (`text/markdown`): tables of `eth_*`, `kaia_*`, `klay_*`, and `net_*` method names with short descriptions.  
  **APIs:** None (static content in `src/resources/rpc-methods-docs.ts`).

## APIs Used

| Resource                      | RPC                         | KaiaScan                      |
| ----------------------------- | --------------------------- | ----------------------------- |
| kaia://mainnet/status         | getBlockNumber, getGasPrice | GET /api/v1/kaia              |
| kaia://kairos/status          | getBlockNumber, getGasPrice | GET /api/v1/kaia              |
| kaia://mainnet/tokens/popular | —                           | —                             |
| kaia://mainnet/top-accounts   | —                           | GET /api/v1/kaia/top-accounts |
| kaia://docs/rpc-methods       | —                           | —                             |

RPC calls use `createRpcClient(network)` (viem public client). KaiaScan calls use `createKaiaScanClient().get(path)`.

## Implementation Notes

- **listResources()** returns a fixed list of five resources (uri, name, description). No pagination; `nextCursor` is undefined.
- **readResource(uri)** parses the URI and dispatches to the appropriate fetcher. Errors are mapped with `toMcpError` and rethrown as `McpError` so the server handler returns proper JSON-RPC errors. Invalid or unknown URIs throw `McpError` with `ErrorCode.InvalidParams`.
- Server registers `ListResourcesRequestSchema` and `ReadResourceRequestSchema` with the same `wrapToolHandler`-style wrapper used for tools (catch → `toMcpError` → `McpError`).
- No resource templates are used; all URIs are fixed.

## Files Touched

- `src/resources/index.ts` — listResources(), readResource(), status/top-accounts fetchers
- `src/resources/token-list.ts` — getPopularMainnetTokens() for kaia://mainnet/tokens/popular
- `src/resources/rpc-methods-docs.ts` — RPC_METHODS_DOCS static markdown for kaia://docs/rpc-methods
- `src/resources/resources.test.ts` — listResources (5 URIs), readResource (mainnet/status, docs/rpc-methods, tokens/popular, top-accounts, invalid URI)
- `src/server.ts` — capabilities.resources = {}, setRequestHandler(ListResourcesRequestSchema), setRequestHandler(ReadResourceRequestSchema)
- `src/server.test.ts` — listResources returns 5 resources; readResource(kaia://docs/rpc-methods) returns RPC docs content
- `docs/PHASE_8_REPORT.md` — this report

## Build and Tests

- `npm run build` — succeeds.
- `npm test` — all 118 tests pass (17 test files), including 7 resource tests and 2 new server tests for resources.

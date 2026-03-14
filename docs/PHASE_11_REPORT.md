# Phase 11: Testing (broader coverage + integration)

## Summary

Strengthened unit test coverage and added integration tests for the full MCP lifecycle, plus an optional live test suite skipped by default.

## Unit tests

- **Tool modules**: All tool modules (account, transaction, block, token, nft, contract, network, wallet) already had tests mocking RPC/KaiaScan with success and validation-error cases.
- **Added**: In `src/tools/wallet.test.ts`, one edge case for `encode_function_data`: when `args` is not an array, the handler throws (invalid args must be an array). No real network calls in any unit test.

## Integration test

- **Location**: `src/server.integration.test.ts`
- **Behavior**: Uses MCP SDK `Client` and `StdioClientTransport` to spawn the built server (`dist/bin/kaia-mcp.js`) and drive the full lifecycle:
  1. `client.connect(transport)` → initialize + initialized
  2. `getServerCapabilities()` → capabilities include tools
  3. `listTools()` → tools array with 25+ tools including `get_block_number`
  4. `callTool({ name: "get_block_number", arguments: { network: "mainnet" } })` → content array with text (hits real RPC in integration)
  5. `listResources()` → resources array
  6. `listPrompts()` → prompts array
- **Default run**: The integration describe block is **skipped** when `RUN_INTEGRATION` is not set, so default `npm test` stays fast and does not spawn the server.
- **How to run**: `npm run test:integration` (builds then runs with `RUN_INTEGRATION=1`). Requires network for `get_block_number` RPC.

## Optional live test

- **Location**: Same file, second describe block: "Live RPC / KaiaScan (optional)".
- **Skipped by default**: Runs only when `LIVE_TESTS=1`.
- **Tests**:
  1. `get_block_number` via `createRpcClient("mainnet").getBlockNumber()` → positive bigint.
  2. `get_kaia_price` via `createKaiaScanClient().get("api/v1/kaia")` → object response.
- **How to run**: `LIVE_TESTS=1 npm test` or `LIVE_TESTS=1 npx vitest run src/server.integration.test.ts`. Documented in this report and can be added to README.

## Test counts

- **Default `npm test`**: 135 passed, 7 skipped (integration + live describe blocks).
- **`npm run test:integration`**: 5 passed (MCP lifecycle), 2 skipped (live tests).

## Deliverable

Broader unit coverage (wallet edge case), one integration test for MCP lifecycle using the SDK Client, optional live test skipped by default. `npm test` and `npm run test:integration` pass.

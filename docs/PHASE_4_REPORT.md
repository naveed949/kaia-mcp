# Phase 4 Report — Account Tools

## Summary

Phase 4 implements four account tools for the Kaia MCP Server, wired through the tools registry with shared validation, formatting, and error mapping. Build and tests pass.

## Deliverables

- **Four tools:** `get_kaia_balance`, `get_account_info`, `get_account_tokens`, `get_account_nfts`
- **Implementation:** `src/tools/account.ts` (definitions + handlers), `src/tools/index.ts` (listTools / callTool)
- **Server:** `src/server.ts` uses `listTools()` and `callTool(name, args)` from tools/index with `wrapToolHandler` for error mapping
- **Helpers:** `src/utils/validation.ts` (validateAddress, validateNetwork), `src/utils/format.ts` (formatKaia, formatPeb)
- **Tests:** Unit tests in `src/tools/account.test.ts` (mocked RPC and KaiaScan), `src/utils/format.test.ts`, and updated `src/server.test.ts` (four tools, formatted balance, invalid-address throws)

## KaiaScan API Paths Used

| Tool                   | KaiaScan path (base: `https://api.kaiascan.io`)        | Notes                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **get_account_tokens** | `GET /api/v1/accounts/:accountAddress/token-balances`  | Query params: `page`, `size`. Docs: [Get Account Fungible Token Balances](https://docs.kaiascan.io/api/Account/Token/get-account-fungible-token-balances).                |
| **get_account_nfts**   | `GET /api/v1/accounts/:accountAddress/nft-inventories` | Query params: `page`, `size`, optional `excludeIfTokenUriIsEmpty`. Docs: [Get Account Nft Inventories](https://docs.kaiascan.io/api/Account/get-account-nft-inventories). |

## Deviations / Notes

1. **Token balances endpoint**  
   The spec mentioned “get-account-fungible-token-balances or get-account-token-balances”. The implementation uses the **fungible** endpoint: `/api/v1/accounts/:accountAddress/token-balances`, which returns a list of fungible token balances in one call. The “get-account-token-balances” doc points to the **historical** endpoint `GET /api/v1/accounts/balances/historical` (single-token, requires `filterType` + `date` or `blockNumber`). Using the fungible list endpoint avoids extra RPC calls for “latest” block and matches the desired “list of token symbol, contract address, balance”.

2. **Network (mainnet vs kairos)**  
   `address` and `network` are validated for all tools; RPC uses the correct mainnet/kairos URL. KaiaScan client currently uses the single base URL `https://api.kaiascan.io` (mainnet). If Kairos has a separate API host or `chainId` parameter, that can be added later; no such parameter was used in the documented endpoints.

3. **RPC**  
   `get_kaia_balance` uses viem `getBalance({ address, blockTag: 'latest' })`. `get_account_info` uses `client.request({ method: 'kaia_getAccount', params: [address, 'latest'] })` (Kaia-specific RPC).

4. **Invalid address**  
   Validation uses viem `getAddress()`; invalid input throws an error that `toMcpError` maps to MCP `InternalError` (-32603) with a clear “Invalid address” message. Server tests assert that calling `get_kaia_balance` with an invalid address causes the client to reject with that message.

## Test and Build

- `npm test -- --run`: 39 tests (9 files) pass.
- `npm run build`: succeeds.

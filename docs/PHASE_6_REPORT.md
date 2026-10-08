# Phase 6 Report: Token + NFT Tools

Phase 6 adds six MCP tools for fungible tokens (KIP-7 / ERC-20) and non-fungible tokens (KIP-17 / ERC-721) using the KaiaScan Open API.

## Tools Added

| Tool                    | Description                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **get_token_info**      | Fungible token metadata (name, symbol, decimals, total supply) by contract address     |
| **get_token_holders**   | Top holders of a fungible token with balance and percentage                            |
| **get_token_transfers** | Recent transfers of a fungible token (from, to, value, txHash, time)                   |
| **get_nft_info**        | NFT collection metadata (name, symbol, total supply, holder count) by contract address |
| **get_nft_item**        | Single NFT item by contract and token ID (owner, tokenURI, metadata/traits)            |
| **get_nft_transfers**   | NFT transfer history for a collection (from, to, tokenId, txHash, time)                |

## KaiaScan API Paths Used

### Fungible token (KIP-7 / ERC-20)

| Tool                | KaiaScan API path                            | Docs                                                                                                           |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| get_token_info      | `GET /api/v1/tokens/:tokenAddress`           | [Get Fungible Token](https://docs.kaiascan.io/api/Token/get-fungible-token)                                    |
| get_token_holders   | `GET /api/v1/tokens/:tokenAddress/holders`   | [Get Holders Of Fungible Token](https://docs.kaiascan.io/api/Token/get-holders-of-fungible-token)              |
| get_token_transfers | `GET /api/v1/tokens/:tokenAddress/transfers` | [Get Transfers Of Fungible Token](https://docs.kaiascan.io/api/Token/Transfer/get-transfers-of-fungible-token) |

### Non-fungible token (KIP-17 / ERC-721)

| Tool              | KaiaScan API path                                  | Docs                                                                                                                 |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| get_nft_info      | `GET /api/v1/nfts/:tokenAddress`                   | [Get Non Fungible Token](https://docs.kaiascan.io/api/NFT/get-non-fungible-token)                                    |
| get_nft_item      | `GET /api/v1/nfts/:tokenAddress/tokenids/:tokenId` | [Get Nft Token Item](https://docs.kaiascan.io/api/NFT/get-nft-token-item)                                            |
| get_nft_transfers | `GET /api/v1/nfts/:tokenAddress/transfers`         | [Get Transfers Of Non Fungible Token](https://docs.kaiascan.io/api/NFT/Transfer/get-transfers-of-non-fungible-token) |

## Response Shape Assumptions

- **Get Fungible Token**: Response fields `name`, `symbol`, `decimal`, `total_supply`, `contract_type` are used; missing values rendered as "—".
- **Get Holders Of Fungible Token**: Paginated `results[]` with `holder.address`, `holder.amount`, `holder.percentage`; query params `page`, `size` (min 1, max 2000).
- **Get Transfers Of Fungible Token**: Paginated `results[]` with `from`, `to`, `amount`, `transaction_hash`, `datetime`; query params `page`, `size`.
- **Get Non Fungible Token**: Response fields `name`, `symbol`, `total_supply`, `holder_count`, `contract_type` are used.
- **Get Nft Token Item**: Response has `info.token_id`, `info.token_uri`, `holder.address`, and optional `metadata` (name, description, image, etc.). `tokenId` is normalized to string and passed in the path (URL-encoded if needed).
- **Get Transfers Of Non Fungible Token**: Paginated `results[]` with `from`, `to`, `token_id`, `transaction_hash`, `datetime`; query params `page`, `size`. Optional query `tokenId` can filter by token (not exposed in Phase 6 tools).

## Pagination

- **get_token_holders**, **get_token_transfers**, **get_nft_transfers**: `page` (default 1) and `size` (default 20, max 2000). Same pattern as existing account/transaction tools.

## Validation

- All contract addresses are validated with `validateAddress()` (0x-prefixed, 20-byte hex).
- `tokenId` for **get_nft_item** accepts string or number; empty/missing `tokenId` throws a clear error.
- `network` is validated with `validateNetwork()` (mainnet or kairos); default mainnet.

## Files Touched

- `src/tools/token.ts` — token tool definitions and handlers
- `src/tools/nft.ts` — NFT tool definitions and handlers
- `src/tools/index.ts` — TOKEN_TOOLS, NFT_TOOLS, and six callTool cases (17 tools total)
- `src/tools/token.test.ts` — unit tests for token tools (mocked KaiaScan)
- `src/tools/nft.test.ts` — unit tests for NFT tools (mocked KaiaScan)
- `src/server.test.ts` — listTools 17 tools, callTool tests for get_token_info and get_nft_info
- `docs/PHASE_6_REPORT.md` — this report

## Credits (KaiaScan)

- Get Fungible Token: 1 credit
- Get Holders Of Fungible Token: 5 credits
- Get Transfers Of Fungible Token: 5 credits
- Get Non Fungible Token: 3 credits
- Get Nft Token Item: 3 credits
- Get Transfers Of Non Fungible Token: 5 credits

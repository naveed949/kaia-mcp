# Phase 5 Report — Transaction + Block Tools

## Summary

Phase 5 adds seven new MCP tools: four transaction tools (`get_transaction`, `get_transaction_receipt`, `get_account_transactions`, `estimate_gas`) and three block tools (`get_block_number`, `get_block`, `get_block_rewards`). All are wired in `src/tools/index.ts`. Validation includes `validateTxHash` and `validateBlockNumberOrHash` in `src/utils/validation.ts`. Build and tests pass.

## Deliverables

- **Transaction tools:** `src/tools/transaction.ts` — get_transaction, get_transaction_receipt, get_account_transactions, estimate_gas
- **Block tools:** `src/tools/block.ts` — get_block_number, get_block, get_block_rewards
- **Registry:** `src/tools/index.ts` — combined list of 11 tools (4 account + 4 transaction + 3 block), callTool cases for all
- **Validation:** `src/utils/validation.ts` — validateTxHash (0x + 64 hex), validateBlockNumberOrHash (integer, hex number, or block hash)
- **Tests:** `src/tools/transaction.test.ts`, `src/tools/block.test.ts` (mocked viem and KaiaScan); `src/server.test.ts` updated for 11 tools and callTool tests for get_block_number and get_transaction_receipt
- **Docs:** This report with KaiaScan API paths used

## KaiaScan API Paths Used

Base URL: `https://api.kaiascan.io` (same client as Phase 4; no network-specific base for Kairos in this phase).

| Tool                            | KaiaScan path                                       | Notes                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **get_account_transactions**    | `GET /api/v1/accounts/:accountAddress/transactions` | Query params: `page`, `size` (size = limit, max 2000). Returns list of transactions (hash, from, to, amount, datetime, status). Docs: [Get Account Transactions](https://docs.kaiascan.io/api/Account/Transaction/get-account-transactions).             |
| **get_block_rewards** (rewards) | `GET /api/v1/blocks/:blockNumber/rewards`           | Path param: block number (integer). Response: `minted`, `total_fee`, `burnt_fee` (KAIA). Docs: [Get Block Rewards](https://docs.kaiascan.io/api/Block/get-block-rewards).                                                                                |
| **get_block_rewards** (burns)   | `GET /api/v1/blocks/:blockNumber/burns`             | Path param: block number (integer). Response: `nearest_block_number`, `accumulate_burnt_fees`, `accumulate_burnt_kaia`, `kip103_burnt`, `kip160_burnt`, `accumulate_burnt`. Docs: [Get Block Burns](https://docs.kaiascan.io/api/Block/get-block-burns). |

## Tool Behavior

- **get_transaction:** viem `getTransaction({ hash })`. Human-readable summary: hash, from, to, value (formatKaia), blockNumber, gas, gasPrice, input (truncated to 66 chars).
- **get_transaction_receipt:** viem `getTransactionReceipt({ hash })`. Status, blockNumber, gasUsed, contractAddress, logs count.
- **get_account_transactions:** KaiaScan `GET /api/v1/accounts/:address/transactions` with `page`, `size`. Returns lines: tx hash, from, to, value, time, status.
- **estimate_gas:** viem `estimateGas({ account: from, to?, value?, data? })` and `getGasPrice()` for cost. Returns estimated gas, gas price, and cost in KAIA.
- **get_block_number:** viem `getBlockNumber()`.
- **get_block:** viem `getBlock({ blockNumber } | { blockHash }, { includeTransactions })`. Supports block number (int/hex) or block hash (0x + 64 hex).
- **get_block_rewards:** Two KaiaScan calls: rewards then burns for the given block number. Combined summary in one text response.

## Validation

- **validateTxHash(txHash):** 0x + exactly 64 hex characters. Used by get_transaction, get_transaction_receipt.
- **validateBlockNumberOrHash(blockNumberOrHash):** Non-negative integer, hex block number (e.g. 0x3039), or block hash (0x + 64 hex). Used by get_block. get_block_rewards accepts only a block number (integer or numeric string); passing a block hash returns a clear error.

## Test and Build

- `npm test -- --run`: 61 tests (11 files) pass.
- `npm run build`: succeeds.

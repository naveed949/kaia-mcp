# Phase 9 Report: MCP Prompts

Phase 9 adds MCP **prompts**: reusable prompt templates that clients can list and resolve with arguments. The server advertises `capabilities.prompts = {}` and handles `prompts/list` and `prompts/get`.

## Prompts

| Name                        | Description                                                                               | Arguments                                                                | Template summary                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **analyze-wallet**          | Analyze a Kaia wallet: balance, recent transactions, and token holdings.                  | `address` (required), `network` (optional, default mainnet)              | "Analyze the wallet {address} on Kaia {network}. Show balance, recent transactions, and token holdings." |
| **investigate-transaction** | Investigate a transaction: status, gas usage, token transfers, and internal transactions. | `txHash` (required)                                                      | "Investigate transaction {txHash}. Show status, gas usage, token transfers, and internal transactions."  |
| **token-research**          | Research a token: supply, holders, recent activity, and transfers.                        | `contractAddress` (required), `network` (optional)                       | "Research the token at {contractAddress}. Show supply, holders, recent activity, and transfers."         |
| **nft-lookup**              | Look up an NFT: owner, metadata, and transfer history.                                    | `contractAddress` (required), `tokenId` (required), `network` (optional) | "Look up NFT {tokenId} in collection {contractAddress}. Show owner, metadata, and transfer history."     |
| **gas-report**              | Generate a gas report: current price, fee history, and recommendations.                   | `network` (optional)                                                     | "Generate a gas report for Kaia {network}. Show current price, fee history, and recommendations."        |
| **smart-contract-audit**    | Review a contract: fetch ABI and source code, identify contract type.                     | `contractAddress` (required), `network` (optional)                       | "Review the contract at {contractAddress}. Fetch ABI and source code, identify the contract type."       |

## Arguments

- **address** — Wallet address (0x...). Used by `analyze-wallet`.
- **txHash** — Transaction hash (0x...). Used by `investigate-transaction`.
- **contractAddress** — Contract or token address (0x...). Used by `token-research`, `nft-lookup`, `smart-contract-audit`.
- **tokenId** — NFT token ID. Used by `nft-lookup`.
- **network** — Optional; `mainnet` or `kairos`. Defaults to `mainnet` when omitted. Used by all prompts except `investigate-transaction`.

## Implementation Notes

- **listPrompts()** returns a fixed list of six prompts, each with `name`, `description`, and `arguments` (array of `{ name, description?, required? }`).
- **getPrompt(name, args)** substitutes `args` into the prompt template and returns `GetPromptResult` with `messages: [{ role: "user", content: { type: "text", text: "..." } }]`. Optional `network` defaults to `"mainnet"`. Unknown prompt name or missing required argument throws `McpError` with `ErrorCode.InvalidParams`.
- Server registers `ListPromptsRequestSchema` and `GetPromptRequestSchema` with the same `wrapToolHandler` wrapper used for tools and resources, so thrown errors are converted to proper JSON-RPC errors.

## Files Touched

- `src/prompts/index.ts` — listPrompts(), getPrompt(), six prompt definitions with templates
- `src/server.ts` — capabilities.prompts = {}, setRequestHandler(ListPromptsRequestSchema), setRequestHandler(GetPromptRequestSchema)
- `src/prompts/prompts.test.ts` — listPrompts (6 prompts, argument names), getPrompt (analyze-wallet, nft-lookup, unknown throws, missing required throws, default network)
- `src/server.test.ts` — listPrompts returns 6; getPrompt(analyze-wallet) returns messages
- `docs/PHASE_9_REPORT.md` — this report

## Build and Tests

- `npm run build` — succeeds.
- `npm test` — all tests pass, including prompts unit tests and server integration tests for prompts/list and prompts/get.

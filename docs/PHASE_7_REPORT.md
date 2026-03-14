# Phase 7 Report: Contract + Network + Wallet Tools

Phase 7 adds eight MCP tools for contract reads, ABI/source lookup, network gas/price/chain info, and wallet generation/calldata encoding.

## Tools Added

| Tool | Description |
|------|-------------|
| **read_contract** | Read a view/pure contract function. Requires contract address, function name, and ABI (JSON string or array). Use **get_contract_abi** first if you do not have the ABI. Returns decoded result as readable text. |
| **get_contract_abi** | Get the ABI of a verified contract from KaiaScan. Returns ABI JSON as text. |
| **get_contract_source** | Get verified contract source code from KaiaScan. Returns source if available, otherwise "Unverified" or a message that source is not available via API. |
| **get_gas_price** | Current gas price from the network in peb, Gpeb, and KAIA per unit. |
| **get_kaia_price** | KAIA price in USD and stats (24h change, market cap, total supply, volume) from KaiaScan. |
| **get_chain_info** | Chain ID, chain name, native currency for the network (mainnet/kairos). |
| **generate_wallet** | Generate a new wallet keypair (address and private key in hex). No RPC call. Keep the private key secret. |
| **encode_function_data** | Encode function call data from ABI, function name, and optional args. Returns hex calldata for building transactions. |

## KaiaScan API Paths

| Tool | KaiaScan path | Notes |
|------|----------------|-------|
| get_contract_abi | `GET /api/v1/contracts/:contractAddress/abi` | [Get Abi Of Contract](https://docs.kaiascan.io/api/Contract/Utils/get-abi-of-contract). Returns ABI JSON. |
| get_contract_source | `GET /api/v1/contracts?contractAddresses=:address` | [Get Contracts](https://docs.kaiascan.io/api/Contract/get-contracts). Response includes `verified`; if `source_code` (or `sourceCode`) is present it is returned, otherwise "Unverified" or a message that source is not available. |
| get_kaia_price | `GET /api/v1/kaia` | [Get Kaia Price](https://docs.kaiascan.io/api/Home/get-kaia-price). Response has `klay_price` with `usd_price`, `btc_price`, `usd_price_changes`, `market_cap`, `total_supply`, `volume`. |

## read_contract and ABI

- **read_contract** requires the contract ABI (as a JSON string or array). If the user does not have the ABI, they can call **get_contract_abi** first with the contract address (and optional network) to fetch it from KaiaScan, then pass that ABI into **read_contract**.
- ABI must parse to a valid viem `Abi` (array of ABI items). Invalid or empty ABI throws a clear error.
- Arguments `args` are optional; when provided they must be an array in the same order as the function inputs.

## Implementation Notes

- **Contract tools** (`src/tools/contract.ts`): `read_contract` uses viem `readContract`; `get_contract_abi` and `get_contract_source` use KaiaScan client. All validate `contractAddress` with `validateAddress()`.
- **Network tools** (`src/tools/network.ts`): `get_gas_price` uses viem `getGasPrice()` and `formatKaia`; `get_kaia_price` uses KaiaScan `GET /api/v1/kaia`; `get_chain_info` uses `getChain(network)` and RPC `getChainId()`.
- **Wallet tools** (`src/tools/wallet.ts`): `generate_wallet` uses viem `generatePrivateKey` and `privateKeyToAccount` from `viem/accounts`; `encode_function_data` uses viem `encodeFunctionData`. No RPC calls. A warning is logged when generating a wallet (private key is not logged).

## Validation

- Contract and account addresses: `validateAddress()`.
- Network: `validateNetwork()` (mainnet or kairos); default mainnet where applicable.
- ABI in read_contract and encode_function_data: must be non-empty JSON string or array of ABI items.

## Files Touched

- `src/tools/contract.ts` — contract tool definitions and handlers (read_contract, get_contract_abi, get_contract_source)
- `src/tools/network.ts` — network tool definitions and handlers (get_gas_price, get_kaia_price, get_chain_info)
- `src/tools/wallet.ts` — wallet tool definitions and handlers (generate_wallet, encode_function_data)
- `src/tools/index.ts` — CONTRACT_TOOLS, NETWORK_TOOLS, WALLET_TOOLS and eight callTool cases (25 tools total)
- `src/tools/contract.test.ts` — tests for contract tools (mocked RPC readContract and KaiaScan get)
- `src/tools/network.test.ts` — tests for network tools (mocked getGasPrice, getChainId, KaiaScan)
- `src/tools/wallet.test.ts` — tests for wallet tools (generate_wallet address/privateKey hex length; encode_function_data hex output)
- `src/server.test.ts` — listTools 25 tools; callTool tests for get_gas_price, get_kaia_price, generate_wallet, encode_function_data
- `docs/PHASE_7_REPORT.md` — this report

## Build and Tests

- `npm run build` — succeeds.
- `npm test` — all 109 tests pass (16 test files).

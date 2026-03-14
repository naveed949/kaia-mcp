/**
 * Static reference of Kaia RPC methods for kaia://docs/rpc-methods resource.
 * Based on Kaia docs: https://docs.kaia.io/references/json-rpc/
 */

export const RPC_METHODS_DOCS = `# Kaia RPC Methods Reference

Quick reference for JSON-RPC methods supported by Kaia nodes. Use these with \`eth_call\`, or via the equivalent \`kaia_*\` / \`klay_*\` methods.

## Ethereum-compatible (eth_*)

| Method | Description |
|--------|-------------|
| eth_accounts | Returns list of addresses owned by client |
| eth_blockNumber | Returns current block number |
| eth_call | Executes a new message call (read-only) |
| eth_chainId | Returns chain ID |
| eth_estimateGas | Estimates gas for a call |
| eth_gasPrice | Returns current gas price in peb |
| eth_getBalance | Returns balance of an address |
| eth_getBlockByHash | Returns block by hash |
| eth_getBlockByNumber | Returns block by number |
| eth_getBlockTransactionCountByHash | Transaction count in block by hash |
| eth_getBlockTransactionCountByNumber | Transaction count in block by number |
| eth_getCode | Returns code at an address |
| eth_getLogs | Returns logs matching filter |
| eth_getStorageAt | Returns storage at position |
| eth_getTransactionByHash | Returns transaction by hash |
| eth_getTransactionByBlockHashAndIndex | Transaction by block hash and index |
| eth_getTransactionByBlockNumberAndIndex | Transaction by block number and index |
| eth_getTransactionCount | Nonce of an address |
| eth_getTransactionReceipt | Receipt of a transaction |
| eth_sendRawTransaction | Submits signed transaction |
| eth_sign | Signs data (deprecated) |
| eth_syncing | Returns sync status |

## Kaia-specific (kaia_*)

| Method | Description |
|--------|-------------|
| kaia_accountCreated | Returns true if account exists |
| kaia_decodeAccountKey | Decodes account key RLP |
| kaia_encodeAccountKey | Encodes account key to RLP |
| kaia_getBlockWithConsensusInfoByHash | Block with consensus info by hash |
| kaia_getBlockWithConsensusInfoByNumber | Block with consensus info by number |
| kaia_getChainConfig | Returns chain configuration |
| kaia_getCommittee | Committee at block |
| kaia_getCommitteeSize | Committee size at block |
| kaia_getCouncilSize | Council size at block |
| kaia_getRewards | Block rewards |
| kaia_getStakingInfo | Staking information |
| kaia_getStorageRoot | Storage root at block |
| kaia_isContractAccount | Returns true if account is contract |
| kaia_signTransaction | Signs a transaction (node key) |
| kaia_signTransactionAsFeePayer | Signs as fee payer |

## Legacy Klaytn (klay_*)

The \`klay_*\` namespace mirrors \`kaia_*\` and \`eth_*\` for backward compatibility (e.g. klay_getBalance, klay_getBlockByNumber, klay_call, klay_chainId, klay_gasPrice, klay_getTransactionReceipt).

## Net (net_*)

| Method | Description |
|--------|-------------|
| net_listening | True if client is listening |
| net_peerCount | Number of connected peers |
| net_version | Network ID (deprecated, use eth_chainId) |

## Common usage

- **Block height:** \`eth_blockNumber\` or \`kaia_blockNumber\`
- **Balance:** \`eth_getBalance\` or \`getBalance\` (viem)
- **Gas price:** \`eth_gasPrice\` or \`getGasPrice\` (viem)
- **Call contract:** \`eth_call\` or \`readContract\` (viem)
- **Chain ID:** \`eth_chainId\` — Mainnet 8217, Kairos testnet 1001
`;

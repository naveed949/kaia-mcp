# Kaia MCP Server

Production-ready [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the [Kaia](https://kaia.io) blockchain. Exposes 25 tools, 5 resources, and 6 prompts for balance, transactions, blocks, tokens, NFTs, contracts, network info, and wallet utilities.

## Installation

```bash
npm install -g kaia-mcp
# or
npx kaia-mcp
```

## Quick start

**stdio (default)** — run and connect via stdin/stdout (e.g. Claude Desktop, Cursor):

```bash
npx kaia-mcp
# or
npx kaia-mcp --transport stdio
```

**HTTP** — run Streamable HTTP transport on a port:

```bash
npx kaia-mcp --transport http --port 3100
```

## Tools (25)

| Tool | Description |
|------|-------------|
| `get_kaia_balance` | Get KAIA balance for an address |
| `get_account_info` | Get account summary: balance, tx count, nonce |
| `get_account_tokens` | List ERC-20 token holdings for an address |
| `get_account_nfts` | List NFT holdings for an address |
| `get_transaction` | Get transaction by hash |
| `get_transaction_receipt` | Get transaction receipt and status |
| `get_account_transactions` | List recent transactions for an address |
| `estimate_gas` | Estimate gas for a transaction |
| `get_block_number` | Current block number |
| `get_block` | Get block by number or tag |
| `get_block_rewards` | Block rewards for a block |
| `get_token_info` | Token metadata (name, symbol, supply) |
| `get_token_holders` | Top token holders |
| `get_token_transfers` | Token transfer history |
| `get_nft_info` | NFT collection info |
| `get_nft_item` | Single NFT item (owner, metadata) |
| `get_nft_transfers` | NFT transfer history |
| `read_contract` | Read contract view/pure function |
| `get_contract_abi` | Verified contract ABI from KaiaScan |
| `get_contract_source` | Verified contract source from KaiaScan |
| `get_gas_price` | Current gas price |
| `get_kaia_price` | KAIA price (USD, BTC, stats) from KaiaScan |
| `get_chain_info` | Chain id and name (mainnet/kairos) |
| `generate_wallet` | Generate a new wallet keypair (address + private key hex) |
| `encode_function_data` | Encode contract call data from ABI and args |

## Resources (5)

| URI | Description |
|-----|-------------|
| `kaia://mainnet/status` | Mainnet status: block height, gas price, KAIA price |
| `kaia://kairos/status` | Kairos testnet status |
| `kaia://mainnet/tokens/popular` | Popular mainnet token addresses with name/symbol |
| `kaia://mainnet/top-accounts` | Top 100 KAIA holders |
| `kaia://docs/rpc-methods` | Static reference of Kaia RPC methods |

## Prompts (6)

| Name | Args | Description |
|------|------|-------------|
| `analyze-wallet` | address, network? | Analyze wallet: balance, txs, tokens |
| `investigate-transaction` | txHash | Investigate tx: status, gas, transfers |
| `token-research` | contractAddress, network? | Research token: supply, holders, activity |
| `nft-lookup` | contractAddress, tokenId, network? | Look up NFT: owner, metadata, history |
| `gas-report` | network? | Gas report: price, history, recommendations |
| `smart-contract-audit` | contractAddress, network? | Review contract: ABI, source, type |

## Configuration

Environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `KAIA_RPC_URL` | Kaia mainnet RPC endpoint | `https://public-en.node.kaia.io` |
| `KAIA_KAIROS_RPC_URL` | Kairos testnet RPC | `https://public-en-kairos.node.kaia.io` |
| `KAIASCAN_API_KEY` | KaiaScan API key (optional) | — |
| `KAIA_DEFAULT_NETWORK` | mainnet or kairos | mainnet |
| `LOG_LEVEL` | debug, info, warn, error | info |
| `RATE_LIMIT_RPC` | Max RPC requests per second | 10 |
| `RATE_LIMIT_KAIASCAN` | Max KaiaScan requests per second | 5 |
| `RPC_TIMEOUT_MS` | RPC request timeout (ms) | 30000 |
| `KAIASCAN_TIMEOUT_MS` | KaiaScan request timeout (ms) | 15000 |

## MCP client setup

**Cursor** — add to Cursor MCP settings (e.g. `~/.cursor/mcp.json` or project MCP config):

```json
{
  "mcpServers": {
    "kaia": {
      "command": "npx",
      "args": ["kaia-mcp"],
      "env": {}
    }
  }
}
```

**Claude Desktop** — in Claude Desktop config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "kaia": {
      "command": "npx",
      "args": ["kaia-mcp"],
      "env": {}
    }
  }
}
```

Override env as needed, e.g. `"env": { "KAIA_RPC_URL": "https://your-rpc.io", "KAIASCAN_API_KEY": "your-key" }`.

## Links

- [Kaia docs](https://docs.kaia.io)
- [KaiaScan API](https://docs.kaiascan.io)

## Programmatic use

```ts
import { createKaiaMcpServer, runKaiaMcpServer } from "kaia-mcp";

// Get the MCP Server instance (e.g. for custom transport)
const server = createKaiaMcpServer();

// Run over stdio (CLI default)
await runKaiaMcpServer();
```

For HTTP:

```ts
import { runKaiaMcpServerHttp } from "kaia-mcp";
await runKaiaMcpServerHttp(3100);
```

## Docker

```bash
docker build -t kaia-mcp .
docker run -p 3100:3100 -e KAIA_RPC_URL=https://public-en.node.kaia.io kaia-mcp
```

Server listens on port 3100 (Streamable HTTP transport). Override env as needed.

### Connecting to the Docker server

The container runs the **HTTP** transport (not stdio), so clients must connect by **URL**.

**Cursor** — in MCP settings (e.g. `~/.cursor/mcp.json` or project MCP config), add a server entry with `url`:

```json
{
  "mcpServers": {
    "kaia": {
      "url": "http://localhost:3100"
    }
  }
}
```

If your client expects a path, use `http://localhost:3100/mcp`. Restart Cursor after changing MCP config.

**Claude Desktop** — if your Claude Desktop build supports remote MCP URLs, use the same `url` in its MCP config.

**Test from the host** (with the container running):

```bash
curl -s -X POST http://localhost:3100 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

You should see a list of tools. Replace `localhost` with your machine’s IP or hostname when connecting from another device.

## License

MIT

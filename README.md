# Kaia MCP Server

Production-ready [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the [Kaia](https://kaia.io) blockchain. Exposes 25 partner-safe tools (26 if `KAIA_ALLOW_UNSAFE_WALLET=1`), 5 resources, and 6 prompts for balance, transactions, blocks, tokens, NFTs, contracts, network info, and calldata encoding.

HTTP is a partner-style connector: OAuth 2.1 with PKCE (browser) or device flow (CLI), fail-closed bearer auth, and token scopes mapped to an allowed-tool registry. An in-process demo IdP runs with the HTTP server so tests and CI need no real credentials. See [docs/AUTH.md](docs/AUTH.md).

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

**HTTP** — Streamable HTTP on a port. Partner default (`KAIA_AUTH_MODE=required`) requires `Authorization: Bearer` on every MCP request. The same process serves the demo OAuth/OIDC endpoints.

```bash
npx kaia-mcp --transport http --port 3100
# GET http://127.0.0.1:3100/health
# GET http://127.0.0.1:3100/.well-known/openid-configuration
```

## Tools (25 partner-safe)

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
| `get_token_allowance` | ERC-20/KIP-7 allowance (owner/spender) for DeFi |
| `get_nft_info` | NFT collection info |
| `get_nft_item` | Single NFT item (owner, metadata) |
| `get_nft_transfers` | NFT transfer history |
| `read_contract` | Read contract view/pure function |
| `get_contract_abi` | Verified contract ABI from KaiaScan |
| `get_contract_source` | Verified contract source from KaiaScan |
| `get_gas_price` | Current gas price |
| `get_kaia_price` | KAIA price (USD, BTC, stats) from KaiaScan |
| `get_chain_info` | Chain id and name (mainnet/kairos) |
| `encode_function_data` | Encode contract call data from ABI and args (`kaia:encode`) |
| `generate_wallet` | **Not in the default list.** Unsafe local-dev only (`KAIA_ALLOW_UNSAFE_WALLET=1` + `kaia:wallet`). Never returns private keys in partner mode. |

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
| `KAIA_AUTH_MODE` | HTTP auth: `required` or `off` | `required` |
| `KAIA_OAUTH_CLIENT_ID` | Demo public client id | `kaia-mcp-demo` |
| `KAIA_ACCESS_TOKEN_TTL_SECONDS` | Demo access-token TTL | 900 |
| `KAIA_OAUTH_AUDIENCE` | `aud` of issued JWT access tokens (and the only audience accepted) | `kaia-mcp` |
| `KAIA_OAUTH_SIGNING_KEY_FILE` | Dev RS256 key path, created 0600 if missing; keep it gitignored (`.kaia-dev/`) | unset (in-memory key per process) |
| `KAIA_INTROSPECTION_CLIENT_ID` | Gateway client id for `/oauth/introspect` | `kaia-mcp-gateway` |
| `KAIA_INTROSPECTION_CLIENT_SECRET` | Gateway secret (HTTP Basic). Unset: introspection is not offered | unset |
| `KAIA_ALLOW_UNSAFE_WALLET` | Enable `generate_wallet` private keys (local only) | off |

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

**Test from the host** (with the container running). Health is unauthenticated; MCP is not:

```bash
curl -s http://localhost:3100/health
# Obtain a demo token (see docs/AUTH.md), then:
curl -s -X POST http://localhost:3100 \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq
```

You should see a list of tools filtered by the token’s scopes. Replace `localhost` with your machine’s IP or hostname when connecting from another device.

## Partner integration

This server is an MCP connector, not a hosted product partnership. Integrate over HTTP with OAuth; do not treat stdio as a partner path.

### Integration checklist

1. Discover `/.well-known/oauth-protected-resource` and `/.well-known/openid-configuration` (demo) or your authorization server’s metadata. Access tokens are RS256 JWTs; fetch keys from the discovery `jwks_uri` and pin `iss` and `aud` (`kaia-mcp` by default) instead of trusting whatever the token says.
2. Register a **public** client. Require PKCE `S256` for browser agents; use device flow for CLIs that cannot host a redirect.
3. Allowlist redirect URIs. The demo IdP accepts only `http://127.0.0.1/callback`, `http://localhost/callback`, and `/cb` variants.
4. Request least privilege: `kaia:read` for chain reads, add `kaia:encode` only if the agent must build calldata. Never request `kaia:wallet` in production.
5. Send `Authorization: Bearer <access_token>` on **every** MCP HTTP request. Do not treat `Mcp-Session-Id` as authentication.
6. Handle fail-closed errors literally: `-32040` unauthorized, `-32041` token_expired, `-32042` insufficient_scope, `-32043` invalid_token. Retry only after a new token; do not retry a denied tool.
7. On disconnect or user logout, `POST /oauth/revoke` with the access or refresh token. Revocation is by `jti` and only the issuer knows about it: a gateway that verifies JWTs offline must also call `/oauth/introspect` (client-authenticated) if it needs to see revocations before `exp`.
8. Keep tokens out of logs, crash dumps, eval fixtures, and git. Prefer a token fingerprint if you must correlate requests.
9. Leave `KAIA_ALLOW_UNSAFE_WALLET` unset. `generate_wallet` must not appear in partner tool lists and must not return private keys.
10. Point production at your own OIDC issuer; the in-process demo IdP is for tests/CI/local bring-up only. No real user secrets or signing keys belong in this repo.
11. If you keep your own copy of the tool → scope map (e.g. in a policy gateway), compare it against `GET /.well-known/kaia-mcp/tool-scopes` at startup and refuse to run on drift.

### Threat notes

- **Scopes.** A `kaia:read` token must not call `encode_function_data`. Scope checks run before handlers; a deny has no chain or wallet side effect.
- **Secret handling.** Access tokens are signed JWTs and are not stored; refresh tokens are hashed at rest. The logger redacts bearer values and bare JWTs. The signing key is generated at startup (or read from a gitignored dev path) and only the public JWK is published. Wallet private keys are not emitted unless the explicit unsafe dev flag is on.
- **Offline verification vs revocation.** A JWT stays cryptographically valid until `exp` even after `/oauth/revoke`. kaia-mcp itself rejects revoked `jti`s; external verifiers need introspection or a short TTL.
- **Algorithm confusion.** Only `RS256` with the published `kid` is accepted; `alg=none`, `HS*`, and foreign keys fail as `invalid_token`.
- **Session fixation.** A stolen MCP session id without the bearer token cannot call tools when `KAIA_AUTH_MODE=required`.
- **PKCE downgrade.** `code_challenge_method=plain` is rejected.
- **Open redirect.** Unregistered `redirect_uri` values are rejected.
- **Fallbacks.** `KAIA_AUTH_MODE=off` and stdio skip OAuth. Those paths are local-only. Partners must not ship them as a “fallback” for failed authentication; failed auth is a deny.
- **Unsafe wallet flag.** If an operator enables `KAIA_ALLOW_UNSAFE_WALLET=1`, private keys can leave the process. Treat that as a break-glass local tool, not a partner feature.

Full protocol detail: [docs/AUTH.md](docs/AUTH.md).

## License

MIT

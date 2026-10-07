# Generate wallet gated

In partner/default mode the connector does not list `generate_wallet` and does not return a private key if an agent calls it anyway.

## Sub-features

- `wallet-omitted` keeps `generate_wallet` out of `tools/list`.
- `wallet-disabled` returns `tool_disabled` for `tools/call` `generate_wallet`.
- `wallet-no-key` response body has no `Private key (hex): 0x` value.

## How to get to it (user POV)

- Obtain any valid access token (PKCE with `kaia:read` and `kaia:wallet` is enough to show even wallet scope cannot enable the tool).
- Call MCP `tools/list`.
- Call MCP `tools/call` with name `generate_wallet`.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`.
- `doctor.sh` reports `unsafeWallet=false`.
- `KAIA_ALLOW_UNSAFE_WALLET` is unset on the launched process.

- **List tools.** Run `.cursor/skills/verify-kaia-mcp/helpers/drive.sh generate-wallet-gated`. It opens an MCP session (`initialize`, `notifications/initialized`) with the bearer first. `tools/list` body lists the read tools (24 for `kaia:read kaia:wallet`) and does not contain the string `generate_wallet`.
- **Call generate_wallet.** POST `tools/call` name `generate_wallet` arguments `{}`. Body includes `tool_disabled` or `-32044`.
- **Confirm no key.** The same body does not match `Private key (hex): 0x` followed by 64 hex characters.
- **Proof.** Evidence files `tools-list.json` and `generate-wallet.json` exist under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/generate-wallet-gated/`.

## Gotchas

- Enabling `KAIA_ALLOW_UNSAFE_WALLET=1` is a different configuration. Doctor must fail that instance for this feature.
- SSE framing may wrap JSON; still assert on the captured body text, not on a parsed SDK client.
- Absence of the tool in `tools/list` alone is not enough; the call path must also be proven.

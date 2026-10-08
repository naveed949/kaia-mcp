# kaia-mcp verification map

This directory is the maintained source for verifying the user-facing behavior of the kaia-mcp HTTP connector. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.cursor/skills/verify-kaia-mcp/helpers/launch.sh` so the instance uses a disposable port and `KAIA_VERIFY_RUN_ID`.
- Require `KAIA_AUTH_MODE=required` and `KAIA_ALLOW_UNSAFE_WALLET` unset. `launch.sh` also sets a short access-token TTL (`tokenTtlSeconds`, default 20) and a per-run introspection secret.
- Invoke the helpers from the repo root; do not attach to some other process on 3100.
- Run `.cursor/skills/verify-kaia-mcp/helpers/doctor.sh` and require `status=ok`, `authMode=required`, `unsafeWallet=false`, and the recorded issuer.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted names, scopes, and JSON-RPC method strings unchanged.
- Drive HTTP with curl (or `helpers/drive.sh <feature-id>`, which wraps those curls).
- MCP calls are real sessions: `initialize` with the bearer, then `notifications/initialized`, then the request with `Authorization` and `Mcp-Session-Id`.
- Do not follow OAuth redirects automatically; read the `Location` header for `code`.
- Restore nothing on the chain: these recipes use local encode/auth only.
- Tokens live for `tokenTtlSeconds`. Every recipe mints its own token right before use; do not reuse a token across recipes. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final JSON.
- HTTP proof includes status, response body, and (for OAuth) the `Location` header.
- Mutation proof for revoke includes a second MCP call with the same bearer.
- Record the feature ID and entry point used with every artifact under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- After cleanup, run `helpers/token-leak-check.sh`; a plaintext token in `server.log` is a product failure.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-kaia` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [OAuth PKCE scoped tools](./oauth-pkce-scoped-tools.md) covers discovery (no ID-token advertisement), browser PKCE consent, token exchange, a scope-allowed MCP tool call, plain-PKCE rejection, and Deny.
- [Fail-closed auth](./fail-closed-auth.md) covers missing bearer, insufficient scope (with its `outcome=denied` `Tool call` log line), unknown and crafted tool names (`reason=unknown_tool`, no forged log line), `Tool error` lines without caller input, and revoked token.
- [Generate wallet gated](./generate-wallet-gated.md) covers omission from tools/list and refusal to return a private key.
- [Device flow](./device-flow.md) covers CLI device authorization, user-code consent, and a scoped tool call.
- [JWT access tokens](./jwt-access-tokens.md) covers the JWT shape, offline verification via JWKS, forged and `alg=none` rejection, live expiry, the `Tool call` log line, and the tool-scopes metadata endpoint.
- [Token introspection](./token-introspection.md) covers client-authenticated RFC 7662 introspection of access and refresh tokens, revocation by `jti`, and refresh rotation.
- [Revocation across restart](./revocation-restart.md) covers revoked tokens staying rejected after a restart (persisted key + persisted denylist), a refresh rotation that cannot persist its revocation (503, retryable), refusal to start on a corrupt or group/world-writable denylist, and in-memory-key restarts invalidating every token.

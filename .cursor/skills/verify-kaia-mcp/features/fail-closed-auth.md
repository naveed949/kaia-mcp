# Fail-closed auth

Missing, insufficient-scope, and revoked tokens cannot call MCP tools. The connector returns a documented error code and does not execute the tool.

## Sub-features

- `auth-missing` rejects MCP POST without `Authorization`.
- `auth-deny-scope` rejects `encode_function_data` when the token has only `kaia:read`.
- `auth-revoked` rejects MCP POST after `POST /oauth/revoke`.

## How to get to it (user POV)

- POST JSON-RPC `initialize` or `tools/call` to `/` with no `Authorization` header.
- Complete PKCE with `scope=kaia:read`, then call `encode_function_data`.
- POST `/oauth/revoke` with the access token, then retry MCP with the same bearer.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`.
- `doctor.sh` reports `authMode=required`.

- **Missing token.** POST `/` with `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-kaia-mcp","version":"0"}}}` and no Authorization. Run `.cursor/skills/verify-kaia-mcp/helpers/drive.sh fail-closed-auth`. HTTP status is `401`. Body is `{"jsonrpc":"2.0","error":{"code":-32040,"message":"unauthorized: missing access token","data":{"error":"unauthorized"}},"id":null}`.
- **Deny by scope.** Finish PKCE with `scope=kaia:read`, open an MCP session (`initialize`, `notifications/initialized`), and call `tools/call` `encode_function_data` with the same balanceOf payload as the allow recipe. Response text includes `insufficient_scope: encode_function_data requires kaia:encode` (code `-32042`) and does not include `0x70a08231`.
- **Revoke.** POST `/oauth/revoke` with `token=<access_token>`, then POST `initialize` with that bearer. HTTP status is `401`. Body error code is `-32043` and message is `invalid_token: access token is invalid or revoked`.
- **Proof.** Evidence files `unauthenticated.json`, `deny-scope.init.headers`, `deny-scope.json`, `revoke.json`, and `revoked.json` exist under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/fail-closed-auth/`.

## Gotchas

- Expired tokens are driven live in [jwt-access-tokens](./jwt-access-tokens.md), which waits out the short launch TTL. The golden evals also cover `token_expired` / `-32041`.
- `WWW-Authenticate` is present on 401s; it is not a substitute for asserting the JSON-RPC `code`.
- A 200 JSON-RPC error for insufficient scope is still a deny. Do not require HTTP 401 for that sub-feature.

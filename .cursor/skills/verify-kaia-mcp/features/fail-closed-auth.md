# Fail-closed auth

Missing, insufficient-scope, and revoked tokens cannot call MCP tools. Insufficient scope is HTTP 403 with a Bearer `insufficient_scope` challenge; the others are 401. The connector returns a documented error code and does not execute the tool.

## Sub-features

- `auth-missing` rejects MCP POST without `Authorization`.
- `auth-deny-scope` rejects `encode_function_data` when the token has only `kaia:read` with HTTP `403`, `WWW-Authenticate: Bearer … error="insufficient_scope" … scope="kaia:encode"`, and a JSON-RPC `-32042` body, and logs one `msg=Tool call tool=encode_function_data outcome=denied errorCode=-32042 reason=insufficient_scope` line with no arguments.
- `auth-unknown-tool` rejects a `tools/call` whose name is not in the tool-scope map with `-32602`, and logs one `outcome=denied errorCode=-32602 reason=unknown_tool` line, never `outcome=allowed`. A crafted name with spaces, `=` and CR/LF is percent-encoded in that line, so it cannot forge a second `Tool call` line or add a field.
- `auth-tool-error-hygiene` logs a client mistake (unknown tool, resource or prompt name, bad arguments, an in-band auth denial) as `level=info msg=Request denied code=<code> method=<method> category=<category> errorType=<name> outcome=denied`, never at error level, and keeps server-side `msg=Tool error` lines (`level=error`) to `code=<code> category=<category> errorType=<name>`. Neither carries caller input.
- `auth-revoked` rejects MCP POST after `POST /oauth/revoke`.

## How to get to it (user POV)

- POST JSON-RPC `initialize` or `tools/call` to `/` with no `Authorization` header.
- Complete PKCE with `scope=kaia:read`, then call `encode_function_data`.
- Call `tools/call` with `name` `no_such_tool`, and with a name containing ` outcome=allowed`, a newline and a fake `msg=Tool call` line.
- POST `/oauth/revoke` with the access token, then retry MCP with the same bearer.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`.
- `doctor.sh` reports `authMode=required`.

- **Missing token.** POST `/` with `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-kaia-mcp","version":"0"}}}` and no Authorization. Run `.cursor/skills/verify-kaia-mcp/helpers/drive.sh fail-closed-auth`. HTTP status is `401`. Body is `{"jsonrpc":"2.0","error":{"code":-32040,"message":"unauthorized: missing access token","data":{"error":"unauthorized"}},"id":null}`.
- **Deny by scope.** Finish PKCE with `scope=kaia:read`, and (one stateless POST, no `initialize`) call `tools/call` `encode_function_data` with the same balanceOf payload as the allow recipe. Response text includes `insufficient_scope: encode_function_data requires kaia:encode` (code `-32042`) and does not include `0x70a08231`. `deny-scope.headers` is `HTTP/1.1 403` with `www-authenticate: Bearer realm="kaia-mcp", error="insufficient_scope", scope="kaia:encode", …`. `deny-scope.tool-call-log-count.json` shows one new `outcome=denied` line, and `deny-scope.tool-call-line.txt` has `errorCode=-32042` and `reason=insufficient_scope` but no `balanceOf`.
- **Unknown and crafted tool names.** With the same `kaia:read` token, `tools/call` `no_such_tool` and then the crafted name. Both responses contain `-32602`. `unknown-tool.log-count.json` shows `unknownAfter = unknownBefore + 1`, `allowedAfter = allowedBefore` (no new allowed `Tool call` line for any tool) and `formatViolations = 0`. `unknown-tool.tool-call-lines.txt` has two lines, both `outcome=denied errorCode=-32602 reason=unknown_tool`; the second logs the crafted name as `tool=get_chain_info%20outcome%3Dallowed%0Alevel%3Dinfo…`. `request-denied-lines.txt` holds two `level=info msg=Request denied code=-32602 method=tools/call category=invalid_params errorType=ProtocolError outcome=denied` lines with no `no_such_tool` or crafted text, and `tool-error-lines.txt` has no `code=-32602` line.
- **Revoke.** POST `/oauth/revoke` with `token=<access_token>`, then POST `initialize` with that bearer. HTTP status is `401`. Body error code is `-32043` and message is `invalid_token: access token is invalid or revoked`.
- **Proof.** Evidence files `unauthenticated.json`, `deny-scope.headers`, `deny-scope.json`, `deny-scope.tool-call-log-count.json`, `deny-scope.tool-call-line.txt`, `unknown-tool.json`, `forged-tool.json`, `unknown-tool.log-count.json`, `unknown-tool.tool-call-lines.txt`, `request-denied-lines.txt`, `tool-error-lines.txt`, `revoke.json`, and `revoked.json` exist under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/fail-closed-auth/`.

## Gotchas

- Expired tokens are driven live in [jwt-access-tokens](./jwt-access-tokens.md), which waits out the short launch TTL. The golden evals also cover `token_expired` / `-32041`.
- `WWW-Authenticate` is present on 401 and 403; it is not a substitute for asserting the JSON-RPC `code`. The full challenge grammar is [bearer-challenges](./bearer-challenges.md).
- Revocation surviving a restart is its own recipe: [revocation-restart](./revocation-restart.md).
- Insufficient scope is HTTP 403, not 401 (the token is valid, it just lacks the scope) and not 200. SDK clients surface it as an HTTP error, so assert the captured body for `-32042`.
- Count allowed calls on the structured fields only: lines matching `^timestamp=\S+ level=info msg=Tool call tool=\S+ outcome=allowed( |$)` (drive.sh `allowed_outcome_total`), across every tool, so a crafted name adding an allowed line for any tool is caught. Never `grep -c outcome=allowed` over the whole log: that also counts text inside other fields. Every value is one percent-encoded token, so `tool=\S+` is exact.

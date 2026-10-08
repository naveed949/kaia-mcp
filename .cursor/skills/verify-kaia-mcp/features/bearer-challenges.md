# Bearer challenges

Every authentication failure on the MCP endpoint tells the client where to get a token. A 401 carries an RFC 6750 `WWW-Authenticate: Bearer` challenge with the RFC 9728 `resource_metadata` URL and a starting `scope`. A valid token that lacks a tool's scope gets HTTP 403 with `error="insufficient_scope"` and the required `scope`, while the body stays the JSON-RPC `-32042` error with the request `id`.

## Sub-features

- `challenge-no-credentials` answers a POST without `Authorization` with `401`, `WWW-Authenticate: Bearer realm="kaia-mcp", resource_metadata="<issuer>/.well-known/oauth-protected-resource", scope="kaia:read"` (no `error`), and body code `-32040`.
- `challenge-invalid-token` answers a garbage bearer with `401`, a challenge with `error="invalid_token"` and `resource_metadata`, and body code `-32043`.
- `challenge-insufficient-scope` answers a `kaia:read` token calling `encode_function_data` with `403`, `WWW-Authenticate: Bearer … error="insufficient_scope", scope="kaia:encode", resource_metadata="…"`, body `{"jsonrpc":"2.0","id":7,"error":{"code":-32042,…,"data":{"error":"insufficient_scope",…}}}`, one `outcome=denied` log line, and no calldata.
- `challenge-prm` serves the protected resource metadata at the `resource_metadata` URL with `resource` equal to the issuer.

## How to get to it (user POV)

- POST `initialize` to `/` with no `Authorization`, then with `Authorization: Bearer not-a-jwt`.
- Get a `kaia:read` token (device flow) and `tools/call` `encode_function_data` with JSON-RPC `id` 7; then `tools/list` with the same token.
- `GET` the `resource_metadata` URL from the 401 challenge.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`, and `doctor.sh` passes.

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh bearer-challenges`.
- **No credentials.** `no-token.headers` is `HTTP/1.1 401` with the challenge above and no `error=`; `no-token.json` has `error.code=-32040`.
- **Invalid token.** `bad-token.headers` is `HTTP/1.1 401` with `error="invalid_token"`; `bad-token.json` has `error.code=-32043`.
- **Insufficient scope.** `insufficient.headers` is `HTTP/1.1 403` with `error="insufficient_scope"`, `scope="kaia:encode"`, `resource_metadata`. `insufficient.json` has `id=7`, `error.code=-32042`, and no `0x70a08231…`. `insufficient.tool-call-log-count.json` shows `after = before + 1`. `allowed-list.headers` is `HTTP/1.1 200`.
- **Metadata.** `prm.json` has `resource` equal to the instance issuer.
- **Proof.** All of the files above are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/bearer-challenges/`.

## Gotchas

- The 403 is decided before the MCP server runs. `tool_disabled` (`generate_wallet`), unknown tools and tool errors stay HTTP 200 JSON-RPC errors; do not expect 403 for them.
- MCP SDK clients raise an HTTP error for the 403 instead of a JSON-RPC error. The body is still the `-32042` error; gateways that parse the body keep working.
- The 401 `scope` is the least-privilege starting scope (`kaia:read`), not a list of every scope.

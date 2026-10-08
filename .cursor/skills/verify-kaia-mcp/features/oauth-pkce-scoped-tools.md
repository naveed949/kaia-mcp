# OAuth PKCE scoped tools

A partner agent discovers the demo authorization server, sends the user through Authorization Code + PKCE S256 consent, exchanges the code for an access token, and calls an MCP tool allowed by the granted scope.

## Sub-features

- `pkce-discover` loads authorization-server metadata. It advertises `response_types_supported=["code"]` and no ID-token support or other OIDC-only metadata (no `subject_types_supported`), because no ID tokens are issued.
- `pkce-consent` shows the consent page and records Approve.
- `pkce-token` exchanges `code` + `code_verifier` for an access token.
- `pkce-allow` calls `encode_function_data` with scope `kaia:encode`.
- `pkce-plain-rejected` refuses `code_challenge_method=plain` with no consent page.
- `pkce-deny` redirects with `error=access_denied` and no `code` when the user picks Deny.

## How to get to it (user POV)

- Open `GET /.well-known/openid-configuration` on the connector origin.
- Open `GET /oauth/authorize` with `client_id=kaia-mcp-demo`, `redirect_uri=http://127.0.0.1/callback`, `response_type=code`, `scope=kaia:encode`, `code_challenge`, `code_challenge_method=S256`, and `state`.
- Choose `Approve` (or `Deny`) on the consent form (`POST /oauth/consent`).
- Exchange the redirected `code` at `POST /oauth/token`.
- Call MCP `POST /` method `tools/call` name `encode_function_data` with `Authorization: Bearer`.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`.
- `doctor.sh` reports `authMode=required` and `unsafeWallet=false`.
- No access token has been issued yet for this recipe.

- **Discover.** Fetch metadata. Run `.cursor/skills/verify-kaia-mcp/helpers/drive.sh oauth-pkce-scoped-tools` (or `curl -sS http://127.0.0.1:<port>/.well-known/openid-configuration`). Body includes `"code_challenge_methods_supported":["S256"]`, `authorization_endpoint`, and `"response_types_supported":["code"]`. The document does not mention `id_token` anywhere and has no `subject_types_supported`.
- **Open consent.** GET `/oauth/authorize` with PKCE S256 and `scope=kaia:encode`. HTML title contains `Authorize kaia-mcp` and lists `kaia:encode`.
- **Approve.** POST `/oauth/consent` with `request_id` from the hidden field and `decision=approve` without following redirects. `Location` contains `code` and `state=verify1`.
- **Exchange token.** POST `/oauth/token` with `grant_type=authorization_code`, `code_verifier`, and the same `redirect_uri`. Body includes `"token_type":"Bearer"` and `"scope":"kaia:encode"`.
- **Call allowed tool.** Every MCP call runs `initialize` (bearer) first, reads `Mcp-Session-Id`, sends `notifications/initialized`, then sends the request with both headers. POST `/` JSON-RPC `tools/call` `encode_function_data` with ABI `balanceOf` and address `0x1234567890123456789012345678901234567890`. Body contains `0x70a082310000000000000000000000001234567890123456789012345678901234567890`.
- **Reject plain PKCE.** GET `/oauth/authorize` with `code_challenge_method=plain&state=verify-plain` without following redirects. `Location` contains `error=invalid_request` and `PKCE+S256+is+required`; no consent HTML.
- **Deny.** Open a fresh S256 consent and POST `decision=deny`. `Location` contains `error=access_denied` and `state=verify-deny`, and no `code`.
- **Proof.** Evidence files `discovery.json`, `consent.html`, `consent.headers`, `token.json`, `allow.init.headers`, `allow.json`, `plain-pkce.headers`, and `deny.headers` exist under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/oauth-pkce-scoped-tools/`.

## Gotchas

- Following the consent redirect consumes nothing, but you will miss the `code` query if curl is allowed to follow `Location`.
- `code_challenge_method=plain` is rejected with a redirect to `redirect_uri?error=invalid_request`; do not treat that as a successful consent page.
- A `tools/call` without `initialize` returns `-32000 Bad Request: Server not initialized`. That is a harness mistake, not an auth outcome.
- A token with only `kaia:read` is a different feature (`fail-closed-auth`). Do not count it as this allow path.

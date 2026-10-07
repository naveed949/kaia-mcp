# Partner authentication

kaia-mcp HTTP transport is a partner-style MCP connector. It ships an in-process **demo OIDC/OAuth 2.1** provider so tests and local runs need no real IdP credentials. Production partners replace the demo issuer with their own authorization server; token verification and the tool-scope registry stay the same.

Stdio remains a local-process transport. It does not speak OAuth. `generate_wallet` is still disabled unless `KAIA_ALLOW_UNSAFE_WALLET=1`.

## Modes

| `KAIA_AUTH_MODE` | Transport | Effect |
|---|---|---|
| `required` (default) | HTTP | Every MCP request must send `Authorization: Bearer <access_token>`. Missing, expired, revoked, or insufficient-scope tokens fail closed. |
| `off` | HTTP | Local debug only. MCP tools run without a bearer token. Do not use for partners. |
| n/a | stdio | Local desktop. No bearer check. |

## Scopes and tools

The session stores the access token’s scopes and maps them onto the allowed-tool registry.

| Scope | Tools |
|---|---|
| `kaia:read` | All chain/account/token/NFT/contract/network read tools, including `estimate_gas` |
| `kaia:encode` | `encode_function_data` |
| `kaia:wallet` | `generate_wallet` (also requires `KAIA_ALLOW_UNSAFE_WALLET=1`) |

Default partner tool list **omits** `generate_wallet`. A call still fails with `tool_disabled` (`-32044`) and does not generate a key.

## Error codes (fail closed, no side effect)

| Situation | HTTP | JSON-RPC `code` | `data.error` | Message |
|---|---|---|---|---|
| Missing `Authorization` | 401 | `-32040` | `unauthorized` | `unauthorized: missing access token` |
| Expired access token | 401 | `-32041` | `token_expired` | `token_expired: access token has expired` |
| Token lacks the tool’s scope | 200 (MCP error) | `-32042` | `insufficient_scope` | `insufficient_scope: <tool> requires <scope>` |
| Unknown, malformed, or revoked token | 401 | `-32043` | `invalid_token` | `invalid_token: access token is invalid or revoked` |
| `generate_wallet` in partner mode | MCP error | `-32044` | `tool_disabled` | `tool_disabled: generate_wallet is not available in partner mode; set KAIA_ALLOW_UNSAFE_WALLET=1 for local development only` |

The matching tool handler is never invoked on these paths.

Tokens are stored hashed. Logs emit a 12-character fingerprint, never the raw token. `Authorization`, `access_token`, `refresh_token`, `code_verifier`, and `device_code` fields are redacted if they reach the logger.

## Browser flow (Authorization Code + PKCE S256)

`plain` PKCE is rejected.

1. Discover: `GET /.well-known/openid-configuration` and `GET /.well-known/oauth-protected-resource`.
2. Create a PKCE pair (`code_verifier` 43–128 chars; `code_challenge = BASE64URL(SHA256(verifier))`).
3. Open the browser at:

```
GET /oauth/authorize
  ?client_id=kaia-mcp-demo
  &redirect_uri=http://127.0.0.1/callback
  &response_type=code
  &scope=kaia:read%20kaia:encode
  &code_challenge=<challenge>
  &code_challenge_method=S256
  &state=<csrf>
```

4. Consent page lists requested scopes. **Approve** redirects to `redirect_uri?code=...&state=...`. **Deny** redirects with `error=access_denied`.
5. Exchange the code (public client, no secret):

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&client_id=kaia-mcp-demo
&code=<code>
&code_verifier=<verifier>
&redirect_uri=http://127.0.0.1/callback
```

6. Call MCP with `Authorization: Bearer <access_token>`. The MCP session (`Mcp-Session-Id`) is not an auth credential; every request is re-validated against the bearer token (expiry and revocation).

Registered demo redirect URIs: `http://127.0.0.1/callback`, `http://localhost/callback`, `http://127.0.0.1/cb`, `http://localhost/cb`.

## CLI flow (Device Authorization Grant)

1. `POST /oauth/device` with `client_id=kaia-mcp-demo` and `scope=...`.
2. Response includes `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`.
3. Show `user_code` to the operator. They open `verification_uri`, enter the code, and approve.
4. Poll `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` until success, `authorization_pending`, `access_denied`, or `expired_token`.

## Consent and revoke

- Consent is explicit (Approve / Deny) on `/oauth/consent` (browser) and `/oauth/device/verify` (device).
- `POST /oauth/revoke` with `token=<access_or_refresh>` immediately invalidates the token. Subsequent MCP calls return `invalid_token`.
- Refresh: `grant_type=refresh_token` rotates the refresh token and revokes the previous access token.

## Demo client

| Field | Value |
|---|---|
| `client_id` | `kaia-mcp-demo` (override with `KAIA_OAUTH_CLIENT_ID`) |
| Client type | Public (PKCE required, no client secret) |
| Demo subject | `demo-user` |
| Access token TTL | 900s (`KAIA_ACCESS_TOKEN_TTL_SECONDS`) |

This IdP is for tests, CI, and local partner bring-up. It is not a production identity provider.

## MCP over HTTP

```bash
# After obtaining ACCESS_TOKEN
curl -s -X POST http://127.0.0.1:3100 \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Health (`GET /health`) is unauthenticated so operators can doctor an instance.

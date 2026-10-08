# Partner authentication

kaia-mcp HTTP transport is a partner-style MCP connector. It ships an in-process **demo OIDC/OAuth 2.1** provider so tests and local runs need no real IdP credentials. Production partners replace the demo issuer with their own authorization server; token verification and the tool-scope registry stay the same.

Stdio remains a local-process transport. It does not speak OAuth. `generate_wallet` is still disabled unless `KAIA_ALLOW_UNSAFE_WALLET=1`.

## Modes

| `KAIA_AUTH_MODE`     | Transport | Effect                                                                                                                                   |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `required` (default) | HTTP      | Every MCP request must send `Authorization: Bearer <access_token>`. Missing, expired, revoked, or insufficient-scope tokens fail closed. |
| `off`                | HTTP      | Local debug only. MCP tools run without a bearer token. Do not use for partners.                                                         |
| n/a                  | stdio     | Local desktop. No bearer check.                                                                                                          |

## Scopes and tools

The session stores the access token’s scopes and maps them onto the allowed-tool registry.

| Scope         | Tools                                                                             |
| ------------- | --------------------------------------------------------------------------------- |
| `kaia:read`   | All chain/account/token/NFT/contract/network read tools, including `estimate_gas` |
| `kaia:encode` | `encode_function_data`                                                            |
| `kaia:wallet` | `generate_wallet` (also requires `KAIA_ALLOW_UNSAFE_WALLET=1`)                    |

Default partner tool list **omits** `generate_wallet`. A call still fails with `tool_disabled` (`-32044`) and does not generate a key.

## Error codes (fail closed, no side effect)

| Situation                                                                                      | HTTP            | JSON-RPC `code` | `data.error`         | Message                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------- | --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Missing `Authorization`                                                                        | 401             | `-32040`        | `unauthorized`       | `unauthorized: missing access token`                                                                                         |
| Expired access token                                                                           | 401             | `-32041`        | `token_expired`      | `token_expired: access token has expired`                                                                                    |
| Token lacks the tool’s scope                                                                   | 200 (MCP error) | `-32042`        | `insufficient_scope` | `insufficient_scope: <tool> requires <scope>`                                                                                |
| Unknown, malformed, forged, wrong `iss`/`aud`, not-yet-valid (`nbf`), or revoked (`jti`) token | 401             | `-32043`        | `invalid_token`      | `invalid_token: access token is invalid or revoked`                                                                          |
| `generate_wallet` in partner mode                                                              | MCP error       | `-32044`        | `tool_disabled`      | `tool_disabled: generate_wallet is not available in partner mode; set KAIA_ALLOW_UNSAFE_WALLET=1 for local development only` |

The matching tool handler is never invoked on these paths.

Access tokens are not stored (they are self-contained JWTs); refresh tokens are stored hashed. Logs emit a 12-character sha256 fingerprint and the `jti`, never the raw token. `Authorization`, `access_token`, `refresh_token`, `client_secret`, `code_verifier`, and `device_code` fields, `Bearer …` values, and bare compact JWTs are redacted if they reach the logger.

Every `tools/call` that reaches kaia-mcp logs one `Tool call` info line, written after the authorization decision: `msg=Tool call tool=<name> outcome=allowed tokenFingerprint=<fp>`, or `msg=Tool call tool=<name> outcome=denied errorCode=<-3204x> reason=<error> [tokenFingerprint=<fp>]`. It never includes arguments or token material. Allowed and denied calls share the `msg=Tool call tool=<name> ` prefix, so a gateway in front of kaia-mcp can count those lines to prove a call it denied never arrived.

## Access tokens (JWT) and JWKS

Access tokens are RS256-signed JWTs in the RFC 9068 shape. Header: `{"alg":"RS256","typ":"at+jwt","kid":"<RFC 7638 thumbprint>"}`. Claims:

| Claim        | Value                                             |
| ------------ | ------------------------------------------------- |
| `iss`        | The server's issuer, e.g. `http://127.0.0.1:3100` |
| `aud`        | `KAIA_OAUTH_AUDIENCE` (default `kaia-mcp`)        |
| `sub`        | Subject (`demo-user` in the demo IdP)             |
| `client_id`  | OAuth client that obtained the token              |
| `scope`      | Space-separated scopes                            |
| `iat`, `nbf` | Issue time (seconds)                              |
| `exp`        | `iat + KAIA_ACCESS_TOKEN_TTL_SECONDS`             |
| `jti`        | Random UUID, the revocation handle                |

Public keys: `GET /oauth/jwks` (also `jwks_uri` in discovery). Only the public JWK (`kty`, `n`, `e`, `kid`, `use`, `alg`) is published.

kaia-mcp verifies every request itself: `alg` must be exactly `RS256`, `kid` must match the active key, the signature must verify, `iss` and `aud` must match, `exp` must be in the future (else `token_expired`), `nbf` must have passed, and the `jti` must not be revoked. Anything else is `invalid_token`.

### Signing key

| Setting                              | Behavior                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| default                              | A fresh RSA-2048 key is generated at startup and kept in memory. Restarting the server invalidates every outstanding token.                          |
| `KAIA_OAUTH_SIGNING_KEY_FILE=<path>` | Dev persistence. The PKCS#8 PEM is loaded from `<path>`, or created there with mode `0600`. Use a gitignored path; `.kaia-dev/` is ignored for this. |

No signing key is committed. Production deployments use their own authorization server and never this provider.

## Revocation and introspection

`POST /oauth/revoke` (RFC 7009) with `token=<access_or_refresh>` always answers `200 {}`.

- Access token: its `jti` is added to an in-memory revocation set until the token's `exp`.
- Refresh token: the refresh token is revoked and so is the `jti` of the access token it was issued with.
- Refresh rotation (`grant_type=refresh_token`) revokes the previous access `jti`.

A revoked JWT still has a valid signature until `exp`. Anything that verifies tokens offline from the JWKS cannot see revocation on its own. For that, kaia-mcp offers **RFC 7662 introspection**:

```
POST /oauth/introspect
Authorization: Basic base64(<KAIA_INTROSPECTION_CLIENT_ID>:<KAIA_INTROSPECTION_CLIENT_SECRET>)
Content-Type: application/x-www-form-urlencoded

token=<access_token>
```

- **Client-authenticated** (`client_secret_basic`), not local-only. It is offered only when `KAIA_INTROSPECTION_CLIENT_SECRET` is set; otherwise the route returns `404` and discovery omits `introspection_endpoint`. The client id defaults to `kaia-mcp-gateway`. The secret is compared in constant time.
- Missing or wrong credentials: `401 {"error":"invalid_client",…}` with `WWW-Authenticate: Basic`.
- A valid, unexpired, unrevoked access token for this issuer and audience: `{"active":true,"token_type":"Bearer","scope","client_id","sub","aud","iss","exp","iat","nbf","jti"}`.
- Anything else, including refresh tokens, expired, forged, and revoked tokens: `{"active":false}`.

The response never echoes the token.

## Tool → scope metadata

`GET /.well-known/kaia-mcp/tool-scopes` (unauthenticated, like other metadata) returns `{"resource":"kaia-mcp","scopes":[…],"tool_scopes":{"<tool>":"<scope>",…}}` from the same registry kaia-mcp enforces. Gateways that keep their own copy of the map compare against it to detect drift.

## Browser flow (Authorization Code + PKCE S256)

`plain` PKCE is rejected.

1. Discover: `GET /.well-known/openid-configuration` and `GET /.well-known/oauth-protected-resource`.

   The authorization-server metadata is served at both `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/openid-configuration`. This demo IdP issues no ID tokens, so the document has no `id_token_signing_alg_values_supported`, `response_types_supported` is `["code"]`, and `openid` is not a supported scope.

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
- `POST /oauth/revoke` with `token=<access_or_refresh>` immediately invalidates the token at kaia-mcp (by `jti`). Subsequent MCP calls return `invalid_token`. See [Revocation and introspection](#revocation-and-introspection) for what offline verifiers see.
- Refresh: `grant_type=refresh_token` rotates the refresh token and revokes the previous access token.

## Demo client

| Field               | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| `client_id`         | `kaia-mcp-demo` (override with `KAIA_OAUTH_CLIENT_ID`)        |
| Client type         | Public (PKCE required, no client secret)                      |
| Demo subject        | `demo-user`                                                   |
| Access token TTL    | 900s (`KAIA_ACCESS_TOKEN_TTL_SECONDS`)                        |
| Access token format | RS256 JWT, `aud` = `KAIA_OAUTH_AUDIENCE` (default `kaia-mcp`) |

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

Health (`GET /health`), discovery, `GET /oauth/jwks`, and `GET /.well-known/kaia-mcp/tool-scopes` are unauthenticated so operators and gateways can doctor an instance.

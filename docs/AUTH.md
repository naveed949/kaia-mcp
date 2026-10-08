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

The HTTP transport is stateless (see [Stateless HTTP](#stateless-http-mcp-2026-07-28)): each request's own access token is the only authority, and its scopes map onto the allowed-tool registry.

`tools/list` stays filtered per token: it lists only the tools the token's scopes allow (and never `generate_wallet` unless the unsafe flag is set). This is deliberate: a client should not be shown tools it cannot call, and it leaks nothing a scope-holder may not already use. The result therefore depends on the caller's token. MCP 2026-07-28 lets servers mark list results with `cacheScope`; SDK 1.32 has no such field, so `cacheScope: "private"` is a phase 2 item (SDK v2). Until then, intermediaries must not share a cached `tools/list` across tokens.

| Scope         | Tools                                                                             |
| ------------- | --------------------------------------------------------------------------------- |
| `kaia:read`   | All chain/account/token/NFT/contract/network read tools, including `estimate_gas` |
| `kaia:encode` | `encode_function_data`                                                            |
| `kaia:wallet` | `generate_wallet` (also requires `KAIA_ALLOW_UNSAFE_WALLET=1`)                    |

Default partner tool list **omits** `generate_wallet`. A call still fails with `tool_disabled` (`-32044`) and does not generate a key.

## Error codes (fail closed, no side effect)

| Situation                                                                                      | HTTP      | JSON-RPC `code` | `data.error`         | Message                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------- | --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Missing `Authorization`                                                                        | 401       | `-32040`        | `unauthorized`       | `unauthorized: missing access token`                                                                                         |
| Expired access token                                                                           | 401       | `-32041`        | `token_expired`      | `token_expired: access token has expired`                                                                                    |
| Token lacks the tool’s scope (`tools/call`)                                                    | 403       | `-32042`        | `insufficient_scope` | `insufficient_scope: <tool> requires <scope>`                                                                                |
| Unknown, malformed, forged, wrong `iss`/`aud`, not-yet-valid (`nbf`), or revoked (`jti`) token | 401       | `-32043`        | `invalid_token`      | `invalid_token: access token is invalid or revoked`                                                                          |
| `generate_wallet` in partner mode                                                              | MCP error | `-32044`        | `tool_disabled`      | `tool_disabled: generate_wallet is not available in partner mode; set KAIA_ALLOW_UNSAFE_WALLET=1 for local development only` |

The matching tool handler is never invoked on these paths.

Bearer challenges (RFC 6750, RFC 9728, MCP 2026-07-28 authorization):

- Every 401 carries `WWW-Authenticate: Bearer realm="kaia-mcp", [error="invalid_token", error_description="…",] resource_metadata="<issuer>/.well-known/oauth-protected-resource", scope="kaia:read"`. `error` is omitted when the request had no credentials at all. `scope` is the least-privilege scope for basic use.
- An insufficient-scope `tools/call` gets HTTP **403** with `WWW-Authenticate: Bearer realm="kaia-mcp", error="insufficient_scope", scope="<required scope>", resource_metadata="…", error_description="…"`. The body is still the JSON-RPC `-32042` error above, with the request's `id`, so gateways that parse bodies (s1-tool-gate) keep working. It is decided before the MCP server runs, with the same gate the tool handler uses; `tool_disabled`, unknown tools and other tool errors stay in-band JSON-RPC errors on HTTP 200.

Transport-level refusals (before auth):

| Situation                             | HTTP | Body                                                                                  |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `Origin` present and not allow-listed | 403  | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Forbidden: Origin not allowed"}}` |
| `GET` or `DELETE` on the MCP endpoint | 405  | JSON-RPC `-32000`, header `Allow: POST`                                               |
| Body is not JSON                      | 400  | JSON-RPC `-32700`                                                                     |
| Body over 4 MB                        | 413  | JSON-RPC `-32600`                                                                     |

Access tokens are not stored (they are self-contained JWTs); refresh tokens are stored hashed. Logs emit a 12-character sha256 fingerprint and the `jti`, never the raw token. `Authorization`, `access_token`, `refresh_token`, `client_secret`, `code_verifier`, and `device_code` fields, `Bearer …` values, and bare compact JWTs are redacted if they reach the logger.

Every `tools/call` that reaches kaia-mcp logs one `Tool call` info line, written after the authorization decision: `msg=Tool call tool=<name> outcome=allowed tokenFingerprint=<fp>`, or `msg=Tool call tool=<name> outcome=denied errorCode=<code> reason=<error> [tokenFingerprint=<fp>]`. It never includes arguments or token material. Allowed and denied calls share the `msg=Tool call tool=<name> ` prefix, so a gateway in front of kaia-mcp can count those lines to prove a call it denied never arrived.

- `reason` is the auth error (`unauthorized`, `token_expired`, `insufficient_scope`, `invalid_token`, `tool_disabled`), `unknown_tool` (`errorCode=-32602`) for a name outside the tool-scope map, or `internal_error` (`errorCode=-32603`) when authorization itself failed unexpectedly. Every one of these fails closed.
- `<name>` is caller input. Names made only of `[A-Za-z0-9_.-]` (every real tool) are logged unchanged; anything else is percent-encoded (UTF-8 bytes, capped at 128), so a crafted name cannot add fields or lines.
- The logger escapes CR, LF and every other control character in all messages and values: one entry is always one line.
- Tool, resource and prompt failures log `msg=Tool error code=<code> category=<auth|rpc_provider|kaiascan_api|rate_limit|invalid_params|internal|...> errorType=<Error name>`, never the error message, which often echoes caller input.

## Access tokens (JWT) and JWKS

Access tokens are RS256-signed JWTs in the RFC 9068 shape. Header: `{"alg":"RS256","typ":"at+jwt","kid":"<RFC 7638 thumbprint>"}`. Claims:

| Claim        | Value                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `iss`        | The issuer: `KAIA_PUBLIC_URL`, or `http://127.0.0.1:<port>`                                                    |
| `aud`        | The canonical resource URI (same value as `iss`); `[<uri>, <legacy>]` when `KAIA_OAUTH_LEGACY_AUDIENCE` is set |
| `sub`        | Subject (`demo-user` in the demo IdP)                                                                          |
| `client_id`  | OAuth client that obtained the token                                                                           |
| `scope`      | Space-separated scopes                                                                                         |
| `iat`, `nbf` | Issue time (seconds)                                                                                           |
| `exp`        | `iat + KAIA_ACCESS_TOKEN_TTL_SECONDS`                                                                          |
| `jti`        | Random UUID, the revocation handle                                                                             |

Public keys: `GET /oauth/jwks` (also `jwks_uri` in discovery). Only the public JWK (`kty`, `n`, `e`, `kid`, `use`, `alg`) is published: the current key first, then any retired keys from `KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES`.

kaia-mcp verifies every request itself: `alg` must be exactly `RS256`, `kid` must match the current or a retired key, the signature must verify, `iss` must match and `aud` must contain this server's canonical resource URI (RFC 8707; a token for any other audience, including a legacy-only `kaia-mcp`, is `invalid_token`), `exp` must be in the future (else `token_expired`), `nbf` must have passed, and the `jti` must not be revoked. Anything else is `invalid_token`.

### Signing key

| Setting                                               | Behavior                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default                                               | A fresh RSA-2048 key is generated at startup and kept in memory. Restarting the server invalidates every outstanding token.                                                                                                                                                                                                        |
| `KAIA_OAUTH_SIGNING_KEY_FILE=<path>`                  | Dev persistence. The PKCS#8 PEM is loaded from `<path>`, or created there with mode `0600`. Use a gitignored path; `.kaia-dev/` is ignored for this.                                                                                                                                                                               |
| `KAIA_OAUTH_REVOCATION_FILE=<path>`                   | Where the revocation denylist is persisted. Defaults to `revoked-jti.json` in the signing key's directory whenever `KAIA_OAUTH_SIGNING_KEY_FILE` is set. The path must be a regular file owned by the server user and not group/world-writable; a symlink or FIFO there refuses startup.                                           |
| `KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES=<a.pem,b.pem>` | Key rotation. Retired keys are published in the JWKS and accepted for verification (never used to sign), so tokens minted before a rotation stay valid until `exp`. Each file must exist; an unreadable one refuses startup. Rotate by moving the old `KAIA_OAUTH_SIGNING_KEY_FILE` here and pointing that variable at a new path. |

No signing key is committed. Production deployments use their own authorization server and never this provider.

## Revocation and introspection

`POST /oauth/revoke` (RFC 7009) with `token=<access_or_refresh>` answers `200 {}` (also for unknown or malformed tokens), or `503` when the revocation could not be persisted (below).

- Access token: its `jti` is added to the revocation denylist until the token's `exp`.
- Refresh token: the refresh token is revoked and so is the `jti` of the access token it was issued with, until that access token's own `exp`.
- Refresh rotation (`grant_type=refresh_token`) revokes the previous access `jti` (until its `exp`), then consumes the refresh token.

Revocations and restarts:

- **In-memory signing key (default).** The denylist is in memory too. A restart generates a new key, so every token from the previous process fails signature verification (`invalid_token`), revoked or not.
- **Persisted signing key (`KAIA_OAUTH_SIGNING_KEY_FILE`).** Tokens outlive the process, so the denylist is persisted as well, to `KAIA_OAUTH_REVOCATION_FILE` (default `revoked-jti.json` next to the key). The format is `{"version":1,"entries":[{"id":"<jti>","expMs":<epoch ms>}]}`. It never contains tokens. Writes go to a temp file created exclusively (`O_EXCL`, so nothing planted at that path is followed) with mode `0600`, written in full, fsynced, renamed over the file, and then the directory is fsynced. Adding an entry that is already present (or already expired) does not rewrite the file. Entries are dropped once the token would have expired. The file is loaded before the port is bound. A missing file means an empty list (first start). An unreadable, corrupt or insecure file (not a regular file, writable by group or others, or not owned by the server's user) stops startup with an error; the server never falls back to an empty list.
- **One file, one process.** Each server keeps its own view of the denylist and rewrites the whole file, so two processes pointed at the same file would drop each other's entries. Give every instance its own file; multi-instance deployments that must share revocations need a shared store.
- If a revocation cannot be written, `POST /oauth/revoke` and a refresh rotation (`POST /oauth/token`, `grant_type=refresh_token`) answer `503 {"error":"server_error","error_description":"revocation could not be persisted"}`. The token is still rejected by this process, and the client should retry: a failed rotation does not consume the refresh token. The server log records the `jti` and the errno.
- Other unexpected failures on any OAuth endpoint answer `500 {"error":"server_error","error_description":"internal error"}`. Internal details such as file paths are logged, never returned.
- Refresh tokens are kept only in memory, so a restart invalidates every refresh token (`invalid_grant`) whatever the key setting.
- The denylist sits behind a `RevocationStore` interface (memory and file adapters today), so a shared store for multi-instance deployments can be added later.

A revoked JWT still has a valid signature until `exp`. Anything that verifies tokens offline from the JWKS cannot see revocation on its own. For that, kaia-mcp offers **RFC 7662 introspection**:

```
POST /oauth/introspect
Authorization: Basic base64(<KAIA_INTROSPECTION_CLIENT_ID>:<KAIA_INTROSPECTION_CLIENT_SECRET>)
Content-Type: application/x-www-form-urlencoded

token=<access_or_refresh_token>&token_type_hint=<access_token|refresh_token>
```

- **Client-authenticated** (`client_secret_basic`), not local-only. It is offered only when `KAIA_INTROSPECTION_CLIENT_SECRET` is set; otherwise the route returns `404` and discovery omits `introspection_endpoint`. The client id defaults to `kaia-mcp-gateway`. The secret is compared in constant time.
- Missing or wrong credentials: `401 {"error":"invalid_client",…}` with `WWW-Authenticate: Basic`.
- A valid, unexpired, unrevoked access token for this issuer and audience: `{"active":true,"token_type":"Bearer","scope","client_id","sub","aud","iss","exp","iat","nbf","jti"}`.
- A valid, unexpired, unrevoked (and not yet rotated) refresh token: `{"active":true,"token_type":"refresh_token","scope","client_id","sub","iss","exp"}`.
- `token_type_hint` is optional and only picks which kind is looked up first; the other is still searched (RFC 7662 §2.1).
- Anything else, including expired, forged, revoked, rotated, and unknown tokens: `{"active":false}`.
- A resource server that relies on introspection alone must also require `token_type` to be `Bearer`, so a refresh token is never accepted as an access credential. kaia-mcp itself never accepts a refresh token as a bearer token.

The response never echoes the token.

## Stateless HTTP (MCP 2026-07-28)

The Streamable HTTP endpoint is `POST /` and has no protocol-level sessions:

- Every POST is served by a fresh MCP server and transport. `Mcp-Session-Id` is never minted or echoed; a legacy client's header is ignored. No `initialize` is needed before `tools/list` or `tools/call`.
- `GET` and `DELETE` on the MCP endpoint answer `405` with `Allow: POST` (no standalone SSE stream, no session to delete).
- Any instance can answer any request when instances share the signing key (`KAIA_OAUTH_SIGNING_KEY_FILE`) and `KAIA_PUBLIC_URL`. A token minted on one instance verifies on another.
- Still per process today (shared stores are phase 3): the demo AS's codes, device codes and refresh tokens (see [AS state](#authorization-server-state)), and the revocation denylist (one `KAIA_OAUTH_REVOCATION_FILE` per process). Behind a load balancer, keep the OAuth flow on one instance (sticky routing) or front a real AS.
- SDK 1.32 negotiates protocol versions up to `2025-11-25`; a request with `MCP-Protocol-Version: 2026-07-28` is refused by the SDK with 400 until the phase 2 SDK v2 migration.

## Public URL and resource indicators (RFC 8707)

`KAIA_PUBLIC_URL` (an `http(s)` origin with no path, query or fragment, e.g. `https://kaia.example.com`) is the OAuth issuer, the canonical resource URI and the `resource` in protected resource metadata. Unset, it is `http://127.0.0.1:<port>` for local development. An invalid value refuses startup.

- `resource` is accepted on `/oauth/authorize`, `/oauth/device` and every `/oauth/token` grant. It must name the canonical URI (scheme and host compared case-insensitively, default port and a trailing `/` ignored). A different value, more than one value, a fragment or a non-URI is `invalid_target` (400 at the token and device endpoints; a redirect with `error=invalid_target` from `/oauth/authorize`).
- A missing `resource` means this server, because this authorization server serves exactly one resource. MCP clients must send it, but older clients and the device flow used by gateways often do not. Set `KAIA_OAUTH_REQUIRE_RESOURCE=1` to reject a missing `resource` with `invalid_target`.
- Access tokens carry `aud = <canonical URI>`. A gateway that still pins a non-URI audience can be kept working with `KAIA_OAUTH_LEGACY_AUDIENCE=<value>` (old name `KAIA_OAUTH_AUDIENCE`, now an alias with no default), which mints `aud = [<canonical URI>, <value>]`. kaia-mcp itself still requires the canonical URI; the legacy value alone is never accepted.

Protected resource metadata (RFC 9728) at `GET /.well-known/oauth-protected-resource`:

```json
{
  "resource": "<canonical URI>",
  "authorization_servers": ["<issuer>"],
  "scopes_supported": ["kaia:read", "kaia:encode", "kaia:wallet"],
  "bearer_methods_supported": ["header"],
  "resource_name": "kaia-mcp"
}
```

## Origin and CORS

Per the Streamable HTTP security rules, a request whose `Origin` header is present and not allow-listed gets `403` before authentication or any handler runs (DNS-rebinding protection). This covers the MCP endpoint and every OAuth endpoint, which also protects the consent forms from cross-site posts.

- Allowed: the server's own public origin (`KAIA_PUBLIC_URL`, or `http://127.0.0.1:<port>`) plus `KAIA_ALLOWED_ORIGINS` (comma-separated `scheme://host[:port]`; `*` is refused). Browser MCP clients (e.g. MCP Inspector on `http://localhost:6274`) must be listed.
- No `Origin` header (curl, SDK clients in Node, gateways): allowed.
- Exempt: public metadata (`/health`, `/oauth/jwks`, the three `/.well-known/…` documents and the tool-scope map) answers any origin with `Access-Control-Allow-Origin: *`.
- CORS on the MCP/OAuth surface echoes the allowed origin (never `*`) with `Vary: Origin`, allows `Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name`, exposes `WWW-Authenticate`, and no longer mentions `Mcp-Session-Id` or `DELETE`.

## Authorization-server state

Everything the demo AS remembers between requests sits behind store interfaces (`src/auth/state-store.ts`): authorization (consent) requests, authorization codes, device codes and user codes, and refresh tokens, next to the existing `RevocationStore`. Only an in-memory adapter ships now.

- Keys are sha256 digests of the secret; stored values never contain a plaintext token, code or device code (device-flow tokens are minted when the device redeems its code, not at consent).
- Every entry expires (consent requests and codes after 600 s, device codes after 600 s, refresh tokens after their TTL).
- Single-use values (codes, device codes, refresh tokens) are redeemed with an atomic `take()`, so a shared store implementation (phase 3) cannot let two instances redeem the same code.
- The interface is synchronous like the provider; a network store needs the provider's OAuth methods to become async first.

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
  &resource=<canonical URI, e.g. http://127.0.0.1:3100>
```

4. Consent page lists requested scopes. **Approve** redirects to `redirect_uri?code=...&state=...&iss=<issuer>`. **Deny** redirects with `error=access_denied` (and `iss`). Every authorization response, including error redirects, carries `iss` (RFC 9207); the metadata advertises `authorization_response_iss_parameter_supported: true`, so clients must compare it with the issuer they recorded.
5. Exchange the code (public client, no secret):

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&client_id=kaia-mcp-demo
&code=<code>
&code_verifier=<verifier>
&redirect_uri=http://127.0.0.1/callback
&resource=<canonical URI>
```

6. Call MCP with `Authorization: Bearer <access_token>` on every POST. There is no MCP session; every request is validated on its own (signature, `iss`, `aud`, expiry, revocation).

Registered demo redirect URIs: `http://127.0.0.1/callback`, `http://localhost/callback`, `http://127.0.0.1/cb`, `http://localhost/cb`.

## CLI flow (Device Authorization Grant)

1. `POST /oauth/device` with `client_id=kaia-mcp-demo`, `scope=...` and (recommended) `resource=<canonical URI>`.
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
| Access token format | RS256 JWT, `aud` = canonical resource URI (`KAIA_PUBLIC_URL`) |

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

No `initialize` or session header is needed: each POST stands alone.

Health (`GET /health`), discovery, `GET /oauth/jwks`, and `GET /.well-known/kaia-mcp/tool-scopes` are unauthenticated so operators and gateways can doctor an instance.

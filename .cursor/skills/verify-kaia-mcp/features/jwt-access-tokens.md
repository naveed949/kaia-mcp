# JWT access tokens

Access tokens from the demo IdP are RS256 JWTs that anyone can verify offline with the published JWKS. kaia-mcp accepts only tokens it signed for its own issuer and audience, rejects forged and `alg=none` tokens, expires them at `exp`, and logs one `Tool call` line, after the authorization decision, for every call that reaches it.

## Sub-features

- `jwt-shape` issues a JWT with header `alg=RS256`, `typ=at+jwt`, `kid`, and claims `iss`, `aud`, `sub`, `client_id`, `scope`, `iat`, `nbf`, `exp`, `jti`.
- `jwt-jwks` publishes the public key at the discovery `jwks_uri` (`/oauth/jwks`), and the token signature verifies against it.
- `jwt-forged` rejects a token with the real `kid` and claims signed by another key (`-32043 invalid_token`).
- `jwt-alg-none` rejects the same claims with `alg=none` (`-32043 invalid_token`).
- `jwt-expired` rejects the bearer after `exp` (`-32041 token_expired`).
- `tool-call-log` adds exactly one `msg=Tool call tool=<name> outcome=allowed` server log line for an allowed call. A denied call gets `outcome=denied errorCode=<code>` instead; see [fail-closed-auth](./fail-closed-auth.md).
- `tool-scopes-metadata` serves the enforced tool → scope map at `/.well-known/kaia-mcp/tool-scopes`.

## How to get to it (user POV)

- Get a token through the device flow (`POST /oauth/device`, approve at `/oauth/device/verify`, `POST /oauth/token`).
- `GET /.well-known/openid-configuration`, then `GET` its `jwks_uri`.
- Call MCP `POST /` with the bearer, a forged bearer, an `alg=none` bearer, and the original bearer after it expires.
- `GET /.well-known/kaia-mcp/tool-scopes`.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`, and `doctor.sh` passes (it checks `jwks_uri`, at least one RS256 JWKS key, and PRM `resource` = issuer).
- `launch.sh` set `KAIA_ACCESS_TOKEN_TTL_SECONDS` to `tokenTtlSeconds` in `instance.json` (default 20, override with `KAIA_VERIFY_TOKEN_TTL`).

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh jwt-access-tokens`. It sleeps until the token expires, so it takes about `tokenTtlSeconds` seconds.
- **Shape and JWKS.** `decoded.json` shows `header.alg="RS256"`, `header.typ="at+jwt"`, a `kid` present in `jwks.json`, `claims.iss` equal to the instance issuer, `claims.aud` equal to the instance issuer (the canonical resource URI), `claims.scope="kaia:encode"`, and `exp - iat = tokenTtlSeconds`. The drive verifies the signature with Node `crypto` and the JWKS only.
- **Allowed call and log.** `allow.json` contains `0x70a082310000000000000000000000001234567890123456789012345678901234567890`. `tool-call-log-count.json` shows `after = before + 1` for `msg=Tool call tool=encode_function_data ` and `allowedAfter = allowedBefore + 1` for `msg=Tool call tool=encode_function_data outcome=allowed `.
- **Forged and alg=none.** `forged.headers` and `alg-none.headers` are `HTTP/1.1 401`. Their bodies have `error.code=-32043` and `data.error="invalid_token"`.
- **Expired.** `expired.headers` is `HTTP/1.1 401`. The body is `{"jsonrpc":"2.0","error":{"code":-32041,"message":"token_expired: access token has expired","data":{"error":"token_expired"}},"id":null}`.
- **Tool scopes.** `tool-scopes.json` has 26 tools, with `encode_function_data` → `kaia:encode`, `generate_wallet` → `kaia:wallet`, and `get_block_number` → `kaia:read`.
- **Proof.** All of the files above are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/jwt-access-tokens/`.

## Gotchas

- Each launch (and each `restart.sh memory`) generates a new signing key, so tokens and `kid`s do not survive it. A token from an earlier run is `invalid_token`, not `token_expired`.
- The expiry wait is real time. With the default 900s TTL (no `launch.sh`) this recipe would sleep for 15 minutes; always launch through the helper.
- `alg=none` must be rejected with the same `invalid_token` as a bad signature. A different code there is a product bug.
- The `Tool call` line is logged after the scope check and carries `outcome=allowed` or `outcome=denied`. Every outcome shares the `msg=Tool call tool=<name> ` prefix, so counting that prefix proves whether a call reached kaia-mcp at all. Count `outcome=allowed` to prove kaia-mcp allowed it.

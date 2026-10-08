# Token introspection

A gateway in front of kaia-mcp asks the issuer whether an access or refresh token is still active (RFC 7662). Only an authenticated gateway client may ask. Revoked tokens and access tokens retired by refresh rotation report inactive, and kaia-mcp itself rejects them.

## Sub-features

- `introspect-auth` rejects introspection with no credentials or a wrong secret (`401 invalid_client`, `WWW-Authenticate: Basic`).
- `introspect-active` returns `active=true` with `scope`, `aud`, `jti`, and the other claims for a live token, without echoing the token.
- `introspect-revoked` returns `{"active":false}` after `POST /oauth/revoke`, and the same bearer gets `-32043 invalid_token` from MCP.
- `introspect-rotation` returns inactive for the old access token after a `refresh_token` grant, and active for the new one.
- `introspect-refresh` returns `active=true`, `token_type="refresh_token"`, `scope`, `client_id`, `sub`, `iss`, and `exp` for a live refresh token, with or without `token_type_hint=refresh_token`. It returns exactly `{"active":false}` once that refresh token is rotated or revoked.

## How to get to it (user POV)

- `POST /oauth/introspect` with `token=<access_or_refresh_token>` (optionally `token_type_hint=refresh_token`) and HTTP Basic `kaia-mcp-gateway:<secret>`. The secret is the per-run value `launch.sh` wrote to `introspectionSecretFile`.
- `POST /oauth/revoke` with `token=<access_token>`.
- `POST /oauth/token` with `grant_type=refresh_token`.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`, and `doctor.sh` passes (it requires `introspection_endpoint` in discovery).
- `instance.json` has `introspectionSecretFile`, and that file exists in the run's evidence directory.

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh token-introspection`.
- **Client auth.** `anon.headers` and `wrong-secret.headers` are `HTTP/1.1 401`, and their bodies have `"error":"invalid_client"`. `anon.headers` carries `WWW-Authenticate: Basic`.
- **Active.** `active.json` has `"active":true`, `"scope":"kaia:read"`, `"aud":"<instance issuer>"`, and a `jti` equal to the token's `jti`. It does not contain the token.
- **Revoke.** `revoked.json` is exactly `{"active":false}`. `revoked-mcp.json` has `error.code=-32043`.
- **Rotation.** `rotated-old.json` has `"active":false` and `rotated-new.json` has `"active":true`.
- **Refresh tokens.** `refresh-active.json` (sent with `token_type_hint=refresh_token`) and `refresh-active-nohint.json` (no hint) have `"active":true`, `"token_type":"refresh_token"`, `"scope":"kaia:read"`, `"client_id":"kaia-mcp-demo"`, `"sub":"demo-user"`, the instance `iss`, and a numeric `exp`. Neither echoes the token. `refresh-old.json` (the refresh token retired by rotation) and `refresh-revoked.json` (after `POST /oauth/revoke`) are exactly `{"active":false}`.
- **Proof.** All of the files above are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/token-introspection/`.

## Gotchas

- Introspection is offered only when `KAIA_INTROSPECTION_CLIENT_SECRET` is set. Without it, `/oauth/introspect` is `404` and discovery has no `introspection_endpoint`. `launch.sh` always sets a per-run secret.
- A revoked JWT still verifies offline against the JWKS until `exp`. Only kaia-mcp and introspection know about revocation.
- A refresh-token answer has `token_type: "refresh_token"`. An access-token answer has `token_type: "Bearer"`. A gateway that relies on introspection alone must require `Bearer`.
- Refresh tokens are held in memory only, so a restart makes every refresh token inactive. See [revocation-restart](./revocation-restart.md).

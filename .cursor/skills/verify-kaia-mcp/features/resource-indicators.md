# Resource indicators

kaia-mcp is both the demo authorization server and the protected resource, and both are named by one canonical URI: `KAIA_PUBLIC_URL`, or `http://127.0.0.1:<port>` by default. Clients may send the RFC 8707 `resource` parameter on authorize, device and token requests; it must name that URI, and every access token's `aud` (and `iss`) is that URI. Authorization responses carry RFC 9207 `iss`, and the protected resource metadata names the same URI as `resource`.

## Sub-features

- `metadata-iss` advertises `authorization_response_iss_parameter_supported: true` in `/.well-known/oauth-authorization-server`.
- `prm-resource` serves `/.well-known/oauth-protected-resource` with `resource` and `authorization_servers` equal to the issuer, and no `token_audience`.
- `resource-accepted` accepts `resource=<issuer>/` (trailing slash normalized) at authorize and at the token endpoint; the token has `aud = iss = <issuer>` and can call `encode_function_data`.
- `resource-mismatch-token` answers a foreign `resource` at the token endpoint with `400 {"error":"invalid_target",…}` without burning the code; the same code then redeems with the right `resource`.
- `resource-mismatch-authorize` redirects a foreign `resource` at `/oauth/authorize` to `redirect_uri?error=invalid_target&…&iss=<issuer>` without showing consent.
- `resource-mismatch-device` answers a foreign `resource` at `/oauth/device` with `400 invalid_target`.
- `resource-missing-default` treats a request with no `resource` as naming this server (`aud = <issuer>`). `KAIA_OAUTH_REQUIRE_RESOURCE=1` turns that into `invalid_target` (covered by the unit suite, not driven).
- `iss-on-responses` adds `iss=<issuer>` to the approve redirect and to the deny (`access_denied`) redirect.

## How to get to it (user POV)

- `GET /.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.
- Browser PKCE flow with `&resource=<issuer>/`, consent approve, then `POST /oauth/token` once with `resource=https://other.example` and once with `resource=<issuer>`.
- `GET /oauth/authorize` with `resource=https://other.example`; a fresh consent with `decision=deny`.
- `POST /oauth/device` with `resource=https://other.example`; a device flow with no `resource`.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`, and `doctor.sh` passes.
- `KAIA_PUBLIC_URL` and `KAIA_OAUTH_REQUIRE_RESOURCE` are empty (launch pins them), so the canonical URI is the instance URL.

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh resource-indicators`.
- **Metadata.** `as-metadata.json` has `"authorization_response_iss_parameter_supported":true`. `prm.json` has `resource` and `authorization_servers[0]` equal to the issuer.
- **Approve.** The `Location` in `consent.headers` has `code`, `state=ri1` and `iss=<issuer>`.
- **Token.** `token-wrong-resource.headers` is `HTTP/1.1 400` and `token-wrong-resource.json` has `"error":"invalid_target"`. `token.json` then has an `access_token` whose `aud` and `iss` are the issuer, and `allow.json` contains the balanceOf calldata.
- **Authorize mismatch.** The `Location` in `authorize-wrong-resource.headers` has `error=invalid_target`, `iss=<issuer>` and no `code`; `authorize-wrong-resource.body` is not a consent page.
- **Deny.** The `Location` in `deny.headers` has `error=access_denied` and `iss=<issuer>`.
- **Device.** `device-wrong-resource.headers` is `HTTP/1.1 400` with `"error":"invalid_target"`. `default-resource.claims.json` has `aud` equal to the issuer.
- **Proof.** All of the files above are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/resource-indicators/`.

## Gotchas

- `resource` comparison ignores the scheme/host case, the default port and a trailing `/` on an empty path, but not a different port or path. `http://127.0.0.1:<other-port>` is a foreign resource.
- Sending `resource` twice is `invalid_target` (this server serves one resource).
- Rejecting a token whose `aud` is not the canonical URI needs a signing key, so it is driven in [stateless-multi-instance](./stateless-multi-instance.md).

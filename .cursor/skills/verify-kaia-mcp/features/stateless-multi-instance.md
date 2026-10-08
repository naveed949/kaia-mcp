# Stateless multi-instance

Because the HTTP transport keeps no sessions, any kaia-mcp process that shares the signing key and `KAIA_PUBLIC_URL` can answer any request: a token minted by one instance works on another, with no `initialize` and no session header. Key rotation keeps old tokens valid when the retired key is listed in `KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES`. Every instance requires its own canonical URI in `aud`, so a validly signed token for another audience is refused. The demo authorization server's codes and refresh tokens, and the revocation denylist, are still per process.

## Sub-features

- `shared-key-cross-instance` lets a device-flow token minted on instance A (`iss = aud = KAIA_PUBLIC_URL`) call `encode_function_data` and `tools/list` on instance B without `initialize`, and no response carries `Mcp-Session-Id`.
- `key-rotation-previous` makes instance C (new signing key, previous = the shared key) publish both keys in its JWKS, current first, and accept A's token. B does not accept a token signed by C's new key.
- `public-url-isolation` makes instance D (same key, another `KAIA_PUBLIC_URL`) refuse A's token with `401 invalid_token`.
- `audience-rejection` refuses tokens signed with the real key and the right `iss` whose `aud` is `"kaia-mcp"` (legacy only), `"https://other.example"`, or the public URL with another port, each with `401`, `-32043` and an `error="invalid_token"` challenge. An `aud` array that also contains the canonical URI is accepted (control).
- `per-process-state` (documented limitation) answers `invalid_grant` on B for a refresh token issued by A, and a token revoked on A still works on B because each process has its own denylist.

## How to get to it (user POV)

- Start A and B with `KAIA_PUBLIC_URL=http://kaia-lb.test`, the same `KAIA_OAUTH_SIGNING_KEY_FILE`, and their own `KAIA_OAUTH_REVOCATION_FILE`; C with the same public URL, a new key file and `KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES=<shared key>`; D with the shared key and `KAIA_PUBLIC_URL=http://kaia-other.test`.
- Device flow on A; MCP `POST /` with that bearer on B, C and D.
- Device flow on C; MCP on B.
- Sign tokens with the shared key and altered `aud`; MCP on B.
- `POST /oauth/token` (refresh) on B with A's refresh token; `POST /oauth/revoke` on A, then MCP on A and B.

## Driving it with verify-kaia

Preconditions:

- `launch.sh` has run (the drive needs `server.env` and the built `dist/`). The launched instance is not used or changed.
- The drive starts its own four processes on free ports, logs them into this run's `server.log`, and stops them at the end. Their pids are recorded in `extra-pids` so `cleanup.sh` stops them if the drive dies.

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh stateless-multi-instance`.
- **Shared key.** `jwks-a.json` and `jwks-b.json` publish the same single `kid`. `health-b.json` has `issuer` `http://kaia-lb.test`. `on-a.token.json` holds a token whose `iss` and `aud` are `http://kaia-lb.test`.
- **Cross-instance.** `b-encode.headers` is `HTTP/1.1 200` and `b-encode.json` contains `0x70a082310000000000000000000000001234567890123456789012345678901234567890`; `b-list.json` lists `encode_function_data`. No `*.headers` file has `mcp-session-id`.
- **Rotation.** `jwks-c.json` has two keys: a new `kid`, then A's `kid`. `c-encode.json` contains the calldata. `tool-call-log-count.json` shows `allowedAfter = allowedBefore + 2`. `b-token-from-c.headers` is `HTTP/1.1 401`.
- **Isolation and audience.** `d-encode.headers`, `aud-legacy-only.headers`, `aud-other-uri.headers` and `aud-other-port.headers` are `HTTP/1.1 401` with `error="invalid_token"` and body `-32043`. `aud-array-with-canonical.headers` is `HTTP/1.1 200`.
- **Per-process state.** `b-refresh-from-a.json` has `"error":"invalid_grant"`. `a-after-revoke.json` has `-32043`. `per-process-observation.json` records `revokedOnA_statusOnB: 200`.
- **Proof.** All of the files above are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/stateless-multi-instance/`.

## Gotchas

- `http://kaia-lb.test` does not resolve; it is only the issuer/audience string. The drive talks to each process on `127.0.0.1:<port>` and sends no `Origin`.
- Each process needs its own revocation file. Two processes writing one denylist file is unsupported.
- `per-process-state` asserts today's documented behavior. When shared stores land, that check fails on purpose; update this file and the drive together.
- The aud-rejection tokens are signed by the drive with the run's own key file. They are proofs of rejection, not a substitute for the device-flow token used for every allowed call.

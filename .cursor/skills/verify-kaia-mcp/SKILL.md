---
name: verify-kaia-mcp
description: Verify the kaia-mcp HTTP MCP connector (stateless MCP 2026-07-28 transport, Origin validation, OAuth PKCE, RFC 8707 resource/audience, RFC 9728 Bearer challenges incl. 403 insufficient_scope, RFC 9207 iss, scoped tools, fail-closed auth, gated generate_wallet, JWT access tokens + JWKS rotation, RFC 7662 introspection, revocation that survives restart, multi-instance with a shared key) by launching isolated local instances and driving them with curl. Use when proving partner auth, scope gates, token verification/revocation, stateless deployment, or private-key withholding.
---

# Verify kaia-mcp

Primary surface: stateless Streamable HTTP MCP (`POST /` only, no sessions) plus the in-process demo OAuth/OIDC endpoints. Stdio exists for local desktop but is not the partner path and is not driven here.

Repo-documented start: `npm run build` then `node dist/bin/kaia-mcp.js --transport http --port <PORT>` (same as `npm start` with `--transport http`). Partner default is `KAIA_AUTH_MODE=required`. Health is `GET /health`. Ready means that URL returns JSON `status=ok`.

Two instances may run side by side if each uses its own port and `RUN_ID`. Never attach to a server you did not launch.

## Launch

From the repo root, with a unique run id:

```bash
export KAIA_VERIFY_RUN_ID="manual-$(date +%Y%m%dT%H%M%S)-$$"
.cursor/skills/verify-kaia-mcp/helpers/launch.sh
```

`launch.sh` rebuilds `dist/` (`npm run build`, log in the instance dir) on every launch so a stale build is never verified, binds an ephemeral port on this host, starts `node dist/bin/kaia-mcp.js --transport http --port <PORT>` with `KAIA_AUTH_MODE=required`, `KAIA_ALLOW_UNSAFE_WALLET` unset, `LOG_LEVEL=debug` (so the leak check covers the noisiest log path), `KAIA_ACCESS_TOKEN_TTL_SECONDS=${KAIA_VERIFY_TOKEN_TTL:-20}` (so expiry is drivable), an in-memory signing key (`KAIA_VERIFY_KEY_MODE=file` persists the key and revocation denylist under the instance dir instead), a random per-run `KAIA_INTROSPECTION_CLIENT_SECRET` (written to `evidence/<run-id>/introspection.secret.json`, mode 0600), and `KAIA_PUBLIC_URL`, `KAIA_ALLOWED_ORIGINS`, `KAIA_OAUTH_LEGACY_AUDIENCE`/`KAIA_OAUTH_AUDIENCE`, `KAIA_OAUTH_REQUIRE_RESOURCE` and `KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES` pinned empty (so a shell export cannot change the issuer or audience: issuer = canonical resource URI = token `aud` = `http://127.0.0.1:<PORT>`), and waits until `GET /health` succeeds.

Ready signal: stdout contains `ready: GET http://127.0.0.1:<PORT>/health returned status ok`. Instance metadata is `/tmp/kaia-mcp-verify-$KAIA_VERIFY_RUN_ID/instance.json` (`pid`, `port`, `issuer`, `logFile`, `tokenTtlSeconds`, `introspectionSecretFile`, `launchKeyMode`, `keyMode`). The server env is in `server.env` (mode 0600) next to it.

`helpers/restart.sh [memory|file]` stops the recorded pid and starts kaia-mcp again on the same port (so the issuer does not change), optionally switching the key mode. It updates `pid`/`keyMode` in `instance.json` and appends to the same `server.log`. Always re-read `instance.json` after a restart.

Teardown is `helpers/cleanup.sh` (see Cleanup). It kills that recorded pid only.

## Doctor

Run before the first drive, after any failed drive, and on a fresh session:

```bash
.cursor/skills/verify-kaia-mcp/helpers/doctor.sh
```

Doctor is read-only. It requires: the recorded pid still running, `GET /health` succeeding, `server=kaia-mcp`, `authMode=required`, `unsafeWallet=false`, `issuer` matching the instance file, discovery advertising `jwks_uri`, `introspection_endpoint` and `authorization_response_iss_parameter_supported: true`, protected resource metadata with `resource` and `authorization_servers` equal to the issuer, and `GET /oauth/jwks` holding RS256 public keys with a `kid` and no `d` (one key at launch; a rotated instance also lists its previous keys after the current one). Do not drive if doctor exits non-zero; cleanup and relaunch instead.

## Drive

Harness is curl against the instance URL in `instance.json` (`http://127.0.0.1:<port>`). OAuth is the real consent + token endpoints, not a test-only stub.

```bash
.cursor/skills/verify-kaia-mcp/helpers/drive.sh oauth-pkce-scoped-tools
.cursor/skills/verify-kaia-mcp/helpers/drive.sh fail-closed-auth
.cursor/skills/verify-kaia-mcp/helpers/drive.sh generate-wallet-gated
.cursor/skills/verify-kaia-mcp/helpers/drive.sh device-flow
.cursor/skills/verify-kaia-mcp/helpers/drive.sh jwt-access-tokens     # waits ~tokenTtlSeconds for expiry
.cursor/skills/verify-kaia-mcp/helpers/drive.sh token-introspection
.cursor/skills/verify-kaia-mcp/helpers/drive.sh revocation-restart    # restarts the instance 4x, restores the launch key mode
.cursor/skills/verify-kaia-mcp/helpers/drive.sh stateless-transport   # 405 on GET/DELETE, no session, Origin 403, CORS
.cursor/skills/verify-kaia-mcp/helpers/drive.sh bearer-challenges     # 401 challenges, 403 insufficient_scope
.cursor/skills/verify-kaia-mcp/helpers/drive.sh resource-indicators   # RFC 8707 resource/aud, RFC 9207 iss, PRM
.cursor/skills/verify-kaia-mcp/helpers/drive.sh stateless-multi-instance  # starts extra processes; shared key, rotation, aud rejection, legacy aud, allowed origins, one denylist per process, revocations survive restart
```

Stable handles: paths `/health`, `/.well-known/openid-configuration`, `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/device`, `/oauth/device/verify`, `/oauth/revoke`, `/oauth/jwks`, `/oauth/introspect`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/kaia-mcp/tool-scopes`, and MCP `POST /` with JSON-RPC methods `initialize`, `tools/list`, `tools/call`. OAuth parameter `resource` (the issuer URL). Demo client id `kaia-mcp-demo`. Redirect `http://127.0.0.1/callback`. Scopes `kaia:read`, `kaia:encode`, `kaia:wallet`.

Every MCP request is one stateless POST (MCP 2026-07-28): `tools/list` or `tools/call` with `Authorization`, no `initialize` first and no `Mcp-Session-Id`. `drive.sh` does this in `mcp_call`, which fails the drive if any response carries `Mcp-Session-Id`. A `Server not initialized` error or a session header means a pre-stateless build is running. curl sends no `Origin` (allowed); only `stateless-transport` sends one.

`stateless-multi-instance` starts its own extra kaia-mcp processes (`start_extra_kaia` in `common.sh`) from this run's `server.env` with overrides, on free ports, logging into the same `server.log`. Their pids go to `/tmp/kaia-mcp-verify-<run-id>/extra-pids`; the drive stops them and `cleanup.sh` stops any left over.

Read the matching file under `features/` and follow every entry point it lists. Capture both the request outcome (status/body) and a second observation (tools/list, a second call, or revoke-then-retry).

## Evidence

Named location: `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/`. Each feature writes a subdirectory (`oauth-pkce-scoped-tools/`, `fail-closed-auth/`, `generate-wallet-gated/`, `device-flow/`, `jwt-access-tokens/`, `token-introspection/`, `revocation-restart/`, `stateless-transport/`, `bearer-challenges/`, `resource-indicators/`, `stateless-multi-instance/`).

Proof standards:

- Drive the HTTP user path (authorize HTML, consent POST, token POST, MCP POST). Do not call `issueAccessToken` from tests as a substitute for a mapped feature.
- Capture the action (headers + body files) and the resulting state (encoded calldata, JSON-RPC error, tools/list).
- `generate_wallet` proof is the absence of `Private key (hex): 0x` plus `tool_disabled`.
- Side effects: revoke proof is a follow-up MCP call that returns `invalid_token`. Restart proof is the same bearer after `restart.sh` on the same port, with the `kid` compared before and after. Denied `encode_function_data` must not contain the expected calldata.
- The demo IdP is the production boundary for identity in this repo; do not talk to an external IdP.
- No plaintext secrets in logs: `cleanup.sh` copies the server log to `evidence/<run-id>/server.log`; then `helpers/token-leak-check.sh` must exit 0 (it scans that log for every token, code, device code, PKCE verifier, and introspection secret captured in the run, and fails on any compact JWT at all).
- A forged or expired token proof is the JSON-RPC error body plus HTTP 401, never only a non-200 status. Insufficient scope is HTTP 403 plus the `WWW-Authenticate` `insufficient_scope` challenge plus the JSON-RPC `-32042` body.
- Audience proof uses tokens with a valid signature (signed with the run's own key file in `stateless-multi-instance`), so the rejection can only come from the `aud` check.
- After cleanup, confirm the evidence directory still exists at the path printed by launch/drive.

Do not write access tokens into files named `*.log` at the repo root. Token JSON under the evidence directory is a verification artifact for that run; it is gitignored with the rest of `evidence/`.

## Cleanup

```bash
.cursor/skills/verify-kaia-mcp/helpers/cleanup.sh
```

Stops the pid currently recorded in `instance.json` (SIGTERM, then SIGKILL if needed), including one changed by `restart.sh`, and any pid listed in `extra-pids`. Copies `server.log` into the evidence dir, then removes `/tmp/kaia-mcp-verify-<run-id>/` only. Also cleans up after a failed launch (no `instance.json`). Does not delete `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/`. Does not `pkill`/`killall` by name.

Then run the leak check against the retained log:

```bash
.cursor/skills/verify-kaia-mcp/helpers/token-leak-check.sh
```

## Helpers

All helpers are executable. Invoke from the repo root. They honor `KAIA_VERIFY_RUN_ID` or the last id in `/tmp/kaia-mcp-verify-current`.

| Script                     | Invocation                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| Launch                     | `.cursor/skills/verify-kaia-mcp/helpers/launch.sh`                 |
| Doctor                     | `.cursor/skills/verify-kaia-mcp/helpers/doctor.sh`                 |
| Restart (same port)        | `.cursor/skills/verify-kaia-mcp/helpers/restart.sh [memory\|file]` |
| Drive                      | `.cursor/skills/verify-kaia-mcp/helpers/drive.sh <feature-id>`     |
| Cleanup                    | `.cursor/skills/verify-kaia-mcp/helpers/cleanup.sh`                |
| Leak check (after cleanup) | `.cursor/skills/verify-kaia-mcp/helpers/token-leak-check.sh`       |

`helpers/common.sh` is sourced by the others; do not run it directly.

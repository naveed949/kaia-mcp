---
name: verify-kaia-mcp
description: Verify the kaia-mcp HTTP MCP connector (OAuth PKCE, scoped tools, fail-closed auth, gated generate_wallet) by launching an isolated local instance and driving it with curl. Use when proving partner auth, scope gates, or private-key withholding.
---

# Verify kaia-mcp

Primary surface: Streamable HTTP MCP plus the in-process demo OAuth/OIDC endpoints. Stdio exists for local desktop but is not the partner path and is not driven here.

Repo-documented start: `npm run build` then `node dist/bin/kaia-mcp.js --transport http --port <PORT>` (same as `npm start` with `--transport http`). Partner default is `KAIA_AUTH_MODE=required`. Health is `GET /health`. Ready means that URL returns JSON `status=ok`.

Two instances may run side by side if each uses its own port and `RUN_ID`. Never attach to a server you did not launch.

## Launch

From the repo root, with a unique run id:

```bash
export KAIA_VERIFY_RUN_ID="manual-$(date +%Y%m%dT%H%M%S)-$$"
.cursor/skills/verify-kaia-mcp/helpers/launch.sh
```

`launch.sh` rebuilds `dist/` (`npm run build`, log in the instance dir) on every launch so a stale build is never verified, binds an ephemeral port on this host, starts `node dist/bin/kaia-mcp.js --transport http --port <PORT>` with `KAIA_AUTH_MODE=required`, `KAIA_ALLOW_UNSAFE_WALLET` unset, and `LOG_LEVEL=debug` (so the leak check covers the noisiest log path), and waits until `GET /health` succeeds.

Ready signal: stdout contains `ready: GET http://127.0.0.1:<PORT>/health returned status ok`. Instance metadata is `/tmp/kaia-mcp-verify-$KAIA_VERIFY_RUN_ID/instance.json` (`pid`, `port`, `issuer`).

Teardown is `helpers/cleanup.sh` (see Cleanup). It kills that recorded pid only.

## Doctor

Run before the first drive, after any failed drive, and on a fresh session:

```bash
.cursor/skills/verify-kaia-mcp/helpers/doctor.sh
```

Doctor is read-only. It requires: the recorded pid still running, `GET /health` succeeding, `server=kaia-mcp`, `authMode=required`, `unsafeWallet=false`, and `issuer` matching the instance file. Do not drive if doctor exits non-zero; cleanup and relaunch instead.

## Drive

Harness is curl against the instance URL in `instance.json` (`http://127.0.0.1:<port>`). OAuth is the real consent + token endpoints, not a test-only stub.

```bash
.cursor/skills/verify-kaia-mcp/helpers/drive.sh oauth-pkce-scoped-tools
.cursor/skills/verify-kaia-mcp/helpers/drive.sh fail-closed-auth
.cursor/skills/verify-kaia-mcp/helpers/drive.sh generate-wallet-gated
.cursor/skills/verify-kaia-mcp/helpers/drive.sh device-flow
```

Stable handles: paths `/health`, `/.well-known/openid-configuration`, `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/device`, `/oauth/device/verify`, `/oauth/revoke`, and MCP `POST /` with JSON-RPC methods `initialize`, `tools/list`, `tools/call`. Demo client id `kaia-mcp-demo`. Redirect `http://127.0.0.1/callback`. Scopes `kaia:read`, `kaia:encode`, `kaia:wallet`.

Every MCP request after auth is a real client session: `initialize` with the bearer, read the `Mcp-Session-Id` response header, send `notifications/initialized`, then `tools/list` or `tools/call` with both `Authorization` and `Mcp-Session-Id`. A `tools/call` without `initialize` returns `-32000 Bad Request: Server not initialized`, which is a harness mistake, not an auth result. `drive.sh` does this in `mcp_call`.

Read the matching file under `features/` and follow every entry point it lists. Capture both the request outcome (status/body) and a second observation (tools/list, a second call, or revoke-then-retry).

## Evidence

Named location: `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/`. Each feature writes a subdirectory (`oauth-pkce-scoped-tools/`, `fail-closed-auth/`, `generate-wallet-gated/`, `device-flow/`).

Proof standards:

- Drive the HTTP user path (authorize HTML, consent POST, token POST, MCP POST). Do not call `issueAccessToken` from tests as a substitute for a mapped feature.
- Capture the action (headers + body files) and the resulting state (encoded calldata, JSON-RPC error, tools/list).
- `generate_wallet` proof is the absence of `Private key (hex): 0x` plus `tool_disabled`.
- Side effects: revoke proof is a follow-up MCP call that returns `invalid_token`. Denied `encode_function_data` must not contain the expected calldata.
- The demo IdP is the production boundary for identity in this repo; do not talk to an external IdP.
- No plaintext secrets in logs: `cleanup.sh` copies the server log to `evidence/<run-id>/server.log`; then `helpers/token-leak-check.sh` must exit 0 (it scans that log for every token, code, device code, and PKCE verifier captured in the run).
- After cleanup, confirm the evidence directory still exists at the path printed by launch/drive.

Do not write access tokens into files named `*.log` at the repo root. Token JSON under the evidence directory is a verification artifact for that run; it is gitignored with the rest of `evidence/`.

## Cleanup

```bash
.cursor/skills/verify-kaia-mcp/helpers/cleanup.sh
```

Stops the pid from `instance.json` (SIGTERM, then SIGKILL if needed). Copies `server.log` into the evidence dir, then removes `/tmp/kaia-mcp-verify-<run-id>/` only. Also cleans up after a failed launch (no `instance.json`). Does not delete `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/`. Does not `pkill`/`killall` by name.

Then run the leak check against the retained log:

```bash
.cursor/skills/verify-kaia-mcp/helpers/token-leak-check.sh
```

## Helpers

All helpers are executable. Invoke from the repo root. They honor `KAIA_VERIFY_RUN_ID` or the last id in `/tmp/kaia-mcp-verify-current`.

| Script | Invocation |
|---|---|
| Launch | `.cursor/skills/verify-kaia-mcp/helpers/launch.sh` |
| Doctor | `.cursor/skills/verify-kaia-mcp/helpers/doctor.sh` |
| Drive | `.cursor/skills/verify-kaia-mcp/helpers/drive.sh <feature-id>` |
| Cleanup | `.cursor/skills/verify-kaia-mcp/helpers/cleanup.sh` |
| Leak check (after cleanup) | `.cursor/skills/verify-kaia-mcp/helpers/token-leak-check.sh` |

`helpers/common.sh` is sourced by the others; do not run it directly.

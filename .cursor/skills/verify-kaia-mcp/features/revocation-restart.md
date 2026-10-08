# Revocation across restart

A token revoked at kaia-mcp stays rejected after the server restarts. With a persisted signing key (`KAIA_OAUTH_SIGNING_KEY_FILE`), the revocation denylist is persisted next to the key, so revoked tokens stay `invalid_token` while unrevoked ones keep working. A corrupt, insecure, symlinked or FIFO denylist stops startup instead of starting with an empty list. With the default in-memory key, a restart mints a new key, so every earlier token is `invalid_token`.

## Sub-features

- `restart-file-revoked` keeps a revoked access token at `-32043 invalid_token` (MCP) and `{"active":false}` (introspection) after a restart with the same key.
- `restart-file-refresh-revoked` keeps the access token linked to a revoked refresh token at `-32043` after restart.
- `restart-file-kept` lets an unrevoked token from before the restart call `encode_function_data`, and introspection reports it active. This shows the key really persisted.
- `restart-refresh-gone` answers `invalid_grant` to any refresh token from before the restart, because refresh tokens are held only in memory.
- `restart-denylist-file` stores `{"version":1,"entries":[{"id":"<jti>","expMs":…}]}` with mode `600`. It lists only the revoked jtis and never contains a token.
- `restart-corrupt-refuses` makes the server exit non-zero, without listening, when the denylist file is corrupt. The log says `revocation store … is corrupt`.
- `restart-insecure-refuses` does the same when the denylist is writable by group or others (mode `666`). The log says `revocation store … is insecure: writable by group or others`.
- `restart-symlink-fifo-refuses` refuses startup, without hanging, when the denylist path is a symlink (`refusing to follow a symlink`) or a FIFO (`not a regular file`).
- `rotate-persist-failure` answers a refresh rotation with `503 {"error":"server_error","error_description":"revocation could not be persisted"}` (no file path) when the denylist directory is not writable. The old access token is denied in-process, the refresh token is not consumed, and the same refresh token rotates (`200`) once the directory is writable again.
- `restart-memory-invalidates` changes the `kid` on an in-memory-key restart, and every earlier token, revoked or not, gets `-32043`.

## How to get to it (user POV)

- Get tokens through the device flow, then `POST /oauth/revoke` with an access token and with a refresh token.
- Restart the server on the same port (`helpers/restart.sh file` keeps the key; `helpers/restart.sh memory` uses a fresh in-memory key).
- Call MCP `POST /` with the same bearers, `POST /oauth/introspect`, and `POST /oauth/token` with `grant_type=refresh_token`.
- Make the state directory read-only (`chmod 500`), POST `/oauth/token` with `grant_type=refresh_token`, restore it (`chmod 700`), and POST the same refresh token again.
- Start a server whose `revoked-jti.json` next to the key is corrupt, one whose `revoked-jti.json` is mode `666`, one where it is a symlink, and one where it is a FIFO.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`, and `doctor.sh` passes.
- Any launch key mode works. The drive switches modes through `restart.sh` and restores `launchKeyMode` at the end, so later drives see the baseline.

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh revocation-restart`. It restarts the instance four times, which takes a few seconds.
- **Revoke.** `revoke-status.json` is `{"access":200,"refresh":200}`. `revoked-before.json` has `error.code=-32043`.
- **Denylist on disk.** `denylist.json` has `version=1` and entries for the revoked token's `jti` and the refresh-linked access `jti`. It has no entry for the kept token and no `eyJ…` JWT or refresh token. `denylist.mode.txt` is `600`.
- **File-mode restart.** `jwks-a.json` and `jwks-b.json` have the same `kid`. `kept-after.json` contains `0x70a082310000000000000000000000001234567890123456789012345678901234567890`. `revoked-after.headers` and `refreshed-access-after.headers` are `HTTP/1.1 401`, with body `error.code=-32043` and message `invalid_token: access token is invalid or revoked`. `revoked-after-introspect.json` is exactly `{"active":false}`, and `kept-after-introspect.json` has `"active":true`. `refresh-after.json` has `"error":"invalid_grant"`.
- **Rotation with an unwritable store.** `rotate-phase.json` is `{"skipped":false}` (it is `{"skipped":true}` only when the drive runs as root, which ignores directory permissions). `rotate-broken.headers` is `HTTP/1.1 503` and `rotate-broken.json` is exactly `{"error":"server_error","error_description":"revocation could not be persisted"}` with no `/`. `rotate-old-access-denied.json` has `error.code=-32043`. `rotate-retry.headers` is `HTTP/1.1 200` and `rotate-retry.json` has an `access_token`.
- **Corrupt denylist.** `corrupt-start.json` is `{"exit":1,"listening":false}`, and `corrupt-start.log` contains `revocation store … is corrupt`.
- **Insecure denylist.** `insecure-start.json` is `{"exit":1,"listening":false}`, and `insecure-start.log` contains `revocation store … is insecure: writable by group or others`.
- **Symlink and FIFO denylist.** `symlink-start.json` and `fifo-start.json` are `{"exit":1,"listening":false}` (exit `124` would mean startup hung on the FIFO). `symlink-start.log` contains `refusing to follow a symlink`; `fifo-start.log` contains `not a regular file`.
- **Memory-mode restart.** `jwks-c.json` has a different `kid` from `jwks-b.json`. `kept-after-memory.headers` and `revoked-after-memory.headers` are `HTTP/1.1 401` with `error.code=-32043`.
- **Proof.** All of the files above, plus `restart-*.txt` and `doctor-*.txt`, are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/revocation-restart/`.

## Gotchas

- The issuer contains the port. Restarting on a different port makes every old token `invalid_token` because `iss` no longer matches, which would hide a denylist bug. `restart.sh` always reuses the recorded port.
- `restart.sh` changes the recorded `pid` in `instance.json`. Use `instance.json` after a restart; never reuse a pid you saved before it.
- The state for file mode (`signing-key.pem`, `revoked-jti.json`) lives under `/tmp/kaia-mcp-verify-<run-id>/state/`, and `cleanup.sh` removes it. `denylist.json` in the evidence directory is the retained copy.
- One denylist file belongs to one server process. The corrupt, insecure, symlink and FIFO phases use their own directories (`corrupt/`, `insecure/`, `symlink/`, `fifo/`) for that reason; never point a second server at `state/revoked-jti.json`.
- Every token in this recipe must be used within `tokenTtlSeconds` of minting. If a restart stalls past that, `kept-after` fails with `token_expired`. That is a harness timing problem, not a revocation bug.

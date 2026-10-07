# Device flow

A CLI agent starts the device authorization grant, the user approves the user code in a browser, and the agent polls the token endpoint then calls an allowed MCP tool.

## Sub-features

- `device-start` returns `user_code` and `device_code`.
- `device-consent` approves the user code.
- `device-token` exchanges the device code for a bearer token.
- `device-allow` calls `encode_function_data` with the granted `kaia:encode` scope.

## How to get to it (user POV)

- POST `/oauth/device` with `client_id=kaia-mcp-demo` and `scope=kaia:encode`.
- Open `GET /oauth/device/verify?user_code=<code>` and choose `Approve`.
- POST `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- Call MCP `tools/call` `encode_function_data` with the bearer token.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`.
- `doctor.sh` reports `authMode=required`.

- **Start device.** Run `.cursor/skills/verify-kaia-mcp/helpers/drive.sh device-flow` (or POST `/oauth/device`). Body includes `user_code`, `device_code`, and `verification_uri`.
- **Approve user code.** GET `/oauth/device/verify?user_code=<user_code>` then POST the same path with `decision=approve`. HTML contains `Device authorized`.
- **Exchange.** POST `/oauth/token` with the device code. Body includes `"token_type":"Bearer"`.
- **Call allowed tool.** POST `/` `encode_function_data` balanceOf payload. Body contains `0x70a082310000000000000000000000001234567890123456789012345678901234567890`.
- **Proof.** Evidence files `device.json`, `device-approved.html`, `device-token.json`, and `allow.json` exist under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/device-flow/`.

## Gotchas

- Polling before consent returns `authorization_pending`. That is not a failure of the start step.
- User codes are case-insensitive but must keep the hyphen (`ABCD-EFGH`).
- Do not log `device_code` in operator transcripts; evidence files are gitignored.

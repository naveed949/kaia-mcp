# Stateless transport

The MCP endpoint follows the MCP 2026-07-28 Streamable HTTP transport with no protocol sessions. Every `POST /` stands alone: the bearer is checked on that request, no `initialize` is needed first, and no `Mcp-Session-Id` is ever minted. `GET` and `DELETE` answer 405. A browser `Origin` that is not allow-listed is refused with 403 before authentication, and CORS echoes only allowed origins.

## Sub-features

- `post-only` answers `GET /` and `DELETE /` with `405`, `Allow: POST`, and a JSON-RPC `-32000` body.
- `no-initialize` answers `tools/list` sent as the first and only request with the bearer's scope-filtered tool list (a `kaia:read` token does not see `encode_function_data`).
- `no-session` never returns `Mcp-Session-Id`, including on `initialize`, and ignores a stale `Mcp-Session-Id` request header instead of answering 404.
- `origin-403` refuses a foreign `Origin` (`https://evil.example`) on `POST /` and on `POST /oauth/token` with `403` and exactly `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Forbidden: Origin not allowed"}}`, with no CORS header, and the tool never runs.
- `origin-allowed` accepts the server's own origin, echoing it in `Access-Control-Allow-Origin` with `Vary: Origin`; requests with no `Origin` (curl, SDKs, gateways) pass.
- `cors-headers` answers a preflight with `Access-Control-Allow-Headers` naming `Authorization`, `Content-Type`, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`, never `Mcp-Session-Id`, and never `*` as the origin.
- `body-limits` answers a body that is not JSON with `400` and `-32700`, and a body over 4 MB with `413` and `-32600`, before any MCP handling.
- `public-docs-cors` serves `GET /oauth/jwks` to any origin with `Access-Control-Allow-Origin: *`.

## How to get to it (user POV)

- Get a `kaia:read` token through the device flow.
- `GET /` and `DELETE /` with the bearer.
- `POST /` `tools/list` with the bearer and nothing else; then `initialize`; then `tools/list` with `Mcp-Session-Id: not-a-session`.
- `POST /` and `POST /oauth/token` with `Origin: https://evil.example`; `POST /` with `Origin: http://127.0.0.1:<port>`; `OPTIONS /` preflight from that origin.
- `GET /oauth/jwks` with `Origin: https://evil.example`.
- `POST /` with the bearer and the body `{"jsonrpc":`, then with a 4 MB + 16 byte body.

## Driving it with verify-kaia

Preconditions:

- kaia-mcp is healthy at `http://127.0.0.1:<port>` from `instance.json`, and `doctor.sh` passes.
- `KAIA_ALLOWED_ORIGINS` is empty (launch pins it), so the only allowed browser origin is the instance URL.

- **Run.** `.cursor/skills/verify-kaia-mcp/helpers/drive.sh stateless-transport`.
- **POST only.** `get.headers` and `delete.headers` are `HTTP/1.1 405` with `allow: POST`; `get.json` and `delete.json` have `error.code=-32000`.
- **No initialize, no session.** `list-no-init.headers` is `HTTP/1.1 200`, `list-no-init.json` contains `get_block_number` and not `encode_function_data`. `init.json` contains `serverInfo`. None of `list-no-init.headers`, `init.headers`, `stale-session.headers` has `mcp-session-id`; `stale-session.headers` is `HTTP/1.1 200`.
- **Foreign Origin.** `origin-evil.headers` and `origin-evil-token.headers` are `HTTP/1.1 403` with no `access-control-allow-origin`; `origin-evil.json` is exactly the body above. `tool-call-count.json` shows `after = before` for `get_block_number`.
- **Own Origin and preflight.** `origin-self.headers` is `HTTP/1.1 200` with `access-control-allow-origin: http://127.0.0.1:<port>` and `vary: Origin`. `preflight.headers` lists the five headers above and has no `Mcp-Session-Id`.
- **Public docs.** `jwks-evil-origin.headers` is `HTTP/1.1 200` with `access-control-allow-origin: *`.
- **Body limits.** `bad-json.headers` is `HTTP/1.1 400` with `bad-json.json` `error.code=-32700`; `too-large.headers` is `HTTP/1.1 413` with `too-large.json` `error.code=-32600`.
- **Proof.** All of the files above are under `.cursor/skills/verify-kaia-mcp/evidence/<run-id>/stateless-transport/`.

## Gotchas

- The SDK in this build negotiates protocol versions up to `2025-11-25`. Sending `MCP-Protocol-Version: 2026-07-28` gets an SDK `400` until the SDK v2 migration; the drive does not send that header.
- `tools/list` depends on the token's scopes. Compare it against the token used, never across tokens.
- curl sends `Expect: 100-continue` for large bodies, which puts an `HTTP/1.1 100 Continue` block first in the headers file; the drive sends `Expect:` (empty) so the first status line is the real one.
- The oversized body is written to a temp file in the evidence directory and deleted right after the request.
- `Origin: null` (sandboxed iframes, `file://`) is a foreign origin and gets 403.
- An `Mcp-Session-Id` in any response, or `Server not initialized`, means a pre-stateless build is running; relaunch (launch rebuilds `dist/`).

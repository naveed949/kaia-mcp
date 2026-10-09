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

`tools/list` stays filtered per token: it lists only the tools the token's scopes allow (and never `generate_wallet` unless the unsafe flag is set). This is deliberate: a client should not be shown tools it cannot call, and it leaks nothing a scope-holder may not already use. The result therefore depends on the caller's token. On the 2026-07-28 path the server advertises `cacheScope: "private"` and `ttlMs: 0` on `tools/list` (SEP-2549): intermediaries must never share a cached list across tokens. `ttlMs` is fixed at `0` for every list: there is no setting for a non-zero TTL, and changing it is a code change.

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

- Every 401 carries `WWW-Authenticate: Bearer realm="kaia-mcp", [error="invalid_token", error_description="…",] resource_metadata="<issuer>/.well-known/oauth-protected-resource", scope="kaia:read"`. `error` is omitted when the request had no bearer credential at all (no `Authorization` header, an empty one, `Bearer` with nothing after it, or another scheme such as `Basic`); that is `-32040 unauthorized`. `scope` is the least-privilege scope for basic use.
- A token is accepted only as `Authorization: Bearer <b64token>` (RFC 6750 2.1): the scheme in any case, one or more spaces, then one token of `A-Z a-z 0-9 - . _ ~ + /` with optional trailing `=`. A malformed bearer credential (the `Bearer` scheme followed by a quoted token, `%`, `!` or another character outside b64token, a trailing comma or junk, a second credential, or a tab, NBSP or other non-space separator) is `-32043 invalid_token` with `error="invalid_token"` in the challenge.
- The JWT's three segments must be canonical unpadded base64url (RFC 7515 2). `<token>==`, or a signature whose last character differs only in its unused low bits, is `invalid_token`, so a token has exactly one accepted spelling and one log fingerprint.
- An insufficient-scope `tools/call` gets HTTP **403** with `WWW-Authenticate: Bearer realm="kaia-mcp", error="insufficient_scope", scope="<required scope>", resource_metadata="…", error_description="…"`. The body is still the JSON-RPC `-32042` error above, with the request's `id`, so gateways that parse bodies (s1-tool-gate) keep working. It is decided before the MCP server runs, with the same gate the tool handler uses; `tool_disabled`, unknown tools and other tool errors stay in-band JSON-RPC errors on HTTP 200.

Transport-level refusals (before auth):

| Situation                             | HTTP | Body                                                                                  |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `Origin` present and not allow-listed | 403  | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Forbidden: Origin not allowed"}}` |
| `GET` or `DELETE` on the MCP endpoint | 405  | JSON-RPC `-32000`, header `Allow: POST`                                               |
| Body is not JSON                      | 400  | JSON-RPC `-32700`                                                                     |
| Body nests deeper than 64 levels      | 400  | JSON-RPC `-32700` `Parse error: body is nested too deeply`                            |
| Body over 4 MB                        | 413  | JSON-RPC `-32600`, header `Connection: close`                                         |
| Body stream broken (client aborted)   | 400  | JSON-RPC `-32600`, header `Connection: close`                                         |

A body over the limit is not read further (a declared `Content-Length` over the limit is refused before any of it is read), and the response closes the connection, so a keep-alive client sends its next request on a fresh connection instead of one the server has stopped reading. The OAuth endpoints do the same with a 1 MB limit: `413 {"error":"invalid_request","error_description":"payload too large"}` with `Connection: close`.

Access tokens are not stored (they are self-contained JWTs); refresh tokens are stored hashed. Logs emit a 12-character sha256 fingerprint and the `jti`, never the raw token. `Authorization`, `access_token`, `refresh_token`, `client_secret`, `code_verifier`, and `device_code` fields, `Bearer …` values, and bare compact JWTs are redacted if they reach the logger, in any value of any type (strings, numbers, arrays, `Error`s, objects through their string form) and in `error=` exception text. Redaction runs before the 256-byte (`error=` 512-byte) cap, so a token cut by the cap cannot leave its `eyJ…` header or payload behind. Before redaction, the logger bounds every value and message to its first 4096 characters, cut only at whitespace: every secret the redactor knows (a JWT, the token of `Bearer <token>`, a URL) is one run of non-whitespace characters, so each run is kept whole (and redacted exactly as in the full value) or dropped whole, and a cut is marked with `…`. A run that crosses the 4096th character is dropped, so a value that is one huge run (a 4 MB tool name) logs as just `…`. The redactor itself is linear-time on any input (the JWT step is a single-pass scanner, the other patterns cannot backtrack super-linearly), and the bound keeps its work to a few KB per value, whatever the size of a tool name, Origin or upstream revert reason.

Every `tools/call` that reaches kaia-mcp logs one `Tool call` info line, written after the authorization decision: `msg=Tool call tool=<name> outcome=allowed tokenFingerprint=<fp>`, or `msg=Tool call tool=<name> outcome=denied errorCode=<code> reason=<error> [tokenFingerprint=<fp>]`. It never includes arguments or token material. Allowed and denied calls share the `msg=Tool call tool=<name> ` prefix, so a gateway in front of kaia-mcp can count those lines to prove a call it denied never arrived.

- `reason` is the auth error (`unauthorized`, `token_expired`, `insufficient_scope`, `invalid_token`, `tool_disabled`), `unknown_tool` (`errorCode=-32602`) for a name outside the tool-scope map, or `internal_error` (`errorCode=-32603`) when authorization itself failed unexpectedly. Every one of these fails closed.
- `<name>` is caller input. Names made only of printable ASCII other than `%`, `=`, `"` and `\` (every real tool) are logged unchanged; anything else is percent-encoded like every log value (below), so a crafted name cannot add fields or lines.
- **Every log value is one token.** The logger percent-encodes (UTF-8 bytes) every byte of every value that is not printable ASCII, plus space, `=`, `%`, `"` and `\`, and caps each value at 256 bytes (`error=` at 512) with an encoded `…`. That covers tabs, CR/LF, C0/C1 controls, U+2028/U+2029, NBSP, U+3000, zero-width and bidi characters, and look-alikes such as U+FF1D. So no caller value (an `Origin`, tool, resource or prompt name, OAuth parameter, header, exception text) can start a line or form a `key=value` token of its own: a foreign Origin of `http://x msg=Tool call tool=generate_wallet outcome=allowed` logs as `origin=http://x%20msg%3DTool%20call%20tool%3Dgenerate_wallet%20outcome%3Dallowed`. Messages are fixed strings (a unit test checks every `logger.*` call passes a literal); they keep their spaces but get the same encoding for everything else. Decode a value with any percent-decoder, e.g. `python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read()))'`.
- To count allowed calls, match the structured fields: `^timestamp=\S+ level=info msg=Tool call tool=\S+ outcome=allowed( |$)`. Do not count the substring `outcome=allowed` across the whole log.
- Client mistakes in a tool, resource or prompt request log one info line `msg=Request denied code=<code> method=<tools/call|resources/read|prompts/get|…> category=<category> errorType=<Error name> outcome=denied`. Only errors kaia raises itself about the request count: an unknown tool, resource or prompt name (kaia's own `ProtocolError`); an in-band auth denial (`AuthError`, `-32040`…`-32044`); and a tool argument that fails validation (`InvalidParamsError`): a bad address, network, transaction hash, block number, `tokenId`, `value` (not a non-negative integer, digit string or 0x-hex, e.g. `"1.5"`), `data` (not even-length hex), or `page`/`size`/`limit` (not a number or numeric string); an ABI that is not a JSON array; an empty `functionName` or one not on the ABI; `args` that is not an array; a function or argument that does not fit the ABI; or, for `read_contract`, an `outputs` list that is missing or has a type viem cannot decode. A caller ABI is copied as soon as it is parsed into kaia's own strictly typed form, and only that copy is used; viem never sees the caller's objects. The ABI must be a JSON array (or a JSON string of one) of at most 4096 items. Every item must be a plain object whose `type` is one of `function`, `event`, `error`, `constructor`, `fallback` or `receive`; `name`, when present, a string (required for functions); `stateMutability`, when present, one of `pure`, `view`, `nonpayable` or `payable`; and `inputs` and `outputs`, when present, real arrays (an array-like object such as `{"length":1,"0":…}` is refused). Every parameter, in every item, at every depth, must be a plain object with a string `type` of at most 256 characters, a `name` that is a string when present, and `components`, when present, a real array; tuples may nest at most 32 deep, and there may be at most 32768 parameters in all. Item and parameter names are at most 1024 characters, and all item names, parameter names and parameter types together at most 262144 characters. Only `type`, `name`, `inputs`, `outputs`, `stateMutability` and, per parameter, `name`, `type` and `components` are read; other fields are ignored. Any of these failing refuses the request (`Invalid ABI: inputs must be an array.`, `Invalid ABI: item name must be a string.`, `Invalid ABI: parameter has a type longer than 256 characters.`, `Invalid ABI: more than 4096 items.`, …). A parameter type must also match kaia's type grammar: `address`, `bool`, `string`, `bytes`, `bytes1`–`bytes32`, `int`, `uint`, `int8`–`int256` and `uint8`–`uint256` (multiples of 8), or `tuple` with `components`, each followed by any number of `[]` or `[N]` suffixes, with no spaces. A function with an input type outside the grammar (`function`, a library's `S storage`, `fixed128x18`…) or a name that is not a Solidity identifier is set aside: calling it is refused (`Invalid ABI: input parameter has unknown type "function", so function "f" is not supported …`), but it does not make the rest of the ABI unusable. For `read_contract`, the called function's outputs must be declared and within the grammar too. The function is then resolved by kaia: by 4-byte selector (`0x` and 8 hex digits, any case, computed from kaia's copy) or by name, from at most 16 functions with that name or selector, then by argument count and each argument against its type, with the same rule as viem (the last overload whose types fit the args, unless two fit ambiguously, such as `address` and `bytes20` for an address argument, which is refused with both selectors so the caller can pick one; when no overload's types fit, the first with as many inputs as there are args, or else the first). viem is then handed just that one function, so its own overload matching never runs. `read_contract` encodes the call once and sends that calldata. These caps are far above any real ABI (of 105 real ABIs checked, 20 mainnet contracts and 85 from Kaia's contract bindings, the most items is 136, Kaia AddressBookV2, the most parameters 470, Seaport 1.6, which has about 9 K characters of names and types; no type is longer than 9 characters; no name has more than 3 overloads). Parsing, selector lookup and overload resolution are linear in the ABI and the args: within the caps, the slowest ABI shape measured (a selector looked up over 4096 functions that use up the character budget) takes about 0.1–0.15 s, and the args are walked at most once per overload with as many inputs. `args` is capped too, in one linear walk before the function is resolved and before viem reads it: at most 32768 values in all (array elements, tuple members and scalars, at every depth, over all arguments), arrays and objects nested at most 32 deep within one argument, and at most 1048576 characters of strings and object keys in all (about 24,900 addresses, or a Multicall3 `aggregate` of about 9,000 `balanceOf` calls). Over a cap the call is refused with `-32602` naming it: `Invalid args: more than 32768 values (array elements, tuple members and scalars) in all.`, `Invalid args: arrays and objects nested more than 32 deep.` or `Invalid args: more than 1048576 characters of strings in all.` Each value is at least one 32-byte word of calldata, so the caps allow 1 MB of calldata or more, eight times the 128 KB transaction that geth's transaction pool accepts; of 109 real ABIs checked, no function needs more than 5 levels of nesting. A call at the caps is about 1.1 MB of JSON, inside the 4 MB body limit, so over HTTP the caps, not the body limit, are what bind. Encoding at the caps takes up to about 0.8 s (24,900 distinct mixed-case addresses, each checksum-checked with a keccak hash; about 0.25 s for other shapes) and returns up to about 10.5 MB of hex (32,767 strings of 32 three-byte UTF-8 characters such as `€`: the cap counts characters, the encoding bytes); an over-cap array or string is refused in about 1 ms however large it is (before the caps, a 1.6 M-element array took 4–8 s to encode). One shape costs more: an object (a named tuple) with 400,000 keys takes about 0.15 s to refuse, because the engine lists every key before the walk can stop; JSON-parsing that body costs more than that. A viem encode error is passed on with at most 256 characters of its message, cut with `…` (viem quotes the offending argument whole). Argument validation answers JSON-RPC `-32602` Invalid params with a short reason (`Invalid address: …`, `Invalid ABI: not valid JSON.`, `Invalid arguments: …`) and logs `code=-32602 category=invalid_params errorType=InvalidParamsError`. It runs before any RPC or KaiaScan call, for all 26 tools (a test sweeps every argument of every tool with hostile JSON values and requires zero `level=error` lines). For `tools/call` the `Tool call` audit line above is still written: `outcome=allowed` records the authorization decision, so a call that then fails validation has both lines.
- Server-side failures log `level=error msg=Tool error code=<code> method=<method> category=<category> errorType=<Error name> [upstreamCode=<n>] [upstreamStatus=<n>] detail=<short description>` and answer a fixed, generic message:
  - An RPC node failure (an HTTP error, timeout, reset, unparseable reply, or a JSON-RPC error **whatever its code**, including `-32602`/`-32601`/`-32600`/`-32700`/`-32042`): `-32001` `Upstream RPC request failed.` (or `… timed out.`), `category=rpc_provider`. The node's code is not trusted to mean "caller mistake": a node answering `-32602` to a request kaia built is a server-side problem.
  - A KaiaScan failure (HTTP error, network error, non-JSON body): `-32004` `KaiaScan API request failed (<operation>)[: HTTP <status>].`, `category=kaiascan_api`. Not `-32002`: MCP SDK v2 rewrites `-32002` to `-32602` on the wire.
  - A rate limit: `-32003` `… rate limit reached; retry later.`, `category=rate_limit`. Only structured signals count: HTTP status 429 from either upstream (KaiaScan after one retry), or an RPC node's JSON-RPC error code `429` (Alchemy, Infura) or `-32007` (QuickNode). Text is never consulted: viem's message carries the caller's function name and the contract's revert reason, so a function named `rateLimit` that reverts, a revert reason of `Too Many Requests`, or a node message saying "rate limit" under any other code stays `-32001`. `-32005` ("limit exceeded") also means a result-size limit, so it stays `-32001`.
  - A `read_contract` result over kaia's size caps: `-32005` (EIP-1474 "Limit exceeded"), `category=result_too_large`, with a fixed message naming the cap: `Contract call result is too large: it is over 2097152 bytes (the read_contract limit).`, `… its decoded text is over 4194304 characters …` or `… it holds over 8192 addresses …`. kaia's own code: an RPC node's `-32005` is still `-32001` with `upstreamCode: -32005`. See [read_contract result size](#read_contract-result-size).
  - Anything else (an unexpected exception): `-32603` `Internal error`, `category=internal`.
  - The caller never gets the upstream's text, the RPC URL (provider URLs often embed an API key), the request body, the KaiaScan API key, or a stack; `error.data` carries at most `upstreamCode` (the node's JSON-RPC code, only when it is a safe integer: a string, object, fractional or non-finite `code` is dropped, so a hostile node cannot reflect its URL or a token through it) and the HTTP `upstreamStatus`. The detail stays in the log: `detail` is the upstream's short description (viem's short message and the node's error text, the KaiaScan HTTP status or network error code, or the exception message), never the request body or the RPC URL. It can include text an upstream echoed from the request (a function name, a parameter), encoded and capped like every value. On top of that the logger redacts every http(s)/ws(s) URL in any value: userinfo, the query string and fragment, and any path segment shaped like a key (16+ token characters with a letter and a digit) become `[redacted]`.
- A refused foreign `Origin` logs `level=warn msg=request refused: Origin not allowed origin=<value> method=<method>`. The value is bounded at a whitespace boundary (as above) and redacted first (a JWT or `Bearer <token>` anywhere in it becomes `[redacted-jwt]`/`Bearer [redacted]`, so cutting cannot leave an `eyJ…` fragment), then cut to its first 64 bytes (plus an encoded `…`), then encoded. Each kept byte encodes to at most 3 characters, so the line has an absolute bound whatever the header holds: the longest is about 306 bytes (64 bytes of `0xFF` as latin-1). This is a fixed ceiling, not a ratio: for a minimal request (a ~67-byte request carrying 32 bytes of `0xFF`), the line is still about 4× the request's size.
- Requests the MCP SDK rejects before any handler runs (header/body mismatch, bad envelope or protocol version, malformed batch, wrong Accept or Content-Type) log one info line: `msg=MCP request rejected code=<JSON-RPC code> cell=<SDK rejection cell> errorType=<Error name> [tokenFingerprint=<fp>]`. Over stdio the same applies to the three messages the SDK logs when it drops a client message (a response before the era is negotiated, a notification with a malformed envelope or an unsupported revision: cells `response-before-negotiation`, `notification-envelope-invalid`, `notification-unsupported-revision`), matched on the SDK's exact text, and to a 2025-era request on a connection pinned to 2026-07-28 (`modern-only-missing-envelope`). Any other "Discarded …" message (the server-side probe timeout, a wording a future SDK adds) logs at error until it is classified. A body nested deeper than 64 levels is refused by kaia before the SDK sees it, with `cell=json-too-deep code=-32700`. The SDK's own message is never logged, because on the 2026-07-28 path it echoes `params.name`, `Mcp-Name`, `Mcp-Method` and protocol-version values. Any other SDK error, and any error caught by the HTTP request handler itself (`msg=HTTP request error`, answered with a 500), logs at error level with the error type, code and a `detail` value encoded like every other value.

## read_contract result size

The ABI encoding lets many offsets point at the same data: 4,000 elements of a `string[]` or `bytes[]` result can all point at one 64 KB string. Before these caps, such a 193 KB `eth_call` result decoded to a 262 MB response (about 4 s, with other requests stalled about 3 s), and the `bytes[]` version ran the server out of memory ([#11](https://github.com/naveed949/kaia-mcp/issues/11) P-1). Anyone who can call `read_contract` on a contract they deployed, or a hostile RPC node, could send it. viem's decoder bounds how often one position is re-read (8,192 times), not how much it produces.

So `read_contract` checks the result before viem decodes it:

- **At most 2,097,152 bytes of result** (`MAX_RESULT_BYTES`). The largest result the args cap lets Multicall3 return, `aggregate3` of about 9,000 `balanceOf` calls, is about 1.44 MB.
- **At most 4,194,304 characters of decoded text** (`MAX_RESULT_CHARS`), the JSON (2-space indent) printed after `Result:`. A walk of the result, in one pass and without building any value, mirrors viem's decoder (the same offsets and the same bounds checks) and adds up the text: an address is 44 characters, a `bytes` value 4 plus 2 a byte, a string 2 plus at least 1 a byte (6 for an escaped control character), an integer its quoted digits, plus brackets, keys, commas and indentation. Data reached through several offsets is counted once per offset, so aliasing cannot amplify past the cap, and an array's length is charged before its elements are visited, so the walk stops within about 4 M steps whatever the result claims. The count is an upper bound (exact for ASCII text, addresses and bytes; a multi-byte character counts one per UTF-8 byte; an integer may count up to three characters more); the printed text is checked against the cap again after decoding. The cap is twice the byte cap, so the largest `bytes` value still fits.
- **At most 8,192 addresses** (`MAX_RESULT_ADDRESSES`). viem checksums each distinct address with a keccak hash, about 20 µs each: 8,192 take about 0.15–0.2 s; the 131,000 that fit in 4 MB took 2.6 s.

Over a cap, the call answers `-32005` naming the cap, and nothing is decoded. Data viem cannot decode (an offset or length out of bounds, an offset that is not a safe integer) still answers `-32001` as before (the walk refuses what it finds out of bounds before viem runs; viem refuses the rest). One case changes code: a huge count of zero-width elements (`uint8[0][]` with length 2^53, its elements starting inside the data), which viem refused with its read limit (`-32001`), is now `-32005`.

Measured (in-process, Node 22, this repo's box; live with the built server and a fake RPC):

| Result                                                                 | Before                                                                             | Now                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P-1 `string[]` (193 KB, 4,000 offsets to 64 KB)                        | 262 MB response, 4.1–4.6 s; live server with a 512 MB heap: killed (out of memory) | `-32005` in 80–88 ms live, an unrelated request 3 ms |
| P-1 `bytes[]`                                                          | server killed (out of memory)                                                      | `-32005` in 23–29 ms live                            |
| 31 offsets to 64 KB of `bytes` (4.06 M characters, just under the cap) | 0.40–0.42 s live                                                                   | same text, 0.37–0.39 s                               |
| Multicall3 `aggregate3`, 9,000 results (1.44 MB)                       | 0.16–0.22 s live                                                                   | same text, 0.20–0.23 s                               |
| One 2 MiB `bytes` value (4.19 M characters)                            | 0.34–0.38 s live                                                                   | same text, 0.36 s                                    |
| 8,192 addresses                                                        | 0.17–0.20 s live                                                                   | same text, 0.19–0.20 s                               |

Of 109 real ABIs (20 mainnet contracts from Sourcify, 85 from Kaia's contract bindings, and viem's ERC-20/721/4626 and Multicall3 ABIs), every one of 1,274 functions with outputs, with 4 random results each (one with 200-element arrays), prints exactly as before (5,096 of 5,096). The walk adds about 0.03 ms to a typical small result and up to about 20–45 ms at the byte cap.

The caps apply to `read_contract`, the only tool that ABI-decodes upstream data (`get_token_allowance` decodes one fixed `uint256` word, which cannot be aliased). Other RPC and KaiaScan responses are read in full by the HTTP client before kaia sees them; they are not size-capped here.

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

| Setting                                               | Behavior                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default                                               | A fresh RSA-2048 key is generated at startup and kept in memory. Restarting the server invalidates every outstanding token.                                                                                                                                                                                                                                                           |
| `KAIA_OAUTH_SIGNING_KEY_FILE=<path>`                  | Dev persistence. The PKCS#8 PEM is loaded from `<path>`, or created there with mode `0600`. Use a gitignored path; `.kaia-dev/` is ignored for this.                                                                                                                                                                                                                                  |
| `KAIA_OAUTH_REVOCATION_FILE=<path>`                   | Where the revocation denylist is persisted. Defaults to `revoked-jti.json` in the signing key's directory whenever `KAIA_OAUTH_SIGNING_KEY_FILE` is set. The path must be a regular file owned by the server user and not group/world-writable; a symlink or FIFO there refuses startup. One file per process: a file another running instance holds (`<path>.lock`) refuses startup. |
| `KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES=<a.pem,b.pem>` | Key rotation. Retired keys are published in the JWKS and accepted for verification (never used to sign), so tokens minted before a rotation stay valid until `exp`. Each file must exist; an unreadable one refuses startup. Rotate by moving the old `KAIA_OAUTH_SIGNING_KEY_FILE` here and pointing that variable at a new path.                                                    |

No signing key is committed. Production deployments use their own authorization server and never this provider.

## Revocation and introspection

`POST /oauth/revoke` (RFC 7009) with `token=<access_or_refresh>` answers `200 {}` (also for unknown or malformed tokens), or `503` when the revocation could not be persisted (below).

- Access token: its `jti` is added to the revocation denylist until the token's `exp`.
- Refresh token: the refresh token is revoked and so is the `jti` of the access token it was issued with, until that access token's own `exp`.
- Refresh rotation (`grant_type=refresh_token`) revokes the previous access `jti` (until its `exp`), then consumes the refresh token.

Revocations and restarts:

- **In-memory signing key (default).** The denylist is in memory too. A restart generates a new key, so every token from the previous process fails signature verification (`invalid_token`), revoked or not.
- **Persisted signing key (`KAIA_OAUTH_SIGNING_KEY_FILE`).** Tokens outlive the process, so the denylist is persisted as well, to `KAIA_OAUTH_REVOCATION_FILE` (default `revoked-jti.json` next to the key). The format is `{"version":1,"entries":[{"id":"<jti>","expMs":<epoch ms>}]}`. It never contains tokens. Writes go to a temp file created exclusively (`O_EXCL`, so nothing planted at that path is followed) with mode `0600`, written in full, fsynced, renamed over the file, and then the directory is fsynced. Adding an entry that is already present (or already expired) does not rewrite the file. Entries are dropped once the token would have expired. The file is loaded before the port is bound. A missing file means an empty list (first start). An unreadable, corrupt or insecure file (not a regular file, writable by group or others, or not owned by the server's user) stops startup with an error; the server never falls back to an empty list.
- **One file, one process (enforced).** Each server keeps its own view of the denylist and rewrites the whole file, so two processes pointed at the same file would drop each other's entries and a revoked token would work again after a restart. The server therefore locks the file at startup (`<file>.lock`, held until it exits) and refuses to start when another live instance holds it: `revocation store <file> is in use by another kaia-mcp process (pid <n> on <host>, lock file <file>.lock) … Set a distinct KAIA_OAUTH_REVOCATION_FILE for each instance`. The default path is next to the signing key, so instances that share `KAIA_OAUTH_SIGNING_KEY_FILE` must each set their own `KAIA_OAUTH_REVOCATION_FILE` (see [Stateless HTTP](#stateless-http-mcp-2026-07-28)).
- **How the lock behaves.** Node has no OS file-lock API without a native addon, so the lock is a lock file created atomically that records the holder (pid, host, boot id, pid namespace, process start time) and is refreshed every 5 s. A clean stop (`SIGTERM`/`SIGINT`) removes it. After a crash it is taken over at the next start: at once when the holder is on the same machine and its process is gone (a reused pid is told apart by its start time), or, when the holder cannot be checked (another host on a shared volume, another container), once its heartbeat is older than 30 s. A lock file that cannot be read refuses startup until it is 30 s old. While running, every write re-checks the lock: if another process took it, the revocation answers `503` instead of overwriting that process's file; if the lock file vanished, it is re-created and the file's current entries are merged before writing.
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

HTTP serving uses the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` `createMcpHandler` with `legacy: 'stateless'`, mounted via `@modelcontextprotocol/node` `toNodeHandler`). The modern path speaks protocol **2026-07-28** (`server/discover`, per-request `_meta` envelope, `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` header validation with JSON-RPC `-32020` HeaderMismatch). 2025-era clients keep working via the stateless legacy fallback (per-request `initialize`, no sessions).

The Streamable HTTP endpoint is `POST /` and has no protocol-level sessions:

- Every POST is served by a fresh MCP server and transport. `Mcp-Session-Id` is never minted or echoed; a legacy client's header is ignored. No `initialize` is needed before `tools/list` or `tools/call`.
- `GET` and `DELETE` on the MCP endpoint answer `405` with `Allow: POST` (no standalone SSE stream, no session to delete).
- Any instance can answer any request when instances share the signing key (`KAIA_OAUTH_SIGNING_KEY_FILE`) and `KAIA_PUBLIC_URL`. A token minted on one instance verifies on another.
- Still per process (there is no shared store yet): the demo AS's codes, device codes and refresh tokens (see [AS state](#authorization-server-state)), and the revocation denylist. Behind a load balancer, keep the OAuth flow on one instance (sticky routing) or front a real AS.
- **Revocations are per instance.** A token revoked on one instance is still accepted by the others until it expires; there is no shared denylist yet. Keep access-token TTLs short, or route each client to a single instance (sticky routing). Each instance must also have its own denylist file (a shared one is refused at startup, see [Revocation](#revocation-and-introspection)):

  ```sh
  # instance A
  KAIA_OAUTH_SIGNING_KEY_FILE=/srv/kaia/signing-key.pem \
  KAIA_OAUTH_REVOCATION_FILE=/srv/kaia/revoked-jti.a.json \
  KAIA_PUBLIC_URL=https://kaia.example.com kaia-mcp --transport http --port 3100
  # instance B
  KAIA_OAUTH_SIGNING_KEY_FILE=/srv/kaia/signing-key.pem \
  KAIA_OAUTH_REVOCATION_FILE=/srv/kaia/revoked-jti.b.json \
  KAIA_PUBLIC_URL=https://kaia.example.com kaia-mcp --transport http --port 3101
  ```

- Protocol versions: a request carrying the 2026-07-28 `_meta` envelope is served on the modern path, which accepts only `2026-07-28` (another envelope version is 400 `-32022` with `supported: ["2026-07-28"]`). A request with no envelope takes the 2025-era stateless fallback (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`), except that an `MCP-Protocol-Version: 2026-07-28` header without the envelope is refused with 400 `-32602`.

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
- Single-use values (codes, device codes, refresh tokens) are redeemed with an atomic `take()`, so a shared store implementation cannot let two instances redeem the same code.
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

#!/usr/bin/env bash
set -euo pipefail
# Drive one mapped feature against the launched instance.
# Usage: helpers/drive.sh <oauth-pkce-scoped-tools|fail-closed-auth|generate-wallet-gated|device-flow|jwt-access-tokens|token-introspection|revocation-restart|stateless-transport|bearer-challenges|resource-indicators|stateless-multi-instance|protocol-2026-07-28>
# Writes evidence under ${EVIDENCE_DIR}/<feature>/ and does not delete it.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

FEATURE="${1:-}"
if [[ -z "${FEATURE}" ]]; then
  echo "Usage: helpers/drive.sh <oauth-pkce-scoped-tools|fail-closed-auth|generate-wallet-gated|device-flow|jwt-access-tokens|token-introspection|revocation-restart|stateless-transport|bearer-challenges|resource-indicators|stateless-multi-instance|protocol-2026-07-28>" >&2
  exit 2
fi

if [[ ! -f "${INSTANCE_FILE}" ]]; then
  echo "drive: missing instance file ${INSTANCE_FILE}. Run launch.sh first." >&2
  exit 1
fi

PORT="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.port))")"
BASE="http://127.0.0.1:${PORT}"
OUT="${EVIDENCE_DIR}/${FEATURE}"
mkdir -p "${OUT}"

save() {
  local name="$1"
  cat > "${OUT}/${name}"
}

# PKCE pair as JSON {verifier, challenge}
pkce_json() {
  node -e 'const {createHash,randomBytes}=require("crypto"); const verifier=randomBytes(32).toString("base64url"); const challenge=createHash("sha256").update(verifier).digest("base64url"); process.stdout.write(JSON.stringify({verifier,challenge}));'
}

ENCODE_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"encode_function_data","arguments":{"abi":"[{\"type\":\"function\",\"name\":\"balanceOf\",\"inputs\":[{\"name\":\"account\",\"type\":\"address\"}],\"outputs\":[{\"type\":\"uint256\"}],\"stateMutability\":\"view\"}]","functionName":"balanceOf","args":["0x1234567890123456789012345678901234567890"]}}}'
EXPECTED_CALLDATA="0x70a082310000000000000000000000001234567890123456789012345678901234567890"

mcp_init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify-kaia-mcp","version":"0"}}}'

# One stateless MCP request (MCP 2026-07-28 Streamable HTTP): a single POST with the
# bearer, no initialize and no session. Fails the drive if the server mints a session.
# Usage: mcp_call <evidence-prefix> <access-token> <json-body> [base-url]
# Writes <prefix>.headers and <prefix>.json.
mcp_call() {
  local prefix="$1" access="$2" body="$3" base="${4:-${BASE}}"
  curl -sS -D "${OUT}/${prefix}.headers" -o "${OUT}/${prefix}.json" -X POST "${base}/" \
    -H "Authorization: Bearer ${access}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${body}"
  if grep -qi '^mcp-session-id:' "${OUT}/${prefix}.headers"; then
    echo "drive: ${prefix} response carries Mcp-Session-Id; the transport must be stateless" >&2
    exit 1
  fi
}

# Device grant end to end (start, approve, exchange). Writes <prefix>.device.json and
# <prefix>.token.json; prints the access token. Usage: device_token <prefix> <scope> [base-url]
device_token() {
  local prefix="$1" scope="$2" BASE="${3:-${BASE}}" user_code device_code
  curl -sS -X POST "${BASE}/oauth/device" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "client_id=kaia-mcp-demo" --data-urlencode "scope=${scope}" > "${OUT}/${prefix}.device.json"
  user_code="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).user_code)" "${OUT}/${prefix}.device.json")"
  device_code="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).device_code)" "${OUT}/${prefix}.device.json")"
  curl -sS -o /dev/null -X POST "${BASE}/oauth/device/verify" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "user_code=${user_code}" --data-urlencode "decision=approve"
  curl -sS -X POST "${BASE}/oauth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
    --data-urlencode "client_id=kaia-mcp-demo" \
    --data-urlencode "device_code=${device_code}" > "${OUT}/${prefix}.token.json"
  node -e "const t=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!t.access_token){console.error('drive: no access_token', t.error); process.exit(1);} process.stdout.write(t.access_token);" "${OUT}/${prefix}.token.json"
}

# Bare MCP initialize with a bearer (no session follow-up). Usage: mcp_init_only <prefix> <token>
mcp_init_only() {
  curl -sS -D "${OUT}/$1.headers" -o "${OUT}/$1.json" -X POST "${BASE}/" \
    -H "Authorization: Bearer $2" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${mcp_init}" || true
}

# RFC 7662 introspection. Usage: introspect <prefix> <token> [none|wrong|gateway]
introspect() {
  local prefix="$1" token="$2" mode="${3:-gateway}" hint="${4:-}" secret_file auth=() extra=()
  if [[ -n "${hint}" ]]; then extra=(--data-urlencode "token_type_hint=${hint}"); fi
  secret_file="$(node -e "process.stdout.write(require(process.argv[1]).introspectionSecretFile)" "${INSTANCE_FILE}")"
  case "${mode}" in
    gateway) auth=(-u "$(node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(s.client_id+':'+s.client_secret)" "${secret_file}")") ;;
    wrong) auth=(-u "kaia-mcp-gateway:not-the-secret") ;;
    none) auth=() ;;
  esac
  curl -sS -D "${OUT}/${prefix}.headers" -o "${OUT}/${prefix}.json" -X POST "${BASE}/oauth/introspect" \
    "${auth[@]}" -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "token=${token}" "${extra[@]}" || true
}

# Lines for one tool and authorization outcome. Usage: tool_call_outcome_count <tool> <allowed|denied>
tool_call_outcome_count() {
  local log
  log="$(node -e "process.stdout.write(require(process.argv[1]).logFile)" "${INSTANCE_FILE}")"
  { grep -c "msg=Tool call tool=$1 outcome=$2 " "${log}" || true; } | tr -d '\n'
}

# Revoke a token over RFC 7009; prints the HTTP status. Usage: revoke_status <prefix> <token>
revoke_status() {
  curl -sS -o "${OUT}/$1.json" -w '%{http_code}' -X POST "${BASE}/oauth/revoke" \
    -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "token=$2"
}

tool_call_count() {
  local log
  log="$(node -e "process.stdout.write(require(process.argv[1]).logFile)" "${INSTANCE_FILE}")"
  { grep -c "msg=Tool call tool=$1 " "${log}" || true; } | tr -d '\n'
}

case "${FEATURE}" in
  oauth-pkce-scoped-tools)
    curl -sS "${BASE}/.well-known/openid-configuration" | save discovery.json
    PKCE="$(pkce_json)"
    echo "${PKCE}" | save pkce.json
    CHALLENGE="$(node -e "const p=JSON.parse(process.argv[1]); process.stdout.write(p.challenge)" "${PKCE}")"
    VERIFIER="$(node -e "const p=JSON.parse(process.argv[1]); process.stdout.write(p.verifier)" "${PKCE}")"
    AUTH_URL="${BASE}/oauth/authorize?client_id=kaia-mcp-demo&redirect_uri=http://127.0.0.1/callback&response_type=code&scope=kaia%3Aencode&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=verify1"
    curl -sS "${AUTH_URL}" | save consent.html
    REQUEST_ID="$(node -e "const fs=require('fs'); const h=fs.readFileSync('${OUT}/consent.html','utf8'); const m=h.match(/name=\"request_id\" value=\"([^\"]+)\"/); if(!m) process.exit(1); process.stdout.write(m[1]);")"
    curl -sS -D "${OUT}/consent.headers" -o /dev/null -X POST "${BASE}/oauth/consent" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "request_id=${REQUEST_ID}" \
      --data-urlencode "decision=approve" \
      --max-redirs 0 || true
    CODE="$(node -e "const fs=require('fs'); const t=fs.readFileSync('${OUT}/consent.headers','utf8'); const m=t.match(/location:\\s*(.+)/i); if(!m) process.exit(1); const u=new URL(m[1].trim()); process.stdout.write(u.searchParams.get('code')||'');")"
    echo "${CODE}" | save authorization.code.txt
    curl -sS -X POST "${BASE}/oauth/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=authorization_code" \
      --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "code=${CODE}" \
      --data-urlencode "code_verifier=${VERIFIER}" \
      --data-urlencode "redirect_uri=http://127.0.0.1/callback" \
      | save token.json
    ACCESS="$(node -e "const t=JSON.parse(require('fs').readFileSync('${OUT}/token.json','utf8')); process.stdout.write(t.access_token||'');")"
    mcp_call allow "${ACCESS}" "${ENCODE_BODY}"
    # Negative entry points on the same consent surface.
    curl -sS -D "${OUT}/plain-pkce.headers" -o "${OUT}/plain-pkce.body" --max-redirs 0 \
      "${BASE}/oauth/authorize?client_id=kaia-mcp-demo&redirect_uri=http://127.0.0.1/callback&response_type=code&scope=kaia%3Aencode&code_challenge=${CHALLENGE}&code_challenge_method=plain&state=verify-plain" || true
    curl -sS "${BASE}/oauth/authorize?client_id=kaia-mcp-demo&redirect_uri=http://127.0.0.1/callback&response_type=code&scope=kaia%3Aencode&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=verify-deny" | save deny-consent.html
    DENY_ID="$(node -e "const h=require('fs').readFileSync('${OUT}/deny-consent.html','utf8'); const m=h.match(/name=\"request_id\" value=\"([^\"]+)\"/); if(!m) process.exit(1); process.stdout.write(m[1]);")"
    curl -sS -D "${OUT}/deny.headers" -o /dev/null -X POST "${BASE}/oauth/consent" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "request_id=${DENY_ID}" \
      --data-urlencode "decision=deny" \
      --max-redirs 0 || true
    node -e "
      const fs=require('fs');
      const r=(f)=>fs.readFileSync('${OUT}/'+f,'utf8');
      const fail=(m)=>{ console.error('drive: '+m); process.exit(1); };
      const disc=JSON.parse(r('discovery.json'));
      if (JSON.stringify(disc.code_challenge_methods_supported)!=='[\"S256\"]' || !disc.authorization_endpoint) fail('discovery missing S256/authorization_endpoint');
      if (JSON.stringify(disc.response_types_supported)!=='[\"code\"]' || JSON.stringify(disc).includes('id_token') || 'subject_types_supported' in disc) fail('discovery advertises id_token/OIDC subject types or a response type other than code');
      const html=r('consent.html');
      if (!html.includes('Authorize kaia-mcp') || !html.includes('kaia:encode')) fail('consent page missing title or scope');
      if (!/state=verify1/.test(r('consent.headers'))) fail('consent redirect missing state');
      const tok=JSON.parse(r('token.json'));
      if (tok.token_type!=='Bearer' || tok.scope!=='kaia:encode') fail('token response wrong: '+JSON.stringify({token_type:tok.token_type,scope:tok.scope}));
      if (!r('allow.json').includes('${EXPECTED_CALLDATA}')) fail('expected calldata missing');
      const plain=r('plain-pkce.headers');
      if (/Authorize kaia-mcp/.test(r('plain-pkce.body')) || !/error=invalid_request/.test(plain)) fail('plain PKCE was not rejected');
      if (!/error=access_denied/.test(r('deny.headers')) || /[?&]code=/.test(r('deny.headers'))) fail('deny did not return access_denied without a code');
      console.log('drive oauth-pkce-scoped-tools: discover, consent, token, allow encode_function_data ok; plain PKCE rejected; deny -> access_denied');
    "
    ;;

  fail-closed-auth)
    curl -sS -D "${OUT}/unauthenticated.headers" -o "${OUT}/unauthenticated.json" -X POST "${BASE}/" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${mcp_init}" || true
    node -e "
      const fs=require('fs');
      const st=fs.readFileSync('${OUT}/unauthenticated.headers','utf8');
      const body=JSON.parse(fs.readFileSync('${OUT}/unauthenticated.json','utf8'));
      if (!st.includes('401')) { console.error('drive: expected HTTP 401'); process.exit(1); }
      if (body.error.code !== -32040) { console.error('drive: expected -32040', body); process.exit(1); }
      if (body.error.message !== 'unauthorized: missing access token') { console.error(body); process.exit(1); }
      console.log('drive fail-closed-auth: unauthenticated ok');
    "
    # Expired tokens are not mintable over the public token endpoint; they are covered by
    # src/evals/partner-auth.eval.test.ts. Live paths here: deny-by-scope, then revoke.
    PKCE="$(pkce_json)"
    CHALLENGE="$(node -e "const p=JSON.parse(process.argv[1]); process.stdout.write(p.challenge)" "${PKCE}")"
    VERIFIER="$(node -e "const p=JSON.parse(process.argv[1]); process.stdout.write(p.verifier)" "${PKCE}")"
    AUTH_URL="${BASE}/oauth/authorize?client_id=kaia-mcp-demo&redirect_uri=http://127.0.0.1/callback&response_type=code&scope=kaia%3Aread&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=verify2"
    HTML="$(curl -sS "${AUTH_URL}")"
    echo "${HTML}" | save read-consent.html
    REQUEST_ID="$(node -e "const h=require('fs').readFileSync('${OUT}/read-consent.html','utf8'); const m=h.match(/name=\"request_id\" value=\"([^\"]+)\"/); process.stdout.write(m[1]);")"
    curl -sS -D "${OUT}/read-consent.headers" -o /dev/null -X POST "${BASE}/oauth/consent" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "request_id=${REQUEST_ID}" \
      --data-urlencode "decision=approve" \
      --max-redirs 0 || true
    CODE="$(node -e "const t=require('fs').readFileSync('${OUT}/read-consent.headers','utf8'); const m=t.match(/location:\\s*(.+)/i); const u=new URL(m[1].trim()); process.stdout.write(u.searchParams.get('code')||'');")"
    curl -sS -X POST "${BASE}/oauth/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=authorization_code" \
      --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "code=${CODE}" \
      --data-urlencode "code_verifier=${VERIFIER}" \
      --data-urlencode "redirect_uri=http://127.0.0.1/callback" \
      | save read-token.json
    ACCESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${OUT}/read-token.json','utf8')).access_token)")"
    DENIED_BEFORE="$(tool_call_outcome_count encode_function_data denied)"
    mcp_call deny-scope "${ACCESS}" "${ENCODE_BODY}"
    DENIED_AFTER="$(tool_call_outcome_count encode_function_data denied)"
    LOG_FILE_PATH="$(inst logFile)"
    grep "msg=Tool call tool=encode_function_data outcome=denied " "${LOG_FILE_PATH}" | tail -n 1 | save deny-scope.tool-call-line.txt || true
    echo "{\"before\":${DENIED_BEFORE},\"after\":${DENIED_AFTER}}" | save deny-scope.tool-call-log-count.json
    node -e "
      const fs=require('fs');
      const body=fs.readFileSync('${OUT}/deny-scope.json','utf8');
      if (!body.includes('insufficient_scope: encode_function_data requires kaia:encode') && !body.includes('-32042')) {
        console.error('drive: expected insufficient_scope', body.slice(0,500));
        process.exit(1);
      }
      if (body.includes('0x70a08231')) { console.error('drive: denied call leaked calldata'); process.exit(1); }
      const hd=fs.readFileSync('${OUT}/deny-scope.headers','utf8');
      if (!/^HTTP\/1\.1 403/m.test(hd) || !/^www-authenticate: Bearer .*error=\"insufficient_scope\".*scope=\"kaia:encode\"/im.test(hd)) { console.error('drive: insufficient scope must be HTTP 403 with a Bearer insufficient_scope challenge', hd); process.exit(1); }
      const n=JSON.parse(fs.readFileSync('${OUT}/deny-scope.tool-call-log-count.json','utf8'));
      if (n.after!==n.before+1) { console.error('drive: expected one outcome=denied Tool call line', n); process.exit(1); }
      const line=fs.readFileSync('${OUT}/deny-scope.tool-call-line.txt','utf8');
      if (!/errorCode=-32042/.test(line) || !/reason=insufficient_scope/.test(line) || line.includes('balanceOf')) { console.error('drive: denied Tool call line wrong', line); process.exit(1); }
      console.log('drive fail-closed-auth: deny-by-scope ok (HTTP 403 insufficient_scope challenge, -32042 body, one outcome=denied errorCode=-32042 Tool call line)');
    "
    # Unknown and crafted tool names: denied (-32602) with one outcome=denied
    # reason=unknown_tool line each, never outcome=allowed, and no forged log line.
    LOG_FILE_PATH="$(inst logFile)"
    ALLOWED_TOTAL_BEFORE="$({ grep -c "outcome=allowed" "${LOG_FILE_PATH}" || true; } | tr -d '\n')"
    UNKNOWN_BEFORE="$(tool_call_outcome_count no_such_tool denied)"
    mcp_call unknown-tool "${ACCESS}" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}'
    FORGED_NAME='get_chain_info outcome=allowed\nlevel=info msg=Tool call tool=get_chain_info outcome=allowed\r'
    mcp_call forged-tool "${ACCESS}" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"${FORGED_NAME}\",\"arguments\":{}}}"
    UNKNOWN_AFTER="$(tool_call_outcome_count no_such_tool denied)"
    ALLOWED_TOTAL_AFTER="$({ grep -c "outcome=allowed" "${LOG_FILE_PATH}" || true; } | tr -d '\n')"
    { grep "reason=unknown_tool" "${LOG_FILE_PATH}" || true; } | tail -n 2 | save unknown-tool.tool-call-lines.txt
    { grep "msg=Tool error" "${LOG_FILE_PATH}" || true; } | save tool-error-lines.txt
    echo "{\"unknownBefore\":${UNKNOWN_BEFORE},\"unknownAfter\":${UNKNOWN_AFTER},\"allowedBefore\":${ALLOWED_TOTAL_BEFORE},\"allowedAfter\":${ALLOWED_TOTAL_AFTER}}" | save unknown-tool.log-count.json
    node -e "
      const fs=require('fs'); const r=(f)=>fs.readFileSync('${OUT}/'+f,'utf8');
      const fail=(m)=>{ console.error('drive: '+m); process.exit(1); };
      for (const f of ['unknown-tool.json','forged-tool.json']) {
        if (!r(f).includes('-32602')) fail(f+' expected -32602 Unknown tool: '+r(f).slice(0,300));
      }
      const n=JSON.parse(r('unknown-tool.log-count.json'));
      if (n.unknownAfter!==n.unknownBefore+1) fail('expected one outcome=denied line for no_such_tool '+JSON.stringify(n));
      if (n.allowedAfter!==n.allowedBefore) fail('unknown/forged tool produced an outcome=allowed line '+JSON.stringify(n));
      const lines=r('unknown-tool.tool-call-lines.txt').trim().split('\\n');
      if (lines.length!==2 || !lines.every(l=>/outcome=denied errorCode=-32602 reason=unknown_tool/.test(l))) fail('unknown_tool lines wrong '+lines.join(' | '));
      if (!/msg=Tool call tool=get_chain_info%20outcome%3Dallowed%0Alevel%3Dinfo/.test(lines[1])) fail('forged name not percent-encoded: '+lines[1]);
      const te=r('tool-error-lines.txt');
      if (/balanceOf|no_such_tool|get_chain_info outcome/.test(te)) fail('Tool error line echoes caller input');
      if (!/msg=Tool error code=-32602 category=invalid_params/.test(te)) fail('Tool error line lacks code/category');
      console.log('drive fail-closed-auth: unknown + forged tool names denied (-32602, reason=unknown_tool), no outcome=allowed, name percent-encoded, Tool error lines carry code/category only');
    "
    curl -sS -X POST "${BASE}/oauth/revoke" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "token=${ACCESS}" | save revoke.json
    curl -sS -D "${OUT}/revoked.headers" -o "${OUT}/revoked.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${mcp_init}" || true
    node -e "
      const fs=require('fs');
      const body=JSON.parse(fs.readFileSync('${OUT}/revoked.json','utf8'));
      if (body.error.code !== -32043) { console.error('drive: expected invalid_token after revoke', body); process.exit(1); }
      if (body.error.message !== 'invalid_token: access token is invalid or revoked') process.exit(1);
      console.log('drive fail-closed-auth: revoked token ok');
    "
    ;;

  generate-wallet-gated)
    PKCE="$(pkce_json)"
    CHALLENGE="$(node -e "const p=JSON.parse(process.argv[1]); process.stdout.write(p.challenge)" "${PKCE}")"
    VERIFIER="$(node -e "const p=JSON.parse(process.argv[1]); process.stdout.write(p.verifier)" "${PKCE}")"
    AUTH_URL="${BASE}/oauth/authorize?client_id=kaia-mcp-demo&redirect_uri=http://127.0.0.1/callback&response_type=code&scope=kaia%3Aread%20kaia%3Awallet&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=verify3"
    HTML="$(curl -sS "${AUTH_URL}")"
    echo "${HTML}" | save consent.html
    REQUEST_ID="$(node -e "const h=require('fs').readFileSync('${OUT}/consent.html','utf8'); const m=h.match(/name=\"request_id\" value=\"([^\"]+)\"/); process.stdout.write(m[1]);")"
    curl -sS -D "${OUT}/consent.headers" -o /dev/null -X POST "${BASE}/oauth/consent" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "request_id=${REQUEST_ID}" \
      --data-urlencode "decision=approve" \
      --max-redirs 0 || true
    CODE="$(node -e "const t=require('fs').readFileSync('${OUT}/consent.headers','utf8'); const m=t.match(/location:\\s*(.+)/i); const u=new URL(m[1].trim()); process.stdout.write(u.searchParams.get('code')||'');")"
    curl -sS -X POST "${BASE}/oauth/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=authorization_code" \
      --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "code=${CODE}" \
      --data-urlencode "code_verifier=${VERIFIER}" \
      --data-urlencode "redirect_uri=http://127.0.0.1/callback" \
      | save token.json
    ACCESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${OUT}/token.json','utf8')).access_token)")"
    LIST_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    mcp_call tools-list "${ACCESS}" "${LIST_BODY}"
    CALL_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_wallet","arguments":{}}}'
    mcp_call generate-wallet "${ACCESS}" "${CALL_BODY}"
    node -e "
      const fs=require('fs');
      const listed=fs.readFileSync('${OUT}/tools-list.json','utf8');
      const called=fs.readFileSync('${OUT}/generate-wallet.json','utf8');
      if (!listed.includes('encode_function_data') && !listed.includes('get_chain_info')) { console.error('drive: tools/list did not return a tool list', listed.slice(0,500)); process.exit(1); }
      if (listed.includes('generate_wallet')) { console.error('drive: generate_wallet leaked into tools/list'); process.exit(1); }
      if (/Private key \\(hex\\): 0x[a-fA-F0-9]{64}/.test(called)) { console.error('drive: private key returned'); process.exit(1); }
      if (!called.includes('tool_disabled') && !called.includes('-32044')) { console.error('drive: expected tool_disabled', called.slice(0,800)); process.exit(1); }
      console.log('drive generate-wallet-gated: no private key ok');
    "
    ;;

  device-flow)
    curl -sS -X POST "${BASE}/oauth/device" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "scope=kaia:encode" \
      | save device.json
    USER_CODE="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${OUT}/device.json','utf8')).user_code)")"
    DEVICE_CODE="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${OUT}/device.json','utf8')).device_code)")"
    curl -sS "${BASE}/oauth/device/verify?user_code=${USER_CODE}" | save device-consent.html
    curl -sS -X POST "${BASE}/oauth/device/verify" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "user_code=${USER_CODE}" \
      --data-urlencode "decision=approve" \
      | save device-approved.html
    curl -sS -X POST "${BASE}/oauth/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
      --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "device_code=${DEVICE_CODE}" \
      | save device-token.json
    ACCESS="$(node -e "const t=JSON.parse(require('fs').readFileSync('${OUT}/device-token.json','utf8')); if(!t.access_token) { console.error(t); process.exit(1);} process.stdout.write(t.access_token);")"
    mcp_call allow "${ACCESS}" "${ENCODE_BODY}"
    node -e "
      const body=require('fs').readFileSync('${OUT}/allow.json','utf8');
      if (!body.includes('${EXPECTED_CALLDATA}')) { console.error('drive: device-flow missing calldata', body.slice(0,500)); process.exit(1); }
      const fs=require('fs');
      const dev=JSON.parse(fs.readFileSync('${OUT}/device.json','utf8'));
      if (!dev.user_code || !dev.device_code || !dev.verification_uri) { console.error('drive: device start missing fields'); process.exit(1); }
      if (!fs.readFileSync('${OUT}/device-approved.html','utf8').includes('Device authorized')) { console.error('drive: device approval page missing Device authorized'); process.exit(1); }
      if (JSON.parse(fs.readFileSync('${OUT}/device-token.json','utf8')).token_type !== 'Bearer') { console.error('drive: device token_type not Bearer'); process.exit(1); }
      console.log('drive device-flow: allow encode_function_data ok');
    "
    ;;

  jwt-access-tokens)
    ACCESS="$(device_token jwt kaia:encode)"
    curl -sS "${BASE}/.well-known/openid-configuration" | save discovery.json
    JWKS_URI="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).jwks_uri)" "${OUT}/discovery.json")"
    curl -sS "${JWKS_URI}" | save jwks.json
    curl -sS "${BASE}/.well-known/kaia-mcp/tool-scopes" | save tool-scopes.json
    # Offline verification with nothing but the published JWKS (no kaia-mcp code).
    node -e "
      const fs=require('fs'), c=require('crypto');
      const [tokFile, jwksFile, issuer, ttl, outFile] = process.argv.slice(1);
      const fail=(m)=>{ console.error('drive: '+m); process.exit(1); };
      const tok=JSON.parse(fs.readFileSync(tokFile,'utf8')).access_token;
      const [h,p,sig]=tok.split('.');
      const header=JSON.parse(Buffer.from(h,'base64url')), claims=JSON.parse(Buffer.from(p,'base64url'));
      const key=JSON.parse(fs.readFileSync(jwksFile,'utf8')).keys.find(k=>k.kid===header.kid);
      if (header.alg!=='RS256' || header.typ!=='at+jwt' || !key) fail('header/kid mismatch '+JSON.stringify(header));
      if (!c.verify('sha256', Buffer.from(h+'.'+p), c.createPublicKey({key, format:'jwk'}), Buffer.from(sig,'base64url'))) fail('signature does not verify against JWKS');
      for (const k of ['iss','aud','sub','scope','exp','nbf','iat','jti','client_id']) if (!(k in claims)) fail('missing claim '+k);
      if (claims.iss!==issuer || claims.aud!==issuer || claims.scope!=='kaia:encode') fail('claims wrong '+JSON.stringify({iss:claims.iss,aud:claims.aud,scope:claims.scope}));
      if (claims.exp-claims.iat!==Number(ttl)) fail('exp-iat '+(claims.exp-claims.iat)+' != ttl '+ttl);
      fs.writeFileSync(outFile, JSON.stringify({header, claims}, null, 2));
    " "${OUT}/jwt.token.json" "${OUT}/jwks.json" "${BASE}" "$(node -e "process.stdout.write(String(require(process.argv[1]).tokenTtlSeconds))" "${INSTANCE_FILE}")" "${OUT}/decoded.json"
    BEFORE="$(tool_call_count encode_function_data)"
    ALLOWED_BEFORE="$(tool_call_outcome_count encode_function_data allowed)"
    mcp_call allow "${ACCESS}" "${ENCODE_BODY}"
    AFTER="$(tool_call_count encode_function_data)"
    ALLOWED_AFTER="$(tool_call_outcome_count encode_function_data allowed)"
    echo "{\"before\":${BEFORE},\"after\":${AFTER},\"allowedBefore\":${ALLOWED_BEFORE},\"allowedAfter\":${ALLOWED_AFTER}}" | save tool-call-log-count.json
    # Forged: same claims and the real kid, signed by a key kaia-mcp never issued.
    FORGED="$(node -e "
      const c=require('crypto'); const [h,p]=process.argv[1].split('.');
      const {privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});
      process.stdout.write(h+'.'+p+'.'+c.sign('sha256',Buffer.from(h+'.'+p),privateKey).toString('base64url'));
    " "${ACCESS}")"
    echo "{\"access_token\":\"${FORGED}\"}" | save forged.token.json
    mcp_init_only forged "${FORGED}"
    NONE_TOKEN="$(node -e "const [h,p]=process.argv[1].split('.'); const hd=JSON.parse(Buffer.from(h,'base64url')); hd.alg='none'; process.stdout.write(Buffer.from(JSON.stringify(hd)).toString('base64url')+'.'+p+'.')" "${ACCESS}")"
    mcp_init_only alg-none "${NONE_TOKEN}"
    # Expiry: wait out the short launch TTL, then reuse the same bearer.
    WAIT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).claims; process.stdout.write(String(Math.max(0, c.exp - Math.floor(Date.now()/1000)) + 2))" "${OUT}/decoded.json")"
    echo "drive jwt-access-tokens: waiting ${WAIT}s for the access token to expire"
    sleep "${WAIT}"
    mcp_init_only expired "${ACCESS}"
    node -e "
      const fs=require('fs'); const r=(f)=>fs.readFileSync('${OUT}/'+f,'utf8');
      const fail=(m)=>{ console.error('drive: '+m); process.exit(1); };
      if (!r('allow.json').includes('${EXPECTED_CALLDATA}')) fail('allowed call missing calldata');
      const n=JSON.parse(r('tool-call-log-count.json')); if (n.after!==n.before+1 || n.allowedAfter!==n.allowedBefore+1) fail('expected exactly one new outcome=allowed Tool call log line, got '+JSON.stringify(n));
      for (const f of ['forged','alg-none']) {
        if (!/^HTTP\/1\.1 401/m.test(r(f+'.headers'))) fail(f+' not 401');
        const e=JSON.parse(r(f+'.json')).error; if (e.code!==-32043 || e.data.error!=='invalid_token') fail(f+' wrong error '+JSON.stringify(e));
      }
      if (!/^HTTP\/1\.1 401/m.test(r('expired.headers'))) fail('expired not 401');
      const ex=JSON.parse(r('expired.json')).error; if (ex.code!==-32041 || ex.message!=='token_expired: access token has expired') fail('expired wrong error '+JSON.stringify(ex));
      const ts=JSON.parse(r('tool-scopes.json'));
      if (Object.keys(ts.tool_scopes).length!==26 || ts.tool_scopes.encode_function_data!=='kaia:encode' || ts.tool_scopes.generate_wallet!=='kaia:wallet' || ts.tool_scopes.get_block_number!=='kaia:read') fail('tool-scopes map wrong');
      console.log('drive jwt-access-tokens: JWT verifies offline via JWKS; allowed call logged once (outcome=allowed); forged + alg=none -> invalid_token; expired -> token_expired; tool-scopes map ok');
    "
    ;;

  token-introspection)
    ACCESS="$(device_token live kaia:read)"
    introspect anon "${ACCESS}" none
    introspect wrong-secret "${ACCESS}" wrong
    introspect active "${ACCESS}" gateway
    curl -sS -o "${OUT}/revoke.json" -X POST "${BASE}/oauth/revoke" \
      -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "token=${ACCESS}"
    introspect revoked "${ACCESS}" gateway
    mcp_init_only revoked-mcp "${ACCESS}"
    # Refresh rotation retires the previous access jti.
    OLD_ACCESS="$(device_token rot kaia:read)"
    REFRESH="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).refresh_token)" "${OUT}/rot.token.json")"
    curl -sS -X POST "${BASE}/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=refresh_token" --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "refresh_token=${REFRESH}" | save rotated.token.json
    NEW_ACCESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).access_token)" "${OUT}/rotated.token.json")"
    introspect rotated-old "${OLD_ACCESS}" gateway
    introspect rotated-new "${NEW_ACCESS}" gateway
    # Refresh tokens are introspectable too (token_type refresh_token).
    NEW_REFRESH="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).refresh_token)" "${OUT}/rotated.token.json")"
    introspect refresh-old "${REFRESH}" gateway refresh_token
    introspect refresh-active "${NEW_REFRESH}" gateway refresh_token
    introspect refresh-active-nohint "${NEW_REFRESH}" gateway
    curl -sS -o "${OUT}/revoke-refresh.json" -X POST "${BASE}/oauth/revoke" \
      -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "token=${NEW_REFRESH}"
    introspect refresh-revoked "${NEW_REFRESH}" gateway refresh_token
    node -e "
      const fs=require('fs'); const r=(f)=>fs.readFileSync('${OUT}/'+f,'utf8');
      const fail=(m)=>{ console.error('drive: '+m); process.exit(1); };
      const jti=(t)=>JSON.parse(Buffer.from(t.split('.')[1],'base64url')).jti;
      for (const f of ['anon','wrong-secret']) {
        if (!/^HTTP\/1\.1 401/m.test(r(f+'.headers')) || JSON.parse(r(f+'.json')).error!=='invalid_client') fail(f+' introspection was not rejected');
      }
      if (!/www-authenticate: Basic/i.test(r('anon.headers'))) fail('missing WWW-Authenticate: Basic');
      const a=JSON.parse(r('active.json'));
      if (a.active!==true || a.scope!=='kaia:read' || a.aud!=='${BASE}' || a.jti!==jti('${ACCESS}')) fail('active introspection wrong '+JSON.stringify(a));
      if (r('active.json').includes('${ACCESS}')) fail('introspection echoed the token');
      if (JSON.stringify(JSON.parse(r('revoked.json')))!=='{\"active\":false}') fail('revoked token still active');
      const m=JSON.parse(r('revoked-mcp.json')).error; if (m.code!==-32043) fail('revoked bearer reached MCP '+JSON.stringify(m));
      if (JSON.parse(r('rotated-old.json')).active!==false) fail('old access token active after refresh rotation');
      if (JSON.parse(r('rotated-new.json')).active!==true) fail('rotated access token inactive');
      for (const f of ['refresh-active','refresh-active-nohint']) {
        const x=JSON.parse(r(f+'.json'));
        if (x.active!==true || x.token_type!=='refresh_token' || x.scope!=='kaia:read' || x.client_id!=='kaia-mcp-demo' || x.sub!=='demo-user' || x.iss!=='${BASE}' || typeof x.exp!=='number') fail(f+' wrong '+JSON.stringify(x));
        if (r(f+'.json').includes('${REFRESH}') || r(f+'.json').includes(JSON.parse(r('rotated.token.json')).refresh_token)) fail(f+' echoed the refresh token');
      }
      for (const f of ['refresh-old','refresh-revoked']) if (JSON.stringify(JSON.parse(r(f+'.json')))!=='{\"active\":false}') fail(f+' should be exactly {active:false}');
      console.log('drive token-introspection: unauthenticated/wrong secret -> 401 invalid_client; active claims; revoke -> inactive + MCP invalid_token; refresh rotation retires old jti; refresh token active (token_type refresh_token) until rotated/revoked');
    "
    ;;

  revocation-restart)
    # Restarts this run's instance on the same port (helpers/restart.sh) and restores the
    # launch key mode at the end. Phase 1: persisted key -> revoked tokens stay revoked.
    # Phase 2: corrupt denylist -> refuses to start. Phase 3: in-memory key -> a restart
    # invalidates every token.
    "${HELPERS_DIR}/restart.sh" file | save restart-1-file.txt
    "${HELPERS_DIR}/doctor.sh" | save doctor-1.txt
    curl -sS "${BASE}/oauth/jwks" | save jwks-a.json
    KEPT="$(device_token kept kaia:encode)"
    REVOKED="$(device_token revoked kaia:read)"
    REFRESH_ACCESS="$(device_token refreshed kaia:read)"
    REFRESH="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).refresh_token)" "${OUT}/refreshed.token.json")"
    echo "{\"access\":$(revoke_status revoke-access "${REVOKED}"),\"refresh\":$(revoke_status revoke-refresh "${REFRESH}")}" | save revoke-status.json
    mcp_init_only revoked-before "${REVOKED}"
    STATE_DIR="$(dirname "$(inst logFile)")/state"
    cp "${STATE_DIR}/revoked-jti.json" "${OUT}/denylist.json"
    stat -c '%a' "${STATE_DIR}/revoked-jti.json" | save denylist.mode.txt
    "${HELPERS_DIR}/restart.sh" file | save restart-2-file.txt
    "${HELPERS_DIR}/doctor.sh" | save doctor-2.txt
    curl -sS "${BASE}/oauth/jwks" | save jwks-b.json
    mcp_call kept-after "${KEPT}" "${ENCODE_BODY}"
    mcp_init_only revoked-after "${REVOKED}"
    mcp_init_only refreshed-access-after "${REFRESH_ACCESS}"
    introspect revoked-after-introspect "${REVOKED}" gateway
    introspect kept-after-introspect "${KEPT}" gateway
    curl -sS -X POST "${BASE}/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=refresh_token" --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "refresh_token=${REFRESH}" | save refresh-after.json

    # A refresh rotation whose revocation cannot be persisted: 503 with no path, the refresh
    # token is not consumed, and the retry succeeds once the store is writable again.
    # (root ignores directory permissions, so this phase records itself as skipped there.)
    ROT_ACCESS="$(device_token rotate kaia:read)"
    ROT_REFRESH="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).refresh_token)" "${OUT}/rotate.token.json")"
    if [[ "$(id -u)" != "0" ]]; then
      chmod 500 "${STATE_DIR}"
      curl -sS -D "${OUT}/rotate-broken.headers" -o "${OUT}/rotate-broken.json" -X POST "${BASE}/oauth/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "grant_type=refresh_token" --data-urlencode "client_id=kaia-mcp-demo" \
        --data-urlencode "refresh_token=${ROT_REFRESH}" || true
      mcp_init_only rotate-old-access-denied "${ROT_ACCESS}"
      chmod 700 "${STATE_DIR}"
      curl -sS -D "${OUT}/rotate-retry.headers" -o "${OUT}/rotate-retry.json" -X POST "${BASE}/oauth/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "grant_type=refresh_token" --data-urlencode "client_id=kaia-mcp-demo" \
        --data-urlencode "refresh_token=${ROT_REFRESH}" || true
      echo '{"skipped":false}' | save rotate-phase.json
    else
      echo '{"skipped":true,"reason":"running as root"}' | save rotate-phase.json
    fi

    # A denylist writable by group/others must stop startup too.
    INSECURE_DIR="$(dirname "$(inst logFile)")/insecure"
    mkdir -p "${INSECURE_DIR}"
    cp "${STATE_DIR}/signing-key.pem" "${INSECURE_DIR}/signing-key.pem"
    printf '{"version":1,"entries":[]}' > "${INSECURE_DIR}/revoked-jti.json"
    chmod 666 "${INSECURE_DIR}/revoked-jti.json"
    IPORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
    set +e
    (
      set -a
      # shellcheck disable=SC1091
      source "$(dirname "$(inst logFile)")/server.env"
      set +a
      export KAIA_OAUTH_SIGNING_KEY_FILE="${INSECURE_DIR}/signing-key.pem" LOG_LEVEL=info
      cd "${REPO_ROOT}"
      timeout 20 node dist/bin/kaia-mcp.js --transport http --port "${IPORT}"
    ) >"${OUT}/insecure-start.log" 2>&1
    INSECURE_EXIT=$?
    set -e
    INSECURE_LISTENING=false
    if curl -s -o /dev/null "http://127.0.0.1:${IPORT}/health"; then INSECURE_LISTENING=true; fi
    echo "{\"exit\":${INSECURE_EXIT},\"listening\":${INSECURE_LISTENING}}" | save insecure-start.json

    # A symlinked or FIFO denylist must stop startup (no hang, no following the link).
    for kind in symlink fifo; do
      SDIR="$(dirname "$(inst logFile)")/${kind}"
      mkdir -p "${SDIR}"
      cp "${STATE_DIR}/signing-key.pem" "${SDIR}/signing-key.pem"
      if [[ "${kind}" == "symlink" ]]; then
        printf '{"version":1,"entries":[]}' > "${SDIR}/real.json"
        chmod 600 "${SDIR}/real.json"
        ln -s "${SDIR}/real.json" "${SDIR}/revoked-jti.json"
      else
        mkfifo -m 600 "${SDIR}/revoked-jti.json"
      fi
      SPORT="$(free_port)"
      set +e
      (
        set -a
        # shellcheck disable=SC1091
        source "$(dirname "$(inst logFile)")/server.env"
        set +a
        export KAIA_OAUTH_SIGNING_KEY_FILE="${SDIR}/signing-key.pem" LOG_LEVEL=info
        cd "${REPO_ROOT}"
        timeout 20 node dist/bin/kaia-mcp.js --transport http --port "${SPORT}"
      ) >"${OUT}/${kind}-start.log" 2>&1
      SEXIT=$?
      set -e
      SLISTEN=false
      if curl -s -o /dev/null "http://127.0.0.1:${SPORT}/health"; then SLISTEN=true; fi
      echo "{\"exit\":${SEXIT},\"listening\":${SLISTEN}}" | save "${kind}-start.json"
    done

    # A corrupt denylist next to a persisted key must stop startup, not start empty.
    CORRUPT_DIR="$(dirname "$(inst logFile)")/corrupt"
    mkdir -p "${CORRUPT_DIR}"
    cp "${STATE_DIR}/signing-key.pem" "${CORRUPT_DIR}/signing-key.pem"
    printf '{"version":1,"entries":[{"id":' > "${CORRUPT_DIR}/revoked-jti.json"
    CPORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
    set +e
    (
      set -a
      # shellcheck disable=SC1091
      source "$(dirname "$(inst logFile)")/server.env"
      set +a
      export KAIA_OAUTH_SIGNING_KEY_FILE="${CORRUPT_DIR}/signing-key.pem" LOG_LEVEL=info
      cd "${REPO_ROOT}"
      timeout 20 node dist/bin/kaia-mcp.js --transport http --port "${CPORT}"
    ) >"${OUT}/corrupt-start.log" 2>&1
    CORRUPT_EXIT=$?
    set -e
    CORRUPT_LISTENING=false
    if curl -s -o /dev/null "http://127.0.0.1:${CPORT}/health"; then CORRUPT_LISTENING=true; fi
    echo "{\"exit\":${CORRUPT_EXIT},\"listening\":${CORRUPT_LISTENING}}" | save corrupt-start.json

    # In-memory key: the restart mints a new key, so even the never-revoked token dies.
    "${HELPERS_DIR}/restart.sh" memory | save restart-3-memory.txt
    "${HELPERS_DIR}/doctor.sh" | save doctor-3.txt
    curl -sS "${BASE}/oauth/jwks" | save jwks-c.json
    mcp_init_only kept-after-memory "${KEPT}"
    mcp_init_only revoked-after-memory "${REVOKED}"

    # Back to the launch mode so later drives see the baseline.
    "${HELPERS_DIR}/restart.sh" "$(inst launchKeyMode)" | save restart-4-restore.txt
    "${HELPERS_DIR}/doctor.sh" | save doctor-4.txt
    node -e "
      const fs=require('fs'); const r=(f)=>fs.readFileSync('${OUT}/'+f,'utf8');
      const fail=(m)=>{ console.error('drive: '+m); process.exit(1); };
      const jti=(t)=>JSON.parse(Buffer.from(t.split('.')[1],'base64url')).jti;
      const kid=(f)=>JSON.parse(r(f)).keys[0].kid;
      const st=JSON.parse(r('revoke-status.json')); if (st.access!==200 || st.refresh!==200) fail('revoke status '+JSON.stringify(st));
      if (JSON.parse(r('revoked-before.json')).error.code!==-32043) fail('revoked token accepted before restart');
      const dl=JSON.parse(r('denylist.json'));
      const ids=(dl.entries||[]).map(e=>e.id);
      if (dl.version!==1 || !ids.includes(jti('${REVOKED}')) || !ids.includes(jti('${REFRESH_ACCESS}'))) fail('denylist missing jtis '+JSON.stringify(dl));
      if (ids.includes(jti('${KEPT}'))) fail('denylist contains an unrevoked jti');
      if (/eyJ/.test(r('denylist.json')) || r('denylist.json').includes('${REFRESH}')) fail('denylist contains token material');
      if (r('denylist.mode.txt').trim()!=='600') fail('denylist mode '+r('denylist.mode.txt'));
      if (kid('jwks-a.json')!==kid('jwks-b.json')) fail('file-mode restart changed the kid');
      if (!r('kept-after.json').includes('${EXPECTED_CALLDATA}')) fail('unrevoked token did not work after file-mode restart');
      for (const f of ['revoked-after','refreshed-access-after']) {
        if (!/^HTTP\/1\.1 401/m.test(r(f+'.headers'))) fail(f+' not 401');
        const e=JSON.parse(r(f+'.json')).error; if (e.code!==-32043 || e.message!=='invalid_token: access token is invalid or revoked') fail(f+' wrong '+JSON.stringify(e));
      }
      if (JSON.stringify(JSON.parse(r('revoked-after-introspect.json')))!=='{\"active\":false}') fail('revoked token active in introspection after restart');
      if (JSON.parse(r('kept-after-introspect.json')).active!==true) fail('kept token inactive after restart');
      if (JSON.parse(r('refresh-after.json')).error!=='invalid_grant') fail('refresh token survived restart '+r('refresh-after.json'));
      const c=JSON.parse(r('corrupt-start.json'));
      if (c.exit===0 || c.exit===124 || c.listening) fail('corrupt denylist did not refuse startup '+JSON.stringify(c));
      if (!/revocation store .* is corrupt/.test(r('corrupt-start.log'))) fail('corrupt start log missing reason');
      if (!JSON.parse(r('rotate-phase.json')).skipped) {
        if (!/^HTTP\/1\.1 503/m.test(r('rotate-broken.headers'))) fail('rotation with unwritable store not 503');
        if (JSON.stringify(JSON.parse(r('rotate-broken.json')))!==JSON.stringify({error:'server_error',error_description:'revocation could not be persisted'})) fail('rotation 503 body '+r('rotate-broken.json'));
        if (r('rotate-broken.json').includes('/')) fail('rotation error leaks a path');
        if (JSON.parse(r('rotate-old-access-denied.json')).error.code!==-32043) fail('old access token not denied in-process after failed rotation');
        if (!/^HTTP\/1\.1 200/m.test(r('rotate-retry.headers')) || !JSON.parse(r('rotate-retry.json')).access_token) fail('rotation retry did not succeed '+r('rotate-retry.json'));
      }
      const ins=JSON.parse(r('insecure-start.json'));
      if (ins.exit===0 || ins.exit===124 || ins.listening) fail('insecure denylist did not refuse startup '+JSON.stringify(ins));
      if (!/revocation store .* is insecure: writable by group or others/.test(r('insecure-start.log'))) fail('insecure start log missing reason');
      for (const [k, re] of [['symlink', /refusing to follow a symlink/], ['fifo', /not a regular file/]]) {
        const s=JSON.parse(r(k+'-start.json'));
        if (s.exit===0 || s.exit===124 || s.listening) fail(k+' denylist did not refuse startup (124 = hung) '+JSON.stringify(s));
        if (!re.test(r(k+'-start.log'))) fail(k+' start log missing reason');
      }
      if (kid('jwks-c.json')===kid('jwks-b.json')) fail('memory-mode restart kept the kid');
      for (const f of ['kept-after-memory','revoked-after-memory']) {
        if (!/^HTTP\/1\.1 401/m.test(r(f+'.headers')) || JSON.parse(r(f+'.json')).error.code!==-32043) fail(f+' should be invalid_token after memory restart');
      }
      console.log('drive revocation-restart: file key -> revoked access + refresh-linked jti stay invalid_token after restart, unrevoked token still allowed, introspection inactive, refresh token invalid_grant; unwritable store -> rotation 503 (no path), refresh not consumed, retry 200; corrupt, group/world-writable, symlinked and FIFO denylists refuse startup (no hang); memory key -> restart invalidates every token');
    "
    ;;

  stateless-transport)
    # MCP 2026-07-28 Streamable HTTP: POST only, no sessions, Origin validated (403).
    ACCESS="$(device_token st kaia:read)"
    LIST_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    for m in GET DELETE; do
      curl -sS -D "${OUT}/${m,,}.headers" -o "${OUT}/${m,,}.json" -X "${m}" "${BASE}/" \
        -H "Authorization: Bearer ${ACCESS}" -H "Accept: application/json, text/event-stream" || true
    done
    # No initialize: tools/list is answered on its own. Then initialize, which mints no session.
    mcp_call list-no-init "${ACCESS}" "${LIST_BODY}"
    mcp_call init "${ACCESS}" "${mcp_init}"
    # A legacy client's stale session header is ignored, not 404.
    curl -sS -D "${OUT}/stale-session.headers" -o "${OUT}/stale-session.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Mcp-Session-Id: not-a-session" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "${LIST_BODY}"
    # Origin: foreign -> 403 before auth and handlers; own origin -> echoed CORS; none -> allowed.
    CALLS_BEFORE="$(tool_call_count get_block_number)"
    curl -sS -D "${OUT}/origin-evil.headers" -o "${OUT}/origin-evil.json" -X POST "${BASE}/" \
      -H "Origin: https://evil.example" -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_block_number","arguments":{}}}' || true
    curl -sS -D "${OUT}/origin-evil-token.headers" -o "${OUT}/origin-evil-token.json" -X POST "${BASE}/oauth/token" \
      -H "Origin: https://evil.example" -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=refresh_token" --data-urlencode "client_id=kaia-mcp-demo" --data-urlencode "refresh_token=x" || true
    curl -sS -D "${OUT}/origin-self.headers" -o "${OUT}/origin-self.json" -X POST "${BASE}/" \
      -H "Origin: ${BASE}" -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "${LIST_BODY}"
    curl -sS -D "${OUT}/preflight.headers" -o /dev/null -X OPTIONS "${BASE}/" \
      -H "Origin: ${BASE}" -H "Access-Control-Request-Method: POST" \
      -H "Access-Control-Request-Headers: authorization, content-type, mcp-protocol-version, mcp-method, mcp-name" || true
    curl -sS -D "${OUT}/jwks-evil-origin.headers" -o "${OUT}/jwks-evil-origin.json" -H "Origin: https://evil.example" "${BASE}/oauth/jwks"
    # Body handling before the MCP server runs: not JSON -> 400 -32700; over 4 MB -> 413 -32600.
    curl -sS -D "${OUT}/bad-json.headers" -o "${OUT}/bad-json.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":' || true
    head -c $((4 * 1024 * 1024 + 16)) /dev/zero | tr '\0' ' ' >"${OUT}/.big-body.tmp"
    # --next sends a second request that reuses the connection when the server allows it:
    # after a 413 the server must close it (Connection: close), never leave it unread.
    curl -sS --max-time 10 -D "${OUT}/too-large.headers" -o "${OUT}/too-large.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" -H "Expect:" --data-binary "@${OUT}/.big-body.tmp" \
      --next -sS --max-time 5 -D "${OUT}/after-too-large.headers" -o "${OUT}/after-too-large.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":11,"method":"tools/list","params":{}}' || true
    touch "${OUT}/after-too-large.headers"
    rm -f "${OUT}/.big-body.tmp"
    echo "{\"before\":${CALLS_BEFORE},\"after\":$(tool_call_count get_block_number)}" | save tool-call-count.json
    OUT="${OUT}" BASE="${BASE}" node - <<'JS'
const fs = require("fs"); const r = (f) => fs.readFileSync(process.env.OUT + "/" + f, "utf8");
const fail = (m) => { console.error("drive: " + m); process.exit(1); };
const status = (f) => Number((r(f).match(/^HTTP\/1\.1 (\d{3})/m) || [])[1]);
const header = (f, h) => ((r(f).match(new RegExp("^" + h + ":\\s*(.*)$", "im")) || [])[1] || "").trim();
for (const m of ["get", "delete"]) {
  if (status(m + ".headers") !== 405 || header(m + ".headers", "allow") !== "POST") fail(m + " must be 405 with Allow: POST, got " + status(m + ".headers"));
  if (JSON.parse(r(m + ".json")).error.code !== -32000) fail(m + " body is not a JSON-RPC -32000 error");
}
if (status("list-no-init.headers") !== 200 || !r("list-no-init.json").includes("get_block_number")) fail("tools/list without initialize did not answer");
if (r("list-no-init.json").includes("encode_function_data")) fail("tools/list for a kaia:read token lists encode_function_data (must stay scope-filtered)");
if (status("init.headers") !== 200 || !r("init.json").includes("serverInfo")) fail("initialize failed");
if (status("stale-session.headers") !== 200 || /^mcp-session-id:/im.test(r("stale-session.headers"))) fail("a stale Mcp-Session-Id was not ignored");
if (status("origin-evil.headers") !== 403) fail("foreign Origin not 403: " + status("origin-evil.headers"));
if (r("origin-evil.json").trim() !== '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Forbidden: Origin not allowed"}}') fail("foreign Origin body " + r("origin-evil.json"));
if (header("origin-evil.headers", "access-control-allow-origin")) fail("foreign Origin got an ACAO header");
if (status("origin-evil-token.headers") !== 403) fail("foreign Origin on /oauth/token not 403");
const tc = JSON.parse(r("tool-call-count.json")); if (tc.after !== tc.before) fail("the foreign-Origin tools/call reached the tool");
if (status("origin-self.headers") !== 200 || header("origin-self.headers", "access-control-allow-origin") !== process.env.BASE || !/origin/i.test(header("origin-self.headers", "vary"))) fail("own Origin not echoed with Vary: Origin");
const ah = header("preflight.headers", "access-control-allow-headers");
for (const h of ["Authorization", "Content-Type", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"]) if (!ah.includes(h)) fail("preflight Allow-Headers missing " + h + ": " + ah);
if (/mcp-session-id/i.test(r("preflight.headers"))) fail("preflight still mentions Mcp-Session-Id");
if (header("preflight.headers", "access-control-allow-origin") === "*") fail("MCP endpoint CORS is *");
if (status("jwks-evil-origin.headers") !== 200 || header("jwks-evil-origin.headers", "access-control-allow-origin") !== "*") fail("public JWKS not readable cross-origin");
if (status("bad-json.headers") !== 400 || JSON.parse(r("bad-json.json")).error.code !== -32700) fail("non-JSON body not 400 -32700: " + r("bad-json.json"));
if (status("too-large.headers") !== 413 || JSON.parse(r("too-large.json")).error.code !== -32600) fail("oversized body not 413 -32600: " + r("too-large.json").slice(0, 200));
if (header("too-large.headers", "connection").toLowerCase() !== "close") fail("413 must close the connection (Connection: close), got " + header("too-large.headers", "connection"));
if (status("after-too-large.headers") !== 200) fail("the request after a 413 on the same curl handle did not answer 200 within 5s (connection left unread?)");
console.log("drive stateless-transport: non-JSON -> 400 -32700; >4 MB -> 413 -32600 + Connection: close, next request on the same handle 200; GET/DELETE -> 405 Allow: POST; tools/list without initialize ok (scope-filtered); no Mcp-Session-Id minted, stale one ignored; foreign Origin -> 403 (MCP + OAuth, tool never ran); own Origin echoed + Vary; preflight allows MCP-Protocol-Version/Mcp-Method/Mcp-Name; public JWKS ACAO *");
JS
    ;;

  bearer-challenges)
    # RFC 6750 / RFC 9728 challenges: 401 names the PRM and a scope; 403 for insufficient scope.
    curl -sS -D "${OUT}/no-token.headers" -o "${OUT}/no-token.json" -X POST "${BASE}/" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "${mcp_init}" || true
    curl -sS -D "${OUT}/bad-token.headers" -o "${OUT}/bad-token.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer not-a-jwt" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "${mcp_init}" || true
    ACCESS="$(device_token read kaia:read)"
    DENIED_BEFORE="$(tool_call_outcome_count encode_function_data denied)"
    mcp_call insufficient "${ACCESS}" "${ENCODE_BODY/\"id\":1/\"id\":7}"
    DENIED_AFTER="$(tool_call_outcome_count encode_function_data denied)"
    echo "{\"before\":${DENIED_BEFORE},\"after\":${DENIED_AFTER}}" | save insufficient.tool-call-log-count.json
    mcp_call allowed-list "${ACCESS}" '{"jsonrpc":"2.0","id":8,"method":"tools/list","params":{}}'
    PRM_URL="$(OUT="${OUT}" node -e "const t=require('fs').readFileSync(process.env.OUT+'/no-token.headers','utf8'); const m=t.match(/resource_metadata=\"([^\"]+)\"/); process.stdout.write(m?m[1]:'')")"
    if [[ -n "${PRM_URL}" ]]; then curl -sS "${PRM_URL}" | save prm.json; else echo '{}' | save prm.json; fi
    OUT="${OUT}" BASE="${BASE}" EXPECTED_CALLDATA="${EXPECTED_CALLDATA}" node - <<'JS'
const fs = require("fs"); const r = (f) => fs.readFileSync(process.env.OUT + "/" + f, "utf8");
const fail = (m) => { console.error("drive: " + m); process.exit(1); };
const B = process.env.BASE, PRM = B + "/.well-known/oauth-protected-resource";
const status = (f) => Number((r(f).match(/^HTTP\/1\.1 (\d{3})/m) || [])[1]);
const www = (f) => ((r(f).match(/^www-authenticate:\s*(.*)$/im) || [])[1] || "").trim();
const n = www("no-token.headers");
if (status("no-token.headers") !== 401 || !n.startsWith("Bearer ") || !n.includes('resource_metadata="' + PRM + '"') || !n.includes('scope="kaia:read"') || /error=/.test(n)) fail("no-credential 401 challenge wrong: " + n);
if (JSON.parse(r("no-token.json")).error.code !== -32040) fail("no-credential body not -32040");
const b = www("bad-token.headers");
if (status("bad-token.headers") !== 401 || !b.includes('error="invalid_token"') || !b.includes('resource_metadata="' + PRM + '"')) fail("bad-token 401 challenge wrong: " + b);
if (JSON.parse(r("bad-token.json")).error.code !== -32043) fail("bad-token body not -32043");
const i = www("insufficient.headers");
if (status("insufficient.headers") !== 403) fail("insufficient scope not HTTP 403: " + status("insufficient.headers"));
for (const p of ['error="insufficient_scope"', 'scope="kaia:encode"', 'resource_metadata="' + PRM + '"']) if (!i.includes(p)) fail("403 challenge missing " + p + ": " + i);
const body = JSON.parse(r("insufficient.json"));
if (body.id !== 7 || body.error.code !== -32042 || body.error.data.error !== "insufficient_scope") fail("403 body is not the JSON-RPC -32042 error for id 7: " + r("insufficient.json"));
if (r("insufficient.json").includes(process.env.EXPECTED_CALLDATA)) fail("denied call returned calldata");
const c = JSON.parse(r("insufficient.tool-call-log-count.json")); if (c.after !== c.before + 1) fail("expected one outcome=denied Tool call line " + JSON.stringify(c));
if (status("allowed-list.headers") !== 200) fail("same token could not list tools");
const prm = JSON.parse(r("prm.json")); if (prm.resource !== B) fail("resource_metadata URL does not serve PRM with resource=" + B + ": " + r("prm.json"));
console.log("drive bearer-challenges: 401 no-credential challenge (resource_metadata + scope, no error); 401 invalid_token challenge; insufficient scope -> 403 Bearer error=insufficient_scope scope=kaia:encode resource_metadata, body JSON-RPC -32042 with id, one denied log line, no calldata; resource_metadata URL serves PRM");
JS
    ;;

  resource-indicators)
    # RFC 8707 resource, RFC 9207 iss, RFC 9728 PRM on the launched instance.
    curl -sS "${BASE}/.well-known/oauth-authorization-server" | save as-metadata.json
    curl -sS "${BASE}/.well-known/oauth-protected-resource" | save prm.json
    PKCE="$(pkce_json)"
    echo "${PKCE}" | save pkce.json
    CHALLENGE="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).challenge)" "${PKCE}")"
    VERIFIER="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).verifier)" "${PKCE}")"
    RES_ENC="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]+'/'))" "${BASE}")"
    AUTH_Q="client_id=kaia-mcp-demo&redirect_uri=http://127.0.0.1/callback&response_type=code&scope=kaia%3Aencode&code_challenge=${CHALLENGE}&code_challenge_method=S256"
    curl -sS "${BASE}/oauth/authorize?${AUTH_Q}&state=ri1&resource=${RES_ENC}" | save consent.html
    REQUEST_ID="$(node -e "const h=require('fs').readFileSync(process.argv[1],'utf8'); const m=h.match(/name=\"request_id\" value=\"([^\"]+)\"/); if(!m) process.exit(1); process.stdout.write(m[1]);" "${OUT}/consent.html")"
    curl -sS -D "${OUT}/consent.headers" -o /dev/null -X POST "${BASE}/oauth/consent" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "request_id=${REQUEST_ID}" --data-urlencode "decision=approve" --max-redirs 0 || true
    CODE="$(node -e "const t=require('fs').readFileSync(process.argv[1],'utf8'); const m=t.match(/location:\\s*(.+)/i); process.stdout.write(new URL(m[1].trim()).searchParams.get('code')||'')" "${OUT}/consent.headers")"
    echo "${CODE}" | save authorization.code.txt
    # Wrong resource at the token endpoint: invalid_target, and the code survives for the right one.
    curl -sS -D "${OUT}/token-wrong-resource.headers" -o "${OUT}/token-wrong-resource.json" -X POST "${BASE}/oauth/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=authorization_code" --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "code=${CODE}" --data-urlencode "code_verifier=${VERIFIER}" \
      --data-urlencode "redirect_uri=http://127.0.0.1/callback" --data-urlencode "resource=https://other.example" || true
    curl -sS -X POST "${BASE}/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=authorization_code" --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "code=${CODE}" --data-urlencode "code_verifier=${VERIFIER}" \
      --data-urlencode "redirect_uri=http://127.0.0.1/callback" --data-urlencode "resource=${BASE}" | save token.json
    ACCESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).access_token||'')" "${OUT}/token.json")"
    mcp_call allow "${ACCESS}" "${ENCODE_BODY}"
    # Wrong resource at authorize: redirect with invalid_target (+ iss), no consent page.
    curl -sS -D "${OUT}/authorize-wrong-resource.headers" -o "${OUT}/authorize-wrong-resource.body" --max-redirs 0 \
      "${BASE}/oauth/authorize?${AUTH_Q}&state=ri2&resource=https%3A%2F%2Fother.example" || true
    # Deny also carries iss.
    curl -sS "${BASE}/oauth/authorize?${AUTH_Q}&state=ri3" | save deny-consent.html
    DENY_ID="$(node -e "const h=require('fs').readFileSync(process.argv[1],'utf8'); const m=h.match(/name=\"request_id\" value=\"([^\"]+)\"/); process.stdout.write(m?m[1]:'')" "${OUT}/deny-consent.html")"
    curl -sS -D "${OUT}/deny.headers" -o /dev/null -X POST "${BASE}/oauth/consent" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "request_id=${DENY_ID}" --data-urlencode "decision=deny" --max-redirs 0 || true
    # Device flow: wrong resource refused; no resource defaults to this server.
    curl -sS -D "${OUT}/device-wrong-resource.headers" -o "${OUT}/device-wrong-resource.json" -X POST "${BASE}/oauth/device" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "client_id=kaia-mcp-demo" --data-urlencode "scope=kaia:read" --data-urlencode "resource=https://other.example" || true
    DEFAULT_ACCESS="$(device_token default-resource kaia:read)"
    node -e "const t=process.argv[1]; require('fs').writeFileSync(process.argv[2], JSON.stringify(JSON.parse(Buffer.from(t.split('.')[1],'base64url')),null,2))" "${DEFAULT_ACCESS}" "${OUT}/default-resource.claims.json"
    OUT="${OUT}" BASE="${BASE}" EXPECTED_CALLDATA="${EXPECTED_CALLDATA}" node - <<'JS'
const fs = require("fs"); const r = (f) => fs.readFileSync(process.env.OUT + "/" + f, "utf8");
const fail = (m) => { console.error("drive: " + m); process.exit(1); };
const B = process.env.BASE;
const status = (f) => Number((r(f).match(/^HTTP\/1\.1 (\d{3})/m) || [])[1]);
const loc = (f) => { const m = r(f).match(/^location:\s*(.+)$/im); if (!m) fail(f + " has no Location"); return new URL(m[1].trim()); };
const as = JSON.parse(r("as-metadata.json"));
if (as.issuer !== B || as.authorization_response_iss_parameter_supported !== true) fail("AS metadata issuer/iss support wrong " + JSON.stringify(as));
const prm = JSON.parse(r("prm.json"));
if (prm.resource !== B || JSON.stringify(prm.authorization_servers) !== JSON.stringify([B]) || "token_audience" in prm) fail("PRM wrong " + r("prm.json"));
const ok = loc("consent.headers");
if (!ok.searchParams.get("code") || ok.searchParams.get("iss") !== B || ok.searchParams.get("state") !== "ri1") fail("approve redirect lacks code/iss/state: " + ok);
if (status("token-wrong-resource.headers") !== 400 || JSON.parse(r("token-wrong-resource.json")).error !== "invalid_target") fail("token with foreign resource not 400 invalid_target: " + r("token-wrong-resource.json"));
const tok = JSON.parse(r("token.json")); if (!tok.access_token) fail("code did not survive the invalid_target attempt: " + r("token.json"));
const claims = JSON.parse(Buffer.from(tok.access_token.split(".")[1], "base64url"));
if (claims.aud !== B || claims.iss !== B) fail("aud/iss not the canonical URI: " + JSON.stringify({ aud: claims.aud, iss: claims.iss }));
if (!r("allow.json").includes(process.env.EXPECTED_CALLDATA)) fail("resource-bound token could not call encode_function_data");
const bad = loc("authorize-wrong-resource.headers");
if (bad.searchParams.get("error") !== "invalid_target" || bad.searchParams.get("iss") !== B || bad.searchParams.get("code")) fail("authorize with foreign resource: " + bad);
if (/Authorize kaia-mcp/.test(r("authorize-wrong-resource.body"))) fail("consent page shown for a foreign resource");
const deny = loc("deny.headers");
if (deny.searchParams.get("error") !== "access_denied" || deny.searchParams.get("iss") !== B) fail("deny redirect lacks iss: " + deny);
if (status("device-wrong-resource.headers") !== 400 || JSON.parse(r("device-wrong-resource.json")).error !== "invalid_target") fail("device with foreign resource not invalid_target");
if (JSON.parse(r("default-resource.claims.json")).aud !== B) fail("missing resource did not default to the canonical URI");
console.log("drive resource-indicators: AS metadata advertises iss parameter; PRM resource = issuer; resource (trailing slash) accepted, aud = iss = canonical URI; foreign resource -> invalid_target at token (code not burned), authorize (redirect + iss) and device; approve/deny redirects carry iss; missing resource defaults to canonical");
JS
    ;;

  stateless-multi-instance)
    # Its own processes (not the launched one): A and B share a signing key and
    # KAIA_PUBLIC_URL; C rotated to a new key with A's key as previous; D shares the key
    # but has another public URL. All log into this run's server.log; cleanup.sh stops them.
    MDIR="$(dirname "$(inst logFile)")/multi"
    ( umask 077; mkdir -p "${MDIR}" )
    PUB="http://kaia-lb.test"
    PA="$(free_port)"
    APID="$(start_extra_kaia "${PA}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-a.json")"
    wait_ready "${PA}" "${APID}"
    PB="$(free_port)"
    BPID="$(start_extra_kaia "${PB}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-b.json" "KAIA_ALLOWED_ORIGINS=http://localhost:6274")"
    wait_ready "${PB}" "${BPID}"
    PC="$(free_port)"
    CPID="$(start_extra_kaia "${PC}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/rotated.pem" "KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-c.json")"
    wait_ready "${PC}" "${CPID}"
    PD="$(free_port)"
    DPID="$(start_extra_kaia "${PD}" "KAIA_PUBLIC_URL=http://kaia-other.test" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-d.json")"
    wait_ready "${PD}" "${DPID}"
    PE="$(free_port)"
    EPID="$(start_extra_kaia "${PE}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-e.json" "KAIA_OAUTH_LEGACY_AUDIENCE=kaia-mcp")"
    wait_ready "${PE}" "${EPID}"
    echo "{\"a\":${PA},\"b\":${PB},\"c\":${PC},\"d\":${PD},\"e\":${PE},\"publicUrl\":\"${PUB}\"}" | save ports.json
    A="http://127.0.0.1:${PA}" B="http://127.0.0.1:${PB}" C="http://127.0.0.1:${PC}" D="http://127.0.0.1:${PD}" E="http://127.0.0.1:${PE}"
    curl -sS "${A}/oauth/jwks" | save jwks-a.json
    curl -sS "${B}/oauth/jwks" | save jwks-b.json
    curl -sS "${C}/oauth/jwks" | save jwks-c.json
    curl -sS "${B}/health" | save health-b.json
    TOKEN_A="$(device_token on-a kaia:encode "${A}")"
    BEFORE="$(tool_call_outcome_count encode_function_data allowed)"
    mcp_call b-encode "${TOKEN_A}" "${ENCODE_BODY}" "${B}"
    mcp_call b-list "${TOKEN_A}" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "${B}"
    mcp_call c-encode "${TOKEN_A}" "${ENCODE_BODY}" "${C}"
    mcp_call d-encode "${TOKEN_A}" "${ENCODE_BODY}" "${D}"
    AFTER="$(tool_call_outcome_count encode_function_data allowed)"
    echo "{\"allowedBefore\":${BEFORE},\"allowedAfter\":${AFTER}}" | save tool-call-log-count.json
    TOKEN_C="$(device_token on-c kaia:read "${C}")"
    # Legacy audience (gateways pinning a non-URI aud): E mints [canonical, "kaia-mcp"]; B accepts it.
    TOKEN_E="$(device_token on-e kaia:read "${E}")"
    mcp_call b-token-from-e "${TOKEN_E}" '{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{}}' "${B}"
    # KAIA_ALLOWED_ORIGINS on B: the listed browser origin passes (echoed), others still 403.
    for o in allowed:http://localhost:6274 other:http://localhost:9999; do
      curl -sS -D "${OUT}/b-origin-${o%%:*}.headers" -o "${OUT}/b-origin-${o%%:*}.json" -X POST "${B}/" \
        -H "Origin: ${o#*:}" -H "Authorization: Bearer ${TOKEN_E}" -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}' || true
    done
    mcp_call b-token-from-c "${TOKEN_C}" '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' "${B}"
    # Audience rejection: tokens signed with the real shared key and the right iss, but an
    # aud other than the canonical URI. The array that also holds the canonical URI is the
    # positive control.
    KID="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).keys[0].kid)" "${OUT}/jwks-b.json")"
    for spec in 'legacy-only:"kaia-mcp"' 'other-uri:"https://other.example"' 'other-port:"http://kaia-lb.test:8443"' 'array-with-canonical:["http://kaia-lb.test","kaia-mcp"]'; do
      name="${spec%%:*}"; aud="${spec#*:}"
      node -e "
        const c=require('crypto'), fs=require('fs');
        const [pem, kid, src, aud, out]=process.argv.slice(1);
        const claims=JSON.parse(Buffer.from(src.split('.')[1],'base64url'));
        claims.aud=JSON.parse(aud); claims.jti=c.randomUUID();
        const b=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');
        const h=b({alg:'RS256',typ:'at+jwt',kid}), p=b(claims);
        const t=h+'.'+p+'.'+c.sign('sha256',Buffer.from(h+'.'+p),fs.readFileSync(pem,'utf8')).toString('base64url');
        fs.writeFileSync(out, JSON.stringify({access_token:t, aud:claims.aud}));
      " "${MDIR}/shared.pem" "${KID}" "${TOKEN_A}" "${aud}" "${OUT}/aud-${name}.token.json"
      T="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).access_token)" "${OUT}/aud-${name}.token.json")"
      mcp_call "aud-${name}" "${T}" '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}' "${B}"
    done
    # Per-process AS state today (documented): a refresh token from A is unknown on B, and
    # a revocation on A is not seen by B (each has its own denylist file).
    REFRESH_A="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).refresh_token)" "${OUT}/on-a.token.json")"
    curl -sS -X POST "${B}/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "grant_type=refresh_token" --data-urlencode "client_id=kaia-mcp-demo" \
      --data-urlencode "refresh_token=${REFRESH_A}" | save b-refresh-from-a.json
    curl -sS -o "${OUT}/a-revoke.json" -X POST "${A}/oauth/revoke" -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "token=${TOKEN_A}"
    mcp_call a-after-revoke "${TOKEN_A}" '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}' "${A}"
    mcp_call b-after-revoke-on-a "${TOKEN_A}" '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}' "${B}"
    # One denylist file per process, enforced. B revokes its own token; with distinct files
    # both revocations survive a restart of both processes.
    TOKEN_B="$(device_token on-b kaia:read "${B}")"
    curl -sS -o "${OUT}/b-revoke.json" -X POST "${B}/oauth/revoke" -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "token=${TOKEN_B}"
    ls -1 "${MDIR}" | grep -E '^revoked-[ab]\.json(\.lock)?$' | sort | save denylist-files-running.txt
    # Q points at A's file while A runs; G uses the default path (next to the shared key)
    # while F already does. Both must refuse to start, naming the file and the fix.
    refused_start() {
      local name="$1"
      shift
      local port code=0
      port="$(free_port)"
      (
        set -a
        # shellcheck disable=SC1091
        source "${INSTANCE_DIR}/server.env"
        set +a
        for kv in "$@"; do export "${kv?}"; done
        cd "${REPO_ROOT}"
        exec timeout 15 node dist/bin/kaia-mcp.js --transport http --port "${port}"
      ) >"${OUT}/${name}.log" 2>&1 || code=$?
      echo "{\"exitCode\":${code},\"port\":${port}}" | save "${name}.exit.json"
    }
    refused_start q-same-file-as-a "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-a.json"
    PF="$(free_port)"
    FPID="$(start_extra_kaia "${PF}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem")"
    wait_ready "${PF}" "${FPID}"
    refused_start g-default-path "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem"
    curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PF}/health" | save f-health-after-g.txt
    curl -sS -o /dev/null -w '%{http_code}' "${A}/health" | save a-health-after-q.txt
    # A crash (SIGKILL, no exit hooks) leaves the lock file; the next start takes it over.
    kill -9 "${FPID}" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "${FPID}" 2>/dev/null || break; sleep 0.1; done
    { [[ -f "${MDIR}/revoked-jti.json.lock" ]] && echo present || echo absent; } | save f-lock-after-crash.txt
    F2PID="$(start_extra_kaia "${PF}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem")"
    wait_ready "${PF}" "${F2PID}"
    curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PF}/health" | save f-health-after-crash-restart.txt
    stop_pid "${F2PID}"
    # Restart A and B on their ports (a clean stop releases each lock file).
    stop_pid "${APID}"
    stop_pid "${BPID}"
    ls -1 "${MDIR}" | grep -E '^revoked-[ab]\.json(\.lock)?$' | sort | save denylist-files-stopped.txt
    APID="$(start_extra_kaia "${PA}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-a.json")"
    wait_ready "${PA}" "${APID}"
    BPID="$(start_extra_kaia "${PB}" "KAIA_PUBLIC_URL=${PUB}" "KAIA_OAUTH_SIGNING_KEY_FILE=${MDIR}/shared.pem" "KAIA_OAUTH_REVOCATION_FILE=${MDIR}/revoked-b.json" "KAIA_ALLOWED_ORIGINS=http://localhost:6274")"
    wait_ready "${PB}" "${BPID}"
    mcp_call a-after-restart "${TOKEN_A}" '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}' "${A}"
    mcp_call b-after-restart "${TOKEN_B}" '{"jsonrpc":"2.0","id":8,"method":"tools/list","params":{}}' "${B}"
    cp "${MDIR}/revoked-a.json" "${OUT}/revoked-a.json"
    cp "${MDIR}/revoked-b.json" "${OUT}/revoked-b.json"
    for p in "${APID}" "${BPID}" "${CPID}" "${DPID}" "${EPID}"; do stop_pid "${p}"; done
    OUT="${OUT}" PUB="${PUB}" EXPECTED_CALLDATA="${EXPECTED_CALLDATA}" node - <<'JS'
const fs = require("fs"); const r = (f) => fs.readFileSync(process.env.OUT + "/" + f, "utf8");
const fail = (m) => { console.error("drive: " + m); process.exit(1); };
const status = (f) => Number((r(f).match(/^HTTP\/1\.1 (\d{3})/m) || [])[1]);
const PUB = process.env.PUB;
const kids = (x) => JSON.parse(r("jwks-" + x + ".json")).keys.map((k) => k.kid);
if (JSON.stringify(kids("a")) !== JSON.stringify(kids("b")) || kids("a").length !== 1) fail("A and B do not publish the same single key");
if (kids("c").length !== 2 || kids("c")[1] !== kids("a")[0] || kids("c")[0] === kids("a")[0]) fail("rotated C must publish [new, previous=shared]: " + kids("c"));
if (JSON.parse(r("health-b.json")).issuer !== PUB) fail("B issuer is not KAIA_PUBLIC_URL");
const claims = JSON.parse(Buffer.from(JSON.parse(r("on-a.token.json")).access_token.split(".")[1], "base64url"));
if (claims.iss !== PUB || claims.aud !== PUB) fail("token from A has iss/aud " + JSON.stringify({ iss: claims.iss, aud: claims.aud }));
if (status("b-encode.headers") !== 200 || !r("b-encode.json").includes(process.env.EXPECTED_CALLDATA)) fail("token minted on A was not accepted on B");
if (status("b-list.headers") !== 200 || !r("b-list.json").includes("encode_function_data")) fail("tools/list on B without initialize failed");
if (!r("c-encode.json").includes(process.env.EXPECTED_CALLDATA)) fail("rotated C did not accept a token signed by its previous key");
const n = JSON.parse(r("tool-call-log-count.json")); if (n.allowedAfter !== n.allowedBefore + 2) fail("expected two allowed encode calls (B and C) " + JSON.stringify(n));
if (status("d-encode.headers") !== 401 || JSON.parse(r("d-encode.json")).error.code !== -32043) fail("D (other public URL, same key) accepted A's token");
if (status("b-token-from-c.headers") !== 401) fail("B accepted a token signed by C's new key it does not know");
const eAud = JSON.parse(Buffer.from(JSON.parse(r("on-e.token.json")).access_token.split(".")[1], "base64url")).aud;
if (JSON.stringify(eAud) !== JSON.stringify([PUB, "kaia-mcp"])) fail("legacy-audience instance E minted aud " + JSON.stringify(eAud));
if (status("b-token-from-e.headers") !== 200) fail("B rejected E's [canonical, legacy] token");
if (status("b-origin-allowed.headers") !== 200 || !/^access-control-allow-origin: http:\/\/localhost:6274\s*$/im.test(r("b-origin-allowed.headers"))) fail("KAIA_ALLOWED_ORIGINS origin not allowed/echoed on B");
if (status("b-origin-other.headers") !== 403) fail("unlisted origin not 403 on B");
for (const f of ["aud-legacy-only", "aud-other-uri", "aud-other-port"]) {
  if (status(f + ".headers") !== 401 || JSON.parse(r(f + ".json")).error.code !== -32043) fail(f + " (wrong aud, valid signature) not rejected: " + r(f + ".json").slice(0, 200));
  if (!/error="invalid_token"/.test(r(f + ".headers"))) fail(f + " lacks the invalid_token challenge");
}
if (status("aud-array-with-canonical.headers") !== 200) fail("aud array containing the canonical URI was rejected (control)");
if (JSON.parse(r("b-refresh-from-a.json")).error !== "invalid_grant") fail("refresh token from A worked on B (state is documented as per-process)");
if (JSON.parse(r("a-after-revoke.json")).error.code !== -32043) fail("revoked token still works on A");
const bAfter = status("b-after-revoke-on-a.headers");
fs.writeFileSync(process.env.OUT + "/per-process-observation.json", JSON.stringify({ refreshFromAOnB: "invalid_grant", revokedOnA_statusOnB: bAfter }, null, 2));
if (bAfter !== 200) fail("B rejected a token revoked only on A; the docs say denylists are per process today, update them if this changed");
// One denylist file per process (enforced by a lock file held while the process runs).
if (r("denylist-files-running.txt").trim() !== "revoked-a.json\nrevoked-a.json.lock\nrevoked-b.json\nrevoked-b.json.lock") fail("running A/B must hold their denylist and lock files: " + r("denylist-files-running.txt"));
if (r("denylist-files-stopped.txt").trim() !== "revoked-a.json\nrevoked-b.json") fail("a clean stop must remove the lock files: " + r("denylist-files-stopped.txt"));
const jti = (f) => JSON.parse(Buffer.from(JSON.parse(r(f)).access_token.split(".")[1], "base64url")).jti;
for (const [name, file] of [["q-same-file-as-a", "revoked-a.json"], ["g-default-path", "revoked-jti.json"]]) {
  const exit = JSON.parse(r(name + ".exit.json")).exitCode;
  const log = r(name + ".log");
  if (exit === 0 || exit === 124) fail(name + " was not refused (exit " + exit + "): two processes on one denylist file");
  if (!log.includes("is in use by another kaia-mcp process") || !log.includes("/" + file) || !log.includes("KAIA_OAUTH_REVOCATION_FILE")) fail(name + " refusal does not name the file and the fix: " + log.slice(0, 400));
  if (log.includes("HTTP server listening")) fail(name + " bound its port before refusing");
}
if (r("a-health-after-q.txt") !== "200") fail("A stopped serving after Q was refused");
if (r("f-health-after-g.txt") !== "200") fail("F stopped serving after G was refused");
if (r("f-lock-after-crash.txt").trim() !== "present" || r("f-health-after-crash-restart.txt") !== "200") fail("a crashed holder's lock was not taken over on restart");
if (JSON.parse(r("b-revoke.json")) && Object.keys(JSON.parse(r("b-revoke.json"))).length !== 0) fail("revoke on B did not answer {}");
for (const [f, tok, file, other] of [["a-after-restart", "on-a.token.json", "revoked-a.json", "on-b.token.json"], ["b-after-restart", "on-b.token.json", "revoked-b.json", "on-a.token.json"]]) {
  if (status(f + ".headers") !== 401 || JSON.parse(r(f + ".json")).error.code !== -32043) fail(f + ": a revoked token works again after restart: " + r(f + ".json").slice(0, 200));
  const ids = JSON.parse(r(file)).entries.map((e) => e.id);
  if (!ids.includes(jti(tok))) fail(file + " lost its own revocation");
  if (ids.includes(jti(other))) fail(file + " holds the other instance's revocation (files are not distinct)");
}
console.log("drive stateless-multi-instance: one denylist per process enforced (Q on A's file and G on the default path refused with the file named and KAIA_OAUTH_REVOCATION_FILE advice, A and F kept serving; crashed F's lock taken over); with distinct files A's and B's revocations both survive a restart of both");
console.log("drive stateless-multi-instance: A and B share key + KAIA_PUBLIC_URL; token from A (iss = aud = public URL) works on B with no initialize and no session header; rotated C serves [new, previous] and accepts it; D (other public URL) rejects it; wrong-aud tokens with a valid signature (legacy-only, other URI, other port) -> 401 invalid_token, aud array with canonical accepted; legacy-audience E mints [canonical, kaia-mcp] and B accepts it; KAIA_ALLOWED_ORIGINS origin allowed on B, others 403; AS state + denylist per process (refresh from A invalid_grant on B; revoke on A not seen by B, as documented)");
JS
    ;;

  protocol-2026-07-28)
    # SDK v2: modern discover, HeaderMismatch -32020, tools/list cacheScope private, legacy init.
    ACCESS="$(device_token p2 kaia:encode)"
    DISCOVER_BODY='{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"verify-kaia-mcp","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
    LIST_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"verify-kaia-mcp","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
    curl -sS -D "${OUT}/discover.headers" -o "${OUT}/discover.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: server/discover" \
      -d "${DISCOVER_BODY}"
    if grep -qi '^mcp-session-id:' "${OUT}/discover.headers"; then
      echo "drive: discover response carries Mcp-Session-Id" >&2; exit 1
    fi
    curl -sS -D "${OUT}/mismatch.headers" -o "${OUT}/mismatch.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \
      -d "${DISCOVER_BODY}" || true
    curl -sS -D "${OUT}/missing-method.headers" -o "${OUT}/missing-method.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "MCP-Protocol-Version: 2026-07-28" \
      -d "${DISCOVER_BODY}" || true
    curl -sS -D "${OUT}/list.headers" -o "${OUT}/list.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \
      -d "${LIST_BODY}"
    mcp_call legacy-init "${ACCESS}" "${mcp_init}"
    OUT="${OUT}" node - <<'JS'
const fs = require("fs"); const r = (f) => fs.readFileSync(process.env.OUT + "/" + f, "utf8");
const fail = (m) => { console.error("drive: " + m); process.exit(1); };
const status = (f) => Number((r(f).match(/^HTTP\/1\.1 (\d{3})/m) || [])[1]);
const body = (f) => { const t = r(f); if (t.trim().startsWith("event:")) { const d = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean); return JSON.parse(d[d.length - 1]); } return JSON.parse(t); };
if (status("discover.headers") !== 200) fail("discover not 200: " + status("discover.headers"));
const disc = body("discover.json");
if (!Array.isArray(disc.result?.supportedVersions) || !disc.result.supportedVersions.includes("2026-07-28")) fail("discover missing 2026-07-28: " + r("discover.json").slice(0, 300));
if (status("mismatch.headers") !== 400 || body("mismatch.json").error?.code !== -32020) fail("method mismatch not 400 -32020: " + r("mismatch.json").slice(0, 300));
if (status("missing-method.headers") !== 400 || body("missing-method.json").error?.code !== -32020) fail("missing Mcp-Method not 400 -32020: " + r("missing-method.json").slice(0, 300));
if (status("list.headers") !== 200) fail("modern tools/list not 200");
const list = body("list.json").result;
if (list.cacheScope !== "private") fail("tools/list cacheScope must be private, got " + list.cacheScope);
if (list.ttlMs !== 0) fail("tools/list ttlMs must be 0 by default, got " + list.ttlMs);
const names = (list.tools || []).map((t) => t.name);
if (JSON.stringify(names) !== '["encode_function_data"]') fail("encode-only token listed " + JSON.stringify(names));
if (status("legacy-init.headers") !== 200 || !r("legacy-init.json").includes("serverInfo")) fail("legacy initialize failed");
console.log("drive protocol-2026-07-28: discover accepts 2026-07-28; HeaderMismatch -32020 on bad/missing Mcp-Method; tools/list cacheScope=private ttlMs=0 (scope-filtered); legacy initialize still works");
JS
    ;;


  *)
    echo "drive: unknown feature ${FEATURE}" >&2
    exit 2
    ;;
esac

echo "evidence written to ${OUT}"
echo "${OUT}" > "${EVIDENCE_DIR}/last-feature-path.txt"

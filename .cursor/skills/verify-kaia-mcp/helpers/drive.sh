#!/usr/bin/env bash
set -euo pipefail
# Drive one mapped feature against the launched instance.
# Usage: helpers/drive.sh <oauth-pkce-scoped-tools|fail-closed-auth|generate-wallet-gated|device-flow|jwt-access-tokens|token-introspection|revocation-restart>
# Writes evidence under ${EVIDENCE_DIR}/<feature>/ and does not delete it.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

FEATURE="${1:-}"
if [[ -z "${FEATURE}" ]]; then
  echo "Usage: helpers/drive.sh <oauth-pkce-scoped-tools|fail-closed-auth|generate-wallet-gated|device-flow|jwt-access-tokens|token-introspection|revocation-restart>" >&2
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

mcp_init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-kaia-mcp","version":"0"}}}'
MCP_INITIALIZED='{"jsonrpc":"2.0","method":"notifications/initialized"}'

# Real MCP client handshake, then one request on that session.
# Usage: mcp_call <evidence-prefix> <access-token> <json-body>
# Writes <prefix>.init.headers, <prefix>.init.json, <prefix>.headers, <prefix>.json.
# The server rejects tools/* without a prior initialize ("Server not initialized").
mcp_call() {
  local prefix="$1" access="$2" body="$3" sid
  curl -sS -D "${OUT}/${prefix}.init.headers" -o "${OUT}/${prefix}.init.json" -X POST "${BASE}/" \
    -H "Authorization: Bearer ${access}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${mcp_init}"
  sid="$(node -e "const t=require('fs').readFileSync(process.argv[1],'utf8'); const m=t.match(/^mcp-session-id:\\s*(\\S+)/im); if(!m){console.error('drive: initialize returned no Mcp-Session-Id'); process.exit(1);} process.stdout.write(m[1]);" "${OUT}/${prefix}.init.headers")"
  curl -sS -o /dev/null -X POST "${BASE}/" \
    -H "Authorization: Bearer ${access}" \
    -H "Mcp-Session-Id: ${sid}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${MCP_INITIALIZED}"
  curl -sS -D "${OUT}/${prefix}.headers" -o "${OUT}/${prefix}.json" -X POST "${BASE}/" \
    -H "Authorization: Bearer ${access}" \
    -H "Mcp-Session-Id: ${sid}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${body}"
}

# Device grant end to end (start, approve, exchange). Writes <prefix>.device.json and
# <prefix>.token.json; prints the access token. Usage: device_token <prefix> <scope>
device_token() {
  local prefix="$1" scope="$2" user_code device_code
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
      if (JSON.stringify(disc.response_types_supported)!=='[\"code\"]' || JSON.stringify(disc).includes('id_token')) fail('discovery advertises id_token support or a response type other than code');
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
      const n=JSON.parse(fs.readFileSync('${OUT}/deny-scope.tool-call-log-count.json','utf8'));
      if (n.after!==n.before+1) { console.error('drive: expected one outcome=denied Tool call line', n); process.exit(1); }
      const line=fs.readFileSync('${OUT}/deny-scope.tool-call-line.txt','utf8');
      if (!/errorCode=-32042/.test(line) || !/reason=insufficient_scope/.test(line) || line.includes('balanceOf')) { console.error('drive: denied Tool call line wrong', line); process.exit(1); }
      console.log('drive fail-closed-auth: deny-by-scope ok (one outcome=denied errorCode=-32042 Tool call line)');
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
      if (claims.iss!==issuer || claims.aud!=='kaia-mcp' || claims.scope!=='kaia:encode') fail('claims wrong '+JSON.stringify({iss:claims.iss,aud:claims.aud,scope:claims.scope}));
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
      if (a.active!==true || a.scope!=='kaia:read' || a.aud!=='kaia-mcp' || a.jti!==jti('${ACCESS}')) fail('active introspection wrong '+JSON.stringify(a));
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
      if (kid('jwks-c.json')===kid('jwks-b.json')) fail('memory-mode restart kept the kid');
      for (const f of ['kept-after-memory','revoked-after-memory']) {
        if (!/^HTTP\/1\.1 401/m.test(r(f+'.headers')) || JSON.parse(r(f+'.json')).error.code!==-32043) fail(f+' should be invalid_token after memory restart');
      }
      console.log('drive revocation-restart: file key -> revoked access + refresh-linked jti stay invalid_token after restart, unrevoked token still allowed, introspection inactive, refresh token invalid_grant; corrupt denylist refuses startup; memory key -> restart invalidates every token');
    "
    ;;

  *)
    echo "drive: unknown feature ${FEATURE}" >&2
    exit 2
    ;;
esac

echo "evidence written to ${OUT}"
echo "${OUT}" > "${EVIDENCE_DIR}/last-feature-path.txt"

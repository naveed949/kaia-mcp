#!/usr/bin/env bash
set -euo pipefail
# Drive one mapped feature against the launched instance.
# Usage: helpers/drive.sh <oauth-pkce-scoped-tools|fail-closed-auth|generate-wallet-gated|device-flow>
# Writes evidence under ${EVIDENCE_DIR}/<feature>/ and does not delete it.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

FEATURE="${1:-}"
if [[ -z "${FEATURE}" ]]; then
  echo "Usage: helpers/drive.sh <oauth-pkce-scoped-tools|fail-closed-auth|generate-wallet-gated|device-flow>" >&2
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
    mcp_call deny-scope "${ACCESS}" "${ENCODE_BODY}"
    node -e "
      const fs=require('fs');
      const body=fs.readFileSync('${OUT}/deny-scope.json','utf8');
      if (!body.includes('insufficient_scope: encode_function_data requires kaia:encode') && !body.includes('-32042')) {
        console.error('drive: expected insufficient_scope', body.slice(0,500));
        process.exit(1);
      }
      if (body.includes('0x70a08231')) { console.error('drive: denied call leaked calldata'); process.exit(1); }
      console.log('drive fail-closed-auth: deny-by-scope ok');
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

  *)
    echo "drive: unknown feature ${FEATURE}" >&2
    exit 2
    ;;
esac

echo "evidence written to ${OUT}"
echo "${OUT}" > "${EVIDENCE_DIR}/last-feature-path.txt"

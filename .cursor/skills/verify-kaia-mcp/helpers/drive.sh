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
    curl -sS -D "${OUT}/allow.headers" -o "${OUT}/allow.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${ENCODE_BODY}"
    node -e "
      const fs=require('fs');
      const body=fs.readFileSync('${OUT}/allow.json','utf8');
      if (!body.includes('${EXPECTED_CALLDATA}')) { console.error('drive: expected calldata missing'); process.exit(1); }
      console.log('drive oauth-pkce-scoped-tools: allow encode_function_data ok');
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
    # expired token via demo issuer helper: issue then wait is flaky; use the in-process
    # token mint through a one-shot node script against the live OAuth token? We cannot
    # mint expired tokens over HTTP. Drive expired by issuing a token then revoking it
    # AND a second path: insufficient_scope with a read-only PKCE token.
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
    curl -sS -D "${OUT}/deny-scope.headers" -o "${OUT}/deny-scope.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${ENCODE_BODY}"
    node -e "
      const fs=require('fs');
      const body=fs.readFileSync('${OUT}/deny-scope.json','utf8');
      if (!body.includes('insufficient_scope: encode_function_data requires kaia:encode') && !body.includes('-32042')) {
        console.error('drive: expected insufficient_scope', body.slice(0,500));
        process.exit(1);
      }
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
    curl -sS -o "${OUT}/tools-list.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${LIST_BODY}"
    CALL_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_wallet","arguments":{}}}'
    curl -sS -o "${OUT}/generate-wallet.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${CALL_BODY}"
    node -e "
      const fs=require('fs');
      const listed=fs.readFileSync('${OUT}/tools-list.json','utf8');
      const called=fs.readFileSync('${OUT}/generate-wallet.json','utf8');
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
    curl -sS -o "${OUT}/allow.json" -X POST "${BASE}/" \
      -H "Authorization: Bearer ${ACCESS}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "${ENCODE_BODY}"
    node -e "
      const body=require('fs').readFileSync('${OUT}/allow.json','utf8');
      if (!body.includes('${EXPECTED_CALLDATA}')) { console.error('drive: device-flow missing calldata', body.slice(0,500)); process.exit(1); }
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

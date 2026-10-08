#!/usr/bin/env bash
set -euo pipefail
# Launch an isolated kaia-mcp HTTP instance for verification.
# Usage: helpers/launch.sh
# Writes ${INSTANCE_FILE} and prints RUN_ID, port, issuer, pid.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ -f "${INSTANCE_FILE}" ]]; then
  echo "Instance already recorded at ${INSTANCE_FILE}. Run cleanup.sh first." >&2
  exit 1
fi

mkdir -p "${INSTANCE_DIR}"
cd "${REPO_ROOT}"
# Always rebuild: a stale dist/ would verify old code (tsup takes ~1s).
npm run build >"${INSTANCE_DIR}/build.log" 2>&1 || { cat "${INSTANCE_DIR}/build.log" >&2; exit 1; }

PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
LOG_FILE="${INSTANCE_DIR}/server.log"

echo "${RUN_ID}" > /tmp/kaia-mcp-verify-current

# Short access-token TTL so expiry is drivable live (jwt-access-tokens waits it out).
TOKEN_TTL="${KAIA_VERIFY_TOKEN_TTL:-20}"
# Per-run introspection credential for the gateway client. Kept with the run's
# gitignored evidence so token-leak-check.sh also scans for it.
INTROSPECTION_CLIENT_ID="kaia-mcp-gateway"
INTROSPECTION_SECRET_FILE="${EVIDENCE_DIR}/introspection.secret.json"
INTROSPECTION_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
( umask 077; printf '{"client_id":"%s","client_secret":"%s"}\n' "${INTROSPECTION_CLIENT_ID}" "${INTROSPECTION_SECRET}" > "${INTROSPECTION_SECRET_FILE}" )

# Signing-key mode: memory (default, a fresh key per process) or file (key + revocation
# denylist under ${INSTANCE_DIR}/state/, so they survive restart.sh). revocation-restart
# switches modes itself through restart.sh and restores the launch mode afterwards.
KEY_MODE="${KAIA_VERIFY_KEY_MODE:-memory}"
write_server_env "${KEY_MODE}" "${TOKEN_TTL}" "${INTROSPECTION_CLIENT_ID}" "${INTROSPECTION_SECRET}"
: >"${LOG_FILE}"
PID="$(start_kaia "${PORT}")"

if ! wait_ready "${PORT}" "${PID}"; then
  stop_pid "${PID}"
  exit 1
fi

cat > "${INSTANCE_FILE}" <<EOF
{
  "runId": "${RUN_ID}",
  "pid": ${PID},
  "port": ${PORT},
  "issuer": "http://127.0.0.1:${PORT}",
  "mcpUrl": "http://127.0.0.1:${PORT}",
  "logFile": "${LOG_FILE}",
  "evidenceDir": "${EVIDENCE_DIR}",
  "tokenTtlSeconds": ${TOKEN_TTL},
  "introspectionSecretFile": "${INTROSPECTION_SECRET_FILE}",
  "launchKeyMode": "${KEY_MODE}",
  "keyMode": "${KEY_MODE}"
}
EOF

echo "RUN_ID=${RUN_ID}"
echo "pid=${PID}"
echo "port=${PORT}"
echo "issuer=http://127.0.0.1:${PORT}"
echo "instance=${INSTANCE_FILE}"
echo "evidence=${EVIDENCE_DIR}"
echo "tokenTtlSeconds=${TOKEN_TTL}"
echo "keyMode=${KEY_MODE}"
echo "ready: GET http://127.0.0.1:${PORT}/health returned status ok"

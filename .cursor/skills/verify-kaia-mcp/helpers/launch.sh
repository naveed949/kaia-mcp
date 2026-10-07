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

KAIA_AUTH_MODE=required \
KAIA_ALLOW_UNSAFE_WALLET= \
LOG_LEVEL=debug \
node dist/bin/kaia-mcp.js --transport http --port "${PORT}" \
  >"${LOG_FILE}" 2>&1 &
PID=$!

READY=0
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "${PID}" 2>/dev/null; then
    echo "Server exited before becoming ready. Log: ${LOG_FILE}" >&2
    cat "${LOG_FILE}" >&2 || true
    exit 1
  fi
  sleep 0.1
done

if [[ "${READY}" != "1" ]]; then
  echo "Timed out waiting for /health on port ${PORT}. Log: ${LOG_FILE}" >&2
  kill "${PID}" 2>/dev/null || true
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
  "evidenceDir": "${EVIDENCE_DIR}"
}
EOF

echo "RUN_ID=${RUN_ID}"
echo "pid=${PID}"
echo "port=${PORT}"
echo "issuer=http://127.0.0.1:${PORT}"
echo "instance=${INSTANCE_FILE}"
echo "evidence=${EVIDENCE_DIR}"
echo "ready: GET http://127.0.0.1:${PORT}/health returned status ok"

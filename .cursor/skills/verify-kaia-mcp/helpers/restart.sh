#!/usr/bin/env bash
set -euo pipefail
# Restart the instance this run launched on the SAME port (so the issuer, and with it
# every token's `iss`, stays the same), optionally switching the signing-key mode.
# Usage: helpers/restart.sh [memory|file]     (default: keep the current keyMode)
# memory: a fresh key per process. file: key + revocation denylist persist under
# ${INSTANCE_DIR}/state/. Updates pid and keyMode in instance.json. Never kills by name.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ ! -f "${INSTANCE_FILE}" ]]; then
  echo "restart: missing instance file ${INSTANCE_FILE}. Run launch.sh first." >&2
  exit 1
fi

OLD_PID="$(inst pid)"
PORT="$(inst port)"
MODE="${1:-$(inst keyMode)}"
MODE="${MODE:-memory}"
TTL="$(inst tokenTtlSeconds)"
SECRET_FILE="$(inst introspectionSecretFile)"
IID="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).client_id)" "${SECRET_FILE}")"
ISECRET="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).client_secret)" "${SECRET_FILE}")"

stop_pid "${OLD_PID}"
write_server_env "${MODE}" "${TTL}" "${IID}" "${ISECRET}"
PID="$(start_kaia "${PORT}")"
if ! wait_ready "${PORT}" "${PID}"; then
  stop_pid "${PID}"
  exit 1
fi

node -e '
const fs = require("fs");
const [file, pid, mode] = process.argv.slice(1);
const i = JSON.parse(fs.readFileSync(file, "utf8"));
i.pid = Number(pid);
i.keyMode = mode;
i.restarts = (i.restarts || 0) + 1;
fs.writeFileSync(file, JSON.stringify(i, null, 2) + "\n");
' "${INSTANCE_FILE}" "${PID}" "${MODE}"

echo "restart: pid ${OLD_PID} -> ${PID} on port ${PORT} (keyMode=${MODE})"
echo "ready: GET http://127.0.0.1:${PORT}/health returned status ok"

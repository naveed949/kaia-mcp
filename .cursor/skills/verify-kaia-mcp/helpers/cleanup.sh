#!/usr/bin/env bash
set -euo pipefail
# Tear down the instance this run started. Never kill by process name.
# Never deletes evidence under .cursor/skills/verify-kaia-mcp/evidence/.
# Usage: helpers/cleanup.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ ! -f "${INSTANCE_FILE}" ]]; then
  echo "cleanup: no instance file at ${INSTANCE_FILE} (nothing to stop)"
  echo "evidence dir (untouched): ${EVIDENCE_DIR}"
  exit 0
fi

PID="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.pid))")"
PORT="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.port))")"

if kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}"
  for _ in $(seq 1 30); do
    if ! kill -0 "${PID}" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "${PID}" 2>/dev/null; then
    kill -9 "${PID}" 2>/dev/null || true
  fi
fi

rm -rf "${INSTANCE_DIR}"
if [[ -f /tmp/kaia-mcp-verify-current ]]; then
  CURRENT="$(cat /tmp/kaia-mcp-verify-current)"
  if [[ "${CURRENT}" == "${RUN_ID}" ]]; then
    rm -f /tmp/kaia-mcp-verify-current
  fi
fi

echo "cleanup: stopped pid ${PID} (port ${PORT})"
echo "cleanup: removed ${INSTANCE_DIR}"
echo "cleanup: evidence retained at ${EVIDENCE_DIR}"

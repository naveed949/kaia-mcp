#!/usr/bin/env bash
set -euo pipefail
# Tear down the instance this run started. Never kill by process name.
# Never deletes evidence under .cursor/skills/verify-kaia-mcp/evidence/.
# Usage: helpers/cleanup.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ -f "${INSTANCE_FILE}" ]]; then
  PID="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.pid))")"
  PORT="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.port))")"
  stop_pid "${PID}"
  echo "cleanup: stopped pid ${PID} (port ${PORT})"
else
  echo "cleanup: no instance file at ${INSTANCE_FILE} (nothing to stop)"
fi

if [[ -d "${INSTANCE_DIR}" ]]; then
  # Keep the server log as evidence (used by token-leak-check.sh) before removing scratch state.
  if [[ -f "${INSTANCE_DIR}/server.log" ]]; then
    cp "${INSTANCE_DIR}/server.log" "${EVIDENCE_DIR}/server.log"
    echo "cleanup: server log kept at ${EVIDENCE_DIR}/server.log"
  fi
  rm -rf "${INSTANCE_DIR}"
  echo "cleanup: removed ${INSTANCE_DIR}"
fi
if [[ -f /tmp/kaia-mcp-verify-current ]]; then
  CURRENT="$(cat /tmp/kaia-mcp-verify-current)"
  if [[ "${CURRENT}" == "${RUN_ID}" ]]; then
    rm -f /tmp/kaia-mcp-verify-current
  fi
fi

echo "cleanup: evidence retained at ${EVIDENCE_DIR}"

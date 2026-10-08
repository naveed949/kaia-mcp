#!/usr/bin/env bash
# Shared paths for verify-kaia-mcp. Sourced by launch/doctor/drive/cleanup.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPERS_DIR="$SKILL_DIR/helpers"

RUN_ID="${KAIA_VERIFY_RUN_ID:-${RUN_ID:-}}"
if [[ -z "${RUN_ID}" && -f /tmp/kaia-mcp-verify-current ]]; then
  RUN_ID="$(cat /tmp/kaia-mcp-verify-current)"
fi
if [[ -z "${RUN_ID}" ]]; then
  RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
fi

INSTANCE_DIR="/tmp/kaia-mcp-verify-${RUN_ID}"
INSTANCE_FILE="${INSTANCE_DIR}/instance.json"
EVIDENCE_DIR="${SKILL_DIR}/evidence/${RUN_ID}"

# Only launch.sh creates INSTANCE_DIR; doctor/cleanup/leak-check must not recreate scratch state.
mkdir -p "${EVIDENCE_DIR}"

export REPO_ROOT SKILL_DIR HELPERS_DIR RUN_ID INSTANCE_DIR INSTANCE_FILE EVIDENCE_DIR

# Start kaia-mcp from ${INSTANCE_DIR}/server.env (written by launch.sh, rewritten by
# restart.sh) on <port>, appending to ${INSTANCE_DIR}/server.log so token-leak-check.sh
# covers every process of the run. Prints the pid. Usage: start_kaia <port>
start_kaia() {
  local port="$1"
  (
    set -a
    # shellcheck disable=SC1091
    source "${INSTANCE_DIR}/server.env"
    set +a
    cd "${REPO_ROOT}"
    exec node dist/bin/kaia-mcp.js --transport http --port "${port}" >>"${INSTANCE_DIR}/server.log" 2>&1
  ) &
  echo $!
}

# Wait until GET /health answers on <port> or <pid> exits. Exit status 0 = ready.
# Usage: wait_ready <port> <pid>
wait_ready() {
  local port="$1" pid="$2"
  for _ in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "kaia-mcp pid ${pid} exited before becoming ready. Log: ${INSTANCE_DIR}/server.log" >&2
      tail -5 "${INSTANCE_DIR}/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  echo "Timed out waiting for /health on port ${port}." >&2
  return 1
}

# Stop <pid> (SIGTERM, then SIGKILL). Never kills by name. Usage: stop_pid <pid>
stop_pid() {
  local pid="$1"
  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}"
    for _ in $(seq 1 30); do
      kill -0 "${pid}" 2>/dev/null || return 0
      sleep 0.1
    done
    kill -9 "${pid}" 2>/dev/null || true
  fi
}

# Write ${INSTANCE_DIR}/server.env (mode 0600) for <memory|file> signing-key mode.
# file: key and revocation denylist live under ${INSTANCE_DIR}/state/ (removed by cleanup).
# Usage: write_server_env <memory|file> <token-ttl> <introspection-id> <introspection-secret>
write_server_env() {
  local mode="$1" ttl="$2" iid="$3" isecret="$4" keyfile=""
  if [[ "${mode}" == "file" ]]; then
    keyfile="${INSTANCE_DIR}/state/signing-key.pem"
  elif [[ "${mode}" != "memory" ]]; then
    echo "key mode must be memory or file, got ${mode}" >&2
    return 2
  fi
  (
    umask 077
    cat >"${INSTANCE_DIR}/server.env" <<ENV
KAIA_AUTH_MODE=required
KAIA_ALLOW_UNSAFE_WALLET=
KAIA_ACCESS_TOKEN_TTL_SECONDS=${ttl}
KAIA_OAUTH_SIGNING_KEY_FILE=${keyfile}
KAIA_OAUTH_REVOCATION_FILE=
KAIA_INTROSPECTION_CLIENT_ID=${iid}
KAIA_INTROSPECTION_CLIENT_SECRET=${isecret}
LOG_LEVEL=debug
ENV
  )
}

# Read one field of instance.json. Usage: inst <field>
inst() {
  node -e "const i=require(process.argv[1]); const v=i[process.argv[2]]; process.stdout.write(v===undefined||v===null?'':String(v))" "${INSTANCE_FILE}" "$1"
}

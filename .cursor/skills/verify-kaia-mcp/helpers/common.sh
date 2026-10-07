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

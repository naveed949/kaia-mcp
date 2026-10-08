#!/usr/bin/env bash
set -euo pipefail
# After cleanup: prove no issued secret appears in plaintext in the server log.
# Usage: helpers/token-leak-check.sh
# Scans ${EVIDENCE_DIR}/server.log for every access_token, refresh_token, device_code,
# authorization code, PKCE verifier, and introspection client secret captured under
# ${EVIDENCE_DIR}, plus any compact JWT at all (access tokens are JWTs). Exit 1 on any hit.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

LOG="${EVIDENCE_DIR}/server.log"
if [[ ! -f "${LOG}" ]]; then
  echo "token-leak-check: no ${LOG}; run cleanup.sh for this run first" >&2
  exit 1
fi

node -e '
const fs = require("fs"), path = require("path");
const [dir, logFile] = process.argv.slice(1);
const log = fs.readFileSync(logFile, "utf8");
const secrets = new Set();
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (p === logFile) continue;
    const t = fs.readFileSync(p, "utf8");
    if (e.name.endsWith(".json")) {
      try {
        const j = JSON.parse(t);
        for (const k of ["access_token", "refresh_token", "device_code", "verifier", "client_secret"]) if (typeof j[k] === "string") secrets.add(j[k]);
      } catch {}
    }
    if (e.name === "authorization.code.txt" && t.trim()) secrets.add(t.trim());
  }
};
walk(dir);
const hits = [...secrets].filter((s) => s.length >= 16 && log.includes(s));
const jwtHits = log.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
if (jwtHits.length) { console.error("token-leak-check: LEAK " + jwtHits.length + " compact JWT(s) in plaintext"); process.exit(1); }
console.log("token-leak-check: scanned " + secrets.size + " secrets against " + logFile + " (" + log.split("\n").length + " lines)");
if (hits.length) { console.error("token-leak-check: LEAK " + hits.length + " secret(s) found in plaintext"); process.exit(1); }
console.log("token-leak-check: no plaintext secrets in server log");
' "${EVIDENCE_DIR}" "${LOG}"

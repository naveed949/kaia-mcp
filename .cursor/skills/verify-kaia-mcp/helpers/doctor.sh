#!/usr/bin/env bash
set -euo pipefail
# Read-only check: is this verification instance worth driving?
# Usage: helpers/doctor.sh
# Exit 0 only when pid is alive, /health matches, authMode=required, unsafeWallet=false,
# discovery advertises jwks_uri + introspection_endpoint + RFC 9207 iss, the protected resource
# metadata names the issuer as its resource, and the JWKS has at least one RS256 public key
# (the current key first; retired keys may follow).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ ! -f "${INSTANCE_FILE}" ]]; then
  echo "doctor: missing instance file ${INSTANCE_FILE}" >&2
  exit 1
fi

PID="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.pid))")"
PORT="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(String(i.port))")"
ISSUER="$(node -e "const i=require('${INSTANCE_FILE}'); process.stdout.write(i.issuer)")"

if ! kill -0 "${PID}" 2>/dev/null; then
  echo "doctor: pid ${PID} is not running" >&2
  exit 1
fi

HEALTH_JSON="$(curl -sf "http://127.0.0.1:${PORT}/health")" || {
  echo "doctor: GET /health failed on port ${PORT}" >&2
  exit 1
}

DISCOVERY_JSON="$(curl -sf "http://127.0.0.1:${PORT}/.well-known/openid-configuration")" || {
  echo "doctor: discovery failed on port ${PORT}" >&2
  exit 1
}
JWKS_JSON="$(curl -sf "http://127.0.0.1:${PORT}/oauth/jwks")" || {
  echo "doctor: GET /oauth/jwks failed on port ${PORT}" >&2
  exit 1
}
PRM_JSON="$(curl -sf "http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource")" || {
  echo "doctor: protected resource metadata failed on port ${PORT}" >&2
  exit 1
}
node -e '
const [disc, jwks, issuer, prm] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), process.argv[3], JSON.parse(process.argv[4])];
const fail = (m) => { console.error("doctor: " + m); process.exit(1); };
if (disc.issuer !== issuer) fail("discovery issuer " + disc.issuer + " != " + issuer);
if (disc.jwks_uri !== issuer + "/oauth/jwks") fail("discovery jwks_uri is " + disc.jwks_uri);
if (disc.introspection_endpoint !== issuer + "/oauth/introspect") fail("introspection_endpoint missing (launch sets the secret)");
if (disc.authorization_response_iss_parameter_supported !== true) fail("discovery does not advertise authorization_response_iss_parameter_supported (RFC 9207)");
if (prm.resource !== issuer || JSON.stringify(prm.authorization_servers) !== JSON.stringify([issuer])) fail("protected resource metadata resource/authorization_servers is not the issuer: " + JSON.stringify(prm));
if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || !jwks.keys.every((k) => k.alg === "RS256" && k.kid)) fail("JWKS must hold RS256 keys with a kid");
if (jwks.keys.some((k) => "d" in k)) fail("JWKS exposes private key material");
' "${DISCOVERY_JSON}" "${JWKS_JSON}" "${ISSUER}" "${PRM_JSON}"

echo "${HEALTH_JSON}" | node -e '
const fs = require("fs");
const inst = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let body = "";
process.stdin.on("data", d => body += d);
process.stdin.on("end", () => {
  const h = JSON.parse(body);
  const fail = (m) => { console.error("doctor: " + m); process.exit(1); };
  if (h.status !== "ok") fail("status is not ok: " + body);
  if (h.server !== "kaia-mcp") fail("unexpected server: " + h.server);
  if (h.authMode !== "required") fail("authMode is " + h.authMode + ", expected required");
  if (h.unsafeWallet !== false) fail("unsafeWallet must be false");
  if (h.issuer !== inst.issuer) fail("issuer mismatch: " + h.issuer + " vs " + inst.issuer);
  console.log("doctor: healthy");
  console.log("  pid=" + inst.pid);
  console.log("  port=" + inst.port);
  console.log("  issuer=" + h.issuer);
  console.log("  authMode=" + h.authMode);
  console.log("  unsafeWallet=" + h.unsafeWallet);
  console.log("  jwks=" + process.argv[2] + " RS256 key(s); introspection + RFC 9207 iss advertised; PRM resource=issuer");
});
' "${INSTANCE_FILE}" "$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).keys.length))" "${JWKS_JSON}")"

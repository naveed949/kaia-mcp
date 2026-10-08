/**
 * Redact secrets in log text so access tokens and upstream credentials never appear in
 * plaintext. The logger runs every message and value through redactString, on the full raw
 * text, before it caps and encodes it.
 */

const SECRET_KEYS =
  /^(access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization|password|private_key|privatekey|device_code)$/i;

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/** Compact JWS (access tokens are JWTs): header and payload both start with base64url("{\""). */
const JWT_RE = /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g;
/** An http(s)/ws(s) URL: scheme, authority, then path/query/fragment up to whitespace. */
const URL_RE = /\b((?:https?|wss?):\/\/)([^\s/?#]*)([^\s]*)/gi;
/** A path segment shaped like an API key: 16+ token characters with a letter and a digit. */
const KEY_SEGMENT_RE = /^[A-Za-z0-9_-]{16,}/;

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.test(key);
}

function looksLikeKey(run: string): boolean {
  return /[A-Za-z]/.test(run) && /[0-9]/.test(run);
}

/**
 * Upstream URLs (an RPC provider's `https://host/v2/<key>?apikey=<key>`) routinely carry
 * credentials. Keep the scheme and host (useful to an operator), drop userinfo, the query
 * string and fragment, and any path segment shaped like a key.
 */
function redactUrl(_m: string, scheme: string, authority: string, rest: string): string {
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : `[redacted]@${authority.slice(at + 1)}`;
  const q = rest.search(/[?#]/);
  const path = q === -1 ? rest : rest.slice(0, q);
  const tail = q === -1 ? "" : "?[redacted]";
  const safePath = path
    .split("/")
    .map((seg) => {
      const run = KEY_SEGMENT_RE.exec(seg)?.[0];
      return run && looksLikeKey(run) ? `[redacted]${seg.slice(run.length)}` : seg;
    })
    .join("/");
  return `${scheme}${host}${safePath}${tail}`;
}

export function redactString(value: string): string {
  return value
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(URL_RE, redactUrl);
}

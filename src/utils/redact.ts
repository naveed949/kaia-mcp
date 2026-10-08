/**
 * Redact secrets in log text so access tokens and upstream credentials never appear in
 * plaintext. The logger bounds every message and value with boundRedactionInput, runs it
 * through redactString, and only then caps and encodes it.
 *
 * Everything here is linear-time on any input: log values include caller input (a tool
 * name, an Origin) and upstream text (a contract's revert reason), so one super-linear
 * pattern lets a single request stall the server. The JWT step is a hand-written scanner
 * for that reason; the remaining regexes are linear (see the notes on each).
 */

const SECRET_KEYS =
  /^(access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization|password|private_key|privatekey|device_code)$/i;

/**
 * `Bearer <token>`. Linear: a match can only start at the literal "Bearer"; `\s+` and the
 * token class are disjoint, so a failed attempt backtracks over its own whitespace once,
 * and `=*` is never followed by anything that can fail.
 */
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/**
 * An http(s)/ws(s) URL: scheme, authority, then path/query/fragment up to whitespace.
 * Linear: the two groups are greedy and nothing after them can fail, so a match that has
 * its scheme never backtracks; a start without `://` fails within seven characters.
 */
const URL_RE = /\b((?:https?|wss?):\/\/)([^\s/?#]*)([^\s]*)/gi;
/** A path segment shaped like an API key: 16+ token characters with a letter and a digit. */
const KEY_SEGMENT_RE = /^[A-Za-z0-9_-]{16,}/;

/**
 * Most characters fed to the redactor at once (see boundRedactionInput): far above every
 * log cap (256 bytes per value, 512 for `error=`), far below a 4 MB request body.
 */
export const REDACT_INPUT_MAX_CHARS = 4096;
const ELLIPSIS = "\u2026";
/** Every character JavaScript's `\s` matches. */
const WHITESPACE = /\s/;

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

/** A base64url character: A-Z, a-z, 0-9, '_' or '-'. */
function isB64(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c === 0x2d
  );
}

/** End (exclusive) of the run of base64url characters starting at `i`. */
function runEnd(s: string, i: number): number {
  while (i < s.length && isB64(s.charCodeAt(i))) i++;
  return i;
}

/**
 * Replace every compact JWS (access tokens are JWTs: header and payload both start with
 * base64url("{\""), i.e. `eyJ`) with `[redacted-jwt]`, in one pass.
 *
 * Exactly what `/eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\/g` replaced, without
 * its O(n²) cost: that regex restarted at every `eyJ` and rescanned the rest of the run, so
 * `eyJeyJeyJ…` took minutes per megabyte. Each segment pattern is greedy over base64url and
 * must be followed by a dot, which is not base64url, so the first segment always ends where
 * its run of base64url characters ends. Every `eyJ` in one run therefore succeeds or fails
 * together, and the leftmost match in a run starts at its first `eyJ`. The scanner walks the
 * runs once: a run with an `eyJ`, then `.`, then a run starting with `eyJ`, then `.`, then a
 * (possibly empty) run is a match from that first `eyJ` to the end of the third run. Each run
 * is scanned at most three times, so the cost is linear.
 */
function redactJwts(s: string): string {
  let out = "";
  let copied = 0;
  let i = 0;
  // The next "eyJ" at or after i (-1: none left). Only searched again once i passes it, so
  // the searches cover the string once in total.
  let next = s.indexOf("eyJ");
  while (i < s.length && next !== -1) {
    if (!isB64(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const end1 = runEnd(s, i);
    if (next < i) next = s.indexOf("eyJ", i);
    const start = next;
    if (
      start !== -1 &&
      start + 3 <= end1 &&
      s.charCodeAt(end1) === 0x2e &&
      s.startsWith("eyJ", end1 + 1)
    ) {
      const end2 = runEnd(s, end1 + 1);
      if (s.charCodeAt(end2) === 0x2e) {
        const end3 = runEnd(s, end2 + 1);
        out += s.slice(copied, start) + "[redacted-jwt]";
        copied = end3;
        i = end3;
        if (next < i) next = s.indexOf("eyJ", i);
        continue;
      }
    }
    i = end1;
  }
  return copied === 0 ? s : out + s.slice(copied);
}

export function redactString(value: string): string {
  return redactJwts(value.replace(BEARER_RE, "Bearer [redacted]")).replace(URL_RE, redactUrl);
}

/**
 * Bound `text` before redaction: at most `maxChars` characters, cut only at whitespace,
 * with "…" appended when anything was cut. Every secret the redactor knows (a JWT, the
 * token of `Bearer <token>`, a URL) is one run of non-whitespace characters, so each run is
 * either kept whole, and redacted exactly as in the full text, or dropped whole: the cut
 * can never leave an `eyJ…` header, half a URL or half a key behind. A run that crosses the
 * bound is dropped, so one huge run (a 4 MB tool name) leaves just "…". Linear, and it
 * makes every later step cost O(maxChars) whatever the input size.
 */
export function boundRedactionInput(
  text: string,
  maxChars: number = REDACT_INPUT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  if (!WHITESPACE.test(text[maxChars])) {
    // text[maxChars] is inside a run: drop the run's kept part, back to its whitespace.
    while (cut > 0 && !WHITESPACE.test(text[cut - 1])) cut--;
  }
  return text.slice(0, cut) + ELLIPSIS;
}

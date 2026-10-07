/**
 * Redact secrets in log metadata so access tokens never appear in plaintext.
 */

const SECRET_KEYS =
  /^(access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization|password|private_key|privatekey|device_code)$/i;

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.test(key);
}

export function redactString(value: string): string {
  return value.replace(BEARER_RE, "Bearer [redacted]");
}

export function redactValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  return value;
}

export function redactMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

/**
 * RFC 8707 resource indicators. kaia-mcp's authorization server serves exactly one
 * resource: its own canonical URI (KAIA_PUBLIC_URL, or http://127.0.0.1:<port>).
 */

/**
 * Canonical form of a `resource` value for comparison: absolute http(s) URI, no fragment,
 * lowercase scheme and host (MCP: servers SHOULD accept uppercase), default port elided,
 * and no trailing slash on an empty path. Returns null for anything that is not a valid
 * absolute URI without a fragment (RFC 8707 §2).
 */
export function canonicalResource(value: string): string | null {
  if (value.includes("#")) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${u.origin}${path}${u.search}`;
}

export function invalidTarget(description: string): Error {
  return Object.assign(new Error(`invalid_target: ${description}`), {
    oauthError: "invalid_target",
  });
}

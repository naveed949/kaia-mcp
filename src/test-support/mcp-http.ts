/**
 * Test-only helpers for driving the HTTP MCP endpoint with raw fetch (no SDK client),
 * so tests observe exact status codes and headers.
 */
export const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "kaia-test", version: "0" },
};

export type RpcMessage = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };

/** Parse a JSON body, or the last JSON-RPC message of an SSE body. */
export async function readRpc(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return data.length ? JSON.parse(data[data.length - 1]) : undefined;
  }
  return JSON.parse(text);
}

export async function mcpPost(
  url: string,
  message: RpcMessage | RpcMessage[],
  opts: { token?: string; headers?: Record<string, string> } = {}
): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(message),
  });
  const body = res.status === 202 ? undefined : await readRpc(res);
  return { res, body };
}

export function toolsCall(
  id: number,
  name: string,
  args: Record<string, unknown> = {}
): RpcMessage {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

export const REDIRECT_URI = "http://127.0.0.1/callback";

export function form(url: string, fields: Record<string, string | string[]>): Promise<Response> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
  }
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

/** GET /oauth/authorize with PKCE S256. Extra params (e.g. resource) may repeat. */
export async function authorize(
  base: string,
  opts: {
    challenge: string;
    scope?: string;
    state?: string;
    extra?: [string, string][];
  }
): Promise<Response> {
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("client_id", "kaia-mcp-demo");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scope ?? "kaia:read");
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.state) url.searchParams.set("state", opts.state);
  for (const [k, v] of opts.extra ?? []) url.searchParams.append(k, v);
  return fetch(url, { redirect: "manual" });
}

/** Approve a consent page; returns the redirect Location. */
export async function approve(base: string, consentHtml: string): Promise<URL> {
  const requestId = consentHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  if (!requestId) throw new Error("no request_id in consent page");
  const res = await form(`${base}/oauth/consent`, { request_id: requestId, decision: "approve" });
  const loc = res.headers.get("location");
  if (res.status !== 302 || !loc) throw new Error(`consent returned ${res.status}`);
  return new URL(loc);
}

/** Start + approve a device authorization; returns the device_code. */
export async function deviceApproved(
  base: string,
  fields: Record<string, string | string[]> = {}
): Promise<string> {
  const start = await form(`${base}/oauth/device`, {
    client_id: "kaia-mcp-demo",
    scope: "kaia:read",
    ...fields,
  });
  if (start.status !== 200) throw new Error(`device start ${start.status}`);
  const { device_code, user_code } = (await start.json()) as {
    device_code: string;
    user_code: string;
  };
  const ok = await form(`${base}/oauth/device/verify`, { user_code, decision: "approve" });
  if (ok.status !== 200) throw new Error(`device verify ${ok.status}`);
  return device_code;
}

export function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<
    string,
    unknown
  >;
}

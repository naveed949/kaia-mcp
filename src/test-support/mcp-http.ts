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

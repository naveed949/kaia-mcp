/**
 * Bounded reads of upstream HTTP responses (issue #15), for the RPC transport and the
 * KaiaScan client. A hostile or compromised RPC node or KaiaScan endpoint controls the
 * response: how large its body is (declared or not, compressed or not), how slowly it
 * arrives, and where it redirects. fetchBounded reads the whole body inside the caller's
 * fetch (so the caller's timeout signal covers the body, not just the headers), refuses
 * it past MAX_UPSTREAM_RESPONSE_BYTES, and never follows a redirect.
 */

/**
 * 8 MiB. Twice the largest response whose result kaia accepts: a read_contract result at
 * the 2 MiB raw cap (#14) is 4 MiB of hex, a JSON-RPC response of about 4,194,342 bytes.
 * Real responses are far smaller (of 30 recent Kaia mainnet blocks fetched with full
 * transactions, the largest was 34 KB). Below viem's own 10 MiB default.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;

/** An upstream response body over the cap. Maps to -32005 (see describeFailure). */
export class UpstreamResponseTooLargeError extends Error {
  readonly limit: number;

  constructor(upstream: "RPC" | "KaiaScan", limit: number) {
    super(`Upstream ${upstream} response is too large: it is over ${limit} bytes (kaia's limit).`);
    this.name = "UpstreamResponseTooLargeError";
    this.limit = limit;
  }
}

/**
 * fetch, then the body read in full up to `maxBytes` and handed back as a new Response.
 * - The decoded bytes are counted as they arrive (a gzip body is counted inflated), so a
 *   missing, lying or compressed Content-Length cannot get more than `maxBytes` read.
 * - A declared Content-Length over `maxBytes` is refused before any of the body is read.
 * - Over the cap, the body stream is cancelled, which closes the connection; nothing more
 *   is read or buffered.
 * - `redirect: "manual"`: a 3xx answer comes back as itself (an HTTP error for both
 *   clients), and its Location is never requested.
 */
export async function fetchBounded(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  upstream: "RPC" | "KaiaScan",
  maxBytes: number = MAX_UPSTREAM_RESPONSE_BYTES
): Promise<Response> {
  const res = await fetch(input, { ...init, redirect: "manual" });
  const tooLarge = () => new UpstreamResponseTooLargeError(upstream, maxBytes);
  if (!res.body) return res;
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Response(size === 0 ? null : Buffer.concat(chunks, size), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** The first error of type `type` in `err`'s cause chain (at most 16 deep). */
export function findCause<T extends Error>(
  err: unknown,
  type: abstract new (...args: never[]) => T
): T | undefined {
  let e: unknown = err;
  for (let i = 0; i < 16 && e && typeof e === "object"; i++) {
    if (e instanceof type) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

# Architecture Deep Dive: Registry Pattern, Error Mapping, and Rate Limiting

This document walks through three core architecture patterns in kaia-mcp with annotated code. These patterns are essential for building production-ready MCP servers and agent-facing infrastructure.

---

## 1. The Tool Registry Pattern

### 1.1 Intent

The **registry pattern** gives the server a single place to:

- **Discover** all tools (for `tools/list`)
- **Dispatch** by name to the right handler (for `tools/call`)

Each tool module owns its definitions and handlers; the registry only aggregates and routes.

### 1.2 Structure

```
src/tools/
├── index.ts      ← Registry: ALL_TOOLS, listTools(), callTool()
├── account.ts    ← ACCOUNT_TOOLS + handleGetKaiaBalance, handleGetAccountInfo, ...
├── transaction.ts
├── block.ts
├── token.ts
├── nft.ts
├── contract.ts
├── network.ts
└── wallet.ts
```

### 1.3 Annotated Code: Aggregation

```typescript
// src/tools/index.ts (excerpt)

// Each module exports a const array of tool definitions (name, description, inputSchema)
// and one handler per tool. The registry imports both.

const ALL_TOOLS = [
  ...ACCOUNT_TOOLS,
  ...TRANSACTION_TOOLS,
  ...BLOCK_TOOLS,
  ...TOKEN_TOOLS,
  ...NFT_TOOLS,
  ...CONTRACT_TOOLS,
  ...NETWORK_TOOLS,
  ...WALLET_TOOLS,
];

/**
 * listTools() is used by the MCP server when the client sends tools/list.
 * It returns only the fields the protocol needs: name, description, inputSchema.
 * No handler references are exposed to the client.
 */
export function listTools(): ListToolsResult {
  return {
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    nextCursor: undefined,
    _meta: {},
  };
}
```

Design choice: the server does not store a separate map from name → handler; it uses a single array for listing and a `switch (name)` for dispatch. Adding a new tool requires:

1. Defining the tool and handler in a module (e.g. `contract.ts`)
2. Adding the module’s tools to `ALL_TOOLS` in `index.ts`
3. Adding a `case "tool_name": return ... handleX(a) ...` in `callTool()`

### 1.4 Annotated Code: Dispatch

```typescript
// src/tools/index.ts (excerpt)

/**
 * callTool is the single entry point for tools/call. The server passes
 * request.params.name and request.params.arguments here. Any thrown error
 * is caught by wrapToolHandler in server.ts and converted to a ProtocolError.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const a = args ?? {};
  switch (name) {
    case "get_kaia_balance":
      return { ...(await handleGetKaiaBalance(a)), _meta: {} };
    // ... one case per tool ...
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

Why a switch instead of a map? The switch is explicit and type-safe: if you add a tool and forget to add a case, there is no default handler and the default branch throws. A dynamic map would require careful typing to keep names and handlers in sync.

---

## 2. Error Mapping Strategy

### 2.1 Intent

Handlers throw normal JavaScript errors (network, validation, API errors). The MCP protocol expects JSON-RPC errors with specific codes. **toMcpError** normalizes any thrown value into a single shape `{ code, message, data? }` that the server turns into a `ProtocolError` (from `@modelcontextprotocol/server`) and sends to the client. Argument validation throws `InvalidParamsError` (`src/utils/errors.ts`), which maps to `-32602` Invalid params. Only kaia's own errors about the request (`InvalidParamsError`, `AuthError`, and the `ProtocolError`s its handlers throw for unknown names) are client mistakes. An upstream error is a server-side failure whatever code it carries, and the caller gets a fixed message for its class, never the upstream text, URL or request body.

### 2.2 Error Codes (src/utils/errors.ts)

```typescript
// src/utils/errors.ts (excerpt)

export const MCP_ERROR_CODES = {
  Parse: -32700, // JSON parse error
  InvalidRequest: -32600, // Invalid JSON-RPC request
  MethodNotFound: -32601, // Method not found
  InvalidParams: -32602, // Invalid parameters (e.g. bad address)
  InternalError: -32603, // Generic server error
  RpcProviderError: -32001, // any RPC node failure, whatever JSON-RPC code the node used
  KaiaScanApiError: -32004, // KaiaScan API failure (-32002 is rewritten to -32602 by MCP SDK v2)
  RateLimit: -32003, // 429 / rate limit
} as const;
```

The -32000…-32099 range is for server-defined errors. The server uses -32001 (RPC provider), -32004 (KaiaScan) and -32003 (rate limit) so the client can distinguish RPC vs KaiaScan vs rate-limit and react (e.g. retry with backoff for rate limit). It avoids -32002: the MCP SDK v2 wire codecs rewrite -32002 (the retired ResourceNotFound) to -32602 Invalid params, which would present a KaiaScan outage as a caller mistake.

### 2.3 Annotated Code: Classification

```typescript
// src/utils/errors.ts (excerpt): typed upstream errors, no message heuristics
export class KaiaScanApiError extends Error {
  /* operation ("token holders"), HTTP status, cause; thrown by the KaiaScan client */
}
export class KaiaScanRateLimitError extends KaiaScanApiError {} // 429 after one retry

export function describeFailure(err: unknown): FailureDescription {
  // KaiaScanRateLimitError -> -32003; KaiaScanApiError -> -32004;
  // viem BaseError (any RPC failure, whatever upstream code) -> -32001, or -32003 for HTTP 429;
  // a network error code (ECONNREFUSED, ...) -> -32001; anything else -> -32603.
  // Returns { code, message (fixed, for the caller), upstreamCode?, upstreamStatus?, detail (log only) }.
}
```

Order of checks in `toMcpError` matters only for kaia's own errors: `AuthError` and `InvalidParamsError` come first and keep their kaia-authored messages (so caller text such as a function name containing "429" cannot turn a validation error into a rate-limit one). Everything else goes through `describeFailure`, which classifies by error type and structured fields (the viem error class, an HTTP status of 429), never by searching message text, and never passes an upstream's JSON-RPC code through as kaia's.

### 2.4 Annotated Code: toMcpError and Server Usage

```typescript
// src/utils/errors.ts (excerpt)

export function toMcpError(err: unknown): McpErrorShape {
  if (err instanceof AuthError)
    return { code: err.code, message: err.message, data: { error: err.error } };
  // A caller's bad argument: -32602, kaia's own message
  if (err instanceof InvalidParamsError)
    return { code: MCP_ERROR_CODES.InvalidParams, message: err.message || "Invalid params" };
  // Everything else: kaia's code and a fixed message; data is at most the upstream's
  // numeric code / HTTP status. Never the upstream text, RPC URL or request body.
  const f = describeFailure(err);
  const data = { upstreamCode: f.upstreamCode, upstreamStatus: f.upstreamStatus }; // when set
  return { code: f.code, message: f.message, data };
}
```

```typescript
// src/server.ts (excerpt)

function isClientMistake(err: unknown): boolean {
  if (err instanceof InvalidParamsError || err instanceof AuthError) return true;
  return err instanceof ProtocolError && CLIENT_PROTOCOL_ERROR_CODES.has(err.code);
}

function wrapToolHandler<T, R>(method: string, handler: (req: T) => R | Promise<R>) {
  return async (req: T, _extra: unknown) => {
    try {
      return await Promise.resolve(handler(req));
    } catch (err) {
      const errorType = err instanceof Error ? err.name : typeof err;
      if (isClientMistake(err)) {
        // unknown name, invalid argument, in-band auth denial: code and category only
        logger.info("Request denied", { method, code, category, errorType, outcome: "denied" });
      } else {
        // upstream fault or unexpected exception: the detail goes to the (redacted) log only
        const failure = describeFailure(err);
        logger.error("Tool error", {
          code: failure.code,
          method,
          category: errorCategory(failure.code),
          errorType,
          upstreamCode: failure.upstreamCode,
          upstreamStatus: failure.upstreamStatus,
          detail: failure.detail,
        });
      }
      if (err instanceof ProtocolError) throw err;
      const shape = toMcpError(err);
      throw new ProtocolError(shape.code, shape.message, shape.data);
    }
  };
}
```

So: every tools/list, tools/call, resources/list, resources/read, prompts/list, prompts/get handler is wrapped. Any thrown value becomes a structured MCP error and is logged before rethrow: a client mistake with code and category only, a server-side failure with code, category, the upstream's numeric code or status and a redacted short `detail`. The client always receives a valid JSON-RPC error response. Unknown tool names are rejected in the `tools/call` handler before `callTool` runs (`-32602`, logged `outcome=denied reason=unknown_tool`); the `default` branch below is a second line of defense.

---

## 3. Rate Limiting and Resilience

### 3.1 Intent

- **Rate limiting**: avoid overwhelming RPC and KaiaScan (and hitting 429s) when the agent issues many requests.
- **Resilience**: timeouts and 429 handling so one slow or rate-limited call does not hang or crash the server.

### 3.2 Token-Bucket Rate Limiter (src/utils/rate-limit.ts)

```typescript
// src/utils/rate-limit.ts (excerpt)

/**
 * Token bucket: tokens refill at requestsPerSecond per second.
 * acquire() returns a Promise that resolves when at least one token is available;
 * it then consumes one token. If no token is available, it waits and retries after
 * a short delay (waitMs derived from refill rate).
 */
export function createRateLimiter(requestsPerSecond: number): RateLimiter {
  if (requestsPerSecond <= 0) {
    throw new Error("requestsPerSecond must be positive");
  }

  let tokens = requestsPerSecond; // Start full
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000; // seconds
    tokens = Math.min(requestsPerSecond, tokens + elapsed * requestsPerSecond);
    lastRefill = now;
  }

  return {
    async acquire(): Promise<void> {
      return new Promise((resolve) => {
        function tryAcquire(): void {
          refill();
          if (tokens >= 1) {
            tokens -= 1;
            resolve();
            return;
          }
          const waitMs = ((1 - tokens) / requestsPerSecond) * 1000;
          setTimeout(tryAcquire, Math.max(1, Math.ceil(waitMs)));
        }
        tryAcquire();
      });
    },
  };
}
```

So: every call to `acquire()` eventually gets one token; if the bucket is empty, the caller waits. No token is consumed until `acquire()` resolves, so concurrency is naturally capped by the refill rate over time.

### 3.3 RPC Client: Rate Limiter + Timeout

```typescript
// src/clients/rpc.ts (excerpt)

const rpcLimiterCache = new Map<number, RateLimiter>();

function getRpcLimiter(requestsPerSecond: number) {
  let limiter = rpcLimiterCache.get(requestsPerSecond);
  if (!limiter) {
    limiter = createRateLimiter(requestsPerSecond);
    rpcLimiterCache.set(requestsPerSecond, limiter);
  }
  return limiter;
}

export function createRpcClient(network: KaiaNetwork, config?: Config): RpcClient {
  const c = config ?? getConfig();
  const url = network === "mainnet" ? c.kaiaRpcUrl : c.kaiaKairosRpcUrl;
  const chain = getChain(network);
  const limiter = getRpcLimiter(c.rateLimitRpc); // One limiter per rate value (shared)
  const timeoutMs = c.rpcTimeoutMs ?? 30000;

  const transport = http(url, {
    timeout: timeoutMs,
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      await limiter.acquire(); // Wait for token before every RPC request
      return fetch(input, init);
    },
  });

  return createPublicClient({ chain, transport });
}
```

So: every viem RPC request goes through the custom `fetchFn`, which first acquires a token. So RPC is limited to `rateLimitRpc` requests per second (e.g. 10). The viem `http` transport’s `timeout` ensures a single request does not hang longer than `rpcTimeoutMs`.

### 3.4 KaiaScan Client: Rate Limiter + Timeout + 429 Retry

```typescript
// src/clients/kaiascan.ts (excerpt)

export class KaiaScanRateLimitError extends Error {
  readonly status = 429;
  constructor(message = "KaiaScan API rate limit (429)") {
    super(message);
    this.name = "KaiaScanRateLimitError";
  }
}

async function doFetch<T>(path: string, params?: Record<string, string>, retry = false): Promise<T> {
  await limiter.acquire();
  const url = buildUrl(path, params, c.kaiascanApiKey);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ... });
    clearTimeout(id);
    if (res.status === 429) {
      if (!retry) {
        await new Promise((r) => setTimeout(r, 1500));  // Wait 1.5s then retry once
        return doFetch<T>(path, params, true);
      }
      throw new KaiaScanRateLimitError(`KaiaScan API rate limit: ${res.status} ${res.statusText}`);
    }
    // ...
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}
```

So: every KaiaScan request is rate-limited by `acquire()`, and has a timeout via `AbortController`. On 429, the client retries once after 1.5s; if it still gets 429, it throws `KaiaScanRateLimitError`, which `toMcpError` maps to MCP code `-32003` (RateLimit). Every other failure (HTTP error status, network error, timeout, non-JSON body) is a `KaiaScanApiError` (`-32004`); the request URL, which carries the API key, is never put into the error. So the agent (or the client app) can detect rate limiting and back off.

---

## 4. Summary

| Pattern           | Location                                                                     | Purpose                                                              |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Registry**      | `src/tools/index.ts`                                                         | Single list of tools + single dispatch for tools/list and tools/call |
| **Error mapping** | `src/utils/errors.ts` + `wrapToolHandler` in `src/server.ts`                 | Turn any throwable into MCP/JSON-RPC errors with stable codes        |
| **Rate limiting** | `src/utils/rate-limit.ts` + `src/clients/rpc.ts` + `src/clients/kaiascan.ts` | Token-bucket per client, timeout, and 429 retry for KaiaScan         |

Together, these make the server suitable for agent-driven load: discoverable tools, predictable errors, and bounded load on upstream RPC and APIs.

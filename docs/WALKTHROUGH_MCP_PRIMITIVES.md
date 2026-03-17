# Interactive Walkthrough: MCP Primitives (Tools, Resources, Prompts)

This document walks through the three MCP primitives in kaia-mcp with direct code references. Use it to understand how the agent discovers and uses each primitive.

---

## 1. How the Server Exposes Primitives

All three primitives are registered in `**src/server.ts**` when the server is created:

```typescript
// src/server.ts (excerpt)
export function createKaiaMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, wrapToolHandler(() => listTools()));
  server.setRequestHandler(CallToolRequestSchema, wrapToolHandler(async (request) => { ... }));

  server.setRequestHandler(ListResourcesRequestSchema, wrapToolHandler(() => listResources()));
  server.setRequestHandler(ReadResourceRequestSchema, wrapToolHandler(async (request) => { ... }));

  server.setRequestHandler(ListPromptsRequestSchema, wrapToolHandler(() => listPrompts()));
  server.setRequestHandler(GetPromptRequestSchema, wrapToolHandler(async (request) => { ... }));

  return server;
}
```

Every handler is wrapped with `wrapToolHandler`, which catches errors and maps them to MCP error codes before rethrowing. So tools, resources, and prompts all get consistent error handling.

---

## 2. Tools — Actions the Agent Can Execute

### 2.1 What a Tool Is

A **tool** has:

- **name** — unique identifier the agent uses to call it (e.g. `get_kaia_balance`)
- **description** — natural-language description the agent reads to decide when to use it
- **inputSchema** — JSON Schema describing required and optional arguments

### 2.2 Where Tools Are Defined

Each domain has its own file under `src/tools/`. For example, account tools live in `**src/tools/account.ts`**:

```typescript
// src/tools/account.ts (excerpt)
export const GET_KAIA_BALANCE = {
  name: "get_kaia_balance",
  description: "Get KAIA balance for an address. Returns formatted KAIA and raw peb.",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: { type: "string", description: "Ethereum-style address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["address"],
  },
};

export const ACCOUNT_TOOLS = [GET_KAIA_BALANCE, GET_ACCOUNT_INFO, GET_ACCOUNT_TOKENS, GET_ACCOUNT_NFTS];
```

The same file exports **handler functions** that perform the actual work (e.g. `handleGetKaiaBalance`). The agent never sees the handler; it only sees the tool definition and receives the result of the call.

### 2.3 How Tools Are Listed and Dispatched

The central registry is `**src/tools/index.ts`**:

- **listTools()** — aggregates every module’s tool array (`ACCOUNT_TOOLS`, `TRANSACTION_TOOLS`, etc.) into `ALL_TOOLS` and returns them for the MCP `tools/list` response.
- **callTool(name, args)** — switches on `name` and calls the corresponding handler (e.g. for `get_kaia_balance` it calls `handleGetKaiaBalance(a)`).

So when an agent calls `tools/list`, it gets all 25 tools with their names, descriptions, and input schemas. When it calls `tools/call` with a name and arguments, the server validates (inside each handler), runs the logic, and returns a `CallToolResult` with `content` (e.g. text).

### 2.4 Try It Mentally

1. Agent sends **tools/list** → server returns 25 tools, including `get_kaia_balance` with the schema above.
2. Agent decides to get a balance and sends **tools/call** with `name: "get_kaia_balance"` and `arguments: { address: "0x...", network: "mainnet" }`.
3. Server runs `handleGetKaiaBalance`, which uses `createRpcClient("mainnet")` and `getBalance`, then formats and returns text like `Balance: 1.5 KAIA (1500000000000000000 peb)`.

---

## 3. Resources — Read-Only Data by URI

### 3.1 What a Resource Is

A **resource** is a URI that the agent can read. It does not take arbitrary arguments; the URI itself is the key. Resources are for stable, read-only data (status, token lists, docs).

### 3.2 Where Resources Are Defined

`**src/resources/index.ts`** defines the list and the URI constants:

```typescript
// src/resources/index.ts (excerpt)
const RESOURCE_MAINNET_STATUS = "kaia://mainnet/status";
const RESOURCE_KAIROS_STATUS = "kaia://kairos/status";
const RESOURCE_MAINNET_TOKENS_POPULAR = "kaia://mainnet/tokens/popular";
const RESOURCE_MAINNET_TOP_ACCOUNTS = "kaia://mainnet/top-accounts";
const RESOURCE_DOCS_RPC_METHODS = "kaia://docs/rpc-methods";

const ALL_RESOURCES = [
  { uri: RESOURCE_MAINNET_STATUS, name: "Mainnet status", description: "..." },
  // ...
];
```

**listResources()** returns these entries for the MCP `resources/list` response. The agent then chooses a URI and calls **resources/read** with that URI.

### 3.3 How a Resource Is Read

**readResource(uri)** in the same file:

1. Validates that the URI starts with `kaia://`; otherwise throws `McpError` with `InvalidParams`.
2. Dispatches on the exact URI (e.g. `kaia://mainnet/status` → `fetchNetworkStatus("mainnet")`).
3. Returns a **ReadResourceResult** with `contents: [{ uri, mimeType, text }]`. Most resources are `text/plain`; `kaia://docs/rpc-methods` is `text/markdown`.

So resources are a fixed set of URIs; adding a new resource means adding a new URI constant, a new entry in `ALL_RESOURCES`, and a new branch in `readResource`.

### 3.4 Try It Mentally

1. Agent sends **resources/list** → server returns the five resources with their URIs and descriptions.
2. Agent sends **resources/read** with `uri: "kaia://mainnet/status"`.
3. Server runs `fetchNetworkStatus("mainnet")` (RPC + KaiaScan), formats block height, gas price, KAIA price into text, and returns it.

---

## 4. Prompts — Reusable Prompt Templates with Arguments

### 4.1 What a Prompt Is

A **prompt** is a named template that takes arguments and produces a **user message** the agent can use as the starting instruction. It does not call RPC or KaiaScan itself; it just fills in a string. The agent is expected to then use tools/resources to fulfill that instruction.

### 4.2 Where Prompts Are Defined

`**src/prompts/index.ts`** defines the `PROMPTS` array:

```typescript
// src/prompts/index.ts (excerpt)
const PROMPTS: PromptDef[] = [
  {
    name: "analyze-wallet",
    description: "Analyze a Kaia wallet: balance, recent transactions, and token holdings.",
    arguments: [
      { name: "address", description: "Wallet address (0x...)", required: true },
      { name: "network", description: "Network: mainnet or kairos", required: false },
    ],
    template: (args) =>
      `Analyze the wallet ${args.address} on Kaia ${args.network}. Show balance, recent transactions, and token holdings.`,
  },
  // ... five more prompts
];
```

Each prompt has:

- **name** — used in `prompts/get`
- **description** — what the prompt is for
- **arguments** — name, optional description, and whether required
- **template** — function that takes resolved args and returns the final prompt text

### 4.3 How Prompts Are Listed and Resolved

- **listPrompts()** — returns each prompt’s name, description, and arguments (with `required` flags) for the MCP `prompts/list` response.
- **getPrompt(name, args)**:
  1. Finds the prompt by name; if not found, throws `McpError` with `InvalidParams`.
  2. For each argument, if required and missing/empty, throws; otherwise optional args default (e.g. `network` → `"mainnet"`).
  3. Calls `def.template(resolved)` to get the text.
  4. Returns **GetPromptResult** with `messages: [{ role: "user", content: { type: "text", text } }]`.

So the client gets a ready-to-use user message it can inject into the conversation; the agent then uses tools and resources to answer it.

### 4.4 Try It Mentally

1. Agent sends **prompts/list** → server returns six prompts, including `analyze-wallet` with arguments `address` (required) and `network` (optional).
2. Agent sends **prompts/get** with `name: "analyze-wallet"` and `arguments: { address: "0x..." }` (no network).
3. Server resolves `network` to `"mainnet"`, runs the template, and returns one user message: *"Analyze the wallet 0x... on Kaia mainnet. Show balance, recent transactions, and token holdings."*

---

## 5. Summary Table


| Primitive | List method       | Use method              | Defined in                             | Purpose                          |
| --------- | ----------------- | ----------------------- | -------------------------------------- | -------------------------------- |
| Tools     | `listTools()`     | `callTool(name, args)`  | `src/tools/*.ts`, `src/tools/index.ts` | Execute actions (RPC, API calls) |
| Resources | `listResources()` | `readResource(uri)`     | `src/resources/index.ts`               | Read-only data by URI            |
| Prompts   | `listPrompts()`   | `getPrompt(name, args)` | `src/prompts/index.ts`                 | Templated user instructions      |


All three are registered in `**src/server.ts`** with the same error-handling wrapper, so behavior is consistent across primitives.
# Hands-On: Adding a New Tool (DeFi Example)

This guide walks through adding a new MCP tool to kaia-mcp using **get_token_allowance** as the example. After reading this and the code changes, you can add your own tools by following the same pattern.

---

## What We Added

**get_token_allowance** — An ERC-20/KIP-7 DeFi primitive that returns the amount a `spender` can transfer from an `owner` for a given token. Agents can use it to check approvals before suggesting swaps or staking.

- **Inputs**: `tokenAddress`, `owner`, `spender`, optional `network`, optional `decimals`
- **Output**: Plain text with raw allowance and human-readable amount
- **Implementation**: RPC only (viem `readContract` with the standard `allowance(address,address)` ABI)

---

## Step 1: Define the Tool and Handler in a Module

We added the tool to **`src/tools/token.ts`** because it is token-related. For a new domain you could create a new file (e.g. `src/tools/defi.ts`).

### 1a. Tool definition (name, description, inputSchema)

The agent sees only these fields when it calls `tools/list`. The description should tell the agent when and how to use the tool.

```typescript
export const GET_TOKEN_ALLOWANCE = {
  name: "get_token_allowance",
  description:
    "Get ERC-20/KIP-7 allowance: the amount a spender can transfer from an owner. Use for DeFi approvals (e.g. DEX, staking). Returns raw allowance and human-readable amount if decimals known.",
  inputSchema: {
    type: "object" as const,
    properties: {
      tokenAddress: { type: "string", description: "Token contract address (0x...)" },
      owner: { type: "string", description: "Owner address (0x...)" },
      spender: { type: "string", description: "Spender address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
      decimals: {
        type: "number",
        description: "Optional token decimals for human-readable output (default: 18)",
      },
    },
    required: ["tokenAddress", "owner", "spender"],
  },
};
```

Add the new tool to the module’s export array:

```typescript
export const TOKEN_TOOLS = [
  GET_TOKEN_INFO,
  GET_TOKEN_HOLDERS,
  GET_TOKEN_TRANSFERS,
  GET_TOKEN_ALLOWANCE,
];
```

### 1b. Handler function

The handler:

1. Validates inputs with shared helpers (`validateAddress`, `validateNetwork`).
2. Calls RPC or KaiaScan (here: `createRpcClient(network)` and viem’s `readContract`).
3. Returns `{ content: [{ type: "text", text: "..." }] }`.

For `get_token_allowance` we use a minimal ABI and `readContract` from viem. See the full implementation in `src/tools/token.ts` (ALLOWANCE_ABI and handleGetTokenAllowance).

---

## Step 2: Register in the Central Registry

**`src/tools/index.ts`** is the single registry.

1. **Import** the new handler and (if needed) the new tool constant:

   ```typescript
   import {
     TOKEN_TOOLS,
     handleGetTokenInfo,
     handleGetTokenHolders,
     handleGetTokenTransfers,
     handleGetTokenAllowance,
   } from "./token.js";
   ```

2. **Re-export** the tool constant if you want it available to other code:

   ```typescript
   export {
     TOKEN_TOOLS,
     GET_TOKEN_INFO,
     GET_TOKEN_HOLDERS,
     GET_TOKEN_TRANSFERS,
     GET_TOKEN_ALLOWANCE,
   } from "./token.js";
   ```

3. **Add a case** in `callTool()`:

   ```typescript
   case "get_token_allowance":
     return { ...(await handleGetTokenAllowance(a)), _meta: {} };
   ```

The `ALL_TOOLS` array already includes `...TOKEN_TOOLS`, so once the new tool is in `TOKEN_TOOLS`, `listTools()` will expose it automatically. No change to `listTools()` is required.

---

## Step 3: Unit Tests

Add tests in the same module’s test file: **`src/tools/token.test.ts`**.

- **Mock** external dependencies:
  - `createRpcClient` (return a dummy client if the handler only passes it to another function).
  - For handlers that use viem’s `readContract(client, options)` directly, mock `readContract` from `viem` (see the `vi.mock("viem", ...)` and `mockReadContract` setup in the file).
- **Test**:
  - Happy path: valid args, assert on the returned text (e.g. “Allowance (raw):”, “Owner:”, “Spender:”) and that the right client/readContract calls were made.
  - Defaults: e.g. missing `network` defaults to mainnet, missing `decimals` defaults to 18.
  - Validation: invalid address (owner, spender, or tokenAddress) throws with a clear message.

---

## Step 4: Update Server-Level Tests

**`src/server.test.ts`** asserts the total number of tools and the sorted list of tool names.

- Change the expected count (e.g. from 25 to 26).
- Add the new tool name to the expected sorted array (e.g. `"get_token_allowance"` in alphabetical order).

---

## Step 5: Update Documentation

- **README.md**: Update the tool count in the intro and in the “Tools” section; add a row for the new tool in the tools table.
- Optionally add a short note in **CONTRIBUTING.md** or a phase report if you keep one.

---

## Checklist for Your Next Tool

- [ ] Add tool definition (name, description, inputSchema) in the right module.
- [ ] Add handler that validates inputs, calls RPC/KaiaScan, and returns `{ content: [{ type: "text", text }] }`.
- [ ] Append the tool to the module’s tools array (e.g. TOKEN_TOOLS).
- [ ] In `src/tools/index.ts`: import handler, add `case "tool_name": return ... handleX(a) ...` in `callTool()`.
- [ ] Add unit tests (happy path, defaults, validation).
- [ ] Update server.test.ts (tool count and names).
- [ ] Update README (and any other docs).

Using this pattern keeps the registry explicit, keeps tool logic and discovery in one place, and ensures new tools are tested and documented.

# Contributing to Kaia MCP Server

Thanks for your interest in contributing. This document covers how to set up the repo, run tests, add a new tool, and open a PR.

## Clone and install

```bash
git clone https://github.com/naveed949/kaia-mcp.git
cd kaia-mcp
npm install
```

## Build and test

```bash
npm run build    # compile TypeScript to dist/
npm test         # unit tests (no integration by default)
npm run test:integration   # integration tests (spawns server, needs network)
```

To run the optional live tests (real RPC and KaiaScan):

```bash
LIVE_TESTS=1 npm test
```

## Lint and format

```bash
npm run lint     # ESLint
npm run format   # Prettier
```

## Adding a new tool

1. **Define the tool** in the appropriate module under `src/tools/` (e.g. `src/tools/network.ts`), or create a new file and export from `src/tools/index.ts`:
   - Add a constant object with `name`, `description`, and `inputSchema` (JSON Schema).
   - Export a handler function (e.g. `handleMyTool`) that accepts parsed args and returns `{ content: Array<{ type: "text"; text: string }> }`.
   - Use `createRpcClient(network)` or `createKaiaScanClient()` for RPC/API calls; use `validateNetwork`, `validateAddress`, etc. from `src/utils/validation.ts` for inputs.

2. **Register the tool** in `src/tools/index.ts`:
   - Add the tool to the appropriate `*_TOOLS` array and to `ALL_TOOLS`.
   - In `callTool()`, add a `case "my_tool_name": return { ...(await handleMyTool(a)), _meta: {} };`.

3. **Add unit tests** in the same directory (e.g. `src/tools/mymodule.test.ts`). Mock `createRpcClient` and `createKaiaScanClient` with `vi.mock()` so tests do not hit the network. Assert success and validation-error cases.

4. **Run tests**: `npm test`

## PR process

1. Branch from `main` (e.g. `feature/my-tool` or `fix/issue-123`).
2. Make your changes; ensure `npm run build` and `npm test` pass.
3. Run `npm run lint` and `npm run format` if applicable.
4. Open a Pull Request with a clear description and reference any issue.
5. Maintainers will review and may request changes.

## Code style

- **TypeScript**: Strict mode; use types for public APIs.
- **Formatting**: Prettier (run `npm run format`).
- **Linting**: ESLint (run `npm run lint`). Fix any reported issues before submitting.

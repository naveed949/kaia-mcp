import { beforeEach, describe, expect, it } from "vitest";
import { authorizeToolCall, filterToolsByAuth } from "./scopes.js";
import { AUTH_ERRORS, SCOPES, insufficientScopeError } from "./constants.js";
import { resetConfigCache } from "../config.js";
import type { AuthContext } from "./types.js";

const ctx = (scopes: string[], exp = Date.now() + 60_000): AuthContext => ({
  subject: "demo-user",
  clientId: "kaia-mcp-demo",
  scopes,
  expiresAtMs: exp,
  tokenFingerprint: "aaaaaaaaaaaa",
});

describe("authorizeToolCall", () => {
  beforeEach(() => {
    delete process.env.KAIA_ALLOW_UNSAFE_WALLET;
    resetConfigCache();
  });

  it("allows encode_function_data with kaia:encode", () => {
    expect(() =>
      authorizeToolCall("encode_function_data", { requireAuth: true, auth: ctx([SCOPES.ENCODE]) })
    ).not.toThrow();
  });

  it("denies encode_function_data with kaia:read", () => {
    const denied = insufficientScopeError("encode_function_data", SCOPES.ENCODE);
    expect(() =>
      authorizeToolCall("encode_function_data", { requireAuth: true, auth: ctx([SCOPES.READ]) })
    ).toThrowError(denied.message);
  });

  it("filters generate_wallet out of the default registry", () => {
    const tools = filterToolsByAuth([{ name: "get_chain_info" }, { name: "generate_wallet" }], {
      requireAuth: true,
      auth: ctx([SCOPES.READ, SCOPES.WALLET]),
    });
    expect(tools.map((t) => t.name)).toEqual(["get_chain_info"]);
  });

  it("fails closed when auth is missing", () => {
    expect(() => authorizeToolCall("get_chain_info", { requireAuth: true, auth: null })).toThrowError(
      AUTH_ERRORS.UNAUTHORIZED.message
    );
  });
});

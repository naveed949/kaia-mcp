import { describe, it, expect } from "vitest";
import { toMcpError, MCP_ERROR_CODES } from "./errors.js";

describe("toMcpError", () => {
  it("maps unknown throwable to Internal error", () => {
    const result = toMcpError("something broke");
    expect(result.code).toBe(MCP_ERROR_CODES.InternalError);
    expect(result.message).toBe("something broke");
  });

  it("uses Error message when given Error", () => {
    const result = toMcpError(new Error("Custom message"));
    expect(result.code).toBe(MCP_ERROR_CODES.InternalError);
    expect(result.message).toBe("Custom message");
  });

  it("maps network-like error (code ECONNREFUSED) to RPC provider error", () => {
    const err = new Error("connect ECONNREFUSED") as Error & { code: string };
    err.code = "ECONNREFUSED";
    const result = toMcpError(err);
    expect(result.code).toBe(MCP_ERROR_CODES.RpcProviderError);
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("maps ETIMEDOUT to RPC provider error", () => {
    const err = new Error("timeout") as Error & { code: string };
    err.code = "ETIMEDOUT";
    const result = toMcpError(err);
    expect(result.code).toBe(MCP_ERROR_CODES.RpcProviderError);
  });

  it("maps rate limit (429) to Rate limit code", () => {
    const err = new Error("Too Many Requests") as Error & { status: number };
    err.status = 429;
    const result = toMcpError(err);
    expect(result.code).toBe(MCP_ERROR_CODES.RateLimit);
  });

  it("maps null/undefined to Internal error with generic message", () => {
    const r1 = toMcpError(null);
    expect(r1.code).toBe(MCP_ERROR_CODES.InternalError);
    expect(r1.message).toBe("Internal error");

    const r2 = toMcpError(undefined);
    expect(r2.code).toBe(MCP_ERROR_CODES.InternalError);
  });
});

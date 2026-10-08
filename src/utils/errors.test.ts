import {
  AuthError,
  InvalidParamsError,
  KaiaScanApiError,
  KaiaScanRateLimitError,
  MCP_ERROR_CODES,
  describeFailure,
  toMcpError,
} from "./errors.js";
import {
  HttpRequestError,
  InvalidParamsRpcError,
  MethodNotFoundRpcError,
  RpcRequestError,
} from "viem";
import { describe, it, expect } from "vitest";
import { AUTH_ERRORS } from "../auth/constants.js";

describe("toMcpError", () => {
  it("maps an unknown throwable to a generic Internal error", () => {
    const result = toMcpError("something broke");
    expect(result).toEqual({ code: MCP_ERROR_CODES.InternalError, message: "Internal error" });
  });

  it("never hands an unexpected exception's text to the caller", () => {
    const result = toMcpError(new Error("Custom message at /srv/kaia/secret.ts:12"));
    expect(result).toEqual({ code: MCP_ERROR_CODES.InternalError, message: "Internal error" });
    expect(describeFailure(new Error("Custom message")).detail).toBe("Custom message");
  });

  it("maps a network-like error (code ECONNREFUSED) to RPC provider error, generic text", () => {
    const err = new Error("connect ECONNREFUSED 10.0.0.1:8545") as Error & { code: string };
    err.code = "ECONNREFUSED";
    const result = toMcpError(err);
    expect(result).toEqual({
      code: MCP_ERROR_CODES.RpcProviderError,
      message: "Upstream request failed.",
    });
    expect(describeFailure(err).detail).toContain("ECONNREFUSED");
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

  it("maps AuthError to its fail-closed code and does not embed the raw error object", () => {
    const result = toMcpError(new AuthError(AUTH_ERRORS.UNAUTHORIZED));
    expect(result).toEqual({
      code: MCP_ERROR_CODES.Unauthorized,
      message: "unauthorized: missing access token",
      data: { error: "unauthorized" },
    });
  });

  it("maps null/undefined to Internal error with generic message", () => {
    const r1 = toMcpError(null);
    expect(r1.code).toBe(MCP_ERROR_CODES.InternalError);
    expect(r1.message).toBe("Internal error");

    const r2 = toMcpError(undefined);
    expect(r2.code).toBe(MCP_ERROR_CODES.InternalError);
  });
});

describe("InvalidParamsError", () => {
  it("carries JSON-RPC InvalidParams (-32602)", () => {
    const e = new InvalidParamsError("x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("InvalidParamsError");
    expect(e.code).toBe(MCP_ERROR_CODES.InvalidParams);
    expect(e.code).toBe(-32602);
    expect(toMcpError(e)).toEqual({ code: -32602, message: "x" });
  });
});

describe("upstream faults are never caller mistakes (M1)", () => {
  const URL_WITH_KEY = "https://rpc.example.test/v2/FAKEKEY1234567890abcdef?apikey=QK1";
  const rpcErr = (code: number) =>
    new RpcRequestError({
      body: { method: "eth_blockNumber", params: [] },
      error: { code, message: `upstream says ${code}` },
      url: URL_WITH_KEY,
    });

  for (const code of [-32700, -32600, -32601, -32602, -32042, -32603, -32000, -32005]) {
    it(`an RPC node answering ${code} maps to -32001, generic text, no data but the code`, () => {
      const result = toMcpError(rpcErr(code));
      expect(result).toEqual({
        code: MCP_ERROR_CODES.RpcProviderError,
        message: "Upstream RPC request failed.",
        data: { upstreamCode: code },
      });
      expect(JSON.stringify(result)).not.toMatch(/FAKEKEY|apikey|eth_blockNumber|upstream says/);
    });
  }

  it("viem's specific RPC error classes (InvalidParamsRpcError, ...) map to -32001", () => {
    for (const E of [InvalidParamsRpcError, MethodNotFoundRpcError]) {
      const e = new E(rpcErr(E === InvalidParamsRpcError ? -32602 : -32601));
      expect(toMcpError(e).code).toBe(MCP_ERROR_CODES.RpcProviderError);
    }
  });

  it("HTTP 429 from the RPC provider is a rate limit; other HTTP errors are -32001", () => {
    const h429 = new HttpRequestError({ status: 429, url: URL_WITH_KEY, details: "slow" });
    expect(toMcpError(h429)).toEqual({
      code: MCP_ERROR_CODES.RateLimit,
      message: "Upstream RPC rate limit reached; retry later.",
      data: { upstreamStatus: 429 },
    });
    const h500 = new HttpRequestError({ status: 500, url: URL_WITH_KEY, body: { a: 1 } });
    expect(toMcpError(h500)).toEqual({
      code: MCP_ERROR_CODES.RpcProviderError,
      message: "Upstream RPC request failed.",
      data: { upstreamStatus: 500 },
    });
  });

  it("the log detail never carries the URL or request body viem puts in its message", () => {
    const h500 = new HttpRequestError({ status: 500, url: URL_WITH_KEY, body: { a: "BODY" } });
    expect(h500.message).toContain("FAKEKEY");
    const d = describeFailure(h500).detail;
    expect(d).not.toMatch(/FAKEKEY|apikey|BODY/);
  });

  it("caller text containing 429 inside an RPC request body does not make it a rate limit", () => {
    const e = new RpcRequestError({
      body: { method: "eth_call", params: [{ to: "0x4290000000000000000000000000000000000429" }] },
      error: { code: -32000, message: "execution reverted" },
      url: URL_WITH_KEY,
    });
    expect(toMcpError(e).code).toBe(MCP_ERROR_CODES.RpcProviderError);
  });

  it("a KaiaScan failure is -32004 (not -32002, which the SDK rewrites to -32602)", () => {
    expect(MCP_ERROR_CODES.KaiaScanApiError).toBe(-32004);
    const e = KaiaScanApiError.wrap("token holders", new KaiaScanApiError({ status: 503 }));
    expect(toMcpError(e)).toEqual({
      code: -32004,
      message: "KaiaScan API request failed (token holders): HTTP 503.",
      data: { upstreamStatus: 503 },
    });
  });

  it("a KaiaScan network error keeps its cause out of the caller's answer", () => {
    const cause = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED https://api.kaiascan.io/?apikey=K"), {
        code: "ECONNREFUSED",
      }),
    });
    const e = KaiaScanApiError.wrap("NFT item", new KaiaScanApiError({ cause }));
    expect(toMcpError(e)).toEqual({
      code: -32004,
      message: "KaiaScan API request failed (NFT item).",
    });
    const d = describeFailure(e).detail;
    expect(d).toContain("ECONNREFUSED");
    expect(d).not.toContain("apikey");
  });

  it("KaiaScan 429 (after the retry) is a rate limit, also when re-labelled", () => {
    const e = KaiaScanApiError.wrap("Kaia price", new KaiaScanRateLimitError());
    expect(e).toBeInstanceOf(KaiaScanRateLimitError);
    expect(toMcpError(e)).toEqual({
      code: MCP_ERROR_CODES.RateLimit,
      message: "KaiaScan API rate limit reached; retry later.",
      data: { upstreamStatus: 429 },
    });
  });

  it("only kaia's own InvalidParamsError and AuthError keep their messages", () => {
    expect(toMcpError(new InvalidParamsError("Invalid address: x"))).toEqual({
      code: -32602,
      message: "Invalid address: x",
    });
    // A foreign error that merely carries code -32602 is not a caller mistake.
    const foreign = Object.assign(new Error("Invalid params from upstream"), { code: -32602 });
    expect(toMcpError(foreign)).toEqual({ code: -32603, message: "Internal error" });
  });
});

/**
 * PR #9 round 3 (verify r2 L-1, L-2, C09).
 * - L-1: `error.data.upstreamCode` is only ever a safe integer; a string or object `code`
 *   from a hostile or broken node (which can carry its URL, key or a token) never reaches
 *   the caller.
 * - L-2: a rate limit is recognised only from structured upstream signals (HTTP 429, or the
 *   JSON-RPC codes 429 and -32007), never from text, which can carry a contract's revert
 *   reason or the caller's function name.
 * - C09: a timeout says so.
 */
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  encodeErrorResult,
} from "viem";
import { describe, expect, it } from "vitest";
import { MCP_ERROR_CODES, describeFailure, toMcpError } from "./errors.js";
import { REDACT_INPUT_MAX_CHARS } from "./redact.js";

const URL_WITH_KEY = "https://rpc.example.test/v2/FAKEKEY1234567890abcdef?apikey=QK1";
const rpcErr = (code: unknown, message = "upstream says no") =>
  new RpcRequestError({
    body: { method: "eth_call", params: [] },
    error: { code: code as number, message },
    url: URL_WITH_KEY,
  });
const FAILED = { code: MCP_ERROR_CODES.RpcProviderError, message: "Upstream RPC request failed." };

describe("L-1: only a safe-integer upstream code reaches error.data", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = [b64({ alg: "RS256" }), b64({ sub: "x" }), "c2ln"].join(".");
  const HOSTILE: unknown[] = [
    `${URL_WITH_KEY} ${jwt}`,
    "-32602",
    { url: URL_WITH_KEY },
    [429],
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 60,
    null,
    true,
  ];
  for (const code of HOSTILE) {
    it(`a node answering code ${JSON.stringify(String(code))} gives no upstreamCode`, () => {
      const e = rpcErr(code);
      expect(toMcpError(e)).toEqual(FAILED);
      expect(describeFailure(e).upstreamCode).toBeUndefined();
      expect(JSON.stringify(toMcpError(e))).not.toMatch(/FAKEKEY|apikey|eyJ/);
    });
  }

  it("the same holds for a coded error deeper in the chain (the fallback walk)", () => {
    const inner = Object.assign(new BaseError("inner"), { code: "FAKEKEY1234567890abcdef" });
    expect(toMcpError(new BaseError("outer", { cause: inner }))).toEqual(FAILED);
    const float = Object.assign(new BaseError("inner"), { code: 3.25 });
    expect(describeFailure(new BaseError("outer", { cause: float })).upstreamCode).toBeUndefined();
    const ok = Object.assign(new BaseError("inner"), { code: -32010 });
    expect(describeFailure(new BaseError("outer", { cause: ok })).upstreamCode).toBe(-32010);
    // A non-integer code higher in the chain is skipped, not taken as "the" code: the walk
    // goes on to the integer one below it (a string network code over a node's code).
    const deep = Object.assign(new BaseError("deep"), { code: -32010 });
    const mid = Object.assign(new BaseError("mid", { cause: deep }), { code: "ECONNRESET" });
    expect(describeFailure(new BaseError("outer", { cause: mid })).upstreamCode).toBe(-32010);
  });

  it("integer codes still pass through, negative and positive", () => {
    for (const code of [-32000, -32602, 3, 0, 4001]) {
      expect(toMcpError(rpcErr(code))).toEqual({ ...FAILED, data: { upstreamCode: code } });
    }
  });
});

describe("L-2: rate limits come from structured signals only", () => {
  const RATE = {
    code: MCP_ERROR_CODES.RateLimit,
    message: "Upstream RPC rate limit reached; retry later.",
  };

  it("JSON-RPC code 429 (Alchemy, Infura) and -32007 (QuickNode) are rate limits", () => {
    expect(toMcpError(rpcErr(429, "Your app has exceeded its compute units"))).toEqual({
      ...RATE,
      data: { upstreamCode: 429 },
    });
    expect(toMcpError(rpcErr(-32007, "10/second request limit reached"))).toEqual({
      ...RATE,
      data: { upstreamCode: -32007 },
    });
  });

  it("HTTP 429 is a rate limit, whatever the body says", () => {
    const e = new HttpRequestError({ status: 429, url: URL_WITH_KEY, details: "ok" });
    expect(toMcpError(e)).toEqual({ ...RATE, data: { upstreamStatus: 429 } });
  });

  it("rate-limit words in the node's text are not a rate limit (any code, any status)", () => {
    for (const text of ["rate limit exceeded", "Too Many Requests", "rate-limited", "ratelimit"]) {
      expect(toMcpError(rpcErr(-32000, text)), text).toEqual({
        ...FAILED,
        data: { upstreamCode: -32000 },
      });
      const h = new HttpRequestError({ status: 503, url: URL_WITH_KEY, details: text });
      expect(toMcpError(h).code, text).toBe(MCP_ERROR_CODES.RpcProviderError);
    }
  });

  it("-32005 (limit exceeded: also a result-size limit) stays an RPC failure", () => {
    expect(toMcpError(rpcErr(-32005, "limit exceeded")).code).toBe(
      MCP_ERROR_CODES.RpcProviderError
    );
  });

  it("a function named rateLimit that reverts 'paused' is an RPC failure, not a rate limit", () => {
    const abi = [
      {
        type: "function",
        name: "rateLimit",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const;
    // viem's revert error: its shortMessage names the function and quotes the reason.
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "", type: "string" }] }],
      errorName: "Error",
      args: ["paused"],
    });
    const revert = new ContractFunctionRevertedError({ abi, data, functionName: "rateLimit" });
    const e = new ContractFunctionExecutionError(revert, {
      abi,
      functionName: "rateLimit",
      args: [],
      contractAddress: "0x1234567890123456789012345678901234567890",
    });
    expect(describeFailure(e).detail).toContain('"rateLimit" reverted');
    expect(describeFailure(e).detail).toContain("paused");
    expect(toMcpError(e)).toEqual(FAILED);
  });
});

describe("M-1: the RPC detail is bounded at the source", () => {
  it("a 1 MB node message gives a detail of at most REDACT_INPUT_MAX_CHARS + 1 characters", () => {
    const huge = "eyJ".repeat(350_000);
    const d = describeFailure(rpcErr(3, `execution reverted: ${huge}`)).detail;
    expect(d.length).toBeLessThanOrEqual(REDACT_INPUT_MAX_CHARS + 1);
    expect(d).toBe("RPC Request failed. | execution reverted: \u2026");
  });
});

describe("C09: a timeout answers the timed-out message", () => {
  it("TimeoutError, bare or wrapped, gives 'Upstream RPC request timed out.'", () => {
    const t = new TimeoutError({ body: { method: "eth_call" }, url: URL_WITH_KEY });
    const timedOut = {
      code: MCP_ERROR_CODES.RpcProviderError,
      message: "Upstream RPC request timed out.",
    };
    expect(toMcpError(t)).toEqual(timedOut);
    expect(toMcpError(new BaseError("outer", { cause: t }))).toEqual(timedOut);
    expect(toMcpError(rpcErr(-32000, "timed out")).message).toBe("Upstream RPC request failed.");
  });
});

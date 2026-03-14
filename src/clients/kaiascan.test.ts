import { describe, it, expect, beforeEach, vi } from "vitest";
import { createKaiaScanClient, KaiaScanRateLimitError } from "./kaiascan.js";
import { resetConfigCache } from "../config.js";
import { toMcpError, MCP_ERROR_CODES } from "../utils/errors.js";

describe("createKaiaScanClient", () => {
  beforeEach(() => {
    resetConfigCache();
    process.env.KAIA_RPC_URL = "https://public-en.node.kaia.io";
    process.env.KAIA_KAIROS_RPC_URL = "https://public-en-kairos.node.kaia.io";
    vi.restoreAllMocks();
  });

  it("returns object with get method", () => {
    const client = createKaiaScanClient();
    expect(typeof client.get).toBe("function");
  });

  it("accepts optional config override", () => {
    const client = createKaiaScanClient({
      kaiaRpcUrl: "https://a.io",
      kaiaKairosRpcUrl: "https://b.io",
      kaiascanApiKey: "key",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 10,
      rateLimitKaiascan: 5,
      rpcTimeoutMs: 30000,
      kaiascanTimeoutMs: 15000,
    });
    expect(typeof client.get).toBe("function");
  });

  it("on 429 after retry throws KaiaScanRateLimitError which toMcpError maps to RateLimit", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount += 1;
        return Promise.resolve({
          status: 429,
          statusText: "Too Many Requests",
          ok: false,
          json: () => Promise.resolve({}),
        } as Response);
      })
    );
    const client = createKaiaScanClient({
      kaiaRpcUrl: "https://a.io",
      kaiaKairosRpcUrl: "https://b.io",
      kaiascanApiKey: "",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 10,
      rateLimitKaiascan: 5,
      rpcTimeoutMs: 30000,
      kaiascanTimeoutMs: 15000,
    });
    await expect(client.get("/api")).rejects.toThrow(KaiaScanRateLimitError);
    const err = new KaiaScanRateLimitError();
    expect(toMcpError(err).code).toBe(MCP_ERROR_CODES.RateLimit);
  });
});

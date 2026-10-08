import { describe, it, expect, beforeEach } from "vitest";
import { createRpcClient } from "./rpc.js";
import { resetConfigCache } from "../config.js";

describe("createRpcClient", () => {
  beforeEach(() => {
    resetConfigCache();
    // Use default env so getConfig() succeeds
    process.env.KAIA_RPC_URL = "https://public-en.node.kaia.io";
    process.env.KAIA_KAIROS_RPC_URL = "https://public-en-kairos.node.kaia.io";
  });

  it("returns object with viem public client methods (getBlockNumber)", () => {
    const client = createRpcClient("mainnet");
    expect(typeof client.getBlockNumber).toBe("function");
  });

  it("returns object with getChainId for mainnet", () => {
    const client = createRpcClient("mainnet");
    expect(typeof client.getChainId).toBe("function");
  });

  it("accepts optional config override", () => {
    const client = createRpcClient("mainnet", {
      kaiaRpcUrl: "https://custom.node.kaia.io",
      kaiaKairosRpcUrl: "https://custom-kairos.node.kaia.io",
      kaiascanApiKey: "",
      defaultNetwork: "mainnet",
      logLevel: "info",
      rateLimitRpc: 10,
      rateLimitKaiascan: 5,
      rpcTimeoutMs: 30000,
      kaiascanTimeoutMs: 15000,
      authMode: "required",
      allowUnsafeWallet: false,
      oauthClientId: "kaia-mcp-demo",
      accessTokenTtlSeconds: 900,
      oauthRequireResource: false,
      allowedOrigins: [],
      oauthPreviousSigningKeyFiles: [],
      introspectionClientId: "kaia-mcp-gateway",
    });
    expect(typeof client.getBlockNumber).toBe("function");
  });
});

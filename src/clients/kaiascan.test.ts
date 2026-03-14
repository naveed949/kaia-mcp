import { describe, it, expect, beforeEach } from "vitest";
import { createKaiaScanClient } from "./kaiascan.js";
import { resetConfigCache } from "../config.js";

describe("createKaiaScanClient", () => {
  beforeEach(() => {
    resetConfigCache();
    process.env.KAIA_RPC_URL = "https://public-en.node.kaia.io";
    process.env.KAIA_KAIROS_RPC_URL = "https://public-en-kairos.node.kaia.io";
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
    });
    expect(typeof client.get).toBe("function");
  });
});

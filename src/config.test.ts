import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig, resetConfigCache } from "./config.js";

describe("getConfig", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfigCache();
    // Backup env vars we might override
    const keys = [
      "KAIA_RPC_URL",
      "KAIA_KAIROS_RPC_URL",
      "KAIASCAN_API_KEY",
      "KAIA_DEFAULT_NETWORK",
      "LOG_LEVEL",
      "RATE_LIMIT_RPC",
      "RATE_LIMIT_KAIASCAN",
      "RPC_TIMEOUT_MS",
      "KAIASCAN_TIMEOUT_MS",
      "KAIA_AUTH_MODE",
      "KAIA_ALLOW_UNSAFE_WALLET",
      "KAIA_OAUTH_CLIENT_ID",
      "KAIA_ACCESS_TOKEN_TTL_SECONDS",
    ];
    for (const k of keys) {
      envBackup[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("returns valid config with default env", () => {
    // Clear so we use defaults
    delete process.env.KAIA_RPC_URL;
    delete process.env.KAIA_KAIROS_RPC_URL;
    delete process.env.KAIASCAN_API_KEY;
    delete process.env.KAIA_DEFAULT_NETWORK;
    delete process.env.LOG_LEVEL;
    delete process.env.RATE_LIMIT_RPC;
    delete process.env.RATE_LIMIT_KAIASCAN;
    delete process.env.RPC_TIMEOUT_MS;
    delete process.env.KAIASCAN_TIMEOUT_MS;
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.KAIA_ALLOW_UNSAFE_WALLET;
    delete process.env.KAIA_OAUTH_CLIENT_ID;
    delete process.env.KAIA_ACCESS_TOKEN_TTL_SECONDS;

    const config = getConfig();
    expect(config.kaiaRpcUrl).toBe("https://public-en.node.kaia.io");
    expect(config.kaiaKairosRpcUrl).toBe("https://public-en-kairos.node.kaia.io");
    expect(config.defaultNetwork).toBe("mainnet");
    expect(config.logLevel).toBe("info");
    expect(config.rateLimitRpc).toBe(10);
    expect(config.rateLimitKaiascan).toBe(5);
    expect(config.rpcTimeoutMs).toBe(30000);
    expect(config.kaiascanTimeoutMs).toBe(15000);
    expect(config.authMode).toBe("required");
    expect(config.allowUnsafeWallet).toBe(false);
    expect(config.oauthClientId).toBe("kaia-mcp-demo");
    expect(config.accessTokenTtlSeconds).toBe(900);
  });

  it("returns config from provided env", () => {
    process.env.KAIA_RPC_URL = "https://my-rpc.example.com";
    process.env.KAIA_DEFAULT_NETWORK = "kairos";
    process.env.LOG_LEVEL = "warn";
    process.env.RATE_LIMIT_RPC = "20";

    const config = getConfig();
    expect(config.kaiaRpcUrl).toBe("https://my-rpc.example.com");
    expect(config.defaultNetwork).toBe("kairos");
    expect(config.logLevel).toBe("warn");
    expect(config.rateLimitRpc).toBe(20);
  });

  it("throws on invalid KAIA_RPC_URL", () => {
    process.env.KAIA_RPC_URL = "not-a-url";
    expect(() => getConfig()).toThrow(/Invalid config/);
  });

  it("returns same instance (singleton)", () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });
});

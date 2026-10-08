import { describe, it, expect, beforeEach, vi } from "vitest";
import { listResources, readResource } from "./index.js";
import { resetConfigCache } from "../config.js";
import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";

vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({
    getBlockNumber: vi.fn().mockResolvedValue(12345678n),
    getGasPrice: vi.fn().mockResolvedValue(25000000000n),
  })),
}));

vi.mock("../clients/kaiascan.js", () => ({
  createKaiaScanClient: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({
      klay_price: {
        usd_price: 0.15,
        btc_price: 0.000002,
        usd_price_changes: 1.5,
        market_cap: 600_000_000,
        total_supply: 10_000_000_000,
        volume: 2_000_000,
      },
    }),
  })),
}));

describe("listResources", () => {
  it("returns 5 resources with expected URIs", () => {
    const result = listResources();
    expect(result.resources).toBeDefined();
    expect(result.resources.length).toBe(5);
    const uris = result.resources.map((r) => r.uri).sort();
    expect(uris).toEqual([
      "kaia://docs/rpc-methods",
      "kaia://kairos/status",
      "kaia://mainnet/status",
      "kaia://mainnet/tokens/popular",
      "kaia://mainnet/top-accounts",
    ]);
    result.resources.forEach((r) => {
      expect(r.name).toBeDefined();
      expect(typeof r.name).toBe("string");
      expect(r.uri.startsWith("kaia://")).toBe(true);
    });
  });
});

describe("readResource", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.clearAllMocks();
    vi.mocked(createRpcClient).mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(12345678n),
      getGasPrice: vi.fn().mockResolvedValue(25000000000n),
    } as unknown as ReturnType<typeof createRpcClient>);
    vi.mocked(createKaiaScanClient).mockReturnValue({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "api/v1/kaia")
          return Promise.resolve({
            klay_price: { usd_price: 0.15, btc_price: 0.000002 },
          });
        if (path === "api/v1/kaia/top-accounts")
          return Promise.resolve([
            { address: "0xaaa", account_type: "EOA", amount: 1e6, percentage: 0.5 },
            { address: "0xbbb", account_type: "SCA", amount: 5e5, percentage: 0.25 },
          ]);
        return Promise.reject(new Error("Unknown path"));
      }),
    } as unknown as ReturnType<typeof createKaiaScanClient>);
  });

  it("readResource(kaia://mainnet/status) returns content with block height and gas", async () => {
    const result = await readResource("kaia://mainnet/status");
    expect(result.contents).toBeDefined();
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.contents.length).toBeGreaterThanOrEqual(1);
    const item = result.contents[0];
    expect("text" in item).toBe(true);
    const text = (item as { uri: string; text: string }).text;
    expect(text).toContain("mainnet");
    expect(text).toContain("12345678");
    expect(text).toContain("25000000000");
    expect(text).toContain("0.15");
  });

  it("readResource(kaia://docs/rpc-methods) returns text containing kaia_ and getBalance", async () => {
    const result = await readResource("kaia://docs/rpc-methods");
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBeGreaterThanOrEqual(1);
    const item = result.contents[0];
    expect("text" in item).toBe(true);
    const text = (item as { uri: string; mimeType?: string; text: string }).text;
    expect(text).toMatch(/kaia_/);
    expect(text).toMatch(/getBalance|eth_getBalance/);
    expect((item as { mimeType?: string }).mimeType).toBe("text/markdown");
  });

  it("readResource(kaia://mainnet/tokens/popular) returns token list with names and addresses", async () => {
    const result = await readResource("kaia://mainnet/tokens/popular");
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBe(1);
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("WKAIA");
    expect(text).toContain("USDT");
    expect(text).toContain("USDC");
    expect(text).toMatch(/0x[a-fA-F0-9]{40}/);
  });

  it("readResource(kaia://mainnet/top-accounts) returns top holders (mocked)", async () => {
    const result = await readResource("kaia://mainnet/top-accounts");
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBe(1);
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("Top 100 KAIA holders");
    expect(text).toContain("0xaaa");
    expect(text).toContain("0xbbb");
  });

  it("readResource with invalid URI throws ProtocolError", async () => {
    const { ProtocolError } = await import("@modelcontextprotocol/server");
    await expect(readResource("not-a-uri")).rejects.toThrow(ProtocolError);
    await expect(readResource("https://example.com")).rejects.toThrow(ProtocolError);
  });

  it("readResource with unknown kaia:// URI throws ProtocolError", async () => {
    const { ProtocolError } = await import("@modelcontextprotocol/server");
    await expect(readResource("kaia://mainnet/unknown/path")).rejects.toThrow(ProtocolError);
  });
});

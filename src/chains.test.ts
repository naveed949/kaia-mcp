import { describe, it, expect } from "vitest";
import { getChain, kaiaMainnet, kaiaKairos } from "./chains.js";

describe("chains", () => {
  it("getChain('mainnet') returns chain with chainId 8217", () => {
    const chain = getChain("mainnet");
    expect(chain.id).toBe(8217);
    expect(chain).toBe(kaiaMainnet);
  });

  it("getChain('kairos') returns chain with chainId 1001", () => {
    const chain = getChain("kairos");
    expect(chain.id).toBe(1001);
    expect(chain).toBe(kaiaKairos);
  });

  it("kaiaMainnet has expected shape", () => {
    expect(kaiaMainnet.name).toBe("Kaia Mainnet");
    expect(kaiaMainnet.nativeCurrency.symbol).toBe("KAIA");
    expect(kaiaMainnet.nativeCurrency.decimals).toBe(18);
    expect(kaiaMainnet.rpcUrls.default.http).toContain("https://public-en.node.kaia.io");
  });

  it("kaiaKairos has expected shape", () => {
    expect(kaiaKairos.name).toBe("Kaia Kairos");
    expect(kaiaKairos.nativeCurrency.symbol).toBe("KAIA");
    expect(kaiaKairos.nativeCurrency.decimals).toBe(18);
    expect(kaiaKairos.rpcUrls.default.http).toContain("https://public-en-kairos.node.kaia.io");
  });
});

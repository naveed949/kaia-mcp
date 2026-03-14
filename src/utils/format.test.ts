import { describe, it, expect } from "vitest";
import { formatKaia, formatPeb } from "./format.js";

describe("formatKaia", () => {
  it("formats 0 as 0", () => {
    expect(formatKaia(0n)).toBe("0");
  });

  it("formats 1 KAIA (10^18 peb) as 1", () => {
    expect(formatKaia(1000000000000000000n)).toBe("1");
  });

  it("formats 0.5 KAIA with one decimal", () => {
    expect(formatKaia(500000000000000000n)).toBe("0.5");
  });

  it("formats large balance with decimals", () => {
    expect(formatKaia(1234567890123456789n)).toContain("1.234567");
  });
});

describe("formatPeb", () => {
  it("returns raw decimal string", () => {
    expect(formatPeb(1000000000000000000n)).toBe("1000000000000000000");
    expect(formatPeb(0n)).toBe("0");
  });
});

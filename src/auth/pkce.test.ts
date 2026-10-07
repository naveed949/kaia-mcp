import { describe, it, expect } from "vitest";
import { codeChallengeS256, generatePkcePair, verifyPkce } from "./pkce.js";

describe("PKCE S256", () => {
  it("round-trips a generated verifier", () => {
    const { verifier, challenge, method } = generatePkcePair();
    expect(method).toBe("S256");
    expect(codeChallengeS256(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects plain method and mismatched verifiers", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifyPkce(verifier, challenge, "plain")).toBe(false);
    expect(verifyPkce("a".repeat(43), challenge, "S256")).toBe(false);
  });
});

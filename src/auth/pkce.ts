import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: codeChallengeS256(verifier), method: "S256" };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify PKCE. Only S256 is accepted; `plain` is rejected (fail-closed).
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  if (!VERIFIER_RE.test(verifier)) return false;
  if (!challenge) return false;
  return safeEqual(codeChallengeS256(verifier), challenge);
}

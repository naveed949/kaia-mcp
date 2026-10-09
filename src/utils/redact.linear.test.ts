/**
 * The redactor runs on every log value, including caller input (a tool name, an Origin)
 * and upstream text (a contract's revert reason), so it must be linear-time on any input.
 * The old JWT regex restarted at every `eyJ` and rescanned the rest of the token run, so a
 * run of `eyJeyJeyJ…` cost O(n²): 100 KB took seconds and 1 MB minutes (PR #9 verify r2,
 * M-1/M-2).
 *
 * Each case below is about 1 MB of input built to hit one regex's worst case. A small probe
 * runs first so a quadratic redactor fails in about a second instead of hanging the run.
 */
import { describe, expect, it } from "vitest";
import { redactString } from "./redact.js";

const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Built at runtime so the source never holds a JWT-shaped literal.
const JWT = [b64({ alg: "RS256", kid: "k" }), b64({ sub: "demo-user" }), "c2ln"].join(".");
const NEAR_MISS = JWT.split(".").slice(0, 2).join("."); // header.payload, no second dot

/** Adversarial inputs, one or more per regex in redact.ts (Bearer, JWT, URL, key segment). */
export const ADVERSARIAL: Record<string, (n: number) => string> = {
  "eyJ repeated (JWT start everywhere, no dot)": (n) => rep("eyJ", n),
  "eyJ. repeated": (n) => rep("eyJ.", n),
  "eyJ.eyJ repeated (two segments, never a third dot)": (n) => rep("eyJ.eyJ", n),
  "header.payload then an endless eyJ run": (n) => "eyJa." + rep("eyJ", n),
  "header.eyJ… then an endless second segment": (n) => "eyJa.eyJb" + rep("eyJ", n),
  "x-prefixed eyJ runs (match inside a run)": (n) => rep("xeyJ-eyJ_", n),
  "near-miss JWTs (header.payload, no signature dot)": (n) => rep(NEAR_MISS + " ", n),
  "Bearer eyJ… (Bearer then a JWT-start run)": (n) => "Bearer " + rep("eyJ", n),
  "Bearer then endless whitespace": (n) => "Bearer" + rep(" \t", n) + "!",
  "Bearer repeated with whitespace": (n) => rep("Bearer \t", n),
  "Bearer, spaces, non-token char, repeated": (n) => rep("Bearer   !", n),
  "Bearer token ending in endless =": (n) => "Bearer a" + rep("=", n) + "!",
  "http:// repeated (URL start everywhere)": (n) => rep("http://", n),
  "https:/ near-miss scheme repeated": (n) => rep("https:/x", n),
  "URL with an endless path": (n) => "https://h/" + rep("aB3/", n),
  "URL with endless key-shaped segments": (n) => "https://h" + rep("/abcdefghijklmnop1", n),
  "URL with one endless key-shaped segment": (n) => "https://h/" + rep("a1", n),
  "URL with an endless query": (n) => "https://h/p?" + rep("a=1&", n),
  "URL with an endless authority": (n) => "https://" + rep("u:p@", n),
  "real JWTs back to back": (n) => rep(JWT + " ", n),
  "real JWTs joined by dots": (n) => rep(JWT + ".", n),
};

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}
function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, timeMs(fn));
  return best;
}

const MB = 1024 * 1024;

describe("redactString is linear-time on adversarial input (M-1, M-2)", () => {
  for (const [name, gen] of Object.entries(ADVERSARIAL)) {
    it(`${name}: 1 MB in bounded time, scaling linearly`, () => {
      // Probe: a quadratic redactor takes over a second at 64 KB; a linear one ~1 ms.
      const probe = timeMs(() => redactString(gen(64 * 1024)));
      expect(probe, "64 KB probe (ms)").toBeLessThan(250);
      const quarter = gen(MB / 4);
      const full = gen(MB);
      const tQuarter = bestOf(3, () => redactString(quarter));
      const tFull = bestOf(3, () => redactString(full));
      // Generous for a slow CI runner: a linear redactor takes ~10-30 ms per MB.
      expect(tFull, "1 MB (ms)").toBeLessThan(1500);
      // Linear: 4x the input costs ~4x; quadratic would cost ~16x. The floor keeps timer
      // noise on sub-millisecond runs from failing the ratio.
      expect(tFull, `1 MB vs 256 KB (${tQuarter.toFixed(2)} ms)`).toBeLessThan(
        Math.max(tQuarter, 5) * 10
      );
    });
  }
});

/** The previous regex chain, kept here as the oracle for what must be redacted. */
const OLD = {
  BEARER_RE: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  JWT_RE: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
};

describe("the linear JWT scanner redacts exactly what the old regex did", () => {
  it("matches the old JWT regex on 20,000 random short strings", () => {
    // Small deterministic PRNG (mulberry32).
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const parts = ["eyJ", "eyJ", "eyJ", "e", "y", "J", ".", ".", "a", "Z", "9", "_", "-", " "];
    parts.push("!", "%", "=", "\t", "\n", "é", "Bearer ", "x");
    for (let i = 0; i < 20_000; i++) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 24);
      for (let j = 0; j < len; j++) s += parts[Math.floor(rnd() * parts.length)];
      // No URL in the alphabet, so only the Bearer and JWT steps act.
      const want = s
        .replace(OLD.BEARER_RE, "Bearer [redacted]")
        .replace(OLD.JWT_RE, "[redacted-jwt]");
      expect(redactString(s), JSON.stringify(s)).toBe(want);
    }
  });

  it("keeps the round-1 cases: a JWT anywhere, in any context, is redacted", () => {
    const cases: Array<[string, string]> = [
      [JWT, "[redacted-jwt]"],
      [`token=${JWT} tail`, "token=[redacted-jwt] tail"],
      [`x${JWT}`, "x[redacted-jwt]"], // inside a token run (the match starts at eyJ)
      [`%22${JWT}%22`, "%22[redacted-jwt]%22"], // percent-encoded JSON quotes
      [`abc-_9${JWT}.`, "abc-_9[redacted-jwt]."], // a dot after the signature is not part of it
      [`${JWT}.${JWT}`, "[redacted-jwt].[redacted-jwt]"],
      [`eyJ${JWT}`, "[redacted-jwt]"], // leftmost eyJ in the run
      [`"${JWT}","${JWT}"`, '"[redacted-jwt]","[redacted-jwt]"'],
      [`${NEAR_MISS}.`, "[redacted-jwt]"], // empty third segment still matches
      // After a match the scan resumes after its signature, not inside it, as the regex did:
      // an eyJ-shaped signature followed by `.eyJ….` is not a second token.
      ["eyJa.eyJb.eyJc.eyJd.e", "[redacted-jwt].eyJd.e"],
      ["eyJa.eyJb.eyJc.eyJd.eyJe.f", "[redacted-jwt].[redacted-jwt]"],
      [NEAR_MISS, NEAR_MISS], // two segments only: not a JWT, as before
      [`Bearer ${JWT}`, "Bearer [redacted]"],
      [`https://h/cb#access_token=${JWT}`, "https://h/cb?[redacted]"],
    ];
    for (const [input, want] of cases) expect(redactString(input), input).toBe(want);
  });
});

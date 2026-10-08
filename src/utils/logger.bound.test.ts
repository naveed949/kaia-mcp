/**
 * Before redaction, the logger bounds every value (and the message) to
 * REDACT_INPUT_MAX_CHARS characters, cut only at whitespace. Every secret the redactor
 * knows (a JWT, `Bearer <token>`'s token, a URL) is one run of non-whitespace characters,
 * so a run is either kept whole (and redacted exactly as before) or dropped whole: the cut
 * can never leave an `eyJ…` header or half a URL key behind. A 4 MB tool name or revert
 * reason then costs the same as a 4 KB one (PR #9 verify r2, M-1/M-2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { logger } from "./logger.js";
import { REDACT_INPUT_MAX_CHARS, boundRedactionInput } from "./redact.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Built at runtime so the source never holds a JWT-shaped literal.
const JWT = [b64({ alg: "RS256", kid: "k" }), b64({ sub: "demo-user" }), "s".repeat(80)].join(".");
const KEY = "FAKEKEYpath7Qx9v2mN4bLr8Tz3Wc6Yd";

describe("boundRedactionInput", () => {
  const MAX = REDACT_INPUT_MAX_CHARS;

  it("is a few KB: well above every log cap (256/512 bytes), far below a request body", () => {
    expect(MAX).toBeGreaterThanOrEqual(2048);
    expect(MAX).toBeLessThanOrEqual(16384);
  });

  it("leaves text up to the bound unchanged", () => {
    const s = "a b ".repeat(MAX / 4);
    expect(s.length).toBe(MAX);
    expect(boundRedactionInput(s)).toBe(s);
  });

  it("cuts longer text at the last whitespace before the bound, then marks the cut", () => {
    const s = "word ".repeat(MAX); // 5x the bound
    const out = boundRedactionInput(s);
    expect(out.endsWith("\u2026")).toBe(true);
    const kept = out.slice(0, -1);
    expect(kept.length).toBeLessThanOrEqual(MAX);
    expect(s.startsWith(kept)).toBe(true);
    expect(kept.endsWith(" ")).toBe(true);
  });

  it("keeps a run that ends exactly at the bound (the next character is whitespace)", () => {
    const s = "x".repeat(MAX) + " tail";
    expect(boundRedactionInput(s)).toBe("x".repeat(MAX) + "\u2026");
  });

  it("drops a JWT that straddles the bound whole: no eyJ fragment survives", () => {
    for (const offset of [1, 5, 40, JWT.indexOf(".") + 1, JWT.length - 1]) {
      const s = "p "
        .repeat((MAX - JWT.length + offset) / 2 + 1)
        .slice(0, MAX - JWT.length + offset);
      const input = s + JWT + " after";
      const out = boundRedactionInput(input);
      expect(out, `offset ${offset}`).not.toContain("eyJ");
      expect(out.endsWith("\u2026")).toBe(true);
    }
  });

  it("drops a keyed URL that straddles the bound whole: no key fragment survives", () => {
    const url = `https://rpc.example.test/v2/${KEY}?apikey=FAKEQUERY55`;
    const cut = url.indexOf(KEY) + 6; // the bound falls six characters into the key
    const input = " ".repeat(MAX - cut) + url + " tail";
    const out = boundRedactionInput(input);
    expect(out).not.toContain("FAKEKE");
    expect(out).not.toContain("rpc.example.test");
  });

  it("drops a Bearer token whose run straddles the bound, keeping no part of it", () => {
    const tok = "Q".repeat(64);
    const input = "z ".repeat((MAX - 10) / 2) + "Bearer " + tok;
    const out = boundRedactionInput(input);
    expect(out).not.toContain("QQQQ");
  });

  it("one endless run (no whitespace at all) is dropped entirely", () => {
    expect(boundRedactionInput("eyJ".repeat(MAX))).toBe("\u2026");
  });

  it("treats every JavaScript whitespace character as a boundary", () => {
    for (const ws of ["\t", "\n", "\r", "\v", "\f", "\u00a0", "\u2028", "\u3000", "\ufeff"]) {
      const input = "a".repeat(MAX - 2) + ws + "bbbb";
      expect(boundRedactionInput(input), JSON.stringify(ws)).toBe(
        "a".repeat(MAX - 2) + ws + "\u2026"
      );
    }
  });

  it("runs in linear time on 4 MB of adversarial input", () => {
    for (const s of [
      "eyJ".repeat(1_400_000),
      " ".repeat(4 * 1024 * 1024),
      "a ".repeat(2_000_000),
    ]) {
      const t0 = performance.now();
      boundRedactionInput(s);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});

describe("logger: huge values are bounded before redaction", () => {
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;
  const out = () => chunks.join("");

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    resetConfigCache();
    chunks.length = 0;
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = orig;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("a 4 MB eyJ… tool name, detail, error and message log in bounded time", () => {
    // Probe: a logger that redacts before bounding takes over a second at 64 KB.
    const p0 = performance.now();
    logger.info("Tool call", { tool: "eyJ".repeat(22_000) });
    expect(performance.now() - p0, "64 KB probe (ms)").toBeLessThan(400);
    chunks.length = 0;
    const huge = "eyJ".repeat(1_400_000);
    const t0 = performance.now();
    logger.info("Tool call", { tool: huge, outcome: "allowed" });
    logger.error("Tool error", { detail: `reverted: ${huge}`, error: new Error(huge) });
    logger.warn(huge);
    expect(performance.now() - t0).toBeLessThan(1500);
    const lines = out().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.length).toBeLessThan(2048);
    expect(lines[0]).toContain(" tool=%E2%80%A6 outcome=allowed");
    expect(lines[1]).toContain(" detail=reverted:%20%E2%80%A6");
  });

  it("a JWT straddling the pre-redaction bound leaves no eyJ fragment in the line", () => {
    // The second JWT starts ~20 characters before the bound, so the bound cuts through it.
    const pad = "y ".repeat(Math.floor((REDACT_INPUT_MAX_CHARS - JWT.length - 21) / 2));
    const detail = JWT + " " + pad + JWT + " end";
    expect(detail.indexOf(JWT, 1)).toBeLessThan(REDACT_INPUT_MAX_CHARS);
    expect(detail.indexOf(JWT, 1) + JWT.length).toBeGreaterThan(REDACT_INPUT_MAX_CHARS);
    logger.info("probe", { detail });
    expect(out()).not.toMatch(/eyJ/);
    expect(out()).toContain("detail=[redacted-jwt]%20y%20y");
  });

  it("the message is bounded before redaction too: a run crossing the bound is dropped", () => {
    // Messages are fixed literals at every call site; this pins the logger itself.
    logger.warn("probe " + "eyJ".repeat(2000));
    const line = out().split("\n")[0];
    expect(line).toContain(" msg=probe %E2%80%A6");
    expect(line).not.toContain("eyJ");
  });

  it("a short value is untouched by the bound (redacted and capped exactly as before)", () => {
    logger.info("probe", { detail: `ok ${JWT} done` });
    expect(out()).toContain("detail=ok%20[redacted-jwt]%20done");
    expect(out()).not.toContain("%E2%80%A6");
  });
});

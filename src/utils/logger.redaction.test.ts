/**
 * Redaction runs on the full raw value before the 256-byte (error: 512-byte) cap and the
 * percent-encoding, for every field: meta values of any type, and the `error` field. A
 * JWT that straddles the cap must not leave a header/payload fragment (`eyJ...`) behind,
 * which is what a cap-then-redact order would do: the cut token no longer matches the
 * three-segment JWT pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { LOG_VALUE_MAX_BYTES, logger } from "./logger.js";

// Built at runtime so the source never holds a JWT-shaped literal.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = [
  b64({ alg: "RS256", typ: "at+jwt", kid: "k".repeat(43) }),
  b64({ iss: "http://127.0.0.1:1", sub: "demo-user", scope: "kaia:read", jti: "j".repeat(36) }),
  "s".repeat(342),
].join(".");

describe("logger redaction order and coverage", () => {
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

  it("a JWT straddling the 256-byte value cap is redacted before the cut (no eyJ fragment)", () => {
    // 240 bytes of prefix: the cap falls inside the JWT's header segment.
    const prefix = "y".repeat(LOG_VALUE_MAX_BYTES - 16);
    logger.info("probe", { detail: prefix + JWT });
    expect(out()).not.toContain("eyJ");
    expect(out()).toContain("detail=" + prefix + "[redacted-jwt]");
  });

  it("a JWT straddling the 512-byte error cap is redacted before the cut (Error instance)", () => {
    logger.error("probe", { error: new Error("x".repeat(480) + " " + JWT) });
    expect(out()).not.toContain("eyJ");
    expect(out()).toContain("[redacted-jwt]");
  });

  it("error= text is redacted: a JWT inside an exception message never reaches the log", () => {
    logger.error("probe", { error: new Error(`upstream said: Bearer ${JWT} rejected`) });
    logger.error("probe", { error: `string error ${JWT}` });
    logger.error("probe", { error: { toString: () => `object error ${JWT}` } });
    expect(out()).not.toContain("eyJ");
    expect(out().match(/\[redacted/g)?.length).toBe(3);
  });

  it("non-string values (arrays, Errors, objects) are redacted too", () => {
    logger.info("probe", {
      list: ["a", JWT],
      err: new Error(`inner ${JWT}`),
      obj: { toString: () => `obj ${JWT}` },
      bearer: { toString: () => `Bearer ${"Q".repeat(40)}` },
    });
    expect(out()).not.toContain("eyJ");
    expect(out()).not.toContain("Q".repeat(40));
    expect(out()).toContain("list=a,[redacted-jwt]");
  });

  it("non-string values are escaped like strings (no raw space or '=' from toString)", () => {
    logger.info("probe", { obj: { toString: () => "a b outcome=allowed" } });
    expect(out()).toContain("obj=a%20b%20outcome%3Dallowed");
    expect(out()).not.toContain(" outcome=allowed");
  });

  it("an upstream URL in any field loses its key path segment, query string and userinfo", () => {
    const key = "FAKEKEYpath7Qx9v2mN4bLr8Tz3Wc6Yd";
    const url = `https://u:pw9secret@rpc.example.test/v2/${key}?apikey=FAKEQUERY55&x=1`;
    logger.error("probe", {
      error: new Error(`HTTP request failed.\n\nURL: ${url}\nRequest body: {}`),
      detail: `URL: ${url}`,
      list: [url],
    });
    expect(out()).not.toMatch(/FAKEKEY|FAKEQUERY55|pw9secret/);
    expect(out()).toContain("rpc.example.test/v2/[redacted]?[redacted]");
  });
});

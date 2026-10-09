import { describe, expect, it } from "vitest";
import { bearerFromHeader, parseBearerCredential } from "./provider.js";

describe("parseBearerCredential", () => {
  it("token: valid forms", () => {
    for (const h of ["Bearer abc", "bearer abc", "BEARER   xyz=="]) {
      expect(parseBearerCredential(h)).toEqual({ kind: "token", token: bearerFromHeader(h) });
    }
  });
  it("none: missing, empty, scheme-only, other scheme, no separator", () => {
    for (const h of [undefined, "", "Bearer", "Bearer   ", "Basic abc", "Bearerabc"]) {
      expect(parseBearerCredential(h), String(h)).toEqual({ kind: "none" });
    }
  });
  it("malformed: quoted, %, !, comma, tab, NBSP, junk, second credential, '=' in middle", () => {
    for (const h of [
      'Bearer "abc"',
      "Bearer abc%",
      "Bearer abc!",
      "Bearer abc,",
      "Bearer\tabc",
      "Bearer\u00a0abc",
      "Bearer abc x",
      "Bearer abc, Bearer abc",
      "Bearer ab=cd",
      "Bearer,abc",
    ]) {
      expect(parseBearerCredential(h), h).toEqual({ kind: "malformed" });
    }
  });
  it("Bearer followed only by whitespace is none, not malformed", () => {
    // dropping the trim() check would classify these as malformed
    expect(parseBearerCredential("Bearer ")).toEqual({ kind: "none" });
    expect(parseBearerCredential("Bearer\t  ")).toEqual({ kind: "none" });
    expect(parseBearerCredential("Bearer\u00a0  ")).toEqual({ kind: "none" });
  });
});

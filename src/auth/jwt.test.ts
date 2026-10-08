/**
 * Only canonical, unpadded base64url segments verify (RFC 7515 2). Node's decoder by itself
 * ignores padding, stray characters and the spare low bits of the last character, so one
 * signed token had many accepted spellings, each with its own sha256 fingerprint.
 */
import { describe, expect, it } from "vitest";
import { SigningKey } from "./jwt.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Same decoded bytes, different text: flip a spare low bit of the last character. */
function sibling(segment: string): string {
  const last = segment.at(-1)!;
  return segment.slice(0, -1) + ALPHABET[ALPHABET.indexOf(last) ^ 1];
}

describe("SigningKey.verifySignature: canonical base64url only", () => {
  const key = SigningKey.generate();
  const token = key.sign({ sub: "u", n: 1 });
  const [h, p, s] = token.split(".");

  it("accepts the token as signed", () => {
    expect(key.verifySignature(token)).toMatchObject({ sub: "u", n: 1 });
  });

  it("the sibling spelling decodes to the same signature bytes (what Node alone accepts)", () => {
    expect(Buffer.from(sibling(s), "base64url")).toEqual(Buffer.from(s, "base64url"));
    expect(sibling(s)).not.toBe(s);
  });

  it.each([
    ["'==' padding", `${token}==`],
    ["'=' padding", `${token}=`],
    ["sibling last signature character", `${h}.${p}.${sibling(s)}`],
    ["stray '!' in signature", `${h}.${p}.${s.slice(0, 10)}!${s.slice(10)}`],
    ["standard base64 '+' for '-'", `${h}.${p}.${s.replaceAll("-", "+").replaceAll("_", "/")}`],
    ["padded header", `${h}==.${p}.${s}`],
    ["empty signature", `${h}.${p}.`],
    ["four segments", `${token}.x`],
  ])("rejects %s", (_label, forged) => {
    if (forged === `${h}.${p}.${s.replaceAll("-", "+").replaceAll("_", "/")}` && forged === token) {
      return; // no '-' or '_' in this signature: nothing to translate
    }
    expect(key.verifySignature(forged)).toBeNull();
  });
});

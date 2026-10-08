import { describe, expect, it } from "vitest";
import { isSecretKey, redactString } from "./redact.js";

describe("redact", () => {
  it("redacts Bearer values and recognises secret-named keys", () => {
    expect(redactString("Authorization Bearer deadbeefcafebabe")).toBe(
      "Authorization Bearer [redacted]"
    );
    expect(isSecretKey("access_token")).toBe(true);
    expect(isSecretKey("Authorization")).toBe(true);
    expect(isSecretKey("scopes")).toBe(false);
  });

  it("redacts bare compact JWTs anywhere in a string", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    expect(redactString(`token=${jwt} tail`)).toBe("token=[redacted-jwt] tail");
  });

  describe("upstream URLs", () => {
    const KEY = "FAKEKEYpath7Qx9v2mN4bLr8Tz3Wc6Yd";
    it("drops the query string, userinfo and key-shaped path segments, keeps the host", () => {
      const out = redactString(
        `HTTP request failed. URL: https://user:pa55word@rpc.example.test:8545/v2/${KEY}?apikey=QK123456&x=1#frag Request body: {}`
      );
      expect(out).toBe(
        "HTTP request failed. URL: https://[redacted]@rpc.example.test:8545/v2/[redacted]?[redacted] Request body: {}"
      );
      expect(out).not.toMatch(/FAKEKEY|QK123456|pa55word|frag/);
    });

    it("redacts a key segment followed by punctuation, and ws(s) URLs", () => {
      expect(redactString(`"url":"wss://node.example/ws/${KEY}",`)).toBe(
        '"url":"wss://node.example/ws/[redacted]",'
      );
    });

    it("leaves ordinary URLs alone", () => {
      for (const u of [
        "http://127.0.0.1:3100",
        "http://127.0.0.1/callback",
        "https://kaia-mcp.example.test/.well-known/oauth-protected-resource",
        "https://evil.example.test",
      ]) {
        expect(redactString(u)).toBe(u);
      }
    });
  });
});

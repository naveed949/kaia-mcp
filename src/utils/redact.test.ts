import { describe, expect, it } from "vitest";
import { redactMeta, redactString } from "./redact.js";

describe("redact", () => {
  it("redacts token fields and Bearer prefixes", () => {
    expect(redactMeta({ access_token: "abc123", scopes: "kaia:read" })).toEqual({
      access_token: "[redacted]",
      scopes: "kaia:read",
    });
    expect(redactString("Authorization Bearer deadbeefcafebabe")).toBe("Authorization Bearer [redacted]");
  });

  it("redacts bare compact JWTs anywhere in a string", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    expect(redactString(`token=${jwt} tail`)).toBe("token=[redacted-jwt] tail");
    expect(redactMeta({ note: `got ${jwt}` })).toEqual({ note: "got [redacted-jwt]" });
  });
});

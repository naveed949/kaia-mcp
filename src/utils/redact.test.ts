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
});

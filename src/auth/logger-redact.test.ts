import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { createDemoOAuthProvider } from "./provider.js";
import { SCOPES } from "./constants.js";

describe("token logging", () => {
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;

  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
    resetConfigCache();
    chunks.length = 0;
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(String(chunk));
      return orig(chunk, ...(args as []));
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = orig;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("never writes access token plaintext to stderr", () => {
    const provider = createDemoOAuthProvider({ issuer: "http://127.0.0.1:9" });
    const tokens = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    const log = chunks.join("");
    expect(log).toContain("oauth tokens issued");
    expect(log).not.toContain(tokens.access_token);
    expect(log).not.toContain(tokens.refresh_token);
  });
});

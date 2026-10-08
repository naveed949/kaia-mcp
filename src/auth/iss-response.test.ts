/**
 * RFC 9207 authorization server issuer identification: every authorization response
 * redirect (code, access_denied, and error redirects) carries iss = issuer, and AS
 * metadata advertises authorization_response_iss_parameter_supported.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { resetConfigCache } from "../config.js";
import { generatePkcePair } from "./pkce.js";
import { authorize, form } from "../test-support/mcp-http.js";

describe("RFC 9207 iss in authorization responses", () => {
  let handle: KaiaHttpServerHandle | undefined;

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    process.env.KAIA_PUBLIC_URL = "https://kaia.example.test";
    resetConfigCache();
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    for (const k of ["KAIA_AUTH_MODE", "LOG_LEVEL", "KAIA_PUBLIC_URL"]) delete process.env[k];
    resetConfigCache();
  });

  async function consent(decision: "approve" | "deny"): Promise<URL> {
    handle = await runKaiaMcpServerHttp(0);
    const page = await authorize(handle.localUrl, {
      challenge: generatePkcePair().challenge,
      state: "st",
    });
    const requestId = (await page.text()).match(/name="request_id" value="([^"]+)"/)![1];
    const res = await form(`${handle.localUrl}/oauth/consent`, { request_id: requestId, decision });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location")!);
  }

  it("metadata advertises authorization_response_iss_parameter_supported: true", async () => {
    handle = await runKaiaMcpServerHttp(0);
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const disc = (await (await fetch(`${handle.localUrl}${path}`)).json()) as Record<
        string,
        unknown
      >;
      expect(disc.authorization_response_iss_parameter_supported, path).toBe(true);
    }
  });

  it("an approved consent redirect carries code, state and iss", async () => {
    const loc = await consent("approve");
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("st");
    expect(loc.searchParams.get("iss")).toBe("https://kaia.example.test");
  });

  it("a denied consent redirect carries error=access_denied and iss", async () => {
    const loc = await consent("deny");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("iss")).toBe("https://kaia.example.test");
  });

  it("an /oauth/authorize error redirect carries iss", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const res = await authorize(handle.localUrl, {
      challenge: generatePkcePair().challenge,
      scope: "kaia:admin",
      state: "st",
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_scope");
    expect(loc.searchParams.get("iss")).toBe("https://kaia.example.test");
  });
});

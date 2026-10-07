import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { resetConfigCache } from "../config.js";
import { generatePkcePair } from "./pkce.js";
import { DEMO_CLIENT_ID, SCOPES } from "./constants.js";

describe("demo OAuth HTTP", () => {
  let handle: KaiaHttpServerHandle | undefined;

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("serves discovery and completes PKCE with consent then revoke", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const base = handle.issuer;

    const discovery = await fetch(`${base}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const disc = (await discovery.json()) as { code_challenge_methods_supported: string[] };
    expect(disc.code_challenge_methods_supported).toEqual(["S256"]);

    const pkce = generatePkcePair();
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set("client_id", DEMO_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", SCOPES.ENCODE);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "s1");

    const consentPage = await fetch(authorize);
    expect(consentPage.status).toBe(200);
    const html = await consentPage.text();
    const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
    expect(requestId).toBeTruthy();

    const consent = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, decision: "approve" }),
      redirect: "manual",
    });
    expect(consent.status).toBe(302);
    const location = consent.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: DEMO_CLIENT_ID,
        code: code!,
        code_verifier: pkce.verifier,
        redirect_uri: "http://127.0.0.1/callback",
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };
    expect(tokens.access_token).toMatch(/^[a-f0-9]{64}$/);

    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({
      status: "ok",
      server: "kaia-mcp",
      authMode: "required",
      issuer: base,
      unsafeWallet: false,
    });

    const revoke = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token }),
    });
    expect(revoke.status).toBe(200);
    expect(handle.oauth.verifyAccessToken(tokens.access_token).ok).toBe(false);
  });
});

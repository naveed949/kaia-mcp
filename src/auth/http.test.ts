import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
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
    delete process.env.KAIA_INTROSPECTION_CLIENT_SECRET;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("serves discovery and completes PKCE with consent then revoke", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const base = handle.issuer;

    const discovery = await fetch(`${base}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const disc = (await discovery.json()) as Record<string, unknown>;
    expect(disc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(disc.jwks_uri).toBe(`${base}/oauth/jwks`);
    // Introspection is only advertised when a gateway secret is configured.
    expect(disc.introspection_endpoint).toBeUndefined();

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
    const [h, p, sig] = tokens.access_token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, string>;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: "RS256", typ: "at+jwt" });
    expect(claims).toMatchObject({
      iss: base,
      aud: base,
      sub: "demo-user",
      scope: SCOPES.ENCODE,
    });
    for (const k of ["exp", "nbf", "iat"]) expect(typeof claims[k]).toBe("number");
    expect(typeof claims.jti).toBe("string");

    // A third party can verify the token with nothing but the published JWKS.
    const jwks = (await (await fetch(disc.jwks_uri as string)).json()) as {
      keys: (JsonWebKey & { kid: string })[];
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(header.kid);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    const pub = createPublicKey({ key: jwks.keys[0], format: "jwk" });
    expect(
      cryptoVerify("sha256", Buffer.from(`${h}.${p}`), pub, Buffer.from(sig, "base64url"))
    ).toBe(true);

    const scopesRes = await fetch(`${base}/.well-known/kaia-mcp/tool-scopes`);
    const scopeMap = (await scopesRes.json()) as {
      tool_scopes: Record<string, string>;
      scopes: string[];
    };
    expect(scopeMap.tool_scopes.encode_function_data).toBe(SCOPES.ENCODE);
    expect(scopeMap.tool_scopes.generate_wallet).toBe(SCOPES.WALLET);
    expect(Object.keys(scopeMap.tool_scopes)).toHaveLength(26);
    expect(scopeMap.scopes).toEqual([SCOPES.ENCODE, SCOPES.READ, SCOPES.WALLET]);

    const noIntrospect = await fetch(`${base}/oauth/introspect`, { method: "POST", body: "" });
    expect(noIntrospect.status).toBe(404);

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

  it("serves RFC 7662 introspection to an authenticated gateway and reflects revocation", async () => {
    process.env.KAIA_INTROSPECTION_CLIENT_SECRET = "test-only-introspection-secret";
    resetConfigCache();
    handle = await runKaiaMcpServerHttp(0);
    const base = handle.issuer;
    const disc = (await (await fetch(`${base}/.well-known/openid-configuration`)).json()) as Record<
      string,
      unknown
    >;
    expect(disc.introspection_endpoint).toBe(`${base}/oauth/introspect`);
    expect(disc.introspection_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);

    const { access_token } = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    const introspect = (authorization?: string) =>
      fetch(`${base}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: new URLSearchParams({ token: access_token }),
      });
    const basic = (id: string, secret: string) =>
      `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

    const anon = await introspect();
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect((await introspect(basic("kaia-mcp-gateway", "wrong"))).status).toBe(401);
    expect((await introspect(`Bearer ${access_token}`)).status).toBe(401);

    const active = await introspect(basic("kaia-mcp-gateway", "test-only-introspection-secret"));
    expect(active.status).toBe(200);
    const body = (await active.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      active: true,
      scope: SCOPES.READ,
      aud: base,
      iss: base,
      token_type: "Bearer",
    });
    expect(JSON.stringify(body)).not.toContain(access_token);

    await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access_token }),
    });
    const after = await introspect(basic("kaia-mcp-gateway", "test-only-introspection-secret"));
    expect(await after.json()).toEqual({ active: false });
  });

  it("introspects a refresh token over HTTP with token_type_hint, inactive after revoke", async () => {
    process.env.KAIA_INTROSPECTION_CLIENT_SECRET = "test-only-introspection-secret";
    resetConfigCache();
    handle = await runKaiaMcpServerHttp(0);
    const base = handle.issuer;
    const { refresh_token } = handle.oauth.issueAccessToken({ scopes: [SCOPES.ENCODE] });
    const authz = `Basic ${Buffer.from("kaia-mcp-gateway:test-only-introspection-secret").toString("base64")}`;
    const introspect = async () =>
      (await (
        await fetch(`${base}/oauth/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: authz,
          },
          body: new URLSearchParams({ token: refresh_token, token_type_hint: "refresh_token" }),
        })
      ).json()) as Record<string, unknown>;

    const active = await introspect();
    expect(active).toMatchObject({
      active: true,
      token_type: "refresh_token",
      scope: SCOPES.ENCODE,
      client_id: DEMO_CLIENT_ID,
      sub: "demo-user",
      iss: base,
    });
    expect(typeof active.exp).toBe("number");
    expect(JSON.stringify(active)).not.toContain(refresh_token);

    await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh_token, token_type_hint: "refresh_token" }),
    });
    expect(await introspect()).toEqual({ active: false });
  });
});

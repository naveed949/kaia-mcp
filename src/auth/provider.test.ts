import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { SigningKey } from "./jwt.js";
import { createDemoOAuthProvider } from "./provider.js";
import { generatePkcePair } from "./pkce.js";
import { AUTH_ERRORS, DEMO_CLIENT_ID, SCOPES } from "./constants.js";

describe("DemoOAuthProvider", () => {
  const issuer = "http://127.0.0.1:3999";

  it("issues JWT access tokens and reports only a fingerprint and jti in the context", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const tokens = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    const ok = provider.verifyAccessToken(tokens.access_token);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.context.scopes).toEqual([SCOPES.READ]);
      expect(ok.context.tokenFingerprint).toMatch(/^[a-f0-9]{12}$/);
      expect(ok.context.tokenFingerprint).not.toBe(tokens.access_token);
      expect(ok.context.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("reports expired and revoked tokens with exact error shapes", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const expired = provider.issueAccessToken({
      scopes: [SCOPES.READ],
      expiresAtMs: Date.now() - 1000,
    });
    expect(provider.verifyAccessToken(expired.access_token)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.TOKEN_EXPIRED,
    });

    const live = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    provider.revoke(live.access_token);
    expect(provider.verifyAccessToken(live.access_token)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.INVALID_TOKEN,
    });
  });

  it("completes PKCE authorization-code exchange and rejects a bad verifier", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const pkce = generatePkcePair();
    const { requestId } = provider.createAuthorizationRequest({
      clientId: DEMO_CLIENT_ID,
      redirectUri: "http://127.0.0.1/callback",
      scope: `${SCOPES.READ} ${SCOPES.ENCODE}`,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      state: "xyz",
    });
    const { redirectUri } = provider.consent(requestId, "approve");
    const code = new URL(redirectUri).searchParams.get("code");
    expect(code).toBeTruthy();

    expect(() =>
      provider.exchangeAuthorizationCode({
        clientId: DEMO_CLIENT_ID,
        code: code!,
        codeVerifier: "wrong-verifier-wrong-verifier-wrong-verifier-xx",
        redirectUri: "http://127.0.0.1/callback",
      })
    ).toThrow(/PKCE verification failed/);

    const tokens = provider.exchangeAuthorizationCode({
      clientId: DEMO_CLIENT_ID,
      code: code!,
      codeVerifier: pkce.verifier,
      redirectUri: "http://127.0.0.1/callback",
    });
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("kaia:read kaia:encode");
    expect(provider.verifyAccessToken(tokens.access_token).ok).toBe(true);
  });

  it("device flow stays pending until consent, then issues tokens", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const started = provider.startDeviceAuthorization({
      clientId: DEMO_CLIENT_ID,
      scope: SCOPES.READ,
    });
    expect(() =>
      provider.exchangeDeviceCode({ clientId: DEMO_CLIENT_ID, deviceCode: started.device_code })
    ).toThrow(/authorization_pending/);

    provider.consentDevice(started.user_code, "approve");
    const tokens = provider.exchangeDeviceCode({
      clientId: DEMO_CLIENT_ID,
      deviceCode: started.device_code,
    });
    expect(provider.verifyAccessToken(tokens.access_token).ok).toBe(true);
  });

  it("verifyAccessToken(undefined) is unauthorized", () => {
    const provider = createDemoOAuthProvider({ issuer });
    expect(provider.verifyAccessToken(undefined)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.UNAUTHORIZED,
    });
  });

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const decode = (token: string) =>
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, unknown>;
  /** Sign arbitrary header/payload with a key the provider has never seen. */
  function forge(header: Record<string, unknown>, payload: Record<string, unknown>): string {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${cryptoSign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
  }
  const invalid = { ok: false, status: 401, ...AUTH_ERRORS.INVALID_TOKEN };

  it("rejects forged, alg=none, wrong-aud, wrong-iss and not-yet-valid tokens as invalid_token", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const good = provider.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const claims = decode(good);
    const kid = provider.signingKey.kid;

    expect(provider.verifyAccessToken(forge({ alg: "RS256", kid }, claims))).toEqual(invalid);
    const [, p] = good.split(".");
    expect(provider.verifyAccessToken(`${b64({ alg: "none", kid })}.${p}.`)).toEqual(invalid);
    expect(
      provider.verifyAccessToken(`${b64({ alg: "HS256", kid })}.${p}.${good.split(".")[2]}`)
    ).toEqual(invalid);
    // Tampered payload under the real signature.
    const tampered = `${good.split(".")[0]}.${b64({ ...claims, scope: "kaia:wallet" })}.${good.split(".")[2]}`;
    expect(provider.verifyAccessToken(tampered)).toEqual(invalid);
    expect(provider.verifyAccessToken("not-a-jwt")).toEqual(invalid);

    const otherAud = createDemoOAuthProvider({
      issuer,
      resource: "other-api",
      signingKey: provider.signingKey,
    });
    expect(
      provider.verifyAccessToken(otherAud.issueAccessToken({ scopes: [SCOPES.READ] }).access_token)
    ).toEqual(invalid);
    const otherIss = createDemoOAuthProvider({
      issuer: "http://127.0.0.1:1",
      signingKey: provider.signingKey,
    });
    expect(
      provider.verifyAccessToken(otherIss.issueAccessToken({ scopes: [SCOPES.READ] }).access_token)
    ).toEqual(invalid);
  });

  it("refresh rotation and refresh-token revocation revoke the linked access jti", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const first = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    const second = provider.exchangeRefreshToken({
      clientId: DEMO_CLIENT_ID,
      refreshToken: first.refresh_token,
    });
    expect(provider.verifyAccessToken(first.access_token)).toEqual(invalid);
    expect(provider.verifyAccessToken(second.access_token).ok).toBe(true);
    provider.revoke(second.refresh_token);
    expect(provider.verifyAccessToken(second.access_token)).toEqual(invalid);
    expect(provider.isRevoked(decode(second.access_token).jti as string)).toBe(true);
  });

  it("introspects active tokens and reports revoked, expired and foreign tokens inactive", () => {
    const provider = createDemoOAuthProvider({
      issuer,
      introspectionClient: { clientId: "gw", clientSecret: "s3cret" },
    });
    const live = provider.issueAccessToken({
      subject: "alice",
      scopes: [SCOPES.READ, SCOPES.ENCODE],
    });
    expect(provider.introspect(live.access_token)).toMatchObject({
      active: true,
      sub: "alice",
      scope: "kaia:read kaia:encode",
      aud: issuer,
      iss: issuer,
      jti: decode(live.access_token).jti,
    });
    expect(provider.introspect(undefined)).toEqual({ active: false });
    expect(
      provider.introspect(
        forge({ alg: "RS256", kid: provider.signingKey.kid }, decode(live.access_token))
      )
    ).toEqual({ active: false });
    const expired = provider.issueAccessToken({
      scopes: [SCOPES.READ],
      expiresAtMs: Date.now() - 1000,
    });
    expect(provider.introspect(expired.access_token)).toEqual({ active: false });
    provider.revoke(live.access_token);
    expect(provider.introspect(live.access_token)).toEqual({ active: false });

    const basic = (v: string) => `Basic ${Buffer.from(v).toString("base64")}`;
    expect(provider.authenticateIntrospectionClient(basic("gw:s3cret"))).toBe(true);
    expect(provider.authenticateIntrospectionClient(basic("gw:wrong"))).toBe(false);
    expect(provider.authenticateIntrospectionClient(basic("other:s3cret"))).toBe(false);
    expect(provider.authenticateIntrospectionClient(undefined)).toBe(false);
    expect(
      createDemoOAuthProvider({ issuer }).authenticateIntrospectionClient(basic("gw:s3cret"))
    ).toBe(false);
  });

  it("introspects refresh tokens per RFC 7662: active until rotated, revoked or expired", () => {
    const provider = createDemoOAuthProvider({
      issuer,
      refreshTokenTtlSeconds: 3600,
      introspectionClient: { clientId: "gw", clientSecret: "s3cret" },
    });
    const first = provider.issueAccessToken({ subject: "alice", scopes: [SCOPES.READ] });
    const before = Math.floor(Date.now() / 1000);
    for (const hint of [undefined, "refresh_token", "access_token", "bogus"]) {
      const res = provider.introspect(first.refresh_token, hint);
      expect(res).toEqual({
        active: true,
        token_type: "refresh_token",
        scope: SCOPES.READ,
        client_id: DEMO_CLIENT_ID,
        sub: "alice",
        iss: issuer,
        exp: expect.any(Number),
      });
      if (res.active) {
        expect(res.exp).toBeGreaterThanOrEqual(before + 3600 - 1);
        expect(res.exp).toBeLessThanOrEqual(before + 3600 + 1);
      }
    }
    // An access token is still an access token whatever the hint says.
    expect(provider.introspect(first.access_token, "refresh_token")).toMatchObject({
      active: true,
      token_type: "Bearer",
    });
    expect(JSON.stringify(provider.introspect(first.refresh_token))).not.toContain(
      first.refresh_token
    );

    // Rotation retires the old refresh token; the new one is active.
    const second = provider.exchangeRefreshToken({
      clientId: DEMO_CLIENT_ID,
      refreshToken: first.refresh_token,
    });
    expect(provider.introspect(first.refresh_token, "refresh_token")).toEqual({ active: false });
    expect(provider.introspect(second.refresh_token, "refresh_token")).toMatchObject({
      active: true,
      token_type: "refresh_token",
    });

    // Revocation.
    provider.revoke(second.refresh_token);
    expect(provider.introspect(second.refresh_token, "refresh_token")).toEqual({ active: false });

    // Unknown and expired.
    expect(provider.introspect("f".repeat(64), "refresh_token")).toEqual({ active: false });
    const shortLived = createDemoOAuthProvider({ issuer, refreshTokenTtlSeconds: 1 });
    const t = shortLived.issueAccessToken({ scopes: [SCOPES.READ] });
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2000;
      expect(shortLived.introspect(t.refresh_token, "refresh_token")).toEqual({ active: false });
    } finally {
      Date.now = realNow;
    }
  });

  it("discovery advertises no id_token support because no id tokens are issued", () => {
    const disc = createDemoOAuthProvider({ issuer }).discovery();
    expect(disc).not.toHaveProperty("id_token_signing_alg_values_supported");
    expect(disc.response_types_supported).toEqual(["code"]);
    expect(disc.scopes_supported).not.toContain("openid");
    expect(JSON.stringify(disc)).not.toMatch(/id_token/);
    // OIDC-only metadata is not advertised either (no ID tokens, so no subject types).
    expect(disc).not.toHaveProperty("subject_types_supported");
    // Contract consumed by s1-tool-gate's claims-gate proxy.
    expect(disc).toMatchObject({ issuer, jwks_uri: `${issuer}/oauth/jwks` });
  });

  it("publishes a public-only JWKS whose kid is the RFC 7638 thumbprint, and persists a dev key with 0600", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const [key] = provider.jwks().keys;
    expect(key).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: provider.signingKey.kid,
    });
    expect(key).not.toHaveProperty("d");
    expect(provider.signingKey.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const dir = mkdtempSync(join(tmpdir(), "kaia-key-"));
    try {
      const path = join(dir, "nested", "signing-key.pem");
      const a = SigningKey.fromFileOrCreate(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const b = SigningKey.fromFileOrCreate(path);
      expect(b.kid).toBe(a.kid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("revocation via a refresh token denies the access token until its real exp", () => {
  const issuer = "http://127.0.0.1:3999";
  // Default access TTL is 900 s; this token lives an hour.
  const LONG = 3600;

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers({ now: new Date("2026-10-08T12:00:00Z"), toFake: ["Date"] });
    const provider = createDemoOAuthProvider({ issuer });
    const t = provider.issueAccessToken({ scopes: [SCOPES.READ], expiresInSeconds: LONG });
    return { provider, t };
  }

  function pastDefaultTtl(provider: ReturnType<typeof createDemoOAuthProvider>): void {
    vi.setSystemTime(Date.now() + (provider.accessTokenTtlSeconds + 60) * 1000);
  }

  it("revoke(refresh_token)", () => {
    const { provider, t } = setup();
    provider.revoke(t.refresh_token);
    pastDefaultTtl(provider);
    expect(provider.verifyAccessToken(t.access_token)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.INVALID_TOKEN,
    });
    expect(provider.introspect(t.access_token)).toEqual({ active: false });
  });

  it("refresh rotation", () => {
    const { provider, t } = setup();
    provider.exchangeRefreshToken({ clientId: DEMO_CLIENT_ID, refreshToken: t.refresh_token });
    pastDefaultTtl(provider);
    expect(provider.verifyAccessToken(t.access_token)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.INVALID_TOKEN,
    });
  });

  it("control: the same token unrevoked is still valid at that time", () => {
    const { provider, t } = setup();
    pastDefaultTtl(provider);
    expect(provider.verifyAccessToken(t.access_token).ok).toBe(true);
  });
});

describe('bearerFromHeader (RFC 6750 2.1: "Bearer" 1*SP b64token)', () => {
  it("accepts the scheme in any case and one or more spaces before a b64token", async () => {
    const { bearerFromHeader } = await import("./provider.js");
    expect(bearerFromHeader("Bearer abc.DEF-_~+/123==")).toBe("abc.DEF-_~+/123==");
    expect(bearerFromHeader("bearer abc")).toBe("abc");
    expect(bearerFromHeader("Bearer  abc")).toBe("abc");
  });

  it("refuses tabs or other whitespace as the separator and non-b64token characters", async () => {
    const { bearerFromHeader } = await import("./provider.js");
    for (const h of [
      "Bearer\tabc",
      "Bearer\u00a0abc",
      "Bearer\u3000abc",
      "Bearer \tabc",
      "Bearer abc,",
      "Bearer abc, Bearer def",
      'Bearer "abc"',
      "Bearer ab=c",
      "Bearer abc\u00e9",
      "Bearer",
      "Bearer ",
      "Bearerabc",
      "Basic abc",
    ]) {
      expect(bearerFromHeader(h), JSON.stringify(h)).toBeUndefined();
    }
  });
});

/**
 * All authorization-server state (authorization requests, codes, device codes, refresh
 * tokens) lives behind injectable store interfaces, so a deployment can share it across
 * instances. Provider instances that share stores and a key behave as one AS. Stores never
 * hold a plaintext token, code or device code, and every entry expires.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoOAuthProvider } from "./provider.js";
import { SigningKey } from "./jwt.js";
import { generatePkcePair } from "./pkce.js";
import { DEMO_CLIENT_ID, SCOPES } from "./constants.js";
import {
  MemoryExpiringStore,
  createMemoryStateStores,
  type OAuthStateStores,
} from "./state-store.js";
import { runKaiaMcpServerHttp } from "../server.js";
import { resetConfigCache } from "../config.js";
import { jwtPayload, mcpPost } from "../test-support/mcp-http.js";

const issuer = "http://127.0.0.1:3999";
const REDIRECT = "http://127.0.0.1/callback";

afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryExpiringStore", () => {
  it("expires entries, take() removes atomically, and values are copies", () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T12:00:00Z"), toFake: ["Date"] });
    const s = new MemoryExpiringStore<{ n: number }>();
    s.set("a", { n: 1 }, Date.now() + 1000);
    const got = s.get("a")!;
    got.n = 99;
    expect(s.get("a")).toEqual({ n: 1 });
    expect(s.take("a")).toEqual({ n: 1 });
    expect(s.take("a")).toBeUndefined();
    s.set("b", { n: 2 }, Date.now() + 1000);
    vi.setSystemTime(Date.now() + 1001);
    expect(s.get("b")).toBeUndefined();
    expect(s.size).toBe(0);
  });
});

describe("provider state behind stores", () => {
  function pair(stores: OAuthStateStores = createMemoryStateStores()) {
    const key = SigningKey.generate();
    const a = createDemoOAuthProvider({ issuer, signingKey: key, stores });
    const b = createDemoOAuthProvider({ issuer, signingKey: key, stores });
    return { a, b, stores };
  }

  it("two providers sharing stores act as one AS across PKCE, refresh and device flows", () => {
    const { a, b } = pair();
    const pkce = generatePkcePair();
    const { requestId } = a.createAuthorizationRequest({
      clientId: DEMO_CLIENT_ID,
      redirectUri: REDIRECT,
      scope: SCOPES.READ,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
    });
    const code = new URL(b.consent(requestId, "approve").redirectUri).searchParams.get("code")!;
    const t1 = a.exchangeAuthorizationCode({
      clientId: DEMO_CLIENT_ID,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
    });
    expect(b.verifyAccessToken(t1.access_token).ok).toBe(true);
    expect(b.introspect(t1.refresh_token)).toMatchObject({
      active: true,
      token_type: "refresh_token",
    });

    const t2 = b.exchangeRefreshToken({ clientId: DEMO_CLIENT_ID, refreshToken: t1.refresh_token });
    expect(() =>
      a.exchangeRefreshToken({ clientId: DEMO_CLIENT_ID, refreshToken: t1.refresh_token })
    ).toThrow(/invalid_grant/);
    expect(a.verifyAccessToken(t2.access_token).ok).toBe(true);

    const dev = a.startDeviceAuthorization({ clientId: DEMO_CLIENT_ID, scope: SCOPES.READ });
    expect(b.peekDeviceByUserCode(dev.user_code)).toEqual({ scopes: [SCOPES.READ] });
    expect(() =>
      b.exchangeDeviceCode({ clientId: DEMO_CLIENT_ID, deviceCode: dev.device_code })
    ).toThrow(/authorization_pending/);
    b.consentDevice(dev.user_code, "approve");
    const t3 = a.exchangeDeviceCode({ clientId: DEMO_CLIENT_ID, deviceCode: dev.device_code });
    expect(b.verifyAccessToken(t3.access_token).ok).toBe(true);
    expect(() =>
      b.exchangeDeviceCode({ clientId: DEMO_CLIENT_ID, deviceCode: dev.device_code })
    ).toThrow(/invalid_grant/);
  });

  it("an authorization code redeems once across instances", () => {
    const { a, b } = pair();
    const pkce = generatePkcePair();
    const { requestId } = a.createAuthorizationRequest({
      clientId: DEMO_CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
    });
    const code = new URL(a.consent(requestId, "approve").redirectUri).searchParams.get("code")!;
    const params = {
      clientId: DEMO_CLIENT_ID,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
    };
    a.exchangeAuthorizationCode(params);
    expect(() => b.exchangeAuthorizationCode(params)).toThrow(/invalid_grant/);
  });

  it("stores never hold a plaintext access token, refresh token, code, request id or device code", () => {
    const seen: unknown[] = [];
    const keys: string[] = [];
    const recording = <T>() => {
      const inner = new MemoryExpiringStore<T>();
      return {
        get: (k: string) => inner.get(k),
        take: (k: string) => inner.take(k),
        delete: (k: string) => inner.delete(k),
        set: (k: string, v: T, exp: number) => {
          keys.push(k);
          seen.push(v);
          inner.set(k, v, exp);
        },
      };
    };
    const stores: OAuthStateStores = {
      authzRequests: recording(),
      authzCodes: recording(),
      devices: recording(),
      deviceUserCodes: recording(),
      refreshTokens: recording(),
    };
    const { a } = pair(stores);
    const pkce = generatePkcePair();
    const { requestId } = a.createAuthorizationRequest({
      clientId: DEMO_CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
    });
    const code = new URL(a.consent(requestId, "approve").redirectUri).searchParams.get("code")!;
    const t1 = a.exchangeAuthorizationCode({
      clientId: DEMO_CLIENT_ID,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
    });
    const dev = a.startDeviceAuthorization({ clientId: DEMO_CLIENT_ID });
    a.consentDevice(dev.user_code, "approve");
    const t2 = a.exchangeDeviceCode({ clientId: DEMO_CLIENT_ID, deviceCode: dev.device_code });
    const blob = JSON.stringify({ seen, keys });
    expect(seen.length).toBeGreaterThan(4);
    for (const secret of [
      requestId,
      code,
      dev.device_code,
      t1.access_token,
      t1.refresh_token,
      t2.access_token,
      t2.refresh_token,
    ]) {
      expect(blob).not.toContain(secret);
    }
  });

  it("authorization requests expire (no unbounded in-memory growth)", () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T12:00:00Z"), toFake: ["Date"] });
    const { a } = pair();
    const { requestId } = a.createAuthorizationRequest({
      clientId: DEMO_CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: generatePkcePair().challenge,
      codeChallengeMethod: "S256",
    });
    vi.setSystemTime(Date.now() + 601_000);
    expect(() => a.consent(requestId, "approve")).toThrow(/unknown consent request/);
  });
});

describe("signing key rotation: JWKS publishes current + previous keys", () => {
  it("tokens signed by a previous key still verify; new tokens use the current kid", () => {
    const oldKey = SigningKey.generate();
    const newKey = SigningKey.generate();
    const before = createDemoOAuthProvider({ issuer, signingKey: oldKey });
    const oldToken = before.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const after = createDemoOAuthProvider({
      issuer,
      signingKey: newKey,
      previousSigningKeys: [oldKey],
    });
    expect(after.jwks().keys.map((k) => k.kid)).toEqual([newKey.kid, oldKey.kid]);
    expect(after.verifyAccessToken(oldToken).ok).toBe(true);
    expect(after.introspect(oldToken)).toMatchObject({ active: true });
    const fresh = after.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    expect(JSON.parse(Buffer.from(fresh.split(".")[0], "base64url").toString()).kid).toBe(
      newKey.kid
    );
    after.revoke(oldToken);
    expect(after.verifyAccessToken(oldToken).ok).toBe(false);
    const dropped = createDemoOAuthProvider({ issuer, signingKey: newKey });
    expect(
      dropped.verifyAccessToken(before.issueAccessToken({ scopes: [SCOPES.READ] }).access_token).ok
    ).toBe(false);
  });

  it("KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES publishes the old key over HTTP and accepts its tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaia-rot-"));
    try {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const oldPem = join(dir, "old.pem");
      writeFileSync(oldPem, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
      const oldKey = SigningKey.fromFile(oldPem);
      process.env.LOG_LEVEL = "error";
      process.env.KAIA_AUTH_MODE = "required";
      process.env.KAIA_PUBLIC_URL = "https://kaia.example.test";
      process.env.KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES = oldPem;
      resetConfigCache();
      const h = await runKaiaMcpServerHttp(0);
      try {
        const jwks = (await (await fetch(`${h.localUrl}/oauth/jwks`)).json()) as {
          keys: { kid: string; d?: string }[];
        };
        expect(jwks.keys.map((k) => k.kid)).toEqual([h.oauth.signingKey.kid, oldKey.kid]);
        expect(jwks.keys.every((k) => !("d" in k))).toBe(true);
        const oldToken = createDemoOAuthProvider({
          issuer: "https://kaia.example.test",
          signingKey: oldKey,
        }).issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
        expect(jwtPayload(oldToken).aud).toBe("https://kaia.example.test");
        const { res } = await mcpPost(
          h.localUrl,
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { token: oldToken }
        );
        expect(res.status).toBe(200);
      } finally {
        await h.close();
      }
      process.env.KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES = join(dir, "missing.pem");
      resetConfigCache();
      await expect(runKaiaMcpServerHttp(0)).rejects.toThrow(/previous signing key/);
    } finally {
      for (const k of [
        "LOG_LEVEL",
        "KAIA_AUTH_MODE",
        "KAIA_PUBLIC_URL",
        "KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES",
      ])
        delete process.env[k];
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

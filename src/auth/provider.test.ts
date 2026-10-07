import { describe, it, expect } from "vitest";
import { createDemoOAuthProvider } from "./provider.js";
import { generatePkcePair } from "./pkce.js";
import { AUTH_ERRORS, DEMO_CLIENT_ID, SCOPES } from "./constants.js";

describe("DemoOAuthProvider", () => {
  const issuer = "http://127.0.0.1:3999";

  it("issues hashed tokens and verifies by fingerprint without storing a lookup by plaintext besides hash", () => {
    const provider = createDemoOAuthProvider({ issuer });
    const tokens = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    const ok = provider.verifyAccessToken(tokens.access_token);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.context.scopes).toEqual([SCOPES.READ]);
      expect(ok.context.tokenFingerprint).toMatch(/^[a-f0-9]{12}$/);
      expect(ok.context.tokenFingerprint).not.toBe(tokens.access_token);
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
});

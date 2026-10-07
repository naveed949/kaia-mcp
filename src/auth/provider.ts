import { createHash, randomBytes } from "node:crypto";
import { logger } from "../utils/logger.js";
import { verifyPkce } from "./pkce.js";
import {
  ALL_SCOPES,
  AUTH_CODE_TTL_SECONDS,
  AUTH_ERRORS,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  DEMO_CLIENT_ID,
  DEMO_REDIRECT_URIS,
  DEMO_SUBJECT,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
} from "./constants.js";
import type { IssuedTokens, IssueAccessTokenParams, VerifyResult } from "./types.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(token: string): string {
  return sha256Hex(token).slice(0, 12);
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function userCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = Array.from({ length: 8 }, () => alphabet[randomBytes(1)[0] % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function parseScopes(scope: string | undefined): string[] {
  const requested = (scope ?? "").split(/\s+/).filter(Boolean);
  if (requested.length === 0) return [ALL_SCOPES[0]];
  const unknown = requested.filter((s) => !ALL_SCOPES.includes(s as (typeof ALL_SCOPES)[number]));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`invalid_scope: ${unknown.join(" ")}`), { oauthError: "invalid_scope" });
  }
  return requested;
}

export type DemoOAuthProviderOptions = {
  issuer: string;
  clientId?: string;
  redirectUris?: readonly string[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
};

type AccessRecord = {
  subject: string;
  clientId: string;
  scopes: string[];
  expiresAtMs: number;
  revoked: boolean;
};

type RefreshRecord = {
  accessHash: string;
  clientId: string;
  subject: string;
  scopes: string[];
  expiresAtMs: number;
  revoked: boolean;
};

type AuthzRequest = {
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  createdAtMs: number;
};

type AuthzCode = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  subject: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAtMs: number;
  consumed: boolean;
};

type DevicePending = {
  clientId: string;
  scopes: string[];
  userCode: string;
  expiresAtMs: number;
  status: "pending" | "authorized" | "denied";
  subject?: string;
  access?: IssuedTokens;
};

/**
 * In-process demo OIDC/OAuth 2.1 provider (PKCE + device flow + revoke).
 * Tokens are stored hashed; plaintext is returned once to the client and never logged.
 */
export class DemoOAuthProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;

  private readonly access = new Map<string, AccessRecord>();
  private readonly refresh = new Map<string, RefreshRecord>();
  private readonly authzRequests = new Map<string, AuthzRequest>();
  private readonly authzCodes = new Map<string, AuthzCode>();
  private readonly devices = new Map<string, DevicePending>();
  private readonly devicesByUserCode = new Map<string, string>();

  constructor(options: DemoOAuthProviderOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.clientId = options.clientId ?? DEMO_CLIENT_ID;
    this.redirectUris = options.redirectUris ?? DEMO_REDIRECT_URIS;
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  }

  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      device_authorization_endpoint: `${this.issuer}/oauth/device`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      jwks_uri: `${this.issuer}/oauth/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...ALL_SCOPES],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["none"],
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.issuer,
      authorization_servers: [this.issuer],
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "kaia-mcp",
    };
  }

  isRegisteredClient(clientId: string): boolean {
    return clientId === this.clientId;
  }

  isAllowedRedirectUri(uri: string): boolean {
    return this.redirectUris.includes(uri);
  }

  createAuthorizationRequest(params: {
    clientId: string;
    redirectUri: string;
    state?: string;
    scope?: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  }): { requestId: string; scopes: string[] } {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    if (!this.isAllowedRedirectUri(params.redirectUri)) {
      throw Object.assign(new Error("invalid_request: redirect_uri is not registered"), {
        oauthError: "invalid_request",
      });
    }
    if (params.codeChallengeMethod !== "S256" || !params.codeChallenge) {
      throw Object.assign(new Error("invalid_request: PKCE S256 is required"), {
        oauthError: "invalid_request",
      });
    }
    const scopes = parseScopes(params.scope);
    const requestId = randomToken();
    this.authzRequests.set(requestId, {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      createdAtMs: Date.now(),
    });
    logger.info("oauth authorization request created", {
      requestFingerprint: fingerprint(requestId),
      clientId: params.clientId,
      scopes: scopes.join(" "),
    });
    return { requestId, scopes };
  }

  getAuthorizationRequest(requestId: string): AuthzRequest | undefined {
    return this.authzRequests.get(requestId);
  }

  consent(requestId: string, decision: "approve" | "deny"): { redirectUri: string } {
    const req = this.authzRequests.get(requestId);
    if (!req) {
      throw Object.assign(new Error("invalid_request: unknown consent request"), {
        oauthError: "invalid_request",
      });
    }
    this.authzRequests.delete(requestId);
    const url = new URL(req.redirectUri);
    if (req.state) url.searchParams.set("state", req.state);
    if (decision !== "approve") {
      url.searchParams.set("error", "access_denied");
      logger.info("oauth consent denied", { clientId: req.clientId });
      return { redirectUri: url.toString() };
    }
    const code = randomToken();
    this.authzCodes.set(sha256Hex(code), {
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      scopes: req.scopes,
      subject: DEMO_SUBJECT,
      codeChallenge: req.codeChallenge,
      codeChallengeMethod: req.codeChallengeMethod,
      expiresAtMs: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
      consumed: false,
    });
    url.searchParams.set("code", code);
    logger.info("oauth consent approved", {
      clientId: req.clientId,
      scopes: req.scopes.join(" "),
      codeFingerprint: fingerprint(code),
    });
    return { redirectUri: url.toString() };
  }

  exchangeAuthorizationCode(params: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): IssuedTokens {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    const record = this.authzCodes.get(sha256Hex(params.code));
    if (!record || record.consumed) {
      throw Object.assign(new Error("invalid_grant: authorization code is invalid"), {
        oauthError: "invalid_grant",
      });
    }
    if (record.expiresAtMs <= Date.now()) {
      this.authzCodes.delete(sha256Hex(params.code));
      throw Object.assign(new Error("invalid_grant: authorization code has expired"), {
        oauthError: "invalid_grant",
      });
    }
    if (record.clientId !== params.clientId || record.redirectUri !== params.redirectUri) {
      throw Object.assign(new Error("invalid_grant: code does not match client or redirect_uri"), {
        oauthError: "invalid_grant",
      });
    }
    if (!verifyPkce(params.codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
      throw Object.assign(new Error("invalid_grant: PKCE verification failed"), {
        oauthError: "invalid_grant",
      });
    }
    record.consumed = true;
    this.authzCodes.delete(sha256Hex(params.code));
    return this.mintTokens({
      subject: record.subject,
      clientId: record.clientId,
      scopes: record.scopes,
    });
  }

  startDeviceAuthorization(params: { clientId: string; scope?: string }): {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  } {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    const scopes = parseScopes(params.scope);
    const deviceCode = randomToken();
    const code = userCode();
    this.devices.set(sha256Hex(deviceCode), {
      clientId: params.clientId,
      scopes,
      userCode: code,
      expiresAtMs: Date.now() + DEVICE_CODE_TTL_SECONDS * 1000,
      status: "pending",
    });
    this.devicesByUserCode.set(code, sha256Hex(deviceCode));
    logger.info("oauth device authorization started", {
      deviceFingerprint: fingerprint(deviceCode),
      userCode: code,
      scopes: scopes.join(" "),
    });
    return {
      device_code: deviceCode,
      user_code: code,
      verification_uri: `${this.issuer}/oauth/device/verify`,
      verification_uri_complete: `${this.issuer}/oauth/device/verify?user_code=${encodeURIComponent(code)}`,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    };
  }

  peekDeviceByUserCode(userCodeRaw: string): { scopes: string[] } | undefined {
    const user = userCodeRaw.trim().toUpperCase();
    const hash = this.devicesByUserCode.get(user);
    if (!hash) return undefined;
    const pending = this.devices.get(hash);
    if (!pending) return undefined;
    return { scopes: pending.scopes };
  }

  consentDevice(userCodeRaw: string, decision: "approve" | "deny"): void {
    const user = userCodeRaw.trim().toUpperCase();
    const hash = this.devicesByUserCode.get(user);
    if (!hash) {
      throw Object.assign(new Error("invalid_request: unknown user_code"), { oauthError: "invalid_request" });
    }
    const pending = this.devices.get(hash);
    if (!pending || pending.expiresAtMs <= Date.now()) {
      throw Object.assign(new Error("expired_token"), { oauthError: "expired_token" });
    }
    if (decision !== "approve") {
      pending.status = "denied";
      logger.info("oauth device consent denied", { userCode: user });
      return;
    }
    pending.status = "authorized";
    pending.subject = DEMO_SUBJECT;
    pending.access = this.mintTokens({
      subject: DEMO_SUBJECT,
      clientId: pending.clientId,
      scopes: pending.scopes,
    });
    logger.info("oauth device consent approved", { userCode: user, scopes: pending.scopes.join(" ") });
  }

  exchangeDeviceCode(params: { clientId: string; deviceCode: string }): IssuedTokens {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    const pending = this.devices.get(sha256Hex(params.deviceCode));
    if (!pending) {
      throw Object.assign(new Error("invalid_grant"), { oauthError: "invalid_grant" });
    }
    if (pending.clientId !== params.clientId) {
      throw Object.assign(new Error("invalid_grant"), { oauthError: "invalid_grant" });
    }
    if (pending.expiresAtMs <= Date.now()) {
      throw Object.assign(new Error("expired_token"), { oauthError: "expired_token" });
    }
    if (pending.status === "pending") {
      throw Object.assign(new Error("authorization_pending"), { oauthError: "authorization_pending" });
    }
    if (pending.status === "denied") {
      throw Object.assign(new Error("access_denied"), { oauthError: "access_denied" });
    }
    if (!pending.access) {
      throw Object.assign(new Error("invalid_grant"), { oauthError: "invalid_grant" });
    }
    const tokens = pending.access;
    this.devices.delete(sha256Hex(params.deviceCode));
    this.devicesByUserCode.delete(pending.userCode);
    return tokens;
  }

  exchangeRefreshToken(params: { clientId: string; refreshToken: string }): IssuedTokens {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    const record = this.refresh.get(sha256Hex(params.refreshToken));
    if (!record || record.revoked || record.expiresAtMs <= Date.now()) {
      throw Object.assign(new Error("invalid_grant: refresh token is invalid or expired"), {
        oauthError: "invalid_grant",
      });
    }
    if (record.clientId !== params.clientId) {
      throw Object.assign(new Error("invalid_grant"), { oauthError: "invalid_grant" });
    }
    record.revoked = true;
    const access = this.access.get(record.accessHash);
    if (access) access.revoked = true;
    return this.mintTokens({
      subject: record.subject,
      clientId: record.clientId,
      scopes: record.scopes,
    });
  }

  /**
   * Issue tokens for tests and the demo IdP. Plaintext is returned once; store keeps hashes only.
   */
  issueAccessToken(params: IssueAccessTokenParams): IssuedTokens {
    return this.mintTokens({
      subject: params.subject ?? DEMO_SUBJECT,
      clientId: params.clientId ?? this.clientId,
      scopes: [...params.scopes],
      expiresInSeconds: params.expiresInSeconds,
      expiresAtMs: params.expiresAtMs,
    });
  }

  revoke(token: string): void {
    const hash = sha256Hex(token);
    const access = this.access.get(hash);
    if (access) {
      access.revoked = true;
      logger.info("oauth access token revoked", { tokenFingerprint: fingerprint(token) });
      return;
    }
    const refresh = this.refresh.get(hash);
    if (refresh) {
      refresh.revoked = true;
      const linked = this.access.get(refresh.accessHash);
      if (linked) linked.revoked = true;
      logger.info("oauth refresh token revoked", { tokenFingerprint: fingerprint(token) });
    }
  }

  verifyAccessToken(token: string | undefined): VerifyResult {
    if (!token) {
      return { ok: false, status: 401, ...AUTH_ERRORS.UNAUTHORIZED };
    }
    const record = this.access.get(sha256Hex(token));
    if (!record || record.revoked) {
      return { ok: false, status: 401, ...AUTH_ERRORS.INVALID_TOKEN };
    }
    if (record.expiresAtMs <= Date.now()) {
      return { ok: false, status: 401, ...AUTH_ERRORS.TOKEN_EXPIRED };
    }
    return {
      ok: true,
      context: {
        subject: record.subject,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAtMs: record.expiresAtMs,
        tokenFingerprint: fingerprint(token),
      },
    };
  }

  private mintTokens(params: {
    subject: string;
    clientId: string;
    scopes: string[];
    expiresInSeconds?: number;
    expiresAtMs?: number;
  }): IssuedTokens {
    const ttl = params.expiresInSeconds ?? this.accessTokenTtlSeconds;
    const expiresAtMs = params.expiresAtMs ?? Date.now() + ttl * 1000;
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessHash = sha256Hex(accessToken);
    this.access.set(accessHash, {
      subject: params.subject,
      clientId: params.clientId,
      scopes: params.scopes,
      expiresAtMs,
      revoked: false,
    });
    this.refresh.set(sha256Hex(refreshToken), {
      accessHash,
      clientId: params.clientId,
      subject: params.subject,
      scopes: params.scopes,
      expiresAtMs: Date.now() + this.refreshTokenTtlSeconds * 1000,
      revoked: false,
    });
    const expiresIn = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    logger.info("oauth tokens issued", {
      tokenFingerprint: fingerprint(accessToken),
      subject: params.subject,
      clientId: params.clientId,
      scopes: params.scopes.join(" "),
      expiresIn,
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: params.scopes.join(" "),
    };
  }
}

export function createDemoOAuthProvider(options: DemoOAuthProviderOptions): DemoOAuthProvider {
  return new DemoOAuthProvider(options);
}

export function bearerFromHeader(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

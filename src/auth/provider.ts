import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { logger } from "../utils/logger.js";
import { verifyPkce } from "./pkce.js";
import { checkAccessTokenClaims, SigningKey } from "./jwt.js";
import { MemoryRevocationStore, type RevocationStore } from "./revocation-store.js";
import {
  ALL_SCOPES,
  AUTH_CODE_TTL_SECONDS,
  AUTH_ERRORS,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_AUDIENCE,
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
    throw Object.assign(new Error(`invalid_scope: ${unknown.join(" ")}`), {
      oauthError: "invalid_scope",
    });
  }
  return requested;
}

export type DemoOAuthProviderOptions = {
  issuer: string;
  clientId?: string;
  redirectUris?: readonly string[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /** `aud` claim for access tokens. Default "kaia-mcp". */
  audience?: string;
  /** RS256 signing key. Default: a fresh in-memory key per process. */
  signingKey?: SigningKey;
  /**
   * Denylist of revoked access-token `jti`s. Default: in memory. Use a persistent store
   * whenever the signing key outlives the process, or revoked tokens revive on restart.
   */
  revocationStore?: RevocationStore;
  /** Resource-server credentials for RFC 7662 introspection. Introspection is disabled when unset. */
  introspectionClient?: { clientId: string; clientSecret: string };
};

export type IntrospectionResponse =
  | { active: false }
  | {
      active: true;
      token_type: "Bearer";
      scope: string;
      client_id: string;
      sub: string;
      aud: string;
      iss: string;
      exp: number;
      iat: number;
      nbf: number;
      jti: string;
    }
  | {
      active: true;
      token_type: "refresh_token";
      scope: string;
      client_id: string;
      sub: string;
      iss: string;
      exp: number;
    };

type RefreshRecord = {
  accessJti: string;
  /** `exp` of the access token minted with this refresh token (ms), so revoking via the refresh token denies that jti for its whole life. */
  accessExpMs: number;
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
 * In-process demo OIDC/OAuth 2.1 provider (PKCE + device flow + revoke + introspection).
 *
 * Access tokens are RS256 JWTs (RFC 9068 shape: iss, aud, sub, client_id, scope,
 * iat, nbf, exp, jti) verifiable offline against `jwks()`. Revocation is by `jti`
 * (kept in a `RevocationStore`) and is visible to gateways through `introspect()`. Refresh tokens stay opaque
 * and are stored hashed. No token is ever logged; logs carry a sha256 fingerprint.
 */
export class DemoOAuthProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly audience: string;
  readonly signingKey: SigningKey;
  private readonly introspectionClient?: { clientId: string; clientSecret: string };

  /** Revoked access-token jtis, each kept until the token would have expired anyway. */
  private readonly revocations: RevocationStore;
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
    this.refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    this.audience = options.audience ?? DEFAULT_AUDIENCE;
    this.signingKey = options.signingKey ?? SigningKey.generate();
    this.revocations = options.revocationStore ?? new MemoryRevocationStore();
    if (options.introspectionClient?.clientSecret) {
      this.introspectionClient = options.introspectionClient;
    }
  }

  jwks(): { keys: Record<string, unknown>[] } {
    return this.signingKey.jwks();
  }

  get introspectionEnabled(): boolean {
    return Boolean(this.introspectionClient);
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
      // No id_token is ever issued, so no id_token_signing_alg_values_supported and no
      // response type beyond "code". The openid-configuration path stays as an alias of
      // the RFC 8414 document because gateways (s1-tool-gate) discover through it.
      subject_types_supported: ["public"],
      access_token_signing_alg_values_supported: ["RS256"],
      ...(this.introspectionEnabled
        ? {
            introspection_endpoint: `${this.issuer}/oauth/introspect`,
            introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
          }
        : {}),
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.issuer,
      authorization_servers: [this.issuer],
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "kaia-mcp",
      token_audience: this.audience,
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
      throw Object.assign(new Error("invalid_request: unknown user_code"), {
        oauthError: "invalid_request",
      });
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
    logger.info("oauth device consent approved", {
      userCode: user,
      scopes: pending.scopes.join(" "),
    });
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
      throw Object.assign(new Error("authorization_pending"), {
        oauthError: "authorization_pending",
      });
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
    this.revokeJti(record.accessJti, record.accessExpMs);
    return this.mintTokens({
      subject: record.subject,
      clientId: record.clientId,
      scopes: record.scopes,
    });
  }

  /**
   * Issue tokens for tests and the demo IdP. The JWT is returned once and not stored; refresh tokens are kept hashed.
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

  /** RFC 7009. Unknown or malformed tokens are ignored (the endpoint still answers 200). */
  revoke(token: string): void {
    const payload = token ? this.signingKey.verifySignature(token) : null;
    if (payload && typeof payload.jti === "string") {
      const expMs = typeof payload.exp === "number" ? payload.exp * 1000 : Date.now();
      this.revokeJti(payload.jti, expMs);
      logger.info("oauth access token revoked", {
        tokenFingerprint: fingerprint(token),
        jti: payload.jti,
      });
      return;
    }
    const refresh = this.refresh.get(sha256Hex(token));
    if (refresh) {
      refresh.revoked = true;
      this.revokeJti(refresh.accessJti, refresh.accessExpMs);
      logger.info("oauth refresh token revoked", { tokenFingerprint: fingerprint(token) });
    }
  }

  isRevoked(jti: string): boolean {
    return this.revocations.has(jti);
  }

  verifyAccessToken(token: string | undefined): VerifyResult {
    if (!token) {
      return { ok: false, status: 401, ...AUTH_ERRORS.UNAUTHORIZED };
    }
    const payload = this.signingKey.verifySignature(token);
    if (!payload) {
      return { ok: false, status: 401, ...AUTH_ERRORS.INVALID_TOKEN };
    }
    const checked = checkAccessTokenClaims(payload, {
      issuer: this.issuer,
      audience: this.audience,
      nowSeconds: Date.now() / 1000,
    });
    if (!checked.ok) {
      return {
        ok: false,
        status: 401,
        ...(checked.reason === "expired" ? AUTH_ERRORS.TOKEN_EXPIRED : AUTH_ERRORS.INVALID_TOKEN),
      };
    }
    const { claims } = checked;
    if (this.isRevoked(claims.jti)) {
      return { ok: false, status: 401, ...AUTH_ERRORS.INVALID_TOKEN };
    }
    return {
      ok: true,
      context: {
        subject: claims.sub,
        clientId: claims.client_id,
        scopes: claims.scope.split(" ").filter(Boolean),
        expiresAtMs: claims.exp * 1000,
        tokenFingerprint: fingerprint(token),
        tokenId: claims.jti,
      },
    };
  }

  /**
   * RFC 7662 introspection for access and refresh tokens. `token_type_hint` only picks
   * which store is searched first; per RFC 7662 §2.1 the other is searched too.
   * Anything that is not a currently valid, unrevoked token is `{ active: false }`.
   * Access tokens answer `token_type: "Bearer"`, refresh tokens `"refresh_token"`, so a
   * resource server can refuse a refresh token presented as a bearer credential.
   */
  introspect(token: string | undefined, tokenTypeHint?: string): IntrospectionResponse {
    if (!token) return { active: false };
    if (tokenTypeHint === "refresh_token") {
      return this.introspectRefresh(token) ?? this.introspectAccess(token);
    }
    const access = this.introspectAccess(token);
    return access.active ? access : (this.introspectRefresh(token) ?? access);
  }

  /** Active refresh-token metadata, or undefined when `token` is not a live refresh token. */
  private introspectRefresh(token: string): IntrospectionResponse | undefined {
    const record = this.refresh.get(sha256Hex(token));
    if (!record || record.revoked || record.expiresAtMs <= Date.now()) return undefined;
    return {
      active: true,
      token_type: "refresh_token",
      scope: record.scopes.join(" "),
      client_id: record.clientId,
      sub: record.subject,
      iss: this.issuer,
      exp: Math.floor(record.expiresAtMs / 1000),
    };
  }

  private introspectAccess(token: string): IntrospectionResponse {
    const payload = this.signingKey.verifySignature(token);
    if (!payload) return { active: false };
    const checked = checkAccessTokenClaims(payload, {
      issuer: this.issuer,
      audience: this.audience,
      nowSeconds: Date.now() / 1000,
    });
    if (!checked.ok || this.isRevoked(checked.claims.jti)) return { active: false };
    const c = checked.claims;
    return {
      active: true,
      token_type: "Bearer",
      scope: c.scope,
      client_id: c.client_id,
      sub: c.sub,
      aud: c.aud,
      iss: c.iss,
      exp: c.exp,
      iat: c.iat,
      nbf: c.nbf,
      jti: c.jti,
    };
  }

  /** client_secret_basic check for the introspection caller. Constant-time on the secret digest. */
  authenticateIntrospectionClient(authorization: string | undefined): boolean {
    const client = this.introspectionClient;
    if (!client || !authorization) return false;
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization.trim());
    if (!match) return false;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return false;
    const id = decodeURIComponent(decoded.slice(0, sep));
    const secret = decodeURIComponent(decoded.slice(sep + 1));
    const a = createHash("sha256").update(secret).digest();
    const b = createHash("sha256").update(client.clientSecret).digest();
    return id === client.clientId && timingSafeEqual(a, b);
  }

  /** Throws if the store cannot make the entry durable; the jti is denied in-process regardless. */
  private revokeJti(jti: string, expMs: number): void {
    this.revocations.add(jti, expMs);
  }

  private mintTokens(params: {
    subject: string;
    clientId: string;
    scopes: string[];
    expiresInSeconds?: number;
    expiresAtMs?: number;
  }): IssuedTokens {
    const ttl = params.expiresInSeconds ?? this.accessTokenTtlSeconds;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtMs = params.expiresAtMs ?? (nowSeconds + ttl) * 1000;
    const expSeconds = Math.floor(expiresAtMs / 1000);
    const jti = randomUUID();
    const accessToken = this.signingKey.sign({
      iss: this.issuer,
      aud: this.audience,
      sub: params.subject,
      client_id: params.clientId,
      scope: params.scopes.join(" "),
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: expSeconds,
      jti,
    });
    const refreshToken = randomToken();
    this.refresh.set(sha256Hex(refreshToken), {
      accessJti: jti,
      accessExpMs: expSeconds * 1000,
      clientId: params.clientId,
      subject: params.subject,
      scopes: params.scopes,
      expiresAtMs: Date.now() + this.refreshTokenTtlSeconds * 1000,
      revoked: false,
    });
    const expiresIn = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    logger.info("oauth tokens issued", {
      tokenFingerprint: fingerprint(accessToken),
      jti,
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

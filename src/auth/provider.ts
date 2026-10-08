import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { logger } from "../utils/logger.js";
import { verifyPkce } from "./pkce.js";
import { checkAccessTokenClaims, SigningKey } from "./jwt.js";
import { MemoryRevocationStore, type RevocationStore } from "./revocation-store.js";
import { canonicalResource, invalidTarget } from "./resource.js";
import {
  createMemoryStateStores,
  type AuthzRequest,
  type OAuthStateStores,
} from "./state-store.js";
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
  /**
   * Canonical resource URI this AS issues tokens for (RFC 8707). Access tokens carry it as
   * `aud` and `verifyAccessToken` requires it. Default: the issuer.
   */
  resource?: string;
  /** Extra `aud` value minted next to `resource` for legacy gateways. Never sufficient alone. */
  legacyAudience?: string;
  /** Reject authorize/device/token requests that omit `resource`. Default false. */
  requireResource?: boolean;
  /** RS256 signing key. Default: a fresh in-memory key per process. */
  signingKey?: SigningKey;
  /**
   * Retired keys still published in the JWKS and accepted for verification (never used to
   * sign), so tokens minted before a key rotation stay valid until they expire.
   */
  previousSigningKeys?: readonly SigningKey[];
  /** Authorization-server state (codes, device codes, refresh tokens). Default: in memory. */
  stores?: OAuthStateStores;
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
      aud: string | string[];
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

/**
 * In-process demo OIDC/OAuth 2.1 provider (PKCE + device flow + revoke + introspection).
 *
 * Access tokens are RS256 JWTs (RFC 9068 shape: iss, aud, sub, client_id, scope,
 * iat, nbf, exp, jti) verifiable offline against `jwks()`. Revocation is by `jti`, kept
 * in a `RevocationStore`, and gateways see it through `introspect()`. Refresh tokens
 * stay opaque and are stored hashed. No token is ever logged; logs carry a sha256
 * fingerprint.
 */
export class DemoOAuthProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  /** Canonical resource URI: required in every accepted token's `aud`. */
  readonly resource: string;
  readonly legacyAudience?: string;
  readonly requireResource: boolean;
  readonly signingKey: SigningKey;
  /** Verify-only keys from before a rotation. */
  readonly previousSigningKeys: readonly SigningKey[];
  private readonly introspectionClient?: { clientId: string; clientSecret: string };

  /** Revoked access-token jtis, each kept until the token would have expired anyway. */
  private readonly revocations: RevocationStore;
  /** Every other piece of AS state; see state-store.ts. */
  private readonly stores: OAuthStateStores;

  constructor(options: DemoOAuthProviderOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.clientId = options.clientId ?? DEMO_CLIENT_ID;
    this.redirectUris = options.redirectUris ?? DEMO_REDIRECT_URIS;
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    const resource = options.resource ?? this.issuer;
    // A URI resource is compared in canonical form; a non-URI value (tests minting a
    // foreign-audience token) is kept verbatim.
    this.resource = canonicalResource(resource) ?? resource;
    if (options.legacyAudience && options.legacyAudience !== this.resource) {
      this.legacyAudience = options.legacyAudience;
    }
    this.requireResource = Boolean(options.requireResource);
    this.signingKey = options.signingKey ?? SigningKey.generate();
    this.previousSigningKeys = (options.previousSigningKeys ?? []).filter(
      (k, i, all) => k.kid !== this.signingKey.kid && all.findIndex((o) => o.kid === k.kid) === i
    );
    this.stores = options.stores ?? createMemoryStateStores();
    this.revocations = options.revocationStore ?? new MemoryRevocationStore();
    if (options.introspectionClient?.clientSecret) {
      this.introspectionClient = options.introspectionClient;
    }
  }

  /** `aud` claim of minted access tokens. */
  get audience(): string | string[] {
    return this.legacyAudience ? [this.resource, this.legacyAudience] : this.resource;
  }

  /**
   * RFC 8707 check of the `resource` values on an authorize, device or token request.
   * Exactly one value naming this server's canonical URI is accepted. An omitted resource
   * means this server (the only resource this AS serves) unless `requireResource` is set.
   * Anything else is invalid_target.
   */
  checkResource(values: string | readonly string[] | undefined): void {
    const list = values === undefined ? [] : typeof values === "string" ? [values] : values;
    if (list.length === 0) {
      if (this.requireResource) throw invalidTarget("resource is required");
      return;
    }
    if (list.length > 1) throw invalidTarget("exactly one resource is supported");
    if (canonicalResource(list[0]) !== this.resource) {
      throw invalidTarget("resource is not served by this authorization server");
    }
  }

  /** Current key first, then retired keys still accepted for verification. */
  jwks(): { keys: Record<string, unknown>[] } {
    return {
      keys: [this.signingKey, ...this.previousSigningKeys].map((k) => k.publicJwk()),
    };
  }

  /** Signature + header check against the current or a retired key (selected by kid). */
  private verifySignature(token: string): Record<string, unknown> | null {
    for (const key of [this.signingKey, ...this.previousSigningKeys]) {
      const payload = key.verifySignature(token);
      if (payload) return payload;
    }
    return null;
  }

  get introspectionEnabled(): boolean {
    return Boolean(this.introspectionClient);
  }

  /**
   * RFC 8414 authorization-server metadata, also served at /.well-known/openid-configuration
   * because gateways (s1-tool-gate) discover through that path. No ID token is ever issued,
   * so nothing OIDC-specific is advertised: no id_token signing algs, no subject types, and
   * no response type beyond "code".
   */
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
      // RFC 9207: every authorization response (success or error) carries `iss`.
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...ALL_SCOPES],
      access_token_signing_alg_values_supported: ["RS256"],
      ...(this.introspectionEnabled
        ? {
            introspection_endpoint: `${this.issuer}/oauth/introspect`,
            introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
          }
        : {}),
    };
  }

  /** RFC 9728 metadata URL for this resource (served at the origin's well-known path). */
  get resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource`;
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
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
    resource?: string | readonly string[];
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
    this.checkResource(params.resource);
    const requestId = randomToken();
    const now = Date.now();
    this.stores.authzRequests.set(
      sha256Hex(requestId),
      {
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        state: params.state,
        scopes,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod,
        createdAtMs: now,
      },
      now + AUTH_CODE_TTL_SECONDS * 1000
    );
    logger.info("oauth authorization request created", {
      requestFingerprint: fingerprint(requestId),
      clientId: params.clientId,
      scopes: scopes.join(" "),
    });
    return { requestId, scopes };
  }

  getAuthorizationRequest(requestId: string): AuthzRequest | undefined {
    return this.stores.authzRequests.get(sha256Hex(requestId));
  }

  consent(requestId: string, decision: "approve" | "deny"): { redirectUri: string } {
    // take(): a consent request is answered at most once, even across instances.
    const req = requestId ? this.stores.authzRequests.take(sha256Hex(requestId)) : undefined;
    if (!req) {
      throw Object.assign(new Error("invalid_request: unknown consent request"), {
        oauthError: "invalid_request",
      });
    }
    const url = new URL(req.redirectUri);
    if (req.state) url.searchParams.set("state", req.state);
    url.searchParams.set("iss", this.issuer);
    if (decision !== "approve") {
      url.searchParams.set("error", "access_denied");
      logger.info("oauth consent denied", { clientId: req.clientId });
      return { redirectUri: url.toString() };
    }
    const code = randomToken();
    const expiresAtMs = Date.now() + AUTH_CODE_TTL_SECONDS * 1000;
    this.stores.authzCodes.set(
      sha256Hex(code),
      {
        clientId: req.clientId,
        redirectUri: req.redirectUri,
        scopes: req.scopes,
        subject: DEMO_SUBJECT,
        codeChallenge: req.codeChallenge,
        codeChallengeMethod: req.codeChallengeMethod,
        expiresAtMs,
      },
      expiresAtMs
    );
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
    resource?: string | readonly string[];
  }): IssuedTokens {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    this.checkResource(params.resource);
    const codeKey = sha256Hex(params.code);
    const record = this.stores.authzCodes.get(codeKey);
    if (!record) {
      throw Object.assign(new Error("invalid_grant: authorization code is invalid"), {
        oauthError: "invalid_grant",
      });
    }
    if (record.expiresAtMs <= Date.now()) {
      this.stores.authzCodes.delete(codeKey);
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
    // Validation passed: redeem atomically. A concurrent redemption (another instance) wins
    // the take() and this one fails, so a code can never mint twice.
    if (!this.stores.authzCodes.take(codeKey)) {
      throw Object.assign(new Error("invalid_grant: authorization code is invalid"), {
        oauthError: "invalid_grant",
      });
    }
    return this.mintTokens({
      subject: record.subject,
      clientId: record.clientId,
      scopes: record.scopes,
    });
  }

  startDeviceAuthorization(params: {
    clientId: string;
    scope?: string;
    resource?: string | readonly string[];
  }): {
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
    this.checkResource(params.resource);
    const deviceCode = randomToken();
    const code = userCode();
    const expiresAtMs = Date.now() + DEVICE_CODE_TTL_SECONDS * 1000;
    this.stores.devices.set(
      sha256Hex(deviceCode),
      { clientId: params.clientId, scopes, userCode: code, expiresAtMs, status: "pending" },
      expiresAtMs
    );
    this.stores.deviceUserCodes.set(code, sha256Hex(deviceCode), expiresAtMs);
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
    const hash = this.stores.deviceUserCodes.get(user);
    if (!hash) return undefined;
    const pending = this.stores.devices.get(hash);
    if (!pending) return undefined;
    return { scopes: pending.scopes };
  }

  consentDevice(userCodeRaw: string, decision: "approve" | "deny"): void {
    const user = userCodeRaw.trim().toUpperCase();
    const hash = this.stores.deviceUserCodes.get(user);
    if (!hash) {
      throw Object.assign(new Error("invalid_request: unknown user_code"), {
        oauthError: "invalid_request",
      });
    }
    const pending = this.stores.devices.get(hash);
    if (!pending || pending.expiresAtMs <= Date.now()) {
      throw Object.assign(new Error("expired_token"), { oauthError: "expired_token" });
    }
    // Tokens are minted when the device redeems its code, not here, so no plaintext token
    // ever sits in the device store. The updated record is written back (stores copy).
    if (decision !== "approve") {
      this.stores.devices.set(hash, { ...pending, status: "denied" }, pending.expiresAtMs);
      logger.info("oauth device consent denied", { userCode: user });
      return;
    }
    this.stores.devices.set(
      hash,
      { ...pending, status: "authorized", subject: DEMO_SUBJECT },
      pending.expiresAtMs
    );
    logger.info("oauth device consent approved", {
      userCode: user,
      scopes: pending.scopes.join(" "),
    });
  }

  exchangeDeviceCode(params: {
    clientId: string;
    deviceCode: string;
    resource?: string | readonly string[];
  }): IssuedTokens {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    this.checkResource(params.resource);
    const deviceKey = sha256Hex(params.deviceCode);
    const pending = this.stores.devices.get(deviceKey);
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
    // Authorized: redeem atomically, so the device code mints exactly once.
    const redeemed = this.stores.devices.take(deviceKey);
    if (!redeemed || redeemed.status !== "authorized") {
      throw Object.assign(new Error("invalid_grant"), { oauthError: "invalid_grant" });
    }
    this.stores.deviceUserCodes.delete(redeemed.userCode);
    return this.mintTokens({
      subject: redeemed.subject ?? DEMO_SUBJECT,
      clientId: redeemed.clientId,
      scopes: redeemed.scopes,
    });
  }

  exchangeRefreshToken(params: {
    clientId: string;
    refreshToken: string;
    resource?: string | readonly string[];
  }): IssuedTokens {
    if (!this.isRegisteredClient(params.clientId)) {
      throw Object.assign(new Error("invalid_client"), { oauthError: "invalid_client" });
    }
    this.checkResource(params.resource);
    const refreshKey = sha256Hex(params.refreshToken);
    const record = this.stores.refreshTokens.get(refreshKey);
    if (!record || record.revoked || record.expiresAtMs <= Date.now()) {
      throw Object.assign(new Error("invalid_grant: refresh token is invalid or expired"), {
        oauthError: "invalid_grant",
      });
    }
    if (record.clientId !== params.clientId) {
      throw Object.assign(new Error("invalid_grant"), { oauthError: "invalid_grant" });
    }
    // Redeem atomically: of two concurrent rotations (possibly on two instances) one wins.
    if (!this.stores.refreshTokens.take(refreshKey)) {
      throw Object.assign(new Error("invalid_grant: refresh token is invalid or expired"), {
        oauthError: "invalid_grant",
      });
    }
    // Persist the old access jti first: if that throws (RevocationStoreError), the refresh
    // token is put back unconsumed and the client can retry the same rotation. The store
    // still denies the jti in this process, so the failure never widens access.
    try {
      this.revokeJti(record.accessJti, record.accessExpMs);
    } catch (err) {
      this.stores.refreshTokens.set(refreshKey, record, record.expiresAtMs);
      throw err;
    }
    return this.mintTokens({
      subject: record.subject,
      clientId: record.clientId,
      scopes: record.scopes,
    });
  }

  /**
   * Mint tokens directly (tests and the demo IdP). The JWT is returned once and never
   * stored; the refresh token is kept only as a hash.
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
    const payload = token ? this.verifySignature(token) : null;
    if (payload && typeof payload.jti === "string") {
      const expMs = typeof payload.exp === "number" ? payload.exp * 1000 : Date.now();
      this.revokeJti(payload.jti, expMs);
      logger.info("oauth access token revoked", {
        tokenFingerprint: fingerprint(token),
        jti: payload.jti,
      });
      return;
    }
    // Revoking only ever narrows access: the refresh token is tombstoned (revoked: true)
    // before its access jti is persisted, so it is dead even if that write throws (the jti
    // is still denied in-process and the caller gets a retryable 503). The tombstone keeps
    // the record so a retried revoke re-attempts the write; success deletes it.
    const refreshKey = token ? sha256Hex(token) : "";
    const refresh = token ? this.stores.refreshTokens.get(refreshKey) : undefined;
    if (refresh) {
      this.stores.refreshTokens.set(refreshKey, { ...refresh, revoked: true }, refresh.expiresAtMs);
      this.revokeJti(refresh.accessJti, refresh.accessExpMs);
      this.stores.refreshTokens.delete(refreshKey);
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
    const payload = this.verifySignature(token);
    if (!payload) {
      return { ok: false, status: 401, ...AUTH_ERRORS.INVALID_TOKEN };
    }
    const checked = checkAccessTokenClaims(payload, {
      issuer: this.issuer,
      audience: this.resource,
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
    const record = this.stores.refreshTokens.get(sha256Hex(token));
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
    const payload = this.verifySignature(token);
    if (!payload) return { active: false };
    const checked = checkAccessTokenClaims(payload, {
      issuer: this.issuer,
      audience: this.resource,
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
    const refreshExpiresAtMs = Date.now() + this.refreshTokenTtlSeconds * 1000;
    this.stores.refreshTokens.set(
      sha256Hex(refreshToken),
      {
        accessJti: jti,
        accessExpMs: expSeconds * 1000,
        clientId: params.clientId,
        subject: params.subject,
        scopes: params.scopes,
        expiresAtMs: refreshExpiresAtMs,
      },
      refreshExpiresAtMs
    );
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

/**
 * The token of an `Authorization: Bearer <token>` header, per RFC 6750 2.1:
 * `"Bearer" 1*SP b64token`. The scheme is case-insensitive (RFC 9110 11.1) and one or more
 * spaces may separate it from the token; a tab or other whitespace separator, a second
 * credential, quoting or any character outside b64token is not a bearer token.
 */
export function bearerFromHeader(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization.trim());
  return match?.[1];
}

export type BearerCredential =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "token"; token: string };

/**
 * What an Authorization header offers as a bearer credential:
 * - `token`: a well-formed `"Bearer" 1*SP b64token` (see bearerFromHeader);
 * - `malformed`: the Bearer scheme, whitespace, then something that is not one b64token
 *   (quoted, `%`, `!`, a trailing comma or junk, a second credential, a tab, NBSP or other
 *   non-space separator). The client did present a token, so it gets RFC 6750
 *   `invalid_token`;
 * - `none`: no header, an empty one, `Bearer` with nothing after it, or another scheme.
 *   The client presented no bearer token, so it gets the bare challenge (RFC 6750 3.1).
 */
export function parseBearerCredential(authorization: string | undefined): BearerCredential {
  const token = bearerFromHeader(authorization);
  if (token) return { kind: "token", token };
  // The scheme is exactly "Bearer" (the next character cannot continue an RFC 9110 token)
  // and, the header being trimmed, something other than whitespace follows it.
  if (/^Bearer[^!#$%&'*+.^_`|~0-9A-Za-z-]/i.test(authorization?.trim() ?? "")) {
    return { kind: "malformed" };
  }
  return { kind: "none" };
}

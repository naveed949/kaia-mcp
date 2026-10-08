/**
 * Storage seam for the demo authorization server's short-lived state. The provider only
 * talks to `OAuthStateStores`, so where that state lives is a deployment choice:
 *
 * - `createMemoryStateStores()` (default): per process. Fine for one instance.
 * - A shared store (Redis/KV) lets several stateless instances act as one AS.
 *
 * Keys are sha256 digests of the secret (code, device code, refresh token, request id),
 * never the secret itself, and values never contain a plaintext token. Every entry has an
 * expiry, so nothing grows without bound.
 *
 * The interface is synchronous because the provider is; an async network store needs the
 * provider's OAuth methods to become async first.
 */
import type { IssuedTokens } from "./types.js";

export interface ExpiringStore<T> {
  /** The live value for `key`, or undefined (missing or expired). */
  get(key: string): T | undefined;
  /** Store `value` until `expiresAtMs` (epoch ms), replacing any previous value. */
  set(key: string, value: T, expiresAtMs: number): void;
  delete(key: string): void;
  /**
   * Remove and return the live value in one atomic step (single-use redemption of codes,
   * device codes and refresh tokens). A shared implementation must make this atomic (e.g.
   * GETDEL), so two instances can never both redeem the same entry.
   */
  take(key: string): T | undefined;
}

/** In-process `ExpiringStore`. Values are copied in and out, like a networked store. */
export class MemoryExpiringStore<T> implements ExpiringStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAtMs: number }>();

  get(key: string): T | undefined {
    const e = this.live(key);
    return e ? structuredClone(e.value) : undefined;
  }

  set(key: string, value: T, expiresAtMs: number): void {
    this.prune();
    if (expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { value: structuredClone(value), expiresAtMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  take(key: string): T | undefined {
    const e = this.live(key);
    this.entries.delete(key);
    return e ? e.value : undefined;
  }

  /** Live entry count (tests). */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private live(key: string): { value: T; expiresAtMs: number } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private prune(now = Date.now()): void {
    for (const [k, e] of this.entries) if (e.expiresAtMs <= now) this.entries.delete(k);
  }
}

export type AuthzRequest = {
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  createdAtMs: number;
};

export type AuthzCode = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  subject: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAtMs: number;
};

export type DevicePending = {
  clientId: string;
  scopes: string[];
  userCode: string;
  expiresAtMs: number;
  status: "pending" | "authorized" | "denied";
  subject?: string;
};

export type RefreshRecord = {
  accessJti: string;
  /**
   * `exp` (epoch ms) of the access token minted alongside this refresh token. Rotating or
   * revoking the refresh token denies `accessJti` until then, not just for the default TTL.
   */
  accessExpMs: number;
  clientId: string;
  subject: string;
  scopes: string[];
  expiresAtMs: number;
  /** Tombstone: revoked, but its access jti could not be persisted yet (revoke retries). */
  revoked?: boolean;
};

export type OAuthStateStores = {
  /** sha256(request_id) -> pending consent. */
  authzRequests: ExpiringStore<AuthzRequest>;
  /** sha256(code) -> unredeemed authorization code. */
  authzCodes: ExpiringStore<AuthzCode>;
  /** sha256(device_code) -> device authorization. */
  devices: ExpiringStore<DevicePending>;
  /** user_code -> sha256(device_code). The user code is shown to the user, not a credential. */
  deviceUserCodes: ExpiringStore<string>;
  /** sha256(refresh_token) -> live refresh token. */
  refreshTokens: ExpiringStore<RefreshRecord>;
};

export function createMemoryStateStores(): OAuthStateStores {
  return {
    authzRequests: new MemoryExpiringStore(),
    authzCodes: new MemoryExpiringStore(),
    devices: new MemoryExpiringStore(),
    deviceUserCodes: new MemoryExpiringStore(),
    refreshTokens: new MemoryExpiringStore(),
  };
}

export type { IssuedTokens };

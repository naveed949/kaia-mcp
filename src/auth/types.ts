import type { KaiaScope } from "./constants.js";

export type AuthContext = {
  subject: string;
  clientId: string;
  scopes: readonly string[];
  expiresAtMs: number;
  /** sha256 prefix — never the raw token */
  tokenFingerprint: string;
};

export type IssuedTokens = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

export type IssueAccessTokenParams = {
  subject?: string;
  clientId?: string;
  scopes: readonly string[];
  expiresInSeconds?: number;
  /** Absolute expiry; wins over expiresInSeconds when set. */
  expiresAtMs?: number;
};

export type VerifyResult =
  | { ok: true; context: AuthContext }
  | {
      ok: false;
      status: 401;
      code: number;
      error: string;
      message: string;
    };

export type ScopeName = KaiaScope;

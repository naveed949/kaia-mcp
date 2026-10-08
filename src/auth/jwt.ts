/**
 * Minimal RS256 JWT signing and verification for the demo IdP's access tokens.
 *
 * Only what the demo needs: one RS256 key, compact JWS, strict header checks.
 * `alg` must be exactly RS256 and `kid` must match the active key, so `none`,
 * HS256-with-public-key, and foreign keys are all rejected before any claim
 * is trusted.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const JWT_ALG = "RS256";
export const ACCESS_TOKEN_TYP = "at+jwt";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

/** RFC 7638 JWK thumbprint of an RSA public key. */
function rsaThumbprint(jwk: JsonWebKey): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash("sha256").update(canonical).digest("base64url");
}

const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;

/** The bytes of a non-empty, canonical unpadded base64url string, or null. */
function canonicalBase64url(segment: string): Buffer | null {
  if (!BASE64URL_CHARS.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : null;
}

export class SigningKey {
  readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly publicJwkValue: JsonWebKey;

  private constructor(privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("signing key must be RSA");
    }
    this.privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
    this.publicJwkValue = this.publicKey.export({ format: "jwk" });
    this.kid = rsaThumbprint(this.publicJwkValue);
  }

  /** Fresh in-memory key. Lost on restart, which also invalidates all tokens. */
  static generate(): SigningKey {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return new SigningKey(privateKey);
  }

  /**
   * Dev persistence: load a PKCS#8 PEM from `path`, or create one there (mode 0600).
   * The path must be gitignored; the repo ships `.kaia-dev/` in .gitignore for this.
   */
  static fromFileOrCreate(path: string): SigningKey {
    if (existsSync(path)) {
      return new SigningKey(createPrivateKey(readFileSync(path)));
    }
    const key = SigningKey.generate();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    return key;
  }

  /** Load an existing PKCS#8/PKCS#1 PEM (verify-only rotation keys). Throws if unreadable. */
  static fromFile(path: string): SigningKey {
    return new SigningKey(createPrivateKey(readFileSync(path)));
  }

  publicJwk(): Record<string, unknown> {
    return {
      kty: "RSA",
      n: this.publicJwkValue.n,
      e: this.publicJwkValue.e,
      kid: this.kid,
      use: "sig",
      alg: JWT_ALG,
    };
  }

  jwks(): { keys: Record<string, unknown>[] } {
    return { keys: [this.publicJwk()] };
  }

  sign(payload: Record<string, unknown>): string {
    const header = { alg: JWT_ALG, typ: ACCESS_TOKEN_TYP, kid: this.kid };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const signature = cryptoSign("sha256", Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${b64url(signature)}`;
  }

  /**
   * Signature + header check only. Returns the payload or null. Claims are not checked here.
   * Every segment must be canonical unpadded base64url (RFC 7515 2): Node's decoder alone
   * ignores `=` padding, stray characters and the spare low bits of the last character, so
   * `<tok>==` or a sibling last character would verify as the same token under another
   * spelling (and another sha256 token fingerprint).
   */
  verifySignature(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decoded = parts.map(canonicalBase64url);
    if (decoded.some((d) => d === null)) return null;
    const [h, p] = parts;
    const [hBytes, pBytes, sigBytes] = decoded as [Buffer, Buffer, Buffer];
    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(hBytes.toString("utf8"));
      payload = JSON.parse(pBytes.toString("utf8"));
    } catch {
      return null;
    }
    if (
      !header ||
      typeof header !== "object" ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return null;
    }
    const hdr = header as Record<string, unknown>;
    if (hdr.alg !== JWT_ALG || hdr.kid !== this.kid) return null;
    const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), this.publicKey, sigBytes);
    return ok ? (payload as Record<string, unknown>) : null;
  }
}

export type AccessTokenClaims = {
  iss: string;
  /** As minted: the canonical resource URI, or [canonical, legacy audience]. */
  aud: string | string[];
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

export type ClaimCheck =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: "invalid" | "expired" };

/** Validate the registered claims of a signature-verified payload. */
export function checkAccessTokenClaims(
  payload: Record<string, unknown>,
  expected: { issuer: string; audience: string; nowSeconds: number }
): ClaimCheck {
  const { iss, aud, sub, client_id, scope, iat, nbf, exp, jti } = payload;
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!isStr(iss) || iss !== expected.issuer) return { ok: false, reason: "invalid" };
  const audList: unknown[] = Array.isArray(aud) ? aud : [aud];
  if (audList.length === 0 || !audList.every(isStr)) return { ok: false, reason: "invalid" };
  // RFC 8707 / MCP: the token must have been issued for this resource server.
  if (!audList.includes(expected.audience)) return { ok: false, reason: "invalid" };
  if (!isStr(sub) || !isStr(jti) || typeof scope !== "string" || !isStr(client_id)) {
    return { ok: false, reason: "invalid" };
  }
  if (!isNum(exp) || !isNum(iat) || !isNum(nbf)) return { ok: false, reason: "invalid" };
  if (expected.nowSeconds >= exp) return { ok: false, reason: "expired" };
  if (expected.nowSeconds < nbf) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    claims: {
      iss,
      aud: Array.isArray(aud) ? (aud as string[]) : (aud as string),
      sub,
      client_id,
      scope,
      iat,
      nbf,
      exp,
      jti,
    },
  };
}

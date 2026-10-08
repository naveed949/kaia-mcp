/**
 * Config loading and env validation (Phase 2).
 * Uses Zod to parse and validate env; optional dotenv for .env loading.
 */

import "dotenv/config";
import { dirname, join } from "node:path";
import { z } from "zod";

const DEFAULT_KAIA_RPC_URL = "https://public-en.node.kaia.io";
const DEFAULT_KAIA_KAIROS_RPC_URL = "https://public-en-kairos.node.kaia.io";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const defaultNetworkSchema = z.enum(["mainnet", "kairos"]);

const urlOrDefault = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v : def))
    .pipe(z.string().url());

const authModeSchema = z.enum(["required", "off"]);
const boolish = z
  .string()
  .optional()
  .transform((v) => {
    const n = (v ?? "").trim().toLowerCase();
    return n === "1" || n === "true" || n === "yes";
  });

/**
 * KAIA_PUBLIC_URL: the externally reachable origin of this server. It is the OAuth issuer
 * and the canonical resource URI (RFC 8707 / RFC 9728), so it must be an absolute http(s)
 * origin with no path, query, fragment or userinfo. Normalized to lowercase
 * scheme://host[:port] with no trailing slash (default ports elided).
 */
const publicUrlSchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const raw = (v ?? "").trim();
    if (!raw) return undefined;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an absolute http(s) URL" });
      return z.NEVER;
    }
    const problem =
      u.protocol !== "http:" && u.protocol !== "https:"
        ? "scheme must be http or https"
        : u.username || u.password
          ? "must not contain userinfo"
          : u.pathname !== "/"
            ? "must be an origin with no path (the MCP endpoint is served at /)"
            : u.search || raw.includes("?")
              ? "must not contain a query"
              : u.hash || raw.includes("#")
                ? "must not contain a fragment"
                : undefined;
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      return z.NEVER;
    }
    return u.origin;
  });

/** KAIA_ALLOWED_ORIGINS: comma-separated browser origins allowed on the MCP/OAuth surface. */
const allowedOriginsSchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const out: string[] = [];
    for (const raw of (v ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      let u: URL | undefined;
      try {
        u = new URL(raw);
      } catch {
        u = undefined;
      }
      if (
        !u ||
        (u.protocol !== "http:" && u.protocol !== "https:") ||
        u.pathname !== "/" ||
        u.search ||
        u.hash ||
        u.username ||
        raw.includes("?") ||
        raw.includes("#") ||
        /^[a-z]+:\/\/[^/]+\/./i.test(raw)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${raw}" is not an http(s) origin (scheme://host[:port]); "*" is not supported`,
        });
        return z.NEVER;
      }
      if (!out.includes(u.origin)) out.push(u.origin);
    }
    return out;
  });

const envSchema = z.object({
  KAIA_RPC_URL: urlOrDefault(DEFAULT_KAIA_RPC_URL),
  KAIA_KAIROS_RPC_URL: urlOrDefault(DEFAULT_KAIA_KAIROS_RPC_URL),
  KAIASCAN_API_KEY: z.string().optional().default(""),
  KAIA_DEFAULT_NETWORK: defaultNetworkSchema.default("mainnet"),
  LOG_LEVEL: logLevelSchema.default("info"),
  RATE_LIMIT_RPC: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_KAIASCAN: z.coerce.number().int().positive().default(5),
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(30000),
  KAIASCAN_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(15000),
  KAIA_AUTH_MODE: authModeSchema.default("required"),
  KAIA_ALLOW_UNSAFE_WALLET: boolish,
  KAIA_OAUTH_CLIENT_ID: z.string().optional().default("kaia-mcp-demo"),
  KAIA_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional().default(900),
  KAIA_PUBLIC_URL: publicUrlSchema,
  KAIA_OAUTH_LEGACY_AUDIENCE: z.string().min(1).optional(),
  KAIA_OAUTH_AUDIENCE: z.string().min(1).optional(),
  KAIA_OAUTH_REQUIRE_RESOURCE: boolish,
  KAIA_ALLOWED_ORIGINS: allowedOriginsSchema,
  KAIA_OAUTH_SIGNING_KEY_FILE: z.string().optional(),
  KAIA_OAUTH_REVOCATION_FILE: z.string().optional(),
  KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  KAIA_INTROSPECTION_CLIENT_ID: z.string().min(1).optional().default("kaia-mcp-gateway"),
  KAIA_INTROSPECTION_CLIENT_SECRET: z.string().optional(),
});

export type LogLevel = z.infer<typeof logLevelSchema>;
export type DefaultNetwork = z.infer<typeof defaultNetworkSchema>;

export type AuthMode = z.infer<typeof authModeSchema>;

export type Config = {
  kaiaRpcUrl: string;
  kaiaKairosRpcUrl: string;
  kaiascanApiKey: string;
  defaultNetwork: DefaultNetwork;
  logLevel: LogLevel;
  rateLimitRpc: number;
  rateLimitKaiascan: number;
  rpcTimeoutMs: number;
  kaiascanTimeoutMs: number;
  authMode: AuthMode;
  allowUnsafeWallet: boolean;
  oauthClientId: string;
  accessTokenTtlSeconds: number;
  /**
   * KAIA_PUBLIC_URL, normalized: issuer and canonical resource URI. Unset: the HTTP server
   * uses http://127.0.0.1:<bound port> (local dev).
   */
  publicUrl?: string;
  /**
   * Optional extra `aud` value minted alongside the canonical resource URI, for gateways
   * that still pin a non-URI audience (e.g. "kaia-mcp"). Never accepted on its own: the
   * resource server always requires the canonical URI in `aud`. KAIA_OAUTH_LEGACY_AUDIENCE,
   * or the deprecated alias KAIA_OAUTH_AUDIENCE.
   */
  oauthLegacyAudience?: string;
  /** KAIA_OAUTH_REQUIRE_RESOURCE: reject authorize/device/token requests without `resource`. */
  oauthRequireResource: boolean;
  /**
   * Extra browser origins allowed to call the MCP and OAuth endpoints (KAIA_ALLOWED_ORIGINS).
   * The server's own public origin is always allowed; requests without Origin always pass.
   */
  allowedOrigins: string[];
  /** Optional gitignored PEM path for a dev signing key that survives restarts. Unset: in-memory key. */
  oauthSigningKeyFile?: string;
  /**
   * KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES: comma-separated PEMs of retired keys. They are
   * published in the JWKS and accepted for verification, never used to sign. Each must
   * exist; an unreadable one refuses startup.
   */
  oauthPreviousSigningKeyFiles: string[];
  /**
   * Where revoked access-token jtis are persisted. Default: `revoked-jti.json` next to
   * `oauthSigningKeyFile` when that is set (a persisted key needs a persisted denylist),
   * otherwise unset and revocations stay in memory.
   */
  oauthRevocationFile?: string;
  introspectionClientId: string;
  /** Unset or empty: /oauth/introspect is not offered. */
  introspectionClientSecret?: string;
};

function parseEnv(): Config {
  const raw = {
    KAIA_RPC_URL: process.env.KAIA_RPC_URL,
    KAIA_KAIROS_RPC_URL: process.env.KAIA_KAIROS_RPC_URL,
    KAIASCAN_API_KEY: process.env.KAIASCAN_API_KEY,
    KAIA_DEFAULT_NETWORK: process.env.KAIA_DEFAULT_NETWORK,
    LOG_LEVEL: process.env.LOG_LEVEL,
    RATE_LIMIT_RPC: process.env.RATE_LIMIT_RPC,
    RATE_LIMIT_KAIASCAN: process.env.RATE_LIMIT_KAIASCAN,
    RPC_TIMEOUT_MS: process.env.RPC_TIMEOUT_MS,
    KAIASCAN_TIMEOUT_MS: process.env.KAIASCAN_TIMEOUT_MS,
    KAIA_AUTH_MODE: process.env.KAIA_AUTH_MODE,
    KAIA_ALLOW_UNSAFE_WALLET: process.env.KAIA_ALLOW_UNSAFE_WALLET,
    KAIA_OAUTH_CLIENT_ID: process.env.KAIA_OAUTH_CLIENT_ID,
    KAIA_ACCESS_TOKEN_TTL_SECONDS: process.env.KAIA_ACCESS_TOKEN_TTL_SECONDS,
    KAIA_PUBLIC_URL: process.env.KAIA_PUBLIC_URL || undefined,
    KAIA_OAUTH_LEGACY_AUDIENCE: process.env.KAIA_OAUTH_LEGACY_AUDIENCE || undefined,
    KAIA_OAUTH_AUDIENCE: process.env.KAIA_OAUTH_AUDIENCE || undefined,
    KAIA_OAUTH_REQUIRE_RESOURCE: process.env.KAIA_OAUTH_REQUIRE_RESOURCE,
    KAIA_ALLOWED_ORIGINS: process.env.KAIA_ALLOWED_ORIGINS,
    KAIA_OAUTH_SIGNING_KEY_FILE: process.env.KAIA_OAUTH_SIGNING_KEY_FILE || undefined,
    KAIA_OAUTH_REVOCATION_FILE: process.env.KAIA_OAUTH_REVOCATION_FILE || undefined,
    KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES: process.env.KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES,
    KAIA_INTROSPECTION_CLIENT_ID: process.env.KAIA_INTROSPECTION_CLIENT_ID || undefined,
    KAIA_INTROSPECTION_CLIENT_SECRET: process.env.KAIA_INTROSPECTION_CLIENT_SECRET || undefined,
  };

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.flatten().fieldErrors;
    const msg = Object.entries(first)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("; ");
    throw new Error(`Invalid config: ${msg}`);
  }

  const d = result.data;
  return {
    kaiaRpcUrl: d.KAIA_RPC_URL,
    kaiaKairosRpcUrl: d.KAIA_KAIROS_RPC_URL,
    kaiascanApiKey: d.KAIASCAN_API_KEY ?? "",
    defaultNetwork: d.KAIA_DEFAULT_NETWORK,
    logLevel: d.LOG_LEVEL,
    rateLimitRpc: d.RATE_LIMIT_RPC,
    rateLimitKaiascan: d.RATE_LIMIT_KAIASCAN,
    rpcTimeoutMs: d.RPC_TIMEOUT_MS,
    kaiascanTimeoutMs: d.KAIASCAN_TIMEOUT_MS,
    authMode: d.KAIA_AUTH_MODE,
    allowUnsafeWallet: d.KAIA_ALLOW_UNSAFE_WALLET,
    oauthClientId: d.KAIA_OAUTH_CLIENT_ID,
    accessTokenTtlSeconds: d.KAIA_ACCESS_TOKEN_TTL_SECONDS,
    publicUrl: d.KAIA_PUBLIC_URL,
    oauthLegacyAudience: d.KAIA_OAUTH_LEGACY_AUDIENCE ?? d.KAIA_OAUTH_AUDIENCE,
    oauthRequireResource: d.KAIA_OAUTH_REQUIRE_RESOURCE,
    allowedOrigins: d.KAIA_ALLOWED_ORIGINS,
    oauthSigningKeyFile: d.KAIA_OAUTH_SIGNING_KEY_FILE,
    oauthPreviousSigningKeyFiles: d.KAIA_OAUTH_PREVIOUS_SIGNING_KEY_FILES,
    oauthRevocationFile:
      d.KAIA_OAUTH_REVOCATION_FILE ??
      (d.KAIA_OAUTH_SIGNING_KEY_FILE
        ? join(dirname(d.KAIA_OAUTH_SIGNING_KEY_FILE), "revoked-jti.json")
        : undefined),
    introspectionClientId: d.KAIA_INTROSPECTION_CLIENT_ID,
    introspectionClientSecret: d.KAIA_INTROSPECTION_CLIENT_SECRET,
  };
}

let cached: Config | null = null;

/**
 * Returns the validated config (singleton). Loads from process.env (and .env via dotenv if present).
 * Throws on invalid required values; uses schema defaults for missing/optional fields.
 */
export function getConfig(): Config {
  if (cached === null) {
    cached = parseEnv();
  }
  return cached;
}

/** Clears the config cache (for tests). */
export function resetConfigCache(): void {
  cached = null;
}

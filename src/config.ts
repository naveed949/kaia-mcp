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
  KAIA_OAUTH_AUDIENCE: z.string().min(1).optional().default("kaia-mcp"),
  KAIA_OAUTH_SIGNING_KEY_FILE: z.string().optional(),
  KAIA_OAUTH_REVOCATION_FILE: z.string().optional(),
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
  /** `aud` of issued access tokens; kaia-mcp only accepts tokens with this audience. */
  oauthAudience: string;
  /** Optional gitignored PEM path for a dev signing key that survives restarts. Unset: in-memory key. */
  oauthSigningKeyFile?: string;
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
    KAIA_OAUTH_AUDIENCE: process.env.KAIA_OAUTH_AUDIENCE || undefined,
    KAIA_OAUTH_SIGNING_KEY_FILE: process.env.KAIA_OAUTH_SIGNING_KEY_FILE || undefined,
    KAIA_OAUTH_REVOCATION_FILE: process.env.KAIA_OAUTH_REVOCATION_FILE || undefined,
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
    oauthAudience: d.KAIA_OAUTH_AUDIENCE,
    oauthSigningKeyFile: d.KAIA_OAUTH_SIGNING_KEY_FILE,
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

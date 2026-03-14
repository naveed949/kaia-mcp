/**
 * Config loading and env validation (Phase 2).
 * Uses Zod to parse and validate env; optional dotenv for .env loading.
 */

import "dotenv/config";
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

const envSchema = z.object({
  KAIA_RPC_URL: urlOrDefault(DEFAULT_KAIA_RPC_URL),
  KAIA_KAIROS_RPC_URL: urlOrDefault(DEFAULT_KAIA_KAIROS_RPC_URL),
  KAIASCAN_API_KEY: z.string().optional().default(""),
  KAIA_DEFAULT_NETWORK: defaultNetworkSchema.default("mainnet"),
  LOG_LEVEL: logLevelSchema.default("info"),
  RATE_LIMIT_RPC: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_KAIASCAN: z.coerce.number().int().positive().default(5),
});

export type LogLevel = z.infer<typeof logLevelSchema>;
export type DefaultNetwork = z.infer<typeof defaultNetworkSchema>;

export type Config = {
  kaiaRpcUrl: string;
  kaiaKairosRpcUrl: string;
  kaiascanApiKey: string;
  defaultNetwork: DefaultNetwork;
  logLevel: LogLevel;
  rateLimitRpc: number;
  rateLimitKaiascan: number;
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

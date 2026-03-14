/**
 * KaiaScan Open API client (Phase 2).
 * Base URL from docs.kaiascan.io; API key appended as query param when present.
 */

import type { Config } from "../config.js";
import { getConfig } from "../config.js";

const KAIASCAN_API_BASE = "https://api.kaiascan.io";

export type KaiaScanClient = {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
};

function buildUrl(path: string, params?: Record<string, string>, apiKey?: string): string {
  const base = KAIASCAN_API_BASE.replace(/\/$/, "");
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  const search = new URLSearchParams(params ?? {});
  if (apiKey?.trim()) {
    search.set("apikey", apiKey.trim());
  }
  const qs = search.toString();
  return qs ? `${base}${pathNorm}?${qs}` : `${base}${pathNorm}`;
}

/**
 * Creates a KaiaScan API client. Uses getConfig() for API key if config is not provided.
 * No rate limiting in this phase (Phase 10).
 */
export function createKaiaScanClient(config?: Config): KaiaScanClient {
  const c = config ?? getConfig();

  return {
    async get<T>(path: string, params?: Record<string, string>): Promise<T> {
      const url = buildUrl(path, params, c.kaiascanApiKey);
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        throw new Error(`KaiaScan API error: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<T>;
    },
  };
}

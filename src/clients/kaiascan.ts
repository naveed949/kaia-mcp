/**
 * KaiaScan Open API client (Phase 2).
 * Rate limiting, timeout, and 429 handling (Phase 10).
 */

import type { Config } from "../config.js";
import { getConfig } from "../config.js";
import { createRateLimiter, type RateLimiter } from "../utils/rate-limit.js";
import { KaiaScanApiError, KaiaScanRateLimitError } from "../utils/errors.js";

export { KaiaScanApiError, KaiaScanRateLimitError };

const KAIASCAN_API_BASE = "https://api.kaiascan.io";

const kaiascanLimiterCache = new Map<number, RateLimiter>();

function getKaiaScanLimiter(requestsPerSecond: number) {
  let limiter = kaiascanLimiterCache.get(requestsPerSecond);
  if (!limiter) {
    limiter = createRateLimiter(requestsPerSecond);
    kaiascanLimiterCache.set(requestsPerSecond, limiter);
  }
  return limiter;
}

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
 * Rate-limited, with fetch timeout (KAIASCAN_TIMEOUT_MS, default 15s) and 429 retry once.
 */
export function createKaiaScanClient(config?: Config): KaiaScanClient {
  const c = config ?? getConfig();
  const limiter = getKaiaScanLimiter(c.rateLimitKaiascan);
  const timeoutMs = c.kaiascanTimeoutMs ?? 15000;

  async function doFetch<T>(
    path: string,
    params?: Record<string, string>,
    retry = false
  ): Promise<T> {
    await limiter.acquire();
    // The URL carries the API key: it is never put into an error (message or cause).
    const url = buildUrl(path, params, c.kaiascanApiKey);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(id);
      throw new KaiaScanApiError({ cause: err });
    }
    clearTimeout(id);
    if (res.status === 429) {
      if (!retry) {
        await new Promise((r) => setTimeout(r, 1500));
        return doFetch<T>(path, params, true);
      }
      throw new KaiaScanRateLimitError();
    }
    if (!res.ok) {
      throw new KaiaScanApiError({ status: res.status });
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new KaiaScanApiError({ status: res.status, cause: err });
    }
  }

  return {
    async get<T>(path: string, params?: Record<string, string>): Promise<T> {
      return doFetch<T>(path, params);
    },
  };
}

/**
 * Structured logger for Kaia MCP server (Phase 3).
 * Writes only to stderr so MCP stdio protocol on stdout is not polluted.
 * Uses getConfig().logLevel for filtering.
 */

import { getConfig } from "../config.js";
import type { LogLevel } from "../config.js";

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

function levelAllowed(configured: LogLevel, messageLevel: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(messageLevel) >= LEVEL_ORDER.indexOf(configured);
}

function formatEntry(
  level: LogLevel,
  message: string,
  meta?: { error?: unknown; code?: number; [k: string]: unknown }
): string {
  const timestamp = new Date().toISOString();
  const parts = [`timestamp=${timestamp}`, `level=${level}`, `msg=${message}`];
  if (meta?.code !== undefined) parts.push(`code=${meta.code}`);
  if (meta?.error !== undefined) {
    const err =
      meta.error instanceof Error ? meta.error.message : String(meta.error);
    parts.push(`error=${err}`);
  }
  const rest = { ...meta };
  delete rest.error;
  delete rest.code;
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && k !== "error" && k !== "code")
      parts.push(`${k}=${String(v)}`);
  }
  return parts.join(" ");
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  try {
    const config = getConfig();
    if (!levelAllowed(config.logLevel, level)) return;
    const line = formatEntry(level, message, meta);
    process.stderr.write(line + "\n");
  } catch {
    // Avoid throwing from logger; fallback to minimal stderr write
    process.stderr.write(`level=${level} msg=${message}\n`);
  }
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    write("debug", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    write("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    write("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    write("error", message, meta);
  },
};

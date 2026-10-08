/**
 * Structured logger for Kaia MCP server (Phase 3).
 * Writes only to stderr so MCP stdio protocol on stdout is not polluted.
 * Uses getConfig().logLevel for filtering.
 *
 * Line format: `timestamp=<iso> level=<level> msg=<message> key=value ...`, one entry per
 * line. The logger is the single place where text is made safe for that format: every
 * message, key and value goes through escapeLogText, so no value (caller input included)
 * can contain a raw space, '=', quote, control or non-ASCII character. A caller value can
 * therefore never start a second line or form a `key=value` token of its own (such as a
 * forged `outcome=allowed`). Call sites pass raw values and never pre-escape.
 */

import { getConfig } from "../config.js";
import type { LogLevel } from "../config.js";
import { redactMeta, redactString } from "./redact.js";

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

/** Bytes of one value (or message) kept before encoding; the rest becomes `%E2%80%A6` (…). */
export const LOG_VALUE_MAX_BYTES = 256;
/** The `error` field (exception text) keeps a little more for operators. */
const LOG_ERROR_MAX_BYTES = 512;
const ELLIPSIS = "%E2%80%A6";
/** Keys written as-is; any other key is escaped like a value. */
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

function levelAllowed(configured: LogLevel, messageLevel: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(messageLevel) >= LEVEL_ORDER.indexOf(configured);
}

/**
 * A byte that may appear raw in a log value: printable ASCII except '%' (the escape
 * character), '=' (the key/value separator), '"' and '\' (logfmt quoting and escaping).
 * Space is allowed only in messages.
 */
function isRawByte(b: number, allowSpace: boolean): boolean {
  if (b === 0x20) return allowSpace;
  return b > 0x20 && b < 0x7f && b !== 0x25 && b !== 0x3d && b !== 0x22 && b !== 0x5c;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

/**
 * Make text safe for one log field. Every byte that is not raw-safe (see isRawByte) is
 * percent-encoded from its UTF-8 form: whitespace (tab, NBSP, U+3000, ...), '=', '%',
 * quotes, backslash, C0/C1 controls, U+2028/U+2029 and every other non-ASCII character
 * (so bidi overrides, zero-width and look-alike characters such as U+FF1D are encoded
 * too). The input is capped at `maxBytes` UTF-8 bytes, with an encoded ellipsis appended.
 */
export function escapeLogText(
  value: unknown,
  options: { maxBytes?: number; allowSpace?: boolean } = {}
): string {
  const text = toText(value);
  const maxBytes = options.maxBytes ?? LOG_VALUE_MAX_BYTES;
  const allowSpace = options.allowSpace ?? false;
  const bytes = Buffer.from(text, "utf8");
  const n = Math.min(bytes.length, maxBytes);
  let out = "";
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    out += isRawByte(b, allowSpace)
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return bytes.length > maxBytes ? out + ELLIPSIS : out;
}

function escapeMessage(message: string): string {
  return escapeLogText(redactString(message), { allowSpace: true });
}

function formatEntry(
  level: LogLevel,
  message: string,
  meta?: { error?: unknown; code?: number; [k: string]: unknown }
): string {
  const timestamp = new Date().toISOString();
  // Redaction runs on the full raw values, before they are capped and encoded.
  const safeMeta = redactMeta(meta as Record<string, unknown> | undefined) as
    | { error?: unknown; code?: number; [k: string]: unknown }
    | undefined;
  const parts = [`timestamp=${timestamp}`, `level=${level}`, `msg=${escapeMessage(message)}`];
  if (safeMeta?.code !== undefined) parts.push(`code=${escapeLogText(safeMeta.code)}`);
  if (safeMeta?.error !== undefined) {
    const err = safeMeta.error instanceof Error ? safeMeta.error.message : toText(safeMeta.error);
    parts.push(`error=${escapeLogText(redactString(err), { maxBytes: LOG_ERROR_MAX_BYTES })}`);
  }
  for (const [k, v] of Object.entries(safeMeta ?? {})) {
    if (v === undefined || k === "error" || k === "code") continue;
    const key = PLAIN_KEY.test(k) ? k : escapeLogText(k);
    parts.push(`${key}=${escapeLogText(v)}`);
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
    process.stderr.write(`level=${level} msg=${escapeMessage(message)}\n`);
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

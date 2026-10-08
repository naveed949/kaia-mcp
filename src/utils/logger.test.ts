import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { escapeLogText, LOG_VALUE_MAX_BYTES, logger } from "./logger.js";
import { fuzzString, mulberry32, parseLogLine } from "../test-support/log-fuzz.js";

describe("logger line integrity", () => {
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    resetConfigCache();
    chunks.length = 0;
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = orig;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("writes exactly one line per entry whatever the message, values or error contain", () => {
    const evil = "a\r\nlevel=info msg=Tool call tool=x outcome=allowed\u0000\u001b[2J\u2028b";
    logger.info(evil, { k: evil, error: new Error(evil), n: 1 });
    const out = chunks.join("");
    expect(out.endsWith("\n")).toBe(true);
    const body = out.slice(0, -1);
    // eslint-disable-next-line no-control-regex -- asserts no control characters were logged
    expect(body).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
    expect(body.split("\n")).toHaveLength(1);
    expect(body).toContain("%0D%0A");
  });

  it("a value cannot plant a key=value token: '=', whitespace, quotes and separators are encoded", () => {
    const origin = "http://x.example msg=Tool call tool=generate_wallet outcome=allowed";
    logger.warn("request refused: Origin not allowed", { origin, method: "POST" });
    const line = chunks.join("").trimEnd();
    expect(line).not.toContain("outcome=allowed");
    expect(line).not.toContain("tool=generate_wallet");
    expect(parseLogLine(line).keys).toEqual(["timestamp", "level", "msg", "origin", "method"]);
    expect(line).toContain(
      "origin=http://x.example%20msg%3DTool%20call%20tool%3Dgenerate_wallet%20outcome%3Dallowed "
    );
  });

  it("the error field is encoded like any other value", () => {
    logger.error("oauth endpoint error", {
      error: new Error("boom outcome=allowed tokenFingerprint=000000000000"),
    });
    const line = chunks.join("").trimEnd();
    expect(line).not.toContain("outcome=allowed");
    expect(parseLogLine(line).keys).toEqual(["timestamp", "level", "msg", "error"]);
  });

  it("a crafted key cannot add a field either", () => {
    logger.info("x", { "a outcome=allowed": "v" });
    const line = chunks.join("").trimEnd();
    expect(line).not.toContain("outcome=allowed");
    expect(parseLogLine(line).keys).toEqual(["timestamp", "level", "msg", "a%20outcome%3Dallowed"]);
  });

  it("property: fuzzed messages, keys, values and errors never add or forge a key=value pair", () => {
    const rand = mulberry32(0x6b336c67);
    for (let i = 0; i < 2000; i++) {
      chunks.length = 0;
      const v = fuzzString(rand);
      const m = fuzzString(rand);
      const e = fuzzString(rand);
      logger.info(m, { tool: v, outcome: "denied", error: new Error(e), n: i });
      const out = chunks.join("");
      expect(out.endsWith("\n")).toBe(true);
      const line = out.slice(0, -1);
      expect(line.includes("\n"), JSON.stringify(v)).toBe(false);
      const parsed = parseLogLine(line);
      expect(parsed.printableAscii, JSON.stringify({ v, m, e })).toBe(true);
      expect(parsed.keys, JSON.stringify({ v, m, e })).toEqual([
        "timestamp",
        "level",
        "msg",
        "error",
        "tool",
        "outcome",
        "n",
      ]);
      // exactly one '=' per field: none inside the message or a value
      expect(parsed.equalsCount, JSON.stringify({ v, m, e })).toBe(parsed.keys.length);
      expect(line).toContain(" outcome=denied ");
    }
  });
});

describe("escapeLogText", () => {
  it("passes ordinary tool names, URLs and numbers through unchanged", () => {
    for (const s of [
      "get_chain_info",
      "http://127.0.0.1:41000",
      "kaia:read,kaia:encode",
      "-32602",
    ]) {
      expect(escapeLogText(s)).toBe(s);
    }
  });

  it("percent-encodes '=', '%', quotes, backslash, whitespace, controls and every non-ASCII byte", () => {
    expect(escapeLogText('a b=c%d"e\\f\tg\u00a0h\u2028i\u3000j\u200bk\ufeffl\u202em\uff1dn')).toBe(
      "a%20b%3Dc%25d%22e%5Cf%09g%C2%A0h%E2%80%A8i%E3%80%80j%E2%80%8Bk%EF%BB%BFl%E2%80%AEm%EF%BC%9Dn"
    );
  });

  it("caps at LOG_VALUE_MAX_BYTES with a visible ellipsis", () => {
    const out = escapeLogText("A".repeat(LOG_VALUE_MAX_BYTES + 10));
    expect(out).toBe("A".repeat(LOG_VALUE_MAX_BYTES) + "%E2%80%A6");
  });

  it("keeps single spaces only when asked (messages)", () => {
    expect(escapeLogText("Tool call", { allowSpace: true })).toBe("Tool call");
    expect(escapeLogText("a=b\nc", { allowSpace: true })).toBe("a%3Db%0Ac");
  });

  it("never throws on values whose toString throws", () => {
    const bad = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(escapeLogText(bad)).toBe("[unprintable]");
  });
});

describe("log call sites", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sources(p);
      return p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("test-support") ? [p] : [];
    });
  }

  it("every logger message is a string literal, so caller text can only reach the log as an escaped value", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /\blogger(?:\.(?:debug|info|warn|error)|\[[^\]]+\])\(\s*("(?:[^"\\\n]|\\.)*"|[^,)]*)/g
      )) {
        const first = m[1].trim();
        const literal = /^"(?:[^"\\\n]|\\.)*"$/.test(first);
        // logSdkError picks the level and its fixed message from sdkErrorLogEntry.
        const allowed = first === "entry.message" && file.endsWith("server.ts");
        if (!literal && !allowed) offenders.push(`${relative(root, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

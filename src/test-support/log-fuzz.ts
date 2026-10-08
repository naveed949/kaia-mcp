/**
 * Test-only helpers for log-integrity property tests: a seeded PRNG, a generator of hostile
 * caller strings, and a strict reader for kaia's `key=value` log lines.
 */

/** Deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fragments an attacker would try to plant: fields, whole forged lines, logfmt quoting. */
const FRAGMENTS = [
  "outcome=allowed",
  " outcome=allowed",
  "msg=Tool call tool=generate_wallet ",
  " level=error ",
  "tokenFingerprint=000000000000",
  "\ntimestamp=2026-10-08T00:00:00.000Z level=info msg=Tool call tool=generate_wallet outcome=allowed",
  ' x="',
  '" y=',
  "\\",
  "%3D",
  "%",
  "=",
  "==",
  "a=b",
];

/** Single characters that break naive one-line / one-token assumptions. */
const CHARS = [
  " ",
  "=",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u0000",
  "\u001b[31m",
  "\u007f",
  "\u0085",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u200b",
  "\u2028",
  "\u2029",
  "\u202e",
  "\u2066",
  "\u3000",
  "\ufeff",
  "\uff1d",
  "\ud800",
  "\udfff",
  "\u{1f600}",
  '"',
  "'",
  "%",
  "\\",
  "&",
  "?",
  "#",
  ":",
  "/",
];

const WORD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-";

/** One hostile caller value: a random mix of plain text, separators and planted fragments. */
export function fuzzString(rand: () => number, maxParts = 12): string {
  const parts = 1 + Math.floor(rand() * maxParts);
  let s = "";
  for (let i = 0; i < parts; i++) {
    const r = rand();
    if (r < 0.35) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
    else if (r < 0.75) s += CHARS[Math.floor(rand() * CHARS.length)];
    else {
      const n = 1 + Math.floor(rand() * 8);
      for (let j = 0; j < n; j++) s += WORD[Math.floor(rand() * WORD.length)];
    }
  }
  if (rand() < 0.03) s += "B".repeat(2000 + Math.floor(rand() * 4000));
  return s;
}

export type ParsedLogLine = {
  /** Keys in order: every space-separated token that contains '=' contributes its prefix. */
  keys: string[];
  /** Total '=' characters on the line (equals keys.length when no value or message holds one). */
  equalsCount: number;
  /** True when every character is printable ASCII (0x20-0x7e). */
  printableAscii: boolean;
};

export function parseLogLine(line: string): ParsedLogLine {
  const keys: string[] = [];
  for (const token of line.split(" ")) {
    const i = token.indexOf("=");
    if (i > 0) keys.push(token.slice(0, i));
  }
  return {
    keys,
    equalsCount: (line.match(/=/g) ?? []).length,
    printableAscii: /^[\x20-\x7e]*$/.test(line),
  };
}

/** Decode the logger's percent-encoding (UTF-8 byte runs), for asserting on readable text. */
export function decodeLogText(s: string): string {
  return s.replace(/(?:%[0-9A-F]{2})+/g, (run) =>
    Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8")
  );
}

/**
 * Bound first, then redact (PR #9 verify r3, N-3). The logger and the refused-Origin log
 * line both cut caller text to REDACT_INPUT_MAX_CHARS (at whitespace) before the redactor
 * runs, so the redactor never sees more than a few KB whatever the value's size. Redacting
 * the full text first would be just as safe but cost O(input) per field (≈190 ms for a
 * 4 MB value): this pins the order.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config.js";
import { checkOrigin } from "../auth/http.js";
import { logger } from "./logger.js";
import * as redact from "./redact.js";

vi.mock("./redact.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./redact.js")>();
  return { ...orig, redactString: vi.fn(orig.redactString) };
});

const redactSpy = vi.mocked(redact.redactString);
const MAX = redact.REDACT_INPUT_MAX_CHARS;

describe("the redactor only ever sees bounded text", () => {
  let orig: typeof process.stderr.write;
  const chunks: string[] = [];

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    resetConfigCache();
    chunks.length = 0;
    redactSpy.mockClear();
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

  const longest = () => Math.max(...redactSpy.mock.calls.map(([s]) => s.length));

  it("logger: a 4 MB message, field and error are cut to the bound before redaction", () => {
    const big = "word ".repeat((4 * 1024 * 1024) / 5);
    logger.info(big, { tool: big, error: new Error(big) });
    expect(redactSpy).toHaveBeenCalled();
    // boundRedactionInput keeps at most MAX characters plus its one-character "…".
    expect(longest()).toBeLessThanOrEqual(MAX + 1);
    expect(chunks.join("")).toContain("msg=word word");
  });

  it("refused Origin: cut to the bound before redaction", () => {
    const origin = "http://evil.example.test/" + "a ".repeat(32 * 1024);
    const req = { headers: { origin }, method: "POST", url: "/" } as unknown as IncomingMessage;
    const res = { writeHead: () => res, end: () => res } as unknown as ServerResponse;
    expect(checkOrigin(req, res, ["https://app.example.test"])).toBe(false);
    expect(redactSpy).toHaveBeenCalled();
    expect(longest()).toBeLessThanOrEqual(MAX + 1);
  });
});

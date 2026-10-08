import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { logger } from "./logger.js";

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
    expect(body).toContain("\\r\\n");
  });
});

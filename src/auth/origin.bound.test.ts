/**
 * A refused Origin is unauthenticated caller input. Its log value is bounded at a
 * whitespace boundary before redaction, so a huge `eyJ…` Origin costs no more than a small
 * one (PR #9 verify r2, M-2: on 93ba944 each 15 KB Origin cost ~100 ms of CPU).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { checkOrigin } from "./http.js";

describe("checkOrigin: a huge refused Origin is logged in bounded time", () => {
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

  function refuse(origin: string): number {
    const req = { headers: { origin }, method: "POST", url: "/" } as unknown as IncomingMessage;
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
        return res;
      },
      end: () => res,
    } as unknown as ServerResponse;
    expect(checkOrigin(req, res, ["https://app.example.test"])).toBe(false);
    return status;
  }

  it("64 KB and 1 MB eyJ… Origins: 403, bounded time, the value logs as …", () => {
    for (const size of [64 * 1024, 1024 * 1024]) {
      const origin = "http://" + "eyJ".repeat(size / 3);
      const t0 = performance.now();
      expect(refuse(origin)).toBe(403);
      // Unbounded redaction takes ~1.4 s at 64 KB and minutes at 1 MB; bounded, ~1 ms.
      expect(performance.now() - t0, `${size} bytes`).toBeLessThan(500);
    }
    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain("msg=request refused: Origin not allowed origin=%E2%80%A6 method=POST");
    }
  });

  it("a short foreign Origin is still logged (redacted, cut to 64 bytes) as before", () => {
    refuse("https://evil.example.test");
    expect(chunks.join("")).toContain(" origin=https://evil.example.test method=POST");
  });
});

/**
 * Issue #11 P-1 at full size, in a memory-limited child process: on main, 4000 bytes[]
 * offsets to one 64 KB payload (a 193 KB result) ran the server out of memory, and the
 * string[] version built a 262 MB response. The child bundles read_contract with a stub RPC
 * client and gets a 256 MB heap, so a regression aborts the child, not the test runner.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const word = (n: number) => n.toString(16).padStart(64, "0");
const K = 4000;
const L = 65_536;
const P1 = `0x${word(32)}${word(K)}${word(K * 32).repeat(K)}${word(L)}${"61".repeat(L)}`;

// The result comes on stdin (387 KB of hex is over the 128 KB limit for one env variable).
const STUB = `import fs from "node:fs";
const data = fs.readFileSync(0, "utf8");
export const createRpcClient = () => ({ call: async () => ({ data }) });`;
const ENTRY = `
import { handleReadContract } from ${JSON.stringify(path.resolve("src/tools/contract.ts"))};
import { toMcpError } from ${JSON.stringify(path.resolve("src/utils/errors.ts"))};
const type = process.argv[2];
const t0 = performance.now();
try {
  const r = await handleReadContract({
    contractAddress: "0x000000000000000000000000000000000000dEaD",
    functionName: "f",
    abi: [{ type: "function", name: "f", inputs: [], outputs: [{ name: "", type }], stateMutability: "view" }],
    args: [],
  });
  console.log(JSON.stringify({ ok: true, chars: r.content[0].text.length, ms: performance.now() - t0 }));
} catch (err) {
  console.log(JSON.stringify({ ...toMcpError(err), ms: performance.now() - t0 }));
}
`;

let dir: string;
let bundle: string;

beforeAll(async () => {
  // Inside the repo so the bundle's external packages (viem, dotenv) resolve.
  const cache = path.resolve("node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  dir = fs.mkdtempSync(path.join(cache, "kaia-p1-"));
  fs.writeFileSync(path.join(dir, "rpc-stub.mjs"), STUB);
  fs.writeFileSync(path.join(dir, "entry.mjs"), ENTRY);
  bundle = path.join(dir, "bundle.mjs");
  await build({
    entryPoints: [path.join(dir, "entry.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    packages: "external",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-rpc",
        setup(b) {
          b.onResolve({ filter: /clients\/rpc\.js$/ }, () => ({
            path: path.join(dir, "rpc-stub.mjs"),
          }));
        },
      },
    ],
  });
}, 60_000);

afterAll(() => {
  if (process.env.KEEP_P1_BUNDLE) return console.log(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("P-1 at full size, 256 MB heap", () => {
  for (const type of ["bytes[]", "string[]"]) {
    it(`${type}: refused with -32005, the process survives`, () => {
      const child = spawnSync(process.execPath, ["--max-old-space-size=256", bundle, type], {
        env: { PATH: process.env.PATH },
        input: P1,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(child.error).toBeUndefined();
      expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
      const out = JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}");
      expect(out.code).toBe(-32005);
      expect(out.message).toMatch(/over 4194304 characters/);
      expect(out.ms).toBeLessThan(500);
    }, 70_000);
  }
});

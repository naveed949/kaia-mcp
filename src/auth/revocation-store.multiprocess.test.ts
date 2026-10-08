/**
 * The verifier's scenario with real processes: two kaia-mcp servers given the same signing
 * key file and no KAIA_OAUTH_REVOCATION_FILE default to the same denylist. The second must
 * refuse to start (it would overwrite the first one's revocations), the first must keep
 * serving, and a crashed holder must not block the next start.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeLogText } from "../test-support/log-fuzz.js";

const ROOT = resolve(__dirname, "../..");
let outDir: string;
let bin: string;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

type Proc = { child: ChildProcess; stderr: () => string; exited: Promise<number | null> };

function startServer(port: number, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [bin, "--transport", "http", "--port", String(port)], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, stderr: () => err, exited };
}

async function waitHealthy(port: number, proc: Proc): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (proc.child.exitCode !== null) throw new Error(`exited early: ${proc.stderr()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`not healthy: ${proc.stderr()}`);
}

describe("two processes on one default revocation file", () => {
  let dir: string;
  const procs: Proc[] = [];

  beforeAll(async () => {
    // Build the real CLI. The bundle sits under node_modules/.cache so its runtime
    // dependencies resolve from this repo's node_modules.
    const cacheRoot = join(ROOT, "node_modules", ".cache");
    mkdirSync(cacheRoot, { recursive: true });
    outDir = mkdtempSync(join(cacheRoot, "kaia-mcp-proc-test-"));
    const { build } = await import("tsup");
    await build({
      entry: { "kaia-mcp": join(ROOT, "src/bin/kaia-mcp.ts") },
      outDir,
      format: ["esm"],
      platform: "node",
      target: "node20",
      silent: true,
      config: false,
      clean: false,
      dts: false,
    });
    bin = join(outDir, "kaia-mcp.js");
    dir = mkdtempSync(join(tmpdir(), "kaia-twoproc-"));
  }, 120_000);

  afterAll(() => {
    for (const p of procs) if (p.child.exitCode === null) p.child.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("the second refuses to start, the first keeps serving, and a crash releases the lock", async () => {
    const env = { KAIA_OAUTH_SIGNING_KEY_FILE: join(dir, "signing-key.pem") };
    const denylist = join(dir, "revoked-jti.json");

    const portP = await freePort();
    const p = startServer(portP, env);
    procs.push(p);
    await waitHealthy(portP, p);

    const q = startServer(await freePort(), env);
    procs.push(q);
    const qCode = await Promise.race([
      q.exited,
      new Promise<string>((r) => setTimeout(() => r("still running after 15s"), 15_000)),
    ]);
    expect(qCode).not.toBe("still running after 15s");
    expect(qCode).not.toBe(0);
    // The fatal line's error value is percent-encoded like every log value.
    const refusal = decodeLogText(q.stderr());
    expect(q.stderr()).toMatch(/ level=error msg=kaia-mcp failed error=\S+$/m);
    expect(refusal).toContain(denylist);
    expect(refusal).toMatch(/in use by another kaia-mcp process/);
    expect(refusal).toContain("KAIA_OAUTH_REVOCATION_FILE");

    // P is unaffected: still healthy, still enforcing auth, still able to revoke.
    expect((await fetch(`http://127.0.0.1:${portP}/health`)).status).toBe(200);
    const mcp = await fetch(`http://127.0.0.1:${portP}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    expect(p.child.exitCode).toBeNull();

    // A crash (SIGKILL: no exit hooks run) must not leave the file locked forever.
    p.child.kill("SIGKILL");
    await p.exited;
    expect(existsSync(`${denylist}.lock`)).toBe(true);
    const portR = await freePort();
    const r = startServer(portR, env);
    procs.push(r);
    await waitHealthy(portR, r);

    // A clean stop removes the lock file.
    r.child.kill("SIGTERM");
    await r.exited;
    expect(existsSync(`${denylist}.lock`)).toBe(false);
  }, 60_000);
});

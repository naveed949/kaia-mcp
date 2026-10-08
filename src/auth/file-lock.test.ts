/**
 * The lock file's mtime is the holder's heartbeat: a holder on another host cannot be
 * checked by pid, so its lock is only considered abandoned once the heartbeat is older
 * than the lease. A live holder must therefore keep refreshing it.
 */
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FileLock } from "./file-lock.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaia-filelock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("a live holder refreshes the lock file's mtime (heartbeat)", async () => {
  const path = join(dir, "x.lock");
  const lock = FileLock.acquire(path, { heartbeatMs: 50 });
  try {
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(path, old, old);
    await new Promise((r) => setTimeout(r, 300));
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(5_000);
  } finally {
    lock.release();
  }
});

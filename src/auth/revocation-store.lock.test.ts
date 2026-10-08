/**
 * One denylist file, one writer. Two processes sharing a file would overwrite each
 * other's revocations (a revoked token comes back after a restart), so the store takes a
 * lock at open and refuses to open a file another live process holds.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileRevocationStore,
  REVOCATION_LOCK_LEASE_MS,
  RevocationStoreError,
} from "./revocation-store.js";

/** A pid that existed and has exited (not reused within the test, in practice). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(r.stdout.toString());
}

describe("FileRevocationStore single-writer lock", () => {
  let dir: string;
  let path: string;
  let lock: string;
  const opened: FileRevocationStore[] = [];
  const open = () => {
    const s = FileRevocationStore.open(path);
    opened.push(s);
    return s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaia-revlock-"));
    path = join(dir, "revoked-jti.json");
    lock = `${path}.lock`;
  });

  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a second open while the first holds the file, naming the file and the fix", () => {
    const a = open();
    let err: unknown;
    try {
      open();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RevocationStoreError);
    const msg = String((err as Error).message);
    expect(msg).toContain(path);
    expect(msg).toMatch(/in use by another kaia-mcp process/);
    expect(msg).toContain("KAIA_OAUTH_REVOCATION_FILE");
    expect(msg).toContain(`pid ${process.pid}`);
    // The holder is unaffected.
    a.add("jti-a", Date.now() + 60_000);
    expect(a.has("jti-a")).toBe(true);
  });

  it("close() releases the lock: the file reopens and keeps its entries", () => {
    const a = open();
    a.add("jti-1", Date.now() + 60_000);
    expect(existsSync(lock)).toBe(true);
    a.close();
    expect(existsSync(lock)).toBe(false);
    const b = open();
    expect(b.has("jti-1")).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["revoked-jti.json", "revoked-jti.json.lock"]);
  });

  it("takes over a lock whose process has died (released on crash)", () => {
    const a = open();
    const record = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
    a.close();
    opened.splice(0);
    writeFileSync(lock, JSON.stringify({ ...record, pid: deadPid() }), { mode: 0o600 });
    const b = open();
    b.add("jti-b", Date.now() + 60_000);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
  });

  it.runIf(process.platform === "linux")(
    "takes over a lock whose pid is alive but was reused (start time differs)",
    () => {
      const a = open();
      const record = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
      a.close();
      opened.splice(0);
      // Our own (live) pid with a different start time: the recorded holder has exited.
      writeFileSync(lock, JSON.stringify({ ...record, startTicks: "1" }), { mode: 0o600 });
      const b = open();
      b.close();
      // Same pid and same start time is this very process: refused.
      writeFileSync(lock, JSON.stringify(record), { mode: 0o600 });
      expect(() => open()).toThrow(/in use by another kaia-mcp process/);
    }
  );

  it("refuses a lock held on another host until its heartbeat lease has expired", () => {
    const a = open();
    const record = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
    a.close();
    opened.splice(0);
    writeFileSync(lock, JSON.stringify({ ...record, host: "some-other-host", pid: 1 }), {
      mode: 0o600,
    });
    expect(() => open()).toThrow(/in use by another kaia-mcp process \(pid 1 on some-other-host/);
    const old = (Date.now() - 2 * REVOCATION_LOCK_LEASE_MS) / 1000;
    utimesSync(lock, old, old);
    expect(() => open()).not.toThrow();
  });

  it("fails closed on a malformed lock file until it is older than the lease", () => {
    writeFileSync(lock, "not json", { mode: 0o600 });
    expect(() => open()).toThrow(RevocationStoreError);
    expect(() => open()).toThrow(/lock file .* is unreadable/);
    const old = (Date.now() - 2 * REVOCATION_LOCK_LEASE_MS) / 1000;
    utimesSync(lock, old, old);
    expect(() => open()).not.toThrow();
  });

  it("refuses a symlink at the lock path", () => {
    symlinkSync(join(dir, "elsewhere"), lock);
    expect(() => open()).toThrow(RevocationStoreError);
  });

  it("a holder whose lock another process took refuses to persist (fail closed: the revoke is not acknowledged)", () => {
    const a = open();
    const record = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
    writeFileSync(lock, JSON.stringify({ ...record, nonce: "someone-else" }), { mode: 0o600 });
    expect(() => a.add("jti-x", Date.now() + 60_000)).toThrow(RevocationStoreError);
    expect(() => a.add("jti-y", Date.now() + 60_000)).toThrow(/no longer holds its lock/);
    // Still denied in this process, and nothing was written over the other holder's file.
    expect(a.has("jti-x")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("a vanished lock is re-taken and entries written in the gap are merged, not dropped", () => {
    const a = open();
    const exp = Date.now() + 60_000;
    a.add("jti-a", exp);
    // The lock file disappears and, meanwhile, another writer adds an entry.
    rmSync(lock);
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ id: "jti-gap", expMs: exp }] }), {
      mode: 0o600,
    });
    a.add("jti-b", exp);
    const ids = (JSON.parse(readFileSync(path, "utf8")) as { entries: { id: string }[] }).entries
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual(["jti-a", "jti-b", "jti-gap"]);
    expect(a.has("jti-gap")).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(() => open()).toThrow(/in use by another kaia-mcp process/);
  });
});

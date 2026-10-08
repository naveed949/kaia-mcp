/**
 * FileRevocationStore durability, observed through node:fs.
 *
 * - The temp file is written completely even when the OS accepts a short write.
 * - The parent directory is fsynced after the rename (best effort where unsupported).
 * - The temp file is created exclusively, so a symlink planted at its path is never followed.
 * - A no-op add (already expired, or already denied at least as long) does not rewrite the file,
 *   but an add after a failed write does.
 */
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

// A fixed temp-name suffix, so the test can plant a symlink where the store will write.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn((size: number) =>
      size === 4 ? Buffer.from("c0ffee00", "hex") : actual.randomBytes(size)
    ),
  };
});

const fs = await import("node:fs");
const { FileRevocationStore, RevocationStoreError } = await import("./revocation-store.js");

const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;
const realWrite = vi.mocked(fs.writeSync).getMockImplementation()! as (
  fd: number,
  data: string | Buffer,
  ...rest: unknown[]
) => number;
const realFsync = vi.mocked(fs.fsyncSync).getMockImplementation()!;

describe("FileRevocationStore durability", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "kaia-revdur-"));
    path = join(dir, "revoked-jti.json");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(fs.openSync).mockImplementation(realOpen);
    vi.mocked(fs.writeSync).mockImplementation(realWrite as typeof fs.writeSync);
    vi.mocked(fs.fsyncSync).mockImplementation(realFsync);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readEntries(): { id: string; expMs: number }[] {
    return (
      JSON.parse(fs.readFileSync(path, "utf8")) as { entries: { id: string; expMs: number }[] }
    ).entries;
  }

  it("writes the whole document even when the kernel accepts a short write", () => {
    // Every writeSync call accepts at most 7 bytes, like a pipe or a nearly full disk can.
    vi.mocked(fs.writeSync).mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      if (typeof data === "string") return realWrite(fd, data.slice(0, 7));
      const buf = data as Buffer;
      const offset = typeof rest[0] === "number" ? rest[0] : 0;
      const length = typeof rest[1] === "number" ? rest[1] : buf.length - offset;
      return realWrite(fd, buf, offset, Math.min(length, 7), rest[2]);
    }) as typeof fs.writeSync);
    const store = FileRevocationStore.open(path);
    const exp = Date.now() + 60_000;
    store.add("jti-short-write-1", exp);
    store.add("jti-short-write-2", exp);
    expect(readEntries().map((e) => e.id)).toEqual(["jti-short-write-1", "jti-short-write-2"]);
    expect(FileRevocationStore.open(path).has("jti-short-write-2")).toBe(true);
  });

  it("fsyncs the parent directory after the rename", () => {
    const store = FileRevocationStore.open(path);
    store.add("jti-dir-fsync", Date.now() + 60_000);
    const open = vi.mocked(fs.openSync);
    const dirOpenIdx = open.mock.calls.findIndex(([p]) => p === dirname(path));
    expect(dirOpenIdx).toBeGreaterThanOrEqual(0);
    const dirFd = open.mock.results[dirOpenIdx].value as number;
    const dirOpenOrder = open.mock.invocationCallOrder[dirOpenIdx];
    const fsync = vi.mocked(fs.fsyncSync);
    // fd numbers are reused, so match the fsync that follows the directory open.
    const dirFsyncIdx = fsync.mock.calls.findIndex(
      ([fd], i) => fd === dirFd && fsync.mock.invocationCallOrder[i] > dirOpenOrder
    );
    expect(dirFsyncIdx).toBeGreaterThanOrEqual(0);
    const rename = vi.mocked(fs.renameSync);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(dirOpenOrder).toBeGreaterThan(rename.mock.invocationCallOrder[0]);
  });

  it("treats a directory fsync the platform does not support as best effort", () => {
    vi.mocked(fs.fsyncSync).mockImplementation((fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
      }
      realFsync(fd);
    });
    const store = FileRevocationStore.open(path);
    expect(() => store.add("jti-einval", Date.now() + 60_000)).not.toThrow();
    expect(readEntries().map((e) => e.id)).toEqual(["jti-einval"]);
  });

  it("never follows a symlink planted at the temp path", () => {
    const victim = join(dir, "victim.txt");
    fs.writeFileSync(victim, "do not touch");
    const tmp = `${path}.${process.pid}.c0ffee00.tmp`;
    fs.symlinkSync(victim, tmp);
    const store = FileRevocationStore.open(path);
    expect(() => store.add("jti-symlink", Date.now() + 60_000)).toThrow(RevocationStoreError);
    expect(fs.readFileSync(victim, "utf8")).toBe("do not touch");
    // The denylist itself was not replaced by the attacker's link.
    expect(fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink()).toBe(false);
    // Fail closed: denied in this process even though the write was refused.
    expect(store.has("jti-symlink")).toBe(true);
  });

  it("does not rewrite the file for an already-expired or already-denied entry", () => {
    const store = FileRevocationStore.open(path);
    const exp = Date.now() + 60_000;
    store.add("jti-once", exp);
    const rename = vi.mocked(fs.renameSync);
    expect(rename).toHaveBeenCalledTimes(1);
    store.add("jti-expired", Date.now() - 1);
    store.add("jti-once", exp);
    store.add("jti-once", exp - 1000);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(store.has("jti-once")).toBe(true);
    // A later expiry is a real change and is written.
    store.add("jti-once", exp + 1000);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(readEntries()).toEqual([{ id: "jti-once", expMs: exp + 1000 }]);
  });

  it("retries the write on the next add after a failed one, even for the same entry", () => {
    const store = FileRevocationStore.open(path);
    const exp = Date.now() + 60_000;
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO: i/o error, open"), { code: "EIO" });
    });
    expect(() => store.add("jti-retry", exp)).toThrow(RevocationStoreError);
    expect(store.has("jti-retry")).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
    // Same entry again: the store is dirty, so this is not a no-op.
    store.add("jti-retry", exp);
    expect(readEntries()).toEqual([{ id: "jti-retry", expMs: exp }]);
  });
});

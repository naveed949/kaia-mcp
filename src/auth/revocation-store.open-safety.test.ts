/**
 * FileRevocationStore.open never blocks or follows a link at the denylist path:
 * - a FIFO there is refused at once ("not a regular file") instead of hanging startup;
 * - a symlink there (dangling or not) is refused instead of followed, so a dangling link
 *   can never load as an empty denylist.
 * And a directory fsync refused with EPERM/EACCES is warned about once per process.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const fs = await import("node:fs");
const { FileRevocationStore, RevocationStoreError } = await import("./revocation-store.js");
const realFsync = vi.mocked(fs.fsyncSync).getMockImplementation()!;

describe("FileRevocationStore.open safety", () => {
  let dir: string;
  let path: string;
  let unblocker: ChildProcess | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "kaia-revopen-"));
    path = join(dir, "revoked-jti.json");
  });

  afterEach(() => {
    unblocker?.kill("SIGKILL");
    unblocker = undefined;
    vi.mocked(fs.fsyncSync).mockImplementation(realFsync);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "a FIFO at the path is refused immediately (no blocking open)",
    () => {
      execFileSync("mkfifo", ["-m", "600", path]);
      // Safety net so a blocking open cannot hang the suite: a writer opens the FIFO after
      // 2 s, which would release a blocked reader. A correct open returns long before.
      unblocker = spawn("sh", ["-c", `sleep 2; exec 3>"${path}"; sleep 5`], { stdio: "ignore" });
      const t0 = Date.now();
      let err: unknown;
      try {
        FileRevocationStore.open(path);
      } catch (e) {
        err = e;
      }
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000);
      expect(err).toBeInstanceOf(RevocationStoreError);
      expect((err as Error).message).toMatch(/not a regular file/);
    }
  );

  it.skipIf(process.platform === "win32")(
    "a symlink at the path is refused, even when its target is a valid denylist",
    () => {
      const real = join(dir, "real.json");
      fs.writeFileSync(real, JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
      fs.symlinkSync(real, path);
      expect(() => FileRevocationStore.open(path)).toThrow(/symlink/);
    }
  );

  it.skipIf(process.platform === "win32")(
    "a dangling symlink is refused, not loaded as an empty denylist",
    () => {
      fs.symlinkSync(join(dir, "missing.json"), path);
      expect(() => FileRevocationStore.open(path)).toThrow(RevocationStoreError);
    }
  );

  it("a missing file is still an empty denylist (first start)", () => {
    expect(FileRevocationStore.open(path).has("x")).toBe(false);
  });

  it("directory fsync refused with EPERM/EACCES warns once per process, writes still succeed", () => {
    vi.mocked(fs.fsyncSync).mockImplementation((fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
      }
      return realFsync(fd);
    });
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const store = FileRevocationStore.open(path);
      store.add("jti-1", Date.now() + 60_000);
      store.add("jti-2", Date.now() + 60_000);
      vi.mocked(fs.fsyncSync).mockImplementation((fd: number) => {
        if (fs.fstatSync(fd).isDirectory()) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return realFsync(fd);
      });
      store.add("jti-3", Date.now() + 60_000);
    } finally {
      process.stderr.write = orig;
    }
    const warns = lines
      .join("")
      .split("\n")
      .filter((l) => l.includes("directory fsync"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("level=warn");
    expect(warns[0]).toMatch(/errno=EPERM/);
    expect(FileRevocationStore.open(path).has("jti-3")).toBe(true);
  });
});

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  chmodSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileRevocationStore,
  MemoryRevocationStore,
  RevocationStoreError,
} from "./revocation-store.js";
import { createDemoOAuthProvider } from "./provider.js";
import { AUTH_ERRORS, SCOPES } from "./constants.js";

describe("MemoryRevocationStore", () => {
  it("denies until expiry and prunes expired entries", () => {
    const store = new MemoryRevocationStore();
    const now = Date.now();
    store.add("live", now + 60_000);
    store.add("already-expired", now - 1);
    expect(store.has("live")).toBe(true);
    expect(store.has("already-expired")).toBe(false);
    expect(store.has("unknown")).toBe(false);
    store.prune(now + 120_000);
    expect(store.has("live")).toBe(false);
  });
});

describe("FileRevocationStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaia-revstore-"));
    path = join(dir, "nested", "revoked-jti.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a missing file as empty and round-trips entries atomically with mode 0600", () => {
    const a = FileRevocationStore.open(path);
    expect(a.has("x")).toBe(false);
    expect(existsSync(path)).toBe(false);
    const exp = Date.now() + 60_000;
    a.add("jti-1", exp);
    a.add("jti-2", exp);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      entries: [
        { id: "jti-1", expMs: exp },
        { id: "jti-2", expMs: exp },
      ],
    });
    // No temp files left behind; the lock file is held until close().
    expect(readdirSync(join(dir, "nested")).sort()).toEqual([
      "revoked-jti.json",
      "revoked-jti.json.lock",
    ]);

    a.close();
    const b = FileRevocationStore.open(path);
    expect(b.has("jti-1")).toBe(true);
    expect(b.has("jti-2")).toBe(true);
  });

  it("drops expired entries on load and on the next write", () => {
    const now = Date.now();
    const flat = join(dir, "revoked-jti.json");
    writeFileSync(
      flat,
      JSON.stringify({
        version: 1,
        entries: [
          { id: "old", expMs: now - 1000 },
          { id: "live", expMs: now + 60_000 },
        ],
      })
    );
    const store = FileRevocationStore.open(flat);
    expect(store.has("old")).toBe(false);
    expect(store.has("live")).toBe(true);
    store.add("new", now + 60_000);
    const ids = (
      JSON.parse(readFileSync(flat, "utf8")) as { entries: { id: string }[] }
    ).entries.map((e) => e.id);
    expect(ids.sort()).toEqual(["live", "new"]);
  });

  it.each([
    ["not JSON", "{"],
    ["empty", ""],
    ["array", "[]"],
    ["wrong version", JSON.stringify({ version: 2, entries: [] })],
    ["missing entries", JSON.stringify({ version: 1 })],
    ["empty id", JSON.stringify({ version: 1, entries: [{ id: "", expMs: 1 }] })],
    ["non-numeric expMs", JSON.stringify({ version: 1, entries: [{ id: "a", expMs: "1" }] })],
    ["null entry", JSON.stringify({ version: 1, entries: [null] })],
  ])("refuses to load a corrupt file (%s)", (_name, content) => {
    const flat = join(dir, "revoked-jti.json");
    writeFileSync(flat, content);
    expect(() => FileRevocationStore.open(flat)).toThrow(RevocationStoreError);
    expect(() => FileRevocationStore.open(flat)).toThrow(/revocation store .* is corrupt/);
  });

  it("refuses to load an unreadable path", () => {
    expect(() => FileRevocationStore.open(dir)).toThrow(/revocation store .* is unreadable/);
  });

  it("fails closed when a write cannot be made durable: throws, but still denies in-process", () => {
    const store = FileRevocationStore.open(path);
    // Replace the parent directory with a regular file so mkdir/open fail (ENOTDIR/EEXIST).
    rmSync(join(dir, "nested"), { recursive: true, force: true });
    writeFileSync(join(dir, "nested"), "not a directory");
    expect(() => store.add("jti-x", Date.now() + 60_000)).toThrow(/could not be written/);
    expect(store.has("jti-x")).toBe(true);
  });

  it("provider: a persist failure on revoke still rejects the token in-process", () => {
    const store = FileRevocationStore.open(path);
    const provider = createDemoOAuthProvider({
      issuer: "http://127.0.0.1:3999",
      revocationStore: store,
    });
    const t = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    rmSync(join(dir, "nested"), { recursive: true, force: true });
    writeFileSync(join(dir, "nested"), "not a directory");
    expect(() => provider.revoke(t.access_token)).toThrow(RevocationStoreError);
    expect(provider.verifyAccessToken(t.access_token)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.INVALID_TOKEN,
    });
  });

  it.each([
    ["group-writable", 0o620],
    ["world-writable", 0o602],
  ])("refuses to load a %s denylist", (_name, mode) => {
    const flat = join(dir, "revoked-jti.json");
    writeFileSync(flat, JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
    chmodSync(flat, mode);
    expect(() => FileRevocationStore.open(flat)).toThrow(RevocationStoreError);
    expect(() => FileRevocationStore.open(flat)).toThrow(/writable by group or others/);
  });

  it.runIf(typeof process.getuid === "function")(
    "refuses to load a denylist owned by another user",
    () => {
      const flat = join(dir, "revoked-jti.json");
      writeFileSync(flat, JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
      const uid = process.getuid!();
      const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        expect(() => FileRevocationStore.open(flat)).toThrow(/not owned by the current user/);
      } finally {
        spy.mockRestore();
      }
      expect(FileRevocationStore.open(flat).has("x")).toBe(false);
    }
  );
});

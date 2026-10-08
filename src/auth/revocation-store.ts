/**
 * Denylist of revoked token ids (access-token `jti`s), each kept until the token's own
 * expiry. The provider talks only to `RevocationStore`, so the backing store is a
 * deployment choice:
 *
 * - `MemoryRevocationStore`: per process. Correct when the signing key is in memory too,
 *   because a restart then invalidates every token anyway.
 * - `FileRevocationStore`: used when the signing key is persisted, so a revoked token
 *   cannot come back after a restart. Writes are atomic; a corrupt or unreadable file
 *   refuses to load rather than silently starting with an empty list.
 *
 * A shared store (Redis/KV) for multi-instance deployments can implement the same interface.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface RevocationStore {
  /**
   * Deny `id` until `expMs` (epoch ms). Throws if the entry cannot be made durable; the
   * entry is still denied in this process when that happens.
   */
  add(id: string, expMs: number): void;
  /** True while `id` is denied. */
  has(id: string): boolean;
  /** Drop entries whose expiry has passed. */
  prune(nowMs?: number): void;
}

/** On-disk shape of `FileRevocationStore`. */
export type RevocationFile = {
  version: 1;
  entries: { id: string; expMs: number }[];
};

export class RevocationStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RevocationStoreError";
  }
}

export class MemoryRevocationStore implements RevocationStore {
  protected readonly entries = new Map<string, number>();

  add(id: string, expMs: number): void {
    this.prune();
    if (expMs > Date.now()) this.entries.set(id, expMs);
  }

  has(id: string): boolean {
    const exp = this.entries.get(id);
    return exp !== undefined && exp > Date.now();
  }

  prune(nowMs = Date.now()): void {
    for (const [id, exp] of this.entries) {
      if (exp <= nowMs) this.entries.delete(id);
    }
  }
}

function parseRevocationFile(raw: string): RevocationFile["entries"] {
  const doc: unknown = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
  const { version, entries } = doc as Record<string, unknown>;
  if (version !== 1) throw new Error(`unsupported version ${String(version)}`);
  if (!Array.isArray(entries)) throw new Error("entries is not an array");
  return entries.map((e, i) => {
    const { id, expMs } = (e ?? {}) as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof expMs !== "number" ||
      !isFinite(expMs)
    ) {
      throw new Error(`entry ${i} is malformed`);
    }
    return { id, expMs };
  });
}

export class FileRevocationStore extends MemoryRevocationStore {
  private constructor(readonly path: string) {
    super();
  }

  /**
   * Load `path`. A missing file is an empty denylist (first start). Anything else that
   * cannot be read and validated throws `RevocationStoreError`.
   */
  static open(path: string): FileRevocationStore {
    const store = new FileRevocationStore(path);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw new RevocationStoreError(`revocation store ${path} is unreadable`, { cause: err });
    }
    let entries: RevocationFile["entries"];
    try {
      entries = parseRevocationFile(raw);
    } catch (err) {
      throw new RevocationStoreError(`revocation store ${path} is corrupt`, { cause: err });
    }
    const now = Date.now();
    for (const { id, expMs } of entries) {
      if (expMs > now) store.entries.set(id, expMs);
    }
    return store;
  }

  override add(id: string, expMs: number): void {
    super.add(id, expMs);
    this.persist();
  }

  /** Write-to-temp, fsync, rename: readers see the old file or the new one, never half. */
  private persist(): void {
    const doc: RevocationFile = {
      version: 1,
      entries: [...this.entries].map(([id, expMs]) => ({ id, expMs })),
    };
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(doc));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // the temp file was never created
      }
      throw new RevocationStoreError(`revocation store ${this.path} could not be written`, {
        cause: err,
      });
    }
  }
}

/**
 * Denylist of revoked token ids (access-token `jti`s), each kept until the token's own
 * expiry. The provider talks only to `RevocationStore`, so the backing store is a
 * deployment choice:
 *
 * - `MemoryRevocationStore`: per process. Correct when the signing key is in memory too,
 *   because a restart then invalidates every token anyway.
 * - `FileRevocationStore`: used when the signing key is persisted, so a revoked token
 *   cannot come back after a restart. Writes are atomic and durable; a corrupt, unreadable
 *   or insecure file refuses to load rather than silently starting with an empty list.
 *   One file belongs to exactly one process: the store keeps its own in-memory view and
 *   rewrites the whole file, so two processes sharing a file would drop each other's
 *   entries. Multi-instance deployments need a shared store instead.
 *
 * A shared store (Redis/KV) for multi-instance deployments can implement the same interface.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { logger } from "../utils/logger.js";

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

/**
 * The store could not be loaded or an entry could not be made durable. The message names
 * the file for operators; never send it to clients. `entryId` is the id being added (a
 * jti, not a secret) and `errno` the underlying system error code, when there is one.
 */
export class RevocationStoreError extends Error {
  readonly entryId?: string;
  readonly errno?: string;

  constructor(message: string, options?: { cause?: unknown; entryId?: string }) {
    super(message, options);
    this.name = "RevocationStoreError";
    this.entryId = options?.entryId;
    const code = (options?.cause as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string") this.errno = code;
  }
}

export class MemoryRevocationStore implements RevocationStore {
  protected readonly entries = new Map<string, number>();

  add(id: string, expMs: number): void {
    this.upsert(id, expMs);
  }

  /** Record `id` until `expMs`, never shortening an existing entry. True if anything changed. */
  protected upsert(id: string, expMs: number): boolean {
    this.prune();
    if (expMs <= Date.now()) return false;
    const current = this.entries.get(id);
    if (current !== undefined && current >= expMs) return false;
    this.entries.set(id, expMs);
    return true;
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
    let fd: number;
    // Never follow a link at the denylist path: a planted or dangling symlink must not
    // redirect (or empty) the denylist. lstat gives the clear error; O_NOFOLLOW closes the
    // race where it exists. O_NONBLOCK keeps a FIFO from blocking startup forever; fstat
    // below then refuses it as not a regular file.
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new RevocationStoreError(
          `revocation store ${path} is unreadable: refusing to follow a symlink`
        );
      }
    } catch (err) {
      if (err instanceof RevocationStoreError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw new RevocationStoreError(`revocation store ${path} is unreadable`, { cause: err });
    }
    try {
      fd = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return store;
      if (code === "ELOOP") {
        throw new RevocationStoreError(
          `revocation store ${path} is unreadable: refusing to follow a symlink`,
          { cause: err }
        );
      }
      throw new RevocationStoreError(`revocation store ${path} is unreadable`, { cause: err });
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        throw new RevocationStoreError(
          `revocation store ${path} is unreadable: not a regular file`
        );
      }
      // Anyone else who can write the denylist can un-revoke tokens. POSIX only: Windows
      // reports neither a uid nor meaningful group/other bits.
      if (process.platform !== "win32") {
        if (st.mode & 0o022) {
          throw new RevocationStoreError(
            `revocation store ${path} is insecure: writable by group or others (chmod 600 it)`
          );
        }
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (uid !== undefined && st.uid !== uid) {
          throw new RevocationStoreError(
            `revocation store ${path} is insecure: not owned by the current user (uid ${uid})`
          );
        }
      }
      raw = readFileSync(fd, "utf8");
    } catch (err) {
      if (err instanceof RevocationStoreError) throw err;
      throw new RevocationStoreError(`revocation store ${path} is unreadable`, { cause: err });
    } finally {
      closeSync(fd);
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

  /** True while the in-memory view holds entries the file does not (a write failed). */
  private dirty = false;

  /**
   * Deny `id` until `expMs` and make it durable. A no-op entry (already expired, or already
   * denied at least that long) does not rewrite the file, unless an earlier write failed.
   */
  override add(id: string, expMs: number): void {
    const changed = this.upsert(id, expMs);
    if (!changed && !this.dirty) return;
    this.dirty = true;
    this.persist(id);
    this.dirty = false;
  }

  /**
   * Write-to-temp, fsync, rename, fsync the directory: readers see the old file or the
   * new one, never half, and the rename itself survives a crash. The temp file is created
   * exclusively (O_CREAT|O_EXCL), so a file or symlink already at that path is never
   * opened or followed.
   */
  private persist(entryId: string): void {
    const doc: RevocationFile = {
      version: 1,
      entries: [...this.entries].map(([id, expMs]) => ({ id, expMs })),
    };
    const dir = dirname(this.path);
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let created = false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "wx", 0o600);
      created = true;
      try {
        // writeFileSync loops until every byte is written; a bare writeSync may not.
        writeFileSync(fd, JSON.stringify(doc));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.path);
      created = false;
      fsyncDirectory(dir);
    } catch (err) {
      if (created) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // best effort; the temp name is unique and never read back
        }
      }
      throw new RevocationStoreError(`revocation store ${this.path} could not be written`, {
        cause: err,
        entryId,
      });
    }
  }
}

/** Errors meaning "this platform or filesystem cannot fsync a directory", not data loss. */
const DIR_FSYNC_UNSUPPORTED = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EISDIR",
  "EPERM",
  "EACCES",
]);

/** Of those, the ones that mean "not allowed here" (a sandbox or ACL), worth telling the operator. */
const DIR_FSYNC_DENIED = new Set(["EPERM", "EACCES"]);

let warnedDirFsyncDenied = false;

/** Skipped directory fsync: silent where unsupported, one warning per process when denied. */
function dirFsyncSkipped(dir: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (!DIR_FSYNC_DENIED.has(code) || warnedDirFsyncDenied) return;
  warnedDirFsyncDenied = true;
  logger.warn(
    "revocation store directory fsync not permitted; a crash right after a revoke may lose it",
    { dir, errno: code }
  );
}

/** Persist the directory entry created by a rename. Best effort where unsupported (Windows). */
function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch (err) {
    if (DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) {
      dirFsyncSkipped(dir, err);
      return;
    }
    throw err;
  }
  try {
    fsyncSync(fd);
  } catch (err) {
    if (!DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    dirFsyncSkipped(dir, err);
  } finally {
    closeSync(fd);
  }
}

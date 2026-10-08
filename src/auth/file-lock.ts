/**
 * Single-writer lock for a file-backed store, held for the life of the process.
 *
 * Node has no flock/fcntl binding and this package takes no native dependency, so the
 * lock is a lock file created atomically (written in full to a temp file, then `link`ed
 * into place, which fails if the name exists) that records who holds it. "Released on
 * crash" comes from checking the holder, not from the kernel:
 *
 * - Same machine (same hostname, boot and pid namespace): the holder is alive only if its
 *   pid exists and, on Linux, still has the start time recorded in the lock (so a reused
 *   pid does not keep a dead holder's lock alive). A dead holder's lock is taken over at
 *   once.
 * - Anywhere else (another host on a shared volume, another container): liveness cannot
 *   be checked, so the holder refreshes the lock file's mtime every few seconds and the
 *   lock is only taken over once that heartbeat is older than the lease.
 *
 * Anything that cannot be decided (an unreadable or malformed lock file with a fresh
 * mtime, a symlink) refuses: the caller fails closed. The holder re-checks that the lock
 * is still its own before every write (`assertHeld`), so a lock lost to a race or deleted
 * by hand makes writes fail instead of silently clobbering another process.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** A lock whose heartbeat is older than this is considered abandoned (cross-host case). */
export const LOCK_LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

export type LockRecord = {
  version: 1;
  pid: number;
  host: string;
  /** Linux: /proc/sys/kernel/random/boot_id. */
  bootId?: string;
  /** Linux: the pid namespace (readlink /proc/self/ns/pid). */
  pidNs?: string;
  /** Linux: process start time in clock ticks since boot (/proc/<pid>/stat field 22). */
  startTicks?: string;
  nonce: string;
  createdAt: string;
};

/** Why acquiring failed. `holder` is set when another live (or unverifiable) process holds it. */
export class FileLockError extends Error {
  readonly lockPath: string;
  readonly holder?: LockRecord;
  readonly heartbeatAgeMs?: number;

  constructor(
    message: string,
    opts: { lockPath: string; holder?: LockRecord; heartbeatAgeMs?: number; cause?: unknown }
  ) {
    super(message, { cause: opts.cause });
    this.name = "FileLockError";
    this.lockPath = opts.lockPath;
    this.holder = opts.holder;
    this.heartbeatAgeMs = opts.heartbeatAgeMs;
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function startTicksOf(pid: number): string | undefined {
  const stat = readTrimmed(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  // Fields after the parenthesised command name start at field 3; starttime is field 22.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19];
}

function selfIdentity(): Omit<LockRecord, "nonce" | "createdAt"> {
  let pidNs: string | undefined;
  try {
    pidNs = readlinkSync("/proc/self/ns/pid");
  } catch {
    pidNs = undefined;
  }
  return {
    version: 1,
    pid: process.pid,
    host: hostname(),
    bootId: readTrimmed("/proc/sys/kernel/random/boot_id"),
    pidNs,
    startTicks: startTicksOf(process.pid),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const r = JSON.parse(raw) as Partial<LockRecord>;
    if (
      r &&
      r.version === 1 &&
      Number.isInteger(r.pid) &&
      (r.pid as number) > 0 &&
      typeof r.host === "string" &&
      typeof r.nonce === "string" &&
      r.nonce.length > 0
    ) {
      return r as LockRecord;
    }
  } catch {
    // malformed
  }
  return undefined;
}

type Observed =
  | { kind: "missing" }
  | { kind: "unreadable"; mtimeMs?: number; cause: unknown }
  | { kind: "held"; record: LockRecord; mtimeMs: number };

/** Read the lock file without following a symlink and without blocking on a FIFO. */
function observe(lockPath: string): Observed {
  let fd: number;
  try {
    fd = openSync(
      lockPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOTDIR: a path component is not a directory, so no lock file can exist there.
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", cause: err };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "unreadable", cause: new Error("not a regular file") };
    const record = parseRecord(readFileSync(fd, "utf8"));
    if (!record) return { kind: "unreadable", mtimeMs: st.mtimeMs, cause: new Error("malformed") };
    return { kind: "held", record, mtimeMs: st.mtimeMs };
  } catch (err) {
    return { kind: "unreadable", cause: err };
  } finally {
    closeSync(fd);
  }
}

/** True when `holder` is certainly gone (its lock may be taken over). */
function holderIsGone(holder: LockRecord, mtimeMs: number, leaseMs: number): boolean {
  const self = selfIdentity();
  const sameMachine =
    holder.host === self.host && holder.bootId === self.bootId && holder.pidNs === self.pidNs;
  const heartbeatExpired = Date.now() - mtimeMs > leaseMs;
  if (!sameMachine) return heartbeatExpired;
  if (!pidAlive(holder.pid)) return true;
  const current = startTicksOf(holder.pid);
  if (holder.startTicks !== undefined && current !== undefined) {
    // Same pid, different start time: the pid was reused after the holder exited.
    return holder.startTicks !== current;
  }
  // Without start times (non-Linux) a live pid may be a reuse; trust the heartbeat.
  return heartbeatExpired;
}

const held = new Set<FileLock>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const lock of [...held]) lock.release();
  });
}

export class FileLock {
  private heartbeat: NodeJS.Timeout | undefined;
  private released = false;
  /** Set when the heartbeat re-created a vanished lock file; reported by the next `ensureHeld`. */
  private recreated = false;

  private constructor(
    readonly lockPath: string,
    private readonly nonce: string
  ) {}

  /**
   * Take the lock at `lockPath` or throw `FileLockError`. Never waits: a live holder, an
   * unverifiable holder inside its lease, or an undecidable lock file is a refusal.
   */
  static acquire(
    lockPath: string,
    opts: { leaseMs?: number; heartbeatMs?: number } = {}
  ): FileLock {
    const leaseMs = opts.leaseMs ?? LOCK_LEASE_MS;
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 5; attempt++) {
      const nonce = randomBytes(16).toString("hex");
      if (tryCreate(lockPath, { ...selfIdentity(), nonce, createdAt: new Date().toISOString() })) {
        const lock = new FileLock(lockPath, nonce);
        lock.assertHeld();
        lock.start(opts.heartbeatMs ?? HEARTBEAT_MS);
        return lock;
      }
      const seen = observe(lockPath);
      if (seen.kind === "missing") continue;
      if (seen.kind === "unreadable") {
        const abandoned = seen.mtimeMs !== undefined && Date.now() - seen.mtimeMs > leaseMs;
        if (!abandoned) {
          throw new FileLockError(`lock file ${lockPath} is unreadable`, {
            lockPath,
            cause: seen.cause,
          });
        }
        takeOver(lockPath, undefined);
        continue;
      }
      if (!holderIsGone(seen.record, seen.mtimeMs, leaseMs)) {
        throw new FileLockError(`lock file ${lockPath} is held by pid ${seen.record.pid}`, {
          lockPath,
          holder: seen.record,
          heartbeatAgeMs: Math.max(0, Date.now() - seen.mtimeMs),
        });
      }
      takeOver(lockPath, seen.record.nonce);
    }
    throw new FileLockError(`lock file ${lockPath} could not be acquired (contended)`, {
      lockPath,
    });
  }

  private start(heartbeatMs: number): void {
    held.add(this);
    installExitHook();
    this.heartbeat = setInterval(() => {
      try {
        if (this.ensureHeld(true)) this.recreated = true;
        const now = new Date();
        utimesSync(this.lockPath, now, now);
      } catch {
        // lost or unwritable: the next write's ensureHeld reports it and fails closed
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  /** True while the lock file on disk is still this lock. */
  isHeld(): boolean {
    if (this.released) return false;
    const seen = observe(this.lockPath);
    return seen.kind === "held" && seen.record.nonce === this.nonce;
  }

  /** Throw unless this process still holds the lock. */
  assertHeld(): void {
    if (!this.isHeld()) throw this.lost();
  }

  /**
   * Call before every write. Returns normally while the lock is ours. A lock file that
   * vanished (deleted by hand, its directory recreated) is re-created, since nobody holds
   * it at that moment; the result is then true (also when the heartbeat re-created it
   * since the last call) so the caller can merge whatever another process wrote in the
   * gap. Throws `FileLockError` when another process holds it now, and the raw fs error
   * when it cannot be re-created.
   */
  ensureHeld(fromHeartbeat = false): boolean {
    if (this.released) throw this.lost();
    const seen = observe(this.lockPath);
    let recreated = false;
    if (seen.kind !== "held" || seen.record.nonce !== this.nonce) {
      if (seen.kind !== "missing") throw this.lost();
      mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
      const record = { ...selfIdentity(), nonce: this.nonce, createdAt: new Date().toISOString() };
      if (!tryCreate(this.lockPath, record)) throw this.lost();
      recreated = true;
    }
    if (fromHeartbeat) return recreated;
    const report = recreated || this.recreated;
    this.recreated = false;
    return report;
  }

  private lost(): FileLockError {
    return new FileLockError(`lock file ${this.lockPath} is no longer held by this process`, {
      lockPath: this.lockPath,
    });
  }

  /** Stop the heartbeat and remove the lock file if it is still ours. Idempotent. */
  release(): void {
    if (this.released) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    held.delete(this);
    try {
      if (this.isHeld()) rmSync(this.lockPath, { force: true });
    } catch {
      // best effort: a leftover lock is taken over once its holder is seen to be gone
    } finally {
      this.released = true;
    }
  }
}

/**
 * Create the lock file with its full content or not at all: write a private temp file,
 * then link it to the lock name (link fails with EEXIST rather than replacing a holder).
 */
function tryCreate(lockPath: string, record: LockRecord): boolean {
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Move an abandoned lock aside. If another process replaced it between our check and the
 * move, put its lock back (when the name is still free) so we never remove a live lock.
 */
function takeOver(lockPath: string, staleNonce: string | undefined): void {
  const aside = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const moved = observe(aside);
    const movedNonce = moved.kind === "held" ? moved.record.nonce : undefined;
    if (movedNonce !== staleNonce) {
      try {
        linkSync(aside, lockPath);
      } catch {
        // someone else holds the name now; the displaced holder's assertHeld will fail
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * One guard per machine.
 *
 * The rungs act on machine-global state — a shared state file and a
 * machine-wide process table — so a second guard is not a second opinion,
 * it is a second writer. Every pi process loads this extension: every
 * session, every sub-agent, every headless `pi -p` the guard itself
 * spawns. Without an election they would each sample, each decide, and
 * each clobber the others' writes.
 *
 * The election is an exclusive file. `open(path, "wx")` is atomic on
 * POSIX, so the winner is decided by the kernel, not by a read-then-write
 * race. The holder refreshes the file's mtime every guard iteration, so a
 * crashed holder's lock ages out instead of parking the machine forever.
 */
import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * How long a lock may go untouched before another process may take it.
 * The guard's slowest cadence is one minute (ok level, sampleSeconds ×6),
 * so three missed beats is a holder that is gone, not one that is busy.
 */
const STALE_MS = 3 * 60_000;

export interface LockHandle {
  /** Refresh the heartbeat. False means another loop now owns the path. */
  touch(): Promise<boolean>;
  /** Drop the lock. Safe to call twice. */
  release(): Promise<void>;
}

interface LockInfo {
  pid: number;
  /**
   * Identifies one guard loop, not one process. A session reload restarts the
   * loop inside the same pid, so pid alone cannot tell the outgoing loop's
   * release() from the incoming loop's lock — and the outgoing one must not
   * drop the lock the incoming one holds.
   */
  token?: string;
}

const readInfo = async (path: string): Promise<LockInfo | null> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockInfo>;
    return typeof parsed.pid === "number"
      ? { pid: parsed.pid, ...(typeof parsed.token === "string" ? { token: parsed.token } : {}) }
      : null;
  } catch {
    return null;
  }
};

/** A pid that is gone cannot be refreshing anything. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Take the lock, or return null when someone else holds it.
 *
 * A lock is taken over only when the holder is provably finished: its
 * heartbeat is stale, or its pid is gone. A live holder is never displaced
 * on a hunch, because two guards is exactly the failure this file exists
 * to prevent.
 */
export async function acquireLock(path: string, now = Date.now()): Promise<LockHandle | null> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, token } satisfies LockInfo));
      await handle.close();
      return makeHandle(path, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      const info = await readInfo(path);
      const age = await ageMs(path, now);
      // A lock this process owns is always stale: only one guard loop runs per
      // process, so our own pid in the file means the previous loop is gone.
      // Without this, a session reload would demote the restarted guard to a
      // follower for the life of the session, reading a lock nobody else owns.
      const holderGone = info === null || info.pid === process.pid || !isAlive(info.pid) || age > STALE_MS;
      if (!holderGone) return null;
      // Stale: clear it and try once more. If the holder was merely slow to
      // touch, the second attempt loses to a live lock and returns null.
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

const ageMs = async (path: string, now: number): Promise<number> => {
  try {
    return now - (await stat(path)).mtimeMs;
  } catch {
    return Infinity;
  }
};

const makeHandle = (path: string, token: string): LockHandle => {
  let held = true;
  const stillOwns = async (): Promise<boolean> => {
    const info = await readInfo(path);
    return info !== null && info.pid === process.pid && info.token === token;
  };
  return {
    async touch() {
      if (!held || !(await stillOwns())) {
        held = false;
        return false;
      }
      const now = new Date();
      try {
        await utimes(path, now, now);
        return true;
      } catch {
        held = false;
        return false;
      }
    },
    async release() {
      if (!held) return;
      held = false;
      // A same-pid reload has a different token. Only the exact loop that
      // wrote this file may unlink it; the outgoing loop must not drop the
      // incoming loop's lock.
      if (!(await stillOwns())) return;
      await unlink(path).catch(() => {});
    },
  };
};

export const lockPathFor = (statePath: string): string => join(dirname(statePath), "ballast-guard.lock");

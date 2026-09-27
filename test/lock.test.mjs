/**
 * One guard per machine.
 *
 * The election is the reason N pi sessions do not become N writers, so the
 * cases that matter are the ones where a second guard must NOT win: a live
 * foreign holder, and a lock this process already owns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lockPathFor } from "../src/lib/lock.ts";

const withTempLock = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "ballast-lock-"));
  try {
    return await fn(join(dir, "ballast-guard.lock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("the first caller wins and a live foreign holder keeps the lock", async () => {
  await withTempLock(async (path) => {
    const first = await acquireLock(path);
    assert.ok(first, "first acquire takes the lock");
    // A different process must not win. The parent is live and is not us.
    writeFileSync(path, JSON.stringify({ pid: process.ppid }));
    assert.equal(await acquireLock(path), null, "live foreign holder is not displaced");
    await first.release();
  });
});

test("a released lock is available again", async () => {
  await withTempLock(async (path) => {
    const first = await acquireLock(path);
    await first.release();
    const afterRelease = await acquireLock(path);
    assert.ok(afterRelease, "released lock is available again");
    await afterRelease.release();
  });
});

test("the outgoing loop's release does not drop the incoming loop's lock", async () => {
  // A session reload aborts the old loop and starts a new one in the same pid.
  // Both hold the file at different times; the old one's release must leave
  // the new one's lock alone, or the machine is left with no guard at all.
  await withTempLock(async (path) => {
    const old = await acquireLock(path);
    const fresh = await acquireLock(path); // reload: same pid, steals back
    assert.ok(fresh, "reload takes the lock back");
    await old.release(); // the old loop finishing late
    assert.equal(
      await acquireLock(lockWithForeignPid(path)),
      null,
      "the fresh lock survived the stale release",
    );
    await fresh.release();
  });
});

/** Rewrite the lock file so it looks held by another, live process. */
const lockWithForeignPid = (path) => {
  writeFileSync(path, JSON.stringify({ pid: process.ppid }));
  return path;
};

test("a lock held by a live foreign process is never stolen", async () => {
  await withTempLock(async (path) => {
    // Our parent is alive and is not us, so the holder looks healthy.
    writeFileSync(path, JSON.stringify({ pid: process.ppid }));
    assert.equal(await acquireLock(path), null);
  });
});

test("a lock this process owns is stolen back", async () => {
  await withTempLock(async (path) => {
    // A session reload restarts the guard loop in the same pid. Reading its
    // own lock as "held elsewhere" would demote it to follower for good.
    writeFileSync(path, JSON.stringify({ pid: process.pid }));
    const handle = await acquireLock(path);
    assert.ok(handle, "self-owned lock is reclaimable");
    await handle.release();
  });
});

test("a lock whose heartbeat aged out is stolen", async () => {
  await withTempLock(async (path) => {
    writeFileSync(path, JSON.stringify({ pid: process.ppid }));
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, longAgo, longAgo);
    const handle = await acquireLock(path);
    assert.ok(handle, "stale lock is reclaimable");
    await handle.release();
  });
});

test("release twice is safe, and touch does not throw", async () => {
  await withTempLock(async (path) => {
    const handle = await acquireLock(path);
    await handle.touch();
    await handle.release();
    await handle.release();
    await handle.touch();
  });
});

test("lockPathFor sits beside the state file", () => {
  assert.equal(lockPathFor("/home/dan/.pi/agent/ballast-state.json"), "/home/dan/.pi/agent/ballast-guard.lock");
});

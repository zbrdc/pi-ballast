/**
 * One guard per machine.
 *
 * The election is the reason N pi sessions do not become N writers, so the
 * cases that matter are the ones where a second guard must NOT win: a live
 * foreign holder, and a lock this process already owns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireLock, lockPathFor } from "../src/lib/lock.ts";

/**
 * The election as the machine actually runs it: two processes, one lock.
 *
 * Every other test here fakes the other holder by writing its pid into the
 * file. This one spawns it, because the property that matters with ten pi
 * sessions is that exactly one of them acts, and a faked pid cannot show what
 * a real contender does. The winner holds the lock rather than dropping it
 * immediately, so the loser is racing a live holder and not an empty file.
 */
test("two processes racing for the lock produce exactly one leader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ballast-lock-race-"));
  const path = join(dir, "ballast-guard.lock");
  const child = join(dir, "racer.mjs");
  // Absolute import path: a relative one resolves against /tmp.
  writeFileSync(
    child,
    `import { writeFileSync } from "node:fs";
import { acquireLock } from ${JSON.stringify(new URL("../src/lib/lock.ts", import.meta.url).pathname)};
const [lockPath, outPath] = process.argv.slice(2);
const lock = await acquireLock(lockPath);
writeFileSync(outPath, lock === null ? "follower" : "leader");
if (lock !== null) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  await lock.release();
}
`,
  );

  try {
    const run = (index) =>
      new Promise((resolve) => {
        const out = join(dir, `verdict-${index}`);
        const proc = spawn(process.execPath, ["--experimental-strip-types", child, path, out], {
          stdio: "ignore",
        });
        proc.on("exit", () => resolve(readFileSync(out, "utf8")));
      });
    const [a, b] = await Promise.all([run(0), run(1)]);
    assert.deepEqual([a, b].sort(), ["follower", "leader"], `exactly one leader (got ${a}, ${b})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("an outgoing loop cannot touch or release the incoming loop's lock", async () => {
  // A session reload aborts the old loop and starts a new one in the same pid.
  // The old loop can wake late from a sample or a process-table read. Its
  // token must keep it from refreshing or unlinking the fresh loop's lock.
  await withTempLock(async (path) => {
    const old = await acquireLock(path);
    const fresh = await acquireLock(path); // reload: same pid, steals back
    assert.ok(fresh, "reload takes the lock back");
    assert.equal(await old.touch(), false, "the old heartbeat detects that its token was replaced");
    await old.release(); // a late finally block from the old loop
    assert.equal(await fresh.touch(), true, "the new token still owns the lock");
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
  assert.equal(lockPathFor("/home/dev/.pi/agent/ballast-state.json"), "/home/dev/.pi/agent/ballast-guard.lock");
});

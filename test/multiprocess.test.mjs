/**
 * Two pi processes, one state file.
 *
 * Every session, sub-agent and headless child loads this extension, so the
 * store is written by several processes at once against a single JSON file.
 * The failure this prevents is quiet: a panel action in one session wiping
 * the guard's sample history in another.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../src/lib/store.ts";

/** Two stores on one path, plus a reader that only ever sees the file. */
const withStores = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "ballast-store-"));
  const path = join(dir, "ballast-state.json");
  const reopen = async () => {
    const store = new Store(path);
    await store.load();
    return store;
  };
  try {
    const a = await reopen();
    const b = await reopen();
    return await fn(a, b, reopen);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const sample = (atMs) => ({
  atMs,
  usedBytes: 1,
  headroomBytes: 2,
  swapUsedBytes: 0,
  compressedBytes: 0,
});

test("a meta key one process set survives another process's write", async () => {
  await withStores(async (a, b, reopen) => {
    a.setMeta("last-level", "warn");
    await a.flush();
    b.setMeta("config", { autoRelieve: "off" });
    await b.flush();
    const c = await reopen();
    assert.equal(c.getMeta("last-level"), "warn", "the other process's key survived");
    assert.deepEqual(c.getMeta("config"), { autoRelieve: "off" });
  });
});

test("a stale meta copy cannot overwrite a value another process just set", async () => {
  await withStores(async (a, b, reopen) => {
    // b loaded before a wrote, so b's in-memory "last-level" is null. b
    // writing must not push that stale null over a's fresh value.
    a.setMeta("last-level", "critical");
    await a.flush();
    b.setMeta("config", { autoRelieve: "safe" });
    await b.flush();
    const c = await reopen();
    assert.equal(c.getMeta("last-level"), "critical");
  });
});

test("samples from both processes land in one history", async () => {
  await withStores(async (a, b, reopen) => {
    const now = Date.now();
    a.recordSample(sample(now - 2000));
    await a.flush();
    b.recordSample(sample(now - 1000));
    await b.flush();
    const c = await reopen();
    assert.equal(c.history(10).length, 2, "neither process's sample was clobbered");
  });
});

test("guard events from both processes are kept, deduped by id", async () => {
  await withStores(async (a, b, reopen) => {
    const now = Date.now();
    a.recordGuardEvent({ atMs: now, action: "relieved", detail: "a", bytesFreed: 0, threadId: null });
    await a.flush();
    b.recordGuardEvent({ atMs: now + 1, action: "steered", detail: "b", bytesFreed: 0, threadId: null });
    await b.flush();
    const c = await reopen();
    assert.deepEqual(
      c.events(10).map((e) => e.detail).sort(),
      ["a", "b"],
      "both events survive and neither is duplicated",
    );
  });
});

test("event ids stay unique across processes", async () => {
  await withStores(async (a, b, reopen) => {
    const now = Date.now();
    a.recordGuardEvent({ atMs: now, action: "relieved", detail: "a", bytesFreed: 0, threadId: null });
    await a.flush();
    b.recordGuardEvent({ atMs: now + 1, action: "relieved", detail: "b", bytesFreed: 0, threadId: null });
    await b.flush();
    const c = await reopen();
    const ids = c.events(10).map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(",")}`);
  });
});

/**
 * Opening the database is where a whole fleet collides, and it is only
 * observable from separate processes — two Stores in one process never contend.
 *
 * The ordering this pins: busy_timeout must be set before journal_mode = WAL.
 * Switching journal mode needs an exclusive lock, and that statement does not
 * wait on a timeout that has not been set yet, so a session that lost the race
 * died with "database is locked" instead of retrying. Symptoms were a
 * missing panel toggle and no guard at all, with nothing in the logs to say why.
 */
test("a dozen processes opening at once all survive and all writes land", async () => {
  const WRITERS = 12;
  const dir = mkdtempSync(join(tmpdir(), "ballast-open-race-"));
  const dbPath = join(dir, "ballast-state.db");
  const child = join(dir, "writer.mjs");
  writeFileSync(
    child,
    `import { Store } from ${JSON.stringify(new URL("../src/lib/store.ts", import.meta.url).pathname)};
const [path, tag] = process.argv.slice(2);
const store = new Store(path);
for (let i = 0; i < 4; i++) {
  store.recordSample({ atMs: Date.now() + Number(tag), usedBytes: 1, headroomBytes: 2, swapUsedBytes: 0, compressedBytes: 0 });
  store.setMeta(\`tag-\${tag}\`, i);
  await store.flush();
}
`,
  );

  try {
    const failures = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        new Promise((resolve) => {
          const proc = spawn(process.execPath, ["--experimental-strip-types", child, dbPath, String(i)], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          proc.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          proc.on("exit", (code) => resolve({ code, stderr }));
        }),
      ),
    );

    const dead = failures.filter((f) => f.code !== 0);
    assert.deepEqual(
      dead.map((d) => d.stderr.split("\n").find((l) => /Error/.test(l)) ?? d.code),
      [],
      "no writer may die opening the database",
    );

    const reader = new Store(dbPath);
    const tags = Array.from({ length: WRITERS }, (_, i) => `tag-${i}`).filter((t) => reader.getMeta(t) !== null);
    assert.equal(tags.length, WRITERS, `every process's write landed (missing: ${WRITERS - tags.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

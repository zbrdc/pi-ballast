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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

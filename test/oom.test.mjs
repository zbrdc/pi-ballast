/**
 * Kernel OOM-kill detection: the journal parser, the failure-proof reader,
 * the leader's cursor-guarded poll, and the brief line that explains a 137.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextBrief, Engine } from "../src/engine.ts";
import { oomDetail, parseOomDetail, parseOomLine, readOomKills } from "../src/lib/oom.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const GB = 1024 ** 3;
const entry = (message, micros = 1_700_000_000_000_000) =>
  JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: String(micros) });

const GLOBAL =
  "Out of memory: Killed process 4242 (node) total-vm:9876540kB, anon-rss:2097152kB, file-rss:1024kB, shmem-rss:0kB, UID:1000 pgtables:8000kB oom_score_adj:0";
const CGROUP =
  "Memory cgroup out of memory: Killed process 777 (chrome) total-vm:1000kB, anon-rss:512000kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:300";
const BARE = "Out of memory: Killed process 99 (cc1plus)";

test("parses the global kill form with anon-rss", () => {
  assert.deepEqual(parseOomLine(entry(GLOBAL)), {
    atMs: 1_700_000_000_000,
    pid: 4242,
    name: "node",
    rssBytes: 2097152 * 1024,
  });
});

test("parses the cgroup kill form", () => {
  const kill = parseOomLine(entry(CGROUP));
  assert.equal(kill.pid, 777);
  assert.equal(kill.name, "chrome");
  assert.equal(kill.rssBytes, 512000 * 1024);
});

test("parses a kill without anon-rss", () => {
  const kill = parseOomLine(entry(BARE));
  assert.equal(kill.pid, 99);
  assert.equal(kill.name, "cc1plus");
  assert.equal("rssBytes" in kill, false);
});

test("ignores other kernel messages and malformed lines", () => {
  assert.equal(parseOomLine(entry("oom_reaper: reaped process 4242 (node), now anon-rss:0kB")), null);
  assert.equal(parseOomLine(entry("usb 1-1: new device")), null);
  assert.equal(parseOomLine("not json"), null);
  assert.equal(parseOomLine(JSON.stringify({ MESSAGE: [1, 2], __REALTIME_TIMESTAMP: "1" })), null);
});

test("detail round-trips through the event log text", () => {
  const detail = oomDetail({ atMs: 1, pid: 4242, name: "node", rssBytes: 2 * GB });
  assert.equal(detail, "node (pid 4242, 2.00 GB) killed by the kernel OOM killer");
  assert.deepEqual(parseOomDetail(detail), { name: "node", pid: 4242 });
  assert.deepEqual(parseOomDetail(oomDetail({ atMs: 1, pid: 5, name: "x" })), { name: "x", pid: 5 });
});

test("a failing journal reader yields no kills instead of throwing", async () => {
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.deepEqual(await readOomKills(Date.now()), []);
  } finally {
    process.env.PATH = saved;
  }
});

/* ---------------- brief ---------------- */

const pressureOf = (level = "ok") => ({
  level,
  reason: "test",
  signals: [],
  thresholds: DEFAULT_THRESHOLDS,
  sample: {
    atMs: Date.now(),
    headroomBytes: 2 * GB,
    usedBytes: 14 * GB,
    totalBytes: 16 * GB,
    swapUsedBytes: 0,
    swapInRate: 0,
    swapOutRate: 0,
    compressionRatio: 1,
    kernelPressure: null,
  },
});

test("brief names a recent kill and omits an old one", () => {
  const now = Date.now();
  const kills = [
    { atMs: now - 3 * 60_000, pid: 4242, name: "node" },
    { atMs: now - 40 * 60_000, pid: 11, name: "ancient" },
  ];
  const brief = contextBrief(pressureOf("warn"), now, null, { kills });
  assert.ok(brief.includes("Kernel OOM-killed node (pid 4242) 3m ago — a command exiting 137/SIGKILL was likely this."));
  assert.ok(!brief.includes("ancient"));
});

test("brief with only old kills stays silent at ok, and ok with a recent kill speaks", () => {
  const now = Date.now();
  assert.equal(contextBrief(pressureOf("ok"), now, null, { kills: [{ atMs: now - 3_600_000, pid: 1, name: "a" }] }), null);
  const brief = contextBrief(pressureOf("ok"), now, null, { kills: [{ atMs: now - 60_000, pid: 1, name: "a" }] });
  assert.ok(brief.includes("Kernel OOM-killed a (pid 1)"));
  assert.ok(!brief.includes("Memory pressure"));
});

test("a numeric 4th argument still means the CPU count", () => {
  assert.ok(contextBrief(pressureOf("warn"), Date.now(), null, 8).includes("Budget for new work"));
});

/* ---------------- leader poll ---------------- */

const reading = pressureOf("ok");

function withEngine(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ballast-oom-"));
  const engine = new Engine(join(dir, "state.db"));
  return engine.load().then(() => fn(engine)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("poll records kills once, advances the cursor, and is rate limited", { skip: process.platform !== "linux" }, () =>
  withEngine(async (engine) => {
    const now = Date.now();
    let calls = 0;
    const hooks = {
      readOomKills: async (since) => {
        calls += 1;
        return [{ atMs: now - 60_000, pid: 4242, name: "node", rssBytes: 2 * GB }].filter((k) => k.atMs >= since);
      },
    };
    await engine.pollOomKills(reading, hooks, now);
    await engine.pollOomKills(reading, hooks, now + 1000); // inside 60 s: no read
    assert.equal(calls, 1);
    await engine.pollOomKills(reading, hooks, now + 61_000); // cursor excludes the seen kill
    assert.equal(calls, 2);
    const kills = engine.recentOomKills(15 * 60_000, now);
    assert.equal(kills.length, 1);
    assert.equal(kills[0].name, "node");
    assert.equal(kills[0].rssBytes, 2 * GB);
    assert.equal(engine.events().filter((e) => e.action === "oom-killed").length, 1);
  }),
);

test("recentOomKills drops kills outside the window", () =>
  withEngine((engine) => {
    const now = Date.now();
    engine.store.recordGuardEvent({
      atMs: now - 30 * 60_000, level: "ok", headroomBytes: 0, usedFraction: 0,
      action: "oom-killed", detail: oomDetail({ atMs: 0, pid: 3, name: "old" }), bytesFreed: 0, threadId: null,
    });
    assert.deepEqual(engine.recentOomKills(15 * 60_000, now), []);
  }),
);

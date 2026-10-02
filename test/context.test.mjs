/**
 * Context injection: the guard's cached reading becomes a request-local
 * status message while pressure is elevated (BB contributeInstructions).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextBrief, Engine, parallelBudget } from "../src/engine.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";
import ballast from "../src/index.ts";

const GB = 1024 ** 3;
const pressureOf = (over = {}) => ({
  level: "warn",
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
    kernelPressure: 0,
  },
  ...over,
});
const topOf = (over = {}) => ({
  label: "strata",
  kind: "other",
  bytes: 43 * GB,
  threadId: null,
  atMs: Date.now(),
  fraction: 43 / 62,
  ...over,
});
const sampleOver = (pressure, over) => ({
  ...pressure,
  sample: { ...pressure.sample, ...over },
});

test("ok never injects", () => {
  assert.equal(contextBrief(pressureOf({ level: "ok" })), null);
});

test("a stale reading stays silent rather than lie", () => {
  const stale = sampleOver(pressureOf(), { atMs: Date.now() - 3 * 60_000 });
  assert.equal(contextBrief(stale), null);
});

test("fresh warn produces a brief that disclaims being the user", () => {
  const brief = contextBrief(pressureOf());
  assert.ok(brief.includes("WARN"));
  assert.ok(brief.includes("headroom"));
  assert.ok(brief.includes("not a user message"));
});

test("paging shows up when swap-in is active", () => {
  const paging = sampleOver(pressureOf({ level: "critical" }), {
    swapInRate: 220 * 1024 ** 2,
  });
  assert.ok(contextBrief(paging).includes("paging in"));
});

test("watch counts as elevated but carries no advice", () => {
  const brief = contextBrief(pressureOf({ level: "watch" }), Date.now(), topOf());
  assert.ok(brief.includes("WATCH"));
  assert.ok(brief.includes("Largest consumer"));
  assert.ok(!brief.includes("Budget for new work"));
  assert.ok(!brief.includes("ballast_plan"));
});

test("warn and critical carry the budget and the plan pointer", () => {
  for (const level of ["warn", "critical"]) {
    const brief = contextBrief(pressureOf({ level }), Date.now(), null, 8);
    assert.ok(brief.includes("Budget for new work: one job at a time — run builds and tests serially (make -j1"));
    assert.ok(!brief.includes("~1 parallel jobs"));
    assert.ok(!brief.includes("if they launch browsers"));
    assert.ok(brief.includes("Use ballast_plan before stopping anything you did not start."));
    assert.ok(!brief.includes("Close browsers"));
  }
});

test("budget with room for several jobs keeps the parallel wording", () => {
  const roomy = sampleOver(pressureOf({ level: "warn" }), { headroomBytes: 7 * GB });
  const brief = contextBrief(roomy, Date.now(), null, 16);
  assert.ok(brief.includes("Budget for new work: ~3 parallel jobs (e.g. make -j3, cargo build -j3, --test-threads=3)."));
  assert.ok(brief.includes("Run test suites serially if they launch browsers."));
});

test("paging rate is per minute from a per-second sample", () => {
  const paging = sampleOver(pressureOf(), { swapInRate: 1024 ** 2 });
  assert.ok(contextBrief(paging).includes("paging in 60.0 MB/min"));
});

test("parallel budget clamps between 1 and the cpu count", () => {
  assert.equal(parallelBudget(0.5 * GB, 16), 1);
  assert.equal(parallelBudget(0, 16), 1);
  assert.equal(parallelBudget(7 * GB, 16), 3);
  assert.equal(parallelBudget(512 * GB, 8), 8);
  assert.equal(parallelBudget(512 * GB, 0), 1);
  assert.ok(parallelBudget(512 * GB) >= 1);
});

const makePi = () => {
  const handlers = {};
  return { handlers, registerCommand() {}, registerTool() {}, on: (e, h) => (handlers[e] = h) };
};

test("context handler appends one status message when elevated", () => {
  const pi = makePi();
  ballast(pi);
  const original = Engine.prototype.lastReading;
  try {
    Engine.prototype.lastReading = () => pressureOf({ level: "warn" });
    const result = pi.handlers.context({ type: "context", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.messages.length, 2);
    const injected = result.messages[1];
    assert.equal(injected.role, "user");
    assert.ok(injected.content.includes("WARN"));
    assert.equal(typeof injected.timestamp, "number");
  } finally {
    Engine.prototype.lastReading = original;
  }
});

test("context handler leaves the transcript alone when ok", () => {
  const pi = makePi();
  ballast(pi);
  const original = Engine.prototype.lastReading;
  try {
    Engine.prototype.lastReading = () => pressureOf({ level: "ok" });
    const result = pi.handlers.context({ type: "context", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result, undefined);
  } finally {
    Engine.prototype.lastReading = original;
  }
});

test("brief names the top consumer outside any project", () => {
  const brief = contextBrief(pressureOf(), Date.now(), topOf());
  assert.ok(brief.includes("Largest consumer: strata (43.0 GB, 69% of RAM), outside any project."));
});

test("brief names the project when the top consumer has a thread", () => {
  const brief = contextBrief(pressureOf(), Date.now(), topOf({ threadId: "/home/dev/hold" }));
  assert.ok(brief.includes("in project /home/dev/hold."));
});

test("brief prefers the project title over the full path", () => {
  const top = topOf({ threadId: "/home/dev/hold", threadTitle: "hold" });
  assert.ok(contextBrief(pressureOf(), Date.now(), top).includes("in project hold."));
});

test("a stored record without threadTitle falls back to the thread id", () => {
  const legacy = topOf({ threadId: "/home/dev/hold" });
  delete legacy.threadTitle;
  assert.ok(contextBrief(pressureOf(), Date.now(), legacy).includes("in project /home/dev/hold."));
});

test("absent top consumer omits the line", () => {
  assert.ok(!contextBrief(pressureOf()).includes("Largest consumer"));
  assert.ok(!contextBrief(pressureOf(), Date.now(), null).includes("Largest consumer"));
});

test("Engine.topConsumer returns a fresh record and drops a stale one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ballast-top-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    assert.equal(engine.topConsumer(), null);
    const fresh = topOf();
    engine.store.setMeta("top-consumer", fresh);
    assert.deepEqual(engine.topConsumer(), fresh);
    assert.equal(engine.topConsumer(fresh.atMs + 3 * 60_000), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context handler passes the stored top consumer into the brief", () => {
  const pi = makePi();
  ballast(pi);
  const origReading = Engine.prototype.lastReading;
  const origTop = Engine.prototype.topConsumer;
  try {
    Engine.prototype.lastReading = () => pressureOf({ level: "warn" });
    Engine.prototype.topConsumer = () => topOf();
    const result = pi.handlers.context({ type: "context", messages: [] });
    assert.ok(result.messages[0].content.includes("Largest consumer: strata"));
  } finally {
    Engine.prototype.lastReading = origReading;
    Engine.prototype.topConsumer = origTop;
  }
});

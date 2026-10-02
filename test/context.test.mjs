/**
 * Context injection: the guard's cached reading becomes a request-local
 * status message while pressure is elevated (BB contributeInstructions).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextBrief, Engine } from "../src/engine.ts";
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

test("watch counts as elevated", () => {
  assert.ok(contextBrief(pressureOf({ level: "watch" })) !== null);
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

const topOf = (over = {}) => ({
  label: "strata",
  kind: "other",
  bytes: 43 * GB,
  threadId: null,
  atMs: Date.now(),
  fraction: 43 / 62,
  ...over,
});

test("brief names the top consumer outside any project", () => {
  const brief = contextBrief(pressureOf(), Date.now(), topOf());
  assert.ok(brief.includes("Largest consumer: strata (43.0 GB, 69% of RAM), outside any project."));
});

test("brief names the project when the top consumer has a thread", () => {
  const brief = contextBrief(pressureOf(), Date.now(), topOf({ threadId: "/home/dev/hold" }));
  assert.ok(brief.includes("in project /home/dev/hold."));
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

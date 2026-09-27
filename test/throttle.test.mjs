/**
 * The throttle rung.
 *
 * Pausing is the reversible intervention: what gets SIGSTOPped comes back on
 * SIGCONT, so it may run before anything is killed. But reversibility is not
 * a license — the same gate that governs killing governs pausing. These tests
 * hold that line from three sides: the authorize gate, persistence across a
 * restart, and the restore path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userInfo } from "node:os";
import { Engine, defaultConfig } from "../src/engine.ts";
import { buildPlan } from "../src/lib/relieve.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const ME = userInfo().username;

const row = (over = {}) => ({
  pid: 100,
  ppid: 1,
  rssBytes: 1024 ** 3,
  ageSeconds: 3600,
  cpuPercent: 0,
  command: "chrome-headless-shell --headless",
  name: "chrome-headless-shell",
  user: ME,
  kind: "browser-automation",
  threadId: null,
  port: null,
  ...over,
});

const consumer = (over = {}) => ({
  id: "pid:100",
  label: "Headless browser",
  detail: "chrome-headless-shell --headless",
  kind: "browser-automation",
  bytes: 1024 ** 3,
  processCount: 1,
  rootPid: 100,
  parentPid: 900,
  pids: [100],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: null,
  threadTitle: null,
  port: null,
  ...over,
});

const relieveConfig = {
  protectedPorts: new Set(),
  exemptPatterns: [],
  idleSeconds: 600,
  protectedThreadIds: new Set(),
};

const pressure = {
  level: "warn",
  reason: "headroom 2.1 GB below 3 GB floor",
  signals: [],
  thresholds: DEFAULT_THRESHOLDS,
  sample: {
    atMs: Date.now(),
    headroomBytes: 2 * 1024 ** 3,
    usedBytes: 8 * 1024 ** 3,
    swapUsedBytes: 0,
    compressedBytes: 0,
    swapInRate: 0,
    swapOutRate: 0,
    compressionRatio: 1,
    kernelPressure: "nominal",
  },
};

/** A plan built the way the guard builds it — through the gate, not around it. */
const planOf = (consumers, rows) =>
  buildPlan({
    consumers,
    threadConsumers: [],
    rows,
    config: relieveConfig,
    selfPids: new Set(),
    steerLimit: 0,
  });

const trackedHooks = () => {
  const stopped = [];
  const continued = [];
  return {
    stopped,
    continued,
    stop: (pid) => stopped.push(pid),
    cont: (pid) => continued.push(pid),
  };
};

const configOf = (over = {}) => ({ ...defaultConfig(), throttle: "safe", ...over });

test("the authorize gate governs pausing: only safe candidates are stopped", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    const browser = consumer(); // orphaned idle headless browser -> safe
    const piSession = consumer({
      id: "pid:200",
      label: "pi session",
      kind: "pi",
      bytes: 2 * 1024 ** 3,
      rootPid: 200,
      parentPid: 1,
      pids: [200],
    }); // not killable -> protected
    const plan = planOf(
      [browser, piSession],
      [row(), row({ pid: 200, kind: "pi", command: "/usr/local/bin/pi", name: "pi" })],
    );
    const hooks = trackedHooks();
    engine.throttleRung(configOf(), "warn", plan, pressure, hooks);
    assert.deepEqual(hooks.stopped, [100], "stops the safe candidate only");
    assert.equal(engine.store.getMeta("throttle-paused").length, 1, "paused set holds the safe pid");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("disruptive-only plans pause nothing", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    // Authorized but not disposable: alive parent means someone holds it.
    const busyBrowser = consumer({ parentPid: 900, rootPid: 100, cpuPercent: 50, ageSeconds: 3600 });
    // buildPlan needs the parent row alive so it is not an orphan
    const rows = [row(), row({ pid: 900, ppid: 1, kind: "other", command: "npm run dev", name: "npm", rssBytes: 64 * 1024 ** 2 })];
    const plan = planOf([busyBrowser], rows);
    const hooks = trackedHooks();
    engine.throttleRung(configOf(), "warn", plan, pressure, hooks);
    assert.deepEqual(hooks.stopped, [], "disruptive work is never paused");
    assert.equal(engine.store.getMeta("throttle-paused"), null, "no paused set written");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("watch is below the pause threshold", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    const hooks = trackedHooks();
    engine.throttleRung(configOf(), "watch", planOf([consumer()], [row()]), pressure, hooks);
    assert.deepEqual(hooks.stopped, [], "watch never pauses");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("one pause wave per episode: an existing paused set blocks a second", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    const hooks = trackedHooks();
    const plan = planOf([consumer()], [row()]);
    engine.throttleRung(configOf(), "warn", plan, pressure, hooks);
    assert.equal(hooks.stopped.length, 1);
    const secondConsumer = consumer({ pid: 300, rootPid: 300, pids: [300] });
    const plan2 = planOf([consumer(), secondConsumer], [row(), row({ pid: 300 })]);
    engine.throttleRung(configOf(), "critical", plan2, pressure, hooks);
    assert.equal(hooks.stopped.length, 1, "no second wave while paused");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("the paused set survives a restart via store meta", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  const state = join(dir, "state.json");
  try {
    const first = new Engine(state);
    first.throttleRung(configOf(), "warn", planOf([consumer()], [row()]), pressure, trackedHooks());
    await first.flush();

    const second = new Engine(state);
    await second.load();
    assert.deepEqual(second.store.getMeta("throttle-paused"), [100], "restart rehydrates the paused set");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("resumePaused restores every pid and clears the set", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    engine.store.setMeta("throttle-paused", [100, 300]);
    const hooks = trackedHooks();
    engine.resumePaused(pressure, hooks);
    assert.deepEqual(hooks.continued, [100, 300], "every paused pid resumed");
    assert.equal(engine.store.getMeta("throttle-paused"), null, "set cleared");
    const events = engine.events(5);
    assert.equal(events[0].action, "restored", "restore is on the record");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("throttle: off configures the rung out entirely", async () => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-throttle-"));
  try {
    const engine = new Engine(join(dir, "state.json"));
    const hooks = trackedHooks();
    engine.throttleRung(configOf({ throttle: "off" }), "critical", planOf([consumer()], [row()]), pressure, hooks);
    assert.deepEqual(hooks.stopped, [], "off means off");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

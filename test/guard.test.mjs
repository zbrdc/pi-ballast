/**
 * The ladder as it actually runs: one loop, BB's order, real gating.
 *
 * These tests drive runGuard itself — sampling, plan, and relief are patched
 * in, hooks record the order events happen. The two properties that must
 * never regress: throttle runs before anything irreversible, and escalation
 * never fires in the same breath as a relief that just acted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, defaultConfig } from "../src/engine.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const PROJECT = "/home/dan/git/hold";

const pressureOf = (level) => ({
  level,
  reason: "test fixture",
  signals: [],
  thresholds: DEFAULT_THRESHOLDS,
  sample: {
    atMs: Date.now(),
    headroomBytes: 1 * 1024 ** 3,
    usedBytes: 8 * 1024 ** 3,
    totalBytes: 16 * 1024 ** 3,
    swapUsedBytes: 0,
    compressedBytes: 0,
    swapInRate: 0,
    swapOutRate: 0,
    compressionRatio: 1,
    kernelPressure: "warning",
  },
});

const candidate = (over = {}) => ({
  id: "kill:100:browser-automation",
  action: "terminate",
  risk: "safe",
  label: "Headless browser",
  rationale: "orphaned",
  bytes: 1024 ** 3,
  pids: [100],
  kind: "browser-automation",
  threadId: null,
  refusal: null,
  ...over,
});

const threadConsumer = {
  id: "pid:100",
  label: "hold",
  detail: "npm run dev",
  kind: "dev-server",
  bytes: 512 * 1024 ** 2,
  processCount: 1,
  rootPid: 100,
  parentPid: 1,
  pids: [100],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: PROJECT,
  threadTitle: "hold",
  port: null,
};

const planOf = (candidates = [candidate()]) => ({ candidates });
const snapOf = () => ({ consumers: [threadConsumer], threads: [threadConsumer], rows: [], titles: new Map(), selfPids: new Set() });

/**
 * Drive the guard loop through a queue of pressure levels. Rungs execute for
 * real; sampling, planning, and the kill itself are patched in. The loop ends
 * when the queue is exhausted.
 */
const drive = async (engine, levels, hooks) => {
  let i = 0;
  const controller = new AbortController();
  engine.readPressure = async () => {
    if (i >= levels.length) controller.abort();
    return pressureOf(levels[Math.min(i++, levels.length - 1)]);
  };
  const snap = snapOf();
  engine.snapshot = async () => snap;
  engine.makePlan = async () => ({ plan: planOf(), snap });
  engine.runRelief = async () => ({ succeeded: 1, failed: 0, bytesFreed: 1024 ** 3, items: [] });
  await engine.runGuard(controller.signal, () => {}, hooks);
};

const harness = async (over = {}) => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-guard-"));
  const engine = new Engine(join(dir, "state.json"));
  const order = [];
  const hooks = {
    mode: "tui",
    cwd: PROJECT,
    stop: (pid) => order.push(["throttle", pid]),
    cont: (pid) => order.push(["resume", pid]),
    sendUserMessage: (text) => order.push(["steer", text]),
    spawnEscalation: (prompt) => order.push(["escalate", prompt]),
    ...over.hooks,
  };
  engine.store.setMeta("config", {
    ...defaultConfig(),
    sampleSeconds: 0.01,
    throttle: "safe",
    steer: true,
    escalate: true,
    autoRelieve: "safe",
    ...(over.config ?? {}),
  });
  return { dir, engine, order, hooks };
};

const cleanup = async (dir) => rmSync(dir, { recursive: true, force: true });

test("relief due: throttle, steer, and relief run — escalation holds its breath", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer"], "throttle precedes steer");
    // relief is recorded via events, not hooks — prove it ran and escalate did not
    const actions = h.engine.events(10).map((e) => e.action);
    assert.ok(actions.includes("throttled"), "throttle rung ran");
    assert.ok(actions.includes("steered"), "steer rung ran");
    assert.ok(actions.includes("relieved"), "relief rung ran");
    assert.ok(!kinds.includes("escalate"), "no escalation the same tick relief acted");
    assert.deepEqual(h.engine.store.getMeta("throttle-paused"), [100], "pause held");
  } finally {
    await cleanup(h.dir);
  }
});

test("relief configured out: throttle, steer, escalate — no kill", async () => {
  const h = await harness({ config: { autoRelieve: "off" } });
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer", "escalate"], "ladder order, escalate in relief's slot");
    const actions = h.engine.events(10).map((e) => e.action);
    assert.ok(!actions.includes("relieved"), "relief is configured out");
    assert.ok(actions.includes("escalated"), "escalation took over");
  } finally {
    await cleanup(h.dir);
  }
});

test("a relief that just ran keeps escalation waiting out its cadence", async () => {
  const h = await harness();
  try {
    h.engine.store.setMeta("last-relief", Date.now() - 60_000); // still inside the 2-min cadence
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.ok(!kinds.includes("escalate"), "no agent while kills may still be landing");
    assert.ok(!kinds.includes("resume"), "pressure never cleared");
  } finally {
    await cleanup(h.dir);
  }
});

test("pressure clearing resumes the paused and stops the ladder", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["critical", "critical", "ok"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer", "resume"], "clear pressure restores the paused");
    assert.equal(h.engine.store.getMeta("throttle-paused"), null, "pause cleared");
    const actions = h.engine.events(10).map((e) => e.action);
    assert.ok(actions.includes("restored"), "restore is on the record");
  } finally {
    await cleanup(h.dir);
  }
});

test("a paused set from a previous session blocks a new pause wave but not the rest", async () => {
  const h = await harness();
  try {
    h.engine.store.setMeta("throttle-paused", [999]);
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.ok(!kinds.includes("throttle"), "no second wave");
    assert.ok(kinds.includes("steer"), "steer still runs");
    assert.deepEqual(h.engine.store.getMeta("throttle-paused"), [999], "old set untouched");
  } finally {
    await cleanup(h.dir);
  }
});

test("warn engages throttle and steer but never relief or escalation", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["warn", "warn"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer"], "warn is the reversible band");
    const actions = h.engine.events(10).map((e) => e.action);
    assert.ok(!actions.includes("relieved") && !actions.includes("escalated"), "no irreversible rung at warn");
  } finally {
    await cleanup(h.dir);
  }
});

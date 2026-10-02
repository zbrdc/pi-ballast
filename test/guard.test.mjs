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
import { writeFileSync } from "node:fs";
import { Engine, defaultConfig } from "../src/engine.ts";
import { lockPathFor } from "../src/lib/lock.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const PROJECT = "/home/dev/git/hold";

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
  bytes: 2 * 1024 ** 3,
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
const drive = async (engine, levels, hooks, consumers = [threadConsumer]) => {
  let i = 0;
  const controller = new AbortController();
  engine.readPressure = async () => {
    if (i >= levels.length) controller.abort();
    return pressureOf(levels[Math.min(i++, levels.length - 1)]);
  };
  const snap = { ...snapOf(), consumers };
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
    sendSteer: (text) => order.push(["steer", text]),
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
  // A foreign live holder makes this session a follower for the whole test:
  // acquireLock refuses it, exactly as it would with another pi session's
  // guard holding the machine. process.ppid is alive and is not us.
  if (over.follower) {
    writeFileSync(lockPathFor(join(dir, "state.json")), JSON.stringify({ pid: process.ppid }));
  }
  return { dir, engine, order, hooks };
};

const cleanup = async (dir) => rmSync(dir, { recursive: true, force: true });

test("relief due: throttle, steer, and relief run — escalation holds its breath", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer", "resume"], "throttle precedes steer; shutdown restores it");
    // relief is recorded via events, not hooks — prove it ran and escalate did not
    const actions = h.engine.events(10).map((e) => e.action);
    assert.ok(actions.includes("throttled"), "throttle rung ran");
    assert.ok(actions.includes("steered"), "steer rung ran");
    assert.ok(actions.includes("relieved"), "relief rung ran");
    assert.ok(!kinds.includes("escalate"), "no escalation the same tick relief acted");
    assert.equal(h.engine.store.getMeta("throttle-paused"), null, "shutdown resumed and cleared the pause");
  } finally {
    await cleanup(h.dir);
  }
});

test("relief configured out: throttle, steer, escalate — no kill", async () => {
  const h = await harness({ config: { autoRelieve: "off" } });
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer", "escalate", "resume"], "ladder order, then shutdown cleanup");
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
    assert.ok(kinds.includes("resume"), "shutdown still cleans up the pause");
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
    assert.ok(kinds.includes("resume"), "shutdown cleans up the old wave");
    assert.equal(h.engine.store.getMeta("throttle-paused"), null, "old set is cleared after resume");
  } finally {
    await cleanup(h.dir);
  }
});

test("a follower steers: the holding session speaks without leading", async () => {
  const h = await harness({ follower: true });
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["steer"], "steer is the only rung a follower runs");
    assert.equal(
      h.engine.events(10).some((e) => e.action === "steered"),
      true,
      "and it is on the record",
    );
  } finally {
    await cleanup(h.dir);
  }
});

test("a follower holds no machine rungs at all", async () => {
  const h = await harness({ follower: true });
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    const actions = h.engine.events(10).map((e) => e.action);
    for (const forbidden of ["throttled", "relieved", "escalated"]) {
      assert.ok(!actions.includes(forbidden), `a follower must not ${forbidden}`);
    }
    assert.equal(h.engine.store.getMeta("throttle-paused"), null, "and touches no machine state");
  } finally {
    await cleanup(h.dir);
  }
});

test("only the leader records the observed transition", async () => {
  const leader = await harness();
  const follower = await harness({ follower: true });
  try {
    await drive(leader.engine, ["critical", "critical"], leader.hooks);
    await drive(follower.engine, ["critical", "critical"], follower.hooks);
    const observed = (h) => h.engine.events(10).filter((e) => e.action === "observed").length;
    assert.equal(observed(leader), 1, "the leader records the level change once");
    assert.equal(observed(follower), 0, "a follower leaves the shared log alone");
    assert.equal(leader.engine.store.getMeta("last-level"), "critical");
    assert.equal(follower.engine.store.getMeta("last-level"), null, "and the shared meta");
  } finally {
    await cleanup(leader.dir);
    await cleanup(follower.dir);
  }
});

/**
 * The resume bug this gate split exposed.
 *
 * The old gate was "under pressure AND leader", so every other branch was
 * "resume what the throttle held" — which meant a follower under pressure
 * resumed the leader's pause wave one tick after it started, and with ten
 * sessions running that was a matter of seconds. Resume belongs to ok alone.
 */
test("a follower under pressure never resumes the leader's pause", async () => {
  const h = await harness({ follower: true });
  try {
    h.engine.store.setMeta("throttle-paused", [4242]);
    await drive(h.engine, ["critical", "critical"], h.hooks);
    assert.ok(
      !h.order.some(([k]) => k === "resume"),
      "pressure never cleared, so nothing is resumed",
    );
    assert.deepEqual(h.engine.store.getMeta("throttle-paused"), [4242], "the leader's wave is intact");
  } finally {
    await cleanup(h.dir);
  }
});

test("the leader resumes on ok, and only then", async () => {
  const h = await harness();
  try {
    h.engine.store.setMeta("throttle-paused", [4242]);
    await drive(h.engine, ["ok", "ok"], h.hooks);
    assert.ok(h.order.some(([k]) => k === "resume"), "clear pressure restores the paused");
    assert.equal(h.engine.store.getMeta("throttle-paused"), null, "pause cleared");
  } finally {
    await cleanup(h.dir);
  }
});

test("a follower at ok still does not resume the leader's pause", async () => {
  // Leadership gates machine actions even when the follower's own sample
  // says healthy. Only the elected process owns the pause-set lifecycle.
  const h = await harness({ follower: true });
  try {
    h.engine.store.setMeta("throttle-paused", [4242]);
    await drive(h.engine, ["ok", "ok"], h.hooks);
    assert.ok(!h.order.some(([k]) => k === "resume"), "the follower leaves it alone");
    assert.deepEqual(h.engine.store.getMeta("throttle-paused"), [4242]);
  } finally {
    await cleanup(h.dir);
  }
});

test("leader shutdown resumes its pause before releasing the lock", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    assert.ok(h.order.some(([k]) => k === "throttle"), "the leader paused a candidate");
    assert.ok(h.order.some(([k]) => k === "resume"), "shutdown cleanup resumed it");
    assert.equal(h.engine.store.getMeta("throttle-paused"), null);
  } finally {
    await cleanup(h.dir);
  }
});

test("warn engages throttle and steer but never relief or escalation", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["warn", "warn"], h.hooks);
    const kinds = h.order.map(([k]) => k);
    assert.deepEqual(kinds, ["throttle", "steer", "resume"], "warn is reversible and shutdown restores the pause");
    const actions = h.engine.events(10).map((e) => e.action);
    assert.ok(!actions.includes("relieved") && !actions.includes("escalated"), "no irreversible rung at warn");
    assert.equal(h.engine.store.getMeta("throttle-paused"), null, "leader exit restored its wave");
  } finally {
    await cleanup(h.dir);
  }
});

test("leader records the largest non-system consumer after its snapshot", async () => {
  const h = await harness();
  try {
    const big = { ...threadConsumer, id: "pid:7", label: "strata", kind: "other", bytes: 8 * 1024 ** 3, threadId: null, threadTitle: null };
    const sys = { ...threadConsumer, id: "pid:1", label: "kernel", kind: "system", bytes: 12 * 1024 ** 3, threadId: null };
    await drive(h.engine, ["critical", "critical"], h.hooks, [threadConsumer, big, sys]);
    const top = h.engine.store.getMeta("top-consumer");
    assert.equal(top.label, "strata");
    assert.equal(top.bytes, 8 * 1024 ** 3);
    assert.equal(top.threadId, null);
    assert.equal(top.threadTitle, null);
    assert.equal(top.fraction, 0.5);
    assert.equal(typeof top.atMs, "number");
  } finally {
    await cleanup(h.dir);
  }
});

test("a follower never writes the top consumer", async () => {
  const h = await harness({ follower: true });
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    assert.equal(h.engine.store.getMeta("top-consumer"), null);
  } finally {
    await cleanup(h.dir);
  }
});

test("status hook: text while pressured, once per change, cleared on return to ok", async () => {
  const calls = [];
  const h = await harness({ hooks: { setStatus: (text) => calls.push(text) } });
  try {
    const big = { ...threadConsumer, id: "pid:7", label: "strata", kind: "other", bytes: 8 * 1024 ** 3, threadId: null };
    // Seed what the leader will record itself so the text is stable across ticks.
    h.engine.store.setMeta("top-consumer", {
      label: "strata", kind: "other", bytes: big.bytes, threadId: null, fraction: 0.5, atMs: Date.now(),
    });
    await drive(h.engine, ["warn", "warn", "warn", "ok", "ok"], h.hooks, [big]);
    assert.deepEqual(calls, ["ballast: WARN 1.00 GB free · strata 8.00 GB", undefined]);
  } finally {
    await cleanup(h.dir);
  }
});

test("status hook stays silent while the machine is ok", async () => {
  const calls = [];
  const h = await harness({ hooks: { setStatus: (text) => calls.push(text) } });
  try {
    await drive(h.engine, ["ok", "ok", "ok"], h.hooks);
    assert.deepEqual(calls, []);
  } finally {
    await cleanup(h.dir);
  }
});

test("steer is delivered through sendSteer", async () => {
  const h = await harness();
  try {
    await drive(h.engine, ["critical", "critical"], h.hooks);
    assert.ok(h.order.some(([k]) => k === "steer"), "sendSteer received the message");
  } finally {
    await cleanup(h.dir);
  }
});

/**
 * Leadership handover. The follower starts holding a foreign lock; its first
 * sample frees the lock and rewrites the shared "last-level", as the old
 * leader would have, so the second iteration takes over.
 */
const takeover = async ({ local, shared, levels }) => {
  const h = await harness({ follower: true });
  h.engine.store.setMeta("last-level", local);
  const controller = new AbortController();
  let i = 0;
  h.engine.readPressure = async () => {
    if (i === 0) {
      h.engine.store.setMeta("last-level", shared);
      rmSync(lockPathFor(join(h.dir, "state.json")), { force: true });
    }
    if (i >= levels.length) controller.abort();
    return pressureOf(levels[Math.min(i++, levels.length - 1)]);
  };
  const snap = snapOf();
  h.engine.snapshot = async () => snap;
  h.engine.makePlan = async () => ({ plan: planOf([]), snap });
  await h.engine.runGuard(controller.signal, () => {}, h.hooks);
  return h;
};

const observedRows = (h) => h.engine.events(20).filter((e) => e.action === "observed");

test("takeover: a change the old leader already recorded is not recorded twice", async () => {
  const h = await takeover({ local: "ok", shared: "warn", levels: ["ok", "warn", "warn", "warn"] });
  try {
    assert.equal(observedRows(h).length, 0, "the shared record already says warn");
    assert.equal(h.engine.store.getMeta("last-level"), "warn");
  } finally {
    await cleanup(h.dir);
  }
});

test("takeover: a change the old leader never recorded is recorded once", async () => {
  const h = await takeover({ local: "warn", shared: "ok", levels: ["warn", "warn", "warn", "warn"] });
  try {
    const rows = observedRows(h);
    assert.equal(rows.length, 1, "the shared record said ok, so warn is news");
    assert.equal(h.engine.store.getMeta("last-level"), "warn");
  } finally {
    await cleanup(h.dir);
  }
});

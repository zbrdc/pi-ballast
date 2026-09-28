/**
 * The escalate rung.
 *
 * The last resort is a second agent: a headless pi spawned to work the relief
 * plan with the ballast tools. An agent whose only possible move is asking
 * the user a question is noise at 3am — so the rung refuses to fire when the
 * plan carries nothing actionable and no pi session is big enough to matter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, defaultConfig } from "../src/engine.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const pressure = {
  level: "critical",
  reason: "headroom 0.8 GB below 3 GB floor",
  signals: [],
  thresholds: DEFAULT_THRESHOLDS,
  sample: {
    atMs: Date.now(),
    headroomBytes: 0.8 * 1024 ** 3,
    usedBytes: 12 * 1024 ** 3,
    swapUsedBytes: 0,
    compressedBytes: 0,
    swapInRate: 0,
    swapOutRate: 0,
    compressionRatio: 1,
    kernelPressure: "warning",
  },
};

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

const piConsumer = (over = {}) => ({
  id: "pid:200",
  label: "pi session",
  detail: "pi",
  kind: "pi",
  bytes: 512 * 1024 ** 2,
  processCount: 1,
  rootPid: 200,
  parentPid: 1,
  pids: [200],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: null,
  threadTitle: null,
  port: null,
  ...over,
});

const planOf = (candidates) => ({ candidates });
const snapOf = (consumers = []) => ({ consumers, threads: [], rows: [], titles: new Map(), selfPids: new Set() });

const harness = async (over = {}) => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-escalate-"));
  const engine = new Engine(join(dir, "state.json"));
  const spawned = [];
  const hooks = {
    mode: "tui",
    cwd: "/home/dev/git/x",
    spawnEscalation: (prompt) => spawned.push(prompt),
    ...over.hooks,
  };
  const config = { ...defaultConfig(), escalate: true, ...(over.config ?? {}) };
  return {
    dir,
    engine,
    spawned,
    config,
    hooks,
    run: (plan, snap, level = "critical") => engine.escalateRung(config, level, plan, snap, pressure, hooks),
  };
};

const cleanup = async (dir) => rmSync(dir, { recursive: true, force: true });

test("an empty plan never wakes an agent", async () => {
  const h = await harness();
  try {
    h.run(planOf([]), snapOf([piConsumer()]));
    assert.equal(h.spawned.length, 0, "nothing actionable, no spawn");
    assert.equal(h.engine.store.getMeta("last-escalation"), null, "cooldown not started");
  } finally {
    await cleanup(h.dir);
  }
});

test("a protected-only plan with no large pi consumer is refused", async () => {
  const h = await harness();
  try {
    const plan = planOf([candidate({ risk: "protected", id: "protected:300" })]);
    h.run(plan, snapOf([piConsumer()])); // pi consumer is only 512 MB
    assert.equal(h.spawned.length, 0, "the agent would have nothing to do");
  } finally {
    await cleanup(h.dir);
  }
});

test("an actionable candidate spawns a headless pi with the tools", async () => {
  const h = await harness();
  try {
    h.run(planOf([candidate()]), snapOf());
    assert.equal(h.spawned.length, 1, "spawned");
    assert.match(h.spawned[0], /ballast_plan/, "prompt tells it to plan");
    assert.match(h.spawned[0], /ballast_relieve/, "prompt tells it the gate");
    assert.notEqual(h.engine.store.getMeta("last-escalation"), null, "cooldown starts");
    assert.equal(h.engine.events(1)[0].action, "escalated", "on the record");
  } finally {
    await cleanup(h.dir);
  }
});

test("a pi session holding over 1 GB justifies escalation on its own", async () => {
  const h = await harness();
  try {
    const plan = planOf([candidate({ risk: "protected", id: "protected:200" })]);
    h.run(plan, snapOf([piConsumer({ bytes: 2 * 1024 ** 3 })]));
    assert.equal(h.spawned.length, 1, "the agent can at least investigate the pi session");
  } finally {
    await cleanup(h.dir);
  }
});

test("cooldown holds for twenty minutes, then frees", async () => {
  const h = await harness();
  try {
    h.engine.store.setMeta("last-escalation", Date.now() - 19 * 60_000);
    h.run(planOf([candidate()]), snapOf());
    assert.equal(h.spawned.length, 0, "nineteen minutes in: still cooling down");

    h.engine.store.setMeta("last-escalation", Date.now() - 21 * 60_000);
    h.run(planOf([candidate()]), snapOf());
    assert.equal(h.spawned.length, 1, "twenty-one minutes later: fires");
  } finally {
    await cleanup(h.dir);
  }
});

test("escalate: false is configured out entirely", async () => {
  const h = await harness({ config: { escalate: false } });
  try {
    h.run(planOf([candidate()]), snapOf());
    assert.equal(h.spawned.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("warn never escalates — critical only", async () => {
  const h = await harness();
  try {
    h.run(planOf([candidate()]), snapOf(), "warn");
    assert.equal(h.spawned.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("no spawn hook, no crash", async () => {
  const h = await harness({ hooks: { spawnEscalation: undefined } });
  try {
    h.run(planOf([candidate()]), snapOf());
    assert.equal(h.spawned.length, 0);
    assert.equal(h.engine.store.getMeta("last-escalation"), null, "no cooldown burned");
  } finally {
    await cleanup(h.dir);
  }
});

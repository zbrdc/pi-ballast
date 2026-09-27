/**
 * The steer rung.
 *
 * One session tells another to give memory back before anyone takes it. The
 * guard asks the session standing in the project that holds the memory — no
 * one else talks. Every condition here is a "stays silent" guarantee.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, defaultConfig } from "../src/engine.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const PROJECT = "/home/dan/git/hold";

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

const threadConsumer = (over = {}) => ({
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
  ...over,
});

const snapOf = (threads) => ({
  pressure,
  rows: [],
  consumers: threads,
  threads,
  titles: new Map(),
  selfPids: new Set(),
});

/** Engine + recorded sends, with a tui session standing in PROJECT. */
const harness = async (over = {}) => {
  const dir = await mkdtempSync(join(tmpdir(), "ballast-steer-"));
  const engine = new Engine(join(dir, "state.json"));
  const sent = [];
  const hooks = {
    mode: "tui",
    cwd: PROJECT,
    sendUserMessage: (text) => sent.push(text),
    ...over.hooks,
  };
  return {
    dir,
    engine,
    sent,
    hooks,
    config: { ...defaultConfig(), ...(over.config ?? {}) },
    run: (level, snap, state = { steered: false }) =>
      engine.steerRung(over.config ?? defaultConfig(), level, snap, pressure, hooks, state),
  };
};

const cleanup = async (dir) => rmSync(dir, { recursive: true, force: true });

test("warn level, holding project, expired cooldown: the message goes", async () => {
  const h = await harness();
  try {
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 1, "one message");
    assert.match(h.sent[0], /hold/, "names the project");
    assert.match(h.sent[0], /512\.0 MB|512 MB/, "states what it holds");
    assert.notEqual(h.engine.store.getMeta("last-steer"), null, "cooldown starts");
    assert.equal(h.engine.events(1)[0].action, "steered", "on the record");
  } finally {
    await cleanup(h.dir);
  }
});

test("watch stays silent", async () => {
  const h = await harness();
  try {
    h.engine.steerRung(h.config, "watch", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("a session outside the holding project is never messaged", async () => {
  const h = await harness({ hooks: { cwd: "/home/dan/git/somewhere-else" } });
  try {
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0, "unrelated sessions keep quiet");
  } finally {
    await cleanup(h.dir);
  }
});

test("cooldown holds for ten minutes, then frees", async () => {
  const h = await harness();
  try {
    h.engine.store.setMeta("last-steer", Date.now() - 9 * 60_000);
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0, "nine minutes in: still cooling down");

    h.engine.store.setMeta("last-steer", Date.now() - 11 * 60_000);
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 1, "eleven minutes later: speaks again");
  } finally {
    await cleanup(h.dir);
  }
});

test("one message per guard invocation, however many samples it takes", async () => {
  const h = await harness();
  try {
    const state = { steered: false };
    const snap = snapOf([threadConsumer()]);
    h.engine.steerRung(h.config, "warn", snap, pressure, h.hooks, state);
    h.engine.store.setMeta("last-steer", 0); // pretend the cooldown lapsed
    h.engine.steerRung(h.config, "critical", snap, pressure, h.hooks, state);
    assert.equal(h.sent.length, 1, "the same invocation does not repeat itself");
  } finally {
    await cleanup(h.dir);
  }
});

test("headless sessions cannot steer", async () => {
  const h = await harness({ hooks: { mode: "rpc" } });
  try {
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("a small holder is not worth a message", async () => {
  const h = await harness();
  try {
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer({ bytes: 100 * 1024 ** 2 })]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("steer: false is configured out entirely", async () => {
  const h = await harness({ config: { ...defaultConfig(), steer: false } });
  try {
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("no messaging hook, no crash", async () => {
  const h = await harness({ hooks: { sendUserMessage: undefined } });
  try {
    h.engine.steerRung(h.config, "warn", snapOf([threadConsumer()]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

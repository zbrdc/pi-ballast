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

const PROJECT = "/home/dev/git/hold";

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
    assert.match(h.sent[0], /Memory pressure is warn \(headroom/, "keeps the lead sentence");
    assert.match(h.sent[0], /npm run dev|hold/, "names the item");
    assert.match(h.sent[0], /pid 100/, "names the root pid");
    assert.match(h.sent[0], /2\.00 GB|2 GB/, "states its size");
    assert.doesNotMatch(h.sent[0], /Playwright/, "no generic advice");
    assert.match(h.engine.events(1)[0].detail, /1 process .*to release/, "record names count and bytes");
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
  const h = await harness({ hooks: { cwd: "/home/dev/git/somewhere-else" } });
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

test("below the byte floor is not worth a message", async () => {
  const h = await harness();
  try {
    const snap = snapOf([threadConsumer({ bytes: 600 * 1024 ** 2 }), threadConsumer({ id: "pid:101", rootPid: 101, pids: [101], bytes: 300 * 1024 ** 2 })]);
    h.engine.steerRung(h.config, "warn", snap, pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
    assert.equal(h.engine.store.getMeta("last-steer"), null, "no cooldown claimed for silence");
  } finally {
    await cleanup(h.dir);
  }
});

test("a thread holding only pi itself is never messaged", async () => {
  const h = await harness();
  try {
    const pi = threadConsumer({ id: "pid:50", kind: "pi", label: "pi", rootPid: 50, pids: [50], bytes: 5 * 1024 ** 3 });
    h.engine.steerRung(h.config, "warn", snapOf([pi]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0, "agents, editors and browsers are not the session's to stop");
  } finally {
    await cleanup(h.dir);
  }
});

test("dev server and headless browser add up and are named, largest first", async () => {
  const h = await harness();
  try {
    const server = threadConsumer({ id: "pid:99", label: "vite", rootPid: 99, pids: [99], port: 5173, bytes: 600 * 1024 ** 2 });
    const browser = threadConsumer({ id: "pid:1234", label: "Headless browser", kind: "browser-automation", rootPid: 1234, pids: [1234], bytes: 1.2 * 1024 ** 3 });
    h.engine.steerRung(h.config, "warn", snapOf([server, browser]), pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /Headless browser \(pid 1234\) 1\.20 GB; vite on :5173 \(pid 99\) 600 MB/);
    assert.match(h.sent[0], /Stop the ones you no longer need, or run \/ballast\./);
    assert.match(h.engine.events(1)[0].detail, /2 processes/);
  } finally {
    await cleanup(h.dir);
  }
});

test("the guard's own process tree is excluded", async () => {
  const h = await harness();
  try {
    const own = threadConsumer({ id: "pid:7", rootPid: 7, pids: [7, 8], bytes: 3 * 1024 ** 3 });
    const snap = { ...snapOf([own]), selfPids: new Set([8]) };
    h.engine.steerRung(h.config, "warn", snap, pressure, h.hooks, { steered: false });
    assert.equal(h.sent.length, 0);
  } finally {
    await cleanup(h.dir);
  }
});

test("only five items are named", async () => {
  const h = await harness();
  try {
    const many = Array.from({ length: 7 }, (_, i) =>
      threadConsumer({ id: `pid:${200 + i}`, label: `srv${i}`, rootPid: 200 + i, pids: [200 + i], bytes: (300 + i) * 1024 ** 2 }));
    h.engine.steerRung(h.config, "warn", snapOf(many), pressure, h.hooks, { steered: false });
    assert.equal((h.sent[0].match(/pid /g) ?? []).length, 5);
    assert.match(h.engine.events(1)[0].detail, /7 processes/);
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

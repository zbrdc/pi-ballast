/**
 * Turning a process table into something a person can act on.
 *
 * Two regressions are pinned here, both of which shipped broken once already
 * and both of which are silent — no error, just a wrong number on screen:
 *
 *   1. Grouping that climbs too far rolled 88 unrelated processes into one
 *      5 GB row belonging to whichever thread it saw first.
 *   2. A group whose members disagree about their thread was captioned with
 *      whichever one happened to sort first.
 *
 * Both are invisible in a screenshot and ruinous in a plan.
 *
 * Every pid here is offset from 1. pid 1 is init, and both tree walks stop at
 * `pid <= 1`, so a fixture that uses 1 for a real process measures the wrong
 * thing entirely.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeByPiCwd, groupByThread, groupConsumers, totalsByKind } from "../src/lib/procs.ts";

const MB = 1024 ** 2;

const row = (over = {}) => ({
  pid: 10,
  ppid: 1,
  rssBytes: 100 * MB,
  ageSeconds: 3600,
  cpuPercent: 0,
  command: "node server.js",
  name: "node",
  user: "dan",
  kind: "dev-server",
  threadId: null,
  port: null,
  ...over,
});

const titles = new Map();

/* ------------------------------------------------------------------ */
/* groupConsumers                                                      */
/* ------------------------------------------------------------------ */

test("a process tree collapses into one row with the tree's bytes", () => {
  const rows = [
    row({ pid: 10, ppid: 1, rssBytes: 100 * MB, port: 3000 }),
    row({ pid: 11, ppid: 10, command: "node fork", rssBytes: 200 * MB }),
    row({ pid: 12, ppid: 10, command: "node worker", rssBytes: 50 * MB }),
  ];
  const consumers = groupConsumers(rows, titles);
  assert.equal(consumers.length, 1, "one dev server, not three processes");
  assert.deepEqual(consumers[0].pids, [10, 11, 12]);
  assert.equal(consumers[0].bytes, 350 * MB);
  assert.equal(consumers[0].processCount, 3);
  assert.equal(consumers[0].port, 3000);
  assert.match(consumers[0].label, /Dev server on :3000 \(3 processes\)/);
});

test("an unclassified child joins its classified parent, never the reverse", () => {
  const rows = [
    row({ pid: 10, rssBytes: 100 * MB, kind: "dev-server" }),
    row({ pid: 11, ppid: 10, rssBytes: 30 * MB, kind: "other", command: "sh", name: "sh" }),
  ];
  const consumers = groupConsumers(rows, titles);
  assert.equal(consumers.length, 1, "the shell folded into the server");
  assert.equal(consumers[0].kind, "dev-server");
});

test("pi and agent are hard stops — a session's work is never absorbed", () => {
  // Every process in the session descends from pi. Walking past it would fold
  // the whole fleet into one row and destroy the attribution this plugin is
  // for. The earlier version did exactly that and reported 5 GB as one item.
  const rows = [
    row({ pid: 10, ppid: 1, kind: "pi", name: "pi", rssBytes: 400 * MB, command: "pi -p 'go'" }),
    row({ pid: 11, ppid: 10, kind: "dev-server", rssBytes: 200 * MB }),
    row({ pid: 12, ppid: 11, kind: "test-runner", rssBytes: 100 * MB, name: "vitest" }),
  ];
  const consumers = groupConsumers(rows, titles);
  const pi = consumers.find((c) => c.pids.includes(10));
  const dev = consumers.find((c) => c.pids.includes(11));
  const runner = consumers.find((c) => c.pids.includes(12));
  assert.equal(pi.pids.length, 1, "pi is its own row");
  assert.equal(pi.bytes, 400 * MB);
  assert.deepEqual(dev.pids, [11], "the dev server did not absorb a classified child");
  assert.deepEqual(runner.pids, [12], "the runner stands on its own, under its own label");
  assert.equal(dev.kind, "dev-server");
});

test("a group below the reporting floor is not shown", () => {
  const rows = [row({ pid: 10, rssBytes: 4 * MB })];
  assert.equal(groupConsumers(rows, titles).length, 0, "4 MB is not news");
  assert.equal(groupConsumers(rows, titles, { minBytes: 1 }).length, 1, "unless asked for");
});

test("system rows are never consumers", () => {
  const rows = [row({ pid: 10, kind: "system", rssBytes: 900 * MB, name: "kernel_task" })];
  assert.equal(groupConsumers(rows, titles).length, 0);
});

test("a mixed tree is captioned with no thread rather than an arbitrary one", () => {
  // Members disagree and the root claims no thread of its own, so any single
  // answer would be a guess. The row says nothing instead.
  const rows = [
    row({ pid: 10, kind: "dev-server", rssBytes: 100 * MB, threadId: null }),
    row({ pid: 11, ppid: 10, kind: "dev-server", rssBytes: 100 * MB, threadId: "/home/dev/git/a" }),
    row({ pid: 12, ppid: 10, kind: "dev-server", rssBytes: 100 * MB, threadId: "/home/dev/git/b" }),
  ];
  const [group] = groupConsumers(rows, titles);
  assert.equal(group.threadId, null, "no thread, not the first one found");
  assert.equal(group.threadTitle, null);
});

test("a tree whose members agree carries that thread", () => {
  const rows = [
    row({ pid: 10, kind: "dev-server", rssBytes: 100 * MB, threadId: "/home/dev/git/hold" }),
    row({ pid: 11, ppid: 10, kind: "dev-server", rssBytes: 100 * MB, threadId: "/home/dev/git/hold" }),
  ];
  const [group] = groupConsumers(rows, titles, { minBytes: 1 });
  assert.equal(group.threadId, "/home/dev/git/hold");
});

test("a parent cycle does not hang the grouping", () => {
  const rows = [
    row({ pid: 10, ppid: 11, kind: "dev-server", rssBytes: 100 * MB }),
    row({ pid: 11, ppid: 10, kind: "dev-server", rssBytes: 100 * MB }),
  ];
  const consumers = groupConsumers(rows, titles);
  assert.ok(consumers.length >= 1, "terminated rather than looping forever");
});

test("rows come back heaviest first", () => {
  const rows = [
    row({ pid: 10, rssBytes: 50 * MB }),
    row({ pid: 11, rssBytes: 300 * MB }),
    row({ pid: 12, rssBytes: 100 * MB }),
  ];
  assert.deepEqual(
    groupConsumers(rows, titles).map((c) => c.bytes),
    [300 * MB, 100 * MB, 50 * MB],
  );
});

/* ------------------------------------------------------------------ */
/* groupByThread                                                       */
/* ------------------------------------------------------------------ */

const consumer = (over = {}) => ({
  id: "pid:10",
  label: "Dev server",
  detail: "node server.js",
  kind: "dev-server",
  bytes: 100 * MB,
  processCount: 1,
  rootPid: 10,
  parentPid: 1,
  pids: [10],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: null,
  threadTitle: null,
  port: null,
  ...over,
});

test("a project's processes sum into one row named for the project", () => {
  // This is the view that makes an intervention actionable: "node holds 3 GB"
  // is useless, "hold holds 3 GB across 2 processes" names a session.
  const rows = [
    consumer({ id: "pid:10", bytes: 2 * 1024 ** 3, pids: [10], rootPid: 10, threadId: "/home/dev/git/hold" }),
    consumer({ id: "pid:11", bytes: 1024 ** 3, pids: [11], rootPid: 11, threadId: "/home/dev/git/hold" }),
    consumer({ id: "pid:12", bytes: 10 * MB, pids: [12], rootPid: 12, threadId: "/home/dev/git/other" }),
  ];
  const grouped = groupByThread(rows, new Map([["/home/dev/git/hold", "hold"]]));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].label, "hold", "the title, not the raw path");
  assert.equal(grouped[0].bytes, 3 * 1024 ** 3);
  assert.deepEqual(grouped[0].pids, [10, 11]);
  assert.equal(grouped[0].processCount, 2);
  assert.match(grouped[0].detail, /Dev server/);
});

test("an unattributed process is dropped, not filed under nowhere", () => {
  assert.equal(groupByThread([consumer({ threadId: null })], titles).length, 0);
});

test("an unknown thread falls back to its path rather than blank", () => {
  const [group] = groupByThread([consumer({ threadId: "/home/dev/git/mystery" })], titles);
  assert.equal(group.label, "/home/dev/git/mystery");
  assert.equal(group.threadTitle, "/home/dev/git/mystery");
});

test("the oldest process decides the row's age and any port is kept", () => {
  const [group] = groupByThread(
    [
      consumer({ id: "pid:10", pids: [10], rootPid: 10, ageSeconds: 100, port: null }),
      consumer({ id: "pid:11", pids: [11], rootPid: 11, ageSeconds: 9000, port: 8080 }),
    ].map((c) => ({ ...c, threadId: "/p" })),
    titles,
  );
  assert.equal(group.ageSeconds, 9000);
  assert.equal(group.port, 8080);
});

/* ------------------------------------------------------------------ */
/* totalsByKind                                                        */
/* ------------------------------------------------------------------ */

test("totals sum bytes and process counts per kind, heaviest first", () => {
  const totals = totalsByKind([
    consumer({ kind: "dev-server", bytes: 100 * MB, processCount: 1 }),
    consumer({ kind: "dev-server", bytes: 200 * MB, processCount: 3 }),
    consumer({ kind: "browser-automation", bytes: 900 * MB, processCount: 5 }),
  ]);
  assert.equal(totals.length, 2);
  assert.deepEqual(totals[0], { kind: "browser-automation", bytes: 900 * MB, count: 5 });
  assert.deepEqual(totals[1], { kind: "dev-server", bytes: 300 * MB, count: 4 });
});

/* ------------------------------------------------------------------ */
/* attributeByPiCwd                                                    */
/* ------------------------------------------------------------------ */

test("a child inherits its project from the pi process it descends from", () => {
  // BB matched argv against worktree paths. pi's sessions do not carry the
  // project in argv — their children inherit a cwd — so attribution walks
  // ancestors instead.
  const rows = [
    row({ pid: 10, kind: "pi", name: "pi", ppid: 1, rssBytes: 100 * MB }),
    row({ pid: 11, ppid: 10, kind: "dev-server", rssBytes: 100 * MB }),
    row({ pid: 12, ppid: 11, kind: "dev-server", rssBytes: 100 * MB, command: "node worker" }),
  ];
  const attributed = attributeByPiCwd(rows, new Map([[10, "/home/dev/git/hold"]]));
  assert.deepEqual(
    attributed.map((r) => r.threadId),
    ["/home/dev/git/hold", "/home/dev/git/hold", "/home/dev/git/hold"],
  );
});

test("a process with no pi ancestor stays unattributed", () => {
  const rows = [row({ pid: 10, ppid: 1, kind: "dev-server" })];
  assert.equal(attributeByPiCwd(rows, new Map([[999, "/x"]]))[0].threadId, null);
});

test("an already-attributed row is not overwritten", () => {
  const rows = [
    row({ pid: 10, kind: "pi", name: "pi", ppid: 1, threadId: null }),
    row({ pid: 11, ppid: 10, kind: "dev-server", threadId: "/already/known" }),
  ];
  const attributed = attributeByPiCwd(rows, new Map([[10, "/home/dev/git/hold"]]));
  assert.equal(attributed[1].threadId, "/already/known");
});

test("no known cwds leaves the table untouched", () => {
  const rows = [row({ pid: 10 })];
  assert.deepEqual(attributeByPiCwd(rows, new Map()), rows);
});

test("a pi process with an unknown cwd attributes nothing beneath it", () => {
  // Degrading to unattributed is the honest answer; guessing a neighbouring
  // session's project would blame the wrong one for the memory.
  const rows = [
    row({ pid: 10, kind: "pi", name: "pi", ppid: 1 }),
    row({ pid: 11, ppid: 10, kind: "dev-server" }),
  ];
  assert.equal(attributeByPiCwd(rows, new Map([[10, ""]]))[1].threadId, null);
});

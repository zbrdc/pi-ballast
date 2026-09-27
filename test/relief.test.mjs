/**
 * Acting on a plan.
 *
 * authorize() decides what may be stopped; these tests cover what happens
 * after that decision — the re-derivation against the live table, the
 * refusals, and the one path that really signals a process. Most run dry,
 * because dry still exercises the part that matters: the plan's pid list is a
 * claim to be re-checked, never an instruction to be obeyed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { applyRelief } from "../src/lib/relieve.ts";

const config = {
  protectedPorts: new Set([3000]),
  exemptPatterns: ["do-not-touch"],
  idleSeconds: 600,
  protectedThreadIds: new Set(),
};

const row = (over = {}) => ({
  pid: 100,
  ppid: 1,
  rssBytes: 1024 ** 3,
  ageSeconds: 3600,
  cpuPercent: 0,
  command: "chrome-headless-shell --headless",
  name: "chrome-headless-shell",
  user: "dan",
  kind: "browser-automation",
  threadId: null,
  port: null,
  ...over,
});

const candidate = (over = {}) => ({
  id: "kill:100:browser-automation",
  action: "terminate",
  risk: "safe",
  label: "Headless browser",
  rationale: "orphaned and idle",
  bytes: 1024 ** 3,
  pids: [100],
  kind: "browser-automation",
  threadId: null,
  refusal: null,
  ...over,
});

/** As groupConsumers builds it: detail is the root's command. */
const consumer = (over = {}) => ({
  id: "pid:100",
  label: "Headless browser",
  detail: "chrome-headless-shell --headless",
  kind: "browser-automation",
  bytes: 1024 ** 3,
  processCount: 1,
  rootPid: 100,
  parentPid: 1,
  pids: [100],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: null,
  threadTitle: null,
  port: null,
  ...over,
});

/** A dry run, which still re-derives and re-authorizes but signals nothing. */
const dry = (candidates, over = {}) =>
  applyRelief({
    candidates,
    rows: [row()],
    consumers: [],
    config,
    selfPids: new Set(),
    dryRun: true,
    log: () => {},
    steer: async () => {},
    ...over,
  });

test("a dry run reports what it would stop without stopping it", async () => {
  const result = await dry([candidate()]);
  assert.equal(result.dryRun, true);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.bytesFreed, 1024 ** 3, "the panel leads with this number");
  assert.match(result.items[0].detail, /would stop 1 processes/);
});

test("a root pid that is gone is already-done, not a failure", async () => {
  const result = await dry([candidate()], { rows: [] });
  assert.equal(result.items[0].ok, true, "nothing to do is not an error");
  assert.equal(result.items[0].detail, "already gone");
  assert.equal(result.bytesFreed, 0, "freed nothing, so claim nothing");
});

test("a recycled pid whose command changed is not stopped", async () => {
  // The root pid now hosts something else entirely. This is what PID reuse
  // looks like, and obeying the stale plan here is how you kill the user's
  // editor because it happened to get the pid a browser used to have.
  //
  // The comparison needs the planned consumer, exactly as runRelief passes it:
  // the live command must still be the prefix of what was planned.
  const result = await dry([candidate()], {
    rows: [row({ command: "nvim README.md", name: "nvim" })],
    consumers: [consumer({ detail: "chrome-headless-shell --headless" })],
  });
  assert.equal(result.items[0].bytes, 0, "no bytes claimed, because nothing was freed");
  assert.equal(result.items[0].ok, true, "declining to act is a success, not an error");
  assert.equal(result.items[0].detail, "already gone");
  assert.equal(result.bytesFreed, 0);
});

test("a pid whose kind changed is dropped even with a planned consumer", async () => {
  const result = await dry([candidate()], {
    rows: [row({ kind: "editor", name: "nvim" })],
    consumers: [consumer({ detail: "chrome-headless-shell --headless" })],
  });
  assert.equal(result.items[0].detail, "already gone");
});

test("a pid from a different kind is dropped even when the root is intact", async () => {
  const result = await dry([candidate({ pids: [100, 101] })], {
    rows: [row(), row({ pid: 101, kind: "editor" })],
  });
  assert.match(result.items[0].detail, /would stop 1 processes/, "the editor child is not signalled");
});

test("a candidate that no longer passes the gate is refused at act time", async () => {
  // Authorized when planned, but by act time the port became protected.
  const result = await dry([candidate({ pids: [100] })], {
    rows: [row({ port: 3000 })],
  });
  assert.equal(result.items[0].ok, false);
  assert.match(result.items[0].detail, /refused/);
});

test("an action other than terminate is reported, never applied", async () => {
  const result = await dry([candidate({ action: "steer", threadId: null })]);
  assert.equal(result.items[0].ok, false);
  assert.match(result.items[0].detail, /no thread to steer/);
});

test("a steer candidate with no thread cannot be steered", async () => {
  const result = await dry([candidate({ action: "steer", threadId: null })]);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
});

test("a steer candidate reaches its thread and reports success", async () => {
  const sent = [];
  const result = await dry([candidate({ action: "steer", threadId: "/home/dan/git/hold" })], {
    dryRun: false,
    steer: async (threadId, message) => {
      sent.push([threadId, message]);
    },
  });
  assert.equal(result.items[0].detail, "steered");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "/home/dan/git/hold");
  assert.match(sent[0][1], /under memory pressure/);
  assert.match(sent[0][1], /Do not stop work/, "it asks, it does not order");
});

test("a steer that throws is recorded as a failure, not swallowed", async () => {
  const result = await dry([candidate({ action: "steer", threadId: "/x" })], {
    dryRun: false,
    steer: async () => {
      throw new Error("thread is gone");
    },
  });
  assert.equal(result.items[0].ok, false);
  assert.match(result.items[0].detail, /thread is gone/);
  assert.equal(result.failed, 1);
});

test("a dry run says what a steer would do without sending it", async () => {
  let called = 0;
  const result = await dry([candidate({ action: "steer", threadId: "/x" })], {
    steer: async () => {
      called += 1;
    },
  });
  assert.equal(called, 0);
  assert.match(result.items[0].detail, /would steer/);
});

/**
 * The only test here that signals a real process, and the only one that waits.
 *
 * stopTree gives a signalled process five seconds to exit before insisting, so
 * this costs five seconds of wall clock. It earns them: this is the only code
 * in the repository whose failure mode is a user's process dying wrongly, and
 * every other test here fakes the signal.
 */
test("a real process tree is actually stopped", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));

  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  try {
    assert.equal(gone(child.pid), false, "sanity: it is running");
    const result = await applyRelief({
      candidates: [candidate({ pids: [child.pid] })],
      rows: [row({ pid: child.pid })],
      consumers: [],
      config,
      selfPids: new Set(),
      dryRun: false,
      log: () => {},
      steer: async () => {},
    });

    assert.equal(result.succeeded, 1, result.items[0]?.detail);
    assert.match(result.items[0].detail, /stopped 1 processes/);
    await exited;
    assert.equal(gone(child.pid), true, "and it is actually gone");
  } finally {
    if (!gone(child.pid)) child.kill("SIGKILL");
  }
});

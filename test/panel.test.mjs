/**
 * The panel is the port's answer to the web dashboard, so what it says about
 * the rungs is the user's only view of them. These tests hold the contract:
 * the header names every rung's configured state, and a held pause is never
 * invisible.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BallastPanel } from "../src/panel.ts";
import { defaultConfig } from "../src/engine.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

/** A project directory, so attribution has something to attribute to. */
const PROJECT = "/home/dan/git/hold";

const pressure = {
  level: "warn",
  reason: "test",
  signals: [],
  thresholds: DEFAULT_THRESHOLDS,
  sample: {
    atMs: Date.now(),
    totalBytes: 16 * 1024 ** 3,
    usedBytes: 8 * 1024 ** 3,
    headroomBytes: 4 * 1024 ** 3,
    swapUsedBytes: 0,
    swapTotalBytes: 0,
    swapInRate: 0,
    swapOutRate: 0,
    compressionRatio: 1,
  },
};

const stateOf = (over = {}) => ({
  pressure,
  consumers: [],
  threads: [],
  plan: null,
  events: [],
  config: defaultConfig(),
  pausedPids: [],
  ...over,
});

const candidate = (over = {}) => ({
  id: "kill:100:browser-automation",
  action: "terminate",
  risk: "safe",
  label: "Headless browser",
  rationale: "orphaned, no session owns it",
  bytes: 1024 ** 3,
  pids: [100],
  kind: "browser-automation",
  threadId: null,
  refusal: null,
  ...over,
});

const consumer = (over = {}) => ({
  id: "pid:100",
  label: "npm run dev",
  detail: "node",
  kind: "dev-server",
  bytes: 2 * 1024 ** 3,
  processCount: 3,
  rootPid: 100,
  parentPid: 1,
  pids: [100, 101, 102],
  ageSeconds: 900,
  cpuPercent: 12,
  threadId: PROJECT,
  threadTitle: "hold",
  port: 3000,
  ...over,
});

const planOf = (candidates) => ({
  builtAtMs: Date.now(),
  candidates,
  safeBytes: candidates.filter((c) => c.risk === "safe").reduce((s, c) => s + c.bytes, 0),
  disruptiveBytes: candidates
    .filter((c) => c.risk === "disruptive")
    .reduce((s, c) => s + c.bytes, 0),
});

const mount = (state) => {
  let closed = null;
  const tui = { requestRender: () => {} };
  const theme = { fg: (_c, text) => text, bold: (text) => text };
  const panel = new BallastPanel(tui, theme, state, () => state, (result) => {
    closed = result;
  });
  const lines = panel.render(100);
  panel.handleInput("\x1b"); // escape closes and clears the refresh timer
  return { lines, closed, panel };
};

const text = (lines) => lines.join("\n");

test("the header names every rung's configured state", () => {
  const { lines, closed } = mount(stateOf({ config: { ...defaultConfig(), throttle: "safe", steer: true } }));
  const header = lines[0];
  assert.match(header, /relieve off/, "relieve state shown");
  assert.match(header, /throttle safe/, "throttle state shown");
  assert.match(header, /steer on/, "steer state shown");
  assert.equal(closed, null, "escape during render test closes later — sanity only");
});

test("a held pause is visible, with its resume promise", () => {
  const { lines } = mount(stateOf({ pausedPids: [100, 200] }));
  const paused = lines.find((line) => line.includes("paused by throttle"));
  assert.ok(paused, "the pause has a line");
  assert.match(paused, /2 processes/, "count shown");
  assert.match(paused, /resumes when pressure clears/, "the promise is stated");
});

test("no pause, no line", () => {
  const { lines } = mount(stateOf({ pausedPids: [] }));
  assert.ok(!lines.some((line) => line.includes("paused by throttle")));
});

/**
 * The states a user will actually land in.
 *
 * The panel replaced a web dashboard, so it is the only place a session
 * learns whether a rung is armed, what the machine holds, and what the plan
 * would kill. Every branch here is a state the guard can produce, and a
 * silent one is indistinguishable from a broken feature.
 */

test("an empty machine says so instead of showing a blank table", () => {
  const { lines } = mount(stateOf());
  assert.match(text(lines), /nothing above the reporting floor/, "consumers admit emptiness");
  assert.match(text(lines), /nothing to do — no disposable processes/, "the plan admits it too");
  assert.ok(!text(lines).includes("By project"), "no projects, no heading");
  assert.ok(!text(lines).includes("Activity"), "no events, no heading");
});

test("consumers and projects are both reported, with the project named", () => {
  const { lines } = mount(
    stateOf({ consumers: [consumer()], threads: [consumer()] }),
  );
  const all = text(lines);
  assert.match(all, /Top consumers/, "by process");
  assert.match(all, /2\.00 GB/, "sized");
  assert.match(all, /npm run dev/, "named");
  assert.match(all, /By project/, "by project");
  assert.match(all, /3 processes/, "grouped by the project, not the pid");
});

test("an unattributed process is shown without inventing a project", () => {
  const { lines } = mount(
    stateOf({
      consumers: [consumer({ threadId: null, threadTitle: null })],
      threads: [consumer({ threadId: null, threadTitle: null })],
    }),
  );
  assert.match(text(lines), /unattributed/, "named for what it is, not where it is");
});

test("swap is only reported when there is any", () => {
  const quiet = mount(stateOf());
  assert.ok(!text(quiet.lines).includes("swap"), "no swap, no line");

  const swapped = mount(
    stateOf({
      pressure: {
        ...pressure,
        sample: { ...pressure.sample, swapUsedBytes: 4 * 1024 ** 3, swapTotalBytes: 8 * 1024 ** 3 },
      },
    }),
  );
  assert.match(text(swapped.lines), /4\.00 GB of 8\.00 GB/, "used of total");
});

test("the plan totals separate safe from disruptive, and says which is which", () => {
  const { lines } = mount(
    stateOf({
      plan: planOf([
        candidate(),
        candidate({ id: "kill:200:dev", label: "Dev server", risk: "disruptive", bytes: 512 * 1024 ** 2 }),
      ]),
    }),
  );
  const all = text(lines);
  assert.match(all, /1\.00 GB safe, 512 MB disruptive/, "both buckets totalled");
  assert.match(all, /Headless browser/);
  assert.match(all, /Dev server/);
});

test("a protected candidate is never offered as something to stop", () => {
  const { lines, panel } = mount(
    stateOf({
      plan: planOf([
        candidate({ id: "kill:300:db", label: "Postgres", risk: "protected", refusal: "port 5432" }),
      ]),
    }),
  );
  assert.match(text(lines), /nothing to do/, "nothing it may act on");
  panel.handleInput("k"); // a stop request with nothing selected is not a crash
  assert.ok(true);
});

test("the selected candidate shows its rationale, and only it does", () => {
  const { lines, panel } = mount(
    stateOf({
      plan: planOf([
        candidate(),
        candidate({ id: "kill:200:dev", label: "Dev server", risk: "disruptive", rationale: "its port answers requests" }),
      ]),
    }),
  );
  assert.match(text(lines), /orphaned, no session owns it/, "the reason is shown, not just the name");
  panel.handleInput("\x1b[B"); // down
  const after = text(panel.render(100));
  assert.ok(after.includes("Dev server"), "both are listed");
  assert.ok(after.includes("its port answers requests"), "the new selection explains itself");
  assert.ok(
    !after.includes("orphaned, no session owns it"),
    "the rationale followed the selection",
  );
});

test("activity is timestamped and names what happened", () => {
  const { lines } = mount(
    stateOf({
      events: [
        { atMs: Date.now(), level: "critical", action: "relieved", detail: "2 stopped, 0 refused", bytesFreed: 1024 ** 3, threadId: null },
        { atMs: Date.now(), level: "warn", action: "steered", detail: "asked hold to release", bytesFreed: 0, threadId: null },
      ],
    }),
  );
  const all = text(lines);
  assert.match(all, /Activity/);
  assert.match(all, /relieved/);
  assert.match(all, /asked hold to release/);
});

test("the footer always offers the keys and reports the sample's age", () => {
  const { lines } = mount(stateOf());
  const all = text(lines);
  assert.match(all, /r refresh · k stop selected · s auto-relieve · q close/);
  assert.match(all, /sampled .* ago/, "how old the numbers are");
});

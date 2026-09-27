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

const mount = (state) => {
  let closed = null;
  const tui = { requestRender: () => {} };
  const theme = { fg: (_c, text) => text, bold: (text) => text };
  const panel = new BallastPanel(tui, theme, state, () => state, (result) => {
    closed = result;
  });
  const lines = panel.render(100);
  panel.handleInput("\x1b"); // escape closes and clears the refresh timer
  return { lines, closed };
};

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

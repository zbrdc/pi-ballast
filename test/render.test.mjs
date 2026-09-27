/**
 * The text every surface shows: the TUI panel, the four agent tools, and the
 * headless escalation child all read these lines. A wrong number here is a
 * wrong number everywhere, and the reason a plan looks like it frees memory it
 * never will.
 *
 * These assert claims — which figures appear, which detail is withheld, which
 * candidates are hidden — rather than column widths. Padding is a layout
 * decision that may legitimately change; a plan that overstates its recovery
 * may not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConsumers, renderPlan, renderPressure } from "../src/render.ts";
import { DEFAULT_THRESHOLDS } from "../src/lib/pressure.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const pressure = (over = {}, sample = {}) => ({
  level: "warn",
  reason: "headroom below 3 GB",
  signals: [],
  thresholds: DEFAULT_THRESHOLDS,
  sample: {
    atMs: Date.now(),
    totalBytes: 16 * GB,
    usedBytes: 8 * GB,
    freeBytes: 2 * GB,
    appBytes: 6 * GB,
    wiredBytes: 1 * GB,
    compressedBytes: 1 * GB,
    cachedFileBytes: 3 * GB,
    purgeableBytes: 512 * MB,
    headroomBytes: 4 * GB,
    swapTotalBytes: 8 * GB,
    swapUsedBytes: 0,
    swapInRate: 0,
    swapOutRate: 0,
    compressionRatio: 1,
    kernelPressure: "warn",
    ...sample,
  },
  ...over,
});

const consumer = (over = {}) => ({
  id: "pid:10",
  label: "Dev server on :3000 (3 processes)",
  detail: "node server.js",
  kind: "dev-server",
  bytes: 3 * GB,
  processCount: 3,
  rootPid: 10,
  parentPid: 1,
  pids: [10, 11, 12],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: "/home/dan/git/hold",
  threadTitle: "hold",
  port: 3000,
  ...over,
});

const candidate = (over = {}) => ({
  id: "kill:100:browser-automation",
  action: "terminate",
  risk: "safe",
  label: "Headless browser",
  rationale: "orphaned, no listener, no owner",
  bytes: 2 * GB,
  pids: [100],
  kind: "browser-automation",
  threadId: null,
  refusal: null,
  ...over,
});

const plan = (candidates) => ({
  builtAtMs: Date.now(),
  candidates,
  safeBytes: candidates.filter((c) => c.risk === "safe").reduce((n, c) => n + c.bytes, 0),
  disruptiveBytes: candidates.filter((c) => c.risk === "disruptive").reduce((n, c) => n + c.bytes, 0),
});

/* ------------------------------------------------------------------ */
/* renderPressure                                                      */
/* ------------------------------------------------------------------ */

test("the pressure block leads with the level and its plain-language cause", () => {
  const [head] = renderPressure(pressure()).split("\n");
  assert.match(head, /^Memory pressure: WARN — headroom below 3 GB$/);
});

test("used is reported with its share of the machine, and broken into its parts", () => {
  // app + wired + compressed is Activity Monitor's "Memory Used". If the
  // components stop summing to the total on screen, one of them is lying.
  const text = renderPressure(pressure());
  assert.match(text, /Used\s+8\.00 GB\s+\(50\.0%\)/, "total and its share");
  assert.match(text, /app\s+6\.00 GB/);
  assert.match(text, /wired\s+1\.00 GB/);
  assert.match(text, /compressed\s+1\.00 GB/);
  assert.equal(6 + 1 + 1, 8, "the parts must add up to the total shown");
});

test("headroom is labelled as what it is, not just printed as a number", () => {
  const text = renderPressure(pressure());
  assert.match(text, /Headroom\s+4\.00 GB/);
  assert.match(text, /before the machine has to page/);
});

test("the compression ratio appears only when the compressor is working", () => {
  assert.ok(!renderPressure(pressure()).match(/\dx\)/), "ratio 1 is not worth a column");
  assert.match(renderPressure(pressure({}, { compressionRatio: 2.4 })), /compressed\s+1\.00 GB\s+\(2\.4x\)/);
});

test("paging in is reported only when there is paging to report", () => {
  assert.ok(!renderPressure(pressure()).includes("paging in"), "idle machines have no rate to show");
  const thrashing = renderPressure(pressure({}, { swapUsedBytes: 2 * GB, swapInRate: 40 * MB }));
  assert.match(thrashing, /Swap\s+2\.00 GB of 8\.00 GB/);
  assert.match(thrashing, /paging in 40\.0 MB\/s/);
});

test("one signal is not repeated — the reason already says it", () => {
  // One signal is the same sentence as the reason, and the header is what
  // people read when the panel is red.
  const one = pressure({ signals: [{ level: "warn", detail: "52.0% of 16 GB in use" }] });
  assert.ok(!renderPressure(one).includes("Signals:"));
});

test("several signals are listed, worst first, with their levels", () => {
  // The reason names the top signal only. Below it lie the other reasons the
  // machine is unhappy, and they change what a person should do.
  const text = renderPressure(
    pressure({
      signals: [
        { level: "critical", detail: "headroom 0.4 GB" },
        { level: "warn", detail: "52.0% of 16 GB in use" },
      ],
    }),
  );
  const lines = text.split("\n");
  assert.ok(lines.some((l) => /Signals:/.test(l)));
  assert.ok(
    lines.some((l) => /critical\s+headroom 0\.4 GB/.test(l)),
    "the critical signal is named",
  );
  assert.ok(lines.some((l) => /warn\s+52\.0% of 16 GB in use/.test(l)), "and the warn signal too");
});

/* ------------------------------------------------------------------ */
/* renderConsumers                                                     */
/* ------------------------------------------------------------------ */

test("an empty list says so instead of printing a bare heading", () => {
  assert.equal(renderConsumers("Consumers", []), "Consumers: nothing above the reporting floor.");
});

test("a consumer row carries its size, label, pid, and project", () => {
  const [head, line] = renderConsumers("Consumers", [consumer()]).split("\n");
  assert.equal(head, "Consumers:");
  assert.match(line, /3\.00 GB/);
  assert.match(line, /Dev server on :3000 \(3 processes\)/);
  assert.match(line, /pid 10\b/);
  assert.match(line, /\[hold\]/, "named for the project, not the raw path");
});

test("an unattributed process shows no project rather than an empty bracket", () => {
  const [, line] = renderConsumers("Consumers", [consumer({ threadTitle: null, threadId: null })]).split("\n");
  assert.ok(!line.includes("["), `no dangling bracket: ${line}`);
  assert.match(line, /pid 10\b/);
});

test("a long project name is truncated and the row stays one line", () => {
  const long = "/home/dan/git/some/deeply/nested/project/that/never/ends";
  const lines = renderConsumers("Projects", [consumer({ threadTitle: long })]).split("\n");
  assert.equal(lines.length, 2, "a wrapped row would need a second line");
  assert.ok(lines[1].includes("…"), "ellipsized, not printed whole");
});

test("the list is capped so a hundred processes cannot flood the panel", () => {
  const many = Array.from({ length: 40 }, (_, i) => consumer({ id: `pid:${i}`, bytes: (40 - i) * MB }));
  assert.equal(renderConsumers("Consumers", many).split("\n").length, 16, "15 rows plus the heading");
  assert.equal(renderConsumers("Consumers", many, 3).split("\n").length, 4);
});

/* ------------------------------------------------------------------ */
/* renderPlan                                                          */
/* ------------------------------------------------------------------ */

test("a plan of nothing but protected candidates says nothing is worth stopping", () => {
  const refused = candidate({ risk: "protected", refusal: "port 3000 is protected" });
  assert.equal(
    renderPlan(plan([refused])),
    "Relief plan: nothing to do — no disposable processes worth stopping.",
  );
});

test("the header separates what is safe from what costs the user something", () => {
  const text = renderPlan(
    plan([
      candidate({ bytes: 2 * GB }),
      candidate({ id: "kill:200:dev-server", risk: "disruptive", bytes: 4 * GB }),
    ]),
  );
  assert.match(text, /2\.00 GB from safe candidates/);
  assert.match(text, /4\.00 GB more if you accept disruption/);
});

test("a protected candidate is hidden by default and shown on request", () => {
  // A refusal is a fact worth recording but not a suggestion. Printing it in
  // the default view invites an agent to act on a row the gate already denied.
  const p = plan([
    candidate({ id: "kill:100:browser-automation" }),
    candidate({ id: "kill:200:dev-server", risk: "protected", refusal: "port 3000 is protected" }),
  ]);
  assert.ok(renderPlan(p).includes("kill:100:browser-automation"), "the actionable one is listed");
  assert.ok(!renderPlan(p).includes("kill:200"), "a refusal is not a candidate");
  assert.ok(renderPlan(p, { verbose: true }).includes("kill:200"), "visible when asked for");
});

test("each candidate states its size and its one-line justification", () => {
  const text = renderPlan(plan([candidate()]));
  assert.match(text, /2\.00 GB\s+safe\s+kill:100:browser-automation/);
  assert.match(text, /Headless browser — orphaned, no listener, no owner/);
});

test("a non-terminate action shows no size, because it frees nothing", () => {
  // Steer returns no bytes. Printing a nominal figure would overstate what the
  // plan recovers, and that total is the number an agent acts on.
  const text = renderPlan(plan([candidate({ action: "steer", risk: "disruptive", bytes: 0 })]));
  assert.match(text, /disruptive\s+kill:100:browser-automation/, "still listed");
  assert.ok(!/[\d.]+\s*[KMG]?B\s+disruptive/.test(text), `no byte figure beside a steer: ${text}`);
});

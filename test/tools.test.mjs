/**
 * The tool bodies: the four calls an agent actually makes.
 *
 * The wiring tests in wiring.test.mjs prove *which* tools get registered and
 * *when*. These prove that pressing one produces a sensible answer — a claim
 * an agent will act on, so a formatting slip here is a wrong action later.
 *
 * Two safety rails, both load-bearing:
 *
 *   BALLAST_CHILD must be set before the import, because isWorker is read once
 *   at factory time. Set later, the real guard loop starts and the suite
 *   hangs for three minutes.
 *
 *   PI_CODING_AGENT_DIR must point at a temp dir, because STATE_PATH is
 *   resolved from getAgentDir() at module load. Without it these tests would
 *   read and write the user's real ~/.pi/agent/ballast-state.db.
 *
 * ballast_relieve is the one that can kill something, so it is only ever
 * given ids that resolve to nothing. A real candidate id here would stop a
 * real process; that path is covered in relief.test.mjs against fixtures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "ballast-tools-"));
process.env.BALLAST_CHILD = "1";
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: ballast } = await import("../src/index.ts");

/** Captures whole tool definitions, so execute() can actually be called. */
const makePi = () => {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    registerTool: (definition) => tools.set(definition.name, definition),
    getAllTools: () => [],
    registerCommand: () => {},
    sendMessage: () => {},
    on: (event, handler) => handlers.set(event, handler),
  };
};

/** A session_start through the mock, so the lazy claim() path runs for real. */
function register() {
  const mock = makePi();
  ballast(mock);
  mock.handlers.get("session_start")({ type: "session_start", reason: "startup" }, { mode: "tui", cwd: "/tmp" });
  return mock.tools;
}

const tools = register();
const textOf = (result) => result.content.map((part) => part.text).join("\n");

test("all four tools are callable once the session starts", () => {
  assert.deepEqual(
    [...tools.keys()].sort(),
    ["ballast_consumers", "ballast_plan", "ballast_relieve", "ballast_status"],
  );
});

test("every tool declares a name, a label, and an object parameter schema", () => {
  // pi's registerTool throws on a non-object schema, and the model cannot plan
  // a call it cannot see the shape of.
  for (const [name, tool] of tools) {
    assert.equal(tool.name, name);
    assert.ok(tool.label.length > 0, `${name} has a label`);
    assert.equal(typeof tool.parameters, "object", `${name} has a parameter schema`);
    assert.equal(Array.isArray(tool.parameters), false, `${name}'s schema is an object`);
    assert.ok(tool.description.length > 20, `${name} explains itself`);
    assert.equal(typeof tool.execute, "function", `${name} is executable`);
  }
});

test("ballast_status reports a real level and a real reading", async () => {
  const result = await tools.get("ballast_status").execute("call-1", {});
  const text = textOf(result);
  assert.match(text, /^Memory pressure: (OK|WATCH|WARN|CRITICAL) — /, "leads with the level and a reason");
  assert.match(text, /Headroom/, "and the number the machine is judged on");
  assert.ok(["ok", "watch", "warn", "critical"].includes(result.details.level), "level is machine-readable");
  assert.equal(typeof result.details.reason, "string");
  assert.ok(result.details.reason.length > 0, "a level without a reason is a mystery");
});

test("ballast_status is the same answer twice in a row", async () => {
  // The 4s cache is deliberate: a fresh read would compute the paging rate
  // over the gap between two calls instead of the guard's interval, and that
  // is where the spurious spikes came from. A stable answer is the contract.
  const first = await tools.get("ballast_status").execute("call-a", {});
  const second = await tools.get("ballast_status").execute("call-b", {});
  assert.equal(textOf(first), textOf(second), "served from the cached reading");
});

test("ballast_consumers answers in both shapes: by process and by project", async () => {
  const text = textOf(await tools.get("ballast_consumers").execute("call-2", {}));
  assert.match(text, /^Top consumers:/m);
  assert.match(text, /^By project:/m, "project attribution is the part pi adds");
  assert.ok(
    /nothing above the reporting floor|GB|pid /.test(text),
    "either a real list or an honest empty state",
  );
});

test("ballast_plan states its recovery and breaks it down by kind", async () => {
  const result = await tools.get("ballast_plan").execute("call-3", {});
  const text = textOf(result);
  assert.match(text, /^Relief plan: /m, "leads with what the plan would recover");
  assert.match(text, /\n\nBy kind:\n/m, "grouped so the shape of the memory is legible");
  assert.equal(typeof result.details.safeBytes, "number");
  assert.equal(typeof result.details.disruptiveBytes, "number");
  assert.ok(
    result.details.safeBytes >= 0 && result.details.disruptiveBytes >= 0,
    "recovery is never negative",
  );
});

test("ballast_plan is read-only: it reports, it never stops anything", async () => {
  const before = textOf(await tools.get("ballast_consumers").execute("call-4a", {}));
  await tools.get("ballast_plan").execute("call-4b", {});
  const after = textOf(await tools.get("ballast_consumers").execute("call-4c", {}));
  assert.equal(before, after, "planning left the machine alone");
});

test("ballast_relieve on ids that are not in the plan stops nothing and says so", async () => {
  // The safe case: an id that resolves to no candidate. An agent passing a
  // stale or invented id gets a truthful zero, not a plausible-looking guess.
  const result = await tools.get("ballast_relieve").execute("call-5", {
    ids: ["kill:999999:invented", "kill:999998:also-invented"],
    dryRun: true,
  });
  const text = textOf(result);
  assert.match(text, /^Relieved 0 B: 0 stopped, 0 refused\.$/m, "reports the truth");
  assert.equal(result.details.bytesFreed, 0);
});

test("ballast_relieve treats a missing dryRun as a real request, and still stops nothing", async () => {
  // dryRun is optional and defaults to false, so a caller who omits it is
  // asking for real action. With no matching candidate that is still zero —
  // but the code path taken is the non-dry-run one, which is the one worth
  // exercising.
  const result = await tools.get("ballast_relieve").execute("call-6", {
    ids: ["kill:999997:invented"],
  });
  assert.match(textOf(result), /^Relieved 0 B: 0 stopped, 0 refused\.$/m);
  assert.equal(result.details.bytesFreed, 0);
});

test("ballast_relieve reports one line per item, marked ok or refused", async () => {
  // The per-item detail is what tells an agent which part of its plan did not
  // happen, so the marker has to survive into the text.
  const result = await tools.get("ballast_relieve").execute("call-7", {
    ids: ["kill:999996:invented"],
    dryRun: true,
  });
  const text = textOf(result);
  const marks = text.split("\n").slice(1).map((line) => line.trim()[0]);
  assert.ok(
    marks.every((mark) => mark === "✓" || mark === "✗"),
    `every item is marked, saw: ${JSON.stringify(marks)}`,
  );
});

test.after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  delete process.env.BALLAST_CHILD;
  delete process.env.PI_CODING_AGENT_DIR;
});

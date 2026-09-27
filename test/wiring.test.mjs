/**
 * Wiring smoke test: the extension factory registers everything it promises
 * against a mock pi API, without launching the real harness.
 *
 * The tools are registered from session_start, not from the factory, and the
 * tests below fire that handler under BALLAST_CHILD so the real guard loop
 * never starts — a unit test has no business polling the machine's memory or
 * writing the real state file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// Set before the factory runs, because that is when the extension decides
// whether it is a worker. A unit test has no business polling the machine's
// memory or writing the real state file.
process.env.BALLAST_CHILD = "1";
const { default: ballast } = await import("../src/index.ts");

const TOOLS = ["ballast_status", "ballast_consumers", "ballast_plan", "ballast_relieve"];

const makePi = (ownedByOthers = []) => {
  const commands = [];
  const tools = [];
  const handlers = {};
  return {
    commands,
    tools,
    handlers,
    registerCommand(name, def) {
      commands.push(name);
      handlers[name] = def.handler;
    },
    registerTool(tool) {
      tools.push(tool.name);
    },
    getAllTools() {
      return ownedByOthers.map((name) => ({ name }));
    },
    on(event, handler) {
      handlers[event] = handler;
    },
  };
};

const startSession = (pi) => {
  pi.handlers.session_start({ type: "session_start", reason: "startup" }, { mode: "tui", cwd: "/tmp" });
};

test("factory registers /ballast and the lifecycle hooks, and no tools yet", () => {
  const pi = makePi();
  ballast(pi);
  assert.deepEqual(pi.commands, ["ballast"]);
  // Tools are deliberately absent: the registry is not readable during load,
  // so claiming a name here is what made two extensions fatal.
  assert.deepEqual(pi.tools, []);
  assert.ok(pi.handlers.session_start, "session_start hook registered");
  assert.ok(pi.handlers.session_shutdown, "session_shutdown hook registered");
});

test("session_start registers all four tools", () => {
  const pi = makePi();
  ballast(pi);
  startSession(pi);
  assert.deepEqual(pi.tools, TOOLS);
});

test("a tool name another extension owns is skipped, the rest still register", () => {
  // The bb provider bridge ships ballast_status, ballast_plan and
  // ballast_relieve. Claiming them would be a fatal load error in pi.
  const pi = makePi(["ballast_status", "ballast_plan", "ballast_relieve"]);
  ballast(pi);
  startSession(pi);
  assert.deepEqual(pi.tools, ["ballast_consumers"]);
});

test("tools register once no matter how many sessions start", () => {
  const pi = makePi();
  ballast(pi);
  startSession(pi);
  startSession(pi);
  assert.deepEqual(pi.tools, TOOLS);
});

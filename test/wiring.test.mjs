/**
 * Wiring smoke test: the extension factory registers everything it promises
 * against a mock pi API, without launching the real harness.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ballast from "../src/index.ts";

const makePi = () => {
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
    on(event, handler) {
      handlers[event] = handler;
    },
  };
};

test("factory registers /ballast, four tools, and lifecycle hooks", () => {
  const pi = makePi();
  ballast(pi);
  assert.deepEqual(pi.commands, ["ballast"]);
  assert.deepEqual(pi.tools, ["ballast_status", "ballast_consumers", "ballast_plan", "ballast_relieve"]);
  assert.ok(pi.handlers.session_start, "session_start hook registered");
  assert.ok(pi.handlers.session_shutdown, "session_shutdown hook registered");
});

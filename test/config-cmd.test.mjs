import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfigCommand } from "../src/lib/config-cmd.ts";
import { defaultConfig } from "../src/engine.ts";

const run = (args, config = defaultConfig()) => parseConfigCommand(args, config, defaultConfig());

test("no args leaves the dashboard alone", () => {
  assert.equal(run("  ").kind, "none");
});

test("config shows the effective config as JSON", () => {
  const result = run("config");
  assert.equal(result.kind, "show");
  assert.deepEqual(JSON.parse(result.message), defaultConfig());
});

test("unknown key is rejected", () => {
  assert.equal(run("config nope 1").kind, "error");
  assert.equal(run("config thresholds.nope 1").kind, "error");
  assert.equal(run("config thresholds 1").kind, "error");
  assert.equal(run("config sampleSeconds.x 1").kind, "error");
});

test("inherited Object.prototype names are unknown keys", () => {
  for (const key of ["__proto__", "constructor", "toString", "thresholds.__proto__", "thresholds.constructor"]) {
    const result = run(`config ${key} {}`);
    assert.equal(result.kind, "error", key);
    assert.equal(result.message, `unknown config key: ${key}`);
  }
});

test("number type is enforced", () => {
  assert.equal(run("config idleMinutes abc").kind, "error");
  const ok = run("config idleMinutes 45");
  assert.equal(ok.kind, "set");
  assert.equal(ok.config.idleMinutes, 45);
  assert.equal(run("config steer 1").kind, "error");
  assert.equal(run("config steer false").config.steer, false);
});

test("nested thresholds key is set without losing siblings", () => {
  const result = run("config thresholds.criticalPercent 97");
  assert.equal(result.kind, "set");
  assert.equal(result.config.thresholds.criticalPercent, 97);
  assert.equal(result.config.thresholds.warnPercent, 85);
});

test("enums and digit-only strings", () => {
  assert.equal(run("config autoRelieve safe").config.autoRelieve, "safe");
  assert.equal(run("config autoRelieve yolo").kind, "error");
  assert.equal(run("config protectedPorts 3000").config.protectedPorts, "3000");
});

test("exempt appends once", () => {
  const first = run("exempt strata*");
  assert.equal(first.kind, "set");
  const second = run("exempt vite", first.config);
  assert.equal(second.config.exemptPatterns, "strata*\nvite");
  assert.equal(run("exempt vite", second.config).kind, "error");
  assert.equal(run("exempt").kind, "error");
});

test("exempt keeps comment and blank lines", () => {
  const config = { ...defaultConfig(), exemptPatterns: "# keep model server\n\nstrata*\n" };
  const result = run("exempt vite", config);
  assert.equal(result.config.exemptPatterns, "# keep model server\n\nstrata*\nvite");
});

test("unknown subcommand prints usage", () => {
  assert.equal(run("frobnicate").kind, "error");
});

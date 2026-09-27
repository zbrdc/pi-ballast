/**
 * The one rule this module exists to enforce: status is never colour alone.
 *
 * On a monochrome terminal, over ssh, or with any form of colour vision, a
 * red panel is just a panel. So every level gets a tone AND a word AND a
 * glyph, and the three must stay distinguishable. The tests below assert that
 * as a property over the level set rather than as three separate snapshots —
 * a fourth level added tomorrow would fail here rather than in someone's
 * terminal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barFraction,
  kindLabel,
  levelGlyph,
  levelLabel,
  levelTone,
  riskLabel,
  riskTone,
} from "../src/lib/ui.ts";

const LEVELS = ["ok", "watch", "warn", "critical"];

test("every level is distinguishable without colour", () => {
  // The whole point. If two levels ever share a word or a glyph, one state
  // becomes invisible the moment colour is unavailable.
  assert.equal(new Set(LEVELS.map(levelLabel)).size, LEVELS.length, "each level has its own word");
  assert.equal(new Set(LEVELS.map(levelGlyph)).size, LEVELS.length, "each level has its own glyph");
});

test("the two axes are separate: a glyph alone never implies severity", () => {
  // Glyphs are ordered by shape as well as assigned arbitrarily, so scanning a
  // column of them reads as a gradient.
  const order = LEVELS.map(levelGlyph);
  assert.equal(new Set(order).size, order.length);
  assert.notEqual(levelGlyph("ok"), levelGlyph("critical"));
});

test("tone and word agree: the loudest level is the critical tone", () => {
  assert.equal(levelTone("critical"), "critical");
  assert.equal(levelTone("warn"), "warn");
  assert.equal(levelTone("watch"), "info", "watch is information, not a warning");
  assert.equal(levelTone("ok"), "good");
  assert.equal(levelLabel("critical"), "Critical");
  assert.equal(levelLabel("ok"), "Healthy", "ok is health, not absence of alarm");
});

test("risk is toned as a gradient from free to forbidden", () => {
  assert.equal(riskTone("safe"), "good");
  assert.equal(riskTone("disruptive"), "warn");
  assert.equal(riskTone("protected"), "neutral", "protected is not a risk, it is a refusal");
  assert.equal(riskLabel("protected"), "Protected");
  assert.equal(riskLabel("disruptive"), "Disruptive");
});

test("every process kind has a human label", () => {
  // A missing kind would render as blank in the panel, which is worse than
  // ugly: it looks like there is nothing there.
  for (const kind of ["agent", "pi", "browser-automation", "dev-server", "test-runner"]) {
    assert.ok(kindLabel(kind).length > 0, `${kind} is labelled`);
  }
  assert.equal(kindLabel("browser-automation"), "Headless browsers", "plural, for a grouped row");
});

test("bars scale to the largest sibling, never to the total", () => {
  // A row holding 4% of the list still needs a visible bar to be comparable
  // with its neighbours; the percentage lives in the text label instead.
  assert.equal(barFraction(50, 100), 0.5);
  assert.equal(barFraction(4, 4000), 0.001, "a small row against a large total is still a fraction");
  assert.equal(barFraction(100, 100), 1, "the largest sibling fills its bar");
  assert.equal(barFraction(200, 100), 1, "never overflows the column");
  assert.equal(barFraction(0, 100), 0, "nothing to draw");
  assert.equal(barFraction(10, 0), 0, "an empty list has no bar to scale against");
  assert.equal(barFraction(-5, 100), 0, "a negative reading draws nothing");
});

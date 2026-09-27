/**
 * Visual language.
 *
 * One rule carried over from the BB web UI and kept for the TUI: **status
 * colour is reserved and never used alone.** Pressure level is the only thing
 * that gets good/warn/critical colour, and everywhere it appears it carries a
 * marker glyph and a word too, so the state survives colourblindness and a
 * monochrome terminal.
 *
 * Tones map to pi-tui theme keys; `render.ts` resolves them to whatever the
 * host theme says.
 */
import type { PressureLevel, ProcessKind, Risk } from "./contract";

export type Tone = "good" | "info" | "warn" | "critical" | "neutral";

/** pi theme color names tones resolve to (see ThemeColor). */
export const toneColor: Record<Tone, "success" | "accent" | "warning" | "error" | "text"> = {
  good: "success",
  info: "accent",
  warn: "warning",
  critical: "error",
  neutral: "text",
};

export function levelTone(level: PressureLevel): Tone {
  if (level === "critical") return "critical";
  if (level === "warn") return "warn";
  if (level === "watch") return "info";
  return "good";
}

export function levelLabel(level: PressureLevel): string {
  if (level === "critical") return "Critical";
  if (level === "warn") return "Warning";
  if (level === "watch") return "Watch";
  return "Healthy";
}

/** Paired with the tone everywhere, so state is never colour-alone. */
export function levelGlyph(level: PressureLevel): string {
  if (level === "critical") return "▲";
  if (level === "warn") return "●";
  if (level === "watch") return "○";
  return "·";
}

export function riskTone(risk: Risk): Tone {
  if (risk === "safe") return "good";
  if (risk === "disruptive") return "warn";
  return "neutral";
}

export function riskLabel(risk: Risk): string {
  if (risk === "safe") return "Safe";
  if (risk === "disruptive") return "Disruptive";
  return "Protected";
}

export function kindLabel(kind: ProcessKind): string {
  const labels: Record<ProcessKind, string> = {
    agent: "Agents",
    pi: "pi",
    "browser-automation": "Headless browsers",
    "dev-server": "Dev servers",
    "test-runner": "Test runners",
    toolchain: "Build tools",
    container: "Containers",
    browser: "Browsers",
    editor: "Editors",
    system: "System",
    other: "Everything else",
  };
  return labels[kind];
}

/**
 * Bars scale against the largest sibling, not the total: a row holding 4% of a
 * list still needs a visible bar to be comparable with its neighbours. The
 * percentage-of-total stays in the text label, where the precision belongs.
 */
export function barFraction(bytes: number, max: number): number {
  if (max <= 0 || bytes <= 0) return 0;
  return Math.min(1, bytes / max);
}

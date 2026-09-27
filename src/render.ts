/**
 * Text rendering — shared by the TUI panel and the agent tools.
 *
 * Ported from the BB server's CLI renderers; a terminal is the terminal, so
 * the layout carries over unchanged. These render plain strings and never
 * touch theme colours: callers wrap lines in whatever their surface wants.
 */
import type { Consumer, Plan, Pressure } from "./lib/contract";
import { ellipsize, formatBytes, formatPercent, padBytes } from "./lib/format";
import { usedFraction } from "./lib/pressure";

export function renderPressure(pressure: Pressure): string {
  const { sample } = pressure;
  const lines = [
    `Memory pressure: ${pressure.level.toUpperCase()} — ${pressure.reason}`,
    `  Total      ${padBytes(sample.totalBytes)}`,
    `  Used       ${padBytes(sample.usedBytes)}  (${formatPercent(usedFraction(sample), 1)})`,
    `    app      ${padBytes(sample.appBytes)}`,
    `    wired    ${padBytes(sample.wiredBytes)}`,
    `    compressed ${padBytes(sample.compressedBytes)}` +
      (sample.compressionRatio > 1 ? `  (${sample.compressionRatio.toFixed(1)}x)` : ""),
    `  Cached     ${padBytes(sample.cachedFileBytes)}  (reclaimable for free)`,
    `  Headroom   ${padBytes(sample.headroomBytes)}  before the machine has to page`,
    `  Swap       ${padBytes(sample.swapUsedBytes)} of ${formatBytes(sample.swapTotalBytes)}` +
      (sample.swapInRate > 0 ? `  paging in ${formatBytes(sample.swapInRate)}/s` : ""),
  ];
  if (pressure.signals.length > 1) {
    lines.push("  Signals:");
    for (const signal of pressure.signals) {
      lines.push(`    ${signal.level.padEnd(8)} ${signal.detail}`);
    }
  }
  return lines.join("\n");
}

export function renderConsumers(title: string, consumers: readonly Consumer[], limit = 15): string {
  if (consumers.length === 0) return `${title}: nothing above the reporting floor.`;
  const lines = [`${title}:`];
  for (const consumer of consumers.slice(0, limit)) {
    const thread = consumer.threadTitle === null ? "" : `  [${ellipsize(consumer.threadTitle, 38)}]`;
    lines.push(
      `  ${padBytes(consumer.bytes)}  ${consumer.label.padEnd(30)} ` +
        `pid ${String(consumer.rootPid).padEnd(7)}${thread}`,
    );
  }
  return lines.join("\n");
}

export function renderPlan(plan: Plan, options?: { verbose?: boolean }): string {
  const actionable = plan.candidates.filter((row) => row.risk !== "protected");
  if (actionable.length === 0) {
    return "Relief plan: nothing to do — no disposable processes worth stopping.";
  }
  const lines = [
    `Relief plan: ${formatBytes(plan.safeBytes)} from safe candidates, ` +
      `${formatBytes(plan.disruptiveBytes)} more if you accept disruption.`,
  ];
  for (const candidate of plan.candidates) {
    if (candidate.risk === "protected" && options?.verbose !== true) continue;
    const size = candidate.action === "terminate" ? padBytes(candidate.bytes) : "        —";
    lines.push(`  ${size}  ${candidate.risk.padEnd(11)} ${candidate.id}`);
    lines.push(`             ${candidate.label} — ${candidate.rationale}`);
  }
  return lines.join("\n");
}

/**
 * The stats panel — the pi answer to the BB web dashboard.
 *
 * One custom screen, five sections: pressure, consumers, projects, plan,
 * activity. Selection walks the plan's actionable candidates only, because a
 * list you can move through but not act on is decoration.
 */
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAgo, formatBytes, formatLocalStamp } from "./lib/format";
import { levelGlyph, levelLabel, levelTone, riskLabel, riskTone, toneColor } from "./lib/ui";
import type { Candidate, Consumer, GuardEvent, Plan, Pressure } from "./lib/contract";
import type { Config } from "./lib/contract";

export interface PanelState {
  pressure: Pressure;
  consumers: Consumer[];
  threads: Consumer[];
  plan: Plan | null;
  events: GuardEvent[];
  config: Config;
  /** Pids currently held by the throttle rung, resumed when pressure clears. */
  pausedPids: readonly number[];
}

/** A kill confirmation closes the loop the web UI's button did. */
export type PanelAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "kill"; id: string }
  | { type: "cycle-auto-relieve" };

const REFRESH_MS = 5_000;

export class BallastPanel implements Component {
  private selected = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flash: string | null = null;
  private flashAt = 0;
  private readonly lines: string[] = [];

  private readonly tui: TUI;
  private readonly theme: Theme;
  private state: PanelState;
  private readonly onAction: (action: PanelAction) => PanelState | Promise<PanelState>;
  private readonly done: (result: null) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    state: PanelState,
    onAction: (action: PanelAction) => PanelState | Promise<PanelState>,
    done: (result: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.state = state;
    this.onAction = onAction;
    this.done = done;
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
  }

  private async refresh(): Promise<void> {
    this.state = await this.onAction({ type: "refresh" });
    this.tui.requestRender();
  }

  private candidates(): Candidate[] {
    return this.state.plan?.candidates.filter((row) => row.risk !== "protected") ?? [];
  }

  private killSelected(): void {
    const candidates = this.candidates();
    if (candidates.length === 0) return;
    const candidate = candidates[Math.min(this.selected, candidates.length - 1)];
    void Promise.resolve(this.onAction({ type: "kill", id: candidate.id })).then((state) => {
      this.state = state;
      this.selected = 0;
      this.flash = `${candidate.label}: stopped (${formatBytes(candidate.bytes)})`;
      this.flashAt = Date.now();
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      if (this.timer !== null) clearInterval(this.timer);
      this.done(null);
      return;
    }
    if (matchesKey(data, "r")) {
      void this.refresh();
      return;
    }
    if (matchesKey(data, "k")) {
      this.killSelected();
      return;
    }
    if (matchesKey(data, "s")) {
      void Promise.resolve(this.onAction({ type: "cycle-auto-relieve" })).then((state) => {
        this.state = state;
        this.tui.requestRender();
      });
      return;
    }
    const count = this.candidates().length;
    if (matchesKey(data, "up") && count > 0) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down") && count > 0) {
      this.selected = Math.min(count - 1, this.selected + 1);
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    /* render is stateless from cached strings; nothing to rebuild */
  }

  /** First snapshot landed — swap out the placeholder state. */
  replaceState(state: PanelState): void {
    this.state = state;
  }

  private fg(tone: "good" | "info" | "warn" | "critical" | "neutral", text: string): string {
    return this.theme.fg(toneColor[tone], text);
  }

  render(width: number): string[] {
    this.lines.length = 0;
    this.renderHeader(width);
    this.renderPressure(width);
    this.renderConsumers(width);
    this.renderProjects(width);
    this.renderPlan(width);
    this.renderEvents(width);
    this.renderFooter(width);
    return this.lines;
  }

  private renderHeader(width: number): void {
    const { config } = this.state;
    const rungs = `relieve ${config.autoRelieve} · throttle ${config.throttle} · steer ${config.steer ? "on" : "off"}`;
    const title = " ballast ";
    const right = ` ${rungs} — s to cycle `;
    const dots = Math.max(1, width - title.length - right.length);
    this.lines.push(
      this.theme.fg("accent", title) + "·".repeat(dots) + this.theme.fg("muted", right),
    );
  }

  private renderPressure(width: number): void {
    const { pressure } = this.state;
    const tone = levelTone(pressure.level);
    const head = `${levelGlyph(pressure.level)} ${levelLabel(pressure.level)} — ${truncateToWidth(pressure.reason, width - 24)}`;
    this.lines.push("");
    this.lines.push(this.fg(tone, head));
    const s = pressure.sample;
    const row = (label: string, value: string): string =>
      `  ${label.padEnd(10)} ${value}`;
    this.lines.push(this.theme.fg("muted", row("used", `${formatBytes(s.usedBytes)} (${Math.round((s.usedBytes / Math.max(1, s.totalBytes)) * 100)}%)`)));
    this.lines.push(this.theme.fg("muted", row("headroom", formatBytes(s.headroomBytes))));
    if (s.swapUsedBytes > 0) {
      this.lines.push(
        this.theme.fg("muted", row("swap", `${formatBytes(s.swapUsedBytes)} of ${formatBytes(s.swapTotalBytes)}`)),
      );
    }
    if (this.state.pausedPids.length > 0) {
      this.lines.push(
        this.fg(
          "warn",
          `  ▸ ${this.state.pausedPids.length} processes paused by throttle — resumes when pressure clears`,
        ),
      );
    }
  }

  private renderConsumers(width: number): void {
    this.lines.push("");
    this.lines.push(this.theme.bold("Top consumers"));
    const rows = this.state.consumers.slice(0, 10);
    if (rows.length === 0) {
      this.lines.push(this.theme.fg("muted", "  nothing above the reporting floor"));
      return;
    }
    const max = rows[0].bytes;
    for (const consumer of rows) {
      const barWidth = Math.max(1, Math.round((consumer.bytes / Math.max(1, max)) * 14));
      const bar = "█".repeat(barWidth) + "·".repeat(14 - barWidth);
      const project = consumer.threadTitle === null ? "" : this.theme.fg("accent", ` ${truncateToWidth(consumer.threadTitle, 20)}`);
      const line = `  ${formatBytes(consumer.bytes).padStart(8)}  ${bar}  ${truncateToWidth(consumer.label, 34)}${project}`;
      this.lines.push(truncateToWidth(line, width));
    }
  }

  private renderProjects(width: number): void {
    const rows = this.state.threads.slice(0, 5);
    if (rows.length === 0) return;
    this.lines.push("");
    this.lines.push(this.theme.bold("By project"));
    for (const thread of rows) {
      const line = `  ${formatBytes(thread.bytes).padStart(8)}  ${truncateToWidth(thread.threadTitle ?? "unattributed", 40)}  ${thread.processCount} processes`;
      this.lines.push(truncateToWidth(line, width));
    }
  }

  private renderPlan(width: number): void {
    this.lines.push("");
    const candidates = this.candidates();
    if (candidates.length === 0) {
      this.lines.push(this.theme.bold("Relief plan"));
      this.lines.push(this.theme.fg("muted", "  nothing to do — no disposable processes"));
      return;
    }
    this.lines.push(
      this.theme.bold(
        `Relief plan — ${formatBytes(this.state.plan!.safeBytes)} safe, ${formatBytes(this.state.plan!.disruptiveBytes)} disruptive`,
      ),
    );
    candidates.slice(0, 8).forEach((candidate, index) => {
      const marker = index === this.selected ? "▶" : " ";
      const tone = riskTone(candidate.risk);
      const head = ` ${marker} ${formatBytes(candidate.bytes).padStart(8)}  ${this.fg(tone, riskLabel(candidate.risk).padEnd(12))}${truncateToWidth(candidate.label, 40)}`;
      this.lines.push(truncateToWidth(head, width));
      if (index === this.selected) {
        this.lines.push(this.theme.fg("muted", `      ${truncateToWidth(candidate.rationale, width - 8)}`));
      }
    });
  }

  private renderEvents(width: number): void {
    const events = this.state.events.slice(0, 4);
    if (events.length === 0) return;
    this.lines.push("");
    this.lines.push(this.theme.bold("Activity"));
    for (const event of events) {
      const line = `  ${formatLocalStamp(event.atMs)}  ${event.action.padEnd(10)} ${truncateToWidth(event.detail, width - 42)}`;
      this.lines.push(this.theme.fg("muted", truncateToWidth(line, width)));
    }
  }

  private renderFooter(width: number): void {
    this.lines.push("");
    let hint = " r refresh · k stop selected · s auto-relieve · q close";
    if (this.flash !== null && Date.now() - this.flashAt < 5_000) {
      hint = ` ${this.flash}`;
    } else {
      this.flash = null;
    }
    this.lines.push("·".repeat(width));
    this.lines.push(this.theme.fg("muted", truncateToWidth(hint, width)));
    const lastSample = this.state.pressure.sample.atMs;
    this.lines.push(this.theme.fg("dim", ` sampled ${formatAgo(lastSample)} ago`));
  }
}

/**
 * pi-ballast — memory pressure monitoring and relief, as a pi extension.
 *
 * The BB plugin ran a web dashboard next to the app; pi has a TUI, so the
 * dashboard is `/ballast`. Everything else survives the port: the same
 * two-tier guard (cheap samples, expensive table only under pressure), the
 * same classification safety model, the same refuse-by-default relief gate.
 */
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defaultConfig, Engine } from "./engine";
import { BallastPanel, type PanelAction, type PanelState } from "./panel";
import { renderConsumers, renderPlan, renderPressure } from "./render";
import type { AutoRelieve } from "./lib/contract";
import { formatBytes } from "./lib/format";
import { totalsByKind } from "./lib/procs";
import { kindLabel } from "./lib/ui";

const STATE_PATH = join(getAgentDir(), "ballast-state.json");

/** The BB plugin logged to its own console; pi has none, so the guard's log
 *  feed is the store's activity trail, written via record(). */
const silentLog = (_message: string): void => {};

export default function ballast(pi: ExtensionAPI) {
  const engine = new Engine(STATE_PATH);
  let guardAbort: AbortController | null = null;

  pi.on("session_start", () => {
    // Do not start timers in the factory: a headless mode spawn would run the
    // guard for the lifetime of a one-shot `pi -p`. The session is the unit.
    void engine.load();
    guardAbort = new AbortController();
    void engine.runGuard(guardAbort.signal, silentLog);
  });

  pi.on("session_shutdown", () => {
    guardAbort?.abort();
    guardAbort = null;
    void engine.flush();
  });

  /* ---------------- /ballast — the dashboard ---------------- */

  pi.registerCommand("ballast", {
    description: "Memory pressure dashboard",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderPressure(await engine.readPressure(engine.readConfig())), "info");
        return;
      }
      await ctx.ui.custom<null>((tui, theme, _kb, done) => {
        const panel = new BallastPanel(tui, theme, emptyState(), applyAction, done);
        void panelState().then((state) => {
          panel.replaceState(state);
          tui.requestRender();
        });
        return panel;
      });
    },
  });

  async function panelState(): Promise<PanelState> {
    const config = engine.readConfig();
    const snap = await engine.snapshot(config, 0);
    const { plan } = await engine.makePlan(config, snap);
    return {
      pressure: snap.pressure,
      consumers: snap.consumers,
      threads: snap.threads,
      plan,
      events: engine.events(10),
      config,
    };
  }

  async function applyAction(action: PanelAction): Promise<PanelState> {
    if (action.type === "kill") {
      const config = engine.readConfig();
      const pressure = await engine.readPressure(config);
      const result = await engine.runRelief(config, [action.id], false);
      engine.record(
        pressure,
        result.bytesFreed > 0 ? "relieved" : "suppressed",
        `${result.succeeded} stopped, ${result.failed} refused — ${formatBytes(result.bytesFreed)} released`,
        result.bytesFreed,
      );
    }
    if (action.type === "cycle-auto-relieve") {
      const config = engine.readConfig();
      const order: AutoRelieve[] = ["off", "safe", "aggressive"];
      config.autoRelieve = order[(order.indexOf(config.autoRelieve) + 1) % order.length];
      engine.writeConfig(config);
    }
    return panelState();
  }

  /* ---------------- tools — the agent half ---------------- */

  pi.registerTool({
    name: "ballast_status",
    label: "Ballast status",
    description:
      "Read current memory pressure: level (ok/watch/warn/critical), reason, and per-signal detail.",
    parameters: Type.Object({}),
    async execute() {
      const pressure = await engine.readPressure(engine.readConfig(), 4_000);
      return {
        content: [{ type: "text", text: renderPressure(pressure) }],
        details: { level: pressure.level, reason: pressure.reason },
      };
    },
  });

  pi.registerTool({
    name: "ballast_consumers",
    label: "Ballast consumers",
    description:
      "List what is holding memory: top consumer process groups with size, age, and project attribution.",
    parameters: Type.Object({}),
    async execute() {
      const config = engine.readConfig();
      const snap = await engine.snapshot(config);
      const text = [
        renderConsumers("Top consumers", snap.consumers),
        renderConsumers("By project", snap.threads, 8),
      ].join("\n\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "ballast_plan",
    label: "Ballast plan",
    description:
      "Show the relief plan: disposable processes (headless browsers, dev servers, test runners, orphaned toolchains) with safe/disruptive risk. Nothing is killed by this tool.",
    parameters: Type.Object({}),
    async execute() {
      const config = engine.readConfig();
      const { plan, snap } = await engine.makePlan(config);
      const bands = totalsByKind(snap.consumers)
        .slice(0, 6)
        .map((row) => `  ${kindLabel(row.kind).padEnd(20)} ${formatBytes(row.bytes)}  (${row.count})`)
        .join("\n");
      const text = `${renderPlan(plan)}\n\nBy kind:\n${bands}`;
      return {
        content: [{ type: "text", text }],
        details: { safeBytes: plan.safeBytes, disruptiveBytes: plan.disruptiveBytes },
      };
    },
  });

  pi.registerTool({
    name: "ballast_relieve",
    label: "Ballast relieve",
    description:
      "Stop processes from the relief plan. Refuses anything not in the plan, re-authorizes against the live process table, and never touches editors, browsers, agents, pi, or the user's other work.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: "Candidate ids from ballast_plan, e.g. ['kill:12345:dev-server']",
      }),
      dryRun: Type.Optional(Type.Boolean({ description: "Report without stopping. Default false." })),
    }),
    async execute(_toolCallId, params) {
      const config = engine.readConfig();
      const result = await engine.runRelief(config, params.ids, params.dryRun ?? false);
      const lines = [
        `Relieved ${formatBytes(result.bytesFreed)}: ${result.succeeded} stopped, ${result.failed} refused.`,
      ];
      for (const item of result.items) {
        lines.push(`  ${item.ok ? "✓" : "✗"} ${item.label} — ${item.detail}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { bytesFreed: result.bytesFreed } };
    },
  });
}

/** Placeholder until the first snapshot lands — every field reads as "unknown". */
function emptyState(): PanelState {
  return {
    pressure: {
      level: "ok",
      reason: "sampling…",
      signals: [],
      sample: {
        atMs: 0,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        headroomBytes: 0,
        cachedFileBytes: 0,
        purgeableBytes: 0,
        appBytes: 0,
        wiredBytes: 0,
        compressedBytes: 0,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
        swapInRate: 0,
        swapOutRate: 0,
        compressionRatio: 1,
        kernelPressure: null,
      },
      thresholds: defaultConfig().thresholds,
    },
    consumers: [],
    threads: [],
    plan: null,
    events: [],
    config: defaultConfig(),
  };
}

// Re-exported for the tests.
export { Engine };

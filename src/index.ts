/**
 * pi-ballast — memory pressure monitoring and relief, as a pi extension.
 *
 * The BB plugin ran a web dashboard next to the app; pi has a TUI, so the
 * dashboard is `/ballast`. Everything else survives the port: the same
 * two-tier guard (cheap samples, expensive table only under pressure), the
 * same classification safety model, the same refuse-by-default relief gate.
 */
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { BriefGate, briefGist, contextBrief, defaultConfig, Engine } from "./engine";
import { BallastPanel, type PanelAction, type PanelState } from "./panel";
import { renderConsumers, renderPlan, renderPressure } from "./render";
import type { AutoRelieve } from "./lib/contract";
import { parseConfigCommand } from "./lib/config-cmd";
import { formatBytes } from "./lib/format";
import { totalsByKind } from "./lib/procs";
import { kindLabel } from "./lib/ui";

const STATE_PATH = join(getAgentDir(), "ballast-state.db");

/** The BB plugin logged to its own console; pi has none, so the guard's log
 *  feed is the store's activity trail, written via record(). */
const silentLog = (_message: string): void => {};

export default function ballast(pi: ExtensionAPI) {
  const engine = new Engine(STATE_PATH);
  const briefGate = new BriefGate();
  let guardAbort: AbortController | null = null;
  // An escalation worker is a guest, not a host. Its tools and its context
  // injection still work; it just never runs the machine's guard loop.
  const isWorker = process.env.BALLAST_CHILD === "1";

  pi.on("session_start", (_event, ctx) => {
    // Do not start timers in the factory: a headless mode spawn would run the
    // guard for the lifetime of a one-shot `pi -p`. The session is the unit.
    // A reload fires session_start again — abort the old loop, not stack them.
    registerTools();
    if (isWorker) return;
    guardAbort?.abort();
    guardAbort = new AbortController();
    const signal = guardAbort.signal;
    void engine.load().then(() =>
      engine.runGuard(signal, silentLog, {
        mode: ctx.mode,
        cwd: ctx.cwd,
        // An extension message, not sendUserMessage: the latter injects text
        // the user never typed into the conversation as if they had.
        sendSteer: (text) => {
          void pi.sendMessage({ customType: "ballast", content: text, display: true }, { deliverAs: "steer" });
        },
        setStatus: ctx.hasUI ? (text) => ctx.ui.setStatus("ballast", text) : undefined,
        spawnEscalation: (prompt) => {
          // BALLAST_CHILD tells the child's own extension load that it is a
          // worker, not a session: it registers its tools but starts no guard
          // loop. The lock already keeps the machine to one guard; this stops
          // the child from spending a follower slot and a timer on it.
          const child = spawn("pi", ["-p", prompt], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, BALLAST_CHILD: "1" },
          });
          child.unref();
        },
      }),
    );
  });

  pi.on("session_shutdown", () => {
    guardAbort?.abort();
    guardAbort = null;
    if (isWorker) return;
    // runGuard releases its lock and resumes its own pause wave after the
    // abort reaches the loop. A follower must not resume the leader's pids.
    void engine.flush();
  });

  /* -------- context injection: live numbers under pressure -------- */

  // The pi equivalent of BB's contributeInstructions. Request-local: pi
  // restores the transcript after the call, so this informs the model
  // without polluting history or spending a turn. It reads the guard's
  // cached sample — a fresh read would skew the paging-rate window.
  pi.on("context", (event) => {
    const pressure = engine.lastReading();
    if (!pressure) return;
    const now = Date.now();
    const kills = engine.recentOomKills();
    if (!briefGate.admit(briefGist(pressure, now, kills), now)) return;
    const brief = contextBrief(pressure, now, engine.topConsumer(), { kills });
    if (!brief) return;
    return {
      messages: [...event.messages, { role: "user", content: brief, timestamp: Date.now() }],
    };
  });

  /* ---------------- /ballast — the dashboard ---------------- */

  pi.registerCommand("ballast", {
    description: "Memory pressure dashboard; `config [key value]` and `exempt <pattern>` edit settings",
    handler: async (args, ctx) => {
      const command = parseConfigCommand(args ?? "", engine.readConfig(), defaultConfig());
      if (command.kind !== "none") {
        if (command.kind === "set") engine.writeConfig(command.config);
        ctx.ui.notify(command.message, command.kind === "error" ? "error" : "info");
        return;
      }
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
      pausedPids: engine.pausedPids(),
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

  // Registered at session_start, not here. See claim() below: pi treats a tool
  // name owned by two extensions as a fatal load error and exits, so a name
  // we cannot own has to never be claimed in the first place.
  const registered = new Set<string>();

  /**
   * True when this extension may register `name`.
   *
   * At session_start the real tool registry is finally readable — during
   * extension load every registry method is a throwing stub — so this is the
   * first moment the owner of a name is knowable. Losing the race is normal
   * and not an error: another extension on the machine (the bb provider
   * bridge ships its own ballast tools) registered first, pi's loader keeps
   * the first owner per name, and we simply do without. The panel, the
   * /ballast command, and the context injection are unaffected.
   */
  function claim(name: string): boolean {
    // Already ours from an earlier session_start: registering again would
    // just add a duplicate entry to the same registry.
    if (registered.has(name)) return false;
    if (pi.getAllTools().some((tool) => tool.name === name)) return false;
    registered.add(name);
    return true;
  }

  // Called from session_start, where claim() can actually read the registry.
  function registerTools(): void {
    if (claim("ballast_status")) {
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
    }

    if (claim("ballast_consumers")) {
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
    }

    if (claim("ballast_plan")) {
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
    }

    if (claim("ballast_relieve")) {
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
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { bytesFreed: result.bytesFreed },
          };
        },
      });
    }
  }
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
    pausedPids: [],
  };
}

// Re-exported for the tests.
export { Engine };

/**
 * The sampler, the snapshot cache, and the guard loop.
 *
 * Ported from the BB plugin's server wiring. The three rungs BB ran against
 * its own fleet become pi-native here: throttle = reversible SIGSTOP on
 * authorized candidates, steer = a message into the session whose project is
 * holding the memory, escalate = a headless pi working the relief plan.
 */
import type {
  Candidate,
  Config,
  Consumer,
  GuardEvent,
  Plan,
  Pressure,
  PressureLevel,
  ProcessRow,
} from "./lib/contract";
import type { RateCursor } from "./lib/memory";
import { attributeByPiCwd, groupByThread, groupConsumers, readPiCwds, readProcesses } from "./lib/procs";
import { sampleMemory } from "./lib/memory";
import { cadenceMs, parseLines, parsePorts } from "./lib/policy";
import { evaluatePressure } from "./lib/pressure";
import { applyRelief, buildPlan } from "./lib/relieve";
import { acquireLock, lockPathFor, type LockHandle } from "./lib/lock";
import { Store } from "./lib/store";
import { formatBytes } from "./lib/format";

/** Rate smoothing window, in samples. 3 = one bad reading cannot trip a swap signal. */
const RATE_WINDOW = 3;
/** Snapshots live this long before the next reader re-reads the table. */
const SNAPSHOT_TTL_MS = 4000;
/** Cooldown after an auto-relieve before another is attempted. */
export const RELIEF_COOLDOWN_MS = 2 * 60_000;
export const STEER_COOLDOWN_MS = 10 * 60_000;
export const ESCALATION_COOLDOWN_MS = 20 * 60_000;

/**
 * How stale a cached reading may be before the context injection stays
 * silent. The guard's slowest cadence is one minute (ok level, sampleSeconds
 * ×6); twice that means the guard is not running and the number would lie.
 */
const CONTEXT_STALE_MS = 2 * 60_000;

/**
 * The brief injected into the model's context on every request while
 * pressure is elevated — the pi equivalent of BB's contributeInstructions.
 * Returns null when there is nothing worth saying: level ok, or a reading
 * too stale to trust.
 */
export function contextBrief(pressure: Pressure, now = Date.now()): string | null {
  if (pressure.level === "ok") return null;
  if (now - pressure.sample.atMs > CONTEXT_STALE_MS) return null;
  const { sample } = pressure;
  const parts = [`${pressure.level.toUpperCase()} — headroom ${formatBytes(sample.headroomBytes)}`];
  if (sample.swapInRate > 0) parts.push(`paging in ${formatBytes(sample.swapInRate)}/min`);
  parts.push(`sampled ${Math.max(0, Math.round((now - sample.atMs) / 1000))}s ago`);
  return [
    "Note from ballast, the memory monitor (automatic status, not a user message):",
    `Memory pressure ${parts.join(", ")}.`,
    "Prefer serial over parallel builds and tests. Close browsers and dev servers you started and no longer need. Use ballast_plan before stopping anything you did not start.",
  ].join("\n");
}

/** Rung side effects, injectable so tests never touch real processes. */
export interface GuardHooks {
  stop?: (pid: number) => void;
  cont?: (pid: number) => void;
  sendUserMessage?: (text: string) => void;
  spawnEscalation?: (prompt: string) => void;
  /** Session context for the steer rung. */
  cwd?: string;
  mode?: string;
}

/**
 * The production side effects. No PID-reuse check on resume: SIGCONT against
 * a live, running process is a scheduling no-op, so the worst case of a stale
 * meta entry is nothing happens — which is also the best case.
 */
const realHooks: GuardHooks = {
  stop: (pid) => process.kill(pid, "SIGSTOP"),
  cont: (pid) => process.kill(pid, "SIGCONT"),
};

export function defaultConfig(): Config {
  return {
    thresholds: {
      watchPercent: 75,
      warnPercent: 85,
      criticalPercent: 92,
      minHeadroomGb: 3,
      swapRateMbPerMin: 200,
    },
    sampleSeconds: 10,
    protectedPorts: "",
    exemptPatterns: "",
    idleMinutes: 30,
    autoRelieve: "off",
    throttle: "off",
    steer: true,
    escalate: false,
  };
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export interface Snapshot {
  pressure: Pressure;
  rows: ProcessRow[];
  consumers: Consumer[];
  threads: Consumer[];
  selfPids: Set<number>;
  titles: Map<string, string>;
}

export class Engine {
  private readonly store: Store;
  private readonly statePath: string;
  private cursor: RateCursor | null = null;
  private lastPressure: Pressure | null = null;
  private recentSwapIn: number[] = [];
  private recentSwapOut: number[] = [];
  private snapshotCache: { at: number; value: Snapshot } | null = null;
  private snapshotInFlight: Promise<Snapshot> | null = null;
  private cachedCandidates = new Map<string, Candidate>();

  constructor(statePath: string) {
    this.store = new Store(statePath);
    this.statePath = statePath;
  }

  load(): Promise<void> {
    return this.store.load();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  events(limit = 50) {
    return this.store.events(limit);
  }

  readConfig(): Config {
    const saved = this.store.getMeta<Partial<Config>>("config");
    if (saved === null) return defaultConfig();
    // Merge over defaults so a config saved by an older version still loads.
    return { ...defaultConfig(), ...saved, thresholds: { ...defaultConfig().thresholds, ...saved.thresholds } };
  }

  writeConfig(config: Config): void {
    this.store.setMeta("config", config);
  }

  private smooth(window: number[], value: number): number {
    window.push(value);
    if (window.length > RATE_WINDOW) window.shift();
    return window.reduce((sum, entry) => sum + entry, 0) / window.length;
  }

  async readPressure(config: Config, maxAgeMs = 0): Promise<Pressure> {
    // Serving a recent reading is not just a saving. Rates are deltas between
    // consecutive samples, so an extra out-of-band read — the panel
    // refreshing, say — would move the cursor forward and compute the paging
    // rate over a two-second window instead of the guard's interval, which is
    // where the worst of the spurious spikes came from.
    if (this.lastPressure !== null && Date.now() - this.lastPressure.sample.atMs < maxAgeMs) {
      return this.lastPressure;
    }
    const { sample, cursor: next } = await sampleMemory(this.cursor);
    this.cursor = next;
    const smoothed = {
      ...sample,
      swapInRate: this.smooth(this.recentSwapIn, sample.swapInRate),
      swapOutRate: this.smooth(this.recentSwapOut, sample.swapOutRate),
    };
    const pressure = evaluatePressure(smoothed, config.thresholds);
    this.lastPressure = pressure;
    return pressure;
  }

  /**
   * Ballast's own process tree: this process and its ancestors, and nothing else.
   *
   * Ancestors only, emphatically. The plugin runs inside the pi process, and
   * *every* process any session starts is a descendant of it. Closing over
   * descendants would protect the entire machine from the plugin whose whole
   * purpose is to reclaim from it.
   */
  private selfPids(rows: readonly ProcessRow[]): Set<number> {
    const byPid = new Map(rows.map((row) => [row.pid, row] as const));
    const pids = new Set<number>([process.pid]);
    let current = byPid.get(process.pid);
    while (current !== undefined && current.ppid > 1 && !pids.has(current.ppid)) {
      pids.add(current.ppid);
      current = byPid.get(current.ppid);
    }
    return pids;
  }

  /**
   * The expensive half of the loop, cached and de-duplicated.
   *
   * Reading and classifying the process table costs orders of magnitude more
   * than reading memory totals does, and a panel render fires several reads
   * within the same second. `inFlight` matters as much as the TTL: concurrent
   * callers join the snapshot already running instead of starting their own.
   */
  async snapshot(config: Config, maxAgeMs = SNAPSHOT_TTL_MS): Promise<Snapshot> {
    if (this.snapshotCache !== null && Date.now() - this.snapshotCache.at < maxAgeMs) {
      return this.snapshotCache.value;
    }
    if (this.snapshotInFlight !== null) return this.snapshotInFlight;

    this.snapshotInFlight = (async () => {
      const [pressure, rawRows] = await Promise.all([this.readPressure(config), readProcesses()]);
      const piRows = rawRows.filter((row) => row.kind === "pi");
      const cwds = await readPiCwds(piRows);
      const rows = attributeByPiCwd(rawRows, cwds);
      const titles = new Map<string, string>();
      for (const cwd of cwds.values()) titles.set(cwd, cwd.split("/").filter(Boolean).pop() ?? cwd);
      const consumers = groupConsumers(rows, titles);
      const value: Snapshot = {
        pressure,
        rows,
        consumers,
        threads: groupByThread(consumers, titles),
        selfPids: this.selfPids(rows),
        titles,
      };
      this.snapshotCache = { at: Date.now(), value };
      return value;
    })();

    try {
      return await this.snapshotInFlight;
    } finally {
      this.snapshotInFlight = null;
    }
  }

  /** Force the next snapshot to be real — after a kill, the table has changed. */
  private invalidateSnapshot(): void {
    this.snapshotCache = null;
  }

  async makePlan(config: Config, snap?: Snapshot): Promise<{ plan: Plan; snap: Snapshot }> {
    const current = snap ?? (await this.snapshot(config));
    const plan = buildPlan({
      consumers: current.consumers,
      threadConsumers: current.threads,
      rows: current.rows,
      config: relieveConfig(config),
      selfPids: current.selfPids,
      steerLimit: 0,
    });
    this.cachedCandidates = new Map(plan.candidates.map((row) => [row.id, row] as const));
    return { plan, snap: current };
  }

  async runRelief(config: Config, ids: readonly string[], dryRun: boolean) {
    // Re-authorization has to see the table as it is now, not as the plan
    // remembered it — that is the entire point of the second check.
    const snap = await this.snapshot(config, 0);
    const candidates = ids
      .map((id) => this.cachedCandidates.get(id))
      .filter((row): row is Candidate => row !== undefined);
    if (!dryRun) this.invalidateSnapshot();
    return applyRelief({
      candidates,
      rows: snap.rows,
      consumers: snap.consumers,
      config: relieveConfig(config),
      selfPids: snap.selfPids,
      dryRun,
      log: () => {},
      steer: async () => {},
    });
  }

  record(pressure: Pressure, action: GuardEvent["action"], detail: string, bytesFreed = 0, threadId: string | null = null): void {
    this.store.recordGuardEvent({
      atMs: Date.now(),
      level: pressure.level,
      headroomBytes: pressure.sample.headroomBytes,
      usedFraction: usedFractionOf(pressure),
      action,
      detail,
      bytesFreed,
      threadId,
    });
  }

  /**
   * The guard: tier one samples, tier two investigates, rungs act.
   *
   * The ladder runs in BB's order: throttle (reversible pause) → steer (ask
   * the session holding the memory) → relieve (kill) → escalate (a headless
   * pi with the ballast tools). Each rung has its own gate and cooldown;
   * escalate never fires the same tick relief already acted.
   */
  /* ---------------- the rungs ---------------- */

  /**
   * Throttle: the reversible rung. BB capped fleet concurrency; pi has no
   * concurrency knob, so we pause what the relief gate would authorize and
   * resume it when pressure clears. Loses nothing — stopped work resumes.
   */
  private throttleRung(
    config: Config,
    level: PressureLevel,
    plan: Plan,
    pressure: Pressure,
    hooks: GuardHooks,
  ): void {
    if (config.throttle !== "safe" || level === "watch") return;
    const paused = this.store.getMeta<number[]>("throttle-paused");
    if (paused !== null && paused.length > 0) return;
    const safe = plan.candidates.filter(
      (row) => row.action === "terminate" && row.risk === "safe",
    );
    if (safe.length === 0) return;
    const pids = safe.flatMap((row) => row.pids);
    const bytes = safe.reduce((sum, row) => sum + row.bytes, 0);
    for (const pid of pids) {
      try {
        hooks.stop?.(pid);
      } catch {
        /* ESRCH: died between plan and signal — the next pause wave is free. */
      }
    }
    this.store.setMeta("throttle-paused", pids);
    this.store.setMeta("throttle-paused-at", Date.now());
    this.record(
      pressure,
      "throttled",
      `${pids.length} processes paused (${formatBytes(bytes)} held) — resumes when pressure clears`,
      0,
    );
  }

  /** Pids currently held by the throttle rung. */
  pausedPids(): readonly number[] {
    return this.store.getMeta<number[]>("throttle-paused") ?? [];
  }

  /**
   * The guard's most recent reading, or null before the first sample.
   * The context injection reports this without sampling on its own —
   * an extra read would move the paging-rate cursor (see readPressure).
   */
  lastReading(): Pressure | null {
    return this.lastPressure;
  }

  /** Resume whatever a previous guard (or a crashed session) left stopped. */
  resumePaused(pressure: Pressure | null, hooks: GuardHooks = realHooks): void {
    const paused = this.store.getMeta<number[]>("throttle-paused");
    if (paused === null || paused.length === 0) return;
    for (const pid of paused) {
      try {
        hooks.cont?.(pid);
      } catch {
        /* already gone */
      }
    }
    this.store.deleteMeta("throttle-paused");
    this.store.deleteMeta("throttle-paused-at");
    if (pressure !== null) {
      this.record(pressure, "restored", `${paused.length} processes resumed`, 0);
    }
  }

  /**
   * Steer: ask the session whose project is holding the memory to release
   * it. BB messaged a thread; pi's equivalent is a message into the session.
   * Only the session standing in the affected project speaks — everyone
   * else's ballast stays quiet.
   *
   * This is the one rung that runs outside the leader gate, because it acts
   * on a session rather than on the machine: the only process that can
   * deliver the message is the TUI session holding the memory, and that may
   * not be the leader. Every other rung acts on machine-global state, where a
   * second writer is the failure this plugin exists to avoid, so those stay
   * leader-only.
   */
  private steerRung(
    config: Config,
    level: PressureLevel,
    snap: Snapshot,
    pressure: Pressure,
    hooks: GuardHooks,
    state: { steered: boolean },
  ): void {
    if (!config.steer || level === "watch") return;
    if (!hooks.sendUserMessage || hooks.mode !== "tui" || !hooks.cwd) return;
    if (state.steered) return;
    const holding = snap.threads.find((row) => row.threadId === hooks.cwd);
    if (!holding || holding.bytes < 256 * 1024 ** 2) return;
    // Claim the cooldown before speaking, not after: sessions are no longer
    // serialised by the leader lock, so two of them standing in the same
    // project reach this line together. The store decides, in one statement.
    if (!this.store.claimCooldown("last-steer", Date.now(), STEER_COOLDOWN_MS)) return;
    state.steered = true;
    hooks.sendUserMessage(
      `Memory pressure is ${level} (${pressure.reason}). ` +
        `This session's project (${holding.label}) is holding ${formatBytes(holding.bytes)}. ` +
        "Close Playwright browsers and stop dev servers you started when they are " +
        "no longer needed, or run /ballast.",
    );
    this.record(
      pressure,
      "steered",
      `asked ${holding.label} (${formatBytes(holding.bytes)}) to release`,
      0,
    );
  }

  /**
   * Escalate: hand the problem to a headless pi with the ballast tools.
   * Never when there is nothing for it to do — BB's lesson: an agent whose
   * only possible move is asking the user a question is noise at 3am. And
   * never while a relief wave is still landing: kills are asynchronous, so
   * the agent waits out relief's own cadence before it concludes the ladder
   * failed. That also makes it the intervention of record when the user runs
   * autoRelieve "off": nothing dies unattended, something reasons instead.
   */
  private escalateRung(
    config: Config,
    level: PressureLevel,
    plan: Plan,
    snap: Snapshot,
    pressure: Pressure,
    hooks: GuardHooks,
  ): void {
    if (!config.escalate || level !== "critical") return;
    if (!hooks.spawnEscalation) return;
    const now = Date.now();
    const last = this.store.getMeta<number>("last-escalation");
    if (last !== null && now - last < ESCALATION_COOLDOWN_MS) return;
    const lastRelief = this.store.getMeta<number>("last-relief");
    if (lastRelief !== null && now - lastRelief < RELIEF_COOLDOWN_MS) return;
    const actionable = plan.candidates.some((row) => row.risk !== "protected");
    const piHolding = snap.consumers.some(
      (row) => row.kind === "pi" && row.bytes > 1024 ** 3,
    );
    if (!actionable && !piHolding) return;
    this.store.setMeta("last-escalation", now);
    hooks.spawnEscalation(
      `Memory pressure is critical (${pressure.reason}). ` +
        "Call ballast_plan, review the candidates, then ballast_relieve with dryRun first. " +
        `Stop safe candidates; take disruptive ones only if headroom stays under ${config.thresholds.minHeadroomGb} GB. ` +
        "Report what you stopped and what it freed.",
    );
    this.record(pressure, "escalated", "spawned a headless pi to work the relief plan", 0);
  }

  /**
   * Whether this session could deliver a steer message — decided without
   * touching the process table.
   *
   * The rung behind it needs a snapshot, and a snapshot reads every process on
   * the machine. So the cheap refusals come first: only a TUI session in a
   * real directory can hold memory, which is also the only place a message
   * can be delivered. At warn or worse that session might be the one holding
   * it, so it pays for the read; a sub-agent or a headless child never does.
   */
  private canSteer(config: Config, level: PressureLevel, hooks: GuardHooks): boolean {
    if (!config.steer || level === "watch") return false;
    return hooks.sendUserMessage !== undefined && hooks.mode === "tui" && Boolean(hooks.cwd);
  }

  /**
   * The irreversible rungs, in BB's order: relieve (kills) → escalate (hands
   * the problem to an agent).
   *
   * Leader-only, like throttle: both act on machine-global state, where a
   * second writer is the failure this plugin exists to prevent. Steer is not
   * in here — it acts on a session, so it belongs to whichever session can
   * deliver it rather than to whoever won the election. The caller runs
   * throttle and steer around this one to keep BB's order intact.
   */
  private async irreversibleRungs({
    config,
    level,
    plan,
    snap,
    pressure,
    hooks,
    log,
  }: {
    config: Config;
    level: PressureLevel;
    plan: Plan;
    snap: Snapshot;
    pressure: Pressure;
    hooks: GuardHooks;
    log: (message: string) => void;
  }): Promise<void> {
    const now = Date.now();
    const lastReliefMs = this.store.getMeta<number>("last-relief") ?? 0;
    const reliefLevel = config.autoRelieve === "aggressive" ? "warn" : "critical";
    if (
      config.autoRelieve !== "off" &&
      level === reliefLevel &&
      now - lastReliefMs > RELIEF_COOLDOWN_MS
    ) {
      const ids = plan.candidates
        .filter(
          (row) =>
            row.action === "terminate" &&
            (row.risk === "safe" ||
              (config.autoRelieve === "aggressive" && row.risk === "disruptive")),
        )
        .map((row) => row.id);
      if (ids.length > 0) {
        this.store.setMeta("last-relief", now);
        const result = await this.runRelief(config, ids, false);
        this.record(
          pressure,
          result.bytesFreed > 0 ? "relieved" : "suppressed",
          `${result.succeeded} stopped, ${result.failed} refused — ${result.bytesFreed} bytes released`,
          result.bytesFreed,
        );
        log(`relieved ${result.bytesFreed} bytes from ${result.succeeded} trees`);
      }
    }

    // Escalation is the last rung. It refuses to fire while a relief wave is
    // still landing (checked against "last-relief" above and again inside the
    // rung) and never without something to do.
    this.escalateRung(config, level, plan, snap, pressure, hooks);
  }

  async runGuard(
    signal: AbortSignal,
    log: (message: string) => void,
    hooks: GuardHooks = realHooks,
  ): Promise<void> {
    const steerState = { steered: false };
    let lastLevel = this.store.getMeta<PressureLevel>("last-level");
    let pendingLevel: PressureLevel | null = null;
    let lock: LockHandle | null = null;

    while (!signal.aborted) {
      let level: PressureLevel = "ok";
      try {
        const config = this.readConfig();

        // One guard per machine. Losing the election is not an error: this
        // process still samples and still serves the panel and the tools, it
        // just does not act. It retries each iteration, so the guard survives
        // the session that started it being closed.
        if (lock !== null && !(await lock.touch())) lock = null;
        if (lock === null) lock = await acquireLock(lockPathFor(this.statePath));

        // Tier one: totals only. Two short-lived reads, no process table —
        // a few milliseconds. This is all a healthy machine ever pays, and it
        // is the whole reason the guard can run on a short interval without
        // being part of the problem it monitors.
        const pressure = await this.readPressure(config);
        if (signal.aborted) break;
        level = pressure.level;
        this.store.recordSample(pressure.sample);

        // A level change has to survive one more sample before it counts.
        // Without this, a single burst of paging writes a critical/warn pair
        // into the log every couple of minutes.
        if (level !== lastLevel) {
          if (level === pendingLevel) {
            // The event log and "last-level" are machine-shared, so only the
            // leader writes them. Every session observes the same transition;
            // letting each record it put duplicate rows at the same millisecond.
            // Followers still track the level locally and still log.
            if (lock !== null) {
              if (lastLevel !== null || level !== "ok") {
                this.record(pressure, "observed", pressure.reason);
              }
              this.store.setMeta("last-level", level);
            }
            log(`pressure ${lastLevel ?? "unknown"} → ${level}: ${pressure.reason}`);
            lastLevel = level;
            pendingLevel = null;
          } else {
            pendingLevel = level;
          }
        } else {
          pendingLevel = null;
        }

        if (level === "ok") {
          // Only the leader can have paused anything. A follower sampling an
          // ok reading must not SIGCONT the leader's wave while its own sample
          // still says the machine is under pressure.
          if (lock !== null) this.resumePaused(pressure, hooks);
        } else {
          // BB's order across two different gates: throttle (leader) runs
          // before steer (any session), which runs before relief and
          // escalation (leader). Throttle is reversible and free, so the
          // machine holds less memory before anyone is asked to act.
          //
          // One snapshot serves all three. The cheap gate is which rungs can
          // run at all, not how many times the process table is read: a
          // follower that cannot steer never looks, and the leader reads
          // once however many of its rungs fire.
          let leads = lock !== null;
          const steers = this.canSteer(config, level, hooks);
          if (leads || steers) {
            const snap = await this.snapshot(config, 0);
            if (signal.aborted) break;
            // The table walk can take long enough for a stalled lock to be
            // stolen. Re-validate before acting; a stale leader becomes a
            // follower in this same iteration instead of double-acting.
            if (lock !== null && !(await lock.touch())) {
              lock = null;
              leads = false;
            }
            const plan: Plan | null = leads ? (await this.makePlan(config, snap)).plan : null;

            if (plan !== null) this.throttleRung(config, level, plan, pressure, hooks);
            if (steers) this.steerRung(config, level, snap, pressure, hooks, steerState);
            if (plan !== null) {
              await this.irreversibleRungs({ config, level, plan, snap, pressure, hooks, log });
            }
          }
        }
      } catch (cause) {
        log(`guard: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const config = this.readConfig();
      await sleep(cadenceMs(config, level), signal);
    }

    // Only the current lock owner resumes what it paused. An outgoing loop
    // that lost ownership during reload must leave the successor's wave alone.
    const ownsLock = lock !== null && (await lock.touch());
    if (ownsLock) this.resumePaused(null, hooks);
    // Hand the machine over. Without this, closing the leader's session left
    // the guard parked until the lock aged out three minutes later, during
    // which no other session could act at all.
    await lock?.release();
  }
}

function usedFractionOf(pressure: Pressure): number {
  return pressure.sample.totalBytes > 0
    ? pressure.sample.usedBytes / pressure.sample.totalBytes
    : 0;
}

function relieveConfig(config: Config) {
  return {
    protectedPorts: parsePorts(config.protectedPorts),
    exemptPatterns: parseLines(config.exemptPatterns),
    idleSeconds: config.idleMinutes * 60,
    protectedThreadIds: new Set<string>(),
  };
}

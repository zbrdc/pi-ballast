/**
 * The sampler, the snapshot cache, and the guard loop.
 *
 * Ported from the BB plugin's server wiring. The three rungs BB ran against
 * its own fleet become pi-native here: throttle = reversible SIGSTOP on
 * authorized candidates, steer = a message into the session whose project is
 * holding the memory, escalate = a headless pi working the relief plan.
 */
import { availableParallelism, platform } from "node:os";
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
import { DEFAULT_THRESHOLDS, evaluatePressure } from "./lib/pressure";
import { applyRelief, buildPlan } from "./lib/relieve";
import { acquireLock, lockPathFor, type LockHandle } from "./lib/lock";
import { oomDetail, parseOomDetail, readOomKills, type OomKill } from "./lib/oom";
import { Store } from "./lib/store";
import { formatBytes, formatRate } from "./lib/format";

/** Rate smoothing window, in samples. 3 = one bad reading cannot trip a swap signal. */
const RATE_WINDOW = 3;
/** Snapshots live this long before the next reader re-reads the table. */
const SNAPSHOT_TTL_MS = 4000;
/** Cooldown after an auto-relieve before another is attempted. */
export const RELIEF_COOLDOWN_MS = 2 * 60_000;
export const STEER_COOLDOWN_MS = 10 * 60_000;
/**
 * A steer interrupts the agent, so it must be worth the interruption: the
 * stoppable processes the session owns have to add up to at least this much.
 * Below it, stopping them would not move the machine and the message is noise.
 */
export const STEER_MIN_BYTES = 1024 ** 3;
/** Most items a steer message names; the rest are summed into the byte total only. */
const STEER_MAX_ITEMS = 5;
/** Kinds a session started and can stop. Never its own pi, agents, editors or the system. */
const STEERABLE_KINDS: ReadonlySet<string> = new Set(["browser-automation", "dev-server", "test-runner"]);
export const ESCALATION_COOLDOWN_MS = 20 * 60_000;

/** Stoppable consumers in the session's project, largest first, never the guard's own tree. */
function steerCandidates(snap: Snapshot, cwd: string): Consumer[] {
  return snap.consumers
    .filter(
      (c) =>
        c.threadId === cwd &&
        STEERABLE_KINDS.has(c.kind) &&
        !c.pids.some((pid) => snap.selfPids.has(pid)),
    )
    .sort((a, b) => b.bytes - a.bytes);
}

function describeSteerItem(c: Consumer): string {
  const port = c.port === null ? "" : ` on :${c.port}`;
  return `${c.label}${port} (pid ${c.rootPid}) ${formatBytes(c.bytes)}`;
}

/**
 * How stale a cached reading may be before the context injection stays
 * silent. The guard's slowest cadence is one minute (ok level, sampleSeconds
 * ×6); twice that means the guard is not running and the number would lie.
 */
const CONTEXT_STALE_MS = 2 * 60_000;

/** The biggest thing on the machine when pressure last rose, shared via meta. */
export interface TopConsumer {
  label: string;
  kind: string;
  bytes: number;
  threadId: string | null;
  atMs: number;
  /** bytes / total RAM, 0..1. */
  fraction: number;
}

const TOP_CONSUMER_KEY = "top-consumer";

function topConsumerLine(top: TopConsumer): string {
  const where = top.threadId === null ? "outside any project" : `in project ${top.threadId}`;
  const share = Math.round(top.fraction * 100);
  return `Largest consumer: ${top.label} (${formatBytes(top.bytes)}, ${share}% of RAM), ${where}.`;
}

/**
 * A typical rustc/tsc/clang job peaks around 1-2 GB; budgeting 2 GiB per job
 * keeps a parallel build from spending the headroom it was told is left.
 */
const BYTES_PER_JOB = 2 * 1024 ** 3;

/** Parallel jobs the current headroom supports: at least 1, at most the CPU count. */
export function parallelBudget(headroomBytes: number, cpus = availableParallelism()): number {
  const jobs = Math.floor(headroomBytes / BYTES_PER_JOB);
  return Math.max(1, Math.min(jobs, Math.max(1, cpus)));
}

function budgetLines(headroomBytes: number, cpus: number | undefined): string[] {
  const jobs = parallelBudget(headroomBytes, cpus);
  return [
    `Budget for new work: ~${jobs} parallel jobs (e.g. make -j${jobs}, cargo build -j${jobs}, --test-threads=${jobs}). Run test suites serially if they launch browsers.`,
    "Use ballast_plan before stopping anything you did not start.",
  ];
}

/** A kill older than this is no longer a plausible cause of a failing command. */
const OOM_WINDOW_MS = 15 * 60_000;
/** The journal is a subprocess; the leader asks at most this often. */
const OOM_POLL_MS = 60_000;
const OOM_CURSOR_KEY = "oom-cursor";
/** More than this many kills in the brief is noise; the newest are enough. */
const BRIEF_MAX_KILLS = 3;

/** Optional brief inputs; a bare number is the CPU count (the original 4th parameter). */
export interface BriefOptions {
  cpus?: number;
  kills?: OomKill[];
}

function killLine(kill: OomKill, now: number): string {
  const minutes = Math.max(0, Math.round((now - kill.atMs) / 60_000));
  return `Kernel OOM-killed ${kill.name} (pid ${kill.pid}) ${minutes}m ago — a command exiting 137/SIGKILL was likely this.`;
}

function killLines(kills: OomKill[], now: number): string[] {
  return kills
    .filter((kill) => now - kill.atMs <= OOM_WINDOW_MS)
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, BRIEF_MAX_KILLS)
    .map((kill) => killLine(kill, now));
}

/**
 * The brief injected into the model's context on every request while
 * pressure is elevated — the pi equivalent of BB's contributeInstructions.
 * Returns null when there is nothing worth saying: level ok with no recent
 * kernel kill, or a reading too stale to trust. Watch carries the numbers
 * only; advice starts at warn so a merely busy machine is not nagged on every
 * request. A recent OOM kill is reported even at ok: the machine has
 * recovered, but the agent's failed command still needs explaining.
 */
export function contextBrief(
  pressure: Pressure,
  now = Date.now(),
  top?: TopConsumer | null,
  options?: BriefOptions | number,
): string | null {
  const { cpus, kills = [] } = typeof options === "number" ? { cpus: options } : (options ?? {});
  const killNotes = killLines(kills, now);
  const header = "Note from ballast, the memory monitor (automatic status, not a user message):";
  const reading = pressureLines(pressure, now, top, cpus);
  if (reading.length === 0 && killNotes.length === 0) return null;
  return [header, ...reading, ...killNotes].join("\n");
}

function pressureLines(
  pressure: Pressure,
  now: number,
  top: TopConsumer | null | undefined,
  cpus: number | undefined,
): string[] {
  if (pressure.level === "ok") return [];
  if (now - pressure.sample.atMs > CONTEXT_STALE_MS) return [];
  const { sample } = pressure;
  const parts = [`${pressure.level.toUpperCase()} — headroom ${formatBytes(sample.headroomBytes)}`];
  if (sample.swapInRate > 0) parts.push(`paging in ${formatRate(sample.swapInRate)}`);
  parts.push(`sampled ${Math.max(0, Math.round((now - sample.atMs) / 1000))}s ago`);
  return [
    `Memory pressure ${parts.join(", ")}.`,
    ...(top ? [topConsumerLine(top)] : []),
    ...(pressure.level === "watch" ? [] : budgetLines(sample.headroomBytes, cpus)),
  ];
}

/** Rung side effects, injectable so tests never touch real processes. */
export interface GuardHooks {
  stop?: (pid: number) => void;
  cont?: (pid: number) => void;
  /** Delivers a steer to the session as an extension message, not as user input. */
  sendSteer?: (text: string) => void;
  /** Status-line text while pressure is above ok; undefined clears it. */
  setStatus?: (text: string | undefined) => void;
  spawnEscalation?: (prompt: string) => void;
  /** Kernel OOM kills since a timestamp; defaults to the journal reader. */
  readOomKills?: (sinceMs: number) => Promise<OomKill[]>;
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
    thresholds: { ...DEFAULT_THRESHOLDS },
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
  private lastOomPollMs = 0;
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
    const defaults = defaultConfig();
    // Keep only live keys: retired ones (warnPercent, criticalPercent) would
    // otherwise show up in /ballast config as settings that do nothing.
    const kept = Object.entries(saved.thresholds ?? {}).filter(([key]) => key in defaults.thresholds);
    return { ...defaults, ...saved, thresholds: { ...defaults.thresholds, ...Object.fromEntries(kept) } };
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
    const pressure = evaluatePressure(
      smoothed,
      config.thresholds,
      this.lastPressure?.level ?? null,
    );
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

  /**
   * The largest non-system consumer the leader recorded at its last snapshot.
   * Followers never snapshot, so the brief reads it from shared meta; a record
   * older than the context window is dropped for the same reason a stale
   * reading is — the guard may have stopped and the name would lie.
   */
  topConsumer(now = Date.now()): TopConsumer | null {
    const top = this.store.getMeta<TopConsumer>(TOP_CONSUMER_KEY);
    if (top === null || now - top.atMs > CONTEXT_STALE_MS) return null;
    return top;
  }

  /**
   * Kernel OOM kills the leader recorded inside the window, newest first.
   * Read from the event log so followers see them without touching the journal.
   */
  recentOomKills(windowMs = OOM_WINDOW_MS, now = Date.now()): OomKill[] {
    const kills: OomKill[] = [];
    for (const event of this.store.events(200)) {
      if (event.action !== "oom-killed" || now - event.atMs > windowMs) continue;
      const who = parseOomDetail(event.detail);
      if (who === null) continue;
      kills.push({ atMs: event.atMs, ...who, ...(event.bytesFreed > 0 && { rssBytes: event.bytesFreed }) });
    }
    return kills;
  }

  /**
   * Leader-only. The cursor lives in meta so a restart does not re-report
   * kills, and a first run looks back only one window rather than flooding the
   * log with a month of history.
   */
  private async pollOomKills(pressure: Pressure, hooks: GuardHooks, now: number): Promise<void> {
    if (platform() !== "linux" || now - this.lastOomPollMs < OOM_POLL_MS) return;
    this.lastOomPollMs = now;
    const cursor = this.store.getMeta<number>(OOM_CURSOR_KEY) ?? now - OOM_WINDOW_MS;
    const kills = await (hooks.readOomKills ?? readOomKills)(cursor + 1);
    let newest = cursor;
    for (const kill of kills) {
      if (kill.atMs <= cursor) continue;
      this.store.recordGuardEvent({
        atMs: kill.atMs,
        level: pressure.level,
        headroomBytes: pressure.sample.headroomBytes,
        usedFraction: usedFractionOf(pressure),
        action: "oom-killed",
        detail: oomDetail(kill),
        bytesFreed: kill.rssBytes ?? 0,
        threadId: null,
      });
      newest = Math.max(newest, kill.atMs);
    }
    this.store.setMeta(OOM_CURSOR_KEY, newest);
  }

  /** Compact status-line text, or undefined when the machine is fine. */
  private statusText(pressure: Pressure): string | undefined {
    if (pressure.level === "ok") return undefined;
    const free = formatBytes(pressure.sample.headroomBytes);
    const top = this.topConsumer();
    const named = top ? ` · ${top.label} ${formatBytes(top.bytes)}` : "";
    return `ballast: ${pressure.level.toUpperCase()} ${free} free${named}`;
  }

  /**
   * Pushes the status only when its text changed: the guard samples every few
   * seconds and a repaint of the footer per sample is churn. Returns the text
   * to remember as "last pushed".
   */
  private publishStatus(
    pressure: Pressure,
    hooks: GuardHooks,
    last: string | undefined,
  ): string | undefined {
    const text = this.statusText(pressure);
    if (text !== last) hooks.setStatus?.(text);
    return text;
  }

  private recordTopConsumer(consumers: Consumer[], totalBytes: number): void {
    let top: Consumer | null = null;
    for (const c of consumers) {
      if (c.kind !== "system" && (top === null || c.bytes > top.bytes)) top = c;
    }
    if (top === null) return;
    const record: TopConsumer = {
      label: top.label,
      kind: top.kind,
      bytes: top.bytes,
      threadId: top.threadId,
      atMs: Date.now(),
      fraction: totalBytes > 0 ? top.bytes / totalBytes : 0,
    };
    this.store.setMeta(TOP_CONSUMER_KEY, record);
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
    if (!hooks.sendSteer || hooks.mode !== "tui" || !hooks.cwd) return;
    if (state.steered) return;
    const items = steerCandidates(snap, hooks.cwd);
    const bytes = items.reduce((sum, c) => sum + c.bytes, 0);
    if (bytes < STEER_MIN_BYTES) return;
    // Claim the cooldown before speaking, not after: sessions are no longer
    // serialised by the leader lock, so two of them standing in the same
    // project reach this line together. The store decides, in one statement.
    if (!this.store.claimCooldown("last-steer", Date.now(), STEER_COOLDOWN_MS)) return;
    state.steered = true;
    const named = items.slice(0, STEER_MAX_ITEMS).map(describeSteerItem).join("; ");
    hooks.sendSteer(
      `Memory pressure is ${level} (${pressure.reason}). ` +
        `This session started ${named}. ` +
        "Stop the ones you no longer need, or run /ballast.",
    );
    this.record(
      pressure,
      "steered",
      `asked about ${items.length} process${items.length === 1 ? "" : "es"} (${formatBytes(bytes)}) to release`,
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
    return hooks.sendSteer !== undefined && hooks.mode === "tui" && Boolean(hooks.cwd);
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
    let lastStatus: string | undefined;
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
        if (lock !== null) await this.pollOomKills(pressure, hooks, Date.now());
        lastStatus = this.publishStatus(pressure, hooks, lastStatus);

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
            if (leads) this.recordTopConsumer(snap.consumers, pressure.sample.totalBytes);
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

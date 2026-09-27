/**
 * The sampler, the snapshot cache, and the guard loop.
 *
 * Ported from the BB plugin's server wiring, minus the rungs pi has no knob
 * for (throttle, steer, escalate — see README). What remains is the same
 * two-tier shape: tier one reads memory totals for a few milliseconds, tier
 * two reads the whole process table, and only pressure buys tier two.
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
import { Store } from "./lib/store";

/** Rate smoothing window, in samples. 3 = one bad reading cannot trip a swap signal. */
const RATE_WINDOW = 3;
/** Snapshots live this long before the next reader re-reads the table. */
const SNAPSHOT_TTL_MS = 4000;
/** Cooldown after an auto-relieve before another is attempted. */
export const RELIEF_COOLDOWN_MS = 2 * 60_000;

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
  private cursor: RateCursor | null = null;
  private lastPressure: Pressure | null = null;
  private recentSwapIn: number[] = [];
  private recentSwapOut: number[] = [];
  private snapshotCache: { at: number; value: Snapshot } | null = null;
  private snapshotInFlight: Promise<Snapshot> | null = null;
  private cachedCandidates = new Map<string, Candidate>();

  constructor(statePath: string) {
    this.store = new Store(statePath);
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
   * Only the terminate rung survives the pi port — throttle and escalate need
   * host knobs pi does not expose, and steer needs a thread messaging API pi
   * does not have. (Auto-relieve itself defaults to "off"; see README.)
   */
  async runGuard(signal: AbortSignal, log: (message: string) => void): Promise<void> {
    let lastLevel = this.store.getMeta<PressureLevel>("last-level");
    let pendingLevel: PressureLevel | null = null;
    let lastReliefMs = this.store.getMeta<number>("last-relief") ?? 0;

    while (!signal.aborted) {
      let level: PressureLevel = "ok";
      try {
        const config = this.readConfig();

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
            if (lastLevel !== null || level !== "ok") {
              this.record(pressure, "observed", pressure.reason);
            }
            log(`pressure ${lastLevel ?? "unknown"} → ${level}: ${pressure.reason}`);
            lastLevel = level;
            this.store.setMeta("last-level", level);
            pendingLevel = null;
          } else {
            pendingLevel = level;
          }
        } else {
          pendingLevel = null;
        }

        if (level !== "ok") {
          const snap = await this.snapshot(config, 0);
          if (signal.aborted) break;

          // The one rung: relieve. Waits for `critical` unless the user asked
          // for aggressive. Safe candidates only, unless aggressive.
          const now = Date.now();
          const reliefLevel = config.autoRelieve === "aggressive" ? "warn" : "critical";
          const reliefDue =
            config.autoRelieve !== "off" &&
            level === reliefLevel &&
            now - lastReliefMs > RELIEF_COOLDOWN_MS;

          if (reliefDue) {
            const { plan } = await this.makePlan(config, snap);
            const ids = plan.candidates
              .filter(
                (row) =>
                  row.action === "terminate" &&
                  (row.risk === "safe" ||
                    (config.autoRelieve === "aggressive" && row.risk === "disruptive")),
              )
              .map((row) => row.id);
            if (ids.length > 0) {
              lastReliefMs = now;
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
        }
      } catch (cause) {
        log(`guard: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const config = this.readConfig();
      await sleep(cadenceMs(config, level), signal);
    }
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

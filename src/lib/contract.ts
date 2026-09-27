/**
 * Shared shapes for Ballast's sampler, grader, attributor, planner and TUI.
 *
 * Ported from the BB plugin's wire contract. The zod schemas existed to
 * validate the HTTP boundary between a server and a web bundle; the pi port
 * has no such boundary — the TUI imports these functions directly — so this
 * is types and the constants the grades are drawn from.
 */

/* ------------------------------------------------------------------ */
/* Pressure                                                            */
/* ------------------------------------------------------------------ */

export const PRESSURE_LEVELS = ["ok", "watch", "warn", "critical"] as const;
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

/**
 * One memory reading, in the terms the operating system actually uses.
 *
 * Deliberately not "used / free". On a modern kernel that pair is meaningless:
 * a machine can report 61% free from `memory_pressure` while holding 5 GB of
 * swap and 6 GB of compressed pages. The fields below are the ones that decide
 * whether the next allocation costs a pointer bump or a page-in from disk.
 */
export interface MemorySample {
  atMs: number;
  totalBytes: number;
  /** Pages the kernel has on hand right now. Almost always small; that's fine. */
  freeBytes: number;
  /** Anonymous, non-purgeable pages: the memory programs actually asked for. */
  appBytes: number;
  /** Kernel and drivers. Cannot be compressed, swapped, or reclaimed. */
  wiredBytes: number;
  /** Already squeezed. Cheap to read back, but it was RAM once. */
  compressedBytes: number;
  /** Clean file pages. The kernel drops these for free under demand. */
  cachedFileBytes: number;
  /** Allocated but discardable on request (caches that opted in). */
  purgeableBytes: number;
  /**
   * What a new allocation can draw on before anything has to be compressed or
   * paged out: free + speculative + clean file cache + purgeable. The single
   * number worth alarming on.
   */
  headroomBytes: number;
  /** appBytes + wiredBytes + compressedBytes — Activity Monitor's "Memory Used". */
  usedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /** Bytes/second paged in from swap since the previous sample. The thrash signal. */
  swapInRate: number;
  swapOutRate: number;
  /** Uncompressed bytes per byte of compressor. Above ~2 the compressor is working hard. */
  compressionRatio: number;
  /**
   * The kernel's own verdict, when it exposes one: macOS
   * `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical).
   * Null on platforms without it.
   */
  kernelPressure: "normal" | "warn" | "critical" | null;
}

export interface Thresholds {
  watchPercent: number;
  warnPercent: number;
  criticalPercent: number;
  minHeadroomGb: number;
  swapRateMbPerMin: number;
}

export interface Pressure {
  sample: MemorySample;
  level: PressureLevel;
  /** Plain-language cause of the current level, for the banner. */
  reason: string;
  /** Every signal that graded at or above `watch`, worst first. */
  signals: Array<{ level: PressureLevel; detail: string }>;
  thresholds: Thresholds;
}

/* ------------------------------------------------------------------ */
/* Consumers                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a process *is*, which is what decides whether it can be killed.
 *
 * Classification is the whole safety model: a `browser-automation` tree is
 * disposable by definition, an `agent` is someone's work in progress, and
 * `system` is never a candidate no matter how much it holds.
 */
export const PROCESS_KINDS = [
  "agent",
  "pi",
  "browser-automation",
  "dev-server",
  "test-runner",
  "toolchain",
  "container",
  "browser",
  "editor",
  "system",
  "other",
] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Resident set size. Shared pages are counted in every mapper; see `Consumer`. */
  rssBytes: number;
  /** Seconds since the process started, from `ps etime`. */
  ageSeconds: number;
  cpuPercent: number;
  command: string;
  /** argv[0]'s basename, for a short label. */
  name: string;
  user: string;
  kind: ProcessKind;
  /**
   * The project this process belongs to, when the argv or an ancestor pi
   * process's working directory says so. The BB plugin attributed to threads;
   * pi's unit of work is the project a session runs in.
   */
  threadId: string | null;
  /** Dev-server port parsed out of argv, when there is one. */
  port: number | null;
}

/**
 * A process tree rolled up to one row.
 *
 * Ranking individual PIDs is useless when a headless Chrome is 30 renderers
 * and a Next dev server forks a compiler: you get a list of identical `node`
 * rows that each look survivable. Grouping by tree root makes the real unit of
 * decision — "this browser", "this project" — the thing you see and act on.
 */
export interface Consumer {
  id: string;
  label: string;
  detail: string;
  kind: ProcessKind;
  bytes: number;
  processCount: number;
  rootPid: number;
  /** The root's parent. `<= 1` means orphaned: nothing is waiting on it. */
  parentPid: number;
  pids: number[];
  ageSeconds: number;
  cpuPercent: number;
  threadId: string | null;
  threadTitle: string | null;
  port: number | null;
}

/* ------------------------------------------------------------------ */
/* Relief                                                              */
/* ------------------------------------------------------------------ */

export const RISKS = ["safe", "disruptive", "protected"] as const;
export type Risk = (typeof RISKS)[number];

export const ACTIONS = ["terminate", "steer", "throttle", "escalate"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * A proposed intervention, with an id that `relieve` will take.
 *
 * The id is the whole boundary. Nothing downstream of here accepts a PID from
 * a caller — an agent, the CLI and the panel all hand back ids Ballast minted
 * while building this plan, and each one is re-checked against the protected
 * list at the moment it is acted on.
 */
export interface Candidate {
  id: string;
  action: Action;
  risk: Risk;
  label: string;
  /** Why this is safe to do, in one line, for a human reading the plan. */
  rationale: string;
  bytes: number;
  pids: number[];
  kind: ProcessKind;
  threadId: string | null;
  /** Set when the candidate is `protected`: what refused it. */
  refusal: string | null;
}

export interface Plan {
  builtAtMs: number;
  candidates: Candidate[];
  /** Bytes the `safe` tier would return. The number the panel leads with. */
  safeBytes: number;
  disruptiveBytes: number;
}

export interface ReliefItem {
  id: string;
  label: string;
  ok: boolean;
  bytes: number;
  detail: string;
}

export interface ReliefResult {
  dryRun: boolean;
  succeeded: number;
  failed: number;
  bytesFreed: number;
  items: ReliefItem[];
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

export interface GuardEvent {
  id: number;
  atMs: number;
  level: PressureLevel;
  headroomBytes: number;
  usedFraction: number;
  action:
    | "observed"
    | "relieved"
    | "steered"
    | "throttled"
    | "restored"
    | "escalated"
    | "suppressed";
  detail: string;
  bytesFreed: number;
  threadId: string | null;
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export interface HistoryPoint {
  atMs: number;
  usedBytes: number;
  headroomBytes: number;
  swapUsedBytes: number;
  compressedBytes: number;
}

export interface Overview {
  pressure: Pressure;
  consumers: Consumer[];
  threads: Consumer[];
  /** Totals per kind, for the "where it went" band. */
  byKind: Array<{ kind: ProcessKind; bytes: number; count: number }>;
  history: HistoryPoint[];
  events: GuardEvent[];
  plan: Plan | null;
  hostname: string;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const AUTO_RELIEVE = ["off", "safe", "aggressive"] as const;
export type AutoRelieve = (typeof AUTO_RELIEVE)[number];

/** The pause tier only ever touches what the relief gate would authorize. */
export const THROTTLE_MODES = ["off", "safe"] as const;
export type ThrottleMode = (typeof THROTTLE_MODES)[number];

export interface Config {
  thresholds: Thresholds;
  sampleSeconds: number;
  /** Ports whose listener is never touched. Empty by default, by design. */
  protectedPorts: string;
  exemptPatterns: string;
  idleMinutes: number;
  autoRelieve: AutoRelieve;
  /** Pause safe candidates under pressure (SIGSTOP), resume when it clears. */
  throttle: ThrottleMode;
  /** Ask this session (when its project holds memory) to release it. */
  steer: boolean;
  /** Spawn a headless pi to work the relief plan at critical. Off by default. */
  escalate: boolean;
}

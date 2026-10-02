/**
 * Grading a reading into a level.
 *
 * Four independent signals, each graded on its own, and the worst one wins.
 * Percent used is capped at "watch": it measures risk, not harm, and a box
 * holding one large intentional process sits above 90% forever with plenty of
 * headroom and no stalls. Warn and critical come only from headroom, paging
 * rate, or the kernel's own verdict. A single percentage cannot express this:
 * 90% used with 4 GB of clean file cache behind it is fine, and 70% used while
 * paging in 300 MB a minute is not. The reason string always names the signal
 * that decided, because a banner that says "memory is critical" without saying
 * which number moved is an alarm you learn to ignore.
 */
import type { MemorySample, Pressure, PressureLevel, Thresholds } from "./contract";
import { formatBytes, formatPercent, formatRate } from "./format";

// Percent used only ever reaches "watch": a full-but-idle page cache is not
// pressure. warn/critical come from headroom, paging rate and kernel PSI.
export const DEFAULT_THRESHOLDS: Thresholds = {
  watchPercent: 75,
  minHeadroomGb: 3,
  swapRateMbPerMin: 200,
};

const ORDER: Record<PressureLevel, number> = { ok: 0, watch: 1, warn: 2, critical: 3 };

export function worst(a: PressureLevel, b: PressureLevel): PressureLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

interface Signal {
  level: PressureLevel;
  detail: string;
}

/**
 * The used fraction, measured against memory that can actually be handed out.
 *
 * Denominator is total, not total-minus-wired: wired memory is real memory the
 * machine no longer has, and hiding it makes a kernel leak invisible.
 */
export function usedFraction(sample: MemorySample): number {
  if (sample.totalBytes <= 0) return 0;
  return Math.min(1, sample.usedBytes / sample.totalBytes);
}

function gradePercent(sample: MemorySample, thresholds: Thresholds): Signal | null {
  const fraction = usedFraction(sample);
  const percent = fraction * 100;
  const detail = `${formatPercent(fraction, 1)} of ${formatBytes(sample.totalBytes)} in use`;
  if (percent >= thresholds.watchPercent) return { level: "watch", detail };
  return null;
}

/**
 * Absolute headroom, graded separately from the percentage for the same reason
 * Reclaim grades free bytes separately from percent-full: on a 128 GB machine
 * 8% headroom is 10 GB and nothing is wrong, while on a 16 GB machine the same
 * percentage is 1.3 GB and the next Chrome tab is a swap storm.
 */
function gradeHeadroom(sample: MemorySample, thresholds: Thresholds): Signal | null {
  const gb = sample.headroomBytes / 1024 ** 3;
  const floor = Math.max(0.5, thresholds.minHeadroomGb);
  const detail = `${formatBytes(sample.headroomBytes)} headroom before the machine has to page`;
  if (gb <= floor / 3) return { level: "critical", detail };
  if (gb <= floor / 1.5) return { level: "warn", detail };
  if (gb <= floor) return { level: "watch", detail };
  return null;
}

/**
 * Paging rate: the only signal here that measures harm rather than risk.
 *
 * Every other number says the machine *might* struggle. This one says it is
 * already reading memory back off an SSD, which is where interactive latency
 * goes to die. Swap that is merely *resident* is not a problem — pages parked
 * there since yesterday cost nothing — so the grade is on the rate, never on
 * the total.
 */
function gradeSwapRate(sample: MemorySample, thresholds: Thresholds): Signal | null {
  const mbPerMin = (sample.swapInRate * 60) / 1024 ** 2;
  const limit = Math.max(10, thresholds.swapRateMbPerMin);
  const detail = `paging in ${formatRate(sample.swapInRate)} from swap`;
  if (mbPerMin >= limit * 3) return { level: "critical", detail };
  if (mbPerMin >= limit) return { level: "warn", detail };
  if (mbPerMin >= limit / 4) return { level: "watch", detail };
  return null;
}

/** The kernel's own verdict. It outranks our arithmetic when it disagrees. */
function gradeKernel(sample: MemorySample): Signal | null {
  if (sample.kernelPressure === "critical") {
    return { level: "critical", detail: "the kernel reports critical memory pressure" };
  }
  if (sample.kernelPressure === "warn") {
    return { level: "warn", detail: "the kernel reports elevated memory pressure" };
  }
  return null;
}

// Release margin: a level only clears once the signal has recovered this far
// past its line, so a reading hovering on a threshold does not flap the level
// (and every banner, steer and brief that follows it) on each sample.
export const HYSTERESIS = 0.1;
// Percent used is already capped at "watch", so its release margin is fixed
// points rather than a ratio.
export const WATCH_PERCENT_RELEASE_POINTS = 3;

/** The thresholds a signal must clear to step down from a held level. */
function releaseThresholds(thresholds: Thresholds): Thresholds {
  return {
    watchPercent: thresholds.watchPercent - WATCH_PERCENT_RELEASE_POINTS,
    minHeadroomGb: thresholds.minHeadroomGb * (1 + HYSTERESIS),
    swapRateMbPerMin: thresholds.swapRateMbPerMin * (1 - HYSTERESIS),
  };
}

// Kernel PSI is not re-graded for release: avg10 is already smoothed.
function gradeAll(sample: MemorySample, thresholds: Thresholds): Signal[] {
  const signals = [
    gradeKernel(sample),
    gradeHeadroom(sample, thresholds),
    gradeSwapRate(sample, thresholds),
    gradePercent(sample, thresholds),
  ].filter((signal): signal is Signal => signal !== null);
  return signals.sort((a, b) => ORDER[b.level] - ORDER[a.level]);
}

function levelOf(signals: Signal[]): PressureLevel {
  return signals.length === 0 ? "ok" : signals[0].level;
}

/**
 * Escalation is immediate. De-escalation is held: when the raw level is below
 * `previous`, the level only drops as far as the release-threshold grading
 * allows, and never below the raw level.
 */
export function evaluatePressure(
  sample: MemorySample,
  thresholds: Thresholds,
  previous: PressureLevel | null = null,
): Pressure {
  const rawSignals = gradeAll(sample, thresholds);
  const raw = levelOf(rawSignals);
  let signals = rawSignals;
  let level = raw;
  let holding = false;

  if (previous !== null && ORDER[raw] < ORDER[previous]) {
    const held = gradeAll(sample, releaseThresholds(thresholds));
    const heldLevel = levelOf(held);
    level = ORDER[heldLevel] < ORDER[previous] ? heldLevel : previous;
    holding = level !== raw;
    if (holding) signals = held;
  }

  const reason =
    signals.length === 0
      ? `${formatBytes(sample.headroomBytes)} headroom, no swap activity`
      : holding
        ? `${signals[0].detail} (holding until clear)`
        : signals[0].detail;

  return { sample, level, reason, signals, thresholds };
}

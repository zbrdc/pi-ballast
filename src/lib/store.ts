/**
 * What Ballast keeps between samples.
 *
 * Almost nothing, deliberately. Memory is a live quantity — the process table
 * is re-read every sample and never cached — so the only things worth
 * persisting are the two that would otherwise be lost across a reload: a
 * downsampled history so the chart survives a restart, and the guard's own
 * activity log, which is the record of every automatic decision the plugin
 * made on the user's behalf.
 *
 * The BB plugin kept this in sqlite. A pi extension runs in-process with the
 * agent, so a JSON file under ~/.pi/agent does the same job with no native
 * dependency: one parse on load, one debounced write on change.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GuardEvent, HistoryPoint, MemorySample, PressureLevel } from "./contract";

/** Six hours at a ten-second sample. Enough to see a build tip the machine over. */
const HISTORY_RETENTION_MS = 6 * 3_600_000;
const EVENT_RETENTION = 500;
/** Flush at most this often; the exit handler flushes whatever remains. */
const FLUSH_DEBOUNCE_MS = 5_000;

interface StoreFile {
  meta: Record<string, unknown>;
  samples: Array<{
    atMs: number;
    usedBytes: number;
    headroomBytes: number;
    swapUsedBytes: number;
    compressedBytes: number;
  }>;
  guardEvents: Array<Omit<GuardEvent, "id"> & { id: number }>;
  nextEventId: number;
}

const EMPTY: StoreFile = { meta: {}, samples: [], guardEvents: [], nextEventId: 1 };

/**
 * In-memory state backed by a JSON file, written atomically.
 *
 * Writes are debounced, not synchronous — losing the last few seconds of
 * samples to a crash is fine; corrupting the file with a torn write is not.
 */
export class Store {
  private readonly file: StoreFile = structuredClone(EMPTY);
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private lastPruneMs = 0;

  // Explicit field: node --experimental-strip-types (the test runner) cannot
  // parse TypeScript parameter properties.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return; // first run — nothing to load
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoreFile>;
      this.file.meta = parsed.meta ?? {};
      this.file.samples = parsed.samples ?? [];
      this.file.guardEvents = parsed.guardEvents ?? [];
      this.file.nextEventId = parsed.nextEventId ?? this.file.guardEvents.length + 1;
    } catch {
      // A corrupt file is a bad surprise, not a catastrophe — start empty.
    }
  }

  getMeta<T>(key: string): T | null {
    const value = this.file.meta[key];
    return value === undefined ? null : (value as T);
  }

  setMeta(key: string, value: unknown): void {
    this.file.meta[key] = value;
    this.scheduleFlush();
  }

  deleteMeta(key: string): void {
    delete this.file.meta[key];
    this.scheduleFlush();
  }

  /**
   * Retention is swept on a timer, not on every insert.
   *
   * The sweep costs more than the insert it would accompany, and running it
   * every sample would mean a scan-and-drop every few seconds to remove rows
   * that are only expiring once an hour. Sweeping every ten minutes bounds the
   * array just as well.
   */
  recordSample(sample: MemorySample): void {
    this.file.samples.push({
      atMs: sample.atMs,
      usedBytes: sample.usedBytes,
      headroomBytes: sample.headroomBytes,
      swapUsedBytes: sample.swapUsedBytes,
      compressedBytes: sample.compressedBytes,
    });
    const now = Date.now();
    if (now - this.lastPruneMs > 600_000) {
      this.lastPruneMs = now;
      const cutoff = now - HISTORY_RETENTION_MS;
      this.file.samples = this.file.samples.filter((s) => s.atMs >= cutoff);
    }
    this.scheduleFlush();
  }

  /**
   * History for the chart, thinned to a target point count.
   *
   * Six hours of ten-second samples is 2160 points for a chart a few dozen
   * columns wide. Taking every nth row keeps the shape without shipping
   * twenty times more data than the panel can draw.
   */
  history(limit = 240): HistoryPoint[] {
    const total = this.file.samples.length;
    const stride = Math.max(1, Math.ceil(total / limit));
    const out: HistoryPoint[] = [];
    for (let i = stride - 1; i < total; i += stride) {
      const s = this.file.samples[i];
      out.push({
        atMs: s.atMs,
        usedBytes: s.usedBytes,
        headroomBytes: s.headroomBytes,
        swapUsedBytes: s.swapUsedBytes,
        compressedBytes: s.compressedBytes,
      });
    }
    return out;
  }

  recordGuardEvent(event: Omit<GuardEvent, "id">): void {
    this.file.guardEvents.push({ ...event, id: this.file.nextEventId++ });
    if (this.file.guardEvents.length > EVENT_RETENTION) {
      this.file.guardEvents.splice(0, this.file.guardEvents.length - EVENT_RETENTION);
    }
    this.scheduleFlush();
  }

  events(limit = 50): GuardEvent[] {
    return this.file.guardEvents
      .slice(-limit)
      .reverse()
      .map((e) => ({ ...e, level: e.level as PressureLevel }));
  }

  /** Stop the debouncer and persist immediately. Call on session shutdown. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.writing;
    this.writing = this.write();
    await this.writing;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writing = this.write();
    }, FLUSH_DEBOUNCE_MS);
  }

  /** Write-via-rename so a crash mid-write never leaves a torn file. */
  private async write(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = join(dirname(this.path), `.${Math.random().toString(36).slice(2)}.tmp`);
      await writeFile(tmp, JSON.stringify(this.file), "utf8");
      await rename(tmp, this.path);
    } catch {
      // Read-only home or a vanished directory: in-memory state still works.
    }
  }
}

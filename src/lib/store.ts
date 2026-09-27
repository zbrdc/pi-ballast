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

/**
 * An event's identity, for the multi-process merge. Not its id: ids are
 * per-process counters, so two sessions both number their first event 1 and
 * dedup-by-id would delete one of them on write.
 */
const eventKey = (event: { atMs: number; action: string; detail: string }): string =>
  `${event.atMs}:${event.action}:${event.detail}`;

const EMPTY: StoreFile = { meta: {}, samples: [], guardEvents: [], nextEventId: 1 };

/**
 * In-memory state backed by a JSON file, written atomically.
 *
 * Writes are debounced, not synchronous — losing the last few seconds of
 * samples to a crash is fine; corrupting the file with a torn write is not.
 */
export class Store {
  private file: StoreFile = structuredClone(EMPTY);
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private lastPruneMs = 0;
  /**
   * Meta keys changed since the last write, with null meaning deleted. The
   * merge writes only these, so a process that loaded the file an hour ago
   * cannot push its stale copy of a key over a value another process just
   * set. Cleared once the write lands.
   */
  private dirty = new Map<string, unknown | null>();

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
    this.dirty.set(key, value);
    this.scheduleFlush();
  }

  deleteMeta(key: string): void {
    delete this.file.meta[key];
    this.dirty.set(key, null);
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

  /**
   * Write-via-rename so a crash mid-write never leaves a torn file.
   *
   * The read before it is the multi-process part. Every pi process on the
   * machine loads this extension — sessions, sub-agents, headless children —
   * and a blind whole-file write would let a quiet panel action discard the
   * guard's sample history. So the on-disk copy is merged with what changed
   * here rather than replaced: samples are append-only by timestamp, events
   * by content, and meta is keyed so a writer only claims the keys it set.
   */
  private async write(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const file = await this.merged();
      const tmp = join(dirname(this.path), `.${Math.random().toString(36).slice(2)}.tmp`);
      await writeFile(tmp, JSON.stringify(file), "utf8");
      await rename(tmp, this.path);
      this.file = file;
      this.dirty.clear();
    } catch {
      // Read-only home or a vanished directory: in-memory state still works.
    }
  }

  /** Our view plus anything another process wrote since we loaded. */
  private async merged(): Promise<StoreFile> {
    let theirs: Partial<StoreFile> | null = null;
    try {
      theirs = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoreFile>;
    } catch {
      // first run, or a file we cannot parse — ours stands
    }
    if (theirs === null) return this.file;
    const samples = [...(theirs.samples ?? []), ...this.file.samples]
      .filter((s) => s.atMs >= Date.now() - HISTORY_RETENTION_MS)
      .sort((a, b) => a.atMs - b.atMs);
    // Ids are per-process counters, so two processes both start at 1 and
    // dedup-by-id would throw away a live event. Identity is the event's
    // content; ids are renumbered once the merged list is whole, which is
    // also what makes them usable as unique keys in the file.
    const events = [...(theirs.guardEvents ?? []), ...this.file.guardEvents]
      .filter((e, i, all) => all.findIndex((other) => eventKey(other) === eventKey(e)) === i)
      .sort((a, b) => a.atMs - b.atMs)
      .slice(-EVENT_RETENTION)
      .map((e, index) => ({ ...e, id: index + 1 }));
    const meta: Record<string, unknown> = { ...(theirs.meta ?? {}) };
    for (const [key, value] of this.dirty) {
      if (value === null) delete meta[key];
      else meta[key] = value;
    }
    return {
      meta,
      samples,
      guardEvents: events,
      // Events were renumbered 1..n above, so that is where the next id goes.
      nextEventId: events.length + 1,
    };
  }
}

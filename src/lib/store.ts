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
 * SQLite, via node:sqlite. This started as a JSON file, on the reasoning that
 * a pi extension runs in-process and one 27K parse is free — which is true of
 * one session and false of a fleet. Every session, sub-agent and headless
 * child loads this extension, so N processes write one file, and a
 * read-merge-write with no lock between them loses writes: measured at ten
 * writers, half the config keys vanished and 60 flushes ballooned the sample
 * list to 700,000 rows. node:sqlite is built into Node (no npm dependency, no
 * experimental warning) and its writes are atomic across processes, so needing
 * it let the whole hand-rolled merge go. The database is the concurrency
 * story now, not a layer of code defending against itself.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { GuardEvent, HistoryPoint, PressureLevel } from "./contract";

/** Six hours at a ten-second sample. Enough to see a build tip the machine over. */
const HISTORY_RETENTION_MS = 6 * 3_600_000;
const EVENT_RETENTION = 500;

export class Store {
  // Definite assignment: the constructor opens the database synchronously.
  private db!: DatabaseSync;
  private lastPruneMs = 0;
  /** Set once the legacy JSON config has been taken, so it is never re-read. */
  private static readonly IMPORTED = "legacy-json-imported";

  // Explicit field: node --experimental-strip-types (the test runner) cannot
  // parse TypeScript parameter properties.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.open();
  }

  /**
   * Kept for the Engine's async load contract. The database opens in the
   * constructor because node:sqlite is synchronous — there was never a reason
   * to defer it, and deferring silently turned every write issued before
   * load() into a no-op.
   */
  async load(): Promise<void> {}

  private open(): void {
    this.db = new DatabaseSync(this.path);
    // busy_timeout FIRST, in its own statement. Switching journal modes needs
    // an exclusive lock, and that one statement does not honour a timeout
    // that has not been set yet — so with ten-plus sessions opening at once
    // it threw "database is locked" and the losing process died before it
    // could retry. Set the timeout, then switch.
    this.db.exec("PRAGMA busy_timeout = 5000");
    // WAL is what makes concurrent processes safe rather than merely
    // serialized: a reader never blocks the writer that is the leader taking a
    // sample.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        atMs            INTEGER PRIMARY KEY,
        usedBytes       INTEGER NOT NULL,
        headroomBytes   INTEGER NOT NULL,
        swapUsedBytes   INTEGER NOT NULL,
        compressedBytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        atMs       INTEGER NOT NULL,
        level      TEXT,
        action     TEXT    NOT NULL,
        detail     TEXT    NOT NULL,
        bytesFreed INTEGER NOT NULL,
        threadId   TEXT
      );
      CREATE INDEX IF NOT EXISTS events_at ON events (atMs);
    `);
    this.importLegacy();
  }

  /**
   * One-time import from the JSON file this store used to be.
   *
   * Only `config` is worth carrying over: it holds settings the user chose —
   * autoRelieve, throttle, steer, protected ports — and re-typing those is
   * worse than losing a chart. The sample history is disposable (six hours of
   * a live quantity, and the guard is running again long before anyone looks)
   * so it stays behind. The old file is left on disk untouched, in case
   * something here is wrong.
   */
  private importLegacy(): void {
    if (this.getMeta(Store.IMPORTED) !== null) return;
    this.setMeta(Store.IMPORTED, true);
    const legacy = this.path.replace(/\.db$/, ".json");
    if (legacy === this.path) return; // tests use .json paths; nothing to migrate

    let parsed: { meta?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(legacy, "utf8")) as { meta?: Record<string, unknown> };
    } catch {
      // No legacy file, or unreadable. A fresh database is the correct
      // starting state, not a failure worth surfacing.
      return;
    }
    for (const [key, value] of Object.entries(parsed.meta ?? {})) {
      this.setMeta(key, value);
    }
  }

  /**
   * Values are read from the database on every call rather than cached. The
   * cache was the bug: a process that loaded an hour ago would answer with an
   * hour-old value, and its next write would push that stale value back over
   * whatever the guard had decided since. There is no cache to invalidate.
   */
  getMeta<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      // A value written by an older version. Not worth failing a status read
      // over: report it as absent.
      return null;
    }
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  /**
   * Set a cooldown, but only if the previous one has expired — decided in one
   * statement so the database picks the winner.
   *
   * This exists because steer runs in every session, not just the leader: two
   * TUI sessions standing in the same project both match the holding thread,
   * and read-then-write let both of them see an expired cooldown and both
   * send. The condition lives inside the upsert, so exactly one caller gets
   * true and the rest are told no. `changes` is the verdict; there is no
   * window between the test and the write.
   *
   * A missing key, or one written by an older version as something that is
   * not a timestamp, casts to 0 and is therefore claimable — which is the
   * right answer for a cooldown nobody set.
   */
  claimCooldown(key: string, now: number, windowMs: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value
         WHERE CAST(meta.value AS INTEGER) < ?`,
      )
      .run(key, JSON.stringify(now), now - windowMs);
    return result.changes > 0;
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /**
   * Keyed by timestamp, so a fleet's redundant samples of the same millisecond
   * collapse into one row instead of stacking up. This is the whole reason the
   * samples are a table and not an array.
   */
  recordSample(sample: {
    atMs: number;
    usedBytes: number;
    headroomBytes: number;
    swapUsedBytes: number;
    compressedBytes: number;
  }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO samples (atMs, usedBytes, headroomBytes, swapUsedBytes, compressedBytes) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        sample.atMs,
        sample.usedBytes,
        sample.headroomBytes,
        sample.swapUsedBytes,
        sample.compressedBytes,
      );

    // Retention is swept on a timer, not on every insert. The sweep costs
    // more than the insert it would accompany, and running it per sample would
    // mean a delete every few seconds to drop rows that are expiring once an
    // hour.
    const now = Date.now();
    if (now - this.lastPruneMs > 600_000) {
      this.lastPruneMs = now;
      this.db.prepare("DELETE FROM samples WHERE atMs < ?").run(now - HISTORY_RETENTION_MS);
      this.db
        .prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)")
        .run(EVENT_RETENTION);
    }
  }

  /**
   * History for the chart, thinned to a target point count.
   *
   * Six hours of ten-second samples is 2160 points for a chart a few dozen
   * columns wide. Taking every nth row keeps the shape without shipping
   * twenty times more data than the panel can draw.
   */
  history(limit = 240): HistoryPoint[] {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM samples").get() as { n: number }).n;
    if (total === 0) return [];
    const stride = Math.max(1, Math.ceil(total / limit));
    const rows = this.db
      .prepare(
        "SELECT atMs, usedBytes, headroomBytes, swapUsedBytes, compressedBytes FROM samples ORDER BY atMs",
      )
      .all() as Array<{
      atMs: number;
      usedBytes: number;
      headroomBytes: number;
      swapUsedBytes: number;
      compressedBytes: number;
    }>;
    const out: HistoryPoint[] = [];
    for (let i = stride - 1; i < rows.length; i += stride) {
      const s = rows[i];
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
    this.db
      .prepare(
        "INSERT INTO events (atMs, level, action, detail, bytesFreed, threadId) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.atMs,
        event.level ?? null,
        event.action,
        event.detail,
        event.bytesFreed,
        event.threadId,
      );
  }

  events(limit = 50): GuardEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, atMs, level, action, detail, bytesFreed, threadId FROM events ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as Array<Omit<GuardEvent, "id"> & { id: number; level: string | null }>;
    return rows.map((e) => ({ ...e, level: e.level as PressureLevel }));
  }

  /**
   * Kept for the shutdown path and the tests. A SQLite write lands with its
   * statement, so there is nothing buffered to push — the debounce existed to
   * spare a JSON serialize, and it left with the rest of the merge.
   */
  async flush(): Promise<void> {}
}

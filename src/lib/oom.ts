/**
 * Kernel OOM-kill detection.
 *
 * Pressure grades say the machine is tight; they never say something already
 * died. When the kernel kills a process, the agent's next command exits 137
 * and nothing explains why. The kernel logs every kill, so the journal is the
 * source of truth — read through journalctl, no shell, and never fatal: a
 * missing binary or an unreadable journal just means "no kills known".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatBytes } from "./format";

const run = promisify(execFile);

export interface OomKill {
  atMs: number;
  pid: number;
  name: string;
  /** Anonymous RSS at kill time, when the kernel line carried it. */
  rssBytes?: number;
}

/**
 * Both kernel forms: "Out of memory: Killed process …" (global) and
 * "Memory cgroup out of memory: Killed process …" (container/cgroup limit).
 * The name is argv[0] truncated by the kernel, so it may itself hold parens.
 */
const KILL_RE = /out of memory[^:]*: killed process (\d+) \((.*?)\)(?: total-vm:|,|\s|$)/i;
const ANON_RSS_RE = /anon-rss:(\d+)kB/;

/** Parses one `journalctl -k -o json` line; null when it is not an OOM kill. */
export function parseOomLine(line: string): OomKill | null {
  let entry: { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: unknown };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  // journald encodes non-UTF-8 messages as byte arrays; none of ours are.
  if (typeof entry.MESSAGE !== "string") return null;
  const match = KILL_RE.exec(entry.MESSAGE);
  if (match === null) return null;
  const micros = Number(entry.__REALTIME_TIMESTAMP);
  if (!Number.isFinite(micros)) return null;
  const kill: OomKill = { atMs: Math.floor(micros / 1000), pid: Number(match[1]), name: match[2] };
  const rss = ANON_RSS_RE.exec(entry.MESSAGE);
  if (rss !== null) kill.rssBytes = Number(rss[1]) * 1024;
  return kill;
}

/** Kernel kills logged at or after `sinceMs`, oldest first. Never throws. */
export async function readOomKills(sinceMs: number): Promise<OomKill[]> {
  const since = `@${Math.max(0, Math.floor(sinceMs / 1000))}`;
  try {
    const { stdout } = await run(
      "journalctl",
      ["-k", "-o", "json", "--since", since, "-q", "--no-pager"],
      { timeout: 5000, maxBuffer: 8 * 1024 ** 2 },
    );
    return stdout
      .split("\n")
      .map(parseOomLine)
      .filter((kill): kill is OomKill => kill !== null && kill.atMs >= sinceMs);
  } catch {
    return [];
  }
}

const DETAIL_SUFFIX = "killed by the kernel OOM killer";
const DETAIL_RE = /^(.*) \(pid (\d+)(?:, [^)]*)?\) killed by the kernel OOM killer$/;

/** The event-log text for a kill; `parseOomDetail` reads it back. */
export function oomDetail(kill: OomKill): string {
  const size = kill.rssBytes === undefined ? "" : `, ${formatBytes(kill.rssBytes)}`;
  return `${kill.name} (pid ${kill.pid}${size}) ${DETAIL_SUFFIX}`;
}

/** Recovers name and pid from an "oom-killed" event's detail. */
export function parseOomDetail(detail: string): { name: string; pid: number } | null {
  const match = DETAIL_RE.exec(detail);
  return match === null ? null : { name: match[1], pid: Number(match[2]) };
}

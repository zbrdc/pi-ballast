# pi-ballast

Memory pressure monitoring and relief for [pi](https://github.com/earendil-works/pi-coding-agent) — a port of [bb-plugin-ballast](https://github.com/braedonsaunders/bb-plugin-ballast), with the web dashboard replaced by a TUI.

## What it does

Watches physical memory, attributes it to process trees and projects, and when the machine is genuinely struggling, stops the things it can prove nobody is waiting on — orphaned dev servers, leaked headless browsers, dead test runners. Nothing else.

- **Headroom, not "% used"** — free + clean file cache + purgeable, plus paging *rates*. A machine at 90% used with 6 GB of cache is healthy; 400 MB of headroom while paging in is not.
- **Two-tier guard** — cheap memory samples every cycle, expensive process-table walk only under pressure. A healthy machine is polled 6× less often.
- **Refuse-by-default relief** — only four kinds are ever killable (headless browsers, dev servers, test runners, build tools), only when orphaned or provably idle, never anything younger than a minute, on a protected port, owned by another user, or part of an agent's own tree. Candidates are re-authorized against the live table at kill time — a recycled PID is refused, not killed.

## Install

```bash
pi install npm:pi-ballast
```

## Use

| | |
|---|---|
| `/ballast` | The dashboard: pressure, top consumers, by project, relief plan, activity trail. `k` stops the selected candidate, `s` cycles auto-relieve. |
| `ballast_status` | Current pressure level and per-signal detail (agent tool). |
| `ballast_consumers` | What is holding memory, grouped by tree and by project. |
| `ballast_plan` | Relief candidates with safe/disruptive risk. Kills nothing. |
| `ballast_relieve` | Stops candidates by id, with `dryRun` first. |

A `ballast` skill teaches the agent when to reach for these instead of `top`.

## Configure

`~/.pi/agent/ballast-state.json` holds state (samples, guard events) and config:

```json
{
  "config": {
    "thresholds": { "watchPercent": 75, "warnPercent": 85, "criticalPercent": 92, "minHeadroomGb": 3, "swapRateMbPerMin": 200 },
    "sampleSeconds": 10,
    "protectedPorts": "3000, 5173",
    "exemptPatterns": "do-not-touch",
    "idleMinutes": 30,
    "autoRelieve": "off"
  }
}
```

`autoRelieve`: `off` (default — you or the agent decide), `safe` (guard stops safe candidates at critical), `aggressive` (adds disruptive candidates).

## Platform support

macOS and Linux (reads `vm_stat`/`sysctl` or `/proc/meminfo`/`/proc/vmstat`).

## Dev

```bash
pnpm install --ignore-workspace
pnpm test        # 47 tests, node --test over stripped types
pnpm typecheck   # tsc --noEmit
```

## License

MIT, same as the original.

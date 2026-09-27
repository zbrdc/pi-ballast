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
| `/ballast` | The dashboard: pressure, top consumers, by project, relief plan, activity trail. `k` stops the selected candidate, `s` cycles auto-relieve. The header shows every rung's configured state. |
| `ballast_status` | Current pressure level and per-signal detail (agent tool). |
| `ballast_consumers` | What is holding memory, grouped by tree and by project. |
| `ballast_plan` | Relief candidates with safe/disruptive risk. Kills nothing. |
| `ballast_relieve` | Stops candidates by id, with `dryRun` first. |

A `ballast` skill teaches the agent when to reach for these instead of `top`.

## How the guard acts

A background guard samples memory and grades pressure (`watch` → `warn` → `critical`). When pressure is elevated it climbs a ladder, in order of what an action costs — each rung independently switchable, each with its own cooldown:

1. **Throttle** (`throttle`) — pauses what the relief gate would authorize (`SIGSTOP`), one wave per episode; resumes automatically (`SIGCONT`) when pressure clears or the session exits. Reversible: stopped work loses nothing. Runs at `warn` and above.
2. **Steer** (`steer`) — sends one message into the session standing in the project that holds ≥256 MB, asking it to close browsers and stop dev servers. Ten-minute cooldown; interactive sessions only.
3. **Relieve** (`autoRelieve`) — stops authorized candidates (`safe`, or `safe` + `disruptive` when `aggressive`) at `critical` (`warn` when `aggressive`). Two-minute cooldown. Re-derives targets from the live process table, so a recycled pid is never killed by a stale plan.
4. **Escalate** (`escalate`) — spawns a headless `pi -p` with the ballast tools to work the relief plan when the machine is still `critical`. Never fires while a relief wave is landing or when the plan carries nothing actionable. Twenty-minute cooldown.

Everything destructive stays off by default. Escalation is the rung of record when `autoRelieve` is `off`: nothing dies unattended — something reasons instead.

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
    "autoRelieve": "off",
    "throttle": "safe",
    "steer": true,
    "escalate": false
  }
}
```

`autoRelieve`: `off` (default — you or the agent decide), `safe` (guard stops safe candidates at critical), `aggressive` (adds disruptive candidates).
`throttle`: `off` (default) or `safe` — pause authorized candidates at `warn` and above, resume on clear.
`steer`: `true` (default) — message the session holding the memory before anything dies.
`escalate`: `false` (default) — spawn a headless pi to work the plan when critical persists past relief's cadence.

## Platform support

macOS and Linux (reads `vm_stat`/`sysctl` or `/proc/meminfo`/`/proc/vmstat`).

## Dev

```bash
pnpm install --ignore-workspace
pnpm test        # 81 tests, node --test over stripped types
pnpm typecheck   # tsc --noEmit
```

## License

MIT, same as the original.

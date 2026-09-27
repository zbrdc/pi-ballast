---
name: ballast
description: "Diagnose and relieve physical memory pressure on this machine. Use when a build or test run is killed, a command hangs or crawls, the machine starts paging, the user asks what is eating their RAM, or the user mentions the /ballast dashboard."
---

# Memory pressure

Ballast reads physical memory and attributes it to process trees and projects.
Use its tools instead of `top`, `vm_stat`, `ps` or `memory_pressure`.

## Read the numbers first

`ballast_status` reports used, headroom, swap, compression, and the largest
consumers grouped by tree and by project.

The number that matters is **headroom** — free plus clean file cache plus
purgeable — not "% used". A machine at 90% used with 6 GB of cached files is
healthy; the same machine with 400 MB of headroom and a non-zero paging rate is
in trouble. `memory_pressure`'s "free percentage" is not a substitute: it counts
inactive pages as free and stays reassuring while the machine swaps.

`paging in` above zero means the machine is already reading memory back off
disk. That is the signal to act on. Swap that is merely *resident* is not —
pages parked there since yesterday cost nothing.

## Relieve it

1. `ballast_plan` lists candidates with ids, graded `safe` or `disruptive`, plus
   anything refused and why.
2. `ballast_relieve` with `dryRun: true`, check the total, then apply.
3. Take `disruptive` candidates only when nothing else gets headroom above the
   threshold, and say which ones you took.

The `/ballast` command shows the same dashboard the user sees — pressure,
consumers, projects, plan, and the guard's activity trail.

## The guard's rungs

A background guard also acts on its own when pressure is elevated, in this
order: **throttle** (pauses authorized candidates with `SIGSTOP`, resumes them
when pressure clears), **steer** (messages the session holding the memory),
**relieve** (kills — only if `autoRelieve` is configured), **escalate** (spawns
a headless `pi` to work the plan when critical persists).

Before diagnosing a hung or stopped build as broken, check the activity trail:
the throttle rung may have paused it, and it will resume on its own when
pressure clears. A paused process is not a corpse — do not kill or restart it.
An unattended `pi -p` process running ballast tools is the escalation rung at
work, not a stray agent to clean up.

## The boundary

`ballast_relieve` takes only ids that `ballast_plan` minted, and re-checks each
one against the live process table before signalling it — a recycled PID is
refused, not killed.

It will only ever stop four kinds of process — headless browsers, dev servers,
test runners and build tools — and only when nothing can still be waiting on
them. In practice that means **orphaned**: reparented to init, so whatever
launched it is gone. The one exception is a headless browser idle at no CPU
past the configured window, which is the ordinary shape of a leak from a
finished suite.

Idle alone is never enough for anything else. A process with a live parent is
being held by it, and a build tool or language server sitting at 0% CPU is a
worker waiting for its next request, not a corpse.

Agents, pi itself, editors, interactive browsers, containers, system processes,
anything owned by another user, anything younger than a minute, anything on a
protected port, and anything it could not confidently classify are refused by
construction.

Do not use `kill`, `pkill` or `killall` to work around that boundary. If you
need memory from something the gate protects, tell the user what is holding it
and let them decide.

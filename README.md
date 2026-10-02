# pi-ballast

pi-ballast monitors physical memory pressure and process memory use in [pi](https://github.com/earendil-works/pi-coding-agent). It groups processes by tree and project, and can pause or stop a limited set of candidates. This is a pi-only port of [bb-plugin-ballast](https://github.com/braedonsaunders/bb-plugin-ballast); it does not need BB.

## Requirements

- pi
- macOS or Linux
- Node.js 22.5 or later (`node:sqlite` is built in)

## Install

```sh
pi install npm:pi-ballast
```

## Use

Run `/ballast` for the TUI panel. Use the arrow keys to select a candidate, `k` to stop it, `s` to cycle automatic relief, and `q` to close the panel. Outside the TUI, `/ballast` prints the current pressure.

While pressure is above `ok`, the footer status line shows the level, free memory, and the largest consumer, for example `ballast: WARN 2.10 GB free · strata 43.0 GB`.

The agent tools are:

- `ballast_status` — pressure level and the signals behind it.
- `ballast_consumers` — largest process trees and projects.
- `ballast_plan` — candidates and their risk. This does not stop anything.
- `ballast_relieve` — stop candidates by id. Use `dryRun: true` to check first.

## Guard

One pi process is elected to run the machine-wide actions. Other sessions still sample memory and serve tools and the panel. A session only sends a steer message when its project holds the memory; this works even when that session is not the elected leader. Only the leader resumes its own paused pids on shutdown, so a follower exiting cannot undo another session's throttle.

The guard acts in this order:

1. **Throttle** (`off` by default): pause safe candidates with `SIGSTOP` at `warn` or higher. Resume them with `SIGCONT` when pressure clears or the leader exits.
2. **Steer** (on by default): at `warn` or higher, tell a TUI session to stop browser automation, dev servers, or test runners it started, naming each one. It fires only when those processes add up to at least 1 GiB; pi itself, editors, and agents never count. The note arrives as an extension message, not as a user message. Ten-minute cooldown.
3. **Relieve** (`autoRelieve: off` by default): at `critical`, stop safe candidates; `aggressive` also permits disruptive candidates and starts at `warn`. Two-minute cooldown.
4. **Escalate** (`off` by default): at `critical`, start a headless pi to work an actionable plan. It waits for a recent relief wave to finish. Twenty-minute cooldown.

A candidate is rechecked against the live process table before a signal is sent. Editors, interactive browsers, agents, pi itself, other users' processes, protected ports, and processes younger than one minute are not stopped.

At `warn` or `critical`, the model receives a short, automatic status note: free memory and swap-in rate, the largest consumer, how many parallel build or test jobs the headroom allows (about 2 GiB each), and any recent kernel OOM kills. The note goes out when the level changes or a new OOM kill appears, and at most every 10 minutes while nothing changes; `watch` alone sends nothing. The note is request-local and does not become part of the conversation history.

### Pressure levels

- `watch`: memory is at least 75% used. Percent used on its own never goes above `watch`; a large, steady model server is not an emergency.
- `warn` and `critical`: free memory under the 3 GB floor, a high swap-in rate, or kernel memory pressure (PSI on Linux, `kern.memorystatus_vm_pressure_level` on macOS).
- Levels go up at once. To drop a level, free memory must be 10% past its line, the swap-in rate 10% under its limit, or percent used 3 points under `watch`.
- On Linux, ballast also reads kernel OOM kills from `journalctl -k`, so a command that exited 137 has an explanation.

## Configure

Edit settings from pi:

```text
/ballast config                          # print the effective config
/ballast config throttle safe            # set a key
/ballast config thresholds.watchPercent 80
/ballast exempt strata                   # never touch processes matching this pattern
```

Values are type-checked against the defaults, and settings with a fixed set of values (`throttle`, `autoRelieve`) reject anything else. State and configuration live in `~/.pi/agent/ballast-state.db`, a SQLite database using Node's built-in `node:sqlite`.

Defaults: `autoRelieve: off`, `throttle: off`, `steer: true`, `escalate: false`; watch at 75% used; warn/critical come from headroom (3 GB minimum), swap-in rate, and kernel memory pressure.

## Develop

```sh
pnpm install --ignore-workspace
pnpm test
pnpm typecheck
```

## Source and license

MIT. See the [BB original](https://github.com/braedonsaunders/bb-plugin-ballast) for the web version.

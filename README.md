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

Run `/ballast` for the TUI panel. Use the arrow keys to select a candidate, `k` to stop it, `s` to cycle automatic relief, and `q` to close the panel.

The agent tools are:

- `ballast_status` — pressure level and the signals behind it.
- `ballast_consumers` — largest process trees and projects.
- `ballast_plan` — candidates and their risk. This does not stop anything.
- `ballast_relieve` — stop candidates by id. Use `dryRun: true` to check first.

## Guard

One pi process is elected to run the machine-wide actions. Other sessions still sample memory and serve tools and the panel. A session only sends a steer message when its project holds the memory; this works even when that session is not the elected leader. Only the leader resumes its own paused pids on shutdown, so a follower exiting cannot undo another session's throttle.

The guard acts in this order:

1. **Throttle** (`off` by default): pause safe candidates with `SIGSTOP` at `warn` or higher. Resume them with `SIGCONT` when pressure clears or the leader exits.
2. **Steer** (on by default): at `warn` or higher, ask the matching TUI session to close browsers or dev servers it started. Ten-minute cooldown.
3. **Relieve** (`autoRelieve: off` by default): at `critical`, stop safe candidates; `aggressive` also permits disruptive candidates and starts at `warn`. Two-minute cooldown.
4. **Escalate** (`off` by default): at `critical`, start a headless pi to work an actionable plan. It waits for a recent relief wave to finish. Twenty-minute cooldown.

A candidate is rechecked against the live process table before a signal is sent. Editors, interactive browsers, agents, pi itself, other users' processes, protected ports, and processes younger than one minute are not stopped.

While pressure is elevated, each model request also receives a short, automatic status note with the latest headroom and paging rate. The note is request-local and does not become part of the conversation history.

## Configure

State and configuration live in `~/.pi/agent/ballast-state.db`, a SQLite database using Node's built-in `node:sqlite`. The `config` row is JSON. After pi-ballast has created the database, this command enables the safe throttle:

```sh
sqlite3 ~/.pi/agent/ballast-state.db \
  "INSERT INTO meta(key,value) VALUES('config','{}') ON CONFLICT(key) DO NOTHING;
   UPDATE meta SET value=json_set(value,'$.throttle','safe') WHERE key='config';"
```

Defaults: `autoRelieve: off`, `throttle: off`, `steer: true`, `escalate: false`; watch at 75% used; warn/critical come from headroom (3 GB minimum), swap-in rate, and kernel PSI.

## Develop

```sh
pnpm install --ignore-workspace
pnpm test
pnpm typecheck
```

## Source and license

MIT. See the [BB original](https://github.com/braedonsaunders/bb-plugin-ballast) for the web version.

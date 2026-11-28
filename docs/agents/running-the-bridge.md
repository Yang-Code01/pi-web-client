# Running the bridge

The bridge is the process behind `http://127.0.0.1:7864` — it serves `web/dist`, speaks WS, and spawns one `pi --mode rpc` child per session. A human usually starts it by hand in a terminal, so the pid you find is **their** process, not yours.

Since #634 (D407) it is **two** processes:

- **壳 (shell)** — `bridge/dist/host.js`. Owns the public port, owns every session's three pipes, keeps the unacked line buffer and the usage ledger. It does not interpret the protocol; it moves bytes and forwards HTTP/WS.
- **脑 (brain)** — `bridge/dist/index.js`, the old bridge. Listens on an internal loopback port the shell assigned, talks to the shell over a control channel (named pipe / UDS), and exits when that channel closes.

`npm start` / `start:nobuild` / the watchdog / `restart.mjs` all start `host.js` (see `scripts/start.mjs`). `PI_HOST_DISABLE=1` starts `index.js` the old way — that is the escape hatch when you need to know whether a problem is in the shell or the brain.

What this buys: a hot deploy swaps only the brain. Pi's pid, the pipes and the running turn survive, the page reconnects on its own. If the shell's own code changed, a brain swap is not enough: the panel says so before you click, the run builds, then stops and asks for a group restart (see *Restarting it*).

```bash
curl -s http://127.0.0.1:7864/healthz   # pid = 壳; brain.pid / brain.ready = 脑
curl -s http://127.0.0.1:7864/api/host/status   # 会话、owner、未确认窗口、账本
```

## Stopping it

Closing the start window leaves the shell and the sessions running (that is the chosen semantic). The named off switch is:

```bash
npm run bridge:stop      # scripts/stop.mjs → POST /api/host/stop → 壳收会话 → 退出
```

or the 「全部停止」 button in 设置 → 系统 → 运行. Both go through the shell: it tells the brain, kills the session children, then exits. Do not `kill -9` the shell — the pi children would be left behind with nobody to collect them. `/api/host/stop` requires a same-origin POST (`Origin` / `Sec-Fetch-Site`), so a random web page cannot `<img>`-trigger it.

## Restarting it

Two different restarts. Pick by what has to change:

- **Brain only — the normal case.** 设置 → 工具 →「热部署」, pick a branch, watch the panel. The shell keeps the port, the pipes and the running turns; the page reconnects on its own (D407). It refuses a dirty main checkout (use 「暂存后热部署」, D268) and a branch checked out in another worktree. It is an HTTP endpoint **of the bridge**, so it needs the bridge alive — there is nobody to click it when the shell is gone.
- **Group restart — the shell's own code changed, or the bridge is dead.** `.pi/skills/bridge-update/` (see `SKILL.md`) is the only entry from outside: it fetches, builds, kills the shell and starts a new one. `--check` is also the cheap pre-flight probe.

```bash
node .pi/skills/bridge-update/bin/restart.mjs --check --dir .   # 只判断，不 build、不杀进程
```

`--check` also compares `bridge/dist/build-id.json` with HEAD, so it answers "is 7864 serving what main says" without touching anything. If `behind: true`, write whatever is unfinished to `.scratch/bridge-update/pending.md`, start `restart.mjs` **detached** (Windows: `Start-Process node -WindowStyle Hidden -ArgumentList …`; macOS/Linux: `nohup node … &`), then end your reply. Never run the full flow in the foreground: killing the bridge takes your own `pi` child with it, mid-turn.

What `restart.mjs` does, in order — the order is the point:

- `git fetch` + `git merge --ff-only origin/main` in the main checkout (the one sanctioned exception to "never write on main"). Dirty or diverged → `merge-failed`: **no stash, no rebase, no reset**.
- `npm run build`. **Only if that succeeds** does it touch the running process — a broken build leaves 7864 serving the old code, so the outage is just the 1–3 s handover.
- Kill the pid `/healthz` reports — that is the **shell**, so this one cuts every session. Windows: `taskkill /PID`, never `/T` (it takes other trees with it); macOS/Linux: `kill -TERM`. Then kill the shell's own `pi` children by pid; orphans keep holding session locks and show up as “terminal in use”.
- Start a new shell: on Windows `Start-Process powershell -File <start-bridge.ps1>` opens a **visible** terminal window running `npm run start:nobuild`, teeing to `.scratch/bridge-update/bridge-live.log` (closing that window stops the bridge); elsewhere the same script spawns `bridge/dist/host.js` detached with its output in that log.
- Poll `/healthz` for 45 s and check the reported `buildId` matches the fresh build; write `.scratch/bridge-update/last-run.json`.

`npm start` still works by hand (`node scripts/bootstrap.mjs --start && node scripts/build.mjs && node scripts/start.mjs`, ~10 s; `build:bridge` / `build:web` are the same script with `--only`). That last script picks `bridge/dist/host.js` when it exists, so what you get is shell + brain, not a bare bridge. Session transcripts live in `~/.pi/agent/sessions/`, so a mid-turn chat is cut, not lost — that is what `pending.md` and the `pendingUnread` startup check in AGENTS.md are for.

If your own transport might be the thing you're restarting, hand the kill+start to the detached helper and reply; whether or not you are a child of the bridge stops mattering.

## "Am I a child of that process?"

Ask the human first when they are around — they started the service, they know. Otherwise one command prints your ancestor chain (works because PowerShell 7 has `Get-Process(...).Parent`):

```bash
pwsh -NoProfile -Command '$p=Get-Process -Id $PID; while($p){ "{0} {1}" -f $p.Id,$p.ProcessName; $p=$p.Parent }'
```

`powershell.exe` (5.1) has **no** `.Parent` — the chain prints one line and stops, which reads like a wrong answer instead of a failed one. Use `pwsh`.

To get a yes/no instead of a chain, append `| Select-String <pid>`: any output means you are a descendant.

Avoid `Get-CimInstance Win32_Process | Where CommandLine -like '*…*'` for this: it is slow, and the query matches its own command line.

## Sessions vs. processes

A session id in `#/s/<id>` is not enough to find "your" process — children are started with `--session <file>` or `--session-id <id> --name <name>`, and a session can be served by a different bridge instance entirely (a worktree on another port). Compare the ancestor chain, not the session id.

With a shell in front, a session's `pi` is a child of **the shell**, not of the brain. Killing the brain therefore does not stop a session: the shell respawns a brain after ~1 s and the new one adopts the live children (`adoptLinked`). Killing the shell stops everything — that is the one process whose death takes the sessions with it.

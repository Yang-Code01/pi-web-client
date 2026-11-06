# Running the bridge

The bridge is the process behind `http://127.0.0.1:7864` — it serves `web/dist`, speaks WS, and spawns one `pi --mode rpc` child per session. A human usually starts it by hand in a terminal, so the pid you find is **their** process, not yours.

## Restarting it

**Use the skill** — `.pi/skills/bridge-update/` (see `SKILL.md`). Don't hand-roll the two-step.

```bash
node .pi/skills/bridge-update/bin/restart.mjs --check --dir .   # 只判断，不 build、不杀进程
```

If `behind: true`, write whatever is unfinished to `.scratch/bridge-update/pending.md`, start `restart.mjs` **detached** (`Start-Process node -WindowStyle Hidden -ArgumentList …`), then end your reply. Never run the full flow in the foreground: killing the bridge takes your own `pi` child with it, mid-turn.

What it does, in order — the order is the point:

- `git fetch` + `git merge --ff-only origin/main` in the main checkout (the one sanctioned exception to "never write on main"). Dirty or diverged → `merge-failed`: **no stash, no rebase, no reset**.
- `npm run build`. **Only if that succeeds** does it touch the running process — a broken build leaves 7864 serving the old code, so the outage is just the 1–3 s handover.
- `taskkill /PID <bridge>` (never `/T`), then kill the bridge's own `pi` children by pid; orphans keep holding session locks and show up as “terminal in use”.
- `Start-Process powershell -File <start-bridge.ps1>` opens a **visible** terminal window running `npm run start:nobuild`, teeing to `.scratch/bridge-update/bridge-live.log`. Closing that window stops the bridge, same as before.
- Poll `/healthz` for 45 s and check the reported `buildId` matches the fresh build; write `.scratch/bridge-update/last-run.json`.

`npm start` still works by hand (`node scripts/build.mjs && node bridge/dist/index.js`, ~10 s; `build:bridge` / `build:web` are the same script with `--only`). Session transcripts live in `~/.pi/agent/sessions/`, so a mid-turn chat is cut, not lost — that is what `pending.md` and the `pendingUnread` startup check in AGENTS.md are for.

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

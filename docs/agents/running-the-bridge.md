# Running the bridge

The bridge is the process behind `http://127.0.0.1:7864` — it serves `web/dist`, speaks WS, and spawns one `pi --mode rpc` child per session. A human usually starts it by hand in a terminal, so the pid you find is **their** process, not yours.

## Restarting it

`npm start` at the repo root = `build:bridge && build:peer && build:web && node bridge/dist/index.js`. A restart costs ~10s of building.

- **Restarting is a plain two-step**: stop the old `node bridge/dist/index.js`, start the new one. Don't build a verification wrapper (log files, retry loops, port polling) before doing the action; do the action, then check `http://127.0.0.1:7864/` once.
- The `pi` child processes (`--mode rpc ... --session <file>`) die with the bridge. Session transcripts are already on disk in `~/.pi/agent/sessions/`, so nothing is lost — but a chat that was mid-turn will be cut.
- If your own transport might be the thing you're restarting, **don't investigate first** — hand the kill+start to a detached helper that waits a few seconds (`Start-Process pwsh -ArgumentList '-File', <script>`), then reply. Whether or not you are a child of the bridge stops mattering.

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

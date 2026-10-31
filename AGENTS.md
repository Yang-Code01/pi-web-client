# pi-web-client

pi 的网页客户端：`bridge/`（Node，WS 桥 + RPC 子进程 + 隧道）与 `web/`（Vite + 原生 TS 前端）。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `Yang-Code01/pi-web-client`, driven with the `gh` CLI (every command needs `HTTPS_PROXY=http://127.0.0.1:18791`). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and the decision log at `docs/DECISIONS.md` (`D1`…`Dn`, 决定 + 为什么). See `docs/agents/domain.md`.

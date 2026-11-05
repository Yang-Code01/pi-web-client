# pi-web-client

pi 的网页客户端：`bridge/`（Node，WS 桥 + RPC 子进程 + 隧道）与 `web/`（Vite + 原生 TS 前端）。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `Yang-Code01/pi-web-client`, driven with the `gh` CLI. 先直连（多数机器直连可用）；只有直连失败才加 `HTTPS_PROXY=http://127.0.0.1:18791`。push / `gh pr create` 报 403 时**先查账号**：`gh auth status` 里的 active 账号可能不是仓库主人（git 用 active 那个），不是网络问题。See `docs/agents/issue-tracker.md`.

#### 账号：本仓库只认 `Yang-Code01`

`Yang-Code01` 的权限只用于**本仓库**的 `gh` 与 `git`，不要让它影响别的项目和全局默认账号。

- 全局 active 账号平时保持 `xyang-qingmin`，别改它；
- 在本仓库动 `gh` / `git push` 时二选一：
  - 逐条带鉴权：`GH_TOKEN=$(gh auth token --user Yang-Code01) gh …`，push 用 `https://x-access-token:$TOKEN@github.com/Yang-Code01/pi-web-client.git`（写法见 `docs/agents/issue-tracker.md`）；
  - 或者临时 `gh auth switch --user Yang-Code01`，**任务一做完立刻 `gh auth switch --user xyang-qingmin` 切回去**，别留着。
- 症状：`gh issue edit … --add-label` 报 `does not have the correct permissions to execute AddLabelsToLabelable` —— 这就是 active 账号不是 `Yang-Code01`，不是标签本身的问题。

### 界面文案（i18n）

界面文案一律走 `web/src/i18n/` 的 `tr("中文原文")`：中文原文就是键，英文/日文在 `en.ts` / `ja.ts`。

- 加文案：直接在代码里写 `tr("新的中文")`，然后往 `en.ts`、`ja.ts` 各补一条同键的译文（`npm --prefix web run typecheck` 会跑 `web/i18n-check.mjs`，缺一条就报错）。
- 别把中文塞进模块级数组当常量再用——`SIZES` 那种标签表要在使用处 `tr(label)`；`ACCENTS` 这类会写进 `localStorage` 的值必须是稳定 id（`ice`/`teal`…），不能翻译。
- 测试：Playwright 的 `newContext()` 必须带 `locale: "zh-CN"`，否则默认 en-US 会把界面变成英文，断言中文的用例会假失败。见 `docs/I18N.md`。

### Running the bridge

The bridge (`http://127.0.0.1:7864`) is normally started by hand in a terminal; its `pi --mode rpc` children die with it. A restart is just stop + `npm start` — no verification wrapper beforehand. To tell whether you are a descendant of some pid, ask the human or print your own ancestor chain with `pwsh` (`Get-Process(...).Parent`). See `docs/agents/running-the-bridge.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and the decision log at `docs/DECISIONS.md` (`D1`…`Dn`, 决定 + 为什么). See `docs/agents/domain.md`.

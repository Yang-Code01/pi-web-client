# pi-web-client

pi 的网页客户端：`bridge/`（Node，WS 桥 + RPC 子进程 + 隧道）与 `web/`（Vite + 原生 TS 前端）。

## Worktree 工作流（硬规则，优先于下文所有流程）

**AI 不在 main 上改代码，也不在已检出的主工作区里编辑文件。每次变更都先开一个 worktree，在它自己的分支上改、提交，再合回来。**

- **开：** 从主检出 `git worktree add ../pi-web-client-wt/<branch> -b <branch>`（本仓库 worktree 统一放 `F:/pi-web-client-wt/`），之后所有读写都在那个目录里做。`<branch>` 用 `feat/…`、`fix/…` 这类主题名。
- **收：** 走本仓库 PR 流程（`gh pr create` → 合并）或本地 `git merge --no-ff <branch>`；之后 `git worktree remove <目录>` + `git branch -d <branch>`，别留僵尸 worktree，手工删过目录就跑 `git worktree prune`。
- **只读不受限：** `git log` / `git diff` / 读 main 上的代码随便跑。禁止的是**写**：在 main 上 `git add` / `git commit`，或者 `git checkout main` 之后改文件。
- **主检出里有未提交的改动时先问用户**（stash / 带走到新分支），不要为了腾地方就 `git checkout .` 或 `git stash` 掉别人的活。
- **并行任务一个任务一个 worktree**，两个 agent 不要共用同一工作目录（会踩 build 产物和 `index.lock`）。
- **sub-agent 改代码用隔离 worktree**（`subagent` 的 `worktree: true`），不要让它直接写主检出。
- **这条规则也管 `AGENTS.md` 自己**：改规则文本一样开 worktree、提 PR、合回来，不在 main 上直接提交。
- **唯一例外：用户当场明确要求在 main / 主检出上改**——照做，但在回复里点明绕过了这条规则。
- **已登记的例外（D154）：** `.pi/skills/bridge-update/bin/restart.mjs` 可以在主检出上 `git fetch` + `git merge --ff-only origin/main`，只此一步，不 stash / 不 rebase / 不 reset；主检出 dirty 就停在 `merge-failed`。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `Yang-Code01/pi-web-client`, driven with the `gh` CLI. 先直连（多数机器直连可用）；只有直连失败才加 `HTTPS_PROXY=http://127.0.0.1:18791`。push / `gh pr create` 报 403 时**先查账号**：`gh auth status` 里的 active 账号可能不是仓库主人（git 用 active 那个），不是网络问题。See `docs/agents/issue-tracker.md`.

#### 账号：本仓库只认 `Yang-Code01`

`Yang-Code01` 的权限只用于**本仓库**的 `gh` 与 `git`，不要让它影响别的项目和全局默认账号。

- 全局 active 账号平时保持 `xyang-qingmin`，别改它；
- 在本仓库动 `gh` / `git push` 时二选一：
  - 逐条带鉴权：`GH_TOKEN=$(gh auth token --user Yang-Code01) gh …`，push 用 `git -c credential.helper= push https://x-access-token:$TOKEN@github.com/Yang-Code01/pi-web-client.git`（写法见 `docs/agents/issue-tracker.md`；`-c credential.helper=` 不能省，理由见该文档）；
  - 或者临时 `gh auth switch --user Yang-Code01`，**任务一做完立刻 `gh auth switch --user xyang-qingmin` 切回去**，别留着。
- 症状：`gh issue edit … --add-label` 报 `does not have the correct permissions to execute AddLabelsToLabelable` —— 这就是 active 账号不是 `Yang-Code01`，不是标签本身的问题。

### 界面文案（i18n）

界面文案一律走 `web/src/i18n/` 的 `tr("中文原文")`：中文原文就是键，英文/日文在 `en.ts` / `ja.ts`。

- 加文案：直接在代码里写 `tr("新的中文")`，然后往 `en.ts`、`ja.ts` 各补一条同键的译文（`npm --prefix web run typecheck` 会跑 `web/i18n-check.mjs`，缺一条就报错）。
- 别把中文塞进模块级数组当常量再用——`SIZES` 那种标签表要在使用处 `tr(label)`；`ACCENTS` 这类会写进 `localStorage` 的值必须是稳定 id（`ice`/`teal`…），不能翻译。
- 测试：Playwright 的 `newContext()` 必须带 `locale: "zh-CN"`，否则默认 en-US 会把界面变成英文，断言中文的用例会假失败。见 `docs/I18N.md`。

### Running the bridge

The bridge (`http://127.0.0.1:7864`) is normally started by hand in a terminal; its `pi --mode rpc` children die with it. A restart goes through the skill below (stop + `npm start` by hand still works, it just skips the build check). To tell whether you are a descendant of some pid, ask the human or print your own ancestor chain with `pwsh` (`Get-Process(...).Parent`). See `docs/agents/running-the-bridge.md`.

### 更新 / 重启 bridge

用 `.pi/skills/bridge-update/`（流程见 `SKILL.md`）：先 `node .pi/skills/bridge-update/bin/restart.mjs --check --dir <仓库根>` 判断是否落后（前台、安全，只 fetch 不杀进程）。落后了才把没做完的事写进 `.scratch/bridge-update/pending.md`，detached 起完整流程，然后**立刻结束回复**。不要在前台跑完整流程——杀 bridge 会切断自己的 turn。

**每次会话开场**：读 `.scratch/bridge-update/last-run.json`；若 `pendingUnread: true`，先按 `pending.md` 把上次没做完的事做完，再把该字段改成 `false`。这是上一轮被重启切断后的续做入口。

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and the decision log at `docs/DECISIONS.md` (`D1`…`Dn`, 决定 + 为什么). See `docs/agents/domain.md`.

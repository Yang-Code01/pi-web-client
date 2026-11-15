# pi-web-client

pi 的网页客户端：`bridge/`（Node，WS 桥 + RPC 子进程 + 隧道）与 `web/`（Vite + 原生 TS 前端）。

## Worktree 工作流（硬规则，优先于下文所有流程）

**AI 不在 main 上改代码，也不在已检出的主工作区里编辑文件。每次变更都先开一个 worktree，在它自己的分支上改、提交，再合回来。**

- **开：** 从主检出 `git worktree add ../pi-web-client-wt/<branch> -b <branch>`（本仓库 worktree 统一放 `F:/pi-web-client-wt/`），之后所有读写都在那个目录里做。`<branch>` 用 `feat/…`、`fix/…` 这类主题名。
- **收：** 提交、推送分支、开好 PR（`gh pr create`）之后**停下**，等用户明确说合并才合并（`gh pr merge` 或本地 `git merge --no-ff <branch>`）。**「改完了」不等于「可以合 main」。** 合并之后才 `node tools/worktree-remove.mjs <目录>` + `git branch -d <branch>`，别留僵尸 worktree，手工删过目录就跑 `git worktree prune`。
- **删 worktree 一律走 `tools/worktree-remove.mjs`，不直接 `git worktree remove`（更不加 `--force`）。** 条件：worktree 里只要有指向外面的链接（典型是 Windows 上用 junction 把 `node_modules` 连回主检出），git 删目录会顺着链接进去，把主检出的依赖一起删掉。脚本先只拆链接、再交给 git、最后核对链接目标还在；没有链接时它等同 `git worktree remove`，所以任何平台都照用，不用先判断。有未提交改动被 git 拒绝时，先确认改动可以丢，再加 `--force` 重跑脚本。
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

#### 账号：动本仓库的 `gh` / `git`，用「有写权限的那个」

写权限不是某一个账号的专利：**`Yang-Code01`（仓库主人）与 `qingmin-new` 都有**（后者 2026-11-15 在这台机器上实测过 push 与合并 PR）。用哪个看 `gh auth status` 里 active 的是谁 —— 在名单里就直接用，别为了「照文档」去切账号。

- **本机（macOS，2026-11-15）**：只登了 `qingmin-new`，`gh` / `git push` 直接用它就行。**不要**再 `gh auth switch --user Yang-Code01` —— 这台机器压根没登过那个账号，切不过去，只会白折腾一轮。
- 另一类机器上全局 active 是 `xyang-qingmin`（**没有**本仓库写权限）：那种环境才需要二选一 —— 逐条带鉴权 `GH_TOKEN=$(gh auth token --user Yang-Code01) gh …`（push 的写法见 `docs/agents/issue-tracker.md`；`-c credential.helper=` 不能省，理由见该文档），或者临时切过去、做完切回来。
- 症状：`gh issue edit … --add-label` 报 `does not have the correct permissions to execute AddLabelsToLabelable`，或者 push / `gh pr create` 报 403 —— 先看 active 账号是不是上面那两个之一，不是标签的问题、也不是网络问题。

#### 合并 PR：`gh pr merge` 会被 ruleset 骗，用 `gh merge-pr`

`main` 上挂着两条 ruleset（`main-protection` + `main: only owner can merge`），所以**一律走 PR**：直接 `git push origin main` 会被拒（`push declined due to repository rule violations`）。

`gh pr merge` 还会先看 `mergeStateStatus`，一旦是 `BLOCKED` 就当场拒：「the base branch policy prohibits the merge」。**同一份 token 走 API 却合得上**：

```bash
gh api -X PUT repos/Yang-Code01/pi-web-client/pulls/<n>/merge -f merge_method=merge
```

本机已把它做成全局别名 **`gh merge-pr`**（合当前分支的 PR）。见到那句 `base branch policy` 就改用它，别停下来等人确认。合完 `git fetch` + `git merge --ff-only origin/main` 把本地 main 拉平。

### 界面文案（i18n）

界面文案一律走 `web/src/i18n/` 的 `tr("中文原文")`：中文原文就是键，英文/日文在 `en.ts` / `ja.ts`。

- 加文案：直接在代码里写 `tr("新的中文")`，然后往 `en.ts`、`ja.ts` 各补一条同键的译文（`npm --prefix web run typecheck` 会跑 `web/i18n-check.mjs`，缺一条就报错）。
- 别把中文塞进模块级数组当常量再用——`SIZES` 那种标签表要在使用处 `tr(label)`；`ACCENTS` 这类会写进 `localStorage` 的值必须是稳定 id（`ice`/`teal`…），不能翻译。
- 测试：Playwright 的 `newContext()` 必须带 `locale: "zh-CN"`，否则默认 en-US 会把界面变成英文，断言中文的用例会假失败。见 `docs/I18N.md`。

### 布局：网格里的可隐藏子元素

给容器写多轨 `grid-template-rows` 时，先看它的直接子元素里有没有会 `hidden` / `display:none` 的（横幅、提示条、菜单）。有就三选一：每个子元素钉死 `grid-row` / `grid-area`；只在它可见时才切到多一行的模板（`:has(> .x:not([hidden]))`）；或整块改 flex 列。隐藏的子元素不占格子，后面的会整体前挪一行：主体掉进 `auto` 行不再自己滚、底栏被拉进 `1fr`。已经踩过三次：随手问面板、系统管理页（`0eebbeb`）、对话栏（`b8149a9` → #372）。加了这类元素的 UI 测试顺手断言它隐藏时底栏仍贴底。

### 尺寸：`#app` 里不许写裸 `vh` / `vw`

`#app { zoom: var(--ui-scale) }`（外观「字号」）会把子树里的长度整体缩放一遍，而 `vw` / `vh` 解析的是**视口**、不认 zoom —— 同一个值被乘第二次。所以视口几成就写 `calc(var(--vh1) * N)` / `calc(var(--vw1) * N)`：

- 往 CSS 里写 `82vh`、`94vw`、`calc(100vw - 16px)` 这种，字号 125% 以上就会把弹层与它的底栏推出屏幕（D123、D263，已经复发四次）。
- 只有 `document.body.append()` 上去、压根不在 `#app` 里的浮层可以写裸的，行尾必须标 `/* 不在 #app */`；守卫只认这个标记，**别拿它当顺手豁免** —— 浮层本来就该跟着字号缩放，请挂进 `#app`。
- 守卫：`npm run test:viewport`（已挂在 web 的 typecheck 里）。新写/改弹层后跑一次，顺便在字号 150% 下看一眼底栏还在不在。
- 判「窄版」用 `@container`（卡 / 面板自己的宽度），不要用 `@media`（视口宽度）：嵌在左栏右栏里的面板永远等不到 `@media` 触发（D263）。

### Running the bridge

The bridge (`http://127.0.0.1:7864`) is normally started by hand in a terminal; its `pi --mode rpc` children die with it. A restart goes through the skill below (stop + `npm start` by hand still works, it just skips the build check). To tell whether you are a descendant of some pid, ask the human or print your own ancestor chain with `pwsh` (`Get-Process(...).Parent`). See `docs/agents/running-the-bridge.md`.

### 更新 / 重启 bridge

用 `.pi/skills/bridge-update/`（流程见 `SKILL.md`）：先 `node .pi/skills/bridge-update/bin/restart.mjs --check --dir <仓库根>` 判断是否落后（前台、安全，只 fetch 不杀进程）。落后了才把没做完的事写进 `.scratch/bridge-update/pending.md`，detached 起完整流程，然后**立刻结束回复**。不要在前台跑完整流程——杀 bridge 会切断自己的 turn。

**每次会话开场**：读 `.scratch/bridge-update/last-run.json`；若 `pendingUnread: true`，先按 `pending.md` 把上次没做完的事做完，再把该字段改成 `false`。这是上一轮被重启切断后的续做入口。

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and the decision log at `docs/DECISIONS.md` (`D1`…`Dn`, 决定 + 为什么). See `docs/agents/domain.md`.

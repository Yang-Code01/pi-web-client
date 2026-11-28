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

Issues and specs live as GitHub issues in `Yang-Code01/pi-web-client`, driven with the `gh` CLI. 先直连（多数机器直连可用）；只有直连失败才加 `HTTPS_PROXY=http://127.0.0.1:18791`（这是 `gh` / 手工 git 命令的代理约定；热部署 worker 自动按 D272 选择代理，不走这条）。push / `gh pr create` 报 403 时**先查账号**：`gh auth status` 里的 active 账号可能不是仓库主人（git 用 active 那个），不是网络问题。See `docs/agents/issue-tracker.md`.

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

### 提问：一律走 `ask_user_question`

需要用户做选择、确认方向、补一个只有他知道的事实时，调用 `ask_user_question` —— **正文里不留待答问题**（「Q1…？」「❓」「要不要我…？」都不算提问）。

- 技能（`grilling` 等）规定的「❓ Q1 + ➡️ 建议」只约束**问什么**，不约束**怎么呈现**：题干整段放进 `question`，分支放进 `options[].description`，推荐项放第一个并在 label 末尾加「（推荐）」。
- 用户还能自己输入（「Type something.」），不要加「其他」选项。
- 兜底：`bridge/ext/ask-nudge.ts` 在模型停下前核对，正文提问且本轮没调 `ask_user_question` 就续跑一次；开关 `web.askNudge`（默认开），同一段问句只提醒一次、整会话最多两次（D319）。

### 界面文案（i18n）

界面文案一律走 `web/src/i18n/` 的 `tr("中文原文")`：中文原文就是键，英文/日文在 `en.ts` / `ja.ts`。

- 加文案：直接在代码里写 `tr("新的中文")`，然后往 `en.ts`、`ja.ts` 各补一条同键的译文（`npm --prefix web run typecheck` 会跑 `web/i18n-check.mjs`，缺一条就报错）。
- 别把中文塞进模块级数组当常量再用——`SIZES` 那种标签表要在使用处 `tr(label)`；`MAC_ACCENTS` 这类会写进 `localStorage` 的值必须是稳定 id（`blue`/`purple`…），不能翻译。
- 测试：Playwright 的 `newContext()` 必须带 `locale: "zh-CN"`，否则默认 en-US 会把界面变成英文，断言中文的用例会假失败。见 `docs/I18N.md`。

### 布局：网格里的可隐藏子元素

给容器写多轨 `grid-template-rows` 时，先看它的直接子元素里有没有会 `hidden` / `display:none` 的（横幅、提示条、菜单）。有就三选一：每个子元素钉死 `grid-row` / `grid-area`；只在它可见时才切到多一行的模板（`:has(> .x:not([hidden]))`）；或整块改 flex 列。隐藏的子元素不占格子，后面的会整体前挪一行：主体掉进 `auto` 行不再自己滚、底栏被拉进 `1fr`。已经踩过三次：随手问面板、系统管理页（`0eebbeb`）、对话栏（`b8149a9` → #372）。加了这类元素的 UI 测试顺手断言它隐藏时底栏仍贴底。

反过来的坑：把别人的多轨模板改成一行时，子元素上钉着的 `grid-row` / `grid-area` 还在，主体会落到隐式行，顶上的第 1 行（`1fr`）白白空出一截（D320 在 `.sys-main { grid-row: 3 }` 上踩过）。改 `grid-template-rows` 时先看子元素里有没有显式行号，有就一起改回去。

### 尺寸：`#app` 里不许写裸 `vh` / `vw`

`#app { zoom: var(--ui-scale) }`（外观「字号」）会把子树里的长度整体缩放一遍，而 `vw` / `vh` 解析的是**视口**、不认 zoom —— 同一个值被乘第二次。所以视口几成就写 `calc(var(--vh1) * N)` / `calc(var(--vw1) * N)`：

- 往 CSS 里写 `82vh`、`94vw`、`calc(100vw - 16px)` 这种，字号 125% 以上就会把弹层与它的底栏推出屏幕（D123、D263，已经复发四次）。
- 只有 `document.body.append()` 上去、压根不在 `#app` 里的浮层可以写裸的，行尾必须标 `/* 不在 #app */`；守卫只认这个标记，**别拿它当顺手豁免** —— 浮层本来就该跟着字号缩放，请挂进 `#app`。
- 守卫：`npm run test:viewport`（已挂在 web 的 typecheck 里）。新写/改弹层后跑一次，顺便在字号 150% 下看一眼底栏还在不在。
- 判「窄版」用 `@container`（卡 / 面板自己的宽度），不要用 `@media`（视口宽度）：嵌在左栏右栏里的面板永远等不到 `@media` 触发（D263）。

### 选区：强调色实底上必须反相

`::selection` 的对比对象是它自己下面那层，所以底色里已经有强调色的地方（对话里的用户气泡 `.msg.user .body`、内网通「我发的」`.msg.mine .bub`），半透明强调色铺上去就等于同一个颜色：`.msg.user` 那对组合实测底对比 **1.00**，整段选中和没选中一模一样（D417）。现在改成：

- 全局 `::selection` 是实心 `--accent` + `--accent-ink` 字，不带透明度；强调色实底的气泡里反过来（`--accent-ink` 实块 + 强调色字）。
- 写在哪：主界面是 `mac-base.css`（只带 `.msg.user .body`），内网通页面只加载 `peer.css`，它自己带一份（`::selection` + `.msg.mine .bub`）。新加「强调色实底 + 可读文本」的区域时，看那个页面加载哪份表，把选择器加进对应的反相名单，否则那块地方的选区又是隐形的。
- 守卫：`node probes/selection-visible.mjs`（真鼠标拖选、量截图像素，改前 1.00:1 / 1.55:1）。注意 programmatic `getSelection().addRange()` 在未聚焦文档里 Chrome 不上色，只看计算样式会误判成已修好。

### 选区的浮动动作：贴最后一截、坐标用布局 px、按下时别丢选区

拖选后在选区旁边冒出来的东西（现在只有一个：`SelAsk` 的「问一下」胶囊，D416），照这几条写：

- **贴 `range.getClientRects()` 里有面积（`width/height > 1`）的最后一个矩形**，不用整段的包围盒：跨段落的包围盒能盖住半个屏幕，按钮会跑到离「选到哪儿」很远的地方。越界夹回窗口、下面放不下翻到上方。
- **`#app` 上有 zoom，量到的和写进去的不是同一套单位**：`getBoundingClientRect()` 是视觉 px，`style.left/top` 是布局 px（除以 `uiScale()`），`offsetWidth` 是布局 px（乘回 `scale` 再夹窗口）。守卫 `probes/sel-ask-chip.mjs` 在 100% 与 150% 两档量胶囊高度（26px / 39px）。
- **按钮的 `mousedown` 里 `preventDefault()`**，否则按下那一刻选区就没了，`onclick` 里再读 `getSelection()` 是空的；选中文字要在 `mouseup` 时就存下来。
- 要在别处（左栏、输入框、别的面板）拖选时不弹，就把监听挂 `document` 的捕获阶段并在 `sync()` 里判断 range 是否落在自己的容器里 —— mouseup / mousedown 会被里面的组件 `stopPropagation`。
- **材质跟主题走，别用 `--panel` 死色**（D418）：底色 `--mac-glass-strong`、模糊 `--mac-blur`、描边 `0.5px solid var(--mac-glass-line)`、投影 `var(--mac-shadow-menu)` —— 跟 `.chat-jump`、助手气泡同一套。写死的 `rgba(0,0,0,.22)` 投影在三套主题里长得一样，等于没跟主题。`probes/sel-ask-chip.mjs` 第 7 段按主题量像素（玻璃必须透、描边必须半透明、三套主题投影必须各不相同）。

### 列表刷新：已显示的内容不许变暗、不许先清空

点了排序 / 筛选 / 新建目录之后「闪一下」，根因永远是同一个：把「忙碌」画在**已经显示好的内容**上（`.busy` 压暗、`clearRows()` 再挂「读取中…」）。列表要 stale-while-revalidate —— 拿到新数据前不动一个像素：

- 静默重取只留 `cursor: progress`，不加 `opacity`、不换占位。非静默重取（跳目录、建目录后重载）**慢过 220ms** 才让位给「读取中…」占位，快的请求用户应当看到「点了立刻换」。
- 需要进度感就画在列表**外面**（页脚计数、工具行），不许改列表本身；也不要用骨架屏当折衷。
- 守卫：`node probes/new-session-sheet.mjs` 第 10 段逐帧采样（排序 / 逐字筛选 / 建目录），任何一帧 `opacity < 0.99` 或有内容期间 `children === 0` 就红。新写/改任何分页列表（文件管理器、附件弹层、内网通选文件）时照这段抄一份。细节见 D316。

### Running the bridge

The bridge (`http://127.0.0.1:7864`) is normally started by hand in a terminal; its `pi --mode rpc` children die with it. A restart is either a brain-only swap (设置 → 工具 →「热部署」) or a group restart through the skill below; stop + `npm start` by hand still works, it just skips the build check. To tell whether you are a descendant of some pid, ask the human or print your own ancestor chain with `pwsh` (`Get-Process(...).Parent`). See `docs/agents/running-the-bridge.md`.

### 更新 / 重启 bridge

**日常换构建让用户点热部署**（设置 → 工具 →「热部署」）：它只换脑，正在跑的会话不断（D407），进度与失败原因都在面板上；主检出有 `package-lock.json` 这类未提交改动时用同一面板的「暂存后热部署」（D268）。agent 点不了那颗按钮——需要更新时先 `--check` 判断，把「落后了，点一下热部署」告诉用户。

`.pi/skills/bridge-update/` 现在只负责它独占的四件事（流程见 `SKILL.md`）：

- **桥已经死了 / 端口没回应**：热部署是桥上的端点，桥没起来没人给点；`restart.mjs` 从外面找 pid、拉壳起来。
- **只想知道落后没有**：`node .pi/skills/bridge-update/bin/restart.mjs --check --dir <仓库根>`，前台、安全：只 fetch，不 build、不杀进程，也不写 `last-run.json`。
- **壳自己的代码变了**（面板说「需整组重启」）：热部署只报不做，真整组重启走 `restart.mjs`——它杀的是壳，会话会断。
- **看门狗**：壳崩之后唯一会把它拉回来的一层（安装脚本目前只有 Windows 计划任务）。

走 `restart.mjs` 完整流程时：先把没做完的事写进 `.scratch/bridge-update/pending.md`，detached 起，然后**立刻结束回复**。不要在前台跑完整流程——杀 bridge 会切断自己的 turn。

**每次会话开场**：读 `.scratch/bridge-update/last-run.json`；若 `pendingUnread: true`，先按 `pending.md` 把上次没做完的事做完，再把该字段改成 `false`。这是上一轮被重启切断后的续做入口。

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and the decision log at `docs/DECISIONS.md` (`D1`…`Dn`, 决定 + 为什么). See `docs/agents/domain.md`.

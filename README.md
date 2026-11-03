# pi-web-client

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

同一个 pi 会话，桌面上用终端，离开桌子用浏览器：看流式输出、批危险命令、按中断。

- `bridge/` — 一个 Node 进程：管 pi 子进程（`--mode rpc`）、HTTP+WS、口令登录、审批转发、隧道与推送。
- `web/` — Vite + TypeScript 前端（无 UI 框架），手机/桌面共用一套组件。
- `probes/` — 摸 pi 的 RPC 边界时写的一次性探针，留着当证据。

设计文档、决策记录、实测报告都在 [`docs/`](docs/)（[`PLAN.md`](docs/PLAN.md)、[`DECISIONS.md`](docs/DECISIONS.md)、[`pi-integration-facts.md`](docs/pi-integration-facts.md)）。**想知道「pi 的 RPC 到底能干什么」，先看 [`docs/pi-integration-facts.md`](docs/pi-integration-facts.md)。**

## 长什么样

桌面：左边是磁盘上所有 pi 会话（可拖拽排序、置顶、归档），中间是流式对话——右缘一列「轮次刻度带」，一轮一根；右边是「需要你的事」。

![桌面](docs/shots/desktop.png)

顶栏 `📂 产物` 列出本会话写/改过的文件，`📁 文件管理器` 从盘符开始浏览并就地改文本；对话下方还能拉出这台电脑上真的 PowerShell：

| 文件管理器：浏览 / 预览 / 编辑是同一个面板（代码带行号 + 语法高亮） | 真终端：`node-pty` 跑本机 PowerShell |
| --- | --- |
| ![文件管理器](docs/shots/files.png) | ![真终端](docs/shots/terminal.png) |

手机上同一套组件，底部三个标签（会话 / 对话 / 需要你），危险命令和模型提问都摊在输入框上方——拒绝单击、批准要二次确认：

| 对话 | 审批 | 提问 |
| --- | --- | --- |
| ![手机对话](docs/shots/mobile-chat.png) | ![手机审批](docs/shots/mobile-approval.png) | ![提问](docs/shots/ask-drawer.png) |

这六张不是手工截的：`node probes/readme-shots.mjs` 在 `.scratch/` 里起一个临时桥、造一份 fixture 会话（假对话、真渲染、真文件浏览、真 PowerShell），审批/提问两个抽屉由一个本地桩推送，重拍全程不碰 `~/.pi/agent` 里的真实会话、也不花模型调用。

## 要求

- **Node ≥ 22.19**（本机 v24.11.1，LTS 22/24 都可以）。仓库里的 `.nvmrc` 指向 24。
- **pi 必须先装好**，它不是本项目的 npm 依赖：`npm i -g @earendil-works/pi-coding-agent@1.4.0`。bridge 启动时只负责去磁盘上找它的 `cli.js`，找不到会直接报错并列出所有试过的路径。
  - 查找顺序：`PI_BIN` → nvm（`%LOCALAPPDATA%\nvm\v*`，仅 Windows）→ PATH 里的 `pi` / `pi.cmd` / `pi.bat` 启动器 → node 同级的 `node_modules` → `npm root -g` → `%APPDATA%\npm`、`%ProgramData%\npm`（仅 Windows）。
  - 也就是说：**pi 是用 npm 全局装的就能自动找到**（Linux/macOS 走 `npm root -g`）；用 pnpm / bun / 装在项目里，就把 `PI_BIN` 指到 `.../pi-coding-agent/dist/bundle/cli.js`。
- 可选：cloudflared（Windows `winget install Cloudflare.cloudflared`，macOS `brew install cloudflared`），只有要从公网访问才需要。找它时依次试 `CLOUDFLARED_BIN` → `PATH` → 几个常见安装位置。
- 部署时 **`bridge/ext/` 要跟着走**：审批门禁是那里的 `approval-gate.ts`，`bridge/dist/` 里没有它，只拷 `dist/` 会静默失去全部审批拦截。

## 跑起来

```bash
npm --prefix bridge install    # 不要加 --omit=dev：npm start 要靠 devDependencies 里的 tsc 编译
npm --prefix web install
npm start                      # tsc 编译 bridge + vite 打包 web/dist，再跑 dist/index.js（约 2 秒）
```

首次启动会打印一次口令（也写在状态目录的 `passphrase.txt`）：

```text
pi-web-client 0.1.0 — pi 1.4.0 @ C:\...\dist\bundle\cli.js
listening on http://127.0.0.1:7864
口令（首次生成，只显示这一次）：nectar-juniper-willow-238
```

手机连同一个 WiFi，打开 `http://<本机局域网 IP>:7864`，输口令进门。

```bash
# 让局域网能连（默认只听 127.0.0.1）
PI_WEB_HOST=0.0.0.0 npm start
```

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PI_WEB_PORT` | 监听端口 | `7864` |
| `PI_WEB_HOST` | 监听地址，局域网要 `0.0.0.0` | `127.0.0.1` |
| `PI_WEB_STATE` | 状态目录（口令、锁、订阅、VAPID） | `%LOCALAPPDATA%\pi-web-client` |
| `PI_WEB_TUNNEL` | 启动时自动开 trycloudflare 隧道 | 关 |
| `PI_WEB_ROOT` | 前端静态目录 | `web/dist` |
| `PI_WEB_NO_EXT=1` | 不加载审批门禁扩展 | 关 |
| `PI_BIN` | 指定 pi 的 `cli.js` | 自动找 |
| `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | 与 pi 同名同义：桥按 pi 的顺序找会话目录（环境变量 → 全局 `settings.json` 的 `sessionDir` → `~/.pi/agent/sessions`，D73） | 跟随 pi |

## 能做什么

- 会话列表：磁盘上 190+ 个 pi 会话按**创建时间**倒序固定排列（回答完不会跳到最前），卡片右下角只提示 `待确认` / `完成` / `运行中`，点开即读（只读预览）；想接着聊就点 composer 上方的「接管会话」，写者换成网页，模型/思考/中断都能用。已接管时同一颗按钮分两种文案：从磁盘接管的显示「让回终端」（释放写者，回终端接着聊），网页新建的显示「停止运行」（关掉那个 pi 子进程，历史留在磁盘，随时再接管）。
- 整理会话：卡片 hover 出现 ⣿ 手柄，直接拖拽换位置（拖进「置顶」段就是置顶，拖回来就取消）；☆ 一键置顶/取消。点「管理」进入多选：置顶 / 取消置顶 / 归档 / 恢复 / 删除，删除要 4 秒内点第二次，运行中或待确认的会话删不掉。顶部的过滤框按名字和目录筛。排好的顺序与归档存在 bridge 的 `state/manage.json`，重启桥也还在；归档只是收进折叠段，pi 的会话文件一个字节都不动。
- 改名：卡片 hover 时右上角出现 ✎，点开就地输入，Enter 保存、Esc 取消、点到别处也保存。已接管的会话走 pi 的 `set_session_name`，名字同时写进会话文件、终端那边也看得到；只读会话只存 bridge 的 `state/names.json`（bridge 从不写 pi 的 jsonl），pi 侧后来改了名（`/name`）会按时间戳夺回显示。
- 发消息：流式文本 + 思考过程可折叠 + 工具卡片（命令、耗时、输出、失败标红）。
- 审批：危险模式（`rm`、`git push`、写 cwd 外、`sudo`…）由扩展 `bridge/ext/approval-gate.ts` 拦住，网页上拒绝单击、批准二次确认；「本会话允许这类」同样要二次确认，记住的规则只对当前会话生效（存在 `state/allow/<会话id>.json`），只按命令开头的程序名（+ 子命令）匹配，带 `;` `&&` `|` 重定向等的复合命令永远单独询问；5 分钟不理等于拒绝。
- 中断：挂起的审批会一起清掉（pi 的 `abort` 在 dialog 挂起时不会返回，所以先 `cancelled` 再 `abort`）。
- 排队：跑着的时候继续发——Enter 引导当前任务（steer），Alt+Enter 等这轮做完再处理（followUp），同终端；输入框上方的「排队中」条能把排队的消息撤回到输入框（D75）。
- `!命令` / `!!命令`：在 pi 里执行，输出成卡片，`!` 的输出随下一条消息进上下文，`!!` 不进；模型面板的「会话」一节有累计 token、费用、会话文件，以及带指令的「立即压缩」（`/session`、`/compact <指令>` 也能到这里）。
- 分支与导出（D77）：`/tree` 打开会话树（缩进=分支，● = pi 会接着走的那条），任何一条用户消息都能 ⑂ 分叉成新会话（消息放回输入框），`/clone` 复制当前分支，`/import <路径>` 导入别处的会话文件；`/export` 用 pi 自带的 HTML 导出在新标签页打开（`/export jsonl` 下载原文件），`/copy` 或消息右上角 ⧉ 复制原文。
- 输入补全（D77）：输入框开头打 `/` 列出内建命令 + 扩展命令 + 提示词模板 + 技能；任意位置打 `@` 模糊搜索工作目录里的文件。终端 `＋` 可以选 shell（PowerShell / Git Bash / cmd，macOS / Linux 用 `$SHELL`）。
- pi 设置与项目信任（D78）：右栏「pi 设置」（或 `/settings`）改全局 / 项目 `settings.json`——常用项是表单，其余「编辑 JSON」，写入走 pi 自己的文件锁、只动改过的字段；`/trust` 决定是否加载项目的 `.pi` 配置（写 `trust.json`，和终端同一份；网页里 pi 不能弹信任提示，所以没决定过的项目会在输入框上方提示）；`/reload` 重启这个会话的 pi 读最新设置；`/changelog` 看 pi 更新日志。新建会话的「高级」里可以给这个会话定 `--model` `--thinking` `--tools` `-e` `--skill` `--append-system-prompt` `-ne` `-nc` `--no-mcp` `--offline`，之后再接管也沿用。
- 登录、扩展与终端联动（D79）：「pi 设置 → 登录 / 凭据」就是 `/login` `/logout`——pi 自己跑登录流程（API key 或 OAuth），网页只转达它的提问、授权链接和设备码，凭据由 pi 写进 `auth.json`；「扩展与 MCP」跑 pi 的 `install / remove / update` 和 `mcp add / list / remove / login / logout`；「全局」页底部可以把「会话锁」扩展装进 pi 的全局扩展，之后终端里的 pi 会登记自己开着的会话，网页不会去接管它（显示「终端占用」），终端打开网页正在写的会话前也会先提醒。
- 分享与报 bug（D80）：`/share` 照 pi 的顺序上传会话——登录了 Radius 传 Radius，否则用 GitHub CLI 建私有 gist，回一个 pi 的查看链接；`/bug` 用 pi 自己的报告格式（设置去敏、不含 API key，可选附上会话记录），上传给 pi 开发者或导出 zip 下载。两者发出前都先说明会带走什么。
- 扩展管理（D81）：输入框下「技能」旁的「扩展」按钮（可在 pi 设置 → 扩展与 MCP 里关掉；有可更新时带数字角标）打开扩展与 MCP 管理：「已安装」列出 pi 包（带版本）、内置与单独的扩展、MCP 服务器和它们的工具，打开时联网查更新，只在有新版时出现「更新 / 全部更新」，扩展和 MCP 可以启停，卸载要 4 秒内再点一次；「扩展商店」是 npm 上的 pi 包（和 pi.dev 画廊同源）按月下载量排、「MCP 商店」是官方 MCP Registry 按 GitHub star 排，都能搜索、取前 10/20/50、一键安装（MCP 支持 npx / uvx / Docker / 远程 HTTP，密钥只以 `${变量}` 写进 mcp.json）。公网隧道下只读。
- 提问：模型调 `question` / `questionnaire` 时，问题直接弹成底部抽屉（多题 tab + 提交，单题点选即答，可「自己写」或取消），composer 上方另有一条「待你回答」顶条；答过的 Q/A 留在聊天里当气泡，刷新后还在。终端里跑同样的工具，界面一行没变。
- 图片：手机相册选图，或桌面直接 `Ctrl+V` / `⌘V` 粘贴截图（压到 ≤2048px 的 JPEG 再发）；点 composer 里的「+N 图」可看缩略图、单张删掉或全部清空。
- 产物与文件（D50）：`📂 产物` 是「本会话写/改过的文件」清单（按工具调用推出来，不需要 pi 配合），点一下直接预览——md / html 渲染、图片直接看、代码带行号和语法高亮。`📁 文件管理器` 是全盘浏览：浏览 / 预览 / 编辑三种状态共用一个面板，路径行上「⌂ 工作目录」旁边还有一颗「⧉ 复制路径」把当前目录复制走（D71）；文本就地改、`Ctrl+S` 保存；保存时发现磁盘上这个文件已经被 pi 改过，会拦下来问「覆盖 / 另存副本 / 放弃」。**这台机器上除了二进制和 >2 MB 的文件，基本都能读写**，所以口令别给不信任的人。
- 打不开的格式有条退路（D69）：预览只认文本 / md / html / 图片，`.xlsm` `.pdf` `.docx` 这类会显示「二进制文件」+ 两颗按钮——「新标签页打开 / 下载」和「📂 在文件夹中显示」。后者调桥在你桌面上的文件管理器里**打开所在目录并选中该文件**（Windows `explorer /select,`、macOS `open -R`、Linux 只开目录），自己双击用 Excel / Acrobat 打开，不用先下载一份副本。只对局域网 / 本机开放，公网隧道下桥直接拒绝。
- 真终端（D52·D70·D92·D93）：桥里挂 `node-pty`，点顶栏「>_ 终端」（在 `📂 产物` 旁边）就是一个真的 PowerShell，输出直接回到页面，会话的 cwd 就是它的起始目录。它是**浮在页面上的 dialog**：**可以多开**（D70），一条标签条，`＋` 再开一个（最多 4 个），每个标签一个独立进程，`×` 只关自己那个；`－` 只是**最小化**——dialog 收回顶栏那颗按钮（按钮亮着、写着数量），标签和桥里的进程都照旧在跑，再点一下就回到原样。**能拖走、能拖大小**（D93）：标题栏空白处拖动整块，右下角那只角同时改宽高，顶边那条只改高；双击标题栏或抓取带复原，位置和大小记在浏览器里，刷新还在。关掉页面再回来会按桥里的活进程把标签重建（`term.list` + 全量回放），但不会自己弹窗。本机和局域网可用，走公网隧道时禁用。
- 轮次刻度带（D60）：对话右缘一列刻度，一轮一根；悬停展开每轮输入的列表（单行右对齐、当前轮是长的那根），点一行跳到那一轮。200 轮的会话会自动抽样，首尾两根一定在。
- 权限模式：输入框右下角「🛡 危险时确认 ▾」按会话切四档——只读（白名单：只放行读 / 搜 / 列目录和声明了 readOnlyHint 的工具）/ 逐个确认（写、命令、MCP 与扩展工具都问）/ 危险时确认（默认，只拦 D1 那批）/ 全自动。门禁扩展每次工具调用读一次，切完下一次就生效。
- 语法高亮（Q-031，本 PR 补了工具卡那一处）：`highlight.js` 按语言按需打包（20 种语法，不是 386 语法的全量构建），预览、md 围栏、以及**工具卡上的命令行与输出里的 unified diff** 都吃同一套 `hljs-*` 颜色；不认识的扩展名、超过 200 KB 的文件、以及高亮器自己抛错的情况一律保持纯文本，不会因为猜错把文件显短，也不会让预览崩掉。编辑态（`<textarea>`）不高亮。
- 引用文件：`文件` 按钮或直接粘贴（截图、资源管理器里 `Shift+右键 → 复制为路径`）——图片压成附件，其他文件把绝对路径插进输入框让 pi 自己去读；路径对不上这台机器时会明说找不到，而不是静默少一段。

## 边界（重要）

- **写者是独占的，一个会话同一时间只能一边写。** 点「接管会话」前，终端那边必须已经退出：pi 自己不做会话文件锁，双进程写同一 `.jsonl` 会产生两条互不可见的兄弟分支。bridge 再加一道护栏——文件 20 秒内被写过就拒绝接管（不提供覆盖）。
- 公网（隧道）进来的连接默认**只读**：发消息、审批前要再输一次口令（step-up，10 分钟）。
- 会话文件是 append-only 且没有跨进程锁，所以 bridge 自己用 `state/locks/<id>.lock` 保证一个会话只有一个写者。

## 测试

```bash
# 起一个隔离的桥（假状态目录，7867），e2e 会真发 prompt、真点审批
PI_WEB_PORT=7867 PI_WEB_STATE=F:/pi-web-client/.scratch/test-state npm start &
npm test                                                                # WS 协议 + 审批 + 中断
npm run test:rpc                                                        # 回归：子进程 stdin 关闭后应答 ui_request 不能崩桥
node bridge/tests/browser.mjs                                           # 真 Chromium，手机/桌面截图
node probes/rename-ui.mjs                                              # 改名：Enter/Esc/失焦/刷新后仍在
node bridge/tests/manage-check.mjs                                     # 会话管理：置顶/排序/归档/删除/拒删 live/重启后仍在（隔离桥 7876）
node probes/manage-ui.mjs                                              # 会话管理 UI：☆/拖拽/多选归档/两步删除/过滤（真 Chromium，7877）
npm run test:ask                                                      # 提问通道：HTTP 三道闸 + 真模型作答/取消（自带隔离桥 7891）
npm run test:ask:ui                                                   # 提问抽屉：真 Chromium，刷新补发/多题/自己写/停止运行（7892）
node probes/readme-shots.mjs                                          # 重拍 README 那六张图（临时桥 + fixture 会话，不碰 ~/.pi/agent）
node probes/scroll-race.mjs                                          # 滚动竞争：流式输出时快滑 / 慢滑 / 回到底部（桩桥 + 真触摸）
node probes/reveal-check.mjs                                         # 在文件夹中显示：三平台命令 + 缺文件/目录/隧道 403（REVEAL_OPEN=1 真弹窗）
node probes/terminal-multi.mjs                                        # 终端多开：标签切换 + 两条独立 pty 流不串（真桥 + 真 PowerShell）
node probes/dir-copy.mjs                                             # ⧉ 复制路径：切目录后剪贴板是当前目录，此电脑上禁用
node bridge/tests/run-lifecycle.mjs                                   # 一轮的边界：重试期间不算空闲、停止清队列、长压缩不超时（假 pi，不花模型调用，需先 build:bridge）
node bridge/tests/session-dirs.mjs                                    # 会话目录解析顺序与列表不截断（D73）
node bridge/tests/session-sync.mjs                                    # 分支只显示当前一支、用户消息多端同步、扩展状态/小部件、/compact 指令（D74，假 pi）
node bridge/tests/composer-actions.mjs                                # 引导/排到之后与队列撤回、!cmd 卡片（D75，假 pi）
node bridge/tests/branch-ops.mjs                                      # 会话树 / 分叉 / 复制 / 导入 / 导出 / @ 文件搜索（D77，真 pi，不调模型）
node bridge/tests/shells.mjs                                          # 终端可选 shell（Windows / macOS / Linux，需先 build:bridge）
node bridge/tests/settings-trust.mjs                                  # 设置读写 / 项目信任 / 启动参数 / 运行时设置 / 重新加载（D78，假 pi + 真 pi 模块）
node bridge/tests/gate-modes.mjs                                      # 权限模式：只读白名单、逐个确认覆盖 MCP / 扩展工具（D78）
node bridge/tests/login-flow.mjs                                      # /login /logout：API key、取消、OAuth 授权链接转达、登出（D79，不联网）
node bridge/tests/session-lock.mjs                                    # 终端会话锁扩展 + bridge 拒绝接管 + 安装 / 移除（D79）
node bridge/tests/pi-cli.mjs                                          # pi install / list / remove 与 pi mcp add / list / remove（D79，真 pi CLI，fixture 目录）
node bridge/tests/share-bug.mjs                                       # /share（假 gh）与 /bug（zip / 离线拒绝上传）（D80，不联网）
node bridge/tests/ext-manager.mjs                                     # 扩展管理：清单与版本、启停、MCP 改版本、商店→pi mcp add、按钮开关、公网只读（D81）
```

`npm run typecheck` 分别跑 bridge 和 web 的 `tsc --noEmit`。

## 还没做

[`docs/PLAN.md`](docs/PLAN.md) 的 M5 后段与 M6：公网实测、微信/Web Push 的实机验收、开机自启与托盘、diff 卡片、移动端手势（左右滑切标签）。与 pi CLI 能力对齐的盘点见 [#8](https://github.com/Yang-Code01/pi-web-client/issues/8)，其中各项已经做完；做不到的（扩展的自定义 TUI 组件、接上终端里正在跑的进程）见那里的「架构上限」。

## 安全模型（别跳过）

这不是一个能直接丢到公网多租户跑的东西。默认只监听 `127.0.0.1`，登录靠首次生成的随机口令（3 个词 + 3 位数字，约 2.7×10⁷ 种组合；可用 `node bridge/dist/index.js --passphrase <更长的口令>` 换成更强的）。存储方式是 scrypt 哈希 + HMAC cookie，HTTP 登录和 step-up 共用每 IP 限流。开隧道时隧道只是运输层，唯一屏障是口令；公网进来的连接默认只读，要发消息和审批得再输一次口令（step-up）。会话文件是 append-only 且没有跨进程锁，所以「一个会话同一时间只有一个写者」是硬约束，bridge 只会拒绝，不会替你覆盖。

## 许可

[Apache-2.0](LICENSE) © 2026 Yang-Code01

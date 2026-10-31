# DECISIONS · pi-web-client

每条都是「决定 + 为什么」。标 **可改** 的是我按默认值定的，你觉得不对直接说，改起来都不贵。

## D1 审批策略：只拦危险模式
决定：bash / 写文件默认放行；拦 `rm|del|mv`、`git push`、`curl … | sh`、`npm/pip install`、写 cwd 之外的路径、`sudo`、改 `.git`。
为什么：逐次全批会在一周内把人烦到不看内容就点批准，那等于没有审批；只拦不可逆/跨边界的动作，既保住安全边界又保住可用性。被拦时可「本会话允许这个模式」（正则加进 gate 的进程内 allowlist，随会话结束失效）。

## D2 拒绝之后不强制停机
决定：`approved:false` 连原因回给 agent，让它自己换路；不因为一次拒绝就 abort。超时同理。
为什么：agent 换条路往往能完成任务（比如改用只读命令验证），强制停机只是把决定权又从你手里拿走一次。

## D3 真实安全边界在口令，不在隧道
决定：`trycloudflare` 只当运输层；公网上唯一屏障是登录口令（scrypt 哈希 + HMAC cookie + 5 次/分/IP 限流）。
为什么：没有域名就挂不上 Cloudflare Access；临时 URL 虽然难猜，但会出现在微信消息、浏览器历史、日志里，不能当访问控制。

## D4 通知只在三类事件推
决定：等审批、出错/中止、长任务（>5 分钟）结束。正文 = 会话名 + 命令摘要 + 当前 URL。
为什么：每条工具调用都推，两天后你会关掉通知；而关掉之后等于没有推送。URL 必须现取，因为 quick tunnel 每次重启都变。

## D5 控制面只做控制条，不做 slash 全集
决定：模型下拉、思考档位、中断、`/compact`。以 `/` 开头的文本仍原样转发给 pi。
为什么：RPC 已给结构化口子（`get_available_models`/`set_model`/`set_thinking_level`）；slash 全集每个命令的参数与确认都要单独写 UI，而手机上敲命令的体验远差于点按钮。

## D6 会话 = 进程，一进程一会话
决定：网页里的每个会话是一个 `pi --mode rpc` 子进程；空闲 2 小时回收，下次点开复活（同 session path）。
为什么：pi 的 RPC 一个进程只有一个 active 会话（`switchSession` 是替换），想并行就得并行进程；这也是唯一能让「关了页面它还在跑」成立的结构。

## D7 新建会话的 cwd：最近列表 + 手输
决定：新建时从「最近用过的 cwd」选，兜底手输绝对路径；不引入文件浏览树。默认值取哪个目录、按什么优先级，见 **D59**。**可改**
为什么：网页里做目录浏览树是为一次性动作付长期成本，而用户通常只在自己那几个项目间切换。

## D8 只读 tail 终端会话，且 UI 必须标死
决定：列表里标 `tty · 只读`，会话顶部常驻横幅「这个会话在终端里，审批要回终端做」。
为什么：终端会话的审批框只存在于 TUI 进程内存里，jsonl 里没有痕迹；不标死的话，你会一直等一个永远不会弹的审批框。

## D9 首连/重连用 `get_entries` 全量重建
决定：任何一次 WS 连接（含断线重连）都以 `get_entries` 快照为起点，之后才消费增量事件；`message_update` 的 delta 用 `message_end` 的完整消息覆盖。
为什么：RPC 事件没有 seq、没有 replay，delta 丢了就永久漂移；全量重建是唯一不依赖事件完整性的正确做法。

## D10 「批准」两段式，拒绝单击
决定：点「批准」→ 按钮变「确认批准」并在 3 秒后复原；「拒绝」单击生效。
为什么：手机上一指头滑过就批掉一条命令是真实代价，而拒绝是安全方向、不需要防误触。两段式在手机和桌面行为一致，不需要教新手势。

## D11 视觉：卡片流为主体 + 队列侧栏
决定：见 `docs/prototype/d-mix.html`。桌面三段（会话栏 / 卡片流 / 需要你），手机底部三标签（会话 / 对话 / 需要你）。
为什么：卡片头（工具 + 目标 + 耗时 + 结果）是「扫一眼知道它干了什么」的最低价形式；而多会话时只有队列能保证不漏批。移动端弹层审批不做——卡片本身已经在流里，再弹一层是重复。

## D12 微信通道：直接复用 iLink Bot 凭证发送
决定：只读 `~/.pi/agent/wechat-assistant/credentials.json`，`POST {baseUrl}/ilink/bot/sendmessage`，`context_token` 从 `context-tokens.json` 取；失败退避一次后标红。
为什么：官方接口、不碰插件的锁、不需要登录态握手；不自己实现微信协议，避免封号风险。插件负责收，bridge 只负责发。

## D13 代码栈：Vite + TypeScript，无 UI 框架
决定：bridge 用 `node:http` + `ws`（唯一运行时依赖）；web 用 Vite + 原生 TS + 一个几十行的 store 与渲染函数。
为什么：界面是「一条流 + 一个队列」，状态机很浅；引框架换来的是构建体积与抽象层，不是速度。**可改**（真觉得手写 DOM 难受就上 Preact，3KB 不影响架构）。

## D14 默认值（都可改）
- 端口 `7864`；bridge state 目录 `%LOCALAPPDATA%/pi-web-client/`
- 审批超时 `5 分钟`；长任务推送阈值 `> 5 分钟`
- 会话空闲回收 `2 小时`；未知口令限流 `5 次/分/IP`；cookie 有效期 `30 天`
- 上传图片：长边 ≤ 2048、≤ 4MB；uploads 保留 `7 天`
- 目标 pi 版本锁 `1.4.0`；启动时读 `pi --version`，不一致就在页面顶部挂一条警告（不阻断）
- 主题：仅暗色，中文界面

## D15 公网会话降级：写与审批前再验一次口令
决定：隧道常开；来自非局域网地址的连接 = 只读会话（能看能读，不能发消息、不能批、不能改配置）。要写/批，先在网页上重输一次口令，换一个 10 分钟有效的 step-up 标记。
为什么：口令会出现在微信消息、浏览器历史和日志里，泄露的后果从「机器被控」降到「别人看一眼聊天记录」。10 分钟窗口让手机上只需偶尔输一次，不至于每次批准都输。
实现：**不能只看 socket 对端**——经 cloudflared 进来的请求对端永远是 `127.0.0.1`。判据是「有 `cf-connecting-ip` 头 = 走隧道 = 公网」；没有该头且对端是私网段（`127.*`/`10.*`/`192.168.*`/`172.16-31.*`/`::1`）= 局域网。公网且无 step-up → 403 `{needsStepUp:true}`，前端弹口令框。限流按 `cf-connecting-ip`（无则 socket 地址）计。
**已实测（2026-10-30）**：Origin 侧看到 `peer=127.0.0.1`、`cf-connecting-ip=112.20.92.2`、`x-forwarded-for` 同值、`x-forwarded-proto=https` —— 判据成立，`Secure` cookie 也可按 `x-forwarded-proto` 判断。

## D16 RPC 客户端自己写，不用内置 `RpcClient`
决定：`bridge/src/rpc.ts` 自实现 JSONL 分帧与 id 关联。
为什么（实测）：`RpcClient.handleLine` 会把 `extension_ui_request` 派发给监听者，但类**没有任何公开方法**能发 `extension_ui_response`；其私有 `send()` 是 `{...command, id: 'req_N'}`，**id 在后会覆盖**调用方的 id —— 审批应答必须原样回服务端那个 id，这条路走不通。分帧规则文档已给全（按 `
` 切、去 CR、**禁用 readline**，因为它会按 U+2028/2029 切断 JSON 字符串）。

## D17 审批超时交给扩展的 `opts.timeout`，不由 bridge 计时
决定：gate 里 `ctx.ui.confirm(title, msg, { timeout: 300000 })`；bridge 只负责让 UI 卡片到点变灰。
为什么（实测）：给了 `timeout` 时 pi 自己会在到点时以 `false` resolve 扩展里的 promise（探针 3 秒超时验证过），扩展自然返回 block。bridge 再自己计时只会制造两份真相、还可能和 pi 抢着 resolve。

## D18 子进程参数：`-ne` + 显式装我们的扩展
决定：`node <cli.js> --mode rpc --session <path> --no-extensions -e ext/approval-gate.ts [-e ext/web-ask.ts]`。
为什么（实测+文档）：`-ne` 只关扩展发现，显式 `-e` 仍生效，settings 里的 provider/model/tools 照常读取；不加载 `pi-lens`（每个子进程一套 LSP 太重）、不加载 `question`/`questionnaire`（它们走 `ctx.ui.custom()`，RPC 下返回 `undefined`，工具必然坏）。技能与 prompt 模板**不关**（`--no-skills` 只在探针里用过），保持和终端一致。

## D19 中断顺序：先清审批，再 abort
决定：「中断」按钮 = ①把该会话所有 pending confirm 以 `{cancelled:true}` 应答 → ②发 `abort`（客户端 5 秒超时，不阻塞 UI）→ ③等 `agent_settled`。
为什么（实测）：有 pending confirm 时 `abort` **永远不返回 response**（15s/8s 两次都没回），而补发 `cancelled` 之后 `agent_settled` 立刻到达、`isStreaming=false`、下一条 `prompt` 正常。直接 abort 只会把界面卡成「正在中断…」。

## D20 会话复活 = `--session <已有文件>`
决定：回收或重启后，用同意 `--session <path>` 重新 spawn 即可拿回全部历史。
为什么（实测）：恢复出 16 条消息 / 18 个条目 / 同一个 leafId，`get_message`、`get_entries` 都完整。增量重连用 `get_entries(since=lastEntryId)`（since 是**排他**的）。

## D21 v1 不带 `question` 工具的完美替代
决定：自带 `ask` 工具（`ext/web-ask.ts`）：`ctx.ui.select` 出选项 + `ctx.ui.input` 收自由文本，网页渲染成选择卡；不追求与终端 questionnaire 一模一样（终端那个有标签页和自定义组件，RPC 下拿不到）。**可改**
为什么：agent 在网页会话里仍然需要「问你一句」，而 `custom()` 在 RPC 下是 `undefined`，两个人写的扩展直接没用。

## D22 cookie 属性跟着来源变
决定：经隧道（有 `cf-connecting-ip` 或 `x-forwarded-proto: https`）时 `Set-Cookie` 带 `Secure`；局域网直连 http 时不带 `Secure`，改 `SameSite=Lax`。两种都 `HttpOnly`。
为什么：局域网是裸 http，`Secure` 的 cookie 浏览器直接不存 → 在家反而登不进去。

## D23 bridge 的会话就落在 pi 默认 sessions 目录
决定：不另建目录，`~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`，与终端共享；bridge 用自己的 `locks.json` 标记 owner，防止两边同时写同一个文件。
为什么：共享目录 = 你在终端 `pi` 里 `/resume` 能看到网页发起的会话（这就是「同一份状态」的落地）；pi 自己没有跨进程锁（已查实），所以锁必须由 bridge 维护，且只在网页侧生效——终端那边无法被拦，只能靠 UI 标注和交接提示。

## D24 通知双通道：微信主力 + Web Push 兜底
决定：先发微信；`ret !== 0` 或出现 `errcode` 时立刻转 Web Push；两者都不可达才只剩页面内角标。VAPID 密钥首次启动生成、存 state 目录；订阅端点按设备存。
为什么（实测）：iLink 只允许「最近活跃过」的会话被 bot 主动发起。本次 `context_token` 是 2.7 天前写的，`sendmessage` 返回 HTTP 200 + `{"ret":-2,"errmsg":"prepare failed"}`，消息一个字没送到；而 `getconfig` / `notifystart` 都 `ret:0`，证明 token 有效——失效条件是不可预知的，正好砸在「你很久没看手机」的时候，所以必须有第二条不依赖第三方的通道。iOS 要先把页面加到主屏幕才有 Push（本身也是 PWA 该有的形态）。
依赖变更：bridge 依赖从「仅 ws」改为「ws + web-push」（VAPID + RFC 8291 加密自己手写不划算）。

## D25 微信发送的实现细节（照实测坑写）
- 必须**同时**检查 `ret` 与 `errcode`：`errcode:-14 session timeout` 的响应**没有** `ret` 字段，只看 `ret` 会把登录过期当成功（插件就是这么错的）。
- `content-type: application/octet-stream` 不是 JSON，别按 header 判断正文。
- `context-tokens.json` 只读不写（插件整文件重写）；只需要「发」就不碰 `session.lock`，两个进程并发发消息不会互相顶掉。
- 长文按 800 字符分片（插件同样规则），自建 ≥1 条/秒软限速 + 失败退避；源码里没有任何发送端限流。
- 失败时 UI 给可执行的话术：「给 bot 发一条任意消息，推送就会恢复」。

## D26 会话列表与历史读取策略（实测 182 文件 / 634MB）
- 列表只用 `stat`（mtime/size）+ 每个文件**前 4KB** 的 header（`type:"session"`、`version`、`id`、`cwd`、`timestamp`）——**绝不**在列表阶段 parse 全文（本机有 290MB 的单文件）。
- 会话身份以 header 的 `id` 为准，不信文件名（文件名虽含 sessionId，但别依赖）。
- 打开会话才流式读：1 MiB 分块，单轮上限 4 MiB；entry 是 parentId 树，需保留 `id→parentId` 全图（增量读来的新条目可能指向很早的父节点）。
- 磁盘上没有「当前 leaf」指针（`branch()`/`resetLeaf()` 只改内存）；外部读者的唯一近似是「最后一行 = leaf」，与 pi 重新打开文件时的行为一致。
- `label` 是追加型条目：维护 `Map<targetId, label>`，空串表示清除。

## D27 只读 tail 的三件套检测（实测 append-only）- `stat.size < offset` → 判定截断/重写，offset 归 0、全量重扫。
- 记住前 512 B 的 sha，每次读新数据前重比对 → 兜住「size 没变但内容被原地重写」。
- 只消费到最后一个 `
`；尾部半行留在缓冲，offset 只推进到最后一个换行的下一字节。
- 单行 parse 失败只计数跳过；连续 ≥3 行失败或本次新增失败率 >10% → 全量重扫。
- 轮询：`fs.watch` 在 Windows 上对「别的进程 append」不可靠，只当唤醒信号，真实触发靠 200–500 ms 的 `stat` 轮询；只对「当前打开的那一个会话」轮询。
- `size === 0 && offset > 0` 时不要立刻重置（重写瞬间），先等 50–200 ms 再看。

## D28 历史以会话文件为准，RPC 只负责命令与实时事件
决定：会话内容（历史、分支、compaction、label）由 bridge 直接读 `.jsonl`（D26/D27 的读法），实时状态（流式 token、工具执行中、审批、队列）由 RPC 事件驱动；在 `turn_end` / `agent_settled` / `compaction_end` 时做一次增量追平。网页发送、审批、控制用 RPC 命令。
为什么（实测）：`get_entries` **没有 limit/offset**，一次返回全部条目——本机有 290 MB 的单文件，那样的会话打开一次会把几十 MB JSON 塞进内存和 WebSocket。而 `entry_appended` 事件只在扩展调 `pi.appendEntry()` 时发，普通消息落盘**没有**对应的 RPC 事件，所以也不能只靠事件补历史。文件是 append-only 且已验证与 RPC 内容一致（复活实测：文件 18 条目 = `get_entries` 18 条目）。
好处：网页会话与终端会话走**同一条读取路径**，只读 tail 与「自己开的会话」共用代码，不用两套。

## D29 隧道：cloudflared quick tunnel 的落地参数（本机实测）
- exe：`C:\Program Files (x86)\cloudflared\cloudflared.exe`（2026.10.6，已装；**不在 PATH 的旧 shell 里**，实现方用绝对路径，且保留「注册表/目录搜索」兜底）。
- 启动：`tunnel --url http://127.0.0.1:7864`，env 注入 `HTTPS_PROXY/HTTP_PROXY = $BILLION_CONTEXT_PROXY`（本机不带代理时 `api.trycloudflare.com` 时好时坏，一次直接 TLS 失败）。
- URL **只在 stderr**（stdout 恒 0 字节），解析：`/\|\s{1,}(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)\s{0,}\|/`。别用宽松正则去抓——失败日志里有 `api.trycloudflare.com`，会抓错并白折腾。
- 时序预算：等 URL 15 s（实测 6.4–6.9 s）；等首个 200 再 30 s（实测 URL 出现后还要 ~12 s）。未就绪时是 `curl code=000` 连接超时，**不是 502**。
- 就绪判据：自己的 HTTP 探测拿 200（Node 的 `fetch` 默认不走代理，天然正确）。死隧道判据：HTTP **530** + body 含 `errorCode:1033`。
- 失败重试：cloudflared 自己**不重试**（quick tunnel 创建失败就退出），必须整进程重拉，URL 会变 → 通知「地址已变」。
- 停止：Windows 上 `taskkill /F /PID <pid>`（不带 `/F` 无效）。
- 副作用：额外占 `127.0.0.1:20241` 起的 metrics 端口。
- 不需要浏览器授权、`--no-autoupdate` 在 Windows 上是空操作（日志明说不会自动更新）。

## D30–D34（实现 M1 时撞出来的，已生效）

**D30 流式期间发消息 = `streamingBehavior:"followUp"`。** pi 在 turn 未结束时收到裸 `prompt` 会直接拒绝；bridge 在 `Session.state.running` 时自动加 `streamingBehavior:"followUp"`，于是「跑着呢，再发会自动排队」这句占位文案才是真的。

**D31 接手守卫看 mtime，不看「终端是否开着」。** 无法探测终端进程，但会话文件 20 秒内被写过就说明大概率还有人写着：`openLive()` 直接拒绝并提示「先退出那边的会话」。宁可误拒 20 秒，也不要静默双写（双写会产生互不可见的兄弟分支，见 `pi-integration-facts.md`）。

**D32 gate 读 `event.input`，且无 UI 时 fail-closed。** `tool_call` 事件字段是 `{toolCallId, toolName, input}`（`dist/core/extensions/types.d.ts:931`），写成 `event.args` 会让门禁永不触发——`rm -rf` 实测直接跑掉。另外 `ctx.hasUI === false`（例如被别的模式加载）时必须阻断而不是放行：宁可卡住，不可静默执行危险命令。

**D33 pi CLI 的解析顺序里必须有 nvm4w 兜底。** 本机 `node` 是 `C:\nvm4w\nodejs\node.exe`，但 pi 装在 `%LOCALAPPDATA%\nvm\v23.11.1\`。只按 `dirname(process.execPath)` 找必然失败；顺序定为 `PI_BIN` → `%LOCALAPPDATA%\nvm\v*\node_modules\...`（版本倒序）→ PATH 里 `pi*.cmd` 内容中的 `*.js` → `npm root -g`。另外启动必须用 `node <cli.js>`，不要 spawn `pi.cmd`（里面带 `%COMSPEC%`/`title`，且会多一层 shell）。

**D34 空白不能占位。** 只带思考/工具调用的 assistant 消息不画空气泡；审批倒计时用 `M:SS` 每秒更新而不是「5 分 0 秒」静态文本。反过来，布局上凡是 `1fr` 的 grid 轨道都要写成 `minmax(0, 1fr)`——否则等宽字体路径会把手机端挤爆，卡片右边被切掉（实测踩过）。

**D35 模型目录用一次性 rpc 子进程取，不挂在会话上。** 模型列表属于 pi 安装（`models.json`），与会话无关：bridge 在 WS 握手后用一个 `--mode rpc` 子进程发 `get_available_models`、拿到就杀，缓存 10 分钟，再用 `catalog` 消息推给前端。前端顶栏那颗 chip 显示「短名 · 档位」（`name.split(" · ")[0]`，因为同步脚本起的名字带价格与上下文），点开是底部抽屉：模型列表 + 该模型支持的思考档位（`thinkingLevelMap` 里非 null 的键，按 off…max 排序）。切换后必须再取一次 `get_state`——pi 会把档位钳到新模型支持的范围，不重取前端就会显示一个不存在的档位。

## D36–D39（m00200 三项：字号/颜色、HUD、上下文）

**D36 字号用 `zoom` 缩 `#app`，不逐条改 px。** 界面上百处字号都是 px，改成 rem 等于重写样式表；`#app { height: 100%; zoom: var(--ui-scale) }` 在 Chromium 里连高度都按 zoom 折算（实测 1.25 时 `getBoundingClientRect().height` 仍是 950，`height: calc(100% / 1.25)` 反而只铺 760 → 底部留黑）。四档 0.9/1/1.12/1.25，存 `localStorage["pi.prefs"]`。**浮层必须挂在 `#app` 里**（`App.overlay()`），挂 `document.body` 就不跟 zoom 一起缩放（实测抽屉还是 100%，与背景不同步）。

**D37 颜色 = 强调色 + 文字亮度两组，不动背景色。** 强调色改 `--accent/--accent-dim`（六色成对写死，暗色是给填充态用的深染），文字亮度改 `--text/--dim/--faint`（柔和/标准/明亮）。背景与描边不开放调节，否则对比度会塌。

**D38 HUD 的数据源分工：上下文与总量走 `get_session_stats`，速率走字符估算 + `usage.output` 校准。** pi 的 `get_state` 里没有 token（`dist/modes/rpc/rpc-mode.js:345`），`contextUsage.tokens` 只在 `get_session_stats` 里；而 `message_update` 的 `usage` 在本机 provider 上流式期间是空的，只有 `message_end` 的 `message.usage` 才准（实测 `output/reasoning` 齐全）。于是：bridge 在 `message_end`、`agent_settled`、`startSession`、`compact()` 后各推一次 `stats`/`usage`；前端流式期间用已到达字符估 token（CJK ÷1.5、其它 ÷4）算瞬时速率，turn 结束用 `usage.output ÷ (首 delta→结束)` 覆盖成准确值。**速率从首个 delta 起算，不含首 token 等待**，否则小回答会被 TTFT 拖成个位数。

**D39 HUD 摆位：桌面 fixed 右下角，手机落在 composer 底部一行内。** 桌面三栏时右下角是队列列底部，遮挡最小；手机上右下角会压住「压缩上下文 / 模型」两颗按钮（实测 hint 行两行折行，y 763 与 tabs 798 之间只有 35px），所以窄屏改为 `position: static` 排在 composer 里，右对齐。

## D40 上下文预算放在 bridge，不放 localStorage

**D40 预算是全局一份 `budget.json`，由 bridge 执行压缩。** 三条限制决定了它不能是纯前端设置：会话可能没有页面在开着（手机锁屏、标签关掉），压缩必须照常发生；`contextUsage` 只有桥能拿到（`get_session_stats`）；压缩本身是 rpc 调用。所以预算是桥状态 `statePath("budget.json") = {"value": 200000|null}`，`setBudget` 走 ws 写入并广播 `budget`，`refreshStats` 拿到 `contextUsage.tokens` 后判断超额。HUD 的 `/窗口` 在设了预算时改显示预算，`hot` 阈值随之从 80% 收到 90%。

**D40a 每轮只自动压缩一次。** `autoCompactUsed` 在 `agent_start` 复位、触发压缩时置位：否则压缩完仍超额（压缩会保留最近若干条）会立刻再触发，形成连环压缩。压缩失败（`Nothing to compact (session too small)`）只发 notice，不中断回合。

**D40b `case "session"` 必须顺手设置 `currentId`（顺带修掉的老 bug）。** bridge 对 `create`/`subscribe` 回的是 `{type:"session", sessionId, ...}`，前端原来只更新 `this.session` 却忘了 `currentId`，于是点「开新会话」后左边列表多了一张卡、中间还是「左边选一个会话」的空态。现在收到 `session` 就采纳它的 `sessionId` 并重置 HUD 计数。

## D41 显式「接管会话」按钮：写者是独占的，切换必须是人点出来的

**决定：** 磁盘上的会话在网页里默认只读预览，composer 上方一条 bar：左边说明、右边「接管会话」。点它发 WS `claim` → `SessionManager.claim(id)` → `openLive(id)` → `startLive({resume:true})`，拿写者锁、`owned=true`，之后发消息/切模型/思考档位/中断/压缩全部可用。已接管时同一条 bar 变成「网页是这个会话的写者」+「让回终端」（发 `close`：关 rpc、释放锁、回到只读 tail）。模型面板在没接管时不再死路，而是给同一颗「接管会话」按钮，接管成功后自动重开面板（`case "session"` 里判 `sheetKind === "model" && owned`）。

**为什么不是「发消息即接管」：** 那样切换是隐式的——你只是想看历史，却被静默变成了写者。**为什么不是「打开即接管」：** 每点一张历史卡就 spawn 一个 `pi --mode rpc`，手机翻记录等于开一堆进程。

**护栏保留、不给覆盖：** `openLive` 的「文件 20 秒内被写过就拒绝」原样留着。pi 没有会话文件锁（`pi-integration-facts.md:135-136`），双进程写同一 jsonl 会各自 `appendFileSync`、`parentId` 各指自己的 leaf，重载后是两条互不可见的兄弟分支，compaction 还可能把对方消息切掉（同文件 139-140）。所以「两边同时能写」不存在安全解，接管前终端那边必须真的退出。

**顺带修掉的 bug：** `readLock` 原来只看锁文件在不在，死进程留下的锁会让对应会话从列表里彻底消失（实测 13 个）。现在 `pidAlive()` 按 `process.kill(pid,0)` 判定（`EPERM` 视为活着），死锁读到即删；会话文件已不存在的孤儿锁由 `sweepLocks()` 在 `startGc()` 首次与每 60s 扫一遍清掉。实测 13 → 0。

**验证：** `probes/claim-probe.mjs`（空闲会话 claim 后 `owned=true`；正在写的会话被护栏拒绝），`probes/claim-check.mjs`（`close` 之后 `subscribe` 回来是 `owned=false`）。**可改**

## D42 根目录只留一层 npm 脚本，`npm start` 先编译再跑 dist

**决定：** 根 `package.json` 的 `start` 改成 `npm run build:bridge && node bridge/dist/index.js`，`build:bridge` / `build:web` / `dev:web` / `typecheck` 一律用 `npm --prefix <子包>` 转发；`test` 指向 `bridge/tests/e2e.mjs`。

**为什么：** 原来 `start: node bridge/src/index.ts` 在 Node 24 的 strip-only 下直接崩 —— `bridge/src/sessions.ts` 构造函数用了参数属性，报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。另外 `typecheck` 指向两个根本不存在的 `tsconfig.bridge.json` / `tsconfig.web.json`，`test` 指向空的 `bridge/test/*.test.ts`（`node --test` 报 0 tests 照样退出 0，等于没测），都要么修要么删。

**为什么走 `npm --prefix` 而不是根 `node_modules`：** 依赖本来就装在各子包里（`bridge/node_modules/.bin/tsc`、`web/node_modules/.bin/vite`），根目录没有 `node_modules`，根 `npm run tsc` 会找不到命令。

**验证：** `npm run typecheck` 两个包都过；`PI_WEB_PORT=7866 PI_WEB_STATE=… npm start` 打印 `listening on http://127.0.0.1:7866` 后正常被 timeout 杀掉，无残留监听。README 的「跑起来 / 测试 / 局域网」三处旧命令同步改掉了。**可改**

**D41a 按钮文案分源：网页新建的会话是「停止运行」，不是「让回终端」。** `SessionState` 加了 `origin?: "web" | "disk"`，只有 `startLive({resume:false})`（即 WS `create` 那条路）把它置成 `"web"`，磁盘会话构造时默认 `"disk"`。这是**出处**不是当前写者路径：网页新建的会话关掉再接管仍是 `"web"`（`startLive` 只在 `!opts.resume` 时写这个字段）。前端按它换文案——网页新建的会话没有「终端那边」可还，点它只是停掉 `pi --mode rpc` 子进程、释放锁、页面退回只读；说成「让回终端」是假的。

**为什么保留这颗按钮而不是藏掉：** 每个 `owned` 会话就是一个常驻 `pi --mode rpc` 进程（带模型连接），手机上并排开三四个会一直吃内存；「停止运行」是唯一的关闸。进程退出后历史照旧在磁盘上，点「接管会话」再起一个新进程，`--session` 续上。

**顺带修掉的排版 bug：** 390px 宽下 `.composer .hint-tools` 里的「压缩上下文」被挤成一字一行（`flex` 默认允许收缩到 min-content），而只加 `white-space: nowrap` 会让整条 composer 撑到 439px 横向溢出。最终做法：按钮 `flex: 0 0 auto; white-space: nowrap` + `.hint-tools` 自身 `flex-wrap: wrap; justify-content: flex-end`，窄屏改成两行右对齐。**可改**

## D43 改名：覆盖层只做显示，live 会话才让 pi 写文件

**决定：** 左边栏卡片 hover 出 ✎，点开就地改名（Enter 保存、Esc 取消、失焦保存），前端发 WS `{type:"rename", sessionId, name}`，桥端 `Session.rename()` 分两条路：live 会话先记 `statePath("names.json") = {"<id>": {"name","at"}}` 再发 RPC `set_session_name`（pi 会 append 一条 `session_info`，终端 `/name` 也看得见）；只读磁盘会话**只**记覆盖层。名字比较用时间戳：文件里最新 `session_info` 的 timestamp 比覆盖层 `at` 新，就以文件为准（终端改名夺回卡片），反过来以覆盖层为准。所有改动 `touch: false`——改名不该把卡片顶到列表最前。

**为什么不直接往只读会话的 jsonl 里 append 一条 session_info：** D31 已经写死 bridge 从不写 pi 的会话文件——写者是独占的，双写会造出两条互不可见的兄弟分支；就算只 append 一个无副作用条目，也是在 pi 可能正在追加的文件里插字节。

**为什么不为只读会话起一个 `pi --mode rpc` 去改名：** 翻历史卡不等于开进程（D41），改个显示名更不值得一个常驻子进程；而且 `--session` 续接后 pi 会接管写者锁，等于把只读预览变成写者。

**为什么名字要尾扫：** `session_info` 是追加写，190+ 条的历史会话长到几 MB，原来的 `readMeta` 只读头 8KB，终端改过的名字读不到（旧 bug）。现在 `stat.size > HEAD_BYTES` 时再读尾 8KB 找最后一条 `session_info`，`nameAt` 一并带出来。`metas()` 刷新缓存（5s）后调 `syncNames()`：已实例化的只读会话按 `preferredName()` 采纳新名字，未打开的文件在 `list()` 里同理。

**浏览器验证：** `probes/rename-ui.mjs`（隔离桥 + 两个手工会话 + Chromium）：输入框自动聚焦全选 → Enter 改名 → 刷新后仍在（`names.json` 持久化）→ Esc 不保存 → 失焦提交 → 卡片仍能点开聊天。**桥端验证：** `node bridge/tests/rename-check.mjs`：只读改名后文件字节数与 mtime 都不变；手写更新的 `session_info` 5 秒内夺回卡片；claim 后续接 live 会话改名，名字真的追加进了 `.jsonl`；空名得到 error notice。**可改**

## D44 失败的工具调用在折叠模块之外再钉一条失败条（画法已被 D49 取代，位置与「不折进模块」的结论仍有效）

**决定：** 一轮里的工具调用照旧折进一个 `<details class="ops">`（标题 `19 个操作 · bash ×19 · 1 失败`）。新增的是：任何失败的工具调用**同时**在模块后面钉一条独立 `.failbar`（`web/src/chat.ts` 的 `failureBar()`），默认展开，内容是「✕ 工具名 + 完整命令」一行、「首条错误行」一行（收起时才显示，`firstErrorLine()` 优先挑 `fatal|error|failed|cannot|denied|not found|timed out|ENOENT|EACCES|Traceback|✗`，跳过 `$ ` 开头的命令回显）、`失败 · 21.4s` 元信息、以及 `<pre>` 里的完整输出（`max-height: 240px` 自己滚）。失败条按 `toolCommitId` 存进 `failBars` 映射，live（`toolEvent("end")`）和历史回放（`add()`/`replace()`/`mergeTool()`）走同一个方法，所以刷新页面后样式一致。

**为什么不在标题旁边就地展开模块（样张 B）：** 19 条操作全铺开会把整整一屏的正文顶走，而失败通常在列表最末，还是要滚；长会话每次失败都撑一次版面。

**为什么不把失败卡从模块里拎出来当独立红卡（样张 C）：** 会打断「一轮 = 一个模块」的结构（这条结构就是 D 系列之前把工具卡收进模块的理由），且多次失败会堆一叠红卡。

**为什么默认展开而不是折叠：** 失败是必须看见的信息，摘要一行里已经带了首条错误，完整 stderr 是第二眼要的东西；`max-height` 保证再长也只占十几行。**可改**

**为什么插入位置要记 `failAnchor`：** `box.after()` 每次都插在模块正后面，第二条失败会跑到第一条前面；`failAnchor` 指向最后一条失败条，新条插它后面，一次失败一眼一条，顺序跟发生顺序一致。

**验证：** 三个可交互样张在 `.scratch/ops-failure/prototype/`（`index.html` 目录页）；真实组件用 vite 探针页驱动 `chat.reset()`（历史路径）和 `chat.toolEvent()`（live 路径）截图确认 —— 折叠态显示 `git push -u origin feature/ops` + `fatal: unable to access …:443` 截断行，展开态显示完整 3 行 stderr，模块标题仍是 `19 个操作 · bash ×19 · 1 失败`。探针页验证后已删除，样张保留。

## D45 会话列表按创建时间固定排序，卡片右下角只放「待确认 / 完成」

**决定：** 列表顺序的唯一键是 `startedAt`（pi 会话文件 header 的 `timestamp`；网页新建的会话在构造时补一个 `new Date().toISOString()`，否则它永远排不上号），降序、不随 `updatedAt` 变化 —— 某个会话回答完、改名、改模型都不挪位置，只有新开会话落在最上面。排序在桥端 `SessionManager.list()` 和前端 `renderSessions()` 各做一次（两端都可能有会话在跑，前端收到 `session.state` 后要原地合并，不能指望顺序来自服务端）。卡片右下角（`meta` 行右侧，相对时间在左）只放一个状态徽标，优先级 `待确认 N`（`approvals > 0`，黄）> `完成`（`done` 且不是当前打开的会话，绿）> `运行中`（蓝）。名字行只留名字和 ✎；圆点仍表示运行/占用。

**为什么徽标由桥端算 `done` 而不是前端记「刚从 running 变 idle」：** 前端只在页面开着时看得到变化，刷新一次、换手机看，完成状态就丢了；桥端在 `agent_start` 置 `done:false`、`agent_end`/`agent_settled` 置 `done:true`，状态跟着会话走。清理由「把快照交给客户端」触发（`Manager.snapshot()` → `Session.markSeen()`），也就是 `subscribe` 那一下；这同时意味着另一台设备点开卡片，这边的「完成」也会消 —— 完成是会话的属性，不是某页的未读。

**为什么只做 live 会话的「完成」：** 只读会话的写者是终端里的 pi，「这一轮结束」在桥这侧没有事件，只能靠文件顿住去猜；猜错比不猜更烦。这类会话能收到的是「待确认」——审批只发生在桥拥有的 pi 子进程里。

**为什么不按 `updatedAt` 但加「新消息」角标保留排序：** 用户要的是「位置不动」，不是「位置动但有提示」；排序键换了才根治跳位，徽标负责通知。

**验证：** `node bridge/tests/session-flags.mjs`（隔离桥 7875 + 真 pi + Chromium）：创建「顺序 A」→1.1s→「顺序 B」后 B 在前且都带 `startedAt`；A 跑完一轮后 `done=true`、`A.updatedAt` 比 B 新但 A 仍在 B 下面；浏览器里 A 卡右下角显示「完成」（`.scratch/session-flags/shots/1-done.png`、`2-card-done.png`），点开卡片后消失且 `/api/sessions` 里 `done=false`。**可改**（想改成升序或「完成」也提示只读会话，都是这一处）

## D46 为什么失败条会被压成 2px 红线：`.chat-scroll` 是 flex 列 + 子项 `overflow: hidden`

**现象：** 用户回答完 `question` 之后（正文变长、会话超过一屏），失败条塌成一条 2px 的红色细线，错误信息「消失」（`.scratch/ops-failure/shots/` 对应的用户截图）。

**根因（实测复现）：** `web/src/styles.css` 的 `.pane { overflow-y: auto; }` 和 `.chat-scroll { display: flex; flex-direction: column; gap: 12px; }` 作用在同一个元素上（app.ts 的 root 是 `.pane chat-scroll`），于是它是一个**高度确定、会滚动的 flex 列容器**：内容超高时子项按 `flex-shrink: 1` 被压缩。普通 `.msg`/`.ops` 的 `min-height: auto` 等于内容高度，压不动；而 `.failbar` 带 `overflow: hidden`（为了裁圆角），按规范 `min-height: auto` 退化成 **0**，于是它是唯一能被压到底的项 —— 长会话里被压成只剩上下 1px 边框 + 3px 左边框 = 2px 红线。探针实测：`flex: 0 1 auto; min-height: auto; overflow: hidden` → `failbar: h=2.0 scrollH=91`。

**修法：** `.chat-scroll > * { flex: 0 0 auto; }` —— 列里的每一块都按内容高度排，超高就滚，不再互相挤压。修后同一探针 `h=93.4`，`scrollH 2261 > clientH 900` 滚动恢复。

**教训：** 「滚动容器 + flex 列 + 子项 `overflow: hidden`」是压缩到 0 的经典组合；以后往 `.chat-scroll` 里加任何自带 `overflow: hidden` 的块（气泡、卡片、条），都要确认这条 `flex: none` 还在。

## D47 网页端「问用户」走桥内部 HTTP 旁路，不改 pi 的 RPC 对话框

**问题：** 网页会话里模型调 `question` / `questionnaire` 只会得到 `Error: UI not available (running in non-interactive mode)` —— 两个扩展都有 `if (ctx.mode !== "tui")` 硬门，而桥用 `pi --mode rpc` 起子进程。

**决定（三条，用户逐条点头）：**
1. **通道**：扩展在 `ctx.mode === "rpc"` 时把完整 payload POST 到 `http://127.0.0.1:<port>/api/ask`，桥推 WS、等答案、原样返回 `{answers, cancelled}`。env 注入 `PI_WEB_ASK` + 每子进程一个 `PI_WEB_ASK_TOKEN`（照 `PI_WEB_ALLOW_FILE` 的旧例，`sessions.ts` 拼 `RpcChild` env 那一处）。
2. **扩展**：原地改全局 `~/.pi/agent/extensions/question.ts` / `questionnaire.ts`，先备份 `.bak.<时间戳>`；TUI 分支一行不动。
3. **留痕**：答过的 Q/A 变成聊天里的气泡，从 tool item 的 `args` + `result` 文本重建，刷新后仍在。

**为什么不用 pi 已有的 RPC 对话框：** `pi/docs/rpc-extension-ui.md` 只暴露 `select`（`options: string[]`，**没有描述**）、`confirm`、`input`、`editor`；`ctx.ui.custom()` 在 rpc 下返回 `undefined`。桥现在的 `onUiRequest` 更狠：把四种对话框压成一个 `ApprovalRequest{title,message}`（`req.options` 直接丢）、回答只发 `{confirmed}` / `{cancelled}`，**永远不发 `value`**。也就是说这条路连「选项」都送不到浏览器，多题 tab 更无从谈起。旁路是唯一不改 pi、也不假装自己是审批的走法。

**为什么不做成新工具：** 另写一份 `web_question` 意味着模型要学两个名字、终端和网页行为分叉，而且用户笔记/技能里已有的 `question` 调用不会自动受益。改原地只多一个分支，`--mode rpc` 才触发。

**为什么不设超时：** 问就是为了要一个决策，猜出来的答案比等待更糟；超时返回 `cancelled` 会让模型在无人时自作主张，还把「没人回答」记成「用户拒绝」。所以问题一直挂在桥内存里（关页面也在），只有作答 / `abort` / 进程退出能结束；代价是这一轮的 `followUp` 队列会堵住，所以 composer 上方必须有顶条说清楚「1 个待答」。

**为什么不落盘：** `ask` 的寿命属于那个 pi 子进程 —— 桥重启时子进程一起死，问题自然消失；持久化反而会在重启后复活一个没人能答的问题。重连靠 `snapshot()` 补发（照 approvals 的做法）。

**防护（三道，缺一不可）：** 路由放在 `if (!ok)` cookie 闸**之前**（子进程没有 cookie），因此自带检查 —— `isTunnelRequest(headers)` 为真直接 403（公网永远进不来）、peer 必须是回环地址、token 必须匹配某个 session。作答走 WS `answer`，与 `approve` 同级，同样要 `requireStepUp()`。

**UI：** 底部抽屉（单题点选即答；多题 tab + 显式「提交」，可回改；都带「取消这次提问」和「自己写…」）+ composer 上方一条「待你回答 · 点此回答」顶条。关掉抽屉不再自动弹回（`askSeen` 记 id），但**刷新/重连时**没展示过的问题会自己弹开 —— 否则用户回来只看到模型不动。问句卡片不进 `.ops` 折叠模块：它是内容，不是操作记录，`chat.ts` 的 `add`/`replace`/`toolEvent` 三处都要绕开 ops 分组。

**验证：** `npm run test:ask`（`bridge/tests/ask-unit.mjs` 注册表单元 + `ask-e2e.mjs` 隔离桥 7891：三道闸 403、`/api/sessions` 仍 401、真模型单题作答拿到 `User selected: 2. 右边`、两题问卷取消拿到 `User cancelled the questionnaire`）；`npm run test:ask:ui`（`ask-ui.mjs`，真 Chromium + 真模型六轮：抽屉自弹、顶条、刷新补发、点选即答、气泡、两题 tab + 提交、自己写 `User wrote: 随便写点`、停止运行让 pending ask 以 `cancelled` 收尾、390px 手机版）。截图在 `.scratch/shots/ask-*.png`。

**可改：** 想让「新会话默认允许提问」变成开关、或把抽屉改成行内展开（不遮住会话），都只动 `web/src/app.ts` 的 `openAskSheet` + `styles.css` 的 `.ask-sheet`。

## D48 会话管理：置顶 / 拖拽排序 / 归档 / 删除都只动 `state/manage.json`，删除才碰文件

**需求：** 侧栏要能管理（m00507），用户在三个样张里选了 **A+C**：单列表 + 置顶拖拽 + 管理模式多选（样张留在 `.scratch/session-manage/`）。

**pi 侧没有这些命令。** `dist/modes/rpc/rpc-mode.js` 的 case 表里只有会话级操作（prompt/abort/compact/clone/export_html/set_session_name…），没有删除、归档、分组 —— 所以排列与归档只能是桥自己的状态，删除只能在桥端做文件系统动作。

**决定（一个文件 `state/manage.json`）：** `{ pin: string[], order: string[], archived: string[] }`。三件事都是「用户对这个会话的意图」，不是会话本身的属性，所以不进 pi 的 jsonl（D31 的同一个理由：桥不写别人的文件）。排列算法在 `bridge/src/manage.ts` 的 `compare()`，与 `web/src/app.ts` 的 `arrangeCompare()` 逐条对应：归档沉底 → 置顶按手序 → `order` 按手序 → 两者都不在手序里的（新会话）按 `startedAt` 降序、并排在所有手排项**之前**。新会话永远落在「其它」最上面，不会插进用户手排的顺序中间。

**为什么 `arrange` 收两份完整数组而不是「把 X 挪到 Y 前」：** 拖拽结束时 DOM 就是用户刚排好的顺序（`commitArrangement()` 直接读 DOM），两端各算一遍更容易分叉；整表覆盖是幂等的，多次拖拽也只是最后一次赢。被过滤隐藏的会话没有 DOM 位置，`commitArrangement()` 会把它们按原顺序补在末尾，不会因为一次过滤后的拖拽把它们丢掉。

**归档是纯显示：** `list()` 仍然返回归档会话（带 `archived: true`），由前端决定放进折叠的「已归档」段；`/api/sessions` 的消费者（手机、脚本）不该因为网页上收起来就以为会话没了。

**删除的护栏（缺一不可）：** 只删「非 live、无待审批、没有别人持有 `state/locks/<id>.lock`」的会话；有一个不满足就整批拒绝，并报 `N 个会话正在运行/待确认，不能删：…`（不是部分成功）。通过后：删 `.jsonl` → 关掉只读 tail → 从 `sessions` 表移除 → `forgetName(id)`（D43 的覆盖层）→ `manage.forget(id)` → **清 `metas()` 的 5 秒扫描缓存**（否则下一次 `/api/sessions` 会把刚删的会话复活 5 秒，这是探针抓到的真 bug）→ 广播 `session.gone`。前端两步确认（4 秒内再点一次才发命令），因为它不可撤销。

**交互细节：** 卡片永远只有一个点击语义 —— 非管理模式下打开会话，管理模式下切换选中；✎ / ☆ 都 `stopPropagation`。拖拽手柄只在 hover 时显示，且**过滤生效时禁用拖拽**（看不见的卡片没法排位置）。归档段默认折叠，数量在段头；管理条移动到列表上方（侧栏会滚动，放底部会被裁掉一半，样张里就出现过）。

**验证：** `node bridge/tests/manage-check.mjs`（隔离桥 7876 + 3 个手工会话文件 + 真 pi 建一个 live 会话）：pin/order 写入 `manage.json`、排序按 pin→order、归档后 API 仍在且沉底、删只读会话后文件 + `names.json` + `manage.json` 三处都干净、live 会话删除被拒、**重启后排列仍在**。`node probes/manage-ui.mjs`（真 Chromium + 隔离桥 7877）：☆ 置顶、拖 戊 到 乙 下方、管理模式下选 2 个归档 → 展开已归档 → 恢复、两步删除真的删掉文件、过滤只剩 1 张且不可拖。截图在 `.scratch/manage-ui/shots/`。**可改：** 想加分组就在同一个 JSON 里加 `groups`（样张 B 已写过）；想把归档做成「真的看不见」只需 `list()` 过滤 `archived`。

## D49 失败诊断：界面要给的是「结论」，不是「更多原文」（取代 D44 的画法）

**需求（m00246 原话）：** 「失败现在只能看到详细信息，但是有时候无法判断到底是什么问题，有没有好办法解决？」

**先摸事实。** 桥给前端的只有 `isError` + 工具输出文本（`bridge/src/sessions.ts:596-625`，`contentText` 截到 20000 字符），**没有 exitCode、没有 stderr 分离**。但退出码在文本里：pi 的 bash 结果末尾固定追加 `Command exited with code N` / `Command aborted`。把本机 `~/.pi/agent/sessions` 里 512 条不同失败指纹统计出来，分布是这样的：`exit 1` 386 条（grep/ls/find「没找到」占大头）、`XxxError:` 77 条（SyntaxError 36 / ModuleNotFoundError 23 / TypeError 20 / FileNotFoundError 19 / AttributeError 16 / ParserError 14 / UnicodeEncodeError 12 / NameError 8 / UnicodeDecodeError 7 / AssertionError 4）、edit 未命中原文 42 条、errno 家族 42 条、`Validation failed for tool "…"` 18 条、`Command aborted` 8 条、`fatal: not a git repository` 5 条、exit 128/49 各 10 条、exit 127 4 条。**这些需要的判断完全不同，界面却一视同仁** —— 这就是「看不清到底是什么问题」的真正原因。顺带暴露 D44 的画法有多浅：`firstErrorLine()` 在 traceback 上抓到的是 `return codecs.charmap_decode(input, self.errors, decoding_table)[0]` 这种毫无意义的行。

**决定了什么：** 用户从四个可打开样张里选了 **D · 报告卡 + 关键行**（`.scratch/failure-diagnosis/`，生成器 `build.mjs`，截图 `shots/`；四个方案共用一套诊断规则，只是画法不同）。选 D 的理由：既有结论（不用读日志就能判断），又留着「凭据」（带行号的几行关键日志），完整输出再折一层，不丢原文。同时**不做**「让 pi 看看」按钮 —— 桥端 `openLive()` 对只读历史会话发不了 prompt，这按钮得按会话可写性禁用；诊断规则本身已经答掉大部分问题，等用一阵子看还剩下什么再补。

**落的代码：**
- `web/src/diagnose.ts`（新）—— 规则全在这里，不碰 DOM：`diagnose({tool, cmd, out}) → {level, title, cause, next, exit, body}` 与 `excerpt(out) → {lines, keep}`。判定顺序（前一条命中就返回）是：`Command aborted` → 参数校验 `Validation failed for tool "X"`（warn，不是环境坏了）→ edit `Could not find the exact text` → 末条 `XxxError`（配 11 类中文原因表）→ errno 表（ENOENT/EACCES/EADDRINUSE/ECONNREFUSED/ETIMEDOUT）→ 网络（本机直连 GitHub 断，指向 127.0.0.1:18791 代理）→ `fatal:` git 表 → 行首 `✗` 自检 → **exit 1/2 且无 error 字样且输出 ≤3 行 = benign**「没有结果，通常不算故障」→ exit 0 = warn → 兜底。`excerpt()` 有 Traceback 就取末 4-6 行，否则取命中行（`HIT` 正则）上下各一行、最多 4 处，兜底取最后两行非空输出，**始终跳过 `Command exited with code N` 尾巴**（退出码已经在标题里，重复一遍纯噪音）。
- `web/src/chat.ts` —— `failureBar()` → `failureCard()` + 模块级 `buildFailureCard()`；`failBars` 改名 `failCards`（元素从 `<details>` 变 `div`），按 `toolCallId` 存，重复调用**整张卡原地重建**（`prev.replaceWith(next)`）：`replace()` 会把 `end` 时还空的 `result` 补上，卡片必须跟着变。`firstErrorLine()` 删除。
- `web/src/styles.css` —— `.failbar`/`.fb-*` 整块换成 `.fcard`/`.fcard .top/.badge/.ttl/.grid/.cmdbar/.ex/.ln/.no/.tx/.gap/.foot`，`benign`/`abort` 走 `.fcard.calm` 灰卡（386 条 exit 1 要是一律红框，红框就失去意义）。

**为什么卡片整张不折叠（`<details>` 只在原始输出上）：** 卡片的全部价值是「不点开也能下判断」。为了裁圆角它必须带 `overflow: hidden`，而 D46 已经踩过这个坑 —— `.chat-scroll` 是有确定高度的 flex 列，带 `overflow: hidden` 的子项 `min-height: auto` 会退化成 0 被压成 2px。现有那条 `.chat-scroll > * { flex: 0 0 auto; }` 覆盖到 `.fcard`，探针实测 8 张卡 h=172–268px、`scrollH 2111 > clientH 1100`，没有再被压。

> **后续修订：** 用户反馈失败卡片太占地方，改为整张 `<details class="fcard">`，**默认折叠**。摘要行保留 `EXIT n` + 标题 + 命令（展开后命令行隐藏，避免重复），结论仍然不用点开就能看到；重建时沿用用户的展开状态。

**验证：** 临时探针（`web/probe-cards.html` + 真 `ChatView`，跑完即删）把 build.mjs 里那 8 条真实失败原文喂给 `reset()`，另加一条 live 路径（`toolEvent("start")` → `end`（`result` 为空，触发「输出为空，只有退出码」）→ `replace()` 补上 `rg: no matches`，卡片变成 1 行关键行）。桌面 900px 与手机 390px 两轮截图：`.scratch/ops-failure/shots/cards.png`、`cards-top.png`、`cards-390.png`。`npm --prefix web run typecheck` 与 `npm --prefix web run build` 通过，新产物 `index-CKACbq4a.js` + `index-Dov9_1hg.css`，7864 端口已在引用（`curl -s http://127.0.0.1:7864/ | grep index-`），用户 Ctrl+F5 即生效。

**可改：** 想加「让 pi 看看」按钮，只需在 `buildFailureCard()` 的 `.top` 里加一颗，点击把 `input.out` 塞进 composer（桥端要先让 `/api/sessions` 暴露会话可写性）；想改某条判定，只动 `web/src/diagnose.ts` 里对应的那条规则；`LEVEL_LABEL` 是四个词的文案表。

## D50 文件资源管理器：全盘可读、文本可写，形态是「viewer 一个容器三态」

**需求（m00038 原话）：** 「文件资源管理器，按钮，产物旁边。点击后，能访问本机的盘符，以及文件，选择文件，可以调用 ui 侧已经存在的功能直接打开，比如 md 、html 等」。用户随后纠正过一次方向：**「目前文件按钮已经实现了读取，现在要做个类似的」** —— 列目录、读图片的底层早有，缺的只是 UI 形态。

**先摸事实（省掉一半工作量）。** `bridge/src/dirs.ts:8` 的 `listDirs` 已经能列任意目录（空 path = 盘符列表），`GET /api/dirs`（`bridge/src/index.ts:288`）**没有任何路径沙箱**；`GET /api/image`（`preview.ts:88`）同样全盘可读（≤30MB）。**唯一窄的是预览**：`openPreview`（`preview.ts:174-200`）要求文件在 `session.cwd` 下或在会话 jsonl 里出现过。列目录的前端 UI 反而被写过两遍（`app.ts:1245-1331` 新建会话的「📁 浏览」、`app.ts:2947-3029` 选图片），本次抽成 `mountDirPicker()` 一份。写通道此前**完全不存在**：只有 pi 子进程写文件（受 D1 gate）。

**形态是看样张选的，不是文字讨论出来的。** 四张能点的样张（`.scratch/fs-explorer/prototype/`，共用 `mock.js` 的「面包屑 + 列表 + 筛选 + 编辑器」，套真实 `styles.css` 令牌）只差一维「这块界面放哪儿」：A 左栏换脸 / B 弹层 / C viewer 三态 / D 常驻第三栏，另加 M 说明窄屏约束（≤760px 只有弹层一条路）。用户选 **C**。

**为什么 C 比看起来好的 A/D 更好（选它的理由要留档）：** viewer 本来就是「头部 + 一个 body」，已经有 `渲染/源码` 分段，加「浏览/编辑」只是多两条分支，**不新增布局层**；桌面和手机上同一个容器，窄屏天然变成全屏，不需要第二套 UI；A 的左栏 288px 在 `styles.css` 的 760px 断点里是被 `display:none` 掉的，手机上必须另做兜底；D 在 1440 屏把对话挤到约 700px，而且同样是纯桌面方案。C 认下的代价是「预览态里没有文件列表，换文件要先切回浏览」。

**放开可读范围。** 删掉 `openPreview` 的 cwd/mention 门，token root 一律取 `path.dirname(abs)`（token 仍是 6h TTL、最多 500 个、`serveRaw` 里再校验一次 `isUnder`，html 仍带 CSP sandbox）。理由：既然 `/api/dirs` 已经把盘符和文件名全暴露了，预览再挡一层只是让人多点两次，且两套规则会互相打脸。

**可编辑并保存，不走审批。** 审批（D1）是给 agent 的，用户亲手点「保存」就是授权本身。收边靠三件事：① 只能写「本次通过 `/api/preview` 登记过」的文件（`bridge/src/preview.ts` 的 `editable: Map<sessionId, Map<abs,{size,mtime,bom}>>`，只有 `kind ∈ {markdown,text}` 且 ≤2MB 才登记，超过 200 条整张清空）；② `POST /api/save` 要 cookie；③ 乐观锁 `mtime + size`，不符回 `409`，前端弹冲突条三选一（覆盖 / 放弃 / 另存副本），**默认不覆盖**。落盘用 `writeFileSync(.tmp-*)` + `renameSync` 原子替换，保留原文件 BOM。用户另外确认了两条：保存后**不通知 pi**（保存就是保存，别往输入框塞字）、未保存离开时**拦一下**（保存 / 放弃 / 取消）。

**安全账记在这里：** 口令泄露 = 全盘文本可读 + 会话 cwd 之外的文件可写。CSP sandbox 只保护 html 预览（`allow-scripts` 无 `allow-same-origin`，拿不到 cookie）；文本保存走的是带 cookie 的普通请求，没有任何沙箱挡着。

**不做的：** 新建/删除/重命名、可展开树（D7 早已否掉）、PDF 特殊处理（落 binary 分支：提示 + 新标签页/下载）、「让 pi 读这个文件」按钮（D49 同款理由）。

**实现落点：** 读侧 `bridge/src/preview.ts` 的 `openPreview`（门已删）+ `bridge/src/index.ts` 的 `POST /api/preview`；写侧同文件的 `rememberEditable` / `savePreviewFile` + `POST /api/save`；界面是新文件 `web/src/dirpicker.ts`（一份目录浏览器，被 viewer 浏览态、开新会话、输入框附件三处复用）+ `web/src/app.ts` 的 `ViewerPane` 三态。两道回归：`node bridge/tests/save-check.mjs`（9 组桥端断言，含 409/403/400/BOM/另存副本）与 `node probes/fs-ui.mjs`（9 组真实浏览器断言，含移动端与脏内容拦截）。

**可改：** 想收回全盘可读，只需在 `openPreview` 里加回 `isUnder` 一行；想只允许改文档，把 `savePreviewFile` 的可写判定从 `kind` 收窄成扩展名白名单；2MB 上限是 `savePreviewFile` 里的一个常量。规格与步骤见 `.scratch/fs-explorer/PLAN.md`。

## D51 删除=移进垃圾箱，清空才真删
决定：会话的「删除」不再 `unlink`，而是把 `.jsonl` move 到桥接自己的 `state/trash/<id>.jsonl`，`state/trash.json` 记「原标题 / 原路径 / 原目录 / 删除时间 / 大小」。垃圾箱是会话管理弹窗里的第二个视图（同一个弹窗、同一个底栏），入口在筛选条最右、紧挨「重置」，切进垃圾箱后同一个按钮变成「← 会话列表」。垃圾箱支持「还原」（move 回原路径）与「彻底删除所选 / 一键清空」（在列表头部，不用先全选），后两者各要点两下；不做自动过期。
为什么：文件一离开 pi 的 sessions 目录，pi CLI 和两侧列表就都看不见它了 —— 不需要在渲染层再加一层过滤，也不会出现「删了但还在」的错位。删除本来就是最容易手滑、最难挽回的动作，多留一步「还在这儿」比事后找备份便宜。保留二次确认是因为批量勾十几条时一次手滑代价高，可还原只把它的定位从「防丢失」降级成「防手滑」。不做定时清理是为了让销毁时刻永远可见（没有「N 天前删的今天突然没了」），磁盘占用直接显示在垃圾箱标题上。
**可改**：想加自动过期，在 `Sessions.purge()` 前挂个启动时扫描即可；payload 目录是 `trashPayload()` 里的一个 `statePath("trash", …)`。

## D52 真终端：bridge 里挂 node-pty，窗口开箱即用但按「本机 + 二次口令」收窄
决定：terminal 走 bridge 内置的 `node-pty`（`bridge/src/terminal.ts` 的 `Terminals`），不上第二套本地 service；每个会话最多同时 4 个，默认 shell 按 `pwsh` → `powershell.exe` → `cmd.exe` 逐级回退，cwd 取当前会话目录。安全边界三层：公网隧道请求一律拒（`publicReq`）、开终端必须过 `requireStepUp()`（二次口令，10 分钟）、只接受 cookie 鉴权的 ws。`.ps1/.psm1/.cmd/.bat` 在文件浏览器里右键可「用 PowerShell 运行 / 以管理员身份运行」，提权一律 `Start-Process -Verb RunAs` 另开桌面窗口（当前终端不升级，也接管不了提权进程的输入）。
为什么：这个产品的用户就坐在跑 bridge 的那台机器上，需求是「一个能 `cd`、能跑交互式程序的窗口」，用一次性命令回显冒充终端会在第一个交互式程序上露馅。选内置而不是新 service，是因为新 service 要再解决一遍鉴权、保活、安装与开机自启，收益为零。提权只能新进程（Windows 没有别的路），所以干脆承认它：桌面窗口 + 应用内面板不假装自己是管理员。
**踩过的坑**：`spawn` 带 `detached: true` 在 Windows 是 `DETACHED_PROCESS`（无控制台），而 `Start-Process` 需要桌面会话 —— 结果是**静默成功但什么都不做**（退出码 0、脚本没跑）。去掉 `detached`、保留 `stdio: "ignore"` + `windowsHide` + `unref()` 才对。
**可改**：并发上限是 `MAX_TERMS`；默认 shell 顺序在 `whichPowerShell()`；想禁掉终端，删掉 ws 里 `term.*` 那几支即可，前端按钮会自然报「不支持」。

## D53 会话状态只在一处计算：`sessionBadge`

**决定**：`web/src/app.ts` 的 `sessionBadge(s, currentId)` 是「这个会话现在处于什么状态」的唯一实现，顺序 `待回答 > 待确认 > 终端占用 > 运行中 > 完成`；左栏卡、管理弹窗行、置顶 chip 都调它。

**为什么**：`running` 只表示「pi 子进程还活着」——等批准、等答题时它照样是 `true`。于是同一个问题在三个渲染点各写了一遍判断，其中置顶条那处漏了 ask/approval，把「卡在等你」显示成「运行中」（Q-015）。规则抄一份就一定会漂移，索性只留一份。

**可改**：要新增状态（比如「排队中」）只改这个函数和它的 `cls` 映射。

## D54 滚动跟随只看用户意图，不看 `scroll` 事件

**决定**：`web/src/chat.ts` 的「是否跟着输出滚到底」改成 `following` 状态机：`wheel`（向上）、`touchmove`（手指下移 > 6px）、`keydown`（PageUp / ArrowUp / Home）**同步**置 `false`；滚回距底 24px 内自动置 `true`；`scrollToEnd()` 只排**一个** `requestAnimationFrame`，回调里再判一次 `following` 才写 `scrollTop`。非跟随时新内容只在悬停按钮上提示「有新内容 ↓」，点一下或滚到底恢复。`web/src/app.ts` 里 `renderComposer()` 末尾那次无条件 `scrollChat()` 一并删掉。

**为什么**：`scroll` 事件是异步且按帧合并的，用户刚上滚那一帧的 `atBottom` 还是 `true`；而每个 `scrollToEnd()` 都新排一个 rAF、只在排队时检查条件，一次输出洪峰就能排几十个回调，全部执行就是「一卡一卡」。只改阈值治不了：程序化滚动自己又会触发 `scroll` 把状态算回 `true`，用户的意图被彻底抹掉。改成意图优先 + 单句柄 + 执行时复查，才断掉这条环。

**没选 `IntersectionObserver` 哨兵**：它分不清「用户滚走了」和「容器变矮了」（输入框长高、终端面板打开都会让哨兵离屏），后者会被误判成「用户在看上面」，从此再不跟随。

**可改**：阈值 `24` 在 `nearBottom()`；按钮文案与位置在 `renderJump()` 与 `.chat-jump`。

## D55 悬停详情卡复用本地状态，不为它加协议

**决定**：运行中悬停卡（`.act-pop`）的信息全部来自前端已收到的数据：`chat.liveInfo()` 记录当前工具名 / 参数压缩单行 / 输出尾部 2000 字 / 思考尾部 800 字，`fillHintStatus()` 每秒重绘时把它们渲染成四行（工具 / 参数 / 输出 / 思考），输出与思考各取尾部若干行。等待态优先于「思考中」。

**为什么**：这些东西 `tool` 与 `delta` 事件里本来就有，只是以前被丢掉了；把展示塞回协议层（新增事件、新增字段）要同时改 bridge、协议类型和三条渲染路径，收益为零。面板默认 `display: none`，只有悬停/聚焦才可见，所以「每秒重绘」并不贵，不需要节流定时器。

**可改**：行数与字数上限在 `tailText(...)` 的调用处；不做敏感信息打码（能看到这个页面的人本来就能看到工具卡里的完整参数），要改在 `compactArgs()`。

## D56 纯文件名不渲染成链接：不猜文件在哪

**决定**：`web/src/md.ts` 的路径正则去掉「裸文件名」分支——只有带目录的路径（`docs/DECISIONS.md`、`F:\dir\a.md`）才变成可点的预览链接；`问题记录.md` 这样的纯名字按普通文本/代码渲染。上一版加过的「点不中时按其它会话的 cwd 逐个重试」一并拆掉。

**为什么**：纯文件名不携带位置，它到底指哪个目录只存在于写它的人的心里。按「当前会话 cwd」解析会在跨项目时必错；按「其它会话的 cwd 挨个试」看似聪明，但会命中**另一个同名文件**——打开错文件比打不开更难发现，而且行为取决于应用里当时恰好有哪些会话目录，用户无法预期（Q-020 的实测：同一句话在同一个会话里，前后两次一次失败一次成功，差别只是中途多了个 cwd 在目标目录的会话）。

**代价**：想在聊天里点开同名文件，得走顶栏的 📁 文件管理器；写全路径就照旧可点。

**可改**：真要「按名字找文件」，正确做法是显式入口（文件管理器里的搜索），而不是把猜测藏在链接点击里。

## D57 正文铺满中栏，不限阅读宽度

**决定**：会话记录、代码块、输入区都用满中栏宽度（`.chat-scroll > *` 与 `.msg .body` 的 `max-width` 全部放开到 100%），删掉「收起整栏才放开」的两条规则。

**为什么**：原来 limit 是 820px 且左对齐，1600px 窗口空 200px、2200px 空 800px，看上去像少画了一块（Q-025）。先试过「保留上限、居中」，用户的口径是「尽量利用上屏幕」——居中只是把空白平均分到两边，屏幕宽度还是没用上，所以最后取铺满；代价是长段落行长跟着窗口走，读起来比限宽累，这条已知代价接受。

**可改**：想恢复限宽就在 `web/src/styles.css` 的 `@media (min-width: 900px)` 段里给 `.chat-scroll > *` 加回 `max-width`（居中要配 `align-self: center`；`.composer` 是 grid，居中得用 `justify-self: center`，用 auto 边距会把输入框收缩成 fit-content）。

## D58 滚动条用 `::-webkit-scrollbar` 自绘，不用标准 `scrollbar-width`

**决定**：全局只保留 `::-webkit-scrollbar*` 一套伪元素（10px 槽位、透明轨道、4px 圆头滑块、hover 提亮、`::-webkit-scrollbar-button { display: none }`），不写 `scrollbar-width` / `scrollbar-color`；`.pin-strip` 原有的 `scrollbar-width: thin` 删掉。

**为什么**：本机实测，只要出现标准属性，Chromium 就切回原生滚动条渲染，两端 ▲▼ 按钮无法用任何伪元素去掉，宽度也只能在 auto/thin 里选 —— 而这两个按钮正是「太丑」的来源。两者只能二选一，选能完全控制的那套。代价是只在 Chromium 系（Edge/Safari）生效，Firefox 会退回原生滚动条（本项目实际只跑前两者）。

**可改**：想兼容 Firefox 就补一条 `@supports not selector(::-webkit-scrollbar)` 分支里写 `scrollbar-width: thin; scrollbar-color: …`，但要在 Firefox 里确认箭头按钮的观感。

## D59 新会话的默认工作目录 = 当前开着的那个会话的目录

**决定**：`web/src/app.ts` 的 `defaultCwd()` 顺序改成 **当前会话的 cwd → `pi.lastCwd` → 最近更新的会话**。左栏「开新会话」、置顶条那颗 ＋、快捷键三条入口都走同一个 `openNewSessionSheet()`，所以一处改动覆盖全部。

**为什么**：原来第一顺位是 `localStorage.pi.lastCwd`（只在 `createSession()` 里写），于是它记的是「上次**创建**时用的目录」，而不是「你现在在哪个会话里」。在 A 会话（A 目录）里点 ＋、而上次创建发生在 B 目录时，对话框会拿 B 的目录当默认值 —— 也就是 D7 那套「最近用过的 cwd」在会话切换后就已经过期了。当前会话的目录是更强的信号：它就是这个人在这个页面里正在做的事。

**代价**：`pi.lastCwd` 只在「没有打开任何会话」时才起作用（首连、刚删掉当前会话），这符合预期 —— 那种时候确实没有「当前目录」可参考。

**可改**：`defaultCwd()` 三行的顺序；想更激进可以去掉 `pi.lastCwd` 直接退到最近更新的会话。验证：`npm run build:web && node probes/round19-default-cwd.mjs`（A 会话 → alpha、切到 B → beta，若返回 `pi.lastCwd` 的陈旧值即判失败）。

## D60 对话右缘一条「轮次刻度带」，悬停展开每轮输入的列表

**决定**：`web/src/turns.ts` 的 `mountTurnRail(host, opts)` 在 `.chat-pane` 上挂一条宽 14px 的刻度带（`right: 12px`，即滚动条左边那 16px 走廊里；桌面端 `.chat-scroll` 的右内边距从 26px 加到 34px 给它腾地方）。一根刻度 = 一轮用户输入（2px 高、间距 4px），轮次多于版面时**按比例抽样**（首尾必留，最后一轮永远在带上）。悬停展开左侧小列表：每行一轮、单行右对齐、超出打点、行尾一短横（10px）；当前这一轮（视口顶部翻过去的最后一轮）整行微微提亮、那根短横拉长到 24px 并转白。**弹层的右缘直接落在刻度那一列上**（`right: 0` 相对刻度带，即面板右缘 = 刻度右缘，再往右 2px 是滚动条），展开时刻度 `opacity: 0` 让位给行尾那列短横 —— 观感是「刻度带被拉宽成一块面板」，而不是框外面还挂着一列刻度（用户口径：「要和 chat 融合到同一个框里面」）。鼠标扫过某行 → 那行与正文里对应那条 `.msg.user` 同时描边（`.turn-flash`，点完会自己亮 1.2s）；点一行/一根刻度 → 那一轮滚到视口顶部（最后一轮则回到底部并继续跟流）。

**为什么**：用户要的是「一眼看出这次对话有几轮、现在在第几轮，然后一下跳过去」。整套只在 `web/src/` 里加，桥和协议零改动 —— 轮次从已经渲染出来的 user 项里数出来，不引入新状态。刻度带只在 `(hover: hover) and (min-width: 900px)` 下显示：手机上它挡内容，又没有悬停可言。

**踩到的三个坑**（都写进了代码注释，改这块先读）：
1. **`grid-template-columns`**：`.turn-list` 是 grid，不给 `minmax(0, 1fr)` 时单列宽度取 max-content，nowrap 的长句把列撑到几千像素，`.txt` 的 `text-overflow: ellipsis` 永远不触发（表现为行文被弹层裁成半个字，没有省略号）。
2. **跳转被自己的 scroll 监听撤掉**：从底部往上跳时，平滑滚动的第一帧 `scroll` 事件里视口其实还在底部，`nearBottom()` 为真 → `resumeFollowing()` 立刻把跟流打开、「回到底部」按钮一闪就没。用 `holdFollow = performance.now() + 900` 挡住跳转期间的自动恢复。
3. **刻度与面板的「缝」**：第一版弹层放在刻度左边 20px、刻度照样露在外面，看上去是两个东西。改成面板右缘压在刻度列上、同时把刻度隐去，行尾短横接替它，才是参考图里「一块框 + 右侧一列横」的样子。
4. **`:focus-within` 会让列表关不掉**：鼠标点完一行，焦点留在那个 `<button>` 上，弹层就一直挂着。改成 `.turn-rail:has(:focus-visible)` —— 键盘 Tab 进来照样展开，鼠标点完移开就收起。

**代价**：刻度带浮在正文右边的走廊里，长会话里它会和正文同一高度存在（不占版面、不吃点击，只有那 14px 宽的一列接事件）；桌面端正文右侧少了 8px 宽度。

**可改**：颜色/尺寸全在 `styles.css` 末尾「轮次缩略图」那一节（`TICK_H`/`TICK_GAP` 在 `turns.ts` 顶部，要改版面高度就改这两个数）；不做抽样的上限是 `viewport.clientHeight * 0.7 / 6` 根。验证：`npm run build:web && node probes/round20-turns.mjs`（12 轮会话验悬停/高亮/跳转/刻度隐去/短横列对齐，200 轮会话验抽样与首尾；截图落在 `.scratch/round20-turns/shots/`）。

## D61 左栏收起时，把路径接到状态行最前面；左栏展开时不显示

用户口径：「当左侧折叠后，希望在 chat 框后下面显示当前工作目录。如果左侧会话没折叠，则不显示，因为左侧会话已经有了该信息」；随后收紧为「不需要单独起一行，放在原来的分支显示那一行就行，可以放在分支显示旁边。不需要显示工作目录这四个字」。

**决定**：`.composer .hint-status`（平时显示 `⎇ 分支 · N 个未提交改动`，没有仓库时显示按键提示，跑起来时显示转圈+计时）最前面接一颗 `button.cwd-chip` —— 等宽小字、只有路径本身、无标签，读起来就是 `F:/probe-work/alpha ⎇ main · 3`。显示与否由 `syncCwdChip()` 统一判定：`this.collapsed.sessions && matchMedia("(min-width: 900px)")`；`renderPanes()` 两个分支末尾各调一次。点一下复制整条路径（`.cwd-path` 闪 0.9s「已复制」，和 git chip 同一套写法）。

**为什么要在状态行里"抢"位置而不是自己开一行**：用户第一版反馈明确否掉了独立一行 —— 状态行本来就是一行稀疏的元信息，路径属于同一类，挤进去不占高度，也不会把输入框往上顶。放在最前面是为了紧挨分支 chip（同一行、间隔 6px），而不是被 `flex: 1 1 260px` 的状态区推到右边那堆按钮里。

**坑**：状态行是整块重画的（`fillHintStatus()` 里有多处 `box.replaceChildren(...)`：仓库/按键提示/运行中三种形态）。所以拆成两层——`paintHintStatus()` 只负责画内容，`fillHintStatus()` 画完把 `this.cwdChip` 节点 `prepend` 回去；节点常驻、只切 `hidden`，不来回装卸。

**顺手补的坑**：全仓原先**没有任何 `window.resize` 监听**，`renderPanes()` 只在点按钮/切页时跑，所以把窗口拖过 900px 断点后 `.main.no-left` 和 `pane.hidden` 都停在旧状态（收起过的左栏在窄屏仍然隐藏，窄屏的 tab 也进不去会话页）。新增一帧一次的 rAF 监听调 `renderPanes()` —— 这也是「窄屏下路径必须消失」能成立的前提。

**代价**：收起左栏时状态行左边多一段等宽字（约 130px，`max-width: 42ch`）；路径过长时按尾部省略，看不到叶子目录（`title` 里有全文，点一下也能复制）；没有仓库的会话里它排在按键提示前面。

**可改**：样式在 `styles.css` 末尾「左栏收起时的路径（D61）」那一节；要改成「左栏展开也显示」就把 `syncCwdChip()` 里的 `collapsed.sessions &&` 去掉；要加回字形/标签只在 `cwdChipNode()` 里加一个 `span`。验证：`npm run build:web && node probes/round21-cwd-line.mjs`（展开时隐藏 / 收起时显示且是当前会话的 cwd / 与分支 chip 同一行且紧挨其左 / 不再有独立的 cwd 行 / 点击复制 / 换会话跟着换 / 窄屏消失 / 拉回桌面宽度又出现；截图落在 `.scratch/round21-cwd-line/shots/`）。

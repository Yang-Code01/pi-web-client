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

## D62 目录选择器里，盘行给占用条、文件行给「大小 + 修改时间」

用户口径（m00810／m00811）：「文件管理器、文件、新会话……我需要看得到容量，比如你的文件大小之类的，总得看得到吧，占用情况之类的」——三个入口指的是新会话的 📁 浏览、文件浏览器 viewer、附件选择器，它们共用 `web/src/dirpicker.ts` 一份实现。

**决定**：盘列表（`此电脑`，即空 path）每行变成 `C:` + 填充条 + `79%` + `55.7 GB 可用`，`title` 里写全 `共 / 已用 / 剩`；`>85%` 转琥珀（`.tight`）、`>95%` 转红（`.full`）。文件行右侧两列：大小（1024 进制、至多一位小数、去掉 `.0`）与修改时间（当天 `00:52`、今年 `09-24`、跨年 `2024-06-01`），两列都右对齐成一条竖线。容器窄于 460px（附件选择器那种弹层）时只丢掉百分比，路径与剩余容量保留。

**为什么盘子行要给剩余而不是已用**：用户问的是「够不够用」。百分比给的是「快满了」，剩余给的是「还能装多少」——两个都留，已用只进 tooltip。

**为什么占用只做到盘一级**：文件夹大小没有系统 API，只能递归遍历整棵子树；一个 `node_modules` 就是上万次 stat，放不进「点一下就出列表」的交互。文件大小则本来就在 `stat` 里，顺手。同时实测 `fs.statfsSync` 对 C…I 六个盘各 **0ms**，与 `Get-Volume` 数值完全一致，所以盘行没有性能借口。

**为什么文件大小走第二个请求**：`stat` 在本地盘 4776 个文件 97ms，但在睡眠的网络盘或机械盘上会是秒级，把「名字已经能看、能点」拖成「转圈」。所以 `listDirs` 先回名字，前端立刻画行，再打 `/api/dirs?path=…&stats=1`（`statFiles()`，同样的过滤与 2000 上限）按 name 回填两列。目录一换就 `statToken += 1`，迟到的旧答案直接丢掉，不会串到新目录的行上；`paint()`（筛选重画）从缓存里补，不会把这一排清空。

**坑（和 D60 同一类）**：`.dir-list` 是 `display: grid` 且没写 `grid-template-columns`，隐式列按 max-content 定宽 —— 一行长名字就把整个列表撑宽，`.nm` 的 `text-overflow: ellipsis` 永远不触发。补 `grid-template-columns: minmax(0, 1fr)`（顺带 `overflow-x: hidden`）之后省略号才真的出现；探针用 `scrollWidth - clientWidth > 0` 盯着这一条。

**代价**：盘行比原来高（6px 条 + 百分比），六个盘刚好占满 `42vh` 的弹层；窄容器里百分比消失，只能靠条长和剩余数字估；mtime 用的是浏览器本地时区；网络盘坏掉时那一行大小就是空的（`statSync` 抛错即跳过，不报错也不显示 `?`）。

**可改**：格式函数 `formatBytes()` / `formatTime()` 与阈值 `NARROW_PX = 460` 都在 `web/src/dirpicker.ts` 顶部；配色在 `styles.css` 的 `.vol-row` 一段（用 `--warn` / `--danger`）；要显示「已用」就把 `.vol-free` 换成 `已用 x / 共 y`。验证：`npm run build:web && node probes/round22-dirsize.mjs`（名字先出、大小后到；四种单位；三档时间格式；大小与时间各自右对齐成一条线；长名省略；筛选不清空大小；进子目录不串行；此电脑三条盘行、D: 92% 琥珀且条按比例填充、tooltip 写全；窄容器丢百分比；截图在 `.scratch/round22-dirsize/shots/`）。

## D63 预览里的链接跳转能退了：一支按会话分开的返回/前进栈

用户口径（m01226）：「现在打开某个文件时，文件里面有链接，点击后，能打开新文件。比如在 html。里面点击一个连接，重新打开的新 html。但是无法返回了。需要追加返回功能」。摸事实时还追问出三条边界：返回覆盖**所有预览**（html 内链、md 内链、浏览态点开的文件、文本里的路径链接）；HTML 里为了拿到导航信息**只注入一个只上报的小脚本、沙箱不放宽**；历史**活在内存里、按会话分开**（关掉预览不丢，刷新页面清空），目录态不算一步，外链**不拦截但记一条占位**。

**决定**：查看器标题栏最左边加 `←` / `→`（`Alt+←`、`Alt+→` 同一套），栈是 `Map<sessionId, { steps, at }>`，`HISTORY_MAX = 60`。一步 = 一次「打开文件」（`VStep = { path, url?, label?, y? }`；`path` 为 `null` 表示外链或跳出目录树的占位）。`⟳` 刷新走 `openPreview(..., replace = true)`，不记步；在当前这一步重新打开同一份文件不记新的一步；点链接、点浏览里的文件算新的一步，并截断前进分支（与浏览器一致）。

**为什么往 `/raw` 的 HTML 里注入脚本**：iframe 是 `sandbox="allow-scripts …"` 且**没有** `allow-same-origin`，页面跑在不透明源里，父页面读不到 `contentWindow.location`，也调不到它的 `history`——链接点了、页面跳了，应用一侧完全看不见，这正是「退不回去」的根。放开 `allow-same-origin` 固然能直接用原生历史，但等于把用户自己写的 HTML 放进应用的源里（能读 cookie、能 DOM 化界面）。所以反过来做：`serveRaw()` 在 `<head>` 之后插入 `navScript(token)`，它只 `postMessage`（click / submit / scroll），**一律不 `preventDefault`**，页面照旧自己跳，父页面只负责「知道跳了、记一步、对齐标题」。

**用 token 认人，不用 `ev.source`**：最初写的是 `ev.source !== v.frame.contentWindow → 忽略`，实测恒为假（跨文档导航后两个 WindowProxy 指针不相等，调试打印 `sameSource=false`），消息全被丢掉。改成页面在每条上报里带 `tk`（签发时注入的 token），客户端用 `v.frameToken || v.info.token` 比对——`api.preview` 每次都会换发新 token，所以「iframe 里现在这份文档当初用的是哪个 token」必须单独记在 `v.frameToken` 上，不能拿 `v.info.token` 现算。

**坑**：① 注入必须放在 `writeHead` **之前**——原来的 `serveRaw()` 先无条件 `writeHead(200)` 再判 HEAD，注入分支又写一次响应头，直接 `ERR_HTTP_HEADERS_SENT`；② iframe 的「保活」判据从 `frame.dataset.src === rawUrl(info)` 改成 `v.framePath === info.abs`——跟着链接走的 iframe 自己换了地址，`rawUrl(info)` 会因为 token 变了而不相等，判据一错就把 iframe 重挂、白跳回原文件；③ 路径比较要归一化（`\` 与 `/`、末尾斜杠、大小写），否则「同一次打开」会在栈里留两格；④ HTML 的滚动位置只能靠页面自己上报（`scroll` 事件 rAF 合并后发 `{t:"pi-y"}`），按钮返回/前进时没有任何别的渠道能拿到它。

**代价**：token 就写在页面的 DOM 里，页面自己的脚本读得到、也能伪造上报——但它只能让**自己的**查看器多出一步，真正的越界仍由 `api.preview`（按会话 cwd 校验）和 `/raw` 的 `isUnder(grant.root)` 挡着；每次点击都要重新走一次 `api.preview`（一次 stat + 一次 token 签发）；栈上限 60 步；iframe 内 `target=_blank`、`download`、`#锚点` 既不拦也不记；外链那一格只能显示「跳出了目录树 / 主机名 + 在新标签打开」，原来的页面态已经随 iframe 一起没了。

**可改**：`HISTORY_MAX` 与 `vhist` 在 `web/src/app.ts`；按钮位置在 `paintViewer()` 的 `viewer-nav` 一段；外链占位文案在 `showExt()` 与 `viewer-msg.ext` 的渲染里；注入脚本在 `bridge/src/preview.ts` 的 `navScript()`（想改成拦截式只需在 click 里 `preventDefault`，但那会打断页面自己的路由）。验证：`npm run build:bridge && npm run build:web && node probes/round23-nav.mjs`（12 步：初始两个按钮都灰 / 点链接后标题跟随且 `←` 亮 / `←` 真回上一页 / `→` 再前进 / 点外链记一步且回得来 / 外链占位带出口 / `⟳` 不多记一步 / `#锚点` 不记 / 关预览再打开历史还在 / 滚动位置来回后回到 420px / 换会话历史各一份 / 切回来还在；截图在 `.scratch/round23-nav/shots/`）。

## D64 置顶条胶囊悬停弹气泡（归档 / 重命名 / 删除），删除时胶囊飞进左栏那颗「垃圾箱」

用户口径（m01571）：「置顶条每个会话悬停弹出小气泡，气泡里放 归档 / 重命名 / 删除，点击后有对应动效（删除要有倒进垃圾桶的效果）」。二轮收紧：气泡里**只放这三个**（不加取消置顶）、**只改置顶条**（左栏卡片不动）、删除「画面是直接丢入垃圾桶，但是不会真的删除。复用会话管理的垃圾桶机制」。第三轮「做几个原型设计出来让我选」，先在 `.scratch/pinactions/prototype/` 出了八个可播放样张（`window.__seek` 定格），用户选定：删除 = **B（左栏自动展开、飞向左栏真实的🗑）**、归档 = **A（压扁滑进条尾抽屉）**、气泡 = **③ 竖排 + 会话名头**、重命名 = **气泡里就地变输入框**。

**决定**：气泡是 `web/src/pinmenu.ts` 的 `openPinMenu(anchor, opts)`，挂在 **`body`** 上、`position: fixed`、贴胶囊下沿 6px 并夹在窗口内；悬停 180ms 才弹、指针离开 220ms 才收（从胶囊挪进气泡时清掉计时器）；重命名输入框开着时 `pinned()` 为真，指针走了也不关。归档：条尾插 `.pin-tray` 抽屉 → 这一颗胶囊 `scale(1.07, .66)` 压扁 → `translate(dx, dy) scale(.22)` 滑进抽屉 → 计数弹一下 → 胶囊宽度塌到 0 → **240ms 之后**才发 `manage/archive`。删除：克隆一颗 `.pin-flyer`（`fixed`，带上原胶囊的 rect）挂到 `body` → 左栏若收着就先展开（`renderPanes()`，置顶条整条消失）→ 220ms 后量 `.bin-btn` 的 rect → 二次贝塞尔（控制点往下偏 26px）五帧 `translate + scale(1→.18) + rotate(-10deg)`、620ms → 落地删克隆、`pulseBin()` 闪一下、发 `manage/delete`。左栏 `manageBar` 在「过滤」与「管理」之间加一颗 `button.bin-btn`：文字「垃圾箱」+ 红色计数徽标，点它 `openManager("trash")` 直接进垃圾箱视图。

**为什么归档要「先演后发」**：归档是幂等的，而桥的回声会 `host.replaceChildren()` 把整条置顶条重建——抽屉、压扁中的胶囊、计数全都会跟着没；所以动效先在本地走完（520 + 240ms）才发帧，最后一句去向提示 `已归档 1 个 · 在左栏「已归档」里` 负责解释东西去哪了。

**为什么气泡必须挂 `body`**：`.pin-strip` 是 `overflow-x: auto`，条里任何溢出的东西都会被裁掉，而条又贴着窗口顶——向上弹被窗口切、向下弹被条裁。所以气泡只能往下弹、并且必须挂在条外面（绝对定位在条里也不行）。样张第一版就是这么被切掉一半的。

**坑（都是这一轮真踩到的）**：① `chip.parentElement` **就是 `.pin-strip` 本身**——塌缩动画早先写在 `slot = chip.parentElement` 上，结果整条被压成 24px（只剩左右 padding）并横向溢出，探针里「条宽度 > 600px」的断言抓住；② 归档后胶囊不换名字：`applyRename()` 只改数据不重画（管理条那边由调用方负责重画），气泡回调必须自己补一次 `renderSessions()`；③ `.bin-btn` 最初用 🗑，而它只有 31px 高、左栏 280px 宽，emoji 在这个尺寸下糊成一小块、还和暗底同色——改成文字「垃圾箱」+ 徽标才看清（它是删除动效的落点，必须一眼认得出）；④ 飞行体必须是**脱离文档流的克隆**：展开左栏后置顶条就 `display:none`，原节点跟着没了，不能直接飞原节点。

**代价**：这套只在「桌面宽 + 左栏收起」时存在（置顶条本身就这么显示）；删除会把左栏顶出来、顺带把整条置顶条切走——这是用户选的方向，代价认了；`prefers-reduced-motion: reduce` 下三个动作都不演动效、直接做那一步（`calm()`）。

**可改**：时长与缓动在 `web/src/app.ts` 的 `archiveFromPin()` / `deleteFromPin()`；气泡宽度与配色在 `web/src/styles.css` 的 `.pin-menu` 一节；抽屉尺寸在 `.pin-tray`；三个动作要增减就改 `pinmenu.ts` 里的 `row()` 调用。验证：`npm run build:web && node probes/round24-pinactions.mjs`（六组断言：气泡挂在 `body` 且在胶囊下方、三行顺序 archive/rename/delete、移开 220ms 内收起、就地改名发 `rename` 且名字当场换掉、归档出抽屉且整条不被压扁且发 `archive`、删除克隆飞进左栏且条已收起且发 `delete` 且徽标变 1、最后点「垃圾箱」直达垃圾箱视图；截图在 `.scratch/round24-pinactions/shots/`）。回归：`round1-ui` / `round19` / `round20-turns` / `round21-cwd-line` / `round22-dirsize` / `round22-hl` / `round23-nav` / `fs-ui` 全绿，`npm run typecheck` 干净。
## D65 `npm start` 必须连前端一起打包：`web/dist` 是 gitignore 的产物，没人替你重建

**症状**：源码 `main` 已经是最新（`865c32c`），但界面上「📁 文件管理器」不见了，退回只有「📂 产物」的老样子。

**根因**：`web/dist` 被 `.gitignore` 掉，是纯生成物；bridge 的 `WEB_ROOT` 默认就指它（`bridge/src/index.ts:50-77`），`npm start` 原来只跑 `build:bridge` 就 `node bridge/dist/index.js`。于是**改了 `web/src` 之后重启服务，服务端换的是新 bridge、发给浏览器的还是上一次 `build:web` 的旧 JS**。实测证据：旧产物 `index-BS6jAuac.js` 时间戳 `10/31 17:55`，而带文件管理器的提交 `a81a429` 是 `11/1 04:26`；旧 JS 里搜「产物」3 处、搜「文件管理器」**0 处**。D50 之前最后一次 `build:web` 恰好停在 `feat/web-ux-sessions-files` 那个分支上。

**决定**：`start` = `build:bridge && build:web && node dist/index.js`（约多 2 秒）；另留 `start:nobuild` 供「刚 build 过、只想重启进程」的场景。README「跑起来」删掉手写 `npm run build:web` 那一行——少一条要背的规矩。

**为什么不是「启动时检查 dist 比 src 旧就自动重建」**：`web/src` 有 20 个模块，比较 mtime 要把整棵树 stat 一遍、还要处理「src 没变但换分支」这类假阳性，光判据本身的代码就比一行 `npm run build:web` 长；直接每次重建在 2 秒的量级上根本不用优化。**可改**（真想省那 2 秒就退回 `start:nobuild`）。

**顺带记下一个会误导排查的隐藏条件**：`renderTop()` 里 `this.els.fs.hidden = !this.currentId`（`web/src/app.ts:1982`，`files`/`fs` 两颗按钮同一条规矩）——**没选中会话时按钮本来就不显示**。所以「最新构建 + 停在没有会话的首页」看起来和「旧产物」一模一样，判断前必须先看 dist 产物有没有这个字符串：`grep -l 文件管理器 web/dist/assets/*.js`。

**验证**：`PI_WEB_PORT=7866 PI_WEB_STATE=.scratch/d62-state npm start` — 日志里依次出现 `built in ~1.9s`（vite）与 `listening on http://127.0.0.1:7866`；`grep -l 文件管理器 web/dist/assets/*.js` 有命中；旧产物被清掉（vite 每次换 hash 文件名）。

## D66 `.app` 的隐式列改成 `minmax(0, 1fr)`：顶栏两颗按钮把 390px 的手机撑到 730px

**症状**：手机上（390×844）每一张卡片右缘都被切掉一截，横向能拖动；截 README 图时一眼就看出来。

**根因**：`.app` 只声明了 `grid-template-rows`，**没声明列**，于是隐式列是 `auto` —— `auto` 轨道的尺寸由子项的 min-content 决定。顶栏是 flex，里面 `📂 产物`（64px）、`📁 文件管理器`（99px）、`Aa`、`⌘` 这些 `flex: none` 的按钮加起来约 300px，会话名又给了 453px（`white-space: nowrap` 的 min-content），顶栏的 min-content 就是 730px，整条隐式列跟着变成 730px，`.main` 和 `nav.tabs` 一起被拉到 730；`documentElement.scrollWidth` 实测 730。

**决定**：`.app` 补一行 `grid-template-columns: minmax(0, 1fr);`，跟 `.main` 早就写过的那句同一个理由（那里的注释已经解释过「1fr 会被 min-content 撑开」）。

**为什么不是「窄屏把两颗 wide 按钮藏掉」**：藏掉等于手机上再也进不去文件管理器（顶栏是它唯一的入口，palette 里只有「产物列表」没有「文件管理器」）。让列可以被压缩、名字走已有的 ellipsis，比砍功能对。

**验证**：`node probes/readme-shots.mjs` 的手机那段会在截图前量一次 `document.documentElement.scrollWidth` 并打印越界元素链（修之前是 `730`，链条一路 `.app → .topbar → .title`；修之后视口 390、顶栏里的 `.title` 只剩 113px 走省略号，越界的只剩 `span.cmd` 这类按设计被 `.pane{overflow-x:hidden}` 裁掉的工具命令行）。**可改**：如果真嫌 113px 太窄，就把 `📂 产物 / 📁 文件管理器` 的文字在窄屏换成纯图标（要给按钮加一个 `span.label` 才好按 CSS 隐藏，属于下一步）。

## D67 markdown 内联解析的两处漏网：嵌套图片链接、链接标签里的行内代码

**症状**：预览 `README.md`（D64 之后随手一看），首行徽章变成 `![License: Apache-2.0](LICENSE)`，正文里 `[`docs/`](docs/)` 显示成带反引号的粗体字。

**根因（两处都在 `md.ts` 的内联正则里）**：

1. 链接标签的字符类是 `[^\]\n]+` —— **不许出现 `]`**。而 `[![badge](https://…)](LICENSE)` 的标签里正好有一个 `]`，外层链接整个匹配不上；扫描指针往后挪到 `[License: Apache-2.0]` 时，**内层**那段反而当成了链接。实测 DOM：`<a href="https://img.shields.io/…">![License: Apache-2.0</a>](LICENSE)` —— 半个链接 + 一堆标点。
2. 文件名链接走 `fileLink()`，它对标签只做 `a.textContent = label`，**不再往下解析**。于是 `` `docs/` `` 里的反引号原样留在屏幕上（外部链接那条分支早就调 `inlineInto` 了，内部分支漏了）。

**决定**：链接标签允许一层嵌套方括号（`\[(?:[^\[\]\n]+|\[[^\]\n]*\])+\]`），并在标签前面加 `(?<!!)` —— 这样 `![…]` 永远归「图片」那条分支，不会再被当成链接的半个身子；标签若是图片就渲染成 `<a><img></a>`（`wrapHref`/`imageNode` 两个小工具，顺手把 m[2] 分支里重复的建图代码也收进去）；`fileLink()` 加一个 `inlineLabel` 开关，内部链接的标签也过一遍 `inlineInto`（嵌套链接用 `openPath: ()=>{}` 掐掉，`<a>` 套 `<a>` 不成立）。

**为什么只支持一层嵌套**：markdown 的标签嵌套是有限文法，一层足够覆盖徽章这种真实写法；再深就得写真正的内联解析器，而这条正则体系（340 行、无依赖、无 innerHTML）本来就是「够用就好」的取舍。

**验证**：`node probes/readme-shots.mjs` 起好临时桥后额外断言一次 README 渲染 —— `rawImageSyntax: 0`（没有原始 `![`）、`rawBracketTail: 0`（没有裸的 `](LICENSE)`）、`badges: 1`、`codeInLink: 10`。改前实测是 `1 / 1 / 0 / 0`，而且第一条断言会直接抛错。

**可改**：`INLINE` 正则里 m[3] 那一条；`fileLink` 的第五个参数（`inlineLabel`）；`wrapHref()` 决定标签里装图片时该跳去哪。

## D68 滚动竞争的真凶是「拿每个 touchmove 和上一次比」：改成和手势起点比，并在手指按住期间禁用程序化滚动

**症状**：手机上发完消息、回复正在流式输出时向上滑，视口被一下一下拽回底部，滑动几乎无效。

**先复现**：`probes/scroll-race.mjs` —— 桩桥（不碰 pi、不花模型调用）+ 真触摸（CDP `Input.dispatchTouchEvent`）+ 每 80ms 一条 `delta` 的真流式。同时跑两种手势：

| 手势 | 改前 gap 轨迹 | 改前结果 |
| --- | --- | --- |
| 快滑 18px × 12 | `[3, 339]` | PASS（能挣脱） |
| 慢滑 4px × 40 | `[0, 4, 55, 4, 4]` | FAIL：`stopAt=-1`，收尾 8 次采样里 **6 次钉在底部** |

**根因（两条，都在 D54 那套状态机的输入侧）**：

1. `touchmove` 里 `if (y - touchY > 6) stopFollowing(); touchY = y;` —— **每个事件都跟上一个事件比**。真机慢滑每个 `touchmove` 只报 1–5px，阈值永远跨不过去，于是 `following` 一直是 `true`，每帧 `scrollTop = scrollHeight`。D54 当初是为了干掉「等 `scroll` 事件」的滞后才改成意图优先，但手势判据本身写成了逐帧差分。
2. `scroll` 事件里 `if (nearBottom()) resumeFollowing()` **不区分手指是否还按着**。拖拽起点本来就在底部，任何一个中间态 `gap ≤ 24` 都会把跟流重新打开 —— 轨迹里那个 `55 → 4` 的回落就是它。

**决定**：`touchstart` 记 `touchStartY`，`touchmove` 和**手势起点**比（`y - touchStartY > 6`），并新增 `touching` 标记（`touchend` / `touchcancel` 清掉）；`touching` 期间 `scheduleScroll()` 的 rAF 直接返回、`scroll` 事件不 `resumeFollowing()`。

**为什么不是「把阈值调小」**：逐帧差分的阈值调到 2px 会在轻点时误判（点击抖动 1–2px），调到 0 又会在任何噪声上停跟；错的是「和上一次比」这个判据，不是那个数字。**为什么不在 `scroll` 里判断方向**：程序化滚动自己也会触发 `scroll`，方向信息不可信——D54 已经吃过这个亏。

**代价**：手势最初约 6px 的拖拽仍然被跟流吃掉（阈值本身）；手指按住不动时视口不再自动跟随（这是有意的：用户的手在流上）。回到距底 24px 内仍然自动恢复跟流，这条有专门断言。

**验证**：`node probes/scroll-race.mjs` 三段断言 —— 快滑 `stop after 36px`、慢滑 `stop after 12px`（改前是 `Infinity`）、`back to bottom: jumpHidden=true / gap=0`；任何一段失败都退出码非 0。改前慢滑 FAIL，改后三段全 PASS。

**可改**：阈值 `6` 在 `chat.ts` 的 `touchmove` 里；`touching` 抑制的两处（`scheduleScroll` 的 rAF、`scroll` 处理器的 `resumeFollowing`）；那条「拖到底要恢复跟流」的断言用的是 `scrollTop` 而不是再模拟一次拖拽——无头 Chrome 会合帧连续的 `touchMove`，模拟拖拽测的是合帧器不是应用。

## D69 「在文件夹中显示」：打不开的格式交给系统的文件管理器，而不是让网页启动它

**需求**：文件管理器里点开一个 `.xlsm`，预览只能给出「二进制文件（65.9 KB），这里不直接显示」+「新标签页打开 / 下载」。真正想要的是**在这台电脑的文件管理器里打开它所在的目录，文件已经选中**，然后自己双击用 Excel 打开。浏览器下载一份副本再去找，是绕远路。

**决定**：桥新增 `POST /api/reveal`（`bridge/src/terminal.ts` 的 `revealInFileManager` / `revealCommand`），前端在**「二进制文件」面板**和**「预览出错」面板**各加一颗「📂 在文件夹中显示」，点击后 toast 回桥的原话。三平台命令：

| 平台 | 命令 | 效果 |
| --- | --- | --- |
| Windows | `explorer.exe /select,<abs>` | 打开所在目录**并选中文件** |
| macOS | `open -R <abs>` | Finder 里选中 |
| Linux | `xdg-open <dirname>` | 只开目录（没有可移植的 reveal 动作） |

**为什么不做「用默认程序直接打开」**：那是让网页在桌面上启动任意文件关联程序（`.exe` 也在关联表里），比「打开一个目录」高一个风险等级；而用户的原话就是「用户可以自己打开」。**为什么按钮只放在这两个面板、不放顶栏工具条**：顶栏已经有 ↗（新标签页）、⧉（复制路径）、📎（引用路径）三颗，再加一颗会挤；而且这条动作只在「这里打不开」的语境里才有意义。

**安全**：信任级与 `/api/preview` 相同（能打开这个页面的人本来就能全盘读，D50），但它**在桌面上产生可见动作**，所以 `publicReq`（隧道进来的）**直接 403**，连 step-up 都不给——和终端禁用同一条线（D52）。错误响应统一是 `{error}`，跟其他路由一致（第一版返回 `{message}`，被探针当场抓出来）。

**启动方式沿用 `openConsole` 的教训**：`spawn(..., {stdio:"ignore"}).unref()`，**不 detached** —— Windows 上 `DETACHED_PROCESS` 没有桌面关联，窗口会静默不出现（Q-008 踩过）。`explorer.exe` 成功时也返回退出码 1，所以只报「命令已发出」，不假装知道窗口开没开。

**验证**：`node probes/reveal-check.mjs` —— 三平台命令形状断言（含中日文带空格路径 `/select,C:\Users\me\我的 文档\a.xlsm` 仍是**一个** argv）+ 缺文件 400 + 目录 400 + `cf-connecting-ip` 伪造的隧道请求 403；加 `REVEAL_OPEN=1` 会真的弹一次窗口（已实测：资源管理器停在 fixture 目录、文件被选中，桥日志 `reveal ... → ok`）。UI 侧另用一次临时 Playwright 复核：二进制面板上两颗按钮都在（`新标签页打开 / 下载`、`📂 在文件夹中显示`）。

**可改**：`revealCommand` 的三条分支（要给 Linux 补文件选中就得上 `dbus` 的 FileManager1）；按钮位置在 `paintViewer()` 的 binary / error 两个分支；要不要顺手在顶栏给一个「任何文件都能在文件夹里显示」的图标，是下一步的事。

## D70 终端多开 = 一个 dock + 标签条：桥早就支持 4 个，卡住的是前端只有一个槽位

**需求**：终端要能同时开多个。

**先查清的事实**：桥这边**已经**支持多开 —— `bridge/src/terminal.ts` 的 `Terminals` 是个 `Map<id, Term>`，`MAX_TERMS = 4`，`term.list` / `term.attach` / `term.data` 全都带 id。真正的限制在前端：`app.ts` 只有一个 `private term: {...} | null`，`mountTerminal()` 第一件事就是 `closeTerminal()`，所以第二次「打开终端」只是把上一个顶掉。**结论：这次不用改桥，改前端。**

**决定**：一个 `.term-dock`，头部一条 `.term-tabs`，一个标签一个 shell（各自的 xterm + 各自的 `.term-body`），`＋` 再要一个；`管理员` / `关闭` 作用于当前标签，`×` 只关自己那一个。标签文字 = 目录名（`pi-web-client`），同名时加序号（`pi-web-client #2`），完整 `shell · cwd` 在 `title` 里。

**为什么标签只写目录名**：第一版写的是 `powershell · pi-web-client #2`，实测 190px 的标签里 ellipsis 先把 `#2` 吃掉，两个标签看起来完全一样。把 shell 名挪进 `title`、把序号放末尾，才是短的能分辨的写法。

**为什么标签条自己横滚**：`＋` 和右侧按钮必须永远点得到；`.term-tabs { max-width: 60%; overflow-x: auto }`（滚动条隐藏）。

**换回页面时怎么恢复**：连接建立后发 `term.list`，对每个还活着的 shell 发 `term.attach` 拿全量回放。`term.replay` 是**整段**缓冲，所以写入前先 `term.reset()` —— 断线重连时不清就会把历史追加两遍。sessionStorage 里那个 `pi.termId` 一并删掉：终端属于桥，不属于某个浏览器标签页。

**代价**：非当前标签的 body 是 `hidden`，xterm 在隐藏容器里量不出尺寸，所以切回来要重 `fit()`（`activateTerm()` 里下一帧做）；最多 4 个（桥的上限，超了会以 `term.error` 回一条提示）。

**验证**：`node probes/terminal-multi.mjs` —— 两层：UI 层（1 个标签 → `＋` → 2 个、任意时刻只有 1 个 body 可见、点标签切 `.on`、标签可分辨），协议层（**另开一个 WS 客户端**分别给两个 id 发 `term.input`，确认回显各自回到自己的 id、两条流不交叉）。xterm 是画在 canvas 上的，DOM 里读不到文字，所以「两个 shell 是两个进程」只能这么证。

## D71 文件管理器里「复制路径」：和工作目录按钮并排，复制的是**正在浏览**的那个目录

**需求**：点开文件管理器后，在「⌂ 工作目录」旁边加一个复制按钮，复制下方选中的目录路径。

**决定**：`dirCopy()` 与 `dirHome()` 并排返回 `{node, bind}`，挂在 `.dir-head` 的 `head: [home.node, copy.node]` 上；`bind()` 在每次 `onState` 里重跑，点击时读 `picker.path()` —— **实时值，不是打开面板时的快照**（先切两层目录再点，复制到的必须是当前那层）。点完按钮自身文字闪 1.1 秒「已复制」。

**细节**：`navigator.clipboard` 在 http 的局域网地址上是 `undefined`，所以 optional chaining 必须包住**调用**（`navigator.clipboard?.writeText(...)`）而不是只包属性，否则 `.then` 会抛 TypeError；拿不到剪贴板时给一条明确的提示，而不是静默失败。盘符列表（此电脑）没有路径，按钮 `disabled`。

**只加在文件管理器，不加在另外两个目录选择器**：附件选择器和新会话 sheet 的「浏览」也有 `⌂ 工作目录`，但那两个的用途是「选一个就走」，复制路径没有落点；等真有人要再说（`dirCopy()` 已经是现成的，加一行就到）。

**验证**：`node probes/dir-copy.mjs` —— 断言两颗按钮在路径行上且复制紧跟在「工作目录」之后；切进 `alpha/` 后点复制，剪贴板内容 `=== path.join(WORK,"alpha")`；按钮显示「已复制」；点面包屑回「此电脑」后按钮 `disabled`。剪贴板读写在探针里用 `context.grantPermissions(["clipboard-read","clipboard-write"])` 打开。

## D72 一轮的边界以 `agent_settled` 为准；停止 = 先 `clear_queue` 再 `abort`；压缩期间的消息由桥扣住（#9 #10 #11 #12）

**决定：**
1. `running` / `done` 只在 `agent_start` → `agent_settled` 之间翻转，`agent_end` 只刷新统计。取代 D45 说明里「`agent_end`/`agent_settled` 置 `done:true`」那半句；D30 的「跑着就加 `followUp`」因此覆盖到重试、溢出恢复整段。
2. 中断在 D19（先清审批）之后再补一步：`clear_queue`（等应答）紧跟 `abort`（照旧 fire-and-forget）。清出来的文本以 `queue.restore` 推回输入框；这些消息的气泡等本轮 settle 后从桥的 transcript 里删掉，再整份 `items` 重发。
3. 手动 / 自动压缩的 RPC 超时从默认 20 秒改成 30 分钟，真正的边界看 `compaction_start` / `compaction_end`。这段时间里到达的 `prompt` 在桥里等压缩结束再发，同时给一条「压缩完成后发出」的提示。
4. assistant 消息带上 `errorMessage`（live 与读盘两条路径都带），聊天里画成红色错误块；`auto_retry_start` 写明原因、第几次、几秒后，`auto_retry_end` 失败时报 `finalError`。

**为什么：**
- pi 文档写明 `agent_end` 只是一次底层 run 结束，重试 / compaction / steering / follow-up 都会接着跑，「不会自动继续」的唯一信号是 `agent_settled`（`docs/rpc.md` Run lifecycle）。以前在 `agent_end` 就判空闲，于是重试那几秒卡片显示「完成」，这时发出的消息不带 `streamingBehavior`，被 pi 以 `Agent is already processing` 拒掉。
- `abort` 不清队列，pi 一空闲就把排队的消息接着跑（`docs/rpc-commands.md` clear_queue：官方 Esc 语义就是先 `clear_queue` 再 `abort`）。`clear_queue` 在 pi 里是同步的（`session.clearQueue()`），命令又按到达顺序分派，所以 `abort` 开跑之前队列已经空了，不必等它的应答再发 `abort`。
- 桥的 `rpc.request` 默认 20 秒，大上下文压缩常常超过它：网页报超时，pi 实际还在压。另外 pi 在压缩中收到 `prompt` 会直接抛错（`agent-session.js`：`Cannot submit a prompt while compaction is in progress`）；而自动压缩发生在 `running=false` 的空档，用户正好会在这时发消息。
- 出错的回复往往一个字都没有，只有 `stopReason:"error"` + `errorMessage`；以前只认 `aborted`，于是错误回合只剩一个空气泡。

**附带修掉：** `queue_update` 转发时写成 `{ type: "queue", ...ev }`，事件自带的 `type: "queue_update"` 把它盖掉了，网页从来没收到过 `queue`。改成先展开再覆盖 `type`（队列面板本身仍在 #14）。

**代价：** 撤回后整份 `items` 重发，会把只存在于网页的 notice（比如上一条「重试中」）一起清掉；错误卡片在 transcript 里，不受影响。

**验证：** `node bridge/tests/run-lifecycle.mjs`（约 40 秒）。它用脚本化的假 pi `bridge/tests/fixtures/fake-pi.mjs`（`PI_BIN` 指过去）复刻 pi 1.4.0 的三条规则：跑着时收到裸 prompt 就拒、压缩中收到 prompt 就拒、`abort` 不清队列。断言：重试期间不出现空闲状态、期间发的消息带 `followUp`、两条 `errorMessage` 都到达；停止后排队消息不再运行、文本回到 `queue.restore`、气泡被删；22 秒的压缩不报超时，期间发的消息在 `compact-end` 之后才到达 pi。修复前的代码在第一条断言就失败。

## D73 会话目录按 pi 自己的顺序解析，列表不再每个目录截断 60 个（#20）

**决定：**
- `agentDir()` = `PI_CODING_AGENT_DIR`（展开 `~`）→ `~/.pi/agent`。
- 会话根 = `PI_CODING_AGENT_SESSION_DIR` → 全局 `settings.json` 的 `sessionDir`（绝对路径或 `~`）→ `<agentDir>/sessions`。
- 原来的 `PI_AGENT_DIR` 保留为**只给桥用的测试缝**，优先级最高，不传给 pi 子进程（探针靠它把列表指到 fixture，同时让 pi 继续用真实的 auth/models）。
- `listSessionFiles` 同时读根目录下平铺的 `.jsonl`（自定义 sessionDir 的布局，pi `listSessionsFromDir`）和 `--<cwd>--/` 子目录（默认布局），去掉每目录 60 个的上限。
- 元数据按 `mtime + size` 缓存，列表刷新时只做 `stat`。
- `/api/me` 多回一个 `sessionsRootSource`，说明答案从哪来。

**为什么：** 以前桥读的是一个 pi 不认识的变量名，也不看 `PI_CODING_AGENT_SESSION_DIR` 和 `sessionDir`。用户改了其中任何一个，网页列的是旧目录，而网页起的 pi 子进程（继承了环境变量）把新会话写到了别处，于是「网页新建的会话在网页上看不到」。60 的上限会让老会话悄悄消失。缓存是去掉上限的前提：D26 要求列表阶段只碰文件头，而侧栏每隔几秒就重列一次。

**不覆盖：** 项目级 `.pi/settings.json` 的 `sessionDir`，以及相对路径的全局 `sessionDir`。在 pi 里它们都相对各项目的 cwd 解析，不存在一个能列的统一目录；遇到相对路径时打一行日志，然后回落到默认目录。**可改**

**验证：** `node bridge/tests/session-dirs.mjs`（直接 import `.ts`）覆盖六种解析顺序、平铺加嵌套共 135 个会话全部列出、缓存能跟上改名和删除。

## D74 网页看到的会话＝pi 会恢复的那条分支；用户消息由桥广播；扩展的通知 / 状态 / 小部件有地方放；终端专用命令不再发给模型（#13 #18 #19 #22）

**决定：**
1. **分支**：读盘后从最后一行沿 `parentId` 回溯到根（`currentBranch()`），只把这条路径转成 items。
   - 文件里没有 `parentId` 字段（老格式）就原样平铺。
   - 回溯时遇到缺失的父节点（只读了文件尾部）或环，就停在那里。
   - 只读 tail 刷新时：旧列表是新列表的前缀，就照旧逐条 `item.add`，内容有变化的旧条目发 `item.replace`；不是前缀（终端里切了分支），就整份 `items` 重发。
2. **用户消息**：`prompt()` 把用户条目广播成 `item.add`，并带上发送页给本地气泡起的 `clientId`。
   - 发送页用 `chat.adopt(clientId, item)` 只换 key、保留原节点（轮次刻度带指着它）。
   - 其他页面直接画出这条消息。
3. **扩展 UI**：`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` 不再走「不支持就取消」的分支，也不再回 `extension_ui_response`。
   - `notify` → 聊天里的 notice，`warning` 映射成 `warn`。
   - `setStatus` → 输入框下方的状态行；`setWidget` → 输入框上方或下方的等宽块；`setTitle` → 浏览器标签页标题；`set_editor_text` → 替换输入框内容。
   - 状态行、小部件、标题由桥保存，随快照下发给后来打开的页面；pi 进程退出时清空。
   - 所有文字去掉 ANSI 控制序列。
4. **终端专用命令**：输入框里的 `/new`、`/resume`、`/model`、`/thinking [档位]`、`/name [名字]`、`/compact [指令]`、`/hotkeys`、`/quit` 直接映射到网页已有的功能。
   - `/compact` 的指令作为 `customInstructions` 传给 pi。
   - `/tree`、`/export`、`/settings`、`/login` 等暂时没有对应功能的命令，以及 `!` / `!!`，在聊天里说明「没有发给模型」并给出跟踪 issue，输入框原文保留。
   - 扩展命令、提示词模板、`/skill:` 照旧发给 pi。

**为什么：**
- pi 的会话文件是一棵树，重新打开时以最后一行为 leaf（D26）。按文件顺序平铺，会把 `/tree` 留下的废弃分支和当前分支交错显示。
- 以前用户消息只存在桥的内存里，不广播：另一台设备看不到，自动接管时整份 `items` 重发还会把发送页的本地气泡冲掉。
- 这五个方法在 RPC 下是单向的（`rpc-mode.js`），桥把它们当成「不支持的对话框」回了 `cancelled`，内容全丢。
- pi 在 RPC 下只执行扩展命令，并展开 `/skill:` 与模板（`agent-session.js` 的 prompt 处理）；TUI 内建命令和 `!` 原样进了模型上下文。

**代价 / 可改：**
- 被拒的命令原文留在输入框里，用户得自己删。这样做是为了不丢输入，也方便改成别的写法。**可改**
- 浏览器标签页标题被扩展改掉后，切到别的会话会恢复成 `pi`。

**验证：**
- `node bridge/tests/session-sync.mjs`，覆盖四组断言：
  - 分支会话只显示 leaf 分支；终端切换分支后整份重发，同分支追加仍是增量。
  - 两个页面之间，用户消息带着发送方的 `clientId` 广播。
  - 扩展五种 UI 都送达且去掉 ANSI；重新订阅后仍在；没有给 pi 回过任何应答。
  - `/compact` 的指令到达 pi。
- 修复前的代码在第一条断言就失败。
- 真 Chromium 检查：发送页只有 1 个用户气泡（另一页也是 1 个）；小部件、状态行、标签页标题、输入框预填都在；`/tree`、`!git status` 发出后 pi 一条用户消息都没收到；`/new` 打开了新建会话面板。

## D75 运行中 Enter = 引导、Alt+Enter = 排到之后，队列条可撤回；`!cmd` 走 pi 的 RPC bash；模型面板加「会话」一节（#14 #15 #16）

**决定：**
1. **引导 / 排到之后**：会话在跑时，Enter 发 `streamingBehavior:"steer"`（当前这步工具跑完、下次调用模型前插入），Alt+Enter 发 `"followUp"`（整轮结束后再处理）。键位与 pi 终端一致。**取代 D30 的「跑着时一律 followUp」**；bridge 在没收到 `behavior` 时按 steer 处理。
2. **队列条**：桥记住最后一次 `queue_update`，随快照下发，在 `agent_settled` 和进程退出时清空。输入框上方显示「排队中 N 条」，每条标「引导 / 之后」。「撤回到输入框」发 `clearQueue`，效果同终端的 Alt+↑：文本回到输入框、对应气泡删掉，**但不中断当前这一轮**。
   - 停止（D72）复用同一段 `withdrawQueue()`。
   - 删气泡改用定点的 `item.remove`，取代 D72 里「等 settle 后整份 `items` 重发」：整份重发会冲掉正在流式输出的草稿和网页侧的 notice。
3. **`!cmd` / `!!cmd`**：走 pi 的 RPC `bash`（`!!` 带 `excludeFromContext`），在聊天里显示成独立的命令卡片。
   - 卡片显示命令、「下一条消息时进上下文 / 不进上下文」、退出码，以及流式输出（`bash_execution_update` → `bash.delta`）。
   - 运行中的卡片有「停止」（`abort_bash`）。
   - 同一会话一次只跑一条，第二条直接拒绝。
   - 读盘时 `role:"bashExecution"` 的消息画成同样的卡片（#31 中与 bash 相关的那部分）。
4. **会话信息与手动压缩**：模型面板加「会话」一节（`/session` 打开这里），显示：
   - 上下文占用、累计 token（输入 / 输出 / 缓存读 / 缓存写）、累计费用（`get_session_stats`，以前就推到网页了，只是没显示）；
   - 会话 ID、会话文件路径（复制、在文件夹中显示）；
   - 「立即压缩」加一个可选的指令输入框，等同 `/compact <指令>`。它是动作，不跟随面板的「确认」草稿。

**为什么：**
- pi 区分两种排队，网页只给了一种，「让它换个方向」只能等整轮做完。
- 队列看不见，也就没法撤回。
- 在网页终端里跑的命令输出进不了上下文，只能复制粘贴；而 pi 本来就有 `bash` 命令，并且会把输出带进下一条消息（`docs/rpc-commands.md` Bash）。
- 压缩只能靠超预算自动触发，`/compact` 的指令也没地方写。

**代价 / 可改：**
- 手机键盘没有 Alt+Enter，手机上运行中发送一律是「引导」。**可改**（以后可在队列条里加切换）。
- 队列条以文本匹配气泡：消息经 `/skill:` 或模板展开后，pi 队列里的文本和气泡对不上，撤回时这些气泡会留下。
- `steering` / `followUp` 的处理方式（`one-at-a-time` / `all`）放到设置面板（#26）。

**验证：** `node bridge/tests/composer-actions.mjs`（假 pi）。
- 运行中裸发 = steer，`behavior:"followUp"` 透传；队列消息两类都有；中途打开的页面能在快照里拿到队列；撤回后文本回来、两个气泡删掉、这一轮没被中断。
- `!` 进上下文、`!!` 不进；退出码 0 / 2；流式输出；停止后为 `cancelled`；第二条被拒。
- 读盘的 `bashExecution` 画成卡片。
- `run-lifecycle.mjs` 改为断言 `item.remove`。
- 真 Chromium：队列条与撤回、三种命令卡片、`/session` 面板、带指令的立即压缩都检查过。
## D76 置顶横向栏给「当前会话」整颗填色：收起左栏后那排胶囊是唯一的入口，得看得出自己在哪儿

**需求**：「现在置顶横向栏中的会话无法明确出于哪个会话。给当前的会话加填充，要一眼能看出现在处于哪个会话」。

**决定**：`renderPinStrip()` 里对 `s.id === this.currentId` 的胶囊加 `.cur` 与 `aria-current="true"`；`.pin-chip.cur` 用**整颗填色**（`rgba(125,211,252,.16)`）+ 强调色描边，`.pin-name` 加粗。当前会话没被置顶时**不**硬凑标记。

**为什么是填色，不是左栏那种细描边**：左栏卡片近 300px 宽，`border-color: var(--accent)` 一条就够；胶囊只有约 120px 且彼此紧挨，深色底上一条 1px 描边在一条横排里几乎看不出来（两种都截过图对比）。名字加粗是第二信号——不靠颜色也能分辨。

**为什么 `aria-current` 打在容器上**：胶囊里是两颗按钮（★ 取消置顶 / 其余区域打开），「当前」属于这一条会话，不属于其中某一颗按钮。

**为什么未置顶时不标**：这条横栏是可选的（只收 `manage.pin` 里且未归档的会话）。当前会话没被置顶时，它在这条里本来就没有入口，凭空标一颗别的胶囊只会误导。

**代价**：一条横排里最多一颗填色胶囊，颜色与 `.pin-chip.wait`（等审批的暗黄描边）可能同屏；两者不冲突（一个是填充、一个是描边 + `small` 的文字色），实测同屏可分辨。

**验证**：`node probes/pin-current.mjs`（桩桥 + 真 Chromium）——打开 A 并收起左栏 → 只有 A 的胶囊带 `.cur`/`aria-current`，且与 B 的胶囊**底色、描边、字重三项都不同**（不硬编码色值，换主题也成立）；点 B 的胶囊 → 标记搬家、A 复原；切到未置顶的 C → 这条里没有任何 `.cur`；展开左栏 → 整条横栏重新隐藏。证据图：`docs/shots/pin-current.png`（A 是当前会话）；探针支持 `PIN_DIST=<另一份 web/dist>` 跑「改之前」的对照，那时六条断言全红、两颗胶囊底色同为 `rgb(18,21,26)`、字重同为 400。

## D77 分叉 / 复制用 pi 自己的 SessionManager 写新文件；会话树、导入、导出、`/` `@` 补全、终端选 shell、摘要卡片（#17 #23 #24 #25 #31 #32）

**决定：**
1. **分叉 / 复制（#17）**：bridge 从 pi 安装目录 import `dist/core/session-manager.js`（由 `cli.js` 往上三级定位，首次加载约 2 秒，之后复用）。
   - 分叉：`SessionManager.open(源文件).createBranchedSession(用户消息的 parentId)`，消息原文放回输入框。
   - 复制：在当前 leaf 上做同样的操作。
   - 新文件由 pi 自己的代码写出：header 带 `parentSession`、label 重建、compaction 重新串链，和终端里 `/fork` `/clone` 的结果一致。源文件只读不写。v1/v2 旧格式拒绝分叉，因为 `open()` 会原地迁移重写。
   - 在第一条消息处分叉，pi 本来就不写空文件，所以等于在同一目录开一个新会话，再把消息放回输入框。
   - 实时气泡的 id 不是 entry id：用「当前分支第 N 条用户消息 + 原文」对上 entry。
2. **会话树**：bridge 直接读文件，把用户消息按「最近的前一条用户消息」挂成树，`current` 标出 pi 会接着走的那条（D74）。
   - 每一条都能分叉，废弃分支上的也行（pi 的 `getEntry` 不限当前分支）。
   - **不做**「切换 leaf」：RPC 没有这个命令，终端 `/tree` 只改内存里的 leaf。要在废弃分支上继续，就从那里分叉。
3. **导入（`/import <路径>`）**：照 pi 的 `importFromJsonl` 做，`COPYFILE_EXCL` 复制进该 cwd 对应的会话目录（自定义 sessionDir 时是平铺目录），重名加 `-1`；同 id 已在列表里就拒绝。原文件不动。
4. **导出（#24）**：
   - `GET /api/export?id=` 跑 `pi --export <文件> <state/exports/id.html>`，在新标签页打开；`&format=jsonl` 直接把会话文件作为附件下载。
   - `GET /api/log?id=` 是网页版 `/debug`，返回该会话 pi 进程的 stderr 日志。
   - `/copy` 和消息头上的 ⧉ 复制原文（markdown）。
   - `/share`、`/bug` 需要外部服务，拆到 #38。
5. **补全（#25）**：
   - 输入框开头 `/` → 内建命令（网页能执行的那些，见 D74）+ `get_commands` 返回的扩展命令、提示词模板、技能。没有活进程时只列磁盘上的技能。
   - 任意位置 `@` → `GET /api/files`：git 仓库用 `git ls-files --cached --others --exclude-standard`，否则有界遍历（跳过 node_modules 等），每个 cwd 缓存 10 秒，按「文件名命中 > 路径命中 > 子序列」排序，插入 `@相对路径 `，和终端一样。
   - ↑↓ 选、Enter / Tab 采纳、Esc 关闭；已经完整输入的命令按 Enter 直接发送。
6. **终端（#23）**：`availableShells()` 按平台列出这台机器真有的 shell。
   - Windows：pwsh、powershell、Git Bash、cmd。
   - 其他：`$SHELL`、zsh、bash、sh。
   - `＋` 有多个可选时弹菜单；「管理员」窗口只用 PowerShell。
7. **摘要卡片（#31）**：compaction 的 summary（live 来自 `compaction_end.result`，读盘来自 entry）、`branch_summary`、`display:true` 的扩展消息（`custom_message` entry 和 live 的 `role:"custom"`），画成默认折叠的卡片。工具耗时：会话文件里没有，不补。
8. **`shared/protocol.ts` 删除（#32）**：它是没人 import 的旧协议草稿，字段名 `t:` 和实际的 `type:` 对不上。
9. **布局修复（D75 引入的）**：模型面板是固定行的 grid（模型列表是 `1fr` 那一行），「会话」一节插进去后占掉了这一行，长路径还把面板撑到约 1000px。现在把它和预算放进同一个 `.sheet-top`，并设 `min-width: 0`。

**为什么：**
- 最先试的是起一个临时 `pi --mode rpc --session <源文件>` 子进程再发 `fork`，测试抓到它会往**源文件**追加一行 `thinking_level_change`：打开会话时 pi 会做模型解析。源文件可能正被终端写着（D8），这等于第二个写者。直接用 pi 的 SessionManager 只读源、只写新文件，也省掉起进程的时间。
- 其余几项都是终端里随手能做、网页上却要切走的事。

**代价 / 可改：**
- 依赖 pi 包内部路径 `dist/core/session-manager.js`，不在它的 `exports` 里；升级 pi 后如果路径变了，分叉 / 复制会报「加载不了 pi 的会话模块」，其他功能不受影响。
- `@` 搜索在超大仓库里最多看 2 万个文件。
- 导入时，导入文件的 cwd 不存在也照样复制，等接管时才会报错。**可改**

**验证：**
- `node bridge/tests/branch-ops.mjs`（用本机真 pi，不调模型），覆盖：
  - 树的嵌套和 current 标记；
  - 在当前分支和废弃分支上分叉、按位置加原文分叉，新文件内容和 `parentSession` 正确，**源文件逐字节不变**；
  - 复制只取当前分支；
  - 导入是复制、重复导入被拒；
  - HTML / JSONL 导出、未登录 401、没有日志时 404；
  - `@` 搜索的首位命中、子序列匹配、忽略目录；
  - 只读会话的命令列表。
- `node bridge/tests/shells.mjs` 覆盖三个平台的 shell 列表。
- 真 Chromium：三种摘要卡片、⧉ 复制到剪贴板、`/ex` 与 `@chat` 补全及采纳、`/tree` 的缩进（8 / 24 / 24 / 24px）与分叉后消息回到输入框、「会话」一节的导出链接与宽度（560px，不再溢出）、终端 `＋` 菜单（powershell / Git Bash / cmd）。

## D78 pi 设置、项目信任、新建会话的启动参数都交给 pi 自己的模块读写；权限模式「只读」改白名单（#26 #21 #28 #29）

**决定：**
1. **`pimods.ts`**：D77 里加载 pi 会话模块的做法推广成通用的 `piModule(cli, "core/xxx.js")`，带缓存，加载失败时给出明确报错。测试用 `PI_WEB_PI_PKG` 指向真 pi 包，这样 `PI_BIN` 可以继续用假 pi。
2. **设置（#26）**：
   - 读：直接读文件。
   - 写：用 pi 的 `FileSettingsStorage.withLock`，和运行中的 pi 是同一把 proper-lockfile 锁。写入时以**当时磁盘上的内容**为底，只改页面动过的字段（`a.b` 点路径；`null` 表示删除，并顺带清掉删空的父对象）。「编辑 JSON」整份替换，替换前先校验。`__proto__` 之类的键直接忽略。
   - 项目设置：照 pi 的规则，未信任的项目拒绝写入。
   - 表单只放常用项，其余走 JSON：模型、思考档位、`enabledModels`（`/scoped-models`）、两种队列方式、`defaultTools`、压缩、重试、`blockImages`、`enableSkillCommands`、`shellPath`，以及只在全局生效的 `httpProxy` 和 `defaultProjectTrust`。
   - 运行中能改的四项（引导 / 后续消息的处理方式、自动压缩、自动重试）保存时顺带用 RPC `set_*` 应用到当前会话。其余设置要 `/reload`：网页里的 reload 就是重启这个会话的 pi，历史在磁盘上。`/changelog` 读 pi 包里的 `CHANGELOG.md`。
3. **项目信任（#21）**：用 pi 的 `ProjectTrustStore`、`hasTrustRequiringProjectResources`、`getProjectTrustOptions`，选项和终端 `/trust` 完全相同，决定写进 `<agentDir>/trust.json`。
   - 会话快照带上 `trust`。项目需要信任、又没有保存过决定、实际也不会加载时，输入框上方出现提示条。
   - **不做**「仅本次信任」（`--approve`）：网页里的会话会反复重启 pi，一次性的决定没有落脚的地方。要么保存，要么不信任。
4. **启动参数（#28）**：新建会话的「高级」里可以设 `--model` `--thinking` `--tools` `--no-builtin-tools` `-e` `--skill` `--append-system-prompt` `-ne` `-nc` `--no-mcp` `--offline`。
   - `launch.ts` 在拉起进程**之前**校验：一个字段一条规则，`--tools` 不能把普通名字和 `+x` / `-x` 混用（pi 也拒绝）。
   - 参数存在 `state/launch/<id>.json`，每次这个会话的 pi 启动（含接管、`/reload`）都带上；审批门禁的 `-e` 始终在最前面。
5. **权限模式（#29）**：
   - **只读**改成白名单：read / grep / find / ls / tool_search / codemode / MCP 资源读取、网页的提问工具、声明了 `readOnlyHint: true` 的工具。其余一律拦下，包括没有声明的 MCP 工具和扩展工具，以前它们会被放行。
   - **逐个确认**对所有「不确定只看」的工具都弹审批。对这类工具选「本会话允许这类」，记住的是工具名（`tool:<名字>`），而不是参数前缀。
   - `codemode` 本身放行，因为脚本里调用的每个工具都会作为嵌套调用、各自经过 `tool_call` 钩子（已核对 `agent-session.js` 的 `_beforeToolCall` 带 `parentToolCallId`）。

**为什么：**
- 设置、信任、锁的格式都由 pi 定义，自己实现迟早和 pi 不一致；D77 已经证明直接用 pi 的模块比起一个 pi 进程更可靠。
- RPC 不能弹信任提示，没决定过的项目在网页里会静默丢掉 `.pi` 配置，用户无从知道（#21）。
- 只读模式的黑名单漏掉了所有 MCP 和扩展工具，名不副实（#29）。

**代价 / 可改：**
- 依赖 pi 包内部路径 `dist/core/settings-manager.js`、`trust-manager.js`（同 D77）。
- 「逐个确认」比以前问得多：MCP 和扩展工具现在也会问。**可改**

**验证：**
- `node bridge/tests/settings-trust.mjs`：
  - 全局设置首次创建、补丁合并时保留别人改的键、删空的父对象被清掉、非法 JSON 被拒、整份替换、忽略 `__proto__`；
  - 未决定项目的信任状态与选项、未信任时项目设置拒写、信任后写入 `trust.json` 并可以写项目设置；
  - 错误的启动参数在拉起前被拒，正确的启动参数出现在 pi 的 argv 里、`/reload` 之后仍在；
  - 四个运行时设置送达 pi；更新日志接口可用。
- `node bridge/tests/gate-modes.mjs`（直接驱动门禁）：17 条全过。修改前的门禁有 4 条失败：MCP 和扩展工具在只读模式下放行、在逐个确认模式下不问。
- 真 Chromium：信任提示条 → 信任 → `trust.json` 写入、提示条消失；全局表单改两项后保存，文件里只多了这两项；项目页显示项目自己的值；更新日志可读；新建会话的「高级」显示 6 个字段和 5 个开关。

## D79 `/login` 由 pi 的 ModelRuntime 在 bridge 里跑、提问经 WS 转给页面；pi 的包 / MCP 子命令做成面板；给终端 pi 一个会话锁扩展（#27 #33 #30）

**决定：**
1. **登录（#27）**：pi 的登录与界面无关：`ModelRuntime.login(provider, "api_key" | "oauth", { prompt, notify })`。
   - bridge 用 `piModule` 建一个 ModelRuntime（`authPath` / `modelsPath` 指向 `agentDir()`，不联网刷新）。`prompt`（text / secret / select / manual_code）转成 `auth.prompt` 发给页面，等 `auth.answer` 回来。`notify`（auth_url / device_code / info / progress）原样转成 `auth.event`。
   - 凭据由 pi 在自己的锁下写进 `auth.json`。bridge 不保存凭据，也从不把凭据发回页面；provider 列表只带「存的是 api_key 还是 oauth」这个类型。
   - 页面断开时取消它发起的登录；取消或中止统一报「已取消」。登录或登出后重新拉模型目录并广播。
   - OAuth 回调落在运行 bridge 的机器上；从别的设备登录时，用流程自己的 `manual_code` 提问，把跳转后的网址粘贴回来（pi docs/providers.md）。
   - 设备 id 用 pi 的 `SettingsManager.getOrCreateDeviceId()`，和终端 `/login` 一致。
2. **包与 MCP（#33）**：`picli.ts` 只有一组固定操作：`pkg.list / install / remove / update(self|extensions|models|all|来源)`、`mcp.list / add / remove / login / logout`。
   - 每个操作由 bridge 拼 argv、逐项校验（服务名字符集、不允许换行、URL 必须是 http(s)、环境变量必须是 KEY=VALUE），页面从不传命令行。
   - 输出实时转发；`pi list` 的文本和 `pi mcp list --json` 解析成行，`mcp list` 退出码为 1 也照样解析。
   - 本地路径的包在 settings 里存的是相对路径（`..\pkg`），卸载和更新时改用 `pi list` 给出的绝对路径，pi 能对上。
3. **会话锁（#30）**：`bridge/ext/session-lock.ts` 是给**终端** pi 用的扩展。
   - 「安装」：把它复制到 `state/ext/`，写入本 bridge 的锁目录，再加进 pi 全局 settings 的 `extensions`（走 D78 的写入方式，只动这一个键）。
   - 装上之后，终端 pi 打开会话时写 `<locks>/<id>.tty.json`（自己的 pid），切换或退出时删掉。如果打开的会话正被 bridge 写，会先问「退出 pi / 仍然打开」。
   - bridge 看到存活的 tty 登记：列表显示「终端占用」，接管时报出终端 pi 的 PID 并拒绝；pid 已死的登记读到时直接清掉。
   - bridge 自己起的 pi（带 `PI_WEB_ALLOW_FILE`）里，这个扩展什么也不做。
   - 这补上了 D8 里 bridge 单方面做不到的那一半：一个开着但闲置超过 20 秒的终端 pi。

**为什么：**
- 登录、MCP、包管理以前都只能回终端做，和「一个画面做完」的目标相反。
- 登录流程交给 pi 自己跑，provider 增减、OAuth 细节变化都不用跟着改。
- 会话锁只能由 pi 那一侧登记：bridge 看不到另一个进程打开了哪个文件。

**代价 / 可改：**
- `/share`、`/bug` 仍未做（#38）。pi 的实现和 TUI 绑在一起，需要单独设计。
- 「更新 pi 本体」会替换 bridge 正在用的 pi，完成后最好重启 bridge。
- 会话锁只对装了扩展、并且是之后启动的终端 pi 有效。**可改**

**验证：**
- `login-flow.mjs`（fixture agent 目录，不联网）：
  - provider 列表来自 pi（42 个），openai 有两种登录方式；
  - API key 以 secret 提问出现，答完后 pi 写入 `auth.json`，列表只显示类型；登录后重新广播模型目录；密钥从未出现在任何发往页面的消息里；
  - 在提问处取消，什么都不存；
  - Anthropic OAuth 的选择题、`https://claude.ai/oauth/authorize…` 链接都送到了页面，取消后不留凭据；
  - 登出后凭据被删。
- `session-lock.mjs`：
  - 扩展本身：登记、切换、退出时释放；网页在写时先问，可选退出或仍然打开；在 bridge 的子进程里不生效。
  - bridge 一侧：显示「终端占用」、拒绝接管并给出原因、登记撤掉后可以接管、清掉死 pid 的登记；安装 / 移除只动 `extensions`。
  - 另外用真 pi（rpc 模式）加载扩展核对过：登记文件随进程出现、退出后消失。
- `pi-cli.mjs`（真 pi CLI，fixture 目录）：
  - argv 的组装与拒绝、`pi list` 的解析；
  - 本地包的安装（输出实时转发）、列出、按绝对路径卸载；
  - MCP 服务器的添加、列出（失败状态和错误都在）、删除；
  - 非法请求在任何东西运行之前就被拒绝。
- 真 Chromium：
  - 登录：DeepSeek API key 输入框是 password 类型，提交后 `auth.json` 写入，列表显示「已登录（auth.json · API key）」；
  - 会话锁：安装后显示安装路径；
  - 扩展与 MCP：失败的 MCP 服务器显示错误，安装本地包后控制台显示「Installed …」，并出现在列表里。

## D80 `/share` 与 `/bug` 用 pi 导出的现成函数在 bridge 里拼出来，读会话文件、不写（#38）

**决定：**
1. **`/share`**：照 pi `session-share.js` 的顺序。
   - 先读 `sessionShareDestination`：项目设置优先，其次全局，默认 `auto`。
   - 不是 `gist` 时，如果登录了 Radius，就把 pi 的 `serializeSessionBranch` 产出的 JSONL POST 到 `<Radius 网关>/v1/artifacts`（组织内可见），返回 `canonical_url`。设置要求 `radius` 但没登录 Radius 时，直接拒绝并说明。
   - 否则先 `gh auth status`，再用 `pi --export` 导出 HTML，然后 `gh gist create --public=false`，查看链接用 pi 的 `getShareViewerUrl(gistId)`。
   - 页面拿到链接后自动复制并在新标签页打开。
2. **`/bug`**：报告用 pi 的 `collectBugReportMetadata` / `collectBugReportDiagnostics`，设置的敏感字段已经去掉，不含 API key。
   - 模型取这个会话最后一条 assistant 消息里的 provider 和 model。
   - 可选附上会话记录（`serializeSessionBranch`）。
   - 「上传」走 pi 的 `uploadBugReport`；登录了 Radius 就带上 Radius token，没登录则匿名上传；离线时拒绝。「导出 zip」走 `writeBugReportArchive`，写到 `state/bug-reports/`，再由 `/api/bugzip`（只认 `pi-bug-report-*.zip` 这种文件名）让浏览器下载。
3. 两个弹层在发出前都把会带走的内容说清楚；都要 step-up。

**为什么：** pi 的这两个命令是 TUI 专用（对话框和运行中的 AgentSession 绑在一起），RPC 里没有。但真正决定「上传什么、传到哪」的那部分 pi 都导出了，直接复用就和终端行为一致。

**和终端的差别（因为 bridge 里没有运行中的会话对象）：**
- 分享和报告里附的会话记录**没有**结尾那条 `pi.share` 条目（系统提示词和工具 schema）。
- 报告不列出加载的扩展；也不提供「让模型写摘要」这个选项。
- 不往会话文件里追加「报过 bug」的记录（bridge 不写 pi 的会话文件）。

**验证：**
- `node bridge/tests/share-bug.mjs`（真 pi 模块，用 `PI_WEB_GH_JS` 替身代替 gh，离线）：
  - 没登录 Radius 时走私有 gist，链接是 `https://pi.dev/session/#<id>`，gh 收到的是 pi 的 HTML 导出；
  - gh 没登录时提示怎么修；设置要求 Radius 却没登录时拒绝；
  - 导出的 zip 里有 `report.json`（以及勾选时的 `session.jsonl`）；不附会话记录时 zip 里没有对话内容；
  - 离线时拒绝上传；`/api/bugzip` 不接受路径穿越，也需要登录。
- Radius 上传要联网、要账号，**未实测**，只做了代码对照。
- 真 Chromium：`/share` 打开新标签页 `https://pi.dev/session/#0123abcd`，聊天里出现链接；`/bug 描述` 会预填描述，导出 zip 后浏览器开始下载 `pi-bug-report-<id>.zip`。

## D81 扩展管理：输入框「扩展」按钮与设置页共用一套界面；商店用 npm（pi-package）和官方 MCP Registry

**决定**（来自 grill-me 的讨论，用户逐项确认）：
1. **入口**：输入框下「技能」旁边的「扩展」按钮打开弹窗；「pi 设置 → 扩展与 MCP」显示同一套内容，并带一个「在输入框下显示扩展按钮」开关。
   - 开关默认开，存在 bridge 的 `state/ui.json`，所以各设备一致。
   - 有可更新的条目时，按钮带数字角标：页面加载时向 bridge 要一次计数，bridge 缓存 6 小时，这一步不连接任何 MCP 服务器。
2. **已安装**分三类：
   - pi 包（版本取自包里的 `package.json`）；
   - 内置扩展和单独的扩展文件（`<agentDir>/extensions`、`<cwd>/.pi/extensions`、settings 里列出的路径）；
   - MCP 服务器及其工具（`pi mcp list --json`）。
3. **更新检查**：打开弹窗就联网检查。
   - npm 包：本地版本对比 npm 的 `latest`。
   - 没有固定 ref 的 git 包：`git ls-remote HEAD` 对比本地 HEAD。
   - 固定了版本的 npx / uvx MCP 服务器：对比 npm / PyPI 上的最新版。
   - 本地包、远程 MCP、固定了版本的包都不检查。
   - 只有确实有新版时才出现「更新」，另有「全部更新（N）」。包更新走 `pi update <来源>`；MCP 更新是改写 mcp.json 里那个固定的版本号。
4. **启停**：照 `pi config` 的写法，往 settings 的 `extensions` 里写 `-builtin:x` / `-<绝对路径>`；MCP 服务器在它自己的 mcp.json 里写 `enabled: false`。
   - 已用真 pi 验证：`-<绝对路径>` 能让 `extensions/` 下自动发现的扩展不加载；`-builtin:llama.cpp` 能去掉 `/llama`。
   - 只允许改 pi 的 mcp.json（全局，或某个项目的 `.pi/mcp.json`）。
5. **卸载 / 删除 MCP**：4 秒内再点一次才执行。改动之后弹窗顶部出现「重新加载当前会话」，其他运行中的会话不受影响。
6. **扩展商店**：npm 搜索 `keywords:pi-package`，和 pi.dev/packages 画廊同一个来源（画廊没有公开 API）。按月下载量排序，空搜索时显示前 10 / 20 / 50。已装的标「已安装」。
7. **MCP 商店**：官方 Registry 里状态为 active 的最新版本，按条目仓库的 GitHub star 排序。
   - 排行索引每天在后台建一次：几千个条目，本机约 2 分钟。有 gh 令牌时 star 走 GraphQL 批量查询；没有就匿名尽力查，并提示登录 gh。
   - 第一次还没有索引时，直接用 Registry 的搜索接口回答，不带 star。
   - npx、uvx、Docker、远程 HTTP 四种都能装：本机缺 uvx / Docker 时置灰并给出安装链接；SSE 远程不支持（pi 不支持这种传输）。
   - 安装表单：服务名可改、填必填变量 / header、选全局或项目；「高级」里有 exposure 和描述。
   - **密钥只以 `${变量}` 写进 mcp.json**，header 模板（`Bearer {token}`）保留原形，装完提示要设置哪些环境变量。
8. **其他**：默认装到全局，可选当前项目；公网隧道下扩展管理只读（包括原来的 picli 写操作）；联网查询走 pi 设置里的 `httpProxy`，没有则用 `HTTPS_PROXY`（bridge 自己实现了 CONNECT 隧道，没加依赖）。

**为什么：**
- 要在一个画面里完成扩展的「看、找、装、更、停」，而且和终端 pi 的行为一致：安装和卸载都走 pi 的 CLI，启停写 pi 认的那些条目。
- 热度数据只能来自真实信号：npm 下载量、GitHub star。Registry 自己没有热度字段。

**代价 / 可改：**
- 第一次建 MCP 排行索引要几分钟。
- 很多 Registry 条目没有仓库链接（抽样约 6 成没有），这些条目的 star 记为 0。
- MCP 的「已安装」标记靠包名或地址出现在命令里来判断，是近似的。**可改**

**验证：**
- `node bridge/tests/ext-manager.mjs`（真 pi CLI，fixture 目录）：
  - 商店条目转成 `pi mcp add` 的参数：四种运行方式、密钥变成变量、header 模板、缺必填项被拒；
  - 包和 MCP 服务器带版本，并查到了 MCP 的 npm 新版；
  - 内置扩展和单独扩展的启停写入与还原，其他设置不动；MCP 的停用和改版本；只允许改 mcp.json；
  - 商店安装产出的是带 `${变量}` 的远程服务器；按钮开关保存在 bridge；公网连接被拒、但能查看。
- 用真 pi 核对过 `-<路径>` 和 `-builtin:x` 的效果（`.scratch/excl-probe.mjs`）。
- 真 Chromium：
  - 按钮显示角标 1；弹窗三个标签；已安装页列出内置、单独的扩展和 MCP（含可更新提示）；
  - 扩展商店前 20 按月下载量排（billion-context 265 万、pi-mcp-adapter 136 万…），搜索 subagent 有结果；
  - MCP 商店前 20 按 star 排（browser-use ★119,890…），安装表单可以选运行方式；
  - 在设置里关掉开关后，按钮消失。
## D90 `ask_user_question` 整份问卷一次给网页，逐题对话框由桥回填

**问题：** 网页上问卷只能一题一题答、答了回不去，每题还各推一次通知。D47 的 `/api/ask` 旁路靠全局 `question.ts` / `questionnaire.ts`，这两个扩展已经不在了；现在的提问工具是 `@juicesharp/rpiv-ask-user-question`，它在 rpc 下走 `rpc-fallback.ts`：每题一个 `ui.select`（多选题是 `ui.input`），桥的 `askViaDialog()` 把每个对话框包成一份单题 ask，单题点选即答。它自带的外部作答通道（`rpiv:ask-user:answer`）对 rpc 宿主回 `unsupported_host`，走不通。

**决定：** 桥在 `tool_execution_start`（`toolName === "ask_user_question"`）就拿到整份问卷参数，立刻发一份多题 ask（复用 tab + 提交 + 可回改的面板，多选题打勾）。之后到来的对话框按标题认题（`[header] question`，去空白比前缀，`bridge/src/questionnaire.ts`），按答案回填：单选发对话框里那一行原文，自己写的发原文；多选发 `1,3` 加可选的 `; 文字`。认不出的对话框照旧单独问；工具结束（`tool_execution_end`）时还挂着的 ask 撤掉。

**为什么不改 npm 包：** 包一升级就被覆盖；回填只依赖它公开的回复解析（序号 / 原行 / 任意文字算自写），对不上时退回原来的逐题模式，代价可接受。

**验证：** `bridge/tests/questionnaire-unit.mjs`（需先 `npm run build:bridge`，Node 26 不再支持 `--experimental-transform-types`，可把 `../src/*.ts` 换成 `../dist/*.js` 跑）；真 Chromium + 真模型探针 `.scratch/q-probe.mjs`。

## D91 页面在前台时不发通知；「pi 设置 → 通知」总开关

**问题：** Windows 右下角的「需要你回答」通知（Web Push，`via Microsoft Edge`）在用户正看着页面时也弹，且一份问卷每题一条。

**决定：**
- 页面在 `focus` / `blur` / `visibilitychange` 和连上时发 `{type:"presence", active}`（`visible && document.hasFocus()`）；桥只要有一个连接 `active` 就不推 Web Push、也不发微信。
- `sw.js` 收到推送时再查一次：有 `focused && visible` 的窗口就不弹（Chromium 在有聚焦窗口时不强制显示）。测试通知带 `force`，照弹。
- 总开关存 `state/notify.json`，`/api/me` 带 `notify`，WS `notify.set`（要 step-up）后广播 `notify`。开关放在「pi 设置」新的「通知」页，同页有「开启 Web Push」「发测试通知」。
- 输入框占位文字统一由 `composerPlaceholder()` 给出（空闲 / 运行中 / 问卷三种都写 Shift+Enter 换行），不再被 `renderAsks()` 覆盖成光秃秃的「说点什么…」。

## D92 终端搬到顶栏、浮成 dialog；最小化只是收起视图

**问题：** 终端原来是从右栏（需要你 → 终端）那颗「打开终端」领出来的、对话栏底部的 dock（D70）。它占的是对话栏的宽度（所以打开前还要先把右栏折叠掉，Q-026），和「本会话的产物」这类每个会话都要用的入口也不在同一条路上；更要紧的是「关掉它」和「结束那个 shell」在语义上混着——`关闭`/最后一条 `×` 会真的 kill 进程。

**决定：**
- 入口只有一个：顶栏 `>_ 终端`，紧挨着 `📂 产物`。右栏那一节（标题 + 按钮 + 提示）整段删掉。
- 终端是**浮在页面上的 dialog**（`position: fixed`，挂进 `#app` 跟着外观缩放；z-index 45 —— 在顶栏 20 与输入框浮层 40 之上，比口令 modal 50、文件预览 55、底部 sheet 60 低，那些东西该盖住终端），不再是对话栏里的一行；因此 Q-026 的「打开终端先折叠右栏」一并作废。
- `－` = **最小化**：只把 dialog `hidden`，标签、xterm、桥里的进程都不动；顶栏按钮亮起并写数量（`>_ 终端 2`）。只有标签上的 `×` / `关闭` 才 `term.close`。
- 刷新 / 重连不自动弹窗：`term.list` 接管回来的标签先挂在收起态，按钮上有数量，点一下回到同一个进程（桥 `term.replay` 全量回放）。
- 收起后再打开要重新 `fit()`：xterm 在 `display:none` 的容器里量不出尺寸，所以 `showTermDock()` 里补一次 fit + focus；反过来，接管 shell 时 dialog 必须短暂可见才挂 xterm（同一个任务里立刻藏回去，不会闪），否则挂上去的是 0 宽字符。

**为什么：** 终端是「这台电脑」的东西，不是「这个会话」的东西——它不该占对话栏的宽度，也不该和右栏的审批队列抢位置；跟产物并排才符合「随时要用、用完就收」的节奏。把「收起」和「结束」分开，是因为用户对「缩小到一个按钮」的预期就是后台还在跑（和对 ssh 会话、对编辑器的预期一致），一旦收起就 kill，等于逼人不敢收。**可改**：按钮文案/图标（`>_ 终端`）与默认尺寸（D93 起改为按窗口算：桌面 `46vh` / `min(1080, vw−32)`，窄屏贴两侧）都是默认值。

**验证：** `probes/term-dialog.mjs`（真桥 + 真 pty + Chromium）：顶栏 `[data-act]` 顺序 = 产物 → 终端 → 文件管理器；右栏不再有终端入口；`－` 之后标签还在、按钮亮、收起期间从另一个 WS 打进去的 `echo` 仍然被同一台 pty 回显、再打开看到同一条 `data-id` 和那段输出；刷新后不自动弹窗但能接管同一个 shell；`×` 之后 dialog 收走、按钮恢复原样；高度抓取带拖动 / 双击复位仍然有效。

## D93 终端 dialog 能拖走、能拖大小；几何一律记「布局 px」

**问题：** D92 之后那个 dialog 只有顶边一条抓取带（只改高度，Q-026 的老手势），位置永远钉在页面底部居中——它挡住什么就只能忍着（输入框上方的排队条、工具卡）。另外 CSS 里的 `vw`/`vh` 在 `#app { zoom }` 下会被再乘一次：UI 缩放 1.25 时 `width: min(1080px, 100vw − 32px)` 渲染出来是 1350px，dialog 直接溢出屏幕右边界（实测过，不是推测）。

**决定：**
- **移动**：标题栏空白处按住拖动整个 dialog（标签、`＋`、`管理员`/`－`/`关闭` 照旧可点，只有空白处是拖动区）；双击标题栏 = 位置 + 大小一起忘掉。
- **缩放**：右下角一只 18px 的角同时改宽高（左上角不动）；顶边那条抓取带仍然只改高度（底边钉住）。双击任一条抓取带同样复原。
- **几何一律用「布局 px」**（`#app` 的 zoom 之前的值）：指针位移先除以 `prefs.scale` 再写进 `style`，所以界面缩放多少都是 1:1 跟手（1.25 下拖 100px 就是 100px，不是 125px）。
- 存 `pi.termGeom` = `{l,t,w,h}`；老的 `pi.termH`（只有高度）只在没有新键时读一次。位置存了就 `left/top` 钉住（脱离 CSS 的底部居中），没存就还是默认位置。
- 拖拽 / 缩放都夹在视口内；窄屏下底边额外让开 56px 给下方三标签——pinned 之后 CSS 的 `bottom` 不再管用，所以这条夹取必须做在 JS 里。
- 宽度 / 高度的默认值改由 JS 按窗口算好写进 `style`（CSS 里那两行 `vh`/`vw` 只当 JS 未跑时的兜底），因此 UI 放大后 dialog 仍整块在屏幕内。

**为什么：** 一个浮层最要紧的两件事是「挡住的东西能挪开」和「内容多了能变大」，只有高度可调等于只解决了一半。而几何必须有一套**统一的单位**：CSS 的 `vh/vw`、`getBoundingClientRect()` 的视觉 px、`style.left` 的布局 px 是三个不同的空间，混着用就会出现「拖一点跑很远」和「放大后溢出」这类看着像玄学的问题——所以这里全部换算到布局 px 再落盘，存盘的值与缩放无关。**可改**：最小尺寸 320×140、右下角角标 18px、拖动区域是否覆盖整个标题栏，都是默认值。

**验证：** `probes/term-dialog.mjs` 新增：顶边抓取带改高度并写入 `pi.termGeom.h`、双击清空并回默认高度；拖标题栏位移与指针 1:1 且大小不变、`l/t` 落盘；右下角缩小 300×100 时宽高同时变而左上角不动、`w/h` 落盘；刷新后 dialog 回到存档的同一位置与大小；视口缩到 390×820 后仍不越界且压在底部三标签上方。另有一次性的 `#app zoom 1.25` 检查（`.scratch/zoom-term.mjs`，不入库）：dialog 整块在 1280×860 视野内，拖动 +100/−100 与缩放 −200/−150 都 1:1。

## D94 滚轮上滚被拽回底部：恢复跟流只认「视口在往下走」，滚轮 / 方向键上翻后再挡 300ms

**症状**：桌面上回复流式输出时，鼠标往上滚，有时滚不上去，视口上下抖动。

**根因**：D54 / D68 的状态机里，`wheel` 向上会同步 `stopFollowing()`，但 `scroll` 事件中只要 `nearBottom()`（gap ≤ 24）就 `resumeFollowing()`。触控板 / 高精度鼠标每个事件只移动几像素，Chrome 的平滑滚动也把一格分成几帧动画，所以手势开头的几个 `scroll` 事件仍在 24px 以内 → 跟流被立刻打开 → 下一段 `delta` 的 rAF 执行 `scrollTop = scrollHeight`，把视口拉回底部，还会打断正在进行的平滑动画。D68 只为触摸加了 `touching` 保护，滚轮和键盘没有。

**决定**（`web/src/chat.ts`）：
1. `scroll` 处理器记录 `lastTop`，只有 `scrollTop >= lastTop`（视口向下移动或不动）且 `nearBottom()` 时才 `resumeFollowing()`。
2. `wheel` 向上 / `PageUp` / `ArrowUp` / `Home` 改走 `holdUp()`：`stopFollowing()` 之外再把 `holdFollow` 推到 `now + 300ms`（取 max，不缩短 `jumpToTurn` 的 900ms），盖住平滑动画的剩余帧。

**为什么现在可以看方向**：D68 担心程序化滚动也会触发 `scroll`。但程序化滚动只发生在已经跟流时（或 `follow()` 主动打开），方向一定向下，不会误判。内容变短导致 `scrollTop` 被钳制时方向向上，不会把跟流打开，这正是想要的结果。

**验证**：`node probes/scroll-race.mjs` 新增 `wheel-tiny`（真实 `mouse.wheel` −4px × 20）和 `wheel-smooth1..3`（一次 wheel 事件 + 4 帧各上移 5px，模拟 Chrome 平滑动画；无头 Chrome 不播放滚轮动画）。断言：离开底部后，手势期间和之后 1 秒内 gap 不再回到 ≤ 2。改前两次运行都 FAIL（`wheel-tiny` 的 gap 轨迹为 `51,4,0,4,55,4,…` 共 8 次回弹；`wheel-smooth` 有时有 7 次回弹）；改后连续三次全部 PASS，原有触摸和「回到底部恢复跟流」断言也保持 PASS。

## D101 记录（🐞 bug）住在顶栏、落在状态目录，一个 dialog 收四类随手记

**问题：** 用这个页面时，bug、要改的地方、想法、杂事都只能「先记在别处」——聊天里说完就沉了，而且这些事大多不是当前会话的事（换会话、甚至还没开会话时也会想到）。已有一个 `/bug`（D80），但它是**把报告发给 pi 的开发者**：跟会话绑定、要上传 / 打包，用来记「我自己待会儿要处理的」完全不对路。

**决定：**
- 入口是顶栏一颗 `🐞 bug`（`data-act="notes"`，插在 `📁 文件管理器` 与 `Aa` 之间），**常显**：跟终端一样不随 `currentId` 隐藏——记录不属于任何会话。有未处理时按钮上带数量（`🐞 bug 3`）。
- 面板是 dialog（`.sheet.notes-sheet`，桌面 `min(1000px,100%)`、高 `min(620px,78vh)`）：左边列表 + 右边常驻编辑器（样张 A）。新建是列表顶部 `＋ 记一条`；打开面板光标直接落进那一格。
- 四类固定枚举：`bug` / `change` / `idea` / `chore`，默认 `bug`；tab 上带待处理计数。默认只看 `pending`，一个「显示已处理」开关翻出 `done` / `dropped`。
- 三档录入（`quick` / `form` / `long`）= 同一个编辑器的三副样子：`quick` 一行、Enter 存（Shift+Enter 换行）；`form` 多两栏加高；`long` 等宽、给日志栈。存下之后正文还能改、图能加能删。
- 截图只从用户手上进来：Ctrl+V 粘贴 / 拖进编辑器 / `＋ 图` 选文件。粘贴的图先以 data URL 挂在 `pendingShots`，**随条目的「保存」一起**上传——不然一条还没存下的记录会在磁盘上先长出一个目录。
- 存储：`stateDir()/notes/bug-notes.json` + `notes/assets/<id>/shot-<n>.<ext>`。图不塞 JSON：base64 会让文件在几十张图后变成几 MB，而列表每次都要整读。截图记**绝对路径**，因为「交给 agent」时它要能直接读。
- 每条字段：`id / kind / status / mode / title / body / shots / sessionId / sessionName / issue / commit / createdAt / updatedAt`。会话只是**静默记下**（列表不显示），标题为空时取正文首行 60 字。写操作不做 step-up、隧道不拦：登录进来的就是本人，记录也不进 pi 的会话文件。
- 枚举值一律校验后拒绝（`不认识的 kind：wat`），不静默退回默认值——打错一个字会把「想法」悄悄记成 bug。
- 出口三个，都在记录上：**复制 Markdown**（单条）· **导出全部**（当前 tab + 当前筛选）· **交给 agent**（菜单两选一：预填到当前会话的输入框；或新开会话、建好后填进那个会话）。两个都**不自动发送**。
- 状态 / issue / commit 是**立刻落盘**的（`notes.status`），不跟正文的「保存」一批——所以它们不会让 `dirty` 拦住「交给 agent」。

**为什么不做「一键建 GitHub issue」：** `gh` 要走代理、还要登录态，失败路径比功能本身长（D80 的教训）；本期只留 `issue` 号字段，用户把号粘进来即可。**为什么不做自动抓屏：** `getDisplayMedia` 要用户选源、服务端 puppeteer 要装浏览器，两个都比「Ctrl+V 贴一下」重，收益还只是省一次粘贴。

**可改：** 四类与 `quick/form/long` 三档的具体文案（`web/src/notesheet.ts` 顶部 `NOTE_KINDS` / `MODE_LABEL`）；单条最多 24 张、单图 20MB（`bridge/src/notes.ts` 的 `MAX_SHOTS` / `MAX_SHOT_BYTES`）；默认快捷键 `Ctrl+Shift+B`（`app.ts` 的 `DEFAULT_KEYS`）。想让「已处理」也立刻消失就把 `.notes-switch` 默认打勾，但那样就没有「回头看看处理了什么」的地方了。

**验证：** `node probes/bug-notes.mjs`（真桥、临时状态目录、纯 WS，24 条断言）：hello 带 `notes`、空标题取正文首行、同 id 是更新（`createdAt` 不变、`updatedAt` 前进）、`issue`/`commit` 落盘、错 status / 错 kind 被拒且状态不变、截图落到 `assets/<id>/` 且 `/api/image` 读得回 `image/png`、第二张换名不覆盖、删图只删自己那条、删记录连目录一起清、桥杀掉后 JSON 仍在。`node probes/bug-notes-ui.mjs`（真 Chromium + 隔离桥）：没开会话也能开、光标落在记一条、Enter 存一条、按钮带计数、真 paste 事件贴图并随保存落盘、缩略图回到编辑器、状态 pill 转已处理后从待处理消失、「显示已处理」翻回来、复制 Markdown 进剪贴板（含截图绝对路径）、交给 agent 菜单两项、Escape 先关菜单再关面板、刷新后记录还在。截图：`.scratch/bug-notes/shots/desktop.png`。

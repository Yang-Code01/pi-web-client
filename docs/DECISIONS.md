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
决定：网页里的每个会话是一个 `pi --mode rpc` 子进程；回收判据与内存上限见 **D120**（2026-11-04 由「空闲 2 小时」改为「完成 + 30 分钟无事件 + 2.5 GB 水位」），下次点开复活（同 session path）。
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
**已被 D155 推翻（2026-11-07）**：批准改为单击生效，卡上不再有任何二次确认；两段式当年也没按这里写的那样落地（实现是原生 `window.confirm`），理由见 D155。

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

> **D186 修订（2026-11-08）：** 窗口从 10 分钟放宽到 1 天（用户报「频繁让输口令」）；前端不再自带 9 分钟的近似钟。下文「10 分钟」的时长以 D186 为准，判据与只读降级的其余部分不变。

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
- **2026-11-08 修订（D184）**：启动参数加 `--protocol http2`（本机 QUIC 半死，见 D184），宽松兜底正则删掉。

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

> **D162 修订（2026-11）：** 「完成」不再随打开 / 订阅清除，也不再只对非当前会话显示 —— 它被持久化到 `state/finished.json`，桥重启、GC、换设备都保留，只有新一轮运行、发消息或终端续写会话文件才清。打开也不再刷新 `updatedAt`（取会话文件 mtime）。下文「不是当前打开的会话」与「清理由把快照交给客户端触发」两句已被 D162 取代；排序键、桥端算 `done` 的论证仍有效。

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

**#224 起（预备重构）：** 这份凭据不再只给「问用户」用，名字跟着改成中性的回环通道 —— env 是 `PI_WEB_LOOPBACK`（回环 origin，不是某个端点）+ `PI_WEB_LOOPBACK_TOKEN`，`Session.askToken` / `askUrl` → `loopbackToken` / `loopbackUrl`，`SessionManager.byAskToken` → `byLoopbackToken`。路由仍是 `/api/ask`；全局两个扩展同时认旧名 `PI_WEB_ASK`，旧桥起的会话不受影响。

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
决定：terminal 走 bridge 内置的 `node-pty`（`bridge/src/terminal.ts` 的 `Terminals`），不上第二套本地 service；每个会话最多同时 4 个，默认 shell 按 `pwsh` → `powershell.exe` → `cmd.exe` 逐级回退，cwd 取当前会话目录。安全边界三层：公网隧道请求一律拒（`publicReq`）、开终端必须过 `requireStepUp()`（二次口令，10 分钟；D186 起 1 天）、只接受 cookie 鉴权的 ws。`.ps1/.psm1/.cmd/.bat` 在文件浏览器里右键可「用 PowerShell 运行 / 以管理员身份运行」，提权一律 `Start-Process -Verb RunAs` 另开桌面窗口（当前终端不升级，也接管不了提权进程的输入）。
为什么：这个产品的用户就坐在跑 bridge 的那台机器上，需求是「一个能 `cd`、能跑交互式程序的窗口」，用一次性命令回显冒充终端会在第一个交互式程序上露馅。选内置而不是新 service，是因为新 service 要再解决一遍鉴权、保活、安装与开机自启，收益为零。提权只能新进程（Windows 没有别的路），所以干脆承认它：桌面窗口 + 应用内面板不假装自己是管理员。
**踩过的坑**：`spawn` 带 `detached: true` 在 Windows 是 `DETACHED_PROCESS`（无控制台），而 `Start-Process` 需要桌面会话 —— 结果是**静默成功但什么都不做**（退出码 0、脚本没跑）。去掉 `detached`、保留 `stdio: "ignore"` + `windowsHide` + `unref()` 才对。
**可改**：并发上限是 `MAX_TERMS`；默认 shell 顺序在 `whichPowerShell()`；想禁掉终端，删掉 ws 里 `term.*` 那几支即可，前端按钮会自然报「不支持」。

## D53 会话状态只在一处计算：`sessionBadge`

**决定**：`web/src/app.ts` 的 `sessionBadge(s, currentId)` 是「这个会话现在处于什么状态」的唯一实现，顺序 `待回答 > 待确认 > 终端占用 > 运行中 > 完成`；左栏卡、管理弹窗行、置顶 chip 都调它（D156 之后统一入口是 `App.badgeOf()`：先用 `shownSession()` 换掉当前会话那份计数，再调它）。

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
   - **D113 改了这一条**：不再等联网结果才出行。打开弹窗先显示上次的清单，桥再分三段推（本机已装的 → MCP 服务器状态 → 联网查到的版本），⟳ 只挂在版本那一栏上。
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
- 终端是**浮在页面上的 dialog**（`position: fixed`，挂进 `#app` 跟着外观缩放；z-index 45 —— 在顶栏 20 与输入框浮层 40 之上，比口令 modal 50、底部 sheet 60 低，那些东西该盖住终端；和文件预览的上下关系见 D111），不再是对话栏里的一行；因此 Q-026 的「打开终端先折叠右栏」一并作废。
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

## D95 链接标签的正则不许用嵌套量词：一行 tool 输出曾让会话打开即卡死

**决定**：`web/src/md.ts` 里 link label 的「一段普通字符」由贪心 `+` 改为逐字匹配——`(?:[^\[\]\n]+|\[[^\]\n]*\])+` → `(?:[^\[\]\n]|\[[^\]\n]*\])+`，`INLINE` 第 3 组和 `inlineInto` 里取 label 的那条正则各一处。接受的语法集合不变（`A+|B` 与 `A|B` 的 Kleene 闭包同语言），只去掉歧义。

**为什么**：`(x+|…)+` 对同一段标签文本有指数级的切分方式，而 md 是**一行一行**送进 `inlineInto` 的——只要某一行里有一段够长的 `[…]` 后面不是 `](`，引擎就得把所有切分试完才认输，主线程再也回不到事件循环，Chromium 就报「此页面没有响应」。实测：会话 `c24330ab…`（名字 `bug`）第 23 条 tool 结果里的一行 TypeScript（`… || [...this.termTabs…`）就够，旧正则在那行上 3 秒都不返回，页面永远画不出来。别的会话没卡只是没撞上这种长方括号行。user 消息走的是 `body.textContent = item.text`（纯文本，不过 renderMarkdown），所以当时怀疑的 `[Image: …]` 注释其实不触发——真正触发的是 tool 输出里的代码行。

**可改**：内层 40 字符时旧正则已 >3s、30 字符以内仍在毫秒级——这是事后测量，不是设计目标；将来放宽标签长度不必再动这条正则。

**验证**：把 `web/src/md.ts` 用 esbuild 打成 ESM，喂该会话全部 213 段 `text`/`result`/`command`：旧正则在前 61 条里就有 6 处单行不返回（第一处 item#23），新正则一趟跑完、0 停滞（同一段文本 2ms）。改后 headless 打开该会话 → 1.5s 内渲染 159 条消息；`npm --prefix web run build` 通过。
## D96 peer 是独立子进程：bridge `fork` 托管，崩了退避重启，端口被占不重启

（D95 是链接正则那条；这里是 #45 的第一篇。）

**决定**（`bridge/src/peer.ts` + `peer/src/index.ts`）：
1. `peer/` 是独立进程，自己绑 `0.0.0.0:7865`；bridge 用 `child_process.fork` 起它，stdout/stderr 逐行转进 bridge 日志（`[peer]` 前缀）。
2. 非 0 退出按 1s → 2s → 4s 重启，第 4 次还死就停手并在页面显示「连续退出 N 次」。
3. 退出码 **2** 表示 peer 自己判定端口被占（`EADDRINUSE`）：不重启，只报「另一份 peer 在跑」。
4. `PI_PEER=0` 时整块不启用；`peer/dist` 不存在时报「还没构建」而不是崩。

**为什么**：peer 要能被局域网访问（绑 `0.0.0.0`），而 bridge 默认只绑回环；两者生命周期也不同——peer 崩了 bridge 必须活着，否则页面连自己为什么看不到在线列表都不知道。端口冲突是唯一「重试也没用」的失败，所以用退出码把它和「偶发崩溃」分开，避免无限重启刷日志。

**可改**：重启次数（3）与退避基数（1s）。

**验证**：`node bridge/tests/peer-e2e.mjs` 的「端口被占时退出码 2」；手动 `kill` 掉 peer 进程后 bridge 日志出现 `[peer] ... 收到 SIGTERM` 与重启记录，页面 `/api/peer` 的 `running` 相应变 false 再变 true。

## D97 页面只跟 bridge 说话，peer 的 `/status` 只认回环

**决定**：`peer.html` 只请求 `127.0.0.1:7864` 的 `/api/peer`（cookie 认证）；peer 的 `/status`、`/peer/add`、`/peer/refresh` 一律拒绝非回环的来源（403）。对局域网开放的只有协议面：`/peer/hello`，以及第 2 片起的 `/peer/inbox`。

**为什么**：cookie、CORS、隧道只在一处（bridge）；而且 `/status` 带的是本机配置（收件箱路径、隐身开关），不该让同网段的人随便读。

**验证**：`node bridge/tests/peer-e2e.mjs` 只走回环；非回环路径靠 `http.ts` 的 `isLoopback()` 拒掉——从另一台机器 `curl http://<ip>:7865/status` 应得 403（真机验收项）。

## D98 「当场确认」走 HTTP `/peer/hello`，不走 UDP 回包

**症状**：两台机器能互见，但要等下一轮 announce（最多 10 秒）；手动填了地址却要等半天才有反应。

**根因**：announce 是发到组播端口（7866）的，回给对端也只能打到它的发现端口——而对方要的确认信息（nickname / http 端口）必须进它的状态表，走 HTTP 才有确定性。

**决定**（`peer/src/discovery.ts`）：收到 unknown / 换了 IP 的 `hello` 时，单播 `POST /peer/hello` 到对方的 HTTP 口（announce 里带着端口），同一个 `nodeId` 10 秒内只回一次；手动地址也走这条。

**为什么**：组播被交换机挡住时，这条路是唯一能在秒级把对方拉进列表的通道（也让「手动地址」真的可用，而不是「等十秒看看」）。

**验证**：`node bridge/tests/peer-e2e.mjs` 的手动地址段——A 不广播给 C（不同组播端口），`POST /peer/add` 后 8 秒内 A、C 双向可见。

## D99 隐身 = 不广播、不回 hello，只被动记录

**决定**：`hidden` 打开时 peer 不发 announce、不响应 `/peer/hello`（回 `{hidden:true}`），但仍然接收并记录别人——所以隐身的人看得见别人，别人看不见他。

**为什么**：如果用「照常收发但把自己标记成隐藏」来实现，任何一台机器只要抓到一个包就知道你在线，隐身就成了自欺。反过来「彻底断网」又会让隐身的人失去一切信息。

**可改**：是否允许「手动填了地址的人也能看见隐身的我」（真机验收时再定，见 #45 已知限制）。

**验证**：`peer/src/discovery.ts` 的 `packet`/`sendHello` 早退分支；e2e 里 C 与 A/B 的隔离段用的是「不同组播端口」，隐身分支暂由代码路径 + 真机验收覆盖。

## D100 第二张页面 `peer.html`：vite 多入口，`/peer` 由 bridge 显式映射

**决定**：
1. `web/vite.config.ts` 的 `build.rollupOptions.input` 加 `peer: peer.html`，产物落在 `web/dist/peer.html`。
2. `bridge/src/index.ts` 的 `serveStatic()` 把 `/peer`、`/peer/` 改写成 `/peer.html`，其余未知路径仍旧回落 `index.html`（SPA 的登录页要靠它）。
3. 页面数据 5 秒轮询 `/api/peer`（第 1 片不另开 WS）。

**为什么**：局域网界面和聊天界面是两种东西（一块是「谁在」+ 传输，一块是会话流），塞进同一个 SPA 会让路由和状态互相污染；而 vite 的多入口是零配置代价的隔离。`/peer` 这条映射必须显式写，否则新页面会被 SPA 兜底吞掉，打开的是聊天界面。

**验证**：`npm run build` 后 `web/dist/peer.html` 存在；`curl -H 'cookie: …' http://127.0.0.1:7864/peer` 返回的 HTML 里含 `<title>局域网 · pi</title>` 与 peer 的 bundle；截图见 `.scratch/peer/online.png`（在线列表里有一台对端）。


## D102 消息与回执都只追加：回执是新的一行，过期判断靠「最近 2000 条 id」

**症状**：一条消息发出后想显示「已送达」，最自然的写法是把那行 JSONL 改一遍（把 `status: sent` 改成 `delivered`）；一旦中途断电，文件里就留半行坏 JSON，而且第 3 片的好友请求、第 4 片的文件卡都会各自再改一遍同一行。

**根因**：追加写只要 `appendFileSync` 一次系统调用，是「要么整行进去、要么没进去」；原地改要先读全文、定位行、重写整个文件，中间任何一次崩溃都留下截断的文件——而历史是只增不减的，文件只会越来越大。

**决定**（`peer/src/history.ts`）：
1. 每段对话一个 `<nodeId>.jsonl`，一行一条 `{id, at, from, to:{kind,id}, kind, text?, ack?}`；`kind` 只有 `text` / `receipt`（v1.1 再加 group 系）。
2. 送达 = 追加一条 `kind:"receipt"`、`ack:{id, status:"delivered"|"failed", error?}` 的新行，原来那条文本一个字节都不动。
3. 补投查重不另建状态文件：读该对话最近 2000 条的 `id` 做集合（`recentIds()`），命中就不写。
4. 读取只读尾巴 512 KB，切掉可能截断的第一行；坏行跳过而不是整份报废。

**为什么**：回执、好友请求、文件卡都在复用同一份历史，append-only 让它们互不干扰；查重用「读尾巴」而不是「写索引」，省掉一个会在崩溃时和 JSONL 不一致的旁路状态。

**可改**：查重窗口 2000 条、尾巴 512 KB 都是拍的数字；对话过万条后要换成「按 offset 的 ring index」，不是现在。

**验证**：`node bridge/tests/peer-e2e.mjs` 的「同一条消息只存一次（dedupe）」把收到的 `entry` 原样重投一次，回 `{dup:true}` 且历史里仍只有一行；「送达回执」段断言 A 侧出现 `kind:"receipt"` 且 `ack.status==="delivered"`。

## D103 来源对不上先握手再说：409 可重试，而不是判「伪造」

**症状**：一个还没被学到（组播被交换机挡住）或刚换了网卡的对端发来消息时，按「来源 IP 不在 nodeId 的 IP 集合里就拒」的字面实现，会把正常消息全部拒掉——对方重试也没用，因为两边都没机会交换新地址。

**根因**：`from` 里自报的 nodeId 只能证明「他想让我以为他是谁」；来源 IP 才是唯一可信的一半，但 IP 本身是会变的（DHCP、多网卡、VPN）。判定「伪造」需要的是「这个人不可能在这个 IP 上」，而单次不匹配不构成这个结论。

**决定**（`peer/src/messages.ts` 的 `verifySource()`）：
1. 不认识的 nodeId → 立刻单播一次 `/peer/hello`（让对端把当前地址报上来），同时回 **409 + `retryable: true`**；
2. 认识但 IP 不在集合里 → 也先握手一次，再查；还是不在才 409 可重试，并记一行「来源 IP 漂移」；
3. 判「不可重试」的只有一种情况：`proto` 不匹配（400）或压根不是合法消息（400）。
4. 文本超过 32 KB 直接 413 且 `retryable:false`——重试一万次也还是太长。

**为什么**：把「可能是漂移」和「确定是伪造」分开以后，outbox 的 24 小时补投才有意义（只有真·伪造会被立刻丢掉）；而 `retryable` 让 4xx 也承载「以后还可以试」的语义，不用把这类失败伪装成 5xx。

**可改**：IP 集合留 5 分钟；真出现「同网段有人拿别人的 nodeId 发消息」时，下一步是签名（issue 里明确没做）。

**验证**：`node bridge/tests/peer-e2e.mjs` 的「不认识的 from 拿不到写入（409 可重试）」段：伪造一个陌生 nodeId 直接 POST `/peer/inbox`，断言 409 且 `retryable === true`，历史里没多出任何一行；正常两实例之间（同机，源 IP 在集合里）文字照常送达。

## D104 好友请求也走 `/peer/inbox`：一条通道，不新开协议

**症状**：第 3 片要发「加好友」「接受」两种短消息。最省事的写法是另开 `POST /peer/friend` 直连对端——但那样就得重新实现补投、去重、来源校验、24 小时过期这一整套，而这些在第 2 片刚刚做完。

**根因**：好友请求和文字消息在传输层没有任何区别：都是一次「我对你说句话」，都可能因为对方离线、IP 漂移、组播被挡而要重试。

**决定**（`peer/src/messages.ts` 的 `sendControl()` / `accept()`）：
1. 新的信封是 `{proto, kind:"friend-request"|"friend-accept", control:{id, at, from}}`，与 `kind:"text"` 共用 `/peer/inbox`、`Outbox`、`verifySource()`；
2. `Outbox.Queued` 从「塞一条 `entry`」改成「`kind` + `payload`」，`text` 的 payload 就是那条 Entry，控制消息的就是 control 体；老 `outbox.json` 读进来按 `kind:"text"` 迁移；
3. 只有 `kind === "text"` 在 `settled` 里追加回执行——好友请求没有「已送达」这个概念，它的进度就是通讯录里的状态；
4. 关系状态落在 `~/.pi-peer/peers.json`（`nodeId → {friend, favorite, incoming, outgoing}`），控制消息不改历史 JSONL。

**为什么**：省掉的不是一百行代码，是「另一条路上没有 IP 校验」这个洞——第 4 片的文件写入本来就要靠好友关系把关，门上的锁必须和消息走同一道验证。

**可改**：「不理」目前只删本地 `incoming`，不通知对方（对方会一直显示「已发请求」）；真需要「拒绝」再发一条 `friend-reject` 控制消息，信封已经现成。

**验证**：`node bridge/tests/peer-e2e.mjs` 的「好友请求到达对端（待接受）」「接受后两边都是好友（outgoing / incoming 都清掉）」「收藏只在本机生效」三段。

## D105 「接受」要求对方在线，否则按钮直接说等一会儿

**症状**：好友请求存在本地，接受时如果对端已经下线，`friend-accept` 进 outbox 也能补投——但对方那份 `outgoing` 会一直挂着，界面显示「已发请求」，直到他 24 小时内再上线。

**根因**：接受这个动作必须有回执才完整（双向确认），而回执只能送到在线的对端。

**决定**（`peer/src/http.ts` 的 `/friend`）：`action:"accept"` 在 `discovery.byId(peerId)` 为空时直接 400「他不在线，等他在线再接受」，不写自己这边的状态、也不排队。请求（`request`）则相反：必须能立刻发出，否则用户点了没反应。

**为什么**：宁可让按钮说「等一会儿」，也不要造出一个「我这边是好友、他那边还挂着请求」的分叉状态——分叉之后没有任何地方会自动收敛。

**可改**：真要支持离线接受，得给 `friend-accept` 加一次幂等重放 + 对方上线时主动 `friend-request` 复述；v1 不做。

**验证**：`node bridge/tests/peer-e2e.mjs` 的「接受后两边都是好友」段（B 接受时 A 在线，两边 `friend` 同时为真）；人工验证：把对端杀掉后点「接受」→ 页面报「他不在线，等他在线再接受」。

## D106 文件只认收方发的 token：`begin` 验好友、分块写盘、`end` 核哈希

**症状**：第 2 片只做了文字。用户第一次真正想用的是「发个截图 / 发个文件」，而文字通道跑通只证明了「能连上」，没有证明「不可信的来源写不进我的盘」。

**根因**：如果收文件复用一个「`from` 说得对就收」的入口，那么伪造 `from` 的人可以往你指定的盘里写任意大小、任意后缀的文件——文字伪造只是刷屏，文件伪造是写盘，后者不可撤销。

**决定**（`peer/src/files.ts` + `peer/src/http.ts`）：
1. 收方先 `POST /peer/file/begin` 验三件事：来源（复用 `messages.verify` 的 IP 集合）、**是好友**（决定 9）、收件盘余量（`fs.statfsSync`，留 5 GB 且留 10%）。三关都过才生成 token，`.part` 文件在收件目录里。
2. 分块 `POST /peer/file/chunk?token=&offset=` 要求 `offset` 正好接上已收字节数（错位回 409 并带上真实 offset，天然支持续传）；token 每收到一块就把 60 秒有效期往后推（决定 24）——固定 60 秒会和 2 GB 文件、和续传同时打架。
3. `end` 核大小 + 核 sha256，对上了才从 `<token>.part` 改名为最终文件（重名加 ` (2)`），往历史里追加**一行** `kind:"file"` 卡片。对不上就丢弃并回不可重试。
4. 发送方只把**路径**交给 peer（页面、peer 同机），由 peer 自己读盘算哈希；剪贴板截图没有路径，走 `/files/upload` 把字节递过来（上限 64 MB）。
5. 收件目录里「哪个 id 对应哪个文件」记在 `statePath("files.json")`，`GET /files?id=` 只认这个索引——不接受任意路径，避免把 `/files` 变成一个能读全盘的回环接口。

**为什么**：token 的意义不是加密，而是**把「谁可以写盘」这件事收敛到一个收方亲自签发的短期凭据上**。伪造者连 `begin` 都过不去，后面两条路由对他就是死路；而正常路径上 token 又不会因为文件大、网慢而失效。

**可改**：token 目前只存内存，peer 重启后未完成的传输作废（对方重新 `begin` 会拿到新 token 并从 0 开始，因为 `.part` 名字是旧 token）。真要做跨重启续传，得把 token 落盘并让 `.part` 名与 messageId 绑定。

**验证**：`node bridge/tests/peer-e2e.mjs` 的「非好友发文件被拒（403）」「文件送到对端（3072 KB，哈希一致）」「落盘内容逐字节一致」「同一文件只留一张卡片」「没有 token 写不进盘（410）」五段；人工：在本机测试环境点「📎」选 `docs/shots/peer-online.png` 发给自己那台，对端出现图片气泡。

## D107 agent 发局域网的文字：三个工具挂在门禁扩展里，直连 peer 回环，消息带 `via:"pi"`

**症状**：#45 的价值锚点是「agent 在链路里」——人能发消息、agent 能读能发，但对端分不清「这句话是人打的还是 agent 打的」；而且 pi 的会话是子进程，没有 cookie，也没有理由让它绕 bridge。

**根因**：① 工具的注册面只有 pi 扩展（`bridge/ext/approval-gate.ts`，与 #40 的门禁同一个文件），bridge 的 HTTP 路由不是 pi 的工具注册点；② 会话子进程继承 bridge 的环境，因此 `PI_PEER_PORT` 可由 bridge 在 `main()` 里写进 `process.env` 再被 `rpc.ts:57` 的 `{...process.env, ...opts.env}` 带下去；③ 人对「这条是 agent 说的」有真实需求（群里开口的是人还是机器，决定你信不信）。

**决定**：三个工具 `peer_find(query?)` / `peer_history(peer, limit)` / `peer_send(peer, text)` 注册在 `bridge/ext/approval-gate.ts` 内，直接 `fetch http://127.0.0.1:${PI_PEER_PORT}/tools/find|/messages|/send`，不经过 bridge；`peer_send` 发出的 entry 带 `via:"pi"`，对端与自己的气泡上都显示「🤖 agent 代发」；门禁侧把 `peer_find`/`peer_history` 加进只读白名单，`peer_send` 单列 `PEER_SEND` 集合——**只读模式仍然拦**（它会碰到别人），**严格模式放行**（决定 33：文字不设审批，文件才设）。

**为什么**：走回环而不是 bridge，是因为 peer 的三个接口本来就只认回环（决定 2），pi 子进程就在本机，少一跳少一处鉴权分叉；`via` 放在 entry 上而不是 UI 推导，是因为接收方也要看到（消息体是唯一的真相来源，本地推断在对端不成立）；严格模式放行 `peer_send` 而不放行全部，是因为「发文字」正是这个功能存在的理由，拦了就等于把它关掉。

**验证**：`node bridge/tests/peer-e2e.mjs` 19 段全过，其中「/tools/find 能按昵称找到人（带在线/好友）」「agent 代发的消息带 via=pi（对端徽章）」两段直击本决定；扩展用假 `pi` 对象跑注册，三个工具名齐全，`peer_find` 对真实 peer 返回「找到 2 个人」，`peer_send` 对不存在的 nodeId 报「这个人已经不在线了」（业务错误不再被包成「连不上 peer」）。

## D108 记录（🐞 bug）住在顶栏、落在状态目录，一个 dialog 收四类随手记

**问题：** 用这个页面时，bug、要改的地方、想法、杂事都只能「先记在别处」——聊天里说完就沉了，而且这些事大多不是当前会话的事（换会话、甚至还没开会话时也会想到）。已有一个 `/bug`（D80），但它是**把报告发给 pi 的开发者**：跟会话绑定、要上传 / 打包，用来记「我自己待会儿要处理的」完全不对路。

**决定：**
- 入口是顶栏一颗 `🐞 bug`（`data-act="notes"`，插在 `📁 文件管理器` 与 `Aa` 之间），**常显**：跟终端一样不随 `currentId` 隐藏——记录不属于任何会话。**只有图标**，数量进 `title`（`记录：3 条待处理（Ctrl+Shift+B）`）：顶栏已经在 620px 处挤过一次（D108 之后那条 `fix(notes)` 提交就是它翻车的现场），再挂一串小字等于把问题还回去。
- 面板是 dialog（`.sheet.notes-sheet`，桌面 `min(1000px,100%)`、高 `min(620px,78vh)`）：左边列表 + 右边常驻编辑器（样张 A）。新建是列表顶部 `＋ 记一条`；打开面板光标直接落进那一格。
- 四类固定枚举：`bug` / `change` / `idea` / `chore`，默认 `bug`；tab 上带待处理计数。默认只看 `pending`，一个「显示已处理」开关翻出 `done` / `dropped`。
- **归档 / 垃圾箱跟「处理状态」正交**：`status`（待处理 / 已处理 / 已忽略）是「我处理到哪一步」，`life`（在列表 / 归档 / 垃圾箱）是「这条还该不该占列表」。
- **但归档 / 垃圾箱和四类 tab 同级、互斥**：它们在**同一条 tab 带**里（`🐞 bug · ◆ 变更 · ◇ 想法 · ○ 杂事 │ 📦 归档 · 🗑️ 垃圾箱`），选了归档就不是「bug 这一类」——归档 / 垃圾箱里的列表不按类过滤，一次看全部。理由：「看哪些 bug」和「看归档了什么」是两个问题，叠在一起要三个维度一起点才找得到东西；把它们摆成同级，选哪个都只有一个高亮，脑子里只有一个当前视图。
- 每条记录行尾有两颗小图标（悬停才出现，避免把行变成按钮墙）：在列表里是「归档 / 删除」，归档里是「复原 / 删除」，垃圾箱里是「复原 / 彻底删除」。按钮名就叫**删除**，行为是放进垃圾箱（可复原）；彻底删是垃圾箱里才有的第二个动作。垃圾箱支持**一键清空**，清空前 confirm。
- 编辑器底部四个动作（保存 / 复制 Markdown / 交给 agent / 删除）一副骨架：等高、同内距、同圆角，只靠颜色分主次（保存实心、删除红字），不给某一个偷偷加大内距。
- 归档 / 垃圾箱都只是打时间戳（`archivedAt` / `deletedAt`），文件不删；只有「彻底删除」和「清空垃圾箱」才动磁盘，并且连 `assets/<id>/` 一起删。
- **归档 / 垃圾箱是「管理列表」，不是「写的地方」**：这两个视图里没有 `＋ 记一条`，编辑器空态只说「复原放回列表才能改」，左栏只留检索（标题 / 正文 / issue / commit 子串，大小写不敏感，三个视图通用）。理由不是洁癖：在这两堆里新建的记录按定义属于列表，存下去之后广播一到、`setNotes` 判定「这条不该待在这堆里」就把编辑器关了——用户看到的是「点了保存，没存上」。现在 `save()` 里还留了一道兜底：不在列表视图就先切回列表。
- 三档录入（`quick` / `form` / `long`）= 同一个编辑器的三副样子：`quick` 一行、Enter 存（Shift+Enter 换行）；`form` 多两栏加高；`long` 等宽、给日志栈。存下之后正文还能改、图能加能删。
- 截图只从用户手上进来：Ctrl+V 粘贴 / 拖进编辑器 / `＋ 图` 选文件。粘贴的图先以 data URL 挂在 `pendingShots`，**随条目的「保存」一起**上传——不然一条还没存下的记录会在磁盘上先长出一个目录。
- 存储：`stateDir()/notes/bug-notes.json` + `notes/assets/<id>/shot-<n>.<ext>`。图不塞 JSON：base64 会让文件在几十张图后变成几 MB，而列表每次都要整读。截图记**绝对路径**，因为「交给 agent」时它要能直接读。
- 每条字段：`id / kind / status / mode / title / body / shots / sessionId / sessionName / issue / commit / createdAt / updatedAt`。会话只是**静默记下**（列表不显示），标题为空时取正文首行 60 字。写操作不做 step-up、隧道不拦：登录进来的就是本人，记录也不进 pi 的会话文件。
- 枚举值一律校验后拒绝（`不认识的 kind：wat`），不静默退回默认值——打错一个字会把「想法」悄悄记成 bug。
- 出口三个，都在记录上：**复制 Markdown**（单条）· **导出全部**（当前 tab + 当前筛选）· **交给 agent**（菜单两选一：预填到当前会话的输入框；或新开会话、建好后填进那个会话）。两个都**不自动发送**。
- 状态 / issue / commit 是**立刻落盘**的（`notes.status`），不跟正文的「保存」一批——所以它们不会让 `dirty` 拦住「交给 agent」。

**为什么归档和垃圾箱不合并：** 归档是「这条已经定了、但我想留着查」，垃圾箱是「这条我删了、可能反悔」。合成一个「回收站」的话，处理完的东西会和误删的东西混在一起，而它们的心智完全不同（前者不该复原，后者几乎一定会）。代价只是两个视图 + 两个工具栏位置，比一个语义含混的列表便宜。

**为什么删图 / 删记录要分「打标记」和「真删」：** 打标记能撤销，真删不能。默认路径必须是能撤销的那条（🗑️ 删到垃圾箱），能撤销的路径上不给「彻底删除」以外的入口。

**为什么不做「一键建 GitHub issue」：** `gh` 要走代理、还要登录态，失败路径比功能本身长（D80 的教训）；本期只留 `issue` 号字段，用户把号粘进来即可。**为什么不做自动抓屏：** `getDisplayMedia` 要用户选源、服务端 puppeteer 要装浏览器，两个都比「Ctrl+V 贴一下」重，收益还只是省一次粘贴。

**可改：** 四类与 `quick/form/long` 三档的具体文案（`web/src/notesheet.ts` 顶部 `NOTE_KINDS` / `MODE_LABEL`）；单条最多 24 张、单图 20MB（`bridge/src/notes.ts` 的 `MAX_SHOTS` / `MAX_SHOT_BYTES`）；默认快捷键 `Ctrl+Shift+B`（`app.ts` 的 `DEFAULT_KEYS`）。想让「已处理」也立刻消失就把 `.notes-switch` 默认打勾，但那样就没有「回头看看处理了什么」的地方了。

**验证：** `node probes/bug-notes.mjs`（真桥、临时状态目录、纯 WS，32 条断言；含 `notes.life` 归档打时间戳 / 复原清空 / 错 life 被拒 / `trashed` 只打标记 / `notes.purge` 只清垃圾箱那条）：hello 带 `notes`、空标题取正文首行、同 id 是更新（`createdAt` 不变、`updatedAt` 前进）、`issue`/`commit` 落盘、错 status / 错 kind 被拒且状态不变、截图落到 `assets/<id>/` 且 `/api/image` 读得回 `image/png`、第二张换名不覆盖、删图只删自己那条、删记录连目录一起清、桥杀掉后 JSON 仍在。`node probes/bug-notes-ui.mjs`（真 Chromium + 隔离桥，37 条断言（含归档视图不给「＋ 记一条」、检索命中 / 空态 / 清空））：没开会话也能开、光标落在记一条、Enter 存一条、按钮只显示图标且计数在 `title`、行内归档后从列表消失 → 归档抽屉可见 → 复原回列表 → 删到垃圾箱 → 只读 + 复原 + 彻底删除 + 清空垃圾箱、真 paste 事件贴图并随保存落盘、缩略图回到编辑器、状态 pill 转已处理后从待处理消失、「显示已处理」翻回来、复制 Markdown 进剪贴板（含截图绝对路径）、交给 agent 菜单两项、Escape 先关菜单再关面板、刷新后记录还在。截图：`.scratch/bug-notes/shots/desktop.png`。

## D109 测试环境技能住进仓库 `.pi/skills/`：项目级零安装，不走 npm 包也不拷用户目录

**问题：** 「起一份隔离测试实例」这套流程一直只活在本机 `~/.pi/agent/skills/pi-web-client-test-dev/`——跟着作者这台机器走，不跟仓库走。新机器 clone 下来部署完之后，这个技能不存在，验收 / 复现「别动我正在用的 7864」那套操作得靠人嘴传。

**决定：**
- 技能进仓库：`.pi/skills/pi-web-client-test-dev/`（`SKILL.md` + `bin/env.mjs`），pi 在**本仓库或其子目录**里跑时按项目级技能自动发现，不需要 `pi install`、不需要 `npm postinstall`，也不写用户的 `~/.pi/agent/skills/`。
- `.gitignore` 原来整目录忽略 `.pi/`，改成只忽略一层内容（`.pi/*`）并对 `.pi/skills/` 开白名单（`!.pi/skills/`）——`.pi/` 里别的都是本机产物（任务日志、sessions），只有技能该进版本库。
- 本机那份 `~/.pi/agent/skills/pi-web-client-test-dev/` 删掉，仓库版成为唯一来源。pi 遇同名技能是「先发现者生效 + 启动警告」，两份都留等于每个会话头上挂一条警告，而且改一份、生效的是另一份。
- `SKILL.md` 顺手通用化：开浏览器给 Windows / macOS / Linux 三块命令，判据写明「窗口标题只在 Windows 实测过，mac/Linux 没有等价判据，用 `/` 的 HTTP 200 + 让用户自己确认」；PowerShell / `taskkill` 那些条目标成 Windows 专属。`bin/env.mjs` 不用改平台逻辑——`killTree()` 早就按 `process.platform` 分了 `taskkill /T /F` 和 `process.kill(-pid, "SIGTERM")`（`env.mjs:182-191`），`npm` 调用的 `shell` 也按平台切（`env.mjs:137,145`）。

**为什么不用 pi 包（`pi install ./`）：** 这是个要在本仓库里验代码的工具，不是要在任何目录下都能用的通用能力。包机制多一次「部署完还得记得 install」，而项目级技能的可见范围（仓库内）恰好等于它该有的范围。**为什么不用 postinstall 拷到用户目录：** 装个 web 客户端顺手改用户的技能目录，属于不请自来的副作用；而且只有走 `npm install` 才触发，从 worktree 起的实例根本没这一步。

**为什么只搬不拆：** 技能的价值在于「先确认代码来源再启动」「7864 绝不碰」「口令恒为 test」这些约束被写在能自动加载的文档里，拆成脚本 + README 反而更容易被跳过。

**可改：** 以后真要给别处的人当通用工具用（任意目录可调），再加 `package.json` 的 `pi.skills` 清单发 npm 包，`.pi/skills/` 那份继续留着当项目级入口也不冲突（改名避开同名警告即可）。mac/Linux 上的端口独占探测与 `xdg-open` 判据都还没实测，第一次在那些平台上跑完 `ports` 应当把结论补回 `SKILL.md`。

**验证：** 从仓库内路径跑 `node .pi/skills/pi-web-client-test-dev/bin/env.mjs list`（空表）、`ports --peers 1`（`base` 17864、三个端口齐全）、`start --dir F:/pi-web-client --name smoke`（打印 `登录自检 HTTP 200（口令 test 生效）`、`/healthz` 回 `{"ok":true,…}`）、`stop --id smoke`（回到空表）。`git check-ignore` 对 `SKILL.md` 与 `bin/env.mjs` 均返回未忽略。
## D110 界面支持中 / 英 / 日：键就是中文原文，切换即时重渲染，不整页刷新

**要做什么**：这个客户端之前是纯中文硬编码（`web/src` 里 850 多处中文字面量，`<html lang="zh-CN">`，时间一律 `toLocaleString("zh-CN")`）。现在要能切简体中文 / English / 日本語，开关放在原来的「字号与颜色」面板里，面板随之改名「外观与语言」。

**决定**（`web/src/i18n/`，约 880 条键 × 3 种语言）：

1. **键 = 中文原文**（gettext 风格）：`tr("关闭")`。中文直接返回键本身，只有 en / ja 需要词典。好处是改造过程可以一段一段来——没进词典的中文照常显示中文，不会出现「键名」这种空壳；坏处是键全带上引号（键里有全角括号、箭头、空格，不加引号直接语法错）。
2. **函数名是 `tr`，不是 `t`**：这个仓库里 `t` 早被当局部变量用惯了（`const t = this.trust`、`t: TimeBucket`、`const t = ev.target`… 20 多处），一个叫 `t` 的 import 会把这些地方的含义偷走。
3. **`|ctx` 后缀消歧**：同一个中文两种语气（`"关闭|toggle"`）→ 两条键，后缀不展示。
4. **占位符 `{p1}`…**，模板串由一次性 codemod（`.scratch/i18n/codemod.mjs`，TS 编译器 API）转换；值可以是函数，英文复数 / 日文量词这类用 `Intl.PluralRules` 写。
5. **存储**：跟字号同一份 `pi.prefs`（localStorage）。`accent` 那三个键顺手从中文色名换成稳定 id（`ice` / `teal` / …）——它们是要落盘的，翻译了就丢色；老值靠 `LEGACY_ACCENTS` 迁移。**恢复默认不动语言**：语言是「我是谁」，不该被配色重置带走。
6. **首次打开跟浏览器**（`navigator.languages`）：`zh*` → 简体，`ja*` → 日文，其余（含认不出的）→ 英文；存过就存过的。
7. **切换即时生效**：`applyLang()` 改 `<html lang>` → `paintChrome()` 重写那些「只构造一次」的按钮（顶栏四颗、开新会话、筛选占位符、底部三 tab）→ `renderAll()` 重画其余 → 当前面板重开。**不整页 reload**：reload 会断 WS、丢滚动位置，看起来像出错。
8. **字体**：`html:lang(ja)` 换成日文字体栈（`Hiragino Sans` / `Yu Gothic UI` / `Meiryo` / `Noto Sans JP`）。Windows 上 `Segoe UI` 没有 CJK 字形，日文会一路落到 `Microsoft YaHei` 按简体字形画（直 / 骨 / 次 一眼就是机翻）。**不打包 webfont**：仓库从来没引过，为这点字形多背 1–2 MB 不值（**可改**）。
9. **时间 / 数字走 Intl**：`fmtTime` / `fmtDate` / `fmtNum` / `fmtRelative`（一分钟内「刚刚」，其余 `Intl.RelativeTimeFormat`）。原来手写的「N 分钟前 / toLocaleDateString("zh-CN")」全删。
10. **不给模型看的文案不翻**：`bridge/ext/approval-gate.ts` 的 label / description / promptSnippet、决策日志、门禁拒绝理由保持中文——读者是模型与维护者，界面上切语言不该让模型收到的工具说明跟着变（会话中途换措辞只会让上下文前后不一致）。
11. **后端错误码化**：bridge 回 `{ error: 中文兜底, code, params }`，前端 `errText()` 先查 `bridge.err.<code>`，查不到才用兜底文案。通知文案（`需要你批准 · 会话名`）跟界面语言走：页面连上 WS 时上报当前语言，bridge 只存内存里最近一个值，不落盘。
12. **测试固定看中文**：所有 Playwright 脚本的 `newContext()` 都显式 `locale: "zh-CN"`（原来靠 Playwright 默认 `en-US`，恰好没触发过检测逻辑，但检测一上线就会把断言全变成英文）。约 30 个脚本。
13. **门禁 `web/i18n-check.mjs`**：`web/src` 里出现中文却没进 `tr()` 就失败；en / ja 键集合必须与代码里的键**完全一致**；不许空串。接在 `npm --prefix web run typecheck` 后面。

**为什么用中文原文当键，而不用 `session.close` 这种符号键**：符号键要求改造时**一次性**把 850 处全填上三份文案，否则界面出现空壳或键名；而这次改造是渐进的长跑，中文当键让每一步都是可运行、可截图的中间态。代价是「同一个中文在不同语境要两种洋文」时得手动加 `|ctx`，以及词典查不到时会静默回落中文（靠 `i18n-check` 与 `tr()` 的一次性 `console.warn` 兜住）。

**已知限制**：`zh-TW` / `zh-HK` 落简体中文（繁体本次不做）；`pi` / 命令 / 路径 / `md`·`json` 这些不译；界面把一句话拆成几段拼接的地方（`"打开 "` + 链接）在语序不同的语言里依赖键保留首尾空格，译文顺序无法自由调整（**可改**：真要治得重排 DOM）。

**验证**：`npm --prefix web run typecheck`（含 i18n-check）；`bridge/tests/i18n-ui.mjs`（en-US 上下文里登录 → 开「Appearance & language」→ 切三语 → 发一条消息，断言 `<html lang>`、顶栏按钮文字、面板标题都跟着变，截中 / 英 / 日三张图）；其余既有 Playwright 脚本全部固定 `locale: "zh-CN"` 后原样通过。


## D111 文件预览与终端按「最后被点 / 聚焦的那扇在前」叠放

**问题：** 同时打开文件预览（右侧固定面板）和终端（浮在页面上的 dialog）时，预览永远盖着终端：终端默认 1080px 宽、底部居中，和右侧 760px 的预览在右下角重叠一大块，而预览的 z-index（55）比终端（45）高。用户点终端、在里面打字，被预览挡掉的那半截也不会让开；点预览时它本来就在上面，于是看起来像「终端点不动」。

**决定：**
- 两扇窗放进同一条层带（终端底值 45、预览 46），谁最后被点 / 聚焦谁拿 `.front` = 47；同一时间只有一扇带 `.front`（`App.raiseWindow()`），另一扇回落到自己的底值，所以不会有平手。
- 判定入口集中在 `App.wireWindowRaise()`：窗内 `pointerdown`（终端标题栏 / xterm、预览的头部与正文）、窗内 `focusin`（键盘 Tab 进来）；打开或换文件时主动抬到前面（`openPreview()` 与 `showTermDock()`）。点进 html 预览的 iframe 时指针事件不跨文档，靠 `window` 的 `blur` + 一 tick 后看 `document.activeElement` 是不是那扇窗里的 `IFRAME` 补一次（`blur` 到别的窗口时不打扰叠放）。
- 整条层带仍在口令 modal（50）与底部 sheet（60）之下：能盖住浮窗的只有真正的模态，另一扇窗不行。因此预览从 55 降到 46/47 之后，口令 modal 第一次能盖住它（以前会躲在预览后面）。

**为什么：** 两扇窗都是「随时要用」的工具，不是模态；用户对浮窗的预期就是桌面窗口那一套——点谁谁到前面。用固定 z-index 排序（预览永远在上）等于让重叠区域里的终端永远用不了，只能先关预览。层级带留在 modal 之下，是因为输入口令 / 回答问卷这类「必须处理完」的东西不该被工具窗压住。

**可改：** 层带数值（45/46/47）与「前窗要不要更深的阴影」都在 `web/src/styles.css` 的 `.viewer` / `.term-dock` 两节；判定入口在 `App.wireWindowRaise()`。

**验证：** `probes/window-front.mjs`（桩桥 + 真 Chromium，量 `elementFromPoint` 而不是只看 class）：先开终端（47）→ 打开 md 预览后它盖过终端（重叠点命中 `.viewer`，预览 47 / 终端 45）→ 点终端左侧可见区（300, 终端中线）终端回到 47、重叠点命中 `.term-dock` → 点预览上方（1300,200）预览回到 47 → 换成 html 预览、把终端抬回前面后点进 iframe，预览仍能盖回来 → `.modal` 仍是 50 > 47。截图 `.scratch/window-front/shots/`。回归：`probes/round12-preview-links.mjs`、`probes/term-dialog.mjs` 全绿，`npm run typecheck` 干净。

## D112 设置里能更新 pi 本体（`#49`）

**问题：** 网页客户端自己就是 pi 的前端，但「升级 pi」只能开终端敲 `pi update`；设置里的「关于」只写着 `pi 1.4.0`，看着像版本号，其实没法动。桥里其实早就有 `pkg.update` 通道（`target: self` 就是 `pi update`），只是前端从来只拿它更新扩展包。

**决定：**
- 入口放在「扩展与 MCP」页顶部一行「pi 本体」：当前版本、最新版本（带来源）、检查时间、`重新检查`、`更新 pi`。它是这一页唯一不属于「装了哪些东西」的东西，但正是下面所有东西跑在里面的程序，所以放在清单上面而不是塞进清单。
- 检查是懒的：第一次画这一页时发一次 `pi.update.check`，桥里按来源缓存 30 分钟（`bridge/src/piupdate.ts` 的 memo，与扩展版本检查同一条 `newer()` 语义）；`重新检查` 带 `force` 绕过缓存。检查是读操作，公网也能查。
- 来源顺序：先问 **npm 安装源**（按 npm 自己的规则解析 `registry`：`npm_config_registry` / `NPM_CONFIG_REGISTRY` / `~/.npmrc` / `%APPDATA%/npm/etc/npmrc` / 官方源），失败再问 `https://pi.dev/api/latest-version`，两个都失败就把两条失败原因一起显示，`更新 pi` 仍然可点（`pi update` 自己会重新查一次，不该因为我们查不到就不让用户动）。
- 点更新先弹确认框（`.modal.hi`）：要联网、可能几分钟、会替换全局安装的 pi、期间别关页面、失败没有自动回滚。确认后走现成的 `picli` 通道（`pkg.update` + `target: "self"`，失败后那一次带 `--force`），输出进同一个控制台，公网只读与 step-up 由桥原有逻辑拦。
- 更新成功后桥自己重读包里的 `package.json` 并 `broadcast({type:"pi.version"})`：页面上的版本号立刻变，**不用重启桥**。但正在跑的会话进程是旧代码，所以提示「已开着的会话仍是旧版本」，给一颗 `重启当前会话`（现有 `reload`）；另给 `看更新日志`，点了才切页，不自动跳走。
- 顺带修了一个既有的层级 bug：`.sheet-back`（60）盖在 `.modal`（50）之上，所以**在设置面板里**触发的口令验证框（写操作要 `requireStepUp`）其实被面板挡住了，只能盲打。新增 `.modal.hi { z-index: 62 }`，确认框与口令框都用它 —— 从弹层里打开的模态必须压过它自己的父层。

**为什么：** 用户升级 pi 的动机几乎总是「网页客户端里少了个新功能」，所以要更新的东西就该出现在同一个设置面板里，而不是让他切到终端。检查与安装必须分成两件事：检查随便点，安装要确认，因为后者会替换掉正在服务这台网页的程序，失败时没有回滚。版本号必须从磁盘重读而不能乐观 +1，否则一次失败的 `npm install` 会让页面报一个并不存在的版本。

**可改：** 缓存时长（`bridge/src/piupdate.ts` 的 `TTL`）、来源顺序与文案、确认框里的话、`--force` 是不是直接给 —— 都在 `paintPiUpdate()` / `confirmPiUpdate()` 与 `piupdate.ts` 顶部。

**验证：** `probes/pi-update.mjs`（桩桥 + 真 Chromium）：行里显示 `pi 1.4.0` / `最新 1.5.0（npm …）`，懒检查只发一次且不带 `force`；确认框写着「全局安装的 pi（1.4.0 → 1.5.0）」且 z-index 62 > 弹层 60、屏幕中心的点击真的落在框上；确认后桥收到 `{op: pkg.update, target: self}`（无 `force`）；安装成功后行变 `pi 1.5.0` +「已是最新」+「已更新到 1.5.0」+ 重启/日志按钮，控制台里是 `Updated pi from 1.4.0 to 1.5.0`；`看更新日志` 切页并读到内容；失败时出现「强制重装（--force）」，点它确认后桥收到 `force: true`；查不到最新版时显示两条失败原因而按钮仍在；`重新检查` 的请求带 `force: true`；公网时按钮禁用且有只读提示。真实网络另跑过两次 `piLatest(true)`：正常拿到 `{"latest":"1.5.0","source":"npm 源 registry.npmmirror.com"}`，把 registry 指到死端口后回落到 `{"latest":"1.5.0","source":"pi.dev"}`。回归：`probes/window-front.mjs`、`probes/round12-preview-links.mjs`、`probes/term-dialog.mjs` 全绿，`npm run typecheck` 干净。截图 `.scratch/pi-update/shots/`。

## D113 扩展弹窗：清单分三段推（本机先出，联网后补 ⟳），写操作按资源排队、按钮不再全灰

**问题**（用户报的，2026-11-04）：① 打开弹窗一直卡在「联网检查版本中…」，列表空着——因为打开时先 `extInv = null`，再发一次 `check:true` 的库存请求，要等 `pi mcp list`（挨个连服务器）+ 每个包问 npm/git（每次 20 秒超时）全部回来才画出第一行；② 点了某一个扩展的「更新」，其他所有行的更新 / 卸载 / 启停也一起变灰——因为界面只有一颗全局忙标志 `extBusy()`（= 「有一条 pi 命令在跑」），而 `cliRun` 一次只能记住一条命令。

**决定：**
1. **库存分三段推**（`bridge/src/extmgr.ts` 的 `inventory()` 收一个 `emit` 回调，`ext.inventory` 每段发一条完整快照）：
   - `local`：`pi list` + 扩展目录，纯本机，约 1–5 秒；`mcpReady:false`、`versionsChecked:false`。
   - `mcp`：`pi mcp list --json`（真连一遍服务器，可能几十秒）之后补上 MCP 行；这阶段**不联网**，固定版本号从 `mcp.json` 的命令行里读。
   - `versions`：npm / PyPI / `git ls-remote` 的答案，只有 `check:true` 才有。
   - 每段都带 `mcpReady` / `versionsChecked` 两个布尔，页面据此决定「连接中…」「检查中…」「⟳ 还在不在」。两段谁先回来都行，**每条快照都是「到目前为止的全集」**。
2. **页面不再清空缓存**：`openExtManager()` 不清 `extInv`，先画上次的清单，同时发一个新请求。新快照到达时 `mergeInventory()` 只在「版本号没变」时保留上一份的 `latest/update`，所以重开时「更新」按钮不会先消失再冒出来。
3. **⟳ 只管版本**：顶部 hint 在 `extCheckLoading` 时是 `⟳ 联网检查版本中…`，否则 `检查于 …`；包行在检查跑着时写「检查中…」而不是「最新」（那时它还不知道）。MCP 区在 `mcpReady:false` 时写「连接 MCP 服务器中…」，不写「没有配置」。
4. **写操作按资源排队**（`bridge/src/writelock.ts` 的 `createWriteLock()`，key 就是被写的资源）：
   - `npm`：`pkg.install/remove/update`、`mcp.add/remove/login/logout`——它们共用 `~/.pi/agent/npm` 这一个 npm 工程，而且 `pi install/remove` 是「先读 settings 再写整份 packages 列表」。
   - `settings:global` / `settings:project`：启停扩展（内置扩展也落在 global，所以 key 按**文件**算，不按 scope 名）。
   - `mcp:<mcp.json 绝对路径>`：MCP 的开关与改版本。
   - 失败不堵队列（前一个 reject 也照跑下一个）。
5. **界面不再全局置灰**：`piCli(req, key)` / `extWrite(req, key)` 给每次写操作带一个页面生成的 `reqId` 和它所属的**行 key**（`pkg:<source>`、`ext:<id>`、`mcp:<source>:<name>`、`mcpadd:<name>`、`install:<name>`、`pi`）。桥把 `reqId` 原样回执到 `picli.start/out/done` 与 `ext.op`（`state: running|done`）。页面用 `cliOps: Map<reqId, {key, state}>`：
   - 该行的主按钮写「排队中…」→「更新中…」；**同一行的次要按钮**（卸载 / 停用 / 删除 / OAuth）保持原名但禁用，因为这一行确实在忙；**其他行一律可点**，点了就是排队。
   - 失败的 `picli.done` 带 `error` 时写进控制台并放开这一行；`ext.op done` 同样放开。
   - 「全部更新（N）」一次把 N 个都排进去，只在它们全都在忙时禁用它自己。
   - 控制台在 `runId` 还没来（排队中）时写「已排队 …（桥按资源一个接一个跑）」，不再谎报「正在运行」。
   - **`done` 不带 `reqId` 时也要把对应行放开**（按 `op` 名关一条）：老桥、或在别的标签页起的操作都会这样回来。宁可多放一个，也不要让按钮永远停在「排队中…」（`probes/pi-update.mjs` 的桩桥就是这种不及时回执的桥，实测曾把「pi 本体」那一行卡死）。
6. **一次只发一个库存请求**：`extCheckLoading` 期间再要就记 `extReloadPending`，等这一段结束再补一次（否则装完一个包会同时跑两遍 `pi mcp list`）。

**为什么：**
- 「联网慢」和「你没事可做」是两件事。已装的清单是本机事实，没必要等网络；版本号才是网络事实，等它就该只转它自己那颗 ⟳。用户的原话是「不会因为网络原因，一直卡在联网界面」。
- 「同时不能点」不是安全需要，是**实现偷懒**（一个 `cliRun` 变量）。但真并行确实有代价：`~/.pi/agent/npm` 是同一个 npm 工程，两个 `npm install --prefix` 同时跑会坏 `package-lock` / 留下半装目录；`pi install/remove` 与 `ext.toggle` 都是「先读后写整份列表」，并发会丢改动。所以答案是**按资源排队**：不同资源真并行，同一资源排队，界面永远可点。
- 排队位置放在**桥**而不是页面：页面可能开好几个标签，真正的互斥只在桥里成立。

**代价 / 可改：**
- 冷启动第一屏仍要等 `pi list`（本机约 1–5 秒），它没法更快（要 pi 自己解析 path）。
- 排队是 FIFO、没有取消：点错了只能等它跑完。
- 「按资源」是人工分类的（三把锁）。新增写操作时要记得给它选 key，选错就等于没锁。**可改**
- MCP 那一行在 `versions` 之后才可能显示「可更新」，所以 `pi mcp list` 慢的时候版本要更晚才出现。

**验证：**
- `node bridge/tests/ext-manager.mjs`（真 pi CLI，fixture 目录）：库存分 3 段推、首段就带包且 `mcpReady:false`、末段两个布尔都为真；`reqId` 原样回执；**两个启停同时发**（builtin + 用户扩展，同一个 `settings.json`）**两条都落盘**（没加锁时这一步必挂，实测丢过一条）；`createWriteLock` 的同 key 串行 / 异 key 并行 / 失败不堵队列；其余 D81 断言不变。
- `node probes/ext-manager-stages.mjs`（桩桥 + 真 Chromium，`npm --prefix web run build` 之后跑）：冷启动先「读取已安装的包和扩展…」+ ⟳；本地段一到就出行、MCP 区写「连接 MCP 服务器中…」、包行「检查中…」；版本段到达后变「可更新到 2.0.0」、⟳ 消失、顶部「检查于 …」；关掉再开行立刻在且 ⟳ 在转；点「更新」→「排队中…」→「更新中…」，**别的包的更新、扩展的停用都可点**（同一行的卸载禁用）；两个包同时点 → 两个不同 `reqId`，结束 A 不影响 B；失败原因进控制台且行放开；`ext.op` 的启停同样「排队中 → 停用中 → 可点」。截图 `.scratch/ext-manager-stages/shots/`。
- `npm run typecheck`（bridge + peer + web，含 `i18n-check`）干净。

## D114 测试与探针里不再写死「这台机器」；代理是环境事实，不是仓库事实

**问题**（用户点的）：`bridge/tests/e2e.mjs` 第一句就读 `F:\pi-web-client\.scratch\test-state\passphrase.txt`，在这台机器上直接 `ENOENT`。扫下来同一类写死共 **357 处 / 72 个文件**：

- 仓库根：`F:/pi-web-client/…`（tests 12 个文件 + probes ≈44 个）；
- playwright：`C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs` —— 连 npx 缓存目录的哈希都写死了，重装一次就失效；
- pi CLI：`C:/Users/GG_Bond/AppData/Local/nvm/v23.11.1/…/bundle/cli.js`；node：`C:/nvm4w/nodejs/node.exe`；
- 产品里的诊断文案：`连接失败（本机直连 GitHub 是断的，要走 127.0.0.1:18791 代理）`；
- 文档：README 的测试示例 `PI_WEB_STATE=F:/…`、`docs/PLAN.md` 的目录树、技能的 `C:\Program Files (x86)\…\msedge.exe`；
- 约定文档：`AGENTS.md` / `docs/agents/issue-tracker.md` 的「GitHub 不可直连，每条命令都要 `HTTPS_PROXY=…:18791`」。

同名后果：任何别的克隆上，测试与探针**第一步就挂**；而那条代理断言在能直连的机器上是假的（这次的 PR 就是因为照它去等代理才卡住，实际 `gh api` 直连就通）。

**决定：**

1. **路径只有一个来源：`tools/paths.mjs`**（`REPO` 用 `import.meta.url` 反推、`DIST`、`scratch(…part)`、`wsWrapper()`）。tests 与 probes 都 `import` 它，不再出现盘符。
2. **playwright 自己找**（`tools/playwright.mjs`）：`PW_PATH` → `<repo>/node_modules` → `%LOCALAPPDATA%/npm-cache/_npx/*`。**「导入成功」不算找到** —— npx 缓存里经常躺着没下载浏览器的半价货，只会在 `chromium.launch()` 时才炸；所以候选必须真 `launch()` 一次（关掉）才算可用。
3. **pi CLI 复用桥的解析**（`tools/pi.mjs` → `bridge/dist/pi.js` 的 `resolvePi()`：`PI_BIN` → PATH 上的启动器 → nvm → `npm root -g`），`process.execPath` 代替写死的 `node.exe`。
4. **端口不再钉死**：`const PORT = Number(process.env.PI_WEB_PORT ?? <原值>)` —— 默认值不变（文档里那些端口号仍然有效），但两份实例要并行时给个环境变量就行。
5. **探针里的假路径**（`F:/probe-work/alpha`、`F:/yqm/pi-cli-web-test` 之类只出现在桩数据里）也换成 `<repo>/.scratch/probe-work/…`：它们不碰盘，但留着就是在教下一次「写死盘符没关系」。
6. **产品文案不写死代理**：`/diagnose` 的网络失败改成「先确认这台机器能直连（`curl -I https://github.com`）；确实要走代理时，填 pi 的 `httpProxy` 或 `HTTPS_PROXY`」+「换网络或代理：`git -c …proxy=<你的代理> push`」。中文原文就是 i18n 的键，`en.ts` / `ja.ts` 同步换。
7. **约定文档改成先试直连**：`AGENTS.md` 一句话 + `issue-tracker.md` 一节，写清两件事：① `curl https://api.github.com` 可能 403 而 `gh` 正常，判网络用 `gh` 不用 curl；② push / `gh pr create` 的 403 往往是 **active 账号**没权限，不是网络 —— 不改全局状态的推法：`TOKEN=$(gh auth token --user <owner>)` + `git push https://x-access-token:$TOKEN@…` + `GH_TOKEN=$TOKEN gh pr create`。
8. **技能的 Edge 路径**交给 App Paths：`Start-Process msedge -ArgumentList '--new-window',…`（64 位的 Edge 在 `Program Files`，写死 `Program Files (x86)` 会白跑一次）。

**为什么：**

- 一个文件知道自己在哪（`import.meta.url`），这是唯一在所有机器上都为真的路径；盘符和用户名不是。
- 代理是**环境事实**：开发那台机器要 18791，这台不用。仓库文档把它写成普遍事实，代价就是这次这样 —— 照着等一个不存在的代理。同理，产品里的诊断文案一旦写死某台机器的网络拓扑，就只对那台机器诚实。
- 「探针在作者机器上能跑」不等于「探针可移植」：他的浏览器语言是 zh-CN（所以 `newContext()` 不带 `locale` 也能过），`round24-pinactions.mjs` 在别的机器上会读到英文界面然后断言中文 —— 这次顺带补了 `locale: "zh-CN"`（AGENTS.md 里本来就写着这条规矩）。

**代价 / 可改：**

- `loadPlaywright()` 会多起一次无头 chromium（约 0.5 s）来验证候选；想要更快就 `PW_PATH` 钉死一份。
- 探针仍各自固定默认端口（文档里的数字不变），并行跑要自己给 `PI_WEB_PORT`。
- 历史记录**不动**：`docs/DECISIONS.md`、`docs/probes/*.md`、`docs/pi-integration-facts.md` 里的 `F:` / `GG_Bond` 是「当时怎么验的」的现场记录，改了等于伪造证据。

**验证：**

- 62 个文件改写后 `node --check` 全过；`rg 'F:/pi-web-client|GG_Bond|nvm4w|v23\.11\.1' bridge/tests probes tools` 无代码残留（只剩 `tools/*.mjs` 注释里「以前写死成什么样」的引用）。
- 之前跑不起来的现在真跑：`bridge/tests/e2e.mjs` 不再 `ENOENT`（它会连 7867 上的隔离桥，本机没有就报连接失败而不是文件不存在）；`probes/round{8,10,15,16,19,20,21,22,24}` 等一批桩桥探针全部 `ALL OK`（含这次新修的两处：`round22-dirsize` 的 `F:\probe-work` 转义写法、`round24-pinactions` 缺 `locale`）。
- `probes/chip-shot.mjs` 依赖仓库外的私有 `cdp.mjs`：改成读 `CDP_LIB`，没有就一句人话退出，不再抛 `ERR_MODULE_NOT_FOUND`。
- 回归：`npm run typecheck`（含 i18n 1001 键 × 3 语言）干净；`bridge/tests/ext-manager.mjs`、`bridge/tests/pi-cli.mjs` 仍 PASS。
- 能跑之后暴露的旧账（单独的 commit）：`round6-keys` 快捷键表已经是 12 条（旧期望 11）；`round15-git` 的 cwd 比较改成两边都 `path.resolve`；`ext-manager-stages` 要等 start 到了再让操作失败。还剩下三个与路径无关的 UI 旧账，本次没动：`round14-admin` / `round18-term` 断言的是 D92 之前的终端 dock（`.term-title`、开终端就折叠右栏），`readme-shots` 要第二个终端标签页。

## D115 技能面板：点外面就关；使用次数按真正发出去的 `/skill:` 算

**问题**（wiki 待处理，2026-11-04）：技能按钮打开的面板只能再点一次按钮或按键关，点面板以外的地方没反应；而「用了几次」只在面板里挑选时 +1，从 `/` 补全选中或者直接在输入框里敲 `/skill:name` 都不记，常用技能挤不进默认的六个。

**决定：**

1. **点面板以外的地方关闭**：打开时在 document 上挂一个捕获阶段的 `pointerdown`，落点不在面板里就关；关闭 = 移除面板 + 移除监听。技能按钮本身排除在外——它自己的 click 已经是开/关切换，`pointerdown` 先关会让它立刻又打开，等于永远关不掉。`renderChat()` 重建输入框时走同一个关闭函数，避免监听器留在 document 上。
2. **计数的时机从「pickSkill」移到 `sendPrompt()`**：真正发出去、并且文本以 `/skill:<name>` 开头（pi 的 `_expandSkillCommand` 只认开头）才发 `skillUsed`；同时本地把 `uses` / `lastUsed` +1，面板下一次打开时本地排序立刻生效。桥照旧落 `skill-usage.json` 并丢掉这个会话的技能缓存。
3. **本地排序对空查询也生效**：次数 → 最近使用 → 名字，和桥的 `rankSkills()` 一致；以前空查询是直接取桥给的前六个，现在本地 +1 能马上改变顺序。

**为什么：**

- 「使用」= 真的发出了一次技能调用，不是「点了面板里的一行」。只挑不发不算；在消息中间提到 `/skill:`（pi 不会展开）也不算。
- 外部点击用 document 监听，而不是加一层全屏遮罩：这是贴着输入框的补全式弹层，点左栏会话 / 对话区时应该**既关掉面板，也让那一下点击照常生效**；遮罩会把点击吃掉，变成真正的模态。
- 计数留在页面而不是桥里：页面知道最终发出去的文本（粘贴块、`/` 补全、面板插入都汇到同一个 `text`），而桥的 `prompt` 只是转手；`skillUsed` 这条消息本来就有，落盘仍在桥里。

**代价 / 可改：**

- 只认 `/skill:` 在开头：和 pi 一致。先粘一大段文本再敲技能命令，pi 也不会展开，所以不计数——这是跟着 pi 的语义，不是漏记。
- 计数发生在「点发送」时：排队后被 stop 的 `queue.restore` 拿回来也算过一次。要精确就得让 pi 在展开时回报，RPC 没有这个事件。**可改**
- 页面 60 秒内不重新拉技能列表，靠本地那份 +1 排序；下一次拉取后以桥的 `skill-usage.json` 为准。如果以后别的客户端也开始发 `skillUsed`，两边的口径要一起改。

**验证：**

- `node probes/skill-palette.mjs`（桩桥 + 真 Chromium，16 条断言，`npm --prefix web run build` 之后跑）：默认六个按次数（alpha…zeta）；点对话区关闭、点面板内部不关、技能按钮仍是切换、Esc 仍能关；直接在输入框敲 `/skill:theta` 发送 → `skillUsed` 恰好一次且带会话 id；从面板挑 alpha 但不发 → 0 次，发出去 → 1 次；再打开顺序变成 alpha / beta / gamma / theta / delta / epsilon（theta 进前六、alpha 回到第一）；`use /skill:eta now` 不计数。截图 `.scratch/skill-palette/shots/`。
- `npm --prefix web run typecheck`（含 i18n 1001 键 × 3 语言）干净。

## D120 会话进程生命周期：完成 + 30 分钟无事件回收，2.5 GB 水位兜底（`#75`）

**问题**（2026-11-04 用户报的「会不会随着会话增加一直不关，把电脑拖卡」）：D6 定的「空闲 2 小时回收」在真实使用下太宽松，而且 `sessions.ts:2288` 的 GC 里有三个**永久豁免**，一旦命中就再也不会回收。实测本机 4 个 `pi --mode rpc` 子进程合计 ~1.2 GB，单个 237–474 MB：

```
15320  285 MB   38344  474 MB   71328  253 MB   57852  237 MB
```

```ts
if (s.state.running)  continue;   // 卡死的一轮：永久
if (s.approvals.size) continue;   // 挂着没人理的审批：永久
if (s.asks.size)      continue;   // 挂着没人答的问卷：永久
if (s.idleFor() > IDLE_GC_MS) s.sleep();   // 2 小时
```

三个放大器：① 关标签页、切换会话都不回收（`index.ts:904` 的 WS close 只取消登录）；② 没有并发上限；③ 界面上看不到挂了几个 pi、吃了多少内存，用户没有手动出口。

**决定：**

1. **回收判据 = `running === false` 且 `idleFor() > 30m`**（原为 2 小时）。`IDLE_GC_MS` 从常量变成设置项。`idleFor` 的口径不变：每个 pi 事件开头都会 `touch()`（`sessions.ts:809`），pi 的 stderr 也算；**订阅/看页面不算活动** —— 这是刻意的，「忘关的标签页」正是要回收的那一类。
2. **内存水位兜底**：每 60 s 随 GC 用一次子进程采样进程表（win32 `tasklist /FO CSV`，darwin/linux `ps -o pid=,rss=`），只统计 `RpcChild` 已知的 `child.pid`（`rpc.ts` 新增 `get pid()`，不去匹配父进程）。总额超 2.5 GB 就踢最久没活动的，直到降到水位以下。
3. **running watchdog**：`running === true` 不再永久豁免。判据是「**没有在途工具**（没有任何 `status === "running"` 的 tool item、`bashRun` 为空）+ 30 分钟无 pi 事件」→ `abort`，60 s 后仍无响应才 `kill`。有在途工具时**只推一条 notice，绝不 abort**。
4. **审批/问卷不再永久豁免**：改成「无 `present` 客户端（页面可见且有焦点）满 30 分钟」→ 丢弃审批 + 休眠，并在会话时间线里插一条「这次审批已过期、那次工具调用已丢弃」的 notice。两个计时器要**同时**到：人不在满 30 分钟，**且**这条审批/问卷自己已经挂了满 30 分钟（否则你走了半小时之后才冒出来的审批，会在下一个 tick 就被丢掉）。
5. **设置面板新增「运行时」一节**：`运行中 pi：4 个 · 1.2 GB [全部休眠]`，以及两个阈值输入（空闲 30 m / 水位 2.5 GB），落 `<state>/lifecycle.json`（沿用 `budget.json` 的写法，不进 pi 的 `settings.json`）。「全部休眠」只休眠 `running === false` 的，仍在跑的跳过并在提示里点名。
6. **采样失败不踢人**：命令不存在 / 超 2 s / 输出格式变了 → 本次不按水位做决策，只记日志，面板把水位显示为「不可用」。宁可多占内存，不可因测量失败误杀。
7. **提示只走会话内 notice**：不加顶部横幅，不给侧栏加「休眠」徽标。休眠本身无害（发消息自动唤醒），不值得占注意力。
8. 一个 30 分钟的值同时服务三处：空闲休眠、watchdog、审批过期。

**为什么：**

- 「关掉页面它还在跑」是 D6 的卖点，但**它只需要撑到这一轮跑完**，不需要撑 2 小时。用户原话是「已经完成，并且 30 分钟内没有任何活动」——`agent_settled` 已经精确表达了「完成」（它会设 `running:false, done:true`，retry / compact / steering 之后才发），所以判据不需要新造信号。
- 回收要能**兜底**：只用空闲时间，遇到「10 分钟里连开 12 个会话」还是会瞬间吃掉 4–5 GB；只用内存水位，则冷门会话会一直挂着。两者各管一段，缺一不可。
- watchdog 必须区分「静默」和「卡死」。一个 `npm install` 或一个无输出的构建可以 40 分钟不发事件，此时唯一的区别就是**有没有工具在途**。`items.ts` 的 `status` 字段和白跑的 `bashRun` 已经够判定，不用改 pi。
- 审批那个豁免本意是「别吞掉用户还没点的批准」，但这个豁免没有上限时，午休挂 5 个报错会话就是 2 GB。人不在的时候（所有页面都不 present）才过期，是对两边都合理的切分。
- 采样失败一律不踢：内存水位是**优化**，不是正确性保证；为了它去猜（甚至用 `live × 350 MB` 估算）会把「测量不可靠」变成「误杀会话」。

**代价 / 可改：**

- 盯着一个空闲会话读 30 分钟，它也会休眠并弹一条 notice，下一条消息要多等 1–3 秒冷启。**可改**：把 `idleMs` 调大，或将来加「有人订阅就不休眠」的第二层阈值（代价是「标签页挂着去睡觉」不再被回收）。
- 审批过期会**丢掉那一次工具调用**（pi 进程没了，审批状态跟着没）。会话文件里那一轮会留下一个没有结果的工具卡片。
- 水位采样要靠平台命令，Windows 上每 60 s 一次 `tasklist` 是几十 ms 的 spawn；读数也不是原子快照（进程可能正好在退出）。
- `fetchModels` 那个每 10 分钟起一次的 throwaway 子进程（瞬时 ~300 MB）**不在本次范围**，另开 issue。

**验证（实现后填实测）：**

- 桩桥把阈值设成几秒：开 3 个会话各发一条消息 → 三个 pi 全退、各有一条「会话已休眠」notice、再发消息能续上同一 session 文件。
- 水位设 600 MB、开 3 个会话 → 踢到水位以下，正在跑的没动。
- 「有 tool 在途 + 30 分钟无事件」→ 只出 notice，不 abort；「无在途工具 + 30 分钟无事件」→ abort，60 s 后 kill。
- 挂一个审批、断掉所有 present → 30 分钟后审批被丢弃 + 休眠 + notice。
- 采样命令故意失败 → 一个会话都不踢，面板显示「不可用」。
- 设置改 5 分钟 / 800 MB → 重启 bridge 仍生效；「全部休眠」跳过 running 并点名。
- `npm run typecheck`（含三语 i18n 校验）、`npm test` 全绿。

**另记（这次查证顺手确认的事实）：**

- **孤儿进程不存在**：`pi --mode rpc` 在 stdin EOF 后 40 ms 自己退出（实测 `EXIT after 4052ms code=0`，4 s 时关 stdin）。bridge 崩溃 / 被任务管理器结束时，子进程的管道断掉，不会留下孤儿。（未核实：pi 正在跑工具时是否同样立即退出，落盘可能不完整。）
- `done === true` 的会话不被 evict **不是 bug**：`done` 的语义是「有未看过的结果」，`markSeen()` 在打开会话时才清（`sessions.ts:591`），evict 掉就等于吞掉一个未读完成。
- 目前没有既有 issue 覆盖这个话题（`#71`/`#72`/`#64`/`#62` 都无关）。
- **为什么编号从 D115 跳到 D120**：`D116`–`D119` 已经在 `#73` 的分支上（另一条线，还没合回 `main`），这里重排成 `D116` 会和那条真的撞号。编号是「先后顺序的标记」，不是「连续序号」，所以空着比撞着强。
- **watchdog 多一条豁免：压缩进行中不判卡死**（`sessions.ts` 的 `checkStuckRun` 里 `this.compaction` 那一行）。压缩天生就是**长时间静默**的（大上下文下「几分钟」，没有任何事件往外发），而第 3 条的判据「无事件 + 无在途工具」在那个窗口里长得和卡死一模一样 —— 不多这一条就会把正常的压缩中止掉。
- **宽限期只在 tick 上判定**：`abortGraceMs` 是拿 `abort` 的时刻与**下一个 tick** 比的，所以「中止后 60 s kill」实际可能晚到约两倍 tick（60 s 宽限 + 60 s tick ≈ 最长 120 s）。要准时就得再开一个定时器，而 D120 明确不要第二个计时器。
- **`abortGraceMs` 不出桥**：面板只收 `{ idleMs, watermarkBytes }`（`LifecycleThresholds`），这个宽限期是测试注入点（`PI_WEB_ABORT_GRACE_MS`），不是给人调的数。

## D121 预览面板的宽度：拖到最窄不许把出口拖没；盖住聊天区就直接全屏

**问题**（用户报的）：把文件预览的分隔条一直往右拖，面板越窄，头部那排按钮（含 ✕ 关闭、⛶ 全屏）**整体溢出到屏幕右侧之外** —— 看不见也点不到，页面里再没有第二个出口，只能按 Esc 或刷新，等于「无法恢复」。

根因是三条叠一起：`.viewer` 是 `position: fixed; right: 0` 且没有 `overflow` 策略；`.viewer-tools` 是 `flex: none`（永不收缩），只有 `.viewer-titles` 可收缩；拖拽下限写死 320px，远小于头部所需宽度。实测 320px 时关闭按钮的右缘在 `1641px`，而视口只有 `1440px`（`probes/viewer-split.mjs` 修前会红）。

顺带发现的同源缺口：`.wide-only`（隐藏「在新标签页打开」「复制路径」）挂在 `@media (max-width: 760px)` 上，它看的是**窗口**宽度 —— 宽屏上把面板拖窄，这条规则根本不触发。仓库里没有容器查询。

**决定：**

1. **头部与工具列允许换行**（`.viewer-head` / `.viewer-tools` 都 `flex-wrap: wrap`，工具列从 `flex: none` 改成 `flex: 1 1 auto; min-width: 0; justify-content: flex-end`）。面板窄了就把整排工具换到下一行，而不是把它顶出屏幕。
2. **`.viewer` 加 `container-type: inline-size`，`.wide-only` 改由 `@container (max-width: 620px)` 收起** —— 判据换成「面板自己多宽」，这才是这个问题真正的自变量。
3. **拖到盖住整个聊天区就自动全屏**：判据是预览左缘（拖拽点）越过**聊天区自己的左缘**（`getBoundingClientRect`），不是视口百分比 —— 侧栏宽窄、窗口大小都不影响；聊天区被收成 0 宽时不判定。进了全屏拖拽随即结束（分隔条本来就隐藏）。
4. **退出全屏一律回到默认宽度** `min(760px, 55vw)`（去掉内联 `--viewer-w`），并清掉 `localStorage` 里的拖拽记忆。
5. **拖拽触发的全屏不持久化**：它不写 `pi.viewerFull`，所以下一个预览不会一打开就满屏；手动点 ⛶ 仍然持久化。

**为什么：**

- 「无法恢复」的根因不是拖拽本身，而是**出口在溢出的那一侧**。右对齐的面板 + 可溢出的子元素 = 关不掉，这是布局层面的必然而不是角上的巧合。换行是最小且对任何宽度都成立的修法（容器查询只是顺手少占两行）。
- 自动全屏的边界必须用**聊天区**而不是数字：聊天区左缘会随侧栏收起/展开、窗口缩放而变，一个写死的百分比在哪种窗口下都可能早跳或晚跳。
- 退出全屏回到固定默认值，是为了让「退出全屏」这件事**每次都一样**。代价是忘掉你上次拖出来的宽度，换来的是不用猜。

**代价 / 可改：**

- 面板很窄时头部会变成两三行，占用一点正文高度。**可改**：把下限从 320 抬到 380–420 就能基本避免换行。
- 退出全屏会忘掉你调过的宽度（D121 §4 的刻意选择）。想改成「记住上一次」就在这里加一个 `pi.viewerW` 的保留分支。
- 自动全屏只看水平方向：面板本来就占满视口高度，所以没有「盖住全部」以外的第二种情况。

**验证：** `npm --prefix web run build && node probes/viewer-split.mjs`（桩桥 + 真 Chromium，约 10 秒）：拖到最窄时头部每个可见按钮都在视口内且 `elementFromPoint` 命中它自己（修前 7 个越界）；拖到覆盖聊天区 → `.viewer.full` 且宽度 = 视口宽；点「退出全屏」→ 回到 `min(760px, 55vw)` 且 `pi.viewerW` 已被清掉。回归 `probes/window-front.mjs`（浮窗叠放）与 `probes/round12-preview-links.mjs`（预览链接）都仍全绿。

## D122 新建会话不等 pi 启动：`create` 立刻回，界面把「正在启动」说出来

**问题**（用户报的）：新建会话时界面卡在「新会话创建」上，要等十几秒才进去。

查下来是一条链：前端点「创建」→ WS `create` → 桥 `sessions.create()` → `startLive()` 里 `await rpc.request("get_state", {}, 30000)` —— **卡片就卡在这句上**，pi 回话了桥才回 `{type:"session"}`，对话框才关掉。

而 pi 回这第一句话之前要先把扩展加载完。实测（真实 agent 目录，各 3 次交错取最小）：

| 配置 | spawn → `get_state` |
| --- | --- |
| `-ne`（不加载任何扩展） | **971 ms**（988 / 995 / 971） |
| 桥的真实参数（12 个 npm 扩展 + 5 个本地扩展） | **8176 ms**（8769 / 8301 / 8176） |

机器忙的时候（测的过程中 CPU 一度 70%、11 个 node 进程）同一个配置飙到 **12–15 秒**，最坏 15.5 秒。而且 pi 的**第一个字节**就要 7–8.8 秒，`session_start` 甚至不作为事件出现 —— 这 7 秒全在 pi 进程内部，桥这边拿不到更早的信号，所以「等第一个事件再返回」救不了。

顺手排除的两个嫌疑：**MCP 不是瓶颈**（`mcp.json` 全量 / 去掉 browser-use / 全空，三种都是 7.7 秒，pi 连 MCP 不在启动关键路径上）；`trustFor()` 也不慢（`piModule()` 是同进程 import，不是 spawn）。

**决定：**

1. **`create`（以及 `openLive`）不再等 `get_state`**：spawn 完立刻返回，会话马上出现在界面上。`get_state` 照旧发、回来补 `model` / `file`，只是不再拦住调用方。
2. **`state.starting`**：spawn 时置 true，`get_state` 落地就翻 false（进程退出、close 也会清）。这是页面唯一需要知道的事。
3. **界面把这几秒说出来**：`starting` 为真时，状态行写「pi 正在启动（加载扩展，通常几秒）…」而不是「Enter 发送」的快捷键提示；输入框置灰、placeholder 换成「pi 正在启动…」；`sendPrompt` 里再兜一次（键盘路径也要拦）。**（已被 D177 推翻，见 #197）**
4. **启动耗时可观测**：`get_state` 落地时往桥日志写一行 `[boot] <sessionId> pi 启动完成 <ms>`。这是「新会话为什么慢」唯一的可观测出口 —— 以后要判断是不是扩展又长胖了，看这一行。

**为什么：**

- 对话框的职责是「确认工作目录和选项」，不是「等 pi 就绪」。把两件事串成一件，等于让一个纯前端交互去背 pi 的启动成本。
- 那 7 秒的根因在**用户自己的扩展集**（12 个 npm 包 + 5 个本地 .ts），不在桥里。桥能做的只有两件事：不把它变成对话框的等待，以及让它可见（第 4 条）。真要让启动变快，得减扩展，那是配置问题不是代码问题。
- 不选「等第一个字节就返回」：第一个字节本来就在 7–8.8 秒，省不下什么。

**代价 / 可改：**

- 新会话会出现**先看到空聊天框、pi 还在起**的那两三秒（机器忙时更久）。这就是第 3 条存在的理由：这段时间界面明确说「正在启动」，并且不让人打字。
- 头几秒 `state.file` / `state.model` 是空的，靠事件和 `get_state` 补齐。要读这两个字段的调用方（比如刚创建就 `/export`）要能容忍 null。
- 想让创建更快只剩三条路：减扩展（治本）、把 `pi` 进程池化（pi 的 RPC 一进程一会话，D6，代价很大）、或者预启动（在用户打开对话框时就猜一个进程起来）—— 后者还没做，是这次明确留下的口子。

**验证：** `node bridge/tests/create-fast.mjs`（桩 pi 用 `FAKE_PI_BOOT_MS=4000` 假装启动很慢）：`create` 的应答 **47 ms** 就到（预算 1.5 秒），刚创建时 `state.starting === true`，4 秒后翻成 false，桥日志里有真实的 `[boot] … 4177 ms`。`node probes/session-starting.mjs`（桩桥 + 真 Chromium）：状态行写「pi 正在启动（加载扩展，通常几秒）…」、输入框禁用且 placeholder 同步、`starting` 翻 false 后恢复可用且回车真能把消息发出去。

回归：`session-lifecycle` / `runtime-panel`（顺带修了它和 `memory-cap` 里「create 一返回就读桩 pi 日志」的竞态）/ `stuck-run` / `approval-expiry` / `runtime-settings` / `sleep-all` / `memory-cap` / `composer-actions` / `run-lifecycle` / `session-sync` 全绿；`probes/window-front.mjs` 仍 ALL OK。

**另记：**

- `memory-cap.mjs` 最后一个用例原来用 7884 端口，这台机器上被 Trend Micro（`TmListen.exe`）占着，换成了 7906。挑测试端口时别用 788x。
- 用户 `mcp.json` 里两个坏件与本结论无关，但记一笔：`browser-use`（`uvx browser-use==0.13.11`）60 秒都没回 `initialize`；`atlassian` 回 401（未授权）。`rea` / `context-mode` 正常（后者 1.8 秒）。
- 未核实：`bridge/src/paths.ts` 的 `agentDir()` 同时认 `PI_AGENT_DIR` 与 `PI_CODING_AGENT_DIR`，但用 `PI_AGENT_DIR` 指到空目录时 pi 的行为没有可观察的变化 —— 疑似 pi 只认后者。这条实验被「空目录缺 auth 导致挂起」污染，没能证伪。

## D123 字号放大后「全屏」会切掉左边：`vw` 在 `#app` 的 zoom 里被乘了两次

**问题**（用户报的，附截图）：把字号调到「大 / 特大」之后，文件面板点 ⛶ 全屏 —— 面板左边一整条不见了：标题「浏览本机文件」、路径、后退/前进、面包屑、每一行的目录名全被切到屏幕外，只剩右对齐的那排工具按钮和行尾的大小 / 日期，看起来像布局全乱。

**根因**：`#app { zoom: var(--ui-scale) }`，而 `.viewer` 是 `position: fixed; right: 0`，全屏靠 `.viewer.full { width: 100vw }`。在 zoom 过的子树里 **`vw` 是「布局长度」，渲染时会被再乘一次缩放**：1440px 的视口在 1.25 下 `100vw` = 1800px 宽，而 `right: 0` 又把右缘钉在视口上 —— 多出来的 360px 全往**左边**溢出，被切掉的正是左对齐的所有内容。实测（`probes/viewer-full-zoom.mjs`）：1.12 档面板 1613px / 左缘 −173，1.25 档 1800px / 左缘 −360；字号 1 时一切正常，所以之前没人发现。

同源的两处一起修：

- 窄屏 `@media (max-width: 760px) { .viewer { width: 100vw } }` —— 手机上开大字同样会左边出血。
- 拖分隔条：`--viewer-w` 写的是**布局 px**，但 `clientX` / `innerWidth` 是**视觉 px**，没除系数时 1.25 档拖出来的面板比鼠标宽 25%，分隔条永远跑在指针前面。

**决定：**

1. **全屏用 `left` / `right` 撑满，不写宽度**：`.viewer.full { left: 0; right: 0; width: auto }`（窄屏那条同样改成 `left: 0; width: auto`）。
2. **拖拽宽度按 `uiScale()` 折算**：`(innerWidth − clientX) / s`，最大宽度 `(innerWidth − 120) / s`；320px 下限仍是布局 px（D121 §3 的下限不动）。
3. **`termScale()` 改名 `uiScale()`**：它不再是终端专用 —— 预览面板的拖拽也走同一个换算，名字留在「terminal geometry」那段会误导下一个改这里的人。

**为什么：**

- `inset` 解析的是 zoom 折算过的包含块 —— 修前 `right: 0` 就已经正确贴住视口右缘，这就是证据。所以「左右都钉住」比「算一个宽度」稳：窗口 resize、改字号都不用重算，也没有 JS 参与。写死 px 得在 resize / `applyPrefs` 里各补一次。
- 拖拽必须除系数而不是「把面板宽度四舍五入」：错误随缩放线性放大（1.25 档 800px 处偏 200px），用户看到的是「分隔条不跟手」，而不是「差一点」。

**代价 / 可改：**

- `pi.viewerW` / `pi.termGeom` 里存的都是布局 px，之后的 **改字号会让同一个数字的视觉宽度变大**（特大档存 760 会画成 950）。和终端几何一致，这次没动 —— 真要统一，就在这里存视觉 px、读的时候乘系数。
- `--viewer-w` 的默认值 `min(760px, 55vw)` 里的 `55vw` 也没改：特大档下它等于视口的 68.75%。看起来就是「字大了面板也大」，不算坏，所以先留着；要严格 55% 就得写成 `calc(55vw / var(--ui-scale))`。
- 同一个坑还在别处：`@media (max-width: 760px)` 里 `.sheet.mgr-sheet` / `.sheet.peer-sheet` 的 `width: 100vw` 与 `100dvh`，以及 `.context-menu` 的 `calc(100vw - 16px)` —— 它们只会「宽出去一点、两边均匀溢出」，不像 `.viewer` 那样一边对齐一边出血，所以没在这次一并改。

**验证：** `npm --prefix web run build && node probes/viewer-full-zoom.mjs`（真桥 + 真 Chromium，三档字号 1 / 1.12 / 1.25，每档点全屏再拖一次）。修前三档里 1.12 / 1.25 红：面板 1613 / 1800 宽、左缘 −173 / −360，头部 `viewer-nav` / `viewer-titles` 与目录名全部越界；修后每档面板都正好 1440 宽、左缘 0，`viewer-head` 三块和目录名都在视口内，拖到 x=640 时面板左缘 = 640（±3px）。回归 `probes/viewer-split.mjs`（D121 全部用例仍绿）、`probes/window-front.mjs`、`probes/round12-preview-links.mjs` 全绿。

## D124 随手问：一个不进列表的会话，清空用同进程 `new_session`（`#86`）

**决定：** 顶栏加 `💭 随手问`，打开一个 dialog；它背后是普通 pi 会话，但被一条 `scratch` 标记当成另类处理：

- **不进任何列表**：app 启动时带 `--session-dir` 指到 `state/scratch/sessions`，那个目录不在 pi 的会话根里，扫不到；`list()` 再滤一次（广播的 `session.state` 也不会把它塞回侧栏）。
- **懒建**：第一次点开才 spawn，`scratch.open` 幂等（没有就建、睡过就唤醒、有就复用）。
- **清空 = 同进程 `new_session`**：pi 的 RPC 有这个命令，进程不重启，上下文和 token 归零，旧文件当场删掉。桥侧 id 不变（页面所有东西都以它为键），只把 `state.file` 换成 pi 报的新路径。
- **只读**：`--tools read,grep,find,ls,web_search,fetch_content,source_check,get_search_content`（联网那几个由 `pi-web-access` 扩展提供；实测 pi 对 `--tools` 里不存在的名字只当没写，不会起不来，所以没装扩展时也能降级），并把审批闸的 `/allow` 模式写成 `readonly`（闸那边 `readonly` 是白名单，不是「什么都放行」；联网这组要显式加进白名单）。cwd 是中性空目录。
- **三条豁免**：休眠用自己的一小时（`lifecycle.json` 的 `scratchIdleMs` / `PI_WEB_SCRATCH_IDLE_MS`）；水位永不收它；`maybeAutoCompact` 跳过它，只发提醒。
- **提醒线不是固定百分比**：pi 在 `contextTokens > contextWindow - reserveTokens`（默认 16384）处自动压缩，200k 窗口是 92%、32k 只有 50%。所以提醒按 `(contextWindow - reserveTokens)` 的 75% / 92% 算。
- **落地范围**：`state/scratch/` 整个目录由桥启动时（`ensureStateDirs()` 之后、任何 spawn 之前）无条件清空重建，退出时再清一次；`PI_WEB_STATE` 已经把多开的第二份桥隔开，所以不需要实例 id 或 pid 文件。

**为什么：**

- 「不留下记录」最可靠的做法是**根本不写到会被扫的地方**，而不是写完再过滤。一个 `--session-dir` 就把「列表里看不见」变成结构性事实。
- 「清空要等 1–3 秒」是**本仓库的实现**（新建 = spawn 新进程），不是 pi 的限制：`new_session` 在同一个进程里换会话。既然用户要的是「随手问一句」，重启进程纯属浪费。
- 三条豁免必须集中在一个标记上：全桥只有它会同时命中「不该休眠 / 不该被水位收 / 不该被压缩」，散成三处 `if` 迟早漏一处。
- 只给读工具就没必要处理审批：没有写、没有 shell，审批闸不会弹，随手问才可能「不打断人」。

**代价 / 可改：**

- 第一次点开仍要付 1–3 秒冷启（懒建换来的：不常驻一个 pi）。
- 它读得到整台机器（pi 没有内置沙箱，工具不按 cwd 限制），只是不能写；cwd 的中性空目录只管相对路径。
- 加了联网查之后，多了一条「把从本机读到的内容当搜索词发出去」的通道。这是联网本身的含义，不是漏洞 —— 但要知道它在。
- 豁免水位意味着内存紧张时被收的是**别的**会话。
- `scratchIdleMs` 只走 `lifecycle.json` / 环境变量，运行面板里还没有它。
- `fork` / `/tree` 都不能用来「回到最顶部」：前者要求会话已写盘且产出新会话 id，后者在桥里只有只读的读文件画树。

**验证：** `npm run build && npm run test:scratch`（桩 pi：懒建 / `--session-dir` / `--tools` / 不进列表 / 同进程清空 + 旧文件删除 / 休眠与水位豁免 / 重启清空，共 26 项）、`npm run test:scratch:ui`（真 Chromium：顶栏入口、说明文案、发一句能回、清空后变空、关掉再开还在）。

## D125 打开即置顶：从任何入口打开会话，它就得在置顶区里；装不下就折成「＋N」

**问题：** 会话管理里打开一个会话，它不一定是置顶的。左栏一收起，那条横栏就是**唯一**的会话入口 ——
当前会话不在里面，一整排胶囊长得一模一样，用户根本不知道自己正在跟哪个会话说话（报障原话）。

**决定：**

- **打开 = 置顶**，入口不分：左栏卡片、置顶胶囊、会话管理的「打开」、分叉 / 导入结果、`#/s/<id>` 深链
  与浏览器后退、新建会话（左栏「开新会话」、`/new`、快捷键、置顶条的 ＋）全都算。落点是一处：
  `openSession()` 与 `case "session"` 里「页面认了这个新会话」那一步，都调 `markOpened(id)`。
- **桥侧一个原子动作**：`manage` 命令加 `opened`（`Manage.opened()`）—— 解除归档 + 插到 `pin[0]`。
  不是「前端拼一个 arrange 再发」：那要发两条、还会被回声打断；而且 `arrange` 会把归档 id 过滤掉，
  先 unarchive 再 arrange 必然丢一次。
- **已经在置顶区的不重排**（只回一份快照，让前端的乐观状态收敛）。手动拖出来的顺序不该被每一次点击
  重排；新来的一律插最前，所以「刚打开的那颗」永远在第一行。
- **归档让位**：打开归档会话 = 要接着用它，`archived` 里摘掉。归档是「收起来」，不是「只读」。
- **装不下一行就折成「＋N」**：置顶会随打开累积（用户选的就是这个，不做「只留一个自动置顶」的魔法），
  所以横栏超出宽度时从尾部往前收，收掉的进那颗「＋N」，点开是一张全量列表（`.pin-menu` 外壳，
  挂在 body 上，理由同 Q-035）。**当前会话那颗永不折叠** —— 藏了等于回到报障现场。
- **公网未验口令时静默跳过**：桥的 manage 写操作要 step-up（D15），但每次点会话弹一次口令框比不置顶
  更难受；跳过不弹，用户自己验过之后的 step-up 窗口里照常置顶（D186 起前端改跟桥的 1 天窗口，不再自带 9 分钟近似值）。

**为什么不用「置顶条只画当前会话」这种更省事的做法：** 用户要的是**状态**（置顶），不是**高亮**。
状态能撑住「收起左栏、换标签页、重开页面」这一串场景；画一个假的当前胶囊只是把问题挪到下一个渲染点。

**代价 / 可改：**

- 置顶区会累积成「最近打开过的会话」，左栏的「置顶」分区也跟着一起长（折叠只做在横栏上；左栏是纵向
  滚动列表，暂时不折）。这是 #72（工作区树）要接手的事。
- 每次切换到一个没置顶过的会话会多一次 `manage` 往返；已经在置顶区里的不发。
- 手动 ★ 之后那颗保持原位，新打开的会插到它前面 —— 手排顺序只在「新加入」时被打断。

**验证：** `node bridge/tests/manage-check.mjs`（真桥 + 真会话文件：`opened` 置顶 / 解除归档 / 不重排
/ 陌生 id 不落盘，与既有的 arrange/archive/delete/purge/restart 一起跑通）、
`node probes/pin-auto-open.mjs`（桩桥 + 真 Chromium：深链首屏、左栏点开、归档点开三条入口都进 `pin[0]`，
横栏折叠出「＋N」且数与藏起来的胶囊一致、不再横向溢出，当前会话排到置顶区最后也不被折、点「＋N」能选）、
`node probes/pin-current.mjs`（D76 的「当前会话标记」跟着 D125 改写第 3 步）、
`node probes/round4-pin.mjs`、`node probes/round16-pin.mjs`、`node probes/round24-pinactions.mjs`（Q-011 /
Q-022 / Q-035 的旧约定没被打破：★ 取消置顶、条 ＋ 建会话落到末尾、悬停气泡照旧）。

## D126 技能商店：面板底部的「商店」开一个 dialog；来源 skills.sh，装进技能目录，只有用户技能能卸

**问题**（用户要求）：技能面板只能「挑一个已有的」，看不到社区里有什么，也没法在网页上装 / 卸。扩展与 MCP 早就有商店（D81），技能这一层是空的。

**决定**（逐项问过用户）：

1. **入口**：技能面板（D115）底部右侧加一颗「商店」，点开是**独立 dialog**（不是面板内切页）——搜索框、结果、按地址安装、已安装列表都放得下。面板本身还是纯挑选器。
2. **搜索来源是 skills.sh**（`GET /api/search?q=`，社区技能目录，按匿名安装次数排）。它只给名字 / 仓库 / 安装量，不给说明，所以说明来自每个技能仓库里的 `SKILL.md` 前言。
3. **仓库树走 jsDelivr**（`data.jsdelivr.com/v1/packages/gh/<repo>@HEAD`）：不需要 GitHub 令牌，也没有 GitHub API 那个「匿名 60 次/小时」。jsDelivr 拒绝大仓库（403，`github/awesome-copilot` 之类）时退回 GitHub API（`/git/trees/HEAD?recursive=1`），有 gh 令牌就用，没有就吃那 60 次/小时。
4. **分两段推**（照 D113 的做法）：先把排名（一次请求）发给页面并画出来，每条技能的目录 + 说明在第二段 `skill.store.meta` 里补上（每条一次 `raw.githubusercontent.com` 的 `SKILL.md`，并发 5，磁盘缓存 12 小时）。没解析出来之前，行上写「正在确认目录和说明…」，安装按钮先不点。
5. **装到哪**：默认全局 `<agentDir>/skills`；下拉可切「当前项目」（`<cwd>/.pi/skills`）。没有打开的会话时只能装全局。
6. **安装 = 下载那一个目录**：按仓库树挑出技能目录（同名 → 忽略大小写 / 非字母数字 → 「只有一个技能目录」三级匹配；`owner/repo/tree/<ref>/<dir>` 这种地址直接指定目录），把目录下每个文件下到目标文件夹，**二进制安全**（脚本、字体、模板不会被 UTF-8 弄坏），单文件 16 MB / 合计 64 MB / 400 个文件封顶。
7. **按地址安装**：`owner/repo`、GitHub 链接（可带 `/tree/<ref>/<path>`）、本机目录都行。仓库照上面解析；本机目录递归找 `SKILL.md`（跳过 `node_modules` / `.git` / 隐藏目录），列出来再选一个装（`fs.cpSync`）。
8. **同名保护**：目标文件夹已存在时，只有它也是本商店装的（有 `.pi-store.json` 且来源一致）才覆盖；用户手工放的技能一律拒绝，提示先卸载或换名字。技能名不许带路径分隔符 / `..`。
9. **卸载**：只允许删**用户技能目录**里的（`<agentDir>/skills`、`~/.agents/skills`），项目技能只读（它们属于仓库，行上写明「要删就直接删这个目录」）；`SKILL.md` 是必备的检查关卡。**junction / symlink 只断链，不碰目标**（本机 `~/.agents/skills` 里大多是链接）。按钮 4 秒内再点一次才真删（同 D81）。
10. **生效时机**：装 / 卸之后弹窗顶部出现「改动要『重新加载』后…」+「重新加载当前会话」（同扩展管理）：pi 只在启动时扫技能，运行中的会话要 `/reload` 才认；面板的技能列表同时重拉一次。
11. **门槛**：写操作在本机 / 局域网直接放行，公网隧道只读（`skill_public`），并走桥的 `skills` 写锁（安装与卸载一个接一个）。搜索、已安装清单、按地址列目录都是只读的，隧道也能看。

**为什么：**

- **选 skills.sh 而不是自己精选仓库**：用户要的是「发现有啥可装」，安装量是唯一现成的真实热度信号；精选清单两周就过期。也不去装 `npx skills` 这个 CLI——它会替我们决定装到哪个 agent 目录，而这里只需要往 pi 的技能目录里放一个文件夹。
- **不要 GitHub 令牌也能用**：jsDelivr 的 gh 树索引没有速率门槛，`raw.githubusercontent.com` 也是匿名可读；GitHub API 只当大仓库的备用通道，这样第一次用不需要先 `gh auth login`。
- **两段推而不是等全部解析完**：一次搜索要碰十几个仓库，冷缓存时要 10 秒上下（主要花在 GitHub 备用通道上），一份「查询中…」转十秒是不可接受的；排名一秒内就该出来。
- **目录 + 文件而不是整包 `pi install`**：技能是「一个文件夹 + SKILL.md」，装成 pi 包会连带 npm 依赖、版本、settings 里的一行来源，为了一个 Markdown 技能太重；而 pi 本来就会扫技能目录（`skillRoots()`，和面板同一套顺序）。
- **只删用户技能**：项目技能是仓库里的文件，网页上的一个按钮不该去改别人的工作区；这也和 D109 把测试技能放进仓库 `.pi/skills/` 的选择一致。

**代价 / 可改：**

- 说明要一次请求一条（缓存 12 小时），大仓库的树是几 MB 的 JSON；新查询的第一次会慢，之后很快。**可改**：只解析可见的前 N 行。
- 名称匹配是启发式的：仓库里的目录改名了（例如 `code-review` → `skills/in-progress/review`）就找不到，行上会明说「仓库里没找到这个技能的目录」，只能按地址装。**可改**：拿 `SKILL.md` 的 `name` 去比（要枚举仓库里所有目录，代价高）。
- 不做「检查更新」：装过之后想更新就再点一次安装（同来源会覆盖）。**可改**：`.pi-store.json` 里已经有来源，加个 `git ls-remote` 比对即可。
- 没登录 `gh` 时，大仓库的备用通道和扩展管理共用匿名额度（60 次/小时），偶尔会有几行只有名字没有说明。
- 安装的是仓库 `HEAD`（jsDelivr / raw 的 `HEAD`），不锁 commit：上游改动会跟着变。**可改**：装完把 commit 记进 `.pi-store.json`。
- 技能内容就是指令 + 脚本，装上等于之后会让模型读它、跑它带的东西——这是技能本身的语义，不是这次的漏洞。

**验证：**

- `node bridge/tests/skill-store.mjs`（假网：`parseSource` 四种地址；树 → 目录 + 三级匹配；skills.sh 排名与第二段的说明；jsDelivr 缓存第二次不再请求；仓库预览 / 本机目录预览；装一个带脚本和 references 的技能、不越出目录边界；手工同名不被覆盖、同来源可重装、`../escape` 被拒；项目范围与无 cwd 被拒；已安装清单的 removable / from；卸载的四种拒绝、链接只断链；`frontmatter()` 的块标量）。
- `node bridge/tests/skill-store-ws.mjs`（真 bridge + WS：已安装清单只列盘上真有的、项目技能只读、本机目录当来源列出来、短查询本地报错、公网隧道装 / 卸被拒但能搜、装完磁盘上有文件、同名不覆盖、项目范围与无 cwd、卸载真删掉、junction 只断链）。
- `node probes/skill-store.mjs`（桩桥 + 真 Chromium：面板底部的「商店」、标题与两个标签、打开就要一次已安装清单、用户 / 项目分组与「只读」、两段式搜索的合并、安装发的 `source + dir + scope + cwd`、按钮「安装中…」与「已装好」回执、已装标记、卸装的 4 秒二次确认、按地址安装、关闭）。
- `node probes/skill-palette.mjs`（D115 的 16 条断言仍绿——底部多了一颗按钮，键盘 / 点击外部 / Esc 都没变）。
- 真网络抽查（本机，非仓库内）：`searchSkillStore("pdf", 5)` / `("excel", 20)` 解析 18–19/20 条，`anthropics/skills` 的 `skills/pdf` 装出 12 个文件、卸载干净；`vercel-labs/agent-skills` 列出 9 个技能。
- `npm --prefix web run typecheck`（含 i18n 1291 键 × 3 语言）干净。

## D127 「交给 agent」的正文不写记录时的会话名；待填文字只属于「我自己刚建的那个会话」

**问题（用户报的 bug）：** 在会话「bug 反馈」里记一条，点「交给 agent → 新开一个会话」，新会话的输入框里出现
`## 111111` / `待处理 · 2026-11-06 00:41 · bug 反馈` —— 那行「bug 反馈」是**上一个会话**的名字，落进新会话
就读成「别的会话的记录混进来了」。同一处还有一个真泄漏：点「新开一个会话」后按「取消」（或建失败），
`prefillNext` 留在字段里，此后打开**任何**会话（`openSession` 回包也走 `case "session"`）都会把那段笔记灌进
那个会话的输入框，并写进它的草稿（复现：取消面板 → 点会话 A → A 的输入框变成某条笔记的 markdown）。

**决定：**
- `web/src/notesheet.ts:58` `noteMarkdown()` 的头部去掉会话名，只剩 `状态 · 时间`（`## 标题` 单独一行）。
  复制 Markdown / 导出全部同一条函数，一起变。记录里的 `sessionName` 字段保留：面板里「这条记在哪个会话」
  （`notesheet.ts:647`）和列表行仍在用。
- `web/src/app.ts` `case "session"`：先取 `const handoff = this.creating ? this.prefillNext : null;` 再
  `this.creating?.finish()`，只认领「这条快照是我刚建的那个会话」的回包。
- `closeSheet()`：`sheetKind === "new"` 时清掉 `prefillNext` —— 关掉面板（取消 / 点背景）= 放弃这段待填文字。

**为什么：** 交接的落点本来就是另一个会话（D95 的「交给 agent」是跨会话的动作），正文里带来源会话名等于把
读者的注意力从「要修什么」拉到「这是谁的记录」；泄漏那一半不是审美问题，是「待填文字没有归属」——
它只能属于发起它的那次创建，创建没发生就该过期。`finish()` 在前、填字在后的顺序不能倒（`switchDraft()`
会把 `composerText` 清空），所以文字必须在 `finish()` 之前取出来，`closeSheet()` 才能在成功路径上也放心清。

**可改：** 想让来源还看得见，可以把它写进行尾的 `> 来自「X」` 引用块（用户这次选了「去掉」，别默认加回来）。

**验证：** `node probes/notes-handoff.mjs`（隔离桥 + 真 Chromium）：正文 `待处理 · 2026-11-06 00:44`
不含会话名、交到 B 的文字没漏进 A、取消新开会话后再切会话输入框为空、之后新开的 C 为空、真建出来的新会话 D
拿到那段文字。`node probes/bug-notes-ui.mjs`（37 条断言）仍全绿；`npm --prefix web run typecheck` 与 `build`。

## D136 一轮 unslop：字号 6 档、圆角 4/6/8/12/16、间距回到 4px 网格（emoji 图标保留）

> 编号说明：D128–D135 是并行分支（工作区 / 后台任务）占用的号段，这五条从 D136 起记以免撞车；合并到 `main` 时那两支尚未合入，号段暂留空。工作区那条原是 D126，见文末 D141。

审计是量出来的，不是看出来的：改之前 `web/src/styles.css` 里有 **15 种字号**（10 / 10.5 / 11 / 11.5 /
11.8 / 12 / 12.3 / 12.5 / 12.8 / 13 / 13.5 / 14 / 14.5 / 15 / 20）、**15 种圆角**（1,2,3,4,5,6,7,8,9,10,
12,14,16,18,999）、间距里 3px×33、5px×29、7px×32、9px×35、11px×15、13px×10 一堆不在 4px 网格，
`font-weight: 600` 用了 30 次。色板本身是干净的（无渐变、无 blob、无渐变字），病在刻度系统。

- **字号收到六档**：11 元信息 / 12 标签与等宽 / 13 次要正文 / 14 卡片名与控件 / 15 正文与顶栏标题 / 20 登录页。
  正文**没有**往下压：15px 是这块界面阅读时长最长的地方，压到 13 省出来的那点密度不值。
- **字重**：600 → 500（唯一保留 700 的是 tab 上那颗计数角标，它是数字不是标题）。
- **圆角**：4 / 6 / 8 / 12 / 16，胶囊仍是 999（高度一半）。
- **间距**：padding / margin / gap 的奇数值向最近的 4 的倍数靠（位移 ≤2px，负值不参与 —— 那是在抵消固定高度）。
- **彩色光晕全删**：`.dot.live` 的绿环、`.now-dot` 的青环、用户气泡闪烁时的 `0 0 22px` 青色外发光。
  状态由颜色本身说，不用辉光。
- **当前会话从「整圈强调色边框」改成 1px 边框 + 左侧 2px 强调色竖条**：四边描边太吵，竖条留位置感。
- **顶栏会话名去重**：`nowchip.ts` 那颗 chip 不再画会话名，只留工作区色点 + 工作区名 + live 点 + 待处理角标 ——
  顶栏自己的标题已经写着同样的名字，并排两个是噪音。名字仍留在 `aria-label` / `title` 上，读屏不受影响。
  `probes/nowchip.mjs` 里原来的「chip 里写着会话名」两条断言改成「chip 里没有名字 + 顶栏标题上有」。
- **没开会话时中栏整块居中成一句**（原来那句提示挂在 `.composer` 里，贴在底边，上面整片空像界面坏了）。
- **顺手修的真 bug（不是审美）**：`.chat-pane` / `.composer` / `.ops-body` 的网格列是隐式 `auto`，
  按内容 max-content 定宽 —— 一条不换行的长命令行把中栏撑到 **28026px**，手机上整段对话被挤出屏幕，
  文档横向滚动 596px。三处都改成显式 `grid-template-columns: minmax(0, 1fr)`，`.tool .cmd` 补 `min-width: 0`；
  顶栏那一排按钮在手机上本来就排不下，改成自己横向滚 + 窄屏右缘渐隐，不再带着整页一起滚。

**记号（新做）：跑着的会话，卡底一把刻度尺。**

- 一条 1px 竖线是一格，最右那条更高（8px）且是信号色 —— 那是「现在」；格子攒得越多，跑得越久。
- 步长从 1 / 2 / 5 / 10 / 15 / 30 / 60 / 120 / 240 分钟里挑，挑一个让格数落在 2–11 的：14 分钟就是
  7 格（每格 2 分），1 小时 52 分是 7 格（每格 15 分）。格子始终等距铺满卡片宽度。
- **不按时间比例画**：按比例就是一根永远填不满的进度条，而进度条会被读成「快完成了」—— agent 跑多久没有
  完成度这回事。密度本身就是读数；具体时长放在 tooltip（`已经跑了 17:42`）。
- 刷新走 `startClock()` 那个已有的 1 秒闹钟（只改格子数，不重画列表），静止的会话不占额外定时器。
- **不用动 bridge**：`SessionState.startedAt` 早就在（`web/src/types.ts:92`；`bridge/src/sessions.ts:655`
  给活会话、`:2086` 给扫出来的历史会话），之前只是没人用它 —— 我起初以为得加字段，查完发现白担心。

**没做的一件：** 图标不换（用户指定）：emoji 与 `>_ 终端` 这种 ascii 混用在顶栏仍然存在，这套界面认它就留着。

**代价 / 可改：** 正文与元信息的字号差被拉大到 4 档（15 vs 11），密集列表里看着更「仪器」也更小；
`--ease` / `--dur-1` / `--dur-2` 三个 token 只接管了 6 处入场动画与弹层，其余 `transition` 仍是各自写的时长。

**验证：** `npm run typecheck`（含 i18n 1263 键 ×3）；`web/tests/{nowchip,pillbar}-unit.mjs`；`probes/nowchip.mjs`、
`probes/round10-scroll.mjs`、`probes/round11-liveinfo.mjs` 全绿；改前/改后截图在 `.scratch/unslop/`（desktop 空态、
对话、左栏特写、390px 列表与对话）。

## D137 颜色收进 token：4 档表面、4 档线、信号色 4 档；按钮字号回 13

**背景（实测）：** 上一轮只收了字号与圆角，颜色还是散着写。`web/src/styles.css` 里 205 处硬编码 hex、
131 个不同值，99 个只用过一次；光「深色面板」这一个角色就有 36 个不同明度（`#0f141a` / `#10141a` /
`#0f1216` / `#11161b` …）。改一次主题色得改几十处，且相邻两块面板差 1 个明度根本看不出来，只让界面发脏。

**决定：**
- 表面 4 档：`--bg #0b0d10` / `--sunken #0a0e13`（代码块、内嵌槽）/ `--panel #12151a` /
  `--panel-2 #171b22`（抬起、悬停行）/ `--panel-3 #1c2129`（浮层行）。
- 线 4 档：`--line-soft #1b2028`（卡内分隔）/ `--line #232833`（卡片外框）/ `--line-strong #2f3a48`
  （悬停、输入框）/ `--line-lit #3a4658`（滚动条、刻度、浮层上缘）。
- 信号色四档一组：本色 / `-bg`（淡底）/ `-dim`（淡边）/ `-ink`（亮底上的深字），四族 accent / ok /
  warn / danger 各一套；另加 `--accent-hover #9adcf9`。
- 收尾：padding / margin / gap 里剩下的 6px→4、10px→8（就近 4 网格、平局向下，与上一轮 3→4、7→8、
  13→12 同一条规则）；`.tabs .pip` 的 9.5px 角标 → 11；`.btn` 补 `font-size: 13px`（此前它继承 body 的
  15px，于是每个按钮都比正文大一档，右栏那排「开启 Web Push / 发测试通知」在视觉上压过了它的标题）。
- 顺手清掉 6 个从未定义过的 `var()`：`--muted`、`--fg`、`--fg-dim`、`--bg-2`（`--ui-scale` / `--sw`
  是 app.ts 运行时写在 style 上的，保留）。这类声明是无效值，等于静默继承父色 —— 看着像「淡一点」，
  实际跟着父元素跑。

**为什么是分档而不是一套色阶：** 这套界面要的是「同一角色只有一个值」，不是「更多颜色」。表面 4 档够覆盖
底 / 内嵌 / 卡 / 抬起 / 浮层五种位置（内嵌比底更暗，卡比底亮一档），再多一档就没人分得清也记不住。
器质性收益在改：主题色、或「把整体提亮 2%」现在是一处改动，而改之前是 205 处 grep。

**代价 / 可改：** 一批相邻的深色被并到同一档，个别地方（`.msg .body pre`、`.fcard` 行）会看得出 1–2 个
明度的漂移；`.btn.danger` 的边框从 `#40222a` 收进 `--danger-dim`（同色），`.badge.done` 拿到了真正的
绿底（`--ok-bg`），比原来更「有状态」一点。想更淡可以只动 `--ok-bg`。

**验证：** `hex` 计数从 205 处 / 131 值降到 35 处 / 31 值 —— 35 处里 33 处就是 `:root` 里的定义本身，
另外两个是渐变 mask 的 `#000` 与 iframe 底的 `#fff`；`npm run typecheck`（i18n 1264 键 ×3）；`web/tests/{nowchip,pillbar}-unit.mjs`；
`probes/{nowchip,round10-scroll,round11-liveinfo}.mjs` 全绿。截图用隔离实例（`pi-web-client-test-dev`，端口
17868，口令 test）出，`.scratch/unslop/{e-list,f-chat,g-chat,g-mobile}.png`。

## D138 窄屏顶栏收成图标、右栏按组分段

**背景（实测 390×844，开着一个会话）：** `.topbar` 的 `scrollWidth` 400 > `clientWidth` 390 —— 九样东西
（工作区 chip、会话名、六颗按钮、字号）挤在一条线上，最后那颗「Aa」被切在半路，而左右两侧的折叠按钮
在手机布局里本来就 `display:none`，没有第二条路进得去。桌面端右栏则相反：`通道 / 快捷键 / 关于` 三组
只靠 `.queue` 的 8px gap 排着，组标题 12px、`.hint` 没有规则落回 body 的 **15px**（比标题还大），
按钮 33px 各自浮着，看着像「三坨东西一起挤在顶上」。

**决定：**
- 顶栏那六颗「图标 + 文字」按钮由 `App.wideBtn()` / `setWideLabel()` 拆成 `<span class="ic">` 与
  `<span class="lb">`；`@media (max-width: 560px)` 只把 `.lb` 收掉，按钮回成 28px 方块。
  **切分用的是 `tr()` 之后的文案**（形如「📂 产物」，第一个空格前是图标），所以英文 / 日文不用另立 key，
  也不必为窄屏写第二套 i18n。文字仍在 `title` 与 `aria-label` 里。
- 同一段 media 里：`.topbar` 缝 8→6、两侧 padding 16→12；`.now-chip .now-ws` 收掉（工作区名 70px，
  而这一排真正要读的是会话名，收掉后标题那格从 0px 回到 ~124px）；`.icon-btn[data-act="files"]` 隐藏 ——
  「📂 产物」与「📁 文件管理器」收成图标之后是两颗并排的文件夹，窄屏上无法区分，留产物、盘符浏览回桌面端。
- 右栏：`.queue` 的 gap 归零，改由 `.queue h2` 自带节奏（上边 14px + 1px 发丝线、下边 8px，`:first-child`
  去掉线），三组因此读成「一组说明 + 一组控件」；`.queue .empty`（「没有等你的事。」）从居中的空卡片改成
  一行 12px 左对齐的状态字；`.queue .hint` 补上规则（12px faint，`关于` 那行才用等宽）。
- 顺手把 `renderQueue()` 里写死的 `style.display/gap/flexWrap` 换成 `.queue-tools` 类。

**为什么不是收进「⋯」菜单：** 这几颗都是 dialog（终端 / 内网通 / 随手问 / 记录），在手机上是主要入口，
收进二级菜单等于多点一次；图标 + `title` 的代价更小，而且桌面端不受影响。

**代价 / 可改：** 手机上图标没有文字，`>_` 与 emoji 靠记忆（用户已定 emoji 图标保留）；`文件管理器` 在
≤560px 不可达。断点 560 是量出来的：560 以下收文字，561–899 恢复文字后最坏情况（产物 + 文件管理器同现）
仍不溢出（实测 561px 时 `scrollWidth == clientWidth == 561`）。

**验证：** 390px 开会话：`scrollWidth == clientWidth == 390`，顶栏内容 chip 26 + 标题 124 + 6×28；
390 / 620 / 900 / 1440 四档 `documentElement.scrollWidth` 都等于视口；`npm run typecheck`（i18n 1264 键 ×3）、
`web/tests/{nowchip,pillbar}-unit.mjs`、`probes/{nowchip,round10-scroll,round11-liveinfo}.mjs` 全绿。
截图 `.scratch/unslop/{y390-top,q2-right,m-queue,d-chat}.png`。

## D139 抽屉标题升一档；色点选中态改成「缝 + 环」

**背景（实测 `外观与语言`）：** `.sheet-title` 是 13px `--dim`，而它下面的组标题 `.levels-label` 是
12px `--dim` —— 一页的名字和「语言 / 字号 / 颜色」几乎一样重。色点的选中态是 `border-color: var(--text)`
的 2px 白环，压在最浅的那颗（`ice #7dd3fc`）上边界发糊；未选的有 `inset` 黑边、选中的又多一道白环，
两种描边语言混在一排 26px 的点上。悬停还 `transform: scale(1.08)`，一排小点会跟着抖一下。

**决定：**
- `.sheet-title` → 14px / `500` / `--text`（去掉对中文空转的 `letter-spacing: .05em`）。所有抽屉共用，
  这一处改动让「这一页叫什么」重新比组标题重一档。
- 色点：`border: 0`，选中态用 `box-shadow: inset 黑边, 0 0 0 2px var(--panel), 0 0 0 3px var(--text)` ——
  环画在外面、中间垫一道面板色留缝，六颗点尺寸不变，浅色点上也能一眼看出选了哪颗；悬停改成 2px
  `--line-strong` 的环，不再缩放。
- 「外观与语言」里的 chip 换成 `var(--sans)`：那几颗写的是语言名 / 字号名，不是 id 也不是数字。
  **只在这一页**（`.display-sheet .chip`）—— 别处 `200K` / `high` / `gpt-5.2` 那些 chip 保持等宽。

**代价 / 可改：** chip 的选择语言仍是「填色 + 深字」，色点是「缝 + 环」，两者依旧不同 —— 因为色点
本身就是颜色，填色无从表达「已选」。真要统一得把全站 chip 的选中态一起改（`model-sheet`、`settings-sheet`
都有），不属于这一轮。

**验证：** `npm run typecheck`（i18n 1264 键 ×3）、`web/tests/{nowchip,pillbar}-unit.mjs`、
`probes/{nowchip,round10-scroll,round11-liveinfo}.mjs` 全绿；截图 `.scratch/unslop/look4.png`（外观与语言）、
`settings.png`（pi 设置，确认标题改动在别的抽屉上也立得住）。

## D140 抽屉表单只留两档字号；聚焦态回到一条规则

**背景（逐个抽屉量出来的）：** 同一个「新建会话」里输入框有 12 / 13 / 14 三种字号、textarea 12、
select 14；笔记抽屉更齐，11 / 12 / 13 / 14 全有（`.note-meta-input` 11、`.note-title` 14、
`.note-body` 13）。这些是各功能各写各的 `font-size` 留下的，不是刻意分档。聚焦态更散：新建会话的
会话名输入框吃浏览器默认的**白 outline**（3px `--text`，比信号色环还响），模型抽屉吃 3px，
笔记编辑器是青 border + `color-mix` 外圈 —— 同一个抽屉系统里三套语言。

**决定：**
- `.sheet :where(input:not([type=checkbox]):not([type=radio]), textarea, select)` 统一 13px；
  **用 `:where()` 把优先级压到 0**，各控件自己的 `.mono` / `.note-meta-input` 等更具体的规则照旧生效
  （等宽路径那类保持 12px），只有「什么都没写」的控件才吃这个默认值。
- 同样用 `:where()` 给 `:focus` 兜底：表单控件 `outline:none` + `border-color: var(--accent-dim)`，
  button / a / checkbox / radio 的 `:focus-visible` 给 2px 淡青环。控件自己写了 `:focus` 的
  （`.notes-search`、`.note-title`、`.composer textarea` 等）依旧走自己的。
- 删掉 `.new-sheet .ns-input` 的 14px、`.ns-adv-grid textarea` 的 12px、`.note-title` 的 14px、
  `.note-body` 的 13px（都回落到 13）；`.note-meta-input` 11→12；`.session-info-head` 与
  `.notes-tabs` 这两个「忘了写字号、继承 body 15px」的容器补成 13 / 12。
- 抽屉标题与色点上一条见 D139；这一轮不改信息架构，也不碰 `.chip.on` 的填色选中态（全站共用）。

**为什么不是逐抽屉列一张字号表：** 这些抽屉不是各自的产品，是同一个「设置 / 新建」壳层。它们标点点的
控件不该各带一套刻度；一处默认 + 少数有理由的例外（等宽路径 12px）比 14 条分散规则好维护。

**代价 / 可改：** 新建会话的会话名输入框从 14px 掉到 13px，笔记标题也从 14 掉到 13（仍保留 500 字重），
在「特大」字号偏好下都跟着 `--ui-scale` 一起放大。想让「新建会话」的名字更像标题，可以单独给
`.new-sheet .ns-input:first-of-type` 加一档，但那会让这一轮的规则重新破例。

**验证：** `fs-sheet.mjs` 逐抽屉统计控件字号：`new` 从 12/13/14 收到 13（外加 5 个 checkbox 12）、
`notes` 从 11/12/13/14 收到 12/13、`model` / `keys` / `artifacts` 无刻度外值。
`npm run typecheck`（i18n 1264 键 ×3）、`web/tests/{nowchip,pillbar}-unit.mjs`、
`probes/{nowchip,round10-scroll,round11-liveinfo}.mjs` 全绿；截图 `.scratch/unslop/s-{new,model,notes,peer}-1440.png`
与 `new-focus.png`（聚焦框现在是淡青边，不是白环）。

## D141 工作区：组 id 就是工程根，读路径不跑 git，临时组补完就清掉

> 编号说明：本条在工作区分支里原是 D126；合并 `main` 时 D126 已被「技能商店」占用，顺延到 D141。正文与它描述的代码没变。

决定（桥侧，`bridge/src/workspaces.ts` + `bridge/src/git.ts` 的 `gitRoot()`）：

- 组 id = 归一化工程根的小写形式（反斜杠转正斜杠、折叠重复斜杠、去尾斜杠、盘符根保留 `F:/`，再小写）；手动组是 `manual:<随机>`。工程根本身保留原样大小写，只用于显示。
- 工程根推导只用 `git rev-parse --git-common-dir`：结果以 `.git` 结尾就取父目录 —— 普通克隆与它所有 worktree 的 common dir 都指向同一个 `<主仓>/.git`，五份 worktree 因此并成一组；否则用 common dir 本身（`separate-git-dir` / bare 的退化）。跑不通（非 git、目录已不存在、没装 git）就用 cwd 本身，不抛错。
- `Sessions.list()` 只查状态文件里的 `keys` 缓存，同步、绝不跑 git；缓存缺失时先拿 cwd 当工程根（新会话立刻有组可站），`resolve()` 异步补缓存，补完把「按 cwd 建出来的临时组」清掉。缓存落盘，重启不重算。
- 拖动写 `overrides`（sessionId → 组 id），优先于 cwd；「放回工程」= 删这一条；删除会话时一并清掉，不留悬空指向。
- 只允许删空的手动组：派生组删了下次还会回来，那是假动作。
- `ws.*` 五个动作与其他管理动作一样先过 `requireStepUp()`；`session.list` 与 `manage` 广播都顺带带上工作区快照，每条会话多一个 `ws` 字段。

为什么：会话列表每次广播都要重算一遍归属，14 个 cwd × 30–80ms 的 git 子进程会让左栏发卡；而 worktree 合并只能靠 `--git-common-dir`（`--show-toplevel` 给的是 worktree 自己，五份就是五个组）。临时组不清掉，worktree 会在补齐后同时留下「按 cwd 那个组」和「主仓那个组」，等于合并失败；但被 override 指着的组不清 —— 用户拖进去的东西不能因为一次探测消失。

代价 / 可改：没缓存过的 cwd 第一次显示时可能先落在以自己为根的组里，几百毫秒后换成真工程根（并触发一次广播）；`keys` 只增不删，目录改名会留下旧条目（无害，没人再指向）。

验证：`node --experimental-transform-types bridge/tests/workspace-unit.mjs`（临时目录里真 `git init` + `git worktree add`：worktree 与主仓同组、非 git 各自成组、盘符根与不存在的目录不炸、override 优先与放回、缓存命中与重启都不再跑 git、只删空的手动组、forget 清 override）。

> 编号说明：下面 7 条来自工作区分支，原编号 D127–D133；合并 `main` 时 D126 已被「技能商店」占用、D127 被「交给 agent」占用，工作区那条也已顺延成 D141，所以这 7 条顺延到 D142–D148。正文与它描述的代码没变（正文里指向旧编号的地方已一并改过）。

## D142 左栏：工作区 → 会话两级树；★ 只排组内，归档是全局尾部

决定（前端：`web/src/tree.ts` 的 `buildTree()` + `web/src/app.ts` 的 `wsSection()` / `renderSessions()`）：

- 左栏从「置顶 / 会话 / 已归档」三段平铺改成「工作区组 → 会话卡」。组间顺序：组里有待处理（待回答 / 待确认）的在前 → 最近活动倒序 → 名字；组内顺序：★ 优先（`pin` 数组里的相对顺序）→ 手动顺序 → 新建时间倒序。`order` 里没有位置的算「新会话」，排在手排过的上面 —— 跟 `bridge/src/manage.ts` 的注释约定一致，不是前端另发明一套。
- 归属只信桥给的 `ws`（`hello` / `sessions.list` / `manage` 广播 / `workspaces` 广播都带快照）；`ws` 在快照里查不到（旧桥、桩桥、脏会话）才按 cwd 归并，空 cwd 进「未分组」。worktree 合并是桥的事（D141），页面不重复推导 git。
- 组头：色点（按组 id 稳定哈希取 `ACCENTS` 同款色值）+ 名字 + 待处理角标「待 N」+ 会话数。点组头整组收起，收起集合存在既有的 `pi.prefs.wsCollapsed` 里（与 accent / scale 同一份偏好，不新开 storage key）。
- 空的手建组显示一行空态；派生的组不会为空。过滤时打中组名 → 整组留下（收起状态不影响过滤）；否则组内只留命中的会话，一条都不剩的组整个消失（不画空组头）。
- 归档仍不属于任何工作区，是末尾的全局分区（`已归档` 段），折叠交互不变。
- 跨组拖拽留给 #99（要 `ws.move` + override）：现在把卡片拖进别的工作区会被忽略，组内重排照旧。

为什么：这是 #72「工作区」的第二步（#94 给数据、#95 给树）。★ 在横栏（D125）里仍叫「置顶」，但左栏变成两级树之后，单独的置顶分区会跟组内顺序打架 —— 同一个会话既出现在置顶区、又得出现在它自己的组里，收起组时更说不清它该不该跟着藏。所以左栏把 ★ 降级成「组内排前」，横栏的置顶语义原样保留。组头角标沿用样张 `a-two-row.html` 的「待 N」，让「哪个工程在等我」一眼可见。

代价 / 可改：

- 左栏不再有独立的「置顶」分区：想找 ★ 的会话，要么看横栏，要么看它所在组的组首。这是 D125「打开即置顶」在左栏留下的观感变化，可改。
- 收起状态按组 id 记：手动组删掉再建（新 `manual:<随机>`）不继承旧收起状态。
- `buildTree()` 每次渲染重算（O(n log n)），几十个会话无所谓；真到几百个再说。

验证：`node --experimental-transform-types --test web/tests/tree-unit.mjs`（19 例：分组 / worktree 并组 / 手建组空态 / 未分组兜底 / 组间与组内排序 / ★ 不跨组 / 过滤打组名整组留与打会话名拆组 / 归档隔离）、`node probes/workspace-tree.mjs`（桩桥 + 真 Chromium：多个组、worktree 并组、收起后刷新记忆、过滤整组、归档不在组内）、`node probes/pin-auto-open.mjs`（横栏与 D125 的行为不受影响）。

## D143 拖拽整理：落点判定是纯函数，跨组只发 `ws.move`（`#99`）

- 把「指针 y → 目标组 + 插入位置 + 那条 2px 线画在哪」抽成 `web/src/drag.ts` 的纯函数：`hitTest()` 吃一组矩形（组、组内可见卡片、可选的「放回工程」），返回 `{wsId, index, line, pool}`；`planDrop()` 把落点换算成三种动作。渲染层只负责量矩形（`getBoundingClientRect()`）和画线，壳 B 的浮层将来复用同一份判定。
- 三种动作：同组 → `arrange`（沿用 `commitArrangement()` 读 DOM 的既有路径）；跨组 → 一条 `{type:"manage", action:"ws.move", ids:[id], wsId:<目标组>}`；拖到「放回工程」→ `ws.move` 且 `wsId: ""`（桥那边 = 删掉 override，回到 cwd 推导）。
- 跨组**不重写 order 数组**：`ws.move` 只写归属，别的组的顺序一根手指都不碰（D142 里「拖进别的工作区会被忽略」到此作废）。
- 「放回工程」这条落点只在拖动期间出现在树尾；归档会话不给拖（归档是全局分区，拖进任何工作区都说不清语义）。
- 高亮就一条 2px 线（`position: absolute` 贴在树容器里），拖离树 / Esc / 窗口失焦都清掉并让松手变成空操作。

为什么：落点判定全是几何边界条件（组间几像素的空隙、空组、末张卡下沿），靠浏览器探针猜像素既慢又脆 —— 抽成纯函数后单测能一口气列出 12 种；而 `ws.move` 与 `arrange` 的分工是桥既有协议定的，前端不该为了「顺手」把整个 order 重写一遍（那等于把所有组的排序都塞进一次拖动里）。

代价 / 可改：

- 「放回工程」用 `workspaces.keys` 把 cwd 折到工程根来猜目标组名；桥没给 keys 时退化成 cwd 本身，所以文案可能只说「按 cwd 回到推导出来的组」。可改。
- 收起的组也是落点（线画在组头下面），但不会自动展开：拖进去之后还得自己点开。
- 组内重排仍按 D142 的规则重算整份 `order`（既有行为），跨组那一路才刻意不碰。

验证：`node --experimental-transform-types web/tests/drag-unit.mjs`（12 例：上半/下半、末张下沿、空组、组间空隙、拖太远、`放回工程` 优先、`planDrop` 三种动作、`moveTo`）、`probes/workspace-drag.mjs`（桩桥 + `page.mouse` 真拖：跨组发 `ws.move` 且刷新仍在、组内发 `arrange`、放回工程 `wsId:""`、空组落点、Esc / 失焦 / 拖离清高亮且不发光、树外无可拖元素）。

## D144 工作区改名 / 删除 / 新建：复用会话卡片的手感，能删不能删先说清楚

决定（前端：新文件 `web/src/wsmanage.ts`（纯逻辑）+ `web/src/wsmenu.ts`（菜单外壳），以及 `web/src/app.ts` 的 `wsSection()` / `openWsMore()` / `startWsRename()` / `commitWsRename()` / `createWs()`）：

- 组头右边一颗 `⋯`（贴着会话卡片的 `card-act` 脾气：指着组头才出现，触屏常显），点开是两行：重命名 / 删除工作区。菜单外壳直接复用置顶胶囊的悬停气泡（`.pin-menu` / `.pm-item`，见 `pinmenu.ts`），只加一行 `.pm-why` 放「为什么删不了」——**不发明新弹层**，用户也不用学第二套。
- 删不掉时不藏这一行，而是置灰 + 下面一行说明：`跟着目录走，不能删` / `还有 N 个会话，先把它们拖回工程或删掉`。把选项藏起来会让人以为这个组漏做了删除。
- 改名是组头就地换输入框（同一个 `.rename-input`，Enter 提交 / Esc 取消 / 失焦提交、重画后恢复光标与全选），跟会话卡片重命名完全同一套手感。
- **空名字 = 恢复成目录名**：发出去的是空串，桥的 `rename()` 原样存空，显示时由 `buildTree()` 的 `nameOf()` 回落到目录名（手动组没有目录 → 回落「新工作区」）。名字先洗再发：折叠内部空白、去首尾、截 80（与桥的 `slice(0, 80)` 同一套规矩）；洗完跟原来一样就一个字都不发（空发一条只会让树重画一次）。
- 树底加一行虚线「＋ 新建工作区」：发 `ws.create {name: ""}` 要一个空组，**等 `workspaces` 广播里出现新的 `manual` 组再进改名态** —— 组 id 由桥生成（`manual:<随机>`），页面猜不出来。5 秒没等到就放弃进改名态（怕广播丢了以后，下一次手建组被误当成刚点的那一个）。
- 「这个组能不能删」是纯函数 `dropBlocker(group, sessions)`，页面在点之前就用它决定置灰和文案；桥那边 `drop()` 仍是权威（`bridge/src/workspaces.ts:239`：找不到 / 非 manual / `overrides` 里有人 → 拒绝）。两处口径一致，页面不假装自己删得掉。

为什么：改名、删除、新建这三件事全在「组头」这一小块地方发生，弹大面板会把左栏的树整个盖住，而用户看着的恰恰是那棵树。已有一张能贴在任何锚点下方、会跟着滚出屏幕的东西叫 `.pin-menu`，复用它的成本和观感都最低。名字与可删性抽成 `web/src/wsmanage.ts` 的纯函数，是因为这两条规则桥和页面各有一份 —— 写成一处（单测里先红后绿）才能保证「置灰的按钮」和「桥真的拒绝了」说的是同一句话。

代价 / 可改：

- 删除只可能是空的手动组，所以「删完组、会话回到按 cwd 推导」在正常路径上根本走不到：桥的 `drop()` 会先因为 `overrides` 里有人而拒绝。前端因此不做任何「假装挪回去」的动作；真正让会话回到 cwd 的是 `groupFor()` 的 override 回落（脏快照 / 旧桥时兜底）。想允许「删组顺手把人挪出去」，得改桥的语义，那是另一张票。
- `⋯` 只在 hover / 焦点里出现：不看说明的人可能找不到删除入口（触屏常显）。可改。
- `wsCreatePending` 是 5 秒的时间窗而不是请求 id：桥没回话时，5 秒内别处冒出来的新手动组会被误当成「刚点的那一个」并进改名态。可改（等桥给 create 回执）。

## D145 壳 A 两行制的两条横栏；布局偏好只存 id、未实现的壳回退 A

决定（前端：`web/src/layout.ts` + `web/src/app.ts` 的 `renderWorkspaceTabs()` / `renderSessionRow()` / `openDisplaySheet()`）：

- 顶栏下固定两行：行 1 是工作区标签页（横向一条、当前组高亮 + 底部 accent 边、有待处理的组带一颗点、点标签 = 打开那组排最上面的一颗 —— ★ 优先，跟左栏同一份 `buildTree()` 顺序；手建的空组没有会话可开，点它展开左栏）；行 2 是「当前会话那颗（`NowChip`，固定最左）+ 本区会话胶囊 + ＋」。原先「收起左栏才出现」的置顶横栏被行 2 取代，不留第二条横栏。
- 行 2 里不再摆条头、空态文案（最左端就是当前会话，不需要标题），`PillBar` 的折叠能力原样保留：装不下仍折「＋N」。
- 行 2 的胶囊在本区未知（旧桥 / 桩桥不发 `workspace` 快照）时**回退到 `manage.pin`**：不知道「本区」时，置顶区至少是用户自己挑过的那批。有快照时显示当前会话所属组的会话（★ 优先），并排除当前那颗 —— 它已经在最左端了。
- 标签页溢出（`scrollWidth > clientWidth + 1`）时给容器加 `.fade` 做右端渐隐（`mask-image`），并把滚动条藏掉：深色顶栏下面一条细滚动条像条裂缝，点标签前先摸滚动条也不对。左栏还在，少一个入口不会丢东西。
- 设置 → 外观与语言新增「工作区布局」四颗 chip（每颗一张纯 CSS 示意图）。偏好写进既有的 `pi.prefs.layout`（稳定 id `a`/`b`/`c`/`d`，标签过 `tr()`，不存译文），默认 `"a"`；读口是 `layout.ts` 的 `layoutPref()`，渲染走 `activeLayout()`。这一票只把 A 加进 `IMPLEMENTED`，其余三颗 `disabled` + 悬停「下一步补上」；「恢复默认」把布局带回 A。
- 存着的壳还没实现时（例如用户手改或 #98 分批上线）渲染回退 A，但**不**改写存着的值：`activeLayout()` 只降级渲染，`layoutPref()` 照原样读回。

为什么：壳 A 是「布局先定下来」的那一版，行 1 回答「有哪些工程」、行 2 回答「这个工程里有哪些会话、我现在在哪」。行 2 的会话胶囊必须与左栏同一份顺序，否则收起左栏和展开左栏会给出两种排序；两行共用 `buildTree()` 之后，「本区」只剩一个定义。标签页点一下开组首而不是只展开组，是因为横栏的高度预算换来的应该是「直接进入」，否则两行比左栏还慢。

代价 / 可改：

- 行 2 常显会在 900–1100px 宽时吃掉一点纵向空间（顶栏 + 标签 + 胶囊约 90px）。
- 没有 `workspace` 快照时行 2 回到置顶列表，与有快照时看到的集合不同 —— 这是给旧桥留的退路，桥升级后自然统一。
- 标签点击只开组内第一颗：想开到别的会话仍要开左栏；标签上也不显示会话数（待处理点已经占了右侧的位置）。

验证：`node --experimental-transform-types web/tests/layout-unit.mjs`（6 例：默认 A / 四种 id 与顺序 / 大小写与空白 / 乱值回 A / 只实现 A 时回退 / label 不是 id）、`node probes/workspace-layout.mjs`（桩桥 + 真 Chromium：两行都在且顶栏不再挂那颗、标签溢出渐隐无横滚条、点标签切组、胶囊 ★ 优先、设置四颗 chip 只亮 A / 其余 disabled、偏好写进 `pi.prefs` 且刷新保留、没实现的壳回退 A 但值不丢、恢复默认回 A、800px 收起两行），以及 `probes/pin-auto-open.mjs` / `probes/nowchip.mjs` / `probes/workspace-tree.mjs` 全绿。

## D146 打开不改排列（废止 D125）：打开 ≠ 置顶 ≠ 解归档，桥的 `opened` 成了纯读操作

**问题：** D125 让「从任何入口打开会话」都顺手把会话插到 `pin[0]`，归档的还顺带解除归档。D142 把左栏改成工作区两级树之后，★ 只剩「组内排前」的意思 —— 于是每打开一个会话，用户手工拖出来的跨组 / 组内顺序就被悄悄改了一次（打开一个归档会话更离谱：它自己跳出了归档区）。报障是「我只是点开看看，排列全乱了」。

**决定：**

- **桥侧不再改写**：`Manage.opened()` 与 `Sessions.opened()` 删除。`manage` 的 `opened` 动作保留（旧缓存 bundle 还会发），但它只 `broadcast` 一份 `manageSnapshot()` 就返回 —— **打开 = 一个读请求**，作用只是把旧页面乐观改过的 `manage` 纠正回来。
- **前端不再发**：`web/src/app.ts` 的 `markOpened()` 整个删掉（连同 `openSession()` 末尾与 `case "session"` 里那两处调用）。打开会话就只是打开会话：不动 `pin`、不动 `order`、不动 `archived`。
- **归档会话可以打开**，但它仍然在归档里；要出来得自己点「恢复」。
- 横栏（PillBar）的折叠语义不变：装不下一行就折末尾进「＋N」，当前会话在条里时不被折。当前会话**不在**条里（没置顶）时由顶栏那颗 NowChip（#96）指认身份 —— 这正是 D125 当初要解决的问题，现在由另一处承担。

为什么：D142 之后 ★ 是「组内排序」而不是「另一个区」，跨组自动改排序必然打乱用户手工拖出来的顺序，且这种改动是静默的、不可回滚的。用户打开会话的意图是「看内容」，不是「重排左栏」；把副作用从一个纯导航动作里摘干净，比任何补偿逻辑都可靠。归档同理：打开 ≠ 恢复。

代价 / 可改：

- 横栏里找不到「正在说话但没置顶」的会话，得抬头看顶栏的 chip。若将来 chip 被拿掉，这条得重新评估。
- D142 里「横栏的置顶语义原样保留」这句仍然成立：☆ 照样置顶、横栏照旧只放 ★，变的只是「打开替你按了一次 ☆」。
- `manage` 的 `opened` 动作留成了空壳：它现在没有任何写入语义，只在旧页面自纠时有用；等前端缓存彻底换代可以删。删除时机写在代码注释里。

验证：`node bridge/tests/manage-check.mjs`（2b：打开归档会话不解归档/不置顶、打开普通会话不动 `pin`/`order`、`manage.json` 一个字节都没变、陌生 id 不落盘）、`node --experimental-transform-types bridge/tests/workspace-unit.mjs`、`node probes/pin-auto-open.mjs`（深链与本地点开都不动 `MANAGE`、前端一条 `opened` 都不发、归档会话打开后仍在归档、折叠「＋N」不变）、`node probes/pin-current.mjs`（切到未置顶会话后横栏里没有 `.cur`）。

## D147 迁移预览：首次见到分组前弹一次，数字数自同一棵树，确认才写标记

**问题：** 左栏从三段平铺变成工作区分组（D142）是一次看得见的搬家：会话换了位置、★ 换了含义。用户第一次打开新版时就该知道「会变成什么样、我手拖的那些还在不在」，而不是先看到一片陌生布局再自己猜。但预览里的数字如果在前端另算一套，迟早跟左栏打架。

**决定：**

- **弹一次**：`pi.prefs.wsIntroSeen` 不存在时，进页面第一次渲染左栏后弹 `.ws-intro-sheet`：一句说明 + 汇总「会建 N 个工作区、M 个会话，其中 K 个是你拖过的」+ 每组一行（色点 / 组名 / 会话数 / 组内被拖过的条数）。
- **数字只有一处来源**：全部读 `renderSessions()` 已经算好的 `buildTree()` 结果（左栏画的就是它），「拖过的」= `workspaces.overrides[session.id] === group.id`。
- **确认才写**：「就这样开始」写 `pi.prefs.wsIntroSeen = true` 并收层；「以后再说」/「稍后」/点背板只收层、什么都不写，所以下次打开还会弹。标记与 accent / scale / `wsCollapsed` 同一份 `pi.prefs`，不新开 storage key。
- **同一张页面只弹一次**（`wsIntroShown`），否则每次 `renderSessions()` 都把它推上来；有别的 sheet 开着时也不弹（不叠模态）。
- **没有 workspace 快照就不弹**（旧桥 / 桩桥）：分组本来还没发生，预览无从谈起。
- **`navigator.webdriver` 为真时跳过**：62 个 chromium 探针与 14 个直连真桥的用例都跑在全新 profile 里，等于每次都「第一次打开」，这张模态会把它们全挡在下面。真人打开的窗口没有这个标记。

为什么：搬家的信息必须在搬家前给到，且必须与搬家结果同源 —— 同一个 `buildTree()` 保证「预览说的」与「左栏画的」永远一致，不用维护第二份推导。标记放在既有偏好里、确认才写，保证「取消 = 没发生过」。

代价 / 可改：

- 自动化环境看不到这张层（靠 `navigator.webdriver`），要测它只能用探针里的 `addInitScript` 摘掉这个标记 —— `probes/workspace-migrate.mjs` 就是这么做的。
- 预览只报数，不提供「撤销这次迁移」：`overrides` 与 `pin` 本来就一个都没改，没什么可撤销的。
- 「拖过的」按 override 计：手动把会话拖回它 cwd 本来所属的组时 override 仍存在，仍算一次「拖过」。无害，可改。

验证：`node probes/workspace-migrate.mjs`（桩桥 + 真 Chromium：首次打开弹、行数=组数、每行名字与会话数与左栏逐项一致、归档不计入、拖过数=2、确认后 `pi.prefs.wsIntroSeen` 落盘且刷新不再弹、取消不写标记且刷新仍弹、关掉后左栏交互不再把它推上来）、`node probes/workspace-tree.mjs`（有 webdriver 标记时不弹，左栏交互不受影响）。

## D148 四套壳共用一个交互内核：`shells.ts` 说「哪几块拼在一起」，`app.ts` 只换装配（`#98`；「标签行不接拖拽」已被 D149 推翻：固定组可鼠标拖拽重排，`#124`）

决定（前端：新文件 `web/src/shells.ts` + `web/src/app.ts` 的 `paintShell()` / `placeNowChip()` / `renderShellAxes()` / `renderWsPop()`）：

- 壳与壳的区别被压成一张表：`shellParts(id)` 返回 `{ tabsRow, sessionRow, chipTop, chipOpensOverlay, rail, strip }`。A 是两行横栏（标签行 + 「当前那颗 + 胶囊」行）；B 只剩顶栏那颗（点它开工作区浮层）；C 加一根常驻 48px 竖列（色点 + 两字头 + 待处理角标）；D 只在左栏收起时缩成 52px 色点条。标签行 / 竖列 / 色点条**都不接拖拽**，可拖的只有左栏树和 B 的浮层 —— 入口多一份，落点规则就多一份分叉，不值得。
- 「当前在哪」那颗（`NowChip`）只有一个实例，套一层 `<button data-act="where">`，挂载点随壳换：A 桌面在行 2 左端，B/C/D 在顶栏；**窄屏四套统一进顶栏**（窄屏下 A 也没有行 2，那颗不进顶栏就消失了），窄屏点它 = 打开「会话」那一页。`renderPanes()` 每次都重摆（断点跨越时落点会变）。
- B/C/D 点顶栏那颗开的是**同一张**工作区浮层（`role=dialog`，按组分段、段头切组、会话行可拖）：浮层里的落点判定就是 `hitAt()` / `planDrop()`，只是把量测范围从左栏 DOM 换成浮层 DOM（`dropScope()` 一个返回值的事），松手照旧只发 `ws.move` / `arrange`。浮层没有第二套拖拽实现。
- 竖列（C）与色点条（D）同吃一份 `railModel(tree.groups, currentWsId())` 纯函数（`railLabel()` 取前两字，emoji 代理对不劈开），高亮 = `aria-current` + 描边；D 的色点条还兼任「展开左栏」的按钮（▸）。
- `IMPLEMENTED` 现在是四套全量（D145 的「未实现回退 A」逻辑保留但成为死代码保险）：`activeLayout()` 不认识的值仍回 A 且不改写存储。
- 换壳时 `paintShell()` 只做装配级动作：浮层关掉、那颗挪窝、`renderPanes()` 重摆 —— 数据、树、拖拽纯函数一行不动。

为什么：票面要求「不要复制粘贴四份渲染逻辑」。四套壳真正的差异只有「哪些块在场、那颗停在哪」，把它们压成一张表之后，新增壳 = 加一行表；而会话归属、顺序、拖拽语义全部只有一份实现，「来回切不丢当前会话」就不再是四个 if 各自保证一遍，而是根本不随壳走（`currentId` / `prefs` 都在壳外）。

代价 / 可改：

- C 的竖列 / D 的色点条只有切组一个动作，组内会话要开左栏或浮层 —— 48px 里塞会话列表不现实，入口交给那颗。
- 浮层窄屏不提供（窄屏点那颗直接去会话页）：手机宽度里再叠一层浮层是套娃。
- `chipOpensOverlay` 在 A 里恒 false，那颗在 A 桌面是指示器不是按钮 —— 语义由 `data-open` 表达，探针据此断言。

验证：`web/tests/shells-unit.mjs`（8 例：四套拼法互异 / A 两横栏 / B 全收 + chipTop + overlay / C 竖列 / D 色点条 / 未知 id 回 A / railLabel 代理对 / railModel 计数与高亮）、`web/tests/layout-unit.mjs`（改为「四套都实现：存什么按什么画」）、`node probes/workspace-shells.mjs`（新探针：对 a/b/c/d 各跑一遍 —— chip 点得动且刷新保留、收起态看得到当前会话（A 行 2 / B·C·D 顶栏）、C 竖列高亮 / D 色点条高亮、各壳切组、B 浮层拖拽真发一条 `ws.move` 且重画后归位、各壳新会话面板开得出来、切会话后刷新仍记得）、`probes/workspace-layout.mjs`（第 5–11 段改为四颗都能点、无「下一步补上」、手写 layout=c 直接按 C 画），以及 workspace-tree / workspace-manage / workspace-drag / pin-auto-open / nowchip / pin-current 全绿。

## D149 工作区标签行：并进顶栏的一行、只画 N 颗、固定组打头 —— 并且**推翻 D148 的「标签行不接拖拽」**（`#119`–`#124`）

**问题：** 左栏一收起，界面上就没有「我在哪个工作区、还有哪些组、怎么切过去」的入口；而壳有四套（D145 / D148），给每套壳各画一条标签行就是把装配逻辑复制四遍。组数没有上限，标签不能无限吃顶栏。用户还想自己排「哪几个组排在最前面」。

**决定：**

- **并进顶栏**：标签行是顶栏里的一行（壳 A 是第二行；B/C/D 只留「当前那颗」，点它开工作区浮层），紧跟在折叠左栏的 ◧ 后面、和工具按钮同一条线。窄屏（800px）不破版：槽内横滚、不占滚动条高度，`＋N` 挂在槽外，所以横滚时它不动。
- **只画 N 颗**：N 由桥端下发（默认 3，可 1–5），超出的不画，剩下的组数报在 `＋N` 上，点开只列被折叠的那些。**当前组永远在圈内**：圈满时挤掉最后一个补位组 —— 不该出现「我在这组，但标签行里没有它」。
- **固定组打头**：固定是落到桥里的（`ws.tabs { pinned }`），固定组排在标签行最前、左栏组头带「已固定」标记、刷新后还在；名额满了点固定就置灰并写明原因，不静默失败。
- **只有固定组能拖**（本条的破例）：固定组之间可以用鼠标拖着换顺序 —— 位移过 4px 才算起拖（否则仍是那次点击切组），落点 2px 竖线，松手发一条 `ws.tabs { pinned }`，顺序没变就一个字都不发。补位组与固定组长得一样但拖不动，悬停说清「先在组头菜单里固定」。**只重排、不增删**：把补位组拖进固定区、把固定组拖出区都不做。
- **推翻 D148 的「标签行 / 竖列 / 色点条都不接拖拽」中的标签行那一半**：D148 的理由是「入口多一份，落点规则就多一份分叉」，在 #118 R7/R15 面前被刻意破例 —— 票面要的就是「固定组可鼠标拖拽重排」，而固定组只存在于标签行，把它挪到左栏去拖等于让用户先去左边找同一个组。破例范围压到最小：只管固定组之间的顺序、只认鼠标（不做键盘 / 触屏兜底）、落点是一个纯函数（`tabHitTest()` 定落点、`tabReorder()` 出顺序），且与左栏拖拽（D143）共用同一个 `moveTo()`，没有第二套「挪一位」语义。竖列与色点条照旧不接拖拽。

为什么：标签行回答「还有哪些组、怎么切过去」，所以它必须在任何壳里都在场 —— 做成顶栏的一行而不是每套壳一条，D148 的「一张表说哪几块拼在一起」才继续成立。只画 N 颗是因为组数无上限、顶栏有上限；「当前组永远在圈内」是这条规则唯一不能让的地方。固定组允许拖，是因为固定的顺序是用户亲手排的、得能改；补位组的顺序是组序推导出来的，拖了也没有落点，干脆不让拖。而固定组之间重排只动一个列表、不增删，一个手势只改一件事，代价与左栏拖拽同一档。

代价 / 可改：

- 只支持鼠标（R15）：没有 `Alt+←/→` 之类的键盘重排，也没有触屏长按。要补的话落点仍走 `tabReorder()`，不用新语义。
- 固定组只能在标签行内挪位：想把第 4 个固定组挪到最前，得先取消固定再固定（会落到队尾）。这是「只重排不增删」的直接后果。
- 名额不满时把补位组拖进固定区也不做：语义（拖进去 = 固定？插在第几位？）票面没定，先留白；满员时按 R7 拒绝新增。
- 竖线画在标签槽的内容坐标里（`left` 加 `scrollLeft`），槽横滚时它跟着标签走；但拖动中不自动横滚 —— 固定组超过一屏时得先滚到能看见的地方。

验证：`web/tests/wstabs-unit.mjs`（`tabHitTest()`：左半 / 右半 / 正中线算右半 / 第一颗之前 / 最后一颗之后 / 空隙归下一颗之前 / 空数组；`tabReorder()`：右半对调 / 左半插前 / 原位与原地 null / 自己与不存在的 id null）、`node probes/workspace-tabs.mjs`（真 Chromium 真鼠标：拖动第一颗到第二颗右缘 —— 竖线 2px 且跟手、松手只发一条 `ws.tabs`、两颗对调、刷新后顺序还在；补位组按住拖不画线不发请求、3px 位移仍算一次点击切组、拖回原位不发声）。

## D150 模型目录两段式：`-ne` 先秒出一份，带扩展的那份落地后补推；失败不再静默（无票，用户口头报障）

**问题：** 「模型与思考」面板会一直停在「模型列表还没加载好」。目录只在连接 / 装包 / 登录时推一次（`bridge/src/index.ts` 的 hello 分支与三处广播），取目录要新起一个带全部扩展与 MCP 的 pi 子进程，实测 **12–15 s**，而超时线写死在 `bridge/src/pi.ts` 的 `setTimeout(..., 25000)`；超了就被 `.catch(() => [])` 吞成空列表。前端唯一会再问一次的地方是空态那行字本身（`web/src/app.ts` 的 `empty.onclick`），所以一条从 8 秒前就连上的标签页可以永远停在空态，界面上没有任何「为什么」。同一时刻再对比：`-ne --no-session` 拿清单只要 **1.3 s**（51 个），差异只有扩展注册的 `qwen-pool/qwen3.6-pool`。

**决定：**

- **两段式**：`fetchModels(cli, { fast: true })` 跑 `--mode rpc -ne --no-session`，先到先发（`catalog` 带 `phase: "fast"`）；带扩展的完整清单落地后，**内容变了才补推**（`phase: "full"`）。同一份不重复发 —— 面板开着时用户可能已经在挑模型，重画会把挑了一半的选项退回去（签名怎么算见下一条）。
- **去重按连接算，不按桥算**：`pushCatalog(socket, …)` 用 `WeakMap<WebSocket, { sig, full }>` 记「这条连接已经拿到哪一份、拿到的是不是完整那份」，而不是一个全局签名。踩过的坑有两个：一是全局签名会让先连上来的那条（验收脚本里「建完会话就关掉的标签页」正是这种）把完整清单吃掉，后进来的页面就永远只剩 51 个（现场量到 `catalog: fast 51 / full 52` 打了三次、页面只收到两条 fast）；二是 WeakMap 的键不能是广播时现造的 send 闭包 —— 那样每条连接每次都是新键，去重等于没做（同一条连接再要一次会重发 `fast 51` 把面板降级，实测 2 帧）。另外「已拿到完整清单的连接」不再补发快清单。广播点（`pkg.*` / `auth.login` / `auth.logout`）改成 `refreshCatalog(true)` 逐条连接各算一遍。
- **前端按内容去重**：`case "catalog"`（`web/src/app.ts`）比较 id+provider 序列，和手里那份一样且没有 error 就不重开面板，只更新数据与 chip。
- **面板自己会问**：`openModelSheet()` 发现 `models` 为空且距上次请求超过 15 s 就发一条 `{type:"models"}`（只吃缓存，不再起 pi 子进程），并按「刚问过 / 已经等了很久 / 有错误」显示三种文案；不再只靠那行字被点到。`force` 只有「点这里重试」才带，bridge 读 `msg.force` 决定要不要作废缓存。
- **失败要说话**：两条路都空时推 `catalog { models: [], error }`（没有异常也要给个理由，否则又是那句「还没加载好」），前端显示「模型列表没读出来：<原因>。点这里重试。」；`fetchModels` 新增 `exit` 监听（子进程早退立刻失败，带上 stderr 尾巴）与可配 `timeoutMs`（快那趟 15 s、完整那趟 45 s，实测 1.3 s / 12–15 s 各有 10× / 3× 余量），失败原因与「这趟拿到了几份」一起写进 `bridge.log`（`catalog: fast 51 / full 52`）。原来「静默成空列表 + 白等满 25 s」是这次报障最贵的部分。`phase` 不是白带的：验收脚本按它断言「先 51 后 52」，日志也靠它区分两趟。
- **`force` 真的强制**：面板里的「点这里重试」带 `force: true`，两段缓存一起失效（原来只让完整那份失效）。
- **删掉 `bridge/src/models.ts`**：`normalizeModels` / `ModelCatalog` 只有自身引用，是 `RpcChild` 时代的死代码；它 `-ne` 的写法被 `fetchModels(fast)` 接了过来。

**为什么：** 用户要的是「面板一开就有东西可选」，而「带全部扩展」这件事本身值 12 s —— 两者不必二选一：`-ne` 那份 1.3 s 就够把 51 个模型摆出来，完整那份多出来的往往只有一个扩展注册的池子模型，晚点补上是可接受的偏差。反过来，失败必须能看见：这次现场唯一的线索是 `bridge.log` 里一行 `listening` 和一行 `ws connected`，然后什么都没有 —— 那说明请求要么没发、要么被吞，两种都该在界面上说清楚。去重是因为「补推一份一样的列表」唯一的效果就是把用户松开的选择退回去。

代价 / 可改：

- `-ne` 那份少扩展注册的模型（实测 1 个）；如果以后扩展开始大量注册模型，这个偏差会变大，届时可以改成「先发缓存、再发完整」而不是「先发 `-ne`」。
- 两条路都是新起子进程，冷启动峰值会多一个 pi 子进程（1.3 s 那种，权重不大）。
- `timeoutMs` 默认 45 s 是留余量而不是实测值；真机上扩展多了可能还要调。前端那两个窗口（15 s 再问、45 s 才说「还没加载好」）是照着这个预算写的常量，改一边要顺手改另一边。
- 前端去重只比 `provider/id`：同一批模型只换了 `levels`（比如改了 thinking 配置）不会重画面板，要等下一次真变化或点重试。

验证：`node bridge/tests/models-unit.mjs`（5 例：完整那趟 argv 不带 `-ne` 且映射出 levels/contextWindow/supportsImages、快那趟 argv 是 `--mode rpc -ne --no-session`、子进程早退立刻报「退出了（code 3）」并带 stderr、静默子进程按 `timeoutMs` 超时且不等到默认线）、`npm run typecheck`；测试桥上 `node bridge/tests/model-check.mjs`（顺带修好一条早就失效的断言：面板改成「草稿 + 确认」式之后，挑完一行并不会自己关掉）与浏览器实测（面板先出 51 行、十几秒后补上第 52 个 `qwen3.6-pool`）。

## D151 内网通页面重做：三栏四页、按容器宽度切、后端只多一个写配置的口子（`#136`）

**问题：** 内网通是 pi 里唯一还停在「第一版能用就行」的页面：`web/src/peer/peer.css` 只有 1 个 `@media`、`main{max-width:720px}` 一栏到底，三个 TAB（对话 / 通讯录 / 在线）把「在线的人、好友、待处理请求、加好友」四种东西切碎在三处，屏幕右半边长期空着；`hidden / dnd / pauseFiles` 三个开关在页面上只拼成一行文字，想改只能去手改 `~/.pi-peer/config.json`；同一刻的 `web/src/styles.css` 已经有 27 个 `@media`、6 套主题色和一套图标语言，两边根本不像一个产品。

**决定：**

- **三栏 + 四个平级页**：`轨道 60px / 列表 292px / 主区`；轨道四个图标是「消息 / 联系人 / 传输 / 我」，不再是 TAB。列表栏跟着页换内容（会话 / 分组联系人 / 传输 / 无），主区画选中项的详情。这一条把「在线」从一个 TAB 变成联系人页里的一个分组（好友·在线 / 好友·离线 / 附近的人），把「加好友」收进联系人页的头按钮，页面从「三个列表轮着看」变成「一个工作台」。
- **按容器宽度切，不按视口**：`web/peer.html` 的 `body` 上 `container-type: inline-size`，`@container (max-width:900px)` 退成单栏钻取（列表 ↔ 内容，带返回箭头）、`(max-width:560px)` 再藏轨道换底部四项导航。原因写在这次改动的场景里：同一个页面既可能是全屏标签页，也可能是 `openPeerSheet()` 里那个 1000×780 的 iframe —— 视口宽度在 iframe 里是骗人的（1440px 的窗口里塞 1000px 的框，`@media` 判成宽的，页面就挤成两条）。
- **后端只加一个写入口**：`peer/src/http.ts` 新增 `POST /config`（只收 `hidden/dnd/pauseFiles` 三个 boolean，写进运行中的 `cfg` 再 `saveConfig()` 落盘；`hidden` 变了立刻 `discovery.announce()`，不等 15 秒那一轮），`peer/src/config.ts` 配 `saveConfig()`，bridge 侧加 `PeerHost.setConfig()` 与 `POST /api/peer/config`。仍守 D97：页面只说 `/api/peer*`，从不直连 7865，`/config` 也只对回环开。
- **不做什么**：会话的未读与置顶**不做** —— `/threads` 不带这两个字段，要做就得加索引和迁移，这次只做「界面兑现已有数据」。传输的暂停 / 取消**不做** —— peer 的 `POST /transfers/:id` 只有 `pause-all`，单条暂停没有后端。pi 代发**不做独立时间线**：那条时间线只存在于 pi 自己的会话里，页面拿不到，所以代发消息在气泡上打 `pi 代发` 标签、会话列表打 `pill`。
- **旧的 picker 保留**：`#picker` 一族的 id 原样留着（`#picker-close/#crumbs/#places/#roots/#files/#picker-sel/#picker-up/#picker-send`），只换了外观；原来那个只有静态 `data-i18n` 文案、TS 里没人引用的 `#picker-title` 删掉了，标题改由 TS 用 `tr()` 画。未选文件时「发送」禁用。

**为什么：** 弹框和全屏是同一份页面，只有容器查询能同时伺候这两种尺寸；而「列表 + 详情」是这类工具最省心的形状 —— 用户在 1000px 的框里也能看到「左边谁在说话、右边说了什么」，不必来回切 TAB。写配置那条口子是这次唯一越过「只读视图」边界的地方，但它换来的是「隐身开关终于能点」：原来那行「隐身着」的文字是死的，用户只能去翻 `~/.pi-peer/config.json`。

代价 / 可改：

- 容器查询要 Chrome 105+ / Safari 16+；但 `peer.css` 还用了 4 处 `color-mix()`，实际底线是 **Chrome 111+ / Safari 16.2+**，再低高亮底色会静默失效（布局不会坏）。
- 未读、置顶、单条传输暂停都留了位置（控件样式在 `peer.css` 里），要做得先补 `/threads` 的字段与 peer 的传输接口。
- `saveConfig()` 写的是**生效中**的配置（含 env 覆盖出来的值），不是重新推导的 —— 如果哪天 env 覆盖项变多，「页面拨一下开关」会把 env 值固化进 config.json，届时要分清「用户改的」和「env 给的」。

验证：`npm --prefix web run typecheck`（`tsc --noEmit` + `i18n-check.mjs`，1405 键 × 3 语言全绿）；测试实例（`pi-web-client-test-dev` 起的两份，端口 17870/17876）上按 1440 三栏、1000×780 弹框、700px 钻取、420px 手机四种宽度逐一截图核对；`POST /api/peer/config {hidden:true}` 后页头出现琥珀色「隐身中」提示条、`~/.pi-peer/state/*/config.json` 落盘。

## D152 `/` 菜单先认名字、描述只兜底；`skill:` 命名空间看冒号后面那段（无票，用户口头报障）

**问题：** 输入 `/hand`，补全列表照旧是 anatomy / claude-handoff / full-output-enforcement / postman / webhook-testing 六个互不相干的技能（2026-11-06 截图）。原因在 `commandItems()` 的过滤：`q.length >= 3` 就把描述也拉进来做子串匹配，`hand` 于是命中 `Hand the current…`（claude-handoff 描述开头）、`handles token-limit splits`（full-output-enforcement）、`handle MCP limitations`（postman）；而真正名字命中的 `skill:handoff` 和这些描述命中混在同一个数组里按原始顺序排，看着就是「没过滤」。另一半问题是名字匹配拿整串 `skill:handoff` 做 `startsWith`：人敲的是冒号后面那段，前缀永远对不上。

**决定：**

- 过滤挪进纯函数 `web/src/commands.ts` 的 `filterCommands()`，`commandItems()` 只负责把内建 + `get_commands` 拼成一份 `all`；单测 `web/tests/commands-unit.mjs`（`npm run test:commands`）。
- 名字命中分档，小的靠前：整名 → 整名前缀 → 尾巴前缀 → 尾巴里某个词的前缀 → 尾巴包含。`skill:handoff` 的尾巴是 `handoff`；`claude-handoff` 按 `[:._\-\s]` 切出 `handoff` 这个词，所以 `/hand` 能命中它。用户自己敲了命名空间（`/skill:hand`）就先把 `skill:` 剥掉再比。
- **命名空间不参与子串匹配**：否则 `/kill` 会命中每一个 `skill:`。只认「整段前缀」，所以 `/skill` / `/skill:` 照旧列出全部技能。只看**第一个**冒号：`mcp:tool:read` 的尾巴是 `tool:read`，`/tool` 照旧命中。
- **名字一个都没命中才看描述**，门槛照旧 3 个字符（两个字符连描述也不看）。名字有命中时描述一条都不混进来 —— 这正是这次「看着没过滤」的根因。查描述用的是剥掉命名空间后的那段：`/skill:document` 去描述里找 `document`，不是找 `skill:document`。
- 空输入照旧前 40 条，排序在原顺序里稳定。

**为什么：** 补全的价值在「缩小范围」，不在「多列几条」。人敲命令时先想到的是名字（技能名 / 扩展名 / 模板名），描述是解释、不是检索键；把描述当第二个检索面，一旦查询短（`hand`、`mod`、`run`）就必然把半个技能表点亮，而用户没有任何手法分辨哪些是真命中。命名空间那一半同理：`skill:` 是 pi 的编码方式，不是人敲的词。

代价 / 可改：

- 名字有命中时描述不再参与：`/compress` 不会带出 `/compact`（即便它的描述里写着「压缩上下文」），`/背诵包` 这种只出现在描述里的词仍能命中（名字零命中，三个字符起；「压缩」两个字符不翻描述）。要恢复可以给描述命中单开一档、排在所有名字命中之后。**可改**
- 尾巴按 `[:._\-\s]` 切词，纯中文技能名整段算一个词，`/补全` 只能子串命中。**可改**
- `/kill` 这类查询不再「命中所有技能」，但尾巴里真有 `kill` 的仍会中（`find-skills` 的 `skills`），名字一个都没中就落到描述兜底或「没有匹配的命令」——比以前更安静。**可改**

**验证：** `npm run test:commands`（13 例：`/hand` 只剩 handoff 那一族且顺序是 handoff → claude-handoff；`/skill:hand` 等价；`/skill`、`/skill:` 列全部且顺序不变；`/kill` 不因 `skill:` 前缀全中、尾巴真含 `kill` 才中；切词认 `-` `_` `.` 空白；`mcp:tool:read` 敲 `/tool` 命中；描述只兜底、两个字符不翻描述、且兜底剥命名空间；整名排最前；同档保持原序；空输入与名字命中都截到 40；大小写）；测试实例（`pi-web-client-test-dev start --dir <本 worktree> --build`，端口 17874）上 `node probes/slash-filter.mjs` 用真 Chromium 逐条断言：`/hand` → 恰好 `skill:handoff` + `skill:claude-handoff`（顺序也查），`/skill:hand` 同，`/kill` → 只列尾巴含 kill 的，`/zzzqqq` → 「没有匹配的命令」，`/claude` → 只剩 claude 那一族，`/skill:` → 全部技能；任一不对退出码非 0。截图 `.scratch/hand-filter/hand.png`。
## D153 文件管理器与「文件」附件 picker 加「跳到路径」：文件 = 标出不打开、桥端多一条 `/api/stat`（无票，用户口头要求）

**问题：** 文件管理器只能靠面包屑一层层点。路径往往已经在手上（从终端、从 Explorer 的「复制为路径」、从另一台机器贴过来），用户要做的却是在树里找到它。更贵的场景是深目录：`work/a/b/c` 里改了 `d.md`，从 cwd 点进去要四次，还容易点错同级目录。

**决定：**

- **输入框是 opt-in**（`mountDirPicker` 的 `pathBox: true`）：文件管理器的浏览页和「文件」按钮（附件）都传了。附件也常已经在手上（终端里复制的路径），跳过去标出来、回车附加，比一层层点回去快。新会话弹层的 picker 不传：那里一打开焦点就该落在「工作目录」上，多一行只会抢 Tab 序，而它要的是**选**一个新目录，不是**回到**一个已知路径。
- **文件夹 = 进去；文件 = 进父目录 + 标出那一行，不打开**。跳到文件时 `.file-row.hit` 给静态高亮（accent 底 + 左侧 inset 竖线）并把焦点移过去，`pane` 仍是「浏览」：一次跳转是「找到它」，不是「看它」。真要打开，回车就在手边。
- **新桥端 `GET /api/stat`**（`bridge/src/dirs.ts` 的 `statPath()`，异步），返回 `{ path, kind: "dir" | "file" | "missing" | "denied", parent }`。不复用 `/api/dirs`：它对文件答 ENOTDIR，在界面上长得像「这个文件夹坏了」。除空输入外 `missing` 也带 `parent` 与绝对路径 —— 报错文案要显示桥端实际解析到哪儿（相对路径、`~` 之类会暴露差异；空串没有问过任何路径，直接答 `{path:"", parent:null}`，不拿它当「不存在」的证据）；`EACCES`/`EPERM` 单独答 `denied`，「不让你看」不该说成「没有这个路径」。用 `fs.promises.stat` 而不是 `statSync`：一个睡着的网络盘上 stat 能卡几秒，同步版会把整个 bridge 一起卡住。
- **相对路径在前端拼**（`resolveTyped()`）：桥端会把相对路径解析到**它自己的 cwd**，那不是用户眼前这个目录。顺带认三种常见写法：Explorer 复制出来的成对引号、只敲盘符 `C:`（补成 `C:\`）、`./x` 与 `.\x`。
- **盘符页拒收相对路径**：那里没有「当前目录」，落到 bridge 的 cwd 只会让人困惑；直接说「在盘符列表里要写完整路径，例如 D:\work」。
- **miss 不动列表**：错误写在输入框下面（`role=status`、红字、自动换行），列表与滚动位置原样（只摘掉 `.hit`，不重画列表），输入保留着等人改；同时清掉上一次跳转留下的高亮 —— 否则「没有这个路径」旁边亮着一行，看起来像是它选中了那个。
- **Esc 只归这一格**：有字就清字；空着再按一次不再 `blur()`，而是让 Escape 继续冒泡给面板（viewer 根节点的 `root.onkeydown` 本来就用它关面板）—— 早先版本 blur 之后焦点落在 body，那个监听收不到按键，面板就再也关不掉了。`preventDefault + stopPropagation` 只用在「清字」这一支（`isComposing` 时只拦不处理），因为输入法正在组字时按 Esc 是取消候选，不该顺手清框或关面板。

**为什么：** 三个 picker 共用一个组件，所以「加不加这行」必须是一个显式选项而不是全局长出来；而跳转的语义要跟「点文件」区分开 —— 点文件是在挑要读的东西，跳转是在从一大片里定位一个已知的东西，顺手把它打开会覆盖掉正在编辑的稿子（还要过未保存拦截）。`/api/stat` 单独一条是因为 `kind` 是这次的核心判断，让前端去猜「ENOTDIR 是不是文件」既脆又读不懂错误。

**代价 / 可改：**

- 没有路径补全 / 历史下拉：要一个词一个词敲完，敲错只能看错误再改。**可改**（列表里每一行都有绝对路径，做一个 `<datalist>` 成本不高，但会跟「输入即跳转」的 Enter 语义打架）
- 高亮先按原样比文件名，找不到才忽略大小写（Linux 上 `A.md` 与 `a.md` 并存时不会亮错那颗）。但父目录若超过 `/api/dirs` 的截断上限（1000 目录 / 2000 文件），`stat` 已确认的文件仍可能不在列表里，此时文案说的是「列表里没有 X（目录过大时只列出一部分）」，不是断言它不存在。
- `/api/stat` 和 `/api/dirs` 一样对隧道访客开放：浏览页本来就能列目录，这里只多一个存在性判断。要收紧得两条路由一起收（`/api/git`、`/api/clipboard-files` 那种 403 口径），否则远程打开文件管理器会变成「列表能看、跳转报错」的半残状态。
- 只在 Windows 上验过。POSIX 上文件在根目录（`/x`）时 `parent` 是 `null`，会 `navigate("")` 回到盘符页 —— 也就是 `/` 的列举，不算错，但和 Windows 的盘符根不完全对称。
- 跳转不写 `v.lastDir` 之外的状态：不进历史、不记住上次跳到哪。刷新页面回到会话 cwd。

**验证：** `npm --prefix web run typecheck`（`tsc --noEmit` + `i18n-check.mjs`，1411 键 × 3 语言）；`npm run test:dirpath`（11 例：引号/空白、三种绝对路径、`joinPath` 分隔符、`fileNameOf` 尾斜杠、相对拼接、`./` 归一、`\Users\me` 落当前盘、只敲盘符（含盘符页 `C:` 归一成 `C:\`）、盘符页不拼相对）；`npm run test:stat`（6 例：dir/file/missing + parent、空串、trim、盘符根 parent 为空串）；浏览器探针 `node probes/fs-path-jump.mjs`（10 段：框在、文件夹进入且清空输入、文件回父目录并高亮且焦点落到行上、带引号路径、相对路径、miss 报错且列表不动并清旧高亮、Esc 两级（第二下关面板）、盘符页相对路径报错、盘符页裸盘符 `C:` 归一、新会话 picker 没这行而附件 picker 有且能跳到文件并标出那一行），截图在 `.scratch/fs-jump/shots/`。

## D154 更新与重启交给 skill：build 成功才换进程，前端比 build id 提示刷新，看门狗兜底（无票，用户口头要求）

**问题：** 合完 PR 之后「让 7864 用上新代码」一直是手工活：找到那个终端窗口、Ctrl-C、`npm start`、等 10 秒编译、刷新页面。三步里每一步都能出错 —— 关错了窗口就把别的会话的 `pi` 子进程带走了；忘了刷新页面则是「代码合了但界面没变」的经典困惑；而 agent 自己在会话里跑这套的话，杀掉 bridge 的瞬间自己的 `pi` 子进程也一起没了，turn 直接断在原地，没人知道成没成。

**决定：**

- **固化成项目 skill**（`.pi/skills/bridge-update/`，`bin/restart.mjs` + `bin/watchdog.mjs`），不做常驻服务、不做镜像目录、不做零中断切换。入口是一条命令，人让 agent「更新一下」就够了。
- **先 build、后杀进程**。`npm run build` 通过才 `taskkill /PID` 旧进程，编译失败时旧服务原样活着、7864 一秒都没断。窗口期只存在于 build 成功之后的那 1–3 秒。
- **合并只做 `git merge --ff-only origin/main`**：这是 AGENTS.md「不在 main 上改」里登记过的例外，也仅限这一步；主检出 dirty 时连 ff-only 都不做（见下）。dirty / 分叉一律 `merge-failed` 退出，**不 stash、不 rebase、不 reset** —— 主检出里可能是别人的活。
- **新进程开在自己的终端窗口里**（`Start-Process powershell -File start-bridge.ps1` 开一个**可见**的新终端窗口跑 `npm run start:nobuild`，输出同时 `Tee-Object` 到 `.scratch/bridge-update/bridge-live.log`）。人还能看见编译和运行日志，关窗即停，和以前手工起的形态一致。
- **只按 pid 杀，绝不 `taskkill /T`**：进程树里可能连着别的 bridge 实例的会话。桥死了之后逐个 `childrenOf(pid)` 补刀，否则孤儿 `pi` 进程攥着会话锁，界面永远显示「终端正在使用」。pid 的来源依次是：`/healthz` 自己报的（只对本机直连回：cloudflared 是本地起的，隧道流量的 remoteAddress 也是 `127.0.0.1`，所以判据必须是 `loopback && !publicReq`，否则 pid 会漏给公网）、`bridge/src/pidfile.ts` 在监听成功时写的 `%TEMP%/pi-web-bridge-<port>.pid`、最后才是枚举端口 —— 在沙箱/本地代理后面 `Get-NetTCPConnection -State Listen` 会答空 pid，只信它就会去起第二个实例撞 EADDRINUSE。
- **一次 build 一个 id**（`scripts/build.mjs`）：`${shortSha}-${base36 时间戳}` 同时写进 `bridge/dist/build-id.json`、以 `PI_BUILD_ID` 传给 vite define；`npm run build:bridge` 也走这个脚本（`--only bridge`），所以单编 bridge 同样刷新 id，`/healthz` 不会长期报旧值。前端只比 id 里的短 SHA：同一提交的两次 build 代码没变，不该弹提示。`/healthz` 与 WS `hello` 都带上它，前端把自己内联的那份一比：不一致才提示。拿 id 而不是 `VERSION`（`bridge/src/paths.ts:6` 写死 `0.1.0`）或文件 mtime（`npm run build` 每次都摸）。
- **不自动 reload**：重连后发现 build 变了，只在顶部挂一条「服务已更新，刷新后生效」+ 刷新按钮。用户可能正在输入框里打字，抢刷新等于把他的字删了；桥端本来就带断线重连，旧 JS 继续用也不会坏。横幅右侧另有一个 `×`：关掉后同一个 build 不再弹，换了 build 才重新提示。
- **失败一律留证据**：每次跑完写 `.scratch/bridge-update/last-run.json`（`result` ∈ `ok|up-to-date|dry-run|bad-repo|aborted|fetch-failed|merge-failed|build-failed|kill-failed|start-failed|stopped|crashed`，加 `fromSha`/`toSha`/`buildId`/`oldPid`/`newPid`）。`--check` 是只读探针，**不写**这份文件 —— 否则一次随手 check 就会把上一次的 `pendingUnread` 冲掉。，build 输出进 `update.log`。
- **turn 被切断不等于任务丢了**：agent 在动手前把「接着要做什么」写进 `.scratch/bridge-update/pending.md`，AGENTS.md 规定下次会话见到 `pendingUnread: true` 先读它接着做、再置 false。
- **看门狗是用户级计划任务**，每分钟探测 `/healthz`；`restart.lock` 新鲜（<5 分钟，正在更新）就跳过，`stopped.flag` 存在就跳过（`watchdog.mjs --stop` 是「我要它停着」的显式表达），5 分钟冷却避免崩循环刷进程。
- `--check` 走前台：只 `fetch` + 比 SHA，不 build 不杀进程，秒回「已是最新」。只有确认落后才起 detached 进程 —— 这一步不能省，不然后台任务白跑一趟还留个过期的 `pending.md`。

**为什么：** 这台机器上没有 pm2 / nssm，也没有容器；「谁来重启」本来就只有人。把它做成 skill 而不是常驻服务，是因为重启是**少数事件**，常驻进程本身又成了新的需要人看着的东西。顺序（build → kill）和合并方式（ff-only，不 stash）都是为了一个原则：**更新器出错时，线上必须还是能用的一套**。build id 走一次性生成而不是每包自己算，是因为三个包分开编译时没人能保证它们描述的是同一次产物。

**代价 / 可改：**

- **只在 Windows 上验过**：进程探测（`Get-NetTCPConnection`）、杀进程（`taskkill`）、看门狗（计划任务）三处都是 Windows 实现，POSIX 分支写了 `lsof`/`kill` 但没跑过。
- **重启仍会断连** 1–3 秒，正在生成的 turn 会被切；前端靠既有重连回来，但正在流的回答只能重发。
- **`--check` 依赖网络**：GitHub 直连不通时靠 `BILLION_CONTEXT_PROXY`，代理也没起就退化成「不知道有没有更新」，报 `fetch-failed` 而不是假装已最新。
- **看门狗只认 `bridge/dist/index.js`**：还没 build 过就跳过，不替你编译。它也不会更新，只会在崩溃后拉起旧 build。
- **build id 在开发模式下是 `"dev"`**（`npm run dev:web`），前端永不给刷新提示 —— 那是故意的，dev 下每次保存都变。
- 新进程开在一个**可见**的终端窗口里，关掉它 bridge 就停了（和以前手工起的一样）；只想看日志也可以直接 `tail .scratch/bridge-update/bridge-live.log`。**可改**（改 `startBridge()` 一处）。

**验证：** `npm run typecheck`（bridge / peer / web 三份 + `i18n-check.mjs`，1412 键 × 3 语言）；`npm run build` 产出的 `bridge/dist/build-id.json` 里 `id` 与 `web/dist/assets/*.js` 内联的 `__BUILD_ID__` 一致（`21b55f3-mw54eo4n`）；在临时克隆（`F:/pi-web-client-wt/_upd-test`，测完已删）上用 `--port 7964` 跑了四条路径：`--check` 判定 `behind:true` → 全流程 `ok`（`oldPid 33836` 来自 pid 文件、`newPid 3032`、`/healthz` 的 `buildId` = 新 build）→ 故意写坏一个 TS 文件后 `build-failed` 且旧进程仍在服务（pid 与 `buildId` 都没变）→ 删掉 pid 文件再跑，仍能从 `/healthz` 的 `pid` 找到旧进程（`oldPid 13956`）；看门狗停掉后一次拉起回到 `/healthz` 正常，`--stop` 期间确实不拉、`--start` 恢复，5 分钟冷却生效。

## D155 审批单击生效：去掉批准前的原生 `confirm`（无票，用户口头要求）

**问题：** 审批卡上点「批准」或「本会话允许这类」，先弹一个原生 `window.confirm`，再点一次才真正发出去。`confirm` 是同步阻塞的：弹窗开着的时候整页脚本停住 —— 审批卡的倒计时不走了、这期间到的 `approval.remove`（比如另一端已经批了）也不上屏；弹窗的按钮文案跟浏览器语言走，不是 `tr()`；同一个卡上「拒绝」却一击生效，两个按钮的份量看起来不一样。

**决定：**

- 「批准」「本会话允许这类」「拒绝」都单击生效。`web/src/app.ts` 的 `approvalCard()` 里不再调 `confirm()`，两个 onclick 直接 `this.decide(...)`。
- 只服务于这两次确认的两个 i18n 键（`确认批准这条命令？`、`批准这条命令，并在本会话内不再询问同一类命令？`）从 `web/src/i18n/en.ts` / `ja.ts` 一起删掉 —— `i18n-check` 会把「词典里有、代码里没有」的键判成多余键。
- 审批卡本身不动：仍是 gate 判定危险才弹、仍带 5 分钟倒计时与 `deadline`、「本会话允许这类」的匹配范围与落盘位置（`state/allow/<会话id>.json`）都不变。

**为什么：** D10 想的防误触是对的，但落地的两段式不是它写的「按钮自己变成『确认批准』」—— 是实现时图省事用了原生 `confirm`，于是每次批准多付一次弹窗：阻塞、样式与语言不受控、多出一套我们管不了的对话框。安全侧真正的门是 gate 扩展（默认只在危险模式弹卡）和「拒绝」，不是这第二个弹窗；用户也明确要求去掉它。

**代价 / 可改：** 手机上一指头滑过就可能批掉一条命令 —— D10 担心的场景回来了。真要防误触，按 D10 的**原设计**做卡内两段（按钮文字自己变 + 3 秒复原，不阻塞页面），不要再用 `window.confirm`。**可改**。

**验证：** `npm --prefix web run typecheck`（tsc + `i18n-check.mjs`，去掉两个键后三边仍然对齐）；本地起 bridge 后危险命令弹卡，单击「批准」直接发 `{type:"approve", decision:"approve"}`、卡片消失、命令开始执行，中途不再出现任何浏览器弹窗。

## D156 待办计数按事件对称地加减：答完的提问不再顶着「待确认」（无票，用户口头报障）

**问题：** 用户截图（2026-11-07）：左侧「skill 商店安装报错」卡右下角一直挂着「待确认」，右边那条提问其实已经答完（选项后面带 ✓）。三处口径错误叠在一起 ——
- 别的会话来**提问**（`ask.add`）时 `notifyUnread()` 把 `approvals` 加 1，`ask.remove` 又从来不减任何计数：答完的提问要么一直「待回答」，要么（`approvals` 已经 >0 时）显示成「待确认」。
- 批准的 `approval.remove` 只给「当前不在看的会话」减数：先收到批准、再切过去批掉，列表里那条就永远留着 1。
- 只有顶栏 NowChip 拿本地队列覆盖当前会话，卡片 / 钉条胶囊 / 管理行读的都是列表里那份旧账。

**决定：**

- 新增 `web/src/pending.ts`：`applyPending(sessions, id, "approvals"|"asks", ±1)`、`syncPending()`、`badgeSession()` 三个纯函数。四个事件（`approval.add/remove`、`ask.add/remove`）都走它，**当前会话也照加照减**，结果夹在 ≥0。
- `session` 快照到达时 `syncPending()` 把列表里那条换成快照里的队列长度（权威值），曾经算歪的会话打开一次就回到真值。
- `App.badgeOf(s)` 成为徽标唯一入口：`sessionBadge(badgeSession(s, currentId, 本地队列长度), currentId)`。左栏卡、钉条、管理面板、NowChip、工作区浮层全走它 —— D53 的「唯一实现」不变，只是多了一层「当前会话以本地为准」。
- `openSession` 清空本地队列、快照还没回来这一小段（`App.pendingFresh` 为 false）徽标退回列表里的计数 —— 否则每切到一个「正等着你」的会话，徽标都会先闪没一拍（评审 P1）。
- 四条事件都补一次 `renderSessions()`：别的会话来事时卡片立刻变（旧代码在 `ask.add` 上根本不重画）。
- 删掉 `notifyUnread()` —— 它就是「提问记成批准」的源头。

**为什么：** 桥只在计数变化时发这四条事件，不补 `session.state`（`bridge/src/sessions.ts` 的 `answerAsk` / `answerApproval` 直接 emit `ask.remove` / `approval.remove`，`setState` 只改自己那条字段），所以前端那份累加值就是列表唯一会变的账；对称加减 + 类型分开，账才不会漂。当前会话再叠一层「以本地队列为准」，是因为本地队列在订阅快照和作答时会重置，比累加值新（D53 的优先级规则照旧）。**没有**改成「桥每次变化都广播 `session.state`」：那等于把「哪条事件属于哪个字段」的语义也搬进桥，还多一次全量广播，而前端手里已经有事件，补一次对应的减法更小。

**代价 / 可改：** 每条事件多一次 `renderSessions()`（列表几十条，可忽略）；`badgeSession` 只在当前会话上分配一个新对象。真要桥端广播，删掉 `badgeOf` 里那层覆盖即可，计数本身仍然是对的。**可改。**

**验证：** `node --experimental-transform-types web/tests/pending-unit.mjs`（6 条：类型分开 / 对称 / 缺字段按 0 / 未知会话 / 快照对齐 / 本地优先）；`probes/pending-badge.mjs`（假桥 + 真界面五步：看 A 时 B 来问题 → B 卡「待回答」而不是「待确认」；打开 B 点选项作答 → 徽标消失；看 B 时 A 来批准 → A 卡「待确认」；打开 A 点批准 → 徽标消失；把 subscribe 延后 900ms 再点开一个待回答的会话 → 徽标全程在）。同一探针在**旧代码**上（`git stash` 回 `3a54f8c` 的 `web/src/app.ts`，控制实验）复现用户现场：问题到达时 B 卡显示「待确认」，作答后**仍是**「待确认」。`npm --prefix web run typecheck`（tsc + i18n-check，1410 键 × 3 语言）、`npm --prefix web run build`。

## D157 技能商店的下载不再只有一个源：raw 被重置时改走 jsDelivr 镜像；树比仓库旧时自愈（无票，用户口头报障）

**问题**（用户截图）：技能商店点「安装到全局」失败，界面上只有一行 `没有装上：read ECONNRESET`。服务器条目也大多没有说明（同一行是「部分条目的说明没查到」）。

查下来是同一件事：商店的**所有文件**都从 `raw.githubusercontent.com` 取（`fileUrl()`），而这个域名在用户的网络里直连被重置（curl `000`，Node 报 `read ECONNRESET`，连试三次都一样）。而商店本来就依赖的 `data.jsdelivr.com`（仓库树）和 `skills.sh` 都是通的 —— 也就是说，只有一个主机把整件事拖垮了。桥自己又没配代理（`settings.json` 里没有 `httpProxy`，进程环境也没有 `HTTPS_PROXY`），D114 明确禁止把本机代理写进产品，所以「让用户去配代理」不是默认答案。

顺带还发现包装没生效：`LIVE_NET.file` 原先把 `await requestRaw(...)` 写在 `try` 之外，所以注释里说的「每次失败都说出是哪个文件」从未发生过，页面只能拿到裸的 `read ECONNRESET`。

修好第一个问题之后又撞上第二个：`anthropics/skills` 的 `xlsx` 报到 `下载 skills/xlsx/scripts/office/pack.py 失败：返回 404`。`data.jsdelivr.com` 的 `@HEAD` 树对它自己缓存了几个小时，上游刚把 `scripts/office/*` 挪走，于是树里列着 raw 上已经不存在的文件 —— 这跟代理无关，`raw` 经代理也 404，旧代码今天同样装不上。

**决定：**

1. **文件有两个源，先后有序**（`MIRROR_HOSTS` / `mirrorUrls()` / `fileFetcher()`）：先 `raw.githubusercontent.com`，只在**socket 级失败**（`ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` / `socket hang up` 等）时改走 jsDelivr 的三个 GitHub 镜像域 `testingcf.jsdelivr.net`、`fastly.jsdelivr.net`、`gcore.jsdelivr.net`（`/gh/<repo>@<ref>/<path>`）。**404 之类的回答不换源** —— 文件是真的不在，换源只会把有用的那条消息换成不存在的那个。
2. **死掉的主机记十分钟**：`fileFetcher` 里一张 `host → downUntil` 表，装一个十二个文件的技能只探一次被墙的主机，不是十二次；十分钟后再给它一次机会，网络恢复时不需要重启桥。
3. **报错说出文件和主机**：失败一律 `下载 <path> 失败：<host> <原因>`，全都挂掉时末尾附「在 pi 的设置里填 httpProxy，或给桥设 HTTPS_PROXY 后重启」。这是页面上唯一能看到的那行字，比堆栈有用。错误对象保留 `code`（`HTTP_404`、`ECONNRESET`…），后面第 4 条要靠它区分。
4. **树比仓库旧时自愈**（`freshRepoFiles()`）：安装中任何文件 404，就用 GitHub API（`/git/trees/HEAD?recursive=1`）取一次**实时**树、把目标目录清空、按新树重来一次；新树写回磁盘缓存，下一次安装不再问 GitHub。新树里连 `SKILL.md` 都没有才把 404 报出去（那说明目录真的没了）。新树要**重新过一遍上限**（`skillFiles()`：文件数与总大小），不能沿用旧树算出来的数——实时树可能比旧树大得多。清空之前先等还在飞的文件写完（`mapLimit` 失败后不再派活、但等所有 worker 收手才抛），否则它会往刚清空的目录里补写。
5. 三个镜像域由代码写死，**不读 `BILLION_CONTEXT_PROXY` 之类的环境变量**，也不自动把本机代理塞给 `fetch` —— 那是 D114 的边界。

**为什么：**

- **镜像而不是代理**：`raw` 被重置、jsDelivr 通，是这台机器上实测出来的差别（`data.jsdelivr.com` 200、`cdn.jsdelivr.net` 000、`testingcf` / `fastly` / `gcore` 200；同一个 165848 字节的 ttf 从镜像取回后与经代理的 raw 逐字节一致）。镜像不要求用户认识代理、不需要重启、也不需要我们把本机端口写进产品。
- **404 不试备用源**：试一遍也是 404，只会把「文件不存在」这条信息淹没在三条主机记录里。
- **漂移自愈而不是让用户清缓存**：缓存目录（`state/market/skill-repos.json`）用户看不到也删不掉；一个安装按钮的结果不该取决于我们内部缓存的年龄。多花一次 GitHub 请求（有令牌还算宽裕）换「点了就能装」。
- **改 `fileFetcher` 而不是在每个调用点 try 三次**：`skillMeta`、`installSkill`、预览都走 `net.file`，一处收口就都受益；也因此单测能直接喂一个假的 `fetchOne` 断言行顺序。

**代价 / 可改：**

- 镜像内容来自 jsDelivr 的缓存，上游刚 push 的提交可能还没进去（raw 是实时的）。真遇到「刚改完就想装」，raw 优先的顺序保证只要 raw 通拿到的就是最新的；镜像只在 raw 不通时用。
- 被墙时每个**不同**的技能目录会多 3 次请求（一次 404 不重试、一次 socket 失败记十分钟），装十个技能最多多探十次，之后同一主机全部命中记仇表。**可改**：把 10 分钟调长或按进程生命周期记。
- 漂移自愈会重下一次整个目录（第一次那半份白下了）。技能都是小文件，几十 KB 到几 MB，值。失败时多等一次正在飞的文件（一个请求的超时上限），换清空之后不被补写。**可改**：要更快收手就给 `net.file` 传 `AbortSignal`。
- 只写死三个镜像：另外几家（`raw.githack.com`、`cdn.statically.io`）实测 `000`，没写。**可改**：改 `MIRROR_HOSTS` 一行。
- 仍然装的是 `HEAD`，不锁 commit（同 D126 的账）。

**验证：**

- `node bridge/tests/skill-store.mjs`：A–L 是 D126 原有的断言（换成记录 `opts` 的假网后全绿，F 段还多断言了「安装把三个备用源和 `label` 交给网络层」）；新增 **M. `fileFetcher` / `mirrorUrls`**（3 个备用地址；带斜杠的 ref 不给备用；raw 被重置时走备用；十分钟内不再探死掉的主机；十分钟后又给 raw 一次机会；404 直接报且只发一个请求；全挂时消息含文件名 + 主机 + 代理提示）和 **N. 树比仓库旧时自愈**（某个文件 404 后只向 GitHub 要一次新树；按新树装完、旧树里的 `pack.py` 没留在盘上；文件数按新树算；新树进缓存后第二次安装不再问 GitHub）和 **O. 自愈后的上限与失败清理**（实时树 70 MB 时按新树重算、报 64 MB 上限且不留半成品；一个文件立刻报错、另一个还在写时，等它写完（实测 97ms）再把目录清干净，晚到的写盘没补回来）。全绿。
- `npm --prefix bridge run typecheck` 干净。
- 真网络（本机，不走代理）：`installSkill({ source: "anthropics/skills", skillId: "xlsx" })` 装出 **53 个文件、15.9 秒**，`find` 出来的文件名与 GitHub 树逐一相等（多出的只有 `.pi-store.json`）；`skillMeta()` 走镜像拿到 `canvas-design` 的说明。修之前同一条命令报 `read ECONNRESET`，修一半时报 `下载 skills/xlsx/scripts/office/pack.py 失败：返回 404`。

## D158 字号从四档 chip 换成一根连续滑杆（0.8–2.0），放大后按「有效宽度」退窄版

**问题：** 外观抽屉里的字号是四颗 chip：小 0.9 / 标准 1 / 大 1.12 / 特大 1.25。它是 D36 选 `zoom` 整页缩时顺手给的档位，上限 1.25 对 1707px 的宽屏明显不够 —— 26px 的正文字在 2K 屏幕上还是小。四个档位本身也不好用：想「比大再大一点」没有；1.12 和 1.25 差 11%，中间全是空的。而一旦把上限抬到 2.0，`zoom` 带来的第二个问题就露出来了：**媒体查询看不见缩放后的布局宽度**，1707px 的窗口在 2.0 下只剩 853 布局 px，`@media (max-width: 899px)` 却照旧不触发，三栏（280 + 1fr + 300）、抽屉的 `max-height: 78vh` 也还是按视口算 —— 抽屉会自己先比屏幕高。

**决定：**

- **滑杆取代 chip**（`web/src/app.ts` 的 `openDisplaySheet`）：`<input type="range">` 0.8–2.0、步长 1%，填充靠 `--fill` 驱动 `linear-gradient`，读数（`120%`）在右侧标题行。轨上 0.1 一格、0.2 一个字（`80 … 200`），**点刻度字精确落档**；指针拖到 ±1.2% 内会吸上去（`SIZE_SNAP`，吸的是 0.9 / 1 / 1.12 / 1.25 这四个老档位，它们**没有字** —— 选样张时定的是 V3，老档位只留隐形磁吸）；键盘不吃吸附（1% 的步长配上 1.2% 的吸附半径，方向键会永远弹回刻度）。双击轨道回 100%。四个 chip 与它们的 i18n 键（小 / 标准 / 大 / 特大 里的三个；「标准」在文字亮度里还在用）一起删掉。
- **写盘只有一个值源**：拖动中 `sizeNext` 是唯一真值，`range.value` 只是被 `paintSize` 抹上去的显示。松手时 `commitSize()` 取 `sizeNext`（不是 `range.value`）—— 单击轨道时那一帧 rAF 根本没跑，读 `range.value` 等于把这一下丢掉。「还没存盘」另记一个 `sizeDirty` 标志：`setScale(…, false)` 自己就会把 `prefs` 改成新值，拿 `prefs` 比等于永远相等，松手那次 `savePrefs` 就再也走不到（这个坑第一版就踩了，键盘连按两下 → 界面 120% 而盘里是 119%）。有了标志，`keyup` + `blur` 挨着来也只会写一次盘、重排一次。
- **拖的是「冻住的盒子」，不是浏览器的滑块**：`#app` 上是整棵树的 `zoom`，页一放大轨道就跟着变宽变位，浏览器拿新几何重新除指针坐标 —— 手指一直往右走、读数却越来越迟钝，2.0 拖不到（实测卡在 1.79）。所以 `pointerdown` 时把轨道的 `getBoundingClientRect()` 冻住，之后一律按 `(clientX - x) / w` 算值，并 `preventDefault()` 掉浏览器自己的拖拽（同时自己 `range.focus()`，否则焦点被拦下、鼠标拖完按方向键没反应）。轨道还要 `touch-action: none`：手机上从滑块上起手，浏览器会把这一串 `pointer` 当成滚动、发个 `pointercancel` 就收走。
- **实时跟随、松手写盘**（沿用选样张时的口径）：`input` / `pointermove` 用 `requestAnimationFrame` 合并、只改 `--ui-scale`；`pointerup` / `keyup` / `blur` 才 `savePrefs` + `applyPrefs()`（顺带重夹终端几何）。
- **窄版判据从媒体查询挪到 JS**：新增 `App.compact()` = `innerWidth / uiScale() < 900`，落成 `<html data-compact="true|false">`；CSS 里原来那 6 个 `899 / 900` 媒体查询改成 `:where(html[data-compact="true"])` / `:where(html:not([data-compact="true"]))` 作用域。`app.ts` 里 9 处同样含义的 `matchMedia` 一起换成 `this.compact()` —— 判据只能有一份，CSS 和 JS 不许分叉。`syncCompact()` 返回「这次真的翻了」，拖动中跨过 900 就顺手 `renderPanes()`：pane 的 `hidden` 是 JS 状态，不重排的话松手前看到的是「三栏挤进一列」。窗口 resize 和每次改字号都会重判。
- **`zoom` 子树里的视口单位改走 `--vh1` / `--vw1`**：`:root` 加 `--vh1: calc(1vh / var(--ui-scale, 1))`（`--vw1` 同理），抽屉、弹层、浮层里所有「几成视口」都写成 `calc(var(--vh1) * N)`，乘上 `zoom` 之后刚好是 N% 视口。`.term-dock` / `.viewer` 的几何本来就是 JS 按布局 px 算的，不动。挂在 `document.body` 上的浮层（`.ws-pop`）在 `#app` 之外、不被 `zoom` 乘，继续用裸 `70vh` —— 在那里除一次缩放会把它压成半高。
- **侧栏改 `clamp(176px, 26%, 280px)` / `clamp(190px, 26%, 300px)`**：窗口一窄先收侧栏，把宽度让给中间那栏；拖过分隔条之后 inline style 优先，宽度固定成用户选的那个数。

**为什么：** 用户要的是「范围由我自己定」，不是再多两档 —— 连续滑杆配上老档位的刻度，既保留了「回到标准」「大一号」这种肌肉记忆，又不再限制上限。上限取 2.0 是因为 13px → 26px 已经到头：再大一行放不下十个汉字，聊天区会变成三行一句。窄版判据放在 JS 而不是用容器查询，是因为 `compact()` 本来就要给 `termDefaults` / `termInset` / `placeNowChip` / 默认 tab 用，放在一处只有一个答案，也省掉「CSS 认为窄、JS 认为宽」这类只在缩放边界上出现的鬼。视口单位走变量而不是每个地方写 `calc(78vh / var(--ui-scale))`，是因为 `zoom` 会乘一次、人却很容易忘，写成 `--vh1` 至少能把「这里除过缩放」写在名字里。

**代价 / 可改：**

- 滑杆的 DOM 比四颗 chip 重（轨 + 13 条刻度 + 7 个字 + 输入框），且 `-webkit-slider-thumb` 是 Chromium 专有伪元素 —— Firefox 上滑块会退化成系统样子（轨道与填充仍然对）。主端是 Edge/Chrome，先不管。
- 吸附半径写死 1.2%（`SIZE_SNAP`），轨宽一变手感就变；换轨宽时要重看一眼。
- 拖过之后侧栏宽度是具体 px，不再跟着窗口收 —— 这是 `wireGrip` 早就有的行为，只是现在和 clamp 混着用，读代码时要记得 inline style 优先。
- 只剩 `620 / 720 / 760 / 860` 这些**子断点**还是媒体查询：它们管的是面板内部排版（`.sheet` 桌面宽度、`settings-row` 折行），放大后这些面板本来就窄，按视口判不会错得很离谱。真要统一，同样可以挂到别的 data 属性上。**可改**。
- `@media (max-width: 720px)` 里那两条全屏 sheet 从 `100vw / 100dvh` 改成了 `100%`：它们本来就在 `.sheet-back` 里，`100%` 拿的是已经排好的那层，反而不会被 `zoom` 二次乘。代价是移动端从动态视口退回布局视口（地址栏收起时不再跟着变高）。
- 框在 `zoom` 子树里的 px 上限（`.peer-sheet` 的 `780px`、`.sheet.file-picker` 的 `640px`）也会跟着乘：0.8 号字时 780px 只剩 624 视觉 px。它们的语义本来就是「别太宽」，先不拆。
- 每拖一格都是整页 relayout（`--ui-scale` 就是 `zoom`），2.0 的下限机器上会掉帧；rAF 合并只保证一帧一次。

**验证：** `npm --prefix web run typecheck`（tsc + `i18n-check.mjs`，1407 键 × 3 语言，删掉三个字号键后三边仍对齐）；隔离测试环境（`.pi/skills/pi-web-client-test-dev/`，口令 test）里在 1707×960 上实测：从 1.0 拖到最右得到 **2.0**（此前同样操作卡在 1.79 —— 这就是「冻住盒子」要修的那个 bug），拖到最左得到 **0.8**，拖到 1.125 吸到 **1.12**，方向键 3 下 1.12 → **1.15**（没有被吸附卡住），`Home` → **0.8**；拖动过程中 `--ui-scale` 实时变而 `pi.prefs.scale` 不变，松手才落盘；1.6 时仍是桌面三栏（`data-compact="false"`、侧栏 443 视觉 px），2.0 时自动退窄版（`data-compact="true"`、底部标签行出现、队列栏隐藏），窗口缩到 860 也退、拉回 1707 又回三栏；抽屉高度在 2.0 下是 787 / 960（82% × 960，`--vh1` 生效，此前会到 1400+）。
## D159 「继续」按钮：借权限按钮上方那 28.5px，把「这一轮断了」接回去（无票，用户要求）

**问题：** 会话被打断（用户按「中断」、看门狗、模型报错、桥重启）之后，界面上没有任何「接着干」的入口 —— 只能自己再写一句话，而大多数时候那句话就是「继续」。pi 的 RPC 也没有 continue 命令（`rpc-mode.js` 的 case 表只有 prompt / steer / follow_up / abort / compact …），所以它只能是一条**普通的用户消息**。

**决定：**

- 位置：composer 右侧，权限按钮**正上方**，同一列。≤520px 的手机宽也一样（那时权限按钮只剩图标）。
- 触发：**常驻** —— 会话空闲就亮，不是只在异常中断后出现。新会话（一条用户消息都没有）显示但置灰；跑着的时候（`pi.status.running`）也置灰；只读预览 / 终端里另一个 pi 持锁时**藏起来**（先点「接管会话」）。
- 发出去的是**字面「继续」**（`CONTINUE_TEXT`），作为一条普通 user 消息进历史、出现在对话里。它**不跟界面语言变**：标签是 `tr("继续")`，发出去的字永远是这两个字。
- **不清草稿**：它不走 `sendPrompt()` 的清空路径，输入框里的东西原样留着 —— 这是「接着刚才那件事」，不是「把我写的发出去」。重画会重建 textarea，所以光标位置与焦点在点击后收回去，手感也不变。
- 乐观气泡照 `sendPrompt()` 带 `clientId`（桥回灌时这一页认自己那条，#19）；`CONTINUE_GUARD_MS`（1.5 秒）连点保护，**按会话记**：`pi.status(running)` 回来之前按钮还亮着，A 里点完立刻切到 B 再点不该被吞。
- 判据抽成纯函数 `continueState(s, hasUserTurns)`（`web/src/continue-state.ts`），`app.ts` 只负责画和发；字段名直接 `Pick<SessionState, …>` 借过来，桥那边改名这边会编译不过。

**为什么常驻、为什么发字面、为什么不清草稿：** 用户要的是「任务被打断之后能接回去」，而不是一个「异常报告」控件 —— 只在异常后出现的话，正常停下（想休息一会儿）时反而找不到它，而且「这一轮算不算异常」在页面这边永远只能猜（`stopReason` 有好几种，桥重启压根没有 item 事件）。「继续」本来就是一句话，把它做成命令/协议事件会让 pi 那边看到一个不存在的能力；发成普通消息则是同一条 `prompt` 路径，接管、排队、steer 全部照旧。不清草稿是因为点它的人多半正在写下一句，清掉就是把人家手上的东西弄没了。

**为什么放在上面那块：** 本机 CDP 实测 `.composer .row` —— 输入框默认两行 **72.5px**，权限按钮 **44px 贴底**，所以它上方本来就空着 **28.5px**，1280/980/700/520/390 五个宽度都一样。28 + 4 间隙 + 44 = **76**，整行只比输入框高 **3.5px**。同一颗按钮塞在别处（新起一行 / 叠一颗 44px 的）分别要多 50 / 19.5px 的正文高度，而那块本来谁也放不进东西。

**代价 / 可改：** 草稿越长，那一列离输入框顶越远 —— 但它始终贴着权限按钮，这正是「一列」的意思。`hidden` 属性打不过 `display:inline-flex`，样式里显式写了 `.continue-btn[hidden]{display:none}`（`disabled` 先置，藏是第二道）。`locked` 目前只出现在桥 `list()` 的副本上（live 广播里没有），所以那一半是兜底，真正管用的仍是 `owned`。字面「继续」不翻译，`i18n-check` 靠模块级常量认出来（当它是「使用处才定语言的值」，不报漏翻）。**可改。**

**验证：** `npm run test:continue`（10 条：藏 / 灰 / 亮三态的边界，含「藏优先于灰」与字段缺省）；`npm run test:continue:ui`（自带丢弃式 bridge + `bridge/tests/fixtures/fake-pi.mjs`，真 Chromium **14 条**：新会话按钮在且是灰的 / 竖着叠在权限按钮上方且同宽 121.2px / `row 76.0 vs textarea 72.5` / 跑完一轮变亮 / SLOW 时是灰的 / **被打断之后又亮** / 点下去 fake-pi 收到字面「继续」/ 草稿仍在 / 对话里出现「继续」/ 英文界面标签是 `Continue` 但**发出去的仍是「继续」** / 英文界面草稿也在）。截图见 `docs/shots/continue-button.png`（被打断的那一轮 + 亮着的按钮）。`npm --prefix web run typecheck`（tsc + i18n-check，1414 键 × 3 语言）、`npm run build:web`、`npm run build:bridge`。

## D160 设置面板的「（默认）」写成 `（默认：值）`：默认值从 pi 包里读，不由我们背（无票，用户口头要求）

**问题：** 面板里 16 个控件的第一项全是 `（默认）`，看不出默认是 `one-at-a-time` 还是 `all`、是 `开` 还是 `关`；`defaultTools` 这种列表连「空 = 用哪几个工具」都说不出来。第二层问题更麻烦：想标就得知道值，而写死在我们的源码里必然与 pi 漂移 —— 本仓已经因为「自己重新实现 pi 的行为」吃过亏（D77/D78）。

**决定：**

- 默认值的唯一来源是 **pi 包自带的 `schemas/settings.schema.json`**（44 个叶子带 `default`），桥的新模块 `bridge/src/settingsdefaults.ts` 用 `piPackageDir(cli)` 找到包根、按点号拍平成 `{ "compaction.reserveTokens": 16384, … }`，随 `settings.get` 的响应以 `defaults` 字段下发；前端 `defaultLabel()` 只做查表与拼文案，**不硬编码任何默认值**。
  - schema 没写、但 pi 文档有明确值的 6 个键（`defaultThinkingLevel`、`defaultTools`、`httpIdleTimeoutMs`、`websocketConnectTimeoutMs`、`npmCommand`、`retry.provider.maxRetries`）由该模块内的 `FALLBACK` 表补；两边都说时 **schema 赢**。
  - 读不到包 / 没有 schema / `cli` 为 null 一律不抛，只给兜底表：默认值标签写错是瑕疵，`settings.get` 崩掉是故障。
- 三种文案：全局页 `（默认：ask）`；项目页在全局设了值时 `（默认：auto，继承全局）`（项目页的「默认」就是实际生效值）；两者都说不出值时 `（默认：不设置）`。列表类（`defaultTools` / `enabledModels`）不显示「继承全局」—— 它们的 `+x / -x` 语法是**合并**而非覆盖，写「继承」是假话；模型行存的是 `defaultProvider` + `defaultModel` 一对，继承时显示 `/` 拼起来的整对。
- 查表顺序是 **schema → `defaultText` → 「不设置」**：`defaultText` 只是给 pi 在运行时才决定的值（「自动，挑一个能用的」「跟随 HTTP 空闲超时」）一句说明，**不能盖住 schema 里的真值** —— 第一版把它放在了前面，等于在代码里硬编码默认值，与上一条自相矛盾。
- 字段的 hint 必须与 pi 的事实对齐：`sessionDir` 写的是「相对路径从工作目录解析，项目设置会盖过全局」（pi 的 `getSessionDir()` 读的是 global + project 合并后的值），不是「只认绝对路径、只在全局生效」。
- 顺手把面板补齐到网页上有意义的全部 pi 设置（16 → 36 行），并加分组小标题 + 一个默认收起的「高级」（展开态记 `pi.settings.advanced`；`globalOnly` 的行在项目页直接不渲染）。对象型设置（`modelThinkingLevels` / `thinkingBudgets` / `compaction.modelOverrides`）不进表单，底部点名 + 「去改 JSON」按钮。

**为什么：** 用户的原话是「很多默认，其实并不知道默认是啥」。答案只能来自 pi 自己那份 schema —— 它是 pi 校验设置的同一份真相，改默认值时我们跟着变，不需要有人记得来改这里的字符串。把「读 schema」放在桥里而不是前端，是因为前端拿不到 pi 的安装路径，而桥已经用它加载 pi 模块（`bridge/src/pimods.ts`）。

- 数字设置一律按整数存（pi 的超时/水位都是毫秒或 token 数），允许 `disabled` 的那几项例外。

**代价 / 可改：** `defaults` 让 `settings.get` 的响应多出几十个键（一次性解析后缓存，面板每次重绘只是查表）。schema 结构若大改（默认值不再在 `properties.*.default`），标签会退回兜底表的样子而不是报错。分组名与哪些行进「高级」是口味问题，全都可改。

**验证：** `node --experimental-transform-types bridge/tests/settings-defaults.mjs`（7 条：拍平、无 default 不算、包缺失不抛、schema 覆盖兜底、缓存）；`node bridge/tests/settings-trust.mjs` 17 条仍全过（`settings.get` 多一个字段不影响既有断言）；`npm run typecheck` + `npm run build`；测试实例（`pi-web-client-test-dev`，口令 test，17874）截图核对全局页 36 行都写出了默认值、项目页出现「（默认：max，继承全局）」。

## D161 默认权限是 pi 设置里的一个桥自有键，在会话被第一次看见时钉死（无票，用户口头要求）

**问题：** 权限模式只存在于 `state/allow/<id>.json`，没这个文件时 `readPermission` 一律返回 `ask`——「默认是什么」这件事既看不见也改不了，每个新会话都得手动点一次 chip。用户要求：设置里加「默认权限」，并且要能按项目设。

**决定：**

- 键是 **`web.defaultPermission`**，值就是 `readonly | strict | ask | auto`。存在 **pi 自己的 settings.json 里**（`~/.pi/agent/settings.json` 与 `<cwd>/.pi/settings.json`），读写走既有的 `bridge/src/pisettings.ts`（D78：pi 的配置由 pi 的模块管，不另起一份）。`web.` 命名空间是桥的约定，pi 对未知键宽容（schema 顶层 `additionalProperties: true`），所以 pi 会原样保留、不会拒绝。
- 解析顺序 **项目 → 全局 → `"ask"`**，与 pi 其它设置同语义。项目级那一层**必须先过信任门**：`readSettings()` 给出 `writable`（= `trustInfo().effective`），未信任项目的 `.pi/settings.json` pi 本来就不加载，桥若照读，会得到一个 pi 自己都不认的值。
- 生效时机是 **会话被第一次看见时钉住（pin）**，不是每次工具调用都解析：`Session.pinPermission()` 在没有 allow 文件时写入 `{ mode: 解析值, from: "default" }`，三处调用——`create()`、`openLive()`（都在 `startLive` 之前，因为 gate 在 spawn 那一刻就读这个文件）、以及启动后的一次扫描 `pinAll()`（覆盖 bridge 从没见过的磁盘会话）。
  - 老会话因此**不会**被后来的默认值改动波及；反过来，手动改过的会话（`setPermission`）会**删掉 `from` 标记**，永远不再被「应用默认值」碰到。
  - `from` 是唯一用来区分「这个 ask 是默认来的还是人选的」的东西 —— 只看 mode 分不出来，而「应用到现有会话」必须只覆盖默认来的那些。
- 「应用到现有 N 个会话」是**显式动作**：`permission.defaults` 回 `{mode, source, path, total}`（cwd 可省 = 全部），前端在设置面板底部显示按钮并写明现在的默认值来自哪一层；`permission.applyDefault` **要 step-up**（它会批量放松/收紧权限），对每个会话用它**自己的 cwd** 重新解析（项目值不同），保留 `from:"default"` 以便下次还能被更新 —— 所以按钮文案是「改成各自的默认值」，不能写死某一个模式名。
- 面板里 MCP 安装表单的「codemode」下拉框改名「**MCP 暴露方式**」（它管的是 MCP 工具的 exposure: deferred/direct/hidden），pi 的 `codemode.mode` 才叫「**codemode 工具模式**」——两个同名控件并排是会误点的。

**为什么：** 默认值要么写进每次工具调用前的解析（成本、且老会话会突变），要么钉一次（可解释、可回滚）。选钉一次，是因为用户对权限的心智是「我会话开始时是什么就是什么」，中途因为谁改了全局设置而变严/变松是惊吓。项目级要求过信任门，是为了不在「pi 根本没读这个文件」的情况下假装它生效。

**代价 / 可改：** allow 文件多一个 `from` 字段（旧的没有，照样能读）。`web.*` 键 pi 不认识，面板的「编辑 JSON」里会看见它——这是有意的，它就该出现在那个文件里。启动扫描只看 `metas()` 里每个会话的 allow 文件是否存在（存在就跳过，**不调 `ensure()`**，否则每个磁盘会话都会多一个 Session 对象和 400 ms 的 tail 定时器），不存在才读该会话 cwd 的 settings.json 并写一行 —— 是一次性的、不阻塞监听的薄扫描。

**验证：** `node bridge/tests/default-permission.mjs`（A 无设置→ask 并带 `from`；B 全局 strict 只影响新会话；C 项目值未信任时被忽略、信任后覆盖全局；D 手动切换清掉 `from`；E `permission.defaults` 把 manual 排除在外、`applyDefault` 只改默认会话且各自用自己的项目值；F 重启桥后启动扫描给磁盘上没见过的会话补钉、手动选择跨重启保留）；`node bridge/tests/settings-trust.mjs` 仍全过；`npm run typecheck`（i18n 三边对齐）+ `npm run build`。

## D162 「完成」是会话的持久状态：打开不清、重启不丢，时间不再被「打开」刷新（无票，用户口头报障）

**现象：** 已完成的任务点开看一眼，卡片上的「完成」消失，时间从完成时刻变成「刚刚」—— 再也判断不出这一轮到底结束了没有（用户截图：`main 重启 25分钟前`、`excel 支持 39分钟前`、`继续按钮追加 刚刚`）。

**根因（三条，都在桥端）：**

1. `subscribe` → `Manager.snapshot()` → `Session.markSeen()`：把「快照交给客户端」当成已读，`setState({done:false})` 默认 `touch:true`，`touch()` 把 `updatedAt` 改成 `Date.now()`（`bridge/src/sessions.ts`）—— 一次打开同时抹掉徽标和完成时间。
2. `Session` 构造把 `updatedAt` 写成 `Date.now()`，手里明明有 `meta.mtime` —— 桥重启后打开任何老会话都显示「刚刚」。
3. `startTail()` → 首次 `refreshFromFile()`：`tailSig` 初值 `""`，第一次必 `touch()` —— 文件没动也算一次活动。

**决定：**

- 完成状态持久化到 `<state>/finished.json`（`{"<sessionId>": <finishedAt>}`），与 `names.json` 同口径：桥自己的状态，写失败只损失持久化。`Session` 构造时读回；`list()` 对磁盘上有、内存里还没 `ensure` 的会话也读同一个文件；删会话时 `forgetFinished()` 一起清。
- 打开 / 订阅**不清**完成：删掉 `markSeen()` 与前端 `openSession()` 里的本地清除；`sessionBadge` 去掉「不是当前会话」条件 —— 当前打开的会话也显示「完成」。
- 清除条件只剩三个：`agent_start`、网页 `prompt()`（消息一发出就清，不等 pi 起跑）、会话文件被终端 / 外部续写（`refreshFromFile` 检测到变化）。三条都同时写 `finished.json` 清除。停止 tail（sleep / 让回终端）再恢复不算「外部续写」：`stopTail()` 把 `tailSig` 复位，恢复后的第一次读盘按「第一次」处理，只取 mtime。
- 「文件比完成标记新」的判据带 **1s 容差**（`FINISHED_SKEW_MS`）：文件系统 mtime 的精度与「settle 后我们自己再写一行」都落在这一秒内；超过 1s 才算停机期间的终端续写。构造、`list()` 与 `refreshFromFile` 三处共用 `finishedIsStale()`。
- `agent_settled` 写 `done:true` + 时间戳。GC 回收不再拿 `done` 当免回收条件（回收后 `ensure()` 会从 `finished.json` 读回来）。
- 时间显示：构造用 `meta.mtime`；`refreshFromFile` 首次读盘只取 `stat.mtimeMs`、不 `touch()`，之后文件真变了才 `touch()`。打开一个会话不再让它跳到「刚刚」，时间始终是「这个会话最后一次真正被写」。

**为什么：** 完成是会话属性、不是某页未读 —— D45 当初已经这么论证（桥端算 `done`），但「清理」仍挂在快照上，实际把属性降级成了未读。用户要在重启、换设备、隔一会儿再看时都能判断「这一轮结束了没有」。持久化而不只是内存标志，是因为桥重启或会话被 GC 回收后 `ensure()` 会重建 Session，内存标志会丢；写盘一次几个字节，和 `names.json` 一样便宜。清在 `prompt()` 而不是等 `agent_start`，是因为消息发出到 pi 起跑有 1–3 秒冷启（D120），这期间卡片不能还挂着「完成」。终端续写要清，是因为只读会话的「这一轮结束」在桥这侧没有事件（D45 的解释仍成立），文件变长说明有人在终端里继续，之前的完成已经过期。时间取 mtime 而非打开时刻，是因为用户要看的是「任务什么时候结束 / 最后活动」，不是「我看它的时候」。

**代价 / 可改：** 多了一个状态文件；会话删除必须同时清（已接进删除路径）。只读会话若终端刚写完、桥还没 tail 到，列表可能短暂显示「完成」再被文件变化清掉 —— 一次事件的事。当前会话显示「完成」是刻意改变；如果嫌和「运行中」来回闪，可以把完成改成左侧小勾或只在非当前会话上显示（**可改**）。

**验证：** `bridge/tests/session-flags.mjs` 改为「点开后完成仍在 + `/api/sessions` 里 `done=true` + 下一条 prompt 清掉」；`npm run test:done`（9 条纯逻辑：读回、mtime、过期清盘、`stopTail()` 后恢复不清、停机期间续写判过期）；`npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（含 `i18n-check`）、`npm run build:bridge`、`npm run build:web`。手测：跑完一轮 → 刷新页面 / 重启 bridge → 仍显示完成且时间是完成时刻；发消息后立即消失；终端 `pi -c` 续写后再看显示新时间。

## D163 附件弹层能引用「当前文件夹」；面包屑的盘符段跳到盘根；弹层按会话记住上次的目录（无票，用户要求）

**问题：** 三件事都出在「文件」弹层里：

- 只有文件行会把路径插进输入框，目录行点一下是「进去」，于是「我想让 pi 看这个目录」没有出口 —— 只能去资源管理器复制路径再粘回来。
- 点面包屑上的 `F:` 会闪一下又落回仓库目录（`F:\pi-web-client`）。根因不在盘符列表：`/api/dirs?path=F:` 里的 `F:` 是**盘符相对路径**，桥端按自己的 cwd 解析，而桥恰好就在 F: 上（`path=F:\` 才进盘根）。面包屑 `paintCrumbs()` 给盘符段的 target 是裸 `"F:"`；跳转输入框那侧早就有 `BARE_DRIVE` 兜底，只有面包屑漏了。
- 每次打开都从会话 cwd 重新开始，在同一个目录里连着挑两次就得重新点进去。

**决定：**

- head 里 `⌂ 工作目录` 右边加 **`📎 引用当前文件夹`**（`dirRef()`，形状照抄 `dirCopy()`）：读 `picker.path()`，含空格才包一对引号（`C:\Program Files\x` 裸着会被读成两个路径；没空格的包上反而多两处要删），走 `insertPaths()` 按 caret 插入，按钮闪「已引用」1.2 秒，**弹层不关** —— 接着还能选文件。「此电脑」页没有目录，按钮 disabled（原因写在 `title`；灰按钮上浏览器常不出 tooltip，所以灰本身也是提示）。
- 重复点只闪「已在输入框」不插第二遍。判定 `hasPathToken()`（`dirpicker.ts`）左右只认空白 / 引号 / 字符串边缘：`F:\a` 不能把 `F:\ab` 认成同一条，同一目录下的另一个子目录仍算新路径。
- 面包屑盘符段的 target 补上分隔符（显示文字仍是 `F:`），并且 `navigate()` 入口再对裸盘符兜底一次，免得下一个调用方重踩。
- 记忆**按会话**：`pi.attachDir:<sessionId>`，目录一变就写；打开时 记忆 → 会话 cwd → 盘符列表 依次退化，没有 session id 就既不读也不写。`pi.attachDir.index` 记着用过的键，超过 30 条删最旧的（删掉的会话不该一直占着键）。文件管理器不受影响，仍旧用它自己的 `pi.fsDir`。

**为什么：** 「引用目录」要跟「进目录」分开 —— 把目录行改成双击进入既改了这个弹层的操作习惯，又要给单点另找一个动作。放在 head 上、点完不关，「挑几个文件 + 引用几个目录」能一口气做完。分号那段修在面包屑而不是只修 `F:` 这一个字符串，是因为它错在语义上：盘符单独出现就不是一个完整路径，任何调用方传裸盘符都会重演。记忆按会话是因为「上次在哪儿」是会话的属性；用一份全局记忆会在切会话时把人带到不相干的目录。

**代价 / 可改：** 含空格的引用只是加引号，模型仍要靠它自己解析，跟粘贴路径的行为一致。记忆会留 30 个 localStorage 键（会话删了不会立刻清，靠 LRU 兜）。「此电脑」页按钮是灰的，不提供「引用某个盘」——用户明确说过不用。这几点都是口味，可改。

**验证：** `npm run typecheck`（含 i18n 三边对齐）；`npm run test:attach:ui`（`bridge/tests/attach-picker.mjs`，独立端口 `ATTACH_UI_PORT`（默认 7889，避开 memory-cap 的 7880/7882/7883 与 continue-ui 的 7888）+ 临时 state 的桥：① 📎 插一次、复点只回「已在输入框」；② 在 `F:\…\work` 点 `F:` 面包屑 → `/api/dirs?path=F:\` 且落在 `此电脑\F:`，列表里有 `pi-web-client`；③ 关掉重开弹层回到 `此电脑\F:`（记忆失效时先退 cwd 再退盘符页）；④ C/D/E/F/H/I 六个盘逐一点过，每条都断言落在 `<盘>:\` 且列表非空；⑤ 进到含空格的 `work\has space` 点 📎 → 插入的是带引号的整条；⑥ 塞满 30 条假会话再换一次目录 → 索引仍是 30 条、最旧那条被清掉；⑦ 把记忆改指不存在的目录再打开 → 退回会话 cwd，不停在盘符页）。修复前同一探针第 ② 步拿到 `path=F:`、落在 `F:\pi-web-client-wt\feat\attach-refine`。
## D164 「AI 出错记录」：右下角一键入账，按类去重，只读，能交回给 agent（无票，用户要求）

**问题：** AI 干活时会走弯路 —— 路径拼错、命令没装、grep 没命中、改了一个不存在的文件。每一步都「能完成任务」，但中间的错误散在几千行工具输出里，用户不可能每次都去纠正。界面上只有一行「N 个操作 · … · M 失败」，一轮结束就散了，跨会话更无从知道「这个算不算老毛病」。

**决定：**

- **入口**：一轮结束（`agent_settled` → `pi.status{running:false}`）时，如果这一轮有失败、而且这些失败还没入账，composer 右上角浮出一颗胶囊「⚡ 总结本轮错误 N」。刷新页面时从会话快照里回放最后那些失败条目（按 `toolCallId` 去重），所以回来按钮还在；N 是这一轮的**失败次数**（不是类数）。点一下入账，toast 上 10 秒内能撤销（桥端快照留 60 秒）；没有新增就不写文件。只送**还没入账的那一段**（`sessions[sid].n` 之后）—— 账本按 key 累加，整批重发会把旧条目的次数翻倍。
- **账本按工作区**（`<state>/failures/<ws>.json`），不是按会话：同一个工程的不同会话共享累计。ws 用会话 cwd 归一化后的组 id —— `workspaces.groupFor` 本来就把 worktree 并回主仓，所以五个 worktree 的错误落到一本账上。
- **归并键 = 工具 + 类型 + 归一化签名**：`cd <path>`、`grep :<n>` 这种。同键只 `count += 1`、刷新 `last`、明细插到最前留 20 条。类型由 `classify()` 判：路径 / 命令 / 权限 / 超时 / 限流 / 上下文 / exit / 中断 / 其他。
- **内容只读**：不进编辑器，没有「编辑」动作。能标「已修复 / 忽略 / 删除」。同一类再犯时「已修复」自动复活（忽略过的也退回未修，只是不吵）；「已忽略」只加次数。
- **位置**：`🐞 bug` 面板第五个 tab「⚡ AI 出错记录」。左栏是**卡片密度**（用户从三版样张里选的 B：一类一张卡，次数大字在右，下面一行工具 + 最近命令），待修按次数降序（同次数最近优先），已修复 / 已忽略 / 已中断各自折叠成一节；右栏是「为什么没成 + 当时给的修法 + 每次发生一张证据卡（发生时刻 / 会话 / exit、命令、输出首行）」。证据卡上的时间是那次失败**发生**的时刻（`item.ts`，live 事件用到达时刻），不是点「总结」的时刻。用户按停止（`stopReason: "aborted"`）也入账，落在「已中断」折叠区，不计待修。
- **交接**沿用面板里那套「交给 agent ▾」：整类 + 最近 3 次明细写进输入框（或新开会话再填），不自动发。
- **诊断在前端跑**：一轮算不算失败、属于哪类，要 tool 参数、命令原文和当时的 intent，这些只有页面这边有（还在 live 事件里）；桥只负责存与并，所以 `failures.commit` 收到的是已经判好类的条目。

**为什么按工作区、为什么只读、为什么不给编辑：**

- 用户要的是「不用每次纠正」，所以统计必须落在**跨会话**的账本里，会话一关不能就没。按工作区而不是按会话，是因为「同一类错误在同一个工程里反复出现」才值得修 —— 分到每个会话里，每本账都只有一次，排序就没意义了。
- 只读是因为这是从会话里抽出来的事实：手改次数，账本就失去「哪类最常犯」的意义。要改的是代码，所以给的是「交给 agent」，而不是编辑框。
- 账本落在桥的 state 目录（不是 localStorage）：换浏览器、清缓存不丢，和笔记、会话同一套备份与迁移。
- 去重键用「工具 + 类型 + 签名」而不是报错原文：原文带时间戳、路径、端口，两条都并不上；归一化之后，五次「同一个目录拼错」才能并成一条 `cd <path>`。

**代价 / 可改：**

- 自动重试（`auto_retry` 的 finalError）与扩展加载错误只以 live 事件出现，重启后拿不到 —— 这类只在当时那轮能入账。
- `classify()` 是保守的正则表，新工具 / 新报错会落到 `other`；要扩就加一条正则，结构不用动。
- 签名把数字一律折成 `<n>`，所以 `grep :7864` 和 `grep :7888` 算同一类。这是有意的（同一类「没命中」），以后要按端口分开看得改归一化。
- 明细只留 20 条，更早的只剩次数；要看全部得回会话。
- 账本不参与「清空垃圾箱」之类批量清理，删单类要一条条点。**可改。**
- 面板带检索与「导出这份账本」，以及单工作区 200 类的静默上限（防单个文件无限长）：前两者不在用户原话里，是让账本能被带走 / 找到的附带手段；超上限时最旧的那类会被丢掉，要更彻底得按类删。

**验证：** `npm run test:failures`（16 条纯函数：分类、归并、排序、状态、交接文本、ANSI 首行）；`node bridge/tests/failures-ui.mjs`（自带丢弃式 bridge + `fake-pi` 的 `FAILS` 场景，真 Chromium **28 条**：CTA 数字、刷新后回放、点击入账、盘上文件、四颗失败归三类、tab 计数、排序、明细原文、标已修复、交接双落点、再犯累计、撤销回退）；`npm run test:continue:ui` 14 条不回归；`npm --prefix web run typecheck`（tsc + i18n-check，1464 键 × 3 语言）；`npm run build:web` / `build:bridge`。
## D165 聊天记录把 `/skill:x` 的展开块折回命令，命令画成 chip（无票，用户报的）

**问题：** 一条用户消息在气泡里显示成 `<skill name="grill-me" location="C:\…">整篇 SKILL.md</skill>`，右侧刻度带的悬停行同样。根因在 pi：发 prompt 前它把 `/skill:<name>` 展开（agent-session 的 `_expandSkillCommand`，`const skillBlock = \`<skill name="…" location="…">…</skill>\`` 再拼上 args），展开结果既进模型上下文，也原样写进会话 JSONL。桥 `entriesToItems` 把它当普通文本透传，前端 `buildUserBody` 只做 `textContent`，于是整篇 SKILL.md 成了气泡内容。侧栏标题早就用 `titleFromUserText` 单独修过（同一个正则），所以只有聊天区难看。同一根因还漏在别处：复制按钮复制整篇 SKILL.md、⑂ 分叉把整篇塞回输入框、分叉的兜底匹配拿原文比对（前端回传折回的命令会直接报「在会话文件里找不到这条消息」）、**队列**（pi 在 `_queueUserInput` 里同样是先展开再入队，`clear_queue` 回来的就是展开文本，撤回会把整篇塞回输入框、队列条显示整篇）、**随手问**只折了文本没折样式、带图消息的 `[图片]` 占位被当成 args。

**决定：**

- 归一化放在桥的数据边界：`bridge/src/sessionfile.ts` 里 `skillExpansion()` 认出「开头是 `<skill …>…</skill>` 再加 args」的文本，`displayUserText()` 是它的一行封装，`normalizeUserText()`（折回 + 塌空白 + trim）是**一切跨端比对**用的那一个 —— `titleFromUserText`、`branchOff` 的兜底、`withdrawQueue` 的队列匹配全走它，不再各写一个 `norm`。开标签是宽松的（`<skill\b([^>]*)>` 认任意属性顺序/多余属性，`name` 用 `\bname="([^"]*)"` 单取），正文**贪婪**到最后一个 `</skill>` —— SKILL.md 自己会引用这个格式，非贪婪会把 args 一起吃掉。`location` 可选：没有就不写 `skillPath`，不用空串哨兵。**会话文件与模型上下文一个字节不动** —— 展开是 pi 的事，桥没有资格改历史。
- `bridge/src/items.ts` 用折回文本当 `item.text`，并给 user item 打 `skill` / `skillPath`（后者只做 chip 的 tooltip）。解析只用**文本段**（`extractText(msg.content)`），`contentText` 给图片追加的 `[图片]` 不参与 —— 否则带图技能消息的命令后面会多出一个「[图片]」。
- 队列同根因、同时修：pi 在 `_queueUserInput` 里先展开再入队，所以 `setQueue()` 落库前过 `displayUserText`（队列条读命令），`withdrawQueue()` 用 `normalizeUserText` 两侧比对并回填折回文本（撤回不再把整篇 SKILL.md 塞回输入框）。
- 展示收进 `web/src/skill.ts`：`skillOf()` 认「输入框里敲的 `/skill:x`」（乐观气泡与技能计数用），`fillUserBody()` 是**药丸 + args** 那段 DOM 的唯一实现，聊天区（`chat.ts` 的 `buildUserBody`）与随手问转录（`scratch.ts`）共用；`adopt()` 也用它重建 body —— 桥那份比本地的更准（tooltip 的路径要等文件回来），只换 `.body`、不换节点，免得丢焦点/滚动。
- 发送瞬间的乐观气泡由 `app.ts` 用 `skillOf()` 打上标记，否则 400ms 后文件一到，气泡会从纯文本跳成 chip。
- 药丸的描边/底色走 `color-mix(in srgb, var(--accent) …)` 而不是硬编码的 `rgba(125,211,252,…)`：仓库有六个 accent（`web/src/palette.ts` 的 `ACCENTS`），写死一个颜色在别的主题下描边和文字会对不上。
- 术语进 `GLOSSARY.md`：「折回」与「药丸 / 技能药丸」，免得下次又临时发明同义词。

**为什么：** 展开块是 pi 回放给模型的真实输入，动它等于伪造历史；能改的是展示层，而把归一化放在桥（`item.text` 一次成型）比放在前端划算 —— 复制、分叉、随手问转录、刻度带全都读同一个字段，一处修好四处对。只认消息开头（与 pi 自己的 `startsWith("/skill:")` 一致），普通消息保持字节恒等，折回幂等（分叉路径会拿到已经折过的文本）。

**代价 / 可改：** 用户真的把 `<skill name=…>…</skill>` 敲进输入框开头，也会被当成技能调用显示（形状相同，无从区分）；反过来，结构能认成开头但缺 `</skill>` 的残缺块**退回原文**（宁可露原文也不猜着折）；`/` 模板展开（pi 不写 XML 包裹）不处理；chip 的圆角/配色是口味，可改；`skillOf` 与 `skillExpansion` 是两份实现（web 与 bridge 是两次独立构建，不能互相 import），靠单测里 `assert.equal(skillOf(t), typedSkill(t))` 钉住，边界情况（别名的 `/skill:` 后到第一个空白为止）仍可能不同。**未覆盖：** `adopt()` 用桥端 item 重建 body 那条路径没有 e2e —— 探针不跑活的 pi，桥端 `prompt()` 在 `if (!this.rpc?.alive) throw` 就抛了，`item.add` 到不了页面；起 stub pi 得连 `get_state` / `get_session_stats` / `get_commands` 的应答形状一起仿，改写整个 transcript 的风险大于收益，只由代码走查 + 类型检查保证。

**验证：** `npm run test:skillblock`（`bridge/tests/skill-block.mjs`，15 条：折叠、args、location 缺失时不写 `skillPath`、普通消息字节恒等（含无名 `<skill>`）、前导空白、正文里引用 `</skill>` 不截断、属性乱序、幂等、标题行为不变、`entriesToItems` 的字段、图片占位不进命令、`normalizeUserText` 空白等价、乐观标记、web `skillOf` 与桥 `typedSkill` 同答案）；`node probes/skill-block.mjs`（真实 Chromium + 临时 state + 手写会话文件，不起 pi 子进程；`PI_WEB_PORT` 覆盖但**拒绝 7864**，`dist` 比 `src` 旧就拒跑 —— 18 条全过：气泡读成命令、整页无 `<skill`、chip 与 tooltip、`innerText` 保留空格、普通消息不受影响、复制按钮给命令、刻度 tooltip 与悬停行都读命令、**真实发送阶段**的乐观气泡当场就有芯片且 1.5 秒后不重影，截图 `.scratch/skill-block/shot.png`）；`npm run typecheck`（含 i18n，1483 键 × 3 语）、`npm run build`。
> 编号说明：Excel 预览这条原编号 D127；落到 `main` 时 D127 已被「交给 agent」占用，顺延为 D166（D164 被「AI 出错记录」、D165 被「技能调用折回」占去）。正文与它描述的代码没变。

## D166 Excel 预览：只读的格子 + （要看图时）LibreOffice 转出来的纸面，装在一扇可拖拽的浮窗里（`#71`）

**问题：** `#71` 原本是一份「读 + 外科手术式写回」的方案。开工前把范围收了一次：写回要 D113 写锁跨过
人工编辑的时长、要 733 MB / 1.48 GB 内存的 exceljs、还要和 Excel 抢同一个文件；而用户真正缺的是
「点开就能看，数和图都在」。原方案还把图表做成「按锚点留白的虚线占位」，用户明确不接受（原话：
「图表、公式完全能够显示，类似微软的 preview」）。

**决定：**

- **只读，不写回**：写回另开一条 issue 封存，等只读落地后再评估；issue 里的「agent 也能改」同样不做。
- **解析用 fflate + 自写的流式 XML**，不引 exceljs（整本读的实测内存 733 MB / 1.48 GB 不可接受，
  且它的写是整本重写，与「保住图表」天然冲突）。
- **取数**：常驻一个 worker，每个可视窗口从 zip 里流式扫到目标行；只缓存元数据（共享字符串 / 样式 /
  合并 / 条件格式 / 列宽），整本按 `path+mtime+size` 缓存、LRU 限字节（默认 128 MB），前端预取 3 屏。
  不缓存解压后的整表 XML，也不把整表发给前端。
- **阈值（见下方 #110 实测补记）**：全量 ≤10 万格 / 只值轻量 ≤100 万格 / >100 万格不给。
- **公式只用缓存值**：缺缓存的格子显空 + hover 给公式原文 + 工具条「N 格无缓存值，需在 Excel 打开重算」；
  不引重算引擎，也不整表借 LibreOffice 的值（那会把「文件里的数」和「算出来的数」混在一起）。
- **条件格式五类全做**（色阶 / 数据条 / 图标集 / cellIs / 表达式），在桥端对可视窗口求值；求值器不认识
  的规则**不涂色**、并在工具条明说「N 条暂不支持」，不静默当 false、也不整表降级。
- **图表不在网格里占位**：只有 zip 里真有 `xl/charts/chartN.xml` 时才提供「页面视图」——
  `soffice --headless --convert-to pdf` 转一次（本机实测冷 12.2s / 同 profile 热 6.7s，38 KB PDF），
  按 `path+mtime` 缓存，挂同源 `/api/sheet/pdf` 的 iframe（`/raw` 每条响应都带
  `CSP: sandbox ...`，PDF 在里面白屏，所以必须另开端点，且这个端点不带 sandbox）。
- **窗口是浮窗，不是 viewer 面板**（用户看过样张后定的，推翻「套进右侧预览栏」）：默认 1180×780，
  够宽时左网格右纸面，拖窄到 900 以下退成「网格 / 页面视图」两个 tab；手势照 D92 / D93
  （标题栏拖走、右下角改宽高、上边缘 7px 改高、双击复原、几何记 localStorage、clamp 在视口内），
  层级与终端并列（46 / 47，D111）。样张在 `.scratch/xlsx-preview/prototype/`（Q1 落选为实装形态）。
- **CSV / TSV 同一个窗**：「表格 / 源码」两个 tab，默认表格；字节仍走 `/raw`，前端 `TextDecoder`
  嗅探 BOM / GBK 后切格（本机实测 `new TextDecoder("gbk")` 可用），保存走现有文本通道。
  #113 实装补记：保存时由桥端按**打开时嗅探到的编码**写回（GBK 的表不会变 UTF-8，编不出来的字 400 报错
  而不是静默替换）；表格只读、改动都在源码 tab；超过 5 万行只显示前面一段，且这种截断的文件不给保存。
- **出口**：新增 `/api/open`（仅本机、只接受 `/api/preview` 发放过的路径）；reveal 与下载保留。
- **选区引用给 pi**：往对话框插「路径 + `A1:C9`」纯文本，不自动发送。

**为什么不用 viewer 面板：** viewer 固定 `min(760px, 55vw)`（D121），760 px 里「格子 + 纸面」并排是两栏各
380 px，两边都看不清；而用户要的是「拖大拖小由我」。浮窗还能和终端共用一套手势与层级规矩。

**为什么是页面视图而不是自己重绘图表：** 手算 OOXML 的图表（锚点、序列、坐标轴、图例、主题字体）等于写一个
小渲染器还要猜 Excel 的默认值；LibreOffice 已经能把打印版式和图表一起吐成 PDF，代价只有一次转换。

**代价 / 可改：**

- 页面视图是**打印版式**：分页、不能连续滚，几百行的长表要翻十几页 —— 所以网格仍是主要看法，纸面只在
  「要看图」时切过去。
- 首开 6.7s（本机、同 profile 热启动），所以显式触发 + 按 `path+mtime` 缓存；没有图表的文件默认不转，
  工具条上仍可手动切。
- 纸面是近似：LibreOffice 的默认打印区域 / 页边距 / 缩放与用户 Excel 的设置不一定一致。
- 浮窗默认 1180×780、断点 900 是我照样张 Q1 定的，可改。
- iframe 内建 PDF 查看器在 Edge / Chrome 的表现还没实测（阈值与 PDF 耗时已实测回填，见下方补记）。

**实现备注（code-review 后）：** 出口与降级把 `.xlsb` 与 `.xls` / `.ods` 一并走二进制分支（`/api/open` 可开）；
读端点（meta / window / find / pdf）都补了 `publicReq` 拒绝，`open` 成功返 200（`{ok,message}`，不是 204 —— 前端 `req()` 统一 `res.json()`，空响应体会抛）。已知技术债（本次不修）：
`el()` 在 `grid.ts` / `dialog.ts` 重复；浮窗 split 拖拽（`dialog.ts`）未复用 `floatwin.ts` 的 `dragFloat`；
`Range {r0,r1,c0,c1}` 在 grid / csv / dialog / api 四处各写一遍。

**验证：** `bridge/tests/fixtures/make-xlsx.mjs` 造全部 fixture（多 sheet、合并、五类条件格式、柱形图、
日期与数字格式、中日混排、五档压测表、GBK + 分号 csv），不把客户文件进 git；`probes/xlsx.mjs` 出截图；
Playwright 用 `locale: "zh-CN"`；阈值的实测数字与 PDF 耗时回填本条。

**#110 实测补记（2026-11-06）：** 五档压测表由 `bridge/tests/fixtures/make-xlsx.mjs` 现场生成（100 列，统一带一张覆盖全表的色阶，专门把「全量档要算条件格式」这笔钱算进去），不提交进 git；`probes/xlsx.mjs` 每档都重启一个冷桥、用 `locale: "zh-CN"` 的 Chromium（1440×900）打开，首屏 = 点文件行到第一个有字格子的墙钟，峰值 RSS = PowerShell 每 100ms 采一次桥进程 `WorkingSet64`，解压字节 = 顶部窗口实际消费的表 XML 字节 / 该表未压缩大小。数字是本机（Windows，Node 24）实测：

| 档位 | 格数（行×列） | 首屏 | 峰值 RSS | 顶部解压 / 整表 | 拖到底 |
|---|---|---|---|---|---|
| 全量 | 2 万（200×100） | 276ms | 94MB | 59,317B / 579KB | 51ms |
| 全量 | 10 万（1,000×100） | 856ms | 103MB | 59,318B / 2.97MB | 107ms |
| 只值轻量 | 40 万（4,000×100） | 250ms | 120MB | 59,318B / 12.5MB | 242ms |
| 只值轻量 | 100 万（10,000×100） | 862ms | 162MB | 59,319B / 31.7MB | 626ms |
| 不给 | 300 万（30,000×100） | 151ms | 100MB | 无窗口请求 | — |

（同一档不同轮次会抖：10 万首屏另一次 353ms，100 万峰值 161–206MB、拖到底 424–626ms，300 万 54–151ms。阈值按较差的那次看；40 万「全量」的 1,918ms / 196MB 是降档前的实测。）

- **全量 ≤ 10 万格**：10 万格 856ms / 103MB，还在 1s、150MB 的预算内；40 万格若走全量要 1.9s / 196MB，比 100 万格轻量还慢，所以 40 万降到轻量。全量与轻量的分界是**条件格式统计**，不是解压本身。
- **只值轻量 ≤ 100 万格**：不建条件格式计划、不涂色，网格照常滚；100 万格 862ms / 162MB（差轮 206MB），再大就超过桌面端可接受的内存。
- **不给 > 100 万格**：只解析工作表清单与 `<dimension>`，不做整表扫描；300 万格 151ms / 100MB，浮窗里给清单、`30,000 行 × 100 列` 和「用本机程序打开」，不建网格、不发窗口请求。
- **预取 3 屏**：顶部可见 21 行时请求 88 行（下方 3 屏，顶部没有上方可预取），桥端硬上限 400 行；滚动后按可见段 ±3 屏重新取，旧段按「可见 ±12 屏」裁剪。同一 `r0..r1/c0..c1` 连问两次，`rows` 的 JSON 全等；表切换用 epoch 丢弃过期响应，不再串行污染。
- **没有测出来的**：真实客户文件（共享字符串/样式特别大的、合并区特别多的）、100 万格以上的深跳（不给档没有网格）、300 万格多工作表同时打开、长时间滚动后的内存回落、Firefox/Safari、以及 10 万到 40 万之间更细的全量边界（只采样了 10 万与 40 万两点）。soffice 大表的耗时与页数仍未测。

## D167 文件管理器里新建文件夹 / 新建文件：在**当前目录**建一层，建完停在原地（无票，用户要求）

**问题：** `📁 文件管理器` 和附件弹层都只能看和改，要新建一个空文件得切到终端 `touch`，建文件夹只有「新会话」那张弹层里有 —— 而那里建完会直接进新目录，和「我正在这个目录里整理文件」不是一回事。

**决定：**

- **两处入口，一份控件**：文件管理器与附件弹层的路径行（`.dir-head`）各加两颗按钮 `＋ 文件夹` / `＋ 文件`（`App.mkControls`）。新会话弹层不动：那里的焦点该先落在「工作目录」，且建完要进新目录，语义本来就不同。
- **建完停在原地**：刷新当前目录、把新行标成 `.hit` 并滚到可见处（`DirPicker.reveal(name)`），**不进入新文件夹、不打开新文件**。理由：这是「整理目录」的动线，不是「跳进去干活」；自动进去/打开会把筛选、滚动位置和上一跳的高亮一起冲掉。
- **只建一层、名字原样**：桥端 `makeFile(parent, name)` / `makeDir(parent, name)` 共用 `checkEntryName()`（空名、`.`/`..`、255 上限、无 `/` `\`、控制字符、Windows 非法字符 / 结尾空格或点 / 保留名）与 `resolveParent()`；**不补扩展名**、不改大小写、不替用户去重（同名报「已经存在」）。
- **文件是 0 字节空文件**，`fs.writeFileSync(target, "", { flag: "wx" })`：`wx` 让「同名即失败」变成原子操作 —— 先 `existsSync` 再写会留一个窗口，把别人（编辑器、终端里的 `touch`）刚建的同名文件截断。
- **写就要口令，两者一视同仁**：`mkfile` 和 `mkdir` 一样先 `requireStepUp()`（本机 / 局域网连接天然放行，公网 10 分钟窗口；D186 起 1 天）。
- **信令**：新增 WS `{type:"mkfile", reqId, parent, name}` → `{type:"mkfile.result", reqId, path|error}`，和 `mkdir` 对称；前端把两张等待表合成 `mkWaits`（结果形状一样）。错误文案由桥端给中文原样显示（与 `mkdir` 一致，不自造 `errCode`）。
- **输入行**：预填「新建文件夹」/「新建文件」并全选（同资源管理器：回车就是默认名）；`Enter` 提交、`Esc` 收起；盘符页（没有当前目录）两颗按钮隐藏。

**为什么：**原因有三条 —— 为什么是「路径行两颗按钮」而不是右键空白处或一次一个「＋ 新建 ▾」、为什么建完不进去、为什么不让名字自动去重。

- 目录行和文件行已经占满右键菜单（`open.script` / 打开 / 复制路径），再往里塞「新建」会和「新建在哪个目录」纠缠；空白处右键在触摸屏上没有入口。
- 两颗按钮比一个下拉少一次点击，代价是附件弹层路径行变成四颗按钮 —— `.dir-head` 加了 `flex-wrap: wrap`，宽度不够时按钮整组换行，路径至少留 240px。

**代价 / 可改：**

- **刷新用的是 `go()`，也就是 `navigate()`：它会清掉筛选框、把列表滚回顶部**（再靠 `reveal` 滚到新行）。所以「不进去」保住的是「不用自己点返回、不会误开文件」，**不是**筛选状态或滚动位置 —— 要保住筛选得另外改 `navigate`，这次没做。
- 每次新建都要一次 bridge 往返 + 一次整目录重列；大目录（上千项）里那次重画会闪一下（与「跳到路径」同源）。
- 预填的默认名跟界面语言走（en 下回车就建出 `New folder`）—— 和资源管理器一致，是有意的，不是漏翻。
- 新会话弹层那套 `submitMk` 与这里形态相近但语义不同（那里建完要进新目录），没有合并；只把「建完重列 + 高亮」抽成了 `App.revealMade`。
- `.hit` 是**一次性**的：下一次导航就清掉，不会一直标着「刚建的」。
- 重名是报错不是「改成 新建文件夹 (2)」—— 自动改名会让用户点错东西；要自动化可以后面再加。
- 附件弹层里新建的文件不会自动附加：仍然要再点它一下（建文件是整理，附加是另一件事）。
- 没有做「在某个子文件夹里新建」（先点进去再建）；移动 / 删除 / 重命名也没做。

**验证：** `node bridge/tests/mk-file.mjs`（12 项：0 字节、不覆盖、只建一层、父目录、Windows 规则、`makeDir` 报错文案回归）；`node bridge/tests/attach-picker.mjs` 在临时桥上用 Playwright（`locale: "zh-CN"`）跑两处界面：预填 / 回车 / 高亮 / 停在原地 / 重名保留原内容 / Esc 收起 / 文件管理器同款按钮。

## D168 「回到底部 / ↓ new」只在下面真有东西时出现：转录装得下（余量 ≤ 24px）时上滚不算「掉队」（无票，用户口头报障）

**症状**：一条短会话（转录整体装得下、下面空无一物），鼠标在转录上随便上滚一格，底部正中就长出「↓ new」；再点一下回到底部，视口其实一动不动。

**根因**：`wheel` 上滚、`PageUp` / `ArrowUp` / `Home` 都无条件 `holdUp() → stopFollowing()`，而「不跟流」这个状态本身就会画出那颗钮（`renderJump` 只看 `following`）。随后流式输出的下一段内容进来，`scrollToEnd()` 在 `!following` 时把 `unread` 点亮，于是连 new 小标也来了 —— 三种状态（手势、跟流、未读）各自都对，合起来却是一句假话：下面什么都没有。

**决定**（`web/src/chat.ts`）：

1. 新增 `hasRoomBelow()`：`scrollHeight - clientHeight > BOTTOM_SLACK`。`BOTTOM_SLACK = 24` 与 `nearBottom()` 共用（**接续 D54**：D54 把 24 记成「可改：阈值在 `nearBottom()` 里」，现在它同时决定「下面还有没有东西」，两处必须同一个数，否则会出现「钮说下面有东西、但滚不动」的缝）。
2. 守卫放在 `stopFollowing()` **本身**（`!following || !hasRoomBelow()` 直接返回），而不是每个调用点各写一遍：`wheel` / `PageUp` / `Home`（`holdUp`）、`touchmove` 那条 ≥ 6px 的拖拽、以及点缩略图的 `jumpToTurn` 都汇到这一个出口。`holdUp()` 另外先早退一次，让 `holdFollow` 在空滚时也不被推后。
3. `renderJump()` 的 `hidden` 改成 `following || !hasRoomBelow()`：内容缩水、窗口变高之后「下面没东西了」也不再画那颗钮。补三次重算覆盖「内容自己缩水」：挂在 `root` 的 `ResizeObserver`（不跟流时）、折行之后（`foldable` 的按钮与助手回复的 `msg-fold`，一次能缩掉几屏）、以及 `remove()` 抽回排队消息之后。新内容进来本来就会经 `scrollToEnd()` 再渲染一次。

**为什么先看余量而不是先看方向**：D94 已经把「恢复跟流」限定成「视口在往下走 + 300ms 冷却」，那解决的是**手势被拽回去**；这一条是反面 —— 手势根本没发生位移，却改了状态。判据只能是「有没有东西可滚」，方向、速度、事件种类在这里都无能为力。

**可改**：24px 这个容差（`BOTTOM_SLACK`）；`hasRoomBelow()` 只看纵向余量，横向溢出（超长代码行）不影响判断。只挡住「下面没东西」这一面，没有改变 D94 的「往下滚 + 300ms 冷却才恢复跟流」；余量落在 24–48px 之间时，钮会出现，但往下移不超过 24px 就会恢复跟流、钮随即收起。

**验证**：`node probes/jump-nothing-below.mjs`（11 项，真实布局 + 真实 `mouse.wheel` + CDP 触摸，用 `tools/paths.mjs` / `tools/playwright.mjs` 取路径与浏览器，D114）：短会话初始 / 上滚 3 格 / 上滚后再来内容 / 触摸下拖 120px 都不出钮且视口仍钉底；喂到溢出后上滚，钮照常出现、掉队期间来内容亮 new、点一下回到底并收起；容差带（`room = 10`）上滚不出钮，刚过容差（`room = 60`）就出钮——把 `BOTTOM_SLACK` 改成 0 或 100 都会有一项失败；不跟流时把长回答折起来（`item.replace` 落定后点 `.msg-fold`），钮跟着收起。改前 8 项版的 5 项 FAIL（上滚后 `jumpHidden:false`，随后 `hasNew:true`，与报障截图一致），改后 11 项全 PASS。回归：`probes/scroll-race.mjs`（D68 / D94 的触摸 + 滚轮断言）与 `probes/round10-scroll.mjs`（Q-018 跟流、600 条突发）仍全 PASS。

## D169 失败账本回流进了会话：老毛病跟着 spawn 进系统提示词，同类再犯当场叫住（无票，用户要求，D164 的延伸）

**问题：** D164 的账本只会事后总结 —— 面板按次数排序，人读完改流程，可下一次的模型看不见它。同一个 `cd <path>` 的坑在这台机器上踩到第 9 次，换一个会话照踩。用户的目标是「以后不会出现这种错误」，光有记录不够，记录得往回流动。

**决定：**

- **两处回流，一条总开关**：`PI_WEB_LESSONS=0` 同时关掉下面两块（默认开）。一开始想做成设置项、由桥读 `ui-prefs`，但那要多一条前后端往返与一次落库；这是「看着烦就关掉」的东西，env 一行够用，真要常改再升级成设置项。
- **开场记性**：`Session.startLive` 在 `launchArgs` 之后追加 `--append-system-prompt <文件>`（pi 的这个参数可重复，不会顶掉用户手填的那段，`docs/cli.md:231`）。文件由 `lessonFile(ws)` 写到 `<state>/lessons/<ws 的 sha1 前 8>.prompt.md`，内容 = 「≥3 次、没标已修复/忽略、不是用户中断、原因单一」的类，按次数降序最多 6 行、整体 ≤1200 字。**传文件不传长文本**：用户手填的系统提示词自己就能占两万字符，命令行塞不下两条。
- **只收单一原因的类**：归并键把几次不相干的失败折成一类时，`why`/`fix` 会张冠李戴（本特性之前账本里那类「9 次 cd」正是如此）。`causes.length > 1` 的类只进账本、不进提示词 —— 宁可不说，也不给一句错结论。
- **当场叫住**：前端在**实时**失败（`live` 标记，历史回放不算）里算出同类在这个会话里的第几次；第 2 次、或账本里这一类已栽过 3 次时发 `failures.remind {ws, sid, key, tool, sig, why, n}`。桥侧再核一次账本（`count >= 2`）并节流（同类每会话一次、整会话 3 次），然后 `Session.prompt(text, …, "followUp")` —— 正跑着就排队，跑完立刻看到。**没在跑就不提醒**：为一句提醒冷启一个 pi 不值得。
- **提醒长得像系统，不像用户**：pi 的 RPC 只有 `prompt`，所以它在会话文件里是一条 user 消息。正文以 ASCII 标记 `[pi-web:remind]` 开头，前端据此画成「自动提醒 · 老毛病重犯」的竖线块（不给复制/分叉），刷新后从文件回放也认得出。抬头走 `tr()`，正文（诊断原文、形状）保持中文数据 —— 与工具输出同一条约定。
- **回执**：桥回 `{type:"failures.reminded", ok}`；`ok:false`（没在跑 / 账本不够 / 节流）时前端释放「在途」标记，下一轮同类失败还能再试一次，不会因为一条被丢掉就永久静音。

**为什么：** 三条 —— 为什么进系统提示词而不是每条消息都提醒、为什么门槛是 3 次、为什么「当场叫住」走 prompt 而不是 notice。

- 每轮都塞一句「你以前栽过」会让模型疑神疑鬼，也占掉本该给任务的注意力；spawn 期一次、内容稳定的清单，才是「这个工程的常识」。
- 2 次可能只是手滑；账本里 3 次以上、且没有标已修复/忽略，才算「这个仓库的老毛病」。同一个门槛给提示词与提醒共用，用户只需要理解一套规则。
- notice 是瞬时的、不进模型上下文 —— 模型看不见就等于没提醒。

**代价 / 可改：**

- 提示词是 spawn 时的快照：会话开久了，账本新入的类不会追进这一轮；下一次唤醒（休眠后）才生效。
- 账本里同一类累计到 3 次之前不出现；偶发失败永远只是记录。
- 提醒文案是桥写的中文，en/ja 界面里抬头是译文、正文仍是中文（诊断与形状本来就是中文数据）。
- 每个会话最多 3 次提醒：同类重犯第 4 次不会再有声 —— 那时该由人改流程了。
- `lessonFile` 每次 spawn 重写一次文件；多会话同时 spawn 会各写一遍同样内容（原子 rename，不会读到半截）。

**验证：** `npm run test:lessons`（10 项：门槛/顺序/长度/单一原因/文件落盘/文案/节流）；`node bridge/tests/lessons-spawn.mjs`（8 项，真 bridge + 脚本化 pi：首 spawn 不带参数 → 入账 3 次后重开 argv 里出现 `--append-system-prompt` 且文件内容对得上 → `failures.remind` 让 pi 真的收到一条提醒（回执 ok:true）→ 同 key 再发回执 ok:false 且不再重复）；`node bridge/tests/failures-ui.mjs` 28/28 不回归；`npm --prefix web run typecheck`（含 i18n-check）。

## D170 后台子代理：会话 settle 了也要说明白，并先把「继续」按住（无票，用户报的）

**问题：** 让 pi 派一个后台子代理（`acp_delegate` / `subagent`，async）之后，界面立刻变回「空闲」：没有提示条，左栏那枚徽标写「完成」，输入框上方的「继续」还能点。用户看到的是一条已经收工的会话，实际后台还在跑；这时点「继续」等于插队多推一轮 —— 而 pi 本来就会在 runner 回来时自己接着做。

**根因：** 桥里 `running` 只由 pi 的 `agent_start … agent_settled` 决定，而**子代理不是这一轮的一部分**：派出去的那次工具调用结束，pi 这一轮就 `agent_settled` 了，之后直到 completion 通知进来，协议里**再没有任何**「我还在忙」的信号。会话文件里那个 toolResult 的 `details.status` 也永远停在 `running`，读它没有意义。

**决定：**

- **桥端按会话记一张后台任务表**（新文件 `bridge/src/bgruns.ts`，`class BgRuns`）。两个口喂它：
  - `noteToolEnd(tool, details, text)` —— `tool_execution_end` 的 `details` 里认 `runId`（acp_delegate 给 `{kind:"delegate", runId, agent}`，pi-subagents 给 `{runId, asyncDir}`）；没有 `details.runId` 时退回结果文本里的 `` runId `…` ``。**只有「刚开跑」的结果才算开一条**（`details.kind === "delegate"` / 有 `asyncDir` / 文本带 `Running in the background`），否则把 wait 的调用示例抄进结果就会造出幽灵任务。
  - `noteText(text)` —— 结束信号只有 runner 自己注入回会话的那条消息（`[acp_delegate completed] … (runId `…`)`、`[acp_delegate FAILED ⚠️] …`）。它可能作为 steering 排进队列（`queue_update`），也可能直接把空闲会话唤醒（`message_start` 的 user 角色），**两头都接**。只在 runId 已认识时才动手，所以误判最多提前收条提示，不会凭空造任务。
- **状态放在 `SessionState.bg`**：`{n, agent?, since}`，变了才 `setState`，且 `touch: false`（后台跑着不该把左栏的「几分钟前」刷新一遍）。走现成的 `session.state` 广播 + hello/list，所以刷新页面、换设备都还在 —— 但它**纯内存**，桥重启就没了（会话文件里查不到 runner 的死活，这是这一版接受的代价）。
- **清空时写 `null` 而不是 `undefined`**：`undefined` 过 JSON 会被整条丢掉，页面就永远收不掉提示条（实测踩到过）。
- **前端两处，同一份判据：**
  - `web/src/continue-state.ts` 的 `continueState()` 里加一条 `bgBusy(s)` → `"off"`（灰，不是藏）。这个纯函数是「继续」的唯一判据口，`app.ts` 不另写判断。
  - 输入框上方一条提示：`● 子代理运行中 · researcher · 已跑 1:23`（`.bg-bar`，插在 `.row` 之前）。秒数挂在已有的 `startClock()` 里滴答，不重画、不轮询。
  - 左栏徽标在「运行中」与「完成」之间加一档「后台」/「后台 N」（`sessionBadge()`，`cls` 复用 `run`）。
- **不读盘**：D133 那套（`.activity` 的 mtime + `status.json`）留给「卡片 + 步数 + 看过程」那一版；这一版只要「在不在跑、跑了多久」，读盘反而多一层可能读错的东西。`BgRun` 往外多带字段就能接上。

**代价 / 可改：**

- **桥重启后提示条会消失**（runner 还在跑，但表是内存的）。刷新页面、换设备、重新打开会话都不会丢 —— `bg` 在会话状态里，跟 `running` 一样从 `hello` / `session` 快照里来。要跨重启就得把 runId 落盘，并解决「文件里查不出死活」—— 那时大概得回到 D133 的痕迹文件。
- **一个从没报过完成的 run 会在 6 小时后被判死**（`SILENT_DEAD_MS`），界面上就是提示条自己收掉。真跑 6 小时以上的任务会被误判，但比「永远挂着一句运行中」好。
- **跑完的 run 留 10 分钟**再丢（`KEEP_DONE_MS`）：这段时间提示条翻成「子代理已结束 · 用了 3:21」，点得开看最终输出，但**不再拦「继续」**。过后从表上、提示条上一起消失（`.out` 还在盘上，只是界面不再指过去）。
- **只覆盖会回报 `runId` 的两种派发**。别的「后台还在干活」形态（比如扩展自己起的定时任务）还没有口子。

**验证：** `npm run test:bgruns`（19 项纯函数：acp/subagents 两条路、重复 runId 不重复记、完成/失败/取消都收、无 runId 不记账、误导性文本不造幽灵任务、`since` 取最早、跑完转「已结束」且不再拦「继续」、线上形状不泄绝对路径、痕迹文件读尾与 `ACP_DIR` 前缀校验）；`npm run test:continue`（13 项，多出 3 项 bg 判据）；`node bridge/tests/continue-ui.mjs`（**40 项**：提示条出现/写着 researcher/在输入框上方/计时在走/「继续」灰/左栏是「后台」；点横幅开详情、写着任务原文、过程里读到手写的活动记录尾、关掉就收；点徽标也能开；**刷新页面后提示条与灰按钮都还在**；completion 通知（`role: "custom"` 那条）到了就翻成「已结束」、不再拦「继续」、样子不再闪；这时点开还能看到「已完成 · 用了 0:01」与 `.out` 里的最终输出）。截图 `.scratch/shots/continue-bg*.png`。

**补：点开看详情（同一条 D170，用户问了「能点开看详细信息么」）**

入口两个，开的是同一屏：输入框上方那条横幅（整条可点，`role="button"`，Enter/空格也行）、左栏「后台」徽标（`stopPropagation`，不然会顺带把卡片自己的「打开这个会话」也触发）。弹层用现成的 `.sheet`。

里面一屏一张卡片，只有三块：

- **概览**：agent、派出去的原话（`details.task`，没有就取结果里的 `Task:` 行）、runId、状态 + 耗时（**跑完用 `endedAt - startedAt` 报总耗时，写「用了 3:21」**；还在跑才写「已跑」）。
- **过程**：runner 自己写的 `%TEMP%\acp-delegate\<runId>.activity` 尾巴（8000 字）。前端 1.5 秒轮询一次，内容没变就不动 DOM；贴着底看的时候自动跟到底，往上翻就不打扰。
- **最终输出**：跑完之后同目录的 `.out`（那正是子代理最后那段答复）。

桥加了两个只读口：`bg.list {sessionId}` → 这个会话的 run 列表，`bg.log {sessionId, runId, limit}` → `{log, out}`。

**读盘处刻意收窄**：`tail()` 只允许读 `%TEMP%\acp-delegate\` 底下的路径（`resolve` 后前缀校验，挡住 `..`）。路径本身是从 pi 的工具结果文本里拾来的 —— 那是一段可能被写邪的东西，不能让它一次注入就变成任意文件读取。公网（`ws.publicReq`）一律拒绝：那只是看历史的手，不该看到本机的 prompt 与命令输出。文件还没写出来 / 已删 / 超上限，都只是少一段，不当错误报。

**为什么轮询而不是推**：桥里没有「文件变了」的通知（D133 那套也是轮询 mtime），而这一屏只在打开时有人看 —— 关掉就 `clearInterval`，比常驻一个 fs.watch 便宜，也不会在没人看时读盘。

**读尾不读全**：`tail()` 只读最后一段（`readSync` 从 `size - limit` 开始），不是 `readFileSync` 整份再截 —— 一个跑了几小时的 runner 的 `.activity` 可以很大，而桥是单线程的，1.5 秒轮一次不能拿来整文件读。

`acp_delegate` 的结果文本里其实带着 `Live activity is streaming to \`…\``，**优先用它**（哪天目录换了也不用改代码），拿不到才退回按 runId 拼的默认路径。

## D171 扩展 / MCP 商店的四个 bug：版本检查的竞态、索引的规模、同步 `gh` 与预发布比较（无票，用户要求排查）

**问题（用户问「扩展和 mcp 商店是否存在 bug」，实测四个都真）：**

1. **MCP 的更新检查会被静默丢掉，角标却照样数得出。** 一个把版本固定住的 npx / uvx MCP 服务器（`npx -y @modelcontextprotocol/server-everything@0.0.1`）永远不显示「可更新到 2.2.1」，而输入框下方「扩展」按钮上的角标写着 1 —— 点开里面什么都没有。
2. **MCP 商店的排行索引第一次要 5–6 分钟，不是两句提示里的「约 2 分钟」**；而且 200 页的上限会把 Registry 的长尾（超过 2 万条）静默切掉。中途一次 TLS 抖动废掉整次抓取（实测第 281 页 `ECONNRESET`）。
3. **每次 MCP 商店搜索都同步 spawn 一次 `gh auth token`**（`spawnSync`，冷的 932 ms、热的 75–80 ms），这期间整个 bridge 停摆：所有会话的流式输出、文件写入都等着。
4. **`newer()` 把「有预发布」判成「更新」**：`newer("2.0.0", "2.0.0-beta.1")` 返回 false，字符串比较把 `beta` 排到了版本号后面。只有两边都是预发布时才错，所以平时看不出来。

**根因：**

1. `bridge/src/extmgr.ts` 的三段推送里，`mcpStage` 与 `versionStage` 是两个井行的异步函数，`versionStage` 在算版本前**没有 await `mcpStage`**：它 `inv.mcp.map(...)` 读到的是「此刻」的数组。`pi list`（不含扩展的快清单）比 `pi mcp list` 快时就是空数组 —— 新机器（0 个 pi 包）`inspectPackages` 立即返回，**必现且每次重检都必现**。而 `updateCount()`（角标）直接读 `mcp.json`、不走 `pi mcp list`，于是两边说法不同。测试掩盖了它：`bridge/tests/ext-manager.mjs` 写成 `if (mcp?.version.latest) check(...) else log("npm not reachable: update check skipped")`，竞态产生的空 `latest` 被当成网络问题跳过。
2. `bridge/src/market.ts` 的 `buildIndex()` 是 `for (pages < 200)` 逐页 `getJson`，每页 1.5–1.6 s（实测 20 页 34.6 s、100 页 157.6 s、120 页 187.3 s），没有任何重试。
3. `ghToken()` 用 `spawnSync` 且不缓存；`hasToken` 只驱动一句提示文案。
4. `newer()` 把 `pre` 段的比较写成了整串比较，没有区分「release 比自己的预发布新」。

**决定：**

- **`versionStage` 开头 `await mcpStage`**（它自己 catch 成 `mcpError`，不会抛）。**推送顺序不变，但版本段现在必然排在 MCP 段之后**（它要读 MCP 行的 pin 版本）。为了不让包版本被 `pi mcp list`（要连每台服务器，`picli.ts` 给 180 s）拖住，`inspectPackages(rows, true)` 在 `await` **之前**就启动，两者并行 —— 代价是包版本的落地时间从「与 mcp 同时」变成「不早于 mcp」。
- **索引：** 上限 200 → **600 页**（实测 Registry 条目远多于 2 万，600 页够到 6 万条）；每页 `getJsonRetry(url, 3)`（没状态码的网络失败、429、5xx 各重试，500 ms / 1000 ms 退避；其它 4xx 不重试 —— 状态码挂在 error 上，不靠解析中文错误串），**一次抖动不再废掉整次抓取**；失败记 `lastFailure`，**60 s 内不再重试**（否则每个搜索都要重新撞一遍墙）；`truncated` 落盘并透到页面。
- **索引去重改成「新的赢」**：以前 `items.set(name, …)` 是后写覆盖，而 `normalize()` 对缺 `_meta` 的条目不做 active / isLatest 过滤，一个缺 `_meta` 的旧版本能顶掉新版。现在同名保留 `newer()` 最大的那个。
- **索引期间可读：** `mcpIndex()` 有盘上的旧索引就先回旧的（`building: true`），后台走完再回新的。旧代码其实**已经**先回旧索引 —— 真正的毛病是 `searchMcp` 把 `idx.building` 丢了（页面看不出还在建）而且建完没人通知，用户得重新输入才换成排行。现在建好就 `setIndexListener` 让桥广播 `{type:"mcp.index"}`，页面收到就重发一次 `mcp.store`，**不用重新输入**（顺手清了 `mcpStore.error`，否则首次搜索失败后 `items === null && !error` 不再成立，索引永远不落地）。
- **`ghToken()` 改异步 `execFile` + 10 分钟缓存**（手写一个 `ghTokenCache`，没用 `cached()`：`cached()` 失败即驱逐，这里把一次超时的 `null` 也留 10 分钟，免得每停手一次搜索都重新 spawn 一个注定失败的 `gh`），`runners()` 也从 `spawnSync` 改 `execFile`（`cached` 键拆成 `runner:npx|uvx|docker`）。
- **`newer()` 按 semver 比**：先比核心段（数值），核心相同后「没有预发布」的一方更新，都有预发布才逐 identifier 比（数字先于字母，短的更旧），`+build` 忽略。
- **顺手把 pi 的自述透出来**（同一个类的问题，用户看不到就以为是桥丢了行）：`pi mcp list --json` 顶层有 `errors[]`（解析不了的条目，pi 从 `servers` 里剔掉）和 `note`（例如「这个项目未受信任，`.pi/mcp.json` 被忽略」）。`Inventory` 加 `mcpErrors` / `mcpNote` 原样带给页面，MCP 区块显示成提示行；`note` 命中 `/not trusted/i` 时换成本地化的解释 —— 否则「装到当前项目」的 MCP 装成功了却不在列表里，界面一声不响。

**代价 / 可改：**

- **600 页 ≈ 15 分钟**（按每页 1.5 s）。第一次用 MCP 商店的人等的是「排行」，这期间看到的是 Registry 直接搜索（无 star）。想更快只能向 registry 要更少页、或换成 star 预排序的上游数据 —— 现在没有这样的上游。
- **`truncated` 只说明「没抓全」，不说是哪些**：长尾服务在排行里搜不到，但搜索框走的是同一份索引，所以**确实搜不到**（只有索引还没建好时才走 live registry）。这是规模的代价，不是 bug；真要全覆盖得把索引改成按需增量抓。
- **`ghToken` 缓存 10 分钟**：中途 `gh auth login` / 换 token，最多 10 分钟才生效。`runners()` 同理（装了 uv 之后 10 分钟内仍显示「需要先安装 uv」）—— 和原来一样，只是键拆开了。
- **`note` 的本地化靠正则匹配英文句子**：pi 改措辞就退回显示原文（仍是英文，但不丢信息）。
- **`normalize()` 对缺 `_meta` 的条目仍不做 active / isLatest 过滤**（复审发现的另一半，这次没改：当前 registry 100/100 都带 `_meta`，属防御缺口，不是现在的 bug）。
- **`gh` 的失败也会被缓存 10 分钟**：一次 10 s 超时之后的 10 分钟里 `hasToken` 都是 false（排行退回「只查到一部分 star」的提示），不会每次都重新撞。
- **`mcp.index` 是广播**：多开窗口时每个都重发一次 `mcp.store`，多花一次搜索；索引本来就一天一建，不值得为它做去重。

**验证：**

- `node bridge/tests/ext-manager.mjs` —— **39 项全过**（基线 38 项，**净增 1 条**：原来那条会条件跳过的 MCP 检查拆成两条无条件断言；`version compare` 是原地补用例，不是新增）：
  - `version compare`（改写）：`2.0.0 > 2.0.0-beta.1`、`1.0.0 > 1.0.0-rc.1`、`1.0.0-alpha.1 > 1.0.0-alpha`、`1.0.0-alpha < 1.0.0-beta`、`2.2.1+build.7 == 2.2.1`；
  - `MCP version check reached npm for the pinned server`（新增，`0.0.1 → 2.2.1`）+ `newer release found on npm → update offered`（改写自原来那条 `if (latest) … else log("npm not reachable")`）—— 拿不到 `latest` 就失败，竞态再回来会当场红；
  - 同一次运行里 `update count 1`，与列表里的那条更新一致。
- **竞态对照**（`PI_CODING_AGENT_DIR` 指到空 fixture + 一个 pin 住的 npx 服务器）：修复前 `FINAL {"version":"0.0.1","latest":null,"update":false}` 而 `updateCount() = 1`；修复后追加一段 `+1309ms packages=0 mcp=1 ready=true versions=true updates=1 … 0.0.1→2.2.1`，三段顺序变成「包 → MCP 行 → 版本」，角标与列表一致。
- **索引路径**（盘上一份 30 小时前的索引 + 把代理指到死端口）：`searchMcp("")` 348 ms 返回按 star 降序的两条、`building: true`；第二次 1 ms（共用同一个 building promise，没有重新起走一遍）；后台那次抓取失败只记 `lastFailure`，没有把异常抛给搜索。
- `npm --prefix bridge run typecheck`、`npm --prefix web run typecheck` 通过（i18n **1627 键 × 3 语言**，新增 3 条、替换 1 条）。
- **复审整改**（两轴评审，同一天）：`bridge/src/skillstore.ts` 的 `ghToken()` 调用点漏了 `await`（`headers.authorization` 会发成 `Bearer [object Promise]`，GitHub 树兜底通道必然 401，而 tsc 不报）；`getJsonRetry` 的 4xx 判定从中文错误串正则改成挂在 error 上的 `status`（429 现在会重试）；`mcp.index` 清 `error`。上面「时序 / 索引期间可读 / ghToken 复用 / 新增几条」四处措辞就是这次评审改出来的 —— 原文把自己没说准的旧行为写成了理由。

## D172 后台子代理：只认「派活的工具 + 真的 runId + 结构化字段」，文本特征一律不建卡（D170 的补丁，无票，用户报的）

**问题：** 用户截了一张「后台子代理」的卡片：头一行写着 `问题：`、`运行中 · 已跑 4:34`，任务是「（没说任务）」，过程是「这个 runner 不写过程记录。」。整份源码、`web/dist`、线上 bundle 里都搜不到 `问题：`。

**根因：一条幽灵任务。** 复现（按 `bgruns.ts` 的原逻辑跑当时的会话记录）只有一处命中：`2026-11-07T18:02:20`，会话 `a076a5ec` 里跑了一次
`cd /f/pi-web-client-wt/store-bugs && sed -n '2631,2650p' docs/DECISIONS.md` —— 打印出来的正是 **D170 自己那段说明**。那 20 行里同时有：

- `**问题：**` → 旧的 `AGENT` 正则「任意加粗就当人名」抓到 `问题：`；
- `(runId \`…\`)` 这个书写示例 → `firstRunId()` 认下 id = `…`；
- 正文里的 `` `Running in the background` `` → `looksStart` 的文本兜底成立。

于是 `noteToolEnd("bash", {exitCode:0}, <那段文档>)` 记下了一条 `source: subagents` 的任务：没有 `logPath`（只有 acp 才拼默认路径）→ `hasLog: false`；`task` 要匹配英文 `Task:` 行 → 空；`state` 又是 `running`，只能等 `SILENT_DEAD_MS`（6 小时）。18:02:20 + 4:34 = 18:06:54，正是截图那一刻。

第二重（不是这次的原因，但同一屏也错）：真 `pi-subagents` 的 async 结果只有 `{mode, runId, asyncDir}` + `Async: <agent> [id]` 文本，`details` 里没有 agent/task；而 `bgruns.ts` 的注释「asyncDir 布局没有公开约定」已经过期 —— pi-subagents 包自己的 `docs/observability.md`（不在本仓库）公开了 `status.json` / `events.jsonl` / `output-<n>.log` 与字段表。

**决定：**

- **建卡三闸同时要求：** ①`tool ∈ {acp_delegate, subagent}`；②结构性开始信号（`details.kind === "delegate"` 或 `details.asyncDir`），**删掉 `/Running in the background/i` 文本兜底**；③`id` 像真 runId（`del_*` / `call_*` / UUID），`…` 这类示例值不认。
- **`agent` / `task` 从 `args` 取**：`tool_execution_start` 早把 `ev.args` 存进 `ToolItem`，end 时按 `toolCallId` 取回（`SessionState.argsOf()`）传给 `noteToolEnd(tool, details, text, args)`。`AGENT` 正则收窄成 runner 自己的两种写法（`Delegated to **X**` / `Async: X [`），`Task:` 行只给 acp 兜底。
- **接上 pi-subagents 的痕迹**：`logPath = <asyncDir>/status.json 的 outputFile`（`output-0.log`，实时过程记录），`outPath = <asyncDir>/subagent-log-<id>.md`。`tail()` 的白名单从 `%TEMP%\acp-delegate\` 扩到 `%TEMP%\pi-subagents-*\`，仍然 `resolve` 后前缀校验、只读尾巴。
- **结束信号多一条权威来源**：`prune()`（30 s 一跳）对 subagents 的 run 读 `status.json.state`：真值是 **`complete`**（实测 20 份产物全是它，文档里写的是 `completed`，两个都认）→ done，`failed/stopped/cancelled/canceled/timeout/error` → failed；同一跳里若 `logPath` 还空着就把 `outputFile` 补回来（派活那一刻 `status.json` 常还没落盘，实测晚 ~1.4 s，不补的话 `hasLog` 永久 false）。`RUN_ID` 那套只留给 acp 的注入通知，6 小时兜底保留。
- **文案不再甩锅 runner**：「这个 runner 不写过程记录。」→「桥还没接上这个 runner 的过程记录。」；「（没说任务）」→「（任务原文没传到桥）」（中/英/日三份）。

**代价 / 可改：** 文本兜底删掉后，只有文本、没有 `details` 的「开始」不再建卡；`details` 有 `runId` 但既无 `kind:"delegate"` 也无 `asyncDir`（更老的 acp 写法）同理 —— 少一条可见，好过错一条；`status.json` 每 30 秒读一次（文件几 KB，只在有 subagents run 时）；`output-0.log` 每次 attempt 会被清空，所以过程记录只有当前 attempt 的尾巴。

**验证：** `npm run test:bgruns`（新增 4 组：D170 文档文本不建卡、无 details 不建卡、`…`/`sub_1` 不建卡、subagents 的 args→agent/task 与 `status.json`→hasLog/done）；`npm run typecheck`（含 i18n-check 1624 键 × 3 语言）；`npm run test:continue` 13 项。
## D173 「读-改-写」的状态文件读不到时：不落盘、把改动排队、恢复后自己接上，并且让用户看见（`#184` 的审查补充）

**问题：** `manage.json`（置顶 / 手排 / 归档）、`workspaces.json`、`bug-notes.json`、`failures/*.json` 都是「启动读一次 → 改内存 → 写回」。原来的 `readJson` 把「文件不存在」和「读失败 / 写到一半」揉成同一个 fallback，于是一次瞬时读失败（EBUSY、EACCES）会让内存里那份从**空状态**长出来，下一次拖动 / 改名就把空状态写回盘上 —— 不可逆。第一版补丁只在构造时判一次「读不到就不许写」，等于**整个进程生命周期**再也不保存：用户拖完置顶、重启一看全没了，界面却一直显示成功。

**决定：** 把「读-改-写」收成一处 —— 新文件 `bridge/src/statefile.ts` 的 `class StateFile<T>`（`value()` / `update(fn)` / `lastError()`），`Manage`、`Workspaces` 都换成它。

- **每次改动都重读盘**（不是开机读一次）：读到了就以盘为准，把 `update` 的闭包按顺序重放到新内容上再落盘；读不到就不写，闭包进队列，等文件恢复可读的**下一次改动**自己接上。闭包只碰传进来的 `data`，不碰 `this`，所以重放是幂等的。
- **失败只报一次**（同一句错不重复刷；刷新是 400ms 一次），并通过 `onUnreadable` 回调接到桥的广播：`{type:"notice", level:"error", code:"state_file_unreadable", params:{p1:文件名}}`，走 `errText` 翻译，三种语言都有。**静默的「假成功」比丢一次改动更糟** —— 这是这一轮审查里唯一被标成「实现不对」的一条。
- **`bug-notes.json` 直接抛**：`index.ts` 的 `notes.*` 处理器已经会把 message 回给界面（`notes.saved {error}`），`save()` 在读失败时 `throw` 而不是静默 `return`；`addShot` 失败时把刚写进 `assets/` 的图删掉（不留孤儿），`removeShot` 改成**先写索引再删图**（反过来保存失败会留下坏缩略图）。注释里「改动只留在内存里」也删了 —— 那不是真的，`listNotes()` 每次都读盘。
- **`failures/*.json` 保持尽力而为**：它是遥测，宁可丢这一次新增，也不为它拦用户的动作；照样读失败不落盘、恢复后照常写。
- `readJsonChecked` 留在 `paths.ts`（`readJson` 不动），`fileFor` 从 `failures.ts` 导出，测试直接 import —— 复刻哈希算法等于给测试埋一条「生产改名就静默失效」的暗雷。

**否决的方案：** ①「构造时判一次、失败就永久拒写」—— 见上，一次瞬时错误变成永久不保存；②「读失败就抛，打断桥启动」—— 状态文件坏掉不该让整个 bridge 起不来；③「四处各写一遍守卫」—— 同一种模式四份副本，改一处漏三处（审查里被标成 Duplicated Code + Shotgun Surgery）。

**代价 / 可改：** 每次拖动都多一次 `readFileSync`（文件都是几 KB，单线程桥里可忽略）；队列只在进程内，崩溃就丢（这些改动本来也只是 UI 排列，不是数据）；`state_file_unreadable` 的提示只在桥的聊天区出现一次，不会周期性提醒 —— 如果用户长时间没看，可能错过。

**验证：** `npm run test:stateguard`（新建 `bridge/tests/state-read-guard.mjs`：`readJsonChecked` 三种语义、四个存储在坏文件下「一个字都不变」、首次运行照常写、**文件修好后排队的改动叠在盘上内容之上且保留其它字段**、notes 读失败必须抛）；`npm run test:tail`（`bridge/tests/tail-read-error.mjs`，用 PowerShell `FileShare.None` 独占句柄制造真 EBUSY：失败时不清屏、只报一次、`tailSig` 不推进，解锁后同一签名能重试成功）；`npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（含 i18n 1624 键 × 3 语言）、`bridge/tests/done-persist.mjs`、`lessons-unit.mjs`、`web/tests/failures-unit.mjs`。

## D174 工作区标签行 v3：`order` 是唯一顺序，固定 / 补位退役（#172 / #178）

**问题：** #118 / #122 的标签行有两套顺序来源：用户固定的 `pinned` 列表管「谁在前面」，剩下的「补位组」按最近活动 / 左栏顺序填。固定还带名额语义（固定组占满 N 颗时当前组多画一颗），于是同一组会因活动时间换位、固定组与补位组的边界随名额变化，用户没法用一句话说出「横条为什么是这个顺序」。#172 把模型改成一份全量 `order`，本票收尾并清掉旧模型的代码、文案与探针旧账。

**决定：**

- **一份顺序：** `WorkspaceState.order` 存全量组 id（含被折叠的组），左栏树与顶栏标签行共用它；新组（`ensure` / `create`）追加到末尾，删组（`drop` / 临时组回收）从 `order` 剔除。顺序只由用户拖动、组头「移到最前」和 `order` 自愈补齐改变，不再看最近活动或待处理数。
- **名额只决定画几颗：** `max` 由桥端持久化，默认 6；写入只接受 1–12 的整数，非法值回 notice 且不改任何字段（旧文件里读到非法值时回落默认 6），页面发 `ws.tabs { max }`，桥端不截断 `order`；改 max 不改顺序、不丢组。
- **当前组永远在圈内：** 当前组不在 `order` 前 `max` 颗时占最后一格，原来第 `max` 颗让位进 `＋N`，横条总数不涨（`tabModel()`）；`＋N` 只列被折叠的组，点一行切组。
- **可见即可拖：** `tabModel().visible` 里的每一颗都能用鼠标拖着重排；松手只写回整份 `order`（`ws.tabs { order }`），折叠组没有 DOM、不参与拖动。位移不到 4px 仍算点击，拖回原位一个字都不发。**替位组的拖动按显示位置算目标**（`tabReorder` 只重排可见段，折叠段原样跟在后面）——这是 #172 Implementation Decisions 的语义，#172 Further Notes 里「按真实位置」的旧说法已由本次评审修订。
- **过滤态不绑拖动：** 左栏搜索词生效时标签行只画命中组，此时拖出来的 `order` 会缺项、被桥按创建序补到末尾；因此搜索时标签不绑 `pointerdown`，与左栏 `item.draggable = !this.filter` 同一套约定。
- **窄屏仍是 D149：** 800px 下保留 A 壳的标签行与 ＋/＋N（槽内横滚，不出现页面横向溢出）；#172 R39 的「800px 不出现」已按 D149 修订，不回退 #119 的窄屏入口。
- **`pinned` 运行期退役：** 快照与落盘不再有 `pinned`；`bridge/src/workspaces.ts` 的 `load()` 只从旧文件读一次，作为没有 `order` 时的迁移种子（旧 `pinned` 顺序打头，其余按显示名 `localeCompare`，再按 id 稳定），下一次写盘就只剩 `order`。`web/src/types.ts` 的会话级 `pinned?: boolean`（侧栏 ★）是另一件事，保留。
- **新旧协议兼容：** 新页面 + 旧桥（快照没有 `order`）退回按显示名字母序，且不绑拖动；组头「移到最前」置灰并说明「旧版桥不支持调整顺序」（旧桥不认识 `ws.tabs`）。旧页面 + 新桥可能发 `ws.tabs { pinned }`：桥端忽略该字段，不改顺序、不报错。
- **收尾清理：** 删除 `.ws-fixed-*` 死样式、设置里的固定组块旧样式与用户文案；`GLOSSARY.md` 的「工作区 / 标签行」按本模型改写，删「固定（组）」「补位（组）」；旧探针里「固定到第一行 / 默认 3」的断言按新模型校正。

**为什么：** 顺序必须是可解释、可持久化的单一事实源 —— 两套来源（固定 + 活动）会让同一个组在刷新、切会话后换位，而「固定占满名额多画一颗」让横条颗数随状态变化。把 `max` 降为纯显示预算、让当前组替最后一格，既保证「当前组永远看得见」，又保证「横条不超 N」。迁移只在读时做、写时落新形状，避免启动时改写用户文件，也让回滚旧桥时旧文件仍可读（旧桥不认识 `order` 就按它自己的规则走）。

**代价 / 可改：**

- 旧桥下没有持久顺序：字母序只是页面兜底，拖不动、也不能「移到最前」；升级桥后不会自动把旧页面的临时顺序带过来（本来就没落库）。
- `order` 里存的是组 id（路径小写 / `manual:<随机>`），改显示名不会换位；手动组永远追加在末尾，不能按名字插队。
- 名额存在 `workspaces.json` 的 `max`，换浏览器仍是同一个 N；但它不跟随窗口宽度自动调整 —— 窄屏是否隐藏标签行由壳决定，不改 `max`。
- `readOrder()` 对未知 / 重复 id 的清洗、缺失组按创建序补尾都在桥端做；页面拿到的永远是已补齐的快照，别再在页面里另推一套顺序。
- 旧决策里出现「固定 / 补位」的条目（D149 等）保留原文，作为历史记录，不回改写。

**验证：** `node --experimental-transform-types bridge/tests/workspace-unit.mjs`（迁移、order 落盘、旧页面 `pinned` 忽略、max 校验）；`node --experimental-transform-types web/tests/wstabs-unit.mjs`（`tabModel` / `tabReorder` / `moveToFront` / `newTabFold`）；`probes/workspace-tabs.mjs`（A 行几何、＋N、拖动、刷新持久化、＋ 新建、六步端到端）、`workspace-settings.mjs`（名额步进器）、`workspace-tree.mjs`、`workspace-layout.mjs`、`workspace-manage.mjs`、`workspace-migrate.mjs`（旧桥无 order 交叉用例）、`workspace-shells.mjs`、`workspace-drag.mjs`、`a11y-workspace.mjs`；`npm --prefix web run typecheck`（含 i18n-check）与 `npm run build:web`。

## D175 ⚡ 那颗按钮多一条路：「发到会话复盘」，让模型把这一类折成一句**规矩**，下一轮 spawn 带回去（无票，用户要求，D164 的第二条出口）

**问题：** D164 的 ⚡ 只会**入账** —— 记下这一类栽了几次、为什么、上次怎么修的，写完就躺在面板里。人得自己读懂再改流程；而真正会重复犯错的是模型，它从来没被问过「这一类你打算怎么不再犯」。D169 已经把账本回流成了教训（统计出来的、门句式的一行），但那是桥按模板拼的，不是对**这一轮具体几次失败**的解释。

**决定：**

- **一条入口、两个举动**：⚡ 那颗按钮单击弹出小卡，两行 =「🗂 记进账本 / 同类只加次数，不花 token」与「⚡ 发到会话复盘 / 开一轮：N 类账本视角 + 一句规矩」。不做两颗并排的胶囊 —— 两个举动代价不一样（一个免费、一个花钱），并排会把它们摆成同级；小卡里每次都能先看到「这一下会发出什么」。
- **点下去就发，不预填草稿、不弹确认**：这一下花的是用户刚刚已经付过 token 的那一轮的账，一次复盘 ≈ 一次普通提问。要反悔就关掉 pi 继续说 —— 那条复盘消息在会话里看得见、可以 stop。
- **提示词是「账本视角」，不是把报错原文再贴一遍**：每个类一行，写本轮次数、账本累计次数、上次诊断、上次修法；原文明明就在上面几条工具卡里，重贴只会让模型再读一遍。正文以 ASCII 标记 `[pi-web:review]` 开头，界面据此画成「⚡ 自动复盘」竖线块（与自动提醒同一套做法，不给复制/分叉）。
- **要两样东西**：每类一句根因（不许复述原文）+ 每类一句**规矩**，规矩必须是「先做 X 再 Y」这种能执行的句子，明确禁止「要小心」「注意检查」；只有确实要动手、且先问过人，才可以动手改代码。
- **每轮最多 5 类**（`classes.slice(0, 20)` 进桥、桥侧再截、`MAX_REVIEW=5` 写进提示词）：一次复盘读 20 类会把上下文吃满，也读不完；剩下的一行括注「另有 N 类没带进来」。
- **规矩旁挂在账本条目上，独立一本账**（`<state>/rules/<ws>.json`，与账本同一套命名）：键 = 账本的归并键（`工具|代码|形状`），同键**覆盖**（不对历史负责），最多 100 条。它不改账本的次数、不动「已修复」状态：那本是事实，这本是打算。
- **回写走一行文本协议**：`[pi-web:rule] <键> :: <一句规矩，≤70 字>`。前端只在**确实看见这一行**时写回（`web/src/rules.ts` 的 `parseRules`，跳过提示词里的示例行与坏行），模型没写就当这轮没结论 —— 不猜、不重试、不造空规矩。键抄的是提示词里给的形状，不自己编。
- **规矩也回流**：`lessonText` 现在 = 教训块 + 规矩块（最多 3 条、单条 70 字），跟着 D169 那条 `--append-system-prompt` 一起进 spawn；账本里已标已修复/忽略的类不再带它的规矩。`PI_WEB_LESSONS=0` 一并关掉。
- **复盘期间不插嘴**：`Session.reviewing` 在 `failures.review` 时置真，D169 的当场叫住（`failures.remind`）在这段时间静音 —— 模型正在回答为什么犯错，再往里塞一句「你又错了」只会打断它；人一开口（`prompt`）就复位。
- **每类只复盘一次**：桥回 `failures.reviewed{ok,n}`，前端把 `reviewed[sid].n` 记在规矩账里，⚡ 换成「已复盘」的外观；再点仍可（文案改成「这 N 次已经复盘过；再发会再烧一轮 token」）。
- **没在跑的会话不冷启**（同 D169）：为一段复盘冷启一个 pi 不值当；桥回 `ok:false, reason:"offline"`，前端转成「先随便说一句话把它叫起来」。

**为什么：** 三条 —— 为什么由模型写规矩而不是桥按模板生成、为什么规矩存在账本旁边而不是另开一页、为什么回写要用机器能认的一行字。

- D169 的教训是**统计**（同类 ≥3 次、原因单一），它能说的是「这一类你栽过 9 次」；这一轮的具体几次为什么会栽、下次手上先做什么，只有刚读完工具输出、又刚刚被问过的模型答得出。两者互补：教训给下一轮的常识，规矩给下一轮的具体动作。
- 面板里已经有「按次数排序的类」，再开一页「规矩」等于让人在两处对照同一个键；贴着条目放，人和模型看到的是同一行字。删规矩也不影响账本 —— 次数是事实，不该被删掉。
- 没有结构化回写通道（pi 的 RPC 只有 prompt），一行带标记的文本是唯一能在刷新后从会话文件里重新认出它的办法；解析严格、宁可丢也不猜。

**代价 / 可改：**

- 规矩的质量取决于模型：它可能写一句听起来对、实际没用的「先确认路径再执行」。所以面板里能改能删，且**它是覆盖式的**，没有历史版本。
- 模型不按格式回写时，这一轮的结论就丢了（界面无提示、不重试）；要更强只能上结构化输出或让桥解析自然语言 —— 后者不可靠。
- 复盘消息是一条普通 user 消息，会占会话上下文；一轮最多 5 类、每类 4 行，约 800–1500 字。
- 「已复盘」按会话记（`reviewed[sid]`），同一类在别的会话里还会再亮一次 ⚡。
- 规矩块与教训块共用 1200 字上限的旧约束没变：规矩多到 3 条 × 70 字时，教训那 6 行会被挤。

**验证：** `npm run test:rules`（web 16 项：归并计数 / 标记识别 / 示例行跳过 / 同键覆盖 / 截断；bridge 14 项：落盘 / 覆盖 / 兜底 / 删除 / 坏文件退空账 / `lessonText` 追加 / 已修复不带 / 上限 3 条 / 提示词首行与回写示例）；`npm run test:lessons`、`npm run test:failures` 不回归；`node bridge/tests/failures-ui.mjs` 41 项（含：小卡写明代价 → 点复盘 → 会话里出现竖线块、正文是账本视角 → 脚本化 pi 收到三类 → 规矩落盘、文本与键都对 → 面板左栏「⚡ 规矩」、右栏「这条规矩」能改能删）

## D176 归档当前会话 = 归档它并离开它：落到 ★ 行的右邻，否则左邻，否则空态（`#188` / `#189` / `#190` / `#191`；票面写的「D174」已被占用（先被「工作区标签行 v3」拿走，合 main 时又被 ⚡ 规矩那条拿走了 D175），按最大号 +1 顺延为 D176）

**问题：** 在 ★ 行里归档当前打开的那颗胶囊，归档本身落库了（它从 ★ 行消失、进左栏末尾的「已归档」段），中栏却仍停在它上面。★ 行第 1 格的 nowchip 画的就是当前会话，于是那颗刚归档的会话占住整条行最显眼的位置；用户读到的是「归档没生效」或者「排序乱了」，真相是「当前会话没换」。

**决定：**

- **规则只有一处：** `web/src/pillbar.ts` 的 `neighborAfterArchive(row, archivedId, alsoArchived = [])` —— 输入 ★ 行从左到右的 id 序列与被归档的那颗，输出该切到的 id，或 `null`。**右邻优先 → 没有右邻取左邻 → 左右都没有返回 `null`（中栏空态）**。不读 DOM、不读 store，改方向也只改这里。
- **触发时机：** 不在点击时切。归档帧发出后等桥的 `manage` 广播回声，`App.switchAfterArchive()` 判断「当前会话属于本次回声**新变归档**的那批，且此刻仍显示着它」，满足才动；只切一次，点击与回声之间不预切、不闪回。
- **判定用差集：** 回声前的 `archived` 集合（`wasArchived`）与回声后比较，只有这一次新落进去的 id 才算「刚归档」。**不看「当前会话现在是否已归档」** —— 从「已归档」段主动点开一个归档会话是允许的状态，按后一种判法会被自己这一眼踢走。
- **邻居按归档之后的 ★ 行算：** 批量归档的一次回声会同时带走好几颗 ★，同批一起消失的那些不能当邻居（否则中栏会切到另一颗刚归档的会话上）。实现上把同一帧回声的差集当 `alsoArchived` 传进纯函数。
- **行的口径只有一份：** `App.starredRow()` / `starredSessions()` —— 当前工作区的 ★，按 `manage.pin` 从左到右；当前会话没打 ★ 时它自己占第 1 格。归档前的行序在上一帧 `renderSessionRow()` 里留底到 `App.rowIds`（窄屏与壳 B/C/D 不画这一行，顺序照样记），所以落点与壳无关。
- **切换走现成入口：** 有邻居 → `openSession(next)`（存草稿、换 currentId / session、重新订阅、全量重画、hash 变 `#/s/<id>`）；没有邻居 → `closeCurrentSession()` 进现成的「还没有打开会话 / 左边选一个，或者开一个新的」，hash 回 `#/`。不新增文案、不加第二条 toast、不切页面标签。
- **入口一个不少：** 胶囊气泡（`pinmenu.ts` 的「归档」→ `App.archiveFromPin()` 先演后发）、卡片底部按钮、管理面板的批量归档（`mgrPicked`）、管理面板行内动作都收口到 `App.archiveIds()`；「这一批里有没有当前会话」在它之上判一次，不在四处各写一遍。卡片列表本身没有多选，批量只从管理面板进。

**为什么：**

- **右邻优先：** ★ 行是从左到右读的，当前那一格之后才是「接着要处理的」。往右走等于「删掉这一格、光标顺延」，与编辑器里删一行的直觉一致；只有行尾没有下一格时才回退到左邻，避免「归档最后一颗还得自己再点一次」。
- **严格只看 ★ 行，不用左栏树的相邻：** 用户是在这一行里动手的，眼里也只有这一行。邻居若去左栏树里找，落点会是「另一棵树里碰巧挨着的会话」—— 可能属于别的工作区，也可能在几十行之外，用户没法预测。★ 行是用户亲手排的、有头有尾的一条序列，「右邻 / 左邻」在它上面才有唯一含义。
- **空态也是一种答案：** 左右都没有时，别把人塞进一个没在看的会话；「还没有打开会话」比「跳去一颗你没期待过的会话」更诚实。

**代价 / 可改：**

- **一颗 ★ 都没有时，归档当前会话会直接进空态**，哪怕左栏还有几十个会话。这是「严格只看 ★ 行」的直接后果，本轮认了；日后若觉得别扭，只需把 `neighborAfterArchive()` 的兜底从 `null` 改成「左栏树里的下一颗 / 上一颗」，App 侧不用动。
- 邻居按**上一帧画出来的行序**（`rowIds`）算，不重新推导：如果两次回声之间 ★ 顺序被别处改了（另一个标签页拖动置顶），可能按旧顺序落点。这一档竞态没做补偿。
- 「同批」按整帧回声的差集算：两个浏览器几乎同时归档、字段合并在同一帧回声里时，另一批的 ★ 也会被当成同批跳过。后果只是邻居再往外挪一格，不会切到已归档的会话。
- 从「已归档」段点开归档会话仍然允许（中栏可以停在归档会话上）。规则只管「这一次归档把它收走了」的那一刻，不负责把用户从已归档的会话里赶走。
- 进空态后没有「当前会话」，也就没有「当前工作区」：★ 行退回 `App.starredRow()` 里现成的兜底（全部置顶会话，跨工作区）。这与手动清空当前会话时的表现一致，本轮不改。

**验证：** `npm run test:pillbar`（`web/tests/pillbar-unit.mjs`：右邻 / 无右邻取左邻 / 只有它 / 不在行里 / 未 ★ 占第 1 格时右邻是右边第一颗 ★ / 批量跳过同批右邻 / 批量落到左邻 / 整行被带走 → `null`）；`probes/archive-switch.mjs`（桩桥 + 真 Chromium：点击瞬间中栏未变、回声后落右邻、第 1 格全程没画过那颗归档会话、最右那颗落左邻、唯一颗 → 空态 + `#/` + 刷新后仍空态、归档非当前会话不动、从「已归档」段点开不被踢走、管理面板批量同落点、批量不含当前会话不动、窄屏与壳 B/C/D 同落点）；`npm --prefix web run typecheck`（含 i18n-check）。

## D177 浮层的落位只留一个函数：`placeMenu` / `stickMenu`（无票，用户报的菜单截断，审查后收拢）

**问题：** `⋯` 菜单贴着窗口底时整块戳出去（1200×420 里溢出 98px，「删除工作区」只剩半行）。根因不是某一行算错，而是这段逻辑在仓库里有四份手写副本，各自只记得其中一半：`pinmenu.ts` 两处只夹左右、封顶还有个 `Math.max(180, …)`（只剩 50px 也硬给 180px）；`app.ts` 的「更多」同款；`openWsPop` 自己数 height 翻转却不看 `max-height`；`wsmenu.ts` 什么都不管。加一条规则（会翻转、会封顶）等于改四处，下次再有人手写第五份，还是这个 bug。

**决定：** `web/src/menuplace.ts` 一个纯函数 + 一个挂载器，别处不许再手写落位。

- `placeMenu(anchor, size, viewport, { gap, cap })` 只做算术：默认往下开，**下方确实放不下且上方更宽敞**才翻上去（免得菜单在窗口中间自己跳）；长度封顶到所剩空间，窗口比菜单还矮时保底 `MENU_MIN_H = 96`（压成 0 高等于没弹）；最后整块夹进窗口 8px 边距。
- `stickMenu(node, anchorRect, opts)` 负责量、写 inline `left/top/max-height`：先把上一次的 inline 封顶清掉再量自然高；封顶引出滚动条改了宽度就按真实宽度重夹一次右缘。
- `cap: false` 给自带上限的浮层（`.ws-pop` 有 70vh 和体内滚动）：只摆位置，翻转按真实高度算 —— 否则会凭空离开锚点一段。
- 菜单/列表自己挂 `scroll`（捕获，不冒泡）：锚点滚出窗口就关，否则重摆；**菜单肚子里**的滚动直接忽略，免得封顶后每滚一格都重排。
- 高度只有一个真相：JS 按实际窗口算 inline `max-height`，CSS 不再写 `max-height`（原来的 `calc(100vh - 16px)` 是第二套数）。

**代价 / 可改：** `.pin-menu` 的 `max-width: calc(100vw - 16px)` 是兜底，窄到装不下 212px 时仍会溢出（靠 `min-width` 优先），实际窗口没那么窄就不管。悬停气泡（`openPinMenu`）故意不挂 scroll：滚动条一动指针就离开胶囊，`pointerleave` 的 close 先到。

**验证：** `npm run test:menuplace`（9 项：贴下方 / 贴底翻转 / 封顶 / 上下都窄时保底 96 / 上方更窄不翻 / 左右夹 / 比窗口宽 / `gap` / `cap:false`）；`probes/workspace-manage.mjs` 第 9 步对 900/480/420/380/300/200 六档按几何算出「该不该翻」再无条件断言，并把删除项滚进视野断言可见；`workspace-layout` / `workspace-settings` / `workspace-shells` / `round4-pin` / `round16-pin` / `pin-auto-open` 不回归。
## D178 启动窗口里也能发消息：桥收下、气泡立刻出现，pi 起来再交出去（`#197`；**推翻 D122 第 3 条**）

**问题：** D122 让 `create` 不再等 pi，代价是「先看到空聊天框、pi 还在起」的两三秒（机器忙时 12–15 秒）。D122 第 3 条选择的缓解方式是**把输入框置灰**、placeholder 换成「pi 正在启动…」、`sendPrompt` 里再兜一次早退 —— 等于在这十几秒里把「我想说的第一句话」这件事整个拦下来。而这段时间恰恰是用户最有话可说的时候：刚建好会话、脑子里正想着要问什么，字打完却发不出去，等 pi 起来还得重新想一遍。

**决定：**

1. **`prompt()` 在 `starting` 为真时不再报错**：立刻把 user item 落地并广播（`pending: "booting"`），消息进该会话的**待发队列**（`bootQueue`）。命名逻辑照旧跑 —— 会话名由这条消息决定，左栏不用等 pi 起来就有名字。
2. **就绪时按到达顺序交出第一条**：`starting` 翻假、且有活着的 rpc 时 `flushBootQueue()` 取队首，构造 message（跑起来时带 `streamingBehavior`，否则 null）、进 `queuedUser`、`rpc.request("prompt", …, 60000)`。同一枚气泡改成 `pending: "sent"`（`item.replace`）。（多条如何排、等不到 `agent_start` 怎么办 → 见 D180）
3. **前端两种状态，一枚徽标**：`pending: "booting"` → 「正在启动 pi…」（小 spinner）；交给 pi 之后（运行态为真且这条是最后一条用户消息）→ 「处理中…」，本轮结束消失。「处理中…」是**推出来的**（`running` + 最后一条 user item），不新增协议字段。启动期输入框不禁用、placeholder 恢复普通文案、不出现中断按钮；状态行仍是 D122 那句「pi 正在启动（加载扩展，通常几秒）…」。
4. **失败不静默**：rpc 在交出前后死掉 → 气泡标 `pending: "failed"`（红字「没发出去，重发一次就行」）并配一句 error notice（`pi 起不来了（<reason>），这条消息没有发出去；重新发一次就行。`）。完整重试归 #200。（完整的「保留 + 重试」→ 见 D179）
5. **既有前置检查照旧在前**：压缩互斥（「Cannot submit a prompt while compaction is in progress.」）等判断仍在入队**之前**走 —— 启动窗口不是绕过它们的理由。

**为什么推翻 D122 第 3 条：**

- **置灰解决的是「发出去石沉大海」，而不是「不许说话」。** 现在桥会把消息收下并排队，那条代价消失了：用户在启动期按 Enter，气泡立刻出现、pi 起来就发出，行为与平时一样，只是多等一会儿。
- **排队归桥，不归页面：** 页面只知道「我发了」，刷新、切标签页、第二个标签页看到的都是同一枚气泡（`#197` 验收里明确要求）。更关键的是**一条会话只有桥那一份记录**：队列若放在前端，另一个标签页根本不知道这条消息存在，会话名也拿不到。
- **几乎全是前端坏处：** 前端早退只是把「pi 还没好」翻译成「你什么都不许做」，而它本来就知道 `starting` 这件事 —— 把徽标说出来比把输入框关掉更有用。

**代价 / 可改：**

- **启动期连发的第 2、3 条仍在队列里等到 `starting` 翻假才排队首**：本票只保证「第一条」在就绪后交出去，多条怎么排（顺序、合并、插话还是排队跑）归 #198。窗口里连发两条的后果是第二条要等第一条跑完一轮才动。
- **待发队列只在桥内存里，不落盘**：桥重启就没了。气泡还在（item 已落地），但没人会再把它交出去 —— 这也是 #200 要补的「重试」入口。
- **样式是「同一枚徽标换文字」**，不是两条消息：`booting` → 无（`sent`）→「处理中…」。用户看不到「交给 pi 那一刻」的独立瞬间，只有徽标的消失 / 出现。
- **`pending` 字段是发给前端的协议的一部分**：老版本前端会忽略它（`pending` 未知字段不参与渲染），行为退化成「气泡出现、没有任何徽标」，消息本身照发不误。

**验证：** `node bridge/tests/boot-queue.mjs`（桩 pi 慢启动 2500 ms）：A 段 —— `starting` 为真、prompt 后 2 ms 内收到带 `pending: "booting"` + `clientId` 的 `item.add`、无 error notice、会话名变成这条消息、桩 pi 日志里窗口期一封 prompt 都没有；就绪后桩 pi 收到 prompt（`behavior=null`）、同一枚 item 变 `pending: "sent"`、没有 `item.remove`。B 段 —— 窗口期把桩 pi 打死：气泡变 `pending: "failed"`、文本还在、error notice 含「没有发出去」、没有 `item.remove`。`node bridge/tests/create-fast.mjs` 不回归（注释里「页面据此禁用输入框」同步改掉）。`PI_WEB_PORT=… node probes/session-starting.mjs`（桩桥 + 真 Chromium）：启动期状态行含「正在启动」+「加载扩展」、无中断按钮、textarea 可用且 placeholder 不含「正在启动」；Enter 后 `.msg.user` 只有一份、徽标「正在启动 pi…」、输入框清空、无错误提示；第二个标签页同一份气泡、同样说法；`starting:false running:true` → 「处理中…」；`running:false` → 徽标消失。`npm --prefix web run typecheck`（含 i18n-check）、`npm --prefix bridge run typecheck`。

## D179 启动失败的那条消息留着、标红、可重试：点「重试」= 接管，先拉起 pi 再按原顺序补发（`#200`；补上 D178 的代价第 2 条）

**问题：** D178 让启动窗口里收下的消息在桥里排队，代价写在明处：队列只在内存里，pi 在窗口里死掉时气泡标红「没发出去，重发一次就行」—— 可「重发一次」让用户自己重新打一遍，而**同一条会话只有桥那一份记录**，用户手里攥着的只是屏幕上那段文字；再发一次还得先手点「接管」把 pi 叫起来。另一个来源更隐蔽：pi 起来了、桥也把 prompt 交出去了，pi 却回 `disposition: "handled"` + `error`（模型那头拒了、上下文超了之类），这条同样没进去，而 D178 只把它标成同一句红字。

**决定：**

1. **两种失败都「标失败 + 保留原件」**：窗口期进程死掉（`boot`）、桥正在退出（`stopped`）、pi 收下却回 `handled + error`（`refused`）。共同动作是把 `BootEntry` 从 `bootQueue` 挪进 `bootFailed`（桥内存），item 标 `pending: "failed"` 并广播 `item.replace` —— 文本、图片、复制全部照旧，气泡不删。
2. **「重试」复用 `claim`，不新增帧**：前端那颗按钮就是现有的接管动作。`SessionManager.claim()` 在 `openLive()` 之后调一次 `session.retryBootMessages()` —— pi 没活着时 `openLive` 会重新 spawn、钉权限、过锁检查，会话起来了再补发；pi 还活着（`refused` 那种）`openLive` 直接早退，于是只补发、不重启。补发成功后 item 回到 `pending: "sent"`，之后「处理中…」由运行态推出来，用户不用再点第二次。
3. **一个串行泵管两种场景**：`flushBootQueue()` 变成「一次只跑一条」的 `pumpBootQueue`。发一条、看运行态：还在跑就接着把下一条按插话送（`streamingBehavior: "steer"`），没在跑就停下来等 `agent_start`（那才是「这一轮开始了」的真实信号），`agent_settled` 兜一次底。重试项 `unshift` 回队首，所以顺序与它们当初的到达顺序一致；`starting` 还是真的时候只排队、不再泵（新 spawn 的 pi 连 `get_state` 都没答）。
4. **文案说人话**：notice 按原因给三句话（「pi 没能起来」/「pi 已经停了」/「pi 没收下」），后面接动作（「点「重试」会先拉起 pi，再按原顺序补发」/「点「重试」会重新发一次」）。exit code、signal、pid 一律不进界面（旧文案 `pi 起不来了（exit code=1 signal=null）` 就是这么漏出去的）。徽标本身只说「没发出去」+ 一颗「重试」。

**代价 / 可改：**

- **`bootFailed` 也在内存里**：桥重启后失败的那几条只剩气泡（还能复制），重试按钮失效 —— 与 D178 对待发队列的取舍一致：不落盘，避免多写一份会被会话文件与 item 双写撞上的东西。
- **重试是「整批」的**：点一下会把所有失败项一起补发，不能只挑其中一条重发；撤回（D178 提到的另一条出口）本票没做。
- **补发成功不等 pi 真的回 ok 才回到 `sent`**：泵在请求发出前就把徽标改成 `sent`（和 D178 的第一条一致）；`refused` 是请求的**成功响应**，所以标红发生在之后一次 `item.replace`。中间的几十毫秒里徽标会闪一下「处理中…」再变红。
- **`claim` 现在有两种含义**（接管 / 重试）：这是有意的 —— 两者要做的动作完全一样（把 pi 拉起来 + 把没交出去的交出去），分开一个帧只会让前端多记一份状态。若日后重试需要「不重启 pi」，再拆。

**验证：** `node bridge/tests/boot-queue.mjs`（桩 pi 慢启动 2500 ms）：B 段 —— 窗口期连发两条后打死桩 pi：两条都变 `pending: "failed"`、文本都在、没有 `item.remove`、notice 含「没有发出去」且**不含** `exit code` / `signal=`；B2 段 —— 发 `claim`（就是那颗「重试」）→ 收到 `starting: true` 的 session 帧 → 新 pid（≠ 被杀的那个）→ 桩 pi 按原顺序收到两条 prompt（第一条 `behavior=null`、第二条 `steer`）→ 两个 item 都以 `pending: "sent"` 回来。C 段 —— pi 就绪但拒收（桩 pi 对 `REFUSE…` 首次回 `handled` + `error`）：标 `failed`、文本还在、notice 可读、桩 pi 日志里有 `prompt-rejected`；C2 段 —— `claim`（pi 已活着，不重启）→ 补发 → `pending: "sent"`。`node bridge/tests/create-fast.mjs`、`PI_WEB_PORT=7918 node probes/session-starting.mjs` 不回归；`npm --prefix bridge run typecheck` + `npm --prefix web run typecheck`（含 i18n-check：删掉旧键 `没发出去，重发一次就行`，新增 `没发出去`、`先拉起 pi，再按原顺序补发没发出去的消息`，`重试` 复用已有）与两边 build。

## D180 启动窗口里连发的几条：能塞就塞进同一轮，塞不进各自成一轮；等「这一轮开始」有 10 秒上限（`#198`；实现并进 D179 的那只泵）

**问题：** D178 只保证「第一条」能发出去，D179 的泵解决「按序交」，但两处语义空着：① 第二条起凭什么算「同一轮」？pi 只在**正在流式输出**时才接受 `streamingBehavior`，交出去的那一刻这一轮可能刚好结束；② 泵发完第一条后要等 `agent_start` 才算「这一轮开始」，可第一条要是被 pi **就地处理**（斜杠命令、`disposition: "handled"`、压根没起 run），`agent_start` 永远不会来 —— 后面的几条会一直挂着，气泡永远「正在启动」。

**决定：**

1. **顺序交出，能塞就塞**：泵按到达顺序一条一条交；交之前 `state.running` 为真就带上 `streamingBehavior: "steer"`，让第 2、3 条落进正在进行的那一轮（用户本来也只会发「一句 + 两句补充」）。
2. **塞不进就自己开一轮**：带标记却没被 pi 排进队列（响应 `disposition !== "queued"`，说明那一轮在交出去的瞬间结束了）不算失败 —— pi 已经单独开了新一轮，`queuedUser` 里立刻把这条摘掉（`unqueueUser`），免得「撤回」去删一条早就不在队列里的气泡。
3. **就地处理掉的那条不算「这一轮没开始」**：`disposition === "handled"` 且没有 error → 下一条**裸发**（无 `streamingBehavior`），让它自己开一轮。
4. **等「这一轮开始」有上限**：`BOOT_RUN_WAIT_MS = 10_000`；`agent_start`、`agent_settled`、进程退出都会 `wakeRunStart()` 放行，等不到就裸发兜底 —— 宁可多开一轮，也不让人盯着「正在启动」干等 10 秒以上。
5. **队列条口径**：启动窗口里收下的消息一条都不进右栏队列条；只有 pi 真的把它们排进队列（`queue_update`）时才列出。

**代价 / 可改：**

- **合并是尽力而为，不是保证**：pi 那一轮恰好在两条之间结束时，第 2 条会成为下一轮的第一条（用户看到两次「处理中」而不是一次）。要强保证得让 pi 支持「先排队再开跑」，超出桥的能力。
- **`BOOT_RUN_WAIT_MS` 是常量**，没进设置；机器慢到 `agent_start` 超过 10 秒才会看出它。
- **与 D179 的失败重试共用同一只泵**：失败项 `unshift` 回队首，所以「重试」补发时仍按原顺序，也仍然享受上面的合并规则。

**验证：** `node bridge/tests/boot-queue-merge.mjs`（桩 pi 慢启动 2500 ms）：A 段 —— 启动窗口里连发三条，窗口期桩 pi 一封 prompt 都没收到、三条气泡都在、右栏队列条空；就绪后第一条 `behavior=null`、第 2/3 条 `steer` 且落在同一轮（桩 pi 的 `run-start` 只有一行）；B 段 —— 队列条只列 pi 真收下的那两条，正在跑的第 1 条不算排队，这一轮结束队列条自己清空；C 段 —— 整条路没有一条被丢；D 段 —— 首条是 `HANDLED` 斜杠命令（就地处理、没起 run）时第二条 61 ms 内裸发（`behavior=null`），没有干等 10 秒上限，也没被 `Agent is already processing` 拒收。`node bridge/tests/boot-queue.mjs`（D179 的 A/B/C/D）、`node bridge/tests/create-fast.mjs`、`PI_WEB_PORT=7916 node probes/session-starting.mjs` 不回归。

## D181 启动期的另外三个入口也走同一条待发队列：接管、只读自动接管、「继续」（`#201`；复用 D178 的落地与 D179 的补发，撤回沿用 #199）

**问题：** D178 只让「启动窗口里发一条」不再干等 pi，但另外三个入口各有各的等待：① 接管一个已经结束的终端会话，用户得先点「接管会话」、等 pi 起来，输入框才真的能发；② 磁盘上的只读会话（`owned: false`）发第一句时，桥先 `await openLive()`（拉起 pi、钉权限、等 `get_state`）才落地气泡 —— 打出去的字要等整个握手才出现在屏幕上，这几秒最容易被当成「没发出去」再打一遍；③ 启动窗口里「继续」是灰的，理由和当年的「输入框置灰」一样（D178 已经推翻过那个理由）。

**决定：**

1. **先落地，再握手**：`prompt` 分两步 —— `sessions.acceptBeforeOpen()` 把气泡广播出去（`pending: "booting"`），然后才 `openLive()`。握手一步不少（tty 锁、20 秒 mtime 检查、`pinPermission`、resume），**也不新增任何 WS 帧**；只读会话的第一句因此和普通发送一样立刻可见。
2. **消息进的是会话自己的待发队列**：`acceptBeforeBoot()` 复用 D178 的 `landUserPrompt()` 与 `bootQueue`，所以撤回（#199 的同帧清空）、失败（D179 的标红 + 重试）、连发（D180 的按序交出）三条路一条都不分叉。
3. **接管没成也走 D179 的失败路**：`failBeforeBoot()` 把原件挪进 `bootFailed`、气泡标红，原因由 WS 那一层原来的 notice 说（不重复说两遍）；点「重试」发的还是现有的 `claim` 帧 —— 先拉起 pi，再按原顺序补发，不需要新协议。
4. **`openLive()` 单飞**：接管与「接管后立刻打字」是两条独立的命令，都会看见 `!live`。`SessionManager.opening` 让后来的那条等那一次在飞的拉起，否则同一份会话文件会有两个 pi 写者。
5. **读回磁盘历史时保住还没交出去的气泡**：`keepUnsentBubbles()` 把 `bootQueue` 与 `bootFailed` 里的 item 接回历史之后 —— 它们不在文件里，不接回来用户刚打的那句会凭空消失，重试时也没东西可标。
6. **「继续」不看 `starting`**：`continueState()` 只在 `running`、后台子代理忙、没有用户消息时变灰；启动窗口里点下去就是把「继续」两个字放进同一条队列。界面上那句「pi 正在启动，起来之后再继续」随按钮一起删掉（en/ja 同步）。

**代价 / 可改：**

- **气泡会先出现、再标红**：自动接管失败（终端里的 pi 还开着、20 秒内还在写）时，用户先看到气泡、随后才看到「没发出去」—— 这是「不等握手」的必然代价；反过来（先等再判）就是原来那几秒的空白。
- **只读会话上「继续」仍然不显示**：按钮的显示条件还是 `owned`（`hidden`），与「发消息自动接管」是两条路；要在只读会话上也点「继续」得先决定它算不算「没有写权就别提供快捷方式」，本票没改。
- **队列仍在内存里**：与 D178/D179 一致，桥重启后待发的那几条只剩气泡。
- **`acceptBeforeOpen()` 对 `live` 的会话返回 `null`**：那时气泡由 `prompt()` 自己落地，避免同一条消息落两枚。

**验证：** `node bridge/tests/boot-queue.mjs`（桩 pi 慢启动 2500 ms）：6 段 —— 只读会话发一句，`item.add` 在「开始拉起 pi」（`starting: true`）**之前**到达（item#104 < starting#105，实测 <1000 ms）、气泡带 `booting`、就绪后 `behavior=null` 交出并 `sent`、`owned` 翻真、只起一支 pi 且走 `--session`；7 段 —— 接管与打字同时来，气泡 11 ms 落地、`claim` 与 `prompt` 只起一支 pi、只交出一次；8 段 —— 有 tty 锁时气泡标 `failed`、notice 说明原因、一支 pi 都没起；9 段 —— 删锁后点「重试」（`claim`）把同一枚气泡放回队列、补发成功变 `sent`、不重复画、仍只起一支 pi。`PI_WEB_PORT=7919 node probes/session-starting.mjs`：8 段 —— 启动期「继续」可见可点，点下去发的是「继续」、气泡立刻出现并带「正在启动 pi…」；9 段 —— 只读会话输入框可用、气泡立刻出现。`node --experimental-transform-types web/tests/continue-unit.mjs`（`starting` → `ready`）。`node bridge/tests/boot-queue-merge.mjs`、`node bridge/tests/create-fast.mjs`、`node bridge/tests/continue-ui.mjs`（40/40）不回归；两边 typecheck（i18n-check 1651 keys × 3 langs）与 build。

## D182 启动窗口里的边界输入：图片原样带走、粘贴块不再削、`!` 命令给句人话不排队（`#202`；图片/粘贴沿用 D178 的队列，`!` 是唯一一条不进队列的）

**已被 D183 取代：** `!` 命令改为排进 `bootBash`（不再拒绝）；撤回窗口改按「还有气泡在桥里」判、失败气泡可退回输入框。下面第 3 条与「代价」里关于 `!` 的取舍以 D183 为准。

**问题：** D178–D181 把「启动期能发消息」做通了，但只验证了纯文本：① `BootEntry` 里 `images` 字段一直在、泵也一直在映射，可没人钉住「交出去的 prompt 真的还带着图」，界面上「+N 图」「附 N 张图片」在启动期有没有掉也没人看；② 粘贴块（长文本 / 代码块）送到桥之前会过一次 `p.text.trim()` —— 贴一段代码时那会削掉块首行的缩进和末尾的空行，交出去的内容和用户贴的不是一份；③ `!cmd` / `!!cmd` 走的是 RPC 的 `bash`，和 `bootQueue` 排的 prompt 根本不是一条通道。票面（#202 AC 3/5）假设「`!` 启动期不被拦、pi 起来后执行」，但 bash **没有队列语义**：排到启动后跑，等于把「顺手敲一下」变成一个延后执行的惊喜 —— 命令什么时候生效、在哪个目录、上下文里进不进，用户都不再看着。

**决定：**

1. **图片：一个字节都不碰，跟着同一条队列走**。`landUserPrompt()` 只把 `mimeType` 记进 item（气泡要的是「附 N 张图片」），`bootQueue` 的 `BootEntry` 带完整 `{data, mimeType}`，`pumpBootQueue()` 交出去时原样映射成 pi 的 `message.images`。前端「+N 图」徽标、图片面板、乐观气泡的认领都是启动期与平时同一套代码，没有第二个入口。
2. **粘贴块：不再 `trim()`，只丢「整块都是空白」的**。`sendPrompt()` 里的 `p.text.trim()` 改成 `p.text.trim() ? p.text : ""`：气泡与交出去的文字同源（同一个 `text`），所以两边天然一致；保留缩进 / 制表符 / 行尾空格，正是「贴代码」要的。粘贴块仍按原顺序排在打字内容之前、空行分隔，一次发送合成一条 prompt —— 与平常一致，不为启动期另立格式。
3. **`!` 命令：拒绝，不排队，草稿留在输入框**。两层同一句话「pi 还在启动，`!` 命令等它起来再跑」：
   - 前端 `runBuiltinCommand()` 在 `socket.send({type:"bash"})` **之前**看 `session.starting`，命中就 `say(tr(…), "warn")` 并 `return true` 但**不**清稿 —— 用户按的这次回车没发东西，pi 起来后再按一次回车就是那条命令；
   - 桥 `Session.bash()` 开头 `if (this.state.starting) throw`（在 `bashRun` 冲突检查与 BashItem 落地之前）—— 这道闸管的是前端看不见的窗口：只读会话的第一条 `!`，`openLive()` 会先把 pi 拉起来那一刻 `starting` 才为真，前端的 `session.starting` 还是假的。
4. **不分叉**：图片、粘贴块走的仍是 D178/D179/D180 那一条 `bootQueue` + 泵；`!` 是**刻意不进队列**的那一类，桥里没有任何第二条待发通道。

**代价 / 可改：**

- **只读会话的第一条 `!` 会丢草稿**：前端那时 `starting` 还是假，命令发上去了，桥拉起 pi 后被闸挡下、notice 异步回来 —— 一句话有了，但输入框已经被清空（`done()` 在 `socket.send` 之后就跑）。修它需要「桥拒绝后把命令退回去」的通道，本票没做；启动窗口里（前端看得见 `starting` 的常态）不会丢。
- **撤回（#199）只退文字，不退图**：`clearQueue` 的 `queue.restore` 只带 texts，所以启动期撤回一条带图的消息，图和气泡一起没了、文字回到输入框。既有取舍（#199 的范围），#202 没动 —— 要修得先决定「撤回时图放哪」（待发图片区 vs 一起退回草稿）。
- **粘贴块的「整块空白」判断用的是 `trim()` 的结果**：内容保留，但只含空白的块仍然被丢，和手打空格不进队列一致。
- **`!` 的拒绝是一句话，不是排队**：用户得自己再按一次回车。这是有意的 —— 见上，bash 没有「稍后执行」的语义，替用户记住命令就是在替他决定什么时候跑。若日后真要做，得先给 RPC 的 bash 补一套带序的队列语义（且要说清上下文如何进），不是前端加个数组。
- **桥那句 notice 没有 sessionId**（WS 兜底 catch 的老形状），多标签页里离线的那些页看不见；常态路径由前端自己那句话负责。

**验证：** `PI_WEB_PORT=7927 node bridge/tests/boot-queue.mjs`（桩 pi 慢启动 2500 ms）：F 段 —— 启动期发一条带两张图 + 一条纯文字，窗口期桩 pi 一条 prompt 都没收到、item 上是 `[{mimeType:"image/png"},{mimeType:"image/jpeg"}]`，就绪后桩 pi 记录的 `TEXTIMG` 那条带 `images: ["image/png","image/jpeg"]`、下一条是 `[]`、两条按序；`item.replace` 之后两张图还在、`pending: "sent"`。G 段 —— 启动期贴 7 行代码块 + 打字：气泡文字与桥收到的 `text` 一字不差（缩进、制表符、行尾空格都在），结尾是 `\n\n` + 打字内容。H 段 —— 启动期发 `bash`：notice 含「还在启动」与 `` `!` ``、**没有** bash 卡片、**没有** user 气泡（没被塞进 prompt 队列）、桩 pi 没有 `t:"bash"` 记录；`starting` 翻假后同一条 `!!` 照常跑、输出照常回来，且启动期那条始终没在后台补跑。`PI_WEB_PORT=7929 node probes/session-starting.mjs`：10 段 —— 启动期贴两张图，`.row` 徽标是「+2 图」，交出去的 prompt 带两张 `image/*`，气泡「附 2 张图片」+「正在启动 pi…」，发完徽标清空；11 段 —— 启动期贴 24 行代码块，气泡 `.foldable.has-fold`，气泡正文与交出去的文字逐字相等（605 字），12 段 —— 启动期 `!` 给一句人话、没发 `bash`、草稿还在，`starting` 翻假后再按回车才真发出去（`excludeFromContext: false`）；末尾把同一段文字在平时再发一次，两条气泡的 `foldable` class 与折叠按钮文案完全相同。`PI_WEB_PORT=7928 node bridge/tests/boot-queue-merge.mjs`、`node bridge/tests/create-fast.mjs`、`node bridge/tests/composer-actions.mjs` 不回归；两边 typecheck（i18n-check 1652 keys × 3 langs）与 build。顺手修好桩 pi 的一处真 bug：`bashAborted` 在 D169 那次提交里被写成 `const`（`abort_bash` 会赋值），于是桩 pi 收到第一条 `bash` 就抛 `Assignment to constant variable` 退出 1 —— H 段才发现（`bridge/tests/composer-actions.mjs` 因此也一直是红的）。

## D183 启动窗口评审修复：`!` 也排队、撤回看气泡、失败可退回、泵期间排尾、退出文案去数字（`#202` 评审；接 D178–D182）

**问题：** #195 与 #197–#202 落地后两路评审找出五个真实缺口：① 只读会话的第一条 `!` 会在拉起 pi 的窗口里被桥拒绝，而前端已经清掉草稿 —— 命令没跑、稿也没了（D182 把这条写成「代价」，实际是丢用户输入）；② 首条已交给 pi、其余还在桥队列等 `agent_start` 的 ≤10 秒里，`starting` 已经是假，撤回按钮与 Esc 都被 `starting` 挡住，违背 #199 的「这批消息随时能退」；③ 失败气泡只有「重试」，没有 #195 状态机里写的「退回输入框」；④ 补发泵运行期间（`starting` 假、`bootQueue` 非空）新消息直奔 pi，插到更早的待发消息前面；⑤ pi 进程退出的 notice 仍把 `exit code=… signal=…` 甩给用户（#200 AC6 要求人话）。

**决定：**

1. **`!` 也排队，不再拒绝**（推翻 D182 决定 3）：`Session.bash()` 在 `starting` 为真时立刻落一张 `status: "queued"` 的 BashItem 并广播 `item.add`，命令进 `bootBash`；就绪处（`get_state` 落地的 `.finally`）`flushBootBash()` 按入队顺序逐条执行，跑前把同一张卡片改成 `running` 并 `item.replace`。前端删掉启动期的 `starting` 拦截，bash 卡片多一个 `queued` 态（`tr("等待 pi 启动…")` + `act-spin`，复用现有卡片视觉）。只读会话因此不再出现「拉起 pi 的那一瞬被拒」。
2. **撤回的门按气泡判，不按 `starting` 判**：`withdrawBoot()` 与 Esc 都改成「`chat.bootingCount() > 0` 才动手」，状态行那颗「撤回」的显隐同判据。首条已交出、其余还在桥里的窗口里，`bootQueue` 里还有气泡，撤回照常可用。
3. **失败气泡也能退回输入框**：`withdrawQueue()` 把 `bootFailed` 与 `bootQueue` 一起 splice，按原始输入顺序（`bootFailed` 是更早的失败批次，排在 `bootQueue` 之前）并进 `queue.restore`，并删掉对应气泡；failed 徽标旁加第二颗按钮（`tr("退回输入框")`）发 `clearQueue`。桥里 rpc 已经死了（`!rpc?.alive`）时也要清这两个队列并发 `queue.restore`，不能直接 `return 0`。
4. **泵运行期间的新消息排到队尾**：`prompt()` 的 `booting` 判据从 `this.state.starting === true` 扩成 `=== true || this.bootQueue.length > 0` —— 泵还在清更早的消息时，新消息必须排在它们后面，保持输入顺序；气泡照旧带 `pending: "booting"`。
5. **退出文案说人话**：进程意外退出的 notice 改成「pi 进程意外退出了（可能有别的终端占着这个会话）。历史留在磁盘，发消息会重新接管。」；`exit code=… signal=…` 只进 `console.log` 的 `[exit] <sessionId>` 一行。

**代价 / 可改：**

- **`!` 变成延后执行**：启动窗口里敲的命令不再「立刻跑」，而是等 pi 就绪后按入队顺序跑；执行时机从用户按回车那一刻挪到就绪那一刻。这是「不丢命令」换来的，且卡片上的「等待 pi 启动…」把这件事说在明处。
- **`bootBash` 不随撤回清理**：`!` 一旦发出就算发出，`withdrawQueue()` 只退 prompt 队列。与平时一致 —— 已经跑过的 bash 也撤不回；把 `!` 混进「退回输入框」会让撤回的语义分叉（命令不是草稿）。要改得先决定「撤回一条还没跑的 `!`」算不算取消。
- **`bootFailed` 仍不落盘**：D179 的取舍不变，桥重启后失败项只剩气泡可复制。
- **撤回文本顺序**：`bootFailed` 排在更早的失败批次之前（按原始输入顺序），同一批内保序；`queue.restore` 仍只带文字，图片仍不退（D182 的既有取舍）。
- **删除启动期 `!` 的提示文案**：前端不再说「pi 还在启动，`!` 命令等它起来再跑」，旧 i18n 键随删；这句话现在由卡片状态承担。

**验证：** `PI_WEB_PORT=7934 node bridge/tests/boot-queue.mjs`：H 段改为启动期 `bash` → 卡片 `queued`、无 error notice、桩 pi 没收到；就绪后同一张卡片 `running` → `done`、输出含 `ran: …`、只跑一次。I 段 —— 只读会话启动期 `!echo hi`：不报错、卡片 `queued`、无 bash 记录；就绪后 `running` → `done`、只起一支 pi 且走 `--session`。J 段 —— 泵已交出第一条 HOLD、两条还在桥里时 `clearQueue`：`queue.restore` 只含后两条、`item.remove` 只删这两条、第一条与 bash 卡片不动、`!` 仍照常执行。K 段 —— 启动期两条失败后 `clearQueue`（rpc 已死）：文本按原顺序退回、气泡删除、notice 不含 `exit code` / `signal=`。`PI_WEB_PORT=7936 node probes/session-starting.mjs`：12 段 —— 启动期 `!` 照发、卡片「等待 pi 启动…」+ 转环、无拒绝、草稿清空只因命令已被收下，就绪后同一张卡片出输出；13 段 —— 只读会话自动接管的窗口里同样排队并跑出输出。`node bridge/tests/boot-queue-merge.mjs`、`node bridge/tests/create-fast.mjs`、`node bridge/tests/composer-actions.mjs`、`web/tests/continue-unit.mjs`、`bridge/tests/continue-ui.mjs` 不回归；两边 typecheck 与 build。

## D184 隧道默认走 http2：本机 QUIC 到 Cloudflare 边缘 10 秒就断，quick tunnel 一直换地址（无票，用户报「开公网隧道后不可访问」= 1033）

**问题（2026-11-08 实测）：** cloudflared 2026.10.6 默认协商 QUIC。本机 QUIC 能注册，但 ~10 秒后 `ERR Serve tunnel error error="accept stream listener error: failed to accept QUIC stream: timeout: no recent network activity"`；重试偶尔直接 `ERR Register tunnel error from server side error="context deadline exceeded"` → `initial tunnel connection failed` → 进程 `code=1` 退出。桥按 D29 整进程重拉、**URL 每次变**；而 `waitReady` 那几秒确实探得通，于是对外报出的地址在一分钟内变成 530 / 1033 —— 用户拿到的链接永远是死的。`bridge.log` 里 02:14–02:20 每分钟一段 `tunnel up … ` + `隧道断了（530），正在换新地址` 就是这条链。换成 `--protocol http2` 后同机连续 5×10s 探测全 200，`ERR` 一条没有。

**第二个坑：** `URL_FALLBACK_RE` 违反 D29 —— 从创建失败日志里抓到 `https://api.trycloudflare.com` 并报 `tunnel up`（02:17:30 日志实证），那是 Cloudflare 的 API 主机，不是隧道；配合 `probe` 的 `status > 0`（任何非 0 都算就绪），它还能一直显示「在线」。

**决定：**

1. spawn 参数加 `--protocol`，**默认 `http2`**；`PI_WEB_TUNNEL_PROTOCOL=auto|quic|http2` 覆盖（认不出的值回落默认，不把垃圾参数递给 cloudflared）。逻辑抽成 `tunnelProtocol()` / `tunnelArgs()` 并导出，便于单测。
2. **只认框线里的 URL**：删 `URL_FALLBACK_RE`，解析收进 `parseTunnelUrl()`；`watch` 改成累积 4KB `buf` 再匹配，管道把横幅拆两块的偶发也不会漏。
3. **就绪判据收紧成 `/healthz` 200**：530 是隧道没连上，502/404 也不是「能用」。
4. **健康检查连续两次探不通才判死**并换地址（单次 530 多半是边缘抖动，换地址等于让已经发出去的链接立刻失效）；中文文案同步改「隧道断了（连续两次探不通），正在换新地址」，`en`/`ja` 一起改。
5. cloudflared 退出时把 stderr 最后一条 `ERR` 附进 `error`（截 200 字符），写进 `bridge.log` —— 此前原因被整个吞掉，只能靠复现猜。

**为什么不是 `--protocol auto`：** cloudflared 的 auto 只在「连不上」时降级；本机是「注册成功、随后没有数据」的半死形态，它不会自己换 http2，正好卡在这个坑里。

**代价 / 可改：**

- http2 比 QUIC 多一点握手开销（本机实测延迟差别看不出来，稳定性差别很大）。要回 QUIC 就 `PI_WEB_TUNNEL_PROTOCOL=quic`，不用改代码。
- 断线后最长等 2 分钟（两次 × 60 秒巡检）才换地址：换来的是「已经发出去的链接不会因为一次抖动就作废」。
- 退出原因进 `error` 后，UI 的 warn notice 里会多一段英文 stderr；它是诊断线索，不是给用户的操作指引。

**验证：** `npm run test:tunnel`（框线解析 / 拒绝 `api.trycloudflare.com` / 协议默认与覆盖 / 参数拼装）；`npm --prefix bridge run typecheck`；手工对照 —— 默认 quic 9 秒内退出，`--protocol http2` 连续 50 秒 5 次 200。

## D185 `subagent({workflow:…})` 的后台 run 也要有任务原文、agent、过程记录和最终输出（无票，用户报的；读盘的三个字段全是空的）

**问题：** 用户派了一个 `subagent({workflow:"parallel", args:{tasks:[…5 条]}})`，详情弹层里只剩 UUID 和「运行中」：任务行「（任务原文没传到桥）」、卡片头落到默认的「子代理」、「过程」写「桥还没接上这个 runner 的过程记录。」。三处都因为 `bridge/src/bgruns.ts` 只按单 run / parallel 的形状读盘 —— `str(d.task) ?? str(a.task)`（workflow 的原文在 `args.args.tasks[]`，深一层）、`details` 里本来就没有 `agent`（pi-subagents 的 `subagent-executor.js:6188` 只给 `mode/runId/asyncDir/workflow/workflowChildren/…`）、`statusField(dir,"outputFile")`（workflow 的 `status.json` 25 个 key 里没有它，只有单 run / parallel 才写 `output-<n>.log`）。`prune()` 补的是同一个字段，所以 `hasLog` 不是晚一拍，是永久 false。

**决定：**

1. **任务原文从 `args.args.tasks[]` 取**：`taskList(a)` 认 `a.tasks` 与 `a.args.tasks` 两个位置；多个孩子按原顺序逐条编号（`1. … 2. …`，12 条封顶 + `… (+N)`），`.bg-run-task` 本来就是 `white-space: pre-wrap`。
2. **agent 两路兜底**：`args.args.tasks[].agent` 去重（超过 3 个写 `a + b + c +N`）；脚本式 workflow（没有 `args.tasks`）退到 `details.workflowChildren.children[].agent`，任务同样从那里的 `sessionName` 去掉 `researcher: ` 前缀。
3. **过程记录 = `<asyncDir>/events.jsonl`**（`workflowEvents()`）：workflow 没有 `outputFile`，但 pi-subagents 自己往同目录写事件流。页面看到的不是原始 JSONL —— `workflowTimeline()` 只投影骨架（`workflow started` / `task-1 researcher started` / `task-1 completed` / `workflow completed (complete)`），跳过累积快照 `subagent.workflow.trace`，也不把孩子答复（`child_settled` 的 `result`）甩出来。事件名保持 runner 原文，不翻译、不进 i18n —— 跟 `.activity` 原样展示同一层级。补 `logPath` 有两处：30 秒滴答（`prune()`）与 `readLog()` 自己抬手（弹层 1.5 秒一轮，不该等滴答）。
4. **最终输出现拼**（`workflowOutput()`）：`status.json` 的 `workflow.value.children[].output`，按 `## <key> · <agent>` 分段；`hasOut` 对 workflow 用「跑完了没有」判（`state !== "running"`），不再指望一份永远不存在的 `subagent-log-<id>.md`。
5. **已有值一律不覆盖**：`agent` / `task` 都接在 `??` 链尾，单 run / parallel 的读盘分支（`outputFile` → `output-<n>.log`、`subagent-log-<id>.md`）一个字节不改；workflow 的兜底只填空位。副作用是 parallel 若只给了 `args.tasks`、`details` 又没有 `agent` / `task`，卡片也顺带显示逐条任务 —— 比空着好，特此写明。
6. **清单晚到时从 `workflow-receipt.json` 回填**：脚本式 workflow 边跑边建孩子，派活那刻 `details.workflowChildren.children[]` 可能是空的，此时 `agent` / `task` 会永久钉死在空值上（病因 (b) 在这一支没闭合）。`prune()` 于是对「workflow 且空着」的卡读同目录的 `workflow-receipt.json`（`workflowChildren.children[]` 带 `agent` 与 `sessionName`）再合一次。

**代价 / 可改：**

- **一张卡代表整个 workflow**：5 个孩子共用一张卡、一个 runId。各自的进度只在「过程」那段文字里按时间排；要拆成 N 张卡得先改 `BgRuns` 的表结构与前端渲染，本票没做。
- **`workflowTimeline` 按字节尾巴读**（`max(limit*4, 32KB)`）：极端情况（几十个孩子、`child_settled` 带大 `result`）会截掉早期骨架。实测那份 workflow 84 秒 22 行、9.7 KB，离上限很远。
- **最终输出取开头**：超 `limit` 时截尾保留开头（结论在前）。要看完整答复仍需读 `outputReference` 指向的 `task-N.md` —— 那份不在桥的白名单里。
- **脚本式 workflow 的任务是截断过的**：`sessionName` 只留到 `…fetch_c` 那么长，卡片上看到的是截断原文（这类 workflow 的完整 prompt 在 `details` 里根本没有）。`workflow-receipt.json` 里的也是同一份 `sessionName`，回填补不上这个截断。
- **`status.json` 每次详情轮询都 parse 一遍**（几十 KB）：1.5 秒一次、单会话量级，比多维护一份缓存简单；真嫌慢再加 mtime 缓存。

**验证：** `npm run test:bgruns`（`bridge/tests/bgruns-unit.mjs` 新增 workflow 段）：`details` 抄真实形状（无 agent/task、无 outputFile）→ agent `researcher`、任务 `1. … 2. …`；`events.jsonl` 落盘前 `hasLog` false，落盘后 `prune()` 补上，时间线含 `workflow started` / `task-1 researcher started` / `task-1 completed`，不含 20 KB 的 `result.output`（`XXXX`）也不含 trace 快照（`operation`）；写 `status.json`（`state:"complete"` + 两段 `workflow.value.children`）→ `prune()` 翻 `done`、`hasOut` true、`readLog().out` 是 `## task-1 · researcher` / `## task-2 · researcher` 两段；脚本式（`{workflow:true}`、无 `args.tasks`）→ agent `planner`、任务 `拆一下这个需求`；`events.jsonl` 在 `prune()` 之前写出来 → `readLog()` 直接接上（不用等滴答）；派活那刻清单为空、之后写 `workflow-receipt.json` → `prune()` 把 agent / task 补回 `planner` / `1. … 2. …`；parallel 只给 `args.tasks` → 逐条列出（决定 5 的副作用，明写）。原有 acp / 单 run / parallel / D172 幽灵任务 / 路径白名单用例全部不回归；`npm --prefix bridge run typecheck`。

## D186 step-up 窗口从 10 分钟放宽到 1 天，前端不再自带一套 9 分钟的钟（无票，用户报「开公网隧道访问会频繁让输口令」）

**决定：** `bridge/src/index.ts` 的 `STEP_UP_MS` 从 `10 * 60 * 1000` 改成 `24 * 60 * 60 * 1000`。

`stepup-ok` 从此同时带 `until`（绝对时刻）与 `ttl`（相对时长），前端用 `Date.now() + ttl - 60s` 作为本地窗口：
`until` 要拿浏览器时钟去比，手机时钟偏快就会「刚验完又弹」，正是这轮要治的症状；`ttl` 不受时钟偏差影响，`until` 只作旧桥的兜底。

弹窗文案的时长改成占位符（`（{p1}内免重复）` + `tr("1 天")`），下次调窗口只动 `STEP_UP_MS` 与「1 天」那一条译名，
不用再去改三份 i18n 里的整句。

**为什么：** 用户报「频繁输密码」，先分时限：登录 cookie 是 30 天（`bridge/src/auth.ts:6`），本轮隧道 10:38 起只有 3 次 `ws connected`、2 次 `login ok`（两个不同公网 IP），登录态并没有反复失效 —— 反复弹的是 D15 的 step-up。10 分钟窗口当初按「手机上偶尔输一次」设计（D15），实际一轮对话里批准几次就到点；更糟的是前端还留了一份 9 分钟的近似值，比桥更早弹窗，等于实际窗口不到 10 分钟。1 天窗口仍要求「写入前现场证明持有口令」，只是把频率降到一天一次；D15 防的是口令从微信/浏览器历史里泄露后被陌生人拿去写，这个威胁模型和窗口长短关系不大。

**代价 / 可改：**

- **stepUntil 仍挂在单条 WS 连接的进程内存里**：桥重启、页面刷新、断线重连都会清零，只是不再每 10 分钟清零。要真正做到「一天只输一次」得把它移到按 IP/cookie 记的表或签名的 cookie 里，本次没改。
- **窗口内被同一浏览器接管的人可以直接写**：和「cookie 被偷」同一等级的风险，D15 的边界本来也不是防这个。想做「批准前一律再验」就把 `STEP_UP_MS` 调回 0（会退化成每次操作都问）。

**验证：** `npm --prefix bridge run typecheck` + `npm --prefix web run typecheck`（含 `i18n-check`）；文案模板键在 `en.ts` / `ja.ts` 同步换键并补 `1 天` 的译名，漏一条 typecheck 会报。
已有 step-up 用例（`bridge/tests/runtime-settings.mjs`、`sleep-all.mjs`）只断言「公网要口令」，不锁时长，不受影响。

## D187 open_preview 的路径信任只到「会话目录 + transcript 尾部」（#225）

**决定：** `/api/preview/open` 在调 `openPreview` 之前先过 `isTrustedPreviewPath`：路径在会话 cwd 之内，或在会话 transcript（`state.file`）里出现过，才放行；否则回 `{ok:false, reason:"untrusted-path"}`，**不签发 token、不投递**。`openPreview` 自己那条宽松规则（D50：任意绝对路径可读）保持不动，`/api/preview` 与 `/api/dirs` 照旧。

- transcript 只读尾部 `TRANSCRIPT_TAIL_BYTES = 512 KB`（`fstat` 拿 size，再从 `size - cap` 处一次读进来）：长会话的记录轻松过 10 MB，为一次工具调用整份读进内存不值。
- 归一化：把连续 `/` 与 `\` 都折成单个 `/`（JSONL 里每个反斜杠是 `\`，折叠后两边天然一致），Windows 上再 `toLowerCase()`；匹配是朴素 substring。
- 路径解析抽成 `resolvePreviewPath`，信任检查与真正打开用同一个结果，避免两处各解析一遍却解析出不同路径。

**为什么：** 这个工具带的是会话级回环凭据，路径由模型随便填。`/api/preview` 的宽松规则有页面上的目录树兜着（是用户自己点开的），工具没有这一层：不设门槛就等于让模型把 `~/.ssh/id_rsa` 之类的东西推进用户的预览面板。反过来，pi 自己写到会话目录之外的文件（临时脚本、别的仓库里的报告）本来就该能看，「transcript 提过」就是那条正当通道 —— pi 提到过的路径一定在会话记录里。拒绝用一个独立 reason，工具回给模型的话才能说清「放哪儿再试」，而不是含糊的失败。

**代价 / 可改：**

- **提及会过期**：一条路径被 512 KB 新历史压下去之后不再放行。工具通常在写完/读完后紧接着调用，够用；真要更久就调大常量，代价是每次调用多读几 MB。
- **substring 不是路径边界匹配**：记录里提到 `a.md` 时 `a.md.bak` 也会命中（前提是那个文件真实存在）。这是「别让工具乱逛」的闸，不是沙箱。
- **没做 realpath 归一**：cwd 里的软链接指向目录外仍然放行，与 `/api/preview` 的既有行为一致，这一票没有单独收紧。
- **前端 `msg.sessionId !== this.currentId` 的双保险保留**：桥不该发错会话，但这道闸是免费的，探针里用 `routeWebSocket` 伪造一条错会话的 `preview.open` 把它测住。

**验证：** `node bridge/tests/preview-tool.mjs`（22 项：两个标签页都在看 → 都收到；cwd 外且 transcript 没提过 → `untrusted-path`、不回路径/凭据、不投递；提过 → 允许；再塞 600 KB 填充把提及挤出尾部窗口 → 重新拒绝）；`node probes/preview-open.mjs`（16 项：wrong-session 请求后标题、正文与 `scrollTop` 都不变；伪造错会话的 `preview.open` 被前端丢掉，同一条消息换对 sessionId 会打开；页面仍停在原会话；两个标签页都弹）；`npm run typecheck`。

## D188 网页会话多一段「交付礼仪」提示词：覆盖全局规则、只投给正在看本会话的页面、先问后开（#226，父票 #223）

**决定：** `Session.startLive` 在「工作区教训」之后再传一次 `--append-system-prompt`，内容是 `bridge/src/delivery.ts:18` 的 `DELIVERY_HINT`（8 行、514 字的短文本，不走文件）。`PI_WEB_HINT=0` 关掉，与 `PI_WEB_LESSONS=0` 同一手感；两个开关各管各的，谁关掉都不会顶掉另一段（pi 的这个参数可重复）。提示词里写死四件事：你在 pi-web-client 的网页客户端里、用户正在这个页面上看；这一段**覆盖**全局 AGENTS.md 的「产物交付：能开就直接开」；交付产物（html / md / 图片 / 表格 / 代码）先用问卷问「要在预览里打开吗？」（选项「在预览里打开」「先不看」），选了打开才调用 `open_preview`，不为交付开浏览器窗口或本机程序；工具回 `no-page` 就改说「点上面的路径」、回 `untrusted-path` 就说明文件不在会话目录，PDF / docx / 在预览里跑坏白屏的只讲原因并指向客户端既有的「用本机程序打开」出口。

**为什么：**

1. **不动全局 AGENTS.md。** 那条「能开就直接开」对终端里的 pi 仍然正确（终端没有预览面板，「打开」只能是外部程序），而全局文件归用户所有、影响所有项目 —— 为一个客户端改掉所有地方的交付方式不划算，也会让终端的 pi 去开一个没人看见的窗口。覆盖关系改由这段随会话注入的文本自己声明：模型是在 spawn 那一刻才知道自己在网页里，就在那一刻告诉它「两处冲突以这里为准」，比让两份常驻文档互相引用干净。终端会话没有这段注入，规则原样生效。
2. **只投给「正在看本会话」的页面（与 D187 的投递范围同一条链）。** viewer 是单例面板，产物跟着会话走；一个后台会话写完文件就抢走前台页面的预览，等于把人的注意力从正在读的东西上拽开。没有页面在看就回 `no-page`，让模型改口写路径，而不是假装打开过 —— 否则它会接着讲用户根本没看到的东西。失败语义要在提示词里写死，因为模型对「工具失败」的默认反应常是重试或糊过去。
3. **先问后开，不自动弹。** 一次交付可能不止一个产物（html + 图 + 表格），自动弹就是连着抢镜头，手机上尤其烦；从点击「在预览里打开」到 viewer 出现还隔着一次模型往返（1–3 秒），自动弹会让这段空白看起来像卡住。问一句把「开不开」留在人手里，代价是一次往返加一张问卷卡。

**代价 / 可改：**

- **提示词是每个网页会话 spawn 都要付的固定成本**（514 字）。嫌贵可以并进 lessons 那一段，或缩到只剩「你在网页里 + 先问后开」两行。
- **问一次要等一次模型往返。** 要更快可以让问卷卡的「在预览里打开」自己直连 `/api/preview/open`（票面 Out of Scope，本次没做）；那时提示词里「选打开才调用工具」这句要改成「问卷已经替你打开」。
- **`PI_WEB_HINT=0` 只关提示词、不关工具。** 模型仍可能从别处知道 `open_preview` 后直接调用；要彻底关掉就把 `previewToolPath()` 也挂到同一个开关上（现在故意不挂：工具本身无害，关提示词的人通常只是嫌啰嗦）。
- **「同一个文件问过一次就不再问」只是提示词里的一句话**，桥不记账，同一轮里模型仍可能再问一次。
- **PDF / docx 的出口靠客户端既有按钮**：提示词只说「指向它」，模型写出来的措辞不受控；要统一文案得在问卷卡或工具回包里给固定句子。

**验证：** `npm run test:hint`（`bridge/tests/hint-spawn.mjs`，12 项：默认两段都在、教训文件内容对得上、交付提示词含「覆盖」/「要在预览里打开吗」/`open_preview`/`no-page`/`untrusted-path`/「用本机程序打开」且不超过 15 行、`PI_WEB_HINT=0` 只剩教训、`PI_WEB_LESSONS=0` 只剩提示）；`node --experimental-transform-types bridge/tests/lessons-spawn.mjs`（8 项；改了两条断言：#226 起第一次 spawn 也带交付提示词，「没有教训段」改成按值判断而不是按参数名）；`npm --prefix web run typecheck`（本次没有新增界面文案，i18n 键不变）。

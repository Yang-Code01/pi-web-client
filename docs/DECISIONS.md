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
决定：网页里的每个会话是一个 `pi --mode rpc` 子进程；回收判据与内存上限见 **D120**（2026-11-04 由「空闲 2 小时」改为「完成 + 30 分钟无事件 + 2.5 GB 水位」；**这两个数 2026-11-21 由 D372 改为默认 120 分钟 / 5 GiB**），下次点开复活（同 session path）。
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

## D44 失败的工具调用在折叠模块之外再钉一条失败条（画法与位置均已被 D253 取代：失败条目现在在模块内的第二页）

**决定：** 一轮里的工具调用照旧折进一个 `<details class="ops">`（标题 `19 个操作 · bash ×19 · 1 失败`）。新增的是：任何失败的工具调用**同时**在模块后面钉一条独立 `.failbar`（`web/src/chat.ts` 的 `failureBar()`），默认展开，内容是「✕ 工具名 + 完整命令」一行、「首条错误行」一行（收起时才显示，`firstErrorLine()` 优先挑 `fatal|error|failed|cannot|denied|not found|timed out|ENOENT|EACCES|Traceback|✗`，跳过 `$ ` 开头的命令回显）、`失败 · 21.4s` 元信息、以及 `<pre>` 里的完整输出（`max-height: 240px` 自己滚）。失败条按 `toolCommitId` 存进 `failBars` 映射，live（`toolEvent("end")`）和历史回放（`add()`/`replace()`/`mergeTool()`）走同一个方法，所以刷新页面后样式一致。

**为什么不在标题旁边就地展开模块（样张 B）（这条结论已被 D253 推翻，留作历史）：** 19 条操作全铺开会把整整一屏的正文顶走，而失败通常在列表最末，还是要滚；长会话每次失败都撑一次版面。

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

**UI：** 底部抽屉（单题点选即答；多题 tab + 显式「提交」，可回改；都带「取消这次提问」和「自己写…」）+ composer 上方一条「待你回答 · 点此回答」顶条。关掉抽屉不再自动弹回（`askSeen` 记 id），但**刷新/重连时**没展示过的问题会自己弹开 —— 否则用户回来只看到模型不动。问句卡片不进 `.ops` 折叠模块：它是内容，不是操作记录，`chat.ts` 的 `add`/`replace`/`toolEvent` 三处都要绕开 ops 分组。**（D189 改了这一段：宽屏答在「需要你」右栏，收起右栏 / 窄屏才回到 composer 上方的整块面板。）**

**验证：** `npm run test:ask`（`bridge/tests/ask-unit.mjs` 注册表单元 + `ask-e2e.mjs` 隔离桥 7891：三道闸 403、`/api/sessions` 仍 401、真模型单题作答拿到 `User selected: 2. 右边`、两题问卷取消拿到 `User cancelled the questionnaire`）；`npm run test:ask:ui`（`ask-ui.mjs`，真 Chromium + 真模型六轮：抽屉自弹、顶条、刷新补发、点选即答、气泡、两题 tab + 提交、自己写 `User wrote: 随便写点`、停止运行让 pending ask 以 `cancelled` 收尾、390px 手机版）。截图在 `.scratch/shots/ask-*.png`。

**可改：** 想让「新会话默认允许提问」变成开关、或把抽屉改成行内展开（不遮住会话），都只动 `web/src/app.ts` 的 `openAskSheet` + `styles.css` 的 `.ask-sheet`。

**#224 起（预备重构）：** 这份凭据不再只给「问用户」用，名字跟着改成中性的回环通道 —— env 是 `PI_WEB_LOOPBACK`（回环 origin，不是某个端点）+ `PI_WEB_LOOPBACK_TOKEN`，`Session.askToken` / `askUrl` → `loopbackToken` / `loopbackUrl`，`SessionManager.byAskToken` → `byLoopbackToken`。路由仍是 `/api/ask`；全局两个扩展同时认旧名 `PI_WEB_ASK`，旧桥起的会话不受影响。

## D48 会话管理：置顶 / 拖拽排序 / 归档 / 删除都只动 `state/manage.json`，删除才碰文件

**需求：** 侧栏要能管理（m00507），用户在三个样张里选了 **A+C**：单列表 + 置顶拖拽 + 管理模式多选（样张留在 `.scratch/session-manage/`）。

**pi 侧没有这些命令。** `dist/modes/rpc/rpc-mode.js` 的 case 表里只有会话级操作（prompt/abort/compact/clone/export_html/set_session_name…），没有删除、归档、分组 —— 所以排列与归档只能是桥自己的状态，删除只能在桥端做文件系统动作。

**决定（一个文件 `state/manage.json`）：** `{ pin: string[], order: string[], archived: string[] }`。三件事都是「用户对这个会话的意图」，不是会话本身的属性，所以不进 pi 的 jsonl（D31 的同一个理由：桥不写别人的文件）。排列算法在 `bridge/src/manage.ts` 的 `compare()`，与 `web/src/app.ts` 的 `arrangeCompare()` 逐条对应：归档沉底 → 置顶按手序 → `order` 按手序 → 两者都不在手序里的（新会话）按 `startedAt` 降序、并排在所有手排项**之前**。新会话永远落在「其它」最上面，不会插进用户手排的顺序中间。

**为什么 `arrange` 收两份完整数组而不是「把 X 挪到 Y 前」：** 拖拽结束时 DOM 就是用户刚排好的顺序（`commitArrangement()` 直接读 DOM），两端各算一遍更容易分叉；整表覆盖是幂等的，多次拖拽也只是最后一次赢。被过滤隐藏的会话没有 DOM 位置，`commitArrangement()` 会把它们按原顺序补在末尾，不会因为一次过滤后的拖拽把它们丢掉。

**归档是纯显示：** `list()` 仍然返回归档会话（带 `archived: true`），由前端决定放进折叠的「已归档」段；`/api/sessions` 的消费者（手机、脚本）不该因为网页上收起来就以为会话没了。

**删除的护栏（缺一不可；**D198** 改掉了一半）：** 只删「非 live、无待审批、没有别人持有 `state/locks/<id>.lock`」的会话；有一个不满足就整批拒绝，并报 `N 个会话正在运行/待确认，不能删：…`（不是部分成功）。**D198 把「非 live / 无待审批」从拒绝条件改成了「先释放再删」，只剩终端锁还是硬闸。** 通过后：删 `.jsonl` → 关掉只读 tail → 从 `sessions` 表移除 → `forgetName(id)`（D43 的覆盖层）→ `manage.forget(id)` → **清 `metas()` 的 5 秒扫描缓存**（否则下一次 `/api/sessions` 会把刚删的会话复活 5 秒，这是探针抓到的真 bug）→ 广播 `session.gone`。前端两步确认（4 秒内再点一次才发命令），因为它不可撤销。

**交互细节：** 卡片永远只有一个点击语义 —— 非管理模式下打开会话，管理模式下切换选中；✎ / ☆ 都 `stopPropagation`。拖拽手柄只在 hover 时显示，且**过滤生效时禁用拖拽**（看不见的卡片没法排位置）。归档段默认折叠，数量在段头；管理条移动到列表上方（侧栏会滚动，放底部会被裁掉一半，样张里就出现过）。

**验证：** `node bridge/tests/manage-check.mjs`（隔离桥 7876 + 3 个手工会话文件 + 真 pi 建 live 会话）：pin/order 写入 `manage.json`、排序按 pin→order、归档后 API 仍在且沉底、删只读会话后文件 + `names.json` + `manage.json` 三处都干净、**live 会话先被释放再进箱（D198）**、**终端持锁仍然被拒（D198）**、**重启后排列仍在**。`node probes/manage-ui.mjs`（真 Chromium + 隔离桥 7877）：☆ 置顶、拖 戊 到 乙 下方、管理模式下选 2 个归档 → 展开已归档 → 恢复、两步删除把文件移进 `state/trash/`（D51 之后不再是 unlink）、过滤只剩 1 张且不可拖。截图在 `.scratch/manage-ui/shots/`。**可改：** 想加分组就在同一个 JSON 里加 `groups`（样张 B 已写过）；想把归档做成「真的看不见」只需 `list()` 过滤 `archived`。

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
>
> **再修订（D253）：** 整张卡搬进模块的「AI 执行失败」页，`<details class="fcard">` 换成 `<section class="fitem">`（不再自成一张卡、也不再默认折叠 —— 它只出现在第二页里），诊断 grid 与 `完整输出` 折层原样保留，`failAnchor` 一并删除。

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

> **后续修订（PDF 内嵌预览）：「PDF 特殊处理」这一条做了。** `kindOf`（`bridge/src/preview.ts:150`）给 `.pdf` 单独返回 kind `"pdf"`，不再落到 `looksText()` 的嗅探里；预览态的 body 是一颗 `<iframe class="viewer-frame">` 直接指向 `/raw` 的字节，翻页/缩放/下载/打印交给浏览器内建的 PDF 查看器，面板不解析也不转换。触发它的是一个真实文件：`ANAJ00L30K25FN0005K9.pdf`（1.4 MB 的加密 PDF，`/CreationDate` 之类的字符串全是十六进制密文，前 8192 字节里 **0 个 NUL、0 个控制字符**）——`looksText()` 只看前 8 KB，判成 `text`，前端 `loadViewerText()` 再 `res.text()` 一读，压缩流就成了乱码。相邻的第二个毛病是：即便没被误判成文本，PDF 也只会落 `binary`（「这个格式这里不支持」），面板里永远看不到内容。
>
> **顺带更正 D166 / D209 里「`/raw` 的 CSP sandbox 会让 PDF 白屏」这句话 —— 它是错的。** 白屏来自 Playwright 自带的 Chromium 没有 PDF 插件（D209 自己的测试记录里也写了这一点），不是 `content-security-policy: sandbox`。实测：同一份 PDF 由本站 `/raw` 提供（带 `sandbox allow-scripts …`）、嵌在 `<iframe>` 里，Chrome 与 Edge 的**有头**模式都能正常渲染出纸面与工具栏（截图在 PR 里）；headless 的 Playwright Chromium 里始终是深灰空框，那是浏览器缺插件、与响应头无关。所以 pdf 不需要像表格/幻灯片那样另开一个不带 sandbox 的端点。
>
> **出口没丢：** `pdf` 不再走 binary 支线，提示框里那颗「用默认程序打开」就看不到了；所以 pdf 的头部工具条补了一颗同名按钮（`web/src/app.ts` 的 `paintViewer`，条件 `info.kind !== "binary" && DESKTOP_OPEN.test(info.name)`），`/api/open` 的凭据照 D209 在 `openPreview` 里注册（`OPENS_ON_DESKTOP`）。
>
> **回归：** `bridge/tests/slides-unit.mjs` 的「.pdf 是 pdf（不是 binary / 不是 text）」两条（含「前 8 KB 无 NUL 的加密 PDF」），`probes/preview-open.mjs` 的 pdf 段（iframe 在、不是 `<pre>`、`/api/preview` 回 `kind: "pdf"`、`/raw` 的 `content-type: application/pdf`）；`PW_CHANNEL=chrome PW_HEADFUL=1 node probes/preview-open.mjs` 还能把 `shots/6-pdf.png` 拍成真渲染的样子。

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

> **修订（D249，2026-11-14，用户报告）：** 下面那句「点一行/一根刻度 → 那一轮滚到视口顶部（最后一轮则回到底部并继续跟流）」的前半段不变、**后半段作废** —— 点最后一轮也落在它自己那次输入上（顶对齐、停跟流）；只有「那一轮本来就落在最后一屏里、顶到顶部也只能贴底」时才回到底部。理由、判据与代价见 D249。

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

> **修订（D244，2026-11-13，用户要求）：** 用户改口径：「现在只有左侧折叠才能在 chat 下面显示目录。现在想要改为，无论是否折叠左侧都显示」。下面「左栏展开时不显示」那一条作废 —— 桌面宽度下常驻，窄屏仍藏；判据、理由与代价见 D244。

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
- 真 Chromium：三种摘要卡片、⧉ 复制到剪贴板、`/ex` 与 `@chat` 补全及采纳、`/tree` 的缩进（8 / 24 / 24 / 24px）与分叉后消息回到输入框、「会话」一节的导出链接与宽度（520px，不再溢出）、终端 `＋` 菜单（powershell / Git Bash / cmd）。

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
   - **不做**「仅本次信任」（`--approve`）：网页里的会话会反复重启 pi，一次性的决定没有落脚的地方。要么保存，要么不信任。**（被 D370 取代的部分）**：未决定 + 全局 `ask` 时由桥自动补 `--approve`（未决定按信任处理）；仍然不提供「仅本次」的按钮。
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

> 2026-11-18：标题里的「验好友」这一关已被 **D300** 取消（文件不再要求好友）；token、分块、续传、`end` 核哈希、磁盘余量都不变。

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

> **D372 修订（2026-11-21）：** 下面第 1、2、5、8 条里的两个默认值已改为**空闲 120 分钟 / 水位 5 GiB**（`bridge/src/lifecycle.ts` 的 `DEFAULT_IDLE_MS` / `DEFAULT_WATERMARK_BYTES`）。「一个 `idleMs` 同时服务三处」的结构不变，所以 watchdog 的卡住判定与审批过期也一起变成 120 分钟。正文里的 30 分钟 / 2.5 GB 保留为当时的记录。

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

> **部分被修订（D233）：** 下面「三条豁免」里的休眠一条已经不成立 —— 随手问现在**默认永不自动休眠**（`scratchIdleMs = 0`），后台回收同样豁免；结束它只有一条路：用户手动按「暂停」。一小时这个数值只在有人显式把 `scratchIdleMs` 填成正数时才回来。其余决定（不进列表、只读工具、同进程清空、重启清空）不变。

**决定：** 顶栏加 `💭 随手问`，打开一个 dialog；它背后是普通 pi 会话，但被一条 `scratch` 标记当成另类处理：

- **不进任何列表**：app 启动时带 `--session-dir` 指到 `state/scratch/sessions`，那个目录不在 pi 的会话根里，扫不到；`list()` 再滤一次（广播的 `session.state` 也不会把它塞回侧栏）。
- **懒建**：第一次点开才 spawn，`scratch.open` 幂等（没有就建、睡过就唤醒、有就复用）。
- **清空 = 同进程 `new_session`**：pi 的 RPC 有这个命令，进程不重启，上下文和 token 归零，旧文件当场删掉。桥侧 id 不变（页面所有东西都以它为键），只把 `state.file` 换成 pi 报的新路径。
- **只读**：`--tools read,grep,find,ls,web_search,fetch_content,source_check,get_search_content`（联网那几个由 `pi-web-access` 扩展提供；实测 pi 对 `--tools` 里不存在的名字只当没写，不会起不来，所以没装扩展时也能降级），并把审批闸的 `/allow` 模式写成 `readonly`（闸那边 `readonly` 是白名单，不是「什么都放行」；联网这组要显式加进白名单）。cwd 是中性空目录。
- **三条豁免**：休眠用自己的一小时（`lifecycle.json` 的 `scratchIdleMs` / `PI_WEB_SCRATCH_IDLE_MS`；**已由 D233 改成默认 0 = 永不自动睡**）；水位永不收它；`maybeAutoCompact` 跳过它，只发提醒。
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
  `CSP: sandbox ...`，PDF 在里面白屏，所以必须另开端点，且这个端点不带 sandbox；
  **更正：**「白屏」是 Playwright 自带 Chromium 缺 PDF 插件造成的，不是 sandbox 头 —— 见 D50 的 PDF 修订）。
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

## D190 open_preview 的路径信任只到「会话目录 + transcript 尾部」（#225）

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

D

**验证：** `node bridge/tests/preview-tool.mjs`（22 项：两个标签页都在看 → 都收到；cwd 外且 transcript 没提过 → `untrusted-path`、不回路径/凭据、不投递；提过 → 允许；再塞 600 KB 填充把提及挤出尾部窗口 → 重新拒绝）；`node probes/preview-open.mjs`（16 项：wrong-session 请求后标题、正文与 `scrollTop` 都不变；伪造错会话的 `preview.open` 被前端丢掉，同一条消息换对 sessionId 会打开；页面仍停在原会话；两个标签页都弹）；`npm run typecheck`。

## D191 网页会话多一段「交付礼仪」提示词：覆盖全局规则、只投给正在看本会话的页面、先问后开（#226，父票 #223）

**决定：** `Session.startLive` 在「工作区教训」之后再传一次 `--append-system-prompt`，内容是 `bridge/src/delivery.ts:18` 的 `DELIVERY_HINT`（8 行、514 字的短文本，不走文件）。`PI_WEB_HINT=0` 关掉，与 `PI_WEB_LESSONS=0` 同一手感；两个开关各管各的，谁关掉都不会顶掉另一段（pi 的这个参数可重复）。提示词里写死四件事：你在 pi-web-client 的网页客户端里、用户正在这个页面上看；这一段**覆盖**全局 AGENTS.md 的「产物交付：能开就直接开」；交付产物（html / md / 图片 / 表格 / 代码）先用问卷问「要在预览里打开吗？」（选项「在预览里打开」「先不看」），选了打开才调用 `open_preview`，不为交付开浏览器窗口或本机程序；工具回 `no-page` 就改说「点上面的路径」、回 `untrusted-path` 就说明文件不在会话目录，PDF / docx / 在预览里跑坏白屏的只讲原因并指向客户端既有的「用本机程序打开」出口。

**为什么：**

1. **不动全局 AGENTS.md。** 那条「能开就直接开」对终端里的 pi 仍然正确（终端没有预览面板，「打开」只能是外部程序），而全局文件归用户所有、影响所有项目 —— 为一个客户端改掉所有地方的交付方式不划算，也会让终端的 pi 去开一个没人看见的窗口。覆盖关系改由这段随会话注入的文本自己声明：模型是在 spawn 那一刻才知道自己在网页里，就在那一刻告诉它「两处冲突以这里为准」，比让两份常驻文档互相引用干净。终端会话没有这段注入，规则原样生效。
2. **只投给「正在看本会话」的页面（与 D190 的投递范围同一条链）。** viewer 是单例面板，产物跟着会话走；一个后台会话写完文件就抢走前台页面的预览，等于把人的注意力从正在读的东西上拽开。没有页面在看就回 `no-page`，让模型改口写路径，而不是假装打开过 —— 否则它会接着讲用户根本没看到的东西。失败语义要在提示词里写死，因为模型对「工具失败」的默认反应常是重试或糊过去。
3. **先问后开，不自动弹。** 一次交付可能不止一个产物（html + 图 + 表格），自动弹就是连着抢镜头，手机上尤其烦；从点击「在预览里打开」到 viewer 出现还隔着一次模型往返（1–3 秒），自动弹会让这段空白看起来像卡住。问一句把「开不开」留在人手里，代价是一次往返加一张问卷卡。

**代价 / 可改：**

- **提示词是每个网页会话 spawn 都要付的固定成本**（514 字）。嫌贵可以并进 lessons 那一段，或缩到只剩「你在网页里 + 先问后开」两行。
- **问一次要等一次模型往返。** 要更快可以让问卷卡的「在预览里打开」自己直连 `/api/preview/open`（票面 Out of Scope，本次没做）；那时提示词里「选打开才调用工具」这句要改成「问卷已经替你打开」。
- **`PI_WEB_HINT=0` 只关提示词、不关工具。** 模型仍可能从别处知道 `open_preview` 后直接调用；要彻底关掉就把 `previewToolPath()` 也挂到同一个开关上（现在故意不挂：工具本身无害，关提示词的人通常只是嫌啰嗦）。
- **「同一个文件问过一次就不再问」只是提示词里的一句话**，桥不记账，同一轮里模型仍可能再问一次。
- **PDF / docx 的出口靠客户端既有按钮**：提示词只说「指向它」，模型写出来的措辞不受控；要统一文案得在问卷卡或工具回包里给固定句子。

**验证：** `npm run test:hint`（`bridge/tests/hint-spawn.mjs`，12 项：默认两段都在、教训文件内容对得上、交付提示词含「覆盖」/「要在预览里打开吗」/`open_preview`/`no-page`/`untrusted-path`/「用本机程序打开」且不超过 15 行、`PI_WEB_HINT=0` 只剩教训、`PI_WEB_LESSONS=0` 只剩提示）；`node --experimental-transform-types bridge/tests/lessons-spawn.mjs`（8 项；改了两条断言：#226 起第一次 spawn 也带交付提示词，「没有教训段」改成按值判断而不是按参数名）；`npm --prefix web run typecheck`（本次没有新增界面文案，i18n 键不变）。

## D192 `open_preview` 要页面回执才算打开：`preview.open.done` + `no-ack` / `stale` 两个 reason（#224 复审，父票 #223）

**决定：** `/api/preview/open` 不再「把 `preview.open` 帧扔出去就回 `ok:true`」，而是给这一帧带上 `reqId`（`crypto.randomUUID()`），在桥的内存里挂 `pendingPreview: Map<reqId, {ws, settle, timer}>`，等页面回一条 `{type:"preview.open.done", reqId, ok, reason?, text?}` 才结算：

- 回执 `ok:true` → `{ok:true, path, name}`；
- 回执 `ok:false, reason:"declined", text` → `{ok:false, reason:"declined", text}`，`text` 就是页面给的解释（用户在「未保存改动，留在这里 / 放弃并打开」里选了前者）；
- 回执 `ok:false, reason:"stale"`（那条页签没在看这个会话）→ 跳过，继续等同会话别的页签 —— 多标签页时不能让它盖掉真正接住那一页的成功；全都 `stale` 就当没接住，回 `no-ack`；
- 超时（`PI_WEB_PREVIEW_ACK_MS`，默认 `15000`）/ 连接断了 → `{ok:false, reason:"no-ack", text:"页面没有回应这次打开（可能刚关掉会话或在处理别的操作）。"}`；
- 一条页面都没在看 → `{ok:false, reason:"no-page", ...}`（文案不变）。

同一条 ws 关闭时，把它名下没结算的 `reqId` 一并结算成 `no-ack` 并 `clearTimeout`（否则请求挂到超时、map 泄漏）。前端配合两处：`openPreview()` 改成 `Promise<boolean>`（`leaveEditor` 被拒返回 `false`），收帧时把返回值当回执发回去；`closeCurrentSession()` 在把 `currentId` 置空之前发 `{type:"unsubscribe", sessionId}`，桥的 `case "unsubscribe"` 只清这一条连接自己的 `watching`（同会话的其它页签照旧在看）。

**为什么：**

1. **「投出去了」不等于「打开了」。** 旧实现只要有一页 `watching === sid` 就回成功，而页面其实可能已经把会话关掉（`closeCurrentSession()` 只清前端的 `currentId`，从没告诉桥）、可能正在处理别的操作、可能因为未保存改动把这次打开拒了。模型拿到 `ok:true` 就会接着讲「已经帮你打开了」——用户屏幕上什么都没有。这正是 #224 要禁的「假装打开」。让真正执行打开的那一页回一句，桥才有一个诚实的答案。
2. **`stale` 与 `no-ack` 必须分开。** 多标签页时每条页面都收到同一帧，没看这个会话的页签（旧标签页、刚切走的页签）如果也回一句 `ok:false`，先到的那句就会把真正接住那页的成功盖掉 —— 所以它回 `stale`，语义是「这句不算数，继续等」。而「有页面在看却始终没人回」是另一回事（页面卡住 / 正在关会话），这时既不能说成功，也不该说 `no-page`（会误导模型让用户「先打开会话」，可用户明明开着），于是单列 `no-ack` 并给一句人话。
3. **超时默认 15 秒，可调。** 正常回执是毫秒级（打开 viewer 是本地操作），慢的是「页面刚连上、会话还在加载」。15 秒足够覆盖一次真实的加载，又不至于让工具调用挂到模型自己超时。`PI_WEB_PREVIEW_ACK_MS` 是给测试用的（`bridge/tests/preview-tool.mjs` 里设 80ms，测「不回执 → no-ack」不必真等 15 秒），也是给慢机器/远程访问留的旋钮。

**代价 / 可改：**

- **`open_preview` 现在至少多一个往返**（浏览器 → 桥）。本地回环可以忽略；但它把「工具调用」和「浏览器还活着」绑在了一起：页面崩溃/挂起时工具会等满窗口再回 `no-ack`（这也是它比旧的「立即 ok」慢的原因，故意的）。嫌慢可以调小 `PI_WEB_PREVIEW_ACK_MS`。
- **回执只认「同一条 ws 的同一个 `reqId`」**：页面刷新后旧请求不会误结算（那条连接已经关了，`pendingPreview` 里那格被结算成 `no-ack`）。
- **`stale` 依赖前端判断**：前端只比 `msg.sessionId !== this.currentId`，不看 `viewer` 是否已经显示了同一个文件 —— 「已经开着这个文件」现在仍会重开一次（幂等，只是白跑一趟）。要省这一趟可以让前端在 `v.info.abs === path && v.pane === "preview"` 时直接回 `ok:true`。
- **`declined` 的文案是两个作者**：桥给兜底句（页面没带 `text` 时），扩展那层只补一句指令（「等他处理完未保存的改动再打开」）。要真正单一来源，得让页面把整句话传上来。
- **`no-ack` 的 15 秒是猜的**：没有实测数据支撑，若用户报「打开要等很久」，先看这一项。

**验证：** `npm run test:bgruns` 新增「前台派活（D187）」段：`args` 形状抄真实调用 → 立卡即有 `agent: researcher` / 任务两行编号 / `view().n === 1`、`hasLog` 先 false；两个孩子 `status.json`（带 `parentWorkflowRunId`）落盘后 `prune()` → `hasLog` true、时间线含 `task-1 researcher started` / `task-1 researcher complete` / `task-2 researcher started`、不出负号；`noteToolEnd(…, callId)` → `done`、`readLog().out` 是 `## task-1 · researcher` / `## task-2 · researcher` 两段（`hasOut` 只是给类型契约的，前端按 `out` 的长度决定画不画）；**单跑、`action:"status"`、缺省 `async`、`async:true` 都不立卡**（后两条就是双卡的回归）；脚本式前台（`{workflow:true, async:false}`）派活那刻 `task` 为空，孩子落盘后 `prune()` 从 `sessionName` 补回 `planner` / `拆一下这个需求再分下去`。另跑 `npm --prefix bridge run typecheck` 与 `npm --prefix web run typecheck`（含 `i18n-check: ok — 1658 keys × 3 langs`），以及 `npm run test:continue:ui`（弹层标题断言从「后台子代理」改成「子代理」）。

## D193 分支 chip 的单击从「复制」变成「看历史」：两列提交、顶上一条领先/落后，fetch 只能手按

**问题：** 聊天下方那颗分支 chip（web/src/app.ts:2674 的 `gitChip`）点一下只把分支名塞进剪贴板 —— 想看清「我在 `feat/x` 上、比 `origin/main` 多 4 条少 8 条、从哪分叉的」得回终端敲三条 git。这次要的是一扇只读的弹窗：左列当前分支的线性历史，右列一条对照分支的历史，顶上横向一条说明谁在哪、领先多少、落后多少、从哪个提交分叉。

**决定：**

1. **弹窗中心化，复用 `.sheet-back`**：新文件 `web/src/branchsheet.ts` 自带 DOM，`mount(#app)` 之后在捕获阶段注册 Esc，点遮罩关；同时只允许一扇（`app.branchSheet`），再点 chip 等于关。复制没有消失，搬进弹窗工具条 —— 单击只做一件事。
2. **两列是两段 `git log`，不是一列砍开**：左 = `log -n N HEAD`，右 = `log -n N <base>`，每行的 `set` 由桥端判（`left`/`right`/`common`）。页面只认这个标签去淡显和描边，不自己比对哈希 —— 两边各算一套必然漂（同一行在一列算独有、另一列算公共）。
3. **自己判独有/公共，不信 `--left-right` 的位置**：`rev-list -n N HEAD ^base` 与 `base ^HEAD` 各拿一份集合做成员表；`rev-list --left-right --count HEAD...<base>` 只负责两个数字。N 就是这一页的行数（10..300，默认 80），所以集合与列表同深，不会出现「行在列表里却没有标签」。
4. **默认对照分支 = `origin/HEAD`**：`symbolic-ref refs/remotes/origin/HEAD` → `origin/main` → 第一个远程分支，三级兜底；`baseAuto` 记下是不是自己猜的，下拉换一个就变 false。当前分支自己当对照（ahead=behind=0）不报错，比例条收成一条安静的底色线。
5. **不自动 fetch，给一颗按钮**：打开只用本地 remote-tracking ref（八个 git 进程、毫秒级）。fetch 是唯一出网的调用，单列 `/api/git/fetch`：POST、45 秒超时、`GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` + `credential.interactive=never` 三件套（缺一件，缺凭据的仓库会挂在等密码，而桥在等它退出）。底部那行「数据来自 12 分钟前」读的是 `.git/FETCH_HEAD` 的 mtime，读不到就明说「不知道」。
> **D240 修订（2026-11-13）：** 这条里「拒绝公网（`fetch_public` 403）」已作废 —— fetch 与其余分支管理接口一样，登录后的公网 / 局域网访客都能发起。超时与三件套不变。
6. **只读**：不 checkout、不 merge、不 pull。连对照分支都只读 ref。
7. **窄屏单列**：<720px 把两列压成一列，顶上多两颗 tab「当前 · x」/「对照 · y」，靠 `.branch-cols[data-show]` 互斥。
8. **底部分页而不是全量**：一页 80 条，到底给「再加载 80 条」；`more` 由 `rev-list --count` 与当前行数比出来（不是「恰好 80 条就当还有」）。

**代价 / 可改：**

- **每个会话切回都要重新读一遍**：弹窗是快照（标题带仓库路径、底部带数据时间），期间切分支不会自己刷。桥端有 5 秒 TTL 缓存，同参数连开两下不会真跑 git。
- **没有 diff**：知道差多少条，但看不到差了什么。要看得点进提交 —— 那是下一步的事。
- **只列 `refs/remotes`**：本地分支不能当对照（下拉里只有远程）。想对照本地 `main` 得先推上去，或者把 `for-each-ref refs/heads` 也拼进来。
- **`for-each-ref --format` 不认 `%x1f`**：那是 pretty format 的写法，会原样吐出来；分支名不许有空格，所以用空格分隔。踩过。
- **`--graph` 没有画**：样张 C（真实 lane 图）用户没选，选的是 A（计数胶囊 + 线性两列）。要换回图线，桥端得再跑一趟 `git log --graph` 并把前缀原样带上 —— 样张里那套逐字渲染的代码还在 `.scratch/git-history-dialog/prototype/c-lanes.html`。

**补（review 后）：** ① 界面文案不许走 ASCII 键 —— `Fetch origin` / `remote` / `detached` 换成「拉取最新」「远程」「游离 HEAD」（`HEAD`、`merge` 是 git 概念本身，留裸串，`i18n-check` 也只认含中文的键）。② 下拉首项是「自动 · 跟随 origin/HEAD」：选项值为空串，桥端重新走三级兜底，`baseAuto` 时前端也把 `this.base` 留空，否则换回一次就再也回不到自动。③ 分页对齐桥端的 300 封顶：到了把按钮换成一句「只显示最近 300 条」，不再给一颗点了不动的按钮。④ 换对照分支失败时留着上一份数据与下拉（失败态只占领列区），否则 `base_unknown` 时只剩关窗重开。⑤ `npm run test:githist:ui` 从「只 log」改真断言（胶囊/两列/公共行/下拉首项/数据时间格式/复制按钮/300 封顶/窄屏 2 tab 1 列），失败退出码 1。

**验证：** `npm run test:githist`（新）—— 现搭裸库当 origin，断言分类（左 2 独有 + 3 公共、右侧 3 条 common）、ahead/behind、分叉点、`n` 下限 10、分页 `more`、`gitFetch` 之后 behind 从 0 变 1 且分叉点不动、空仓库 `empty`、非仓库 `null`、坏对照分支 `base_unknown`、detached HEAD 能读。另跑 `npm --prefix bridge run typecheck` 与 `npm --prefix web run typecheck`（含 `i18n-check: ok — 1680 keys × 3 langs`）。
## D194 「⚡ 总结本轮错误」并进 composer 上方那条，不再浮在它头顶（#234）

**决定：** `.fail-cta` 的宿主不再写死 `.row`。

- 每次 `renderChat`、以及那些条出现/消失之后跑一次 `placeFailCta()`（`web/src/app.ts`）：取 `.composer` 里 `.row` 之**前**、仍在参与排布的最后一块（`position` 不是 `absolute` / `fixed`，`getBoundingClientRect().height` 非 0），交给纯函数 `ctaHost()`（`web/src/failures.ts`）判三种形态 —— `rail`（接管条 / 后台运行条 / 队列条：⚡ 作为那条里的一员，`margin-left: auto` 挤到右边）、`card`（提问卡 / 扩展组件：自成一脚）、`float`（上方什么都没，或那块没登记：照旧 `absolute` 浮在 `.row` 右上）。按钮藏着时直接不挂（不占条里的位）。
- 宿主条尾如果是 `<button>`（接管会话 / 决定是否信任 / 停止后台），⚡ 插在它**前面** —— 条的主动作留在最右。
- 条自己的版式由 CSS 判：`.takeover:has(> .fail-cta:not([hidden]))` 才 `flex-wrap: wrap` + 给文字列 `min-width`（否则 `flex: 1` 的 basis 0 会把文字压到 0，永远轮不到换行）；⚡ 加 `inline`（去掉定位、阴影与入场动画），卡片里再加 `stacked`。
- 小卡（`.fail-menu`）改成按 ⚡ 实测位置定位：`bottom = offsetParent.bottom - ⚡.top + 8`，不再用 `calc(100% + 46px)`；`max-height` 也按上方空地算，长菜单自己滚，顶不出视口。

**为什么：**

1. **叠层的绝对定位没法可靠避让。** 压它的那些条高度各异、字多了还会换行；量高度往上让会让整个 composer 每轮结束跳一次版，挤窄让位会把按钮挤成半截。条本身是 flex 行，pill 作为行内一员天然跟着排布走，代价只剩「哪条在就进哪条」这一层判断。
2. **判断放在纯函数里，因为宿主表会变。** 以后再加条，只要往 `CTA_HOSTS` 添一行，取舍规则（取最后一块、跳过浮层与隐藏的）不用重写，也才能用不启浏览器的单测把它钉住。
3. **主按钮留在最右是那条的既有版式。** 接管会话是那一行的主动作；按 DOM 末尾挂上去会把主按钮顶到内侧 —— 用户报的那半颗按钮就是从右边被盖起的，别用同样的顺序再犯一遍。
4. **小卡定位跟着 ⚡ 实测走。** ⚡ 现在可能在条里、在卡片里、或浮着，`calc(100% + 46px)` 在这三种位置里只有一种是对的；`offsetParent` 才是真正的定位包含块（`.row` 有 `position: relative` 也未必接得住它最近的定位祖先）。

**代价 / 可改：**

- **宿主表是硬编码名单**（`CTA_HOSTS`）。新加一条 composer 条却忘了登记，⚡ 会退回浮层、又开始压人；`ctaHost()` 的兜底是 `float`（旧行为）而不是「随便猜一块」—— 宁愿旧样子也别乱塞。
- **审批卡不登记**（`.approval-slot` 虽然也是卡片）：它插在 `.row` **之后**（`renderApprovals()` 用 `insertBefore(slot, hint)`），压根不在扫描范围里，也不会和按钮抢右端 —— 登记它只是死条目。
- **窄屏更挤。** 文字列有 `min-width: 200px`，340px 左右条会换行，composer 高一两行；嫌高可以把 ⚡ 缩成只有图标和数字。
- **「插在按钮前面」是按「最后一个元素是 `<button>`」判的。** 将来某条尾巴是 `<a>` 或包了一层的按钮，⚡ 会落到它后面；要更稳就给主动作加 `data-primary` 之类的显式标记。
- **`card` 里的右对齐靠 `margin-left: auto`**：扩展组件若自己就是 `display: grid`，这个 auto 边距未必靠得过去（会左对齐），不重叠但不好看。
- **`renderAsks()` / `fillExt()` 里各多一次 `placeFailCta()`**：是防御，不是必须 —— 提问卡与扩展块只在轮次里出现，那时 ⚡ 本来就不亮；但 `remove()` / `replaceChildren()` 会连孩子一起删，按钮会悬在已卸掉的节点上。

**验证：** `npm run test:failures`（38 项，其中 8 项是 `ctaHost`：空 / 接管条 / 多块取最后 / absolute 跳过 / hidden 跳过 / 未登记→float / 卡片 / 多类名，另含「审批卡不认」）；`npm run test:failcta:ui`（13 项，丢弃式桥 + 真 Chromium：无条时是 `absolute` 浮层、让回终端后 ⚡ 进接管条且与「接管会话」矩形不相交、420px 并排不重叠、340px 换行到文字下一行、点开的小卡贴在 ⚡ 上方 8px 且不出视口、轮次进行中按钮不亮）；`node bridge/tests/failures-ui.mjs` 44/44；`npm --prefix web run typecheck`（i18n 1736 键不变，本次没加界面文案）。

## D195 设置页两本账：pi 的更新日志照旧，本项目的读检出根 `CHANGELOG.md`（无票，用户要求）

**问题：** 设置里那个「更新日志」tab 一直读的是**装机里 pi 包**的 `CHANGELOG.md`（`changelog(pi.cli)`），页面上没有一处是「这个网页客户端自己改了什么」。想知道本项目的进展只能翻 459 条 commit 或 158 条 D；而人手写日志的代价，正是这个仓库一直没写日志的原因。

**决定：**

1. 日志走检出根的 **`CHANGELOG.md`** 一个文件，按**日期分批**，批内分「新增 / 修复 / 设计决定」三组，每条一句、结尾带 `#PR` 或 `D编号`。不伪造 semver、不打 tag、不建 release。
2. 桥新增 `GET /api/changelog?scope=self`（`bridge/src/whatsnew.ts` 的 `selfChangelog()`），读 `<检出根>/CHANGELOG.md`，附带根 `package.json` 的 version、当前分支与短 SHA，以及检出根的绝对路径（正文里的 `docs/DECISIONS.md` 这类相对链接按它解析，与会话 cwd 无关）；不带 `scope` 的老请求原样返回 pi 的那份，`/changelog` 的语义一点没动。
3. 设置页新开 tab「本项目更新日志」，键盘命令 `/whatsnew` 直达；旧 tab 在中文里更名「pi 更新日志」。两个 tab 并排而不是二选一：一个是「pi 这个程序的版本说明」，一个是「我们这层的版本说明」，混在一页两边都失真。面板标题也跟着 tab 走（`pi 设置` / `pi 更新日志` / `本项目更新日志`）。
4. **日志由 AI 写、人来扫一眼**：会话里说一句「写更新日志」，agent 读 `git log --first-parent` 与 `docs/DECISIONS.md`，把新批次插到最上面，走 worktree + PR。文件开头（说明段之后）留两行注释：`<!-- 写到 <SHA> · <日期> -->` 与「从哪些 sha 往后读」；下一批读的是 **`origin/main` 上那份**（D196），不是工作区里的。
5. 渲染前抹掉 HTML 注释（那是人机锚点，`renderMarkdown` 不认）；截断按**字节**（默认 200 KB），超长保留最新批次、尾巴写「更早的批次略」；文件缺失返回空串，前端显示「这个检出里还没有 CHANGELOG.md」，不是 500。

**为什么：**

- **读文件而不是 build 时内联**：桥读自己所在的那份 checkout，换目录起桥就等于换日志，不需要为了改一行日志重新构建、重启服务。`bridge/src/*.ts` 直跑与 `bridge/dist/*.js` 构建后都落在 `<检出>/bridge/`，往上两层是同一个根。
- **`scope` 参数而不是新端点**：两个日志的请求形状相同（`{version, text}`），前端只换 url；旧页面（以及任何绕过 UI 的脚本）不会因为新端点出现而改变行为。
- **不生成 semver**：这个项目没有版本节奏，硬编 `v0.2.0` 只会逼着下次改号。日期 + 主题足够回答「那条改动是什么时候来的」，PR 号负责追到底。
- **AI 写日志不是噱头**：日志的价值在「结果可读」，而结果就在 commit 与 D 条目里。人写要花一小时，AI 写要一次 PR 审读，而且它天然照着已有段落的语气续写 —— 第一版 8 批 55 条就是子代理读 git log + DECISIONS 产出的。

**代价 / 可改：**

- **日志只记到合并为止**：分支上没合的工作不写（只看 `--first-parent`），页面上说「已经有了」却还在 PR 里会骗人。
- **`#编号` 不可点**：页面上是纯文本（`/changelog` 那份也不带链接），要点得复制到 GitHub。
- **桥必须跑在自己的检出里**：从 npm 安装的桥没有 `CHANGELOG.md`，tab 会一直是「还没有」。目前桥只在检出里跑（`npm start`），等真发 npm 包时再决定随包带一份还是让 `scope=self` 返回空。
- **`git` 子进程**：分支名与短 SHA 靠 `git rev-parse --short HEAD` 与 `git branch --show-current`（两条命令分开跑 —— `--short` 与 `--abbrev-ref` 同条会 `fatal: Needed a single revision`），失败留空串；5 秒缓存，连点 tab 不刷进程。
- **版本号只有一个 0.1.0**：顶部那行显示的是根 `package.json` 的 version，它不随批次变。要真的改版本就得先有发版流程，这是另一件事。

**验证：** `npm run test:whatsnew`（`bridge/tests/whatsnew-unit.mjs`：版本取根 `package.json`、正文有日期批与 `#PR` / `D` 锚点、HTML 注释不泄漏、120 字节截断带省略尾巴且不出替换符、短 SHA 非空、`root` 指向检出根（detached 时分支本就是空串，只断言类型））；`npm run test:whatsnew:ui`（Playwright + `locale:"zh-CN"` + 7887 上的丢弃式 bridge：两个 tab 并存、本项目页有 `#228`/`#229` 与「当前版本 0.1.0」、pi 页不含我们的批次、面板标题随 tab 变、`/whatsnew` 直达且激活该 tab、点开正文里的 `docs/DECISIONS.md` 后预览里读到的确实是该文件正文（不只看路径））；`npm --prefix bridge run typecheck` + `npm --prefix web run typecheck`（`i18n-check: ok — 1740 keys × 3 langs`）；`npm run build`；另用 `curl '/api/changelog?scope=self'` 核对返回 `{version:"0.1.0", branch, commit, text}`，不带 `scope` 仍是 pi 的 1.5.0 那份。

## D196 补日志做成一条命令：`/whatsnew-write` + 项目技能（D195 的下一步）

**问题：** D195 定了「AI 写、人扫眼」，但触发方式还是「在会话里说一句『写更新日志』」。锚点在哪、worktree 开在哪、分支怎么命名、PR 怎么写 —— 每次都靠现场发挥，写出来的批次语气与粒度会飘；也想不起要补的时候，日志就停在那儿。

**决定：**

1. **项目技能** `.pi/skills/whatsnew-write/`：`SKILL.md` 是流程（定位主检出 → fetch → 读锚点 → 列新合并与新 D → 写一批 → worktree 提交 → PR → 停下等合并），`references/writing-rules.md` 是条目怎么写（读者、三组、什么不写、字数、好/坏例子、术语表），`references/commands.md` 是命令与故障处置。带 `disable-model-invocation: true` —— 模型不会自己挑它干活。
2. **命令** `.pi/prompts/whatsnew-write.md`（提示词模板，`argument-hint` 收补充要求）。模板只做两件事：指向 `SKILL.md` 并交代边界（只改 `CHANGELOG.md`、没有新提交就别开 PR、开完 PR 停），流程细节不复制第二份。
3. **锚点读 `origin/main` 上的那份**（不是工作区里的），所以别人刚补过、或本地的日志还没合，都不会重写同一段；`git -C "$ROOT" log --first-parent <锚点>..origin/main` 天然只看已合进 main 的。主检出脏不影响 `worktree add`，新分支从 `docs/changelog-<时间戳>` 起。

**为什么：**

- **触发必须是显式的**：写不写取决于「这批有没有值得告诉用户的变化」。全自动就退化成 commit 复读机，而 D195 的前提是「AI 写、人扫眼」，不是「无人值守」。
- **流程写成文件而不是每次口述**：批次粒度、PR 四段式、账号与代理、失败怎么办，都有据可查；下次是另一个会话（或另一个 agent）来做也一样。
- **两个入口分工清楚**：`/whatsnew` 看，`/whatsnew-write` 写。

**代价 / 可改：**

- **只对本仓库里跑的 pi 可见**：项目级技能与模板，换目录就没了（和 `pi-web-client-test-dev` 同样的边界）。
- **模板是纯文本展开**，机器不替它保证顺序；写错了靠 PR 审读与 `references/` 里的自查清单兜。
- **`skill:` 那份也还在**（`/skill:whatsnew-write`）：两个入口做同一件事，`/` 菜单里会并排出现；名字前缀和查看用的 `/whatsnew` 撞，靠「-write」区分，真觉得绕可以改名（模板文件名就是命令名）。
- **依赖锚点真实存在**：`CHANGELOG.md` 开头那两行注释被删的话，命令会停下问人，不会自己挑 SHA。

**验证：** 模板展开实测：临时模板 `/zz-argcheck 甲 乙` 在会话记录（`~/.pi/agent/sessions/….jsonl`）里落成 `ARG=[甲 乙] ONE=[甲] TWO=[乙]`，即 `$@` / `$1` / `${2:-默认}` 都按文档展开。在测试实例（17876，本项目 worktree）里新建会话后发 `{"type":"commands"}`，返回的 146 条里有 `whatsnew-write [prompt]` 与 `skill:whatsnew-write [skill]`；只读那几步按文档原样跑通：`--git-common-dir` 反推出 `ROOT=F:/pi-web-client`（从 worktree 里调也一样）、锚点从 `origin/main:CHANGELOG.md` 取到失败时为空串（当前 main 还没有这个文件，属预期）、`10f96a0..origin/main` 数出 2 个合并（#227 / #232）；`git log --first-parent --format='%s' … | grep -oE '#[0-9]+'` 拿到 PR 号。

## D197 关隧道：回包先走、再杀 cloudflared；hello 的隧道快照只许往新了盖（#236）

**问题（用户报「关闭公网隧道点击不生效，没反应」）：** 从公网页面（quick tunnel 地址）点「关掉公网隧道」时，桥端先 `tunnel.stop()` 杀 cloudflared，再写响应 —— 回包要穿回的那条隧道此刻已经死了，浏览器拿到的是 Cloudflare 的 502 HTML，`api.tunnel()` 抛错；而按钮的 `.catch(() => null)` 把错误吞了、标签照旧，于是「点了没反应」。本机（127.0.0.1）点同一颗按钮一切正常，只有公网页面才会踩到，所以一直没被发现。

**第二个坑（同一个症状的另一半）：** `web/src/app.ts` 的 `case "hello"` 是 `this.tunnel = msg.tunnel ?? this.tunnel`。hello 带的是**连上那一刻**的隧道快照，公网页面 socket 频繁重连，一个早于关闭动作算出的快照会在回包之后到达，把 `off` 盖回 `up`、`renderAll()` 再把按钮翻成「关掉公网隧道」—— 桥已经关了，界面说还开着。

**决定：**

1. **stop 分支先走 `json()` 把 off 回出去，再排一个独立的 `setTimeout(TUNNEL_STOP_GRACE_MS = 400)` 去 `tunnel.stop()`**（`bridge/src/index.ts` 的 `/api/tunnel`）。state 由路由现造：`{ ...tunnel.state, status: "off", url: null, error: null, updatedAt: Date.now() }`，不回读 `tunnel.state`。start 分支照旧先动作再回包（它不拆任何东西）。
2. **定时器不挂在 `res.end` 的回调上**：回调只在数据真的写出去之后才触发，而「socket 已经断了」正是公网页面最常见的现场 —— 挂在那儿，最坏情况是界面翻成 off、cloudflared 还在跑，症状一模一样但更隐蔽。（这条是 review 抓出来的第一版实现错误。）
3. **grace 是经验值，不是同步点**：`json()` 只保证数据交给内核，cloudflared 还得把它转给 Cloudflare 边缘。400 ms 在本机实测够用（curl 走公网 URL 能拿到完整 200 + `{"status":"off"}`）；真要更保险得让 cloudflared 优雅退出，而 quick tunnel 没有这个接口。
4. **hello 的隧道快照加门槛**，收进 `web/src/tunnel-snapshot.ts` 的 `newerTunnel()`：`next && next.updatedAt >= prev.updatedAt ? next : prev`。`updatedAt` 是桥端 `Tunnel.setState()` 盖的时间戳，off 快照用路由那一刻的 `Date.now()`，必然 ≥ 任何更早算出的 hello —— 同一个钟，单调比较就够了。抽成模块是为了能在 Node 里单测（`app.ts` 整个类进不了单测环境）。
5. **失败必须说话**：去掉 `.catch(() => null)`，`catch` 里 `flashToast`。公网页面（`me.public`）且动作是 stop 时提示「没收到回包：隧道可能已经关了，这个页面也就断了」（这时候八成真的关了，含糊的报错反而误导），其余给「隧道操作失败：<原因>」。按钮在请求期间 `disabled`，防连点。
6. **`start()` 也不再装死**：进程还活着但状态停在 `error`（`waitReady` 60 秒超时会留下活进程）时，旧逻辑 `if (this.child) return` 让「开」也点不动；改成换一条新进程。`child.on("exit")` 加 `if (this.child !== child) return` —— 被换掉的旧进程退出不许覆盖新进程的状态。

**为什么：** 症状是「点了没反应」，但它有两层：回包出不去（用户什么也看不到），和状态被旧快照盖回来（用户看到了，只是看到了错的东西）。只修一层都还是「不生效」，所以回包顺序、失败提示、快照门槛三件事一起做。代价是关隧道晚了 400 ms —— 换来的是「点了有回话，而不是猜」。

**代价 / 可改：**

- 关隧道后 400 ms 内再点「开」会和新进程抢同一份 state；按钮 `disabled` 只在单页面内挡得住。
- 公网页面的 stop 一旦回包真的丢了，界面无法确认桥侧状态，只能给一句「可能已经关了」；下次 hello 会纠正（第 4 条保证不会往旧了盖）。
- **`start()` 的换进程与 exit 守卫没有自动化用例**：要真跑子进程得能 spawn 一个假 cloudflared，Windows 上 `.cmd` 垫片 `spawn` 不了（EINVAL），`Tunnel` 又只吃一个 bin 路径。这条靠手工验（「开」在 error 状态下能把进程换掉），比没测好，但不是测住。

**验证：** `npm run test:tunnel`（协议/参数/框线解析 + `web/tests/tunnel-snapshot-unit.mjs`：旧的 hello 盖不回 off、同毫秒收、更新的照收、没带 tunnel 保持原引用）；新增 `npm run test:tunnel:ui`（`bridge/tests/tunnel-ui.mjs`，自带丢弃式 bridge + Playwright 拦 `/api/tunnel` 造成功/500/回包丢失三种回包，断言 toast 与标签：失败不谎报、成功翻成「关掉公网隧道」并显示地址、回包丢了也要说出来）。真隧道对照：curl 走公网 URL 发 `POST /api/tunnel {"action":"stop"}` 拿到完整 200 + `{"tunnel":{"status":"off"...}}`；Playwright 公网页面连跑两轮点击，标签都在 1 秒内翻回「开公网隧道」。另跑 `npm --prefix bridge run typecheck` 与 `npm --prefix web run typecheck`（含 `i18n-check: ok — 1764 keys × 3 langs`）。

## D189 提问答在「需要你」右栏：到货自己开栏、加宽到能读，答完还回去（#230）

**问题：** 面板原来长在 composer 的 grid 行里（`web/src/styles.css:601`，`grid-template-rows: 1fr auto`），题目一到就把会话挤小；更糟的是 `web/src/chat.ts:300-304` 的 ResizeObserver（观察 `this.root`，不是 composer） 在看到 following 时 `scheduleScroll()` 重新贴底，最后一条回复正好被顶出视口上沿。用户的实际操作是「先收起表单，再上滑读回复」，每问一次做一遍。用户提的替代方案是「滚轮上滑自动收起、读到底自动展开」（样张 E）。

**决定：**

1. **宽屏答在右栏**（改掉 D47 的 UI 一段：底部抽屉 → composer 面板 → 宽屏右栏；D47 的通道与「无超时」不动）：`!compact()`（有效宽度 ≥ 900，`app.ts:870` 的 `compact()`）且右栏没被收起时，题目渲染进「需要你」那一栏（`renderQueue()` 里用同一个 `askPanel()`），composer 只留输入框。窄屏（tab 制）与手动收起右栏时回落到原形态：composer 上方的整块面板，仍带「收起 / 展开」。
2. **到货自己开栏**：收着的右栏在提问到达时自动展开一次（`askAutoOpened`），宽度取 `clamp(340, 30% × 布局宽, 420)`（1280 下实测 384px）。答完把宽度与收起状态还回去；用户中途自己收起的这一份不再抢（`askDockMuted`），题目当场回落到 composer。
3. **两条作答路都通**：右栏里点选项；或者在输入框里直接打字（`answerFromComposer` 不变，占位文案换成「或点右栏的选项」）。
4. **右栏只画第一份**：多份待答时，面板只渲染 `asks[0]`，其余显示「还有 N 份等着，答完这份再来。」—— 一栏里叠三个表单没人读得下去。
5. **改列宽时先钉住会话顶端**：`overflow-anchor: none`（D188）之下浏览器不会自己补，`chat.pinTop()` 在改宽前后按节点差值补 `scrollTop`（跟流时交给 ResizeObserver 重新贴底），否则你正在读的那段会整块上移。
6. **不写 localStorage**：加宽只是这一次的临时值（`--queue-w` inline）；用户拖过右栏就以拖动结果为准（答完不覆盖），`pi.queueW` 只在拖动结束时写。

**为什么当时不上样张 E（滚轮收起 / 到底展开）：**（收起态后来按 D190 做了，见下）

- **点击没变少**：原来是「收起 → 上滑」，E 是「上滑 → 要答时展开」。省的是收起那一下，换来面板在阅读时自己动。
- **目标会跑**：读到一半想顺手点选项，面板已经收起，得先滚回底；「回到底自动展开」又会在你刚要读底部时再改一次版面。
- **触屏没有滚轮**：只能靠 6px 拖动阈值判（D68），翻长回复时手指一停一停就反复收/展。
- **到货那一下没解决**：进来第一眼仍然是回复被顶走 + 一块大表单。

**为什么不上别的：**

- **A（预算 + 锚定）**：保留整块面板，只封顶 38% 并把回复末尾锚在面板上沿。改动最小，面板仍吃 300px 上下；现在它是「收起右栏 / 窄屏」时的形态，不是主路径。
- **B（一屏两行）**：默认两行、点 chip 即答，代价是选项说明默认折起。它是窄屏的下一步（现在窄屏仍是整块面板），这次没做。
- **C（行内作答）**：答题区就是会话里的卡，最新消息会把卡推走，得靠 composer 一行兜底入口。

**代价 / 可改：**

- **到货那一下会话窄 84px**（300 → 384），长回复会重排一次；这是「加宽到能读」的代价，`340/420/0.3` 三个数都能调。
- **右栏变高**：题目 + 下面「通道 / 快捷键 / 关于」共用一个滚动条，第一屏基本只剩题目。想更干净可以让提问期间把那三节收起来，这次没做。
- **窄屏还是整块面板**：B 的 peek 没做；手机上仍然占 444px（样张实测）。
- **临时宽度与拖动**：中途拖动会以用户的新宽度为准并写进 `pi.queueW`，下次提问按这个新默认再算。

**验证：** `npm run test:ask:ui`（`bridge/tests/ask-ui.mjs`，真 Chromium + 真桥 + 真模型，28 条）：面板在 `.queue` 里而不在 composer、`--queue-w` 加宽到 ≥340、窗口缩到 1100 时重算成 340、拖到 600 的栏不被压窄、收起右栏后提问自己把栏打开（评审 P1：同一趟就把宽度写成 340+，不是先露 300）、答完还回收起、390px 手机上仍在 composer（且右栏里没有面板）、取消 / 自由文本 / 中断清理照旧。

## D190 折叠态的提问收成一行：上滑收起、回到底部展开（#230）

**问题：** D189 只覆盖了「右栏开着」的一条路。右栏被收起、或者窄屏（tab 制）时，题目回落到 composer 上方那块整面板 —— 1280 下 259px，手机上 444px（占 pane 69%）。用户此时读回复仍要先找「收起」，而收起后留下的是一行标题 + 两枚按钮，答案区整个消失，想答题还得再点一次「展开」。用户提的规则是：**上滑自动收起、读到底自动展开**。

**决定：**

1. **折叠态就是一行**：`.ask-strip` —— 「提问」+ 题干首行（单行省略）+「回答」+「取消提问」，实测 34px。手动按「收起」与自动收起落进同一个状态，不再有「只留 head、答案区没了」的中间态。
2. **上滑收、到底展**：`ChatView` 新增两个回调 `onScrollUp`（`stopFollowing()` 里触发）与 `onSettleBottom`（`resumeFollowing()` 与 `follow()` 里触发）。上滑读历史 → 面板收成一行；**往下滚回底部** → 展开。往上滚回底部不算 —— 这是 `resumeFollowing` 原有的 `movingDown` 条件（D94），顺带解决了「收起后 `scrollTop` 被 clamp 回底部、立刻又展开」的闪回。
3. **只撤回自己做过的事**：自动收起的（`askAutoFolded`）到底会自动展开；用户自己按「收起」的不再被抢回来，要展开点「回答」。
4. **到货仍然整块展开**：`ask.add` 把两个折叠标志都清掉 —— 弹出来就是要你答，先给全。
5. **收起不动草稿**：`askDrafts` 与输入框里的字都在，展开回来原样。

**为什么只放在折叠态（而不是 D189 否掉的全局 E）：**

- 右栏开着时答题区本来就在旁边，没有任何东西挡着回复，自动收/展只会让面板无端闪。
- 折叠态才是「面板和回复抢同一块高度」的那条路：收起来是为了读，读到底再答题，顺序天然对应。

**代价 / 可改：**

- **一格就收**：一格滚轮（或触控板 5–20px）就把面板收起来。用户当场选了「不加迟滞」，觉得过灵可以在 `holdUp()` 一侧累计 40px 再回调（`onScrollUp` 是唯一的挂点）。
- **滚动时高度会变**：收起让视口变高、展开变矮，正在读的那段会随 `scrollTop` 的 clamp 微调；`follow()` 在展开后由 ResizeObserver 重新贴底（D189 的 `pinTop()` 只管改宽）。
- **窄屏同样生效**：手机上两态一样，422px 的面板一上滑就变 34px。

**验证：** `node bridge/tests/ask-ui.mjs` 33 条：上滑把面板收成一行且 `.ask-slot` 消失、滚回底部展开、手动收起在底部不再被展开、点「回答」展开、半截草稿过一道折叠还在，外加 D189 的 28 条、到货开栏后的宽度在 340 以上、取消 / 自由文本 / 中断清理。

## D198 删除运行中的会话：先释放再删，只剩终端锁还拒绝（用户要求）

**问题：** D48 的删除闸门是「非 live、无待审批、没人持锁」三缺一就整批拒绝。用户遇到的是最常见的一种：一个正在跑的会话要删，卡片上的 🗑 是灰的，提示「运行中不能删，先停止运行」；人得先找到输入框下方的「释放会话 / 让回终端」，点完再回来删 —— 两步，而且第二次还得等列表重画。用户的判断很直接：「删除会自动释放」（m00072）。

**先摸事实（为什么这不是「放开一个护栏」，而是「用本来就有的能力」）：** 删除路径原本就会 `await session.close()`（`bridge/src/sessions.ts:2461`：abort → 等 running 落盘 ≤5s → `rpc.kill()` → 等 exit ≤2s → `releaseLock`）。也就是说旧代码对每个目标都执行了一遍关闭流程，只是在 live 会话上提前拒绝了。**唯一不能替它关的是终端里的 pi**：那不是本桥的子进程，杀不掉，也不能替它交还写者身份（`readLock()` 拿到的 pid ≠ `process.pid`）。

**决定：**

1. **桥（`Sessions.trash()`）：** 只剩终端锁还拒绝（`skipped: 终端正在使用`），且两种写者身份都算：`<id>.lock` 的 pid 不是本桥（另一个桥实例），以及 session-lock 扩展写的 `<id>.tty.json`（终端里开着，`readTtyLock()`）。live / 网页接管 / 待审批的一律先 `close({ quiet: true })` 再搬文件，关掉的 id 进新字段 `released: string[]`。
2. **有文件才进箱，且要在释放之后才判：** pi 要到第一条消息才落盘（实测：`create` 之后 19 秒，`state.file` 有路径但文件不存在），所以「刚建、还没说话」的会话没有文件可搬 —— 这种直接关掉、从列表里拿掉，不写垃圾箱行（磁盘上本来就没东西可丢，也没东西可还原）。**判断必须放在 `close()` 之后、逐个做：** `close()` 会 abort 并等在飞的那一轮落盘（≤ 5s），文件可能就在这一小段里才出现。审查时第一版算在释放之前，等于把「刚写完的会话」当空会话：移出列表却不搬文件，`cache = null` 之后下一次扫描又把它扫回来 —— 就是 D48 里那个「复活」。进箱的 id 另外放进 `binned: string[]`，页面拿它报「已移入垃圾箱 N 个」，剩下的报「另有 N 个还没有内容，已直接删除」。
3. **并行关闭：** `Promise.allSettled(held.map((s) => s.close({ quiet: true })))`。一次 close 最坏 7s（5s + 2s），批量删除不该按 7s×N 排队。关失败（rejected）的进 skipped 并保留文件，不移文件也不谎报删除。
4. **`quiet: true`：** 被删除打断的那一轮不该再弹「已停止运行，历史留在磁盘，发消息会自动接管」—— 那句是「释放会话」的台词，而这里会话马上就不在了。
5. **页面：** 删除按钮只在 `locked`（终端占用）时置灰；`App.busy()` 换成 `App.deleteBlocked()`，只判 `Boolean(s.locked)`。hover 文案分三档：终端占用 / 已武装 / 运行中（「删除（运行中：先停止这一轮再移入垃圾箱，可还原）」）。结果提示补两句：「其中 N 个已先停止」（`released`，`live` 里也包含「接管但空转」的，所以话术只说停止不说着火）、「另有 N 个还没有内容，已直接删除」（`removed` 减 `binned`）。
6. **i18n：** 删「网页正在运行/接管这个会话，先停止运行再删」与「运行中 / 网页接管中 / 待确认的会话不能删，先停止运行」两条旧文案，加四条新的（含批量删除的「终端正在占用其中 {p1} 个会话，先在终端退出再删」）。

**为什么保留终端锁这道闸：** 让终端里的 pi 继续往一个已被搬走的文件写，等于制造两个写者（D31 / D48 的同一个理由）。而「运行中」不是拒绝删除的理由，只是「这次删除多做一件事」。

**代价 / 可改：**

- 删除最坏多等 ~7s（abort 5s + exit 2s），批量时按钮转圈更久。想先回包、后台关也可以，但那样 `session.gone` 与进程真正退出之间会出现观察窗口，这次先要确定性。
- `released` 是桥新增的可选字段：旧前端忽略它，不报错。
- 终端持锁时仍然只能先去终端退出（不变）。
- 新网页 + 旧桥：按钮不再置灰，但旧桥会回 `skipped: 正在运行`（提示是真话，只是姿态不好看）。桥与网页同仓同版本发布，没做能力协商。
- 若同一 id 正被另一个桥实例接管，`close()` 会失败 → 进 skipped、文件不动；这条没有专门测试，按 `readLock` 的语义它是可达的。

**验证：** `node bridge/tests/manage-check.mjs`（D48 的探针按新语义重写）：删 live 会话 → `removed` / `binned` / `released` 都含它、`skipped` 为空、payload 进 `state/trash/`、`state/locks/<id>.lock` 消失、列表里没了；刚建的空会话 → `released` 有它、垃圾箱**没有**空行；写一个外来 pid 的锁文件（`.lock` 与 `.tty.json` 都覆盖）→ 仍然 `skipped: 终端正在使用` 且文件原地不动；混合批（idle + 终端占用）→ idle 进垃圾箱、终端占用的保留；删掉锁文件后再删 → 通过；purge 把 live / 终端占用的都真删；重启后这些 id 都不回来。两边 typecheck（`npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`，后者含 i18n-check）。

## D199 隐式触发的技能在对话里立一张卡：靠 `read …\SKILL.md` 认，理由是它读之前那句话（用户要求）

**问题：** 用户点了「技能」面板或用 `/skill:x` 发的技能，气泡上有一枚药丸（D165），能看出「这一轮用了什么」。但模型自己挑的技能 —— 提示词触发的隐式加载 —— 在界面上完全不存在：pi 没有 Skill 工具（`pi-coding-agent/dist/core/sdk.js` 内建只有 read/write/edit/bash/grep/find/ls/powershell），系统提示词里只有 `<available_skills>` 清单（`dist/core/skills.js` 的 `formatSkillsForPrompt`，一行 name + 一行 description + location），加载动作就是模型自己 `read` 那份 SKILL.md。于是对话里只多出一张普通的 `read` 工具卡，用户既不知道「它刚用了一个技能」，也不知道「这个技能是干什么的」和「为什么是它」。用户要的就是这三样：显示出来、一句话说清是干啥的、说清为啥触发。

**决定：**

1. **判定用路径匹配，零侵入。** 新增 `skillOfRead(skills, name, args, cwd?)`（`bridge/src/skills.ts`）：只有 `name === "read"` 且 `path.resolve(cwd, args.path)` 正好等于某个技能目录下的 `SKILL.md` 才算命中（`cwd` 是会话 cwd —— pi 的 read 就是按它解相对路径的）。不挂 pi 扩展、不改 pi 侧任何东西 —— 记录里本来就有这条工具调用，参数里有绝对路径。
2. **只认 `read`。** `bash cat …\SKILL.md` 不标：命令行的字符串里出现路径和「读了它」不是一回事（`grep`、`echo`、写文件都会带路径）。
3. **回放也补上。** 老会话（磁盘上的 JSONL）里没有「用了技能」这种事件，唯一的痕迹同样是那次 read。`withSkillItems(items, skills)`（`bridge/src/items.ts`）在 `entriesToItems` 之后跑一遍，把卡插在命中的 tool item 之前；`bridge/src/sessions.ts` 的 `loadFromFile()` 里接上。技能清单按 cwd 缓存 30s（`skillsHere()`），否则每次文件变化重放整卷都要扫一次盘。
4. **实时也补上，用同一个判据。** assistant 消息带 toolCall 到达时（`bridge/src/sessions.ts` 的 `item.add` 循环）先问一次 `skillItemFor(this.items, …)`，命中就先把 `skill` item 推给页面，再推 tool item。
5. **一轮一个技能一张卡。** `skillItemFor` 从画布末尾往回扫，遇到本轮最后一条 user 就停 —— 已经画过同名卡就不再画（模型常把同一份 SKILL.md 读两遍：先读主体，读完附件再读）。
6. **「为什么」只能写线索。** 记录里没有动机字段。卡上那句取**模型读之前最近说的那句**，它没说话就退回**本轮用户消息**（`whyFrom` 区分两者），压成一行、截 120 字。这句不是在调用点传进去的，而是卡要落地时从「已经画到画布上的本轮条目」回扫出来的（`turnAssistantText`）—— 实时与回放跑同一段代码，同一条消息刷新前后不会换词。所以卡片写「触发线索：它读之前说「…」」，不写「因为」—— 那是我们编的。
7. **形态（用户在三个样张里选的 A）：** 一张独立卡，名字（等宽 accent）+「自动加载」虚线徽标 + `SKILL.md` 出口（点开走 `pi-preview`）+ 一句话描述（frontmatter 的 description，两行截断，全文在 title）+ 触发线索一行。虚线徽标说的是「没人让你用它，它自己挑的」，与 `/skill:` 药丸（实线 + 用户气泡里）形成对照。卡到达时页面收掉已经开着的那一摞操作（`closeOps()`）：卡是「下面那张 read」的前言，不收的话那张 read 会落进上面那摞、画在卡前面（多步轮次里就是这个顺序）。
8. **不动计数。** `uses` / `lastUsed` 仍然只由用户真发 `/skill:<name>` 计数（`bumpSkillUsage`）。隐式触发不进「常用」排序：那是「你爱用什么」，不是「模型爱读什么」。

**为什么不做成 pi 扩展：** 扩展能在 `tool_call` 上看到参数并 `appendEntry` 一条自定义消息，但那样第二份实现要跟着 pi 的扩展 API 走（还有 `PI_WEB_*` 挂载、扩展找不到时的降级），而桥本来就要把 JSONL 重放成 items —— 在重放里认路径，实时与历史两条路自然同源。代价是 `bash cat` 那种读法标不出来（见下）。

**代价 / 可改：**

- `bash cat SKILL.md`、`sed -n … SKILL.md` 不标；要标得解析命令行，误报比漏报难收拾。
- 模型把 SKILL.md 内容贴错路径读（比如读 `skills/x/README.md`）不标 —— 只有 SKILL.md 本身才算。
- 用户自己为了看看技能写了什么而 `read` 一次，也会被标成「本轮用了这个技能」。这是「一条路径判据」的固有代价；折中是加一条「仅当该技能 description 与用户消息有交集」的猜测规则，不做（会把假阳性换成假阴性）。
- 卡占两行高度，一轮多一次；嫌吵就在 CSS 里把 `.skillcard .why` 藏掉（一句话是什么仍在）。
- 老会话回放依赖 cwd 能扫到技能目录：技能后来被删了，老会话里那张卡就不出现（宁缺，不瞎标）。
- 一轮里技能卡会把这一轮的操作拆成两摞（卡前 / 卡后）：多步轮次里模型先跑几条命令再读技能，那一轮就是「一摞 + 卡 + 一摞」，比硬塞进同一摞更诚实，但也比平时多一个折叠头。
- 用户这轮只发了张图（没有文字）、模型也没说话时，卡上没有线索那一行 —— 没话可引，不编。

**验证：** `node bridge/tests/skill-implicit.mjs`（14 项）：路径命中 / 正反斜杠 / 同目录别的文件 / `bash` 不命中 / 清单外路径 / 相对路径 + cwd / BOM 与开头空行的 frontmatter / 一轮去重 / 卡位置在 read 之前 / 下一轮重新计 / 回放退回用户消息（`whyFrom=user` 与 `id: e2:c1:skill`）/ 清单为空不插 / 实时去重 / 多步轮次里实时与回放给出同一张卡。`npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（含 i18n-check：1777 键 × 3 语）都过。

## D200 一轮的技能卡收进一个折叠组：默认一行点名，点开才是详情（用户要求）

**问题：** D199 让每次隐式触发都立一张卡。可模型在一轮里常连着读好几个技能的 SKILL.md（`/skill:grill-me` 那类会再读 `grilling`、`anatomy`），一屏里就并排好几张卡：每张都有名字、徽标、两行描述、触发线索。它们讲的是同一件事（「这轮它自己挑了这些技能」），却按张平铺，把用户自己的话和模型的回答挤开——用户报「自动加载的很多，会干扰当前会话」。

**决定：**

1. **按用户消息分轮，一轮一个组。** `ChatView.add()` 收到 `user` 时把 `skillGroup` 指针清空；此后到达的每个 `skill` 都进本轮的组。实时推送与文件回放走的是同一个 `add()`，两条路自然同源。
2. **组落在本轮第一张技能卡的位置**（用户选的 A）。第一条到达时 `push` 一个 `<details class="skillgroup">`，后面同轮的技能 `append` 进 `.skillgroup-body`——组不移动，时间顺序不乱，也不会把这轮后面的操作挤到组前面。
3. **默认折叠，一行点名。** summary = 虚线「自动加载」徽标 +「N 个技能」+ 名字（` · ` 连接）。名字多了 CSS 省略，全文挂在 `.skillgroup-names` 的 title 上。不展开时组只有一行（实测 35.5px）。
4. **单个技能也折叠。** 用户在问卷里选的：形态统一，不会出现「有时一整张卡、有时一行」的跳动。代价是单卡时描述要点开才看。
5. **展开后是原样的完整技能卡**（用户选的）：名字、徽标、`SKILL.md` 出口、两行描述、触发线索都不删。组的外壳已经是一条边框，组里那张卡去掉自己的边框和底色（`.skillgroup-body .skillcard`），不然框套框。
6. **动态刷新不重建节点。** 新技能只是 `append` 进已有的组并改写摘要，`<details>` 的 `open` 状态归浏览器，所以用户展开着的时候再来一张卡也不会把它收起来。
7. **翻页插历史要把指针收走。** `skillGroup` 进 `TurnState`：`prepend()` 先 `holdTurnState()`（顺带把它置空），插完 `releaseTurnState()` 恢复。否则「载入更早」那一页里的技能会被追加到用户正在看的这一轮的组里。
8. **折叠态必须显式 `display: none`。** 给 `.skillgroup-body` 写了 `display: grid` 之后，Chromium 收起的 `<details>` 不再替我们隐藏这块内容——探针量到 246px 的空肚子。规则 `.skillgroup:not([open]) > .skillgroup-body { display: none; }` 兜住。

**为什么用 `<details>` 而不是自绘开关：** 折叠只是一个开关，浏览器自带语义、键盘可达、`open` 属性可读；自绘就得再管一遍焦点与 aria，和 D199 那张卡一样，能少写就少写。

**代价 / 可改：**

- 组钉在第一次出现的位置：本轮后面的技能要往上找它的详情。换来的是时间顺序不乱（用户选的）；嫌麻烦可以把组改成跟最后一张卡走，但那会让组在本轮里跳位置。
- 摘要只给名字，描述要展开——用户明确要的是「一行点名」。
- 技能组仍然把这一轮的操作拆成两摞（组前 / 组后），D199 那条代价没变。
- 一轮只有一个技能时也是一行摘要，比原来多一次点击才能看到描述。

**验证：** `node probes/skill-group.mjs`（20 项，真实 Chromium + 手写会话文件）：两轮各一组 / 默认折叠 / 摘要点名 3 个技能且按到达顺序 / 徽标 / tooltip 全文 / 组里 3 张完整卡（描述、`SKILL.md` 出口、线索）/ 模型说过话用最近那句 / 没说话退回用户消息 / 第二轮另起一组 / 折叠时摘要一行高 / 展开 3 张卡 / chevron 转 90° / 收回后详情不占高度。`npm --prefix web run typecheck`（含 i18n-check：1779 键 × 3 语）与 `npm run test:skill`（14 项）都过。

## D201 点未载入的刻度自己把那一轮翻回来：索引随帧走、淡一档占位、用户一动手就停（#241 3/3）

**问题：** 刻度带（D60 / #243）已经把整段会话画成一根根刻度，没载入的淡一档占位。但那些淡刻度只是「看得见的占位」：点它什么也不发生，想回到第 1 轮还得滚到顶、一页页按「载入更早」。用户要的是「点哪儿就带我去哪儿」—— 界面自己往回要页，直到那一轮到货，再滚过去、高亮它；中途他自己动手了就停下，别把他拽走。三个决定绕不开：整段历史怎么让前端知道（正文还是索引）、没载入的怎么显示（藏还是淡）、自动翻页什么时候算被用户接管。

**决定：**

1. **整段轮次索引随帧下发，正文仍按页取。** `session` / `items` 帧的 `history.turns?: { id, text, images }[]` 是**整段会话**的轮次索引（#242），前端拿它画刻度带、算「第几轮」。正文不动：一页 30 轮约 200KB 级，而索引一帧 2–3KB（实测 120 轮 / 60 items 的 `session` 帧 17.7KB，其中索引约 2.5KB）。要正文就发 `history.before` 一页一页取。
2. **坐标一律靠 id，不靠下标。** 往前翻会把新轮次插到 `turns` 前面，任何数字下标在下一次 `prepend` 之后就失效。所以 `ChatView.turns` 带 `id`（`noteTurn` 用 `item.id`，`prepend` 的 staging 路径也带；`adopt` 把本地 id 换成服务器 id），刻度带的 ghost 段也带 id（`setGhosts({ id, label }[])`），ghost 的点击只回 id（`TurnRailOpts.onPickGhost(id)`）；已载入的刻度/行仍是原来的下标坐标（`onPick(loadedIndex)` / `setCurrent` / `onHover`），那段实现没变。
3. **淡一档占位，而不是把没载入的藏起来。** 刻度带的高度就是「这段会话有多长」；藏掉未载入的那 90 根，翻一页带子就会长一截，位置也跟着跳，用户没法靠它判断自己在哪儿、还能往回多少。淡色占位 + 从尾部吃掉（`prepend` 把等量的 ghost 换成实线）保证总高度、总根数从头到尾不变。
4. **一次跳转 = 一个 `pendingJump: { id, n }`，串行翻页。** `jumpToTurnId(id)` 先在 `turns` 里找：找到就 `jumpToTurn(index)` + `flashTurn(index, 1200)`（跟点已载入刻度同一套观感）；找不到就记下 `pendingJump`（`n` 是它在全量索引里的第几轮，失败文案要用），立刻 `loadOlder()` 走**同一条**手动翻页的路（同一颗按钮、同一个 `loadingOlder` 禁用态）。每页到了（`prepend` 末尾的 `afterOlderPage(advanced)`）先查 id 到没到：到了就收尾（清 `pendingJump` → `jumpToTurn` + 高亮），没到且 `hasMore` 就 `setTimeout(…, 0)` 排下一轮（不递归、不并发 —— 每页一次请求，`before` 游标是上一页的顶），`hasMore` 为假或空页（`advanced === false`）就失败收尾。
5. **「用户一动手就停」是取消边界。** `holdUp()`（上滚 / 键盘）、`stopFollowing()`（touch / 跳转）、点任何已载入的刻度或行、`reset()`（切会话 / 重连换了内容）都在开头清掉 `pendingJump`；已经发出的那一次请求不回退、到货的页照常插入，但**不 follow() 也不 jumpToTurn()**，滚动位置不动。用户自己点「载入更早」等于「我接管了」：清掉 pending，但这次手动翻页照常进行。
6. **反馈都在带子上，不在会话里插条目。** 载入中沿用顶部那一行（按钮 `disabled` + 「载入中…」），另给刻度带 `setBusy(true)` 挂 `.busy`，`.turn-tick.ghost` 轻脉动（`prefers-reduced-motion` 下不动）—— 「那一带在动」得在刻度带上看得见，因为用户点的就是带子。失败也写两处：正文顶部那一行 `moreNote`（3 秒后自清）优先于「载入更早」、**即使没有更早的也要显示**（`hasOlder === false` 时那一行本来是藏的），**并且同一句挂到带子顶端**（`.turn-note`，`role="status"`，3 秒后自清）—— 带子固定在右缘、不随滚动走，而顶部那一行在自动翻页期间早就在视口上方几千像素外，只写那一行等于没反馈（评审提的 P1，已补断言：提示的 bounding box 必须落在视口内）。文案 `没翻到第 {p1} 轮`（i18n 三语）。不往会话里插 notice 条目：那是记录，翻页失败是当下的一次操作结果。

**为什么「用户动手就停」：** 自动翻页是替用户跑腿，不是接管视口。翻三页要几次往返，这段时间里他可能自己滚上去了、点了别的轮次、切了会话 —— 这些都说明他改主意了。停的粒度只到「不再往前要页」：已经发出的请求照收（取消它反而让 `loadingOlder` 卡住，或者白丢一页已经付出的等待），已经取回的页留着（下次往上滚就是现成的），**唯一不许的是把他从当前位置拽走**。失败同理：到头了也没有那一轮，说明索引与正文不一致（桥那边删过/改过），再翻只会无限空转，所以停下并说清楚「没翻到第 N 轮」。

**代价 / 可改：**

- 每帧多 2–3KB：`session` / `items` 帧都带整段索引，轮次越多越大（120 轮 ≈ 2.5KB，1000 轮就 ≈ 20KB）。嫌大可以让桥按「最近 N 轮 + 更早的只给条数」裁，刻度带就得改成两段画法。
- 协议多一个可选字段：老桥不下发 `history.turns` 时前端 `history?.turns ?? []` → ghost 段为空，刻度带退回「只有已载入的、还不知道后面有多少」的旧行为，按钮和手动翻页不受影响。
- 前端多维护一段 ghost 坐标：id → 第几轮（`turnOrdinal`）、ghost 段整体替换、`prepend` 从尾部吃掉等量的 ghost。id 与正文对不上时（见失败那条）只能靠「翻到头」兜底。
- 翻页次数多时是连续请求：每页一次、串行（不并发，`before` 游标就是链条），从第 30 轮跳回第 1 轮要 3 个往返。想快就得让桥支持「按 id 直接给一页」（`history.at` 之类），这次没做。
- 跳转会把还在排队的锚点补偿作废（`anchorPinRun`）：往前插一页后的三次钉（立刻 / 下一帧 / 150ms）会把平滑滚动按回原处，所以跳转推进代数、让剩下的钉自己让路。

- 刻度受版面限制仍挨 D60 采样：`fit = floor((0.7×视口高 + 4) / 6)`（844px 约 99 根、900px 约 105 根），所以「120 轮 = 120 根刻度」只在能装下时成立；**行是全量的**（120 行）。票面那句话要当「轮次都画上了、能装下就一根不少」读。

**验证：** `node --experimental-strip-types bridge/tests/history-ui.mjs`（63 项）：G. 点最上面那根淡刻度 → 期间按钮 `disabled` + 「载入中…」、刻度带 `.busy`，正好 3 个 `history.before`，翻完定位到第 1 轮并带 `.turn-flash`、按钮收起、`.busy` 撤掉；H. 起跳后同一拍派发上滚 `wheel` → 只取回已在飞的那一页（1 个请求）、不高亮、第 1 轮仍在视口上方很远、按钮回「载入更早」；I. 假桥在 `session` 帧的 `history.turns` 前插一条正文里不存在的轮次 → 点那一**行**（行与刻度共用回调）翻到头就停（3 个请求）、顶部那行是「没翻到第 1 轮」且可见（行不隐藏、钮不可点）、**带子上那句提示的 bounding box 落在视口内**、不跳不高亮、800ms 后不再发请求、3 秒后两处提示都自己收。另有「ghost 行的 aria-label 写着未载入」。已载入的刻度点击照旧即时定位（E 段原断言）。两边 typecheck（`npm --prefix web run typecheck` 含 i18n-check、`npm --prefix bridge run typecheck`）与 `bridge/tests/history-page-unit.mjs` 都过。
## D202 Jira 连接：凭据留在桥里，页面只见掩码；隧道只读（工单 #248）

**问题：** 网页客户端要连 Jira（#247 第一张单：入口 + 连接 + 个人信息）。Jira Cloud 的 REST API 用 Basic 认证（邮箱 + API token），token 等于账号的完全权限；页面是可能被隧道带出去的，凭证存哪、谁能读、能对哪里发请求，都得先定下来。

**决定：**

1. **凭据由桥保管，明文 0600 写 `statePath("jira", "config.json")`（`{ siteUrl, email, apiKey }`）。** 页面只能 `GET /api/jira/config`，拿到的是 `{ configured, siteUrl, email, keyMask }`——token 只回 `••••` + 后 4 位。错误文本、日志也不含 token。代价：本机任何读到这个文件的人就有完整权限；页面被 XSS 也拿不到 token，但拦不住本机同用户的进程。要再加一层，可将来接系统钥匙串（Windows Credential Manager），目前不做。
2. **保存先验证，再落盘。** `PUT /api/jira/config` 用这组凭据真打 `GET /rest/api/3/myself`，2xx 才写文件；非 2xx / 网络错一律 400 + `{ error, code }`，状态目录里不出现新文件，页面保留用户已填的值。代价：保存慢一个往返（15 秒超时封顶），且 Jira 抖动时保存不了——这正是要暴露的事。
3. **单站点，只发配置站点。** 站点地址必须 https、无 userinfo、无路径/查询/片段、不是 IP 字面量、不是 `localhost` / `*.local` / `*.internal`；出站只有 `new URL("/rest/api/3/…", siteUrl)`，并在 `fetch` 前断言目标 origin 与配置站点相同（重定向 `redirect: "manual"`，不跟）。桥不做开放代理：没有任何接口接受用户给的 URL。代价：不支持自建 Server/Data Center（http + 内网域名），也不支持同一账号连多个站点——要连就退出重连。
4. **头像多信一个 Atlassian 域名。** 头像字节由桥去取（`GET /api/jira/me/avatar`），但 Cloud 的 `avatarUrls` 实际落在 `*.atl-paas.net` CDN 上，只认「同站 origin」会让所有人的头像都取不到。所以允许名单 = 同站 origin 或 host 以 `.atl-paas.net` 结尾，两者都要求 https、无 userinfo、端口为空或 443、无 fragment；仍不接受任意 URL（页面没有入口传 URL），不跟随重定向，取不到就 502 `jira_avatar`、界面退回首字母。代价：放行了一个第三方域名——它由 Atlassian 控制、且只用于取图；若哪天 CDN 换域名，按这份名单会取不到头像，改一处常量即可。
5. **隧道只读。** `publicReq`（隧道来的请求）下 `PUT` / `DELETE /api/jira/config` 一律 403 `{ error: "回本机操作", code: "tunnel_readonly" }`；`GET config` / `GET me` 照常。代价：在外面用手机改 token 得回本机——写凭据这件事不该让一条隧道代劳。
6. **不探测 Jira MCP。** 面板底部只放一行提示「读描述和评论要用 Jira MCP：在设置 → 扩展与 MCP 里安装」+ 一颗跳过去的按钮。查 MCP 有没有装要读设置、猜服务器名，提示反而更容易说错。代价：用户装没装、装得对不对，面板不知道；点进去自己看。

**为什么由桥代理而不是浏览器直连：** token 一旦进了浏览器就能被页面脚本、扩展、隧道读到；由桥保管，页面拿不到原始 token，出站地址也只由桥决定（上面第 3 条），顺手把 CORS 与「站点地址由用户填」的 SSRF 面收在一处。代价是桥多两个上游请求路径与一个凭据文件。

**代价 / 可改：** 明文 0600 在 Windows 上 `chmod` 基本无效（ACL 仍按用户目录继承，同用户进程可读）；换钥匙串是一次独立改动，接口形状不用变。掩码只露后 4 位，用户据此分辨「是不是换过 token」，看不到全串——这是有意的。

**验证：** `node bridge/tests/jira-e2e.mjs`（9 项，假 Jira + 临时 `PI_WEB_STATE`）：未配置 `configured:false` / 错 token 400 + `jira_auth` + 原话 + **文件不存在** / 正确凭据落盘且 GET 响应全文不含 token / `GET me` 401→401、403→403 / 未配置 `jira_not_configured` / DELETE 后回未配置 / 隧道 PUT·DELETE 403 `tunnel_readonly` 而 GET 200 / 白名单外头像 502 `jira_avatar` / `avatarUrlAllowed` 正反例。`node web/tests/jira-unit.mjs`（7 项，纯函数在 `web/src/jira-shared.ts`，不经 `chat.ts`，Node 26 直接跑）：`siteUrlProblem` 的 http·IP·localhost·`.local`·path·query 全拒、正常 Cloud 站点（含结尾 `/`、无 scheme）通过；`keyMask` 只露后 4 位。`npm --prefix web run typecheck`（含 i18n-check：1807 键 × 3 语）与 `npm run build:web` 都过。

## D203 Jira 列表：桥固定查询 + 60 秒内存缓存（工单 #249）

**问题：** 连上 Jira 之后，面板要显示「我的未完成」和「可访问项目」。这两段都是上游实时数据，但面板开关频繁（每次 `open()` 都重新问桥，D202），Jira Cloud 又按账号限流；同时页面不该有能力对 Jira 发起任意查询。

**决定：**

1. **查询由桥写死，页面没有查询面。** `GET /api/jira/issues` 固定 `jql = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC"`、`maxResults=20`、`fields=summary,issuetype,priority,status,updated`，打新的 `GET /rest/api/3/search/jql`（老的 `/rest/api/3/search` 正被 Atlassian 下线）；`GET /api/jira/projects` 固定 `GET /rest/api/3/project/search?maxResults=20`，只取 `values` 的 `key`/`name`。除了 `refresh=1`，页面传来的其它 query（`jql`、`fields`、`startAt`、`maxResults`…）一律忽略。代价：本单只能看「分配给我 + 未解决」这一种列表，想换查询条件得改桥——这正是 #249 要的边界，任意 JQL 入口是另一个产品决定。
2. **60 秒内存缓存，按当前配置分键。** issues / projects 各一条，键是 `产物 + siteUrl + email + keyMask(apiKey)`；只缓存整理后的 `JiraIssue[]` / `JiraProject[]`（不缓存上游响应对象），过期即弃。`GET …?refresh=1` 跳过读取、取到后覆盖缓存；只有成功的 2xx 结果会进缓存，401/403/网络错不缓存，下次照旧重试。代价：两个标签页共享同一份缓存（它们本来就在同一台桥后面），换账号后 60 秒内看到旧列表的窗口最多一个 TTL。
3. **为什么不落盘。** 列表是易变数据，缓存的目的只是省请求、避开限流；进程重启后重取一次的成本远低于维护一份可能过期的文件，也少一处要跟着「清除凭据」清理的磁盘状态。代价：桥一重启就冷启动，第一打开面板必然打两次上游。
4. **保存 / 清除凭据时清空缓存。** `writeJiraConfig` / `clearJiraConfig` 都调用 `clearListCache()`：换了站点或 token 还读旧缓存，等于把上一个账号能看的列表展示给下一个人。键里已经带了配置，清空是双保险，也顺手回收内存。代价：重连后的第一次打开一定等一个往返（本来也要验证凭据）。
5. **错误码沿用 `me` 的口径。** 未配置 400 `jira_not_configured`；上游 401 → 401 `jira_auth`；403 → 403 `jira_forbidden`；其它非 2xx / 网络错 502 `jira_upstream` / `jira_network`；响应永远 `{ error, code }`，不回 token。前端据此把 401/403 整块换成「凭据失效 + 去改 token」，其它错误只在列表位置留一行字。

**为什么缓存放在桥而不是页面：** 页面缓存跨不过标签页、也挡不住刷新页面，而限流是账号级的；桥是唯一知道当前凭据的地方，缓存键能跟着配置走，保存/清除凭据时也能一致地失效。代价：桥多一份进程内状态，多实例部署时各自一份（本工具就是单机进程，不做共享缓存）。

**验证：** `node bridge/tests/jira-e2e.mjs`（17 项，假 Jira 加 `search/jql` 与 `project/search` + 命中计数器）：固定 JQL/字段（含页面传 `jql`、`fields`、`startAt` 被忽略）、字段映射（priority 为空回 `null`）、空列表、401/403 映射、两次读取只打一次上游、`refresh=1` 再打一次、`projects` 的映射与缓存、重新保存凭据清空缓存、未配置 400。`node web/tests/jira-unit.mjs`（10 项）：`browseUrl` / `formatUpdated` / `issueMeta`。`npm --prefix web run typecheck`（含 i18n-check：1814 键 × 3 语）与 `npm run build:web` 都过。

## D204 Jira 详情：ADF 在页面端解释、评论只为附件而取、详情不缓存（工单 #250）

**问题：** 「我的未完成」里点一行要就地展开详情：描述（Jira Cloud 存的是 ADF）+ 两段附件清单（issue 附件、评论附件）。描述要不要桥先转成文本、评论正文要不要一起返回、详情要不要缓存，三件事都会影响接口边界与将来的下载（#251）。

**决定：**

1. **描述 ADF → 纯文本在页面端做，桥原样透传。** `GET /api/jira/issues/:key` 的 `issue.description` 就是上游 `fields.description`（可能是 `null` 或 ADF 对象），桥不解析、不裁剪；`web/src/jira-shared.ts` 的 `adfToText()` 把段落 / 标题 / 列表 / 代码块 / 表格 / 引用 / 分隔线转成可读文本，`media` 节点变成 `[图片]` / `[附件]` 占位，超过 800 字截断并给「在新窗口打开」。代价：页面多一层要跟着 ADF 演进维护的转换器（认不出的节点类型会退化成丢格式的纯文本）；好处是桥保持「只做认证与转发」的单一职责，将来别的界面（预览、摘要）能复用同一份 ADF。
2. **评论只为附件而取：只挖 `media` / `mediaSingle` 节点的 `attrs.id`。** 详情固定打一次 `GET /rest/api/3/issue/<KEY>/comment?maxResults=100`，遍历每条评论的 ADF body 收集 media id，映射成 `{ id, filename: attrs.alt || attrs.title || "附件", size: null, author: comment.author.displayName, created: comment.created }`，按 id 去重；评论正文、body 原样、其它字段都不进响应（e2e 用哨兵字符串断言全文不含）。代价：评论附件拿不到真实大小（media 节点里没有），界面显示 `—`；这条评论接口失败时整个详情按该错误码失败，而不是静默少一段附件——宁可让用户看见「读不到」，也不假装「没有评论附件」。
3. **详情不缓存，只记在面板实例内存里。** 详情是点开才要的数据，桥端没有 TTL 缓存（与 D203 的列表缓存分开）；页面用 `Map<key, {open, state}>` 记住已经取到的结果，收起再展开、多行同时展开都不重请求，面板关闭 / 重连 / 换账号即丢弃。代价：同一工单在两个标签页里各请求一次；页面刷新后重新取；换来的是不会把上一个账号的工单详情留在内存里，也少一份要跟凭据失效同步的缓存。

**接口形状：** `GET /api/jira/issues/:key` → `{ issue: { key, summary, type, priority, status, updated, description }, attachments: { issue: [...], comments: [...] } }`。key 先过形状校验 `^[A-Za-z][A-Za-z0-9_]*-[0-9]+$`（不匹配 400 `jira_key`），大写化后拼 URL；这只是形状校验，能不能看由固定站点与用户 token 决定。上游 404 → 404 `jira_not_found`（「Jira 上没有这个工单」），401/403 沿用 `jira_auth` / `jira_forbidden`。

**验证：** `node bridge/tests/jira-e2e.mjs`（23 项，新增 6 项）：详情字段映射与 description 原样透传、两段附件映射（未知 size → `null`、未知 author → 空串、评论 media 按 id 去重）、响应全文不含 `SENTINEL_COMMENT_TEXT`、key 大写化与形状校验、404/401/403 映射、详情不缓存与未配置 400。`node web/tests/jira-unit.mjs`（18 项，新增 8 项）：`adfToText` 的段落 / 标题 / 嵌套无序与有序列表 / 代码块 / 表格 / media 占位 / mention / hardBreak / 链接 / 空输入，`formatBytes` 的 B/KB/MB 与未知值。`npm --prefix web run typecheck`（含 i18n-check：1821 键 × 3 语）与 `npm run build:web` 都过。

## D205 Jira 下载全部附件：根目录独立成文件、评论 media 探测 uuid、100 MB 上限与串行（工单 #251）

**问题：** 详情块里的两段附件（issue 附件 + 评论附件）要能一键收下来。落盘到哪、评论里那些 media 的 id 与 attachment id 不是一回事、跳转是签名 URL、超大文件与并发、公网隧道下的写权限，五件事都要在桥这边定清楚。

**决定：**

1. **根目录存独立文件，不进 `config.json`。** `statePath("jira", "attachments.json")` 里只有 `{ "root": "<绝对路径>" }`；接口 `GET /api/jira/attachments/root` → `{ root: string | null }`，`PUT` 收 `{ root }`，按 `^[A-Za-z]:[\\/]`、`^\\\\`（UNC）、`^/`（POSIX）认绝对路径，`fs.mkdirSync(root, { recursive: true })` 不抛错才写盘，否则 400 `jira_root`；隧道访客 PUT 403 `tunnel_readonly`（「回本机操作」），GET 照常。代价：桥多一份状态文件，而且「退出连接」不清它（目录不是凭据，重连不该丢）；好处是含 token 的那份文件（chmod 0600）里不会多出一个用户可重复编辑的路径字段。

2. **`POST /api/jira/issues/:key/download` 是批量语义，单项失败不整单失败。** 没设根目录 → 400 `need_root`（「还没设置附件目录」），而且在拉详情之前就返回，一个字节都不写；有目录时拉与详情同一套数据（issue 字段 + 评论 media），落 `<root>/<KEY>/`（KEY 大写），回 `{ dir, items: [{ id, filename, path, status: "saved" | "skipped" | "failed", reason? }] }`，HTTP 仍是 200。`reason` 是中文短句（超限 / 取不到内容 / 找不到对应附件 / 跳转到不允许的地址…）。代价：前端要分「整单错误」（400/403，显示在按钮下）与「单项失败」（逐行显示）两层。

3. **评论 media 的 uuid 不是 attachment id，按需探测。** ADF 里 `attrs.id` 是 media services 的 UUID，直接当 `/rest/api/3/attachment/content/{uuid}` 用会 404。做法：先按 uuid 取；404 时对这张工单的 issue 附件逐个 `GET /rest/api/3/attachment/content/{attachmentId}`（手动不跟随跳转），从 302 的 `Location` 里取 `/file/{uuid}/binary` 的 uuid 反查，命中即重试；探测结果（含失败）记在进程内 `Map`，只有「这张工单有评论 media 且按 uuid 取不到」时才发生。代价：最坏情况每单多 N 次（N = issue 附件数）探测请求；缓存不落盘、桥重启重来。

4. **单文件 100 MB 上限、全程串行。** `MAX_DOWNLOAD = 100 * 1024 * 1024`；`Content-Length` 超限直接 `skipped`（不建文件、不发请求体读取）；没有长度就边写边数，超限立刻中断、删掉半截文件、记 `skipped`。一个文件 `await` 完再下一个，不并发。代价：上限写死，要改得动代码；整单耗时是各文件之和，换来的是不需要并发池、限速与部分失败回收。

5. **跳转只认站点自己或 `*.atl-paas.net` 的 https，第二跳不带 Authorization。** 第一跳 `redirect:"manual"`，`Location` 必须 https、无 userinfo、无 hash、端口空或 443，且 host 等于配置站点或 `atl-paas.net` / `*.atl-paas.net`；跟随那一跳走同一套超时与代理缝，但**不带** Authorization（签名 URL 自带凭据）；别的 host 一律 `failed`。代价：Atlassian 换域名 / 改端口 / 换 CDN 时下载会整体 `failed`，要跟着改白名单这一处；放宽成「任意 https」等于让上游指定主机拿到我们的 Basic 头（SSRF + 凭据外泄）。

6. **文件名清洗是一层纯函数，重名靠附件 id、重下覆盖。** 导出 `safeFileName(name, id)`：`\ / : * ? " < > |` 与控制字符换成 `_`，去首尾空白与结尾的点，Windows 保留名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9，带扩展名也算）前加 `_`，空名回落 `attachment-<id>`，截到 120 字符且保留扩展名；同批内重名 → `name-<id>.ext`；磁盘上已有同名文件就是覆盖（重下不堆副本）。代价：只差非法字符的两个附件会在磁盘上撞名，靠 id 后缀区分；`_CON.txt` 这类改名对用户可见，但比在 Windows 上写失败好。

**接口形状：** `GET /api/jira/attachments/root` → `{ root: string | null }`；`PUT …/attachments/root` body `{ root }` → `{ ok: true, root }`（不合法 400 `jira_root`；隧道 403 `tunnel_readonly`）；`POST /api/jira/issues/:key/download` → `{ dir, items: [{ id, filename, path, status, reason? }] }`（没设目录 400 `need_root`；隧道 403 `tunnel_readonly`；key 形状校验同 `GET /api/jira/issues/:key`，大写化）。

**验证：** `node bridge/tests/jira-e2e.mjs`（33 项，新增 10 项：root 的 null / 相对路径 400 / 建目录 / 不写进 config.json、隧道 PUT 403 而 GET 200、`need_root` 不拉详情、完整下载的目录结构与清洗 / 同批重名 / 超限 / 评论 media 探测 / 白名单外跳转 / 第二跳 `authorization` 为 null、重下覆盖、隧道 POST 403、`safeFileName` 与 `attachmentRootProblem` 与 `attachmentRedirectAllowed` 的单测）。`node web/tests/jira-unit.mjs`（19 项，新增 `downloadMark`）、`node web/tests/commands-unit.mjs` 通过；`npm --prefix web run typecheck`（含 i18n-check：1831 键 × 3 语）与 `npm run build:web` 都过。

**偏移点（未在真实租户上核实）：** 白名单按工单原文只收 `*.atl-paas.net`；Atlassian Media 的真实主机若是 `api.media.atlassian.com` 之类，跳转会整体 `failed`。实机确认后只改 `attachmentRedirectAllowed` 一处；先把「拒绝未知主机」定下来，比先放行再看发生了什么安全。

## D206 Jira「交给 agent」：提示词在页面拼、附件行由桥端的 downloaded 事实决定、浮层照抄笔记面板（工单 #252）

**问题：** 列表每一行和展开的详情里都要有一颗「交给 agent ▾」，两个出口（预填当前会话 / 新开会话）与笔记面板一致。要定清楚的是：提示词在哪拼、附件路径那一行凭什么出现、浮层是抽共用件还是复制。

**决定：**

1. **提示词是纯函数，在页面端拼。** `web/src/jira-shared.ts` 的 `handoffPrompt(input)` 把工单号 / 标题 / 链接（复用 `browseUrl`）/ 状态 / 优先级 / 类型与固定指令拼成一段文本；`type` 与 `status` 缺省就省略那一段，`priority: null` 写「优先级：未设置」。它**不走 `tr()`**——这是给 agent 的指令，不是界面文案，切英文界面也不该改变指令内容；`web/i18n-check.mjs` 为此加了 `// i18n-ignore-start <理由>` … `// i18n-ignore-end` 行区间（用法记在 `docs/I18N.md`），区间内既不报漏翻也不进词典。代价：改提示词得动代码、且没有多语言版本；换来的是指令稳定、可单测（`node web/tests/jira-unit.mjs` 直接 import，不经 `chat.ts`）。

2. **附件那一行只在确实下载过时出现，事实由桥端给。** 新增只读 `GET /api/jira/issues/:key/downloaded` → `{ dir: string | null, count: number }`：没设根目录、目录不存在、目录里没有普通文件都回 `{ dir: null, count: 0 }`；否则 `dir = <root>/<KEY>`、`count` 只数 `readdirSync(..., { withFileTypes: true })` 里的普通文件（子目录不算）。它不建目录、不拉 Jira、隧道访客也能读。页面点击交接时：详情里刚下载过就复用 `download.dir`，否则问桥，桥问不到按「没下过」处理，不阻断交接。代价：每次交接多一次本地往返（详情刚下载过时省掉），换来的是提示词不会骗 agent「附件在这个目录」——空目录/没下过时宁可不写这一行。

3. **浮层从笔记面板复制一份，不抽共用件。** `web/src/jira.ts` 的 `openHandoffMenu()` 照抄 `notesheet.ts` 的 `handoffMenu()`：同样两颗按钮、同一批 `tr` 键（`预填到当前会话` / `写进输入框，Enter 才发`、`新开一个会话` / `建好后填进那个会话的输入框，不自动发送`），点外面、`Esc`、滚动、改尺寸都关。额外补了两点：上下翻转（下方放不下且上方更宽裕就翻到锚点上方）与夹进窗口边（左右 12px、上下 12px），因为验收要求「展开位置不超出窗口」，而笔记那份只是贴着按钮往下开。`prefill` / `newSessionWith` 抛错或没接上时，在浮层里显示一行中文错误，不静默。代价：两份约五十行浮层代码要同步维护，改交互得改两处；换来笔记面板零风险，Jira 这边的布局与错误态能独立演进（用户明确要求不抽共用件）。

4. **交接完只收浮层，不关 Jira 面板。** 预填只把提示词放进当前输入框（发不发由人按 Enter）；新开会话沿用既有出口——设 `prefillNext` 再开会话，建好后填进输入框，不自动发送。关掉整个 Jira 面板会让用户丢失列表与展开状态，而预填完往往还要看别的工单。代价：面板与输入框同时在场，用户要自己切走；这是「预填」这个动作本来的语义。

**接口形状：** `GET /api/jira/issues/:key/downloaded` → `{ dir: string | null, count: number }`；key 先过与详情相同的形状校验（不匹配 400 `jira_key`），非 GET 405 `bad_method`；隧道 GET 200（只读）。`handoffPrompt(input: { key, summary, siteUrl, status?, priority?: string | null, type?, dir?: string | null })`：`dir` 为空（`null` / 缺省 / 空白）不出现附件行，有值时补一个与目录同风格的结尾分隔符（Windows 根的 `C:\…\<KEY>` 补 `\`，POSIX 补 `/`）。

**验证：** `node bridge/tests/jira-e2e.mjs`（36 项，新增 3 项：没设根目录 `{null,0}` 且不拉 Jira、`<root>/<KEY>/` 两个文件加一个子目录 → `{dir, count: 2}`、目录不存在与空目录都是 `{null,0}` 且隧道访客写了一个文件后读到 `{dir, count: 1}`）。`node web/tests/jira-unit.mjs`（23 项，新增 4 项：全文逐字、附件行有/无与结尾分隔符、优先级 `null` 与缺省、空标题只留工单号）。`node web/tests/commands-unit.mjs`（13 项）通过；`npm --prefix web run typecheck`（含 i18n-check：1833 键 × 3 语）与 `npm run build:web` 都过。

**偏移点：**

- 笔记面板的 `handoffMenu()` 实际没有上下翻转（固定开在按钮下方）；本单按验收要求自行加了翻转与窗口内夹取，所以两份浮层代码不完全一样。
- 附件目录的结尾分隔符跟随目录本身（Windows 上是 `\`），不使用固定的 `/`；这与工单原文的 `<根目录>/<KEY>/` 在 Windows 上不是逐字相同，但避免了 `C:\…\ACME-12/` 这种混搭。
- 为了让「中文但不翻译」的字面量过门禁，改了 `web/i18n-check.mjs`：新增行区间标记，只跳过区间内的字面量，其余检查逻辑未动。

## D207 Jira 搜索：第二颗 tab、结构化条件只由桥拼 JQL、人员选择器带无权限降级（工单 #256–#259）

**问题：** v1 只能看「分配给我 + 未解决」（D203）；要按人（含别人的）、项目、状态、类型、优先级查，得离开面板去 Jira 网站。开放查询能力会把「页面能对 Jira 发什么」这条边界（D202/D203）重新打开：原始 JQL 一旦从页面进来，桥就成了任意查询代理；人员字段还牵着「找不到人」与「没有看关注者权限」两种常见失败。

**决定：**

1. **形态选 A：面板内两颗 tab**（我的未完成 / 搜索），各自滚动、各自保留状态；默认列表，首次进搜索自动跑一次记忆条件（没有就跑全部未解决）。B（同屏折叠）与 C（按钮切块）在原型里对比过，不入库。代价：搜索不能与列表同屏对照；换来的是两个入口平权、互不挤位置。
2. **页面只传结构化条件，JQL 仍由桥拼。** 白名单参数、长度/枚举/互斥校验、`escJql` 转义都在桥端；页面没有 `jql` 参数入口，未知参数忽略。这与 D203「页面没有查询面」一致，只是把条件集从一条固定 JQL 扩到一张受控表单。代价：新增一种条件要改桥；换来的是注入面收敛在一处。
3. **人员是选择器，账号 ID 优先、自由文本兜底。** 输入 ≥2 字走 `GET /api/jira/users`（代理 `/rest/api/3/user/search`），选中存 `accountId`；该接口要 `Browse users and groups`，401/403 时回 `unavailable` 而不是报错，页面退化成手输邮箱/accountId。三个关系勾（经办人/报告人/关注者）默认全选、OR 语义；`未分配` 与人员互斥。代价：名字重名时以选中的 accountId 为准，自由文本可能被 Jira 判为找不到人；换来的是没有权限的人仍能查。
4. **关注者被拒时自动降级，而不是整单失败。** 带 `watcher` 的查询遇到上游 400/403，桥去掉 watcher 重试一次；成功则回 `degraded: { watchers: true }`，页面在结果上方说明。**只剩 watcher 一项时不重试**（去掉就变成无条件，结果会悄悄变宽），直接 403 并提示改选经办人 / 报告人。代价：真正的 JQL 错误会多打一次上游；换来的是大多数人不至于因为一个勾选就看不到任何结果。
5. **分页 20 + `nextPageToken`，没有总数。** 新版 `/rest/api/3/search/jql` 不返回 total，界面只说「已显示 N 条」，`isLast` 后说「已全部加载」；不为了一个数字再打一次估算接口。代价：用户不知道总共多少条；换来的是不做假数字、不增加请求。
6. **元数据单独取、短期缓存；搜索结果不缓存。** `GET /api/jira/meta?project=` 给类型/优先级/项目内状态，5 分钟内存缓存（键含配置与项目），失败不缓存；`status` 必须带 `project`（否则状态名跨项目歧义），桥端 400。搜索是用户主动动作且条件多变，缓存收益低、串条件风险高，故不缓存；D203 的列表缓存不动。代价：搜索每次一个往返；换来的是结果永远对应当前条件。
7. **边界不变：单站点、只读、隧道 GET 可查。** 搜索只发配置站点的 `/rest/api/3/*`；隧道访客能查（读），没有任何写路径。

**接口形状：** 细节见 `docs/JIRA-SEARCH.md`。`GET /api/jira/search` → `{ ok, issues, nextPageToken?, isLast, degraded? }`；`GET /api/jira/meta?project=` → `{ ok, statusCategories, types, priorities, statuses, partial? }`；`GET /api/jira/users?q=` → `{ ok, users, unavailable? }`；错误沿用 `jira_not_configured` / `jira_auth` / `jira_forbidden` / `jira_upstream` / `jira_network`，参数错误新增 `jira_query`（带 `field`）。

**验证：** 本 PR 只落设计与实现单（#256–#259）。实现门槛：`node bridge/tests/jira-search-unit.mjs`（条件→JQL 与校验）、`node bridge/tests/jira-e2e.mjs`（三条路由、watcher 重试、meta 缓存、隧道）、`node web/tests/jira-unit.mjs`（query 组装与本地记忆）、`npm --prefix web run typecheck`（含 i18n-check）、`npm run build:web`；界面按 `docs/JIRA-SEARCH.md` 的手点清单验收。

## D208 产物弹窗：会话级基线快照判「新增 / 修改 / 删除」，改动放进独立 diff 弹窗

产物弹窗过去只记「哪个工具写过这个路径」：`write` 覆盖已有文件也显示「写入」，同一路径写了两次只有一行，改了多少完全不知道。根因是「新增还是修改」是**文件事实**，而弹窗当时拿到的是**工具事实**——pi 的 `write` 返回值只有一句 `Successfully wrote to <path>`（`dist/core/tools/write.js:50`），`edit` 才带 `details.diff`，所以靠工具结果猜不出覆盖还是新建。

**决定**

1. **基线在写入前抓，抓在 pi 的 `tool_call` 钩子里。** 新增 `bridge/ext/artifact-snapshot.ts` 扩展，由 `sessions.ts` 与既有两个扩展一起 `-e` 注入；钩子里把路径回打给桥（`POST /api/artifacts/snapshot`，回环 + 会话 token），桥读磁盘存下**第一次**碰它时的字节。`tool_call` 在执行前且被 await，这是唯一零竞态的位置。替代方案（桥在 `tool_execution_start` 抢读）是毫秒级竞速，新建文件大概率读成「修改」、diff 恒空，否决。
2. **快照是会话级的，不是全局的。** 存 `statePath("artifacts", <sessionId>)`：`index.json` + `<sha256(abs)>.orig`。单文件 2 MB、单会话 500 个文件封顶；到顶之后的新文件不再拍快照，那些行只能走 git 估算或标「未知」——宁可少一条基线，也不无限长。会话被彻底删除时（`sessions.purge`）一并清掉。
3. **状态有五档，缺基线时不猜。** `new` / `modified` / `same` / `deleted` / `unknown`。没有基线时先问 git（`git show <root-relative>` 能否解出会话开始时的 blob），能给就标「按 git 估算」，否则明说「未知」——不把猜测画成事实。判断「没变」用的是 `diffTexts` 的 `added === removed === 0`，不是字节相等，否则 CRLF ↔ LF 会被算成整文件重写。
4. **改动呈现选独立弹窗（C）。** 产物弹窗只留徽章 + `+N −M` + `工具×次数`；点一行开 `diff-sheet`：左栏换文件、右边左右对照、`j / k` 换文件 `← / →` 换 hunk `Esc` 关。否决了「行内展开」（弹窗要变高、只能塞前 60 行）与「查看器加变更页」（得为同一个文件开关两次查看器）；代价是多了第三套浮窗，但它只在产物弹窗里可达，不进查看器的导航。
5. **只认 write 系工具。** `bash` / `apply_patch` 之外的方式写文件不触发钩子，P0/P1 不追（`WRITE_TOOLS` 与既有 approval-gate 同名不同源，将来若要合并再抽公共常量）。二进制只给大小变化，`>2MB` 或 `>5000 行` 或改动超过 3000 行只给原因不给逐行；`diffTexts` 对前两种回 `added=removed=0`，那只是「没比」，状态必须是 `unknown` 而不是 `same`。

**接口形状**

`POST /api/artifacts/list {sessionId, items}` → `{items, summary, baseline}`；`POST /api/artifacts/diff {sessionId, path}` → `{path, abs, status, estimate, binary, added, removed, hunks, truncated, reason?, sizeBefore, sizeAfter}`（没基线也是 200 + `reason: "no-baseline"`，不是错误）；`POST /api/artifacts/snapshot {token, path}` 只给扩展（回环 + token，失败也回 200，记账不能挡写入）。清单的 `items` 由页面从自己的工具条目里算（`chat.ts` 的 `written` 现在带 `writes` 计数），桥只负责「拿这些路径和磁盘比」——会话历史重放是免费的。

界面文案不由桥拼：`why` 是码（`no-baseline` / `git-head-missing` / `snapshot-too-big` / `size-only` / `binary-size-only` / `built-then-deleted` / `diff-too-large` / `diff-rewrite`），句子在 `app.ts` 的 `artifactWhyText()` 里经 `tr()` 取，否则 `i18n-check` 扫不到桥端，三种语言里两种会缺。

**验证**

`node bridge/tests/artifacts-unit.mjs`（新增/修改/没变含 CRLF/已删除/二进制/无基线/相对与绝对路径去重/清理）、`node bridge/tests/artifacts-e2e.mjs`（临时桥：snapshot 无 token 与假 token 都 403、未知会话 404、`/api/git` 未被闸到）、`npm run typecheck`（含 i18n-check，新增 24 条文案 ×3 语）、`npm run build`。界面用原型页先对齐过三个候选的观感，真机手验留给测试环境（一条真模型回合写两个文件）。

## D209 幻灯片支持：能打开文件的地方都要能开 .pptx，翻页走 PowerPoint → PDF（#265）

「用户或 agent 能直接打开一个本地文件」的入口有四条：预览面板 / 文件管理器、聊天里的附件与路径 chip、Jira 面板的附件行、内网通收到的文件。它们过去只认「文本 / 图片 / 表格 / 其它二进制」四类，`.pptx` 落进最后一类——页面明写「这个格式这里不支持」，而且只有 xlsx 家族才配一颗「用默认程序打开」。结果是：能看见文件，打不开它；客户发来的季度汇报在网页里就是一行字。

还有一处更早就错位的地方：`bridge/src/delivery.ts` 一直告诉模型「预览打不了的就指向客户端里已有的『用本机程序打开』出口」，可那颗按钮只对 `WORKBOOK` 家族出现。对 pdf/docx/ppt 来说是句空话，模型顺着这句话让用户去点，用户找不到。

**决定**

1. **两步走，先本机能开、再站内翻页。** 第一步（便宜、立刻可用）把「用本机程序打开」从 xlsx 家族扩到**所有会落到 binary 支线、且有桌面程序认领的格式**：`.pptx .pptm .ppsx .potx .ppt .pps .pdf .doc .docx`（加上原有 `.xlsx .xlsm .xlsb .xls .ods`）。判定在桥（`OPENS_ON_DESKTOP` 那张表），前端只问 `kind` 与扩展名，不再各自维护正则。第二步才是站内翻页。代价：`.pdf`、`.docx` 从「只能下载」变成「能交给本机」，多一条启动外部程序的路径；这与 D69 当年担心的「网页启动任意关联程序」是同一类风险，区别在于现在只对**用户亲手点开的那个文件**、且只在回环页面（`/api/open` 本来就是回环 + token）。

2. **扩展名分家族，伪装包退 binary，老二进制直接认。** `.pptx .pptm .ppsx .potx` 必须是 zip 包（`isZipPackage` 沿用表格那边的判定），不是就退 binary 并给「用本机程序打开」；`.ppt .pps` 是 97-2003 的 OLE 二进制，没有可靠的结构判据，直接认。改了扩展名的 pptx（比如改名成 `.doc`）按扩展名走，仍是 binary —— 但 grant 在，本机照样能开。**不做内容嗅探**：那是给「打开就崩」开了个口子，而「点了打不开」是可解释的。

3. **站内翻页 = PowerPoint COM 转 PDF，塞进 iframe，放在独立的幻灯片浮窗里。** 不复用 `viewer` 面板：它固定 `min(760px,55vw)`（D121），一页 16:9 的幻灯片塞进去只剩半张；也不复用 `/raw`——它的 `content-security-policy: sandbox` 会让浏览器内建 PDF 查看器白屏（D166 已经因此给表格单开了 `/api/sheet/pdf`；**更正：**这条实测不成立，白屏来自 Playwright Chromium 缺插件，见 D50 的 PDF 修订）。所以照抄 D166 的形状，另开 `/api/slides/pdf`：POST 换状态、GET 取字节，`content-disposition: inline`，`nosniff`，`no-store`。iframe 不带 `sandbox`（要 PDF 查看器自己的 origin），这是 D166 已接受的取舍。

4. **把「文件 → PDF」抽成共用设施，`sheet/pdf.ts` 降级成 wrapper。** 新 `bridge/src/docpdf/service.ts` 收排队、缓存键（`sha256(abs\0mtime)`）、两阶段状态、失败记忆、超时、临时目录、`%PDF-` 校验、清理；`engine` 是唯一的变量。表格的 driver 仍是 LibreOffice（行为、错误码 `sheet_pdf_failed/_timeout/_soffice`、`PI_SOFFICE` 全部不变），幻灯片的是 COM。**不顺手改 sheet-pdf 的旧行为**（它至今不清理缓存），只给新目录加 `retain: {count: 50, days: 7}`——旧坑单独修，别混在一次变更里。

5. **页数上限要在启动 PowerPoint 之前判。** `200` 页：先只读 zip 中央目录数 `ppt/slides/slideN.xml`（读尾 66 KB 找 EOCD，不整包进内存），超了直接 `slides_pdf_pages`。认不出结构（加密包、Zip64）就不数，只靠 50 MB 体积上限——认输比吃内存好。为什么不转完再判：一次 PowerPoint 启动 8 秒起步，转完再拒不但是白等，还会在磁盘上留一份没人要的 PDF。

6. **COM 只读、无窗口、强制禁宏、超时杀进程树。** `Presentations.Open($Src, ReadOnly:=$true, Untitled:=$false, WithWindow:=$false)`、`AutomationSecurity = 3`（`msoAutomationSecurityForceDisable`）、`SaveAs(..., 32 = ppSaveAsPDF)`、`Close()` + `Quit()`。PowerShell 脚本**只写 ASCII**、`param()` 必须是第一句：Windows PowerShell 5.1 按 ANSI 读无 BOM 的 UTF-8，一句中文注释就能让整个脚本炸。超时 180 秒，先 `taskkill` 掉这次新出现的 `POWERPNT.EXE` 再抛 `slides_pdf_timeout`。代价：**接受 PowerPoint 窗口闪一下**（`WithWindow:=$false` 也拦不住进程启动那一下）；换来的是不依赖装载项、不写用户模板。

7. **打开即转、直出页面；关掉浮窗不取消转换。** 不做「先信息页再点按钮」（那要多一次点击和一次状态机），浮窗一开就轮询 `POST /api/slides/pdf`，`ready` 直接挂 iframe。用户提前关窗，转换继续跑完落缓存——下次打开直接 `ready`（实测缓存命中 0.5 秒，首次 8.1 秒）。失败记进 `failures`，只有页面上的「重试」带 `retry: true` 才重转，避免一次坏文件把 PowerPoint 反复拉起来。

8. **可信根：Jira 附件目录与内网通收件箱，每次请求现读配置。** 这两处的文件不在会话 cwd 下，工具和页面都够不着。`previewPins()` 每个请求调 `readAttachmentRoot()` 与 `peer.view().status?.config?.inbox`，命中就把 token 的 `root` 钉在那个目录上（不是 cwd）——页面拿到的读权不多于它刚才列出的那份清单。**只信当前配置值**：用户改掉附件根，旧目录立刻不再是可信根。`open_preview` 工具走 `isTrustedPreviewPath(session, abs, pins)`，所以 agent 也能开这两处的文件。

9. **内网通点卡片 = 用本机程序打开（与原计划的偏差）。** 原定「点卡片 = 站内预览」，落地时发现 `web/peer.html` 是独立页面、自己的 bundle，不加载 `app.ts`，也没有会话上下文；而 `/api/preview` 必须 `sessions.locate(sessionId)`，SPA 启动时又不会自动选会话，深链预览会 404。所以改为：卡片点击 → `POST /api/peer/open` → 桥问 peer 守护进程要收件目录里的**真路径**（新增回环 `/files/meta`）→ `openWithApp`。「另存」小链接保留。`.pptx` 由 PowerPoint 打开，仍然满足「能打开」；代价是没了站内翻页。

10. **公网不给演示文稿内容，也不给路径。** 与表格同一条口径（US 46）：`/api/preview` 在隧道请求上一律 403 `slides_public`「通过公网访问时不提供演示文稿内容，回本机操作」，页面根本拿不到 token。`/api/peer/open` 同样拒绝公网。

**接口形状**

`POST /api/preview {sessionId, path}` 的 `kind` 新增 `"slides"`，并带 `slides: {pages: number|null, engine: boolean}`（页数与「这台机器有没有 PowerPoint」提前告诉页面，别让它轮询一场注定失败的转换）。`POST /api/slides/pdf {token, retry?}` → `{id, status: "ready"|"pending"|"failed", error?, code?}`；`GET /api/slides/pdf?id=&token=` → 200 `application/pdf`（完成）/ 202 text/plain「幻灯片还在生成」/ 404 `slides_pdf_gone`（id 与当前 grant 的 key 不符）。错误码：`slides_pdf_failed`、`slides_pdf_timeout`、`slides_pdf_powerpoint`（未安装 / COM 未注册，HTTP 503）、`slides_pdf_pages`；公网 403 `slides_public`。`POST /api/peer/open {id}` → `{ok, message}`；peer 守护进程新增 `GET /files/meta?id=` → `{ok, path, name, size, mime}`（只回环）。

**验证**

`node --experimental-strip-types bridge/tests/slides-unit.mjs`（`npm run test:slides`）—— 共用设施的排队/缓存/失败记忆/`retry`/超时+kill/页数粗筛/体积上限/清理各一组，`countSlides` 的 3 / 0 / null / null，以及分类与 pinRoots；`npm run test:preview` 不回归；`npm run typecheck`（含 i18n-check，14 条新文案 ×3 语）、`npm run build`。真机另验（本机 PowerPoint 16，未提交脚本）：3 页真 pptx → 首次 8.1s 出 PDF、缓存命中 0.5s、`/api/open` 能交给桌面程序；Playwright + 真桥 + Edge 通道截图确认浮窗里渲染出「Slide 1 / 1 of 3」，拖拽缩放后几何落 `pi.slidesGeom`，重开保留。Playwright 自带 Chromium 没有 PDF 插件，headless 里是白框——那不是这套实现的问题。
## D210 行 2 的「本区」不拿全量置顶兜底：没有当前会话就只剩 ＋

**问题：** 用户在只有 1 个会话的「月报」工作区里，看到行 2 铺着 13 颗别组的 ★ 胶囊（截图里是 9 颗 + `＋5`），括弧里那句「我明明只在这组」就是 D145 留下的两条兜底造成的：`starredRow()` 在**没有当前会话**、以及**反查不到当前会话属于哪个组**时都返回 `manage.pin` 全量。全量置顶与当前组无关，于是左栏越干净，这条越像串组。

**决定：** 行 2 的「本区」只在有当前会话时才有定义。**取代 D145 决定第 3 条的后半句**（「有快照时显示当前会话所属组的会话（★ 优先），并排除当前那颗」）：D145 只说了「有快照时有本区」，没说没有当前会话时算什么，那处空白就是本条的来源。

1. 没有当前会话 → 返回空，`PillBar` 只剩尾巴那颗 ＋（不传 `empty` 文案，所以连提示都没有）。
2. 有当前会话但 `wsOf()` 反查不到组（脏快照 / 过滤把组滤掉）→ 同样返回空，**不**猜一个组、也不退回全量。
3. 旧桥 / 桩桥根本不发 `workspace` 快照时仍退回 `manage.pin`：那种桥里「本区」这个概念不存在，置顶是它唯一能给的集合。这条**比第 1 条先判** —— 旧桥 + 没有当前会话也一样铺置顶，跟开没开会话无关。

实现：`web/src/app.ts` 的 `starredRow()` 三条出口（旧桥 → `pins`；没有当前会话 → `[]`；否则本区会话交给 `starredSessions`）+ `web/src/pillbar.ts` 的 `starredSessions(zone | null | undefined, stars)`：`zone` 为空（本区没定义）直接得 `[]`，于是「不猜」这条可以脱离 DOM 单测。

**为什么：** 行 2 的职责是「我在这个工程里，这个工程里有什么事」。没有当前会话时它答不了第一问，退回全量置顶等于用「所有工程」回答「这个工程」——用户看到的就是别组的会话。空态至少不会指错组；左栏与顶栏标签仍然在，要找会话不缺入口。

**代价 / 可改：** 没有当前会话时行 2 只剩一颗 ＋，一屏之内看不出「有哪些置顶」（要开左栏）；这是有意的：置顶的作用是「在本区里排前」，不是全局收藏夹。若以后想要「全局收藏」，应该是另一个入口（比如左栏的「已置顶」分区），而不是让行 2 兼职。

**验证：** `node web/tests/pillbar-unit.mjs`（新增 2 项：本区未定义（`null` / `undefined`）为 `[]`、本区有定义时仍只留本区 ★）；`probes/workspace-tree.mjs`（新增 2 项：没打开会话时行 2 零胶囊、只剩 ＋）；`probes/workspace-shells.mjs`（A 壳新增 2 项：没打开会话时别组 ★ 不进行 2；打开 proj-01 的会话后行 2 只留本区那颗 `s-01-2`）；`probes/pin-auto-open.mjs`（22 项全绿；新增 1 项：旧桥 + 没有当前会话时行 2 仍铺满全部置顶，旧桥回退的行为未变）。`npm --prefix web run typecheck`（含 i18n-check）与 `npm run build:web` 通过。

## D211 diff 弹窗右边被裁：`.sheet` 是 grid 却没钉列，隐式列按 max-content 长过自己的 width

**现象：** 产物弹窗打开某个文件的 diff 之后，右上角的「关闭」整颗看不见、只露一条边；`j / k 换文件` 那行提示和白字计数的 `按 git 估算` 粘在一起；路径栏的「在查看器里打开」和路径文本叠在一起；没有基线时的说明文字从右侧被切掉半句（`F:/pi-web-client/.scratch/shots/bug-diff-overlap.jpg`）。

**根因（仿真实 DOM 的 harness 复现，不是推测）：** `.sheet` 是 `display: grid`，只写了 `grid-template-rows`（`web/src/styles.css:1485`），**没写 `grid-template-columns`** —— 那条隐式列按 `max-content` 定宽，标题栏的内容宽（title 333 + hint 240 + 关闭 60 ≈ 633）把列撑到 594px，比 `.sheet` 自己的 `width: min(560px, 100%)` 还宽，再被同一元素上的 `overflow: hidden` 从右边裁掉。实测：sheet 560 / head 594.1（右 955.1 vs sheet 右 920），`.sheet-head > .btn` 被 flex 收缩到 58.9×58.3（两字标签折成两行）。同类先例：D60 的 `.turn-list`、`.dir-list` 都是这个坑。

**修法：** ① `.sheet` 补 `grid-template-columns: minmax(0, 1fr)`；② `.sheet-head` 补 `gap: 8px`（title 与 `margin-left: auto` 的 hint 之间原来零间距）；③ `.sheet-head > .btn { flex: none }` —— 按钮按内容宽排，要收的是标题和提示，不让按钮折行长高；④ `.diff-hint` 补 `min-width: 0; overflow: hidden; text-overflow: ellipsis`，让它可收、收的时候出省略号而不是被裁。

**顺带把 diff 弹窗开到 920px（独立、可回退）：** 560px 扣掉 208px 左栏后每边只剩 ~130px，48px 行号 + 80px 代码，而 `.diff-text` 是 `white-space: pre` + `overflow: hidden`（不横滚）—— 左右对照在那个宽度下不成立，一行只能看十来个字。`@media (min-width: 760px)` 里给 `width: min(920px, calc(var(--vw1) * 94))`，窄屏仍是原来的全宽单列（`.diff-row` 在 ≤760 有 `min-width: 560px` 横滚）。用 `--vw1` 是为了跟 `#app { zoom }` 下的 UI 缩放对齐（同 `.ext-sheet` / `.mgr-sheet`）。

**验证：** harness `F:/pi-web-client-wt/fix-diff-sheet-overflow/.scratch/diff-overlap/repro.html`（链接真 `web/src/styles.css`，DOM 照 `web/src/app.ts:5744-5820` 拼）+ `check.mjs`（Playwright）：修前 1280 宽下 head 594.1 > 560、close 58.9×58.3、`在查看器里打开` 右缘 943.1 > 920；修后 360 / 420 / 560 / 640 / 760 / 800 / 900 / 1100 / 1280 / 1600 十个宽度全过 —— 关闭恒 60×38.1、head 不溢出不折行、按钮全在 sheet 内，<760 仍是 `x=0` 全宽。`node bridge/tests/whatsnew-ui.mjs` 全绿（设置页也是 `.sheet`，确认基础规则的改动没伤到别的抽屉）；`npm run build` 与 `npm run typecheck`（含 i18n-check）通过。

**可改：** 920 / 94vw 两个数是按「两列各 356px 能读 48 列左右」定的；hint 在窄一点的窗口会先出省略号，如果更想让它换行就换成两行 grid。

## D212 本机管理：独立控制台，读走 REST、DNS 写走 UAC 助手，公网只读打码

「pi 设置」旁边要能看这台机器，并且切 DNS，但不能再做成一页 pi 配置。DNS 是整机状态，改错会影响域登录、内网域名和 Jira；桥又常年以普通权限跑着。这个功能的关键不是把 `ipconfig` 画出来，而是把「谁能改、改之前存什么、失败怎么退」定死。

**决定**

1. **独立控制台，四个分区，C 布局。** 不从设置 sheet 里长 tab：DNS 影响整台机器，不该藏在「某个项目的 pi 设置」里。左栏概况 / 网络与 DNS / 端口与服务 / 服务，右栏内容；入口是「pi 设置」旁边的按钮 + `/sysmanage`。原型阶段比较过设置式页签、单页体检报告、双栏控制台，选 C 是因为它把「网卡列表」和「DNS 编辑」放在同一屏，切网卡不用滚动。代价是比设置页多一层导航；换来的是 DNS 的当前值、预设、应用按钮始终同屏。
2. **读走 REST，不新增 WS 协议。** 四个分区各自 `GET /api/sys?section=`，前端按 tab 懒加载。理由是这些是请求-响应式快照，没有服务端推送需求；WS 那条 `onMessage` 的 `switch` 已经很长，再塞四种子协议只会增加状态。缓存：network 30s、ports 10s、services 30s；DNS 改动后只清 network。
3. **采集选快路径，慢的靠缓存。** 概况用 Node 的 `os` + `fs.statfsSync` + 一次注册表（`DisplayVersion` / `CurrentBuild` / `UBR`）；网卡用 `Win32_NetworkAdapter` + `Win32_NetworkAdapterConfiguration`（冷 ~2.2s、热 ~0.9s），不用 `Get-NetAdapter`（1.4s）叠 `Get-NetIPConfiguration`（2.3s）；端口用 `netstat -ano`（123ms）+ `Win32_Process`（~1.1s）；服务用 `Win32_Service`（~1.5s，含 PathName）；防火墙读注册表三档 `EnableFirewall`（~0.4s），不用 2.5–4.7s 的 `Get-NetFirewallProfile`。网卡按 GUID 定位用 `Win32_NetworkAdapter -Filter "GUID='{...}'"`——`Get-NetAdapter` 没有 `-InterfaceGuid`，这条踩过。
4. **DNS 只改 IPv4，按网卡记原值，绝不自动回滚。** 预设 = 公司 172.28.1.23 / 阿里 / 腾讯 / 114 / Google / Cloudflare / 自定义；首次应用前把原值写进 `statePath("sysmanage.json")`（键是 InterfaceGuid），页顶常驻「原值已保存 + 恢复」。原值是 DHCP 时恢复用 `-ResetServerAddresses`，静态则写回保存的数组。不做「N 分钟后自动恢复」：改 DNS 的人通常要的就是一直用下去，倒计时会在开会/跑构建时突然把网断掉；也不做启动时自动回滚，只在页面上给一键恢复。代价是桥崩了原值仍在文件里，但不会自己动。
5. **写操作走一次性 UAC 助手，桥不常驻管理员。** 桥用校验过的值（GUID 正则、InterfaceIndex 整数、`node:net` 的 IPv4 校验、最多 3 个）生成固定 `.ps1` + 回执路径，`Start-Process powershell -Verb RunAs -Wait` 拉起；助手执行 `Set-DnsClientServerAddress` + `Clear-DnsClientCache`，把 `{ok, error, after}` 写成无 BOM UTF-8 JSON；桥 120s 超时，UAC 取消记 `uac_denied`。**不 detached**：Windows 的 `detached: true` 是 `DETACHED_PROCESS`，`Start-Process -Verb RunAs` 需要桌面会话，D52 已经踩过「静默成功但什么都没做」。每次应用都弹 UAC 是刻意的：DNS 是整机改动，必须有人在主机前点「是」。
6. **权限边界在桥端，不在 UI。** 本机/局域网沿用现有 WS 升级的预授权（`publicReq` 为 false 时 `stepUntil` 已给满）；公网（`cf-connecting-ip` / `x-forwarded-proto: https`）读也打码：主机名前 2 位、IP/MAC/网关/DNS、进程名/服务名与路径，桥在返回前就抹掉，不指望前端隐藏；DNS 写直接 403。公网端口/服务只回数量，不回明细。这样即使有人绕过页面直接打 API，拿到的也只是打码后的摘要。
7. **非 Windows 降级为只读。** macOS/Linux 只回概况与网卡（能读多少读多少），`supported: false`；DNS/端口/服务在界面上说明「暂不支持」，不伪造空表。第一版不写 systemd/networkd，也不碰 `/etc/resolv.conf`。
8. **「服务」单独一页，默认只看非 Microsoft 且运行中。** 端口页放对外监听 + 防火墙三档；服务页放可搜索的全量列表，带「显示 Microsoft / 含已停止」开关。Microsoft 判定看路径（`\Windows\`、`\Microsoft\`、`\WindowsApps\` 之外的 `microsoft shared`）与显示名前缀；没路径的当 Microsoft，避免默认列表被系统服务淹没。

**接口形状**

`GET /api/sys?section=overview|network|ports|services` → 对应的 `SysOverview` / `SysNetwork` / `SysPorts` / `SysServices`；公网时 `public: true`，字段已打码。`POST /api/sys/dns {guid, servers}` → `{ok, before, after, unchanged, saved, dhcp}`；同值回 `unchanged: true` 且不弹 UAC。`POST /api/sys/dns/restore {guid}` → `{ok, dhcp, before, after}`；没有原值回 404 `no_saved_dns`。错误统一 `{error, code}`：`dns_guid` / `dns_servers` / `adapter_not_found` / `uac_denied` / `uac_timeout` / `no_receipt` / `dns_failed` / `dns_state` / `public_dns` / `uac_busy`（原 `dns_busy`，见 D221）。

**验证**

`npm run test:sysmanage`（netstat 解析、网卡合并/掩码/默认路由、服务归类、DNS 预设与解析、端口/服务过滤、格式化）；`npm run typecheck`（含 i18n-check，新增文案 ×3 语）；`npm run build`；测试实例上四页签真数据 + 公网头打码 + 同值不弹 UAC；真实改 DNS 的 UAC 与恢复留本机手验（会动整机网络，不在自动化里跑）。

## D213 会话 / 待发图片都能点开看原图：快照只带 mimeType，字节按需走 `/api/session/image`

**问题：** 用户气泡里的图片只有一行「附 N 张图片」；待发弹层的缩略图是死图，想看大一点只能先发出去。会话快照里的 `images` 只有 `{mimeType}`（`bridge/src/items.ts` 的 `entriesToItems` 故意不带 base64），所以页面没有可显示的源。

**决定：**

1. **快照不塞图片字节。** 一个 4 MB 的截图变成 base64 会撑大每一页 `session` 帧，也会让 localStorage 草稿爆掉；只保留 `mimeType`，点开时单独请求。
2. **新 `GET /api/session/image?id=&item=&n=`**：`n` 必须是 ≥0 的整数（否则 400 `bad_image_index`）；`id` 找不到 404 `session_not_found`；条目/序号取不到 404 `image_not_found`；成功 200 带原始 `content-type`、`content-length`、`cache-control: private, max-age=31536000, immutable`、`x-content-type-options: nosniff`。
3. **读字节两条路。** 本次进程里发出去的 `user:N` 气泡，原图还留在 `Session.promptImages`（上限 40 条用户消息，`close()` 清掉），不必回读文件；落盘条目走 `loadEntryImage(file, id, n)`，用 `readline` 逐行扫、先 `line.includes(entryId)` 再 `JSON.parse`，不整文件进内存。
4. **页面**：`chat.ts` 的 `buildUserBody` 给每张图画 `.msg-image` 按钮（`loading="lazy"`），源由 `app.ts` 注入的 `setImageSource` 拼；点击派 `pi-image` 事件，`app.ts` 的 `openImage()` 在 `#app` 上盖一层 `.image-view` 灯箱（Esc / 点背景 / × 关闭，`z-index` 高于待发弹层）。待发弹层的 `.image-open` 按钮同样调 `openImage()`。
5. **取不到图的降级**：`<img onerror>` 移除按钮、回落到原来的「附 N 张图片」灰字；`imageSource` 返回空时也不画破图。

**为什么：** 图片是会话文件里最大的一块，快照的职责是「列出有什么」，不是「把所有字节送到页面」；按需接口还能让只读的休眠会话在没被打开时也看图（`locate(id)` 直接拿文件，不拉起 pi）。

**验证：** `npm run test:image`（`session-image-unit.mjs` 6 项 + `session-image.mjs` 9 项：列表、两序号字节/mime、越界 404、负序号 400、幽灵会话/条目 404、缓存头）；`npm run test:image:ui`（Playwright 11 项：气泡缩略图源是接口、点开 1×1 原图解码成功、Esc 关闭；合成 paste 后待发角标、弹层缩略图按钮、data URL 灯箱、× 关闭；真发出去后 `user:N` 从桥内存取图并解码；无页面异常）。`npm run typecheck`、`npm run build` 通过。

## D214 diff 弹窗：单边改动单栏铺满，hunk 头不再漏行

**问题：** 新建文件（整份都是 `+`）在左右对照里等于把右半屏复制成两半：左列只剩 48px 行号和一大片空白，代码挤在半屏，998 行每行只看得见十来个字。另外往下滚时，代码会从 hunk 头**上方**那条缝里露出来 —— `@@ -0,0 +1,998 @@` 头顶压着半行代码（穿模）。

**原因（穿模）：** `.diff-scroll { padding: 8px 0 24px }` 撞上 `.diff-hunk { position: sticky; top: 0 }`。sticky 的吸附矩形是**滚动容器自己的 padding box**，容器带内边距，头就停在 +8px，那一条 8px 永远露着下滚的行。跟 `backdrop-filter`、合成层都无关（都摘掉复现页照样漏）。

**决定：**

1. **整份改动只有一种行**（全是 `+`，或全是 `-`）时改单栏：一行「号 + 代码」，`grid-template-columns: 48px minmax(0, 1fr)`；号取存在的那一边（全新增用 `newNo`，全删除用 `oldNo`）。混着改的照旧左右对照 —— 有可比内容时才值得占两列。
2. **上下留白从滚动容器挪到内层 `.diff-pad`**：`.diff-scroll { padding: 0 }`，`.diff-pad { padding: 8px 0 24px }`。滚动容器没有内边距，sticky 头就贴着滚动口顶边，缝没了；静止时那 8px 呼吸感由内层给。

**为什么单栏按文件、不按 hunk：** 同一个文件里一半单栏一半对照，滚动时版面会跳；而「整份只有一种行」正好是唯一**没有对比内容**的情形（新建、纯追加、纯删除）。

**代价：** 单栏时行的横向空间比对照模式多一倍，长行省略号的位置随窗口变（本来就是 `overflow: hidden` 不横滚）；窄屏（≤760px）那条 `.diff-row{min-width:560px}` 横滚规则对单栏不再适用，显式 `min-width: 0` 取消，免得手机上每行都要横拖。

**验证：** 静态复现页（真 `web/src/styles.css`，900 / 1280 / 420 宽、`--ui-scale: 2`、`.diff-scroll.scrollTop = 140`）量 `hunk.top − scroll.top`：改前 8 / 改后 0，顶部不再有行露出；单栏文本宽度 636 里占 588（对照模式 270）；420 宽 `scrollWidth == clientWidth`（不横滚）；`npm --prefix web run typecheck`（含 i18n-check）、`npm --prefix web run build`。

## D215 历史分页只跟隧道连接走：本机 / 内网仍整段下发

**问题：** #218 为公网隧道把首帧切成末尾一页（`HISTORY_PAGE_SIZE = 60`）。#219–#221（2026-11-08，PR #228）把这条规矩扩展到分支切换、唤醒续接与重连，并且 `items` 帧整页替换，页面收到就 `chat.reset()`。结果本机也被切了页：切走会话再切回来，历史回到第一页，「载入更早」重新出现、还得再点一遍（#220 的验收项本来就这么写）。而本机实测一条 1267 条 / 2.6 MB 的会话：收帧 143 ms、DOM 稳定 1.3 s、最长一次任务 501 ms —— 本来就不慢，分页在那里只带来副作用。

**决定：**

1. **分页形状跟着连接走，不跟着会话走。** 认证层早就逐条判定过「这条连接是不是从隧道来的」（`isTunnelRequest`：`cf-connecting-ip` 或 `x-forwarded-proto: https`，结果记在 `publicReq`），`frameFor(client, payload)` 就照它整形：隧道连接原样（末尾一页 + `history`），其余把 `session` / `items` 帧的 `items` 换成整段、`history` 换成 `{hasMore:false, total}`。
2. **单播与广播同一处成形。** subscribe / claim / create / reload 四个 `session` 帧与分支切换那条 `items` 帧都过 `frameFor`；`broadcast()` 只序列化「整段」和「原样」两份字节，逐连接挑一份发，不按连接重复序列化。
3. **`PI_WEB_PAGE_ALL=1` 强制本机也分页**，给分页的两套 UI 用例（`test:history:ui`、`test:loadolder:ui`）和复现隧道行为用。
4. **前端一行不用改。** `hasMore:false` + 全量 `items` 就是 #219 之前的老形状，「载入更早」自然不出现；隧道上的分页、刻度带 ghost 刻度与点刻度自动往回翻（#242–#244）全部照旧。

**为什么按连接、不按配置 / UA：** 同一个人常同时开着本机标签页和公网手机；配置是全局的，而连接头是逐条的，认证层本来也依赖它判定公网请求。

**代价：** 本机的大会话仍是 1.3 s 的 DOM 稳定与一次 501 ms 长任务（用户接受：卡的不是网络）；`frameFor` 给每帧多一次会话查找，命中时是常数开销。

**验证：** `npm run test:paging`（`bridge/tests/paging-scope.mjs` 14 项：本机订阅 220 条整段 + `hasMore:false`、隧道 60 条 + `hasMore:true` + total 220、同一会话两帧 21 083 B vs 43 764 B、分支切换广播按连接分形状、本机任何帧都不出现 `hasMore:true`、隧道的 `history.before` 照旧翻页）；`npm run test:paging:ui`（`bridge/tests/paging-local-ui.mjs` 15 项，从页面这一层：开关不设 `PI_WEB_PAGE_ALL`，打开一条 220 条的会话帧里就是 220 条、110 轮一次画完、切走再切回仍整段且没有 `.chat-more`、断线重连不翻倍、全程 0 帧说「还有更早」）；`npm run test:history:ui`（28 项，`PI_WEB_PAGE_ALL=1`）；`npm run test:loadolder:ui`（63 项，同）；`npm --prefix bridge run typecheck`。`claim` / `reload` 两条单播起点是拉起 pi（`sessions.claim` / `sessions.reload` → `openLive`），不另起 pi 验；形状与 subscribe 共用 `sessionFrameOf` + `frameFor` 两处，subscribe 那条已盖到。

## D216 设置面板改成本机管理同构的 C3 控制台：表单为主、对照只读、保存走 diff（#282–#287）

**问题：** 老设置是 720px 弹层里 11 颗会换行的 chip，下面一长串表单；「全局」和「项目」是两个独立页，想看一个值现在从哪来要来回切页；默认值只以「（默认：…）」挤在标签里，项目没设置时输入框是空的，看不出会继承全局还是 pi 默认；窗口一窄，chip 换行、表单被压得很窄。旁边的本机管理已经是分组控制台，两个入口像两个产品（#282）。

**决定**

1. **选 C3 控制台，不选 C1 / C2。** 弹层换成 `.st-console`：顶部 eyebrow「pi 设置」+ 标题 + 当前设置文件路径 + badge，左栏两组（设置 / 系统）九项，右侧内容区，底部一行说明；「全局 | 项目」是设置页里的分段，不再是两个平级 tab。C1（表格里就地编辑）每改一格都要处理一次保存/确认，点得更多，而且表格本来是用来「看」的；C2（每行一个独立表单）多一层进出导航，也丢掉了旧表单的手感。C3 保留旧表单的肌肉记忆、迁移最小，用只读的对照表回答「谁在生效」；代价是改之前要先点回表单，但「点行回表单并聚焦」把这一步压成一次点击。
2. **表单为主，一行一个字段。** 每行标「覆盖 / 未设置」（全局页是「已设置 / 未设置」）；项目未设置时选项里写「继承全局 · X」或「继承 pi 默认 · X」，默认值灰字「默认 · X」；列表字段标「与全局合并」，全局独有的标「仅全局」，复杂对象提示用 JSON 编辑；高级项收进折叠的「高级」。JSON 编辑器一直保留，切到复杂对象时仍是唯一入口。
3. **对照只读。** 三列「设置 / 全局 / 项目」；生效格高亮并标「全局生效 / 项目生效」，未设置格 dashed；「只看项目覆盖」只把没有项目覆盖的行变暗（不删行），再点恢复；点任意行退出对照、回到表单、展开对应的「高级」、滚到中间并聚焦输入。对照是设置页的模式，换页或换 tab 就退出，不在别的页面上残留。
4. **保存单位是当前作用域的整张表单，实际只发 diff。** 打开/刷新时留一份快照，`diffPatch()` 只把与快照不同的键放进 `settings.set` 的 `patch`；模型是 provider + model 一对，任一边变了两个键一起发；清空写成 `null`（桥按删除处理），没动过的键一个都不写；没有 diff 时保存按钮就是 disabled（不再点了只闪「已保存」），有 diff 才可点。这取代了更早的「每格保存」偏好：用户接受「整表单 + 一次保存」，diff 是安全阀——表单动作只有一个，但不会把没碰过的键、以及别人并发改的无关键一起盖掉。代价是改一格也要走一次表单保存；同一个键被两边同时改仍是后写者赢，所以才有下面的外部更新提示。
5. **草稿与异常都按「不丢用户输入」处理。** 切全局/项目保留草稿；有脏草稿时外部推来 `settings.view` 不覆盖草稿，只提示「设置已从别处更新，保存会覆盖这些键」；`settings.set` 失败保留草稿并给红字；项目未信任时表单只读、保存 disabled、黄条给「去项目信任」，对照仍可看；settings.json 解析失败时红条 + 只留 JSON 编辑器，修好刷新回表单。刷新只重读、不写盘。
6. **导航合并但旧入口都还在。** 九项覆盖旧的 11 个 tab：设置组「全局与项目 / 项目信任」，系统组「登录·凭据 / 口令 / 扩展与 MCP / 子代理 / 通知 / 运行时 / 更新日志」；pi 更新日志与项目更新日志合成一个入口，页内用分段切。tab id 不动，所以命令面板、`/settings`、`/whatsnew` 和 `#/settings?tab=trust` 这类深链仍落到原来的页。
7. **窄窗口横排、Esc/关闭/刷新不变。** 900px 左栏变一行横排且内容区不横溢，640px 占满屏幕；`Escape`、关闭按钮、刷新按钮沿用旧行为。

**接口形状**

没有新的桥接口或 WS 命令：仍是 `settings.get` / `settings.set {scope, cwd?, patch?}` / `settings.error` 与 `trust.*`。新增的是前端纯函数 `web/src/settings-matrix.ts`（分组、生效值、placeholder、`diffPatch`）、`web/src/settings-console.css` 和 `web/src/app.ts` 里的控制台渲染；所有新文案走 `web/src/i18n/` 的 `tr("中文原文")`，en / ja 各一条。

**验证**

`npm run build`；`npm --prefix web run typecheck`（含 i18n-check，2003 keys × 3 langs）；`node web/tests/settings-console-unit.mjs`（19 项：分组、覆盖计数、生效值、placeholder、模型对、列表合并、diffPatch）；`node bridge/tests/settings-console-ui.mjs`（A–H：壳与九项、全局只写一个键、项目继承 + 覆盖、对照生效/过滤/点行聚焦、未信任只读、坏 JSON 只读、900px 横排、更新日志分段、Escape/关闭、外部更新与保存失败保留草稿、无 pageerror）；根脚本 `npm run test:settings`、`npm run test:settings:ui` 与上面两条单测同源。截图 `.scratch/shots/settings-console-form.png`、`settings-console-compare.png`、`settings-console-untrusted.png` 只给 PR 看，`.scratch` 不进产品包。

## D217 横条成员是 `inRow` 过滤器，空组可删（含目录组）；按目录新建时目录就是组的身份；双击标签就地改名

**问题：** 组多了以后横条放不下。只靠 `max` + `＋N` 能防爆，但用户没法把「最近不看、也不想它总占名额」的组从横条里拿掉；把组从 `order` 里删掉又会让左栏和横条的共用顺序失真。左栏这边，删除边界原本是「只有手建的空组能删，派生组一律不给删」—— 理由是派生组由 cwd 推出来，删了下次 `groupFor()` 又建回来，那是假动作。但只要会话都搬走了，一个空的目录组留在左栏里就是个死格子：点进去没有东西，也删不掉，只能等它自己消失（而它不会）。#274 要把这条边界改成「有会话才拦」。

**决定：**

1. **每组多一个 `inRow: boolean`，缺省 true。** 桥端 `WsGroup` 落库并在快照里下发；旧状态文件没有这个字段时读成 true，旧桥完全不发这个字段时网页按「全员都在横条里」处理。成员只是 `order` 上的过滤器，`order` / `max` 的语义不变。
2. **新消息 `ws.row { id, inRow }`。** 组不存在或 `inRow` 不是布尔就静默忽略；有效时写盘并广播整份 workspace 快照（与 `ws.rename` 同一条路）。页面不本地猜，等广播回来重画。
3. **模型多出两份输出：** `more`（成员里装不下的）+ `offRow`（不在横条里且没有临时占位的）+ `currentOffRow`（当前组自己不在横条里）。当前组被移出后仍占最后一格，横条总数永远不超过 `max`；它画虚线与名字划掉，和「装不下」区分开。因为这一格已经算 visible，`offRow` 不再收它，否则 `＋N` 会重复数。
4. **`＋N` 两段：** 左「装不下」点一行只切组，成员不变；右「不在横条里」点一行先 `ws.row true` 再切过去。当前组被移出后不进右段，用标签上的 ⊙ 放回。
5. **⊙ 是唯一主入口：** 悬停任意可见标签（包括当前组）出 ⊙，点一下移出横条并给带「撤销」的 toast；撤销只把成员放回，不改 `order`，所以回到原位置。左栏组头 ⋯ 的「在横条中」是同一动作的第二入口，只有新桥才出现（旧桥不画，不置灰）。
6. **拖拽只重排成员。** 带 `offRow` 时把可见段的新次序按原位置替换回整份 `order`，不在横条里的组一格都不动，避免拖一下把非成员从顺序里丢掉。
7. **`dropBlocker(group, sessions)` 只看会话数**（`web/src/wsmanage.ts`）：组不存在 → 「这个工作区不在了」（快照过期兜底）；有会话 → 拒绝；空组 → `null`，手动组与目录组一样。顺序是「不存在 → 有会话 → 空」，先说的那个才是真正的理由。
8. **拒绝原因按组类型分开**：手动组「这个工作区里还有 N 个会话，先把它们拖回工程或删掉」，目录组「这个工作区跟着目录走，不能删」。后一句从此不再是「空了也不给删」，而是解释「为什么带着会话删不掉」—— 派生组的归属由 cwd 决定，删了它，那些会话下一次还是会回来。
9. **会话数由桥数，页面只做投影。** `Sessions.dropWorkspace(id)` 用 `list()` 数 `ws === id` 的会话，再交给 `Workspaces.drop(id, sessions)`。不再用 `Object.values(overrides).includes(id)`：override 只覆盖「拖过的」会话，cwd 派生来的会话不在里面 —— 只看 override，带着会话删掉一个派生组，下一次 `groupFor()` 又把它建回来。归档的也算（它们不在左栏里，但组没了它们就没归属）。删成功时顺手清掉指向它的 override，不留悬空指向；`index.ts` 的 `ws.drop` 成功后除了 `workspaces` 快照，也广播一条 `sessions.list`（会话的 `ws` 可能跟着挪窝）。
10. **空组在组头标「空」**（`.ws-empty-badge`），与组里的「这个工作区里还没有会话。」那句话并存：一个是组头上的状态，一个是组里的解释。有会话时徽标根本不画，不需要额外同步。
11. **删除说明分手动组 / 目录组两句**（`dropHint()`）：手动组「只删这个空组，组里的东西一概不动」，目录组「只把这个目录移出列表，目录里的文件一概不动」。删组永远不动文件，这两句话得在点下去之前说清。
12. **删掉当前组就落到右邻**（`wsNeighborsAfterDrop(order, id)`：右邻在前、再左邻反过来，近的优先）。落点只认「这一组里有会话可开」的邻居；邻居全是空的就把左栏亮出来，至少别让人对着一个不属于任何组的会话发愣。当前会话要是已经跟着目录落进了别的组（`currentWsId()` 还答得出），页面本来就有归属，不硬切。
13. **`ws.create` 可带 `dir`，目录就是组的身份**（#278）：桥端 `Workspaces.createDir(dir)` 先 `stat`（读不了 / 不是目录 → 拒绝并说清路径），再把目录交给 `root` 缝（默认 `gitRoot`）解析工程根 —— git 仓库里的子目录与 worktree 都折进同一个主仓库，非 git 目录用自己的绝对路径。身份直接用现成的 `groupId(root)` 与快照里的组比，不另存一张「目录 → 组」的表：同目录永远不建第二个组；对着已有的组再建一次就把那组原样回给你（`created:false`）。大小写 / 双斜杠 / 尾斜杠由 `normalizePath` 归一，跳过这一层就等着出两个 `F:/app` 吧。
14. **新组 `inRow:true`、追加到 `order` 末尾、名字留空**（与 `create()` 一致）：名字空着就显示目录名，重命名照旧走 `ws.rename` —— 建组时不把目录名写死成一个改不掉的名字。
15. **`hello.caps` 下发能力表**（目前只有 `ws.create.dir`）：页面看到这条能力才把 ＋ 变成「挑目录」；旧桥没有 `caps` 就还是「空壳组 + 就地改名」，绝不摆一张按下去会坏的对话框。用能力表而不是版本号：桥以后可以只加能力。
16. **`ws.created { id, created }` 回执**：快照照旧先广播（所有客户端都看得见新组），这一条只回给发起者 —— 页面凭它切组，`created:false` 时补一句「这个工作区已经在列表里」。失败（目录读不了 / 桥拒绝）只回 `notice`：不广播、不落半个组、页面不切走。
17. **对话框两栏（原型 B）**：左栏=已有工作区（当前那个标「这里」，点一行 = 右侧目录跳过去），右栏=真目录浏览（复用 `mountDirPicker`，不再写第二套目录实现）。选到已有目录按钮变「带你过去」，不发创建；否则「就在这里新建」，建完直接切过去、不进改名态；脚注一句话说清这一下会发生什么。空组没有会话可开，切过去的表现是左栏展开并把那一行滚到眼前。
18. **`wsCreateAction()` / `groupAtDir()` / `cleanDirPath()` 放在 `web/src/wsmanage.ts`**（纯函数、可单测）：页面先用快照自己判断「这个目录是不是已经有组」，省掉一次注定被拒的往返；桥端仍然做最终去重 —— 客户端的快照随时可能过期。
19. **双击标签就地改名**（#277）：输入框是挂在 `body` 上的 `position: fixed` 浮层（`.ws-tab-rename-input`），几何由纯函数 `tabRenameBox()` 算 —— 贴当前标签下沿 4px，左右/上下都 clamp 进视口，最窄 160px。浮层不进标签槽，所以不推走整行、也不改行高；横条重画时按新标签位置再贴一次。
20. **两下规则**：一次双击里第一下照常切组，第二下才进编辑 —— 双击当前组时第一下是原地切组，直接进编辑；双击非当前组时第一下已经切过去，浮层出现时组一定已经是它。判定用 click 的 `detail` 加「上一次点击落在哪颗、隔了多久」，不另绑 `dblclick`：拖动过的那一下仍由 `tabDragMoved` 吞掉，4px 以内的点击照旧只切组。
21. **复用左栏的改名提交路径**：`renameIntent()` 判「没变 / 空串回落目录名」，`ws.rename` 走同一个 `act()` 队列；页面不做乐观改名，快照是唯一来源。桥对 `ws.rename` 没有回执，所以发出后等 1.5s 内的下一份快照：组没了 → toast「这个工作区不在了，名字没改」；组还在但名字不是请求值 → toast「改名没存下 · 还是原来的名字」。两种情况横条和左栏都保持原值。
22. **入口只在有横条的壳里**：B/C/D 不画横条，也就没有横条改名；左栏组头的改名与 `⋯` 菜单那条 rename 都保留，两条都发同一种 `ws.rename`。

**为什么：** 成员是「横条收哪些组」的过滤条件，不是第二套排序；把被移出的组留在 `order` 里，放回时才能回到原位置，左栏也不会因为横条开关而重排。左栏则是「我有哪些工程」的清点区，空着的格子要么能删、要么得说明为什么不能删；「派生组不许删」在会话都搬走之后就没有依据了 —— 用户要的是把这一项从列表里拿掉，而不是删目录。反过来，有会话的组一律拦在桥端：页面置灰只是提示，真正的边界不能靠 UI 自觉。

按目录新建同样踩在「组是从 cwd 推出来的」这条老地基上：`ensure()` / `resolve()` / `prune()` 都认 `groupId`，所以建组也用同一个身份函数，而不是另立一张映射（多一张表就多一处会不同步的真相）。对话框把「选已有组」和「选目录」摆在一屏，是因为用户此刻只需要回答一个问题：这个目录是新建，还是已经在了。

双击改名不改模型：名字仍住在组的 `name` 上，横条只是同一个 `ws.rename` 的第二入口；浮层挂在 `body` 上、不进标签槽，是「改个名字不该把整行标签挤走」的直接做法。两下规则判在 click 上而不是另绑 `dblclick`，是因为拖动也走同一条 pointerdown/click 链，再挂一个 `dblclick` 只会和拖动抢同一串事件。

**验证：** `node --experimental-transform-types bridge/tests/workspace-unit.mjs`（旧文件缺字段读 true、快照带字段、setRow 落盘/跨重启/不改 order/max；空目录组删掉后快照与 `order` 一起少一项、有会话的目录组仍拒且状态不动、删组顺手清 override）；`node --experimental-transform-types web/tests/wstabs-unit.mjs`（四份输出、当前组被移出仍 ≤ max、名额 0、旧桥 members 缺省、带 offRow 的拖拽保留非成员原格）；`node --experimental-transform-types web/tests/wsmanage-unit.mjs`（`dropBlocker` 四种组合与新旧桥识别、`wsNeighborsAfterDrop` 的顺序、`dropHint` 分得开手动组与目录组）；`probes/workspace-tabs.mjs`（悬停 ⊙、移出/撤销、两段托盘、当前组虚线占最后一格且 ＋N 不重复、刷新持久化、B/C/D 无 ⊙/托盘、旧桥回退；「空」徽标与空态并存 / 有会话时没有徽标、拒绝删有会话的组且不发 `ws.drop`、删空的手动组与空的目录组、刷新后不复活、删掉当前组落到右邻且不留空白页；#277 双击当前标签、浮层贴标签且不改行高、Enter/点别处保存、Esc 不改、空串发空名、非当前组两下规则、拖动不误开、桥拒收提示且保留原值）；`npm --prefix web run typecheck`（含 i18n-check）、`npm --prefix bridge run typecheck`、`npm run build` 通过；`probes/workspace-manage.mjs` 与 `probes/workspace-tree.mjs` 照旧全绿。#278 之后再加：`bridge/tests/workspace-unit.mjs` 的按目录建组段（大小写 / 双斜杠 / 尾斜杠去重、跨重启不新建、worktree 折回主仓库、非 git 目录的身份与追加 `order` 末尾、失败不动状态、并发只建一个）；`web/tests/wsmanage-unit.mjs`（`cleanDirPath` / `dirBaseName` / `groupAtDir` / `wsCreateAction`）；`probes/workspace-tabs.mjs`（两栏与「这里」、已有目录「带你过去」且不发创建、新目录建组后追加 order 并在横条里、不进改名态、`created:false` 的提示、失败只在对话框里说一声、旧桥退回空壳组）。#277 之后再加：`web/tests/wstabs-unit.mjs` 的 `tabRenameBox()` 五个落点（贴标签下沿、靠右往左挪、窄窗口缩宽、贴底翻到上方、极矮窗口仍留边）。

**代价 / 可改：** 桥侧的删除现在要先数一遍会话（`list()` 本来就每页都在跑，多这一次不贵）。派生组删掉之后目录还在，下一次有会话落进那个目录，组会重新出现 —— 这是刻意的，删的是列表项不是目录，也不做「删过的组记仇」那种黑名单。按目录建组多一次 `stat` + `root` 解析（可能起一个 git 子进程），只在用户按下按钮之后发生，不预热、不缓存目录身份。双击改名的浮层挂在 `body` 上、只在横条重画时重新贴位（单独缩放窗口要等下一次重画才对齐），换来的是它永远不参与 `.ws-tabs` 的布局；桥对 `ws.rename` 没有回执，页面只能盯着下一份快照，最坏 1.5s 才知道名字没存下 —— 这是不新增一条确认消息换来的。

## D218 顶栏 / 下沿 11 颗按钮可单独关掉：`chrome` 三态存桥端，`true` 是「显式显示」（#281）

**问题：** 顶栏常驻七颗（产物、终端、文件管理器、bug、内网通、随手问、Jira），输入框下沿常驻四颗（技能、扩展、文件、模型），今天没有任何减法手段。窄屏 390px 顶栏 `scrollWidth 400 > clientWidth 390`（D138）的解法是 560px 以下用 CSS 把「文件管理器」直接藏掉——用户既不能选择，也不能推翻。选择也不跟人走：换浏览器、换手机就从头开始。而「我每天用哪几颗按钮」和「我说什么语言、用多大字」是同一种东西——是「我是谁」，不是当前这一屏的临时状态。

**决定：**

1. **11 个稳定 id，写进状态、不是文案。** 顶栏 `artifacts` / `terminal` / `files` / `notes` / `peer` / `scratch` / `jira`；下沿 `skills` / `ext` / `attach` / `model`。`look`（Aa）与左右栏折叠**锁死**——Aa 是这张表的唯一入口，关了没有路回来。
2. **存储是一个三态字段，用「键在不在」表达第三态。** `ui.json` 里 `{ "chrome": { "terminal": false, "files": true } }`：键缺失 = 默认行为（11 颗全显示；560px 以下 `files` 照 D138 被 CSS 藏掉）；`false` = 隐藏；`true` = **显式显示**，窄屏也显示。这一条是整份设计的支点。
3. **不用「隐藏列表」。** `{ hidden: [...] }` 里 `true` 与「从没碰过」是同一种状态，于是「用户显式打开的按钮顶开窄屏」与「没人动过时行为不变」不可能同时成立。三态把「默认」本身变成可表达的状态，也让「全部显示」有一个正确写法：**删掉该组的键**，而不是写成 `true`（否则窄屏会被永久顶开）。未知 id 忽略、非布尔忽略、新按钮默认可见——以后加按钮不用同步改偏好文件。
4. **状态存桥端（`ui.json`），不放 localStorage。** `hello` 带 `ui`，改动走 `ui.set` 落盘后广播 `ui`，页面不本地猜。理由是这三态描述的是「我是谁」，刷新、换浏览器、换手机、局域网里另一台机器都该看到同一份。代价是**全桥一份**：局域网里任何人改了，所有客户端一起变，删掉 `ui.json` 就回默认——这是买「换设备跟着我」付的钱，不是缺陷。语言 / 字号继续留在浏览器本地 `pi.prefs`：那是「这台设备看着舒服」，与「我每天用哪几颗」不是同一层；本次不把语言 / 字号搬上桥。
5. **协议按 11 个 id 白名单。** `ui.set` 接受 `{ chrome: { [id]: boolean } }`：丢弃未知 id 与非布尔值，`undefined` 视为删除该键（所以「全部显示」与「回默认」能用同一条消息表达）。仍接受 `{ showExtButton }` 并映射进 `chrome.ext`；`hello.ui.showExtButton = chrome.ext !== false` 作为派生值，现有消费者不动。step-up 仍是 `ui.set` 的第一行：本机 / 局域网零摩擦，公网要口令。
6. **「开关优先」窄屏：D138 的 CSS 不动，只被覆盖。** 当且仅当某颗是显式 `true` 时，页面根元素带一个标记，样式表在那条 560px media **之后**追加一条覆盖规则把它顶回来。没人动过 → 根元素没有标记 → D138 原样。这样 390px 下 `files` 仍是「默认消失」，但用户在 sheet 里点亮它（写 `true`）之后就会留下。
7. **旧布尔偏好只迁移一次，之后不再落盘。** 读盘时 `chrome` 键存在（哪怕是 `{}`）就完全忽略 `showExtButton`；只有完全没有 `chrome` 的旧文件才把 `showExtButton: false` 读成 `chrome.ext = false`。写盘只写 `chrome`——否则旧键会像僵尸一样在用户重新打开扩展后又被读回来。**何时能删：** 等确认没有比新字段更老的桥在跑（`hello` 里没有 `chrome` 就是老桥），届时删掉派生值与迁移分支。
8. **可见性只有一份定义：一个纯函数。** 输入 `(id, chrome, ctx)`，`ctx` 只带「是否有当前会话」「是否窄屏」两件事实；顶栏装配、下沿装配、壳重画、sheet 的预览与方块都只问它，不各自拼条件。没开会话时产物 / 文件管理器不显示，与现有的「没会话不显示」叠加而不是替换。
9. **隐藏是真移除，不是禁用。** 不渲染、不占宽度、`title` 与 `aria` 不残留；不出现「⋯」兜底菜单，省下的宽度还给标题与 now-chip。手滑关掉仍有找回入口：`/terminal`、`/files`、`/artifacts` 三条斜杠命令；「外观与语言」底部的「恢复默认」**不碰** `chrome`（理由同它保住语言），回默认靠分组头的「全部显示」。

**被否掉的替代方案：**

- **隐藏列表 + 布尔「显示」**：见第 3 条，无法区分「显式显示」与「默认」，窄屏那条规则只能二选一。
- **存 localStorage / `pi.prefs`**：换浏览器、换手机就丢，正好违背这个功能要解决的问题；也做不到「一台改了另一台立刻跟着变」。
- **把语言、字号一起搬上桥**：那是更大的一次改动，而且语言 / 字号是「这台设备看着舒服」，与「我每天用哪几颗」不是同一层；本次只搬按钮可见性。
- **窄屏继续 CSS 硬藏 / 改成禁用**：CSS 硬藏是没有选择；禁用仍然占宽度，也没解决「想极简」和「手机上要留文件管理器」两种诉求。
- **收进「⋯」溢出菜单**：只是把拥挤换个地方，而且隐藏按钮的 `title` / `aria` 还会被焦点撞上。
- **排序 / 拖拽、预设档（极简 / 全开）、「全部隐藏」**：排序散在装配代码与四套壳的重画逻辑里，要先换成一张真正的顺序表才谈得上，是另一个量级，本次不做。

**验证（随 #281 的 #288–#293 落地）：** 纯函数表格（11 个 id 默认可见 / `false` 全藏 / `true` 覆盖窄屏 / 未知 id 与非布尔忽略 / 无会话时产物与文件管理器不可见 / `chrome.ext` 与派生值一致）；桥的 WS 协议（`hello.ui` 默认、`ui.set {chrome}` 落盘并广播、白名单、`undefined` 删键、旧 `showExtButton: false` 迁移、写过之后文件里不再有 `showExtButton`、公网 step-up）；页面探针（11 颗逐个关掉后 DOM 里不存在且 `scrollWidth` 变小、四套壳一致、预览与方块、390px 下 `files` 的默认 / 显式两档、三条斜杠命令、断桥置灰）。尺寸口径沿用 D138：390 / 560 / 620 / 1440 四档 `documentElement.scrollWidth == 视口宽`。
## D219 商店页重画：请求从渲染里挪出来，重画保存滚动与焦点（#310）

**问题：** 扩展商店与 MCP 商店的列表是「重画 = 重建整块 DOM」，而请求写在渲染函数里（`paintExtStore` / `paintMcpStore` 末尾 `if (items === null) send(...)`）。一次 tab 切换、每段库存推送、每次回包都会重画，于是：一次搜索发两个 `ext.store`，进一次 MCP 商店发五个 `mcp.store`；`storeHeader` 每次重画都用「上次发请求时」的文本覆盖输入框，在途时打的字被吞、光标被夹回旧位置；设置页那个宿主更彻底——`paintExtIfOpen` 对它只调 `paintSettings()`，滚动位置归零。另外 `checkPiUpdate()` 在 `paintPiUpdate → paintExtSettings` 内部同步调 `paintExtIfOpen()`，重入 `paintSettings` 之后外层继续往已脱离的节点 append，首帧出现两份开关与两份管理器。桥端 `searchMcp` 与 `mcpIndex` 各自 `readJson` 一遍索引（11.4MB / 21,108 条），每个查询两次同步解析，约 170ms 卡住事件循环。

**决定**

1. **渲染不发请求。** 请求只从一个地方出：`requestExtStore()` / `requestMcpStore()`，按 `(查询, 条数)` 在途去重，回包到达时清标记（清在 query 守卫之前——旧查询的回包也得结束它自己的请求）。渲染里的兜底变成调这个方法，语义是「打开时还没有东西可看」，不再每次重画都发一次。
2. **重画保存并恢复滚动、焦点与光标，两个宿主一起。** 弹窗滚在 `.settings-body`、控制台滚在 `.st-pane`（`.ext-host` 自己不滚），恢复顺序是**先 `focus({preventScroll:true})` 再设 `scrollTop`**——`focus()` 会把输入框滚进视口，反过来会把页面拉回顶部。这是「设置页以前完全没存」的补齐，不是新交互。
3. **请求期间不清空列表。** 清空后中间态只剩「查询中…」，面板变矮，浏览器的 `scrollTop` 被钳到 0；等到列表回来再恢复已经晚了（这正是旧实现恢复不了的根因）。代价是新查询的头几百毫秒里还看得见上一批结果——商店列表本来就是这个手感，比闪一下白屏好。
4. **paint 内部的重画断在微任务里。** `checkPiUpdate()` 里的 `paintExtIfOpen()` 改成 `queueMicrotask(...)`：调用栈上的那层 paint 先画完，再重画，就不会两次 append 到同一父节点。没有改成「不要再画」——`piChecking` 的状态徽标需要立刻反映。
5. **索引一次解析。** `readIndexDisk()` 按 `mtime + size` 记住解析结果，`mcpIndex` 接受调用方已经读过的索引（`preloaded`），写盘后失效；10 分钟没人用就丢掉，免得桥长期驻留 ~30MB 解析后的条目。
6. **「已安装」按 pi 记下的出处整词匹配。** 用 `version.identifier`（npx / uvx / docker 跑的那个包）与 `transport`，正则两侧要求词边界（前导集合里**没有** `/`，否则 `pkg` 会命中 `@scope/pkg`）。旧写法 `服务器名 + includes(identifier)` 靠 transport 里带着包名侥幸命中，同时会把 `exa` 认成 `exa-search` 装过。

**接口形状**

没有新桥命令：仍是 `ext.store` / `mcp.store` / `ext.inventory`。前端新增 `requestExtStore` / `requestMcpStore` / `mcpInstalled(identifier, haystack)`；`extStore`、`mcpStore` 各多一个 `inflight` 字段（不在 WS 消息里传）。桥端 `mcpIndex(force, preloaded?)` 多一个可选参数与 `readIndexDisk()` 缓存，`searchMcp` 不再自己 `readJson`。

**验证**

`npm run typecheck`（三个包 + i18n-check 2005 keys × 3 langs）；`npm run test:settings`（19 项）；`npm run test:settings:ui`（全绿）；新增 `npm run probe:extstore`（`probes/ext-store-paint.mjs`，桩桥 + 真 Chromium，商店回包故意延迟 700ms）：T6 边加载边打字、T1 在途打字、T7 一次搜索一个 `ext.store`、T3 进店一个 `mcp.store`、T4 装过的仍显示「已安装」、T8 弹窗滚动、T5 设置页首帧一份、T2 设置页输入/滚动/光标。同一探针在旧代码上跑出 5 条红（`agh` 吞字、2 个、5 个、两份管理器、滚动 60→0），新代码 11 条全绿；索引实测改后首次 267ms、之后 9–12ms。

## D220 部署时一次把依赖备齐：`npm install` 顺手装 pi 与三个扩展（用户要求）

> **D393 修订（2026-11-23）：** 第 2、3 点与「代价 / 可改」里那条「已装就不动、不升级不降级、页面上只说『比 x 旧，能用』」都已作废。清单里的版本现在是**下限**：没装就装它，低于它就升到它，等于或高于它一动不动；低于下限的包在启动关卡里跟「缺」同等对待。`pi-subagents` 从 0.86.0 推到 0.90.0，`MIN_PI_VERSION` 从 1.5.0 推到 1.6.0。下文其余部分（先查再动、按包名对、共用同一个判据、缺了要看得见、能关掉）不变。

**问题：** 这个网页有三块能力不在仓库里：设置→子代理直接读 `pi-subagents` 的会话目录（`bridge/src/subagents.ts`、`bridge/src/bgruns.ts`），网页问卷按 `@juicesharp/rpiv-ask-user-question` 的 rpc-fallback 对话框格式回填（`bridge/src/questionnaire.ts`），随手问的联网工具由 `pi-web-access` 提供。它们住在 pi 自己的全局目录（`~/.pi/agent`），clone 下来 `npm install` 拿不到 —— 于是同一份代码在两个人的机器上表现不同，而缺的那块通常只是**静默少一个工具**，不报错，也不在界面上说。

**决定：**

1. **在部署时装，不在启动时装。** 入口是仓库根的 `postinstall` → `scripts/bootstrap.mjs`，用户跑一次 `npm install`，再 `npm start`。桥每天开关，不在后台改用户的全局目录。
2. **装之前先查。** 先定位 pi（`resolvePi()` 的候选表，不是另抄一份）；低于 `MIN_PI_VERSION` 才 `npm i -g @earendil-works/pi-coding-agent@latest`；三个扩展问 `pi list` 的**用户级**包、按包名对（包名读各包自己的 `package.json`，读不到才按来源末段猜，所以 git / 本地路径装的同名包也算），有就一动不动 —— 不升级、不降级，哪怕比钉的版本旧（旧了只在页面上提示「能用」）。脚本与 `/api/deps` 共用这一个判据（`bridge/src/deps.ts` 的 `foundPackages`）：页面说 ✓ 的，脚本就不会再装一份同名扩展。`pi list` 跑不起来时这一轮不装扩展，宁可少装也不装重。预发布的 pi（`1.5.0-rc.x`）算低于 `1.5.0`。
3. **钉两个、放一个。** `pi-subagents@0.86.0` 与 `@juicesharp/rpiv-ask-user-question@2.15.0` 钉住，因为网页解析它们的目录布局与对话框格式；`pi-web-access` 不钉，只调它的工具。清单只有一处：`bridge/src/deps.ts`。
4. **装到用户全局**，效果等同用户自己 `pi install`；不写项目里的 `.pi/settings.json`（它只对 cwd 所在项目生效，桥会开任意工程的会话）。
5. **能关掉。** `PI_WEB_NO_AUTOINSTALL=1`、`--deps-only`、`CI` 三种情形只装子包的 `node_modules`，一行都不往全局写。
6. **缺了要看得见。** `/api/deps` 报「pi 够不够新 + 三个在不在 + 上次 `npm install` 的结果」，设置→「扩展与 MCP」顶部列出来并给一条可复制的命令；没装 `billion-context` 时设置→子代理的 `acp_delegate` 整片灰掉并说装法。
7. **pull 之后依赖变了，`npm start` 先拦下。** 日常启动只跑 `npm start`（每次都重新编译），不会再经过 `npm install`。所以 `scripts/build.mjs` 编译前把三个子包的 `package-lock.json` 和 `node_modules/.package-lock.json` 对一遍（可选依赖不算），对不上就列出来并让人先跑 `npm install`，而不是让 tsc / vite 报一句看不懂的 `Cannot find module`。

**为什么不在 spawn 时注入 `-e`：** 那条路要先判断包在不在、再拼路径，缺了就静默退化成「没有这些工具」，而且每个会话都要判一次；用户要的是「装一次，以后不管」。

**不碰的东西：** MCP 服务器（atlassian / browser-use）与本项目功能无关，不装、不改 `mcp.json`；pi 的鉴权与模型配置不动。

**代价 / 可改：**

- `npm install` 会往用户的全局目录写东西 —— 所以失败不炸安装，只把原因写进 `<状态目录>/bootstrap.json` 让页面说。
- 已装就不动，所以「钉版本」只对第一次安装生效：老机器上留着的旧版不会自己升，页面只说「比 x 旧，能用」。
- 三个包名 + 最低 pi 版本在 `bridge/src/deps.ts`、README 与测试里各出现一次；改版本要三处一起改。README 那张表下面与 `bridge/tests/deps-unit.mjs` 开头都写着「抄自 `bridge/src/deps.ts`」，`npm run test:deps` 会把 README 的表和清单对一遍，抄漏了就失败。

**验证：** `node scripts/bootstrap.mjs --check`（本机：pi 1.5.0，三个包已装，退出码 0）；`node scripts/bootstrap.mjs --deps-only`（不碰全局，三包依赖各跑一次）；`npm run test:deps`（纯函数与 `pi list` 文本解析）；`npm run test:deps:ui`（真桥 + 真 pi，两种状态各跑一次，含端口冲突与灰化）。

## D221 本机管理加「重启 WinNAT」：第二个 UAC 写操作，跟 DNS 共用助手与锁

**问题：** 用户桌面上有个 `netweb_restar.bat`（自提权 → `net stop winnat` → `net start winnat`），端口被 Hyper-V / WSL 保留、绑定报「访问权限不允许」时双击用。要把它挪进本机管理 → 网络与 DNS，不再靠桌面脚本。

**决定：**

1. **还是一次性 UAC 助手（D212 第 5 条），抽成通用 `runElevated(kind, body, failCode)`**，DNS 改动和 WinNAT 重启都走它；超时常量改名 `UAC_TIMEOUT`（120s）。助手 `.ps1` 只放 ASCII：桥写的是无 BOM UTF-8，Windows PowerShell 5.1 会按 ANSI 读，中文会乱码；中文提示由桥按 `code` 拼。**以后新加的提权脚本照此办理**——条件：脚本交给 `powershell.exe`（Windows PowerShell 5.1）跑、文件无 BOM。若哪天改成带 BOM 写入或改用 `pwsh` 7（默认 UTF-8）可以放宽，但脚本只回 `code`、文案由桥拼的分工照旧，便于 i18n。
2. **一把锁 `elevatedBusy`**：同一时刻只弹一个 UAC，DNS 和 WinNAT 互斥，统一错误码 `uac_busy`（原 `dns_busy` 废弃）。
3. **结果与 .bat 对齐：** 原本在跑却停不下来 → `winnat_stop_failed`（.bat 里随后的 `net start` 会因「已启动」报错）；原本没在跑 → 只启动，回 `wasRunning:false`，页面如实说「只是启动了它」，不假装重启过；启动失败 → `winnat_failed`。
4. **停止带 `-Force`，但事先记下在跑的依赖服务，WinNAT 起来后逐个拉起**；拉不起的名字回 `depsFailed`，页面提示。停、启各 `WaitForStatus` 30 秒，整体落在 `UAC_TIMEOUT` 内，避免「桥超时放锁、助手还在跑」。
5. **失败也清缓存、页面也重读**：停下来却没启动成功时，卡片得显示真实状态（`Stopped`），不能停在 30 秒缓存里的「运行中」。
6. **状态一起读**：`SysNetwork.winnat = {status, start} | null`，在读网卡那一次 PowerShell 里顺带 `Get-Service winnat`，不多起进程。页面上服务状态/启动类型走 `serviceStatusLabel` / `serviceStartLabel` 翻译。点按钮先 `confirm`：会断几秒 WSL / Docker / Hyper-V NAT 网络。

**接口：** `POST /api/sys/winnat/restart` → `{ok, wasRunning, depsFailed, winnat}`；公网 403 `public_winnat`。新增错误码 `public_winnat` / `uac_busy` / `winnat_failed` / `winnat_stop_failed`；`uac_denied` / `uac_timeout` / `no_receipt` / `unsupported_platform` 的 en/ja 文案改成不点名 DNS 的通用说法。

**验证：** `node bridge/tests/sysmanage-unit.mjs`（`normalizeWinnat`）、`node web/tests/sysmanage-unit.mjs`（状态文案）、`node bridge/tests/sysmanage-ui.mjs`（卡片 + 按钮、公网 403、network 带 winnat）；助手脚本非提权干跑（停止那步按预期回 `winnat_stop_failed`）。真点 UAC「是」重启留本机手验——会动整机 NAT 网络。

## D222 已确认的工作区删除：会话进垃圾箱，恢复时还原工作区

**问题：** D217 将「有会话的组不能删」作为桥端边界，并明确删组不动文件。新的工作区删除流程需要允许用户在确认后删除有会话的组，同时保留可恢复性。

**决定：** 确认框列出工作区当前的会话，桥端校验确认时的会话 ID 列表仍与实际成员完全一致；确认后将会话移入垃圾箱，只有所有成员都成功移入后才删除工作区，任何会话无法移入时保留工作区。每个垃圾箱条目记录工作区快照与原顺序，恢复会话时重建工作区、成员关联与顺序；没有文件的空会话仅在这条工作区删除路径中先生成可恢复的会话头文件。普通会话删除沿用原语义，旧客户端的 `ws.drop` 仍只允许删除空组。本条只取代 D217 对「有会话的组」的删除限制，D217 其余决定不变。

**为什么：** 用户要移除的是工作区列表项，而不是永久丢弃其中的会话；将会话和工作区关系一并放进垃圾箱，才能在恢复时还原原来的工作区身份与位置。桥端核对确认时的成员快照，可避免用户确认后成员已变化仍误删。

## D223 执行面板的计划来源选 `@juicesharp/rpiv-todo`，不自建工具

**决定：** 执行面板从市场扩展 `@juicesharp/rpiv-todo` 的 `todo` 工具结果读取 `details.tasks`，桥随会话帧与计划帧转发快照；不另造计划工具、不加提示词或规划开关，上线后观察扩展默认行为。扩展固定为 2.15.0，并进入 D220 自动安装清单。

**为什么：** 这是已有成熟扩展，而且作者已在 D220 清单中；它把完整任务快照保存在当前会话分支里，能随 `/reload`、`/resume`、`/tree` 与压缩重放，不需要桥另建一份计划状态。复用同一快照可让网页只读呈现，不为计划再引入另一套真相。

## D224 `npm start` 先确认 pi 扩展齐了，缺了就拦下（用户要求）

**问题：** D220 只在 `npm install` 时装扩展，`npm start` 只核对子包的 `node_modules`。清单里新加一个扩展（D223 的 `@juicesharp/rpiv-todo`）后，pull 完直接 `npm start` 一声不吭，缺的功能只在网页的设置页和执行面板里才看得到。

**决定：** `npm start` 第一步跑 `node scripts/bootstrap.mjs --start`：pi 找不到 / 太旧、或清单里有扩展没装，就列出缺什么、提示先跑 `npm install`，退出码 1，不编译不启动；都齐了直接往下走。判据与 D220 相同（`pi list` 的用户级包，按包名对，版本旧不算缺）。`--start` 什么都不装，也不写 `bootstrap.json`。

- **记住「齐了」。** `pi list` 要把 pi 整个加载一遍（本机约 18 秒）。结论存在状态目录的 `start-check.json`，键是 pi 的位置与版本、清单、pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可换）及其 `settings.json` 大小与修改时间（`pi install` / `pi remove` 都会改它）；键不变就跳过。只记「齐了」，缺东西时每次都重查。
- **查不了不挡人。** `pi list` 跑不起来时只打一行 ⚠，照常启动，免得 pi 自己的毛病把桥也拖住。
- `PI_WEB_NO_AUTOINSTALL=1` 时 `npm install` 不会装扩展，所以改给手动 `pi install …` 的命令（只列缺的）；`CI` 下整段跳过。

**为什么拦而不是只提示：** 用户要求「没装就提示先执行 npm install，装了才直接启动」；缺扩展时网页是静默少功能，拦在启动前最不容易被忽略。

**不管的：** bridge-update 技能的 `restart.mjs` 自己跑 `npm run build` 再起进程，不经过 `npm start`，这一查不覆盖它。

**验证：** `npm run test:start-check`（桩 pi：齐了放行并记住、缓存命中不再跑 `pi list`、`settings.json` 变了重查、缺扩展拦下且只列缺的、缺了不记缓存、关自动安装只给缺的 `pi install` 命令、换 agent 目录重查、`pi list` 失败照常启动、pi 太旧拦下）。

## D225 设置抽屉分成「外观」与「连接与设置」两页，入口从 `Aa` 换成一枚齿轮（用户要求）

**问题：** 右栏（「需要你 / 执行」）底下挂了三组跟排队毫无关系的东西：通道（Web Push / 发测试通知 / 公网隧道）、快捷键（含 pi 设置、本机管理）、关于（一行 11px 的 `pi · bridge · 会话目录`）。它们是设置，却占着唯一那个「等你的事」面板的版面：有批准卡时三组按钮被挤到下面，没等你的事时那一栏一半是空的设置。

**决定：** 三组整体搬进顶栏那颗抽屉，抽屉从「外观与语言」改名「设置」，标题后紧跟两枚页签 `外观` | `连接与设置`（chip，不另起一行，390 宽与 en / ja 都放得下）；右栏的三组连标题一起删掉，只剩「等你批准 / 待办 / 执行」。

- **入口是齿轮，不是 `Aa`。** `⚙`（U+2699 + U+FE0E，单色字形）16px —— 13px 在这个等宽字体里糊成一圈。抽屉已经不只管字号，`Aa` 名不副实；`data-act` 仍是 `look`，快捷键面板里那条动作名跟成「设置：外观 / 通道 / 快捷键」。抽屉预览里的那颗占位方块同理（`⚙ 关不掉`）。
- **标题与页签钉住，只有页自己滚。** 外观页本来就长，整块滚的话翻到底想换页得先滚回顶上：`.sheet.display-sheet` 由 grid 改 flex 列，`.set-page` 吃剩下的高并 `overflow-y: auto`。
- **停在哪页记进 `pi.prefs.settingsTab`**（`"look"` / `"conn"`），下次打开还是那页。「恢复默认」不碰它 —— 和语言一样，那是「我的选择」，不是被重置的样式。
- **关于 = 两行可点复制**（版本 `pi x · bridge y`、会话目录），贴在「连接与设置」页底。以前是一行不能选中的小字，报问题时得手抄路径。
- **通道搬走后重画点跟着走。** 以前隧道点完靠 `renderQueue()`；抽屉不在那条路上，改成隧道回包后 `renderTop() + paintConnPage()`，抽屉没开时后者直接返回。

**代价：** `.sheet` 高度是自适应的，连接页比外观页短，切页签或从别的入口进来时抽屉会跳一下高度（内容撑多高就多高）。没加 `min-height` 兜：真加固定值，窄屏和小窗里反而会空出一块。

**i18n：** 新键 9 条（含 `设置`）。en 的「连接与设置」译成 `Channels & hotkeys` 而不是 `Connection & settings`：后者在 390 宽会折成两行，把标题栏撑高一倍（页签已加 `white-space: nowrap`，折行会改成裁切，更糟）。顺手修了 `"设置": "Set"` 这条错译 —— 仓库里四处 `tr("设置")` 都是名词（导航标签、作用域分片），英文里被译成了动词。

**验证：** `npm --prefix web run typecheck`（含 i18n-check，2196 键 × 3 语言）；`probes/run-all.mjs --only chrome-topbar,chrome-bottom,chrome-sheet,chrome-narrow,workspace-layout,workspace-settings,a11y-workspace` 7/7 通过；独立实例实测：左上右栏无「通道 / 快捷键 / 关于」标题、抽屉标题「设置」、两页签可切、滚到底标题仍在视口、重开仍是上次那页、复制写进剪贴板（回读 `pi 1.5.0 · bridge 0.1.0`）、en + 390 标题行不溢出（`scrollWidth == clientWidth`）。

## D226 找 pi 的候选表按平台补全；npm ≥ 12 拒 remote 取包时只放开这一次调用

**问题：** macOS + nvm 上 `npm install` 会在 postinstall 里报「pi 装不上」然后整段失败，可 `pi --version` 明明是 1.5.2。三处拼路径的错叠在一起：POSIX 的全局包在 `<node 前缀>/lib/node_modules`，候选表写的是 `bin/node_modules`；`npm root -g` 返回的已经是 `node_modules` 那一层，再拼 `node_modules/...` 就成了 `node_modules/node_modules/...`；`bin/pi` 是软链，`statSync` 跟到 bundle 上（> 1 MB）就把这条候选整个跳过。三处都不报错，只是「假装机器上没装 pi」——于是去重装，而重装又撞上 npm 12 的 `allow-remote=none`（registry 被指到 `http://` 镜像、包地址是 `https://`，npm 把包当成「remote」拒掉），看到的只有一句 `EALLOWREMOTE`。

**决定：**

- **POSIX 单独一条前缀候选**：`<execPath 的祖父>/lib/node_modules/<pkg>`；再按 `$NVM_DIR/versions/node/v*`（没设就是 `~/.nvm`）从新到旧各补一条 —— 跑桥的 node 未必是装 pi 的那个版本。Windows 的 `%LOCALAPPDATA%\nvm`、`%APPDATA%\npm`、`%ProgramData%\npm` 照旧。
- **`npm root -g` 只拼包路径，不拼 `node_modules`**。这条以前在哪个平台都没命中过，纯属白跑一次 npm。
- **启动器先看是不是软链**：是就跟 realpath，结尾是 `cli.js` 就用它；不是才当脚本读（`pi.cmd` 里写着真路径）。跳过只看**启动器自己**的大小（`lstatSync`），不跟到目标上去。
- **`EALLOWREMOTE` 只放开这一次调用**：重试一次 `npm install -g … --allow-remote=all`，**不改用户的 `~/.npmrc`**。还是失败就把「把 registry 换成同名 https 地址」写进错误里，别让人对着 `EALLOWREMOTE` 猜。

**为什么改候选表而不是让用户手工 `pi install` / 设 `PI_BIN`：** 桥自己也用同一张表（`resolvePi()`），表错了这台机器上 bridge 连 pi 子进程都起不来；`PI_BIN` 是兜底，不该拿来当日常方案。

**代价：** `piCandidates()` 多了一个可选入参（`PiProbe`），测试可以喂假环境，不用真 fork npm、真读 bundle。POSIX 上 `bin/node_modules` 那条候选去掉了（本来就只在便携版 Windows 有意义）。

**验证：** `npm run test:pi`（POSIX 前缀、nvm 多版本、`npm root -g` 不重复拼、软链启动器、`pi.cmd` 里的路径、`PI_BIN` 优先、`readVersion` 上溯三层）；本机（macOS + nvm）`resolvePi()` 由抛异常变成 `1.5.2`；`node scripts/bootstrap.mjs --check` 从「找不到 pi」变成「✓ pi 1.5.2」；`tsc -p bridge/tsconfig.json --noEmit` 通过。

## D227 聊天记录里一轮的计划更新折成一张卡（用户要求）

**问题：** 每调一次 `todo`，聊天里就多一张「计划 x/y · 完成「…」」的窄条。八项的计划要更新七八次，记录里就挂七八条，把正文挤出去；而这些中途快照在右侧执行面板里本来就有对应的计划与步骤。

**决定：** 同一轮（两条用户消息之间）的所有 `todo` 调用在聊天里只占一张卡：主行显示最新快照，右边 `▾ N`（N > 1 才出现）展开这一轮的每次更新（时间 / 动作 / 记号）；主行仍是「点击查看执行面板计划」。换轮（`user` 消息）与 `reset()` 另起一张；往前翻历史（`prepend`）时旧轮各自成组，不并进当前这张。

**为什么折而不是删：** 中途快照能说明「计划在第几步变的」，删掉就只剩最终态；折起来保留这份证据，又只占一行。默认收起，扫读成本与一张卡时相同。

**代价 / 可改：** 展开记录不做虚拟滚动，一轮更新特别多（几十次）时这张卡会很高；真碍事就只留最近若干条。记号与执行面板同一套（✓ / ◌ / ○），聊天里不显示归属步骤数。

**验证：** `npm run test:exec-panel:ui` 的 PLANLOOP 场景（一轮三次 `todo`）：只出一张卡、主行是最后一次快照并带「3 次更新」、更新默认收起、展开后三行按时间顺序、单击主行仍打开执行面板；单次更新的轮次不出现展开钮。

## D228 「现在」卡里的长参数默认压成一行（用户要求）

**问题：** 「现在」卡把在途工具的完整参数直接摆出来：子代理那一行是整段任务描述（几百字），`ask_user_question` 是整段 JSON，一张两行的卡被撑成一屏。它上面是计划列表、左边是正文，这块恰恰是谁都不看的。

**决定：** 参数超过 80 字符的现在行，默认只占一行（省略号），行尾给一个 `▾`；点开在行下铺 `<pre>`（最多 180px，内部滚动），再点收起。展开状态按「工具名 + 参数全文」记住，同一工具在一轮里反复出现时不会自己收回去。

**为什么不是整卡折叠：** 工具名和耗时才是这张卡的信息量（谁在跑、跑了多久），该折的是参数正文；整卡折掉「现在」就没有意义了。

**代价 / 可改：** 80 字符是拍的值（一行大约放得下 60–80 个西文字符），阈值与 `<pre>` 高度都可改。参数带密钥时展开就是明文——与改动前一样，只是不再默认摆出来。

**验证：** `npm run test:exec-panel:ui` 的 NOWARGS 场景（在途 `ask_user_question`，参数是一段 24 次重复的长文本）：默认一行（高度 ≤ 1.5 倍行高且内容溢出）、按钮在且 `aria-expanded=false`、没有 `pre`；点开后全文（>120 字）出现在 `.exec-now-args`、`aria-expanded=true`；再点收起。

## D229 网页会话再挂一段「计划维护」提示词：D223 的观察结果出来了，模型不更新计划

**问题：** D223 把执行面板的计划来源定为 `@juicesharp/rpiv-todo`，并明确「不加提示词、上线后观察扩展默认行为」——理由是扩展自己已经在 `promptGuidelines` 里写了「开工前标 `in_progress`、完成立刻标、不许批量收尾」（`@juicesharp/rpiv-todo/todo.ts:58-68`），pi 会把它拼进系统提示（`pi-coding-agent/dist/core/system-prompt.js:31-64`），再写一遍是重复。

观察结果不算好：2026-11-10 的会话 `38bae779`（cwd `F:\pi-web-client`，deepseek-v4.1-flash）里，`todo create` 建了 8 项、全 `pending`，之后跑到开好 PR #338，中间又发了 **99 次工具调用**（bash 79 / read 10 / edit 5 / write 2 / compress 3），`todo` 更新 **0 次**；右侧面板于是全程 8 行 ○、每项 0 步。全机 357 个会话里 3 个用过 todo，全是单次 `create`（5 / 6 / 8 项），`update` 一次都没有。

**决定：** 网页会话 spawn 时再追加一段 `PLAN_HINT`（`bridge/src/delivery.ts`，`bridge/src/sessions.ts` 里 push），排在交付提示词之后；`PI_WEB_PLAN_HINT=0` 可关，与 `PI_WEB_HINT` / `PI_WEB_LESSONS` 各自独立。

- **讲机制，不只喊纪律。** 扩展那段是抽象要求（「记得更新」），这段先说清「面板读的是你最近一次 `todo` 快照，不调用它就一直停创建时的样子」，再给三条硬约束（开工前 `in_progress`、做完立刻 `completed`、不批量补；计划本身变了当场改）。弱模型不照做往往不是忘了规则，是没建立「不更新会怎样」的因果。
- **允许不建计划。** 提示词第一句就是「要么别建计划」，宁可没有计划，也不要一屏停在 0/N 的假进度。
- **只对网页会话生效。** 终端里没有这块面板，不该替用户的教育模型多付 token；代价是同一工作区里两边行为不一样，README 的环境变量表与这一段说明里都写清楚。
- **仍然可能被无视。** 提示词不是机制，模型照样可以不遵守；这次先用真会话复验，不行再往下走选项 B（面板如实标注「计划未更新」）。

**不管的：** 不从工具调用自动推断任务完成（会造假进度）；不改扩展包（vendored 依赖，升级会覆盖）；不改现有 UI 呈现。

**可改的：** `PLAN_HINT` 的措辞、行数、是否按模型/供应商分流；开关名。若复验发现无效，删掉这段与开关即可回到 D223 的状态，不影响数据结构。

**验证：** `node bridge/tests/hint-spawn.mjs`（20 项：三段 argv 与顺序、三个开关各自只关自己那段、计划提示词含机制与三条约束）；`npm run test:exec-plan` 不受影响。

真会话复验（同一个模型 `cn:deepseek-v4.1-flash`、thinking `max`，测试桥 17864，不是 7864）：给一个三步任务，模型 `todo create` 建了三项，随后 **19.3s → 39.7s 之间推了 7 帧 `plan`**：`0/3 pending` → `0/3 in_progress` → `1/3` → `1/3 + 第二项 in_progress` → `2/3` → `2/3 + 第三项 in_progress` → `3/3`，会话里 `todo` 调用 7 次（create + 6 次 update）。对照组 `38bae779`（无这段提示词）：create 之后 99 次工具调用、0 次 update。同一根因、同一个模型，差别就在这段提示词。

## D230 计划跟不上时：面板照实标「可能过期」，另加一个默认关的「停下前核对计划」

**问题：** D229 的提示词对强模型也不够。2026-11-11 的会话 17850（`ce57f425`，cwd `C:\api`，claude-opus-5.5，bridge `e23e7fa` 已带 `PLAN_HINT`）在第 23 轮 `todo create` 4 项、把第 2 项标成 `in_progress` 之后，又调了 **82 次工具、停下 6 次**，计划一次没动；活其实全做完了。面板于是一边写「空闲 · 全部成功」，一边写「现在 · 计划 2/4 · 搭 skill 目录与通用脚本」，自相矛盾。长回合（中间多次等后台任务、被通知唤醒）里提示词会被淡忘，光靠提示词管不住。

**决定：** 两层，都不从工具调用推断任务完成（D229 的底线不变）。

- **B 面板照实说（总是开）。** 桥在计划快照上记 `sinceUpdate`：这份快照之后又调用了几次别的工具（`bridge/src/execplan.ts`，回放与实时同一口径；实时只在 `agent_settled` 推一帧，不每个工具推）。页面在**会话空闲、看的是当前计划、还有没关的项、`sinceUpdate ≥ 5`** 时：计划框里加一行「可能过期：上次更新计划后又调用了 N 次工具」，进行中那项不再转圈，「现在 · 计划」改成「最后记录 · 计划」，并给一个「让 agent 同步计划」按钮（发一句固定指令，走「继续」同一条路与连点保护）。跑着的时候不判：一步本来就可能很长。
- **A 停下前核对（设置开关，默认关）。** 新扩展 `bridge/ext/plan-nudge.ts` 挂在 pi 的 `agent_before_settle`：开关开、本次运行正常结束（`outcome === "completed"`）、能续跑、计划还有没关的项、上次更新后 ≥ 5 次别的工具、这份快照之后还没提醒过 → 追加一条 `display:false` 的 `custom_message` 并 `continue: true`，让模型只用 `todo` 对齐计划。
  - **为什么挂在 `agent_before_settle` 而不是桥补发一条用户消息：** 不新增用户回合（轮次编号、会话树、「需要你」与完成提示音都不动）；桥只认 `agent_settled` 为空闲，续跑在同一段「运行中」里；用户中断时 pi 自己丢掉续跑。`display:false` 的条目桥本来就不画（`customMessageItem`）。
  - **为什么默认关、放进设置：** 剩下的风险没法靠机制消掉——模型可能借机接着干活，或为了交差把没做完的项打勾；每次多一次完整上下文请求。措辞上已明确「只对齐事实、没做完的保持原状、不接着干」，先让用户自己选择开。
  - **开关：** 全局 `settings.json` 的 `web.planNudge`（设置 → 工具与脚本 →「停下前核对计划」，`globalOnly`）。扩展每次停下现读，改了立即生效；路径由桥经 `PI_WEB_SETTINGS_FILE` 给，以桥的 `agentDir()` 为准。读不到 / 坏 JSON / 不是 `true` 都按关。只认全局：项目级还要过信任判定，不值得为一个开关在扩展里重做一遍。
  - **只提醒一次：** 提醒本身作为 `custom_message`（`pi-web-plan-nudge`）记进会话；同一份计划快照之后已经有它就不再提醒，进程重启也不重复。模型更新了计划才重新计数。

**不管的：** 不自动替模型改计划；不按模型分流门槛；终端会话不受影响（扩展只在网页会话里 `-e`）。

**可改的：** 门槛 5（`PLAN_STALE_TOOLS` / `NUDGE_MIN_TOOLS` 两处一致）；提醒措辞；观察一段时间没有乱打勾再考虑默认开。

**验证：** `node bridge/tests/plan-nudge-unit.mjs`（30 项：开关各种读不到都算关；没计划 / 全关 / 不到门槛 / 已提醒 / 中断 / 出错 / 不能续跑都不续跑；条件满足时追加 `display:false` 提醒、`continue:true`、保留前面处理器的 entries；桥的 `sinceUpdate` 回放与实时计数）；`web/tests/exec-view-unit.mjs` 新增过期判定（门槛、全关、运行中、历史轮都不报）。

## D231 问卷到达时自动切到「需要你」标签，答完还原（#359）

**决定：** 当前会话收到 `ask.add`，或快照恢复出待答问卷时，若当前不是窄屏且内层标签不在「需要你」，自动切到「需要你」并记住切换前的标签。用户手动点任一内层标签就清除这次切换记忆；现有问卷数量变化不会重新触发自动切换，直到下一份新问卷到达。最后一份问卷结束后，且没有待批准项时，自动还原记住的标签。内层标签状态是内存状态，自动切换不写 `localStorage["pi.queueTab"]`，该存储仍只记录用户点击。窄屏不自动切换，也不自动还原；跨回宽屏后按当前待办数量重算。

**状态机：** `web/src/ask-tab.ts` 以纯 reducer 管理 `tab`、`recall` 及当前 `asksCount` / `approvalsCount`。问卷事件用 `arrived` 区分新问卷到达与单纯数量变化：`ask.add` 和快照落地可触发自动切换，`ask.remove` 只更新数量；审批到达本身不切换。还原统一要求 `asksCount === 0 && approvalsCount === 0 && recall !== null`。因此问卷先结束但仍有批准时先留在「需要你」，最后一张批准卡也结束后才还原，避免把用户留在已空的「需要你」页。

**为什么：** 问卷到达时，用户可能以为 AI 还在运行，看不到任务正等自己确认；自动切换只改内存、不改偏好，用户手动点击始终优先。窄屏没有内层标签条可供自动切换，因此以执行页顶部提示条告知待答题。

**代价 / 可改：** 删除未读取的自动切换标记后状态机更小；提示条会占用执行页顶部一行；角标超过 9 显示 `9+`。窗口从窄屏变宽时，若用户仍停在执行页且有待答问卷，会按当前待办重新计算并切到「需要你」。

**验证：** `npm run test:ask-tab`（纯状态机：到达与仅数量变化、手动切换、清空还原、待批准、窄屏、快照重放、多份问卷 recall）；`npm run test:ask-tab:ui`（隔离 bridge + fake pi + Chromium，DOM 检查自动切换、作答还原、手动选择不被抢回）。

## D232 「现在」卡的长参数、子代理步骤详情改成点开弹对话框，不在栏里展开（用户要求）

**问题：** D228 给「现在」卡里的长参数加了一行省略号 + `▾`，但点开是把 `<pre>` 铺在行下（`max-height: 180px` 只是内部滚动）。执行面板只有一栏宽，一张 `worker` 行的任务描述展开后整张卡就变成正文，下面的数字、时间线全被顶走；而且这个展开状态没有「这一屏我只是想看一眼」的退路。

**决定：** 参数正文不再进栏。`execActiveTool()` 里参数超过 80 字符时，整行本身变成按钮（`aria-haspopup="dialog"`、行尾一个 `⤢`），点击打开一次模态对话框：标题是「工具名 的参数」+ 耗时，正文等宽字体、内部滚动，顶栏给「复制」，`✕` / Esc / 点遮罩都关。子代理步骤行（`execChildStep()`）同一套：原来就地铺开的「参数 + 结果摘要」改成对话框里的两块（带小标题）；技能行本来没有工具参数，就把技能自己的 `description` / `why` / `path` 拼成「技能说明」一块——否则这类行点了什么也不会发生。

**模态就得真的模态：** 打开时把遮罩以外的兄弟节点全部 `inert`（读屏和 Tab 都进不了背景），`Tab` / `Shift+Tab` 只在「复制」和「✕」之间循环，关掉时恢复。

**为什么是对话框而不是就地折叠：** 用户要读的是一整段任务描述，读的时候执行页不需要同时在场；而就地展开无论如何都要占掉这一栏的高度。遮罩层复用 `.modal`（与口令框同一层 `z-index 50`），Esc 在捕获阶段 `stopImmediatePropagation()`，不会关掉对话框又顺手关掉底下那一层。

**代价 / 可改：** 展开状态不再被记住（关掉就是关掉）——D228 那个按「名字 + 参数全文」记忆的 `execNowExpanded` 一并删掉。80 字符阈值保留；面板宽度 `min(760px, 100%)`、`max-height: min(80vh, 720px)` 可改。焦点循环写死了两个按钮，以后正文里要是出现可聚焦内容（链接、输入框）得同步改那里。

**验证：** `npm run test:exec-panel:ui` 的 NOWARGS 场景（在途 `ask_user_question`，参数是 24 次重复的长文本）：默认一行且溢出、行是 `button` + `aria-haspopup=dialog` + `⤢`、没有 `.exec-now-args`；点开后 `.argdialog-text` 全文 >120 字，期间「现在」卡高度不变；`✕` 与 Esc 都能关掉且面板还在。BGCHILD 场景里点一条子代理步骤，对话框里出现「参数」和该步骤的参数原文，栏里不再有 `.exec-child-step-detail`。（fixture 里子会话那条 `child_lookup` 只有 toolCall、没有 toolResult，所以「结果摘要」这一块没有 UI 断言；往 fixture 里补 toolResult 会把子会话的 parent 链改成冲突分支、计划更新就收不到了，不值得。）技能行的「技能说明」由 `web/tests/exec-view-unit.mjs` 的单元断言覆盖（`description` / `why` / `path` 拼成 `note`，空技能不带 `note`）。

## D233 随手问默认常驻：不自动休眠、不被回收，结束只能由用户按「暂停」（`#365`）

**问题：** 用户报「随手问没有长驻，还是会被后台杀掉」——开着隔一段时间再问，中间冒出「找不到这个会话」，字发不出去。根因不是休眠：GC 每 10 分钟扫一次，过了 `IDLE_EVICT_MS` 就 `sessions.delete(id)`；而离开主会话视图时 `unsubscribe` 已经把 `isWatched` 清掉，随手问的文件又不在 pi 的会话根里（`known()` 不认它），于是「对象还在内存里」并不等于「活得下来」。删掉之后 `scratchSession()` 只会新建一条空会话，旧转录留在磁盘上再也接不回来。

**决定：**

- **默认不睡**：`DEFAULT_SCRATCH_IDLE_MS = 0`，0 明确表示「永不自动休眠」。配置层为此加了 `nonNegative()`（`positive()` 把 0 当没填），闲置 tick 里 `idleMs > 0 && …` 才睡。`lifecycle.json` 的 `scratchIdleMs` 与 `PI_WEB_SCRATCH_IDLE_MS` 都留着，填正数恢复旧行为，不上面板。
- **回收豁免**：`startGc()` 里 `if (s.state.scratch) continue;`，连「已休眠、对象还在」的那份也不删——它是这条转录在桥里唯一的入口。
- **「全部休眠」跳过它**：`sleepAll()` 同样的判断，回执里既不把它列成已睡、也不列成跳过。
- **结束只有一条路**：dialog 头部的「暂停 / 开始」toggle，服务端 `state.paused` 是唯一真相（两个标签页、后开的标签页都以它为准）。暂停 = 关 pi、保留转录与文件、**不开启 tail**（不再把冻结的转录读活）；开始 = 唤醒**同一个**会话文件。暂停态下 `openLive()` 直接拒绝，所以打开 dialog、自动重开都拉不起来；跑着一轮时按钮禁用（「这一轮跑完才能暂停」）。暂停中「清空」只清内存、删文件，仍然保持暂停。
- **不做落盘指针**：不写「上次随手问是哪个 id」。桥重启照样 `resetScratchDir()` 清空，已经失联的旧转录不救——界面上写明「桥重启会清空随手问」，让失忆有解释而不是莫名其妙。
- **失败一律可见**（`#368`）：失效时那句话留在输入框并排队，重开成功后自动发到新会话；桥的 404 变成会话顶部一条可关闭横幅 +「重新接管」，不再当 notice 落进聊天记录；主会话与随手问的横幅各管各的。

**为什么：**

- 把一小时调大只是把问题推后：用户要的是「它一直在，直到我说停」，不是「它撑得久一点」。
- 指针文件只解决「找回旧转录」，不解决「别丢」；随手问的价值是「现在还能接着问」，接回一条三天前的转录反而像在假装记得。
- 暂停必须独立于休眠：两者都关进程，但休眠是系统判定、暂停是用户意图——暂停要挡住**所有**自动唤醒路径，否则「我按了暂停它还偷偷起来」比不暂停更糟。
- 状态放在服务端而不是页面：多标签、刷新、重连之后页面各记一套，只有桥里的 `paused` 能一句话说清。

**代价 / 可改：** 一个常驻 pi 进程（省掉冷启，占着内存）；`state.scratch` 的对象在桥的生命周期内不再回收；暂停态不持久化（重启后是全新随手问，与「重启即清空」一致）；默认 0 意味着忘了关的随手问会一直在，这是有意的。

**验证：** `npm run test:scratch`（桩 pi，A–E 组：默认不睡、正数阈值恢复、休眠后复用同一 id、GC 不驱逐、重启清空）、`npm run test:scratch:ui`（真 Chromium：暂停/开始闭环、暂停只读不唤醒、清空保持暂停、404 自动重开、主会话与随手问横幅互不影响、中/英/日三语）、`npm run typecheck`（含 i18n 键检查）。

## D234 内网通「快捷联系人」与好友正交：一键可聊，文件仍只给确认过的好友（#376 / #382）

> 2026-11-18：「文件仍只给确认过的好友」这一条已被 **D300** 取消 —— 现在谁都能传文件；quick 与 friend 的其余分工（能不能聊、要不要待接受）不变。

**问题：** 内网通添加一个人原先只能手输 IP，而且「加好友」要走 `friend-request` → `friend-accept` 两步、对方还得在线点「接受」。用户要「广播看到所有在线的人、一键添加、一键发消息」。但若直接把一键添加写成 `friend: true`，就等于把 D106 的三道文件闸（发端 `/files/send`、剪贴板 `/files/upload`、收端 `files.begin()`）一起放行 —— 写盘是不可撤销的，陌生人也能往收件箱写文件；若走既有 `friend-request`，对端又必然出现「待接受」，不算一键完成。

**决定：**

- **通讯录先合并在线表**：`/contacts` = 已有关系记录 ∪ 当前在线、未忽略、无任何关系的人；合并出来的行只用于展示与发文字，不落 `peers.json`。在线名单、状态接口、找人接口与 pi 三个工具都不改（D98/D99/D103 一字不动）。**与 D104 / D105 的冲突在这里显式记一笔**：D104 决定 1 把 `/peer/inbox` 的信封限定为 `friend-request` / `friend-accept` 两种 `kind`，且「都可能因为对方离线、IP 漂移、组播被挡而要重试」；本条把 `friend-quick` 作为第三种 `kind` 复用了同一信封与 Outbox，`quick` 动作又只认 30 秒在线窗口、不命中直接 400，D105「接受时对方要在线」的规则也不适用于它。握手去重（D98）、隐身（D99）、来源校验（D103）与两步好友流程本身不改；D234 只在「控制消息多一种 `kind`」「离线目标直接拒、不补投」这两点上取代 D104 决定 1 与 D105 的适用范围，不重写那两条。
- **`quick` 是与 `friend` 正交的字段**：老记录缺字段按 `false`；`isFriend()` 仍只看 `friend`，所以 quick 只放行 1:1 文字，文件权限不变（D106）。一键添加沿用好友接口新增 `quick` 动作，本机立即写 `quick` 并经既有 Outbox 发新控制消息 `friend-quick`；接收侧 `acceptFriendQuick()` 只 `verifySource` + 写 `quick`，**不写 `incoming`、不回 `friend-accept`**，既有两步确认制原样保留。
- **离线即拒**：`quick` 动作只认 `discovery.online()` 的 30 秒窗口，不命中回 400，不用 5 分钟 IP 宽松窗口、不塞补投；页面按钮同步禁用并提示等上线。**实现取舍**：「不进补投」指接口在发起前就拒绝离线目标；一旦已通过在线检查并 `outbox.add()`，控制消息仍走既有 Outbox —— 旧版 400 `retryable: false` 会被直接 `settle`，但 IP 漂移的 409 / 网络抖动仍按 D104 重试。因此 story 21「失败时不进补投、不静默重试」只在「旧版明确拒绝」这一支严格成立，不为 `friend-quick` 单造一条不重试的旁路（spec 的 Implementation Decisions 也明写「经既有 Outbox 发」）。
- **混合版本尽力而为**：旧版对未知 `kind` 回 400 `unknown kind` 且 `retryable: false`，Outbox 直接丢这一条、不重投、不提示、不协商，不改 `PROTO`、不加能力位；新版本机 `quick` 照写、文字照发，旧版仍在「附近的人」看到新版。
- **忽略名单优先于合并行**（第三片实现）：移除一个由在线表合并出来的人时写本地 `ignored`，`/contacts` 不再合并他，但状态在线表与找人结果照旧；`ignored` 只吞「在线合并且无任何关系」的行，好友 / quick / 待处理 / 已发出申请 / 收藏都不受影响。
- **避免零点击自动互加**：列表每行一颗按钮，点一下才生效。

**为什么：**

- 文字与文件的风险不是一个量级：文字可删可忽略，文件是替对方往磁盘写东西。把「能看见、能聊」和「能传文件」拆成两个关系，用户看到的「一键添加」才不会悄悄放大权限。
- 复用 inbox + Outbox + `verifySource` 而不是另开通道：补投、去重、IP 校验都是已有的，新控制消息只是多一个 `kind`，旧版天然把它当 `unknown kind` 丢掉。
- 不做版本协商、不改协议号：内网通是去中心、无中心的，靠组播互认；一个「你支持 quick 吗」的往返反而会让双方都依赖对方在线，且给每个旧版都背上兼容分支。
- 忽略名单独立持久化、只作用于合并行：否则 `/contacts` 每 6 秒重新合并一次，按「移除」的人刷新就回来；而把已有关系的人一起吞掉会破坏收藏与好友语义。
- 术语「快捷联系人」「忽略名单」已写进 `GLOSSARY.md`，`好友` 条目也补上「两者都不等于好友」；按 `docs/agents/domain.md`，新决定不改写旧决定，只在这里点名 D104 / D105 的冲突。

**代价 / 可改：** 一个额外的 `quick` 字段与一种控制消息；旧版升上来之前，单向 quick 不会同步到对端（对端仍把你看作附近的人，文字照常收发）。按钮文案「快捷添加（可聊天）」/「加为好友（可传文件）」/「已是快捷联系人」、分组名「快捷联系人」及其 en/ja 译文都是默认值，可改；quick 组位置（好友之后、附近的人之前）也可改。忽略名单只在设置页整体清空，不做单条编辑。

**验证：** `npm run test:peer`（后端真实多进程：在线陌生人进通讯录且关系字段全假、一键添加后双方 `quick` 且无 `incoming`、重复添加不重复、quick 发文字成功有回执、quick 发文件仍 403 且收件端拒写、离线 `quick` 被拒、既有两步好友流程与文件仅好友不回退、旧版 400 只丢不补投）、`npm run test:peer:ui`（真 `web/dist` + 桩 API：quick 单独成组且位置正确、两颗按钮并存、传文件仅好友、离线禁用并显示可见提示、发消息聚焦输入框、中文语境的新文案与 en/ja 两种 locale 下的译文）、`npm run typecheck`（含 i18n 三语言键检查）。

## D235 分支 chip 从「只读历史」升级成「分支操作工作台」（用户要求）

**编号说明：** 本决定在分支开发时暂记 D234；同期合入 main 的「内网通快捷联系人」（#376 / #382）已占用 D234。按「不改写已合入的决定」，本决定顺延为 **D235**，D234 的内容一字不动。

**问题：** D193 的弹窗只读、是快照、对照分支只有一个纯下拉、看不到 diff，也不让 cherry-pick。用户从「聊天框的分支功能很简单，想追加功能」开始，九轮逼问定下全集写操作的边界，再做四份真实 HTML 样张（`.scratch/git-ops-dialog/prototype/`）选定**样张 D · 居中操作卡**，第二轮又补了三条：全部动词要看得见、加一个「选分支 + 写要求 → 交给 AI」的独立入口、对照分支要能输入检索。

**决定：**

1. **落点不变**：仍是输入框状态行的 `⎇ 分支` chip → `BranchSheet`；消息气泡的 `⑂` 分叉是另一条线，不动。
2. **明确覆盖 D193 的第 6 条「只读」与「弹窗是快照」**：写操作成功后立刻 `invalidateGitCache(dir)`（清 `bridge/src/git.ts` 的 5s TTL）并以 `fresh` 重拉 history / info / refs / diff，状态行的分支与 dirty 数跟着变；弹窗不再自称「只读」。
3. **版面按样张 D**：三 tab「历史 / 差异 / 图解手册」+ 右上写操作按钮 + **740px 居中操作卡**（背景遮暗是用户选定并接受的代价）。标题栏常驻 commit / switch / merge / **cherry-pick / revert / tag** / fetch / 红色操作，另有「▦ 全部动词 · 24」分组选择器与「🤖 交给 AI 操作…」。
4. **对照分支改成可输入检索**：关键词过滤本地 + 远程分组候选，回车或「用输入的 ref 对照」接受任意 ref；历史右列、差异文件栏、并排 diff 标题同步。D193 的纯 `<select class="bc-base">` 与「只列 refs/remotes」一并作废。
5. **差异富视图**：默认「当前分支 vs 对照」，点提交切「该提交 vs 父提交」（根提交用空树 `4b825dc…` 当左侧）；文本逐行并排（tag `same`/`add`/`del`/`mod` 分别上色）、图片两栏缩略、PDF / 表格 / 二进制占位、超 200 行或 400 KB 截断并明说。
6. **桥端执行通道**（新文件 `bridge/src/gitops.ts`）：只收 `id + 结构化 params`，24 个 id 由 `OP_BUILDERS` 逐条显式拼 argv，**绝不执行网页传来的 argv**；`ref` 拒绝 `-` 开头与 `[\s~^:?*\[\\]`、`paths` 限 200 条且拒 `..`、`message` 去 NUL；统一 `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` + `credential.interactive=never`（否则缺凭据的仓库会挂在等密码）；按 `dir` 串行排队防 `index.lock` 互踩；返回 `GitExecResult` 带 `exitCode` / 原 argv / 原始 stdout+stderr / 新 state / 冲突文件 / pending / `refresh` / 稳定 `code`（`auth`/`identity`/`conflict`/`dirty`/`op_failed`）。D193 那个把失败吞成 `null` 的私有 `git()` 不复用。
7. **D240 已推翻（2026-11-13）：双闸，写入只在真本机放行**：`isLoopbackPeer(req.socket.remoteAddress) && !isTunnelRequest(headers)`，LAN 直连与公网隧道一律 403 `op_public`。两个判据缺一不可：cloudflared 在本机起，隧道请求的 `remoteAddress` 天然是回环；LAN 直连不带 cf 头，`publicReq` 又判不出来。**现改为**：cookie 闸是唯一边界，登录后的公网 / 局域网访客与本机同样可读写，理由与范围见 D240。
8. **保护与失败可见**：会覆盖工作区且当前 dirty 的操作先弹「stash / 逐文件 restore / 取消」；冲突态只放行「中止 / 继续 / 交给 agent」，继续要逐文件勾完「已解决」才启用；8 个红色动词（`reset --hard` / `clean -fd` / `push --force` / 删分支 / `stash drop` / `tag -d` / rebase / restore）给确认卡（会丢什么 + 可复制回退命令），但 **restore 特判**：逐文件勾选清单本身就是确认，不叠第二张卡；鉴权与提交身份失败给结构化失败卡 + 系统 credential helper / `user.name` 指引 + handoff，网页不收集账号密码、不自动兜底。
9. **交给 agent 两个出口**：`buildHandoffPrompt()` 打包仓库 / 当前分支 / 选中分支 / ahead·behind / dirty 数 / 可用分支 / 失败时的 argv+exit+stderr / 用户要求；复用 `web/src/app.ts` 的 `prefill(text)` 与 `newSessionWith(text)`（JiraPanel 已接过同一对回调），**只填不发**。提示词字面保持中文、不随界面语言变（`i18n-ignore`）。
10. **前端单一注册表**（新文件 `web/src/git-ops.ts`）：24 条 `GitOpDef` 各带两帧纯内联 SVG 图解（离线可用）、结构化字段、具名开关（`--force-with-lease` / `--no-ff` / `-u` / `--include-untracked`）、命令预览、风险、红色 lose / rollback；界面文案全走 `tr()`。

**为什么：** 让新手在网页里就能把「看差了什么 → 想清楚要不要动 → 动完立刻看到新状态 → 出事把原始 stderr 交给 agent」闭成一条链，而不用回终端；把 argv 拼装收进 id 白名单，是因为网页一旦能传任意参数，红色确认卡就形同虚设。
> **修订（2026-11-13）：** 第 9 条的「可用分支」清单已删除：本机 `F:/pi-web-client` 实测 105 条 ref 拼成 2735 字符，占提示词九成以上；agent 自己跑 `git branch -a` 拿到的是更新更准的列表，网页塞一份全量快照只会把上下文挤掉。失败卡也从「`branchPrompt` + 另一份 `buildHandoffPrompt` 用空行拼两份」收成一次 `buildHandoffPrompt()`（第二份原本还丢选中分支 / ahead·behind / dirty）；其余字段与「只填不发」「提示词固定中文」不变。历史决定原文不改写，只在这里标被推翻。
> **D240 修订（2026-11-13）：** 「把『能连上 bridge 就能写』收紧成只认真本机，是因为隧道的回环地址是个假象」这一句不再成立；真实边界改回 D3 的登录口令，见 D240。

**代价 / 可改：** 样张 D 的已知代价（每次操作都离开上下文、普通动作也显得重）随选择一并接受；不收 submodule / worktree / bisect / blame / remote 管理 / config / gc；`--graph` 仍未画；大文件与非文本只给占位；鉴权失败只能在系统侧配好后重试；`ref` 的字符黑名单会挡掉极少数合法但罕见的分支名。24 个 id 与字段在 `web/src/git-ops.ts`，桥端白名单在 `bridge/src/gitops.ts`，两边要一起改。

**验证：** `npm run typecheck`（bridge / peer / web 三份 tsc + `i18n-check`）；`npm run test:githist` 扩成裸库写操作集成（switch / stage+commit / merge 冲突 / 非法 ref / 未知 id / force 拒绝）；`npm run test:githist:ui` 用 Playwright 断言三 tab、24 动词选择器、AI 入口、对照检索、居中卡、红色确认、失败卡、冲突逐文件、handoff、chip 刷新与公网 / 局域网可读写（D240）。样张阶段的四版截图与 100+ 条 linkedom 交互断言留在 `.scratch/git-ops-dialog/prototype/`。

## D236 问答卡按「新工具名 + 三套旧文案」一起认（用户要求）

**问题：** D90 把网页提问从自补丁的 `question` / `questionnaire` 换成 `@juicesharp/rpiv-ask-user-question`（工具名 `ask_user_question`）之后，转录里的问答卡（D47 的 `.qa-card`）就没了：`web/src/chat.ts` 的 `isAskTool` 只认两个旧名字，于是用户点完表单，聊天区只剩一行收起的「N 个操作 · ask_user_question ×1」，答案要点开折叠层才看得见。名字和答案文案同时不命中 —— 新包的答案是 `User has answered your questions: "问题"="答案"`，不是旧的 `User selected: 2. 右边`。本机 633 个会话文件里旧工具名出现 0 次、`ask_user_question` 762 次，所以这不是「某天之后偶尔看不到」，而是所有新提问都看不到。

**决定：**

1. `isAskTool` 三个名字都认：`ask_user_question`（现在）+ `question` / `questionnaire`（历史会话里还在）。旧名字不能删，历史会话重放时得画成同一张卡。
2. 参数先归一成 `{ label, prompt, options }`（新文件 `web/src/ask-result.ts` 的 `askQuestions`）：新工具每题是 `{ header, question, options }`，旧单题是平铺的 `{ question, options }`。以前 `buildAsk` 直接读 `q.prompt`，对新工具永远是空题干。
3. 结果解析也搬进 `web/src/ask-result.ts`（`parseAskResult`），三套文案都认：新文案用 `"问题"="答案"` 成对解出来并**按问题原文配对**（模型把答案顺序写反也能对上，配不上才按下标），旧问卷按 `<label>: user selected: N. X` / `<label>: user wrote: X`，旧单题按裸的 `User selected:` / `User wrote:`。`User declined…` 与 `cancel` 记成「已取消」。
4. 启动体检改成走 `depsReport`（`pi list`，D220 的判据）打印安装的 npm 包版本：以前找的是 `~/.pi/agent/extensions/question.ts`，D90 之后那儿永远没有，于是日志天天说「缺」而实际在用。
5. 回归放两处：`web/tests/ask-card-unit.mjs`（纯函数：三套文案、配对乱序、转义引号、取消、空结果）与 `probes/round3-fold.mjs`（真 `web/dist`：两种工具名都得渲染成 `.qa-card`、都不能掉进 `details.ops`）。原来的探针只种了 `questionnaire`，这正是它漏测的原因。

**为什么：** 工具名是别人的接口，会变；转录渲染是我们自己的约定，不能只按一种拼写写死。旧名字一起认，是为了同一份会话文件昨天看是卡、今天看还是卡 —— 否则每次换扩展都等于把历史记录改坏一遍。答案只能从文本里解析，是因为扩展把结构化结果放在了 `details` 里而工具结果文本另有措辞；按原文配对而不是按位置，是唯一能容忍模型换序的写法。

**代价 / 可改：** 名字清单是手写的，将来再换名字要同步改 `isAskTool` 与单测 fixture，没有自动发现；文案仍是文本匹配，扩展改措辞会退回「未回答」—— 但单测会红，不再静默。历史 `question` 单题卡的头叫「提问」，多题叫「问卷 · N 题」，与 D47 一致。

**验证：** `npm run test:ask-card`；`npm run typecheck`（bridge / peer / web 三份 tsc + `i18n-check`）；`node probes/round3-fold.mjs`（含新增的两条 ask 名断言）；同一份种子会话跑 `.scratch/ask-card-probe.mjs`，修前 `qaCards:1 / opsModules:1`，修后 `qaCards:2 / opsModules:0`，截图里两张卡都显示题干与「✓ 右边」。

## D237 非 git 工作目录：chip 改成「目录与仓库」三栏窗（#392）

**问题：** 左下角的路径 chip 只会复制路径，⎇ 分支 chip 只在 cwd 本身是仓库时出现。可实际项目常是伞形目录：`erp/api`、`erp/ui` 各自是仓库、彼此联动，cwd 却是 `erp`（不在任何仓库里），于是「看/切/合并子仓库的分支」在网页里没有入口，而把每个子仓库都开一个会话又割裂了上下文。

**决定：**

1. **点击按 cwd 分叉，chip 的显隐规则不动。** cwd 在仓库里时 chip 仍复制路径、⎇ 仍开老「分支操作工作台」；cwd 不在仓库里（`gitCwd !== cwd` 或 `git === null`）时点 chip 换成打开「目录与仓库」窗。判据在点击时现算，并在每次 `refreshGit()` 后刷新 title —— git 是异步到的，建节点时定死会让标题永远停在「浏览子仓库」。chip 仍然只在左栏收起时出现（可达性是既有问题，不在本 ticket 里改）。
2. **三栏：目录树 224px + 仓库列 214px + 面板。** 标题栏是路径、当前仓库分支、dirty、复制路径、关闭；底部是提示与 Esc。目录树根 = cwd，带「↑ 上级」与路径输入（可越出子树）；只列目录，隐藏 `.` 开头与 `node_modules`，懒加载。仓库列随展开累积：卡片 = 仓库名 + dirty + 分支 + ↑ahead ↓behind + 最近提交，点卡片选中。面板首次选中仓库才懒建，把 `BranchSheet` 以 `embedded` 模式挂进去。
3. **两列都可折叠成 26px 竖条**（竖排「目录」「仓库」+ 仓库数），列宽走容器 CSS 变量 `--rw-tree` / `--rw-rail`，窄屏（≤720px）目录树收成抽屉、仓库列隐藏；Esc 顺序 = 面板操作卡 → 抽屉 → 窗口。
4. **批量探测只读接口。** 50 个子目录逐个 `api.git()` 会起 150+ 个 git 进程，新增 POST `/api/git/probe`：入参父目录 + 子目录名列表（上限 64，可 `fresh`），4 并发，且只保留 `rev-parse --show-toplevel` 等于该子目录本身的结果（父仓库里的普通目录回 null）；复用 `gitInfo` 的 5s TTL，异常一律 null 不 500。写操作完全沿用老工作台，不新增任何写能力。
5. **右栏按「选中目录所在仓库」取数**：选 `api/src` 也显示 `api`，标题标明解析出的仓库根、深于根时标「选中：src」；切目录调 `BranchSheet.setDir()` 重置 base/diff/limit 并用 ticket 丢弃迟到响应；写成功后同时刷右栏与树上的标记。
6. **记住位置**：按 cwd 持久化「选中目录 + 展开节点（≤40）+ 折叠状态」到 `localStorage.pi.reposSheet`（最多 12 个 cwd），`statPath` 校验失败静默回落；切会话关窗。
7. **老工作台零外观变化**：`embedded` 只换外壳（无遮罩、无 ✕、无 Esc 绑定、标题隐藏），DOM 顺序与类名不变；历史 tab 的 `aside` 在嵌入时搬进头部「分支 · 本地 + 远程」浮层，两颗 CTA 原样保留。

**为什么：** 伞形目录是真实工作方式，让人为了切分支去开八个会话等于把项目结构从界面里抹掉；把面板做成老工作台的嵌入模式而不是第二套实现，是因为 24 个动词、冲突/脏工作区保护、handoff 这些语义已经有一份，复制一份必然走偏。批量探测在桥端做，是因为「每目录一次 HTTP + 3 个 git 进程」在 50 个目录时肉眼可见地卡，而父目录一次往返能把整层标记一起拿回来。

**代价 / 可改：** 仓库列卡片没有 ahead/behind 与最近提交（`GitInfo` 只有 repo/branch/dirty/empty/空/游离，加这两项会让每个子仓库多 3 个 git 进程）——首版按「仓库名 + 分支 + dirty」收敛，已在 issue 记录；探测上限 64，超出不探（界面给提示而不是分批续探）；不跟随文件系统变化（写操作后主动 fresh 重探已展开层）；不支持 submodule / worktree 内部的仓库；折叠状态是「按 cwd」而不是「按窗」，同时开多窗会互相覆盖。

**验证：** `npm run typecheck`；`npm run test:githist`（含新增 `bridge/tests/git-probe-unit.mjs`：真 git 的子仓库/普通目录/空仓/游离 HEAD/非法名/截断/缓存+fresh）；`npm run test:repos:ui`（真 bridge + Playwright：伞形目录、隐藏目录、子仓库分支标记、内嵌工作台、浮层、折叠、Esc、重开回原位、窄屏抽屉、仓库会话仍复制）；`npm run test:githist:ui` 原样通过（老工作台外观回归）。原型三变体与选型记录在分支 `proto/repos-dialog`（`web/prototype/repos-dialog.html`）。

## D238 会话读取预算按「正文」算：图片 base64 读完就抹掉，开头的用户消息不再被截图挤掉（用户报 bug）

**问题：** 用户看到「最上面我发的第一句话没了」。真实会话（70.6 MB、529 条）里第一条用户消息整条消失，界面上顶部没有气泡、没有「载入更早」、刻度带 0 轮 —— 像是被删了。根因不在文件：`loadEntries()` 按**文件字节**只留末尾 16 MB，窗口起点落在 57.3 MB 处，06:56 那条用户消息在 08:32 起的第一条之前，整条没进 entries。体积 98% 是模型截图的 base64（50 张 ≈ 69 MB，正文 1.4 MB），每贴一张窗口就前移，越过那条消息后它静默消失；而 `truncated` 只写进 `session.state`，`web/src` 没人读，翻页又只切内存里的 items（`index.ts:1874` 的 `pageBefore`），所以既没提示也翻不回去。

**决定：**

1. **预算算内容字节。** `loadEntries()` 读进条目后立刻把 `image` 部件的 `data` 抹成空串（`stripImageData()`），预算按抹完之后的字节算；`mimeType` 留着，像素仍由 `loadEntryImage()` 按需从盘上流式读 —— 渲染层本来也只用 `mimeType`（`entriesToItems()` 折成「[图片]」）。正文自己超预算才从头部丢条目，此时才 `truncated = true`。
2. **读取本身仍有上限，但放宽到 256 MB**（`MAX_READ_BYTES`）：再大就是病态输入（读一次要几秒、瞬时吃几百 MB 堆），退回「只读尾部」，剩下的交给上面的内容预算。真实案例在新规则下 529 条一条不丢，读取 ~200 ms。
3. **`truncated` 上帧、界面说清楚。** `itemsFrame()` 在真丢过头部时才带 `history.truncated`，web 在聊天区顶部那行（`chat-more`）把「载入更早」换成不可点的「会话文件太大，只载入了最后一段」。没截断时字段不出现 —— 帧的字节与以前一致，老 UI 用例、快照都不用改。
4. **顺手修同一文件里的一条 lint 阻塞**：`scanFirstUserText()` 的 `while ((nl = buf.indexOf(10)) >= 0)` 改成 `for (;;)` + `break`（no-assign-in-expr），语义不变。

**为什么：** 16 MB 的意义是「别把几百 MB 拖进内存」，而截图字节恰恰是渲染层一个字节都不用、却最占体积的那种。按文件字节裁，等于让「贴了多少图」决定「你还看得见多久以前的话」—— 用户没有任何线索，只能以为记录丢了。另一端（真的超大文件）宁可读慢一次也不要静默丢历史，丢的时候必须有话说。

**代价 / 可改：** 打开大会话要整段读一遍（70 MB ≈ 200 ms，以前读 16 MB 尾巴）；`loadEntries()` 现在会持有一段整文件的字符串，峰值随文件涨到 256 MB 上限；抹掉的是内存里的副本，文件本身一个字节不动（归属规则：pi 拥有会话文件）。没有做的：`loadEntryImage()` 每次仍扫全文件取像素（未改）；分页 API 依然只切内存里的 items，所以「丢过头」的文件翻不回更早的（只是现在会说明原因）。

**验证：** 新增 `bridge/tests/session-head-unit.mjs`（26 张 800 KB 截图 + 开头一条用户消息：不截断、首条仍是用户消息、`data` 已抹空、`mimeType` 还在、`loadEntryImage` 仍取得到像素；正文超预算时从头部丢且条目连续；`itemsFrame` 只在截断时带字段）；`npm run typecheck`（bridge / peer / web + `i18n-check`）；`npm run test:history`、`npm run test:image`、`npm run test:tail` 原样通过；对真实会话跑 `loadEntries()` + `entriesToItems()`：`truncated:false`、529 条、`items[0].kind === "user"`（修前 `users: 0`）。

## D239 随手问也能贴图：图和文字走同一条管线，回显改成按 `clientId` 配

**问题：** 随手问（`.scratch-*` 那套只读工具的轻量会话）只有一个纯文字 textarea。贴图时粘贴落在主输入框的 window 级处理器上，图会跑进主聊天；就算把它接进随手问，回显也配不上——会话里用「文字逐字相等」认领自己刚发的那条，而纯图片消息的 `text` 是空串。

**决定：**

1. 抽出 `web/src/images.ts`（`PendingImage`、`pastedFilesFrom`、`splitImages`、`ATTACH_IMAGE`、`rasterizeSvg`、`downscale`、`readImageFile`、`imagesFromFiles`），主输入框与随手问共用一份；压缩参数不分叉（长边 2048、JPEG 0.86）。
2. 三个入口都收：textarea 上的 paste（焦点落进来才归随手问，页面别处仍归主输入框）、dialog 上的 drop（`stopPropagation` 挡掉 window 上的主输入框处理器）、📎 文件选择。
3. 待发图是输入框上方一条缩略图横条（每张带 ×），不是模态预览；发送那一刻清空。
4. 允许纯图片消息；非图片文件拒收并明说，不把文件名塞进消息。
5. 只有模型明确 `supportsImages === false` 才拦（置灰发送 + 一行说明 + 模型 chip 警示色），`undefined` 视为未知不拦；不自动换模型。
6. 回显配对从文字相等改成桥回带的 `clientId`（`item.add` 本来就带它，见 `bridge/src/sessions.ts`）。
7. 图的开销跟文字一致：清空一起清、关窗与暂停保留、桥重启/404 之后跟着那句话自动重发。

**为什么：** 图的处理（粘贴取文件、SVG 光栅化、降采样、编码）在主输入框已有一份，随手问再写一份必然在「同一张图两边贴出来不一样大」这种地方分叉；而用文字认领自己发的那条是历史遗留的权宜，纯图片消息一进来就从「偶尔配不上」变成「永远配不上」。至于非视觉模型，默默放行等于让人贴完图、发出去、再被后端拒一次，不如发送前就说清楚。

**代价 / 可改：** 只支持图片，文档与 PDF 要另一次决定；`downscale` 一律 re-encode 成 JPEG（透明通道会丢，主输入框本来也如此）；模型目录缺 `supportsImages` 时按未知放行，遇到真不认图的后端会发过去再被拒；缩略图横条在窄屏换行，占两行高度。

**验证：** `web/tests/images-unit.mjs` 9 例；`bridge/tests/scratch-ui.mjs` 五段（贴图→发送→气泡缩略图可点开且 pi 真收到 `image/jpeg`、看不了图的模型拦截、非图片拒收、清空连图一起清、404 重开后图跟着重发），靠 `FAKE_PI_VISION=1` 让桩模型的第一个能看图、第二个仍只收文字；`npm --prefix web run typecheck`（含 `i18n-check` 2547 keys × 3 langs）。

## D240 分支管理放开公网 / 局域网访问（用户要求）

**问题：** 用户直说「现在分支管理，不支持公网和局域网访问了，修改掉，允许访问」。D235 第 7 条给 `/api/git/*` 加了双闸（`isLoopbackPeer(remoteAddress) && !isTunnelRequest(headers)`），D193 第 5 条让 `/api/git/fetch` 拒绝公网，Q-021 让 `/api/git` 与 `/api/git/history` 对隧道访客直接答 `{repo:null}`，`/api/git/probe` 也只认本机回环。结果是：手机走 trycloudflare 隧道、或家里另一台机器走局域网直连打开网页，登录后分支 chip 变空、历史弹窗空、工作台所有动词 403 `op_public`、fetch 403 `fetch_public` —— 而用户明确要把这套功能带出本机。

**决定：**

1. **拆掉双闸，边界统一回到 D3 的登录口令**：`bridge/src/index.ts` 里 `/api/git`、`/api/git/history` 的 `publicReq → {repo:null}` 早退、`/api/git/fetch` 的 `fetch_public` 403、`/api/git/{state,refs,diff,op,probe}` 的 `!isLoopbackPeer(peer) || publicReq → op_public 403` 全部删除。所有 `/api/git/*` 仍在那道 `authorized(cookieHeader)` 闸之后，无口令一律 401（`/api/` 前缀）；口令验的是 HMAC 签名 + 过期时间，与请求从哪来无关。`isLoopbackPeer()` 保留给 `/api/ask`、`/api/preview/open`、`/api/artifacts/snapshot`、`/api/peer` 四处 —— 那些要打开本机程序或回表单，仍只认回环。
2. **只动入口闸，不动执行层**：`bridge/src/gitops.ts` 的 24 个 `OP_BUILDERS` 白名单、`ref` / `paths` / `message` 参数清洗、按 `dir` 串行排队、`GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` + `credential.interactive=never` 三件套、`gitFetch` 的 45 秒超时、红色动词的前端确认卡与冲突态收口，一字不改。网页依旧传不了任意 argv。
3. **目录校验与错误兜底照旧**：`dir` 空 / 非绝对路径仍 400，读不到仓库仍回 `{repo:null}`，写失败仍是 200 + `{ok:false, code, ...}` 的结构化失败卡。`bridge/src/index.ts` 里 `publicReq` 变量本身保留（`/api/me`、sysmanage、jira、`/healthz` 还要用），只是不再拿它拦 git。
4. **口径同步**：`GLOSSARY.md` 的「分支操作工作台」去掉「写操作只对本机回环放行」；`web/src/api.ts` 两处注释去掉「隧道不给 / 一律 403」；`docs/DECISIONS.md` 的 D193 第 5 条、D235 第 7 条与「为什么」段加 D240 修订标注（历史决定不改写，只标被推翻）；`CHANGELOG.md` 记一条。
5. **回归改断言**：`bridge/tests/git-history-ui.mjs` 原来断言「隧道写操作 403 / op_public」，改成三条来源都能读写 —— 带 `x-forwarded-proto: https` 的隧道头、桥听 `0.0.0.0` 后用本机非回环网卡地址连回去的局域网对端、以及原来的本机回环。写操作用 `id:"no-such-op"` 换 `unknown_op` 结构化返回（不真打标签、不碰仓库），只验「路由放不放行」；另外补 `/api/git`、`/api/git/history`、`/api/git/fetch` 带隧道头仍能拿到真实分支 / 历史 / fetch 成功。

**为什么：** D3 早就定了「公网上唯一屏障是登录口令」，而 cookie 闸对所有 `/api/git/*` 已经生效 —— 双闸是在口令之外又叠了一层来源判断，等于把「已登录」这个事实按访问路径打折。用户要的就是已登录后不论从哪来都能用分支管理，所以不需要再判 `publicReq` 或 `remoteAddress`；删掉它们还顺带消掉「cloudflared 的回环地址是假象」这个一直要两边一起维护的坑。保留执行层白名单与三件套，是因为「谁能连桥」和「连上之后能动什么」是两件事：前者放行到已登录用户，后者仍由 24 个 id 与确认卡兜底。真终端（D89）在公网下继续禁用，不在本次范围内 —— 它是开一个真 shell，和这里读 git 状态 / 跑白名单动词不同量级。

**代价 / 可改：** 拿到口令的公网访客现在也能 `push --force` / `reset --hard` / `clean -fd`（前提是过了那张红色确认卡）—— 这是用户要的可用性的直接代价，口令丢了后果比从前大；真要收紧，应给写操作单独加 step-up 或在设置里加开关，而不是退回「只认回环」。局域网测试依赖跑测试那台机器有非回环 IPv4 网卡，没网卡时该条会失败并明说「无」（不静默跳过）。`CHANGELOG.md` 这批的 PR 编号在开好 #404 后补进标题。

**验证：** `npm run typecheck`（bridge / peer / web 三份 tsc + `i18n-check`）；`npm run test:githist`（裸库写操作集成）；`npm run build` 后 `npm run test:githist:ui`（真 Chromium，三 tab / 24 动词 / 红色确认 / 冲突态 / 公网头·局域网·回环三来源可读写 / 窄屏）；`npm run test:repos:ui`（目录与仓库面板，probe 不再 403）。

## D241 Jira 面板换成「本机管理」同款控制台；搜索加工单号，模糊由桥内两级查询兜底（#407）

**问题：** Jira 面板一直是「一个 sheet + 两颗 tab」的弹窗形态：标题只有一行「🔷 Jira」，账号信息、站点、token 掩码挤在列表页顶上，搜索页和列表页共享一个 14px 内边距的滚动区。工单越积越多之后，「我的未完成」和「搜索」都变长，谁在滚、滚到哪全靠猜；窗口一窄，头部那点信息先被挤掉。同时搜索缺了最常用的入口——**按工单号查**。用户在聊天里贴的、邮件里抄的、会被念成「那个 21352」的，都是号；而 JQL 的 `key` 字段不支持 `~`（Atlassian 的 unsupported operators 里就有它，JRACLOUD-61197 同结论），`text ~ "21352"` / `summary ~ "21352"` 也不命中工单号，所以「模糊查号」在面板里必须自己实现。

**决定：**

1. **外壳照抄「本机管理」**：`web/src/jira-console.css`（`.jc-*`）独立成文件，遮罩 + `min(1120px,96vw) × min(800px,90vh)` 控制台 + 头部 eyebrow/标题/副行/徽章 + 横幅 + `214px` 左导航 + 内容区 + 页脚；面板外壳是 `.jc-*`，工单行/表单/详情这些内件继续用 `.jira-*`，互不覆盖（与 `.sys-*` / `.st-*` 同一套做法）。横幅行在网格里**钉死 `grid-row`**，否则空横幅会把内容区和页脚前挪一行 —— 这个坑 sysmanage 已经踩过两次。
2. **三个分区取代两颗 tab**：我的未完成（默认）/ 搜索 / 账号与附件；未连接时只有「连接」。左导航是 `button` 列表（`aria-current="page"`，不假装 tablist），内容区唯一滚动，切分区各自记住滚动位置；账号、token 掩码、附件目录、退出连接、可访问项目都收进「账号与附件」。
3. **头部用站点域名当标题**（`kaigit.atlassian.net`），副行是登录邮箱，徽章是显示名 / 未完成条数 / token 掩码；刷新失败、凭据失效、关注者降级、**公网只读**走横条，可单条关掉（`dismissed` 集合只在打开期间有效）。只读这件事由桥告知：`GET /api/jira/config` 多回一个 `readonly: ctx.publicReq`，页面据此挂「公网只读」徽章与「改连接、换附件目录要回本机」的横幅 —— 写操作本来就会被桥回 403 `tunnel_readonly`，但人得先知道，而不是点下去才撞墙。
4. **工单号一格，形状由桥判**：`parseKeyQuery` 去 `#`、按空格/逗号切段；每段都像完整键（`^[A-Za-z][A-Za-z0-9_]*-\d{1,9}$`）→ `exact`（大写去重，最多 `SEARCH_MAX_KEYS = 20`）；否则 `fuzzy`，只拿第一段当 token。页面上不多一颗「模糊」开关，也不做实时下拉 —— 用户明确要「只在提交时模糊」。
5. **工单号非空时不加 `resolution = Unresolved`**：精确、多个、模糊一致。查指定号就该看到它的真实状态；「含已解决」对号查询不再起作用（保持不变会让「查 CASPH30BUG-12 却什么都没有」变成常见困惑）。
6. **模糊直接拼进 JQL**：`workItemKey ~ "<token>*"` 前缀匹配，一条查询由 Jira 执行、可翻页，响应带 `fuzzy: { token }`（D243 取代了原先「picker 找候选 → key IN 拉行」的两级做法）。
7. **完整号查空自动退回模糊**：只有一个键、`key =` 查回 0 行时，用这个键再发一次 `workItemKey ~ "<key>*"`；有结果就采用，响应标 `fuzzy.fallback = true`，页面写「没有这个工单号，下面是按号段模糊找到的」。

**为什么：** 外壳换成控制台不是为了好看，是因为面板的条目数已经超出「一个 sheet 塞得下」的量级：账号/凭据/附件属于设置，搜索与列表属于日常，混在一个滚动区里必然互相挤。选「照抄 sysmanage」而不是抽象出通用控制台，是因为三个控制台（设置、本机管理、Jira）布局相似但内容密度不同，先复制数值（1120×800、214px、断点 900/640），等第四个出现再抽。工单号这一格之所以不拆成「精确/模糊」两个开关，是因为用户输入的形状本身已经说明了意图（带项目键的整串 vs 半截数字），让桥判比让人再选一次更省事；而「只在提交时模糊」把 picker 的 20 条上限、无分页这些毛病留在提交之后，不污染输入过程。

**代价 / 可改：** 前缀匹配是「号段从头对」，输入 `2135` 不会命中 `12135`（要包含就得自己多打几位），这是有意的取舍（D243）。`fallback` 只在「一个完整键查空」时触发，多键查空不退回（避免把 N 个键的语义混成一个）。`SEARCH_MAX_KEYS = 20` 是 `key IN` 的上限，多给的键会被静默截断。控制台外壳与 sysmanage 各存一份 CSS，改视觉要改两处 —— 已知，等第三个控制台出现再谈抽象。

**验证：** `web/tests/jira-unit.mjs` 35 例（含 `key` 的 normalize / serialize / read 往返）；`bridge/tests/jira-search-unit.mjs` 25 例（精确 / IN / `#` 前缀 / 20 键截断 / 判模糊 / 前缀 JQL / 超长 400）；`bridge/tests/jira-e2e.mjs` 58 例（`workItemKey` 前缀 JQL、与标题同时生效、模糊查空、上游 403 照实报、`emptyOnce` 触发 fallback）；`npm --prefix web run typecheck`（`i18n-check` 2597 keys × 3 langs）；`npm run build:web`；真 Jira 探针见 D243；隔离实例（jira1，真凭据）手点：`2135` → 4 行，`CASPH30BUG-21352` → 1 行无提示，`CASPH30BUG-99999` → 「没有匹配这个工单号的工单」，520 宽输入框可见不溢出。

## D242 附件一键下载：行尾一颗按钮、按工单号建目录、撞同名先问；附件内容认 `api.media.atlassian.com`（#407）

**问题：** D205 只做了单票详情里的「下载全部」，两个缺口在日常里都暴露出来：一是下载入口藏在展开的详情底部，列表上十几张票要逐个展开；二是 Jira Cloud 把附件内容的中转地址搬到了 `https://api.media.atlassian.com/file/<uuid>/binary?...`，而 `attachmentRedirectAllowed` 只认站点自己与 `*.atl-paas.net`，于是每一张票的每个附件都以「附件跳转到不允许的地址」失败 —— 用户看到的正是「下载按钮像是不见了」。另外「交给 agent」的提示词只说「已经下载到本机的附件在 <目录>」，agent 还得自己列目录猜哪个是哪个。

**决定：**

1. **行尾一颗「下载附件」**：与「交给 agent」同组靠右（`.jira-issue-acts`），摘要占剩余宽度并省略，窄屏下按钮整组换行、不拆成两行。首次点击直接在 `<附件根>/<KEY>/` 落盘；下完在行下方留一行 `已下载 N 个 · M 个同名文件没动 · K 个失败 · <目录>`。
2. **冲突先问再写**：`POST /api/jira/issues/:key/download` 不带 `conflict` 时，只要目标目录里已有同名文件就回 **409 `jira_conflict`** + 清单，一个字节都不写；页面弹出「有 N 个同名附件已经在这个目录里」+ 三个出口：**跳过已存在的**（其余照下，主按钮）/ **覆盖** / **取消下载**。`?conflict=skip` / `?conflict=overwrite` 是同一套服务端语义，行的「覆盖已存在的」直接复用 `overwrite`。
3. **多一个只读计划接口**：`GET /api/jira/issues/:key/download` 只算不写，回 `{ dir, items: [{ id, filename, path, exists }] }`。页面用它既判断「还有几个没下」，也判断「哪些会撞同名」——先问后写的代价是多一次请求，换来「409 之前不碰磁盘」这个可验证的性质。隧道访客能读这个接口（只读），POST 仍是 403 `tunnel_readonly`。
4. **提示词逐个列绝对路径**：`handoffPrompt` 在目录行之后追加「已经下好的附件（直接用绝对路径读，不要再问我）：」+ 每行 `  - <绝对路径>`。点了「交给 agent」但还有附件没下时，先问「这张票还有 N 个附件没下载」：**立即下载**（下完再拼提示词，接着走原来的预填 / 新会话）/ **就先用现有的** / **取消**。
5. **认 `api.media.atlassian.com`**：`attachmentRedirectAllowed` 的 host 白名单加上它（仍是 https、无 userinfo、443、无 fragment，跟随时不带 `Authorization`）。这是 Jira Cloud 自己的文件域名，签名 URL 自带一次性 token，放开它不扩大 SSRF 面 —— 真正的护栏是「只认这三个来源」而不是「只认哪些后缀」。

**为什么：** 「下载」这件事的主体是票，不是详情面板，所以入口必须回到行上；而「同名」是唯一会毁掉已有文件的时刻，因此默认动作必须是「先问」而不是「覆盖」——用户明确选了「只跳过冲突的，其余照下」这个收场方式，主按钮顺着它排。多一个 GET 计划接口不是过度设计：没有它，页面无法在不写盘的前提下说清「有几个没下」，也就没法在交接前发问。路径逐条写进提示词，是因为 agent 拿到「目录」也只能自己列、自己猜文件名，而在 Windows 上文件名还可能被 `safeFileName` 改过；给绝对路径是把这层猜测消掉。

**代价 / 可改：** 冲突询问把一次点击变成两次，全量重下老目录时会多点一次「跳过」；`exists` 只比文件名、不比大小或 mtime，Jira 上换了同名文件不会自动重下（要么「覆盖」，要么先删目录）。计划接口与下载接口各读一次详情，单票会打两次 Jira；附件多时能感到延迟，可改成 409 之后复用同一份 plan。行下方那行小结会随目录变长而省略，路径靠 hover 标题看全。

**验证：** `bridge/tests/jira-e2e.mjs` 61 例（409 清单与磁盘一致、`skip` 不重写、`overwrite` 同名覆盖、`GET download` 只算不写、隧道 403、`attachmentRedirectAllowed` 认 `api.media.atlassian.com` 但不认 `media.atlassian.com` 与后缀伪装）；`web/tests/jira-unit.mjs` 36 例（`downloadMark("exists")`、`handoffPrompt` 逐条列路径）；隔离实例（jira1，真凭据）探针：行尾按钮 → 建 `CASPH30INC-17971/` 并下了 1 个 xlsx、再点弹「有 1 个同名附件」选跳过 → 文件字节不变、换一张没下过的票点「交给 agent」→ 先问「还有 2 个附件没下载」→ 立即下载 → 目录出现且计划接口给出绝对路径。

## D243 工单号模糊从 picker 两级改成 `workItemKey ~ "<token>*"` 前缀匹配（#407）

**问题：** D241 选的「picker 找候选 → `key IN` 拉行」在真站点上毛病很硬：picker 只回约 17–20 条、不能翻页，匹配还松（`query=2135` 会把 `CASPH30BUG-17233` 一起带出来），所以我们只能在结果上方写「最多 20 个候选」，用户还得自己判断哪几条真是他要的。

**决定：** 模糊这一级不再调 picker，直接拼 `workItemKey ~ "<token>*"`：

- `parseKeyQuery` 判出 `fuzzy` 后，token 先剥掉 `*` / `?`（用户不能自带通配符），再由 `buildSearchJql` 拼前缀表达式，和其它条件照常 AND。
- 一条查询拿到真正的工单行，`nextPageToken` 照常翻页，没有条数上限，也不再需要「最多 N 条」的提示。
- 完整号查空后的自动退回保留，只是退到这条前缀查询，标 `fuzzy.fallback = true`，文案「没有这个工单号，下面是按号段模糊找到的」。
- picker 相关的桥代码（`pickIssueKeys` / `contextOf` / `PICKER` 常量 / `fuzzy.total`）整段删除；`fuzzy` 只剩 `{ token, fallback? }`。

**为什么：** 真 Jira 探针（本机凭据，只读 GET）比出来的：`workItemKey ~ "2135"` 只回号段正好是 2135 的两条；`~ "*2135*"` 会把 `12135` 也带出来；`~ "*213*"` 直接 20+ 条；`~ "casph30bug-2135*"` 回 `CASPH30BUG-21352` + `CASPH30BUG-2135`，正是要的前缀语义；`project = "..." AND workItemKey ~ "*21*"` 也照常 AND。前缀比包含准、比 picker 全，而且服务端执行、能翻页 —— 三个毛病一次解决，代码还更短。

**代价 / 可改：** 前缀语义意味着 `12135` 里含的 `2135` 不会被搜到（要包含得自己多打几位）；这符合「按号段」的直觉，但如果以后有人要「任意位置包含」，改成 `workItemKey ~ "*<token>*"` 只是一行，代价是结果明显变宽。`workItemKey` 是 Jira Cloud 的字段，其它部署形态（DC/Server）不一定有，桥没有做能力探测 —— 真遇到会以 400 `jira_query` 冒出来。

**验证：** `bridge/tests/jira-search-unit.mjs` 25 例（含「半截号走 `workItemKey ~`」与用户自带 `*`/`?` 被剥掉）；`bridge/tests/jira-e2e.mjs` 58 例（前缀 JQL 逐字断言、模糊与标题同时生效、模糊查空仍回 `fuzzy`、上游 403 照实报 403 `jira_forbidden`、`emptyOnce` 触发一次 fallback）；真 Jira 探针 `.scratch/workitemkey-probe.mjs` 六种输入逐条核对；`npm --prefix web run typecheck` + `i18n-check` 2597 keys × 3 langs。

## D244 工作目录路径 chip 常驻：左栏展开也显示（修订 D61）

**问题：** D61 把这颗 chip 的前提写成「左栏收起时」，理由是选中的会话卡片上写着同一个 cwd。实际用起来的观感不是这样：**开不开着会话列表**这件跟目录无关的事，决定了看不看得到「现在在哪个目录」—— 左栏一展开，状态行左边那段就消失，人还停在同一个会话里。用户口径（2026-11-13）：「现在只有左侧折叠才能在 chat 下面显示目录。现在想要改为，无论是否折叠左侧都显示」。

**决定：** `syncCwdChip()` 的判据从 `!(this.collapsed.sessions && !this.compact())` 收成 `this.compact()` —— 桌面宽度下不管左栏收没收起都显示；窄屏（<900px，左栏是一页 tab、没有折叠这回事）保持隐藏。位置（`fillHintStatus()` 里 `prepend` 到 `.composer .hint-status` 最前面、紧挨分支 chip 左边）、样式、点击复制全都不动。

**为什么只动这一条：** 折叠状态本来只该管「旁边的列表怎么摆」，不该兼任「当前会话有没有目录」的信号。解耦之后，A/B/C/D 四种壳乘上「收起 / 展开」看到的都是同一颗 chip。左栏展开时会话卡片上的路径与它并存不算重复：卡片是列表里的一条，这颗是「现在」的那一条，位置和用途都不同。

**代价 / 可改：** 状态行左边常驻一段等宽字（`max-width: 42ch`，约 130px），桌面窗口窄一点时会先把右边的按键提示挤掉；没有仓库的会话里它排在按键提示前面。不想要就只改 `syncCwdChip()` 那一行；要窄屏也显示再去掉 `this.compact()`。

**验证：** `npm run build:web && node probes/round21-cwd-line.mjs`（左栏展开时在且是当前会话 cwd / 收起后仍在、与分支 chip 同一行且紧挨其左 / 不再有独立 cwd 行 / 点击复制 / 展开左栏换会话跟着换 / 窄屏消失 / 拉回桌面宽度又出现；截图落在 `.scratch/round21-cwd-line/shots/`）。
## D245 预览里的翻译对照：另起 pi 子进程翻，译文可改、可写回原文

> **D245 修订（2026-11-14）：** 下文第 5 条「更新只重翻变了的节」的判据不再只看 `old.src === 新节文本 && old.out`。机器没翻成的节（模型调用失败 / 输出不合格重试耗尽）带 `failed?: boolean`，`out` 里摆的是原文；旧缓存里没这个字段但 `out === src` 的坏结果同样按坏结果处理 —— 这些节点「更新」必须真重翻，否则一份日文源、选中文的对照会一直停在左右都是日文。但人已经接手改过的译文（`out !== gen`）以人写的为准，别再让机器覆盖掉。整篇只要有一块没翻成，`TranslateJobs` 就把 job 记成 `error` 并带上原始原因，前端不再写「翻完了，可以直接改译文」；`piChildEnv()` 给 pi 子进程补 loopback `NO_PROXY`，免得本机外部代理把 `127.0.0.1:7863` 上的网关请求截走。其余（分节 / 代码不翻 / 表格校验 / 缓存位置 / 同步回原文）不变。

> **D245 修订（2026-11-14，同步回原文）：** 第 7 条「`out` 与 `gen` 逐块比」有三个坑一起补了。① 在编辑器里打开再保存一次，节尾就会多几个空行，`out !== gen` 于是成立 —— 比对前先抹掉尾部空行（`sameSection`）。② 模型翻译时会把 `---` 这类分隔块吞掉（有时又留着），块数一比就判「结构变了」，改一个标题也得把整节拎去整节重译，还可能把没改的节漂掉 —— 现在三边都先摘掉分隔块再比，真对不上（人合并 / 拆开了段落）才退回整节重译。③ 语言护栏只看单块假名，「## 練習」「## 本文の中国語訳」这种假名很少的日文块写回正确日文反而被判「写回的是日文，原文不是」（用户实测：改完标题点同步，只回一句「写回的是日文，原文不是；这一块没有写回」）—— 现在整篇是日文（`docJa`）时假名 ≥ 1 的块也算日文、阈值降到 1；标题判完即返回，不再落进「原文不是日文」那条；写回与原文完全一致只是「没改动」，一律放行。日文稿里确实是中文的块照旧退回。④ `docJa` 原来只看全文假名数 ≥ 3（连 `・` 也算、还算进了围栏代码），中文稿里夹一段日文引文就会整篇被当成日文，标题写回反被误判 —— 改成看正文（去围栏）假名密度 ≥ 12%。⑤ 整节重译是最后手段，也会失败：原来它在 `try` 外抛错会连累整个 `planSync`，已经算好的块级改动全丢，现在同样只记 warning。**已知取舍：** 全汉字日文标题（`## 練習`）没有假名，汉字区又分不出中文日文，所以只在「写回与原文完全一致」时放行；改一个字（`## 練習問題`）仍会被当成中文退回并告警 —— 宁可让用户手改这一行，不拿中文标题盖到日文原文上。

**问题：** 用户要求「文件预览加翻译对照：1、加入翻译对照 2、直接修改翻译后的文档，同步更新（任务简单可以交给便宜模型，用户可选，不占用当前对话上下文）」。预览面板（D50/D63）此前只能看原文、改原文，遇到日文文档只能整段贴进对话让模型翻 —— 那就把几 KB 原文灌进正在用的会话上下文，翻完也拿不到「左右对着看、改一处译文只动那一处」的体验。

**决定：**

1. **翻译是另起的 pi 子进程，不占会话上下文。** `bridge/src/translate.ts` 用 `spawn(process.execPath, [cli, "--mode","text","-p",<短指令>, …])`，正文走 **stdin**（Windows 命令行长度不可控；pi 把 stdin 内容拼在 `-p` 消息前面，所以正文末尾自带空行）。参数固定 `--no-session --no-tools --no-context-files --no-skills --no-prompt-templates --no-mcp --thinking off`：不给它读文件、不给它 AGENTS.md、不管扩展与 MCP，翻译只吃 stdin 里那一段。模型在 fast 目录（`sessions.modelsFast()`）里时再加 `--no-extensions` —— 带扩展的启动要 12–15 s，翻译这种纯文本活不该等它。
2. **模型由用户选，默认偏向便宜的那个。** 前端选择器列的是 `App.models`（桥推的目录），预选顺序：`localStorage["pi.trModel"]` → 会话当前模型 → 第一项。记住上次选的是刻意的：同一份文档重译不必再挑一遍。
3. **译文存状态目录，不碰源文件。** `statePath("translate", "<basename>.<sha1(abs|lang)[0:16]>.json")`，每份 `{abs, lang, provider, model, mtime, size, startedAt, warnings, sections}`。放在仓库旁边会污染被翻译的工程（用户多半在别人的 repo 里翻文档），丢在状态目录里最多丢缓存，重翻一次即可。
4. **分节翻译 + 代码段不翻 + 表格结构校验。** 按 `#{1,2}` 切节（preamble 一节，围栏与 HTML 注释里的 `#` 不算标题），节是左右对照的对齐锚点；节内把围栏代码块单独摘出来原样拼回，模型动不到代码；正文按空行分块、每块 ≤ 4000 字。每块回来先校验：表格行数 / 每行 `|` 数量必须一致（先剥行内代码），译文不能是原文回声（源含 ≥ 20 假名而译文假名 > 80% 判照抄）。不合格重试一次，仍不合格就**保留这一块的原文**并记 warning，不拿一段坏译文覆盖整节。
5. **更新只重翻变了的节。** `keep` 里按 `heading || "\u0000preamble"` 记上一版的 `src`，`old.src === 新节文本 && old.out` 就直接复用。换模型不 keep（`force`）—— 不同模型的译文混在一份文档里没有意义。
6. **改译文只改缓存，`gen` 是机器基线。** 每节存 `{src, gen, out}`：`gen` 是模型这一次的输出，`out` 是当前译文（可能被用户改过）。保存译文只写 `out`，源文件一个字节不动；「你改过」的标记就是 `out !== gen`。
7. **同步回原文走两步，且可预览。** `out` 与 `gen` 逐块比，变了的块连同 `src` 一起交给模型「把改过的地方折回原文，其余照抄」，回读的原文块再过一次表格校验；块结构对不齐时整节重译并告警。`/api/translate/sync` 只算差异、把结果挂在 `pendingApply` 里返回前 20 处前后对照；用户点「写回原文」才 `/api/translate/apply`，校验 `mtime`/`size`（被人改过就 409，重新点一次同步），写前把原文备份到 `statePath("translate","backup", …)`。写盘复用 `writeTextFile`（GBK / BOM 规则与预览保存同一份）。写回成功还要把缓存里的 `src` 换成新原文、`gen` 归到当前 `out`（我第一版漏了这步，用户在对照页点了「写回原文」：提示说写完了，左边还挂着翻译那一刻的旧快照，看起来像没生效）。`patch` 更新任务里的 doc 时也要先读一遍磁盘上的那份，别拿翻译开始时的 `mtime`/`size` 写回去 —— 那样页面立刻又报「译文过期」。
8. **改译文也保留原文，右边一节一个编辑框。** 编辑态不是把整篇译文塞进一个大 textarea：左边照旧渲染原文，右边每节一个自带高度的 `textarea.tr-sed`（`wrap="soft"`、按 `scrollHeight` 撑高、不再有内滚动条），两栏按节等高对齐，保存时用 `"\n\n"` 拼回整篇交给桥（节的划分规则与桥同一份，节数不变才算合法）。第一版是整篇一个大框、左边空着 —— 长行不折、右边被裁，用户一眼就看出来不对。
9. **对照是单滚动条的一行一节。** 左原文右译文，同一节同一行、等高，整块跟着 `.viewer-body` 滚。两列各自滚会错位 —— 长表格里右边一滚，看到的就不是左边那一节了。开始翻译时自动进全屏（不写 `pi.viewerFull`，关掉面板不留全屏偏好）。
10. **换文件就清空译文状态并停轮询**（`openPreview` 里比较切换后的 path/session；一开始写成比较赋值后的值，永远相等，等于不清）。

**为什么：** 翻译与「随手问」（D86）是同一类活：一次性的、跟当前对话无关、用完就丢。走会话内联就等于把几 KB 原文塞进上下文，还占着用户正在用的那个模型；走子进程则上下文干净、模型可换、钱能算在便宜的那个头上。译文放缓存而不是源文件旁边，是因为「翻译」只是用户看的方式，不是文档的一部分 —— 真要把译文留在仓库里，那应该是一次显式的另存，而不是翻一下就在别人仓库里多出一个 `*.zh.md`。分节 + 代码段不翻 + 表格校验三件事合起来才有「改一处只动一处」：不分节就对不齐，不摘代码模型就会顺手改代码，不校验表格就会出现译文比原文少一列而用户看不出来。

**代价 / 可改：** 翻译质量取决于模型，桥只做结构校验（表格 / 回声 / 长度），做不了语义校验；每节一次 spawn，几十节的文档要一分多钟（进度按节报，可取消）；反向同步是「模型改写原文」，改不动的块会跳过并告警，不是逐字节 diff 回放；同步只给前 20 处对照，超出部分照样写回但不显示；译文只在 `markdown` / `text` 且 ≤ 512 KB 的预览里有入口（表格/幻灯片/PDF 不做）；多标签页同时改同一份译文，后写的覆盖前者（`out` 没有版本号）。

**验证：** `bridge/tests/translate-unit.mjs` 38 例（分节/围栏/分块/表格校验/清洗/整篇翻译/`keep` 复用只翻改过的节/`planSync` 只挑出改动的那块/`applySync` 只替换那一块/找不到位置/照抄与语言跑偏告警/脏标题写回日文）；`bridge/tests/translate-e2e.mjs` 41 项（桩 pi 跑通 start→save→sync→apply，含公网 403、409 冲突、备份）；`probes/translate-ui.mjs` 30 项（真 Chromium：译按钮、选择器、两栏对照、逐节编辑、同步确认、写回后左栏刷新）；`npm run typecheck`（bridge / peer / web 三份 tsc + `i18n-check` 2641 keys × 3 langs）。真机（`github-copilot/gpt-6-luna`）：1.7 KB 日文文档翻中文 36 s；小文档改一处 7 s 翻完、44 s 折回；日文文档里被写坏的中文标题改一次即写回「# 私の父は徐藤恩です」，20.5 s。

## D246 上下班：解锁时间三级取证，从第一次解锁起算墙上 N 小时

**问题：** 用户要求「想要在本机管理里面 加一个上下班管理的模块。显示的是每一天打开屏幕输入密码解锁的时间。然后用户可以设定每天工作的时间，默认 9 小时，用户可设置。然后显示下班倒计时」。核心难点不是倒计时，是**解锁时间从哪来**：用户第一轮就否掉了「只看系统日志」的方案（原话「我一定要的是解锁时间。要准确。」），而准确的历史解锁时间在本机只有 Security 日志 4800/4801 一条路，非管理员读不到。

**决定：**

1. **三级取证，页面上逐条标来源。** ① 常驻记录器实时收 `SystemEvents.SessionSwitch`（事件）；② 记录器里每 15 s 一次 `Get-Process LogonUI` 兜底（估计）；③ 页面上一颗「导入历史（需管理员）」按钮，走一次 UAC 读 Security 4800/4801 回填（日志）。三点都不是摆设：事件最准但只有装了记录器之后才有；轮询 13 ms 但只能判「锁屏界面在不在」；日志最全但要 UAC。
2. **记录器是每用户计划任务，日常零 UAC。** `Register-ScheduledTask -TaskName pi-web-client-workclock -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Settings (… -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable)` —— 不传 `-User/-Password` 就不需要管理员（实测 Principal 落在 `Interactive/<user>`、`Start-ScheduledTask` 立刻起、卸载干净）。脚本落在状态目录 `workclock/workclock-agent.ps1`，页内开关直接注册/开停/卸载。
3. **一天只认第一次解锁，倒计时不重置。** 工时口径是**墙上时间**（午休照走），不是「累计在线时长」—— 用户要的是「几点能走」。再解锁几次只进今日明细（`unlocks` 计数）。目标时刻 `target = firstUnlock + hours`，`remainingMs` 可以为负，归零后变「已下班 +X」。
4. **来源优先级：真实事件 > 轮询估计 > 日志回填 > 记录器启动时刻。** 中途才装上记录器时它写的 `start` 事件最弱 —— 否则 15:00 装的记录器会把上班时间顶成 15:00，盖掉回填出来的真 09:00。
5. **工作日可改，休息日只记解锁不算倒计时**（`met` 恒 false、不显示倒计时）。默认周一–周五、默认 9 小时，`saveSettings` 只接受 0.5–24 之间的数（越界回 400，不静默夹到 24）。
6. **公网只读：** `/api/sys?section=workclock` 在隧道下照常返回但 `public:true`；`/api/sys/workclock/{settings,agent,backfill}` 一律 403 —— 装记录器、导入历史都是本机才能做的事。
7. **提醒分两条：** 页面 toast 默认开（`settings.notify`）；系统通知要用户点一下「允许系统通知」（浏览器权限必须手势）。

> **被 D286 取代的部分（2026-11-17）：** 第 2 条「每用户计划任务」不成立 —— 标准用户机器上 `Register-ScheduledTask` 一律 `Access is denied`，而且它报的是 CIM 非终止错误，脚本照样打 `{"ok":true}`。登录自启改成 HKCU 的 Run 项，装完回读验证，见 **D286**。其余口径（三级取证、第一次解锁、来源优先级、公网只读）不变。

**为什么：** 轮询做不到「准确」——15 s 的采样丢掉的正是用户输密码那几秒；事件驱动能拿到精确时刻但不能追历史；Security 日志能追 90 天却要 UAC。三条合起来才对得上用户那句「要准确」：日常靠事件，漏了靠轮询，历史靠一次性 UAC。至于「从第一次解锁起算 N 小时」而不是累计在线，是因为用户问的是「几点下班」，累计口径一午休就答不上来。

**踩到的坑（都在真机端到端才暴露，单测看不见）：** ① PS 里 `$line + "\n"` 得到字面反斜杠 n，`agent.jsonl` 全是坏行 —— 改 `[IO.File]::AppendAllLines($path, [string[]]@($line), $utf8)`；② PowerShell 5.1 按 ANSI 读无 BOM 的 `.ps1`，脚本里一加中文注释就 `缺少右「}」` —— 落盘统一 `\ufeff` 前缀；③ `String.raw` 模板里写反引号会截断模板块（报 537 个假 TS 错误），PS 正文与注释里都不出现反引号；④ `Add-Event 'start' 'event'` 写成 `k="start"` 被解析器丢掉，今天直接没有上班时间 —— 改成 `k="unlock" src="start"`；⑤ bash 里拼 `Get-CimInstance … | ForEach-Object { $_… }` 会被 MSYS 吃掉 `$_` 报 127，复杂 PS 一律走 `.ps1` 或 `-EncodedCommand`。

**代价 / 可改：** 记录器是常驻 powershell 进程（约 40–60 MB），停掉后当天的后续解锁只能靠日志回填；Security 日志默认只留 20 MB（约 1–2 周），回填封顶 90 天且页面写明实际覆盖；工时是墙上时间，早退/加班只有「已下班 +X」一个反馈；事件驱动的锁屏/解锁依赖 `SystemEvents`（无桌面会话时收不到，例如 RDP 断连），那种情况靠轮询。

**验证：** `node bridge/tests/workclock-unit.mjs` 22 例（换行/去重/来源优先级/当日推进/休息日/夹取工时/覆盖统计）；`node web/tests/sysmanage-unit.mjs` 13 pass（倒计时格式/工时解析/星期换算）；`node bridge/tests/sysmanage-ui.mjs` 真 Chromium 48 项（五个分区、倒计时每秒在走、七日 chip、记录器卡片、公网 403 三条、改工时 8.5 落盘、工时 99 回 400、布局不穿模）；真机装了记录器后 `agent.jsonl` 有 `{"k":"unlock","src":"start"}`、心跳新鲜、`Get-ScheduledTask` State `Running`，卸载后任务与进程都不残留。

## D247 验收跑成「测试书」：`/pi-web-test-html` + 随仓库发布的技能

**问题：** 上下班模块验收时临时写了四个脚本（`run.mjs` 驱动、`build_xlsx.py`、`build_html.mjs`、`reset.sh`），跑出 12 条用例 + 18 张截图的 xlsx 与 1:1 复刻的 HTML。它们只活在那次会话的 `.scratch` 里：换模块要重写，换个会话没人知道有过这套流程，而且 `git worktree remove` 顺手把它们删了个干净（见 D246 的代价段）。要的是「下次任何模块，一条命令跑出同一格式的书」。

**决定：**

1. **项目技能** `.pi/skills/pi-web-test-html/`：`SKILL.md` 是流程（定对象 → `env.sh fresh` 起隔离实例 → `run-book.mjs` 跑用例 → `build-xlsx.py` → `build-html.mjs` → 交付 → `env.sh down`），`bin/` 放四个可单独运行的脚本，`cases/` 放用例集（首份是 `workclock.mjs`），`setup/` 放模块自己的系统级清场，`references/` 放「用例怎么写」与「踩过的坑」。带 `disable-model-invocation: true`，只由命令唤醒。
2. **命令** `.pi/prompts/pi-web-test-html.md`（提示词模板），`argument-hint` 收用例集与补充要求；模板只指向 `SKILL.md` 并交代边界（不改产品代码、失败如实记录、跑完关环境），流程不复制第二份。
3. **驱动与用例分离**：`bin/run-book.mjs` 管浏览器、登录、截图落盘、`spec.json`（含 `summary`、`env`、`pageErrors`），用例只写 `h.openCase / h.step / h.ok / h.fail / h.shot` 四件套。判定三态：通过 / 失败 / 人工（人工步骤要写清怎么补）。
4. **产物落在主检出的 `.scratch/testbook/<用例集>/`**，即使命令是在 worktree 里跑的 —— 用 `git rev-parse --git-common-dir` 反推主检出。这是被删过一次之后的硬约束。
5. **HTML 是交付物、xlsx 是下载物**：HTML 把 18 张截图与 xlsx 全部内联成 data URI（单文件 2.5 MB），页内有「下载 xlsx」按钮；两者都由 `layout.json` 同一份表格模型渲染，观感与 xlsx 一致。

**为什么：**

- **流程必须固化在仓库里**：这套步骤里有太多「不看就忘」的细节（A 列要 9 宽、`fitToPage` 不设会被 A4 切列、LO 重算公式缓存、sticky 三轨 z 序、data URI 内联），写进 `references/pitfalls.md` 比每次靠记忆靠谱。
- **驱动与用例分离**：换模块只写用例，不重写浏览器样板；判定口径、截图命名、`spec.json` 结构也就不会漂。
- **显式触发**：跑一本书要起实例、装计划任务、跑几分钟，模型不该自己决定。

**代价 / 可改：**

- **只对仓库里跑的 pi 可见**（项目级技能与模板，换目录就没了，和 `pi-web-client-test-dev` / `whatsnew-write` 同一边界）。
- **用例集与模块强绑定**：`workclock.mjs` 里写死了分区序号（第 5 个）、按钮文案、接口路径；产品改这些，用例得跟着改（跑失败先怀疑用例，其次才是产品）。
- **`fresh` 会清空该实例的状态目录**：要保留上一轮数据就用 `env.sh up`。
- **人工用例不能自动点**：TC-03（真锁屏）、TC-10（UAC 读 Security 日志）在书里标「人工」，`ConsentPromptBehaviorAdmin=5` 的机器上 UAC 必须人来点。

**验证：** 用技能自己的脚本重跑一遍完整链路：`bash bin/env.sh fresh F:/pi-web-client wk workclock` → `node bin/run-book.mjs --case workclock` → 12 条（通过 10 / 失败 0 / 人工 2，21 步 18 张截图，`pageErrors` 0，产物 `F:\pi-web-client\.scratch\testbook\workclock`）→ `python bin/build-xlsx.py` → 14 sheet、902 KB、LO 重算过 → `node bin/build-html.mjs` → 2521 KB、18 处 `data:image/png;base64`、0 处 `src="shots/`、xlsx 已内联；`bash bin/env.sh down wk` 后 `Get-ScheduledTask -TaskName 'pi-web-client-workclock'` 为 `GONE`。

## D248 局域网共享市场（skill / 扩展 / MCP）：P2P 公告 + 镜像字节的设计共识与首版实现（用户要求 / 设计评审）

**问题：** 用户（2026-11-13）：「局域网内基于公司、项目的共享skill、插件、mcp服务的市场。 只要用户部署了本程序，因此有局域网连接功能。现在想要在扩展按钮里面追加这样的功能。 每个用户都能上传skill、扩展、mcp服务。」本条先记设计共识（grilling R1~R7 共 25 项决策），随后在 2026-11-14 于 `feat/lan-market` 完成首版实现并验收。编号顺延到 D248：本分支写文档时 main 还没有 D246，合并时 main 已先占用 D246（上下班）/ D247（测试书技能），不能覆盖别人的条目。逐文件施工清单见 `.scratch/lan-market/PLAN.md`（被 `.gitignore:7` 忽略，不进提交）。

**现状事实（只读勘察）：**

- 扩展面板 `web/src/app.ts:10737-10739` → `openExtManager()` `web/src/app.ts:12657-12685`，`div.sheet.settings-sheet.ext-sheet` 三 tab「已安装 / 扩展商店 / MCP 商店」`web/src/app.ts:12668-12670,12730-12745`；技能商店是另一套独立 dialog `openSkillStore` `web/src/app.ts:4893-4896`。入口是「扩展按钮」，不是独立页面。
- `bridge/src/market.ts:1-9` 头注释 `Nothing here installs anything`：现有商店只做公网目录 + 缓存；WS 注册 `bridge/src/index.ts:2758-2774`，写操作 `bridge/src/index.ts:2666-2717,2776-2841`。
- 三套安装器互不相通：skill 从 GitHub 下载文件夹写 `.pi-store.json`（`bridge/src/skillstore.ts:635-713,715-726`，配额 `bridge/src/skillstore.ts:588-590` 为 16 MB / 64 MB / 400 文件）；扩展走 `pi install`（`bridge/src/picli.ts:39-97`，`case "pkg.install"` 在 `bridge/src/picli.ts:44-45`）；MCP 走 `pi mcp add` 只写配置片段、secret 只写 `${VAR}`（`bridge/src/market.ts:389-404,769-803`、`bridge/src/picli.ts:57-87`）。三套都没有签名 / 白名单 / 沙箱 / 内容审查。
- peer：组播 `239.255.42.99:7866`、HTTP `7865`、bind `0.0.0.0`（`peer/src/config.ts:10-12,69-71`），`PROTO = 1`（`peer/src/config.ts:6`），hello 只带身份（`peer/src/discovery.ts:7-15,113-123`），无广播 / 订阅 / 签名（`docs/DECISIONS.md:1146`）。`peer/src/http.ts:137-144` 是单 `createServer` 连续 `if` 分发，目前**没有任何** `/market/*` 端点，兜底 `peer/src/http.ts:453-456` 返 404；`/files` 只对回环开放（`peer/src/http.ts:418-419`），LAN 上唯一文件通道要求互为好友（`peer/src/files.ts:164-167`）；原始 upload 上限 64 MB（`peer/src/http.ts:402`），`GET /status` 在 `peer/src/http.ts:146-159`。
- 鉴权：单机单口令 + cookie（`bridge/src/auth.ts:5-6,36-42,77-103,125-129`），公网隧道 `stepUntil = 0`、本机 / 局域网放行（`bridge/src/index.ts:1682-1683`），`skill.install` 已明确拒公网隧道（`bridge/src/index.ts:2481-2484`），`web/src/app.ts:13095` 按 `me.public` 把商店转只读；无用户 / 角色 / 管理员、无 company / org / tenant / team 领域模型，只有按目录分的 `scope: "user" | "project"`（`bridge/src/market.ts:189,207`、`bridge/src/skills.ts:65`）与按 cwd / git 根分组的 workspace（`bridge/src/workspaces.ts:31-44`）。
- 浏览器只经 bridge 转发（`web/src/peer/main.ts:3-4`）；`bridge/src/peer.ts:106-125` 每 5 秒只拉本机 `/status`，`bridge/src/peer.ts:130-155` 已有 GET/POST 转发基础，`bridge/src/peer.ts:204-215` 的 `upload` 走 64 MB 原始字节。全仓无 `multipart/form-data`；`bridge/package.json:18` 已有 `fflate ^0.8.3`，zip 读写不需新增依赖。

**决定（R1~R7 共 25 项，问卷逐项确认）：**

*R1 架构与形态*

1. **P2P 自发现，零中心部署**：每台自己发布 + 托管，复用组播在线节点表，不新增 registry 服务。
2. **「公司 / 项目」只是用户自建的分类路径**，无成员身份、无租户；分类示例「公司 / 项目 / 其他」可改。
3. **自包含包，市场托管字节**（边界由第 22 项按类型细化）。
4. **开放发布 + 安装前明示**：人人可发布、可安装，不设审批；确认页列原发布者、镜像主机、清单与风险。

*R2 目录与镜像*

5. **浏览时按需拉取**：打开市场 tab 时逐个在线节点 GET 一次清单再合并，本机 JSON 缓存；零后台同步。
6. **分类归属各人本地自建**：发布者写分类路径字符串，浏览者并入自己的树，不推全局分类表。
7. **完整清单字段**：`id` / 类型 `skill|extension|mcp` / 名称 / 描述 / 版本 / 分类路径 / 发布者 `nodeId` + `nickname` / 宿主 `hostname` / 字节大小 / 内容 `sha256` / 上传时间 / 依赖或启动说明。
8. **自动互为镜像**：安装成功即成为该版本字节的提供者；原发布者离线仍可从镜像安装（此选择覆盖了早期「离线即灰色不可装」的假设）。

*R3 权限、MCP、安装*

9. **仅原发布者可改删**：原发布者 `nodeId` 为唯一权威，镜像只提供字节。
10. **安装成功即成为镜像**（与第 8 项同一条，落点在安装流程）。
11. **MCP 只分享配置片段**：`mcp.json` 片段 + 依赖 / 启动说明 + 需填变量清单，不内置运行时代码；secret 由各人自己填。
12. **统一落包 + 按类型分派**：下载 → 校验 sha256 / 大小 / 路径穿越 → 解临时区 → 展示清单 → 按类型安装。

*R4 删除、字节、发布、版本*

13. **墓碑随清单收敛**：删除写带原发布者 `nodeId` + 时间戳的墓碑，各节点浏览拉清单时见到就隐藏并删本地镜像；原发布者离线期间镜像仍可装，等其上线才最终收敛。
14. **新增 `GET /market/blob?id=&sha256=` 对 LAN 开放、不要求好友**；下载后按清单 sha256 + 大小强校验，不符拒装；确认页同时列「原发布者」与「当前镜像主机」。
15. **两种发布入口都支持**：从「已安装」一键发布 + 上传手工 zip（内含 `manifest.json`）；共用同一 `manifest.json` 规范。
16. **同 id 只展示最新版**：id 稳定、版本号递增，列表只显示最高版本，安装与镜像自动替换成最新。

*R5 协议与落盘*

17. **公告（published）与可得性（blobs）解耦**：清单拆两层 —— `published` 只由原发布者产出、镜像原样转发（保留发布者 `nodeId` + `version` + 时间戳，合并取最高 `version`，旧镜像盖不掉新版）；`blobs` 列本节点实际持有的 `(id, version, sha256)`。安装时对目标版本从 `blobs` 挑在线节点拉。
18. **`(发布者 nodeId, 本地 id)` 复合主键**：id 只需发布者本机唯一，全局靠 `nodeId` 消歧；合并 / 版本 / 墓碑全按复合键；去中心无需协调，改昵称或 hostname 不影响历史。
19. **市场自管落盘、与现有来源标记隔离**：统一市场安装器 —— skill 解到技能目录并写 `.market-meta.json`；扩展按形态放文件 / 目录并登记 settings（或本地路径 `pi install`）；MCP 生成片段转 `mcp.add`，`${VAR}` 在确认页填；卸载走市场自己删目录 + 撤登记，不污染现有卸载 / 更新语义。
20. **独立缓存目录 + 软上限淘汰**：缓存放 `~/.pi-peer/market/`，单包沿用 64 MB，总缓存软上限 2 GB（可改），超限时优先淘汰「最久未被本地安装、且非本机原创发布」的镜像字节；本地原创发布优先保留。

*R6 信任与曝光*

21. **不加签名，明确「局域网可信」**：公告 / 墓碑按 `(nodeId, id)` 明文合并，sha256 只负责字节不被传输偷换；「仅原发布者可改删」定性为协作约定而非密码学保证，风险写进安装确认页。
22. **按类型约定托管边界**：skill 与 loose 扩展托管实体文件，但不含 `node_modules` / 站点包 / 大二进制，依赖写进清单由各人本机环境或在线补；pi 包只存来源引用（`npm:${p.name}`，`web/src/app.ts:13113`）、装时在线拉、条目标「需联网」；MCP 只配置片段。
23. **全量公开 blobs**：只含 id / 版本 / sha256 / 大小 / 分类，不含本机绝对路径或配置内容。

*R7 收敛*

24. **镜像转发见过的全部公告与墓碑**：原发布者离线后新节点仍能从任一在线镜像学到条目，仅字节可得性受 `blobs` 限制。
25. **时间戳单调裁决，谁新谁赢**：墓碑压掉所有更早公告，更晚公告或新墓碑又能盖过它；删后可同 id 重发、`version` 继续递增，旧镜像与历史快照无需清理。

**协议与包格式（按约定由我定下的可改默认值）：**

- peer 7865 新增三个端点：`GET /market/manifest`（对 LAN 开放）、`GET /market/blob?publisher=<nodeId>&id=<local id>&sha256=<hex>`（对 LAN 开放；R4 先写 `id=&sha256=`，R5 的复合主键补 `publisher`，落地规范见 `docs/lan-market-protocol.md`）、`POST /market/publish`（限回环，bridge 用原始字节调）；沿用 `peer/src/http.ts:402` 的 64 MB 单包上限。
- `PROTO` 保持 1；旧节点对 `/market/*` 返 404 时当「不支持市场」跳过，不把它从在线表剔除。hello 加自定义字段旧节点会忽略（`peer/src/discovery.ts:125-132,172-216`），故无需升级协议号。
- 公网隧道下市场 tab 只读，写操作在 bridge 侧拒掉（与 `bridge/src/index.ts:2481-2484` 的 `skill.install` 同口径）。
- 市场不复用 `cfg.hidden`（那是内网通通讯录的隐身），维持第 23 项的全量公开。
- 墓碑只隐藏条目并删镜像缓存、不动已安装；新版只在条目上提示，不静默升级（第 5 项无后台同步）。
- 手工 zip 与一键发布共用同一 `manifest.json`；默认分类示例「公司 / 项目 / 其他」；沿用现有「全局 / 当前项目」下拉（`web/src/app.ts:13032-13038`）；MCP 的 `${VAR}` 在确认页填写。
- 文案走 `tr("中文原文")` 并补 `web/src/i18n/en.ts` / `web/src/i18n/ja.ts`（`npm --prefix web run typecheck` 会跑 `web/i18n-check.mjs`）；Playwright `newContext()` 带 `locale: "zh-CN"`。
- 首版实现与验收同在 `feat/lan-market` worktree 完成，按 `AGENTS.md` 的流程提交、开 PR，合并等用户明确指令（2026-11-14）；实现细节见 `docs/lan-market-protocol.md` 与下方「实施补记」。

**为什么：**

- 拆 `published` / `blobs` 两层是第 5 + 8 + 14 项的必然：原发布者一发新版，`version` 与 `sha256` 同时变，镜像手里只有旧版字节，按新 sha256 请求 `GET /market/blob?id=&sha256=` 必然拿不到；而 `peer/src/http.ts:137-144` 是单 server 分发、没有广播 / 订阅 / 后台同步，只有「公告与可得性解耦」能让离线发布者不拖死镜像。
- 复合主键 + 不加签名，是第 1 项「零中心部署」+ 第 4 项「开放发布」+ 现状（`peer/src/config.ts:98-111` 的 `nodeId` 是裸 uuid、可手改；`peer/src/discovery.ts:113-132` 的 hello 无凭据）共同决定的：引入密钥体系会推翻这两项前提，故把风险显性化写进确认页，而不是假装解决。
- 自管落盘是因为复用三套安装器会连踩三处：`skill.install` 本地分支把 `marker.local` 写成临时解包目录（`bridge/src/skillstore.ts:640-653`），卸载 / 更新指向已删目录；扩展同时有 loose 文件 / 目录与 pi 包两种形态（`bridge/src/market.ts:241-271`）；MCP 片段须转成 `mcp.add` 的强校验形状（`bridge/src/picli.ts:57-87`）。
- 单包 64 MB + 2 GB 软上限 + 按类型边界，是因为 `bridge/src/skillstore.ts:588-590` 的配额只管 skill，市场要同时扛 skill / 扩展 / MCP 三种包；pi 包只存来源引用是为了不把 `node_modules` 塞进 LAN 字节通道。
- 先把协议与包格式钉在纸上：清单协议一旦写进 7865，所有节点都要跟着改；收口问卷先选「只写设计共识文档」，随后在同一分支按文档实现，协议规范没有变成空头承诺。

**代价 / 可改：** 已接受的残留风险 ——（1）无签名 → 同网段可冒名发布或伪造墓碑藏条目；（2）原发布者离线期间镜像仍可装、墓碑等其上线才收敛；（3）pi 包离线装不了，互为镜像对它打折；（4）时钟回拨会让时间戳裁决反常；（5）blobs 全量公开意味着同网段能看出这台装过哪些包；（6）2 GB 软上限会淘汰最久未用的镜像字节。可改默认值全部集中在上面的「协议与包格式」段：端点路径、`PROTO`、404 降级策略、分类示例、2 GB、`tr()` 文案 —— 改任一项都不动 25 项决策的前提。另：手工 zip 与一键发布两套打包 / 校验 / 表单，第一版工作量约翻倍（第 15 项用户覆盖了推荐项）。

**验证（设计，2026-11-13）：** R1~R7 共 7 轮问卷 25 项选择 + 最后一轮「达成共识，可以收口」「只写设计共识文档」的确认。可进版本库、给所有节点参照的协议与包格式钉在 `docs/lan-market-protocol.md`；逐文件施工清单、测试矩阵与验收步骤写在 `.scratch/lan-market/PLAN.md`（`.gitignore:7` 忽略 `.scratch/`，不进提交）。

**实施补记（2026-11-14）：**

- 落点：peer `peer/src/market.ts`（350 行，帧解析 / 公告与墓碑快照 / blobs 落盘 / 2 GB 软淘汰）与 `peer/src/http.ts`（`/market/manifest`、`/market/blob`、`/market/publish` 三个端点，`POST` 仅回环）；bridge `bridge/src/market-lan.ts`（705 行，清单并发拉取与 `(version, at)` 裁决、sha256 强校验、按类型安装 / 卸载、安装成功即转镜像）与 `bridge/src/index.ts` / `bridge/src/peer.ts`（WS 五个 op，写操作拒公网隧道）；web `web/src/app.ts`（扩展面板第四 tab、确认页分列原发布者与镜像主机、MCP `${VAR}` 输入框）+ `web/src/i18n/en.ts` / `ja.ts`（各 40 条文案，走 `tr()`）。`PROTO` 仍为 1，旧节点 404 按 `unsupported` 跳过。
- 三实例 e2e（`F:/pi-web-client-wt/feat/lan-market/.scratch/lan-market/e2e/results.json`）：14 个 case / 40 步，`failedSteps=0`、`failedCases=0`，覆盖手工 zip 发布、跨节点发现与安装、自动互为镜像、原发布者离线仍可从镜像装、扩展实体包、MCP 变量填写、墓碑在离线期间收敛、同 id 重发复活、从「已安装」一键发布、公网只读、旧节点降级、收尾关环境。
- 测试书：`F:/pi-web-client-wt/feat/lan-market/.scratch/lan-market/局域网共享市场-测试书.xlsx`（15 sheet = 总览 + TC01~TC14，40 张内嵌真实截图，0 公式 / 0 错误）与一比一复刻的 `F:/pi-web-client-wt/feat/lan-market/.scratch/lan-market/局域网共享市场-测试书.html`（15 个 sheet 标签、点击 / 方向键切换、`#TC14` hash 恢复、40 张内嵌图、`SELFCHECK_OK`、0 console error）。两者都在 `.scratch/` 下，不进提交；三份测试环境已由 TC14 关闭。
- 编号：代码注释、协议文档与 PLAN 中原本写的 D246 全部机械改为 D248；main 的 D246 / D247 在合并冲突解决时原样保留。

## D249 点最后一轮也落在它自己那句输入上（修订 D60）

**问题：** 用户报：「选择其他用户输入计入，能自动跳转，但是选择最后一个记录，跳到的末尾，并不是我最后一次输入的记录」。截图里刻度带展开列表停在最后一行（「我现在 pi cli 装了很多扩展后，启动会很慢，能否优化，」），正文却停在那一轮长回答的末尾、输入框就在脚下 —— 他点的是「我那句输入」，看到的是「答案的尾巴」。

**根因：** `web/src/chat.ts` 的 `jumpToTurn(index)` 里有一句特判 `if (index === this.turns.length - 1) { this.follow(); return; }`：最后一轮直接回到底部并继续跟流。这是 D60 当时定的口径（「最后一轮则回到底部」），但它只在「最后一轮就是最末尾」这个前提下说得通 —— 回答一长，最后一次输入离末尾几千像素，跳过去就等于没跳。

**决定：** 删掉这条特判，最后一轮与其它轮走同一条路：`startTop()` 算出「把这一轮的用户气泡顶到视口顶部」该滚到的位置，`stopFollowing()` → 挡一帧 `holdFollow` → `scrollTo({ behavior: "smooth" })`。唯一保留「回到底部」的情形是**滚不过去**：`startTop() >= scrollHeight - clientHeight - 1`，也就是这一轮的开头本来就落在最后一屏里 —— 那时顶对齐与贴底是同一个像素，顺手把跟流留住（正在流的长回答不会断在半截，`回到底部`按钮也不会白闪一下）。

**为什么不是「永远顶对齐」：** 最后一轮短于一屏时（`probes/round20-turns.mjs` 里的 200 轮会话），顶对齐只能被浏览器夹到 `maxScroll`，位置与回到底部完全一致，却会把跟流关掉 —— 用户什么也没看见变，失去的却是「回答继续往下流我会跟着」这件事。判据用 `startTop() >= maxScroll - 1` 而不是「这一轮多高」，因为真正决定「能不能顶到顶部」的是「它后面还有没有一屏的内容」，不是它自己多高。

**坑：** `.chat-jump`（回到底部那颗钮）是 `position: sticky` + `margin: -36px 0 0`，显隐会改变 `scrollHeight` 约 6px。所以滚动目标要在 `stopFollowing()` **之后**再量一次（`startTop()` 调用两次），否则偶尔会差几像素停不正。

**代价：** 最后一轮也要先 `stopFollowing()`，所以点完最后一轮后新来的流不会自动跟（想跟就点一下「回到底部」）。这是「用户自己找了去处」的一致语义：其它轮一直如此，最后一轮不再特殊。

**验证：** `npm run build:web && node probes/round20-turns.mjs`（会话 A 的最后一轮故意做成一屏放不下：点最后一行 → 顶对齐、下方 gap > 200、`.chat-jump` 出现；会话 B 每轮都短：点最后一根刻度 → 仍贴底、跟流保留、最后一次输入在视口内）；另有 `probes/turn-rail-last.mjs` 单独盯这条 bug（4 轮 × 长回答，最后一根刻度 / 最后一行 / 中间一行三条路各量一次）。修前红：`last tick: round 4 top -884.3 pane 96.4 gap below 0`。

## D250 按回车 /「继续」之后落到自己那条气泡上（无票，用户口头报了别的 bug 时顺带发现）

**问题：** 读着几屏前的旧文按回车发一条（或点「继续」），视口纹丝不动，自己刚发的那条在视口下方一千多像素，只在右下角长出一颗「有新内容」。要看见自己发的东西，得再点一次那颗钮 —— 而随后的回答也一直待在下面。

**根因：** 两条发送路径（`web/src/app.ts` 的 `sendPrompt()` / `sendContinue()`）只把乐观气泡 `chat.add()` 进 DOM。`add()` 末尾调 `scrollToEnd()`（未 force），跟流早已被用户上滚关掉，于是走 `this.unread = true; renderJump()` 分支，一个像素都不动。而 `web/src/chat.ts` 的 `follow()` 注释早写着它被「the button, `reset()`, and **I just sent a message**」用到 —— 最后那一项从来没接线（`git log -S "scrollToEnd(true)"`：force 参数在 974a38d 引入时只给 `reset()` 用，a81a429 把它换成 `follow()` 之后仍然只有 `reset()` 叫）。

**决定：** 两处乐观气泡 `add()` + `renderChat()` 之后各调一次 `this.chat.follow()`。`follow()` 是瞬移（`scrollTop = scrollHeight`），顺带清 `unread`、藏回底钮、通知队列面板展开（`onSettleBottom`）。

**为什么不是「继续不拽你」：** 上滚不拽的前提是来的内容**不是他发的**（D68 / D94 / D168 保护的都是「在读历史的人」）。按回车这一刻是他本人要发东西，等的是随后的回答；自己那条看不见，等于发送没有回显。另一端没有被牵连：桥回灌、多端来的消息仍然走 `add()` → 未跟流时只亮「有新内容」，不拽人。

**代价：** 发送 = 瞬移到底部。想边读旧文边排队发几条的人，每发一条都会被拉回来一次；「继续」同理。换来的是发送一定有回显，且之后的流式输出照常钉底。

**验证：** `probes/send-while-reading.mjs`（桩桥、6 轮长回答；真滚轮上滚 1600px 再按回车）。修前：`sent bubble top 2322.5`（视口 96.4–718.8）、`gap below 1682`、`.chat-jump.has-new` 可见；修后：`top 646.5 / bottom 710.4`、`gap 0`、钮隐藏，随后推一条助手回答仍然 `gap 0`。`round10-scroll` / `scroll-race` / `composer-grow` / `jump-nothing-below` 四条不回归；`npm --prefix web run typecheck`（含 `i18n-check`）绿。

## D251 转录「自己跳到最底部」：滚动条槽位常驻，进场不再重排（用户报障 2026-11-14）

**问题：** 用户（2026-11-14，附截图）：「我点击展开操作记录时，会自动展开，并且展开后自动移动到最底部。但是有时候又不会。」截图里折叠块是「31 个操作 · bash ×25 · read ×6」，展开后视口停在转录末尾。

**事实（探针实测，真 Edge 量宽度）：**

- `.chat-scroll` 的滚动条是 `web/src/styles.css:83` 的 `::-webkit-scrollbar { width: 10px }` 画的，**占 10px 布局宽度**：`probes/ops-expand-scroll.mjs` 记的 `gutter = offsetWidth - clientWidth` 在真 Edge 里溢出前 1、溢出后 10。headless 的 chromium-headless-shell 是 overlay 滚动条（`gutter` 恒为 1），**这条复现不出来** —— 必须 `PI_PROBE_BROWSER=msedge` 跑真 Edge。
- 转录第一次从「装得下」变成「溢出」时，内容盒当场窄 10px，root 的 `ResizeObserver`（`web/src/chat.ts:381`）无条件 `if (this.following) this.scheduleScroll()`，而 `scheduleScroll()` 就是 `scrollTop = scrollHeight` —— 视口翻到转录末尾：探针 before `{top:0, sh:600, gutter:1}` → after `{top:6482, sh:7082, gutter:10}`，滚动写入落在 `.chat-scroll` 上（调用栈是 `scheduleScroll` 的 rAF）。
- 为什么「有时候又不会」：滚动条只在**第一次溢出**时进场。转录本来就溢出、用户又用滚轮上滚过（`following === false`，D94 / D168）时，RO 只走 `renderJump()`，一个像素都不动，槽宽也不再变。
- 为什么短会话必跳：D168 让 `stopFollowing()` / `holdUp()` 在 `!hasRoomBelow()` 时提前 return，所以**装得下的会话里 `following` 恒为 true**，没有「你已经上滚了」这个状态能救场。

**决定：** 给 `.chat-scroll` 加一行 `scrollbar-gutter: stable`（`web/src/styles.css:660`）。槽位常驻，滚动条进场/退场不再改变内容盒宽度，ResizeObserver 也就不会被这一下叫醒。`web/src/chat.ts` 不动。

**为什么不让 ResizeObserver 自己分辨宽度/高度（先试过，有洞）：**

1. RO 在**重排之后**才醒，量到的 `gap` 已经包含重排自己的增量，分不清「本来就贴着底、内容被挤高了」和「刚展开一块」。
2. 放宽到 `gap <= clientHeight` 会漏掉小增量：装得下的会话里点开一小块（增量不到一屏），重排后 gap = 300px < 一屏 → 仍被当成「贴着底」→ 照样跳（探针 A2：修复前 `top 0 → 294`）。用户报的就是「点开之后自己滚」，不因为它滚得少就不算。
3. 反过来收紧到 `gap <= BOTTOM_SLACK` 又会误伤右栏开合（跟流中一开右栏就掉队）。触发源是渲染产物，不该让重排有资格决定视口在哪；把触发源掐掉，三个方向都不用赌。

**代价 / 可改：**

- 内容列常驻窄 10px —— 装得下的会话里也留着那条空槽（真 Edge 里槽位 10px；headless 也照样留 11px，所以两种跑法下 A 的槽宽断言都成立）。10px 在 1240px 宽的转录里看不出来，但要改回「只在溢出时占位」就得回到上面那个有洞的启发式。
- Safari < 18.2 不支持 `scrollbar-gutter`：那边的行为退回修复前（而且只在真非 overlay 滚动条上才有这个病）。
- 右栏开合、输入框长高这类**真重排**该不该贴底？本条目没改它们，沿用 D94 的行为（跟流中照旧贴底）—— A 之所以能修好，只是那个触发源没了。
- 残留没修：`following` 只在 wheel / touch / 键盘手势里关闭，**拖滚动条上滚**（不产生这些手势）之后 `following` 仍是 true，一到内容增量就回到底部。修它要动 D94 的重入条件，另开一条。

**验证：** `probes/ops-expand-scroll.mjs` 五个 case —— A 装得下的短会话点开 ops（视口不动 + 槽宽不变）、A2 同一会话点开**小**一块（增量不到一屏，视口同样不动）、B 已溢出且上滚过再点开（视口不动，别为了修 A 把跟流一起关掉）、C 跟流中视口被顶矮 60px（仍贴底）、D 跟流中右栏拉开 136px（仍贴底）。去掉那一行 CSS：A 红（`top 0 → 6482`）、A2 红（`top 0 → 294`）、B/C/D 绿；加上后 A/A2/B/C/D 全绿，headless 与 `PI_PROBE_BROWSER=msedge` 各跑一遍（A 的槽宽断言只有 msedge 才有意义）。相邻探针 `jump-nothing-below`（D168）/ `composer-grow`（#319）/ `scroll-race` 全绿；`round10-scroll` 判「↓ 在正中」原来拿 border-box 宽度当中心，滚动条一占位就差 9px —— 改成按 `clientWidth`（内容盒）算，本条目之前之后都成立。

## D252 附件弹层换成「本机管理」式控制台，文件行加「引用 / 打开」（用户要求 2026-11-14）

**问题：** 下沿「文件」弹层是个 560px 窄抽屉：文件行整行点击 = 引用路径（图片 = 直接附加），没有第二种动作；文件管理器点行 = 预览；产物 chip 点整颗 = 预览。用户要求「以设置里的本机管理 UI 为模板改下沿文件按钮」，并且「给每个文件的右侧加两个按钮：引用、打开」。

**决定：**

- 新增 `web/src/fileconsole.ts` + `web/src/fileconsole.css`：附件弹层用本机管理的外壳（`.sys-back` / `.sys-console` 1120×800 / 10px 眉毛 + 25px 标题 / 214px 左栏 / 页脚）。左栏 = 快速位置（工作目录、此电脑、最近目录）+ 当前目录的子文件夹；右栏 = 面包屑工具条、跳到路径、筛选、四列表格（名称 / 大小 / 修改时间 / 操作）。
- `web/src/dirpicker.ts` 增 `tableView`、`layout: "console"`、`actions(abs, name)`：表格版把文件行改成 `<tr>`，行内放 `button.fc-pick` + 操作列；列表版在带 actions 时把行从 `<button>` 改成 `div[role=button]`（button 不能嵌套 button）。
- 三处入口的「点行」语义保持各自原样，两颗按钮只提供另一种动作：附件弹层点行 = 引用（图片行第一颗按钮改叫「附加」，行为 = 附加成待发图片）；文件管理器点行 = 打开预览，「引用」= 插路径并关掉 viewer（全屏 viewer 会盖住输入框）；产物 chip 变成 `[图标][名称][引用][打开]`，chip 主体不再可点。
- 引用统一走 `pi-quote` 事件（聊天区没有 app 引用）；「打开」仍走既有 `openPreview` / `pi-preview`。

**为什么：** 本机管理外壳已有成熟令牌与窄屏降级（D123 的 `data-console-narrow/tight`），D241 的 Jira 面板也照抄过这一套，视觉不用另起一套；`button` 里不能再放 `button`，表格化顺带把「大小 / 修改时间」变成列，操作列才有稳定位置。

**代价 / 可改：** 文件管理器的整行可点区域被两颗按钮占掉约 90px；产物 chip 比原来宽，一行能放的 chip 变少；620px 以下隐藏大小与修改时间两列（只留名称 + 操作）。左栏「最近」按会话存 `localStorage["pi.attachRecent:<sessionId>"]`（最多 8 条），换设备/清缓存就没了。

**验证：** `npm --prefix web run typecheck`（tsc + `i18n-check`，2801 keys × 3 语言）与 `npm --prefix web run build` 绿；测试实例（17876）手动全链路：附件弹层引用/附加/打开、文件管理器引用（viewer 关闭、路径进输入框）/点行预览、产物 chip 引用/打开；620 / 880 / 1440 三档 `scrollWidth == innerWidth`，无横向溢出。

## D253 失败诊断搬进「操作」模块的第二页，入口是两枚字按钮（用户要求 2026-11-15，取代 D44 的位置结论 / D49 的「模块外一张卡」）

**需求（m00001 原话，附截图）：** 「现在 chat 历史里面的失败信息，是专门一个栏目的。现在想要把它融入到上面的操作里面。」先按四套画法出样张（A 摘要行给结论 / B 模块脚注 / C 纯就地 / D 失败聚顶，`.scratch/ops-failure-merge/`），用户全部否掉（m00217 原话）：「一个折叠框，里面有两个字按钮，分别叫做操作，和AI执行失败。」→ 再出四套字按钮样张（E 体内下划线页签 / F 页签长在摘要行 / G 连体分段控件 / H 等宽方括号，`.scratch/ops-failure-tabs/`，生成器 `build.mjs`，共享外壳 `prototype/shared.css`），用户选 **G**。

**决定：**

- `.ops` 的 body 变成「页签条 + 两块页」：`div.ops-tabs[role=tablist]` 里两枚 `button.ops-tab`（`操作` / `AI 执行失败` + `b.cnt` 计数），`div.ops-panel[data-panel="ops"]` 装工具行（`this.opsBody` 指向它），`div.ops-panel[data-panel="fail"]` 装失败条目、初始 `hidden`。点页签走 `showOpsPanel()`（切 `is-on` / `aria-selected` / `hidden`，末尾 `renderJump()`），**不**碰 `details.open`。
- 失败条目从「模块后面独立的 `<details class="fcard">`」变成模块里的 `<section class="fitem">`（`buildFailureCard()` → `buildFailureItem()`）：不再是一张卡（无边框 / 无圆角 / 无底色），头部是 `EXIT n` 徽标 + 一句话结论 + 右侧 `tool · cmd`；下方诊断 grid、红色关键行、`完整输出（N 字符）` 折层原样保留。
- 一条失败都没有时页签条整条 `hidden`（`syncOpsTabs()` 里 `tabs.hidden = n === 0`）：没出事的一轮，界面与以前完全一样。
- `failAnchor` 整套删除（`TurnState` 字段，`reset()` / `holdTurnState()` / `releaseTurnState()` / `closeOps()` / `noteWrite()` 里的搬运）：失败条目一律 `append` 进第二页，顺序天然等于发生顺序；重建时 `prev.replaceWith(next)` 原地替换并沿用 `details.raw` 的展开态。

**为什么认这个形状：** 用户点名要的；顺带把 D44 惦记的「一轮 = 一块」结构彻底保住 —— 模块外的兄弟元素从「0～N 张红卡」变成 0 个，失败再多也不会把后面的正文越推越远。代价是三处信息挪位：折叠态只剩标题里的 `· 4 失败`，看不到「找不到文件 / 目录」这句结论，定位一次失败要多点一次（展开模块 → 切页签）。

**四处容易踩的细节：**

- `.ops-tabs[hidden]{display:none}` 必须显式写：`.ops-tabs` 是 `display:flex`，flex 会顶掉 `hidden` 的默认 `display:none`，不写这条，没失败的一轮也露一条空轨道。
- 页签条自己带 `--panel` 底 + 1px `--line` 边框 + 3px padding：模块底是 `--sunken`（最深一档），轨道要「提一层」才分得清激活段（原型里试过纯文字页签，1x 截图里看不出哪边是激活态，要 `--force-device-scale-factor=2` 才勉强看见）。
- 失败条目的 `.ex` 背景从 `--sunken` 改成 `--panel`：原来在 `.fcard`（`--panel` 底）里 `--sunken` 是凹进去的，搬进 `--sunken` 底的模块里再凹就糊成一片。
- **不做**原型右侧的小结 `共 6 个 · 21.6s`：时长要在卡上额外记 `data-ms`，而卡片重建时机不固定；「共 N 个」与标题重复，「N 个失败」与页签计数重复。
- 失败页签的**计数要自己染红**：`.ops-tab .cnt` 自带 `color: var(--faint)`，只给按钮染红，数字还是灰的（代码评审抓到的）；两枚页签**建的时候**就写 `aria-selected`，别等到第一次点击才补上选中态。

**代价 / 可改：** ① 折叠时看不到失败结论，见上；② 失败多的一轮第二页更密也更长，滚动距离没变少；③ `AI 执行失败` 是按用户原话定的，想换文字只改 `web/src/chat.ts` 里那处 `tr("AI 执行失败")` 与 `en.ts` / `ja.ts`；④ 页签没做键盘左右切换（原生 `button` 的 Tab / Enter 够用），要加时只动 `ensureOps()` 里那段。

**验证：** `bridge/tests/ops-tabs-ui.mjs`（端口 7897，自带丢弃式 bridge + `tests/fixtures/fake-pi.mjs`）19 项：没失败的一轮无页签；4 条失败时标题 `4 个操作 · bash ×3 · edit ×1 · 4 失败`；体内两枚页签、失败那枚计数 4；点页签模块不跟着合上（`details.open === true`）；操作页让位、四条失败都在第二页；首条给结论 + 诊断键齐全；完整原文能展开；没有任何 `.fitem` 落在模块外；切回操作页高亮跟着走。截图 `.scratch/shots/ops-tabs-{clean,tabs,fail}.png`。`npm --prefix web run typecheck`（i18n-check 2805 keys × 3 语言）与 `npm run build` 绿。
## D254 设置里加「热部署」：面向用户的分支切换 + 重启，不复用开发用的 skill 脚本（用户要求 2026-11-14）

**问题：** 这个工程自己天天在改，改完要让 7864 上跑的桥换成新构建，每次都靠 `.pi/skills/bridge-update/`（拉 main → build → 杀进程 → 开新窗口）。那是给开发用的、写死 main 的脚本；用户要的是设置在「本机管理」旁边的一颗按钮，点开选一条分支、编译、换进程，一步到位，前端顺带自动刷新。用户原话：「和skill 无关，skill 只是开发者用来测试的，这个按钮，是给用户用的， 只是让你参考skill」。

**决定：**

- 新模块 `bridge/src/hotdeploy.ts` + 独立 worker `scripts/hotdeploy.mjs`，**不 import 也不 shell 出 skill 里的 `restart.mjs`**：端点挂在 `/api/hotdeploy`（`GET` 快照 / `GET log?lines=` / `POST run {branch}` / `POST remove-worktree {path,force}`），worker 是 detached 的一次性脚本，状态写 `.scratch/hot-deploy/state.json`，日志写同目录 `worker.log`，前端每 900ms 轮询快照。
- 分支可切但**不新建 worktree**：`git switch <branch>`（只在本地的走 `--track`，落后远端就 `merge --ff-only`），在 .gitignore 掉的 `.scratch` 里工作，不碰用户主检出目录以外的任何东西。
- 被别的 worktree 检出的分支显示成不可选，行内给「收掉它」（走 `tools/worktree-remove.mjs`，脏的要点两次才带 `--force`）；顶栏在非 main 分支时挂 `主检出在 {branch}` pill，提醒当前源码在哪条分支上。
- 换进程要在**可见的 PowerShell 窗口**里做（用户选「可见窗口」）：worker 先按 `/healthz` 的 pid / pidfile 找旧桥，先杀它的 `pi` 子进程再杀它自己（不用 `taskkill /T`，那会连别的会话一起带走），然后 `Start-Process powershell` 跑 `npm run start:nobuild`；健康检查必须等到 `buildId` 与本次构建一致，否则报 `stale-health`。
- 自我保护：worker 在 linked worktree 里拒绝跑（`hotdeploy_worktree`）、源码脏了拒绝跑（`hotdeploy_dirty`）、同端口已有 worker 跑着拒绝跑（`hotdeploy_busy`）、公网请求全拒（`hotdeploy_public`）。D154 的启动横幅照旧不管这件事：它只管「build 落后」，热部署管「换分支」。

**为什么：** ① skill 是开发工具，写死 main 且假定调用者是 agent；给用户的按钮要能选分支、要给进度和失败原因，两者不该共用一个入口 —— 一旦复用，skill 改流程会悄悄改掉用户看到的按钮行为。② 不新建 worktree 是因为用户就是要「让 7864 跑这条分支」，worktree 反而会多出一份不认识的主检出，且构建产物与 node_modules 都得重装。③ 换进程必须让用户看见：窗口一闪而过、桥起不来时至少要有一处能读的日志（窗口标题固定 `pi bridge`）。④ 拒绝脏树 / 拒绝 worktree 是本地实测出来的：脏树上 `git switch` 会把改动直接带过去，worktree 里跑等于把**那个**检出换成新构建、而 7864 上什么也没变。

**代价 / 可改：** 顶栏 pill 只在连上桥之后才出现（离线时不知道分支）；`run` 会切断正在跑的会话，对话框里只写一行提示、不做二次确认（用户选的）；worker 写死了端口来自 `--port`，改端口部署要重启整个 bridge；`/run` 的 409 分支必须靠前端把 hint 写清楚，否则用户只会看到按钮是灰的。分支列表 110 条里远端默认折起来（`showRemote`），要展开才看得到。worktree 守卫留了个 `PI_HOTDEPLOY_ALLOW_WORKTREE=1` 的逃生口，只给 UI 自动化驱动真跑用 —— 正常部署别设它。

**验证：** `node bridge/tests/hotdeploy-unit.mjs`（worktree/track/refs 解析、占用判定、路径归一、日志尾）；`npx tsc -p bridge --noEmit` 与 `npm --prefix web run typecheck`（i18n 2863 keys × 3）绿；worktree 的桥起在 7999 上用手工假 state.json 走完 idle / running / ok / fail 四种渲染（截图 `.scratch/hot-deploy/shots/hd-*.png`），设置页四颗按钮、24 条本地分支 / 15 颗「收掉它」/ 远端 86 条折叠、列表与进度块不重叠。

## D255 「热部署」落地后的四处行为修正 + 两处口径追平 D254（review 后 2026-11-15）

**问题：** D254 是动手前写的，落地时有两处走了别的路（轮询 900ms→1200ms、换进程 `npm run start:nobuild`→直接跑 node），review 又翻出四件真的会咬人的事：桥在 spawn 之后自己写 `state.json`、`收掉它` 的任何失败都被当成「有未提交改动」、自动刷新按时间窗而不是按进程认领、`GET /api/hotdeploy` 与日志在公网也发。按 `docs/agents/domain.md` 的规矩，旧条目不改写，重开一条覆盖。

**决定：**

- 轮询写死 **1200ms**（`POLL_MS`），因为单次快照要 3–4 秒、900ms 会互相叠着排队；D254 里的 900ms 作废。
- 换进程用 `Start-Process powershell -File start-bridge.ps1`，脚本里**直接 `& <process.execPath> bridge\dist\index.js`**，不走 npm —— `npm.cmd` 会把窗口标题改回 `PowerShell`，「关窗即停」那扇窗就认不出来了。D254 里的 `npm run start:nobuild` 作废。
- **`state.json` 只归 worker 写**：桥 spawn 完只在内存里记一份 `spawned`（worker 还没落盘的那几秒顶一下），`currentRun()` 一旦看到 state 里同一个 pid 就以文件为准。原写法会把 worker 抢先记下的 step/失败盖回 `step:0, running`，随后 `stomped()` 把快速失败报成 `crashed`。
- `收掉它` 失败后由桥跑一次 `git -C <path> status --porcelain`，只有真有未提交改动才回 `dirty: true` 让前端给「确认强删」；锁着、路径没了、`TARGET MISSING` 之类只报错不给强删。退出码 2（worktree 删了但外链目标丢了）算成功 + 一条提醒。
- 自动刷新认 **pid**：`POST /run` 回来的 `run.pid` 存成 `minePid`，只有 `runOf().pid === minePid` 才倒计时。原来的 `startedAt ≥ mineAt - 3000` 会误认别的标签页刚点的那一轮。
- `GET /api/hotdeploy` 与 `GET /api/hotdeploy/log` 也加 `publicReq` 403 —— D254 写的是「公网请求全拒」，之前只拦了 POST，快照里的仓库路径和分支表会露出去。

**为什么：** 这四条都不会在 happy path 上现形，但每条都会在最需要它准的时候骗人：失败被显示成「崩了」、用户被引去强删一个干净的 worktree、别的标签页把当前页面刷掉、公网能读到本机路径。D254 的两处口径是写的当时的打算，代码改了就该让文档追上，而不是让下一个人照文档去改代码。

**代价 / 可改：** `spawned` 只在进程内存里，桥自己重启就丢（那一刻 state.json 已经有 worker 写的了，所以只影响「spawn 完立刻重启桥」的极端情况）；`dirty` 检测多花一次 `git status`（只在失败路径上）；`minePid` 要求 `/run` 的返回里有 pid，`run.pid` 缺失时不会自动刷新（只会停在那条成功横幅上，手动点「刷新页面」）。

**验证：** `node bridge/tests/hotdeploy-unit.mjs`、`npx tsc -p bridge --noEmit`、`npm --prefix web run typecheck`（i18n-check 2877 keys × 3）绿；7999 测试桥上重跑一轮真部署（切分支→build→换进程→healthz 的 buildId 对上），以及审查后逐条手验：假 state.json 里 pre-write 的 step/error 不再被盖、脏 worktree 与 `TARGET MISSING` 两种失败分别给出不同弹法、面板打开时上一轮的 ok 不触发倒计时、公网头下两个 GET 都是 403。

## D256 表格网格按 WPS 的排法重写：样式表整链下传，行高/列宽/换行按 font metrics 排（`#427`，修订 D166 的「格子只画数字格式 + 对齐」）

**问题：** D166 落地时为了先把「数和图都在」做完，`readStyles()` 只读 `numFmt` 与 `<alignment horizontal>`，`<fonts>` / `<fills>` / `<borders>` / `<row ht>` / 隐藏行列 / `wrapText` 全部丢掉；前端把每格钉成 `nowrap; overflow:hidden; 28px 行高; 13px #1f2430`。结果是：文件里排好的表（深色表头、隔行底纹、合计行、标题行加高、备注列换行）在我们的网格里全变成一堵同样大小的字墙，用户的原话是「效果不是很好」。

**怎么定的：** 用户指名「用 REA 解构 WPS 的 Excel 预览，按它的写法设计模式」。实测本机 WPS 12.1.0.29690：`et.exe` 只是启动器，窗口由 `wps.exe` 承载，引擎是 Qt5 + Skia（`Qt5CoreKso.dll` / `skia.dll`），没有独立的轻量网页渲染器；注册的 `.xlsx` 预览处理器 CLSID `{E260F96C-8EF4-4C24-A2B9-455F1D116531}` 只登记了 `ole32.dll`，拿不到实现模块。**所以「写法」只能从屏幕像素里反推**：用 `PrintWindow` 抓窗口（150% 缩放下行高 = pt×2、列宽 = (chars×7+5)×1.5），再逐点探针取色（网格线 `#E6E6E6`、表头 `#F0F0F0`、选中青绿、数字右对齐、放不下出 `###`、文本溢出到右空格、隐藏行在行号上直接跳过）。

**决定：**

- **样式在桥端解析成扁平表，整本一次下发。** 新文件 `bridge/src/sheet/styles.ts`：`readFonts/readFills/readBorders/readStyles`，加 `INDEXED`（64 项老式索引色）、theme 色槽 + `tint()`（RGB→HLS→RGB），输出 `WireStyle { f/bg/bd/h/v/w/ind/sh/rot }`，相同样式按 `JSON.stringify` 去重、0 号恒为默认样式；`WorkbookMeta.styles` 下发，`SheetCell.s` 只带下标。这样前端拿 `styles[cell.s]` 就够，不再猜。
- **列宽/行高/隐藏/网格线开关都从文件读**：`sheetExtras()` 读 `<sheetFormatPr defaultColWidth|defaultRowHeight>`、`<col width|customWidth|hidden>`、`<row ht|customHeight|hidden>`、`<sheetView showGridLines="0">`；`heightPx(pt) = round(pt*4/3)` 与浏览器一致（WPS 在 150% 屏上是 ×2，等于 CSS 的 ×4/3）。
- **默认尺寸改成 Excel 的**：`ROW_H = 20`（15pt）、`COL_W = 64`（8.43 字符）、`HEAD_W = 40`、`HEAD_H = 24`；CSV（`colWidths === undefined`）仍用 110px，CSV 没有列宽语义。
- **只画左/上边**：Excel 的边框归属是「格子负责自己的左/上」，右/下由邻居的左/上画；我们照抄——自己的 `bd.l/bd.t` → 左/上邻居的 `bd.r/bd.b` → 网格线 `1px solid #E6E6E6`（`showGridLines=0` 时 none）；只有窗口边缘才补右/下，避免相邻两格把同一条线叠成 2px。
- **数字放不下出 `###`**（量 `#` 宽度、按可用宽度重复），不裁剪也不溢出；文本默认左对齐、可溢出到右侧连续空列（`roomFor()` 上限 8 列、遇有内容的格子停），`wrapText` 用 `pre-wrap` 并在**节点上树之后**量真实高度回填行高（离屏量尺会被 `font` 简写和可用宽度算错，实测差 5–8px）。
- **行高/列宽不再用「整表前缀数组」**：`fileH`/`autoH` 两张稀疏 map + 排序键 + 前缀和（`dsum`）做 `topOf()` 二分，百万行的 light 档也不会建出百万长度数组。
- **交互全部保留**：四层冻结、键盘走位、Shift 扩选、Ctrl+C 的 TSV、查找命中、`setZoom`（同时作用行高列宽字号）、`selectionRef`；`SheetGrid` 与 `ZOOM_*` 的导出签名不变，`dialog.ts` 不用改。
- **表里的图片照 drawing 的锚点摆**（重写后发现旧网格从来没画过图，用户报「图片没法正常显示」）：新文件 `bridge/src/sheet/media.ts` 读 `xl/worksheets/_rels/sheetN.xml.rels` → `xl/drawings/drawingN.xml`，`twoCellAnchor` 用 from/to 的行列+偏移，`oneCellAnchor` 用 `<xdr:ext>` 的固定 EMU（÷9525 换 px）；只认 `a:blip` 指向的 media part，图表（graphicFrame）跳过。字节走新的 `GET /api/sheet/media?token&sheet&id`：id 必须是这张表 meta 里登记过的 zip 路径，伪造的一律 404，绝不按前端给的路径去读 zip。前端 `drawImages()` 把图片按 `leftOf/widthOf/topOf/heightOf` 算成绝对定位的 `<img class="sd-img">`，只挂视口上下左右各一屏以内的，`z-index: 2` 压在格子之上、选区之下，`pointer-events: none` 不吃点选。

**代价 / 可改：** 样式解析在桥端多一次 `<styles.xml>` + `<theme1.xml>` 的解析（整本缓存，窗口请求不再付）；pattern 填充只做近似（深色花纹取 fg、其余取 bg）；行内富文本 run、旋转文字按像素旋转（只认 90/180 的倍数）、渐变/图片填充都不做。选中框颜色取 `#0f766e`（WPS 的绿有青有蓝，实测采样被文字抗锯齿污染），要改只动 `grid.ts` 的 `SEL_COLOR`。

**验证：** `bridge/tests/fixtures/make-xlsx.mjs` 新增 `buildStyledXlsx()`（两张表、6 字体、5 填充、4 边框、货币/日期/百分比/负数红字、indent、wrap、隐藏行、冻结、`showGridLines=0`），`probes/xlsx.mjs` 加「富样式」一组 17 条断言（行高 20/44/46、隐藏行跳过、表头底 #1F4E79 白字、细边框 1px 不叠、`¥1,234.50` 右对齐、负数 `(400.00)`、`###`、`pre-wrap`、溢出、缩进、合计行黄底、无网格线页）＋「换行内容不被行高截断」一条＋「图片」一组（两张图都挂上、字节取到、一格锚点 120×80、两格锚点铺满 B2:E7）；整轮 **290 项 ok / 全部通过**，截图 `.scratch/xlsx-probe` 与 WPS 同屏对照。

## D257 表格预览就地编辑：改的是 sheet XML 里的那几格，原文件其余字节照抄（`#432`，D166 / D256 的「只读」到此为止）

**问题：** D166 定的是「只读格子 + 纸面 PDF」，理由是「预览只要看清」。真用起来不是：核对表里改一个数、补一行备注，都得跳到 WPS 里改完再切回来，一个几十行的表来回十几次。用户要的是「打开 excel 的窗口里加一个编辑按钮，能实现编辑」。

**决定：**

- **写回原文件，不另存。** 新文件 `bridge/src/sheet/write.ts`：`unzipSync` 拿整包 → 只重写被改到的那几个 `<sheetData>/<row>`（`cellXml` 按需生成 `<c r t s>`，字符串写 `inlineStr`、数字写 `<v>`、公式写 `<f>`，**样式下标 `s` 原样保留**）→ `zipSync(level 6)` → 写同目录临时文件 → `rename` 覆盖；第一次保存前把原文件拷成 `<文件名>.bak`（只留一份，覆盖上一次的）。
- **不重写共享字符串表**：新写的文本走 `t="inlineStr"`，既不用改 `sharedStrings.xml`、也不会把别人还在引用的字符串挤掉；Excel/WPS 都认。
- **公式改动打 `fullCalcOnLoad`**：在 `workbook.xml` 的 `<calcPr>` 上置 `fullCalcOnLoad="1"`，下次用 Excel/WPS 打开会重算；我们自己仍然只显示缓存值（和只读预览的约定一致，见 D166）。
- **并发只看 mtime**：请求带 `mtime`，桥端 `stat` 对不上就 `sheet_stale` 拒绝写（不覆盖别人刚改的文件）；写成功后重新 `registerFileGrant` 把新 mtime 记进凭据，同一扇窗可以接着改，不用重开。
- **只走这一条路**：`POST /api/sheet/edit` 与其它 sheet 端点同样 `publicReq → 403`，凭据就是打开这扇窗时拿到的 token；`ops` 上限 20000 格、整包上限 64 MB，超了直接拒。
- **前端是「覆盖层」不是改数据源**：`grid.ts` 用 `edits: Map<"r:c", SheetCell | null>` 叠在 `cellsByKey` 之上（`cellAt()` 是唯一读口），保存成功才 `clearEdits()` + 重取窗口；撤销/重做是 `EditEntry[]` 两摞栈（一次提交 = 一批）。
- **交互照 Excel 的肌肉记忆**：只读态点格子只用于复制；「编辑」按钮切进编辑态后，选格直接敲字 = 覆盖、F2 / 双击进原地 `textarea`（光标在末尾）、Enter 下移 / Tab 右移 / Shift 反向 / Esc 取消、Delete 清空、Ctrl+Z / Ctrl+Y、Ctrl+V 按 TSV 从当前格铺开、Ctrl+S 保存；改过几格就在「保存」上写几格，没改就藏着；关闭时问一句。
- **双击自己认**：`pointer capture` 下浏览器不派 `dblclick`（踩过），所以在第二次 `pointerdown` 里判定 400ms 内同格再按；编辑态下延迟一帧再开编辑框（否则 mousedown 的默认聚焦会把刚出来的 `textarea` blur 掉）。

**代价 / 可改：** 只支持**单格**改动（多选只用于复制/清空），不做列宽拖拽、插入/删除行列、区域整体填充；合并格写到左上角，不拆合并；行内富文本 run 会退化成纯文本；`zipSync` 是整本重打包，几十 MB 的工作簿保存要一两秒（前端有「保存中…」）；`.bak` 只留一份，没有版本历史。

**验证：** `bridge/tests/fixtures/make-xlsx.mjs` 的 `buildStyledXlsx()` 作靶子，`probes/xlsx.mjs` 新增「编辑」一组：按钮出现/只读无保存、切「完成」+ 底栏「编辑中」、直接敲字覆盖、Esc 不动原文、Enter 提交并亮「保存 1」、Ctrl+Z/Y 来回、双击进编辑框、Ctrl+A 改数、Shift 选两格 Delete 清空、保存后 mtime 变 + `.bak` 在 + 按钮收起、关掉重开新值还在且底色没丢、C5 保留货币格式显示 `¥7.50`；整轮 **310 项 ok / 全部通过**。

## D258 表格浮窗顶上换成 WPS 那条功能区：六个页签，样式补丁回写 styles.xml（`#433`，D256 / D257 的延伸）

**问题：** D256 把格子画对了、D257 让人能改字，但「改样子」还得回 WPS：加粗一行、给合计行涂个黄底、把一列数字改成百分比，这些在预览里都只能看不能动。用户要求把顶部那两颗「网格 / 页面视图」按钮去掉，照着 WPS 复刻「开始 / 插入 / 页面 / 公式 / 数据 / 视图」六个页签，并且常用命令要真的能改到表上。

**决定：**

- **去掉视图切换按钮，纸面收进功能区。** `.sd-viewtabs` 那两颗不建了；`SheetDialog` 仍然构造 `.sd-panes`（宽窗并排、窄窗单面），入口改成「页面 → 纸张视图」开关。`showView()` 保留，`activeView` 仍然驱动 `applyView()`。
- **功能区是一张声明式的表。** 新文件 `web/src/sheet/ribbon.ts`：六个页签各一个 `.sd-rb-pane`，开始页分「剪贴板 / 字体 / 对齐 / 数字 / 编辑」五组，组标题 10px 灰字压在按钮下面（WPS 的排法）；按钮的亮灭由 `update()` 按 `grid.activeStyle` 现算，选区一动就刷。
- **只放真能生效的命令。** 粘贴、插图、图表、排序、筛选做成 `disabled` 并在 `title` 里说清原因（不读系统剪贴板 / 预览不画图表对象 / 不改行序），不做假按钮。命令名照 WPS 的中文写（`// i18n-ignore-start` 有理由：用户按 WPS 的肌肉记忆找按钮，翻译反而找不到）。
- **样式改动走「补丁」而不是整份样式。** 前端 `grid.styleOver: Map<"r:c", SheetStylePatch>` 叠在 `styleOf()` 上（`mergeStyle()` 只覆盖补丁里出现的键，所以「只加粗」不会把原来的底色冲掉），渲染立刻生效；保存时并进 `editOps()`，只改样式、没改内容的格子也发。
- **桥端克隆 xf，不新建样式体系。** 新文件 `bridge/src/sheet/style-write.ts`：`StyleBook` 读 `xl/styles.xml` 的四段（fonts / fills / borders / cellXfs），`alloc(base, patch)` 拿原 `xf` 和它指的 `font` / `fill` 复制一份改属性，按字符串去重后追加；`toXml()` 从后往前替换四段并更新 `count`。`write.ts` 在 `applyEdits` 里算好每格的新 `s`，只有 `styles.changed` 时才替换 `xl/styles.xml`，别的字节照抄。
- **视图类命令不碰文件。** 网格线（`setGrid`）、公式视图（`setShowFormulas`，格子里显示 `=原文`）、冻结窗格（`freezeOver`，按焦点上方/左侧冻）都只改内存里的画法；保存不会把它们写进 xlsx（Excel 的冻结是 `<pane>`，这次不做）。
- **自动求和照 WPS 的默认行为**：`autoSum(kind)` 先往上数连续的数字，没有再往左右找，框成 `A1:A5` 写 `=SUM(...)`；「插入 → 今天 / 现在」直接往焦点格写日期/时间字符串。

**代价 / 可改：** 样式补丁只覆盖字体开关 / 字号 / 字色 / 纯色填充 / 水平垂直对齐 / 换行 / 内置数字格式 id；不做边框描边、合并单元格、条件格式编辑、插入删除行列、排序筛选、图表。字体名与字号框只**显示**当前值（真下拉要枚举工作簿的字体集合，留待以后）。纸张视图仍是 LibreOffice 转的 PDF（D166），只是入口换了地方。

**验证：** `probes/xlsx.mjs` 新增「功能区」一组 9 条：六个页签文字、旧 `.sd-viewtab` 为 0、加粗后计算样式 `font-weight: 700` 且按钮亮、填充后 `rgb(255, 242, 204)`、插入页有自动求和、保存后重开加粗与填充都还在；整轮 **319 项 ok / 全部通过**。另外用 WPS 打开写回后的 `styled.xlsx`，B5 的加粗与黄底都在（`docs/shots/xlsx-ribbon.png` 是预览侧的样子）。

## D259 表格浮窗把「改样子」和「改结构」补齐：样式补丁加边框字体名，结构化改动单独走一条写回（`#434`，D257 / D258 的延伸）

**问题：** D258 的功能区只能改字体的开关、字号、颜色、填充和对齐；边框、合并单元格、插入/删除行列、排序、筛选、图表都还是「看得见摸不着」，而这些恰恰是拿到一张别人的表最先想动的地方。

**决定：**

- **样式补丁加两样：边框与字体名。** `CellStylePatch` 增 `bd?: { t?, r?, b?, l? }`（值取 `thin / medium / thick / double / dashed / dotted / none`）与 `fn?: string`。`style-write.ts` 里克隆原 `border` 后按「左/右/上/下」重排，`none` 写成空的 `<left/>` 而不是删掉元素（Excel 对「无边框」和「没定义」是两种意思）；改边框时顺带把 `xf` 的 `applyBorder="1"` 打上。字体名改 `<name val>`。
- **结构化改动不由前端拍坐标，交给桥端重排 XML。** 新文件 `bridge/src/sheet/struct.ts`：把 `<sheetData>` 解析成 `Row{ r, attrs, cells }`，按操作重写（合并区跟着插删行列平移、排序时样式跟着内容走、筛选写 `hidden="1"`、清条件格式改 `sqref`），再拼回原 XML；`saveStruct` 与 `saveBook` 共用同一套 mtime 闸 / 64MB 上限 / `.bak` / 临时文件改名。
- **结构化改动单独走 `POST /api/sheet/struct`，并且必须「先存再改结构」。** 前端有未保存的格子改动时直接拦住（提示「先保存改动，再改结构」）——结构一动，`edits` 里那些 `r:c` 就全错位了。成功后重新取 `meta`、重建网格（行列数与合并区都变了），编辑态保持。
- **图表按锚点画成 SVG，不转图片。** 新 `bridge/src/sheet/chart.ts` 读 drawing → chart part，认柱/条/折线/饼/面积/散点，值优先回读单元格（`readWindow`），取不到时退回 `<c:numCache>`；新 `web/src/sheet/chart.ts` 把值画成内联 SVG（Office 主题色、参考线、标签过密自动抽稀）。缩放/滚动时跟着格子走，不额外存像素。
- **条件格式只做「清」不做「建」。** 建规则要一套编辑 UI（规则类型、阈值、色阶端点），收益低于成本；「清掉别人留下的红绿灯」是预览场景里更常见的诉求，所以只加 `clearCf`：按 `sqref` 与选区求交，整块没了就删 `<conditionalFormatting>`，还剩一部分就摘掉对应范围。

**代价 / 可改：** 排序只按一列、不认表头是否参与；筛选是「值相等」的精确过滤，不做多选/包含/颜色筛选；插入删除行列会让公式的相对引用错位（我们只搬格子，不重算引用）；图表只画值，不读标题格式、图例位置、次坐标轴；条件格式的 `x14` 扩展（数据条渐变、图标集自定义）不处理。结构化改动对整个文件重打包，几十 MB 的表要一两秒。

**验证：** `probes/xlsx.mjs` 新增「图表 + 结构」与条件格式清理共 6 条：图表 SVG 出现且柱子数 > 3、标题在图上、选区合并后一格占三列（实测 288px）、插行后状态栏「已更新」、清条件格式后色阶消失而数据条还在；整轮 **325 项 ok / 全部通过**。桥端另有 `.scratch/t-style2.mjs`（边框/字体名写回后 21 条样式，读回 `2px solid` 下边框与「微软雅黑」）、`.scratch/t-struct.mjs`（合并/插删行列/排序/筛选的 XML 级验证）。

## D260 表格编辑器再补四样：拖列宽行高、名称框、可编辑公式栏、超链接与批注（`#435`，D258 / D259 的延伸）

**问题：** D259 之后，改动能力基本齐了，但「怎么改」还很别扭：列宽行高只能靠文件里的值，名称框是个只读标签，公式栏只能看不能改，而真实工作簿里最常见的两样东西——超链接和批注——在预览里完全看不见。

**决定：**

- **列宽/行高拖动只在编辑态出现，拖的是「未缩放的像素」。** 列头与行号右侧各挂一个 6px 握把（`.sd-grip-v` / `.sd-grip-h`），`pointerdown` 在 `root` 上委托，`pointermove/up` 挂在 `window` 上——拖动过程中表头会重画，握把节点会被换掉，监听挂在握把上只能收到第一下（踩过）。拖动时先改 `colOver`/`rowOver` 两张本地覆盖表就地重排，**松手才写回**：`colWidth` 的 `w` 是字符数（`(px-5)/7`），`rowHeight` 的 `h` 是磅（`px*0.75`），跟 Excel 的换算一致。保存失败也不回滚，重开时以文件为准。
- **名称框是可编辑的 `<input>`，认 `A1` 与 `A1:C5`。** 回车后 `jumpTo()` 解析成行列号、设 anchor/focus、`afterSelect()` + `reveal()` 滚到可见；非法输入直接不响应（不报错、不跳）。
- **公式栏在编辑态可改，回车写入焦点格。** 只读态仍只显示；`readOnly` 随 `setEditMode` 切换；正在输入时不被选区变化覆盖（`document.activeElement` 判断），Esc 还原。
- **超链接与批注只读展示，不写回。** 两者都不在 `<sheetData>` 里：超链接是 `<hyperlinks>` + sheet rels，批注是单独的 `xl/commentsN.xml`（靠同一份 rels 的 `Type` 结尾 `/comments` 找）。新 `bridge/src/sheet/refs.ts` 一次读完、按 `"r:c"` 贴到窗口内的格子上（`lnk` / `note`），`readWindow` 里缓存整表结果。前端：链接格画成蓝色下划线，**Ctrl/Cmd + 点击**才开（拖选不会误触），页内 `#表!A1` 只挂在 `title` 上不跳（跨表要重载；D283 已把页内跳转补上，点击语义也改成只读态单击就跳）；批注格右上角画红色小三角，正文进 `title`。
- **这几样都不进撤销栈。** 尺寸拖动直接落盘，超链接与批注不可改——只有格子内容和样式走 `edits` / `styleOver` 那套撤销。

**代价 / 可改：** 拖出来的尺寸没有「双击自适应」与「按内容最佳宽度」；批注只读，批注框/作者/时间不展示；超链接只开 `http(s)/mailto` 这类外链，页内跳转与 `file://` 不处理；名称框不支持命名区域与多选区（`A1,B2`）；公式栏只写不显示函数提示。这些都不影响「能改一张表」的主路径。

**验证：** `probes/xlsx.mjs` 新增「编辑增强」3 条（握把出现、拖 40px 后 B 列 117→157、名称框跳 C5、公式栏回车写入）与「超链接与批注」5 条（`is-lnk`/`is-note` 类、蓝色 `rgb(11, 87, 208)`、批注 title、页内 `#` 前缀），整轮 **334 项 ok / 全部通过**；桥端另有 `.scratch/t-refs.mjs`（自造的 refs.xlsx：A1 外链、B2 页内跳转、C3 两段批注，读回逐格正确）。

## D261 表格编辑器补「一格多字体」「从列表里选」「表头筛选」（`#436`，D259 / D260 的延伸）

**问题：** D260 之后还能一眼看出的三处不像 WPS：一格里的字有粗有细多色时我们只画一种字体；文件里写好的数据验证（下拉）完全没显示；表头上没有筛选箭头，只能靠功能区「筛选」按当前格的值硬筛。

**决定：**

- **富文本按 `<si><r>` 的段画，整串仍留一份。** 共享字符串里带 `<r>` 的，`readRichRuns()` 把每段的文本与 `rPr`（字体名、字号、粗斜下划线、删除线、`rgb` 颜色）拆出来，作为 `WireCell.rt` 跟格子一起下线；`t` 仍是拼好的整串（复制、查找、编辑、`###` 判宽都用它，只有绘制走 `rt`）。宽度按段累加 `textW`，所以「前半粗体后半普通」的溢出判断跟 WPS 一致。主题色不解析（只认文件里写死的 `rgb`），拿不到就继承格子样式。
- **数据验证只做「列表」这一种的下拉，其它类型记住规则但不拦。** `valid.ts` 读 `<dataValidations>`：`<formula1>"是,否,待定"</formula1>` 直接拆，`<formula1>$D$1:$D$3</formula1>` 用同一份 sheet XML 就地取值（`valuesInXml`，去重、上限 200），跨表的引用先不解析。编辑态在有选项的格子右侧挂一个 ▾，点开是 `.sd-list`，选一条走 `writeAtCell()`（进撤销栈、算脏）。`whole/decimal/date/textLength/custom` 只保留 `kind` 与提示语，**不做输入拦截**——预览不是数据录入系统，拦错了比不拦更烦人。
- **表头筛选：只读去重值，筛选动作仍走 `struct.ts` 的写回。** `filter.ts` 读 `<autoFilter ref>` 与已有 `<filterColumn>` 的 `val`，算出每列的去重值（上限 300）放进 meta；编辑态在筛选区的列头右侧画 ▾（`.sd-fbtn`，跟拖宽握把分居两侧），点开第一条是「（全部）」，其余是候选值。选中后走 `applyStruct({t:"filter", c, value, r1,c1,r2,c2})`：**只藏筛选区内的行**（`row.r <= r1 || row.r > r2` 直接跳过，第一版把表头也藏了），同时把 `<autoFilter>` 换成当前状态（清筛选就整块删掉），这样 Excel 打开时看到的是同一份筛选。
- **不用 LibreOffice，也不用任何外部进程。** 这三样都是「读 XML + 画」与「改 XML 的那几格」，跟 D256–D260 一条路；公式重算也打算照这个路子自己算，不引外部二进制。

**代价 / 可改：** 富文本只认 `rPr` 里写死的 `rgb`，主题色、字符间距、上标下标不还原；数据验证不支持跨表引用、`showDropDown="1"`（Excel 里意思是「隐藏箭头」）与输入拦截；筛选只支持「等于某个值」的单列筛选，不支持多选、颜色筛选、数值区间、`top10`，也不画「已筛掉多少行」的提示。这些都不挡主路径。

**验证：** 新增 `bridge/tests/fixtures/valid-xlsx.mjs`（写死列表 / 区域引用 / 整数规则三种）与 `filter-xlsx.mjs`（两列六行 + `autoFilter`），`make-xlsx.mjs` 一并产出；`.scratch/t-rich.mjs` 读回分段字体（微软雅黑 14 粗体 `#C00000` + 11 号）、`.scratch/t-valid.mjs` 读回两列选项、`.scratch/t-filter.mjs` 确认只藏区内三行且 `autoFilter` 写成 `<filterColumn colId="0">`；`probes/xlsx.mjs` 新增 5 条（下拉箭头、选项数、选中写入、区域引用选项、筛选后行消失/清筛选后回来），整轮 **343 项 ok / 全部通过**。

## D262 预览自己补算公式：自写求值器，不引 LibreOffice（`#435`，D261 的延伸）

**问题：** 很多文件（尤其是别的程序导出的 xlsx）只写 `<f>` 不写 `<v>`，Excel 打开会自己算，我们一直显示空白，底栏只能写「N 格无缓存值，需用表格软件重算」。用户要求补上这一块，并明确**不用 LibreOffice 做重算兜底**。

**决定：**

- **求值器自己写，只有「有公式没缓存值」时才启动。** `calc.ts` 是词法 + 递归下降 + 求值三段：四则 / 幂 / 百分号 / `&` / 比较，单元格与区域引用（`$` 绝对、跨表、中文表名、`'带 空格'!A1`），约 50 个常用函数。不认识的函数返回 `#NAME?`，除零 `#DIV/0!`，环引用 `#CIRC!`——**宁可显示错误，也不猜一个像是对的错数**。
- **按表懒建「整表小网格」当取值源，逐格记忆化。** 只有窗口里出现 `noCache` 的格子才建上下文；一张表超过 40 万格就不算（返回空，保留「算不出来」的提示），每窗口最多补算 2 万格。跨表引用会顺带把目标表也建起来，同一个 `(表,行,列)` 只算一次。
- **算完按格子自己的数字格式显示。** 结果写回 `WireCell.t`，数值进 `v`；有位号格式的走 `formatValue`（`¥3.00`、日期、百分比都对），算完把 `nf` 临时字段删掉，不上线。
- **保存后整块重取，不再只重渲染。** 顺手修掉一个真 bug：`grid.refresh()` 只重画、不重取已加载的分片，刚写完的格子在保存后会显示成改动前的样子。新增 `grid.reload()`（丢掉分片与缓存再拉），`dialog.saveGrid()` 改调它——这条对纯文本编辑同样成立，不只是公式。
- **不引外部进程、不引依赖。** 跟 D256–D261 同一条路：读 XML、算、画。

**代价 / 可改：** 不支持数组公式、动态数组、迭代计算、外部工作簿引用、`INDIRECT/OFFSET` 这类会改引用范围的函数，也不解析 `1904` 之外的日期系统差异；文本比较按 `localeCompare` 的近似语义，跟 Excel 的排序规则不是逐字一致；单表 40 万格、单窗口 2 万格是拍的阈值，超了宁可不算。要真做到「和 Excel 一模一样」，就得把函数表补全并引入日期/精度细节，那是另一个量级的事。

**验证：** 新增 `bridge/tests/fixtures/calc-xlsx.mjs`（12 个公式格全部只有 `<f>`，含 SUM / IF / ROUND / VLOOKUP / 跨表 / 除零 / 未知函数 / 环引用 / 带货币格式的公式），`make-xlsx.mjs` 一并产出；`.scratch/t-calc2.mjs` 逐格核对显示值。`probes/xlsx.mjs` 新增 14 条（9 个值 + 底栏计数 + 编辑态现写公式、保存后刷新、重开仍在），并把原来「缺缓存值格显空 / 红虚线 / 需重算」三条改成新行为；整轮 **356 项 ok / 全部通过**。

## D263 `#app` 里不写裸 `vh` / `vw`：分支工作台掉出屏幕的修复 + 一条守门用例（用户报障 2026-11-15）

**问题：** 用户报「chat 框下面的分支点开，现在是穿模的」，追问后落在一句具体的话上：**「分支管理里面的拉取最新，在我现在这缩放下看不见了」**。复现：外观「字号」调到 125% 以上，点状态行的 `⎇main`，卡片底栏（`拉取最新` / `Esc 关闭`）整条掉到视口外面；150% 起头行的「分支操作工作台」几个字压在「提交」身上。

更让用户火大的是这**不是新坑**：`--vh1` / `--vw1` 就是为它起的，`.sys-console` / `.mail-console` / `.jc-console` 三处文件头都写着「不写 96vw / 90vh」，预览面板的 `.viewer.full` 也留着一整段注释。前几次都是「哪里炸了补哪里」，于是同一个错误换一个弹层就复发一次。这一轮按**类**收口。

**原因：**

1. `#app { zoom: var(--ui-scale) }`（外观「字号」）会把子树里的长度整体缩放一遍，而 `vw` / `vh` 解析的是**视口**尺寸、不认 zoom —— 同一个值被乘第二次。字号 125% 下 `height: 82vh` 的卡就是 923px（视口 900），150% 是 1107px，200% 下 `94vw` 宽的卡 2000px（视口 1440）。
2. 卡一窄，`.branch-tools { flex: none }` 不让位，`.branch-title` 里那几段 `nowrap` 文字又撑着自己的 min-content（`min-width: 0` 不够）—— 盒子被挤到内容以下后文字**直接画到动词按钮身上**。
3. 分支工作台的窄版规则挂的是 `@media (max-width: 720px)`，看的是**视口**宽度。嵌进「目录与仓库」右栏时面板只有 800（150% 时 482），视口还是 1440 → 窄版永远不触发：对照行里 `origin/main` 输入框压在「领先 / 落后」上、两列历史挤成省略号。

**决定：**

1. **`web/src/*.css` 里一律不写裸 `vh` / `vw`**，要写几成视口就写 `calc(var(--vh1) * N)` / `calc(var(--vw1) * N)`（`--vh1` = 1vh ÷ zoom，跟 `.sheet`、预览面板同一个口径）。这轮把 `styles.css` 里剩下的 **33 处**声明全换了：分支工作台、目录与仓库、diff 弹窗、参数对话框、翻译对照、终端浮窗、背景任务、Jira 选择器、随手问、新建工作区、回合列表、消息图片、模型 chip、`.bg-sheet` 等。
2. **挂在 `document.body` 上的浮层例外**：它们不在 `#app` 里、没有 zoom，裸单位本来就是对的（位置也是用 `getBoundingClientRect()` 的视觉 px 夹的）。这类规则**行尾标一条「不在 #app」注释**，守卫认这个标记；目前 10 条（`.pin-menu` / `.pin-menu.pin-list` / `.ws-tabs-menu` ×2 / `.ws-tray-col` / `.ws-pop` ×2 / `.perm-menu` / `.update-bar` / `.fail-toast`）。新东西不要往这个豁口里塞 —— 浮层本来就该跟着字号缩放，请挂进 `#app`；守卫对豁免条数有上限（12），涨爆了就说明又有人在往 body 上挂。
3. **加守门用例** `web/tests/viewport-units-unit.mjs`（挂进 `npm --prefix web run typecheck`，也可单跑 `npm run test:viewport`）：扫 `web/src/*.css`（`web/src/peer/` 是另一张没有 zoom 的页面，不在范围内），除了 `--vh1` / `--vw1` 那两行定义和带豁免标记的行，出现裸 `vh` / `vw` / `dvh` / `svh` / `lvh` / `dvw` 就红并指出文件行号。**这条是整个决定里真正管用的部分** —— 前三次都写了文档没写守卫，所以第四次还是发生了。
4. **分支工作台 / 目录与仓库的窄版判据从 `@media` 换成 `@container`**（`.branch-sheet { container-type: inline-size }`，同 `.viewer` 的理由）：窄版规则（cmp 两列、单列历史 / 差异、侧栏下移、动词左对齐、藏 Esc 提示）整套搬进 `@container (max-width: 720px)`；头行两级降级 —— 卡宽 < 960 标题让位只留 `⎇`，< 720 常驻动词收进「全部动词 · 24」（那一页本来就有全部 24 条）。`.branch-title { overflow: hidden }` 与 `.branch-head { flex-wrap: wrap }` 兜底，任何一步都不许再画到按钮上。`.branch-sheet` 自己的宽高仍留在 `@media`：容器查询不能给容器自己写样式。
   **「目录与仓库」同样处理**：`.repos-sheet { container-type: inline-size }`，三列 / 单列 + 「目录」抽屉的
   切换搬进 `@container (max-width: 720px)`（`.repos-sheet` 自己的 `width/height` 仍留在 `@media`），
   `repossheet.ts` 里「选中后自动收起抽屉」的判据从 `matchMedia("(max-width: 860px)")` 改成
   `this.sheet.clientWidth <= 720` —— 两处必须是同一个数，否则抽屉会开着不关。
   同一轮顺手把**预览面板**头部那组窄版规则也换了（`.viewer` 早就有 `container-type: inline-size`，
   却把 `display: none` / 换行那几条挂在 `@media (max-width: 760px)` 上）：宽屏上把面板拖到 400px，
   以前一声不响，头部就照着「#79 的教训」那条注释继续往视口外溢。

5. **极窄时别再让卡片自己吃掉纵向空间**（这一条是量的过程中冒出来的新坑）：字号 200% 时有效视口 720×450，`.repos-sheet` 的 84vh 只剩 378，头行 + 对照行 + 两个 tab 条 + 底栏就把高度吃干，内嵌工作台的 `.go-body` 被压成 **1px**（列表整块看不见）。三处改动：
   - `:where(html[data-compact="true"]) .branch-sheet, … .repos-sheet { height: calc(var(--vh1) * 94) }`：有效宽度窄时这两张卡多占一点高度（`data-compact` 是 app.ts 按「视口 ÷ 字号」算的既有判据，`.term-dock` 早就这么用）。84vh → 94vh 在 200% 下是 378 → 423。
   - 对照行换两列的门槛从 720 降到 **520**：卡还有 600 上下时三列（当前 | 领先/落后 | 对照）排得下，换两列反而多占一行 —— 200% 时那 70px 就是列表的全部。
   - 位置顺序有讲究：这两条必须写在两张卡的 base 规则**之后**，`:where()` 的权重是 0、只赢在同权重靠后。

**顺带审过、结论是没问题：** `app.ts` 那几处 `menu.style.left = innerWidth - 220` / `menu.style.right = innerWidth - r.right`（右键菜单、终端菜单、工具权限浮层）与 `menuplace.ts#stickMenu` —— 它们全都 `document.body.append`，不在 zoom 子树里，用视觉 px 定位是对的。**不是**每一处 `innerWidth` 都要除 scale：先看它是不是挂在 `#app` 里。

**挖出来的、留给你拍板的事：** 「目录与仓库」在 `compact()`（有效宽度 < 900，也就是手机、或字号 175% 以上）下**根本打不开** —— `syncCwdChip()` 里 `cwdChip.hidden = compact()`，而它唯一的入口就是那颗 chip（`openReposSheet` 只有这一个调用点）。也就是说这一轮给 `.repos-sheet` 加的窄版容器查询，在真机上暂时没有触达路径（只有「卡被拨窄」这种合成情况能走到）。要修得先定：手机/高字号下这颗 chip 放哪（状态行挤得下吗、还是收进左栏抽屉）。**没动**，等产品口径。

**没做的：** 部分工具浮层仍用 `@media` 判窄版（`.notes-*`、`.fail-*` 等挂在满屏 sheet 里的那些，它们的宽度本来就跟着视口走，优先级低）。

**代价：** 字号 150% 下嵌在右栏的常驻动词要收起来，得多点一下「全部动词 · 24」；200% 时独立的卡也进窄版（单列 + 顶部 tab），一屏只看得到两三行提交 —— 仍可滚、仍能关；只当上限用的 `max-width: Nvw`（模型 chip、消息图片）现在按「面板宽度的 N%」算而不是「视口的 N%」，高字号下会比以前更早出现省略号 —— 那才是它本该有的意思。

**验证（真 Chrome：playwright-core + Chrome for Testing；走真桥点开 chip，1440×900）**

- `.branch-fetch` 的 bottom（视口 900）：改前 100 / 125 / 150 / 175 / 200% = 808 / **929** / **1115** / **1301** / **1486**；改后 = 808 / 806 / 803 / 801 / 797。
- 100% 下分支工作台 1000×738、head 63、title 146、tools 808、body 473 —— 与改前**逐项相同**（`--vh1` 在 scale=1 时就是 `1vh`，这轮换单位对主力尺寸零影响）。
- 嵌在「目录与仓库」右栏（面板 800）100 / 150 / 175%：foot 底 792 / 775 / 766；150% 下对照行不再重叠、历史改单列；100% 下常驻动词 7 颗仍在（阈值 720 没误伤）。
- 静态 A/B（同一个 harness，只换 CSS，`--ui-scale: 1.5`）：`.diff-sheet` 高 774 → 516（本地 px，乘 1.5 后是 1161 → 774，视口 900），`.term-dock` 宽 1080 → 928（1620 → 1392，视口 1440）。
- 700×800（`@media` 窄版路径）、390×844（手机）、1440×700 + 150% 全在视口内；新建会话 / 随手问两张 sheet 在 150% 下无溢出。
- `npm --prefix web run typecheck`（`tsc` + i18n-check 3008 键 × 3 + 新守卫 8 项）、`node scripts/build.mjs --only web` 通过；守卫反向验过（往 `sysmanage.css` 塞一行 `height: 42vh` 立刻红，删掉恢复绿）。
- **`npm run test:githist:ui` 加了 10 条**（150% / 200% 各五条）：卡片整张落在视口里、「拉取最新」在视口内、头行标题没画到动词按钮上、「全部动词」入口可见、窄版判据跟的是卡自己的宽度。跑法见 `docs/agents`（这台机器上 `npm i --no-save playwright && npx playwright install chromium` 之后 `loadPlaywright()` 就找得到了）。整套 116 条全绿、0 失败；**把 `.branch-sheet` 退回 `94vw` / `82vh` 再跑，这组立刻红**（`1500x1107 @ 24,24，视口 1440x900`），改回来恢复绿 —— 用例确实咬得住这次的事故。
- 同一轮顺手修了 `bridge/tests/git-history-ui.mjs` 的一处环境假设：`/api/git/state` 回来的 repo 是 `/private/var/…` 而 tmpdir 是 `/var/…`（macOS 同一个地方两条路径），断言改成比 realpath，否则这条用例在 macOS 上第一跑就红。
- `test:repos:ui` 从「这条机器上跑不过」修成绿：`ROOT` 拉平到 `fs.realpathSync`（macOS 的 `/var` → `/private/var`，否则 `data-dir` 永远匹配不上、卡在第一条 `waitForFunction`），清理换成带重试的 `rmSync`（ENOTEMPTY 会把真正的失败盖掉）。另加 4 条容器判据：卡 1240 宽三列照旧、把卡拨到 600（视口仍 1280）就换「目录」抽屉、同一时刻目录列/仓库列/面包屑都让位、拨回来自动还原。
- 预览面板那组容器查询用真样式表验的：面板 420 宽时 `.viewer-path` 隐藏、900 宽时显示；同一张页面对照旧 CSS，420 宽下路径**没**隐藏（就是被修掉的那个静默失败）。
- 同族回归：`test:scratch:ui`、`test:settings:ui`、`test:repos:ui`、`test:githist:ui` 全绿。（`test:repos:ui` 原先在这台机器上跑到「只列目录…」就 timeout —— main 上未改动的构建同样跑不过，是本轮顺手修掉的 macOS 路径问题，见上。）

## D264 邮箱：按时间取信、AI 权限只管 AI、坏配置别拿默认值盖掉（用户报障 2026-11-15）

**问题：** 用户报「邮箱有 bug，邮件不全，只能看到 2022 年的邮件」。拉开看，这不是一个 bug，是**一批口径没照文档办**：面板上写的一句话（「只约束 AI」「发送前确认」「取附件」）和代码里的实现不是同一件事，而三处碰巧都落在同一条链上（列表取数 → 权限判定 → 配置读写）。

对着真信箱（1092 封的 QQ 邮箱）和一份假桥逐个量出来的是：

1. **列表按「序号最后 N 条」取，而序号不是时间。** `listMessages` 取 `exists-limit+1 : *` 再按时间排。序号是「进这个文件夹的先后」：这箱里 uid 1410–1429 是 **2021-09/10** 的信（从别处搬回来 / 恢复过，最后才落地），uid 1330 附近才是 2026-11 的信。于是默认 20 封里最新的一封是 **2022-01-31**，2021-11~2022-03 整段看不到；实际这箱最新是 **2026-11-14**。`limit=100` 也只能到 2022-03-25。
2. **未读是在那个窗口里本地筛的**：同一箱「只看未读」`limit=20` 给 **6 封**，`limit=100` 给 **23 封**，真数 100+。
3. **列表没有翻页出口**：`limit` 夹 100、没有 `offset`，页面写死 30 且没有「看更早的」。第 100 封以前的历史读不到。
4. **AI 永远发不出信。** 桥会发 `{type:"mail.confirm"}` 并等页面点头（默认 `confirmSend: true`），而 `web/src` 里**根本没有处理这一帧的地方**（只有 `preview.open.done`）。每封都干等 300 秒 → 回 `no-ack`，而这个码既不在工具的 `NEXT_STEP` 里也没写进描述，模型当成临时故障又试一次。
5. **面板「回复」对有显示名的发件人 100% 失败。** `startReply` 把 `m.from`（`PlayStation <email@…>`）整串填进 `to`，而 `normalizeMail` 拿 `^[^\s@]+@…$` 怼整串 → 回 **500** smtp-error「收件人不像地址」。真实邮件九成带显示名。
6. **「AI 权限」其实也拦人。** 关掉「读邮件」连人自己在面板里都看不了信（`/api/mail/folders|messages|message` 走同一份 `policyDenial`），附件权限默认关着连自己的附件都下不了；日上限与收件人白名单还算上你自己点的那些 —— 而设置页写着「只约束 AI；你自己点的不受限」「只算 AI 发的」。
7. **配置文件读坏一次就把账号与授权码永久清空。** `readMailConfig` 丢掉 `readJsonChecked` 的 `ok`，坏文件按「没有账号」处理；紧接着任何一次写（点一下权限开关、`/api/mail/repair`）就把 `accounts: []` 落盘。实测：截断 config.json → 读 0 个账号 → `POST /api/mail/policy` → 文件里的 `REALSECRET` 没了。
8. 一串小的：`mail_reply` 把 `attachments` 硬写成 `[]`（schema 声明了）；纯 HTML 的信 AI 读到「(没有纯文本正文)」且 `html` 被「取附件」开关连坐；25MB 的闸门在 `source` 拉完之后才判（等于没挡）；面板读完信把本地那条标成已读（服务器上 PEEK 没改）；切文件夹/账号时先点的慢响应会盖掉后点的；`asInt(null,20)` 让 `/api/mail/messages` 不带 `limit` 只回 1 封；删账号不清 `policy.accountIds`（删完谁都不许用）；`mutate` 在工具提示与 `mail_accounts` 回包里有、面板里没有。

**原因：**

1. IMAP 的**序号 / UID 是「到达顺序」，不是邮件时间**。个人信箱通常两者一致，所以按序号取「最近的」看不出问题；一旦从备份恢复过、或把信从回收站/别的文件夹搬回来，这批信的 uid 会变成最新的而时间是老的 —— 以前那套「取最后 N 个序号再按时间排」在这种信箱上给出的是一个**既不是最近、内部还错位**的窗口。而「未读」在窗口内过滤，等于「窗口外的未读不存在」。
2. 「AI 权限」的**唯一入口是 `policyDenial`**，页面路由和工具口共用。共用是对的，共用同一份**开关语义**就错了：这六个开关的文案都是对 AI 说话，页面（人自己）不该被它挡住。
3. 配置读写的默认值**兜底兜到了写路径**：读不出来 → 空配置 → 照样写回，等于把「读失败」翻译成「用户没有账号」。

**决定：**

1. **列表按时间挑，不按序号挑。** 从最新到达的一批往回扫信封，扫到「按时间的前 `limit+offset` 封」能被证明找全为止：拿第 `want` 封的时间当 cutoff，`SEARCH SINCE cutoff` 一次 —— 比 cutoff 新的信全都已经在手里就算收手，否则再往回扫一批（每批 200，上限 2000 封）。信封只取 envelope/flags/uid/size/internalDate，`bodyStructure`（`📎`）只为最终要显示的那几封补。纯函数 `seqWindows` / `orderByDateDesc` / `takeWindow` 拆出来单测。
2. **未读走 `SEARCH UNSEEN`**：先在服务器上把未读的 uid 全找出来再取信封（`limit` 之内完全准确），不再「取窗口再本地筛」。
3. **翻页**：`listMessages` 加 `offset`，`mail_list` 加同名参数；面板底部「看更早的」按偏移往后接。
4. **补上确认框**（`web/src/mailconfirm.ts`）：收件人/抄送/主题/正文前 800 字/附件摊开，只有点「发送」才回 `ok:true`；Esc、点遮罩、5 分钟不点都回 `ok:false` + 一句给人看的话。排队与回执抽成无 DOM 的 `MailConfirmQueue`（一次只摊一封、回执只认当前那封的 `reqId`）。`no-ack` / `timeout` 补进工具的 `NEXT_STEP`，别再让模型把「没回音」当临时故障重试。
5. **地址口径收到 `bridge/src/mailaddr.ts`**：`Name <a@b.com>` 与 `a@b.com` 是同一个人；校验、白名单比对、SMTP 收件人都走它；参数错给 `bad-input`（400），不再混成 500。`splitRecipients` 也不再切引号/尖括号里的逗号。
6. **权限只管 AI。** `performSend` 里策略判定、白名单、日上限、发送前确认都进 `by === "agent"` 分支；页面路由不再过 `policyDenial`，**但页面口自己判 `account.enabled`**（停用的账号人也不给用，`pageAccount()` 回 409 `account-disabled`）—— 两边各拦各的，别只在一边拦。`sentToday()` 只数 `by === "agent"` **且不是草稿**的审计行（草稿写在同一个文件里，但它没发出去）。`mutate` 从工具提示**与 `mail_accounts` 的回包**里都拿掉（`agentPolicyView()`；v1 没有对应动作，面板本来也不给这个开关）。
7. **坏配置拒写，不拿默认值盖。** `readMailConfigChecked()` 把「文件读不出来」交出去；`/api/mail/config` 带 `configError` + `configPath`，面板顶一条横幅指路；账号/权限/test/repair 这些写操作一律 409 `config-corrupt`，一个字节都不动。**人自己修或删文件再刷新** —— 这条宁可挡住，也不要静默丢凭据。
8. 小的照旧各修：`mail_reply` 带附件（复用 `normalizeAttachments`）；`html` 不再受「取附件」管、纯 HTML 的信在扩展侧扒标签；`fetchRaw` 先问 `size` 再拉 `source`；面板不再伪造已读；列表/详情各带自己的请求代号（切文件夹就作废在飞的请求）；`asInt` 把 `null/undefined/""` 当「没给」；删账号顺手清 `policy.accountIds`；导航角标去掉「当前列了几条」那个假数字；删账号两步确认；TLS 由端口算（`secureForPort`）；每日上限输入非数字时不保存并回填。

**代价：**

- 列表首次取数从「一次 FETCH，< 1s」变成 **2–5s**（1092 封的信箱实测：limit=20 2.5s、limit=100 4.6s、offset=300 3.7s）。多出来的是扫信封 + 一次 SEARCH。还没做的是**按 (账号, 文件夹) 缓存排序结果**（30 秒足够），真要提速再说 —— 现在先保证对。
- 上限 2000 封的扫描预算：一封 2000+ 的邮箱如果时间序乱到 2000 封都盖不住，仍然会退化成「按到达顺序的前 2000 封里挑最新的」。未读超过 2000 时同理（取到达得最晚的那批）。
- 确认框 5 分钟内不点 = 不发；AI 那头拿到的是 `timeout`，要重新发起。宁可多问一次，也不替人点头。
- 页面不再受「AI 权限」管，意味着**关掉「读邮件」并不会阻止你自己看信**（这才是文案的意思），也不再是一个「隐私开关」：想真的断掉，去删账号或停用它。
- 前端多一个模块（`mailconfirm.ts`）+ 一段 CSS。确认框**挂进 `#app`**（跟「本机管理」同一个挂法 `(document.getElementById("app") ?? document.body).append(…)`），跟别的弹层一起吃 `zoom`；宽高用 `min(px, 100%)` 跟着遮罩扣完 padding 的可用格走、不写 vh/vw（D263 明说别往 body 浮层那个豁口里塞）。

**验证：**

- `npm run test:mail`：`bridge/tests/mail-unit.mjs` 44 → **65**（新增 21 条：读权限关着页面照样能读、缺 uid 才 400、页面发信不看 AI 权限、AI 仍被 `policy-denied:send` 拦、白名单只拦 AI、日上限只数 AI、草稿不占上限、停用账号页面也 409、删账号清 `accountIds`、默认账号停了不报、`mail_accounts` 不报 `mutate`、坏配置 409 且磁盘不动）；新增 `bridge/tests/mail-list-unit.mjs` **34** 条（序号窗口、按时间挑、翻页、地址解析、`bad-input`、附件口径、HTML 扒标签）；`web/tests/mail-unit.mjs` 5 → **10**（`secureForPort`/`portOf`、`MailConfirmQueue` 的排队与回执、`MAIL_ERROR_TEXT` 的说法）。
- 真信箱（作者自测的一个信箱，附件名与地址已脱敏，见 D362；INBOX 1092 封）：改前 `limit=20` 最新 **2022-01-31**、未读 6 封；改后最新 **2026-11-14**、未读 100+；`offset=300` 能翻到 2025-03，与「整箱排序后第 301–320 封」逐条一致；`📎` 只为最终那几封补，不再整箱取 `bodyStructure`。
- 假桥（临时 `PI_WEB_STATE` + 指向 `127.0.0.1:9` 的账号）：坏配置 → 409 且 `REALSECRET` 原封不动；页面发信不看 `policy.send`；AI 发信仍被拦；白名单只拦 AI。
- `npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（tsc + i18n-check 3040 键 × 3 + `test:viewport`）全绿。
- **复审（两轴：标准 / 需求）之后补的一轮**，对着 `git diff main...HEAD` 逐条核：页面口补上 `account.enabled`（以前停用账号在面板里照样能读能发，CHANGELOG 那句「页面只受账号停用限制」才成立）；草稿不再占 AI 的日上限；`mutate` 真的从 `mail_accounts` 回包里去掉（不只是文案）；审计失败改成「错误码 → 人话」的映射（`MAIL_ERROR_TEXT`，认不出来的码只说「失败」）；详情的 `finally` 也比 `detailSeq`（先发的慢详情不会提前收掉后发请求的「正在读」）；确认框挂进 `#app`；超时只留一份 `MAIL_CONFIRM_PAGE_MS`；删掉没人读的 `downloadable`、页面上的「附件（取附件权限关着）」死分支与 `MailConfirmFrame` 的 `as any`；`normalizeAccount` 改用 `mailaddr.isEmailAddress`；`mailconfig.ts` 头部注释改成「`policyDenial` 是给 AI 的唯一判据」；GLOSSARY 补「邮箱面板 / AI 权限 / 发送前确认」、README 补邮箱一条与 `test:mail`。
- **没做的：** 确认框只有 `MailConfirmQueue` 的单测，没有 playwright 的点击用例（这台机器上要临时装 chromium）；`mail_send` 真发一封的路径仍靠肉眼。

## D265 轮次缩略图照 WorkBuddy 重写：收起是短横、展开是同一批节点（用户口径 2026-11-15）

用户口径：**「聊天记录右侧那个对话刻度表做得不太好，照着本机 WorkBuddy 里同样的功能重写一下。」**

**逆向来源（可复核）**：本机 `/Applications/WorkBuddy.app` 5.9.3（Electron 应用，
`Contents/Resources/app.asar` → `renderer/assets/`）。功能是
`contexts-B8WkfybU.js` 里的 `ConversationHistoryNavigation`，样式在同名 `contexts-O760BA_R.css`
（类名前缀 `conversation-history-navigation`，21 条规则）。拿到的几何、时长、阈值都是它写死的常量：
一格 14px（收起）/ 28px（展开）、行高 26、展开上限 400px、收起带最宽 40px、面板宽 96–320px、
展开 543ms（`cubic-bezier(.16,1,.3,1)`）/ 收起 343ms、悬停意图 60ms 进 / 180ms 出、
超过 120 条只画看得见的那几十行、行文字截 160 字符、宽度靠一个隐形「尺子」撑。

**决定：**

1. **收起和展开画同一批节点**，不再「一列刻度 + 一个列表」两套 DOM（旧的 Q-028 实现是两套，点刻度
   和点行是两个处理器、两种坐标）。现在一个 `.turn-row` 里同时有 `.txt` 和 `.dash`：收起时文字
   `opacity: 0`、`transform: translateY(--turn-compact-y)`，展开时同一节点改成
   `translateY(--turn-expanded-y + --turn-expanded-scroll-offset)`。面板用 `clip-path` 从「右缘一条
   40px 宽、只覆盖带子高度」的窄条张开成整块（`round 16px`），底下那层 `.turn-surface` 同时淡入 ——
   用户看到的是「同一块东西长大」，不是「弹出一个新框」。
2. **两套坐标靠一次滚动补偿接上**（这是整套东西的核心，也是最容易做错的一步）：同一个滚动容器，
   收起时它的 `scrollTop` 是「短横滚到哪儿」，展开时是「所有行滚到哪儿」。展开前先算出「那一轮在
   展开坐标里的 `scrollTop`」，差多少先用 CSS 变量 `--turn-expanded-scroll-offset` 把行推回原来的
   视线；等 543ms 动画放完，在**关掉过渡的那一帧**（`.scroll-commit`）里把 `scrollTop` 改到位、把偏移
   清零（`commitScroll()`）。收起同理，用 `--turn-scroll-compensation` 反向补一次。实测 200 轮的会话里
   「当前」那一行展开前后屏幕纵坐标差 **0.0px**（先量收起态、再量 +120ms、+680ms）。
3. **收起时那一列不再是「抽样后的刻度」**。旧实现把 200 轮按比例抽成能放下的几十根，抽掉的那些从
   此点不到。现在最多摆 28 根、摆不下就在那一条带子里跟着「当前」滚（`keepCurrentInBand()`），
   一根都不少；行也不再全画，超过 120 轮只画「收起坐标」和「展开坐标」两段可见区间并起来的那批
   下标（`shownRange()` 返回**下标集合**，不是 min..max —— 刚换会话时两套坐标离得很远，取区间会把
   中间几百条一起画出来，窗口化就等于没做）。
4. **交互：悬停 / 聚焦才展开，点行才跳。** 收起时接指针的是一块盖在短横上的透明按钮
   （`.turn-hit`，WorkBuddy 的 `rail-hit`），进 60ms 展开、出 180ms 收起 —— 扫过去不算。键盘：聚焦即
   展开、Esc / 焦点离开带子收起。**「点一根短横直接跳」这条没有了**：指针扫上去 60ms 就已展开，
   点下去的时候指针底下已经是行；短横本身只有 8×2px，硬要它可点反而更难点中。
5. **行节点复用，不每帧重建**：展开着的时候谁被拆掉，拿着它的焦点就会收到一次 `focusout`
   （顺带把刚点出来的高亮抹掉）。窗口化滚动时该增删的只是差额，而且行是绝对定位的，DOM 顺序
   不影响摆放 —— 复用 + 不重排。同理，`focusout` 的 `relatedTarget` 为 null（焦点掉回 body，多半是
   那一行被窗口化删了）不算「用户走了」；`pointerout` 的 `relatedTarget` 为 null 且指针坐标仍落在
   带子里，也不算离开。这两条不写，长会话里面板会「开 → 收 → 开」抖个不停（真踩到了）。
6. **顺手修掉一个老坑**：`#app` 上有 `zoom: var(--ui-scale)`，`getBoundingClientRect()` 是**视觉** px、
   `style.top` 是**布局** px。旧的 `frame()` 直接拿前者写后者，字号 125% / 150% 下带子会往下漂
   **69px / 97px**（不会报错，只是慢慢偏）。现在除一次 `--ui-scale`，三个档位的居中误差都在 0.5px 内。

**代价（接受）：**

- 长会话里想点很早以前那一轮，得先把面板往上滚（旧实现是抽好样、一眼点得到）。这是 WorkBuddy 的
  取舍 —— 换来的是「一根不少」和「不会点到被抽掉的轮」。带子跟着「当前」自动滚，读的时候几乎用不上。
- 收起时那 40px 走廊里没有可点的东西，点击落到 `.turn-hit` 上（展开了才有行可点）。
- 面板展开时先有一次 543ms 的生长动画；`prefers-reduced-motion` 下没有专门分支（WorkBuddy 有，这里
  暂未接 —— 真要接，是给 `.turn-rail` 加一条 media query 把 `--turn-open-dur` 归零 + 跳过等待）。

**补充（2026-11-15 用户报障：除了第一轮，别的轮次要连点三次才顶到视口最上面）**

拉开量才看清，这不是「跳转」坏了 —— 面板**展开并落定**之后点行是 4/4 一击即中；坏的是**「点击」本身**
在那几百毫秒里被吃掉了。真桥 + 真会话（16 轮）+ 真鼠标，逐个点击记录「按下时指针底下是谁 / 抬起时
是谁 / 正文有没有动」：

1. **收起态那根短横不是点击目标**：`.turn-row` 收起时 `pointer-events: none`，盖在上面的是空的
   `.turn-hit`（它只负责聚焦 → 展开）。点一下最多把面板「打开」，**根本不可能一击就跳**。
   老版本（D265 之前）的 `.turn-tick` 是带 `onclick` 的 `<button>`，所以以前是一下。
2. **面板是 `clip-path` 从右往左长出来的，左边那片前 ~0.4 秒还属于正文**：`inset(… calc(100% - 40px))`
   → `inset(… 0)`。实测同一行、不同停顿：**0 / 60 / 120 / 200 / 280 ms 按下时指针底下是 `<li>`（正文）**，
   360 ms 那次按下在 `<li>`、抬起落在行上 —— 浏览器把 `click` 派发给**共同祖先**，行上的处理器不跑；
   440 ms 之后才稳定命中。也就是「移上去到能点」中间有个半秒的空窗（60ms 意图 + 543ms 动画）。
3. **展开时列表会滚一段把「锚点行」按在原地**（14px 一格 → 28px 一格），于是同一个屏幕位置对应的
   轮次变了：320 轮会话里瞄 `data-i=315`，展开后指针底下是 **317**；16 轮会话里瞄 1 得到 **2**。
4. **行 26px 高、格距 28px**：那 2px 缝落在 `.turn-rows`（没有处理器的容器）上 = 点了没反应。
5. （行为而非 bug）靠近结尾的几轮「顶对齐」物理上做不到：`jumpToTurn` 在 `startTop >= maxScroll` 时
   直接 `follow()` 到底部（D60 定的）—— 这几轮点多少次都不会跑到最上面。

于是用户看到的就是三步：**第 1 下点在正文/空处（只开了面板）→ 第 2 下被共同祖先吃掉、或落到隔壁一轮
→ 第 3 下（面板落定、行文字也看清了）才成**。「第一轮没问题」也对得上：头几行离锚点最近、要跳的距离
也最短，偏移最小。

**改法（四条一起上，缺一条都还留着一次白点）：**

- **收起态点短横 = 直接跳那一轮**：按下时按「收起那套坐标」反推最近的短横（`dashAt()`，几何反算，
  不靠 `elementFromPoint` —— 它会被 `clip-path` 和目标行之间的缝骗），抬起就跳，跳完顺手把面板摊开，
  让人看见自己落到哪一轮。
- **按下即认账**：`pointerdown` 记下那一刻命中的行，`pointerup` 只要求指针没移开 6px 就认 —— 不再要求
  两次落在同一个元素上（这正是被「共同祖先」吃掉的那一路）。面板落定之后（`open`）改用「行」的口径
  （`rowAt()`，按行此刻的 rect 算），因为这时用户看得见行文字，点什么就该是什么；还在长/收的时候用
  「短横」口径，因为用户瞄的是那一根。
- **挡住紧随其后的原生 `click`**：两条路都会收到这次点击，后跑的那条是按「已经滑到那儿的那一行」算的
  —— 不挡就是「按下对、抬起错」，错的那条赢（`clickGuard` 400ms）。
- **行高 = 格距 = 28px**（去掉那 2px 缝），面板外框整块接指针（`.turn-rail.open .turn-panel-outer`
  `pointer-events: auto`，把 `clip-path` 裁掉的那半边的按下捞回来）。
- **动效砍半**：展开 543 → **240ms**、收起 343 → **200ms**、意图 60 → **40ms**。WorkBuddy 那 543ms
  正好是空窗本身 —— 它那边点击也是同样的物理问题，只是没人报。

**代价：** 面板长出来时不再有那半秒的「慢慢张开」（240ms 仍是缓动曲线，观感还在）；`dashAt` 要读一次
`--ui-scale`（缩放换算，见上一条）；收起态点短横现在**会**同时把面板摊开（老版本点了不展开）。

**验证：** 新探针 `probes/rail-click.mjs`（`npm run probe:rail-click`）钉住四条：收起态点短横一击到位、
展开态点行一击到位、**动画进行中在文字区按下也会跳**（以前纹丝不动）、点行底边那一像素仍归这一行。
真桥 + 你的 16 轮会话手动复核：停 100/160ms 点在短横上 → 直接顶到第 3 轮（原来跳去第 7 轮）。
`npm run probe:rail`（四条探针）+ `test:loadolder:ui` 67/67 全绿。

**验证（真 Chrome，playwright-core）：**

- `probes/round20-turns.mjs`（12 轮 + 200 轮两条会话）：一根短横一轮、滚到底最后那根是 `cur`、悬停
  展开、点行跳转顶对齐并停跟流、键盘焦点展开、200 轮时行被窗口化到 48 行而带子仍在正文视口内、
  展开后「当前」那一轮在列表视口里。**改了三处断言**：`isVisible()` 在 `clip-path` 裁掉时也是 true
  （旧实现靠 `display:none`），改成看 `.open` / `.settled` 两个 class；`.turn-tick` 全部换成 `.turn-row`；
  「200 根刻度被抽样」改成「行被窗口化」。
- `probes/turn-rail-last.mjs`：点最后一根短横 / 最后一行都落在最后一轮的输入上（`top = 视口顶 + 6`），
  下面还留着 `>200px` 可滚，跟流停掉。
- `probes/rail-ghost.mjs`：320 轮里 300 轮未载入 → 展开、滚到顶、点第 4 轮 → 自动翻 15 页取回来、
  顶对齐、亮一下、不 busy；索引里多一条正文没有的轮次 →「没翻到第 5 轮」3 秒自收。
- `bridge/tests/history-ui.mjs`（`npm run test:loadolder:ui`）**67/67 全绿**：ghost 占位 / 分界线 /
  「当前」不落在 ghost 上 / 真鼠标点行不被拽走 / 翻页后带子总高不变。为窗口化补了两个 dataset
  （`.turn-rail` 的 `data-turns` / `data-ghosts` / `data-rendered`）：DOM 里只有看得见的那几十行，
  全量数字得有个地方读。
- `npm --prefix web run typecheck`（tsc + i18n 3022 键 × 3 + 视图单位守卫）、`node scripts/build.mjs
  --only bridge` 通过。
## D266 表格预览照本机 WPS 的资源补齐：格式引擎重写、函数表 51→215、功能区真菜单（用户要求「用 rea 逆向本机的 wps」，D256–D262 的延伸）

**问题：** 上一轮的表格浮窗已经「照 WPS 排过一次」，但排法是靠记忆 + 截图：功能区只有 6 个页签、每页十来颗按钮，字色/填充是「红/黄 一按切换」，数字格式只有 6 个写死的 id，边框 3 种，没有色板、没有下拉、没有格式刷、没有填充柄；公式只算了 51 个函数。用户的话是「不完善，用 rea 逆向一下本机的 wps，把 Excel 的功能都完善一下」。

**做法：先去读参照物，再动手。**

1. `rea inspect-desktop-application /Applications/wpsoffice.app` 把「这台机器上的 WPS 是什么」弄清：6.11.0（8885），1.3 GB，10932 个条目、6316 个文件头，**没有 Electron / 没有 JS 包**——是原生 Mach-O + Qt（框架名都带 `Kso` 后缀），表格落在 `etmain`（界面）/ `etcore`（模型）/ `etsolver`（计算）/ `excelrw`+`etxmlrw`（读写）/ `griddrawer`（绘制）里。
2. 界面是**声明式资源**，不用跑程序就能读：`Contents/Resources/office6/res/commands/et/ongmani/CT_*.kuip` 是七个页签的 ribbon 定义（组、项、`hotKey`、`shortcutHint`、嵌套下拉都在），`mui/zh_CN/config/{numberformat,datetimeformat,etfunctionhelp}.cfg` 是特殊数字格式、日期格式表、函数清单（406 个名字）。新脚本 `tools/wps-inventory.mjs` 把这两样读成 Markdown / 函数名清单，可重跑。
3. 逆出来的东西落成 `docs/SHEET-WPS.md`：功能区结构、数字格式表、函数清单，以及一张**逐条对照表**（WPS 有 / 我们有 / 🔶 只有一部分 / ❌ 不做 + 为什么）。

**决定：**

- **数字格式引擎按格式代码重写，不再「认不出就退回原样数字」。** `bridge/src/sheet/numfmt.ts` 现在认：分区（`正;负;零;文本`）、`#`/`0`/`?` 三种占位、千分位与**缩放逗号**（`0.0,` = 除以 1000，WPS 的「单位：万元」就是这么写的）、百分比、科学记数（含工程记数 `##0.0E+0`）、分数（`# ?/?` / `?/8`）、`[h]` 累计时长、`[DBNum1/2/3]` 中文数字、`[$¥-804]` / `[红色]` / `_(` / `*x` 这些方括号与占位。四舍五入按**十进制**做（`1.005` → `1.01`），不是 JS 的 `toFixed`。
- **自定义格式能写回文件。** `CellStylePatch.nf` 从「只能是内置 id」放宽到 `number | string`：字符串是格式代码，`style-write.ts` 先按内置表反查，查不到就在 `xl/styles.xml` 里造一条 `<numFmt>`（id 从 164 起、按代码去重、`<numFmts>` 插在 schema 要求的最前面），`count` 属性跟着改。这样从功能区选「中文大写数字」，写进文件的就是 WPS 自己那串 `[DBNum2][$-804]G/通用格式`。
- **函数表按 WPS 的清单补到 215 个**（`calc.ts` 51 + 新文件 `functions.ts` 164）。取舍不变：只做标量语义，数组公式/动态数组/外部引用/迭代计算不碰，认不出的函数仍旧 `#NAME?`。顺手把两处老毛病修了：`ISERR(1/0)` 以前被错误短路成 `#DIV/0!`（函数看不到参数里的错误值），`ROW()`/`COLUMN()` 以前直接 `#NAME?`（`CalcCtx` 现在带 `at`，跨表算的时候也会对）。
- **共用零件抽到 `value.ts`**：值类型、类型转换、比较、条件匹配（含 `*`/`?` 通配、`~` 转义、日期串条件）、日期序列号互转。原来这些都埋在 `calc.ts` 里，函数表一涨就讲不清了；`criteria()` 也跟着搬过去，顺手补上通配与「条件写成日期」两种真实文件里最常见的情形。
- **功能区做成 WPS 那颗形状：主按钮 + ▾ 分开。** 数字格式、字色、填充色、边框、合并、清除、排序、自动求和、函数库都是「点主按钮=最常用那一下，点箭头=整张菜单」。**旧按钮的 `title` 全部保留**（探针和用户的肌肉记忆都按它找）。
- **空单元格也能上色上边框。** 以前 `styleOf()` 一开头就 `if (!cell) return undefined`，于是「给空区域加边框」这种最普通的操作在预览里毫无反应。改成按坐标取样式（`styleOf(r, c)`），空格子照样合并本地样式补丁。
- **填充柄是真的能拖。** 之前那个小方块只是画着好看（`pointer-events: none`）。现在按住往四个方向拖：数字两格以上按等差、其余按循环复制、带尾号的文本（`Q1`→`Q2`）自增，松手落成**一条**撤销记录。拖的时候只画虚框，不预写。
- **键盘补到 Excel 的手感**：`Ctrl/Cmd + 方向键`（先跳过空格、再走到连续区尽头）、`Ctrl+Shift+方向键` 扩选、`Ctrl+A` 选整块、`Tab`/`Shift+Tab`、`Enter`/`Shift+Enter`、编辑框里 `Alt+Enter` 换行。
- **底栏报选区的求和 / 平均值 / 计数**（WPS 那条），超过 5 万格不算。
- **数字格式选完立刻改样子**：`web/src/sheet/fmt.ts` 是一份**只认功能区那 20 来个代码**的前端预览，认不出来就退回桥端给的显示串。这一份重复是有意的：桥端才是口径（读文件里的代码），前端这份只为「点完不用等存盘」。写进 D266 的代价里。

**代价 / 可改：**

- 两份格式代码解释器（桥端全量、前端闭集）必须同时改；前端那份只覆盖菜单里能选到的代码，文件里别的自定义格式在本地改过之前一律走桥端算好的串。
- 中文数字（`[DBNum]`）只按整数 + 4 位小数的口径实现，`[DBNum20]`（WPS 的「中文大写数字 2」那一档）没做区分。
- 填充柄不做「序列对话框」、不做等比/日期步长提示，也不搬公式里的相对引用（复制过去的是原文）。
- 还是不做：工作表增删、隐藏行列、批注增删、定义名称、条件格式新建规则、数据验证规则编辑——理由与工作量写进 `docs/SHEET-WPS.md` 的对照表。
- `mui/zh_CN/*.qm` 解不出来（表头不是标准 QM），所以功能区的中文写法是按 WPS 习惯对回去的，不是从翻译文件里读的。

**验证：**

- 单元测试（新建，`npm run test:sheet`）：`sheet-numfmt-unit.mjs` 60 条（两位数小数、千分位、缩放逗号、科学记数、分数、中文数字、日期时刻、1904、文本段、`isDateCode`）；`sheet-calc-unit.mjs` 148 条（17 类函数的真值 + 错误码 + 通配 + 日期条件）；`sheet-style-unit.mjs` 9 条（自定义 numFmt 写回：代码去重、id 从 164 起、引号转义、`<numFmts>` 位置、二次写入不新增）。
- 老行为的护栏没动：`probes/xlsx.mjs` 里 356 条断言照旧跑（`¥1,234.50` / `(400.00)` / `12.3%` / `2025-01-21` 这些显示串逐条比过），并新增 **10 条**：填充柄拖出等差序列、`Ctrl+↓` 跳连续区末尾、底栏求和/计数、清除菜单、边框菜单只加下边框、色板 26 格、点色板立刻换底色、数字格式菜单选「中文大写数字」当场变字、函数库把 `=SUM(` 填进公式栏、存盘重开后中文大写还在。整轮 **244 ok**（改前 234 ok）。
- 这台 macOS 上 `probes/xlsx.mjs` 有 3 条本来就红（`千分位整数` 量出 `#######`、`Tab 提交并往右走` / `重开还看得到新写的数` 读到 `7.5¥114.00`），**main 上未改动的构建同样红**——是字体度量差异，不是这一轮引入的（对比方式：在 main 检出上 `npm run build && node probes/xlsx.mjs`，失败集合逐条相同）。

## D267 邮箱新账号：地址只填 @ 前面的部分，授权码不再被浏览器自动填（用户要求 2026-11-15）

**问题：** 用户说「邮箱地址，应该有默认值，跟随用户选择的邮箱类型，自动切换。另外客户端授权码，现在会直接填入值，应该是 Edge 保存的当前网页的密码。这个改掉」。

**决定：**

- 个人邮箱预设（163 / 126 / yeah / qq / aliyun / sina / 189 / gmail / outlook / icloud / yahoo / zoho / yandex）在 bridge 的预设表里加 `domain`；邮箱地址输入拆成「本地部分 + 固定 @ 域名」，类型切换时只换域名、保留前缀。企业邮 / 自定义没有固定域名，退回整框输入；切到它们时只留前缀，避免把旧服务商地址静默保存。
- 域名只是表单默认值，不替用户填本地部分；保存时仍要校验地址以当前预设域名结尾。
- 客户端授权码输入框统一 `autocomplete="new-password"`（与 Jira API token 同口径），避免 Chrome / Edge 把本站保存的登录密码自动填进密码框；其他字段按语义给 `name` / `username` / `email`，不再一律 `off`。

**代价：** 地址编辑从单框变成「前缀 + 固定后缀」，粘贴完整本域地址时会把后缀临时藏起来；这层逻辑在 `mail-shared.ts` 里单测，UI 用临时探针验证，没进常驻测试。

## D268 热部署可以先暂存再部署：干净构建，部署前恢复（用户要求 2026-11-15）

**问题：** 主检出只要有一个未提交的改动（哪怕只是 `package-lock.json` 的 npm 元数据），热部署就整个灰掉，用户只能先提交或还原。用户要求加一颗按钮，先 `stash`、`pull`、`pop` 再部署。

**决定：**

- 只在**当前分支、非 detached** 时开放。stash 属于当前工作区，不能安全地 pop 到另一条分支；选别的分支、detached HEAD 都不显示这颗按钮。
- worker 内部顺序固定为：`git stash push --include-untracked` → `git fetch` → `git merge --ff-only origin/<branch>` → `npm run build` → `git stash pop` → 杀旧 bridge / 起新 bridge。构建使用**干净分支**，本地改动不进入本次产物；`pop` 放在杀旧进程之前，恢复失败就不换进程。恢复只保证工作区内容回来，不还原 index 暂存状态；`pop --index` 在 index 冲突时可能已经落地文件却返回非零，worker 会误判。
- stash message 用本轮唯一的 `hotdeploy-<pid>-<time>`，按 message 找 `stash@{n}` 再 pop，绝不盲取 `stash@{0}`（仓库里可能已经有旧 stash）。
- 失败恢复：fetch / merge / build 任一步失败都先尝试恢复 stash；`pop` 冲突则中止部署，旧 bridge 继续跑，stash 保留并在错误里给出 message；worker 崩溃时 stash 仍在 `git stash list`。
- 界面在 dirty 时保留禁用的「先提交改动」主按钮，旁边追加「暂存后热部署」次级按钮，点之前二次确认，说明「本次构建不包含这些改动」。
- 不自动 `reset` / `checkout`，不做 dirty build。D254/D255 的默认拒绝保留，只有显式传 stash 参数才走这条路。

**代价 / 限制：**

- 本次构建不包含本地未提交改动；要验证 WIP 仍需先提交或另开分支。
- `pop` 可能与上游冲突（尤其同一个 `package-lock.json` 被两边改），冲突后需要手动解决再重试。
- 只支持当前分支；不能把当前分支的 stash 带到别的分支。
- 旧 stash 不会被复用或清理，仍留在 stash list 里。

**验证：** 新 `bridge/tests/hotdeploy-stash-unit.mjs` 在临时仓库覆盖 stash/pop、未跟踪文件恢复、旧 stash 不误取、冲突时 stash 保留、worker 在 build 失败后恢复改动，以及 worker 在 pop 冲突时停在恢复步骤、不进入换进程；`npm run test:hotdeploy` 串跑旧纯函数测试和这条集成测试。另用临时 bridge + Playwright 回归按钮显隐与确认框。

## D269 表格编辑「点哪格就是哪格」：照 WPS 的 DP→LP 分层换算指针坐标（用户报障 2026-11-15）

**问题：** 表格编辑态里鼠标点一个格子，选中的却是右边/下面的一格甚至几格；越靠右/下偏得越多。字号越大越明显，125% 时 B10 会选到 B12、E2 会选到 F2。

**根因：** `#app { zoom: var(--ui-scale) }`（D36 / D158）让 `clientX/clientY`、`getBoundingClientRect()` 都变成**视觉 px**，而网格的 `leftOf()` / `topOf()`、行高列宽、`scrollLeft/scrollTop` 是**布局 px**。`pointCell()` 却直接 `clientX - rect.left` 去和 `leftOf()` 比，等于把视觉 px 当布局 px；界面缩放 1.25 时每个格子被多算 25%，偏移随列/行累积。边界判界同样拿视觉指针去比 `clientWidth`（布局 px），右/下那片可点的格子会被判成界外。

**为什么：** 命中坐标必须与行高列宽在同一坐标系里；视觉 px 只在最外层换算一次，换算点越少越不会在下一个 `getBoundingClientRect` 里复发。WPS 的 DP→LP 分层就是把这个边界固定成视图层的一件事。

**先逆 WPS。** 按用户要求继续用 `rea` 读本机 WPS：

```bash
rea inspect-desktop-application /Applications/wpsoffice.app --detail summary \
  --evidence_output .scratch/wps/app-inventory.json
strings .../etcore.framework/Versions/A/etcore \
  | grep -E "IETViewPortTrans|IKETViewportService|IETViewportUtility|KWorksheetViewPanes|KViewportLayer"
nm .../etmain.framework/Versions/A/etmain | c++filt | grep -E "DPtoLP|LPtoDP"
```

`etcore` 里有 `IETViewPortTrans` / `IKETViewportService` / `IETViewportUtility` / `KWorksheetViewPanes` / `KViewportLayer`（`RENDERLAYER0`），`etmain` 的鼠标路径明确调用 `KAxOleObject::DPtoLP(IKViewportService*, QPoint*, ...)` / `LPtoDP`。这说明 WPS 的同类写法是**先做设备坐标 → 逻辑坐标的换算，再做命中**；冻结、滚动、视图缩放都在逻辑坐标一侧，而不是拿窗口坐标直接套行高列宽。完整命令和结论落在 `docs/SHEET-WPS.md` 第 8 节。

**决定（照 WPS 的分层）：**

- `SheetGrid` 新增 `uiScale()`（浮窗把 `opts.scale` 传进来）；`pointCell()` 先 `(clientX - view左缘) / uiScale()` 换回布局 px，再按冻结带分叉、加滚动量，最后二分查行列。右/下边界用 `clientWidth * uiScale` 判，滚动条那条缝不算格子。
- 同一换算覆盖所有指针几何：拖列宽/行高（再乘表格自身 `zoomLevel`）、填充柄拖动、换行行高的 `getBoundingClientRect` 实测值、并排视图的分界线。
- **冻结带事件挂 root**：`.sd-frz` 是 `.sd-view` 之外的覆盖层，原来的 pointer 监听挂在 view 上，点冻结行/列根本到不了 `pointCell`；挂到网格 root 后仍用 view 的矩形判界，表头点击返回 null。
- **冻结表头握把贴边**：冻结列/行的表头容器只有一格宽/高且 `overflow:hidden`，普通握把的 `right/bottom: -3px` 正好被裁掉一半，点不到；`colhead-frz` / `rowhead-frz` 里的握把改贴边。
- **合并区归左上角**：`pointCell` 命中 `spans` 时返回 `span.r0/c0`，否则点合并标题中间会出现 `A1:G1` 这种半截选区，名称框也不对。
- **按表视图状态集中到 `SheetGridState`**：列宽/行高/冻结/本地格式预览由浮窗持有；网格因为大表 `showTooBig` 被销毁重建时，切回来仍能恢复。
- **Alt+Enter 分支提前**：旧代码先判普通 Enter，`ev.key === "Enter" && ev.altKey` 永远到不了；现在先判 Alt+Enter 并在编辑框里插入换行。
- **切表先落账、按表分账**：改动账目只按 `"r:c"`、不带表名，有未保存改动时 `pickSheet` 直接提示「先保存改动，再切换工作表」；列宽/行高/冻结/本地格式预览按表保存，切回来不丢、切过去不串。关闭浮窗前先 `commitEdit`，刚敲完没回车的编辑不会丢。
- 功能区下拉菜单的翻转判断把 `menu.offsetHeight`（布局 px）乘上界面缩放再和 `window.innerHeight`（视觉 px）比。

**代价 / 可改：**

- `uiScale()` 依赖浮窗传入的 `opts.scale()`；直接 new `SheetGrid` 的测试不传时按 1 处理（现有测试都是 1）。
- 合并区点击归到左上角是「整块选择」，但 Shift 扩选跨过合并区时仍只扩到左上角，不是 Excel 那种把整块纳入矩形；边界情况留待以后。
- 切表拦截是「先保存再切」，不是「每张表各留一份未保存草稿」；后者要改 `edits` 的键空间，工作量大，这一轮不做。
- 切表会清掉撤销/重做栈（撤销记录没有表名，留着会把 A 表的 r:c 回退到 B 表）；每张表的撤销历史不跨表保留。
- 拖列宽/行高仍是本地先画、松手写文件；如果写文件失败，本地覆盖值还在（旧行为，未改）。

**验证：**

- 新探针 `probes/sheet-hit.mjs`（`npm run probe:sheet`，可用 `PI_TEST_SCALE=0.8/1/1.5` 重跑）在 0.8 / 1 / 1.25 / 1.5 四档界面缩放下点 B2 / B10 / E2 / E10：修前 1.25 档得到 B12 / F2 / F12，修后全部命中；`report.xlsx` 的冻结表滚动后点 A1 / A21 / K21 全部命中（修前冻结带点击根本不动），冻结列拖选 A21:A25 也命中，报表 B 列加宽后切到明细不继承、切回来还在，有未保存改动时切表被拦。
- 同一探针：表格缩放到 200% + 界面 125% 时拖行高 25px 从 50 → 75、拖列宽 25px 从 160 → 185；修前行高会被放大成 162.5 左右。
- 同一探针新增换行行高：`styled.xlsx` 的换行行在表格 200% 下从 43.75 → 87.5（2.00×），不再按 4× 放大。
- `Alt+Enter`：修前 `textarea.sd-edit` 直接消失并提交到下一格，修后仍在编辑框且值以换行结尾。
- `npm --prefix web run typecheck`（tsc + i18n 3059 键 × 3 + 视图单位守卫）通过。
- `npm run build:web` 通过。

## D270 插件市场照本机 DeepSeek 的 dshmarket 1.73.19 重画（用户要求「用 rea 逆向本机 deepseek 里面的插件市场 dshmarket，一比一复刻」）

**问题：** 输入框下那颗「扩展」按钮打开的管家里，「扩展商店」一直是 2015 年式的清单：一行一个包、月下载量、安装按钮。用户要求把入口改叫「插件」、把「扩展商店」改叫「插件市场」，并按本机 DeepSeek Harness 里的 dshmarket 1:1 重画插件市场。

**逆向来源（可复核）：**

- 本机 `/Applications/DeepSeek Harness.app` 0.2.2-rc.3（安装于 2026-11-13），桌面 profile 的插件在
  `~/.dsh/profiles/desktop/node_modules/dshmarket`，版本 **1.73.19**。真正的界面在
  `client/client.js`：React 18 bundle，`Market.module.css` 被内联成一条 79,886 字节的字符串，
  482 个选择器，类名前缀 `nUhMVa_`。这不是猜的：`node -e` 把 `const css = "…"` 解出来存到
  `/tmp/dshmarket.css` 后逐条读的。
- `rea analyze-javascript-application ~/.dsh/profiles/desktop/node_modules/dshmarket --source-path
  client/client.js --detail summary --evidence_output /tmp/dshmarket-rea`：REA 6.9.0，20,802 条
  semantic node、47.8 MB 的 Evidence，确认了 Masonry 的分列公式和卡片字段。
- 在 1440×900 的 `dsh web`（DeepSeek Harness 的 web 入口）里用 Playwright 实测宿主页：内容宽
  **960**；三列卡片各 **310.66**、列距 **10**；卡片圆角 **20**、内边距 **12/14**；标题
  **14/20·500**；正文 **12/18**；标签 **11/17**（圆角 999、内边距 1/8）；搜索框高 **32**、圆角
  **12**；内层页签高 **32**、字号 **13/20**；最近收录横条高 **80**、宽 `min(320px, 30.7692% - 7.38462px)`；
  卡片列数 `min(3, max(2, floor((width + 10) / 290)))`，≤680px 退成单列。

**决定：**

1. **只改入口这一层，不把整个仓库的「扩展」做全局改名。** 输入框下按钮 → 「插件」，管理器标题 →
   「插件与 MCP」，设置页那一栏 → 「插件与 MCP」，页签 → 「插件市场」，空态指向「插件市场」。
   代码里的 `ext` / `extension` 标识、pi 自己的 `--no-extensions`、MCP 的「扩展」语义都不动 ——
   用户要的是界面上这两个词，不是一次有风险的全局重命名。
2. **插件市场照 dshmarket 的「发现」页重画，但数据仍是 pi 的 npm 商店。** 卡片结构、三列瀑布流、
   搜索框 + 筛选、分类胶囊、最近收录、卡片内部的「名字 / 作者 / 版本 / ↓月下载 / 三段描述 /
   未声明要求 / 分类标签 / 收藏 / 评论 / ··· / 安装」全部按 dshmarket 的 DOM 顺序与几何来；颜色换成本项目
   的暗色令牌（`--panel-2` / `--line-soft` / `--dim` / `--faint` / `--accent`），因为本仓库没有亮色主题，
   硬塞一块白底会在暗色聊天里像另一个程序。**不伪造 DSH 的 star 数、宿主兼容结论与截图**：卡片上写
   「未声明 pi 要求」，没有 star 就不排 star 行，截图区不放假图。
3. **Masonry 用 dshmarket 的原公式和交替分列。** `distributeColumns()` 按 0,3,6… / 1,4,7… / 2,5,8…
   分桶，保证排序仍是「从左到右、再下一行」；`ResizeObserver` 只在列数真的变了才重排，
   ≤680px 走单列，和 dshmarket 的 JS 断点一致。
4. **内层页签做成真的：发现 / 收藏 / 已安装 / 已屏蔽 / 高级。** 「已安装」不重复画一份列表，
   而是把外层「已安装」的清单直接嵌进插件市场；「收藏」「已屏蔽」写 `localStorage`
   （`pi.pluginMarket.favorites` / `pi.pluginMarket.blocked`），刷新和重启都还在；「高级」保留按来源
   安装、安装位置、刷新目录、导出日志。
5. **数据侧只补字段，不新增安装协议。** `StorePackage` 多带 `owner` / `repository` / `homepage` /
   `published` / `keywords`：npm search 本来就返回这些字段，桥端只是之前丢掉了。安装仍走
   `pkg.install`，和「扩展商店」时代完全同一条路。`ext.store` 的 `limit` 上限从 100 提到 250，
   这样分类、排序、最近收录在客户端有足够的样本；超出 250 的长尾仍靠 npm 搜索。
6. **分类从作者标签推，不写死目录。** `categoriesOf()` 先用包的 `keywords`（`context`、`mcp`、
   `theme`、`workflow`…），没有标签再看名字 / 描述里的中英文关键词；只取第一个命中的标签，兜底「其他」。
   这样新包不用改代码就能进分类。

**代价 / 可改：**

- 没有 DSH 的 star、截图、评论、宿主兼容结论和「已屏蔽 11k」那套目录；「评论」直接开 npm 页面。
- 「最近收录」只在这 250 条里按 npm `date` 排；不是全量 npm 的最近发布。真要做全量，得再加一条
  按发布时间抓 npm 的后台索引，和 MCP 商店那套索引一样重。
- 分类是启发式，不是作者填的目录；同一插件可能进两个分类。好在只影响筛选，不影响安装。
- 颜色是暗色映射，不是 dshmarket 的浅色像素级配色。几何、字号、间距、圆角与 DOM 顺序是 1:1 的。
- 内层「已安装」不画卡片，点一下切外层；这是为了让「已安装」只有一处真源，避免两份列表状态不同步。

**验证：**

- `node web/tests/pluginmarket-unit.mjs`：6 条纯函数单测（`formatCount`、`categoriesOf`、排序、筛选、
  交替分列、列数公式）。
- `npm --prefix web run typecheck`：tsc + i18n-check（3105 键 × 3 语言）+ `test:viewport` 全绿。
- `npm --prefix bridge run typecheck`、`npm --prefix web run build` 绿。
- Playwright 冒烟（worktree 的桥 + 生产构建，1440×900 与 1920×1080·150% 字号）：三列 30 张卡片、
  搜索 `subagent` 回 `pi-subagents`、分类筛选、「收藏」计数与列表、`··· → 屏蔽` 后从发现页消失并在
  「已屏蔽」出现、内层「已安装」嵌入外层清单、高级页表单、视口底栏仍在屏内。

**后续（2026-11-15 用户看过测试环境后）：** 用户要求三件事：① 检索有 bug；② 内层「已安装」不要跳回左侧外层，把左侧清单嵌进插件市场；③ 主题页不需要，删掉。检索有两层根因：输入只存在 DOM、防抖期间点分类/排序会用旧的 `query` 重画；以及客户端按月下载量重排把精确匹配压到后面。现在输入立刻写进 `extStore.query`，请求仍防抖 300ms；`rankSearchResults()` 把精确包名（含 scoped 尾名）排第一，再前缀，再按所选排序；桥端在切 250 条前也先保留精确匹配。内层「已安装」改为调用 `paintExtInstalled()` 把清单直接挂进市场页。主题页、主题卡与对应 CSS / 文案全部删除。

**再后续（同日晚些）：** 外层的「已安装」页签删除，「插件市场 / MCP 市场 / 局域网市场」三颗；「MCP 商店」改名「MCP 市场」并按同一套 `.mk-*` 卡片 / 瀑布流重画（搜索、npm / PyPI / Docker / 远程分类、star / 名称排序、安装表单在卡片上方展开）。
## D271 Context 面板按 dsh-context 复刻：七类组成、逐请求快照、趋势与上下文浏览器（用户要求「用 rea 逆向本机的 dsh-context」）

**修订（2026-11-15）：** 本条「只留预览、不镜像 transcript」的约束由 D278 取代；v3 的 `body` 行让浏览器能展开真实正文，并补上跨会话「上下文洞察」页与技能加载计数。

**问题：** 原来的 #384 面板只有 KPI + 六类估算 + 一张轮次柱状图；`context-log.ts` 只统计 `text` 块，assistant 的 thinking / toolCall 全记成 0，system 的 `sections` 也没拆，导致面板上看不到系统提示、工具定义、技能注入和助手回复。用户说「现在做的很垃圾」，要求照本机 `dsh-context@0.84.1` 重做。

**做法：**

- 用 REA 的 `analyze-javascript-application` 分析 `~/.dsh/profiles/desktop/node_modules/dsh-context`（REA Evidence：`ev_d91ebab2bc6bb023a4fab24b88c998c03fd337b22b267c4f4c1fff6f16ce9763`（summary `ev_743a245f1e3871866b4ace0506c5b7e7f1d61917cac8b7373d453f1eaef1c170`）），并从 DSH 临时实例的 Context tab、`/context` 弹窗截图核对布局；只复刻 **Context 面板**（stat / token / timing / current / trend / browser / events / files / commands），不搬 Fleet / 跨会话 Insights / 插件偏好页。
- `bridge/ext/context-log.ts` 升到 v2：系统 `sections` 拆成 sys / inject / skill；assistant 的 thinking、toolCall 参数、text 分别计入 asst；每条请求写 `items`（最多 400 条，160 字预览）、`header.system` / `header.tools`、`turn/step`；`message_end` 写 `usage` 行；`tool_execution_end` 为所有工具记 `tool` activity，注入变化记 `inject` event。命令仍只留程序名，文件只留路径与行数，正文/输出不落盘。
- 前端把纯函数集中到 `web/src/context.ts`：七类组成、billed 八类、usage 合并、Timing、step/turn 粒度、browser delta；渲染拆到新 `web/src/context-panel.ts` + `context-panel.css`，`app.ts` 只负责开/关 sheet 和传数据。
- 兼容旧 ctxlog：没有 `kind` 的行仍按 request 处理，缺少 `skill` / items 时用 `perMessage` 兜底，不会把旧会话画崩。
- `subscribe` 时补一次 `emitContextLog(true)`：ctxlog 是 per-session 文件，之前新开页面拿不到已落盘的组成行。

**代价：**

- `context-log.ts` 的 request 行会变大（每条请求最多 400 条预览 + 80 个工具定义）；换来浏览器能按请求看条目。预览不是完整正文，点开完整内容仍需后续接会话日志。
- 组成仍是本地 CJK/ASCII 估算，provider 真值只在 usage / stats 里并列显示，不混算。
- 只做了 dsh-context 的 Context 面；Fleet 的多 Agent 时间线、跨会话 Insights、DNA 模式、插件设置页未复刻。

**验证：**

- `node --experimental-transform-types --test bridge/tests/context-log-unit.mjs`（8/8）与 `web/tests/context-unit.mjs`（15/15）覆盖 v2 行、usage、items、turn/step、七类、billed、timing、trend、browser、旧日志兜底。
- `npm run typecheck` 通过（i18n 3175 键 × 3、viewport 守卫）。
- 临时 bridge + 合成 ctxlog 的 Playwright 截图核对：1360px sheet、1600/1000px 视口、展开手风琴、增量、轮次、文件筛选均正常。

## D272 热部署 fetch 的代理按环境候选，不写死一个端口（用户报障 2026-11-15）

**问题：** 热部署第一次拉取分支时，worker 先用进程环境里的代理，失败后回退到写死的 `127.0.0.1:18791`。这台机器上 bridge 启动时的 `HTTPS_PROXY` 指向已经停掉的 `127.0.0.1:2078`，而当前代理是 `127.0.0.1:7899`；于是直连和回退都失败，热部署卡在「检查更新」，7864 仍跑旧构建。代理是环境事实，不该在代码里只认某台机器的端口。

**为什么：** 代理端口是机器的环境事实，不是产品常量；把它写死在 worker 里，换机器或代理进程换端口就会让整次部署失败。候选链把「用户显式指定」放最前，其次跟随当前进程环境，最后才保留历史默认；同时必须先做一次不继承旧代理的真直连，否则 `HTTPS_PROXY` 会让所谓「直连」继续撞旧端口。

**取代：** D254 / D255 建立的热部署 worker 里，`fetchOrigin()` 只认 `127.0.0.1:18791` 的旧实现细节；D254 / D255 的分支切换、进程替换等其余约定不变。

**决定：**

- `scripts/hotdeploy-git.mjs` 的 `proxyCandidates(env)` 按顺序收集、正规化并去重：`BILLION_CONTEXT_PROXY` → `HTTPS_PROXY` / `https_proxy` → `HTTP_PROXY` / `http_proxy` → `ALL_PROXY` / `all_proxy` → `http://127.0.0.1:18791`（最后兜底）。正规化包括补 `http://`、统一小写、去掉末尾斜杠。
- `scripts/hotdeploy.mjs` 的 `fetchOrigin()` 先用清空代理环境变量的子进程做真直连（并用 `-c http.proxy=` / `-c https.proxy=` 清掉 git 配置）；失败后逐个代理重试，使用通用 `http.proxy` / `https.proxy`，不绑定 GitHub host；全部失败时，`state.json` / `last-run.json` 保留直连和每个代理的实际失败原因，不再只报最后一次，并在末尾提示重启 bridge。
- 不在代码里自动探测/启动代理，也不改 bridge 的环境变量；bridge 进程启动时继承的旧代理，需要重启 bridge 才能更新，这一点在错误文案外由用户/运维处理。

**代价 / 可改：**

- 代理候选多时，全失败会多花几次 git 超时；但成功路径不受影响。要更快可以给每个候选加独立超时（**D374 起已给每次尝试加上限**）。
- `http.proxy` 只对 HTTP(S) 远程生效；`origin` 是 SSH 地址时，候选代理不会生效。
- `ALL_PROXY` 若是 socks 代理，是否可用取决于本机 git/curl；失败会出现在错误列表里，不会静默跳过。
- AGENTS.md / issue-tracker 里「直连失败才加 `HTTPS_PROXY=18791`」是 `gh` CLI 的手工代理约定，不适用于热部署 worker；worker 的规则以本条为准。

**验证：** `bridge/tests/hotdeploy-unit.mjs` 新增 `proxyCandidates()` 单测（显式代理优先、去空白、URL 正规化后去重、默认兜底、`ALL_PROXY` 顺序）；`npm run test:hotdeploy` 通过。真实代理切换仍建议重启 bridge 后点一次热部署验证。

## D273 邮箱正文按 HTML 渲染：内嵌图直接显示、远程图默认拦下、AI 能单独看内嵌图（用户报障 2026-11-15）

**问题：** 面板只把 `MailDetail.text` 放进 `<pre>`，完全不看 `html`。纯 HTML 的信（本机真信箱里两封：Sony 营销 120,005 字符、92 张远程图；Jenil 求职信 11 张 `cid:` 内嵌图 + 1 个 PDF）在面板里只剩「（没有纯文本正文）」或一段被剥光的文字，图片内容读不到；`mail_read` 的 `htmlToText()` 又把 `<img>` 静默删掉，模型连「这里有图」都不知道。更糟的是工具口返回带 data URI 的 HTML，20,000 字截断会先被图片 base64 吃掉，正文反而没了。

**逆向来源（可复核）：**

- 本机 `/Applications/MailMaster.app` 4.17.24（`com.netease.macmail`）的正文页在 `Contents/Resources/webui/js/viewer/viewer.js`：`resetInlineAttachment` 把 `img[src^="cid:"]` 按 `Content-ID` 换成内嵌附件 URL；未下载完的图先用 `mailmaster://static.dashi.163.com/style/img/loading.gif` 占位并缩到 16×16；`readMailImgAdapt.js` 再按容器宽度适配图片。
- 原生侧同一套路的符号（`strings -a Contents/MacOS/MailMaster`）：`MailMasterURLSchemeHandler`、`WKURLSchemeHandler`、`inlineAttachmentWithAccountId:contentId:url:filename:`、`mailmaster://static.dashi.163.com/mailpart/`。即 MailMaster 用自定义 scheme 提供内嵌图，而不是把 base64 塞回正文。
- REA 6.9.0：`rea analyze-javascript-application /Applications/MailMaster.app/Contents/Resources/webui --source-path js/viewer/viewer.js --source-path js/viewer/readMailImgAdapt.js --source-path js/viewer/viewTmpl.js --source-path js/common.js --detail summary --evidence_output /tmp/rea-mailmaster/webui.evidence.json`，得到 183 条 finding、88 MB Evidence；确认了 cid→附件的映射、`loading.gif` 占位与图片适配三条行为。REA 的 native provider（Ghidra/Hopper/IDA/Kuna）在本机不可用，原生符号靠 `strings` 补。

**决定：**

1. **正文 HTML 进 sandbox iframe，不直接 `innerHTML`。** `web/src/mailhtml.ts` 先做白名单清理（去 script/iframe/form/svg/object/embed/meta/base、`on*`、`srcset`、`javascript:`，CSS 去 `@import` / `expression` / 远程 `url()`），再套 `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`（不给 `allow-scripts`）+ CSP `default-src 'none'`。邮件自带的 `<head><style>` 保留，否则营销邮件整页布局会散。
2. **内嵌图分两条路：** 面板口 `readMessage()` 用 mailparser 默认行为，把 `cid:` 换成 `data:image/...`——一次 IMAP FETCH 就够，不用为 11 张图各拉一遍整封信；工具口 `mail_read` 用 `keepCidLinks: true`，正文保持 20k 级、附件清单带 `contentId` / `inline`，图片另走 `mail_image`；截断前先去掉 head/style，别让营销邮件前 20k 的 CSS 把正文切没。cid 对不上时（服务器写法怪）前端再退回 `/api/mail/attachment?...&inline=1`；CSS 里的 `url(cid:)` 也走同一张映射表。
3. **远程图片默认不加载，且不占正文高度。** 先把 `src` 换成 1×1 透明 GIF、原地址记 `data-mc-remote-src`，同时 CSP 的 `img-src` 只给 `data: blob: 'self'`（`'self'` 留给 cid 兜底的附件直链）；用户点「显示图片（N）」才重画并放行 `https: http:`。按钮的 N 只数远程 `<img>`（`remoteImages`），CSS 背景图另算 `remoteCss`；只有 `srcset` 没有 `src` 的图先取第一个候选补成 `src`。图片关掉时 `display:none`，否则 92 张 600×300 的占位会把正文撑到近万像素、看着像空白。
4. **附件区不再列内嵌图。** `MailAttachmentInfo` 加 `contentId` / `inline`；列表 📎（`countParts`）只认 `Content-Disposition: attachment`，内嵌图属于正文。PDF 等真附件照旧在附件区下载。
5. **AI 侧补 `mail_image`。** `mail_read` 把内嵌图列成 `#index / 文件名 / 大小 / cid`，提示用 `mail_image`；`mail_image` 返回 `ImageContent`（png/jpeg/gif/webp，单张 ≤3MB），让视觉模型真的看到图。`htmlToText()` 把 `<img>` 保留成 `[图片：alt]`，不再让图片静默消失。

**代价 / 可改：**

- 面板口 HTML 带 data URI，25MB 的原始邮件最坏膨胀到 ~33MB JSON；仍受 `MAX_RAW_BYTES` 25MB 闸门。真遇到大图邮件，后续可改成 `/api/mail/attachment?inline=1` + 服务端短期缓存。
- 远程图片开关是**每封信**的，不持久化；换一封信回到默认拦截。和邮件客户端「本次显示」一个口径。
- 清理是白名单近似，不是 MailMaster 的完整 WebKit 排版；复杂 CSS（`mso-`、浮动）会有差异。`mail_image` 只支持四种位图格式，超过 3MB 让用户走 `mail_attachment`。
- `mail_image` 每看一张图会重新拉整封原始邮件（低频，先不缓存）；要连看多张时可再合并成一次取多张。

**验证：**

- `npm run test:mail`：`bridge/tests/mail-unit.mjs` 68/68、`mail-list-unit.mjs` 43/43（新增 cid 元数据、`keepCidLinks`、`htmlToText` 图片标记、无 disposition 的内嵌图、截断前去掉 head/style）、`web/tests/mail-unit.mjs` 15/15（新增 `cidKey`、`inlineImageMap`、`srcset` 首个候选、CSP 默认/放行远程图）。
- 真信箱（作者自测的一个信箱，地址已脱敏，见 D362）：uid=1328 面板渲染 11 张内嵌图（naturalWidth 800、iframe 高度 4,703px），附件区只列 `resume.pdf · 152 KB`；uid=1321 远程图 92 张，默认 `img[data-mc-blocked]` 全部收起、iframe 419px，点「显示图片（92）」后 92 张 `src` 全部恢复为原 `https://...`。
- `mail_image` 工具口实测 uid=1328 index=0：`image/jpeg`、61,660 字节、base64 82,216 字符；`mail_read` 回 12 个附件（11 inline + 1 PDF），HTML 保留 `cid:` 且截断在 20,029 字。
- `npm run test:mail:html`（真 Chromium）：script/iframe/on*/javascript: 清理、`cid:` 映射、`srcset`-only 图、远程图拦截与放行 CSP 全绿；`npm run test:permission` 也覆盖 `mail_image` 在只读模式放行、`mail_attachment` / `mail_send` 被拦。
- `npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（i18n 3180 键 × 3 + viewport）、`npm run build` 全绿。

## D274 附件弹层「从本设备选文件」：非图片上传到上传暂存区、路径进输入框（#455，用户要求 2026-11-15）

**问题：** 「文件」弹层右上角只有「从本设备选图片」，浏览器所在设备上的 PDF / Word / 压缩包送不进来。pi 的 prompt 只认图片（`{type:"image", data, mimeType}`），没有随消息上传任意文件的通道；能做的只有把原件落到 pi 所在机器，再把绝对路径插进输入框，让模型用工具去读。

**决定：**

1. **一颗按钮、原地改名「从本设备选文件」**，`accept` 不再限制；手机上同一个入口同时给相册、拍照、选取文件。图片仍走原来的内联压缩附加，行为不变 —— 只有非图片才上传。
2. **落点是桥状态目录下的「上传暂存区」** `uploads/<会话 id>/`，不叫收件箱（那是内网通 `~/.pi-peer/inbox`，D209 的可信根，两回事）。目录名只接受 `[A-Za-z0-9._-]+`；会话 id 必须能在 `sessions.locate()` 里解析（含休眠 / 归档，已删除的不行），绝不拿请求里的字符串直接拼路径。
3. **`POST /api/uploads?session=&name=` 收原始字节**（和 `/api/peer/upload` 同一条路，不把 64 MB 塞进 base64 的 WS 帧）；单文件 64 MB、一次 10 个非图片文件由前端先拦。文件名只取 basename、洗控制字符与 Windows 非法字符、剪尾点空格、120 字符截断保留扩展名、Windows 保留名加 `_`；重名在扩展名前加 `-2`、`-3`。
4. **原子落盘**：先写 `.upload-<uuid>.tmp`，再 `linkSync` 到最终名（不覆盖；不支持硬链接的盘退回 rename），最后删临时名。失败时不会留下半份看起来正常的文件；批量中途失败由前端调 `/api/uploads/remove` 回滚已落盘的几份。
5. **成功后插路径、关弹层**：走现有的 `insertPaths()`（光标处、前后补空格），草稿与其他附件不动。公网访问走 `act()` 的 step-up 门；按钮里显示「上传中 42%」，失败在右栏底部留 5 秒红字。
6. **清理**：桥启动时删 `uploads/` 下 30 天没动过的会话目录与根上的残留临时文件；只碰这个目录，删不掉不挡启动。D14 里「上传图片：……uploads 保留 7 天」是当时没落地的默认值，以本条 30 天为准。

**代价 / 可改：**

- 非图片不进模型上下文：模型要读得自己去开文件；图片仍受 2048 长边压缩，原件不保留。
- 上传是逐份串行的，10 个 64 MB 最坏要等一轮；换来的是进度准确、失败回滚简单。
- 30 天清理只在启动时跑一次；长期不重启的桥不会清，后续可加定时器。

**验证：**

- `npm run test:uploads`：`bridge/tests/uploads-unit.mjs` 12 项（basename / 非法字符 / 空名 / 保留名 / 中文 emoji / 0 字节 / 重名 -2 / 120 截断 / 64MB+1 拒收且不落半份 / 无残留临时文件 / 回滚越界拒绝 / 30 天清理）。
- `npm run test:attach:ui`：新增三段 —— 真上传 `from-device.txt` 并核对内容、同名第二份落成 `from-device-2.txt` 且第一份没被覆盖、11 个文件被「一次最多 10 个文件」拦下；同时把这份 D163/D167 探针的选择器从旧的 `.sheet.file-picker` / `.model-row` 更新到现在的控制台 DOM（`.fc-back` / `.dir-row`），否则它在 D252 之后根本跑不起来。
- `npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（i18n 3186 键 × 3 + viewport）、`npm run build` 全绿。

## D275 产物列表也收「交付」：open_preview 打开过的文件算本会话产物（用户报障 2026-11-15）

**问题：** 一次会话里生成了 `Excel全能教学练习簿.xlsx`，回复里写着「已生成并在预览中打开」，但「📂 产物」弹窗里只有 `excel_build.py`。根因是列表只收 write 系工具（D208 第 5 条）：xlsx 是 `bash` 跑 python 脚本生成的，脚本产出的文件永远不会经过 write 钩子。而 `open_preview` 是网页会话的交付出口（D190 / D226），路径就在工具参数里，却没进列表 —— 用户看到「已打开」却找不到。

**决定：**

1. **产物来源加第二条：`open_preview` 记「交付过」。** `web/src/artifact-sources.ts` 里 `WRITE_TOOLS` / `DELIVER_TOOLS` 两个集合，页面重放历史时都收。**写入优先**：同一路径先开后写就升级成写入那条，先写后开保留写入那条 —— 只有写入那条才有「写入前的原文」。
2. **交付记录只进产物列表，不进这一轮的产物芯片。** 芯片答的是「这轮写了什么」，打开一个文件不算写。
3. **桥端新增 `why: "delivered-only"`。** 交付来的行没有写入前基线时，说明是「脚本 / 程序生成」，不再套用「桥没在运行或扩展被关了」——那句话对脚本产物是错的。
4. **只认 `open_preview`，不解析 `bash` 输出里的路径。** 按文本猜路径（`saved /…`）太脆，宁可少一条也不猜。

**为什么：** 「产物」这个列表答的应该是「这个会话产出了 / 交付了什么」，而不是「哪个工具碰过盘」。write 钩子只能看到 write 系工具，脚本、构建、下载都绕开它；预览是这些文件唯一确定经过的一站，而交付提示词又只让模型走预览。

**代价 / 可改：** 打开一个旧文件（比如让模型看一眼 README）也会出现在列表里，状态是「未知」。可以接受：open_preview 在交付提示词里只用于交付。若以后嫌吵，可以加「只收 mtime 晚于会话开始」的过滤，但那要会话起始时间，先不做。

**修订：** D208 第 5 条「只认 write 系工具」扩成「write 系 + `open_preview`」；D208 的写入前快照、五档状态、diff 弹窗都不变。

**验证：** `web/tests/artifact-sources-unit.mjs`（7 条：两种来源、先后顺序、去重、无关工具、toolPath）接进 `npm run test:artifacts`；`bridge/tests/artifacts-unit.mjs` 新增一条「交付文件 → delivered-only」；`probes/artifacts-delivered.mjs` 用真桥 + 真 Chromium 复现用户那次的形状（xlsx 在列表里、`open_preview×1`、说明是脚本产物、py 仍是 `write×1`）；`npm run typecheck` / `npm run build` 通过。

## D276 字号默认值从 100% 调到 125%（用户要求 2026-11-15）

**决定：** `DEFAULT_PREFS.scale` 改为 `1.25`：新设备、清过 `localStorage` 的浏览器第一次打开就是 125%（登录页在 `App` 之前渲染，也先套用已存/默认字号），设置抽屉的「恢复默认」和双击字号轨道都回到 125%。已经存过 `pi.prefs.scale` 的浏览器保留原值，不迁移 —— 分不清「从来没动过」和「明确选了 100%」。设置里字号的读数高亮改成跟 `DEFAULT_PREFS.scale` 比较，否则默认状态会被标成「用户改过」。

**为什么：** 用户要求默认大一号。125% 在常见的 1280 / 1440 桌面窗口下有效宽度仍是 1024 / 1152，高于 900 的窄版阈值，不会一上来就退成单栏。

**代价：** 视口窄于 1125px 时有效宽度不足 900，1024 宽的小屏新设备会直接进入单栏；这是默认放大字号的直接结果，不为它做特殊回退。

**验证：** `npm run typecheck`、`npm run build`、`node bridge/tests/scratch-ui.mjs` 全绿（用例新增登录页与 App 的默认 125% 断言）；本地起桥实测全新 profile 的 `--ui-scale` 与 `#app zoom` 都是 1.25，1440 窗口仍是三栏。

## D277 设置抽屉的工具区去掉「快捷键」入口（用户要求 2026-11-15）

**问题：** 「连接与设置」→「工具」里那颗「快捷键 / 设置快捷键」按钮，只是把同一张快捷键面板又开一遍；设置抽屉应放设置，不该再维护第二份动作入口。用户要求删掉它。

**决定：** 只删设置抽屉里的这颗按钮，工具区保留 `pi 设置` / `本机管理` / `热部署`；快捷键面板、键位捕获和 `/hotkeys` 命令都保留。en / ja 的页签与齿轮提示从「Channels & hotkeys / 接続とショートカット」改成「Channels & tools / 接続とツール」。`probes/round6-keys.mjs` 改为从输入框走 `/hotkeys` 打开面板，不再找已删除的按钮。

**为什么：** 删的是重复入口，不是功能；已经绑过的键位和动作表不受影响。

**代价 / 可改：** 快捷键面板不再有可见的设置入口，只能记 `/hotkeys` 或继续用已绑定的键。若以后又需要一个可见入口，应把它放回动作表或命令面板，而不是设置抽屉。

**验证：** `npm --prefix web run typecheck`（i18n 3194 键 × 3）、`npm run build:web`、`node probes/round6-keys.mjs` 全绿。

## D278 上下文洞察页 + 技能加载计数修复 + Context Browser 正文落盘（用户要求，2026-11-15）

**问题：** ① 会话内 Context 面板只能看当前会话；设置 → 工具里没有跨会话入口。② 用户用了 `/skill:`，Token 统计里技能注入有占比，但「上下文统计 → 技能加载」一直是 0。③ Context Browser 只有 160 字预览，原版 dsh-context 可以展开系统提示词、工具 JSON schema、消息正文、思考、工具参数和工具结果；用户说「表现和原版差别很大」。

**REA 逆向：** 用 `rea analyze-javascript-application ~/.dsh/profiles/desktop/node_modules/dsh-context --source-path lib/client.js --source-path lib/index.js --detail summary` 复核本轮 0.84.1；Evidence `ev_2c02d565005601ee745b41c4d1e880a3f1ccd5e99df0a66de31c00b4c0111195`（summary `ev_743a245f1e3871866b4ace0506c5b7e7f1d61917cac8b7373d453f1eaef1c170` 为 D271 那轮）。原版 Insights 的区块是 KPI / 近 7 天用量 / 活跃度热力图 / 技能加载 / 工具调用 / 命令执行 / Context Composition / 按项目分组的会话卡片；Context Stats 的 `skills` 是**去重技能名数量**（`totals.skills` / inject `sub:"skill"`），不是「每次请求都重数一遍」。

**决定：**

1. **设置 → 工具 → 热部署右侧新增「上下文洞察」**，打开 1320px 的 sheet；数据走新 `GET /api/context/insights`。桥端 `collectContextInsight()` 扫所有会话的 ctxlog，只回会话级聚合（Token / 费用 / bill 八类 / 每日 / 技能 / 工具 / 命令 / 文件），按文件 mtime+size 缓存；不把逐请求正文搬出桥。
2. **页面分「全体 / 分项目」**：顶部范围（今天 / 近 7 天 / 近 30 天 / 全部）与项目 chip；KPI、近 7 天用量、8 周活跃度、技能 / 工具 / 命令账本、Context Composition、分项目表、会话卡片。项目按桥的 workspace 组（`ws`）分组，没进组的按 cwd 的 basename 分。点会话卡片关 sheet 并切到该会话。
3. **skills 计数改为去重技能名**：`bridge/ext/context-log.ts` 把 `/skill:` 展开的 `<skill name="…">…</skill>` 从 user 正文里拆出来，计入 `cats.skill`，请求行写 `skills: ["name"]`，并且每条技能消息只写一次 `event: inject, label: skill:<name>`；`ctxSummary` 取「请求行 skills ∪ skill 事件 ∪ skill 工具活动 ∪ 旧日志 user preview 里的 `<skill name>`」去重，修掉「技能注入有占比但技能加载 0」。
4. **Context Browser 正文**：ctxlog 升 v3，新增 `kind:"body"` 行，按 item id + 内容 digest 只写变化（单条上限 64 KB）。系统提示词段、工具 schema、user / assistant / thinking / toolCall 参数 / toolResult 正文、skill 正文都落到 body；`ctxBodyMap()` 在 `ctxBrowserView` 里按 id 合并。前端条目可展开：工具结果显示参数、OK / error、命令 / exit code / 路径与结果正文；助手条目按思考 / 工具 / 回答筛选；工具定义按大小 / 名称排序；旧日志没有 body 时明确写「旧版日志只保留了预览」。
5. **隐私口径修订：** D271 写的「previews only，不镜像 transcript」由本条取代。body 只写本机桥状态目录，内容和 pi 自己的会话 JSONL 同源；activity 行仍然只留程序名 / 路径 / 行数，不写命令行正文和工具输出到 activity。

**代价 / 可改：**

- 首次打开洞察页要扫一遍 ctxlog（本机 126 MB / 29 个会话实测约 0.6 秒），之后按 mtime/size 缓存；文件多到几 GB 时可改增量索引。
- 费用依赖 `usage.cost.total`，旧日志没有这一项只能显示「–」；新会话从下一条 `message_end` 起有值。
- body 只覆盖升级后的新请求；旧日志无法凭空恢复正文，界面明确标注，不伪造。
- 未复刻原版的 Fleet / DNA 模式 / 附件卡片 / 自定义日期范围；Insights 的「全部」范围只保留最近 80 天按日，早期只在会话总计里。

**验证：**

- `npm run test:context`：`context-log-unit`（v3 body、skill 拆分、usage cost、活动行仍脱敏）、`context-insight-unit`（聚合 / 费用 / 技能去重 / 旧日志 preview 兜底）、`context-unit`（`ctxSummary` 技能三种来源、`ctxBodyMap` 合并）、`chrome-unit` 全绿。
- `npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（i18n 3246 键 × 3 + viewport）、`npm run build` 全绿。
- 真桥 7871 + 真 Chromium：设置 → 连接与设置 → 工具里按钮顺序为「pi 设置 / 本机管理 / 热部署 / 上下文洞察」，点开 KPI / 近 7 天 / 活跃度 / 三个账本 / Context Composition / 分项目 / 会话卡片都出来；点项目 chip 过滤 KPI，点会话卡片回到该会话。

## D279 「交给 AI 操作」的分支选择器与「对照分支」共用一套可输入控件（用户要求 2026-11-15）

**问题：** 「分支操作工作台 → 交给 AI 操作」的「① 选一条分支」还是原生 `<select>`，只能在下拉里已经列出的几条分支中挑；同一张卡上方的「对照分支」早就是「输入即检索 + 点候选 + 直接回车用任意 ref」。用户要求把 AI 卡这一处也做成一样的。

**决定：**

1. **抽 `branchPicker()` 一处实现，两处共用。** 输入框、▾、候选菜单、检索、`全部 N 个分支` 折叠、「用输入的…」按钮都走同一份代码；`paintCmp()` 和 `openAi()` 不再各写一套。
2. **AI 卡不提供「自动 · 跟随 origin/HEAD」。** 那是给对照分支表示「不指定 base」的空 ref；AI 卡必须选定一条分支才有意义，所以菜单里只有本地 / 远程 / 历史分支。
3. **打开卡不自动弹菜单。** `openCard()` 会把焦点给第一个输入框；选择器默认聚焦即展开，这里传 `openOnFocus: false`，只有开始输入、点输入框或点 ▾ 才展开，免得菜单一开卡就盖住下面的要求框。
4. **手输不校验。** 和大分支输入框一致，任意文本都原样接受并直接进提示词；不认识的 ref 由 agent 自己判断。
5. **点候选立即收起并回填**，预览同步重算；底部按钮在 AI 卡里写「用输入的分支：{p1}」，不沿用「对照」的说法。

**为什么：** 两处要的行为本来就一样，复制第二份只会让检索、折叠、键盘行为慢慢分叉。复用后「能输入」不是新增的另一套交互，而是同一套控件换个位置。

**代价 / 可改：** 对照分支的菜单原来点到外面不会收，现在两处都用 document 的 pointerdown 收起（顺带修了对照那一处）；`paintCmpMenu()` 的类字段 `cmpAllOpen` / `cmpFoldKey` 移进了 picker 闭包，每个选择器各记各的折叠状态。

**验证：** `bridge/tests/git-history-ui.mjs` 的 AI 段改成：无 `select.go-select`、默认当前分支、开卡不弹菜单、菜单无「自动」项、候选回填与预览联动、手输 `HEAD~1`、回车收起；`npm run typecheck`、`npm run build`、`npm run test:githist`、`npm run test:githist:ui` 全绿。
## D280 邮箱工具默认不挂，用户提到邮件才挂上（用户报障 2026-11-16）

**问题：** 用户在一个 11-13 建的老会话（`C:\api`，模型 `github-copilot/claude-opus-5.5`）里 11-16 续聊，第一句就 400：`messages.123: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position`。翻会话文件：报错前一条是 pi 补的 system 消息，`toolsAdded` 正好是 8 个 `mail_*` —— 11-15 合进来的邮箱扩展（`bridge/ext/mail.ts`）对每个网页会话**无条件** `registerTool`，老会话一续聊工具清单就变了。11-11 另一个会话的同款 400（`messages.273`）是中途多了 `todo` 引起的，所以根子不在邮箱。

根子在 pi-ai 1.5.0 的 `anthropic-messages.js`：中途的 system 更新被 `convertMessages` 压到下一条 assistant 前或数组末尾；能中途调思考强度的模型（`supportsMidConvoEffort`）又被 `insertThinkingLevelMessages` 在**末尾**追加一条 `{role:"system", content:[], output_config:{effort}}`，于是「system(更新)」后面跟的是另一条 system，既不是 assistant 也不在末尾。先切过模型再变工具的几次没报错，原因未核实。上游 bug 本轮不修。

用户的原话是这和他的设计相违：邮箱工具应该**默认不挂、按需加载**。

**决定：**

1. **8 个 `mail_*` 一律 `defaultActive: false` 注册。** 没提邮件的会话一个都不带，系统提示与工具清单里都没有它们。
2. **触发：用户这一句提到邮件。** `input` 钩子看用户原话（`/skill:` 展开前），命中 `邮件|邮箱|收件箱|发件箱|草稿箱|e-?mail|\bmail|inbox|メール` 就 `setActiveTools(现有 + mail_*)`，本轮请求就带上。`source === "extension"`（后台通知等扩展发的消息）不算。宁可漏判：「发信息」「gmailer」不命中；漏了用户再说一句「看邮件」就行。
3. **挂上不卸。** 卸了再挂又是一次中途改清单；pi 把清单记在会话里，续聊（`--session`）自己恢复，不会再补 system 消息。已经带着 `mail_*` 的老会话保持原样。
4. 没选「模型用 `tool_search` 自己找」：要多一个常驻工具，老会话第一次加它同样是一次中途改清单；也没选「点按钮才开」：要加 UI，多一步。

**代价 / 可改：**

- 没提关键词时模型想不到去用邮箱（比如「把刚才的报告发给张三」）。要补就往正则里加词，别改成常驻。
- 挂上那一刻本身仍是一次中途改工具清单：pi-ai 那个 bug 不修，用 opus-5.5 这类模型在**老会话中途**第一次提邮件还可能 400；新会话第一句就提邮件不受影响（初始清单在首条 system 消息里，不算中途改动）。只是把触发面从「每个老会话」缩到「真要用邮箱的那一下」。

**验证：**

- `bridge/tests/mail-list-unit.mjs` 新增 7 条（关键词命中/不命中、注册成不激活、无关的话不动清单、扩展消息不算、命中后 8 个挂上且原有不丢、已挂上不重复改）：`npm run test:mail` 67 + 50 全绿；`npm --prefix bridge run typecheck`、`npm run test:permission` 全绿。
- 真 pi（`pi -p -e bridge/ext/mail.ts`，deepseek-flash）三步：第一句「只回复 OK」→ 首条 system 的 36 个工具里没有 `mail_*`；续聊「我有几封邮件？」→ stderr `[mail] tools on: …`，会话里多一条 `toolsAdded` 正好 8 个 `mail_*`；再续聊无关的话 → 没有新 system 消息。

## D281 技能面板每行加「使用」「查看」，查看按名字交给桥解析（用户要求 2026-11-16）

**问题：** 对话输入框下面那颗「技能」按钮打开的面板只是一个选择器：点一下把 `/skill:<名字>` 插进输入框，想看某个技能到底写了什么，只能去技能商店的「已安装」里翻目录。对话流里的技能卡（D199）早就带一个「SKILL.md」出口，两个地方的行为不该不一样。

**决定：**

1. **每行右端两枚按钮：「使用」「查看」，一直是文字，不做图标。** 整行点击、数字键 `1-9`、`↑↓` 加 `Enter` 仍是老行为（插入 `/skill:<名字> `）。两枚按钮各自 `stopPropagation`，不触发整行。
2. **行本身从 `<button>` 换成容器**（`div.skill-row` + `tabindex=0`）：按钮不能嵌按钮。Tab 到行本身时 `Enter` / 空格仍等于「使用」，键盘可达性与原来一致。`查看` 没有键盘快捷键 —— 面板的按键面已经够满了。
3. **「查看」把名字交给桥，路径不下发。** 页面发 `skill:<名字>`，桥在 `openPreview()` 里按 `scanSkillEntries()` 的顺序解析成那份 `SKILL.md`（项目先于用户，同名取先找到的，和 pi 的遮蔽规则一致）。名字是逐一比对盘上的扫描结果，不拼路径。文件不在盘上（扩展自己带进来的技能）时：桥报「这个技能的 SKILL.md 不在盘上」，页面把按钮置灰并在行里写明原因。
4. **`SkillInfo` 加 `viewable`**，由桥在有 pi 回答时用盘上扫描的结果标注（`skills()` 里 `onDisk.has(name)`）；磁盘兜底那一份天然全是 `true`。
5. **技能商店「已安装」行也加「查看」**，但用它自己那份绝对路径（`entry.path + "/SKILL.md"`），不走 `skill:`。两个来源故意不同：面板只有名字，商店手里有确切目录；同名遮蔽时按名字解析会开到别人那份。
6. **`skill:` 只在 `/api/preview` 上认**，由专门的 `openSkillPreview()` 接手（它把名字换成文件后照旧调 `openPreview()`）。`openPreview()` 与 `resolvePreviewPath()` 都不认这个前缀：前者还被 `open_preview` 工具口调用，那个口子先自己 `resolvePreviewPath()` 再做 D190 的信任检查，要是 `openPreview` 认了 `skill:`，就等于拿一个自己没检查过的文件（用户技能目录，在会话目录外）绕过了那道检查。`, `/api/dirs`、`/api/image` 也就不会多出「前缀」这层含义。
7. **公网不递技能目录**：`publicReq` 下这一条 `skill:` 预览把 `abs` 与 `root` 一起抹掉（和 binary/pdf 同一条口径）。页面 `v.path = v.info.abs || path` 正好留着 `skill:<名字>`，刷新时还能重解析。
8. **看不算用**：`uses` 只在 `sendPrompt()` 里数，点「查看」不动计数，也不影响面板排序。

**为什么：**

- 名字解析留在桥里，公网页面上就没有技能目录可读；顺带把「同名取哪份」的规则收到一处，和 pi 自己的目录顺序对齐 —— 页面自己拼路径早晚会和 pi 分叉。
- 商店行用自带路径不只为省事：它列的是「盘上有哪几份」，遮蔽掉的那份也要能打开，按名字解析正好做不到。

**代价 / 可改：**

- 面板里点「查看」时页面不知道目标是什么，viewer 标题要等桥回来才变成 `SKILL.md`；公网下 `abs` 为空，`v.path` 保留 `skill:<名字>` 而不是绝对路径（本来也不该给）。
- 磁盘兜底那份清单不区分来源，`viewable` 一律 `true`；真要看技能商店里的完整来源信息还是去商店。
- 以后若给「查看」加键盘入口，得先定它和 `Enter`（使用）谁优先。

**验证：** `bridge/tests/skill-view-ui.mjs`（真桥 + Chromium，`locale: zh-CN`，`npm run test:skill:ui`）走完 6 段：每行两枚按钮且文字是「使用」「查看」；点「使用」插 `/skill:<名字>` 且面板关；点「查看」在 viewer 里渲染出 `SKILL.md` 正文、面板关、`skill-usage.json` 里没有这次计数；`fake-pi` 多报的 `phantom-skill` 查看置灰、行内有说明、使用照常；商店「已安装」里同名技能打开的是项目里那份（正文含「项目版本-PROJECT」、不含「用户版本-USER」）；F 段打 `/api/preview`：本机拿得到 `abs`、挂上 `cf-connecting-ip` 装成公网后 `abs`/`root` 都是空的、盘上没有的名字报「不在盘上」。回归：`npm run typecheck`（含 i18n 3251 键 ×3、viewport 守卫）、`npm run build`、`npm run test:skill`（14 条）、`npm run test:skillblock`（15 条）、`bridge/tests/preview-tool.mjs`（33 条，`PREVIEW_PORT=7802 PI_PEER=0`）、`bridge/tests/open-preview-unit.mjs`（23 条）全绿。`npm test`（`bridge/tests/e2e.mjs`）没跑：它要 7867 上活着的真桥 + 真 pi，且全文不含 skills/preview，与本改动无关。

**复审修正（同样这次提交）：** 第一版把 `skill:` 解析写进了 `openPreview()`，被两个轴同时抓到：`open_preview` 工具口会先 `resolvePreviewPath(\`skill:x\`)` 当成「会话目录下的相对路径」通过 D190 检查，再进 `openPreview()` 才换成目录外的真文件 —— 信任检查白做；公网预览 md 时 `abs` 也没被抹（那条规则当时只覆盖 binary/pdf）。改法即上面第 6、7 条。

## D282 邮箱加 Outlook / Microsoft 365：走 OAuth（设备码），不再指望授权码（用户要求 2026-11-16）

**问题：** 用户要在邮箱面板里加一个公司/学校的 Microsoft 365 信箱。面板原本只支持「用户名 + 授权码」的 IMAP/SMTP 基础认证，而微软已经关掉了它：Exchange Online 2022-10 起（`Deprecation of Basic authentication in Exchange Online`），Outlook 个人账号（outlook.com / hotmail / live）2024-09-16 起，**连应用密码也不行**。所以旧的 `outlook` 预设必然回 `auth-failed`。

**决定：**

1. **给账号加第二种认证：`auth: "password" | "oauth"`。** 其余十几个预设一律还是授权码，行为不变；`outlook` 与新增的 `m365` 预设只能 OAuth（`PRESETS[x].auth = ["oauth"]`，`presetAuthMethods()` 是唯一判据，`custom` 只有授权码）。`m365` 不猜域名（公司地址各种后缀），IMAP `outlook.office365.com:993`、SMTP `smtp.office365.com:587`（`secure: false`，STARTTLS）。
2. **用设备码（device authorization grant），不用浏览器回调。** 回调要求先在 Entra 应用里登记重定向 URI，桥的端口还会变；设备码一个重定向都不要，用户在面板里点「用 Microsoft 登录」→ 打开 `microsoft.com/devicelogin` 输码即可，且用的就是他被管理员管着的那套浏览器会话 —— 我们不碰他的 cookie。代价：页面上要显示码并轮询（`POST /api/mail/oauth/{start,poll,cancel,logout}`），轮询间隔不得低于微软给的 `interval`（下限 2 秒，`slow_down` 再 +5 秒）。
3. **令牌只存桥、只由设备码流程写。** `MailOAuth { clientId, tenant, refreshToken, accessToken, expiresAt, upn }` 存在邮箱配置文件里（与授权码同级），`publicAccount()` 只给 `hasToken / oauthUpn / oauthClientId / oauthTenant`，页面与 AI 都看不到令牌值。`saveOAuthTokens()` / `clearOAuthTokens()` 是仅有的两个写入口。
4. **应用由用户自己在 Entra 里注册（公共客户端，允许设备码流）。** 面板收「应用（客户端）ID」与「租户」，租户留空默认 `common`（多租户应用与个人账号都登得上；单租户应用填自己的租户 ID 或域名）。权限是三个委派作用域：`openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send` —— 不用 Microsoft Graph 的 Mail.Read/Mail.Send，因为桥是用 IMAP/SMTP 连的。
5. **换应用或换租户就作废旧令牌**（`normalizeAccount()` 比较 clientId/tenant），换授权码/服务器也一并清 `verifiedAt`。刷新时如果微软没回新的 refresh token，**沿用旧的**（轮换不总能拿到新的）。
6. **`expiresAt - 90s` 内就提前刷新**：一次读信可能几分钟，别拿一个马上过期的令牌去连。刷新失败按错误分类翻译：`invalid_grant` / `AADSTS70008|50173|50196|7000215` → `oauth-needed`（「在面板里重新登录」）；`invalid_client` / `AADSTS700016|900023|50059` → 指向「客户端 ID 或租户」；`AADSTS65001|90094` / consent → 指向「管理员同意」；`invalid_scope` / `AADSTS70011` → 指向「权限」。
7. **传输层不加新依赖**：IMAP 用 imapflow 原有的 `auth: { user, accessToken }`（XOAUTH2），SMTP 用 nodemailer 的 `auth: { type: "OAuth2", user, accessToken }`。

**为什么：**

- **为什么不干脆让用户填个「应用密码」：** 没有这条路了。微软对 Exchange Online（2022-10）和个人 Outlook（2024-09-16）都关掉了 IMAP/SMTP 基础认证，应用密码同样被拒 —— 原来那个 `outlook` 预设只能报 `auth-failed`，不是配置问题。
- **为什么是设备码而不是 OAuth 回调：** 回调要预先在 Entra 登记重定向 URI，桥的端口一换就得回去改应用；设备码一个 URI 都不要，用户在 `microsoft.com/devicelogin` 输一段码就行，用的还是他自己那套被 IT 管着的浏览器会话 —— 我们不碰他的密码与 cookie，也不用在他机器上装东西。
- **为什么令牌放桥、不放页面也不放浏览器：** 页面是网页客户端，令牌落在 `localStorage` 就等于任何同源脚本都能拿走；放桥里则与授权码同级（本机配置文件、0600），页面与 AI 工具都只看得到「登录过没有、是谁」。
- **为什么不自带一个仓库级 client ID：** 那等于让所有用户的邮件授权挂到同一个应用上，出事时谁也分不清是谁在访问。多一步注册换来「每个人自己的应用、自己的租约」。
- **为什么改传输层而不是另写一条收信通道：** 收信/发信的行为（分页、附件、审计、策略）已经都在 IMAP/SMTP 那套里，XOAUTH2 只是换一种「怎么证明你是谁」；换通道等于把那些规则再实现一遍。
- **为什么并发刷新要合并（单飞）：** 微软每刷新一次就把 refresh token 轮换掉，两个读信请求同时刷新，后到的那个必然 `invalid_grant` —— 人会看到「登录已失效」，而其实刚刚刷新成功。

**代价 / 可改：**

- 多了一步「先建 Entra 应用」：这是微软的硬要求（设备码流也要一个公共客户端 ID），面板里写了注册步骤的 hint，完整步骤见 [`docs/MAIL-OAUTH-SETUP.md`](MAIL-OAUTH-SETUP.md)。想省这一步，只能由本仓库提供一个公共 client ID —— 那等于把所有人的邮件授权挂到同一个应用上，没做。
- 设备码有 15 分钟有效期，过了要重新点；登录状态存在桥这边，换机器要重新登。
- 令牌在配置文件里是明文（和授权码同一处境）；配置文件本来就只在本机、权限 0600，暂不加密。

**验证：**

- `bridge/tests/mail-oauth-unit.mjs`（12 条，已挂进 `npm run test:mail`）：预设只给 OAuth、oauth 必带 GUID 客户端 ID、租户默认 `common`、换应用/换租户作废旧令牌、`publicAccount` 不含令牌、设备码 pending→done（真等 2×2 秒，断言 upn 从 id_token 解出、令牌落盘）、取消/过期、`accessTokenFor` 三条路径（无令牌、撤销、能刷新）、令牌端点错误翻译（四类分开验）、并发刷新只发一次请求、OAuth 账号被服务器拒令牌时翻成 `oauth-needed` 而不是「重新生成授权码」。
- `bridge/tests/mail-unit.mjs` 加 HTTP 面：授权码账号调 `/api/mail/oauth/start` → 400、未知账号 → 404、非 POST → 405、未知动作 → 404、存 oauth 账号 200 且 `hasToken:false`/`hasSecret:false`、新建 oauth 账号不给客户端 ID → 400、改存时沿用原客户端 ID。
- `npm run test:mail` 全绿（bridge 单测 50 + oauth 12 + 列表 50 + web 17）。

## D283 表格颜色按 Excel / WPS 的主题色索引排，sheet 标签色与页内超链接真能跳（用户报障 2026-11-16）

**问题：** 用户拿 openpyxl 生成的练习簿预览时看到两处不对：「sheet 里原来的 Excel 里面有颜色，现在没有」「单元格里面有 link 点击能跳到对应的 sheet，现在也不起作用」。靶子是 `~/Excel全能教学练习簿.xlsx` 与 `~/excel-demo/Excel功能演示大全.xlsx`。

**原因（排查出四个问题：1、3 解释「颜色没了」，4 解释「链接不跳」，2 是顺手补的）：**

1. **主题色索引按 XML 顺序读了。** `styles.ts` 的 `THEME_SLOTS` 抄的是 `clrScheme` 的 XML 顺序（`dk1, lt1, dk2, lt2, accent1…`），但 Excel / WPS 的 `theme="N"` 用的是「背景 1、文字 1、背景 2、文字 2、强调色…」顺序，前四档两两对调。openpyxl 的默认字体就是 `<color theme="1"/>`：我们解析成 `lt1` 白色，`Excel功能演示大全.xlsx` 里有 352 个格子变成白字，看起来像「颜色没了」；主题底纹的 0/2/3 也分别错成黑 / 深蓝 / 浅灰。
2. **边框的另一种写法没认全。** Excel 与本机 WPS 都写属性 `<left style="thin">`，但有些导出器 / 旧版样张把线型写成子元素 `<left><color …/><style val="thin"/></left>`；`readBorders()` 只读属性，遇到这种整张表一条边框都没有。
3. **`<sheetPr><tabColor>` 从来没读。** 两个练习簿每张表都设了标签色（`rgb="00…"` / `FF…`），前端 `renderTabs()` 也只会画同样的灰按钮，所以底部一排标签全无颜色。
4. **页内链接被当成「不能开的链接」丢掉了。** 桥端本来已经解析 `<hyperlinks>`，但 openpyxl 把页内链接写成 relationship 的 `Target="#'01 基础格式'!A1"`（还带 `TargetMode="External"`），WPS 写成 `<hyperlink location="'第二页'!A1"/>`；前端只认 `#` 以外的外链、而且必须按 Ctrl/Cmd 才开，于是「单击跳到对应 sheet」这条主路径整条失效。

**决定：**

- **主题索引改成 Excel / WPS 的顺序**：`lt1, dk1, lt2, dk2, accent1…`。这一条是拿 WPS 实测出来的：openpyxl 造一张 `theme 0…11` 的样张，用 WPS 打开逐格看颜色——0 是白（背景 1）、1 是黑（文字 1）、2 是浅灰（背景 2）、3 是深蓝（文字 2）、4 起是强调色 1…6。`readTheme()` 按这个顺序装数组，`colorOf()` 直接按 `theme="N"` 取。
- **调色板以文件为准**：`<colors><indexedColors>` 覆盖过就用文件里的，没有再退回 ECMA 的 64 色；这样 `Color(indexed=…)` 不会再按别的调色板解释。
- **边框两种写法都认**：`style` 属性优先，没有就看子元素 `<style val="…"/>`；`none` 当没有边。
- **sheet 标签色进 `SheetInfo`**：从表前缀的 `<sheetPr><tabColor>` 读（支持 `rgb` 8 位 ARGB、`theme` + `tint`、`indexed`），前端在标签底部画一条 2px 色带。只画色带、不把整颗标签染色：标签文字的可读性不受深色影响。
- **页内链接归一成 `#…`**：桥端 `linkTarget()` 把 `location` 统一加一个 `#`，relationship 的 `Target` 本身以 `#` 开头就原样保留；外链不 decode（`%20` 是地址的一部分），页内表名才 decode。前端新增 `web/src/sheet/links.ts` 解析 `#'表名'!A1:B2`（去引号、`''` 反转义、`$`、反向区域、只给表名落 A1、忽略大小写匹配），`SheetDialog.followLink()` 负责切表 + `jumpTo()` 选区。
- **点击语义照 Excel / WPS**：只读态**单击**链接格就跳；编辑态单击是选中该格去改，**Ctrl/Cmd + 单击**才跳。外链交给 `window.open`，页内链接切表后选中目标区域；找不到表或目标位置不合法时在底栏闪一条说明，不静默失败。

**代价 / 可改：**

- 页内链接只支持「工作表 + A1 式区域」；命名区域（`#税率`）、外部工作簿（`#'[book.xlsx]Sheet1'!A1`）、`file://` 目标仍不跳，底栏会明说打不开。
- 标签色画成底部色带，不是 Excel 那种整块染色的标签；深色标签也不做自动反白。
- 主题色只认 `clrScheme` 的 12 个槽位和 tint；渐变、图片填充、条件格式里的主题色仍按近似处理。
- 编辑态要 Ctrl/Cmd 才跳是刻意的：不然想选一格改字就会误开链接；这个键盘约定和 Excel 一致。

**验证：** 新增 `bridge/tests/sheet-theme-unit.mjs`（主题 0–11 顺序、openpyxl 默认字体黑色、theme=2 浅灰、WPS 子元素边框、自定义 indexed 调色板、标签色 rgb/theme）与 `bridge/tests/sheet-refs-unit.mjs`（location / relationship / 百分号转义 / 不叠 `##` / 外链不 decode），`web/tests/sheet-links-unit.mjs`（引号表名、区域与反向区域、`''`、命名区域拒绝、大小写匹配），一并挂进 `npm run test:sheet`。两处 typecheck、`npm run build` 全绿。真 Chromium + 隔离桥打开用户两个文件：标签色 `#1F3864` / `#8EA9DB` / `#2F5597` 都对；`00 目录` 的正文从白字变黑字；单击 B6 跳到 `01 基础格式` 并选中 A1；演示文件 `05 图片与超链接` 的 B19 跳到 `09 排序与汇总`。WPS 侧另存一份带边框 / 标签色 / 页内链接的样张，读回 `#2E75B6` 标签色、`1px solid #D9D9D9` 边框、`#'第二页'!A1` 链接。

## D284 补全只替换光标左边已经敲的那一截，不再吃掉右边的字（用户报障 2026-11-17）

**问题：** 输入框里已经写了一段话，光标回到最前面，敲 `/` 再挑一条命令 / 技能，原来的内容就没了；换个位置也一样（比如在句子中间敲 `@` 选文件）。用户原话：「当用户在输入框中已经输入一些内容后，然后回到最前面，用/ 然后选择一个skill 后，会导致已经输入的内容被清空」。

**原因：** `web/src/app.ts` 的 `updateComplete()` 用 `const before = text.slice(0, caret)` 匹配 `/^\/([^\s]*)$/`，但替换终点取的是 `tokenEnd(caret)` —— 「从光标一直吃到下一个空白」。光标停在开头那个 `/` 时，`tokenEnd` 会把 `/` 后面整段用户文本当成待替换的 token 一起切掉：`/new ` + 用户原文整段消失；原文里恰好有空格时，只从第一个空格往后幸存，变成 `/new bug` 这种残句。`@` 文件补全同一个 `end = tokenEnd(caret)`，症状一样。技能面板的「使用」走的是另一条路（`pickSkill()` 按 `selectionStart` 插入），没有这个问题。

**决定：**

- **匹配和替换都只看光标左边。** `web/src/commands.ts` 新增 `slashSpan(text, caret)` / `atSpan(text, caret)`：`start` 是 token 起点，`end` **就是 caret**，`query` 是 token 里光标之前的那一截。`updateComplete()` 改用它们（`web/src/app.ts:14065` / `web/src/app.ts:14075`），`tokenEnd()` 与旧的 `before` 拼接一起删掉。
- **光标右边的文本一律不归补全管。** 这条是不丢内容的唯一保证：不管用户在多早的位置敲 `/`，替换范围都不会越过光标。

**代价 / 可改：**

- 光标停在一条**已经敲完**的命令词中间（`/new` 里光标在 `e` 和 `w` 之间）再补全时，只替换到光标，右边那个 `w` 会留着变成 `/newX w` 之类的拼接 —— 旧行为是整词替换，看起来更「干净」，但它正是清空用户文本的那把刀。选了宁可留残字也不丢话。
- `@` 文件补全同理：路径中间补全只换光标左边那截。

**验证：** `web/tests/commands-unit.mjs` 新增 5 个用例（`applyPick()` 切片模拟真插入）：光标回开头选候选后原文完整保留、无空格整段保留、词中间补全只换到光标、`/` 只认行首、`@` 同样只到光标 —— `npm run test:commands` 20 pass。真 Chromium 探针 `probes/complete-insert-keeps-text.mjs`（隔离桥 17876，用内建命令行代替技能行，路径相同）：修复前输入框变成 `/new ` 与 `/new bug`（红），重建后 `/new 帮我看看这个bug`、`/new 帮我看看这个 bug`（绿）。`npm --prefix web run typecheck`、`npm --prefix web run build` 全绿。

## D285 启动完成不再把正在打字的人甩出输入框（用户报障 2026-11-17）

**问题：** 开新会话后 pi 要几秒才起来，这段窗口是允许打字的（D178）。但就在 bridge 报「起来了」的那一瞬，**焦点从输入框掉回页面**，正在打的字再也进不去，只能重新点一下输入框。字不丢（`composerText` 草稿还在、重画会填回去），丢的是焦点和光标位置 —— 打断的是「正在写一句话」这件事本身。

**根因：** `mergeSession()` 里判断「要不要重画聊天区」的条件含有 `starting`：

```ts
if (prev?.owned !== state.owned || prev?.origin !== state.origin || prev?.starting !== state.starting) this.renderChat();
```

但 `starting` 只喂 `paintHintStatus()`（那行「pi 正在启动（加载扩展，通常几秒）…」）和撤回按钮。`composerPlaceholder()` 只看 running / asks，`renderChat()` 函数体里根本没有 `starting`。桥在 `bridge/src/sessions.ts` 的 `setState({ starting: false })` 翻这一格，前端就为了一行提示文案把整块聊天区 `replaceChildren()`，`this.textarea = null` 之后重建一个全新的 —— 焦点随旧节点落回 `<body>`。启动期越长，撞上的概率越高，看着就像「pi 一起来就把我踢出去」。

同一个坑其实早被踩到过一次：「继续」按钮的 `sendContinue()` 里手工记了 `selectionStart`、重画后 `focus()` + `setSelectionRange()` 收回来（那里有注释明写「重画会重建 textarea，光标位置和焦点不会 —— 收回来」）。只是它只管自己那一条路径。

**决定：**

- **`starting` 不再算重画理由。** 条件只留 `owned` / `origin`；`starting` 翻转照旧走事件处理里的 `fillHintStatus()`，提示条该变还是变。
- **`renderChat()` 自己负责焦点搬运。** 进门先看 `document.activeElement === this.textarea`，是就记下 `selectionStart` / `selectionEnd`；函数末尾（`syncCwdChip(); placeFailCta();` 之后）新 textarea 建好了，`focus({ preventScroll: true })` 再 `setSelectionRange()`。理由：`owned` / `origin` 翻转（另一端接管、pi 进程退出）**同样会重建 composer**，症状一模一样，只修 `starting` 是修一个入口，不是修一类。`sendContinue()` 那段保留（幂等），并把它的 `focus()` 补成同一套参数（`preventScroll` + 完整选区），以后新加的调用点不用各自再抄一遍。

**代价 / 可改：**

- 接回焦点以「重画前焦点在输入框里」为条件，所以弹窗、侧栏、抽屉的焦点不会被抢；反过来，如果将来有「重画时想把焦点主动送去别处」的需求，得显式 `blur()` 或在重画后再聚焦目标元素（后聚焦的赢）。
- 只在同一个会话内重画才有意义：切会话时 `this.textarea` 的内容会换成另一份草稿，`setSelectionRange()` 的超界偏移由浏览器夹到文本长度内，不会抛错，但光标位置对不上原来那句 —— 现状本来就是这样，没有变差。
- 选区只在焦点确实在输入框时恢复；用户此时若正在用鼠标拖选别处（焦点已不在 textarea），概不干预。

**验证：** 新增 `bridge/tests/composer-focus.mjs`（端口默认 7870，`COMPOSER_FOCUS_PORT` 覆盖）：`FAKE_PI_BOOT_MS=5000` 让假 pi 握住第一条命令模拟慢启动，走真实 UI 开新会话、进输入框，每 80ms 用真键盘敲一个字，一直敲到「正在启动」消失；断言焦点始终是 composer 里的 `TEXTAREA`、字数一个不少、之后再敲的字照样进输入框。修复前红：`activeElement=BODY inComposer=false`、末字丢失（`len=53 want≥54`）；修复后绿（`flippedAt=45`）。`npm run typecheck`（含 i18n-check、viewport-units 守卫）与 `npm run build` 全过。

## D286 记录器登录自启改用 HKCU 的 Run 项，装完必须回读验证（用户报障 2026-11-17）

**问题：** 用户报「我今天解锁了，但是没有看到信息」。查下去是三件事叠在一起：

1. **计划任务从没注册成功。** 这台机器的账号 `HYRON-JS\yangqm` 不在 Administrators 组，`Register-ScheduledTask` 一律回 `Access is denied`；而它是 CIM 的非终止错误，`-ErrorAction Stop` 也拦不住，脚本照到底、照打 `{"ok":true}`。页面于是显示「装上 / 运行中」，`agent-status.json` 却是上一次手动跑留下的心跳。
2. **就算装上也没有数据。** 非管理员读不到 Security 日志的 4800/4801，这台机器连审核策略都没开（`log-events.json` 是 `[]`），回填也就永远是 0 条。
3. **0 条还给了绿条。** 「导入历史」把 0 条也算成功，用户看到的是「导入了 0 条」这种假绿灯。

**决定：** 登录自启换成 **HKCU 的 Run 项**（`AUTOSTART_KEY` / `AUTOSTART_NAME` = `pi-web-client-workclock`），装/卸用 `reg.exe`，装完**回读注册表**判断成败，再靠心跳确认进程真起来了。计划任务那条路整条删掉。

- 测试实例（有 `PI_WEB_STATE`）的值名带状态目录哈希后缀：`pi-web-client-workclock-<6 位>`，取哈希**低位**（djb2 末尾字符的差异只落在低位，取前 6 位会让 `wk-a` / `wk-b` 撞名）。这样两个测试实例、以及测试实例与正式实例之间不会互相顶掉自启项。卸载时 CIM 兜底杀进程只匹配 `*<本实例脚本完整路径>*`，同理不误杀别的实例。
- 拉起进程用「短命 powershell 里 `Start-Process -FilePath <powershell 绝对路径> -ArgumentList <脚本参数> -WindowStyle Hidden`」，**不用 node 的 `detached: true`**：Windows 上那是 `DETACHED_PROCESS`（没有控制台），PS 5.1 启动即退。
- 自启项与 `Start-Process` 都写 **PowerShell 的绝对路径**（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，找不到才退回裸名字）：Run 项在登录时由 explorer 拉起、靠 PATH 解析，用户把 PATH 改坏或前面有条冒牌的 `powershell.exe` 就会跑错东西。Run 项是 CreateProcess 语义，路径带空格才用双引号包（**不能**用 PowerShell 的单引号 `psQuote`）。
- 装了但没心跳时报错要把脚本路径写出来（「直接跑一次 <script> 看报什么错」），不能让用户猜。
- 装/卸的结果一律读回真实状态决定 `ok`，不信子进程的退出码。
- 页面文案跟着分档：`运行中` / `已注册自启，但没在跑` / `未安装`，并显示心跳时间；回填 0 条改成明确的坏消息（「这台机器没开审核策略（4800/4801），只能用记录器从现在开始记」）。

> **被 D288 取代的部分（2026-11-17）：** 回填只查 4800/4801、以及 0 条时那句「没开审核策略（4800/4801）」的说法都不再准确 —— 解锁改读默认就审计的 4624，页面上给「推算」的下班时刻也标了出来，见 **D288**。其余口径（Run 项自启、回读验证、三档文案）不变。

**实测（本机，Windows 11 + PS 5.1）：**

- 标准用户 `Register-ScheduledTask` → `Access is denied`；改成 `-File` 模式后语句级错误仍不中止。
- node `spawn` 的 `detached: true`（`stdio` ignore / pipe 都试）启动 PS 5.1 → 立刻 exit 0，脚本一行没跑。
- 不 detached 又会跟着父进程死：父进程退出 5 秒后 `tasklist /FI "PID eq <子进程>"` → `No tasks are running`，心跳文件停住不动。
- `Start-Process` 那条路：父进程退出后 20 秒心跳仍在推进（`updatedAt` 1794881304 → 1794881318）。
- `reg query HKCU\...\Run` 的真实输出（`OneDrive` / `ctfmon` / `Docker Desktop` / `Teams` 都在）解析器实测能取回含空格的值名与带引号的命令行；值不存在时返回 null。

**验证：** `bridge/tests/workclock-unit.mjs` 新增 `parseRegQueryValue`（真实格式：CRLF、值名补到列宽、含空格的值名、命令带引号、缺值 / 空输出 / 中文报错行）与 `autostartValueName`（正式实例原名、测试实例带后缀且不撞）两组用例；两处 typecheck 全绿。

**代价 / 局限：** Run 项在登录后几秒才拉起（不是「一登录就绪」），开机后立刻锁屏的那一小段会漏；Windows「启动应用」列表里显示的是 `powershell.exe` 而不是好认的名字；非管理员仍读不到 Security 日志，历史回填依旧要 UAC 或另开审核策略。

**追加（同一次改动，代码评审后）：** `readAgent` 的 running 与 `installAgent` 的「已在跑就别再起一份」原本各写一份判定，抽成 `statusRunning(status, now)` 共用 —— 两处各写一遍早晚会漂成「装的时候觉得在跑、页面觉得是死的」。

## D287 扩展弹窗里的 pi 包用 pi 自己的 `autoload: false` 停用，不用另立开关键（#469，用户要求 2026-11-17）

**问题：** 扩展弹窗「已安装 → pi 包」只有「更新」「卸载」。用户想让某个包「先别生效、但别卸掉」时，唯一的路是卸载：版本记录没了，之前用 `pi config` 收窄过的资源过滤（`extensions` / `skills` / `prompts` / `themes`）也一起丢，回头重装还得重配一遍。

**决定：**

- **停用 = 把 settings 里的条目改写成 pi 自己的 `{ source, autoload: false }`。** 不引入我们自己的开关字段（页面自带的 `extensions` 黑名单那套只认扩展 id，包不是扩展），也不改名/移文件。pi 读包时 `autoload === false` 就走「空 patterns」那条路：扩展、技能、提示词、主题一个都不加载，等价于「装在那儿但不起作用」。
- **不改包、不改来源。** `pi update` / `pi remove` 只认 `pkg.source`，所以停用的包照样能升级、能卸载；升级不会把条目改回启用（`updateConfiguredSources` 不写 settings）。
- **启用按 pi 的塌缩规则还原**（`pi config` 同一个规则：去掉 `autoload`、丢掉被清空的资源数组、只剩 `source` 时塌回纯字符串）。**不存「停用前的原始形态」的存档映射** —— 存档会和用户在终端里自己跑 `pi config` 之后的真实状态打架，而 `autoload: false` 之上只要还留着用户的过滤条件，还原就不丢信息。
- **`pi list` 会给对象条目打 ` (filtered)` 尾巴**（user 和 project 两个 scope 都会），所以 `picli.parsePackages` 先把尾巴剥掉再当来源用；否则停用之后「更新」按钮对不上这一行，`pkg.toggle` 也会拿着带尾巴的字符串去找条目。
- **项目条目会替换全局条目，反过来不行**：全局停用、项目里重新启用 → 包照旧加载。`pi list` 又把项目条目并进同一行（同一来源只给一行），所以行上只有一个 `alsoEnabled`：按行自己的 scope 说「项目里仍启用」或「全局仍在加载」，不让「已停用」说谎。
- **每个 scope 只动自己那份 settings.json**，写锁按文件命名（`settings:global` / `settings:project`），和扩展启停同一把锁 —— 两个按钮同时点不会互相覆盖。项目 scope 的写入要项目已被信任（pi 自己的 `FileSettingsStorage.withLock` 拒绝写未信任项目的 `.pi/settings.json`），拒绝时把 pi 的原话带给页面。
- **来源比对按 settings 里的原样字符串**（trim 后相等）。`pi list` 回显的就是 settings 里的写法，`pkg.toggle` 拿的也是它，所以两边天然一致；pi 没有导出规范化函数，我们不自造一套（将来若支持 `npm:x@2` 之类的等价写法要重新看这里）。

**代价 / 可改：**

- 「停用」是写在 settings 里的事实，不是页面状态：换台机器、换个前端看到的是同一份。代价是它有副作用范围 —— `pi` 在终端里也读不到这个包了（这正是用户要的），所以按钮文案写「停用」而不是「在这里隐藏」。
- 停用只影响资源加载，不影响包文件、`pi list` 的可见性（会标 `(filtered)`）与版本检查。
- 启用会丢掉用户手写的空数组（例如 `prompts: []`）：pi 里空数组和不写这一类是同一个意思（都表示「不限」），塌缩后语义不变；如果将来 pi 改成「空数组 = 一个都不加载」，这里要跟着改。
- 已开着的会话不会立刻掉资源，沿用原来的「重新加载当前会话」提示（和扩展启停一致）。

**验证：** `bridge/tests/ext-manager.mjs` 新增 A2 段（条目两形态 / 停用保过滤 / 启用塌缩 / 幂等 / 找条目 / 另一 scope 仍在加载）与 B 段 `pkg.toggle` 端到端（写盘形状、库存 `disabled` / `alsoEnabled`、`(filtered)` 不进来源、启用塌回字符串、未知来源拒绝且不写盘、项目条目仍加载、未信任项目拒绝写入）；`probes/ext-manager-stages.mjs` 新增第 10 步（点停用 → 变「启用」、状态写「已停用」、版本号还在 → 点启用回来），并把探针第一步修到现在的新弹窗（已安装清单在「插件市场」子页签里）。

## D288 回填解锁改用 4624 的 LogonType，4800/4801 只够拿锁屏（用户要求借鉴 login_audit 2026-11-17）

**问题：** D286 之后记录器能跑起来了，但「导入历史」在这台机器上永远是 0 条 —— 只查 `Id=4800,4801`，而这两个事件属于「Other Logon/Logoff Events」子类别，默认**不**审计（微软文档的默认值就是 Not logged）。用户拿 `E:\yqm\login_audit` 的实现来问有没有可借鉴的，那套脚本的解锁来源是 4624。

**决定：** 回填同时读 **4624**（Audit Logon）。Win10 1809 起 Audit Logon 默认 Success + Failure 都开，所以不改任何审核策略就能拿到历史解锁时间：

- `LogonType` 决定算不算「到岗」：`7` = 解锁（微软原话 "This workstation was unlocked"）、`2` = 开机后登录、`11` = 缓存凭据登录、`10` = RDP 连进来、`12`/`13` = 缓存远程/缓存解锁 → 都算 unlock。
- `3`（网络）/`4`（批处理）/`5`（服务）**必须排除**：不排除的话每次文件共享访问、每个计划任务都会造出一条「上班」。
- 只认 `TargetUserName` == 当前 `WindowsIdentity` 的短名，`DWM-1`/`UMFD-0` 这类伪用户不算。取短名不用 `.Split('\')[-1]`（`Split` 的重载绑定会受字面量影响），也不直接信 `$env:USERNAME`（UAC 里改用另一个管理员凭据时它就不是当前账号了）：按 `LastIndexOf` 截。
- `LogonType` 用 `[int]::TryParse` 转，转不动的整条跳过、不让一条脏数据把整次回填抛死在写盘之前。
- 字段一律从 `[xml]$e.ToXml()` 里按 `EventData/Data[@Name]` 取；`$e.Properties` 取不到命名字段（login_audit 的脚本注释记了这条，我没有在 Security 上复验 —— 没有提权环境）。
- 锁屏（下班时刻）仍然只有 4800/4801：默认不审计的机器上「下班」只能靠记录器，这是这条决定的已知缺口，页面上按来源标出来。
- `FilterHashtable` 没有 EndTime，只能 `StartTime` + `-MaxEvents 50000` 截断；生成脚本抽成 `backfillScript(outFile)`，单测直接断言这几条不变量。
- 回执里的条数是**去重前**的原始事件数，一次解锁常有两三条重复 4624；给用户看的条数由桥读完 `log-events.json` 后按 `dedupeEvents` 重算 —— 去重规则只留 TS 一份，不在 PS 里再抄一遍（否则两个数对不上，用户会以为「导入了但看不见」）。
- **缺口要在页面上标出来：** 没开审核策略的机器回填不到 4800/4801，「下班」只能取「当天最后一次解锁」，工时只会偏小。`WorkclockDay.endInferred` 为真时下班时间后面写「推算」，不再默默少算。

**取舍：** 记录器仍是主来源（`event` > `poll` > `log` > `start`，D246）；4624 只是把「历史」这一层从 0 条变成有数据。代价：一次解锁可能产生 2 条重复 4624（login_audit 的注释记了本机这个现象），靠 `dedupeEvents` 的同 kind 5 秒合并吃掉；RDP 连进来算到岗（「连上就开始干活」更贴工时口径，但有人可能不认同）；换账号后只看得到当前账号的历史；回填得到的历史只有上班时刻准、下班时刻是推的。

**验证：** `node bridge/tests/workclock-unit.mjs` 新增用例断言生成脚本含 `Id=4624,4800,4801`、`@(2,7,10,11,12,13)`、XML 取值、当前用户过滤、`-MaxEvents 50000`，且 `LOGON_UNLOCK_TYPES` 不含 3/4/5；PowerShell 解析器（`[Parser]::ParseFile`，用 `.scratch/parse-check.ps1`）对生成脚本报 0 错；**真机回填条数未自动验证** —— 要弹一次 UAC，留给用户点「导入历史」确认。
## D289 历史里点一条提交弹详情小窗，形状是「主从双栏」（用户要求 2026-11-17）

**问题：** 分支工作台的「历史」里，一行只有短 SHA、标题、作者时间，想知道这条提交到底改了什么，只能去命令行 `git show`，或者切到「差异」页把对照设成这条提交 —— 后者会丢掉当前对照、也不显示提交说明与提交元信息。用户要求：点提交履历能弹出一个小 dialog 看详细信息，关掉后回到分支管理的 dialog。

**决定：**

- **入口只加在历史行上**（左右两列都算），`role="button"` + `tabindex="0"`，Enter / 空格也开；开着的行加 `.is-open` 高亮。
- **形状用「主从双栏」**（原型阶段给了三个候选：A 侧栏+行内展开 diff、B 主从双栏常驻 diff 面板、C 锚定行旁的浮层手风琴，用户挑的 B）：900 宽 / 86% 高；左 300px 是作者、时间、父提交、位置 chips、引用、完整 SHA 加提交说明；右上文件清单（`+n −m`，300 条封顶并写「还有 N 个」），右下是选中文件的并排差异。窄到 720 以下靠 `@container` 折成上下。
- **说明截断、差异按块分页**：说明取 `%B` 去掉与标题重复的首行，超 6 行 / 420 字 / 桥端 `BODY_LIMIT`（400 行 / 20000 字）就给「展开全文」。**单文件差异只给 `@@` 块**（`-U3` 上下文，`parseHunks` 解析），一页 `HUNKS_PER_PAGE = 20` 块、滚到底按 `from` 续拉下一页 —— 原来是两侧整篇文件按行号硬对齐再截 200 行，改在文件后半段的提交根本滚不到；现在不读整篇 blob，块数超过 20 也照样能一路看完全部改动。单块超过 `HUNK_ROWS_MAX = 4000` 行就截断并写明原因。
- **点文件才读那一份的差异**：为此新开两个只读接口，而不是复用 `/api/git/diff` —— 后者的 `commit` 模式会为提交里**每个**文件都读两侧 blob，一条上千文件的提交能拖很久。`POST /api/git/commit` 只要 `--numstat`（不读 blob），`POST /api/git/commit-file` 读一个文件的 `-U3` 差异（带 `from` 续页）。
- **元信息能回答「能不能拿来干下一步」**：`onHead`（`merge-base --is-ancestor <sha> HEAD`，即已在当前分支里）与 `pushed`（`for-each-ref --contains <sha> refs/remotes` 非空）；merge 提交额外给父提交列表并标出第一父，差异按**第一父**展开（与 `git show` 默认一致）。
- **关掉的三种方式等价**：✕、Esc、点遮罩，都走 `closeOp()`，焦点回到刚才那一行；Esc 用现有的捕获阶段链（先关详情卡，再关工作台），嵌在仓库面板里时由 `ReposSheet` 的 `closeLayer()` 传出去。
- **与现有操作卡打通，不另造一套**：底部「摘提交 / 回滚」先关详情卡，再用 `openOp(id, { hashes })` 打开原有操作卡并预填哈希 —— 脏区三选一、红色确认、结果卡全都沿用。不适合的时候按钮**照常显示但禁用**并写明原因（已在当前分支 / 这是 merge 提交，要 `-m`，操作卡还没有这个入口），不藏按钮。
- **会话内缓存**（`Map<repo|sha>`，说明与文件清单）：写操作后 `load(fresh)`、换仓库 `setDir()` 都清空；列表被后台刷新重画时 `keepCommitRow()` 把高亮挪到新节点上，不让它凭空消失。

**取舍：** 代价是多两个接口、多一层缓存失效判断；跨仓库的缓存不复用（键里带 repo，只在本会话内）；merge 提交的摘/回滚暂时禁用（操作卡没有 `-m` 入口，与其让人跑出一条红字，不如先说清）。没选「点行就跳到差异 tab」：那会覆盖用户当前的对照与筛选，回不去。三个候选原型留在丢弃分支 `proto/commit-detail`（`web/prototype/commit-detail.html`，`?variant=A|B|C`），不进 main。

**验证：** `npm run test:githist` 里的新单元 `bridge/tests/git-commit-unit.mjs` 用真 git 仓库断言：短/全长 SHA、标题取 `%B` 首行、正文为空、根提交 `parents === []` 且对照空树、merge 报两个父且差异只列第一父侧的文件、rename 带 `old`、`onHead` / `pushed`（`update-ref refs/remotes/...` 之后才为真）、500 行正文截到 400 行、`limits.files === 300`、参数清洗（`--evil` / `../outside` / `deadbeef` 各自报对码）；另有一组「400 行文件里改 40 处不相邻的位置」断言 `hunks.total === 40`、首页 `count === 20` 且首行是 `@@` 块头、块与块之间的上下文行不出现、`from = 20` 从第 21 块起、`from = 40` 返回空页，以及「整篇 4100 行都改」时单块截到 4000 行并写明原因。`npm run test:githist:ui`（Playwright，`GITOPS_UI_PORT` 要避开 Hyper-V 保留段，本机用 8300）点一遍：行是 `role=button` 且在 Tab 序列、点开小窗且工作台还在下面、完整 40 位 SHA、父提交、自动展开第一个文本文件的并排差异、**差异里有 `@@` 块头且不是整篇文件**、高亮唯一、文件清单带增删数、点另一个文件换右侧、摘提交关窗改开操作卡且哈希预填、Enter 也能开、Esc 关掉后焦点回到那一行、点遮罩同样关、顶点提交的摘提交是禁用的。续拉另用一次性探针验过：造一个「300 行文件改在 25 处」的临时仓库，首屏 `已显示 20/25 个变更块`，滚到底自动补到 25 块、提示消失。`npm --prefix web run typecheck`（含 i18n 与 viewport 守卫）通过。

## D290 工作区按天插位：新建 / 首见的组落在「同一天那一档」的末尾（用户要求 2026-11-17）

**问题：** 组的先后只有一份 `order`，而 `create / createDir / resolve` 都把它**追加到末尾**（D168 定的）。结果：今天新建的两个工程排在一堆三个月没动过的工程后面；启动时补出来的组也一样。用户要的是「按最后一次更新排，以天为单位」——前两个今天有更新的在上面，后面两个今天没更新，今天新建的就该排第三，而不是第五。

**决定：**

- **只有一个插入规则**：新出现的组（显式新建、按目录新建、`resolve` 启动补组）**只在出现的那一刻**插一次 —— 插到 `order` 里第一个「比它旧」的组之前，也就是同一天这一档的末尾；等于 `order` 里没有任何更旧的组时落到末尾。已有组命中就不动顺序（`createDir` 返回 `created:false` 时尤其）。
- **组的天 = 组内可见会话的最新 `updatedAt`**（含子会话；归档与随手问不算 —— 归档是全局分区，不进任何工作区）。**一个会话都没有的空组按最旧算**，排在当天档的末尾而不是冒充「刚刚更新」。
- **天是本地日历日**（`dayKey()` → `yyyymmdd`），不是「多少小时以内」：跨零点就该换档，与左栏分组用的是同一个口径。
- **比较的是 `order` 里组的「最近更新天」，锚点只有新建那一下用**：`insertByDay(order, id, anchorDay, dayOf)` 是纯函数，`Workspaces` 只负责把它接到 `create / createDir / resolve` 上；`groupFor` 的调用方（开新会话 / 接管终端会话）也带上同一个 `place`，否则那两处新建的组又会跑到末尾。
- **新建之后要能看见它**：横排在可见段就滚到那一颗，被折叠进 ＋N 就把 ＋N 标亮（**不自动展开下拉** —— 空组紧接着要开全屏的「新会话」弹层，展开了也看不见）；左栏展开并滚到组头、闪一下；空组直接把「开新会话」摆出来并预填目录，位置写进弹层标题下（「已建在 X，横条第 N 位」/「已建在 X，收在 ＋N 里（第 M 位）」）。
- **新建工作区的目录输入框与文件管理器同一种**：`mountDirPicker(..., { pathBox: true })`，粘绝对路径即可定位，不新写一套目录浏览。

**取舍：** 代价是「一次插入」之后顺序就归 `order`，用户手动拖过的顺序不会被下一次更新打乱 —— 这是有意的：自动重排会把人刚整理好的横条又搅一次。没做「按最近活动整体重排」，因为那会让横条上的位置天天变、肌肉记忆失效（D168 的理由仍然成立）。`dayMap()` 每次要扫一遍会话元数据（只读缓存，不跑 git），`list()` 里按帧记忆一次；`Workspaces` 的状态写会重放两遍，所以 `dayOf` 必须是纯读。

**验证：** `bridge/tests/wsorder-unit.mjs`（11 条：本地日切、同档末尾、空 order、手动拖乱的顺序上再插、稳定性）、`bridge/tests/workspace-unit.mjs`（41 条，其中 5 条新的：`createDir` 带 place 插到旧组前、命中已有组不动顺序、不带 place 仍追加、手建组按天、`resolve` 按 `cwdDay`）、`bridge/tests/sessions-day-order.mjs`（5 条：真会话文件 + mtime，今天档末尾 / 子会话算今天 / 空组最旧 / 归档不计 / 再次看到顺序不变）、`web/tests/wstabs-unit.mjs`（47 条，6 条新的 `birthReveal()`：可见段第几颗、被折叠时 ＋N 里的序号、不在横条）。`npm run typecheck`、`npm run build` 通过。

## D290 新建工作区按天插位，建完在横条与左栏都指得出它在哪（用户要求 2026-11-17，issue #478）

**问题：** `order` 一直是「新组追加到末尾」，于是今天新建的组被排到几个月没动的旧组后面；横条名额满了它直接进 ＋N，看起来像没建成；按目录建完组是空的，还得自己再点一次新会话。

**决定：**

- **组的天 = 组内可见会话（含子会话）的最大 `updatedAt`**；空组算最旧（`-Infinity`）。归档是全局分区、不进任何工作区，随手问也不在列表里，两者都不计。
- **新建组落在「今天这一档的末尾」**：插到第一个更旧的组之前（`insertByDay`）。只在出现那一刻插一次，之后归 `order` 管，拖动 / 删除不再重排；命中已有组不动顺序。显式 `ws.create`、按目录 `ws.create.dir`、启动补组 `resolveWorkspaces` 三条路都按这条走。
- **补组的锚点用 `cwdDay(cwd)`**（该目录下会话的最大活动日），取不到才用启动当天 —— 启动补出来的旧工程不会被当成「今天新建的」顶到前面。
- **建完四件套**：横排滚到它；被折叠时标亮 ＋N 但**不自动展开**（新会话弹层是全屏遮罩，展开了也看不见）；左栏展开并滚到、组头闪一下；位置写进新会话弹层的说明里（「横条第 N 位」/「收在 ＋N 里（第 M 位）」）。
- **空组建完直接开「开新会话」并预填目录**；取消就停在原会话，不回滚、不留一个空对话。
- **「新建工作区」对话框加 `pathBox: true`**，与文件管理器同一行输入框（贴绝对路径回车即定位）。

**取舍：** 天的粒度是**本地时区的日**（`dayKey = 年*10000+(月+1)*100+日`）。同一天内的先后沿用 `order` 里原有次序，不按小时排 —— 按小时排会让「今天的组」每来一个新会话就跳到最前，位置不稳。`dayOf` 必须纯读（`StateFile.update()` 会在缓存上跑一遍、读盘后重放一遍，两次结果要一致），所以 `SessionManager.dayMap()` 只查缓存与 `discover()`，不建组、不跑 git；`place()` 返回前把 `dayMap()` 算成一回，避免 `insertByDay` 对每一项回调时重扫全部会话。

**验证：** `node bridge/tests/wsorder-unit.mjs`（11 通过）、`node bridge/tests/workspace-unit.mjs`（41，含 5 个 #478 用例）、`node bridge/tests/sessions-day-order.mjs`（5，真会话文件 + `utimesSync` 控 mtime）、`node web/tests/wstabs-unit.mjs`（47，含 6 个 `birthReveal` 用例）；`npm run typecheck`、`npm run build` 通过。

## D291 考勤做成「本机管理」第六页，OA 形状全部搬进 config，密码用 DPAPI（用户要求 2026-11-17）

**问题：** 用户所在公司的考勤/OA 系统要把「我的考勤」和「加班申请」搬进 pi-web 的本机管理里。这套系统是内网私有部署，接口形状是它自己的（`token` 头、`query_type` 四种模式、加班申请要两级审批人 id），而上游是开源项目 —— 任何公司标识、域名、工号都不能进仓库。

**决定：**

- **独立第六页，不动「上下班」。** `web/src/sysmanage.ts` 的 `SysSection` 加 `"attendance"`。已有的「上下班」是拿 Windows 解锁事件算本机工时（D246/D288），与公司考勤是两套账，混在一起会让人以为在核对同一件事。
- **页面只认字段名，不认字段含义。** `config.json` 里存 `apiBase` / `pageBase` / `account` / `endpoints{login,records,overtimeInit,overtimeAdd,overtimeCancel,leaders}` / `fields{...}`。代码里没有一处公司域名字面量，换一家 OA 只改配置。
- **`query_type` 只能是 3。** 实测 0/1 会忽略日期参数、固定回最近一段（换日期结果一模一样），2 返回空，只有 3 尊重 `start_dt`/`end_dt`。页面强制 3 并把区间裁到 90 天。
- **`keyword` 必须填自己的 `user_id`。** 空串会让上游抛 `1292 (22007): Truncated incorrect INTEGER value: ''`，回填工号也行但没必要 —— 只查自己，不等上游的权限兜底。
- **两次确认、十分钟去重。** 加班提交第一次只回预览（`needConfirm` + 链路 + 小时数），第二次带 `confirm` 才真发；成功后按「账号+时段+时长+事由」记账 10 分钟，同样的内容再提交直接 409，避免连点两下造两张单。撤回同理。
- **密码落 DPAPI，页面只见掩码。** `credentials.bin` 是 `PWDP1` + 长度 + `[ProtectedData]::Protect(CurrentUser)` 密文；页面拿到的永远是 `TS***1` 这种掩码。PowerShell 只用 `Add-Type -AssemblyName System.Security`，不引原生依赖；非 Windows 退化成 `PWPL1` 明文 + 0600（并在设置页写明）。
- **登录失败即停。** 10 分钟窗口内最多 3 次，第一次等 1s 再翻倍、封顶 60s；登录 URL 把密码放在 query 里（上游形状），所以 **`oaFetch` 的错误消息一律不带 URL**，token 与密码都不进日志、不进审计、不进模型上下文。
- **隧道访客整页隐身。** 命中 `ctx.publicReq` 直接 `return false`，落到 `bridge/src/index.ts` 的兜底 404 —— 不是 403（403 等于承认这里有个功能）。单测里用 `x-test-tunnel: 1` 头复现。
- **缓存 90 天 + 手动清除。** 记录按天覆盖写 `cache.json`，超过 90 天裁掉；上游挂了就退缓存并标 `stale`；「清除本地数据」清配置/凭据/缓存但保留 `audit.jsonl`（那是「做过什么」的账，不是数据）。

**取舍：** 缓存只保 90 天 —— 更长的历史得联网取，但内网断线时仍有三个月可看；退避与去重都是「宁可挡一下」的取向，代价是连续改两次申请要等或改内容；DPAPI 走 PowerShell 子进程，每次加解密约几十毫秒，够用但不如原生调用，好处是零依赖、跨机器不出错。

**验证：** `npm run test:attendance` 三段 69 条全绿 —— `bridge/tests/attendance-unit.mjs` 37 条（日期区间/90 天上限/退避/去重键/掩码/行映射/汇总/事由 JSON/审批链往返/草稿校验）、`bridge/tests/attendance-e2e.mjs` 20 条（假 OA + 临时 `PI_WEB_STATE`：未配置 400、配置校验、登录成功只回掩码、上游 NG 401、退避 429、只查自己、缓存放 stale、上游挂了回 502、加班申请与候选、二次确认、本地校验、七字段 body、10 分钟去重、撤回要 confirm、隧道全 404、清除后配置归零而审计仍在）、`web/tests/attendance-unit.mjs` 12 条（本地日期不跟 UTC、默认 14 天跨月跨年、审批状态三种、工时/区间/事由显示）。`npm --prefix web run typecheck`（含 `i18n-check` 与 `test:viewport`）与 `npm --prefix bridge run typecheck` 均通过。

## D292 加班提醒走桥自己的定时器，当天补一次但绝不重复（用户要求 2026-11-17）

**问题：** 用户要「每周几、几点、提示内容、弹系统通知」的加班申请提醒。bridge 会重启、机器会关机、笔记本会睡眠 —— 到点那一刻不一定有人在跑定时器；反过来，补发做不好就会一天弹好几遍，那就成了骚扰。

**决定：**

- **放在考勤页的第四个页签，不在主界面弹自己的对话框。** 提醒是「这个模块的配置」，放在它旁边最不容易找不到；页签顺序：考勤记录 / 加班申请 / 提醒 / 设置。
- **桥里跑，不在页面里跑。** `bridge/src/attendance-reminder.ts` 的 `startReminderLoop` 每 30 秒问一次纯函数 `reminderDue(rule, lastFiredDate, now)`，`timer.unref()` 免得把进程吊着。页面关着、人不在电脑前也照样发。
- **当天补一次、准点不算补。** `reminderDue` 只回 `{fire, late}`：`late = now − 设定时刻 > 0`，正文在补发时加「（今天 18:00 的提醒）」，让人知道是补的而不是系统抽风。早于设定时刻不发。
- **先落盘 `lastFiredDate` 再推送。** 顺序反过来，桥中途被杀就会重启后再发一遍。发完再把实际到达数写回 `lastSent`。
- **改了时间或星期就清掉 `lastFiredDate`。** 否则用户把 18:00 改成 17:00，当天已经「发过」的标记还在，那天就再也收不到 —— 这种「我明明设了却没响」最难查。
- **关着的时候不挑毛病。** `ruleProblem` 在 `enabled: false` 时一律放行：先关掉、回头再填是正当用法。开着才要求「至少一个星期 / HH:MM / 不空的提示内容」。
- **通知走 `force`。** `Notifier.push(title, body, url, force)` 的 `force` 以前只在 payload 里传、`web/public/sw.js` 不看它（有前台页面就直接 return）。这次让 sw 认它：定时提醒不该因为「页面上正好开着」就不弹 —— 用户要的是系统通知。
- **通道状态照实说，不假装成功。** 面板直接列「通知总开关 / 推送订阅数 / 上次提醒 / 上次到达」。没订阅就明说「去 pi 设置 → 通知里打开推送」，试发时 `subscriptionCount() === 0` 回 409 而不是静默成功 —— 通知发出去没人收到，比报错更糟。
- **隧道访客照旧 404。** 提醒路由也在 `handleAttendance` 里，`ctx.publicReq` 先返回 false 落兜底。
- **星期存 ISO 编号（1=周一…7=周日），不存「周一」两个字。** 要能排序、能跨语言；`weekdayOfDate` 把 `getDay()` 的 0 映射成 7。

**取舍：** 轮询 30 秒而不是按「下一个点」算精确定时器 —— 规则的每次改动都要重排定时器，而 30 秒的误差在这个场景里没人能感知；代价是每天至多 2880 次空转（读一个 JSON），实测可以忽略。补发只限当天，不回溯昨天以前 —— 隔天提醒「上周该交加班了」没有意义。

**验证：** `bridge/tests/attendance-unit.mjs` 44 条（新增 8 条：`weekdayOfDate` 周日=7、`minutesOf`/`clockOfMinutes` 往返与坏值、`normalizeRule` 回落与夹取、`ruleProblem` 关着放行、`reminderDue` 四种不发的情形与补发偏移、`reminderBody` 补发文案、规范化后再校验）；`bridge/tests/attendance-e2e.mjs` 30 条（新增 6 条：默认关着且通道状态照实说、开着不选星期 400、规范化后读回一致、关着不挑毛病、没有通道试发 500、定时器到点只发一次且重启不补第二遍、挪时间后清掉当天标记）；`web/tests/attendance-unit.mjs` 12 条不变。i18n 增 26 个键（en/ja 齐）；`npm --prefix web run typecheck`（含 `i18n-check` 3394 键 × 3 语言、`test:viewport`）、`npm --prefix bridge run typecheck`、`npm --prefix web run build`、`npm run build:bridge` 全过；测试实例 17876 上真界面截过三张（记录/加班申请/提醒），提醒页的七个星期按钮在 1400px 下排成一行、窄容器改四列。

## D293 加班申请的默认值从「我上一次的申请」推，二级审批人只读（用户要求 2026-11-17）

**问题：** 用户比着 OA 的新建单据说三件事：时间要按日期类型给默认值（工作日 18:00–22:00、周末 09:00–18:00）；一级审批人要有默认值；二级审批人该是固定的、不可改，"应该有 api"。

**决定：**

- **时间窗由日期类型算，不记住上次。** `defaultWindow(dateKey)`：周六日 `09:00–18:00`、其余 `18:00–22:00`。换日期就整段重给、时长跟着自动算；人手动改过 `start`/`end` 就不再覆盖。理由是 OA 自己也是这个规律，而"上次用过的时间"在跨周末时几乎总是错的。
- **一级审批人的默认值取「我上一次加班申请的 idx1」。** 实测最新一条 117477 的 idx1 `江伟晨-JS0654` 与 OA 新建单据的默认值逐字一致 —— 这说明 OA 的默认值就是"上一单的那一位"，而不是某个组织架构接口。页面仍可改，选择按工号记在 `localStorage`（`pi-web-attendance:l1`），下次优先用它（前提是还在候选里）。
- **二级审批人取「上一次申请的 idx2 的完整名单」，只读展示。** `workflow_list[code]` 里 `workflow_user_name` 是这一级"应该是谁"的完整名单（`李庆-JS0031,徐凯-JS0716`），`handle_user_name` 只有真正点过的那一个。用前者，与 OA 弹窗的两枚只读框一致。删掉原来的多选 + `L2_KEY`。
- **`GET /in/roles/depart_leader_data` 只当兜底，绝不当权威。** 同一天同一 token 连取该端点，`last.depart_manager` 从 `[李庆-JS0031, 徐凯-JS0716]` 变成了 `[王俊-JS0055, 刘琳-SH0355, 姜祯-SH0654]`（连打三次都一样），说明它跟"我这个部门审批谁"不是一回事。只有在历史申请里找不到 idx2 时才用它，且面板上写明「OA 没给这级的固定审批人，提交前先在 OA 网页上确认一次」。
- **审批人名字按工号对 id，对不上就丢，绝不猜。** `parsePerson` / `resolvePeople` 逐字比对工号，名字只在没有工号时才用来兜底 —— 工号是唯一键，名字会重。
- **这些都在桥端算，前端只拿结果。** `GET /api/attendance/overtime` 直接回 `fixedL2` / `defaultL1`；页面不再自己拼"上一单"的逻辑，免得两处口径不一致。

**取舍：** 一级审批人没有真正"系统给的默认值"这件事本身有点可疑 —— 如果哪天 OA 改成按当前时间点的组织架构算，这个推断会滞后。但三个可能的来源（`apply_approvers` 空数组、`workflow/*` 全部 `权限不足`、`depart/user/c` 只有人数）都试过，历史单据目前是唯一能验证与 OA 一致的口径。二级审批人固定名单一旦变了（比如换了部门负责人），我们的展示会滞后到下一次申请 —— 这可以接受：提交那一刻 OA 自己会按最新组织架构重算，我们显示的只是"应该是谁"。

**验证：** `bridge/tests/attendance-unit.mjs` 49 条（新增 `parsePerson` 7 种切法、`resolvePeople` 五种匹配、`readDepartManagers`、`lastStepPeople`）；`bridge/tests/attendance-e2e.mjs` 30 条（假 OA 审批链补 idx2，`roles` 端点的 `last.depart_manager` **故意给一个不在候选表里的人**当路标，断言 `fixedL2` 仍是历史里的两位 —— 证明没走 roles）；`web/tests/attendance-unit.mjs` 14 条（新增 `defaultWindow`）。`sysmanage-ui` 90 项 ok。测试实例 17876 上改日期实测：11-17（周二）自动 18:00–22:00 / 4 小时，11-21（周六）自动 09:00–18:00 / 9 小时，11-18（周三）又回 18:00–22:00；一级选中上一单那位、二级两枚只读标签，`select[multiple]` 计数为 0。

## D294 问卷也进轮次缩略图：一份问卷一格，文字是「问卷概况：第一题 · 等 N 题」（用户要求 2026-11-17）

**问题：** 右侧刻度带原来只认 `item.kind === "user"`（`web/src/chat.ts` 的 `noteTurn` 与 `bridge/src/history.ts` 的 `turnIndex`），问答卡（`ask_user_question` / 旧 `question` / `questionnaire`）不进带子。用户要求：问卷也是用户输入，要进刻度表；同一份问卷的多道题只显示一次；行文用「问卷概况：…」。不做 ghost 的话，只有已经滚到过的那几张问卷能出现，整段会话的问卷位置与编号都对不上（#243 的索引本来就是全量的）。

**为什么：** 刻度带回答的是「我在这段会话里输入过什么」，问卷是模型反过来要求用户输入，和气泡一样属于用户输入；漏掉它，带子的格数就与真实交互对不上，点击跳转也少了一类落点。索引放在桥上而不是只在网页里补，是因为 ghost / 自动翻页依赖**全量**顺序，只有已载入的那几张问卷会让未载入的问卷无法点击到位。

**决定：**

- **桥上把问卷条目录进全量索引**：`turnIndex` 里 `ASK_TOOLS` 命中的工具条目 push `{ id, kind: "ask", text: 第一题标题, images: 0, questions: 题数 }`；`HistoryTurn.kind` 老条目缺省按 `user` 读（新前端 + 老桥仍然只画用户消息）。标题取 `header`，没有就依次取 `question` / `prompt` / `label`，与 `askQuestions` 同序；`questions: []` 视为没给，回退到平铺的 `question`，免得同一份问卷载入前后文字或题数对不上。
- **一份问卷一格，按工具调用去重**：同一份多题问卷只对应一个 toolCall，因此天然一条；前端另按 `toolCallId` 去重，实时卡（id `live-tool:<callId>`）在结果/回放到达被重建时，把带子上的 id 与节点一起换成新的，点它才不会指向已经 remove 的节点。
- **文案**：`askTurnLabel(title, questions)` 固定前缀「问卷概况：」；多题补「 · 等 N 题」，单题不补；没有标题时单题只说「问卷概况」、多题说「问卷概况：等 N 题」。上限按**整行** 80 字算（含前缀与「等 N 题」，`ASK_TITLE_MAX` 与桥的 `TURN_TEXT_MAX`、缩略图的 `TURN_LABEL_MAX` 对齐）：先量出前后缀占多少，剩下的留给标题与省略号，别把题数截掉。桥上送 `text` 时已折行截短，前端再折一次，两边同一句话。
- **点它回到卡**：ghost 行同样可点（#244 的自动往回翻页），已载入的悬停 / 点击给 `.qa-card` 描边（原来只给 `.msg.user .body`）。
- **「执行→计划」的 round 只数用户消息**：`app.ts` 两处 `execPlanRounds` 过滤 `turn.kind !== "ask"`，否则计划的 `listedRound` 与 `ordinal` 全错位。
- **旧会话也认**：`question` / `questionnaire` 与 `ask_user_question` 一视同仁（`isAskTool` 与桥的 `ASK_TOOLS` 对齐）；取消 / 一题没答的问卷照样占一格。

**取舍：** 刻度带的行号从此数的是「用户输入」而不是「用户消息」—— 问卷后面那条消息的「第 N 轮」会比以前大 1（点计划跨轮引用的仍是用户消息编号，两者不再完全相同，这是「问卷也是输入」的直接代价）。实时卡重建的时机依赖 `add()` / `replace()` 两条路径，别处若再重建问答卡要记得也走 `noteAskTurn`。

**验证：** `bridge/tests/history-page-unit.mjs` 断言索引里 ask 的 kind / 标题 / 题数、旧工具名、普通工具不占格、多题只有一条、空 `questions` 回退与 `prompt`/`label` 的标题顺序；`web/tests/ask-card-unit.mjs` 断言 `title` 与桥同序的回退、`askTurnLabel` 四种文案、折行与整行 80 字截断（多题仍保住「等 N 题」）；`probes/rail-ask.mjs` 验四格（2 用户 + 2 问卷，多题只占一格）、ghost 行文字、悬停亮问答卡、点 ghost 翻页到货；`npm --prefix web run typecheck`（含 i18n 与 viewport 守卫）与 `npm --prefix bridge run typecheck` 通过。

## D295 上下文里的 system 段换成可读化视图，先看数据再定形状（用户要求 2026-11-17）

**问题：** 上下文浏览器里「技能注入」那一行展开后，是一整段 `<pre>`：`<skills>` 那份 XML 有 22KB、42 条技能，描述里的引号还是 `&quot;` / `&apos;` 转义实体；「注入内容」（rules / docs / addendum / project_context）其实是原样的 Markdown，只是外面裹了一层分节标签。用户要的是能读的页面，不是代码块。

**决定：**

- **先做一次性原型再定形状**：从真 ctxlog 里抽出那次请求的 `sec:skills`，摆出四个候选（A 卡片流、B 两列紧凑表、C 折叠列表、D 按目录分组），用同样的真实数据截图给用户挑；用户挑 **B**：一屏放得下更多、名字单行省略、说明两行。
- **列表自己滚，高度 380px**：`.cx-viz { max-height: 380px; overflow: auto }`。同时要 `.cx-acc:has(.cx-viz) { max-height: none }` —— 手风琴本身有 345px 上限（`:201`），两层一起就是两条滚动条。
- **点击就地展开，不整块重画**：`skillRow` 只 toggle 自己的 `.open` 与路径行。面板每次来日志行都会 `render()` 重建整棵树，展开走重画会把 42 行列表的滚动位置甩回顶部。
- **转义实体在界面上解掉**：`decodeEntities` 解 `&quot; &apos; &amp; &lt; &gt; &nbsp;` 与数字实体（`&#39;` / `&#x27;`），其余命名实体原样保留 —— 模型看到的就是解码后的文字，界面不该跟模型不一致。
- **注入类目一律当注入**：`cat === "inject"` 下不管 kind 是 `section` 还是 `inject`（custom / branchSummary / compactionSummary）都走 Markdown，别只认 section。
- **分节标签按「唯一且配对」剥**：`ctxUnwrapSection` 只在首行是 `<tag …>` 且末尾是 `</tag>` 时剥；`<rules>…</docs>` 这种对不上的不动，避免把正文里的半截标签当成外壳。
- **project_context 按文件分界**：`<project_instructions path="…">` 换成一条粗体路径行，而不是 `##` 标题 —— AGENTS.md 自己就有 `##` / `###`，用标题会和文件内层级打架（先用 `##` 试过，h2 里叠出 `## Worktree 工作流`）。
- **保留原文出口**：「可视化 / 原文」开关放在类目**头行**（不展开类目也看得见），默认可视化，切到原文就是原来那段 `<pre>`；技能目录解析不出条目时这一行自动退回原文。
- **解析与渲染都按内容缓存**：一个 `memo(cap)` 小表按 id + 内容缓存三样东西（技能目录、注入段 Markdown、Markdown 节点）。日志很密，22KB XML 每行重解析一次会卡；行上的摘要与展开正文共用同一份转换结果，预览行不能每次重画都重算。
- **顺手删掉 `statsCard` 没用到的 `token` 入参**：改这块时 delta lint 会把它报成新错误，不删每次都要绕。

**取舍：** 代价是多一个纯函数模块（`web/src/context-viz.ts`）和两套样式；技能说明两行 clamp 意味着长描述（最长 1053 字）默认看不全，要靠点开或过滤。没选「按目录分组」（D）—— 42 条里 34 条来自同一个目录，分组头一天就把列表撑开了。

**验证：** `node --test web/tests/context-unit.mjs` 新增 5 组用例（实体解码、`<skills>` 解析去重、标签剥除的配对判定、注入段转 Markdown 后每份 AGENTS.md 一条分界行）；`npm --prefix web run typecheck`（tsc + i18n-check 3329 键 × 3 语 + viewport 守卫）通过，`context` / `layout` / `rules` 三个单测文件 31 过。界面用一次性 harness（真 ctxlog 的那次请求 + 全部 body 行，Vite 起在 5191）在 Chromium 里核过：42 行、`.cx-viz` 计算高度 380 / 可滚、手风琴 `max-height: none`、行展开解 clamp 并显示 `SKILL.md` 路径、过滤 `hyperframes` → `10 / 42 个技能`、切原文恢复 XML、`sec:rules` 出 `UL/LI/CODE`、窄容器（root 573px）技能行转单列、页面无 console 错误。harness 的三个文件用完即删，不进 main。

## D296 测试的监听端口交给系统分配，不再在代码里记账（2026-11-17）

**问题：** 135 个 `bridge/tests/*.mjs` 里有两个独立缺陷，叠在一起的表现都是「E2E 很慢、跑不完」。其一：**57 个文件把监听端口写死**（7880…7927 这些连号），而这台机器用 `netsh interface ipv4 show excludedportrange protocol=tcp` 能报出 7877–7976、7977–8076、8077–8176、8336–8435、8436–8535、8536–8635 七段保留区 —— 落在里面的 `listen` 拿到的是 **EACCES**（不是寻常的 EADDRINUSE），桥起不来、`/healthz` 永远不通，测试于是先空转 `100 × 200ms` 等它，20 秒后抛 `fetch failed`。所以这些用例不是慢，是**在这台机器上永远过不了**；报错长得不像端口问题，没人往那儿想。其二：`probes/` 里还留着一份手写的 `freePort(start)`（从给定基数往后扫），跟新做法两套实现。

**决定：** 测试（`bridge/tests/`、`web/tests/`）不再声明端口的默认值，改为**问系统要**：新增 `tools/free-port.mjs` 的 `freePort()`（`net.createServer().listen(0)` 拿到内核分配的空闲端口再关掉），64 个文件统一写成 `const PORT = Number(process.env.<X>_PORT ?? (await freePort()));`，`<X>_PORT` 仍可钉死（两份并行、复现某个端口相关的 bug 时需要）。理由：系统分配的端口天然避开 Windows 的保留块与服务占用，也不会撞上上个用例留下的 `TIME_WAIT`；文件名里那个「端口的归属账本」（7887 是 history-paths、7888 是 continue…）同时删掉，因为它维护不动、也解释不了保留区。

- **例外：`bridge/tests/e2e.mjs` 保持固定 7867。** 它不自己起桥，连的是「人先开好的那一份」实例；把端口交给系统只会连到没人开的端口上。`dbg*.mjs` / `browser.mjs` / `model-check.mjs` 同理，连的也是活着的实例。
- **`hint-spawn.mjs` 里那份本地 `freePort` 副本删掉**，改从 `tools/free-port.mjs` 引 —— 同一概念不留两套实现。
- **加守卫 `tools/port-guard.mjs`（`npm run test:ports`）**：扫 `bridge/tests/` 与 `web/tests/`，出现「端口常量 / `process.env.X ?? 数字` 兜底 / 直接 `.listen(数字)` / `startBridge({ port: 数字 })` / `PI_*_PORT: "数字"`」就报错，行尾写 `// port-guard: allow` 加理由才放行（全库只剩 `peer-e2e.mjs` 一处：它要**故意**和 B 抢同一个端口，验「另一份在跑」的退出码 2）。`probes/` 与 `port: 993` 这类纯数据不扫，宁缺勿滥。

**取舍：** 端口不再可预测，日志里每次不同，靠终端里打印的那行 `listening` 找；想让用例复现「某个端口上的问题」得自己带 `<X>_PORT`。`probes/` 那 80 多个写死端口的探针**这次没管**（它们是手工脚本，逻辑上「先连活着的实例还是自己起一份」各不相同，得逐个读），也就仍然在保留区上跑不起来 —— 文档里的 `PI_WEB_PORT=` 覆盖对它们照旧有效，属于下一步。

**验证：** 迁移前实测 7911 / 7901 / 7902 / 7903 / 7893 / 7891 六个端口 `listen` 全报 `EACCES`，7480 / 7481 正常。迁移后 `node bridge/tests/git-history-ui.mjs`（原 7927）与 `node bridge/tests/sysmanage-ui.mjs`（原 7918）**从「起不来」变成全绿**（56 s / 66 s）。`npm run build` 通过；`npm run test:ports` 扫 166 个文件报 ok。

## D297 UI 测试里自己设的超时定时器，命中之后必须 `clearTimeout`（2026-11-17）

**问题：** `bridge/tests/skill-view-ui.mjs` 整程 **65 s**，而它真正在干活只有 5 s —— 首条日志与末条日志相差 5 秒，进程却再挂 55 秒才退。原因是自己写的「等 create 回执」这类 promise 里 `setTimeout(() => reject(new Error("create timeout")), 60000)` 没有配对的 `clearTimeout`：promise 早早就 resolve 了，可那个 60 s 的 pending 定时器还挂在事件循环上，node 只能等它到期才退。同一写法在 `browser.mjs` / `model-check.mjs` / `session-flags.mjs` 里各有一份；`e2e.mjs` 的 `waitFor()` 队列是「命中就从 `waiters` 里摘掉」，可定时器同样没清。

**决定：** 一律 `const timeout = setTimeout(...)` + 在 resolve 与 reject 两路都 `clearTimeout(timeout)`（`ws.on("open")` 之后才建，避免握手失败时先报别的错）；`e2e.mjs` 的 `waitFor` 在命中分支里 `clearTimeout(w.timer)`。**不是**把超时时间调小 —— 病症是「该清不清」，缩短只会把真正的等待也一起砍掉。

**取舍：** 每个 ws 辅助函数多两行样板；换来的是测试进程的存活时间等于它真正干活的时间，CI 里按「整条命令跑多久」看回归也不会再有这种隐形尾巴。

**验证：** 只删 `skill-view-ui.mjs:137` 那一行的副本（`.scratch/skill-ui-fast.mjs`）跑出 **11 s**；四个文件都改完后 `node bridge/tests/skill-view-ui.mjs` 稳定在 **17.5–19 s**（在 main 上是 65–67 s），末条日志与进程退出同一秒，连跑两次一致。刚 `npm run build` 完的第一次仍要 ~60 s —— 那是另一个成本：桥启动时 `pinAll()` 要扫 452 个会话，冷缓存下几十秒才回 `/healthz`，这次没动它。

## D298 端到端测试按 CPU 并发跑，一个测试一份桥（2026-11-17）

**问题：** `bridge/tests` 有 131 个端到端用例，每个都自己 `spawn` 一份 `bridge/dist/index.js`、自己开一个 Chromium。串行跑一遍，把各用例耗时相加是 **2704 s（45 分钟）**，而这台机器有 12 个核 —— 绝大部分时间是在等各自的进程起来、等页面加载，CPU 基本空着。D296 修好端口、D297 修好定时器之后，单个用例已经快了不少，但「一条命令跑完整个套件」仍然是件没法在改完东西后随手做的事，实际结果就是没人跑。

**决定：** 新增 `tools/run-tests.mjs`，`npm run test:all` 就是它。

- **并发**：默认 `min(6, CPU-1)` 路；`--jobs N` 调、`--only a,b` 只跑几个、`--skip` 跳过、`--timeout <秒>` 改单测上限、`--list` 先看计划、`--json` 把逐条耗时写进 `.scratch/tests/results.json`。
- **一个用例一份桥**：不给多个用例共享一份长驻桥。`probes/run-all.mjs` 早就实测过共享一个 Chromium 反而更慢（8 路 62–64 s vs 各起各的 58 s），浏览器进程本身成了争用点；桥同理，而且共享桥还要解决会话/状态隔离，收益不抵复杂度。
- **每份桥一个自己的内网通端口**：`PI_PEER_PORT` 由 `freePort()` 给。桥默认都去绑 `0.0.0.0:7865`，并发时除了满屏 `EADDRINUSE`，还真的会让 `boot-queue-merge` 这类用例挂掉（实测过）。测试自己设了 `PI_PEER` / `PI_PEER_PORT` 的照旧覆盖。
- **必须串行的 7 个**写进 `SERIAL` 表并逐条写理由：`rename-check`、`session-dirs`（读写真的 `~/.pi/agent`）、`ext-manager`（netsh / sc.exe 看本机服务）、`sysmanage-ui`（系统管理页读真实磁盘与进程数）、`peer-e2e` / `peer-ui` / `peer-history`（同机多份内网通会互相发现、抢好友关系）。它们排在并行波之后单独跑。
- **默认不跑的**：`e2e`、`browser`、`model-check`（连的是手工起在 7867 的那份实例，还要 `.scratch/test-state` 的口令文件，不是自起桥）、`dbg*`（一次性脚本）。
- **node flag 别另维护一份**：从 `package.json` 的 scripts 里抽「文件 → `node --xxx` 参数」；抽到现装 node 不认的 flag 就先问 `node <flag> -e ""`，不认就丢掉并提示（`--experimental-transform-types` 在 node 26 已被移除，而 `test:context` 还写着它，照抄会让一个好用例 0.1 秒就死）。
- **超时杀整棵进程树**：`child.kill()` 只杀直接子进程，用例拉起的桥、真 pi、Chromium 都是孙进程，会留在那儿继续吃 CPU、占端口，把后跑的用例成片挤成 `timeout waiting for bridge up` —— 看着像「并行让测试变慢」，其实是没清干净。Windows 走 `taskkill /PID <pid> /T /F`，POSIX 用 `detached` 起的进程组 `kill(-pid)`。杀完最多再等 5 秒 —— 用例被杀了，它拉起的桥可能还拿着 stdout 管道，`close` 永远不来，不放这个兜底的话跑套件的进程会被一个用例拖死。
- **输出**：每个用例的完整输出落 `.scratch/tests/<name>.log`，终端一行一个结果（`ok [ 12/129] ask-ui 116.6s`），最后打通过数与总用时、最慢五个、失败用例的尾巴。

**取舍：** 并发会让慢用例更慢（`session-flags` 要跑真实的 pi turn，4 路时 219.5 s、6 路时 201 s），所以拿它看「某个用例变慢没」要 `--jobs 1`；并发也让个别用例偶发挂（`scratch-ui` 第一遍挂、第二遍过），所以失败要用 `--jobs 1 --only <name>` 复跑一次再判断是不是回归。**跑套件的机器要空着**：各用例等 `/healthz` 都有上限（十来秒），机器一挤就成片变成 `timeout waiting for bridge up` —— 我自己一边跑全量一边插队单跑三个用例，那次 6 路就掉到 85/129、761.8 s，失败清一色是这句。有 14 个用例在这台机器上本来就跑不过（端口原本落在 Windows 保留区、或断言早就对不上实际行为），跑套件会一直看到它们 —— 别把「套件不是全绿」当成这次改动弄坏的。

**验证：** 4 路全量 **706.8 s**、6 路全量 **633.5 s**（各用例耗时之和 2704.2 s，即串行下限），当时 129 个用例里 113 个通过（合并 main 之后 bridge/tests 有 133 个，多出考勤与 ws 排序那四个，数字没重测）。18 个失败逐个查过：串行（`--jobs 1`）复跑仍有 17 个挂 —— 其中端口原本落在保留区（7877–8635）的那批，main 上压根没在这台机器跑通过；`manage-check`（原端口 7876，不在保留区）用 `git show origin/main:bridge/tests/manage-check.mjs` 的原文件复跑，失败文本一字不差。剩下的 `context-log-unit` 是 node 26 已移除 `--experimental-transform-types`（顺手改成 `node --test`）、`browser` / `model-check` 要手工起的实例（改成默认不跑）。真正被并发碰到的只有 `boot-queue-merge`（`EADDRINUSE 0.0.0.0:7865`）和 `exec-child-subscribe`，加上 `PI_PEER_PORT` 后 `--jobs 1` 复跑都过。

**这个数是量级不是常数**：同一份代码在机器上同时开着别的 pi / lens / 浏览器进程时，6 路全量会掉到 **889.8 s、93/129**，失败清一色是各用例自带的『等桥起来』超时（那些等待只有十来秒，机器一挤就到点）——并发本身没错，错在机器不空。所以拿这个数对外说「快了多少」时说 4–6 倍墙钟（633–890 s 对 2704 s 的耗时和），别说成一个准确值；要稳定复现单测快慢就用 `--jobs 1`。

## D299 内网通 v2 照 QQ 的聊天模型补四片：会话元数据、消息状态机、控制面（撤回/引用/输入中）、在线与通知（2026-11-18）

**问题：** 内网通的传输层已经够用（组播发现 + HTTP 直达 + Outbox 补投），但**聊天模型几乎是空的**：一条消息就是 `{text}`（`peer/src/history.ts:21`），一个会话只是「历史目录里的一个 jsonl 文件名」，会话列表就是按最后一条消息时间倒排（`peer/src/history.ts:150`）。于是用户在页面上看不到：有多少条没读、哪条还在发、发的失败了能不能原地重发、对方是不是正在打字、发错了能不能撤回。这些不是「界面没画」，是**数据里没有**——要补就得动 `Entry`、`/threads`、`/peer/inbox` 三处。

**决定：**

- **拿 QQ 当参照系，但只抄它的分层，不抄它的体积。** QQ 把每件事都做成了独立管理器（`nt::im_core::MsgUnreadCntMgr` / `MsgRecallMgr` / `IRecentContactTopMgr` / `MsgDraftMgr` / `AioInputStateWorker`），而不是往消息结构里堆字段。我们照这个分层拆成四片：P1 会话元数据（`threads.json`）+ 未读，P2 `seq` + 三态 + 原 id 重发，P3 `kind:"recall"` + `replyTo` + typing 心跳，P4 `away` 状态 + 通知。方案与逐片验收见 `docs/PLAN-peer-qq.md`。
- **撤回不删原消息，追加一条灰条。** 这是 QQ 的做法（`GrayTipsMsgElem` + `GrayTipMsgManager`，文案「X 撤回了一条消息」/「原消息已被撤回」），也是唯一跟 JSONL append-only 兼容的做法：历史文件里留着原文，渲染层不显示，撤回本身是第三条记录。删除式撤回会让「对端离线时缓存的那份」和「我这份」永远对不齐。
- **未读水位用 `{at, id}` 双键，不用单个时间戳。** `uuidv7` 同一毫秒内剩余位是随机的（`peer/src/messages.ts:14` 自己写了），单键会让同一毫秒里后到的那条永远算未读。判定用字典序，纯本地比较，对时钟漂移只影响本机。
- **状态派生、不落盘。** 「发送中」由 `outbox.pendingFor(peerId)` 现算，「已送达 / 失败」仍由既有 receipt entry 折出来（`peer/src/index.ts:31`）。历史文件格式不动，旧版本读新文件不会炸；`Entry` 只加可选字段。
- **`PROTO` 保持 1。** 新 `kind`（`recall`、`typing`）与新增字段都是加性的，旧对端对未知 kind 回 `400 {retryable:false}` 直接丢掉（`peer/src/messages.ts:124`），这正是 D234 用过的「混合版本尽力而为」。代价要认：**撤回只在新版之间生效**，旧版看到的是被撤回的原消息。
- **逆向的边界写清楚。** QQ 7.0.3 的 `application.asar` 1436 个文件逐文件加密（`isByteCodeShell: true`），渲染层代码静态不可得；fuses 上 `EnableNodeCliInspectArguments` / `EnableNodeOptionsEnvironmentVariable` 都写着 enabled，但实测 `--remote-debugging-port`、`NODE_OPTIONS=--require`、`NODE_OPTIONS=--inspect` **三条全都不生效**（端口不监听、hook 不执行）。所以这次没有「QQ 的明文代码」可引，能引的是 `wrapper.node` 里没剥掉的 `nt::im_core::*` 符号表（26 373 个 demangle 名）+ 同文件里的灰条文案 + 运行中 QQ 的会话列表截图。**这不是「逆完了」，是「能证到的这一层」**——把它写进方案，是为了后面谁说「QQ 明明是这样」时能指出证据来源。

**取舍：** 不抄 QQ 的元素列表（`*MsgElem`）、云端漫游（`IRoamMsgManager`）与群——我们没有富媒体渲染链、没有中心存储，`GLOSSARY.md` 也把群排在 v1.1。`seq` 只用于排序与「本机发现缺号时提示」，因为 QQ 的 `MsgSeqPullApi` 是向服务端要漏掉的消息，我们无服务端可问。混跑期间撤回能力不对称，这是不升 `PROTO` 的固定成本。

**验证：** 已实现（2026-11-18，四片合成一个 PR）。`npm run build` 过；`node bridge/tests/peer-e2e.mjs` 全过，其中这一段是新加的：

```
ok 未读按对方发来的条数算（3）
ok 消息带会话内单调的 seq
ok 已读水位是 {at,id} 双键，打过之后只算新来的
ok 置顶 / 静音 / 草稿只在本机生效，置顶排最前
ok 输入中 3 秒窗口（心跳不落盘）
ok 撤回是追加一条记录、原文留在文件里，重复撤回被拒
ok 超过 2 分钟的撤回被拒（400 + 文案）
ok 重发复用原 id：两边都还是一条
ok 送达状态由 receipt 折叠出来（state=delivered）
ok 本机状态（online/away）进 /status 与在线表
```

`node bridge/tests/peer-history.mjs` 与 `node bridge/tests/peer-ui.mjs` 也全过；peer-ui 新加了两条界面断言（未读徽标在头像上、静音会话只画不带数字的小圆点）。顺带修掉一个一直在的洞：**`/messages` 以前从来没有把 receipt 折叠回消息**，所以页面上的「已送达 / 发送失败」其实从来没显示过 —— `ack` 字段只存在于 receipt 那一行，而那一行被前端跳过了。现在折叠在 `peer/src/history.ts` 的 `foldEntries()` 里做。

## D300 文件不再要求好友：好友只决定「在不在好友列表里」，不再是权限（2026-11-18）

**问题：** 文件通道从 D106 起有三道「好友闸」（发端 `POST /files/send`、剪贴板 `POST /files/upload`、收端 `files.begin()`），理由是「写盘不可撤销，文字谁都能发、文件不行」。但用起来是这样：局域网里想给同事丢一个安装包、或给同一台机器的另一份实例传一个文件，都得先走 `friend-request` → `friend-accept` 两步，对方还得在线点一次「接受」。而好友关系现在的实际作用是通讯录分组（D234 之后 quick / 附近的人 都能聊），把它同时当文件权限，等于「为了传一个文件先建立一段关系」。

**决定：**

- **拆掉三道闸**：`peer/src/http.ts` 的 `/files/send`、`/files/upload` 与 `peer/src/files.ts` 的 `begin()` 都不再看 `relations.isFriend()`。好友关系此后只影响「通讯录里分在哪个组、有没有那颗 ★ / 删除好友」，**没有任何权限含义**。
- **保留真正的约束**（它们与好友无关，也不该被一起拆掉）：来源校验 `messages.verify()`（报文里的 `from` 必须落在对端记着的 IP 集合里）、token 只能由收方 `begin` 签发（没有 token 写不进盘）、`pauseFiles` 开关（默认关，打开后对所有人 503）、收件盘余量（留 5 GB 且留 10%）、单文件与分块上限、`end` 核大小与 sha256。
- **UI 跟着改判据**：联系人详情、会话右键菜单、联系人右键菜单里的「传文件」从「是好友」改成「**对方在线**」（文件是点对点直连，离线发不了）；离线时按钮禁用并提示「对方已离线，等他上线再试」。同时把「加为好友（可传文件）」这颗按钮的文案改回「加为好友」——它不再承诺文件权限。
- **不新增「仅好友可传文件」的开关**：用户要的是权限无差别，多一个开关就多一套状态、多一处要解释的界面。真要挡人就用已有的「暂停收文件」。
- **协议不动**：文件通道的字段一个没改、`PROTO` 仍是 1。

**为什么：**

- 局域网里「能看见、能聊」本来就已经是 D234 的默认状态（附近的人、快捷联系人都能直接发文字）；把文件单独留一道好友闸，挡不住有意的人（加一下好友就行），只挡住顺手传个文件的自己人。
- 「好友」这个词在界面上已经承载了收藏、分组、待接受三种语义，再给它加一层「文件权限」，用户看到的「不是好友」就同时意味着三件不同的事。

**取舍（要认）：** 局域网里任何能被发现的人现在都能往我的**收件目录**写文件（不是任意路径）。缓解有三层：收件目录是专用目录且按配额拒收、`pauseFiles` 可以在不想收的时候整体关上、每个文件仍然要经过 token + 来源校验。跨版本混跑时这一条不对称：**新版发给旧版仍然会被旧版 403**（旧版自己的闸门），我们不为此做协商——这与 D234 的「混合版本尽力而为」一致。

**验证：** `node bridge/tests/peer-e2e.mjs` 里原本断言「非好友发文件被拒（403）」，改成「C 跟 A 没有任何关系记录，照样收发文件，哈希一致」；`node bridge/tests/peer-ui.mjs` 三条界面断言同步改成「已 quick 的人也有传文件」「在线陌生人也有传文件」「离线的人连传文件一起禁用」。

## D301 内网通：文件卡给「下载 / 预览」两颗按钮，未读件数挂在顶栏按钮上并走系统提示（2026-11-18）

> 2026-11-18 晚：其中「预览走本工程的预览面板」已被 **D302** 取代 —— 现在预览是内网通页面自己的 dialog。徽标、系统提示、下载按钮不变。

**问题：** 收文件之后页面上只有一颗「另存」链接（`<a target=_blank>`），点卡片是「用本机程序打开」——想看一份 `.md` / `.diff` / 图片，得先下载再用别的程序打开，而这个工程本身就有预览面板。另一头：内网通的未读只有打开弹层才看得见，人待在主界面里时不知道有没有人找他。

**决定：**

- **收到的文件给两颗按钮**：`下载`（`/api/peer/file?id=`，带 `download`，强制落盘）与 `预览`。点卡片本身仍是 D209 的「用本机程序打开」，那颗按钮的位置不变。
- **「预览」走本工程的预览面板，不在内网通页面里另造一个预览器**：内网通页面 `POST /api/peer/preview { id }` → 桥用既有 `peer.filePath(id)` 把 id 解成收件目录里的绝对路径 → 通过 WS 广播 `{type:"peer.preview", path}` → 主页面 `onPeerPreview()` 关掉弹层、调 `App.openPreview(path)`。绝对路径只由桥自己解析，客户端递不上任意路径。收件箱本来就是 D209 列进 `previewPins()` 的可信预览根，所以不用另开信任口子。
- **未读件数画在顶栏「🌐 内网通」那颗按钮上**：主页面每 12 秒轮询一次 `/api/peer/threads` 求和（未读是**服务端**算的，`threads.json` 里的水位），徽标显示 `N` / `99+`。清空仍然只由内网通页面打开会话时打水位完成 —— 主页面不记第二份状态。
- **系统提示（两条路，互不重叠）**：主页面在「未读增加且不是自己发的、不是静音、没开免打扰、内网通弹层没开着（或页面不可见）」时 `new Notification()`；弹层关着 / 页面没开时由 bridge 的 `Notifier` 走 Web Push（D299 的 P4）。内网通页面自己那份通知**只在它被单独打开**（`window.self === window.top`）时才发，嵌在弹层里时交给主页面，避免同一件事弹两条。
- **通知权限借着一次用户手势问**：第一次点「🌐 内网通」时如果 `Notification.permission === "default"`，就地 `requestPermission()`；问过就不再问。开关沿用内网通设置页那颗「桌面通知」（`localStorage["peer.notify"]`），两边共用一份。

**取舍：** 主页面多了一条 12 秒的轮询（与内网通页面自己那条 4 秒的分开，因为弹层关掉之后只剩主页面在看）；「预览」在没有打开会话时无法显示（预览面板属于会话，`openPreview()` 要 sessionId），那种情况主页面给一句 notice 而不是假装打开。徽标只显示总件数，不区分是哪个会话——会话内的未读仍在列表里。

**验证：** `peer-e2e` / `peer-ui` / `peer-history` 全过；`npm run build`、`npm run typecheck`（i18n 与 viewport 守卫）通过。人工：在测试实例里从「同事2」（非好友）发一个 `.txt` 过来，卡片出现「下载 / 预览」两颗按钮；点「预览」主页面关掉弹层并在预览面板里打开该文件（`/api/peer/preview` 回 `{ok:true, pages:1}`）；把内网通弹层关掉后再收消息，顶栏按钮上出现件数徽标。

**复审修正（同日，用户报的两个 bug）：**

1. **自己发出去的文件点不开预览**：`files.storedPath(id)` 只登记收到的文件，自己发的（也就是原路径那份）不在索引里 → `/files/meta` 404 → 预览必然失败。改成 `send()` 时也把 `{ id → 原路径 }` 写进同一份索引（两个方向共用），并在 `/api/peer/preview` 里把解析出来的路径记进一个 30 分钟 / 20 条的短时集合，交给 `previewPins()` —— 自己发的文件通常在桌面或下载目录，既不在收件箱也不在会话目录，没有这一步 `/api/preview` 的 D50 信任检查会拒。同时自己发的卡片也长出了 `预览 / 打开` 两颗按钮，点卡片 = 预览。
2. **发完文件不滚到底**：`renderMain()` 每次重画都会用「刚才停在哪」重算 `stickBottom`，把发送方设的意图盖掉；而且 `renderChat()` 在**输入框挂进 DOM 之前**就设 `scrollTop`，量到的高度比最终少一截。改成给发送动作一个 `forceBottom` 意图（重画时优先于位置判断），并把贴底放到输入框挂上之后、再补一帧 `requestAnimationFrame`。实测同一场景 `距底差` 从 938px / 212px 变成 0px。

## D302 内网通文件卡：预览改成这页自己的 dialog、按钮改「打开所在位置」、会话列可折叠，消息列不再平滑滚动（2026-11-18）

**问题（用户当场报的四条）：** ① 发完文件聊天不回到底；② 「预览」借的是主界面的预览面板 —— 那个要一个打开的会话，还会把内网通弹层关掉；③ 「打开」交给系统默认程序，用户要的是**打开文件所在位置**；④ 每发一条消息，滚动条都从顶上往下滑一遍。

**决定：**

- **预览 = 内网通页面自己的 dialog**（`.modal.preview`，复用既有 `.scrim` / `.modal` 骨架）：图片 `<img>`、PDF `<iframe>`、文本类 `<pre>`（按 mime 或后缀判，上限 2 MB），其余说清楚「点下载」。**删掉** D301 那条 `/api/peer/preview` → WS `peer.preview` → 主页面 `App.openPreview()` 的路，连同桥里的 `peerPreviewPaths` 短时集合与 `app.ts` 的 `peer.preview` 分支。理由：那条路要「有一个打开的会话」（预览面板属于会话），还要 `closeSheet()` 把弹层关掉 —— 为了看一张截图把整个弹层拆了不值当；而且它把内容渲染在另一个窗口里，用户点完还要自己找。
- **「打开」→「打开所在位置」**：新路由 `POST /api/peer/reveal { id }`，桥用 `peer.filePath(id)` 解析路径后调既有的 `revealInFileManager()`（macOS `open -R` 在 Finder 里选中、Windows `explorer /select,`、Linux `xdg-open <目录>`）。自己发的指向**原文件**、收到的指向收件箱里那份；页面仍然只递 id，递不上任意路径。点卡片本身也统一成「预览」。
- **会话列表可折叠**：列表头一颗「收起」，折叠后 `#list` 不进 DOM、`app[data-nolist="1"]` 把整块宽度让给对话（复用「我」页那套机制），顶栏出现「展开」按钮。状态记 `localStorage["peer.listCollapsed"]`，跨刷新保留。窄屏（单栏）本来就只显示对话，这颗按钮由容器查询藏掉。
- **消息列去掉 `scroll-behavior: smooth`**：整列每次重画都是 `replaceChildren()` 重建，平滑滚动会把「发完贴底」演成从顶上滑下来 —— 那正是用户看到的「滚动条滚下来」。改成 `auto`（瞬时），配合 D301 复审里的 `forceBottom`：发送动作明确要求贴底，重画时优先于「刚才停在哪」。

**取舍：**

- 预览不再是「本工程的预览面板」，所以没有 md 渲染、对照、译文这些；它只回答「这份文件里是什么」。要看渲染版就点「下载」再用主界面打开。
- 文本预览 2 MB 上限、二进制/视频/未知类型一律给「点下载」：在 iframe 里塞一个 400 MB 视频只会把内网通页面拖死。
- `/api/peer/open`（交给系统默认程序）不再被页面调用，路由保留 —— `open_file` 这类 pi 工具将来可能要用，删了还得再加回来。
- 折叠是「整块让位」而不是「窄成一条」：内网通弹层本来就窄，留一条 40 px 的图标条只会挤占对话。

**验证：** `peer-e2e` / `peer-ui` / `peer-history` 全过，`npm run build`、`npm run typecheck`（i18n 3472 键 ×3 + viewport 守卫）通过。真机实测（无头浏览器打测试实例）：

```
列表头按钮: 1 收起会话列表
折叠后 list 可见: false | data-nolist: 1
顶栏展开按钮: 1 展开会话列表
展开后 list 可见: true
卡片出现耗时 ~216ms
距底差: 0px（发之前 0px）
卡片按钮: [ '预览', '打开所在位置' ]
预览 dialog: 1 | 标题: 自己发的-预览测试.md
预览正文前 40 字: # 自己的文件  这是我自己发出去的文件，应该能直接预览。
Esc 之后 dialog: 0
图片 dialog: 1
```

**对 D301 的取代关系：** D301 的「预览走本工程的预览面板」这一条作废（改为本条）；D301 的徽标 / 系统提示 / 下载按钮都不变。

## D303 内网通预览支持 Excel（**复用本工程的表格浮窗**）；自己的名字能改，好友能改备注名（2026-11-18）

**问题（用户两条）：** ① 主界面有 Excel 的查看/编辑，但内网通的预览对 `.xlsx` 只说「不支持」；PDF、代码这些也要能在这边和那边都打开。② 没法改自己的名字，也没法给好友起个自己看得懂的名字。

**第一次做错了（同日复审推翻）：** 我先在内网通页面里手写了一块只读网格（自己调 `/api/sheet/window` 画表）。用户一眼看出来「预览功能不全，是不是你自己重写了？应该直接调用本工程的 Excel 的打开的逻辑复用」。**这条是对的**：同一份表在两个地方长得不一样、能做的事不一样，是纯亏。

**决定：**

- **Excel 直接开本工程那扇表格浮窗**（`web/src/sheet/dialog.ts` 的 `SheetDialog`，D166 那一套）。内网通页面 `import` 同一个组件，凭据由新路由 `POST /api/peer/sheet { id }` 现发（桥解析路径 + stat，调既有 `registerFileGrant()`；内网通页面没有会话，拿不到 `/api/preview` 的 grant）。拿到 token 之后：看、查找、改格子、合并/插删行列/排序、页面视图、用默认程序打开、在文件夹中显示、下载 —— **全是同一份代码**。差别只有两处：`scale` 恒为 1（这页没有界面缩放）、不给 `onQuote`（这里没有「引用给 pi」的输入框，那一格按钮自己会隐藏）。
- **把表格浮窗的样式抽成 `web/src/sheet/sheet.css`**：它原来在 `styles.css` 里（478 行、全是 `.sd-*`、不依赖主题 token，纸张永远浅色）。内网通是独立文档（`peer.html`），不抽出来就只能整份 `styles.css` 一起加载。两个入口各 import 一次，Vite 自动打成共享 chunk（`dialog-*.css`，`index.html` 与 `peer.html` 都链到同一份）。
- **`.csv` 仍然按文本看**（主界面也是这么分的，D166），图片 / PDF / 代码继续走弹窗里的 `<img>` / `<iframe>` / `<pre>`。
- **名字两处都能改**：
  - **自己的名字**：`POST /config { nickname }`（≤40 字、去空白、空名字 400），改完立刻 `discovery.announce()` 重播一次；照旧落 `config.json`。
  - **好友的备注名**：`POST /friend { action:"rename", name }` → `Relations.rename()`，只写本机记录；**不告诉对方、也不被对方的 announce 覆盖**（对方在线表里的昵称变了，通讯录里这条备注照旧）。
- **UI**：「我」页 hero 下面一行输入 + 保存；联系人详情一颗「改备注名」（弹窗，Enter 保存）；会话右键与联系人右键各一条。

**取舍：** 表格浮窗在内网通页面里也是「浮窗」而不是模态 —— 拖拽范围被 iframe 框住（弹层多大它就多大）；它和主界面共用 `localStorage` 的 `pi.sheetGeom`，所以窗口大小在两边是同一份记忆。备注名只在本机，两边可能显示不同名字，这正是「备注」的语义。

**验证：** `peer-e2e` 新增三段（改名广播可见、空名字 400、备注名只在本机且不被覆盖），`peer-ui` / `peer-history` 全过，`npm run build`、`npm run typecheck`（i18n 3481 键 ×3 + viewport 守卫）通过。真机实测（无头浏览器打测试实例）：

```
浮窗 .sd: 1
标题: 📊 报价单-预览测试.xlsx  /tmp/报价单-预览测试.xlsx  ✕
工具条按钮: [ '编辑', '保存', '引用给 pi', '生成页面视图', '用默认程序打开', '📂 在文件夹中显示', '下载' ]
格子样例: [ '项目', '单价', '数量', '网线', '12.5', '4' ]
公式栏: A2 | 网线
底部: 报价 / 说明 | 12 格·全量显示 · 只读 · 4 行×3 列 · 100% | 用默认程序打开 · 在文件夹中显示 · 下载
```

（「只读」是浮窗底栏的默认态，点右上角「编辑」就进编辑模式 —— 与主界面一字不差，因为它就是同一个组件。）

## D304 内网通的选文件对话框：路径框 + 跳转、每行「预览 / 选择」，照本工程文件管理器的做法（2026-11-18）

**问题：** 选文件的对话框只有「点文件夹进入、点文件名选中」和侧栏几个常用位置。要发一份在深目录里的文件，得一层层点进去；发之前也没法看一眼选对没选对（只能发出去再说）。

**决定（照 `web/src/dirpicker.ts` 的 D153「跳到路径」那一套）：**

- **路径框 + 跳转**：选择器顶部一行输入，回车或点「跳转」。指向**文件夹**就直接进去；指向**文件**就进它的父目录、把那一行标成 `.hit` 并**选中**它（与文件管理器里的「定位不是打开」一致，区别是这里选中的意义就是「准备发给对方」，所以顺手把 `发送` 也解禁）。找不到就地报红 + toast，列表不动。
- **每行两颗按钮**：`预览` 与 `选择`。文件夹行不出这两颗（点行就是进入）。整个文件列表的摘要与 `发送` 按钮逻辑不变。
- **行内预览要能看**：新路由 `GET /fs/raw?path=`（peer）+ `GET /api/peer/fs/raw`（bridge 透传）—— 回环、单文件 ≤64 MB、`inline`。它不比既有能力多开什么口子：`/files/send` 本来就能把任意本机路径发出去。
  拿到字节后复用 D302 的弹窗：图片 `<img>`、PDF `<iframe>`、文本/代码 `<pre>`；**Excel 走 D303 那扇真浮窗** —— 为此 `POST /api/peer/sheet` 增加 `{ path }` 入口（`{ id }` 仍然按内网通消息解析），桥侧同一套 `registerFileGrant()`。
- **Esc 的层级修正**：以前在预览里按 Esc 会把下面整个选择器一起关掉（弹窗的捕获监听先清空 `#layer`，冒泡到全局监听时它已经空了 → 关选择器）。现在弹窗的监听 `stopPropagation()`，全局那条也改成「有弹层先关弹层，没有才关选择器」。

**取舍：** 路径框不做补全（文件管理器也没有）；跳转失败不清空当前列表（照 D153）。行内预览受 2 MB 文本上限约束（大文件提示「点下载」）。`/fs/raw` 与 `/api/peer/fs` 同一道门（只回环），公网隧道一律 403。

**验证：** `peer-e2e` / `peer-ui` / `peer-history` 全过，`npm run build`、`npm run typecheck`（i18n 3485 键 ×3 + viewport 守卫）通过。真机实测（无头浏览器打测试实例）：

```
选择器可见: true
路径框: /Users/yangcode-            ← 打开时就是当前目录
跳到 /tmp 后路径框: /tmp | 行数: 511
跳文件后 hit 行: 1 | 选中: 报价单-预览测试.xlsx | 发送可用: true
行内按钮: [ '预览', '选择' ]
文本预览: 1 | print("内网通里也能看到这段代码"
表格浮窗 .sd: 1 | 标题: 📊 报价单-预览测试.xlsx /tmp/报价单-预览测试
```

## D305 图片 / 动图 / 表情包在聊天里就是图（照 QQ 的元素模型）：缩略尺寸、点开看原图（2026-11-18）

**问题：** 以前所有附件都画成文件卡片 —— 发一张截图，聊天里只有一行「01.png 199 KB」。用户要「图片、表情包、gif 图都能和 QQ 一样」。

**REA 依据（`wrapper.node` 的 `nt::im_core::` 符号 + 同文件文案，见 `docs/PLAN-peer-qq.md` §1.3b）：** QQ 把这三样做成**三种元素** —— `PicMsgElem`（图片，自带宽高）、`GiphyMsgElem`（动图）、`FaceMsgElem`/`FaceBubbleMsgElem`（小表情 / 表情气泡），配 `PicUploadMgr`/`PicDownloadMgr` 与 **`PicAioThumbDownMgr`**（会话里先拉缩略图）。会话列表摘要写的是 `[图片]` / `[表情]` 这类占位符，不是文件名。

**决定：**

- **不新增 `kind`，按 mime 分派**。我们的 `Entry` 只有 `kind:"file"`；再拆出 `pic` / `gif` / `face` 三个 kind，回执、撤回、未读、折叠、去重那一套全都得分叉。所以 `picKind(e)` 只看 mime 与后缀：`image/gif` → 动图，其它 `image/*` → 图片，其余仍是文件卡片。
- **图片消息带宽高**：`Entry.file` 加可选的 `w`/`h`，**发和收的时候都在本机读一次文件头**（`peer/src/image.ts`，PNG/JPEG/GIF/WebP 四种容器，只读 256 KB）。页面用它先占位（等比缩到气泡宽度内），没有 `w/h` 的旧消息退化成一加载完就重新贴底（`repinBottom()`）。这就是 `PicMsgElem` 带尺寸、`PicAioThumbDownMgr` 先给缩略图的等价物。
- **渲染**：`.pic > img`，圆角、最大 300×300、`loading="lazy"`（滚到才取，跟按需拉缩略图一个意思）；点一下开 D302 的弹窗看原图；右键菜单（复制 / 引用 / 撤回）仍然挂在 `.msg` 上，不用另写。取不到图就退回文件卡片。
- **表情包**：小、方、且不是动图的（`max(w,h) ≤ 200` 且长宽比 ≤ 1.6）画成 `.pic.sticker` —— 无边框、上限 150px、不回弹放大。动图永远按图渲染（QQ 也是 `GiphyMsgElem` ≠ `FaceMsgElem`）。
- **会话摘要**：图片显示 `[图片]`、动图 `[动图]`，其它文件仍是 `[文件] 名字` —— 与 QQ 的 `[图片]` 占位符一致。

**取舍：** 没有「缩略图与原图分开传」——局域网里原图本来就够快，`/api/peer/file?id=` 直接给原图，省掉一套缩略图生成与缓存。因此首屏大图会占一点带宽（`lazy` 只解决「没滚到就不拉」）。预览里也不加「查看原图」二级按钮：弹窗里已经是原尺寸了。

**验证：** `peer-e2e` 新增一段（发一张 PNG，两边都记下 `w=10 h=10` 与 `image/png`），`peer-ui` / `peer-history` 全过，`build` + `typecheck`（i18n 3487 键 ×3）通过。真机实测（无头浏览器打测试实例，发了大图 / 表情包 / 动图各一张，另让对端发一张回来）：

```
图片气泡 .pic: 19 | 其中表情包 .sticker: 9
可见图片全部加载成功（naturalWidth>0）
展示尺寸: 146x298 | 213x298 | 298x167 | 120x120 | 150x75 …
预览里原图: 640x360        ← 点开是原尺寸
会话列表摘要: [图片]
```
## D299 上下文阈值改「窗口百分比」三层，删绝对 token 预算；交接与压缩二选一且交接优先（用户要求 2026-11-17）

**问题：** 自动压缩「从来没生效」不是触发逻辑写错了，而是量纲错了：`state/budget.json` 里存的是绝对 token 数（本机实际是 `{"value": 1000000}`），判定是 `lastContextTokens >= budget`。任何真实模型的窗口都比 1M 小得多，所以这条线永远等不到；而且它是全局一份、与模型无关，切换模型后更说不清。长任务还有第二个缺口：上下文顶到窗口时没有任何机制把「做到哪了」交给下一个会话。

**决定：**

- **删掉绝对预算整条链**：`budget.json` / `readBudget` / `writeBudget` / `setContextBudget` / `maybeAutoCompact` / ws `setBudget` / 模型弹窗里的 100K–1M chips / `BUDGETS` / `budget` 帧字段，一个不留（不留兼容层：旧文件留着也没人读）。判定、层级、夹取全部收进新纯函数模块 `bridge/src/context-policy.ts`。
- **三层优先级：会话 > 项目 > 全局 > 默认**。全局/项目写在 pi 的 `settings.json` 里，键为 `web.autoCompactPercent` / `web.autoHandoffEnabled` / `web.autoHandoffPercent`（沿用 `web.defaultPermission` 的先例，进「消息与压缩」组，项目级天然「覆盖全局 / 清空继承」）；会话级覆盖另存 `state/context/<id>.json`，清空即恢复跟随。
- **默认压缩 70%，交接默认关**。自动压缩的总开关仍是 pi 自己的 `compaction.enabled`：关 = 桥也不按百分比提前压；开 = 桥按百分比提前压，pi 的 `窗口 − reserveTokens` 当兜底。不再新增第二个开关。
- **两条线都夹在 `min(百分比×窗口, 窗口 − 16384 − 2000)`**，并且界面显示夹取后的**真实百分比**：200K 上 70% 就是 140K；32K 窗口上 70% 会变成 ~43.9%，因为 pi 自己的压缩线在 48.8%（`32K − 16384`），不夹的话小窗口模型永远轮不到桥。
- **交接和压缩不能同值、不会同时发生，交接优先**：交接开着（开关开 **且** 有百分比）时，桥只判交接线，压缩不自动触发 —— 否则低阈值的压缩会把上下文压回去，交接永远等不到。校验 5–90% 且两条至少差 5 个百分点，按**解析后的值**比（会话覆盖可能和项目值撞成相等）。
- **两种动作的时机不对称，是有意的**：压缩等这一轮结束（`running` 时不动，pi 跑着的时候压缩没有意义）；交接在到线时**立即中断**（`abort` → 等 settle）。这条与「压缩不打断」不同，别在共用一处守卫时抹平。
- **交接 8 步**：占位互斥 → 中断并等 quiet → 终止后台子代理（只断开追踪，真进程随 abort/关闭走）→ 发 `/skill:handoff` 并**指定绝对路径**（技能默认写 `%TEMP%` 且文件名不定，不指定就找不到产物）→ 校验文件 > 200 字节且 mtime 稳定（5 分钟超时）→ 同 cwd 建**全新空会话**（不 clone 消息树，否则上下文没省）并继承权限/模型/launch/会话覆盖 → 自动发首条「先读这份交接文档」→ 成功后停旧 pi、永久解武、归档、写 `handoffTo` 后继链接、页面切过去。任何一步失败：只通知 + 5 分钟退避，不建新会话、旧会话重新武装。
- **旧会话交接后彻底退场**：`handoffTo` 一置位，`maybeContextAction` 直接早退（不解武的话交接轮结束时会再触发一次，原地无限 fork）；卡片挂「已交接」徽标、页面顶部一条「已交给新会话」可点跳转，文件本身不动（归档不删）。
- **只读/需确认权限下也能写交接文档**：`allowFile(id)` 多一个 `handoffPath`，审批闸门每次调用重读它，写工具的目标规范化后与这条绝对路径相等就放行；只放行这一个文件，别的一律照旧拦。
- **随手问（scratch）从不确定压缩、也不交接**：它本来就不受通用休眠管理，自动动作会更乱。

**取舍：** 删预算后旧的 `budget.json` 成了无主文件（不迁移，因为那个数没有任何意义）；百分比必须在有窗口信息时才生效，冷会话打开面板只能显示「还没拿到窗口大小」，要等一次 stats；交接文档落在桥的 `state/handoff/` 而不是工作区，翻历史要去状态目录找；`/skill:handoff` 是用户技能（`disable-model-invocation`），没装时开关会被拦住，但「装没装」是在打开开关/触发那一刻才查。

**验证：** `node --test bridge/tests/context-policy-unit.mjs`（7 条：三层优先级、5/90 边界、差 4 点、32K/200K/1M 夹取、交接优先、未设百分比不压制压缩）；`node --test bridge/tests/context-session-unit.mjs`（9 条：交接只发事件、到压缩线只压一次、运行中不压、scratch/已交接/占位中/失败退避全早退）；`npm run test:context`（桥 30 + web 33）通过；`node bridge/tests/context-policy-ui.mjs`（假 pi + Chromium，口令 `context-ui-pass`，端口 `CONTEXT_UI_PORT`，默认 7914 会被 Windows 保留段占掉，实测用 8934）20 项通过：四个头栏按钮、横幅隐藏时底栏仍贴底、窗口/默认 70%≈140K、差 2 点被拦且不发帧、保存后 `layer.session` 正确（保存前查 `/handoff` 技能，假 pi 用 `FAKE_PI_COMMANDS` 报一条）、生效来源变 session、140K→80K 夹取、Esc 只关子弹窗、交接说明与两次点击才发、压缩按钮不炸页面；`npm --prefix web run typecheck`（tsc + i18n 3489 键 × 3 语 + viewport 守卫）与 `npm --prefix bridge run typecheck`、`npm run build:bridge`、`npm run build:web` 通过。

## D300 交接时把票号 / 分支 ref 预填进新会话的名字框（2026-11-17）

**问题：** 从 Jira 面板「交给 agent ▾」或分支操作工作台交接出去，新会话的名字总要手抄一遍：面板里的名字框默认空着，桥于是先叫它「新会话」，等第一条消息才拿正文首行取名（40 字截断）。同时开着几个交接会话时，左栏一片看着都差不多。而「这件事叫什么」本来就在手上 —— 提示词里已经带着票号和分支。顺带查出一个更要紧的：Jira 面板是整屏盖板（`.jc-back` z-index 80 / `.jc-pane` 90），比底部 sheet（z 60）与它的 modal（z 70）都高，所以从 Jira 交接出去之后，新会话面板和输入框被压在下面**点不到**（探针里 `.jc-pane intercepts pointer events` 直接点不动「创建」）。

**决定：** 新增 `web/src/session-name.ts` 两个纯函数，规则只写这一处，两个面板共用：

- **票号 → 名字**：`trim` 后取最后一个 `-` 之后的原文。`CASPH30INC-17967` → `17967`，`ABC_DEF-12` → `12`，没有连字符的 `E2E` 整条照填；取完是空的（`PROJ-`）返回空串，调用方按「不填」处理，别在面板里摆一个看不见的空名字。
- **分支 ref → 名字**：整条原样，只去前后空白（`feat/skill-inject-viz`、`origin/main`、`HEAD~2` 都留着斜杠与 `~`）。
- **只预填，不改名**：名字进「开新会话」面板的名字框，可改可清，创建时用最后写的；不加 `rename` 请求、不多一次网络往返。光标停在末尾（不 select-all），接着补字不会盖掉整段。名字只活在那个输入框里，面板一关就没，不需要额外的待填状态（D127 那条只管待填文字）。
- **回退路径同样带名字**：`prefill()` 在没有当前会话时会去建新会话，名字一起带过去。
- **分支工作台用点下去那一刻的 ref**：`openAi()` 那颗卡上，两个出口各自在 onClick 里读 `picker.input.value`（不是面板打开时缓存的 `selectedBranch`，也不是建卡时快照的值）；`openHandoff()` 那三处（询问 / 单个动词 / 批量动词）用的是面板当前选中的那条分支。

**取舍：** 名字不再按字数额外截断，只服名字框自己的 120 字上限（预填时显式 `slice` 到 `nameField.maxLength` —— 程序赋值绕得过 `maxLength`，不截就会显示一个 130 字、建出来却是 120 字的名字）；分支不改用「最后一段」，用户要的就是整条 ref。Jira 交接时先 `close()` 自己（与笔记面板同一做法），否则上面那条盖板问题会让整个功能在浏览器里用不了；代价是交接后要再看 Jira 得重开面板。记录 / 邮箱两个面板这次没扩（用户定的范围）；仓库面板与分支工作台共用同一个 `BranchSheet`，类型跟着放宽，它的 AI 出口实际也带名字。

**验证：** `node --experimental-strip-types web/tests/session-name-unit.mjs` 覆盖票号与 ref 的边界；`node probes/jira-handoff-name.mjs` 用真 Chromium + 拦掉的 `/api/jira/*` 跑三条场景（无会话时回退、有会话时新开、取消后不漏），断言的是左栏那一行会话叫什么；`npm run test:githist:ui` 里补了一条「分支出口把 ref 填进名字框」。
## D301 记录面板重做成三栏控制台：正文存净化过的 HTML，`mode` 退休（用户要求 2026-11-17）

**问题：** 🐞 记录面板一直是「一列条目 + 一个 textarea」，跟「设置 → 本机管理」那套控制台不是一个世界的；用户要的是同一套语言（分区 / 列表 / 正文三段），输入要能写富文本：标题 + 长文、代码块（打 ``` 换行就成块）、颜色 / 字号 / 下划线 / 删除线 / 列表 / 表格 / 分隔线，设置多了就折起来。原来的 `mode`（快速 / 表单 / 详细）三档在「统一成长文本」之后没有意义了。

**决定：**

- **`Note.body` 从纯文本改成净化过的 HTML**，`mode` 字段留在类型与落盘里，但写路径不再写、读路径一律忽略（老数据不迁移）。写进 body 之前必须过 `sanitizeRich()`：白名单只放 `p br h1-h3 strong b em i u s strike del ul ol li code pre blockquote hr table thead tbody tr th td span mark a`，`span[style]` 只留 `color` / `background-color` / `font-size`（`0.5–4em`），`a` 只留 `http(s)`，`script / style / iframe …` 连内容一起丢。老纯文本按**空行**切 `<p>`、单换行当 `<br>`；判「是不是 HTML」认块标签与行内排版标签（`strong/em/span/mark/a` 等），不认裸 `<13:45:02>` 这种日志片段。
- **净化和 Markdown 导出都是纯函数**（`web/src/notes/rich.ts`，无 DOM）：浏览器与 node 单测共用一份。标题仍由 web 侧从正文首行派生（`plainText(body)`），**桥的 `saveNote` 一行没动** —— 后端不动是这次的范围。
- **富文本编辑器单开一个类**（`web/src/notes/editor.ts`）：`execCommand` 负责粗斜下删 / 列表 / 段落，颜色 / 字号 / 底色自写 `wrapInline()` 包 `span[style]`；粘贴时 text/html 走净化、纯文本走转义分行；```` ``` ```` 在**回车那一刻**才转代码块（` ```ts ` 带上 `language-ts`）—— 边打边转会把语言名吃掉。不用 `innerHTML` 拼内容（仓库一贯规矩），统一 `DOMParser` + `importNode`。
- **布局状态跟人走**：`NotesLayout = { nav: "open" | "rail", list: "open" | "closed" }` 存 `localStorage` 的 `notes.nav` / `notes.list`；`⌘\` 收放列表，导轨上的 `»` 展开。三栏列宽 `168px 272px minmax(0,1fr)`，收起时改轨道而不是 `display:none`（要过渡）。
- **存盘从按钮改成停手自动存**（900ms，Ctrl/⌘+S 立刻存），脚注写「已自动保存 · 改于 … · N 字」；新建先聚焦标题；归档 / 垃圾箱里的记录整块只读。
- **尺寸 / 响应式照 AGENTS.md 的两条硬规矩**：面板在 `#app` 里，宽高一律 `calc(var(--vw1) * 94)` / `calc(var(--vh1) * 88)`；工具栏折叠用 `@container doc (max-width: 620px)`，列表列窄了用 `@container console`，不用 `@media`。

**取舍：** `execCommand` 已废弃但仍被三大浏览器支持，换 ProseMirror 要整棵编辑器重写、还要一份 schema 维护；这里只要「常见排版」，选它省下的复杂度比未来的兼容风险值。`mode` 不删字段而是「写不再写、读一律忽略」—— 老 `notes/*.json` 直接能读，代价是类型上还会看到这个字段。

**验证：** `npm run test:notes` 四段全绿：`web/tests/notes-rich-unit.mjs`（22：白名单 / 事件属性 / 字号只认 em / 表格 / 幂等 / 老文本迁移）、`web/tests/notes-editor-browser.mjs`（真 Chromium：选区加粗、``` 回车转代码块、粘贴净化、颜色包裹、选区丢失时不改正文）、`web/tests/notes-sheet-browser.mjs`（三栏骨架 / 列表行 / 自动存 / 状态菜单 / 两栏折叠 / 搜索 / 归档只读，`locale: zh-CN`）。`cd web && npm run typecheck`（tsc + i18n 3475 键 × 3 语 + viewport 守卫）通过。

## D306 考勤：设置页能看回本机存着的密码，token 过期自动续登（用户要求 2026-11-18）

**问题：** 用户提了两件事：「之前已经登陆过了，每次打开考勤自动更新」——可界面在 token 一过期就说「未登录」，而实际上记录页一拉数据，`session()` 就会拿存着的密码自动重登，提示与事实相反；「设置里面密码现在默认不显示，设置为显示状态。但是不是直接显示，应该有一个眼睛的图标，点击能显示」——要看的是**本机存着的那个**密码，不是重敲一遍。

**这条取代 D291 里的一句。** D291（以及同口径的 D202）说「密码落 DPAPI，页面只见掩码 …… 页面拿到的永远是 `TS***1` 这种掩码」，那时页面没有任何读密码的入口。现在用户要在设置页核对已存的密码，边界必须放宽一格；**账号仍然是掩码**，那颗例子说的主要是账号。按 `docs/agents/domain.md`「Never rewrite an existing entry」，D291/D202 原文不动，改口径记在这里。

**决定：**

- **「已登录」= 现在就能用，或待会儿能自动续。** `statePayload` 的 `loggedIn` 从 `token && tokenFresh(token)` 改成 `tokenFresh(cred) || (cred.password && !passwordRejected)`。只看 token 的话，过期那一刻界面说「未登录」，用户什么都没做错却看到一句错话。
- **自动续登真被拒了才回落成「未登录」。** `session()` 自动重登抛 `login_failed`（401）时置 `passwordRejected`，摘要就回 `loggedIn: false` —— 否则界面绿着、每个请求都 401，比原来的假红更难查。退避（429）**不**置位：那是「等一会儿」，不是「密码坏了」。这个标记只活在本进程里，桥重启等于人工介入过，重新试一次比一直挂着一句可能是旧的结论强。人手动在设置页敲错密码不算（那条密码压根没落盘）。
- **新路由 `GET /api/attendance/password`。** 回 `{ password }`，没有就是空串。隧道访客在 `handleAttendance` 开头 `if (ctx.publicReq) return false;` 已被挡成 404，e2e 的路由清单里加上了它。
- **页面在进设置页时拉一次回填，`input` 仍然是 `type=password`。** 眼睛按钮只切 `type`：不改值、不再问桥要一次，明文只存在于这一帧的 DOM 里。密码不落 `localStorage`、不进状态摘要、不进审计（与 D291 的「不进日志」一致）。
- **回填失败不记账。** 只有真拿到才把那一轮标记成「已问过」；桥还在跑旧版本（没这条路由）或这次网络抽风时，下次重画还会再问 —— 不能失败一次就让框在这一整页里永远是空的。
- **眼睛的开合存在闭包里，跟着人走。** 保存配置、登录成功、失败提示都会整页重画，眼睛要是每帧复位，人按下「看密码」再点一下别的就白按了。
- **`autocomplete="new-password"`**，与 D267（邮箱授权码）同口径：避免 Chrome / Edge 把浏览器存的登录密码自动填进这个框，也避免弹「保存密码」。

**取舍：** 这条边界是有意放宽的 —— 页面进程一旦被 XSS 控制，就能直接读到明文密码。挡住它的只有三条：只服务 `127.0.0.1` 的页面（隧道访客整页 404）、不复用它做任何跨域请求（密码只在本机输入框里显示）、不出现在日志 / 审计 / 模型上下文里。若哪天考勤页要开给隧道，这条路由必须先撤掉。另一半取舍是 `passwordRejected` 只在内存：桥重启后「密码已被拒」这个结论会丢一次，界面可能短暂显示「已登录」，下次请求失败才回到「未登录」。

**验证：** `bridge/tests/attendance-e2e.mjs` 33 条（新增「token 过期但密码还在：仍算登录态，设置页能拿回那个密码」与「自动续登被上游拒了：界面回落成未登录，密码改对之后又回来」；隧道清单含 `/api/attendance/password`；顺手修「登录闸门 1 秒退避没等过去」那条既有脆调用例）；`bridge/tests/sysmanage-ui.mjs` 105 条（假 OA + 真 Chromium：回填已存密码、`type=password`、眼睛切明文、再点收回）；`bridge/tests/attendance-unit.mjs` 52 条；`npm --prefix web run typecheck`（i18n 3579 键 × 3 语、viewport 守卫）与 `npm run build` 通过。
## D307 Copilot 按「积分」记账：全部在 bridge 里算，不装扩展（用户要求 2026-11-18）

**问题：** pi 在用 `github-copilot` 模型时，`usage.cost` 仍然是「按价格表折算的美元」——可 GitHub 实际扣的是 **AI credits**（1 积分 = $0.01），而且个人 / Business 套餐是按月额度扣，超出才计费。于是界面上那三个数字（执行面板「本轮费用」、模型弹层「累计费用」、状态栏芯片）对 copilot 会话全是**看起来精确、实际是换算值**的数；用户真正想知道的「这一轮花了几个积分 / 本月还剩多少」一个都没有。pi 1.5.0 与 1.5.2 都没有对应的 RPC 或 schema 字段（`cost.totalFromProvider` 只给 OpenRouter 用）。

**决定：**

- **不写 pi 扩展，全部在本工程内**：先用扩展做过一版（`provider_stream_event` 抓响应里的 `copilot_usage.total_nano_aiu`，写会话条目），实测确认 `cost × 100` 与 `nanoAiu / 1e9` **逐位相等**（`claude-haiku-4.5`：0.0080125 美元 ↔ 801,250,000 nano-AIU = 0.80125 积分，含 cacheWrite）。既然等比，扩展多出来的只是一个「必须装到全局目录的组件」，于是撤掉：`credits = usage.cost.total × 100`，会话里若出现 `copilot-credits` 真值条目（将来 pi 自己吐）就优先用它并标「真值」。**代价只有一个**：pi 内置价格表落后于 GitHub 改价时会系统性偏 —— 由对账（下一条）自动暴露。
- **账户额度由 bridge 自己拉**：每轮结束（`agent_end` / `agent_settled`）与打开会话时 `GET https://api.github.com/copilot_internal/user`，token 顺序 `COPILOT_GITHUB_TOKEN` → `~/.pi/agent/auth.json` 的 `github-copilot.refresh` → `.access`（`bridge/src/copilot-credits.ts` 的 `fetchCopilotAccount()`）。**最小间隔 30 秒**、8 秒超时、同一时刻只允许一个请求在飞；间隔内的轮次沿用旧快照，界面写「额度更新于 2m」，不假装是新的。不做「打开面板立即刷」——那会让一次视图刷新也变成网络请求。
- **桥按字节 offset 增量读会话文件**：`CopilotTally` 只消费到最后一个 `
`（半行留到下次；文件变短就 reset；文件不在返回上次快照），`CopilotView = { hasCopilot, credits, requests, lastAt, estimated, otherCost, account, reconcile }` 以 `{ type: "copilot", sessionId, … }` 推给前端。子会话走 `copilotFromEntries(entries)`（那边已有 `loadEntries()` 的结果）。
- **按 provider 分账**：`otherCost` = 会话里 provider ≠ `github-copilot` 的 assistant 消息 `usage.cost.total` 之和。它 > 0 就是**混合会话**：主格子保留「本轮费用」写成 `积分 + $X`，专项块的「本轮 / 会话累计」只算 copilot 部分；**绝不把积分折成美元充成一个数**（决策 26）。
- **显示形态（V1）**：专项块挂在执行面板「本轮耗时」那块卡里，只有会话历史出现过 copilot 才显示（切走模型也不消失）。纯 copilot 会话里主格子只留「本轮耗时 / 工具失败」两列，积分只在专项块出现一次；混合会话才回到三列。专项块四格：本轮 / 会话累计 / 本月已用 / 剩余，外加额度进度条、`重置 2026-12-01 00:00 UTC（本地 12/01 09:00）`、`额度约 $5,000`、`额度更新于 N m`。模型弹层的「累计费用」与状态栏芯片同口径换积分，悬停给 `$`。
- **精度三档**：`< 1` 三位、`< 100` 两位、`≥ 100` 取整加千分位（`0.013` / `12.35` / `469,980`），`formatCredits()` 一处实现。账号行标「本月」，重置时间 UTC 与本地**并列**（决策 27）。
- **对账**：收到新额度快照时比较「上一快照以来的账号增量」与「本机记账增量」，`accountDelta ≥ 10` 才比，偏差 > 2% 在专项块底部出一行小字；样本太小或月度重置（`used` 变小）就清掉。这条同时是「价格表过期」的探测器。
- **范围**：上下文洞察里跨会话的「预估费用」KPI 保持美元不换（决策 31）；pi 本体不动。

**取舍：** 放弃「provider 真值」换来零安装、零新进程、单一数据面（桥与 web 各自一份类型，没有第三处要装的东西）；`estimated` 字段把这个交换写进协议，界面据此显示「估算 / 真值」，不让人误以为是 GitHub 自己给的数。副作用是老会话里 `usage.cost` 为 0 / 缺失的请求没有积分（pi 记价之前的历史）。**否决过的两条**：① 桥自己做 MITM 代理截 pi 的 HTTP 流 —— 多一个进程、要正确转发流式响应，风险远大于收益；② 桥自己发一次 copilot 请求读响应头 —— 那是**真花钱**的探测，且与用户实际那次请求不是同一笔。

**验证：** `node --experimental-strip-types bridge/tests/copilot-credits-unit.mjs`（12：增量读含半行/变短/文件不在/坏行、`cost × 100` 换算与真值优先、provider 分账、对账三态、额度解析含 `quota_reset_at:0` 与真实 Business 响应、拉额度失败一律 null 且不发请求）、`node --experimental-strip-types web/tests/copilot-unit.mjs`（7：精度三档、美元换算、重置时间 UTC/本地/天数、混合判定、用量比例、刷新年龄）、`web/tests/exec-view-unit.mjs` 22 通过（模型带 credits/otherCost）；`npm --prefix web run typecheck`（i18n 3597 键 × 3 语 + 视口守卫）与 `tsc --noEmit -p bridge/tsconfig.json` 全过。等价性实测：同一请求 pi 写的 `cost.total 0.0080125 × 100` 与响应的 `total_nano_aiu / 1e9` 完全一致。

## D308 从弹层里打开的浮窗提一档（`.viewer.hi`），三处「先关父层」的绕法删掉（2026-11-18）

**问题：** 一堆「面板里再开一层」的路径不遵守「从哪来，回哪去」。清了一遍（产物 / 差分 / 设置抽屉 / 设置台 / 模型面板 / 上下文面板 / 技能商店 / 内网通 / 记录 / Jira / 分支工作台 …），根因其实只有一条：**`.viewer` 是 46/47，永远在 `.sheet-back` 60 之下**，所以从面板里 `openPreview` 什么都看不见，点了像没反应。绕开的办法是「先 `this.closeSheet()` 再开预览」——用户关掉预览，父层也没了：

- 产物列表点不可 diff 的行（`artifactRow`）；
- 技能商店「已安装 → 查看」（`paintSkillInstalled`）；
- 设置台「更新日志」里点 `docs/DECISIONS.md`（`paintWhatsnew` 的 `openPath`，代码注释里明写了「先收面板再交给预览」——那是当时对层序的妥协）。顺带 `settingsEsc` 的越级守卫只数 `.st-back, .sheet-back, .image-view`，Esc 会连父层一起收。

**为什么：** 打开一扇浮窗本来不该销毁它背后的那一页，可 `App` 的 sheet 是单槽（每个 `open*Sheet` 首句 `closeSheet()`），谁也不能把自己叠在自己上面。改那个契约要动十几个入口，而这里真正的病症只有「预览被父层盖住」一条 —— 给这一种浮窗提一档，三处绕法就都不需要了。整体抬高 `.viewer` 不行：D111 的语义是工具窗压不过真正的模态与底部抽屉，这条得留着。

**决定：**

- **`.viewer.hi { z-index: 63 }`**（`.viewer.hi.front` 同高）：`openPreview` 里 `toggle("hi", Boolean(this.sheet || this.subSheet))` —— 从弹层里开的预览压得住父层，从空场 / 终端 / 普通浮窗里开的还是 46/47。只提这一类，**不是**把 `.viewer` 整体抬高（D111）。
- **`.modal.hi` 62 → 64**：口令框与「更新 pi」得压得住 63（设置台里点文档链接 → 再点「更新 pi」就是这条路）。层带现在是 `term-dock 45 < viewer 46 < *.front 47 < modal 50 < sheet 60 = st-back 60 < sheet-sub 61 < viewer.hi 63 < modal.hi 64 < choose 66 < image-view 70`。
- **父层关掉时摘掉 `hi`**（`closeSheet()` / `closeSubSheet()` 各一句 `this.viewer?.root.classList.remove("hi")`）：预览是拖出来的窗，父层没了就该回落到普通层带，不跟着消失。
- **Esc 从上往下收**：新增 `viewerEsc`（document 捕获阶段，只在 `.hi` 时生效）→ 先收预览并 `stopPropagation()`；`settingsEsc` 加 `.viewer.hi` 提前 return，并把 `.sheet-sub-back` 补进越级守卫。面板自己的 Esc 挂在元素上，焦点在面板里时事件走不到浮窗，所以这一层必须在捕获阶段拦。三支 Esc（`viewerEsc` / `subEsc` / `settingsEsc`）统一先查 `ev.defaultPrevented`，且都不越级：`.viewer.hi` 上面压着 `.modal.hi`(64) 或 `.choose-back`(66) 时由 `higherLayerOpen()` 拦下，子层(61) 上面压着 `.viewer.hi` 时 `subEsc` 也提前 return —— 收掉的一定是最上面那层。`.image-view`(70) 不用列：它挂在 `window` 捕获阶段且自己 `stopPropagation()`。
- **三处 `closeSheet()` 删掉**：产物不可 diff 行、技能商店「查看」、更新日志文档链接（见上）。

**取舍：** 没顺手改「单槽 sheet」本身（`openDiffSheet` 首句仍是 `closeSheet()`，所以产物 → 看改动 → 关差分还是全关；设置抽屉 → pi 设置 / 本机管理 / 热部署、模型面板 → 项目信任 / 会话树、上下文面板 → 交接卡 → 阈值卡同理）。那些要的是 sheet 栈，改的是十几个 `open*Sheet` 的公共契约，不是这一档的事；先把「预览型子层」这条最容易误判成没反应的路修对，其余记在 issue #496 等下一条。`viewer.hi` 在子层(61) 盖上来时不会自动降回（子层其实还在预览下面）：今天没有一条路径能在预览已开时再开子层，Esc 的顺序已按「先收最上面那层」处理，真撞上了再决定是降档还是让子层也提一档。Esc 越级的三条分支（口令框 / 选择框压在上面时不收预览）没有自动化用例，只有代码审阅与 `higherLayerOpen()` 的注释：那两条要真起口令框或选择框，代价比收益大；层带本身由 `layers-unit.mjs` 兜底。

**验证：** 新增 `web/tests/layers-unit.mjs`（已挂进 `npm --prefix web run typecheck`）从 `styles.css` / `settings-console.css` 里读真实 `z-index`，断言 `.viewer < .sheet-back`、`.viewer.hi > .sheet-back / .sheet-sub-back / .st-back`、`.modal.hi > .viewer.hi`、`.choose-back > .modal.hi`、`.image-view > .choose-back`、`.viewer.hi.front === .viewer.hi`；`bridge/tests/whatsnew-ui.mjs` 的 D 段改成「点链接后面板还在 + 预览 z-index 更高 + Esc 只收预览」，`bridge/tests/skill-view-ui.mjs` 的 E 段改成「查看之后商店还在 + Esc 回到商店」。两条 UI 用例在真 Chromium 里跑过（`WHATSNEW_UI_PORT` / `PI_WEB_PORT` 钉端口，本机 `freePort()` 偶尔会给出绑不上的端口）。

## D309 模型回复的抬头补上时间：桥在 `message_start` 打一次点，`message_end` 沿用（用户要求 2026-11-18）

**问题：** 对话里用户那条抬头是「你 · 15:32」，模型回复那条只有「pi · 」——**时间位置有,值没有**。原因不在前端拼串：`bridge/src/sessions.ts` 实时流式那条 assistant 消息在 `message_start`（草稿卡 `draft:N`）与 `message_end`（`live:N`）两处都**没写 `ts`**，而重放的历史条目（`bridge/src/items.ts`）用的是 pi 自己的 `entry.timestamp`。于是同一个会话，**刷新一次页面前后同一条消息两种长相**；前端 `timeOf("")` 把空 ts 变成空串，留下的就是那个悬空的分隔符。

**决定：**

- **桥打点，前端只读**：`message_start` 里 `this.draftTs = new Date().toISOString()` 并写进草稿卡；`message_end` 用 `this.draftTs ?? new Date().toISOString()`（`draftTs` 随后清空）。不选「前端收到帧时自己 `Date.now()`」——那是**渲染时间**，刷新后重放条目带的是 pi 的时间，同一条消息会跳；也不选「`message_end` 才打点」——那样长回复的抬头是收尾时刻，和 pi 的 `entry.timestamp`（≈ 开口那刻）差着整段生成时长。
- **缺 ts 就整段省掉**，包括分隔符：`headLine()` 拼的是 `名字${stamp ? " · " + stamp : ""}`，老桥（还没升级的那份）发来的实时条目抬头就是干净的「pi」，不再是「pi · 」。
- **非今天带日期**：今天是 `15:32`（与用户那条同一形态），不是今天则 `2026/11/17 15:32`。翻回上周的会话，「15:32」是哪个 15:32 读不出来。
- **模型名不翻译**：抬头前半截仍是 `item.model ?? "pi"`，走 `headLine()` 而不是 `tr("{p1} · {p2}")`；「你」这个称呼进 i18n（`en` "You" / `ja` "あなた"），原来的 `"你 · {p1}"` 删掉。
- **只动 assistant 抬头**：`timeOf()` 仍在，摘要卡 / 提醒卡 / 复习卡与 `!` 命令回显那行保持原样（范围外，免得顺手改掉它们的文案）。

**取舍：** 时间落在**桥**而不是页面上，代价是这条时间在会话 JSONL 里**多一份**（pi 自己的 `entry.timestamp` 仍在），两处不保证逐位相等，只保证同一段：刷新后抬头用的是 `items.ts` 的 `entry.timestamp`，与实时那次的 `draftTs` 会差几十毫秒 —— 分钟级显示看不出来，也不打算为它去改重放路径。没顺手给 `thinking` / `toolCall` 条目补时间（它们不显示抬头）。

**验证：** `node --experimental-strip-types bridge/tests/message-time-unit.mjs`（7：草稿卡有 ts、`model` 保留、`message_end` 沿用同一个 ts、`s.items` 里那条同 ts、`draft:N` → `live:N`、下一条重新打点、孤立 `message_end` 也补 ts）；`node --experimental-strip-types web/tests/chat-head-unit.mjs`（5：无 ts 只留名字、坏 ts 当没有、今天只时分、非今天带年份、后缀接在时间后）。

## D310 浏览器面板第一步：从工具日志派生一条可折叠的时间线，不新增桥事件（用户要求 2026-11-18）

**问题：** 浏览器 MCP（browser-use / Playwright / Puppeteer …）在会话里只有一个工具项：名字加一整段代码，右栏「执行」也只给一行 `mcp__browser_use 48.0 秒`。用户看不到它点了哪个按钮、跑到哪一步、是慢还是卡死 —— 真实的会话里 14393 秒、506 次工具调用，其中 41 次是 `browser_exec`，只能人肉读代码。

**决定：**

- **数据只从会话已有的 items 派生**（`web/src/browser-ops.ts` 的纯函数 `browserOpsView()`），不新增桥事件、不落盘截图。刷新、重开、换设备都自动回放，也不需要额外的存储。
- **子步骤是从参数代码里解析出来的，不是浏览器回传的轨迹**：按已知的 helper 名字（`goto_url` / `wait_for_load` / `click_at_xy` / `js` / `print(page_info())` …）切成一步一行，拆不出的整段原样一行。所以**不给每步编耗时**（工具事件只有整次的 `durationMs`）—— 那要等第二步的 CDP 通道。展开态显示函数名与坐标，折叠态一律不显示（坐标、JS 片段、函数名都只在展开态）。
- **两层「卡住」的措辞必须分开**：面板里只有「疑似卡住 / 无声 / 打转」（60s 黄、120s 红、20s 无新输出、同动作连续 3 次），**卡死** 是 watchdog 那条整轮 30 分钟无事件（D372 起这个阈值默认 120 分钟），两者不是一回事（GLOSSARY 各一条）。
- **无声只在这次调用确实上报过 partial 输出时才算** —— 否则所有不流式的 MCP 调用一开始就会被标成静默。
- **唯一动作是「中断本轮」**，且点击前 `window.confirm` 说明「会停掉整轮、不能只杀这一步」：pi 的 RPC 没有单工具中止。按钮只在会话 running 时出现（`bridge/src/sessions.ts` 只在 `agent_start` 上把 `running` 置真）。
- **第三颗 tab 不抢焦点**：有调用在跑且当前不在该 tab 时只亮一颗小圆点，不自动切过去。默认只展开「正在跑」与「卡住」的卡，其余折叠成一行中文。
- **阈值与工具名单可改**：面板汇总行的齿轮里四个阈值加一行逗号分隔的名单，存 `pi.browserOps.thresholds` / `pi.browserOps.tools`；读不出来就回 `BROWSER_OPS_DEFAULTS`。
- **子代理不新增订阅**：只读执行面板已经订阅到的子代理 items，拿不到就只画主会话；「只看主会话」开关过滤掉子代理的卡。

**取舍：** 卡片顺序按「发现顺序」的倒序（新的在上），不再按 `startedAt` 排 —— 工具项没有 `ts` 时 `startedAt` 会退化成「现在」，混进两分钟前的调用会把顺序排反。副作用是子代理的卡（先收集）排在自己会话的卡后面。

**验证：** `npm run test:browser-ops`（20 条纯函数用例：白名单 / 步骤序列 / 拆不出 / 打转 / 无声 / 阈值 / partial 输出 / 空视图）；`npm run test:browser-ops:ui`（Playwright + 假 pi：第三颗 tab 与 pip、折叠与全折叠、输出折三行、快进 70s/130s 变黄变红、中断前的确认框、齿轮里的阈值与名单）。

**补记（同日，真实使用反馈后）：** 第一版只认 MCP 工具名，用户真跑「用 playwright 打开百度、输入、点检索」那一轮，面板是空的 —— 那轮 agent 先 `write` 了 `baidu-weather.mjs`、再用 `bash` 跑，一个 MCP 浏览器工具都没调。于是「浏览器类调用」改成**看行为**而不是看工具名：脚本源码里出现驱动调用（`page.goto` / `locator` / `launch` / `waitForSelector` …）才算，脚本可以是之前写好的文件、也可以是同一条命令里的 heredoc；`npx playwright test` / `cypress run` 这类命令式跑测试算一步 `run`；直接起 `chrome --headless` / `--remote-debugging-port` 算一步 `launch`；`curl 127.0.0.1:9222/json` 算一步 `cdp`。**不认**屏幕驱动（pyautogui / computer-use）和 `selenium-side-runner`（要跨机连浏览器），也不认「命令里出现 playwright」——试过那个宽松版本，真实会话一次多出 12 张噪音卡（`npx playwright --version`、`npm i playwright`、`grep -i playwright`）。

**顺带修的桥问题：** `bridge/src/items.ts` 的 `toolResult` 分支没抄 `durationMs`（pi 把它写在 toolResult 消息顶层），所以**刷新页面后**所有工具耗时都是 0 —— 执行栏和浏览器面板一起瞎。补上之后同一条会话从「共 13 次 · 0.0 秒」变成「共 13 次 · 151 秒 · 最慢 84 秒」（`bridge/tests/items-duration-unit.mjs` 两例）。
## D311 目录入口一场雨改齐：桥端分页 + 递归检索 + 按大小·时间排序，五个入口共用同一份排序（用户要求 2026-11-18）

**问题：** 大目录（几千个文件、`node_modules` 在列表里）面前，五个「挑目录 / 挑文件」的入口一起失灵：新会话弹层的目录树、文件管理器的浏览页、附件弹层（`文件` 按钮）、内网通的选文件对话框、新建工作区的目录框。桥端 `listDirs()` 只回一页死数据 —— `dirs.slice(0, 1000)` / `files.slice(0, 2000)` —— 于是「筛选」框只在**已经拿到的这一千个名字**里找，用户看到一个空列表、一句「列表里没有 xxx（目录过大时只列出一部分）」，却没有任何办法把它找出来；排序只能按名字；新会话弹层的目录选择也还是老样子（输入框 + datalist），跟已经重做过的「新建工作区」不是一套东西。

**决定：**

- **分页放桥端**（能力标记 `dirs.page`，走 `/api/dirs?page=1&…`）：`q`（名字子串、大小写不敏感）、`offset`、`limit`（默认 200）、`sort=name|size|mtime`、`dir=asc|desc`、`sub=1`、`files=0`。响应在老字段 `dirs` / `files` 之外追加 `total`、`truncated`、`entries`（`{name, kind, size?, mtime?, rel?}`），老桥没有 `entries` 时前端把 `dirs/files` 折成同一形状、`paged:false` —— 页面不会因为桥没升级就白屏。
- **筛选与排序都由桥做，页码一起归零**：前端 150ms 防抖后重取第一页；排序换列 / 翻向同样重取（`keepQuery`，筛选词不丢）。不选「前端本地过滤」：本地只有当页，`筛选 readme` 会把第 2501 个文件漏掉。
- **目录与文件一条流，文件夹恒在前**，且**文件夹的顺序不随方向翻转**（`name` 时点文件排后、`size` 时文件夹之间按名字、`mtime` 时按各自 mtime）：否则「按大小降序」会把文件夹甩到最后一页 —— 原型里就是这么发现的。
- **`sub=1` 复用 @ 搜索的家当**：`git ls-files` 优先、不是仓库或 gitignored 就退 `walk()`，跳过 `node_modules` / `dist` / `.git`，命中带 `rel`（相对当前目录）在行尾显示，两万条封顶。**顺手修掉一个真 bug**：`listFiles()` 给的是**仓库根相对**路径，浏览子目录时 rel 全错、gitignored 目录直接返回空数组（Git 一个文件都不报），于是「包含子目录」在仓库子目录里永远空 —— 新增 `listFilesUnder(dir)` 用 `git rev-parse --show-prefix` 切前缀，空结果退回 `walk(dir)`。
- **两个上限写在代码里**：整目录 `ENTRY_CAP = 50_000`（超过就 `truncated`，页脚写「超过 5 万条，只展示前 5 万」），按大小 / 时间排序时最多量 `STAT_MAX = 20_000` 个 `stat`、按目录缓存 60s（`STAT_TTL_MS`），量不完就先按名字排并在页脚写「正在统计大小…」—— 2.5s 里量不完就不挡着人。
- **「只列目录」的入口真的不再列文件**（`files=0`）：新会话弹层只挑目录，文件连 `total` 都不进 —— 否则「已加载 20 / 1533」和列表对不上。「包含子目录」也只列目录时隐藏（桥端 `sub` 找的是文件）。
- **五个入口共用一份排序状态**（`pi.web.dirsort.shared`，默认 `name asc`）：第一次切到「大小 / 修改时间」自动降序；文件管理器与附件弹层传同一个 `defaultSort`（`mtime desc`），新会话弹层传 `name asc`。**只有新会话弹层不跟文件入口一样默认时间降序**：挑目录时名字序更好扫，用户在问卷里选了这一条。
- **新会话弹层照「新建工作区」重排**：左栏「已经在列表里」的工作区（不含手动组，当前组标「这里」）+ 最近目录（约 6 条，与会话 cwd 去重），右栏常显目录浏览，底部「名称 + ⚙高级选项 + 将在 / 已有个会话 + 新建会话」。撤掉输入框上的 datalist（`#pi-recent-cwds`），会话名的默认值改成**占位符**「新会话」（提交留空也按它，不再拿目录名当默认值）。
- **路径框定位在服务端兜底**：跳到 `file-1499.txt` 这种排在好几页之后的文件，当页找不到就把名字当 `q` 再问一次桥；还找不到才说「这一页里没有 xxx，试试清空筛选或再点一次「加载更多」」。定位前先**取消排队中的筛选防抖**，否则 150ms 后它拿旧筛选词重取一页，把刚标出来的行冲掉。
- **弹层固定 396px 高**（`.new-sheet .ws-new-body`）：换筛选词、翻排序、加载更多都不许把弹层撑高，列表自己滚。宽度 `min(1020px, calc(var(--vw1) * 100 - 32px))`，窄版用 `@media` 把两栏叠起来。

**取舍：** 不做虚拟滚动（200 条一页 + 滚到底自动加载已经够用），不做「文件夹递归体积」，不做列宽拖动，不给卷行排序（`↑ 上一级` 与盘符行钉在顶部不算进条数）。排序是共享的一份而不是每个入口一份：同一个用户在同一台机器上，刚在文件管理器里按大小排过，回到新会话弹层按名字排会更让人意外；真要分开，`loadDirSort(store)` 已经留了 `store` 参数。

**验证：** `node bridge/tests/dirpage.mjs`（15：过滤 / 排序 / 文件夹不随方向翻转 / 分页越界 / 递归 rel 且跳过 `node_modules` / 空路径盘符页 / `listFilesUnder` 三条）；`npm run test:stat`、`npm run test:dirpath` 不动；真桥探针 `probes/new-session-sheet.mjs` 八组 —— 弹层布局（只列目录 32 行 + `↑ 上一级`）、筛选 10 个且焦点不丢、只列目录时「包含子目录」隐藏、排序切向、`这个目录已有 1 个会话`、API 层 size 降序 / offset / `total` / `sub`、文件管理器默认 `mtime ↓` 且能跳到第 1500 个文件、附件弹层表头点「大小」两向都单调。

## D312 记录面板记住上次的分区与选中；正文下不再有 issue / commit / 会话（用户要求 2026-11-18）

**问题：** 记录面板每次打开都回到「bug / 全部 / 没选中」——正在跟的一条 bug，关一下再开就得重新点；用户要求「保存上次使用的窗口」。同一处底部还挂着 issue、commit 两个输入框和一行「会话」，用户明确说不再需要（#4）。

**决定：**

- **只记三样：分区（kind）、去向（view）、选中（sel）**，落在 `localStorage["notes.memory"]`（`{ kind, view, sel }`）。分段筛选（全部 / 待处理…）与搜索词**不记**：那是这一次的临时过滤，明天打开还想看见全部。
- **面板实例不保留状态**（`close()` 会销毁根节点与编辑器，下次 `new`），所以记忆必须落盘；写入时机是每次真的切了分区 / 去向 / 选中，不做「关闭时再写」——崩溃、刷新都不丢。
- **回落分两层**：分区与去向永远是合法的（读到坏值回落 `bug` / `active`）；选中只在「这一堆里真的有它」时接回（`inView(note)` + active 下 kind 相符）。找不到就清掉选中、保留分区，不自动选第一条——凭空打开一条不是用户的意图。
- **换堆不关编辑器**：`setNotes()` 只在「选中那条真的不该在这堆里了」（被删、被改到别的去向）时清空，只是被「显示已处理」过滤掉不算；否则点个状态就把编辑器关了。
- **多标签不监听 `storage` 事件**：打开时读一次、切了就覆盖写，另一个标签下次打开才看到——记录面板不是协作文档，省掉一套同步逻辑。
- **issue / commit / 会话从界面到桥全删**：`Note` / `NoteInput` / `notes.save` / `notes.status` / `NotesHost.session()` 一起收掉，不留「存着但看不见」的字段。**老 JSON 不迁移**：`readNote()` 逐字段运行时收窄，`sessionId` / `sessionName` / `issue` / `commit` 读到即丢，下次保存自然消失；`kind` / `status` / `mode` 非法值回落。

**取舍：** 不记面板宽度 / 高度（用户问的是「窗口」，选了分区与选中）；不记分段与搜索词；不迁移老数据（字段没人读，迁了也是死重量）。

**验证：** `npm run test:notes` 的 `notes-sheet-browser.mjs` 新增三组：`notes.memory` 落盘值、重开接回分区与选中、切到归档后只清选中且重开仍在归档；同时断言正文下只剩 状态 / 分类 / 创建 / 改动 四格。`npm --prefix web run typecheck`（含 i18n / 视口 / 层带守卫）与 `npm --prefix bridge run typecheck` 通过。

## D313 `npm start` 自己把页面打开，内网通的在线人数不再刷日志（用户要求 2026-11-18）

**问题：** 两处都只是「不方便」，但每天都在忍着：① 手动 `npm start` 之后只打印一行地址，还得自己去浏览器里粘一遍；② 内网通的人数变化一直往控制台打 —— `peer/src/index.ts` 里一句 `discovery.on("change", …在线 N 台…)`，而 `prune()` 每 5 秒无条件 `emit("change")`、每条 announce（约 10 秒一次）也发一次，所以空局域网也每 5 秒刷一行「在线 0 台」，`peer.log` 跟着长。

**决定：**

- **只在「人手动在终端里启动」时开页面**：判据是 `process.stdout.isTTY`（`bridge/src/openbrowser.ts` 的 `shouldOpenPage()`）。看门狗、热部署（`scripts/hotdeploy.mjs`）、`.pi/skills/bridge-update/bin/restart.mjs`（输出走 `Tee-Object` 管道）、测试环境（`pi-web-client-test-dev`）全都不接终端，一行都不用改就不会弹标签。`PI_WEB_OPEN=1` / `0` 可以越过这个判断强制开或关（也认 `true` / `false`；认不出来的值按没写处理，不会反而把页面关掉）。
- **系统默认浏览器**：Windows `cmd /c start "" <url>`、macOS `open`、Linux `xdg-open`。那个空的 `""` 是必需的 —— `start` 会把第一个带引号的参数当窗口标题，少了它 URL 只是把标题改掉、窗口不开。`spawn` 用 `stdio:"ignore"` + `windowsHide`，**不 detached**（Windows 上 DETACHED_PROCESS 没有桌面关联，`start` 静默失效，`terminal.ts` 已经踩过一次）；再挂一个空 `error` 监听：找不到 opener 时是个 `error` 事件，没人接就会带走 bridge。
- **挂在 `listen` 回调里、打印「已启动」之后**：端口才是确定能连的；先开浏览器再去 listen 会撞上「页面打得开、服务还没起」。
- **打开页面的函数不回报结果**：`openPage()` 只发起 `spawn` 就返回（`void`），不看返回值也无法可靠地看 —— opener 不存在要等 `error` 事件，而调用处并不关心开没开成。
- **内网通的在线日志整句删掉，不是降频也不是去重**：用户要的是「完全不打印」。人数本身在「内网通」页面里一直看得见，日志里那行没有额外信息；prune 每 5 秒都 emit，去重也只能把刷屏变慢一点。
- **顺手清掉 `bridge/src/index.ts` 里 10 条过期 lint**（模板串拼接、重复声明、嵌套三元、否定 if、赋值表达式），它们和这次功能无关，但都在要改的那个文件里。

**取舍：** 没用「永远打开」（用户选项里明说不要：后台重启一天弹一屏标签）；没用「往上找父进程判断是不是终端」那种探针（`isTTY` 已经够用，且零配置）；没引 `open` 这类 npm 依赖，三平台各一行就够。

**验证：** `npm run test:openpage`（纯函数：TTY 真假、`PI_WEB_OPEN` 的 1/0/true/false/空串/认不出的值、三平台命令形状含 win32 的空标题参数）；`peer-e2e` 末尾新增一条断言：三份 peer 跑完，stdout 里不得出现 `/在线 \d+ 台/`（收 stdout 的方式与 `PEER_E2E_VERBOSE` 共用）；空端口/临时状态目录真跑 21 秒 —— 含「在线 N 台」的行数为 0（别用「含‘在线’的行」计数：`peer/src/index.ts` 的隐身横幅与 `messages.ts` 的「对方不在线」都是合法行），`pi-web-client 已启动：http://127.0.0.1:…` 照旧；`openPage(url,"linux")` 在没装 `xdg-open` 的 Windows 上不再能把进程带走（`error` 监听生效）。

## D314 内网通气泡按「富文本 / Markdown」两支渲染，图片与表格不进气泡（用户要求 2026-11-18）

**背景：** #515 把输入区换成富文本之后，消息正文可能是 `RichEditor` 产出的 HTML；旧消息与「提交给好友」转发的正文仍是纯文本 Markdown。气泡原来只 `textContent` + `pre-wrap`，两类都显示不出结构。

**决定：**

- **判定顺序：`hasRichMarkup()` 命中的走富文本，其余全部走 Markdown**。不再为「纯文本」留第三支：`1. 第一`、`- 项` 这类老消息会开始显示成列表，明确接受。
- **富文本支：** `sanitizeRich()` 后把 `span[style]` 拆成文本（颜色 / 字号 / 底色丢弃、字体跟主题）；`h1-h3` 加 `.bub-h` 降成 13.5px；`a` 补 `target="_blank" rel="noopener noreferrer"`；`img` 本就不在白名单。
- **Markdown 支：** `renderMarkdown(text, { tables: false, imageSrc: () => null, openPath })`。气泡里不画表格（窄栏读不了）、不画图片（图片走文件卡）；`openPath` = 复制路径 + toast「已复制路径」。
- **点击：** 气泡空白处复制全文（富文本复制 `plainText(html)`，Markdown 复制原文）；`a` / `code` / `pre` / `table` / 折叠按钮不抢点击。
- **长消息：** 纯文本超过 1600 字或 24 行，正文套 `.bub-body.clip`（`max-height:280px` + 底部渐变），底部「显示全文 / 收起」只切类、不重渲染；展开状态不持久化。
- **引用与列表摘要：** 富文本先 `plainText()` 再截 120 字，会话行预览同理，标签不再漏进摘要。

**取舍：** 没给 peer 另写渲染器（直接复用 `web/src/md.ts`，构建增量在预算内）；没记展开状态（刷新回到折叠，和聊天软件一致）；老纯文本会按 Markdown 变化，这是为了让 #518 转发的正文与旧消息共用一条渲染路径。

**验证：** `node bridge/tests/peer-ui.mjs` 新增四条夹具（富文本、带样式的 span、Markdown 列表/标题/表格、1700 字长消息）：结构保留而颜色字号被剥、链接 `_blank`、`1.` 成 2 个 `li`、`#` 成 h3、`table` 为 0、折叠按钮文案切换；全过。`npm --prefix web run typecheck`（含 i18n）通过。

## D315 记录包复用内网通的 note 帧，截图按 sha 后到对齐，接受走桥的原子导入（用户要求 2026-11-18）

**背景：** 「提交给好友」要把一条记录（标题 / 正文 / 分类 / 状态 / 截图）交给别人，对方看到一张卡片，能只读预览、能一键接受进自己的记录。内网通协议 v1 只认 text / file / recall，未知 kind 直接 400 不可重试（`peer/src/messages.ts`）。

**决定：**

- **协议：** `EntryKind` 加 `"note"`，载荷 `{ title, body, kind, status, shots: [{ name, size, sha256 }], noteCreatedAt, noteUpdatedAt }`；`normalizeNote()` 与 text 一样在**发与收两侧**都跑，正文 ≤ 200 KB、标题 200 字、截图 ≤ 24 张，整帧 ≤ 256 KB（`peer/src/note.ts`）。`deliver()` 与 `Queued.kind` 一起加 note，离线照样 24 小时补投；`PROTO` 不变，`VERSION` 0.1.0 → 0.2.0（只有 `version` 字段与 `/hello` 用它，`/contacts` 不带版本）。
- **截图不塞进 note 帧：** 逐张走现成的 `/api/peer/sendfile`（`EntryKind: "file"`）。接收端按「同一发送人 / 在 note 之后 / 清单里有这个 sha / 还没被别的卡片用过」找文件条目，找到才把 `entryId` 缝进卡片视图；缺图卡片显示「还差 n 张图」并禁用接受。截图内容在**接受时**才从发送人 `/peer/file?id=` 拉回、校验 size 与 sha 再落盘。
- **接受是桥的活，不是 peer 的：** `POST /api/peer/note/accept { peer, id }` 在 `bridge/src/index.ts` 里查历史 → 拉图校验 → `importNote()` 生成**新 id**、`createdAt = now`、分类保留、状态重置为「待处理」、截图写 `notes/assets/<新 id>`（临时目录写全再 rename，失败清理）、`origin { peerEntryId, nodeId, nickname, hostname, at }` 只读；成功后 `broadcast({ type: "notes" })` 刷新已打开的面板。
- **「已接受」不进 JSONL：** peer 的历史是 append-only，改写会破坏它的时间线；接受状态放 `statePath("peer", "notes-accepted.json")` sidecar（`bridge/src/peer-notes.ts`），`/api/peer/messages` 返回前把 `accepted` 与每张图的 `entryId` 缝上去。一张卡片只接受一次：第二次点只会打开已接受的卡片。
- **卡片与预览：** 四态（发送中 / 失败 / 缺图 / 已接受）、预览只读（`sanitizeRich` 的正文 + 全部截图 + 来源），不出现 issue / commit / 会话；「打开记录」用 `postMessage({ t: "pi-note-open", id })`，外壳校验同源且记录存在后开面板并选中。

**取舍：** 没走 zip 或专用的整包上传接口（要新协议、新进度、新重试）；没把 base64 塞进 note 帧（256 KB 上限和 24 张图对不上）；没让 peer 直接写记录库（peer 进程不该碰 `state/notes`，也拿不到面板广播）；没把已接受写回历史（JSONL 不 patch）；跨版本互通不管（#138 明确「只要求同版本可用」）。

**验证：** `npm run test:note` —— `peer-note-unit`（载荷校验、sha 对齐先到先得、原子导入、sidecar 读写）、`peer-e2e`（note 收发、超长正文 400「正文太长」、坏截图清单 400 不可重试）、`peer-ui`（卡片 chips、缺图禁用、只读预览、接受请求体与「已接受」）；`npm run typecheck` 三包全过；`npm --prefix web run build` 通过。

## D316 列表刷新不许变暗、不许先清空：把「忙碌」画在已经显示好的内容上就是「闪一下」（用户报障 2026-11-18）

**问题：** 用户报「新建目录和排序按钮，点击后会闪一下。这个发生过很多次」。逐帧采样（rAF 记录 `.dir-list` 的 `opacity` 与 children）抓到两处，机制不同、症状一样：

- **排序（换顺序 / 换筛选词）**：`fetchInto(..., { quiet: true })` 保留旧的这一页，但给根节点加 `.busy`，而 `.dirpicker.busy .dir-list { opacity: .55 }` 让整张列表压暗再弹回 —— 实测 +41ms 变 0.55、+90ms 回 1。50ms 的亮度跌落，眼睛读到的就是「闪」，而内容从头到尾没变。
- **新建目录**：建完 `picker.go(path)` 走的是**非静默**那条路，先 `clearRows()` 再挂「读取中…」，快请求下这一两张空帧就是白屏闪。凡是非静默重取（跳目录、建目录、删改名后重载）都吃这一口。

**决定：**

- **已显示内容的列表，在拿到新数据前不动一个像素**（stale-while-revalidate）：清空、压暗、骨架屏一律不允许。忙碌只体现在 `cursor: progress` 和页脚计数上。
- **非静默重取先留着旧的一页，慢过 220ms 才让位给「读取中…」**占位（`fetchInto` 里的 `waitTimer`，`stopWait()` 在每个出口清掉，`seq` 变了就不许再出占位）。本机目录 20~80ms 回，用户看到的就是「点了立刻换」；真慢的时候仍有明确反馈。
- **把规则做成断言，而不是靠记性**：`probes/new-session-sheet.mjs` 第 10 段在点排序、逐字筛选、建目录三段里逐帧采样，任何一帧 `opacity < 0.99`，或「有内容期间」出现 `children === 0`，就红。结束为空是合法的（新建后跳进空目录），所以只统计最后一个有内容帧**之前**的空帧。
- **验证断言真的会咬人**：把 `.dirpicker.busy .dir-list { opacity: .55 }` 加回去重跑，探针立刻失败在 `sort: the list never dims (opacity 1/0.55)`，再删掉即恢复全绿。

**取舍：** 不加骨架屏、不加 spinner、不加「正在读取」的动效 —— 本机目录的刷新快到不值得任何视觉解释，慢的时候一句静态占位已经够；如果哪天刷新真的慢到需要进度感，要在**列表外面**（页脚、工具行）表达，不许改列表本身。

**验证：** `node probes/new-session-sheet.mjs` 十段全过（第 10 段为本次新增）；`.scratch/ns-ui/flicker.mjs` 另有同一套规则的独立取证脚本（排序 / 筛选 / 露出建目录行 / 真建目录四段，均 0 变暗 0 清空）。

## D317 记录面板的「内网通连动」：发送是文字、提交是记录包，图永远后补（#518）

> **后续（#663）：这里的「发送给好友」已经撤掉** —— 跟「提交给好友」重复、且更好用的是后者。现在菜单只剩一项，并加了体积护栏，见 D398。

**问题：** 记录正文下方原本有一颗「复制 Markdown」；用户要把它换成「内网通连动」：发送给好友 = 一条普通消息，提交给好友 = 打包给对端，对端在气泡里看到卡片，能接受或只读预览。于是要定的是**入口放哪、发送与提交各发什么、截图什么时候走**。

**决定：**

- **入口**：active 与归档两个分支都用「内网通连动 ▾」替掉「复制 Markdown」；垃圾箱没有（那条已经删了，发不出去）。菜单先挂「正在问内网通…」，`GET /api/peer` 回来才换成两项；未启用、正在重启、连不上都写成禁用 + 原因，`> 32 KB` 的正文让「发送」禁用并提示改用提交。
- **发送**：`noteTextForPeer(title, body)` = 标题 + 空行 + `richToMarkdown(body)`，走 `/api/peer/send` 的普通 `text` 帧，对端没有任何按钮。标题与正文都空时两项都禁用；发送允许草稿，不强迫先落盘。（**这一项已由 D398 撤掉**：`noteTextForPeer()` 与其测试并删除。）
- **提交**：先 `saveAndWait()` 拿到桥发回来的真 id 与截图清单（dirty 时挂 waiter 等 `notes.saved`，6s 超时；`waitShots()` 每 100ms 轮询到张数齐，5s 上限），再选人、`POST /api/notes/measure` 拿每张图的体积与 sha256，确认页写「对方会收到什么」，最后 `POST /api/peer/sendnote` 发 note 帧、逐张 `POST /api/peer/sendfile` 补图。**note 先到、图后到**是正常状态：对端卡片按 sha 对齐，缺图时禁用接受（#517），不为此把整包改成一次上传。
- **选人**：合并 `/api/peer` 的在线名单与 `/api/peer/contacts`，排除 `status.nodeId`，在线优先、离线置灰不可点，可按昵称与主机名搜；`localStorage["notes.peerLast"]` 记上次发给谁并打「上次」标。
- **失败语义**：`sendnote` 成功、某张图失败 → 提示「记录包已发出，但第 n 张图没发出去：…」，不回滚 note（对端会按缺图处理）；`sendnote` 失败 → 提示错误、不重试，用户可再点一次。
- **为什么不打包成 zip：** #507 已经定过——沿用现有文件通道，对端才能逐张对齐、中途补图；zip 会引入解包、路径与体积上限一整套新约定，收益只是少几次请求。

**取舍：** 确认页不可取消发送（点「提交」即发，失败再重试），避免「点了确认还在等」的二段状态；没有多选/群发；提交前的截图体积用桥端 `describeShots()`（流式 sha256）算，不在浏览器里读文件。

**验证：** `web/tests/notes-sheet-browser.mjs` 第 15 段走完「菜单两项 → 选人在线/离线/排除自己 → 发送的 Markdown 文本与回执 → 确认页四项 → sendnote + sendfile → 空记录禁用」；`npm run test:notes`、web/bridge typecheck 全绿。

## D318 浏览器面板的折叠行改成一条操作链：只说「对页面做了什么」，不报最后那一下（用户要求 2026-11-18）

**问题：** D310 的折叠行取的是「最后一个动作」，而 playwright 脚本几乎都是读页面收尾（`page.title()` / `page.evaluate()` / `page.screenshot()`）。真实会话里八张卡七张挤成同一行：`search.mjs · 读取页面信息 ×2`、`dom.mjs · 读取页面信息 ×2`、`inspect.mjs · 读取页面信息` —— 脚本名之外一个字都不同不了，一栏卡看下来不知道哪次是打开百度搜索、哪次是打开结果页截图。`×2` / `×3` 也不是「打转」，是相邻两步恰好都是读页面：`page.title()` 与 `page.evaluate()` 合并出来的。

**决定：**

- **折叠行 = 这次调用的一串操作**（`打开 www.baidu.com → 点击 → 输入 南京今天天气 → 输入 Enter`），挑与合并的规则放进模型层（`web/src/browser-ops.ts` 的 `foldedSteps()`），渲染层只把它们串成中文。
- **只列「对页面做了什么」**：`nav` / `click` / `input` / `js` / `cdp` / `scroll` / `run` / `call` / `raw`。`launch`、`tab`（启动浏览器 / 切换标签）、`wait`、`print`、`read`、`shot` 是每支脚本都有的过场，**只在没有别的可列时兜底出现**（一张只调了 `page_info` 的 MCP 卡仍然说「读取页面信息」，不会因为筛干净而空成一片）。
- **合并放在筛之后做**：`page.title()` → `waitForTimeout()` → `page.evaluate()` 中间那个 wait 被筛掉后会留下相邻的两行「读取页面信息」，那不是两件事。
- **折叠行仍然不露代码与坐标**（D310 那条不变）：点击只写「点击」，输入只留值（`输入 南京今天天气`，选择器只在展开态），导航省掉 `https://` 前缀（一串「打开 …」本来就挤，协议名每段占 8 个字什么也没说）。
- **链宽了不折行**：`.browser-title` 还是单行 + 省略号，全链挂在 `title` 属性上，悬停能看完整的。列表密度不变 —— 一屏还是那几条卡。
- **新增 i18n 键 `输入 {p1}`**：折叠态没有分隔符（`输入 南京今天天气`），展开态仍是 `输入 · 值 · #选择器`，两种文案分开，别让 `·` 在链里跟 `→` 打架。

**取舍：** 不做「每步耗时」与「执行到第几步」—— 子步骤仍然是从源码解析出来的要求，不是浏览器回传的轨迹（D310），折叠行能说的只是「这一步被要求做过」。也不把 `read` / `shot` 留在链里凑信息：留着就回到「七张卡同一行」的老问题。

**验证：** `npm run test:browser-ops`（31 条，新增两条：`foldedSteps()` 在真实脚本上只剩「打开 → 输入 → 点击」；只有读页面时兜底、且被 wait 隔开的两步并成一条）；`npm run test:browser-ops:ui`（42 条，假 pi 的 `BROWSER` 场景多了两颗 `write` + `bash node x.mjs` 的脚本卡：折叠行要点出打开的网址与输入的值，链再宽也要整条挂在 `title` 上）。红过的判定：改动前两张脚本卡分别是 `search.mjs · 读取页面信息 ×2` 与 `inspect.mjs · 读取页面信息`，与用户截图逐字一致。

## D319 正文里提问不再放过：停下前核对，没走 `ask_user_question` 就续跑一次（用户要求 2026-11-18）

**问题：** 会话「回复时间」（`455ac52c`）第 12 轮，模型加载了 `grilling` 技能，按技能模板在正文里写了 `❓ Q1 / ➡️ 建议` 一次问三个问题，整轮没有调用提问工具；用户第 13 轮追问「为什么没用表单」才补上。技能规定的是「问什么」，却把「怎么呈现」也接管了。项目里只有交付礼仪那一条「用问卷问预览」的提示词（D191 / `DELIVERY_HINT`），通用的「提问走表单」从来没有写成可执行规则 —— `AGENTS.md` 与它的 git 历史里 `ask_user_question` 都是 0 命中，所以冲突时没有任何东西把输出拉回表单。

**决定：**

- **规则写死**：`AGENTS.md` 新增「提问：一律走 `ask_user_question`」——正文里不留待答问题；技能格式只约束问什么，题干整段进 `question`，分支进 `options[].description`，推荐项放第一个并标「（推荐）」。工具自带「Type something.」，不要加「其他」选项。
- **兜底按 `plan-nudge` 的路子**：新扩展 `bridge/ext/ask-nudge.ts` 挂在 pi 的 `agent_before_settle`（停下前最后一个能动手的点），条件满足就追加一条 `display:false` 的 `custom_message` 并 `continue: true`，让模型把同一批问题搬进表单再停一次。不选「网页端把自由文本渲染成问答卡」：解析不可靠，答案回填也没有着落。
- **只认三种提问结构**，宁可漏一次也不误伤正常总结：`❓` 标记后 400 字内有 Q 编号或问号；行首 `Q1` / `Q2` 段里有问号；结尾 600 字内有问号、问号前有第二人称或「要不要我」，且结尾含选择词。代码块与行内代码先剥掉。
- **去重与上限**：提醒按问句摘要（djb2 hash）记进 `custom_message` 的 `details`，同一段问句只提醒一次，整会话最多 `MAX_NUDGES = 2` 次；第二次还不动就放过，不把会话卡在续跑里。
- **默认开**：开关 `web.askNudge`，只有显式写 `false` 才关；设置文件读不到 / 坏 JSON 都按开处理 —— 这是兜底，不该静默失效。每次停下现读，改了不用重启会话。

**取舍：** 兜底会多一次模型请求，但只在「正文提问且没走表单」时发生；正常回答、工具结果结尾、本轮已经调过提问工具都不触发。检测是启发式的，引用用户原话里带「怎么」之类的问句可能误报一次，代价是一轮提醒而不是错误输出；`MAX_NUDGES` 把最坏情况封在两次。没有改全局 `grilling` 技能（用户明确要求只在本工程兜底），技能格式与表单的冲突由 `AGENTS.md` 的规则文本裁决。

**验证：** `node --experimental-transform-types bridge/tests/ask-nudge-unit.mjs`（44：三种结构命中、正常总结 / 代码块 / 无第二人称疑问不误伤、本轮调过 ask 工具不触发、末尾是工具结果不触发、旧名字 `question` 也认、同一问句去重、上限、开关默认开与显式关、中断 / 出错 / 不能续跑都不续跑、保留前面处理器的 entries）；`npm run test:ask-nudge`。
## D320 文件管理器换成控制台骨架：和附件弹层同一份实现，两种壳（用户要求 2026-11-18）

**问题：** 顶栏 📁 打开的浏览页和下沿「文件」的附件弹层是同一件事的两种做法，旧的那种明显没打磨过：

- 路径是一整行会折行的字符串（`此电脑 / var / folders / …`）。实测 760px 的面板里它占三行，把工具条顶成三层；面包屑每一段虽然能点，但长路径只能折。
- 工作目录 / 复制路径 / ＋文件夹 / ＋文件 四颗按钮挤在路径右边，窗口 1024px 就掉到第二行。
- 排序是单独一排小字（名称 大小 修改时间），不是表头。
- 行高 39px，目录行没有大小 / 修改时间，跟文件行对不齐；只有很淡的 hover，没有分隔感。
- 没有状态栏，页脚只有一句「已加载 10 / 10」。

附件弹层（#421）已经照「本机管理」重做过：左栏（快速位置 / 此电脑 / 最近 / 当前目录）、四列表格、sticky 表头、行内两颗动作。同一个 `dirpicker.ts` 支持两种版式，差的只是外壳。

**决定：**

- **一份实现、两种壳**：`openFileConsole({ chrome })`。`dialog` = 附件弹层（遮罩 + 标题栏 + 页脚 + 从本设备选文件）；`pane` = 文件管理器浏览页（没有外壳，viewer 自己的头在上面）。左栏、表格、状态栏、窄版折叠两边共用。
- **行语义由调用方注入**（`actions` / `onPick` / `onContext`）：弹层点行 = 引用（图片 = 附加）并收起，文件管理器点行 = 打开预览、右键出菜单。不传时用弹层那套默认值，`app.ts` 给 pane 传文件管理器那套。
- **行高 30px**（`.fc-console .fc-table td { height: 30px; padding: 0 10px }`）。表格保持自动布局，名称格用 `max-width: 0` 让长名字走省略号：`table-layout: fixed` 下把某一列 `display: none`，那一列仍会占宽度，窄版收列收不干净（实测列宽 405 而表格 520，右边空一条）。
- **工具条三行**：面包屑 + 右侧一组按钮（`.fc-actions`，整组换行，不会剩一颗刷新孤零零挂在下一行）；跳到路径 + 筛选 + 包含子目录；可点排序的 sticky 表头。
- **面包屑只占一行**：横向滚到尾巴（当前目录就在眼前），左边还藏着内容时渐隐，右边还有内容时另一侧渐隐。
- **状态栏**：控制台里 `dir-pagefoot` 常显，左边「已加载 N / M」（没有分页的旧桥写「N 项」），右边当前目录。pane 壳才写路径：弹层已经在自己的页脚写了一份，不重复。
- **窄版按面板自己的宽度折**（`ResizeObserver` + `clientWidth`，布局 px）：≥780 立左栏，700 以下左栏折成顶上一条横标签，430 以下连标签也收掉；<560 收「修改时间」，<430 再收「大小」。不读窗口宽度：792px 的浏览页常挂在 1440px 的窗口上，`@media` 等不到（D263）；也不读 `data-console-*`，那套是 `#app` zoom 之后的窗口宽度（D158），比面板宽出几百 px。
- **弹层继续读 `data-console-*`**（1120×800 的固定外壳，跟窗口同生共死），所以那一组规则原样保留，只加了 `.fc-dialog` 作用域 —— 否则窗口一窄，pane 壳的列也被它收掉。

**取舍：** 文件管理器是右侧 760px 的面板，左栏只有在全屏（⤢）的 viewer 或 1120px 的附件弹层里立得起来；760 以下折成横标签，等于常用宽度下「左栏」就是顶上那一排。要真立左栏得把 viewer 加宽，那会连带影响预览 / 编辑态的宽度，留作下一步。手机宽度下顶栏本来就把 📁 收起来（D281），这一版没有动它。

**验证：** `node probes/fs-console-ui.mjs`（19 项：控制台壳有左栏、四列表头、状态栏写当前目录、没有重复标题栏、点行 = 预览、行内引用进输入框、右键菜单、跳到文件落在父目录并标出该行、面包屑分段、点此电脑、＋文件夹停在原地、900 / 560 不横向溢出、弹层仍是标题栏 + 页脚且不在状态栏重复写路径、弹层点行 = 引用并关闭）；`node bridge/tests/attach-picker.mjs` 的上传 / 引用 / 带空格目录几段；`node probes/fs-ui.mjs` 的 1–7 步（第 8 步的手机段与本决定无关：560 以下顶栏藏起文件管理器）。`npm --prefix web run typecheck`（含 i18n / viewport / layers 三道守卫）。顺手修了 `probes/fs-ui.mjs` 两处早就对不上的断言（面板页签多了「对照」、「↑ 上一级」现在是 `.fc-up`）。

## D321 文件搜索：索引自己建（node:sqlite + 扫盘 + fs.watch），不借 Everything（用户要求 2026-11-18）

**问题：** 客户端里按名字找本机文件，原来只有 `@` 补全那一套：`bridge/src/filesearch.ts` 现跑 `git ls-files` 或 `readdirSync`，上限 20 000 条、缓存 10 秒，面板一关就全丢。会话目录之外的东西（`C:\Users\…`、别的盘）搜不到；20 万文件的项目一搜就空。

**决定：**

- **索引建在桥端，用 Node 自带的 `node:sqlite`**（本机 Node 24.22.3 / SQLite 3.54.1，FTS5 与 trigram 都可用）。不借本机 Everything：那要用户另装一个外部程序、也只有 Windows 有，与「客户端自带」相冲突。用动态 `import("node:sqlite")` 并 catch —— 22.5–22.12 上它需要 `--experimental-sqlite`，静态 import 会让那些机器上的 bridge 直接起不来。
- **只有一张表**：`files(path PRIMARY KEY, nlow, size, mtime, is_dir, vol, gen)` + `idx_files_nlow / idx_files_vol / idx_files_gen` + `meta(k, v)`。`nlow` 存 basename 小写（前缀查询吃索引），整条路径还是 `path`。库文件走 `statePath("filesearch.db")`。
- **查询两段式，不上 FTS5。** 第一段 `nlow LIKE 'q%'` 吃 `idx_files_nlow`；不够 200 条才补第二段 `(nlow LIKE '%q%' OR path LIKE '%q%') AND path NOT IN (已取到)`。100 万行实测：前缀 0.4 ms、子串 0.6 ms、子串 + `ORDER BY length(name), name` 100.8 ms、建库 2.9 s / 168 MB，trigram FTS5 子串 0.7 ms —— 目标是 100 ms，多花一倍磁盘不值。
- **卷勾选是显式清单，空清单 = 全关。** 这是踩过的坑：把 `enabled.size === 0` 当「没设过」，用户把卷全勾掉之后 `[]` 会退化成「不限范围」，取消勾选照样搜出结果。现在 `enabled: Set | null`（null 才是全开），query 里 `volFilter()` 对空清单直接回空；Web 侧同样以显式集合维护，「所有卷」是填满而不是清空。
- **扫描是显式栈 DFS + `opendir`**，每 500 条一个事务、每批 `setImmediate` 让出；`SKIP` = `.git node_modules dist build __pycache__ .venv venv target $Recycle.Bin "System Volume Information" WinSxS Windows.old`。扫完用世代号 `gen` 删掉本轮没见到的行（整棵子树被删也能收尾）。`fs.watch(root, { recursive: true })` 做增量，每次事件 800 ms 防抖后 `syncPath`。
- **入口与形态：** 顶栏「🔎 文件搜索」+ `ctrl+shift+f` + `runAction("filesearch")`。面板是控制台式（用户在三张样张里选的 A），外壳直接复用 `.sys-back / .sys-console / .sys-head / .sys-main / .sys-foot`；`.sys-console` 本来就是四行网格（head / 搜索行 / main / foot），不用改它，也不会踩「隐藏子元素挪行」那个坑。单击一行 = 引用并关面板，`Ctrl+Enter` = 关面板并在预览里打开。
- **进 `CHROME_IDS`，但不进 `SESSION_ONLY`，且默认隐藏：** 索引是机器级的，没开会话也能用，所以设置里关掉就是真关掉，不是「有会话才画」。用户要求「和顶部按钮一样能在设置里关」＋「默认隐藏」，于是它既进白名单（`web/src/chrome.ts` 与 `bridge/src/extmgr.ts` 两份要同步，`web/tests/chrome-unit.mjs` 的 TOP 表跟着改），又进了 `DEFAULT_HIDDEN` —— 键缺失时不画，只有显式 `true` 才占顶栏。加一个不常用的大按钮却不让人先把它关掉，比不加更脏。
- **名字就叫 Everything：** 用户 2026-11-18 定的（“更名为 everything”）。它不是品牌借用 —— 界面上要表达的就是「像 Everything 那样找」。i18n 键写成 `tr("🔎 Everything|顶栏按钮")` 这种带上下文后缀的形式：`i18n-check` 只收含 CJK 的 tr 键，纯拉丁键会被当成「词典里多余的键」。
- **行尾三颗动作：引用 / 打开 / 位置**（抄文件弹层 `.fc-acts` 的做法）：整行点击仍是「引用并关面板」，精确动作走行尾按钮；「位置」直接走桥端 `POST /api/reveal`（`explorer /select`），**面板不关** —— 人多半要继续看后面的结果。**目录行换一套**：目录没有「预览」这回事，「打开」与「位置」都变成「打开目录」，点了在应用内文件管理器里进到那一层（`openFiles(start)`，没开会话时退回资源管理器）。

**取舍：** 首次全盘扫描要几十秒到几分钟（满盘未实测；1 百万行建库 2.9 s，瓶颈在目录遍历与 `lstat`），期间可以先搜已经进库的部分；只做了「暂停 / 继续」，没做限速。不做 USN 级实时（要管理员权限 + 卷句柄），`fs.watch` 漏掉的事件靠下次重扫收。`node_modules` 这类目录永远不进索引，与 `@` 补全的老规矩一致。

**验证：** `node bridge/tests/fileindex.mjs` 六条（转义、卷标识、真扫一个临时目录、删文件后 `syncPath`、`PI_WEB_FILEINDEX=0`、卷全取消再勾回）；`.scratch/filesearch/ws-probe.mjs` 起隔离 bridge 走真 WS（status → query → 取消全部卷 → 0 条 → 勾回 → 又有）；`probes/filesearch.mjs` 真浏览器四段（打开即列出 → 输入出结果且 `node_modules` 不出现 → 点一行引用进 composer → ArrowDown + Ctrl+Enter 开预览）；`npm --prefix web run typecheck` 全绿（含 i18n 三语键集合、viewport、layers）。截图在 `.scratch/filesearch-ui/shots/`。

## D322 Copilot 积分跟着 `session` 帧走，不在订阅后干等下一轮（2026-11-19）

**问题：** test 会话刚打开时「执行」面板有「Copilot 积分」块，几轮之后整块消失，直到下一轮结束才回来。`copilot` 帧只在 boot（`openLive` / `resume`）、`agent_end`、`agent_settled` 三处发；而 `subscribe` 只回一条 `session` 帧，前端 `case "session"` 里又无条件 `this.copilot = null`。页面重连、切会话回来、`stepup-ok` 之后的 resync 都走 `subscribe`，于是这三条路都会把面板清空 —— 正在跑的那一轮里（截图时 135 秒 / 213 字）就一直是空的。真桥实测：订阅后 8 秒内 `{"hello":1,"session":1,"ctxlog":1,"stats":1,"filesearch.status":1126,"catalog":1}`，`copilot` 帧 0 条。

**决定：**

- **`SessionSnapshot` 加 `copilot: CopilotView | null`**（`bridge/src/sessions.ts`）：`emitCopilot()` 把合并过账号额度的视图存进 `this.copilotView`，`snapshot()` 带出去。`sessionFrameOf` 是 subscribe / claim / create / reload 四条路共用的那一处（`bridge/src/index.ts:2625`、`:2704`、`:2832`、`:3268`），所以四条一起带上这个字段，不必给每条都补一次构造。冷会话（从未统计过）的首帧里它还是 `null` —— 缓存视图没算过，这一次由下面那条 `refreshCopilot()` 的帧补上，毫秒级；探针第一轮常常就是从那条帧拿到的。
- **`subscribe` 里补一次 `refreshCopilot()`**：缓存视图只覆盖「已经统计过」的会话；页面刚打开（bridge 重启过、或这条会话从未 boot）时缓存还是 null，靠这次增量读（一次 `stat`，读不到新字节就不扫）当场算出来。
- **前端 `case "session"` 读 `msg.copilot`，不再清空**：会话帧本来就只发当前这条会话（切会话时 `currentId` 跟着换），不存在串号；旧 bridge 不带这个字段时 `copilotFromFrame` 拿到 undefined 就回落 null，行为与以前一致。
- **两半各留一个探针**：`probes/copilot-on-subscribe.mjs` 打真桥（只读，登录 + subscribe）量「订阅后 3 秒内拿不拿得到」—— 跑在未修复的 bridge 上 2/2 次拿不到，跑在修复后的隔离 bridge 上连跑 5 次都 2/2 拿到（第二次起直接来自 `session` 帧）。它挑会话的判据与 `CopilotTally` 对齐（`message.role === "assistant"` 且 `provider === "github-copilot"`，或 `custom` / `copilot-credits`），**不能只搜字符串**：工具输出与模型自述里出现 “github-copilot” 的会话满地都是，实测这个漏洞会挑中一个一分积分也没有的会话，把红/绿判反。等 `session` 帧才开始计时（框架前面的 git trust 首次可能慢到十几秒，那是环境不是 bug）。`probes/copilot-panel-resubscribe.mjs` 用桩桥 + 真前端量另一头，四种帧形状：帧自带 copilot（切会话 A→B→A、整页重载之后块还在）、纯非 copilot（不画）、旧 bridge 的 boot 形状（帧里没这个键、另跟一条 `copilot` 帧 → 仍然画得出来）、旧 bridge 的重订阅形状（什么都不补 → 不画，前端不拿上一份去猜）。

**取舍：** 没有改成「轮次进行中也定时推积分」。积分只在会话文件写完一条 assistant 后才有变化，而 `session_start` / `agent_end` / `agent_settled` 已经覆盖了写入时刻；再加定时器只会多出一堆无变化的帧。也没有把 `copilot` 挪进 `items` 帧 —— 那条是分页用的历史正文，混进计费数据会让 `frameFor` 的两形（paged / full）多背一个不相干字段。

**验证：** `node probes/copilot-on-subscribe.mjs`（对着未修复的 bridge 2/2 红；对着修复后的隔离 bridge 连跑 5 次 2/2 绿）、`node probes/copilot-panel-resubscribe.mjs` 八条全 ok、`npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（含 i18n 三语 / viewport / layers）。

## D323 缺卡口径：申请与假日先豁免，同一时刻的打卡算缺一次（依据 2026-11-19）

（原编号写成 D322，与同一天落进 main 的「Copilot 积分跟着 `session` 帧走」撞号，合并后改成 D323。）

**问题：** 同事报来两条：11/13 只打了一次卡（09:27 / 09:27）却记「缺卡 0 天」；11/2 请假已批准（未打卡）却记「缺卡 1 天」。旧 `summarize` 只判 `!clockIn || !clockOut`，且只把 `day_type === 1` 当休息日：OA 把单次打卡镜像成 `start === end`，两头都非空就漏掉；整天调休 / 法定假日（`day_type` 2、3）没打卡则一律算缺。本机 180 天真实数据旧口径误判 8 天（5 天整天假 + 3 天 `day_type` 2/3 假日），新口径 0 天。

**决定：**

- 缺卡的唯一判定入口是 `isMissingRow(row, today)`（`bridge/src/attendance-model.ts`）：`dayOff`（`day_type` 1/2/3，即 `dayOffOf`）、`fullDayExcused`（请假 / 出差 / 居家 / 活动合计 ≥ 8 小时，或 `home === 1`，或 `special_reason` 非空）、`date === today`（今天还没下班）三条都豁免；余下的加上 `clockIn === clockOut`。
- 阈值取 8 小时的依据是 OA 导入模板那句「请假总时长不可超过 8 小时」；半天假（0 < 小时 < 8）且完全没打卡仍算缺卡 —— 宁可多报也不漏报。
- 假日并进「周末」桶：`summarize` 的 `weekendOvertime` 现在收 `dayOff` 行的加班，不新增字段、不动接口。
- 旧缓存不升版本号：`rowsInRange` 见到没有 `dayOff` 字段却带 `raw` 的行就用 `mapRow(raw)` 重映一遍；连 `raw` 都没有的老行退回老字段 `weekend`（只可能是手改过的缓存）。
- 「缺」由桥端算好下发（`viewRows()` 在每行上补 `missing`），前端只照着高亮，不再自己推导。

**取舍：** 判定读的是 OA 原始行的请假小时字段（`c_hours` / `t_hours` / `s_hours` / `o_hours` / `bt_hours` 加 `home` / `special_reason`），这些名字是 OA 前端的约定；OA 换字段名这里会静默退回「只看有没有打卡」。整天假按 8 小时判，7.5 小时的年假会被算成缺卡（本机数据里没有这种样本）。时间只比到分钟（`clockOf` 取 `HH:mm`），真实两次打卡若只差几秒也会被当成同一时刻 —— 镜像行的两端是逐字相同的，这个方向宁可多算一次缺卡。

**验证：** `node bridge/tests/attendance-unit.mjs` 57 条全绿（新增六条：`day_type` 1/2/3 都是休息日且 4 不算、全天申请从小时字段认出来、整天请假 / 假日没打卡不算缺卡、上下班同一时刻算缺一次、假日加班进周末桶；改前 8 条红）；`node bridge/tests/attendance-e2e.mjs` 33 条全绿（新增整天调休与假日两行，并把旧版缓存形状 `{weekend:true, raw:{day_type:2}}` 写进去验证重映）；`node web/tests/attendance-unit.mjs` 14 条；`npm --prefix bridge run typecheck`、`npm --prefix web run typecheck`（含 i18n / viewport / layers）全绿；把 `.scratch/attendance/att-a.json` + `att-b.json` 的 180 行 raw 直接跑 `summarize`，`missing` 从 5 + 假日误判降到 0。

## D324 文件搜索：每条 SQL 的执行计划钉死，名字子串不再顺着索引回表；重建不清表（2026-11-19）

**问题：** 真机索引 2.06M 行（库 1.0 GB）时，Everything 面板「什么文件都没有了」：状态是「就绪 · 2.06 M 项」，结果区一直空、页脚 0 ms。查询本身没报错，是**慢到出不来**：`node:sqlite` 是同步 API，一条查询跑多久整个 bridge 就停多久，逐键输入又排起一串。用同形状的 2.06M 行合成库（558 MB）逐条计时：

- 每条带卷过滤的 SQL 都写成 `vol IN (?,?,?)`，SQLite 挑了 `idx_files_vol` —— 三个卷就是整张表，再临时排序：空查询 1.0 s，前缀 2.1 s。
- 前缀写成 `nlow LIKE 'x%'`：默认 LIKE 不分大小写，BINARY 的 `idx_files_nlow` 根本用不上。D321 头注里「前缀 0.4 ms」只在小库、无卷过滤时成立。
- 名字里没有的词（逐键输入时几乎每一键）会落到子串段：`(nlow LIKE '%x%' OR path LIKE '%x%') ... ORDER BY nlow`，计划是顺着 `idx_files_nlow` 一行一行回表，**单条 21.7 s**。
- 「重建索引」先 `DELETE FROM files`：真机日志里事件循环停了 17 s（03:22:12 的日志 03:22:29 才落盘），删完库是空的，要等整轮重扫（约一小时）才回来。

**决定：**

- 卷过滤写成 `+vol IN (...)`，一元 `+` 让它不能走 vol 索引；前缀改成 `nlow >= ? AND nlow < ?`（上界拼 U+10FFFF）走名字索引区间；名字子串先在 `idx_files_nlow` 上覆盖扫描拿 rowid（只读索引，不回表），再取那几行；新增 `idx_files_mtime`、`idx_files_size`，空查询按时间 / 大小排直接走索引顺序。
- **只按名字匹配，搜索词带 `/` 或反斜杠才匹配整条路径**（和 Everything 一致；用户 2026-11-19 选定）。路径子串必须顺序读完整张表（合成库 1.1 s），只在用户明确在搜路径时付这笔账。Windows 上 `/` 当反斜杠用。
- **重建不清表**：`start()` 不再有 `rebuild` 参数，重建就是再扫一轮，边扫边覆盖，扫完按 gen 删掉本轮没见到的行（`gen < ?` 走 `idx_files_gen`，原来的 `gen != ?` 是全表扫）。重建期间照样能搜。
- `FileIndex.explain(q, opts)` 返回 `query()` 每段 SQL 的 `EXPLAIN QUERY PLAN`。测试在小库上断言计划形状（没 ANALYZE 时 SQLite 在大小库上的选择一致）：不出现 `idx_files_vol`、有词时不出现 `SCAN files USING INDEX idx_files_nlow`、空查询不出现 `TEMP B-TREE`。

**取舍：** 仍然不上 FTS5 trigram（D321 第 1 条）：名字子串覆盖扫描 2.06M 行约 0.2–0.3 s，够用；trigram 要给路径建就是几个 GB。也没有把查询挪到 worker：计划修好后最慢的是显式路径搜索（~1 s），先不为它引入第二个连接。

**验证：** 合成库上同一组查询：空查询 1004 ms → 5 ms，前缀 2092 ms → 6 ms，不存在的词 1975 ms → 167 ms（子串段 21.7 s → 0.27 s），按大小排 0.7 s → 2 ms；`node bridge/tests/fileindex.mjs` 十项全 ok（新增三项在旧代码上红）；`node probes/filesearch.mjs` ok；`npm --prefix bridge run typecheck`。
## D325 「发送中」必须能解释自己：连败 3 次改口 + 立即重试（2026-11-19）

**问题：** 用户报「接受了对方从缺陷记录联动过来的记录包之后，我再回消息，气泡一直显示『发送中…』」。实测（本机 `~/.pi-peer/outbox.json` + `logs/peer.log`）根本不是记录包的事：对方的 7865 入站 TCP 被静默丢弃（4 秒超时，连试 29 次都没通），而我们这边 **第一次「收到」在记录包到达的同一分钟就已经在超时重投**。真正让用户困惑的是产品行为 —— `foldEntries` 只认「在不在 outbox 里」，`pending.has(id)` 就画「发送中…」，而 outbox 把超时一律当可重试、24 小时才过期；「发送失败 + 重发」只挂在 `ack.failed` 上，一条永远送不到的消息要等到**明天**才肯说自己没送到，中间没有任何「为什么」和「手动再来一次」的入口。

**决定：**

- **状态仍然派生、不落盘**（D299 不变），但把 outbox 里已经有的东西交出去：`Queued.lastError` 记下每次投递失败的原因（`flush()` 重试分支里 `item.lastError = verdict.error`），`pendingFor()` 除 id 集外多交一份 `Map<id, {tries, error}>`，`foldEntries(entries, me, pending, why)` 把它折成视图字段 `ViewEntry.tries / sendError`。视图字段的边界还是那条：**服务端算，页面只画**。
- **`state === "sending"` 分两步说**：`tries < 3` 照旧「发送中…」（正常的一次投递、一次重连）；`tries >= 3` 改口成琥珀色「对方没响应（已重试 N 次）」+ 一颗「立即重试」（`STALL_TRIES = 3`，`web/src/peer/main.ts` 的 `stalled()`）。3 次意味着已经跨过约 1+2+4 秒的退避，够排掉「刚好在切换网络」；24 小时的补投**不取消** —— 改口只是不再骗人，不是放弃。
- **原因说人话**：`why()` 先把真正的原因从 `err.cause` 里挖出来（Node 的 `fetch` 只把 `fetch failed` 摆在最外面，`connect ECONNREFUSED 127.0.0.1:7865` 在 cause 上 —— 不挖的话页面拿到的永远是 `fetch failed`，谁也翻译不出人话），再交给 `errorText()`：`abort/timeout` → 「连不上对方（4 秒没响应）」、`ECONNREFUSED` → 「对方没开内网通（连接被拒绝）」、`ECONNRESET/EPIPE` → 「连接被对方重置」、`ENOTFOUND/EAI_AGAIN` → 「地址解析不出来」，认不出的原样显示。这类故障的判别点只有这一个：**同一个端口在别人机器上通、在他机器上不通**，就说明防火墙 / bind 在他那边（`ping`、`arp`、445 都判不出来，本机实测 ICMP 与未开放端口一律静默丢弃）。
- **「立即重试」走 `nudge()`，不走 `retry()`**：那条消息本来就在队列里，`add()` 按 id 去重会什么都不做 —— `Outbox.nudge(id)` 把 `nextAt` 归零再 `flush()`，语义是「现在就去试」，成功后 `state` 自然变 delivered，失败则 `tries` 加一（页面两秒内从 2.5 秒轮询里看到新数字）。`retry()` 留给「队列里已经没有这条」（早已过期 / 从没进过队）的情况，它要求消息真的不在排队中。
- **顺手修 `retry()` 把 note 的 kind 写成 `text`**：`outbox.add({ ... kind: "text", payload: entry })` 对记录包会拼出 `{kind:"text"}` 帧，对端 `acceptText` 判定 `bad message` 回 400 —— 记录包重发从来没成过。`retry()` 现在保留 `entry.kind === "note" ? "note" : "text"`（两者的 control 形状本就能互用，`acceptNote` 只读 `control.id/from/note/at/seq`）。
- **页面允许对 note 点「重发」**：`resend()` 的条件从 `kind === "text"` 放宽到 text / note。

**取舍：** 没做「超过 N 分钟就自动判失败」。outbox 的 24 小时补投是 D103 有意留的（对端可能一整天没开机，`409 还没学到你` 也要靠它兜），改成短超时会让「他下午才上线」变成永久丢失；用户要的是**当时就知道**，不是「更早放弃」，所以只加解释与手动入口，不动过期窗口，也不改退避曲线。也没给文件卡加这套：文件传输不走 outbox（token / 分块 / 哈希自成一摊），它显示的「发送中…」本来就有进度条和失败态。

**验证：** `node bridge/tests/peer-e2e.mjs`（新增「停掉对端后仍带 tries/sendError，state 仍是 sending」「立即重试之后同一条只把 tries 往前推、不多出一条」两段 —— 第一步就抓到 sendError 原本是 `fetch failed`，才有了上面的 `why()`）；`node bridge/tests/peer-ui.mjs`（假 API 灌 `state:"sending", tries:7, sendError:"The operation was aborted due to timeout"` → 气泡出现「对方没响应（已重试 7 次）」与「立即重试」，点它发出 `POST /api/peer/retry`；`tries:1` 的那条仍只写「发送中…」且没有按钮；`delivered` 写「已送达」）；`node bridge/tests/peer-note-unit.mjs`、`node bridge/tests/peer-history.mjs`；`npm run typecheck`（含 i18n 三语键集合 / viewport / layers）。

## D326 热部署不再闪窗，并复用同一扇 pi bridge 窗口（用户报障 2026-11-19）

**问题：** 在 Windows 上点热部署，会有一串黑色控制台窗口弹出又关掉，`npm run build` 那扇会一直开到编译结束；最后旧的 `pi bridge` 窗口关掉，再弹一扇新的。用户问能不能「一个窗口干完所有操作」。

**根因：** 桥用 `spawn(..., { detached: true })` 起 worker（`bridge/src/hotdeploy.ts`）。在 Windows 上这是 `DETACHED_PROCESS`，worker **没有控制台**。worker 里的 `spawnSync`（`git` 十几次，`powershell` 用来找 pid / 查子进程 / 轮询存活，`taskkill`，`cmd` 跑 `npm run build`）都没带 `windowsHide`，所以每一次调用，系统都会给子进程新建一个**可见**控制台。已用探针复现：同样参数起的子进程，默认 `IsWindowVisible(GetConsoleWindow())` 为 True；带上 `windowsHide` 后 hwnd=0。bridge-update skill 的 `restart.mjs` 是经 `Start-Process -WindowStyle Hidden` 起的，自带一个隐藏的控制台，所以没有这个问题。

**决定：**

- `scripts/hotdeploy.mjs` 的 `sh()`、`build()`，以及 `scripts/hotdeploy-git.mjs` 的 `gitIn()`，全部带上 `windowsHide: true`。已实测：外层 powershell 带 `windowsHide` 时，`Start-Process` 照样能打开可见窗口。
- 换进程用的窗口改成一个**循环脚本** `.scratch/hot-deploy/bridge-window-<port>.ps1`（由 `scripts/hotdeploy-window.mjs` 的 `windowScript()` 生成）：`node bridge\dist\index.js` 退出后，若存在 `relaunch-<port>` 标记，就删掉标记、在**同一扇窗口**里再起一次；没有标记就退出循环，窗口关掉（关窗即停、杀桥即关，D154 的语义不变）。分支名每一轮现查，因为复用窗口时，脚本里写死的分支会过期。
- worker 在杀旧桥之前，用 `windowHostOf(oldPid, port)` 查旧桥的父进程是不是本端口的循环窗口。是的话就放下标记，杀桥后等 5 秒，看窗口有没有收走标记。收走了就不再开新窗口；没收走（旧桥没死、窗口被关）就撤回标记，照旧 `Start-Process` 开一扇新窗口。旧版 `start-bridge.ps1` 窗口、手动 `npm start` 的终端都不认，所以升级后的第一次部署还会换一扇新窗口，从第二次起就一直复用这一扇。

**取舍：** 没有让 worker 自己在可见窗口里跑（那样进度也能看见）。worker 必须先 build、再杀桥，进度已经在页面上轮询显示，再开一扇窗口只会多一扇。也没改 bridge-update skill，D254 规定两者不共用入口。

**验证：** `node bridge/tests/hotdeploy-unit.mjs` 新增一段静态守卫：`scripts/hotdeploy*.mjs` 里每一处 `spawnSync(` 都必须带 `windowsHide`。去掉 `hotdeploy-git.mjs` 里的那一个，守卫会变红。`node bridge/tests/hotdeploy-window-e2e.mjs`（Windows，`npm run test:hotdeploy-window`）用一份假桥覆盖三件事：`windowHostOf` 认得本端口、不认别的端口；有标记时同一父 pid 原地重起、标记被收走；没有标记时窗口随桥关闭。把标记写到别的路径，这段测试会变红。`hotdeploy-stash-unit.mjs` 在 main 上本来就红，与本条无关：临时目录在这台机器上是 8.3 短路径（`YANGQM~1.HYR`），`occupiedBy()` 把它误判成「已被别的 worktree 检出」。

## D327 新建即置顶：所有入口建出来的会话都落到 pin 末尾（取代 Q-022「只有横条 ＋ 置顶」，2026-11-19）

**问题：** 用户报「Jira 里交给 agent → 新开一个会话，建出来没有星标」。查下来是一类问题：只有横条 ＋、工作区竖列 ＋、工作区弹层「＋ 新会话」三处传了 `openNewSessionSheet(true)`，`create` 帧才带 `pin: true`；左栏「开新会话」、`/new`、快捷键、新建空工作区后弹出的面板、所有「交给 agent → 新开会话」（Jira / 笔记 / 失败面板 / 分支面板 / 目录与仓库，经 `newSessionWith` 写死 `false`）都不置顶。分叉 / 复制、`/import` 由桥直接建，没有 pin 的概念；只有交接「接棒」在 `startHandoff` 里自己 `pinLast`。同一件事三种行为，加入口还会再漏。

**决定：** 置顶由桥在「会话真正建出来」的地方统一做，页面不再传 `pin`：

- `SessionManager.pinNew(id)` = `manage.pinLast(id)` + 广播 `manage`。`create()` 里调用（随手问 `scratch` 除外，#86 它不是用户的会话），所以面板所有入口、交给 agent、在第一条消息处分叉、接棒都自动覆盖；`branchOff` 的 `createBranchedSession` 路径和 `importFile` 各自补一次。
- 落到 pin **末尾**（`pinLast`，挨着横条的 ＋），不插到最前面。
- 只加不减：别的会话的置顶一概不动，分叉 / 复制的原会话照旧置顶。（接棒后原会话被归档 —— 那是交接本身的语义，`setArchived` 会把它从 pin 拿掉，与本条无关。）
- 前端删掉 `openNewSessionSheet(autoPin)` / `createSession(pin)`；桥对旧页面发来的 `pin` 字段直接忽略。

**与 D146 的关系：** D146 规定「打开 ≠ 置顶」，打开不改排列；本条只管「新建」，新建本来就要在列表里给它一个位置，两者不冲突。

**验证：** `node bridge/tests/new-session-pin.mjs`（真桥 + 桩 pi：不带 pin 的 create 落到末尾、第二个排在后面且第一个仍在、`/import` 也置顶、随手问不进 pin）；`node probes/round16-pin.mjs` 改成桩桥对所有 create 置顶，并断言页面不再发 `pin`（顺手修了它在新会话面板改版后失效的路径输入选择器）。

## D328 预览能播放视频 / 音频：浏览器能放就放，放不了降级到本机程序（#542，2026-11-19）

**问题：** 预览把 `.mp4` 当二进制，只给「新标签页打开 / 下载」；`/raw` 不支持 Range，大文件拖进度、moov 在尾部的 mp4 都放不了。Markdown 里也嵌不了视频。

**决定：**

- 桥：`kindOf` 新增 `video` / `audio`（mp4 m4v webm ogv mov mkv avi wmv flv / mp3 wav m4a aac ogg oga flac opus），带正确 MIME；`/raw` 支持单段 `Range`（206 / 416，多段与坏头退回 200 全量），本地与隧道同一条路。公网同样抹掉 `abs`。不转码、不引入 ffmpeg。
- viewer：`<video|audio controls preload="metadata">`，**不自动播放**；重绘时同一个 raw url 的播放器原地保留（不打断播放），关闭 / 换文件先 `pause()`。`error` 事件 → 和不支持格式的二进制同一张卡片：「用默认程序打开」「新标签页打开 / 下载」「在文件夹中显示」；失败过的 url 记住，重绘不再重试。
- Markdown（文档预览）：`![](x.mp4)` 按扩展名变播放器；块级 `<video>` / `<audio>` 只认白名单 `src poster loop muted width height`（`<source>` 取第一个），`controls` 强制开，`autoplay` / `on*` / `style` 一律丢弃——不是消毒 HTML，而是从不拷贝白名单外的东西。本地路径走和图片相同的 `imageSrc`（`/raw`），http(s) 直接加载。
- 聊天气泡：**本地媒体不内嵌**（和本地图片一样），变成「[视频：名]」链接，点开进 viewer；路径链接也认媒体扩展名。

**已知偏差：** `HTMLMediaElement` 没有 `referrerPolicy`，页面也没设全站 referrer 策略，外链媒体会带默认的 origin-only referrer（图片是 `no-referrer`）。

**验证：** `node bridge/tests/media-raw.mjs`（kind / MIME / Range 206·416·多段·坏头 / 隧道抹 abs）；`bridge/tests/media-grant-unit.mjs`（媒体文件都有 `/api/open` 授权）；`node probes/media-preview.mjs`（真 Chromium：webm 时长、拖动出 206、能播、关掉即停；wav；坏 mp4 与 avi 降级卡片；md 三种写法 + 白名单；聊天只出链接、点开播放；150% 字号不越界）。

## D329 浏览器面板：按「怎么驱动浏览器」认，不只按工具名认（用户报障 2026-11-19）

**现象：** 会话 18325 里 AI 点了按钮、截了图、录了视频，右栏「浏览器」却是「共 0 次 · 这一轮没有浏览器操作」。

**原因：** 那轮的操作全走 bash：`bash scripts/e2e.sh W TC-01.py TC-02.py`。真正开浏览器的是项目自带的执行器 `run.py`（`sync_playwright` + `connect_over_cdp`），用例和探针只是片段（`p.locator(...).click()`，不写 `import playwright`）。旧的 `scriptedCall()` 找到片段源码后，看它没提 playwright 就丢弃；`.sh` 不算脚本；`read` 过的脚本不进源码表；内联只认 node。另外盘点 716 份会话：用得最多的 `agent_browser`（553 次）与 `agent_browser_code`（63 次）不在默认名单里，`mcp({tool:"browser_exec"})` 网关、desktop-touch 的 `desktop-touch_browser_*` 也认不出。

**决定：**
- 工具名：默认名单加 `agent_browser`；名字里有独立的 `browser` 段（`agent_browser`、`desktop-touch_browser_click`）也算；`mcp` / `mcp__*` 网关看 `args.tool`，卡片标成「mcp · browser_exec」。只列工具、查说明的网关调用不算。
- agent-browser：把 `args` 命令行（可串联多条、`batch` + stdin、`browser({args})`）拆成步骤，`--headed` 记成有窗口。shell 里跑 `agent-browser` / `browser-use` 命令行同样算，安装、`--version`、`doctor` 不算。
- shell 脚本：先把命令切成简单命令、去掉 heredoc 正文和包装（`timeout`、`env`、`npx`、`uv run`…），只认**被执行的**脚本：解释器后面的那一份，或者作为执行器参数传进去的那几份。前者要看得出在驱动浏览器（提到驱动、起浏览器、CDP，或至少两处 page API）；后者一处 page API 就够，看不到源码也照样记一步「run」。多份片段合成一张卡，每份前面插一步「run 文件名」。`read` 读过的整份脚本也进源码表。
- python：`python - <<EOF` 里真的调了 `sync_playwright()` / `connect_over_cdp` 才算；只是用 python 改文件、`python -c "import playwright"` 检查都不算。
- 兜底：齿轮里加一栏「命令关键词」（默认空，存 `pi.browserOps.commands`），自家执行器认不出时用户自己补。
- tab 上的小圆点改用和面板同一套识别，不再只看工具名。
- **步骤以运行输出为准**（用户在测试环境里反馈：卡片只有「运行 e2e.sh / 读取页面信息 ×4 / 点击」，看不出点了哪个按钮、改了什么）：shell 跑的脚本，输出里认得出 `step …` / `手順N：…`（动作）、`OK` / `NG` / `✓` / `not ok`（断言，失败带 actual / expected）、`data:` / `db:`（读到的值）、`note:`、截图 / 录像路径、`=== 文件名` 段头，就按输出列步骤，跑的时候跟着 partial 输出实时增加（最多留最新 80 步）。一行都认不出才回到源码猜，源码里的 `step('…')` / `test.step('…')` 旁白也记成动作。卡片元信息标出「步骤来自运行输出」还是「从脚本源码推测」（`stepSource`）。浏览器工具卡不读输出（agent_browser 的快照里也有 ✓）。
- **打转只看实际执行**：从代码里猜出来的重复（循环、四次 `input_value`）不算；只有运行输出里同一步连续报了 `loopCount` 次，或者连着 `loopCount` 次一模一样的浏览器工具调用，而且这次还在跑，才标「打转」；调用一结束就不再标。

**取舍：** 只在命令里**提到**脚本名不算（`grep`、`sed -i`、`git commit -m` 都会提到），所以不能按「出现过就算」放宽；`.sh` 包装器本身也不当浏览器脚本，靠它的参数片段判断。命令关键词默认空，免得把别人的 `e2e` 字样都算进来。

**验证：** `npm run test:browser-ops` 新增 10 段（18325 的执行器片段、heredoc 探针、改文件不算、python 内联、agent_browser 三种写法、CLI、mcp 网关、desktop-touch、命令关键词），改回旧逻辑会红。拿 18325 的真实会话回放：0 张 → 9 张。716 份会话新旧对比：1409 → 2331 张，少掉的约 320 张逐条抽查都是旧版的误报（`sed` / `grep` / 改文件脚本里提到了脚本名）。`npm run test:browser-ops:ui` 补一条：齿轮里有空的命令关键词框。第二轮（输出步骤 + 打转）再加 6 段：按输出列步骤、跑着时实时 / 无输出回源码、源码旁白、工具卡不读输出、代码重复不算打转、连续同样调用或输出重复且在跑才算。用户那次 TC-01 录像会话回放：由 4 步（含「打转」）变成 26 步，逐条是手順、断言、读到的值和录像路径。

## D330 浏览器面板：以运行时真实发生的事为准，猜只用来起名字（用户追问 2026-11-19）

**问题。** D329 之后用户又跑了一轮：AI 写了个启动器 `run_green.py`（只 `import run`）、`cp` 一份片段改成中文再跑，面板又只剩一张「发 CDP」。看命令 / 源码去猜，AI 每换一种写法就漏一次，补不完。

**决定。** 三层，从硬到软：

1. **进程观察（`bridge/src/browser-watch.ts`）。** 工具在跑时，桥每 ~0.8 秒看一眼 pi 子进程底下的进程树与本机 TCP 连接：树里出现 chrome / msedge / chromium / chrome-headless-shell / firefox … 记 `launch`；树里的进程连上「浏览器在监听的本机端口」记 `cdp`（隔一层 daemon 也算）。证据写到工具卡 `ToolItem.browser`，推 `tool`/`browser` 事件，落盘到 `<state>/browser-evidence/<会话>.json`，重开会话补回。前端：有证据而命令认不出时也出卡（步骤 = 运行 <命令> + 启动浏览器 / 发 CDP，输出里有步骤仍按输出）。`PI_WEB_BROWSER_WATCH=0` 关掉。
2. **输出约定 `::browser <动作> <说明>`。** 脚本打印这种行，这次调用就算，逐行成步骤（act/ok/ng/nav/click/fill/wait/shot/video/value/note/launch，不认识的动作原样当一步）。
3. **手动标记。** 「执行」页里认不出的 shell 步骤，悬停出 🌐：点一下把被跑的脚本名（没有就用不泛的程序名）加进命令关键词。

**为什么这样。** 各种写法里不变的只有「浏览器被拉起或被连上」，这件事桥能直接看到，不依赖命令长什么样；原来的猜测留着给步骤起名字、给看不到进程的场合兜底（会话回放、远程 pi）。

**取舍。**
- 归属：pi 的直接子进程里，工具开始之后才出现的，记到开始时间在它之前、最晚开始的在跑工具上；MCP 服务器、扩展这类常驻子进程早于工具，不算。两个 shell 工具同时起子进程时可能记错。
- Windows 上每开一次 PowerShell 查 `Win32_Process` 要将近 2 秒，所以用一个常驻的 PowerShell（闲 30 秒关），netstat 另跑（几十毫秒）。真机实测：python + playwright 拉 headless 约 2.3 秒认出，连已开 Edge 的 9399 约 3.2 秒认出，不碰浏览器的 `sleep` 不误报。
- 不到一秒就结束的浏览器调用可能漏看，靠第 2、3 层和原来的猜兜底。
- `bg_run` 起的后台进程只在工具调用期间看，调用返回后就不跟了。

**验证。** `node --experimental-strip-types bridge/tests/browser-watch-unit.mjs`（8 段：launch、cdp、daemon 隔层、常驻子进程不算、dev server 端口与 pid 重用不算、并发归属、结束后不上报、netstat/lsof/etime 解析）；`web/tests/browser-ops-unit.mjs` 加证据出卡、证据 + 输出步骤、`::browser` 约定、手动标记关键词。

## D331 记录面板：顶栏全局检索，结果视图不占分区（用户报障 2026-11-19）

**现象。** 用户截图三件事：①「关闭」按钮离面板右边缘还有一大截，跟「＋ 记一条」「导出」挤在标题右边；② 顶上那个「导出」没人用，要删；③ 想跨分区找一条记录，只能先点分区再用列表里那颗搜索框，得一个个分区试。

**原因。** 头部是 `head.append(title, badge, count, el("div", "grow"), nb, exportAll, closeButton(...))`，而 `.grow` 在全仓库都没有通用的 `flex: 1`（只在 `.nc-state-bar` / `.peer-pick` / `.ask-strip` / `.fail-actions` / `.bc-col-head` 里各自定义），所以那个空 div 宽度是 0，按钮组就紧贴标题、离右边很远。

**决定。**
- 删掉「导出」：按钮、`exportAll()`、`# {p1} 记录 · {p2}` / `导出` / `把当前这一堆记录导出成一份 Markdown` / `这一堆里没有可导出的记录` / `已导出 {p1} 条` 五条 i18n 键，一起走。要整堆拿走仍可「交给 agent」，那是另一条路。
- 头部顺序改成 `标题 / 待处理 badge / 统计 / grow / 搜索框 / ＋ 记一条 / 关闭`，`.notes-head > .grow { flex: 1; min-width: 0 }`：「关闭」落右上角，标题与按钮之间留给搜索框（`flex: 0 1 300px`，最窄 120px）。
- 全局检索不新增视图状态：`searching()` 就是「顶栏输入框有字」（`gq.length > 0`），`view` / `kind` 原封不动。`visible()` 在搜索时忽略分区与分段，只看**活记录**（`!deletedAt && !archivedAt`）的标题 + 正文纯文本（沿用 `matches()`），归档 / 垃圾箱另有各自主页。
- 结果视图里：导航空放（哪一项都不亮）、分段控件与黄条隐掉、「＋ 记一条」隐掉、列表内那颗搜索框隐掉（两个框并排分不清谁管什么），列表头改「搜索结果 + 命中数 + ✕」，头部统计改「全部记录 · N 条命中」。
- 结果行标题前挂分区胶囊；行上不摆归档 / 删除两颗小按钮（它们跟着当前这一堆的语义走，跨分区结果里容易误操作）。点一行 = `clearSearch(false)` + `openNote(id)`：切到它所在的分区并选中。
- 点左侧任一分区 / 归档 / 垃圾箱 / AI 出错记录 = 退出搜索（`setKind` / `setView` 清 `gq`）；否则点了像没反应。
- Esc 两段：有搜索词时第一下只清空（焦点回到顶栏搜索框），再一下才关面板。

**取舍。** 不加 Ctrl+K（面板是临时浮层，用户没提，加了要跟编辑器 / 浏览器抢键）；不做防抖（本地数组过滤，几十条毫秒级）；搜索词不落盘、不记忆（一次性动作，记下来下次打开还会在搜，预期之外的空白屏）。列表内那颗 `.nc-search` 保留：它限当前分区、按 `seg` 过滤，适合「就在这一堆里找」，和顶栏的分工是范围不同。

**验证。** `npm run test:notes`（`web/tests/notes-sheet-browser.mjs` 第 13 段重写：跨分区命中 / 分区胶囊 / 导航空放 / 三个控件隐掉 / 列表头与头部统计 / 归档不进结果 / 正文可搜 / Esc 只清搜索 / 点结果切分区并选中 / 列表搜索框回来），原「导出」那段与 `footHint` 断言一起删掉。`npm --prefix web run typecheck`（`i18n` 无多余键）。三栏布局截图核对：头部右侧「搜索框 / ＋ 记一条 / 关闭」，搜索态中栏只剩「搜索结果 / 胶囊 / 正文摘要」。

## D332 顶栏默认对调：文件管理器默认不显示，Everything 默认显示（用户要求 2026-11-19）

**要求。** 用户原话：「现在默认文件管理器是显示、everything 不显示的。现在想要改成文件管理器默认不显示，everything 默认显示」。

**决定。**
- `web/src/chrome.ts` 的 `DEFAULT_HIDDEN` 从 `["filesearch"]` 改成 `["files"]`。三态不变：键缺失 = 按这里（文件管理器不画、Everything 画），`true` 显式打开，`false` 关掉（与缺失同效但记住「关过」）。
- **取代 D321 尾部那句。** D321 里「又进了 `DEFAULT_HIDDEN` —— 键缺失时不画，只有显式 `true` 才占顶栏」讲的是旧默认（Everything 默认隐藏），自本条起不再成立：Everything 默认就画，进 `DEFAULT_HIDDEN` 的是文件管理器。D321 其余内容（索引、两段式查询、卷勾选、面板形态、改名 Everything）不变；按 `docs/agents/domain.md` 的体例，旧条目原文保留、由本条点名取代。
- 拔掉 D138 的第二重默认：`ChromeContext` 不再带 `narrow`，`isChromeVisible()` 不再因 560px 以下把文件管理器藏起来 —— 它的默认在所有宽度一致。样式表里那条 560px 媒体查询留着，显式 `true` 时 `data-chrome-narrow="files"` 还要顶开它（#292）。
- 桥端协议与 `ui.json` 格式不动：白名单、`ui.set`（`null` 删键）照旧；已有 `filesearch: true/false` 的旧偏好照读。
- 设置 → 外观的预览仍留「桌面 / 手机 390」切换，只演示排版，不再改变预览里哪颗亮；原来那句「手机宽度下「文件管理器」默认收起」与 `ctx.narrow` 那条虚线原因（「手机上默认收起」）一并删掉，后者换成「默认不显示」。

**为什么。** 用户每天用的入口是 Everything（按名字全盘找文件），文件管理器进得少；把顶栏常驻位让给常用的那颗。顺带消掉「默认结果取决于窗口宽度」这条 D138 的历史包袱 —— 同一个账号在桌面和手机上看到的默认不一样，设置面板很难解释。

**取舍。** 没开会话时产物与文件管理器仍不画（`SESSION_ONLY` 没变），文件管理器在开关墙里是虚线方块、title 写「默认不显示」。在 390 上点亮过文件管理器（`files: true`）的旧偏好继续生效，升级后不会又消失。

**验证。** `web/tests/chrome-unit.mjs`：默认表、`files:true` / `filesearch:false` 闭环、无会话时 files 仍不画、`narrowForcedVisible` 只认显式 true；`probes/chrome-topbar.mjs` 四档宽度断言「文件管理器默认不画、Everything 默认画」、逐颗开关与重开会话后的默认；`probes/chrome-narrow.mjs` 断言 390 / 559 / 560 / 561 / 620 默认一致不画、`true` 在窄屏顶开、`false` 任何宽度都不画；`probes/chrome-sheet.mjs` 断言预览两档都不出文件管理器、点亮后两档都出、删键回默认；`probes/filesearch.mjs` 开场改为默认就在顶栏。

## D333 插件与 MCP 弹窗：已安装的 MCP 先出行后连接，搜索补全，两个市场一个样子（用户报障 2026-11-19）

1. **MCP 行不等 `pi mcp list`。** 它要挨个连上每个服务器（实测十几秒到几分钟）。桥一开始就从 mcp.json 读出行（状态「连接中」）推给页面，`pi list` 和 `pi mcp list` 并排跑，谁回来谁更新；包版本查完立刻推（`packagesChecked`），不再等 MCP。行的命令显示用户写的（`npx -y …`），不是 pi 解析后的 `node.exe …\_npx\…`。刷新时上一次的连接状态和包行保留到新答案回来（stale-while-revalidate）。
2. **pi-mcp-adapter 自己配置里的服务器也列出来**（`~/.config/mcp/mcp.json`、`~/.agents/mcp.json`、`<agentDir>/mcp-adapter.json`、项目 `.mcp.json` 等），只读：pi mcp 管不到它们，用 `/mcp-adapter` 管。
3. **MCP 搜索。** 排行索引只取每个服务器的最新版（`version=latest`），否则 600 页上限被旧版本占满、两万多条后被截断，`desktop-touch-mcp`、JetBrains 的都不在里面（索引带 `v`，旧索引照用但后台重建）。匹配看全名（去掉 `io.github.` 前缀）和安装包名，`newrelic` 能搜到 `com.newrelic/mcp-server`；有查询时同时问一次 Registry 的在线搜索合并进来（6 秒超时）。
4. **插件搜索。** npm 一次只回 250 个，列表到底时「从 npm 加载更多」按 `from=` 再取一页（最多 1000）；查询是一个确切包名而结果里没有时按名字直接查 registry，只认带 `pi-package` 关键词或 `pi` 清单的包。
5. **样子。** 已安装页嵌在各自市场的子页签里（插件市场 → 已安装：pi 包 + 插件；MCP 市场 → 已安装：MCP 服务器 + 手动添加），行用市场的卡片样式 `.ext-row`、按钮用 `mk-install`，外层页签与市场对齐、字体统一。

**验证。** `node bridge/tests/ext-manager.mjs`（首段先到的是 mcp.json 的行、状态 connecting）、`node probes/ext-manager-stages.mjs`、`node --experimental-strip-types bridge/tests/mcp-relevance-unit.mjs`。

## D334 上班时间取当天最早的真实解锁，不再按来源排先后（用户报障 2026-11-19）

**问题：** 用户截图：今日明细第一条是 09:29「解锁 · 日志」，「上班」卡却写 11:23「事件」。那天记录器 10:22 才启动（明细里 10:22 那条是 `start`，界面按 `事件` 显示），它亲眼看到的第一次解锁是 11:23。D246 第 4 条 / D288 规定 `event` > `poll` > `log` > `start`，所以只要当天有一条记录器事件，日志回填的更早解锁就被整体压掉 —— 中途装记录器的那天，上班时间被推后两个小时。

**决定：** `pickFirstUnlock` 取 `event` / `poll` / `log` 里**最早**的一条解锁，来源标那一条自己的；`start` 仍只在一条真实解锁都没有时兜底。取代 D246 第 4 条与 D288「取舍」里的来源排序；D246 想挡的「15:00 装的记录器把 09:00 顶成 15:00」照样挡得住（`start` 不参与取最早，取最早本身也不会选晚的）。

**为什么：** 三种来源都是真实发生的解锁：4624 LogonType 7/2/11… 是系统自己记的，并不比记录器的会话事件「假」；按来源排先后只在「两者报同一次解锁、时刻略有出入」时有意义，而那种情况 `dedupeEvents` 的 5 秒合并已经吃掉了。代价：RDP 连进来（LogonType 10，D288 算到岗）若早于本人到座，上班时间会按它算 —— 这和 D288 的口径一致。

**顺带查出的几处（同一 PR 修）：**

1. **往日下班漏掉最后一次解锁。** 9:00 解锁、12:00 锁屏、13:00 解锁后关机（关机不产生锁屏），下班取「最后一次锁屏」只算 3 小时、还不标推算。改成：往日最后一条是解锁就以它为下班、标 `endInferred`；最后一条是锁屏才用锁屏（抽成 `dayEnd`）。
2. **休息日照样倒计时、到点弹提醒。** D246 第 5 条定的是休息日不算倒计时，但 `summarizeToday` 没看 `workday`。改成休息日 `target` / `remainingMs` 为空，页面标题写「今天是休息日，不算倒计时」，「已工作」照走。`bridge/tests/sysmanage-ui.mjs` 种的设置改成七天都上班，周末跑也能看到倒计时。
3. **记录器启动被当成一次解锁。** `start` 计进「今日解锁 N 次」，明细里显示成「解锁 · 事件」（这次报障里 10:22 那条就是它，读截图时很容易当成真解锁）。改成不计数，明细写「记录器启动」。
4. **过了半夜还在干活，凌晨那次解锁被算成第二天上班（用户追加要求「凌晨不算」）。** 一个工作日从凌晨 5:00 算起（`WORKDAY_START_HOUR = 5`，`workDayKey`）：0:00–5:00 的解锁 / 锁屏归前一天，前一天的下班与工时顺着延长，第二天上班从 5:00 后第一次解锁算；5 点前打开页面，「今天」仍是前一个工作日。页面上跨过零点的时刻写「次日 01:30」（`dayClockText`），目标下班落在昨天写「昨天 20:23」，不再一律写「明天」。回拨用本地分量减一天，不减 5 小时（夏令时那天不错位）。代价：真在 5 点前开工的早班会记到前一天（用户选的是 5:00，不是 6:00，也不是「只不当上班、不归前一天」）。

**验证：** `node --experimental-strip-types bridge/tests/workclock-unit.mjs`：新增凌晨归前一天两例、往日最后解锁、start 不计数、休息日无目标三例；原「两者都有时不取更早的日志」改成取更早的日志（来源 log、工时 11h）；新增截图场景（日志 09:29 解锁 + 10:22 start + 11:23 事件 → 09:29 / log）与「事件更早时用事件」。`npm --prefix bridge run build`、`npm --prefix web run typecheck`、`node bridge/tests/sysmanage-ui.mjs`（105 项）、`node web/tests/sysmanage-unit.mjs`（新增「昨天 / 次日」一例）通过。

## D335 上下文面板：日志 seq 不再撞号，进度条 / 浏览器下拉 / 轮次高亮 / 过滤框输入法修正（自查 2026-11-19）

1. **seq 接着数。** 扩展每次 `session_start`（重载扩展、`/reload`、切模型后的重启）都把 `seq` / `turn` / `step` 清零，却接着往同一份 `<id>.ctx.jsonl` 追加：同一个文件里出现好几段从 1 开始的 seq（本机样本 1374 行里 802 个重号），`usage.atSeq`、事件的 `atSeq`、点柱子后的 `pickSeq` 都对不上，「第 1 轮」出现几次，轮次 KPI 偏小。扩展启动时改为读文件尾，从最后一行的 seq、最后一个请求的 turn/step/userKey 接着数（`resumeState`）。已经写坏的旧日志由桥在读时 `renumberCtxLog`（`bridge/src/ctxlog-seq.ts`）把后面每一段整体平移到前一段之后，面板与 context-insight 都经它；seq 本来单调时原样返回。
2. **当前上下文进度条。** 已用部分 `.cx-progress-used` 没有宽度，各段的百分比解析不出来，39.6% 只画成几个像素。改为已用宽度 = 已用 / 窗口，各段按已用的占比分。
3. **浏览器下拉只列最近 40 次。** 从趋势图点了更早的柱子，下拉仍显示最后一项。选中的那一步不在最近 40 次里时把它插到下拉最前面。
4. **轮次粒度的高亮。** 「轮次」柱子的 seq 是这一轮第一次请求；选中的若是这一轮的中间一步就一根都不亮，详情落到最后一轮。改为找第一根 `seq >= pickedSeq` 的那一轮。
5. **过滤框与输入法。** 每敲一下都整块重画，组字中途 input 被换掉，半截拼音被提交（「wenwenj文件」）。组字期间不重画（也推迟 ctxlog / stats 触发的重画），`compositionend` / 失焦后再画。

**没修：** 「剪枝」chip 固定 `prune: 0`；命令过滤只匹配程序名。

**验证。** `npm run test:context`（新增 `bridge/tests/ctxlog-seq-unit.mjs`、`context-log-unit.mjs` 里两条续号用例）、`node probes/context-panel.mjs`（合成三段日志，量进度条比例、下拉、轮次高亮、CDP 模拟输入法；在 main 上 2/3/4/5 都红）。

## D336 问卷说「详情在回复里」却没写正文：拦下这次提问（用户要求 2026-11-19）

**现象。** 会话 `ae79148b`（上下文面板查 bug）第 74 条助手消息只有 thinking + `ask_user_question`，题干写「查出 5 个确认的 bug（详情在回复里）」，5 个 bug 只在思考里，页面上一个字都看不到。不是客户端漏渲染：会话文件里这条消息根本没有 text 块。

**决定。** 在 `bridge/ext/ask-nudge.ts` 加第二道兜底，挂 `tool_call`，与 D319 共用开关 `web.askNudge`：
- 问卷文本（题干 / 选项，跳过 `preview`）命中「详情在 / 详情见 / 见上文 / 如上 / 上述 / 回复里 / see above」这类指向正文的说法；
- 且这次调用所在的助手消息正文去空白后不足 40 字、本轮所有助手正文合计不足 200 字；
- 就 `block` 这次调用，理由里让模型先把详情写进正文（或直接写进题干）再问。同一段引用只拦一次（按理由里的 `#hash` 认），第二次放行，不让会话卡死。

**为什么挂 `tool_call` 而不是停下前补一条。** 这时用户还没看到问卷，拦下后模型补完正文再问，用户看到的就是「正文 + 问卷」；等问卷发出去再补，用户已经在答一张看不懂的卷子了。

**验证。** `node bridge/tests/ask-nudge-unit.mjs`（第二道兜底一段：空正文拦、写了详情 / 前一步写过放行、只拦一次、开关关不拦）。

## D337 设置 → 外观加「配色主题」：默认午夜 + 晨光 / 暖炉 / 峡湾 / 素白 / 深海 / 沙丘（用户要求 2026-11-20）

**决定。** 新增 `web/src/theme.ts`：稳定 id `midnight`（默认，就是原来那套）/ `daylight`（浅色）/ `ember`（暖色深底）/ `fjord`（蓝灰深底），存在 `pi.prefs.theme`，读到乱值回默认；「恢复默认」一并回到午夜。
- 颜色真源仍在 `styles.css`：`:root[data-theme="…"]` 覆盖底色、线、文字、状态色与 `color-scheme`；三档文字亮度（D158）每套主题各写一组 `[data-theme][data-text]`，否则同特异度下主题块会把 soft / bright 吃掉。
- 强调色两变量仍由 TS 写行内样式：浅底主题换 `palette.ts` 的 `ACCENTS_LIGHT`（深一档，`dim` 是浅填充），否则冰蓝字在白底上看不清。
- `main.ts` 在登录页前 `bootTheme()`，浅色用户第一眼不闪黑；`meta[name=theme-color]` 跟着换。
- 各 CSS 里写死的深底半透明色（`rgba(255,255,255,a)` 悬停叠层、`rgba(11,13,16,a)` 毛玻璃、冰蓝 `rgba(125,211,252,a)`、状态色淡字等）改成 `color-mix(… var(--text|--bg|--accent|--ok|--warn|--danger) …)`，午夜下观感不变，换主题跟着走。
- 文案键用「配色主题」，因为「主题」已经被邮件的 Subject 占了。
- **2026-11-20 追加三套**（同一套机制，不另立结构）：`light`「素白」纯白画布（与晨光的冷灰底 #f5f6f8 拉开）、`dusk`「深海」（比峡湾暗一整档的蓝黑，`#070b14`）、`paper`「沙丘」（唯一的暖色浅底 `#f4efe4`）。小样 `.theme-demo` 的内联 `--td-*` 就是各自的底色；三套与原本四套一样补了 `[data-theme][data-text]` 的 soft / bright 两条。
- **终端跟着主题**（推翻下面「不在范围」里终端那条）：`theme.ts` 的 `TERM_THEMES` 给七套各一份 xterm 调色板（底 / 字 / 选区 + 16 色 ANSI），`applyPrefs` 经 `paintTermThemes()` 把已经开着的终端一起换（缓存键 `theme/accent`，没变就不写），新开的走 `termPalette()`，光标色取当前强调色。
- **顺手修**：强调色块改成取当前主题那一支 ramp（`paintSwatches()`），浅底上不再是一圈看不清的粉彩点；晨光的 `--faint` 压深到 `#616a7a`（soft 组 `#626b7b`），对面板 3 从 4.2:1 拉到 4.6:1，过 AA。
- **2026-11-21 反转：** 上文那七套配色主题（连同文字亮度三档与六色强调色）已经整项删掉，外观只剩 Mac 风格三套 —— 见 D353。

**不在范围。** 表格查看器（自带浅色）、内网通独立页 `peer.css`（自己一套变量）。终端配色已跟主题（见上）。

## D338 内网通：弹框最大化、表情 / 我的表情、表情回应、记录内搜索、多选转发、看图器（用户要求 2026-11-20）

**要什么。** 用户要「内网通支持全屏、支持表情包，其他功能可以补充」。问过之后定为：弹框标题栏加最大化（外加新标签页打开）；Unicode 表情面板 + 自定义图片表情收藏；补聊天记录内搜索、消息转发 / 多选、表情回应、看图器。

**决定。**
- **最大化**（`web/src/app.ts` `openPeerSheet`）：标题栏「新标签页 / 最大化 / 关闭」，双击标题栏也切；状态记 `localStorage["pi-web.peer.max"]`，下次打开沿用。不用浏览器 Fullscreen API：它会被 Esc 抢走，而 Esc 在内网通里有别的用处。
- **表情面板**（`web/src/peer/emoji.ts`）：分类 + 最近使用（`peer.emoji.recent`），按钮 mousedown 不抢焦点，插到输入框原光标处（`execCommand("insertText")`，进撤销栈、触发草稿保存）。
- **我的表情**（`peer/src/stickers.ts`）：存在 peer 自己的 state 目录 `stickers/`，按内容哈希去重，单张 ≤ 5 MB、最多 300 张。发送时复制成 `表情.<ext>` 走普通文件通道 —— 对方不用升级，老版本也看得到；接收端按文件名 `表情.` 开头画成表情（无边框、小尺寸）。聊天里的图右键 / 看图器里「添加到表情」。
- **表情回应**：新增 `kind:"react"` 的历史条目（`emoji`, `ref`, `on`），`foldEntries` 折叠到被回应那条的 `reactions` 视图字段上，同人同表情后到的覆盖先到的。走 outbox 的控制消息投递，与撤回同一条路；对方离线时只记本地。
- **搜索**：只在当前会话里，搜索时把拉取上限从 200 提到 2000；命中描边、Enter / Shift+Enter 上下跳；搜索条跨轮询重画复用，不丢焦点。
- **多选 / 转发**：文字重新 `send`，文件走新的 `/api/peer/forwardfile`（用本机已有的那份，不用再从磁盘选）；记录包不转发。多选时输入区换成操作条，点哪儿都是勾选。
- **看图器**（`web/src/peer/viewer.ts`）：同会话所有图左右翻，滚轮以指针为中心缩放、拖动、双击 适应 ↔ 1:1、旋转、下载。

**顺手修。** 打完字 800 ms 内回车，草稿定时器会把刚发出去的内容又存回草稿；`send()` 成功后先清定时器。

**验证。** 两份测试实例（`pi-web-client-test-dev`）上跑 `node probes/peer-chat-extras.mjs <A bridge> <B bridge> <B peer>`：32 项（最大化 / 表情插入 / 我的表情发送 / 回应双向可见与取消 / 搜索 / 看图翻页缩放 / 多选转发对方收到 / 图片加到表情）。

## D339 执行面板 Copilot 积分块在长任务进行中实时出现并更新（用户报障 2026-11-20）

**症状。** 新建会话或第一轮长任务跑了 6 分钟、52 个工具调用、`主会话 3.6M Token 数 · $2.0289` 已实时刷出来，但执行面板一直没有「Copilot 积分」板块（且本轮费用显示美元而非积分）。

**根因。** `refreshCopilot()` 只在 `boot`、`session_start`/`session_info_changed`、`agent_end`、`agent_settled` 和 `subscribe` 时触发，而 `onPiEvent` 的 `message_end` 只调了 `refreshStats()`、没调 `refreshCopilot()`。新会话创建时尚无 assistant 消息（`hasCopilot: false`），只要第一轮没走到 `agent_end` 且页面没重新订阅，`copilotView` 就一直是 `hasCopilot: false`，整轮期间面板都不会亮起积分块；后续轮次里积分数字也会卡在上一轮末尾。另外 `claim` / `reload` 下发 `session` 帧时也未补一次 `refreshCopilot()`。

**决定。**
- `bridge/src/sessions.ts`：`onPiEvent` 的 `message_end` 在 `void this.refreshStats()` 旁同步补 `void this.refreshCopilot()`。`CopilotTally.read()` 按字节 offset 增量读 JSONL，单次只需一次 `stat` + 读新增行；账号额度本身有 30s 节流和 inflight 互斥，不会多打 GitHub API。
- `bridge/src/index.ts`：`claim` / `reload` 补发一次 `void session.refreshCopilot()`，与 `subscribe` 对齐。

## D340 产物列表补收 AI 回复正文提及的脚本产物（用户报障 2026-11-20）

**症状。** 会话里用脚本（`bash`）生成了两个 HTML 报告（如 `C:\soft\10_計画\AI駆動開発\planning-external-report(プラン).html`），用户对「要在预览里打开吗？」选了「先不看」，结果打开「本会话的产物」弹窗时看不到这两份文件，只看得到 `write` 工具写的模板和临时脚本。

**根因。** D275 之后产物来源只有 `WRITE_TOOLS` 与 `DELIVER_TOOLS`（`open_preview`）。脚本写入不走 `write/edit`，用户选「先不看」又不调 `open_preview`，两条线索都落空；另外 `web/src/md.ts` 的 `NAME` 字符集排除了半角圆括号 `()`，反引号里的带括号文件名（`report(プラン).html`）也无法被 `looksLikePath` 识别。

**决定。**
- **路径提取与括号支持**（`web/src/md.ts`）：在反引号行内代码（`SPAN_NAME`）中允许半角括号 `()`，同时导出 `extractMentionedPaths(src)` 复用与 `renderMarkdown` 一致的路径规则（行内代码、本地链接、纯文本路径，跳过围栏代码块与 URL）。
- **前端收集优先级**（`web/src/artifact-sources.ts`、`web/src/chat.ts`）：在 `noteAnswer` 中提取回复正文路径，经 `noteMentioned` 记入 `this.written`（带 `mentioned: true`）；优先级严格为「写入 > 交付 > 提及」，不覆盖真实写入或 `open_preview` 记录。
- **桥侧校验过滤**（`bridge/src/sessions.ts`、`bridge/src/artifacts.ts`、`bridge/src/index.ts`）：`locate()` 一并返回 `startedAt`，`listArtifacts()` 对 `mentioned` 条目校验「文件存在、是普通文件、且 `mtimeMs >= startedAt - 1000`」，过滤掉旧参考文件、目录与不存在的路径；同一 `abs` 撞车时保留非 `mentioned` 记录；无基线时返回 `why: "mentioned-only"`，页面显示「回复提及」及对应说明（三语同步）。

## D341 Jira 面板加「最近消息」：@我的 / 我回复过的（用户需求 2026-11-20）

**需求。** Jira dialog 左栏新增一页「最近消息」，分两段：别人在哪些工单里 @ 了我、我最近在哪些工单里回复过。默认最新 10 条、新的在上，「显示更多」每次再加 10 条；每行照样能展开详情、下载附件、交给 agent。

**能不能做（在 kaigit.atlassian.net 上实测）。** Jira 没有「我的通知」REST API，也没有 `commentedBy`，所以两段都是「JQL 粗筛 + 逐单读评论精筛」：
- **@我的**：`comment ~ "<accountId>"`（ADF 的 mention 节点按 accountId 进索引）按 `updated DESC` 取 50 张，再读 `/issue/KEY/comment?orderBy=-created`，挑**别人写的、mention 节点 `attrs.id` 等于我**的最新一条。只认评论里的 @，描述里的 @ 不算。
- **我回复过的**：`issuekey in updatedBy("<accountId>", "-90d")` 取 100 张（只改字段也会命中），再挑**我自己写的**最新一条，没有就丢掉。窗口定死 90 天。`updatedBy(currentUser(), …)` 在 issuekey 子句里会 400，必须传 accountId。
- 每段约 50～100 次评论请求，8 路并发，实测 2.4s；桥端按段缓存 60 秒，「↻」/ 顶部刷新绕过缓存。读不到评论的单（非鉴权、非网络错误）跳过并计数，不让整段失败。

**决定。**
- 桥：`GET /api/jira/recent?kind=mentions|replied` → `{ kind, items: JiraRecentItem[], skipped }`，`JiraRecentItem = JiraIssue + comment{id, at, author, body(ADF)}`，按 `comment.at` 降序，最多 50 条。JQL 由桥写死，页面只能选 kind（同 D203）。
- 页面：分段切换（原型里比过「上下两块」「左右两栏」，选了分段）；每行复用「我的未完成」的 `issueEl`，在标题下插一行评论摘要（作者：正文前 160 字 · 相对时间）。只拉「@我的」随面板打开一起取（左栏角标要用），「我回复过的」切过去才取。
- **新消息 = 上次查看之后**：没有已读 API，用 `localStorage["pi.jira.recent.seen\n<站点>\n<accountId>"]` 记「上次进这一页的时间」。不在这一页时左栏角标显示 `@N`；进页时按旧值画蓝点并把记录更新成现在，所以蓝点本次可见、下次消失。从没看过（无记录）一律不算新，免得第一次满屏蓝点。只给 @我的 算，自己的回复没有「未读」。
- 顺手修 `adfToText`：Jira Cloud 的 mention `attrs.text` 自带「@」，原来拼成「@@名字」（详情评论里也一样）。

## D342 Mac 风格：一个 `data-ui="mac"` 开关换掉整套材质、动效与快捷键

- **决定**：Mac 三套主题（mac-light / mac-dark / mac-midnight）由 `paintTheme` 在 `<html>` 上挂 `data-ui="mac"`，`web/src/mac.css` 里所有规则都挂在这个开关下：壁纸式渐变底 + 毛玻璃顶栏 / 悬浮侧栏 / 弹层 / 菜单，iMessage 气泡，macOS 按钮、分段控件、开关，Apple 弹簧缓动，弹层落下与退场动画（`retireOverlay` + `.mac-leaving`），以及兜底快捷键 `MAC_KEYS`（⌘/Ctrl + , 设置、+K 搜索、⌃⌘S 左栏、+. 中断）。强调色在 Mac 主题下改用 `prefs.macAccent`（macOS 八色，默认系统蓝），与原来的 `prefs.accent` 分开存；文字亮度三档在 Mac 主题下固定为 normal（Apple 标签色层级）并在设置里隐藏。
- **为什么**：用户要的是「改天换地」的整体体验，不是第十套配色。把所有改动关在一个属性开关后面，其它七套主题一个像素都不变，也不用给每条旧规则加分支；强调色分开存，切回普通主题时原来的选择还在。位移动画只用独立的 `translate` / `scale` 属性，因为不少浮层本来用 `transform` 定位。

- **2026-11-21 反转：** 「Mac 风格与配色主题并存」这一半已经推翻 —— 配色七套删掉，`data-ui="mac"` 现在恒挂，强调色只剩 macOS 八色那一份。开关与文件分层保留。见 D353。

## D343 运行时面板的内存：Windows 按 pid 逐个问 `tasklist`

- **决定**：win32 不再跑一次不带过滤的 `tasklist /FO CSV /NH`，改成对每个 `RpcChild` pid 各跑一次 `tasklist /FO CSV /NH /FI "PID eq N"`（最多 4 个并发），结果拼起来交给同一个 `parseProcessTable`。单条命令超时从 2 s 放到 5 s。任何一条失败整次采样算失败（照旧显示「不可用」、水位不动手）；pid 不在表里（进程刚退）只是这一行没数字。darwin / linux 的 `ps` 不变。
- **为什么**：运行时面板「占用内存」和每行会话一直是「不可用」。实测这台机器忙时不过滤的 `tasklist` 要 2–18 s（它要问遍所有进程，含服务与受保护进程），D120 §2 的 2 s 超时几乎每次都触发；带 PID 过滤的稳定在 0.3–0.8 s。
- **代价**：pi 多时一次采样会多 spawn 几个 `tasklist`（7 个会话 = 2 批）；仍只在 GC tick / 面板刷新时跑。

## D344 问卷里的「在预览里打开」当场打开，预览让出「需要你」栏（用户报障 2026-11-20）

**症状。** 模型把「要在预览里打开吗？」和「三个变体选哪个」塞进同一份问卷。用户点了「在预览里打开」，什么都没出来，下一题已经在问选哪个 —— 还没看就要选。

**根因（三层叠在一起）。**
1. 多题问卷要整份提交，模型才拿得到答案（`askPanel` 的提交钮「还差 N 题」时禁用）；模型没拿到「打开」就调不了 `open_preview`。
2. 交付提示词（D226）只说「用问卷问一句」，没说要单独问；全局规则「把问题合成一次提问」把模型推向合并。
3. 预览浮窗 `.viewer` 固定在右缘，正好整栏盖住「需要你」：就算先开了预览，下一道题也被压在它底下。

**决定。**
- 提示词（`bridge/src/delivery.ts`）：这一问**单独**发，优先于「合并提问」；题干写文件的**绝对路径**；要先看过产物才答得了的题等预览开了再问。`test:hint` 补三个关键词。
- 前端（`web/src/ask-preview.ts`）：单选题点的选项以「在预览里打开」开头（兼认英 / 日说法）时，从选项说明、再从题干里找第一个带扩展名的**绝对路径**，当场 `openPreview`，答案照旧记草稿 / 提交，回给模型的选项原文不变。模型拿到答案后照提示词再调一次 `open_preview` 也无害（同路径 `pushStep` 去重）—— **但「原地刷新」这句是错的**：那条第二次投递会清屏重建 iframe / 重开表格浮窗，画面闪一下（用户报障 2026-11-22），已修，见 D388。
  - 只认绝对路径：相对路径要按会话 cwd 解析，而产物常在别的 worktree 里（这次就是），猜错会打开同名的另一份或报错页。认不出就什么都不做，退回原来的模型往返。
  - 这就是 D226 记下的 Out of Scope「问卷卡直连预览」，但不走 `/api/preview/open`（那是给子进程的回环入口），直接用页面自己的 `openPreview`。
- 布局：题目在「需要你」栏里（`askDock()`）时，预览加 `.beside-ask`，`right` 让到那一栏左缘（`--ask-right`，按 `uiScale` 换算成布局 px，D123）；全屏预览不让；题答完、收起右栏、窗口变化时 `syncViewerBesideAsk` 复位。拖宽度改成从面板自己的右缘量。

**验证。** `npm run test:ask-preview`（8 项纯函数，含截图那句「相对路径 + worktree 目录」不猜）；`node probes/ask-preview.mjs`（9 项：2 题问卷，「先不看」不开，点「在预览里打开」当场弹 viewer、停在第 2 题且提交仍禁用、第 2 题选项在最上层未被盖、提交后两条答案原文回给发起方、答完预览回到右缘）；`npm run test:hint`（20 项）；`npm --prefix web run typecheck`。`probes/preview-open.mjs` 在 main 上就因 `.topbar` 的「文件」按钮已隐藏而卡住（与本改动无关），临时换掉那个等待后预览相关 13 项都过。

## D345 产物弹窗改成设置控制台样式（方案 A，用户选定 2026-11-20）

**需求。** 「本会话的产物」弹窗的 UI 按本项目设置控制台（`st-console`）的模板重做。先出三版原型（A 设置式分组 / B 目录树 + 对照表 / C 主从详情，分支 `proto/artifacts-console`，未进主线），用户选 A。

**决定。**
- 外壳：`section.st-console.settings-sheet.art-sheet`。head 放 eyebrow、标题、会话工作目录与状态徽章；左栏 nav 分「状态」（全部 / 新增 / 修改 / 已删除 / 未知 / 未变）与「来源」（工具写入 / 在预览里打开 / 回复里提到），带计数；右栏是「按最近 / 按路径」切换 + 路径预览输入 + 四张统计卡 + `settings-panel` 行清单；底下是 `st-foot`。
- 行：`button.settings-row.art-row`，三列「名字 + 路径 / 脚本说明 | 数字与工具名 | 状态胶囊」。能对比的行给「看改动」（打开 diff 弹窗）；不能对比的给「预览」（`openPreview`，不关弹窗）。
- 列轨写成 `minmax(0,1fr)`：顶栏按钮会把隐式 auto 列撑到 min-content（390px 下实测 427px），和 `display-sheet` 同法修。
- 样式全部挂在 `.st-console.art-sheet` 下，替换 `styles.css` 里旧的 `.art-*` 块；`.art-badge`、`.art-count`、`.art-est` 与 diff 弹窗共用，留在全局。
- 数据层不动：`/api` 返回、D275 / D340 的来源收集与桥侧校验都没改。

**验证。**
- `npm run typecheck`（tsc、i18n 3983 键 × 3 语、视口守卫、层带、主题单测）通过。
- `probes/artifacts-delivered.mjs` 9/9：原有 7 条，外加 390px 下弹窗与行不撑出视口、字号 150% 下底栏仍在弹窗里。
- `web/tests/artifact-sources-unit.mjs`、`chrome-unit.mjs`、`commands-unit.mjs`、`settings-console-unit.mjs` 通过。

**顺带。** `probes/artifacts-delivered.mjs` 在 Windows 上一跑就炸：会话目录名 `--C:-Users-…--` 里带冒号，`mkdirSync` 报 ENOENT。把编码里的 `:` 也替换成 `-`。
## D346 所有弹层统一 Esc 关闭：一个 Esc 栈（`web/src/modal.ts`）

**症状。** 很多 dialog 只有 ✕ 和点遮罩，按 Esc 没反应；少数有 Esc 的（设置、子面板、查看器）各写一份 `document` 监听，焦点一离开就失效，层级判断（`higherLayerOpen`）散在几处。

**决定。**
- `pushEscLayer({ el?, focusScoped?, onEsc })` 登记一层、返回摘除函数；全局只挂一个 `document` keydown，**冒泡阶段**。从栈顶往下找第一层接 Esc 的，`preventDefault()` 后调它的 `onEsc`，一次 Esc 只关一层。挂着的 `el` 已不在页面上的层顺手摘掉。
- 焦点处的控件要用 Esc 做事（清搜索、先收下拉、取消改名）就 `preventDefault()` / `stopPropagation()`，弹层不再动。没人吃的才交给栈顶。
- `setSheet(back)` 统一登记面板（23 处原 `this.sheet = …` 全部改走它）；`openSubSheet`、小框（口令、安装、升级确认、选择框）、菜单（设置里的下拉、权限、终端菜单、表格下拉候选）、图片查看、随手问、笔记的提示框都登记。
- 非模态浮窗（预览 `.viewer`、表格 / 幻灯片停靠 `.sd`）用 `focusScoped`：焦点在窗里才接 Esc，焦点在聊天里放过去（聊天里的 Esc 不被抢，`D308` 的层带不变）。`.hi` 状态变了由 `syncFloatLayers()` 重登记。
- 内网通 iframe：页内没东西可关的 Esc 发 `peer-esc` 给父页，父页调 `escapeTopLayer()`，关的是外面那层（面板）。
- `trapEscape` 保留为 `pushEscLayer({ onEsc })` 的简写，原来是捕获阶段，现在改冒泡（邮箱两处用它）。

**为什么不用每个弹层自己挂监听。** 焦点丢了就失效，这是症状本身；统一栈之后焦点在哪都一样，新弹层只调一次 `pushEscLayer`。

**验证。** `npm --prefix web run typecheck`（含 layers、viewport 守卫）；`node probes/esc-dialogs.mjs`（上下文 / 模型 / 开新会话 / 技能面板 / 技能商店 / 内网通，各测「焦点在内」与「焦点在 body」两种，无弹层时 Esc 不动输入框）；`web/tests/notes-sheet-browser.mjs`、`web/tests/layers-unit.mjs`、`web/tests/ask-tab-unit.mjs` 通过。

**未覆盖（待补）。** 邮箱的 Esc（`trapEscape` 改冒泡）、预览 / 表格 / 幻灯片浮窗的焦点分支、选择框 `choose`、口令框 `askStepUp`、升级确认、终端菜单 `openShellMenu`、图片查看，现在只有代码审查，没有 probe。`probes/skill-palette.mjs` 在 origin/main 的基线上就卡在「点对话区关闭」那一步（`.skill-panel` 截住了点击），与本改动无关。

## D347 内网通：附件先进输入框、基础群聊、固定消息、名字跟备注走、@ 与标为未读（用户要求 2026-11-20）

**背景。** 粘贴 / 选择图片会立刻发出去，没机会配文字或反悔；不能拉群；给好友改的备注只在列表生效，气泡上还是对方自报的昵称；没有 Teams 那样的「固定消息」。

**决定。**
- **附件暂存**（`web/src/peer/main.ts`）：粘贴、拖入、文件选择器里挑的文件都先进输入框上方的托盘（缩略图 / 文件名 + ✕），按发送才依次上传，再发文字。选择器按钮改叫「放进输入框」。
- **名字一律跟备注走**：`peer/src/history.ts` 的 `threads()` 先取联系人里的名字（备注）再取在线表；页面用 `nameOf(nodeId)`（联系人 → 会话 → 在线表 → 消息里的自报名）画气泡头像、群里的发言人、撤回提示、回应、引用、转发。备注仍只存本机（D303）。
- **基础群聊**（`peer/src/groups.ts`，`groups.json`）：群 id `grp-<uuid>`，带版本号 `v` 的成员快照随每条群消息 / 控制消息一起走，收方按「v 更大或同 v 更晚」合并，第一次收到就建群。消息由发送方逐个成员扇出，离线成员照常进发件箱（`Queued.thread / msgId`，回执按 `msgId` 落回群会话）；文件同理扇出给在线成员。建群 / 改名 / 拉人 / 退群写成 `sys` 灰条。退群后不再收发，非成员发来的群消息 403。群里暂不支持发「记录」。
- **固定消息**：`pin` 和 `react` 一样是折叠到目标消息上的控制条目，双方 / 全群同步；`/messages` 额外带回窗口之外仍在固定的消息（`outside: true`，页面不画进流里）。顶上一条固定条，多条时可展开，点一下跳到原消息，太早的会先加载更多再跳。撤回的消息自动取消固定。
- **Teams 式补充**：群里 `@成员` / `@所有人`（输入框 @ 按钮），@到我的消息高亮、会话列表显示「[有人@我]」且免打扰的群也提醒；会话菜单加「标为未读」（`/threads/patch {unread:true}` 把已读水位退到对方最后一条之前）。

**为什么不做中心服务器。** 内网通是对等的，没有常驻的「群主机」。快照随消息走 + 发送方扇出，任何一个成员在线就能把群续下去，代价是群越大发送方越累，所以上限 50 人。

## D348 内网通：重要 / 紧急、群话题回复、已读名单、「已固定」会话分区（用户要求 2026-11-20）

**决定。**
- **重要 / 紧急**：输入框底栏「！」选优先级，只管下一条，发完清掉。消息带 `priority: "important" | "urgent"`，气泡上方彩色标签 + 左色条。收方会话列表显示「[紧急]」；**紧急和 @我 一样穿透免打扰**（`ThreadSummary.urgent / mention`，bridge 的 web-push 与页面通知都认）。
- **话题回复**（只在群里）：消息带 `topic: <根消息 id>`，发送方校验话题存在。主消息流只留根消息，下方挂「N 条回复 · 最后谁 几点」，点开在右侧面板看全部回复、单独回；面板输入框跨轮询复用，打到一半的字不丢。
- **已读回执**：已读水位往前走时，peer 只向「这段里发过消息的人」发 `read` 控制（`upTo` = 水位），对方存进 `reads.json`（按会话、按人单调前进），`/messages` 给自己的消息带 `readBy`。1:1 显示「已读」，群里「N 人已读 / 全部已读」，点开是已读 / 未读名单。离线的人上线后经发件箱补到。
- **「已固定」分区**：会话菜单的「置顶」改叫「固定」，固定的会话单独成可折叠的一段，其余在「最近」；折叠状态存 `localStorage`。

**为什么回执只发给作者。** 群里每读一次都广播给全员，消息量是成员数的平方；只告诉写了被读消息的人，量和「回执」本来的用途对得上。代价是第三人看不到别人对别人消息的已读，这和 Teams 一致。

## D349 加班提醒在任何情况下都要看得到：页面开着也提醒（用户要求 2026-11-20）

**问题：** D292 的加班提醒只走 Web Push。用户反馈「打开这个工程页面时加班申请的提醒不生效」—— 那是 D91「页面在前不弹系统通知」的老规矩；D292 虽在 sw.js 里加了 `force`，但推送在页面就在眼前时仍可能被浏览器 / 旧 sw / 系统吞掉，而且页面上什么都看不到。用户要的是「加班申请所有情况都提醒」。

**决定：**

- **到点同时走两条路。** `startReminderLoop` 新增 `onFire(title, body)`；桥在到点时除了推送，还给所有开着的**本机**页面广播 `attendance.reminder` 帧（隧道连接跳过，考勤对公网整页隐身）。
- **页面自己再弹一遍。** 收到帧后 `App.showAttendanceReminder`：挂一条 10 分钟、点一下才关的页内提示（没给通知权限也看得到），有权限再用 `registration.showNotification` 弹系统通知。
- **同 tag 不叠两条。** 推送与页面弹的都用 `REMINDER_TAG = "pi-attendance-reminder"`（`Notifier.push` 新增 `extra.tag`，sw.js 认 `payload.tag`），系统只留一条。
- **不自动消失。** 两条路都带 `requireInteraction`（推送里叫 `sticky`），人点掉为止；只用于加班提醒，D91 的其它通知不变。
- 去重仍是 D292 的「先落盘 lastFiredDate」：页面广播与推送是同一次触发，不会多发。

**验证：** `npm run test:attendance` 61 + 39 + 14 全绿（e2e 新增：到点 `onFire` 恰一次、推送带 `tag` 与 `sticky`）；测试实例 17864 上用 Playwright 开着页面（有焦点、在最前）把提醒时间设成当前分钟：8 秒内出现「加班申请提醒：…」页内提示，并以 tag `pi-attendance-reminder`、`requireInteraction: true` 调了 `showNotification`。

## D350 内网通页面跟主题走，Mac 风格也覆盖到（用户要求 2026-11-20）

**决定。**
- `/peer` 是独立文档（主界面弹框里是 iframe），以前 `peer.css` 自己写死一套「午夜」配色，换主题它不跟。现在把全部主题令牌从 `styles.css` 抽到 `web/src/theme-tokens.css`，主界面和 `peer.css` 都 `@import` 它；`peer/main.ts` 启动时调 `bootTheme()`，并监听 `storage` 事件，在别的标签页换主题时当场跟。
- Mac 的公共底子（材质变量、字体、壁纸、滚动条、焦点环、动效）抽到 `web/src/mac-base.css`，`mac.css` 引它；内网通自己的 Mac 覆写放 `web/src/peer/peer-mac.css`（毛玻璃栏、iMessage 气泡、胶囊输入框、Mac 按钮 / 开关 / 菜单 / 弹窗）。
- 弹框里 iframe 与页面底在 Mac 下都透明，外层弹框的玻璃透上来，和主界面是同一块窗。
- `peer.css` 里的硬编码颜色改成主题变量的 `color-mix`；看图器固定深色（照片底不跟主题）。

**为什么抽文件而不是复制。** 复制一份令牌，下次加主题又会漏掉内网通——这次的 bug 就是这么来的。守卫：`node probes/peer-theme.mjs <A> <B> <B peer>`（六套主题各自换底、Mac 挂 `data-ui`、跨标签页实时切换、弹框透明）。

## D351 Mac 风格：用户气泡宽度、选中胶囊里的状态字（用户报 bug 2026-11-20）

**决定。**
- 用户消息会包进 `.foldable > .fold-body`，Mac 下 `.msg.user` 是 flex 列、子项按内容收缩，气泡的 `max-width: 78%` 就成了「自己宽度的 78%」：短消息被折成「mer / ge」，长气泡贴左、右边空一截。宽度上限挪到 `.foldable`，里面两层贴右、气泡只限 100%。
- 内网通消息流每次轮询 / 发送都整段重画，Mac 的入场动画挂在 `.bub` 上，发一条消息所有气泡一起弹。改为只给这次新出现的消息打 `.fresh` 再放动画；换会话后第一次画不算新。守卫在 `probes/peer-theme.mjs` 第 4 段（数 `animationstart`）。
- 钉条里当前会话那颗胶囊是实心强调色底，里面的状态小字（运行中 / 进行中）和 ★ 也是强调色，叠在一起看不见。选中胶囊里一律跟胶囊白字走。

**守卫。** `node probes/mac-chat.mjs`：四套主题下量短气泡单行、气泡贴右、选中胶囊对比度，并扫整页「自己带字、对比度 < 2」的元素（展开 / 收起左栏各一遍）。

## D352 Mac 风格：弹层外壳清单集中一处，自管弹层的退场走同一个出口（用户报「只有 Everything 不兼容」2026-11-21）

**症状。** 同一份 CSS 下，产物（`.st-back`）是毛玻璃 + 浅遮罩 + 460ms 窗口入场，Everything（`.sys-back`）还是深黑遮罩 + 纯白面板 + 没有动画；bug 反馈（`.notes-sheet`）居中却演成底部抽屉。

**根因。** `mac.css` 的白名单只认 `.st-console` / `.sheet` / `.modal form` / `.argdialog-panel` 四个外壳类，而 `sys` / `jc` / `mc` 是系统管理 / Jira / 邮箱各抄一份的控制台（`sysmanage.css:3-30`、`jira-console.css:5-30`、`mail-console.css:3-30` 三段几乎逐行相同），一个都不在名单里；零散弹层（`.jira-ask`、`.peer-pick`、`.image-view`、`.sheet-sub-back`、`.choose-back`、`.jira-picker`）同理。笔记面板没挂 `.center` 类，被 `.sheet-back:not(.center)` 判成抽屉。

**决定。**
- 外壳清单在 `web/src/mac.css` 一处写全：遮罩组 `:is(.st-back, .sheet-back, .modal, .sys-back, .jc-back, .mc-back, .jira-ask-back, .jira-picker, .sheet-sub-back, .choose-back, .peer-pick, .image-view)`，窗口组 `:is(.st-console, .sheet, .modal form, .argdialog-panel, .sys-console, .jc-console, .mc-console, .mc-confirm, .jira-ask, .peer-pick-panel, .branch-sheet, .repos-sheet, .jira-picker-box)`。尺寸与内部布局仍留各自文件，`mac.css` 只管材质、圆角 14px、入场与退场。**同一套控制台里再分出的小卡片也要单独写进名单**：邮箱的发信确认框外壳是 `.mc-back`、面板却叫 `.mc-confirm`（`mail-console.css:957`），只收 `.mc-console` 会让它退回纯色面板 —— 第一版就是这么漏的，review 才逮到。
- 笔记面板按名字判（`.sheet-back.notes-back .sheet` 播 `mac-window-in`），不靠没人维护的 `.center`；随手问是右侧抽屉，单独 `mac-side-in`。
- 退场：`web/src/modal.ts` 新增 `startLeaving(node)`（判 `html[data-ui="mac"]` + reduced-motion，加 `.mac-leaving` / `inert`）、`LEAVE_MS = 210`、`retireOverlay(node)`。sysmanage / jira（面板与选目录）/ mail / mailconfirm / notesheet（面板与选人框）/ hotdeploy / branchsheet / repossheet / translateview / app 的子弹层一律换 `retireOverlay`。原来是 `node.remove()`，Mac 下没有退场。`branchsheet` 的 `embedded` 分支不换：那 `sheet` 是别的面板里的一块，退场会把父面板一起拖下水。
- app.ts 里那个私有版本改名为 `retireSheet`，**只给 `this.sheet` 本身用**：它多一段「同一轮又开了新面板就当场拆旧的、给新的挂 `mac-instant`」的判定，而灯箱 / 小选择器是**浮在 sheet 之上**的浮层，关闭时底下那张 sheet 本来就还在，走它会误判成同帧重开 —— 动画被掐掉，还给 sheet 挂上一个永不摘掉的 `mac-instant`。浮层一律调 `modal.ts` 的 `retireOverlay`。

**为什么不是逐文件加规则。** 三套控制台是复制粘贴出来的，下一套新控制台再抄一遍时，只有「清单在 `mac.css` 里、守卫会数」才拦得住；分散到 `sysmanage.css` 之类的文件里，下次照样漏。

**守卫。** `npm --prefix web run build && node probes/mac-dialogs.mjs`：真 Chromium 起一份隔离 bridge，真开 Everything / 产物 / 笔记 / 设置四层，另注 16 个骨架，逐项跟「产物」对齐遮罩 blur 与动画名、面板动画与圆角、阴影；另对 10 个外壳家族注入 `.mac-leaving` 断言面板拿到 `mac-window-out`（这条查 CSS 白名单，不依赖哪个模块记得调 JS）；再在 700px 视口下断言铺满整屏的仓库面板圆角与边框都是 0。21 行全绿才过；`.choose`（alert 形，缩放淡入）和灯箱（图不是窗口，12px）写成带 label 的豁免表，表里任何一条对不上实测行也红 —— 免得改了骨架名就静默失效。

**特异性的坑（写覆盖规则时先数一遍）。** 窗口组那条 `:is()` 的参数里有 `.modal form`，所以整条的特异性是 `(0,2,2)` 而不是 `(0,2,1)` —— `:is()` 取参数里最高的那个。窄屏复位写成 `html[data-ui="mac"] .repos-sheet`（`(0,2,1)`）压不过它，`border: 0` 静默失效、只剩圆角生效；改成 `html[data-ui="mac"] .sheet-back .repos-sheet`（`(0,3,1)`）才对。窄屏那条用 `@media (max-width: 720px)` 而不是 `@container`：面板铺满整屏时已经没有「自己的宽度」可判。

## D353 删掉「配色主题」，外观只剩 Mac 风格三套（用户要求 2026-11-20，反转 D337 的一半与 D342 的并存结构）

**问题。** D337 加的七套配色主题与 D342 的 Mac 风格三套共用 `pi.prefs.theme`，在设置里占两页、在首跑弹窗里占两排。两族换的东西根本不是一回事：Mac 三套换的是材质（壁纸渐变、毛玻璃、iMessage 气泡、弹簧动效、⌘ 快捷键），配色七套只换底色 —— 选了配色主题就没有 Mac 材质，而配色主题的暖底 / 冷底在 Mac 里也没有对应。维护上每加一条颜色都要同时写 Mac 内与 Mac 外两条；文字亮度在 Mac 下是隐藏且失效的；六色强调色表退化成只服务左栏色点。用户要的是「一套观感」。

**决定。**
- 主题只剩 `mac-light` / `mac-dark` / `mac-midnight`；`isMacTheme()` 与「配色主题」那一页一起删，`data-ui="mac"` 恒挂 —— 材质仍集中在那三个 CSS 文件里，没有并进基础样式（那是一次纯靠肉眼验收的重排，风险大、收益小）。
- `:root` 兜底从午夜深色换成 Mac 浅色（含 `color-scheme: light`），浅色令牌只保留一处（不再另写 `[data-theme="mac-light"]`）；`bootTheme()` 跑之前页面就是白底。
- 文字亮度三档（`prefs.text`、`[data-text]` 规则）整项退休，Mac 固定 Apple 的标签色层级。
- 强调色只剩 macOS 八色（`MAC_ACCENT_IDS`）；`prefs.accent` 与六色表 `ACCENTS` / `ACCENTS_LIGHT` 退休。左栏工作区色点改用八色哈希（模数 6→8），已有组会换色 —— 纯装饰，名字仍是主线索。
- 老偏好由 `migrateThemePrefs()`（主题模块里的纯函数，不读存储、不碰 DOM）迁移：旧主题按明暗与色相（midnight / dusk → 午夜蓝，fjord / ember → 深色，daylight / light / paper → 浅色），旧强调色按最近色（ice→blue、teal→green、violet→purple、amber→yellow、rose→pink、slate→graphite）。**只有存的主题是旧配色主题时才搬强调色** —— 那时生效的是 `accent`；已经选了 Mac 主题的人则相反（`macAccent` 才是他选的，`accent` 是残值）。读偏好时一次写回 `pi.prefs`，旧键不再留着。
- 首跑弹窗保留，收成一排三颗；终端三份调色板照旧（浅色 GitHub 风、深色 Apple system 色）。

**为什么。** 两族并存的成本不在代码量，而在**心智**：用户看到一个十选一的货架，实际是「换皮」与「换系统」两种东西并排；维护者每加一条颜色要写两遍（Mac 内 / Mac 外），而两条里只有一条会被大多数人看到。而「换皮」那七套从来没有带来 Mac 材质 —— 选了它们反而离 Mac 更远，与 D342 想要的「整体体验」直接相反。收敛到一族之后，三套主题之间的差异只剩明暗与色温，是同一套设计语言里的三种取值，不是三种设计。反过来若保留配色主题、只删 Mac 材质，代价是把已经做完的材质层（210 条规则、动效、快捷键）整块扔掉，收益更小。

**不做。** 跟随系统外观（`prefers-color-scheme`）、终端换 Terminal.app 调色板、把 Mac 材质并进基础样式。

**守卫。** `web/tests/theme-unit.mjs`：只剩三套 id、CSS 里不许再出现旧主题块与 `[data-text]`、`TERM_THEMES` 只有三份、迁移七个旧主题与六个旧强调色的落点 + 不覆盖已选 Mac 的人 + 幂等。`probes/theme-switcher.mjs`：设置只剩「Mac 风格」「颜色」两页、三颗 chip、八色行（六色行与文字亮度行不再存在）、三套主题的底色 / color-scheme / 对比度 / 浅底不漏深色、旧偏好迁移与写回、首跑弹窗一排三颗。`probes/peer-theme.mjs` 与 `probes/mac-chat.mjs` 的循环表改三套。
## D354 这一轮的产物收成一张卡，不再一行行铺药丸（用户提「不优雅」2026-11-21）

**症状。** 一次重构能写八十几个文件，每个文件一颗药丸（图标 / 名字 / 引用 / 打开），聊天框里铺开三四行；动作（引用 / 打开）重复出现十几遍，比文件名还显眼，而它们其实只对一颗文件有意义。

**决定。**
- 一段工具模块（原来 `.ops-files` 那行芯片的位置）只放**一张** `.artcard`：收起时一行 —— 一叠纸（每种类型一张小方块）、`14 个产物`、类型小结（`样式 3 · 脚本 9 · 图片 1 · 文档 1`，数全部条目，与件数同口径）、最近两个新文件名、chevron。点开在**原位**长高（`grid-template-rows: 0fr → 1fr`），按类型分组（样式 / 脚本 / 页面 / 图片 / 文档 / 数据 / 其他，组序 = 首次出现序），网格 `minmax(min(188px, 100%), 1fr)`。
- 「引用 / 打开」不再常驻：每格平时只有类型块 + 文件名，悬停或键盘 focus-within 才浮出来；`@media (hover: none)` 常显。类型块用扩展名（CSS / TS / PNG / MD），颜色按类别 —— 一眼看出这轮动了什么，而不是认图标 emoji。
- 卡片最多画 12 块，多的交给顶栏「产物」面板（D208）：脚注 `还有 2 个 · 在产物面板中打开`，走新事件 `pi-artifacts`（app.ts 里已有的 window 事件家族：`pi-quote` / `pi-preview` / `pi-image`）。聊天区与 app 之间仍然不持引用。
- **卡片只管这一轮写过的文件**；整场会话的产物（含 `open_preview` 交付、回复里提到的）仍在「产物」面板，D275 那条分工不变。

**为什么是这张卡。** 先做了四个能点的样张（`.scratch/artifact-card/prototype/a-stack.html` 叠卡 / `b-grouped.html` 分组列表 / `c-dock.html` 图标架 / `d-window.html` 小窗口 + 目录页），用户选了「叠卡」、范围选了「这一轮」。A 的信息密度与收起高度最平衡：收起 48px 与一颗药丸同量级，展开的分组是唯一能回答「这轮在改什么」的排法；B 收得更高但只是一行字，C/D 收起时看不到文件名或本身就有 156px。

**顺带定下的两件小事。**
- 「最近」取**首次写入顺序**的最后两个（重写不改变位置）。这样 agent 连续写文件时格子不跳动 —— 为了「最近」二字让正在看的行乱序，代价比收益大。
- 收起态那行 0fr 只压扁 `.ac-clip`：内边距留在里层 `.ac-inner` 被裁掉，否则收起时卡片还留 9px 的底（第一版就多出 11px）。

**守卫。** `npm run build && node probes/artifact-card.mjs`：丢弃式 bridge + 手写会话（一轮 15 次写入、14 个唯一文件），断言只有一张卡、药丸清零、默认收起（身体高度 0）、标题 14、小结数全部 14 块（与标题同口径）、分组顺序、悬停才出动作、点「引用」进输入框、窄栏（@container 520px）隐藏「最近」。13 行全绿。

## D355 会话帧自带工作区，新建之后补一次工作区缓存（用户报「置顶的会话没出现在横排」2026-11-21）

**症状。** `window_dev` 里三条会话 ★ 都亮着，第二排横排却只剩一颗当前会话胶囊 —— 置顶的没出现，胶囊的左侧工作区色点也没有；左栏和上面的工作区标签一切正常（`window_dev` 计数 3）。F5 之后好，另一台设备连上之后也好（"之前出现了，现在又好了"）。

**根因。** 两条叠在一起。

- 页面反查工作区有这几条来源（`web/src/nowchip.ts:67-86`）：override、列表条目的 `ws`、会话快照的 `ws`，最后才是 `keys[cwd]`。而桥在 `create` 之后只广播 `session.state`（当时没有 `ws`）和 `manage` 帧；唯一带 `ws` 的 `sessions.list` 只在客户端**连上**时由 `syncWorkspaces()` 补一次（`bridge/src/index.ts:2602-2608`）。
- `Workspaces.ensure()`（`bridge/src/workspaces.ts:306`）建组**不写 `keys`**，`keys` 只有 `resolve()`（`:326`，跑 git 才知道 worktree 的真根）写。于是「页面先开着、随后在新目录里开新会话」的窗口期里：`groups` 有该组、`keys` 没有该 cwd、会话条目也没有 `ws` —— 三条来源全空 → `wsOf()` 返回 null → `starredRow()`（`web/src/app.ts:19996`）按 D210 返回 `[]` → 第二排只剩胶囊和 ＋；`nowChipView` 的 `accent` 也就成了 null（`web/src/nowchip.ts:115`），胶囊丢色点。

左栏和标签行看不出异常，是因为 `buildTree()`（`web/src/tree.ts:123`）对没有 `ws` 的会话按 `normalizePath(cwd)` 兜底分桶。`pi-web-client` 不受影响：它的 cwd 早就在 `keys` 里，第四条来源能命中。

**决定。**

- 帧盖 `ws` 用只读版 `Workspaces.lookup()`（`bridge/src/workspaces.ts:315`）：与 `groupFor()` 同一条映射规则，但**只查不建** —— 发帧是热读路径，`ensure()` 会落盘，且不带 `place` 时把组追加到标签行末尾。
- 每一条 `session.state` 都带 `ws`：`Sessions.emitState()`、`stateFrameWithWs()`（会话自身冒泡上来的帧），以及 `index.ts` 的 `sessionFrameOf()`（subscribe / claim / create 回放都要）。
- `create()` 在**建组之后、`startLive()` 之前**先广播一次 `workspaces` 快照：`session.state` 是 `startLive()` 里就发出来的（页面靠它当场建会话），快照晚到那一帧里的 `ws` 就指向页面还不认识的组。先 `pinNew` 再 `emitState` 不够 —— 实测首帧仍空排。
- 新建之后补一次缓存：`Sessions.refreshWorkspaces()`（失败自己吞），客户端连上 / `ws.list` / 新建三处共用；`index.ts` 里 create 不再二次广播 `session.state`（`create()` 已经广播过）。
- **没有**让 `ensure()` 顺手写 `keys[cwd]`：那样 `resolve()` 的 `known` 会命中、永远不去探测真 git 根，worktree 就永久停在按 cwd 分的临时组上。

**守卫。** `npm run test:ws-row`（`bridge/tests/ws-row-drift.mjs`）：起一份隔离 bridge，在一个**全新目录**里 `create`，断言 `session.state` 帧带 `ws`、create 之后 `keys[cwd]` 补上并重播了 `sessions.list`、列表条目的 `ws` 与之一致；再把收到的帧按顺序**增量重放**（`wsOf()` 的镜像），从页面知道这个会话的那一帧起，每帧之后反查本区都不能为 null —— 顺序错了也红。

## D356 设置里「主题」与「强调色」同住一页（用户要求 2026-11-21，收尾 D353）

**症状。** 外观左栏五项，其中「Mac 风格」管三套主题、「颜色」只有一行八颗色块 —— 换一套样子要跨两页，而「颜色」页除了那八个色块什么都没有；页名说的是它在模仿谁（Mac 风格），不是用户在做的事（换主题、换强调色）。

**决定。**
- 两页合成一页，页名「主题与强调色」（`data-sec="theme"`，稳定 id 从 `mac` 改来，只在内存里记「停在哪个子页」，不持久化）：三颗主题 chip → 强调色八色 → Mac 快捷键，三行。
- 外观左栏收成四项：语言与字号 / 主题与强调色 / 工作区 / 界面元素。
- 页内 chip 的行标题与第一张摘要卡叫「外观主题」（en "Theme"），不叫「主题」。
- 顶部摘要卡一屏两张：「外观主题」（值 + 默认 / 已调整）与「强调色」（值 + 按钮与选中项）。
- 首跑弹窗去掉分组标题（标题已经写了「选一套主题」），保留 `data-role="theme-intro-mac"` 钩子 —— 探针按它数分组。
- 存储不动：`pi.prefs.theme` / `pi.prefs.macAccent` 字段、默认值、`migrateThemePrefs()` 的迁移表都不改，没有数据迁移。
- 强调色的渲染、亮 / 暗两套色表、选中态、aria-label 全部沿用，只换宿主页；点主题 chip 不重建这一行（选中那颗与 hover 留在原地）。

**为什么不叫「主题」。** i18n 的键就是中文原文，`tr("主题")` 已被邮件撰写 / 列表 / 确认框占用（en "Subject"、ja「件名」）。改叫「主题」要么把这四处邮件文案一起改名，要么让同一个键在设置里读成「主题」、在邮件里读成「主题」—— 两条都更糟。所以页名取「主题与强调色」，页内的行标题与卡片取「外观主题」。

**为什么不让每颗 chip 自带强调色。** 那样八颗色块会重复三次，选颜色变成「先选主题再选色」两问一答，与 macOS 系统设置的心智相反（主题与强调色在那里是两个并列的独立设置）。合并的是**页面**，不是这两项设置本身。

**不做。** 不动邮件文案；不改 `data-ui="mac"` 材质开关与 Mac 快捷键内容；不把 D353 删掉的七套配色主题、六色强调色、文字亮度借这次复活；不做视觉改版（沿用现成的行、卡片、色块样式）。

**守卫。** `probes/theme-switcher.mjs`：外观左栏恰好四项、第二项是「主题与强调色」，`Mac 风格` / `颜色` / `配色主题` 都不在；主题页三行顺序（外观主题 / 强调色 / Mac 快捷键）；八色块就在这一页里；点色块换 `--accent`；点主题 chip 后色块行还在、紫色仍亮且换成深色那档；两张摘要卡分别写当前主题与强调色；首跑弹窗没有分组标题。`npm --prefix web run typecheck` 追加：`en.ts` / `ja.ts` 的键集与代码一致（新增四条、删掉五条废键）。

## D357 启动窗口里的技能清单先给磁盘那份，启动完成再补推权威版（用户报「新会话里敲 /skill，弹出来的技能列表是空的」2026-11-21）

**症状。** 新开一个会话，立刻在输入框里敲 `/skill`（或点输入框旁的技能按钮）：`/` 补全显示「没有匹配的命令」，技能面板显示「技能列表还没到，稍等一下…」，看上去就是「这台机器没装技能」。等几秒 —— 期间状态条上一直写着「pi 正在启动（加载扩展，通常几秒）…」—— 再敲一次，技能全出来了。同一台机器、同一个会话，只是问早了几秒。

**根因。** 清单的权威来源是 pi 的 `get_commands`，而 pi 冷启时**一条命令都不答**：它得先把所有扩展加载完（本机实测 4.9 秒，机器忙时十几秒，最坏实测过 137 秒）。桥端两条路都死等它：

- `Session.commands()`（`bridge/src/sessions.ts:2748` 一带）在 `this.rpc?.alive` 为真时就 `await this.rpc.request("get_commands", {}, 30000)`，30 秒超时之后才落回磁盘扫描；
- `Session.skills()`（`bridge/src/sessions.ts:2701` 一带）同样在 rpc 活着时直接问，`scanSkills()` 只在「没有活进程」或「这一问抛错」时才跑。

于是「进程起来了但还没加载完扩展」这个窗口里，**唯一能给出答案的那条路（扫盘，实测 27 毫秒）恰好被跳过**，页面只能干等 5 秒。实测（隔离实例，桥 7864 之外的一份）：`commands` 首问 4871 ms、第二次 5 ms；`skills` 首问 4900 ms、第二次 5 ms；同一目录的磁盘扫描 27 ms。

**决定。** 启动窗口（`rpc.alive && state.starting`）里**先给磁盘那份**，别让界面空着；启动完成后再把 pi 的权威版**推**回去。

- 桥端 `Session.startingNow()` 判定这个窗口，`commands()` / `skills()` 命中时直接返回 `scanSkills()` 的结果（`diskCommands()` / `diskSkills()`），不再问一个答不了的进程。
- 同一时刻排一次补推：`queueCommandsPush()` → `waitBooted()`（等 `starting` 翻 false，5 分钟兜底）→ `pushCommands()` 发 `{type:"commands"}` 与 `{type:"skills"}` 两帧。一次启动只排一份，窗口里问多少次都只推一次。
- 页面对这两个帧本来就会重画（`case "commands"` / `case "skills"`），不用改协议。
- 空态文案分两种：还在启动说「pi 正在启动（加载扩展，通常几秒）…命令表随后到」/「…技能表随后到」，否则维持「没有匹配的命令」/「技能列表还没到，稍等一下…」。

**代价。** 启动窗口里给的是**子集**：磁盘上看不见的 7 个扩展自带技能（`council-mode`、`pi-subagents`、`pi-lens-*`、`openwiki`）和全部扩展命令 / 提示词模板要等推送才出现，实测窗口里 67 条、pi 报 74 条技能 + 80 条非技能命令。选它是因为另一头是「空着 5 秒」—— 用户在这几秒里看到的是「没有」，比「少几条、马上补」坏得多；而且推送一到页面自己换人，不需要重新敲。

**守卫。** 两层，都红过（先在没有 `startingNow()` 短路的 dist 上跑，`commands` 3101 ms，红了 4 条）。

- `npm run test:skill-boot`（`bridge/tests/skill-boot-list.mjs`）：桩 pi 的 `FAKE_PI_STARTUP_MS` 演「启动期一条都不答」，桥的启动窗口压到 1000 ms。断言启动窗口里 `commands` / `skills` 都在 1 秒内回来且只含盘上的技能、不含 `boot-only` 与 `mcp`；启动完成后桥**自己推**两帧补齐、且窗口里问两次也只推一次。
- `node probes/skill-boot-hint.mjs`：桩桥 + 真 Chromium，同一个空回答下 `starting` 真 / 假两个会话，断言文字分别是「还在启动」与「没有匹配的命令」；再让桩桥主动推两帧，断言补全与面板不重新问也当场换人；最后推一帧**别的会话**的技能，断言不盖住当前面板（`web/src/app.ts` 的 `case "skills"` 补了 `sessionId` 比对 —— 广播推送是这一条的新入口，去掉它这条就红）。

推送能推空的这一点也收了一下：`pushCommands()` 里 pi 回空清单不推（`if (!all?.length) return;`），否则刚启动完那一瞬会把盘上那份盖成「没有」。

## D358 启动时自动打开「本服务更新了什么」：桥端判定 + 24 小时闸（#588，用户要求 2026-11-21）

**问题。** 本项目更新日志一直躺在 设置 → 更新日志 里，而最需要它的人从不点设置 —— 他只会感觉到某个行为悄悄变了。两处漏洞叠在一起：一是**服务常驻**，一份桥连跑三五天不重启，这期间合进 main 的十几批对他等于不存在；二是**更新日志的节奏是一天一到两批**，而服务一天可能重启好几次，任何「一重启就提示」都会退化成噪音。

**决定。**

- 判定是纯函数（`bridge/src/whatsnew.ts` 的 `whatsnewBatches()` / `whatsnewDecision()`）：输入日志原文、已读状态、当前时刻，输出「弹不弹 / 弹哪一批 / 还有几批」。IO、派发、状态文件在同一文件的下半截，页面只消费结论。
- 已读落在状态目录 `whatsnew.json`：`seenTitle`（批次标题**原文**，即 `## ` 之后整行）、`lastShownAt`（上次真弹出去的时刻）、`enabled`（缺省算开）。批次身份取标题原文 ——「未发布 → 日期」的改标题会让同一批再弹一次，接受。
- 判定机会只有两种：**桥进程起来后第一个客户端连上**，以及**距 `lastShownAt` 满 24 小时后的下一次连接**。两个 24 小时是同一个闸，不设两套时钟。
- 只有**这台机器以前跑过这个服务**（启动口令文件已在）才派发。全新的一份状态目录属于第一次装 —— 那时「本服务变了什么」对他没有意义，把七十批旧账摊给一个刚装的人只是噪音。判据是 `ensurePassphrase()` 首次启动时写下的 `passphrase.hash`，在 `ensureStateDirs()` 之前问一次。
- 测试用的开关是 `PI_WEB_WHATS_NEW=0`（口径同 `PI_PEER=0`）：一张模态弹窗会盖住那些「预写口令 + 临时状态目录」的测试要点的东西，所以它们在自己的 env 里关掉它。
- **只有真弹出去才推进** `lastShownAt`：被闸挡下、10 分钟排不上队、开关关着，三者都不推进已读，那几批留到下次。
- 派发窗口在桥端（进程内 `claimed`，记标题与时刻），窗口内只发给第一个来领取的页面、窗口过了才有新的判定机会 —— 窗口就是那条 24 小时的闸，所以桥常驻不重启也等得到第二次；`GET /api/changelog?scope=self&unread=1` 是领取，`POST /api/changelog/seen` 才是落盘（弹窗打开那一刻调）。领走之后那个页面排不上队就放弃，这次启动不再转给别人 —— 换来的可预测性比「一定让人看到」值。
- 页面侧只找时机：没有正在跑的回合、输入框空着、页面在前台、没有别的弹层开着，最多等 10 分钟。
- 内容只装本项目的 CHANGELOG（pi 的变更继续归设置里那页），最近 1 批 + 「还有 N 批更早的」折叠；`未发布` 批次照常算；正文保持中文，框上的文案走 `tr()` 三语；~~条目里的 `#PR` / `D编号` 保持纯文本~~（**D406 改写**：条目与弹窗共用同一套结构化条目，`#PR` 是可点的 chip、`D编号` 打开 `docs/DECISIONS.md`）。
- 开关「启动时自动打开更新日志」与「上次看到」~~放在 设置 → 更新日志 →「本项目」那一页的开头~~（**D406 按用户要求改到日志页最下方**；原来那句「翻到底要滚几十屏，放底部等于没人看得见」的理由仍然成立，代价与补救记在 D406），不进那六个分组：想关掉它与想知道自己读到哪，是同一个地方的两件事。在设置页自己翻完**不算**已读。

**为什么。** 「第一次装不弹」这条不是省事，是定义：这里要告知的对象是**已经用过这个服务的人**，而不是「机器上多了一份新状态目录」。改这一个判据同时解决了两件事 —— 新装用户不再被七十批旧账迎接，仓库里上百个临时状态目录的 UI 测试也不会一开门就被一张模态弹窗盖住（剩下预写口令的那批用 `PI_WEB_WHATS_NEW=0` 关掉）。

「打开即写」是刻意的：这个功能的目的是**知道**，不是**确认**；反过来（点「知道了」才算）会把「不打扰」开个口子，还得再配一个频率上限。已读存桥端而不是 localStorage，是为了与「桥启动时判定」同源、并且手机和电脑看到同一份已读 —— 代价是一次改动影响所有设备。不把设置页那一页改造成弹窗，是因为那等于把用户从对话里拽进设置控制台，回会话还要再点一次。开关不放进 pi 的 `web.*` 设置，是因为它和已读是**同一份状态**：桥端一次读、一次写，pi 的 settings.json 被锁住或被手改都不该影响这条提示。

**不做。** 把 pi 本体的 CHANGELOG 也纳入这个弹窗；en / ja 的日志正文翻译；系统通知或托盘提醒；把 24 小时、10 分钟做成可配置项；旧桥不认识新接口时的兼容层（就是不弹）。

**守卫。** `npm run test:whatsnew-popup`（`bridge/tests/whatsnew-popup-unit.mjs`）：批次切分（含 `###` 分组与注释）、没记录 / 已读在中间 / 已读就是最新、已读那批被改写、闸未满与正好满、开关关着、`older` 列表与顺序。`node probes/whatsnew-dialog.mjs`：真桥 + 真页面，验首弹内容与 N、一打开即已读、刷新不重弹、重启不重弹、闸挡住且已读不前进、只差一批时不出「还有 N 批」、Esc 能关、设置页那两行与开关落盘、在设置页翻完不推进已读、草稿没发出去时先不弹、窄屏铺满整屏、字号 150% 时底栏仍在屏幕里。派发窗口的到期单独在单测里验（`claimExpired`）。

## D359 子代理详情卡跟着数据长：原文晚到就补，失败就说为什么（用户报「任务原文没传到桥」2026-11-21；修正 D185 决定 6 的前提）

**修正 D185：** 第 6 条把 `workflow-receipt.json` 当成「runner 早就把清单写进去了」，实测它在跑完那一刻才写（上游「问题」第 1 条）；回填来源改为 `status.json`，其余各条（`args.args.tasks[]` 优先、已有值不覆盖、`hasOut` 按跑完没跑完判）不变。

**问题：** 同一层弹层里两张卡都写着「（任务原文没传到桥）」。查下来是两个不同的毛病叠在一起，而 D185 把这两个形状当成一个处理了。

1. **脚本式 workflow**（`subagent({cwd, options:{script:"await runs.all([…])"}})`，实测 `1f34ca75-e6e0-4529-ba74-2e35f4cf496a`）：任务原文只在 `options.script` 里，`args` 里没有 `tasks[]`、`details` 里没有 `workflowChildren`，桥只剩 `sessionName` 一条路 —— 而它只在 `status.json` 的 `steps[]` / `workflowChildren.children[]` 里。D185 第 6 条的回填读的是 `workflow-receipt.json`，理由写的是「runner 早就把清单写进了同目录」；实测不成立：开跑 17:24:14，`steps[0].sessionName` 17:24:15.099 就有，receipt 的 `createdAt` 是 17:27:03.637 —— **跑完那一刻才写**。于是卡片在跑着的那几分钟里一直空着，而且 `prune()` 之外没人再读盘，即使数据到了也要等 30 秒或重开弹层。
2. **前台派活当场失败**（`subagent({workflow:true, cwd, async:false})` 而那条助手消息里没有 ```js 围栏，实测 `call_00_79ZGyKVyGhxhy8l7XsKw7723`）：runner 的报错只存在于那一条工具结果里，`foregroundOutput()` 只认 `Return: {…}`，`BgRun` 也没有装错误的字段 —— 于是卡片只有「失败 · 0:00」，任务、过程、原因全是空的。
3. **前端只画一次**：`paintBgSheet()` 建节点时就写死了 `task` 的文字，`BgRunNode` 里也没有 `agent` / `task` 的引用，桥后来回填也永远显示占位；`hasLog` 同样只在建节点时取一次。

**决定：**

1. **读盘顺序 `recordedChildren(dir)`：`workflow-receipt.json` → `status.json.workflowChildren.children[]` → `status.json.steps[]`。** receipt 先读（它是独立文件，没有 `status.json` 也要读），后两者是跑着的那几分钟里唯一读得到任务的来源。任务文字仍是 `summarizeChildren()` 那份截断过的 `sessionName`（`1. Code review: STANDARDS axis only…`）—— 不假装是原文。
2. **三处都顺手补：** 建卡时（`noteToolEnd` 的 `kids` 链尾）、`readLog()`（`bg.log` 每 1.5 秒一轮，比 30 秒滴答快）、`prune()`（改调同一个 `backfillNames()`）。`readLog` 不回写 `onChange()`：页面每个滴答本来就会再要一次 `bg.list`，同 D185「补 `logPath`」的补法。
3. **失败原因存下来：** `BgRun.error` / `BgRunView.error`。前台失败且没有 `outText` 时存工具结果的开头（`clipError()`：去空行、前 3 行、最多 600 字，只截断不改字）；后台完成通知里带 `failed` 的也存一份（`run.error ??= clipError(text)`）。前端在任务行下面用 `.bg-run-err` 原样显示。
4. **占位文案不再指认桥：**「（任务原文没传到桥）」→「（没有任务原文）」（`en` / `ja` 同键跟着改）。这次就是桥收到了才写出占位，把责任写成桥没收到，用户只能来问。
5. **失败且没有过程记录的卡不摆空过程框：** `state === "failed" && !hasLog` 时「过程」两个字与框一起藏 —— 派活当场就挂的调用没有 runner，说「桥还没接上」等于叫人去查一个不存在的东西。
6. **不去 `options.script` 里抠原文：** 那是任意 JS，正则提取会造出**假的**原文（可能是别的任务的 prompt 片段），比截断的名字危险得多，也违反 D185「一个字不改」的取向。要真原文只能读子会话 transcript，得另开白名单与一条决定。

**代价 / 可改：**

- **卡片上的任务仍是截断名**：`reviewer: Code review: STANDARDS axis only, do not modif...`。完整 prompt 只在子会话的 session 文件里，见第 6 条。
- **`status.json` 每次详情轮询/日志轮询各 parse 一次**（几十 KB）：沿用 D185 的取舍，量级是单会话 1.5 秒一次；真嫌慢再加 mtime 缓存。
- **错误只留三行 600 字**：够放 runner 那几句（"The workflow script is missing." + 怎么重试），长栈会截尾。要看全文仍去会话里翻那条工具结果。
- **回填只在名字空着时动手**：`agent` / `task` 一旦有值就不再覆盖，误填与真值无法靠后续数据纠正 —— 与 D185 第 5 条一致。
- **回填不按 `run.workflow` 卡**：单 run / parallel 的卡名字缺了也照同一个顺序补。`status.json` 里没有 `workflowChildren` / `steps` 时 `recordedChildren()` 返回空，不会凭空造任务；派活时 `details` 缺 `agent` 的不只脚本式 workflow 一种（D185 第 2 条）。
- **后台 run 只在完成通知带了 `failed` 时才写原因**：`prune()` 从 `status.json` 看出失败的（没有通知，或通知里没写失败）卡片仍只有「失败」二字 —— 那个文件里没有一段能当理由的文字。要看原因得去会话里翻工具结果。

**验证：** `npm run test:bgruns` 新增两段：脚本式 workflow 形（`options.script`、无 `workflowChildren`、`status.json` 带 `steps[]` + `workflowChildren.children[]`）→ `readLog()` 后 `agent` 是 `reviewer`、`task` 是两条编号行、`prune()` 之后不变；前台失败（`workflow:true` + `async:false`）→ `state` `failed`、`hasOut` false、`error` 以 `The workflow script is missing.` 开头且正好三行，成功卡没有 `error`。第一版把 `status.json` 放在读 receipt 之前，`bridge/tests/bgruns-unit.mjs` 里原有的「receipt 里的 agent 补回来」当场变红（`'' !== 'planner'`），改成先读 receipt 才绿。
`node probes/bg-runs.mjs`（新探针，丢弃式 bridge + fake-pi 的 `BGSCRIPT` / `BGFAIL` 两个场景，真 Chromium）：停在会话列表点「后台」徽标开弹层，断言开卡那刻是「（没有任务原文）」、留在同一张卡上 12 秒内自己换成两条任务、卡片头变 `reviewer`；前台失败那张卡标「失败」、错误三行原样在卡上、没有「最终输出」、没有空过程框；界面不再出现「任务原文没传到桥」；10 项全过，无 `pageerror`。`npm --prefix web run typecheck`（含 i18n / viewport / layers 单测 14 项）与 `npm --prefix bridge run typecheck` 均绿。
## D360 测试实例的浏览器 tab 上是「测试 <实例名>」（用户要求「启动新的测试窗口，窗口的 tab 名称是测试+启动测试环境的会话名」2026-11-21）

**症状。** 正式的 7864 和一两份测试实例同时开着，浏览器上一排 tab 全叫「pi」，分不出哪个是刚起来的那份；测试脚本起完只打印一个地址，窗口还得人自己开、开完也认不出来。

**根因。** 正式和测试跑的是同一份前端、同一份 HTML（`web/index.html:9` 的 `<title>pi</title>`），`document.title` 全仓只有 `fillExt()` 里一处设置（`web/src/app.ts:16004`），算出来只可能是「会话标题 · pi」或「pi」。实例名只活在脚本的标准输出和 `~/.pi/agent/state/pi-web-test-dev/instances.json` 里，从来没进过页面。

**决定。** 把实例名交给**桥**，由桥写进它送出的页面 —— 不是 URL 参数，也不是前端写死。

- 测试脚本起桥时带 `PI_WEB_WINDOW_TITLE=测试 <实例名>`（`bin/env.mjs:324`），`--name` 缺省时是 `t<N>`，标题也随之变成「测试 t2」。
- 桥端 `serveStatic()` 只在「变量非空 + 送的是 index.html」时改正文（`bridge/src/index.ts:261`）：`injectWindowTitle()`（`bridge/src/window-title.ts`）把 `<title>` 换成实例名、并往 `</head>` 前挂 `window.__piWindowTitle`。首帧 tab 就对，不靠 JS。
- 前端把标题算法收成 `documentTitle()`（`web/src/window-title.ts`）：前缀顶在最前，会话标题接在后面 —— 测试实例里进某个会话就是「测试 t1 · 会话名」；没有前缀时与原来一模一样。
- 脚本启动成功后**自己开一个窗口**（`openWindow()`，`bin/env.mjs:237`）：Windows 先按 App Paths / `Program Files` 标准路径找到 `msedge.exe` 再 `--new-window`（`Get-Command msedge` 不可靠，Edge 不在 PATH 上），macOS 先试 Edge 再回退 `open`，Linux `xdg-open`；开完等 Edge 的窗口标题里多出一条**等于「测试 <id>」**的才报「新开了一个：测试 t1」。退出码不算数 —— Edge 常驻时丢 URL 只会在后台开标签，用户看到的还是「没打开」。`--no-open` 只打印地址。

为什么不走 `?tab=测试 t1` 那种 query 参数：标题该是**实例**的属性，不是某一次打开方式的属性。同一份实例谁打开、哪个窗口都该叫「测试 t1」；query 只对带参数的那一次有效，还会一路跟着 URL 被复制出去。

**代价。** 正式实例一个字节都不变（`WINDOW_TITLE` 为空时仍走原来的流式发送，不读全文）。测试实例里 `document.title` 的最前面是实例名，会话名被挤到第二段；浏览器通知 / 书签这些跟着标题走的入口也会变 —— 这正是想要的。前缀是**实例数据**（`windowTitleFor()` 里的「测试」写在脚本里），不跟界面语言切换：静态 `<title>` 得在 JS 之前就正确，桥那边也没有用户语言可查；`/peer`（内网通）页固定「内网通 · pi」，不跟实例名走。

**守卫。** `npm run test:window-title`：`bridge/tests/window-title-unit.mjs`（无标题时页面原样、`<title>` 与注入脚本的位置、标题里的 `</script>` / `<` 不把页面写坏、没有 `</head>` 的畸形页面补 `<head>` 且不把脚本塞到 `<!doctype>` 之前）与 `web/tests/window-title-unit.mjs`（前缀 × 会话标题四种组合，正式实例必须还是「会话 · pi」/「pi」）。真机：`env.mjs start` 的输出里出现「新开了一个：测试 t1」才算开成（新增标题必须**等于**「测试 <id>」，别的新窗口不算），找不到 Edge 或标题一直对不上就明说，不要报成功。

## D361 分发构建产物要随附第三方版权声明：清单由锁文件生成，设置里能看（2026-11-21）

**症状。** 仓库只有根目录 `LICENSE`（Apache-2.0）与 README 里一行「[Apache-2.0](LICENSE)」，没有 NOTICE，也没有任何第三方清单。而 `web/dist` 是单文件 bundle：`highlight.js`（BSD-3-Clause）、`@xterm/xterm` 与 `@xterm/addon-fit`（MIT）的版权头在压缩后一个都不剩（这三个包发出来的 ESM 本身就没有 `/*!` 头 —— xterm 是压好的 UMD），`vite.config.ts` 也没开 `legalComments`。源码分发有 `node_modules/*/LICENSE` 兜着，一旦把 `web/dist` 交给别人（或发 npm 包），BSD-3 / MIT 的「保留版权与许可声明」就落空了；桥端 `web-push`（MPL-2.0）还要求给出源码地址。

**决定。** 声明不手写，由锁文件生成，三处消费同一份事实。

- `tools/notices.mjs` 读四个 `package-lock.json`（根 / web / bridge / peer）的**非 dev** 条目（传递依赖一样进产物），从每个包自己的 `LICENSE*` 里取版权行与正文，生成根目录 `THIRD-PARTY-NOTICES.md`（约 99 KB）与 `web/src/legal/bundle-notices.txt`（只含真正打进 dist 的三个，约 0.4 KB）。包内没有 LICENSE 文件、只声明 MIT 的（`http_ece`）补标准正文并写明版权人取自 `package.json` 的 author，不假装它随包发过。
- `web/vite.config.ts` 把后者读成 `build.rollupOptions.output.banner`；**不能指望 `esbuild.legalComments`**（没有可识别的许可注释可保）。banner 落在 ESM 的 import 之后，仍然在文件里。
- 桥加 `GET /api/notices`（在 cookie 闸之后，100 KB 文本，`cache-control: no-store`），`bridge/src/notices.ts` 按 `import.meta.url` 上两级找仓库根那份文件，读不到就 404 `notices-missing`，不拿空串糊弄。
- 设置 → 关于多一行「开源许可」，点了**原地展开** `<pre>`（要能选中、能 Ctrl+F，不套弹层），高度用 `calc(var(--vh1) * 42)` 而不是裸 `vh`（D123 / D263）。
- 四个 `package.json` 补 `"license": "Apache-2.0"`；三份 README 的许可段指向这份清单，并说明「分发产物时一起带上」。

**代价。** 99 KB 的生成文件进 git（依赖不动就不变，diff 只在升级时出现），每次改依赖都要 `npm run notices`，忘了就在 typecheck 里红。清单是**运行时**从仓库根读的，发行包丢了它，设置里只会得到 404 —— 这是有意的：产物里的清单会跟装的依赖不一致。

**守卫。** `npm run test:notices`（`bridge/tests/notices-unit.mjs`）：`tools/notices.mjs --check` 通过、三个打包组件的段落里有版本 / 许可名 / 版权人 / 许可正文、`web-push` 的 MPL-2.0 带源码指引、页首声明里不出现没进产物的桥端依赖、`noticesText()` 读得到仓库根那份。`npm run typecheck` 第一步就是 `node tools/notices.mjs --check`。构建后 `grep -c Copyright web/dist/assets/*.js` 每块非零（本次 3 / 3 / 4）。

## D362 公开仓库里的真第三方隐私要脱敏，作者自己的现场路径不动（2026-11-21）

**症状。** 这是一份公开仓库（Apache-2.0），但两处验证记录里直接写了作者的真信箱（QQ 邮箱，地址在正文里已换成描述），其中一条还带着别人投递的简历文件名（`…_Resume.pdf`）；`docs/shots/peer-chat.png` 更是整块个人主目录的截图（`C:\Users\GG_Bond` 下的 `AI`、`clip`、`ansel`、`Contacts`、`Cookies`…），而且它是个**孤儿文件**：三份 README 引用的是 `peer-agent.png`（正常的对话截图，没有 PII），没有任何文档引用 `peer-chat.png`。邮箱同时是 git 历史的作者地址，也出现在 D229 的「真信箱（…）」证据行里。

**决定。** 分两类处理，**不是**按「谁的隐私」分：**有证据价值的验证记录**（工作树路径、分支名、命令输出）照 D114 不动 —— 包括 README 图里 `E:\yqm\pi-web-client` 这种项目路径；**孤儿截图里任何人（含作者本人）的家庭目录清单**一律删掉，它不承担任何证据作用，留着只暴露账号名与机器名。

- 两处「真信箱（真地址）」改成「真信箱（作者自测的一个信箱…）」，附件名改成 `resume.pdf`，都在句子后标「见 D362」，让读者知道这里被改过、而不是原本就没有。这条记录自己也只写掩码 —— 把原串抄进来，守卫一 grep 就红，等于没脱敏。
- `docs/shots/peer-chat.png`（`C:\Users\GG_Bond` 的完整目录清单）与 `docs/shots/peer-picker-new.png`（`C:\Users\yangqm.HYRON-JS` 与对端主机名 `DESKTOP-VANQ2M`）直接删掉：两张都是孤儿，没有任何文档引用。`git log --diff-filter=D` 还找得到，`peer-agent.png` 不受影响；`peer-picker.png` 留着（只露 `F:\pi-web-client\docs\shots`）。
- `docs/shots/xlsx-ribbon.png` **保留**：它露出的只是本仓库自己的工作树路径（`F:\pi-web-client-wt\feat\xlsx-render\.scratch\…`）与分支名，没有第三方身份信息，属于 D114 说的「当时怎么验的现场记录」。想重拍时注意 `probes/xlsx.mjs` 现在在 `openSession()` 就红（1440×900 下 `.topbar .icon-btn.wide` 的「文件管理器」是 hidden，等了 15 秒），得先修探针，别拿它当重拍工具。
- **历史 commit 不改：** 改写历史会让所有 fork、PR 引用与 issue 里的 SHA 全部失效，收益只是把一个已经公开过的信箱从 packfile 里挪走 —— 与 D114 的取向一致，也避免不可逆的操作。真要清理得整库重建，那不是一个文档 PR 该做的事。

**代价。** 被删的图和被改的字都不再是「原样证据」，但两句都留了指向 D362 的标记，读者能分清「当时就是这样」与「这里被脱敏了」。git 历史里的信箱仍可被 `git log -p` 翻到。

**守卫。** `grep -rn '13040495[0-9][0-9]\|Jenil_Son[i]' docs README*.md` 为空（正则里各拆一位，免得这行自己命中 —— 这条记录自己也只写掩码）；`docs/shots/` 下不再有个人主目录清单的截图；`git config user.email` 已是 GitHub noreply 地址（`57058104+Yang-Code01@users.noreply.github.com`），新提交不再写真实信箱。

## D363 局域网聊天仍叫「内网通」：名字撞了商业产品，但这是一个私有项目的功能名（2026-11-21）

**问题。** 侵权体检时发现「内网通」是别人的在售商业产品名 —— 南通艾睦网络科技有限公司的局域网即时通讯软件（官网 51nwt.com，苏ICP备18049291号-2，2025 年仍在更新 v3.4.3055，常被写作「IMO 内网通」）。我们这套局域网聊天的 UI 标题、README、`web/peer.html:6` 的 `<title>` 都叫「内网通」，与它**同名同品类**。

**决定。** 改名的事评估过一轮（候选 LAN / 局域网 / 邻网 / 内网），最后**不改**：这是作者自用、不对外销售、不投放的应用，「内网通」在这里是功能名而不是商品名；同一类词在 IT 里属于描述性用法（局域网内通信），且仓库没有任何对方商标、图标或界面素材。

- 三份 README 加一句声明：本项目与南通艾睦的「内网通 / IMO 内网通」**没有关系**，名字只是描述「内网里通消息」这件事。
- 将来若对外发布、上架或做推广，先改名再说 —— 那时才需要商标检索，现在没有商业使用，构不成实际的混淆来源。

**代价。** 搜索「内网通」会混进对方的官网与下载页，别人可能误以为这是它的插件；README 那句声明就是为这个准备的。i18n 的英文译文一直是 `LAN`（`web/src/i18n/en.ts`），日文同理，外语界面本来就没有这个问题。

**可改。** 真要改名，全仓库 332 处 / 54 个文件（`docs/DECISIONS.md` 65 处最多），历史文档按 D114 不改，只改代码与 README。

## D364 界面风格与命令名：仿的是观感与公开约定，不搬别人的素材（2026-11-21）

**问题。** 侵权体检把仓库里所有「对标别人」的地方都翻了一遍，结论是：**没有资产层面的风险，只有措辞层面的**。代码与文档里到处是「照 WPS 抄」「iMessage 气泡」「照 macOS 表情弹窗做」，读起来像是把别人的界面搬了过来；而实际上仓库里一个外部图标、字体文件、皮肤位图都没有——图标全是内联手绘 SVG（`web/src/app.ts` 那一批 24×24），壁纸是 CSS 渐变，字体只写系统字体名、不打包 webfont（D110）。

真正的争议点只有两处：表格功能区的**中文命令名**与**数字格式代码**，以及 Mac 主题的**观感**。

- **命令名与格式代码是公开约定，不是 WPS 的创作。** 「加粗 / 冻结窗格 / 中文大写数字 / 单位：万元」这些是 Excel 中文界面的通用叫法，`[DBNum2][$-804]G/通用格式` 这类格式代码是 Excel 文件格式的语法，Excel 存出来一模一样（WPS 兼容它）。函数名同理：`SUM` / `XLOOKUP` / `SUMPRODUCT` 是公开的事实清单。我们取的是「同一套叫法与语法」，用户按这个找按钮、按这个打开文件。
- **观感可以接近，素材不能取。** 圆角、玻璃、发丝线、弹簧曲线、气泡形状都是自己写的数值；「iMessage 气泡」只是描述「一侧收口」这个形状。
- **读资源文件的目的写清。** `docs/SHEET-WPS.md` 一开始就写「拿本机的 WPS 当参照物，把资源读出来对行为」，但通篇用「逐字照抄」「原样输出」的口气，容易被读成「抄资源」。

**决定。** 只改措辞与归属，不动代码行为（这一轮一个字的功能代码都没改）。

- `docs/SHEET-WPS.md` 顶部加一节「参照物与边界」：取用的只有函数名与格式代码两类公开事实，没有取用图标/皮肤/位图/翻译文件/代码；文档保留原样清单是为了可复核。正文里「逐字照抄」「值得抄」改成「原样记下来」「值得对齐」，对照表表头改成「WPS / Excel 的命令」，灯位说明改成「排法与 Excel / WPS 一致」。
- `bridge/src/sheet/numfmt.ts:2-5`、`web/src/sheet/ribbon.ts:2,10-12,15` 的注释改成同一口径：按 Excel 的格式语法重写、用本机 WPS 的 cfg 做对照、命令名用 Excel 中文界面的通用叫法。
- `web/src/mac.css`、`web/src/peer/peer-mac.css` 小节标题里的「iMessage 气泡」，以及 `web/src/app.ts` 主题说明那句里的「iMessage 气泡」，都改成「圆角气泡」（`en.ts` / `ja.ts` 的三语译文同步换键）；`web/src/mac-base.css` 头注释加一条：壁纸是 CSS 渐变、圆角/阴影/缓动是自己写的数值，没有 Apple 的图片、图标或字体，名字里出现 macOS 只是描述观感。
- `web/src/peer/emoji.ts:4` 改成「排法跟 macOS 的表情面板一样」（描述布局，不声明来历）。
- 三份 README 在「许可」前加一节「与别人的东西的关系」：非官方前端（上游 `@earendil-works/pi-coding-agent`，MIT，© Mario Zechner，地址取自该包的 `repository` 字段）、商标归各自主人且不使用其图标、表格对标 Excel 的公开约定、Mac 风格与「内网通」名字的说明。

**代价。** 文档里不再有「照抄」这种直白说法，读者得看「参照物与边界」才知道那些清单是怎么来的；两处注释变长了几行。功能行为、产物像素一个都没变。

**守卫。** `grep -rn '逐字照抄\|照 WPS 抄' docs web bridge --include=*.md --include=*.ts` 只剩 D364 自己在引述旧说法（其余为空）；`grep -rn 'iMessage' web/src` 只剩 `mac-base.css` 头注释里「名字里出现 macOS / iMessage 只是描述观感（D364）」这一句；三份 README 都有那一节（`grep -c '与别人的东西的关系\|How this relates\|他の人のものとの関係' README.md README.en.md README.ja.md` 各 1）；`npm --prefix bridge run typecheck` 与 `npm --prefix web run typecheck` 照旧全绿（只动注释与文档）。

## D365 把「没看懂」做成输入框上方那一行「重讲」，而不是让模型自己想起来的技能（用户「我想要把 skill：wait-what 嵌入本工程，因为每次手动调用太麻烦了」2026-11-21）

**背景。** `wait-what` 技能（`~/.pi/agent/skills/wait-what/SKILL.md`，英文原文）做的事是：用户说「没看懂」时，把刚才那一段用 ASD-STE100 简化技术语言重讲一遍（背景 → 结论 → 下一步）。问题是它得人去翻技能、发 `/skill:wait-what`，没人会在看不懂的时候还记得有这个东西。

**试过又被否掉的三条路。** ①做成「设置 → 系统提示词」里一条可开关的注入（`--append-system-prompt`，照 `DELIVERY_HINT` / `PLAN_HINT` 的做法）：用户否 —— 那是让模型**自己决定**什么时候重讲，看不见也管不住。②做成技能面板里置顶的快捷入口：仍然是「先想起来去点」。③挂进 `/` 菜单：同理。用户要的是**答案旁边一个能点的东西**，不是更短的命令。

**决定。** 输入框上方常驻一行（`.retell-bar`）：左边一句「没看懂最后一条回答？」，中间一颗药丸「↻ 重讲」，右边一行小字「先交代背景，再用简化技术中文说结论」。点它 = 把一句本地化的指令当成**下一条用户消息**发出去（`behavior:"steer"`），不碰输入框里的草稿。

- **为什么不用「每轮回答前加一条特别提示」**：那样每轮固定多两三行，长对话里最吵；而且提示条与它的回答之间隔着用户的下一条消息，回头读时对不上。输入框上方这一行始终贴着「你现在要说话的地方」，位置固定不随回答长短漂移。
- **三态只在 `web/src/retell-state.ts` 里判**（`hidden` / `off` / `ready`）：没开会话不画；没有说话回答或这一轮还在跑就是灰（半截回答重讲没有意义）；停下来了、有回答才亮。`app.ts` 只负责画和写 title，跟 D159 的「继续」同一个范式。
- **指令跟着界面语言走**（`tr()` 三份）：中文原文是用户定的「等一下。我不明白你在这里进行到哪一步。请重新说明。先提供上下文。然后使用简体技术中文来说明。」英文换 Simplified Technical English、日文换やさしい日本語。不读 SKILL.md 原文 —— 技能在用户家目录里、界面语言与它无关，而且换成别的机器就没有这个文件。
- **发出去的是普通用户气泡**，不是桥注入的 [`remind`] 块：这一下确实是他点的，不该伪装成系统提醒（与 D169「自动提醒」区别开）。

**代价。** 输入区常驻多一行（约 26px，字号放大时按比例涨），而且**每轮都在**，不是想知道时才出现。选它是因为另一头是「想不起来有这么个东西」—— 常驻的那点地方换「看得见」，值。灰态（跑着一轮、或还没有回答）会有一行点不动的药丸，title 写清楚原因。

**守卫。** `npm run test:retell`（`web/tests/retell-state-unit.mjs`，6 条）：没开会话不画、还没回答也不画（新建空会话）、跑着才灰、老桥不发 `running` 也能判、只读预览照常可点。`probes/retell-hint.mjs`（已进 `probes/run-all.mjs` 名单）：位置、三态（含新建空会话不画）、设置里的拨杆关 / 开、发出去的指令、草稿保留、英文文案，以及**连点两下只发一句** —— 点下去到桥的 `running:true` 回来之间有一段空窗，那 1.5 秒里按钮自己按住，到期再自己松手（`retellTimer` 补一次 `sync`）。`npm --prefix web run typecheck` 追加七条 i18n 键（缺一条 `i18n-check` 就红）。样式遵守 `#app` 里不写裸 `vh/vw`（这一行是流式高度，不涉视口单位）。

**修订（2026-11-25，用户「重讲的功能会有提示：先提供上下文，再用简体技术中文说明。这个不需要在 chat 框上面显示，放到设置里面的对话里面对应开关的提示」）。** 输入框上方那截 11px 灰字（`.retell-sub`）删掉，那一行只剩「没看懂最后一条回答？」+ 药丸：说明句每轮都在，却只在第一次见时有用。同一句话搬进 设置 → 对话 那颗开关的说明（`先提供上下文，再用简体技术中文说明。默认开；关掉后输入框上面那一行不再出现`）—— 想不起来「重讲」是什么的人，正好会在开它/关它的地方读到。药丸的 `title` 仍带完整说明（鼠标停上去还读得到），行为、发送内容、三态都没变。左侧分组小字「输入框上方那一行「重讲」开不开」保留：它说的是那一行本身，不是说明句。`probes/retell-hint.mjs` 补两条：输入框上方没有 `.retell-sub`、设置说明以原句打头并讲清关掉后会怎样。

## D366 本机每个实例用自己的 cookie 名，测试环境登录不再把正式实例踢下线（用户「开了测试环境后，每次主环境都变成了未认证，每次都得刷新页面，重新登录口令」2026-11-21）

**背景。** 浏览器存 cookie 只看 host、不看端口：`127.0.0.1:7864` 与 `127.0.0.1:17864` 上的同名 cookie 是**同一个槽**。桥的会话 cookie 一直叫 `pwc`，而签名用的 `secret` 在各自 state 目录里。测试环境（`.pi/skills/pi-web-client-test-dev/`）以 `PI_WEB_STATE=~/.pi/agent/state/pi-web-test-dev/<id>/bridge` 起桥、口令恒为 `test`；在测试窗口里一登录，浏览器就把正式实例的 `pwc` 顶成一枚用另一把 secret 签的 token，正式页面的下一次 `/api/me`（以及 WS 升级，`bridge/src/index.ts:2303`）就是 401 —— 页面停在登录页，得刷新重输口令。

**决定。** cookie 名跟 state 目录走：默认 state 目录仍是 `pwc`（升级后现有的 cookie 继续有效，正式实例不用重新登录）；显式 `PI_WEB_STATE` 的实例用 `pwc_` + `sha256(stateDir)` 前 10 位。`bridge/src/auth.ts` 里 `sessionCookie` / `clearedCookie` / `authorized` 共用同一个常量，登录、退出、校验不会各说各话。名字锚在 state 目录而不是端口：端口重启会变，state 目录就是那把签名密钥的归属，也是实例的身份。

**为什么不用别的。**

- 给 cookie 加端口作用域：RFC 6265 的 cookie 没有端口维度，做不到。
- 让所有实例共用同一把 `secret`：测试实例的 token 就能直接登进正式实例，而测试脚本的口令是公开的 `test`，等于把正式实例的门拆了。
- 前端改成 localStorage token + `Authorization`：丢掉 HttpOnly，还要改所有请求与 service worker，换来的只是把冲突面挪个地方。
- 只在测试脚本收尾时清 cookie：管不住用户手工多开的第二个实例，也没解释「为什么会串」，下次照样复发。

**代价。** 用 `PI_WEB_STATE` 起的实例（测试环境、多开）升级后各自要重登一次；默认实例不受影响。cookie 名不再是一个固定字符串 —— 本机现在会同时有 `pwc` 与 `pwc_<hash>`，排查时别只 `grep pwc=`。state 目录搬家等于换了实例身份，得重新登录。

**守卫。** `bridge/tests/auth-cookie-scope.mjs`：开三份真实桥（A、B 各自 state 目录，另有一份**不设 `PI_WEB_STATE`** 的默认实例），用一个**忽略端口**的 cookie 罐走真实 HTTP —— 登录 A、再登录 B，回头问 A 的 `/api/me` 必须仍是 200，且两枚 cookie 名不同；把 B 的 cookie 原样递给 A 必须 401（名字分开不等于密钥共享）；默认实例登录后拿到的名字必须是 `pwc`（升级不用重登）。把 cookie 名改回共用一个，第四条立刻红；把名字改成永远哈希，最后一条红。跑法：`npm --prefix bridge run build && node bridge/tests/auth-cookie-scope.mjs`（约 3 秒）。「默认目录」的判据只认 `bridge/src/paths.ts` 的 `stateDirIsDefault()`，auth 不再自己读 `PI_WEB_STATE`。
## D367 设置里「装行的容器」是 `.settings-panel`，`.settings-group` 只做小节头（#588 那一页的版面从上线起就是竖的，2026-11-21）

**背景。** #588（D354）在「设置 → 更新日志 → 本项目」里加了一个开关与一行「上次看到」。写的时候把这两行塞进了 `el("div", "settings-group")`，而 `.settings-group` 在设置控制台里是**横排的小节头**（`display: flex; justify-content: space-between`，`settings-console.css`）：于是「小节头 + 两行设置」排成了一条 flex 行，每行只剩一列字的宽度，整页变成一根竖条（实测 435×1002 与 350×551，名字列 17px）。

文字断言拦不住它 —— `querySelector(".settings-row")` / `.settings-name` 照样拿得到，只是高度 1000px。三个会打开这一页的守卫（`bridge/tests/settings-console-ui.mjs`、`bridge/tests/whatsnew-ui.mjs`、`probes/whatsnew-dialog.mjs`）当时都只比文字和点击，所以从 `567dd66` 上线到被发现，没红过一次。

**决定。** 这一页改回全站同一套「小节头 + 面板 + 行」：小节头 `stSection()` 留在外面，两行装进 `.settings-panel`。「上次看到」的值不再借用 `.settings-path`（那是可点路径的样式：`word-break: break-all` + `margin-bottom`），换成新增的 `.settings-value`（等宽一档、长了省略、全文进 `title`）。

- `.settings-group` 从此**只**做小节头。要装行就 `el("div", "settings-panel")`，别拿它当外框 —— 它自己的 `justify-content: space-between` 与 `align-items: baseline` 会把子项当标题栏里的两段文字。
- 想验证「这一页摆对了」，**只能看几何**：`.settings-row` 高过宽、或名字列超过 2.5 行，就是外层容器错了。文字与 DOM 查询都过得去。

**代价。** 无。这是把一处笔误改回全站模板；`.settings-value` 只多一条样式。

**守卫。** `bridge/tests/whatsnew-ui.mjs` 的 A 段与 `probes/whatsnew-dialog.mjs` 的第 6 段各加一条几何断言（行不能高过宽、名字列不超过 2.5 行），并断言两行确实装在 `.settings-panel` 里；两处本来就会打开这一页，成本为零。**`bridge/tests/settings-console-ui.mjs` 没加**：它自己在 main 上就是红的（左栏分组 / 十项文案 / 头部 scope 的旧断言与后来的改版对不上，B 段之后、G1 直接抛 timeout），那条「每个设置页扫一遍行几何」的通用断言得等它先修好 —— 记在这里，别以为已经覆盖。

## D368 长回答收尾回到第一行，而不是留在末尾（用户报「回答完成后得自己滚回最上面」2026-11-21）

**症状。** 回答流式长出来时视口一直贴底；等它结束，人停在最后一屏，要读开头得自己往上滚好几屏。短回答没有这个问题，只有长到超过一屏的回答才有。

**根因。** 跟流只有往下这一条路：`delta()` 每来一段就 `scrollToEnd()`（`web/src/chat.ts:1321`），`message_end` 的 `replace()` 收尾时又贴一次底；`setRunning(false)` 只重画最后一枚用户气泡的「处理中」，不碰滚动。没有任何一处会在收尾时把视口送回回答开头。

**决定。** 选「收尾回开头」：`running` 从 true 翻成 false、且用户此刻仍在跟流时，把**最后一条 assistant** 的第一行送到视口顶部（留 6px）。做成 `ChatView` 内部的一个收尾动作，不动 app、桥、协议与样式：

- `setRunning()` 记下 `wasRunning`，true → false 后等两帧再量（`replace()` 已经把流式节点换成最终节点，高度要等排版）。
- `settleScroll()` 只在「最后一块内容就是这条 assistant」时动手：后面还跟着工具卡 / 下一轮用户气泡就不算收尾；手动折叠过的不动；回答不到视口 90% 不动（整段都看得见，动了像页面抽了）；`touching` / `staging` / `pendingJump` / 已经停跟都不动。
- 动手时置 `following=false`、`unread=false`，先 `renderJump()` 再量（钮显隐会改一点 `scrollHeight`）；`holdFollow = now + 900` 挡住从底部往上跳的头几帧 scroll 事件，避免 `resumeFollowing()` 把视口拽回底部；最后 `scrollTo({behavior:"smooth"})`。目标本来就在最后一屏里（`startTop >= maxScroll - 1`）时留在底部。
- 不调 `stopFollowing()`：它会报 `onScrollUp`，让提问面板以为人自己往上滚了而收起来。也不调 `jumpToTurn()`：那是定位用户轮次、还会闪用户气泡。
- `reset()` 静默清 `running` 并取消待跑的帧：换会话 / 重连时旧会话的 true 会让新会话的 false 被当成「刚结束」，不取消就会滚到别人的回答上；app 随后那句 `setRunning(新会话.running)` 因此成为一次真正的跃迁。

**顺带修掉的单位混用（D123）。** `getBoundingClientRect()` 是视觉 px，`scrollTop` 是布局 px，`#app` 上挂着 `zoom: var(--ui-scale)`；原来的 `rect.top - root.top + scrollTop` 在默认字号 125% 时会把目标算大 0.25×局部距离，`scrollTop` 过冲，收尾停在回答首行上方几百像素。新 `contentTopOf(node)` 把 rect 差除以 `--ui-scale` 再相加；`jumpToTurn()` 的同一段也改用它（右侧刻度带跳到轮次时同样受益）。

**代价 / 可改。** 收尾会动一次视口（这正是 A 的定义）；回答在 0.9–1.0 屏之间时首行已经落进最后一屏，`startTop >= maxScroll - 1` 会走 `follow()`，仍停在底部（不会再往上顶）；阈值、6px 呼吸、900ms 冷却、平滑动画都是可调的常量，先按实测手感取这组。用户一旦上滚、手指还在屏上、或收尾后又有新内容，都只点亮「有新内容」，不再自动移动。

**守卫。** 新增 `probes/settle-top.mjs`（`npm run probe:settle`）：长回答收尾停在首行、↓ 可见且无「new」、点 ↓ 回底；短回答也真正流完并收尾一次，视口不动；流式中途上滚不被拽回；收尾后补一条 delta 也不拽回。`probes/scroll-race.mjs`（D68 / D94）、`probes/turn-rail-last.mjs`（D244 / D60）、`probes/rail-click.mjs` 仍要跑；后者把固定 900ms 等待换成了「等滚动停稳」再量落点。`npm --prefix web run typecheck` 全绿。


## D369 一轮恒一个操作框：技能组插到框前，而不是把框收掉（用户截图报障「一次回复中，操作框出现了两次」2026-11-21）

**取代。** D199 决定 7 里「卡到达时页面收掉已经开着的那一掽操作（`closeOps()`）」那句作废：那时以为不收就会把下面那张 read 画进上面那掽，其实只有本轮第一张卡需要挪位，而挪位靠插入位置就够了。D200「组不移动」不变。

**背景。** 会话「模型ui重新设计」的一轮回复里出现了两个操作框：`2 个操作 · read ×1 · bash ×1` 和 `7 个操作 · read ×1 · bash ×6`。那一轮的工具顺序是 `read grill-me/SKILL.md` → `bash` → `read grilling/SKILL.md` → 6 个 `bash`，两次 `skill` 项正好落在两个分界上。

根因是 `web/src/chat.ts` 里 `add()` 的一行：每个 `skill` 项到达都无条件 `closeOps()`。当时的注释说「隐式技能卡是下面那张 read 的前言，不能落在它后面」——这个意图**只对本轮第一张技能卡成立**：技能组只在本轮第一张卡到达时 `push()` 一次、之后不移动（D200），第二张以后的卡只会 `append` 进顶部那个组，本来就到不了自己那次 read 上面。所以那次关框换不来任何版面收益，只把一轮的操作切成两撮。D200 里写的是「拆成两摞」，实际是**每个后续技能各拆一撮**：一轮 N 个技能最多 N 个框。

实测（一次性探针，手写会话 + 私有端口，跑的是与截图同源的构建）：真会话顺序 → `2 | 7`；两个技能连读 `read,read,bash×7` → 仍 `1 | 8`（所以「两个技能之间夹没夹工具」不是必要条件，只要技能到达时模块里已有卡片就拆）；单个技能来晚 `bash,read,bash×7` → `1 | 7`。

一直没被发现，是因为 `probes/skill-group.mjs` 只数 `.skillgroup`、从不断言 `.ops` 数量，而它的 fixture 本身就把一轮拆成了 3 个框。

**决定。** 两条一起改（缺一条都治不干净）：

- `add()` 删掉 `if (item.kind === "skill") this.closeOps();`。
- `ensureSkillGroup()` 插入组时：本轮已有操作框（`this.opsBox` 且 `parentNode === this.root`）就 `current.before(box)`，否则照旧 `this.push(box)`。

于是「技能卡在所有工具之上」这条从*靠收掉模块*改成*靠插入位置*，而且比从前更彻底（以前只保证在**自己那次** read 上面，现在在**本轮所有**工具上面）；一轮任何到达顺序都只有一个框。**例外**：问答卡与待办卡不住在操作框里（`add()` 里它们直接 `push()` 到会话流），技能组不会为它们让位——先有问答卡、后有技能时，组落在卡下面。D200「组不移动」不变：组仍然只在第一张卡时插入一次，之后只往组里加卡。

为什么不用只加一个条件的版本（`&& !this.skillGroup`）：它只治「同一轮多个技能」，`bash → read 技能 → bash` 这种「第一个技能来在工具之后」仍然两个框——用户下次撞上还是一样的观感。改插入位置以后，那种情形里技能组从两框之间挪到最上面，这是本条唯一会让元素移动的地方。

为什么不改成「技能并进操作框内部」：那要重做 D199 的卡片形态，属于新设计而不是修 bug，另有样张（`.scratch/ops-split/prototype/s4-b-flat.html`）留档，用户选了不改。

**代价。** 技能来晚时（`bash → read 技能 → bash`）技能组的位置从「两框之间」挪到「最上面」，读法从「工具 / 技能 / 工具」变成「技能 / 工具」；组件形态、标题文案、折叠行为都不变。

**守卫。** `probes/skill-group.mjs` 新增按 `.msg.user` 切轮的断言：每轮只有一个 `.ops`、行数等于本轮工具数、标题计数对得上、技能组排在操作框前面。fixture 第二轮故意做成「工具先跑、技能后到」（`bash → read 技能 → bash`），第三轮就是报障那一轮的原序（`read → bash → read → bash×6`，合并后标题 `9 个操作 · read ×2 · bash ×7`）。改前这三条都红（一轮 3 个框 / 技能来晚 2 个框 / 原序 `2 | 7`），改后全绿；同一个探针也参进了 `probes/run-all.mjs` 和 `npm run test:skill-group`，不再只是一次性脚本。

顺手修了这条探针自己的假红：原来卡 `summary` 盒高 `< 40px`，而折叠态盒高自上线起就是 43.3px（inline 徽标的行框比一行字高），所以它一直是红的、当不了闸门。现在比的是「3 个名字的组与 1 个名字的组一样高」——名字多了走省略号、高度不变，这才是那条不变量。

同一修法下，一次性复现探针的三个变体（真会话顺序 / 技能连读 / 技能来晚）都只剩一个框，标题分别是 `9 个操作 · read ×2 · bash ×7`、`9 个操作 · read ×2 · bash ×7`、`8 个操作 · bash ×7 · read ×1`。`npm --prefix web run typecheck` 全绿；`bridge/tests/ops-tabs-ui.mjs`（27/28，那条「失败计数是红的」在 main HEAD 上就红）与本条无关。

## D370 网页里未决定的项目默认按信任处理：spawn 时补 `--approve`，新用户不再静默丢掉 `.pi` 配置（#21 续，2026-11-21）

**背景。** pi 的默认值是 `defaultProjectTrust: "ask"`（[chunk-62VOPMLK.js:43]），终端里第一次进入带 `.pi` 资源的目录会弹一次「是否信任」。桥走 `--mode rpc`，没有这个提示通道，所以网页以前把 `ask` 读成 `never`：目录没在 `~/.pi/agent/trust.json` 里保存过决定，`.pi/settings.json`、`.pi/mcp.json`、`.pi/extensions|skills|prompts|themes`、`SYSTEM.md` 就全部静默不加载，用户也看不到任何解释。`AGENTS.md` / `CLAUDE.md` 本来就不受信任门管。用户的原话是「改这个没有用，新用户，咋办？」—— 只在机器上把全局默认改成 `always` 解决不了别人的新环境。

**决定。** 网页把「未决定」当成信任：`bridge/src/pisettings.ts` 的 effective 改成 `entry ? entry.decision : fallback !== "never"`；`bridge/src/sessions.ts` 在拉起 pi 前算一次 `trustInfo`，只有 `needed && !saved && fallback === "ask"` 时补 `--approve`。显式保存过的信任/不信任、全局 `never` 与 `always` 都不碰（`always` 下 pi 自己会加载，不需要旗标；`never` 下照旧不加载）。信任面板与设置提示同步改成「ask 按信任处理（不能弹提示）」，面板里写明未决定时是自动信任。项目设置在未决定时也可写（与「按信任处理」保持一致）。本决定取代 D78 第 3 条，并修订其第 2 条里「未信任的项目拒绝写入」的判据。

**为什么不用别的。**

- 网页首次运行就把全局 `defaultProjectTrust` 改成 `always`：会改掉用户在终端里也会用的全局配置，等于替所有 pi 实例做了决定，事后很难解释是谁改的。
- 提上游让 RPC 在 `ask` 时直接信任：要等发布，而且上游未必愿意把「无人值守」的语义塞进通用 RPC。
- 网页里加一次性确认弹窗：信任要在子进程读文件**之前**定下来，桥没有阻塞在 spawn 上等用户的地方；会话已经起来了再问，配置已经错过了。
- 保持旧语义、只在界面上提示：新用户仍然要自己找到 `/trust`，正是这次要消除的静默失败。

**代价 / 可改。** `--approve` 是 pi 的「本次信任」旗标，它也会压过**用户级扩展**对未决定目录抛的 `project_trust` 事件；要彻底关掉自动信任，在网页设置里把全局 `defaultProjectTrust` 设成 `never`，或对目录保存「不信任」（一个选项，优先级最高）。克隆来的仓库在网页里因此变成零点击加载 `.pi/extensions`，安全默认比终端松 —— 这是本决定的已知代价。改动对已经跑着的会话不生效，`/reload` 或新会话才重新算。

**验证。** `npm --prefix bridge run build && node bridge/tests/settings-trust.mjs`：B2 段断言 `ask` + 未决定 → `effective === true` 且 fake pi 的 argv 带 `--approve`、项目设置可写；`never` → 无旗标且快照为不信任；`always` → 无需旗标；保存「不信任」后压过 `always`；项目级 `pi mcp list` 的 argv 是 `["--approve","mcp","list","--json"]`。真 pi 实测接受该旗标：`pi --help` 有 `--approve, -a  Trust project-local files for this run`，`pi --approve --mode rpc` 退出码 0、无未知选项报错。`npm --prefix web run typecheck` 覆盖 i18n 与 viewport 守卫。

## D371 删掉当前会话的落点 = 「归档当前会话」那一套（★ 行右邻 → 左邻 → 空态）（用户「从横排置顶的会话中，删除会话，当前的横排置顶不显示了，必须要重新点击上方的工作区之后，才会显示」）

**问题。** 从 ★ 行里删掉**当前打开的那颗**会话之后，整条 ★ 行只剩尾巴那颗 ＋，本区还在的置顶一颗都看不见；点一次上方的工作区标签（`gotoGroup()` 会打开本区第一颗会话）才回来。删一颗**非当前**的 ★ 一切正常。

**根因（探针复现，不是推测）。** 桥的 `manage{action:"delete"}` 回声先发 `session.gone`，`App` 的 `session.gone` 分支在这时把 `currentId` / `session` 清空、把中栏 reset 进空态；而 ★ 行的数据是 `starredRow()`，D210 规定**没有当前会话就一颗都不排**。于是「删掉的是自己那颗」＝「当前会话没了」＝「整条置顶空了」。用户手点工作区标签之所以管用，是因为那颗标签走 `gotoGroup()` → `openFromList()`，**顺手打开了一颗会话**，`currentId` 又有了值。

**决定。** 删掉当前会话之后不留在空态，按**「归档当前会话」同一套落点**（D176）走：`neighborAfterArchive()`（纯函数，`web/src/pillbar.ts`）算 ★ 行的右邻，没有右邻取左邻，左右都没有才进现成的「还没有打开会话」空态。

- 行只认一份：`App.rowIds`（上一帧 `renderSessionRow()` 留底的 ★ 行序，与归档用的是同一个字段）。当前会话没打 ★ 时它自己占第 1 格 —— 补上去，右邻不因这一格而变。
- 批量删：整批 `session.gone` 的 id 全传进 `alsoArchived`，同批一起消失的那几颗不能当落点。
- 切换走现成入口：有邻居 → `openSession(next)` + `go(this.tab)`（草稿、订阅、hash 都照旧）；没有邻居 → 原来的空态代码原样保留。
- 入口不新增：`session.gone` 是所有删除路径的唯一回声口（★ 行气泡、左栏卡片、管理面板批量、垃圾箱之外的 `trash`），规则写在这里一处，四个入口自动一致。

**为什么是「落到邻居」而不是「让 ★ 行留着」。** 用户点上方工作区标签已经**事实上**打开了一颗会话 —— 他要的就是「删完之后接着干活」，不是「停在空态看一条空行」。让 ★ 行在没有当前会话时继续铺上一区（或全局）的置顶要推翻 D210，还得新记「上一个工作区」；落到邻居既不动 D210，又让中栏不留空，和关浏览器标签的直觉一致。

**代价 / 可改。** 与 D176 同一档：**本区一颗 ★ 都没有**时删当前会话仍然进空态（严格只看 ★ 行），哪怕左栏还有几十个会话；要改只需把 `neighborAfterArchive()` 的兜底从 `null` 换成「左栏树里的下一颗 / 上一颗」。另外落点按上一帧画出来的行序算，两次回声之间别处改了 ★ 顺序会按旧序落点（D176 已记过同一档竞态）。

**验证。** `probes/pin-delete-current.mjs`（新，桩桥 + 真工作区快照 + 真 Chromium，5 段）：删非当前 ★ 其余照旧；删当前 ★ → 剩下的两颗 ★ 仍在、落右邻「文档站」、`#/s/pd-c`；删行尾那颗 → 落左邻；删到最后一颗 → 空态 + `#/`；管理面板批量带走当前 + 右邻 → 跳过同批那颗落到再右边。**改前先在旧构建上跑过一遍确认会红**（第 1 段那 5 条全红：★ 行 0 颗、没有 `.cur`、`hash=#/`、中栏是空态），改后全绿。`npm run test:pillbar`（`neighborAfterArchive` 的右邻 / 左邻 / 同批跳过，D176 那组）不回归；`npm --prefix web run typecheck`（含 i18n-check 与 viewport 守卫）、`npm run build:web` 通过。顺手跑的相关探针：`pin-archive-jitter` STEADY、`round16-pin` ALL OK、`workspace-tree` 全过。**`pin-current`（字重 500 / 400 两条）、`archive-switch`（等不到 `.pin-strip .pin-chip[data-pin-id]`）、`round24-pinactions`（「左栏展开后置顶条应当整条收起」这条期望在壳 A 两行制之后已经过时）、`pin-auto-open`、`nowchip`、`round4-pin`（等「2 颗置顶胶囊」——D210 之后没有当前会话一颗都不排）、`workspace-shells` 在 origin/main 上就已经是红的**：另开一份 origin/main 工作树逐条复跑确认过，与这次改动无关，别以为是本次弄坏的，也别以为这些面已经覆盖。

## D372 运行时阈值默认改为空闲 120 分钟 / 内存水位 5 GiB（用户「我希望修改将本项目默认设置为 120 分钟，5G」2026-11-21）

**问题。** D120 定的默认是「完成 + 30 分钟无事件就休眠、水位 2.5 GB」。用户要求把**项目默认**改成 120 分钟 / 5 GB：一轮长任务或长思考跑完就被收掉太早，回来再发消息要等 1–3 秒冷启、还要重载上下文，不值。

**决定。** 只改 `bridge/src/lifecycle.ts` 的两个默认常量：

- `DEFAULT_IDLE_MS`：`30 * 60 * 1000` → `120 * 60 * 1000`。
- `DEFAULT_WATERMARK_BYTES`：`2.5 * 1024 ** 3` → `5 * 1024 ** 3`（面板除以 1024³ 渲染，所以 5 GiB 显示成「5 GB」，与既有单位一致）。
- 随手问的 `DEFAULT_SCRATCH_IDLE_MS` 不动，仍是 0（D233：永不自动睡）。

四条边界：

- **`idleMs` 仍是一个值服务三处**（D120 §8）：空闲休眠、watchdog 的卡住判定、所有页面都不 present 时审批 / 问卷过期。三处一起变成 120 分钟 —— 这是明确接受的代价，不新增第二个字段，面板上的「空闲多久休眠」仍然就是这三处共用的那个数。
- **只改默认，不改优先级**：`PI_WEB_IDLE_MS` / `PI_WEB_WATERMARK_BYTES`（测试钩子）> `<state>/lifecycle.json` > 代码默认（`lifecycle()` 的顺序没动）。已经在面板上保存过阈值的实例不受影响 —— 本机就是这种情况，`lifecycle.json` 早就是 120 分钟 / 5 GiB，所以这次改动在本机看不到行为变化。
- **测试不再抄默认值**：`bridge/tests/runtime-settings.mjs` 里原本自己写了一份 `30 * MIN` / `2.5 * GB` 并断言「没改过时是默认的 30 分钟 / 2.5 GB」，改成从 `../src/lifecycle.ts` import 两个常量、断言文案按常量渲染。以后再调默认，不会先把这个测试弄红（这次它本来会红）。
- **注释里写死数字的句子一起改**：`lifecycle.ts` 头部「squeeze the 30-minute rules」、`sessions.ts` 里 watchdog 取整函数的说明与审批过期那段「30 minutes after you left」。

**为什么 30 分钟变 120 分钟。** 30 分钟对「跑完一轮、人离开一会儿再回来接着追问」太紧：休眠本身无害（消息、文件、上下文都在，下一条消息自动唤醒），代价全在唤醒那 1–3 秒冷启与上下文重载上，而长任务跑完之后恰恰最可能马上要接着问。放宽到两小时，把「同一段工作时间内的来回对话」留在热态。

**代价 / 可改。**

- **watchdog 同步放宽到 120 分钟**：真正会 `abort` 的只有「没有任何东西在途却长时间没有事件」的回合（有工具 / `!` 命令 / 待批审批在途时只推一条 notice，绝不 abort，D120 §3），所以受影响的本就是罕见的僵死回合；代价是一个真卡死的回合要多占两小时的内存。要收紧就得把 watchdog 拆成独立阈值 —— 面板、`runtime.stats`、三语文案、测试都要跟着扩，这次不做。
- **审批 / 问卷过期同步放宽**：所有页面都不 present 时，挂着的审批要两小时才被丢弃 —— 人离开一小时再回来，那张卡还在；反过来说，它丢掉那一次工具调用也会晚到两小时。
- 默认更宽松 = 更多 pi 进程可以同时睡着不睡；内存侧由水位兜底，5 GiB 比原来宽一倍。两手是同一套机制，「内存紧」时把水位调小就回到激进回收，不用改代码。
- 已经手动保存过阈值的实例**不会**跟着变（`lifecycle.json` 优先）。想让某台机器回到新默认，删掉它的 `lifecycle.json`。

**验证（实测）。**

- `npm --prefix bridge run build && node bridge/tests/runtime-settings.mjs` → PASS。默认值取的就是新常量（断言文案现在是「默认的 120 分钟」）、改值落盘且跨重启保留、非法值整份拒绝、隧道来的写要 step-up。
- `node bridge/tests/session-lifecycle.mjs` → PASS（C 段：`lifecycle.json` 里的秒级阈值生效，默认的两小时没生效）。
- `node bridge/tests/memory-cap.mjs` → PASS（A–D 四段，采样不可用时一个都不收）。
- `node bridge/tests/stuck-run.mjs`、`approval-expiry.mjs`、`sleep-all.mjs` → PASS。前两个自己注入秒级 `idleMs` 验 watchdog 与审批过期（它们吃同一个值，改默认后必须重跑）；`sleep-all` 不吃这个值，但靠「默认值长到不会自己休眠」成立。
- `npm --prefix web run typecheck` → 4071 键 × 3 语言无缺键，`#app` 里没有裸 `vh` / `vw`。
- `node probes/runtime-settings.mjs`、`probes/runtime-panel.mjs`、`probes/runtime-sleep-all.mjs` → all checks passed。

**顺手修掉的探针（必须说明）。** 这三个 runtime 探针从 `9f00bbd`（2026-11-19 把齿轮设置改成两大类页签）起就是红的：那次改了设置导航与 pi 设置的容器（`.settings-body` → 控制台 `.st-console` / `.st-pane`）并更新了另外六个探针，漏了这三个。不改它们，这次就跑不了那条界面验证。但要说清它验的是什么：桩桥喂的是 30 分钟 / 2.5 GB，探针证明的是「按 60s / 1024³ 换算并渲染成整数、能保存、非法值被拦」；**新默认值本身**由 `bridge/tests/runtime-settings.mjs` 那条 import 常量的断言负责。

- 入口从「顶栏 `pi 设置` 按钮」改成「齿轮 → 连接与设置 → 工具 → pi 设置」。
- `runtime-panel` 那条「不可用时不留 0 B」改读 `.settings-sheet`。
- `KNOWN_MISSING` 补上 `🔷 Jira` / `Jira` / `Web Push` / `bridge`：词典只收含中文的原文，这几条纯 ASCII 的键本来就不翻译，不是漏翻。

## D373 模型切换改成「设置控制台」那一套：左栏三页 + 只在改了时才出现取消/确认（用户「根据设置的 ui。重新设计一下 chat 框下面的模型切换 ui」2026-11-21）

**背景。** 输入框下面那颗 chip 是四格胶囊（模型 / 窗口 / 速率 / 档位），点开是一张自成一套的居中弹窗：上下文阈值行、折叠的「会话」行、当前模型、可折叠的 provider 分组、思考档位 chips、底栏「未改动 / 取消 / 确认」。设置页（`/settings`）这两年是另一种语言：`.st-console` 双栏壳（左栏入口、右栏内容、底栏只在改了时出现保存条）、`.st-cards` 统计卡、`.settings-panel` + `.settings-row` 的卡片行。同一套界面里两套弹窗语法，用户提出来要统一。

**决定。** 模型弹窗换成 `.st-console settings-sheet model-sheet`：左栏 `切换`（当前使用 / 全部模型）+ `信息`（本会话，只读），右栏按页渲染；头部是「模型与思考」+ 草稿模型名 + `provider · id · 窗口` + `N 个模型` / `未保存` 徽标；底栏平时只有一句提示，**改了才长出「取消 / 确认」**（对齐设置页「改了才出现保存条」）。点一行只改草稿，点档位同理；`确认`（或 ⌘/Ctrl+Enter、行双击）才发 `setModel` / `setThinking`，`取消` / Esc / 点遮罩一律丢弃草稿。切模型时若当前档位在目标模型上不存在，落到它的**最高档**——`off` 是最低档，落过去等于默默把思考关掉。「最近使用」并进「当前使用」页，不单独占左栏入口（用户要求：不要重复入口）。

chip 一起改：模型名 · 思考档位（带点）· 上下文（进度条 + `72K/1M`）· 速率 · ▾。**空闲时不再显示 `– tok/s`** —— 速率是流式的副产物，没在跑的时候它只是一格噪声；真在流式才出现。这一行本来就挤（技能 / 上下文 / 插件 / 文件 / 释放会话），所以 `.hint` 开了 `container-type: inline-size`：容器窄于 620px 时 chip 只留「模型 · 档位 · ▾」，上下文数字让位给同一行的「上下文」按钮，别把「释放会话」挤到第二行。

**为什么不用别的。**

- 沿用旧弹窗、只换皮：用户在两个弹窗之间仍得切两套语法（一套有确认步骤、一套没有），统一也就没发生。
- 每点一次立即生效（不做草稿）：能省一次点击，但思考档位与模型是**会改变后续所有回合成本**的设置，误点没有回头路；设置页已经证明「改了才出现按钮」不会拖慢人。
- 把「最近使用」留在左栏：左栏是**入口**，不是列表；同一个模型在「当前使用」和「最近使用」里各出现一次，用户会以为有两份。

**补丁（反馈后第二版的三个毛病）。** ①「全部模型」页原来只有模型行，改档位得再切回「当前使用」，等于两步跳；第一版修法是在两页顶部各插一块「思考档位」，结果用户又撞上第二个问题 —— 19 个模型时，选完中间那个还得滚回顶部才能换档。最终把档位控件从滚动区里拿出来：`.st-pane` 变 `display:flex` 两段，上面 `.pm-body` 自己滚，下面 `.pm-lvbar` 常驻（`思考档位 · 草稿模型名 · 分段`），滚到列表底部也够得着；这一条在「当前使用」页同样生效（两个页共用一条，不会出现两套控件）。② 这一页原来会把草稿模型排到第一行 —— 点一行、整张列表换位，看起来像「选完自动跳到第一个」，鼠标底下那行已经不是刚点的那行；现在按目录原顺序排，选中行只加高亮与「待切换」胶囊，位置不动。

**补丁（多来源）。** 第一版把「全部模型」做成一整列平铺 —— 真机上只有一个来源（wb2api）看不出来，但接第二个来源后 19+ 个模型混在一起，唯一能看出出处的只有 id 前缀（`cn:` / `or:`）。现在按来源分组：组头一行 `▾ 来源 · N 个`，点了折叠，状态写进 `pi.modelGroups.open`（跟目录选择器共用同一份，不必多记一个键）；**当前模型所在组默认展开**，否则新开一屏只看见一排折着的组头；**搜索时强制全部展开**，组头改报 `N / 总数 个` —— 否则搜出来的东西藏在折着的组里，等于没搜。只有一个来源时不画组头（见上），免得 19 个模型顶上多一行无关信息。平铺的「当前使用 / 最近使用」在多来源时行里带出来源名（`wb2api · off · medium`）。顺带修了没接管时「确认」还能点的问题：桥会直接丢掉 `setModel`，现在底栏只剩一句「这个会话没有写入权，先接管会话再切模型」，「全部模型」页也摆了同一块接管提示。

**补丁（评审后）。** 三处是行为约定没落到代码上，补上：① ⌘/Ctrl+Enter 真的算「确认」（挂在 `.st-console` 上，冒泡范围内的输入框也认）；② 没接管时行双击也走不到 `setModel` —— 原来只把底栏按钮藏了，双击照样发，桥直接丢掉、chip 却按「已换」改了本地状态；现在 `commit()` 头一行就 return；③ 「待切换」那一节只在模型真的变了才出现 —— 只改档位时草稿＝当前模型，再插一块就是同一行画两遍。另外两处是可用性：搜索框从滚动区里搬出来（原来每敲一个字整块 body 重建，`<input>` 换节点，中文输入法的候选词会断），「当前来源默认展开」改成只对第一次渲染生效（记在 `forceOpen` 里，用户点一下折上之后不再被 paint 摊开）。


**倍率放哪。** `x0.11` 是 wb2api 塞在模型名里的计费口径（`Kimi-K3 · x1.62 · 1M`），`shortModelName` 一直把它切掉。现在单独取出来放进 chip 和弹窗（头部 sub、行 hint、窗口卡的 sub）。chip 上它排在上下文之后、比上下文数字更晚出场：1600 宽的工具行只有 652px，模型名 + 档位 + 上下文 + 倍率 + ▾ 放不下，会把这行挤到两行；所以 ≤700px 时倍率让位（旁边就并排着「上下文」按钮）、≤620px 时上下文数字也让位。真机上要看 chip 上的倍率，把窗口拉宽到 ~1750 以上，或者直接开弹窗。

**代价。** 多一层左栏，在 1000px 宽的弹窗里占 214px；「全部模型」要滚动才能看完 19 个。草稿只活在弹窗里：弹窗被后台事件重建（模型目录刷新、接管完成）时不保留未确认的选择 —— 与旧版 `draftModel` 的行为一致，但确认步骤让这种丢失更显眼。草稿现在只按 `id` 认模型（不认 provider）：两个来源撞同一个 id 时会认第一个，这在现有目录里还没发生，真发生了再把 draft 改成 `{provider, id}`。

**守卫。** `npm --prefix web run typecheck`（i18n 三份齐全 + `#app` 里没有裸 `vh/vw` + 弹层层带单调）；`node probes/model-sheet-ui.mjs`（桩桥 + Chromium，不花模型调用，目录里放了 wb2api / openrouter / lmstudio 三个来源）盯住：按来源分组且当前来源默认展开、组头点了能折回去、搜索时自动展开并报命中数、点一行只改草稿且**不重排列表**、**列表滚到底时档位条仍在视口内**、取消/Esc 丢弃、确认才发 `setModel` / `setThinking`、目标模型没有当前档位时落最高档、窄容器里上下文数字让位但整行不换行。`.model-row` / `.model-list` 被目录选择器与工作区新建面板复用，这次没有动它们：模型行另起 `.pm-row` / `.pm-*`。顺手修了 `mac.css` 的 `html[data-ui="mac"] .st-nav__item.on * { color: inherit }` —— 它把选中项里的 `.st-nav__count` 也刷成白字，浅色胶囊上的数字看不见（设置页同样受影响）。

## D374 没有会话的工作区也切得过去：页面记住「选中的工作区」，NowChip 承担 ★ 行那张气泡（#611；用户「当某个工作区中没有会话时，现在无法切换，希望改成可以切换」「当工作区中只剩一个会话时，横排鼠标移动到最后一个会话时，没有出现弹出，归档、删除的小 dialog」2026-11-21）

**问题。** 两处根因是同一个：页面把「我在哪」完全绑死在一颗会话上。

- **只剩一颗会话时，★ 行里没有可操作的胶囊。** ★ 行只列**本区打过 ★** 的会话（D146 / D210），没点 ★ 的当前会话由最左那颗 NowChip 代表，而气泡组件（`pinmenu.ts`）只被 ★ 行胶囊的悬停手势调用过 —— NowChip 一次都没接过。于是「工作区里只剩一颗会话」恰好落进「整条行里没有任何可悬停的胶囊」，归档 / 重命名 / 删除一个入口都没有。用户遇到的那颗就是「没置顶、没有星星图标」的那颗。
- **空工作区切不过去。** 标签行、壳 B/C/D 的工作区浮层段头、竖列(C)、色点条(D) 的「切到这一组」都只有一条路：打开组里排最上面的那颗（`gotoGroup()`）。没有会话就只剩「把左栏展开 / 滚到它」，横杠（`.ws-tab.on`，读的是 `currentWsId()` 反查当前会话）还停在上一个组 —— 看上去就是点了没反应。

**决定。** 页面多记一件事「选中的工作区」，并把 ★ 行那张气泡也挂到 NowChip 上。

- **选中态**：`localStorage` 的 `pi.ws.selected`（存组 id，不是目录）。优先级固定为 **当前会话所在组 > 选中的工作区 > 无**，只在 `effectiveWsId()` 一处算 —— 标签行 `.on` / `aria-current`、竖列与色点条的 `.on`、浮层段头的 `.on` 全部改读它，不再各自反查当前会话。
- **`gotoGroup()`**：有会话照旧打开第一颗（★ 优先，行为不变）；没有会话 → 写选中态、关掉当前会话、中栏进空态，再照旧展开左栏并滚到那一组。**左栏组头不动**，它仍是折叠开关 —— 为了切空组去改左栏最常用的手势，代价比收益大。
- **清掉选中态**：打开任何会话（点胶囊/卡片、深链 `#/s/<id>`、新建、垃圾箱还原、交接接棒）；组从桥的快照里消失（删组 / `prune()`）。**不清**：刷新、换布局、折叠左栏、过滤。另外**快照还没到时一个字都不清**（`pruneSelectedWs()` 在 `groups` 为空时直接返回）—— 否则刷新第一帧就会把存着的选中态当成「组已经没了」抹掉。
- **中栏空态分两句，按事实挑**：`group.count` 为 0 → 「{p1}里还没有会话」；否则 → 「{p1}里的会话还没打开」（`count` 含已归档，与左栏组头那颗「空」徽标同一个数）。没有选中的工作区时，沿用原来的「还没有打开会话 / 左边选一个，或者开一个新的」，一个字不改。
- **空态多一颗按钮**「在{p1}里开一个会话」，与 ★ 行尾巴那颗 ＋ 都在新会话弹层里预填该组目录（`openNewSessionSheet({ cwd })` 已有这条路）。顶栏 ＋ / 竖列 ＋ / 浮层底部 ＋ 仍用「你上次用的目录」—— 那几颗平时不属于「本区」，突然换目录容易意外。
- **NowChip 那张气泡**：复用 ★ 行胶囊的气泡组件与放置逻辑，三项动作「归档 / 重命名 / 删除」，**没有**「取消置顶」（它本来不在 `manage.pin` 里）。手势参数与胶囊一致（180ms 弹 / 220ms 收 / 指针进气泡不关 / Esc 关）。**只在桌面挂**：窄屏那颗的点击是「打开工作区浮层 / 展开左栏」，而触屏的 `pointerenter` 是点下去才触发，气泡会抢在那一下点击前面；点它时先收气泡，不让两层浮层叠着。
- **两个动作的动效**：归档 = 原地淡出 → 发归档 → 中栏进空态（**不演** ★ 行那种「横向收拢让位」——那颗没有邻居，收拢只能看着像被挤坏；动画结束先 `cancel()`，否则 forwards 留下的 `opacity: 0` 会粘在这颗身上）；删除 = 用 NowChip 的矩形克隆体沿弧线飞进左栏🗑（复用 `deleteFromPin()`，飞行轨迹与垃圾桶反馈与胶囊同一套）。
- **删 / 归档当前会话后的落点一个字没改**（只看 ★ 行：右邻 → 左邻 → 空态，D176 / D371），只是进空态时把归属记成**那颗会话原来的工作区** —— 「删/归档完还停在这个工程里」比「哪儿也不在」更好猜。
- **桥不需要改。** 查过 `bridge/src/workspaces.ts`：派生组存在 `workspaces.json` 里，`prune()` 只按 `keys` 映射清（组 id 还对应同一个工程根就留着），**不看组里有没有会话** —— 所以「删空之后组还在（标『空』）」本来就是现状，不用新增协议或状态文件。

**为什么不把 NowChip 塞进 ★ 行**（另一条候选路）：那样要推翻 D210「没有『我在哪』就谈不上本区」与 D146「打开 ≠ 置顶」，还会在行 2 里出现两份「我在哪」。补一张气泡只动入口，不动 ★ 行的口径 —— D146 / D210 这一轮一个字都没改。

**为什么是这个形状。** 两件事其实是同一个缺口：页面只有「当前会话」这一个位置来源。补上的第二件事（选中的工作区）不是新概念，而是把「没有会话时我在哪」显式记下来；它只在 `effectiveWsId()` 一处参与排序，所以标签行、竖列、色点条、浮层段头都不必知道「这个组是从会话来的还是记住的」，也不用为「空工作区」写第二套渲染分支。第一件事走同一思路：不把 NowChip 塞进 ★ 行（那会改 ★ 行的定义），只把它接上同一张气泡 —— 入口变了，行还是那一条行。

**代价 / 可改。**

- 选中态存 `localStorage` 而不进 hash：刷新能恢复、换标签页也在，但「我在这个空工作区」分享不了，也没有浏览器历史。
- 组里后来有了会话（别处新建 / 还原），刷新照样停在空态、**不**自动打开，文案换成「里的会话还没打开」。想改成「有会话就打开第一颗」只需动 `gotoGroup()` 旁边那一处判断。
- 过滤态下选中的组可能被筛出标签行，横杠仍然记在它上面（高亮读的是未过滤的组）—— 与「当前组被移出横条仍占最后一格」的现有处理同一个思路，没有额外提示。
- 左栏组头本来就没有「当前组」这个视觉，这次也没加：归属靠标签行的横杠与竖列的 `.on`。加了就得定义「空组」在左栏里的展开态是选中还是折叠，容易和折叠手势打架。
- 窄屏（compact）没有气泡入口：那颗仍是「点开工作区浮层 / 展开左栏」，触屏用户走左栏卡片上的归档 / 删除。

**验证。** `probes/empty-workspace.mjs`（新，桩桥 + 真 Chromium，9 段）先把这几条跑红再转绿：0 前置（只剩一颗、没 ★ ⇒ ★ 行 0 颗胶囊、NowChip 露着）；1 NowChip 悬停出气泡、三项动作齐全且没有「取消置顶」；1b 气泡里改名（`rename` 帧 + NowChip 换名字）；2 点标签行里的空工作区 → 横杠与 `aria-current` 落过去、中栏认领、NowChip 收起、`#/`；3 刷新仍停在那；4 空态按钮与 ★ 行 ＋ 都预填该组目录；5 组里后来有会话 → 文案换成「还没打开」且不自动打开；6 / 7 从 NowChip 气泡归档、删除 → 中栏进空态、横杠留在原组；8 / 9 壳 C 竖列、壳 D 色点条的高亮跟着同一份选中态走、从这两处也能切到空工作区，壳 B 的工作区浮层段头同样能切过去（并顺手验了段头高亮仍在会话所在组）。另跑 `npm run test:pillbar`（20 条，`neighborAfterArchive` 不回归）、`npm --prefix web run typecheck`（i18n 4076 → 4079 键 × 3 语言、`#app` 里没有裸 `vh`/`vw`）、`npm run build:web`。回归本来就绿的 `pin-delete-current` / `pin-archive-jitter` / `workspace-tree` / `rail-click` / `round16-pin` → 全过。**本来就红的记录在案、本轮不救**：`archive-switch`、`pin-auto-open`、`nowchip`、`round4-pin`、`workspace-shells`、`round24-pinactions` 的过时期望、`workspace-tabs`（等不到可见的 `.session-card`）、`rail-ghost`（滚动锚定）、`a11y-workspace`（`.ws-pop` 那条）、`workspace-manage`（取消删除那条）、`manage-ui`（要真桥口令文件）—— 都在 `origin/main` 的另一份检出上逐条复跑确认过是同一个失败，与这次改动无关。

## D375 热部署的每次 `git fetch` 都有上限：直连 20s、每个代理 90s（用户问「为啥热部署一直卡在那里」2026-11-21）

**问题。** 用户点热部署，进度停在「检查更新」（`step: 0`）、用时一直涨到 210s 以上，看起来像卡死。真机证据：`.scratch/hot-deploy/worker.log` 在 `[13:52:40] 当前 main 6f27e8fc` 之后静默整整 5 分钟，然后 `[13:57:40] git fetch 直连失败 … Connection timed out after 300001 milliseconds`；两秒后唯一回退代理 `127.0.0.1:18791` 也连不上（`Failed to connect to github.com:443 over proxy 127.0.0.1 after 2119 ms: Could not connect to server`），`=== fetch-failed ===`，state.json 落成 `phase: "fail"`。也就是说「卡住」= libcurl 默认的 300s 连接超时，这段里界面没有任何进度可画；等它超时，本轮也一定失败。

**为什么之前没有上限。** `fetchOrigin()`（`scripts/hotdeploy.mjs`）先用 `spawnSync` 直连、失败再逐个代理，两边都没传 `timeout`。D272 的「代价 / 可改」里写这句地雷：要更快可以给每个候选加独立超时 —— 一直没落地。

**决定。** 直连尝试 20s 封顶，每个代理 90s 封顶（`scripts/hotdeploy-git.mjs` 的 `FETCH_DIRECT_TIMEOUT_MS` / `FETCH_PROXY_TIMEOUT_MS`）。超时在错误与日志里写成「超过 20s 没连上」，不再露出 `spawnSync git ETIMEDOUT`；直连一开始先写一行日志（`git fetch 直连，最多等 20s`），日志里能看出它在动。

**为什么两个数不同。** 直连要么秒通、要么根本不通（本机被墙时 SYN 全丢），20s 足够；代理要传对象，首次拉取比握手慢得多，90s 才不误杀真拉得下来的部署。

**不改什么。** 代理候选链不动（仍是 env → `127.0.0.1:18791` 兜底，D272），也**不**替用户去探测系统代理（`HKCU\…\Internet Settings\ProxyServer`）。本次只解决「等多久」，不解决「bridge 进程 env 里没代理、18791 又死了」——那种情况下现在的表现是 20s 内明确报失败，而不是坐满 5 分钟。要让它真拉下来，得用带 `HTTPS_PROXY` 的环境重启 bridge。（**D376 起这两条都变了**：候选加上 pi 设置的 `httpProxy` 与系统代理，全失败还会再试一轮——这条只记录当时的边界。）

**代价 / 可改。** 直连若是「慢但能通」的网络，会提前落到代理路径（代理通就没影响；代理也坏时错误里两边原因都会列出）。`spawnSync` 超时只杀 `git` 本体，`git-remote-https` 子进程可能把那次连接超时走完才退；那时 fetch 还没写 refs，不影响仓库状态。

**验证。** `npm run test:hotdeploy` 新增两条：常数在合理区间（直连 5~60s、代理 > 直连），以及 `scripts/hotdeploy.mjs` 里两处 `fetch` 调用必须带 `timeout: FETCH_*_TIMEOUT_MS`（源码守卫，和 windowsHide 那条同一手法）。真机：本机直连不通时「检查更新」应当约 2 分钟内落地（直连 20s + 18791 秒拒），不再是 300s 静默。

## D376 热部署自己找代理：pi 设置 → 系统代理 → env → 18791，全部失败再试一轮（D375 的续，2026-11-21）

**问题。** D375 只给了每次 `git fetch` 一个上限，没解决「直连一坏就必失败」：`fetchOrigin()` 的候选只有进程 env 与写死的 `127.0.0.1:18791`。这台机器上两点都不满足 —— bridge 进程的 `HTTP(S)_PROXY` 全空（桥是手起的，env 是那个 shell 的），`18791` 也没有监听（当时监听里的代理只有 `7899`）。于是直连不通时热部署一定失败，尽管这台机器**明明配了代理**：pi 的 `settings.json` 里 `httpProxy = "http://127.0.0.1:7899"`，Windows 系统代理 `ProxyEnable=1 / ProxyServer=127.0.0.1:7899`。D272 当时把 18791 定成「历史默认端口」，那份默认写在代码里，换机器就失效。

**顺带纠正一个判断。** 用户看到的是「无法连接 GitHub」，但重测时直连是通的：`git ls-remote --heads origin` 2s、`git fetch --prune origin` 3.4s、走 7899 的 fetch 1.1s（`github.com` 的 DNS 落在 `57.155.223.240`，中间有东西接管，但证书与内容都是真的）。所以 13:52 那次 300s 卡死是网络瞬时坏掉，不是常态；真正要修的是「网络一抖，热部署就再没有第二次机会」。

**决定。**

1. 候选顺序改成 **pi 设置里的 `httpProxy` → 系统代理 → 进程 env → `18791`**，同一个代理只留一次。pi 设置排第一是因为它是产品自己的约定（扩展市场的 `bridge/src/market.ts` 读的就是这一份），用户在一个地方填一次，两边都生效。
2. 系统代理只取「手动配置」那一栏：Windows 读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（`127.0.0.1:7899` 与 `http=…;https=…` 两种写法都认），macOS 问 `scutil --proxy`。**PAC 自动脚本（`ProxyAutoConfigEnable`）不猜** —— 那要跑一遍 JS 才知道地址。
3. 所有候选都不通时 **等 3s 再整轮重试一次**（`FETCH_ATTEMPTS = 2`），网络抖动几秒就好的情况靠这一轮吃掉。
4. 加一个**总预算** `FETCH_TOTAL_BUDGET_MS = 240s`：每次尝试的 timeout 取 `min(该路径上限, 预算剩余)`。没有它，候选变多以后「两轮」能把「检查更新」又拖回五分钟 —— 正是 D375 要修掉的那个体感。
5. `proxyCandidates(env, extra)` 保持**纯函数**（系统代理由调用方探好从 `extra.system` 传进来，好测）；worker 用 `resolveProxyCandidates()` 把 pi 设置与系统代理读进来。`18791` 仍留在链尾当兜底，不当主路径。

**代价 / 可改。**

- Windows 上每次热部署多两次 `reg query`（约几十毫秒），macOS 多一次 `scutil`；读失败一律当「没有」，不会让部署停摆。
- 「慢但能通」的直连会提前落到代理路径（代理通就无影响）；代理也不通时错误里两条原因都会列出，末尾还会带「如果 bridge 启动时继承了旧代理，重启 bridge 后再试」。
- 注定失败的部署，最坏等待从 20s 级涨到预算上限（240s）；换来的是抖动场景能自愈。要更快可把 `FETCH_TOTAL_BUDGET_MS` 调小。
- **没做**：PAC 解析、`socks5` 代理的可用性探测（候选会照试，失败写进错误列表）、以及「所有 fetch 都失败时改用本地已有的分支离线部署」—— 那是另一个能力（要动面板与 worker 状态机），留给后续决定。

**验证。** `bridge/tests/hotdeploy-unit.mjs` 新增：候选顺序（设置 → 系统 → env → 默认、去重、空设置当没填）、`ProxyServer` 两种写法、`scutil` 文本解析与 PAC 忽略、重试常数与总预算区间、以及 worker 源码守卫（必须调 `resolveProxyCandidates()`、要有 `for (let attempt = 1; attempt <= FETCH_ATTEMPTS` 循环、重试间隔用 `sleepSync`、两次 fetch 的 timeout 要经过 `budget(`）。本机实测：`resolveProxyCandidates({})` 返回 `["http://127.0.0.1:7899", "http://127.0.0.1:18791"]`（设置与系统代理同值被去重），走该代理 `git fetch` 1.1s 成功。

## D377 直连与代理都不通时，最后再走一次 SSH over 443（D376 的续，2026-11-21）

**问题。** D376 让热部署自己找代理，但「一个代理都没配、18791 也死了」仍然必失败。用户先问「网上国内连不上 GitHub 的方案里有没有比走代理更有用的」，调研后挑了一条能自动兜底的：GitHub 的 SSH 端点 `ssh.github.com:443`。

**调研结论（2025–2026 的中文资料，实测过坐标）。** 四类常见方案里没有比「用用户已有的代理」更通用的：

- **改 hosts / DNS**（GitHub520、ineo6/hosts、SwitchHosts）：只治 DNS 污染；要管理员权限；那类项目自己在 README 里写「手抄的固定 IP 极易过期」。
- **镜像站**（kgithub / kkgithub / gitclone / githubfast / bgithub）：只镜像公开库、**不能 push**；`fastgit`、`cnpmjs.org` 已失效；换域名就等于把用户的历史与身份交给第三方。
- **文件加速**（gh-proxy、`ghfast.top`、`gh-proxy.com`、`ghproxy.net`）：只加速 raw / release 下载，**不走 git 协议**；`ghproxy.com` / `mirror.ghproxy.com` 已关停；有 66MB 上限与黑名单审计。
- **本地反代 + 本地根证书**（Watt Toolkit ≡ Steam++、FastGithub、flashgithub）：本质还是代理，只是把这些步骤自动化。它的「系统代理模式」会写 `HKCU\…\Internet Settings\ProxyServer` —— D376 的注册表读取**已经能自动发现它**；「hosts + MITM」模式要装根证书，产品不能替用户做这个决定。
- **SSH over 443**：不依赖代理与 DNS 欺骗，只依赖能连 `20.205.243.160:443`；一个已经登记过 SSH key 的机器开箱可用。

本机实测：`ssh -p 443 git@ssh.github.com` 与 `git -c url.ssh://git@ssh.github.com:443/.insteadOf=https://github.com/ ls-remote origin` 都在 1.6s 内返回 `Permission denied (publickey)` —— 通道是通的，只是这台机器没把 `~/.ssh` 里的 key 加到 GitHub。

**决定。** `fetchOrigin()` 每轮在「直连 → 各代理」都失败之后，如果 `origin` 是 `https://github.com/…`，再加一次换传输：

- `git -c "url.ssh://git@ssh.github.com:443/.insteadOf=https://github.com/" -c "http.proxy=" fetch --prune --quiet origin`，走 `scripts/hotdeploy-git.mjs` 的 `SSH_443_INSTEADOF`，上限 `FETCH_SSH_TIMEOUT_MS = 25_000`（同样经过总预算）。
- 环境：`sshEnv()` = 去掉全部代理变量（这条路就是绕开 HTTPS 的，留着代理反而让 ssh 去连代理）+ `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new"`，不许它停下来问密码或指纹。
- 只有 `origin` 命中 `^https://github\.com/` 才加这一步（`ssh443InsteadOf()`）：origin 已是 SSH 地址或别的宿主时，这条 `insteadOf` 会把请求送到错误的地方。
- 失败原因里若出现 `publickey`，日志直接补一句「这台机器的 SSH key 没登记到 GitHub，这条路要先加 key」，不让人对着 `Permission denied (publickey)` 猜。
- 顺带把 `GIT_TERMINAL_PROMPT="0"` 铺到所有 fetch 上（worker 没有控制台，任何一条路径等凭据都会卡到超时，等于换个理由重演 D375）。

**为什么要而不是不做。** 它不花用户的钱、不换域名、不改仓库身份，且只在「别的路都死」时才发生：直连通、代理通时一次都不会走到。25s 的上限让最坏情况仍在 D376 的总预算内。

**代价 / 可改。** 没登记 SSH key 的机器上这一步必然失败（约 1~2s，实测 1603ms），只多一条日志与一条错误原因；总预算因此更早耗尽。要更省可以把它挪到最后一轮才试。**没做**：镜像站与 hosts 写进产品流程（只写进用户答复当手动出路）、Watt Toolkit 之类的 MITM 自动安装、`ssh` 用自定义 key 的配置项（现在用 `~/.ssh/config` 的默认身份）。

**验证。** `npm run test:hotdeploy` 扩到三次 fetch（直连 / 代理 / 换传输都要带 timeout 且经过 `budget(`）、`ssh443InsteadOf` 四种 origin（GitHub HTTPS 带/不带 `.git`、SSH、别的宿主、空串）、源码守卫（要从 `origin` 读 URL、要带 `GIT_SSH_COMMAND`、要有 `GIT_TERMINAL_PROMPT = "0"`）。本机手工按同一命令跑过：`debug1: Connecting to ssh.github.com [20.205.243.160] port 443` → 1.8s `Permission denied (publickey)`，exit 128 —— 说明换传输真的把请求送到了 443，而不是原地报「未知选项」。

## D378 热部署那扇窗口按 UTF-8 解桥的日志：`[Console]::OutputEncoding` 指到无 BOM 的 UTF-8（用户「在 window 环境，热部署启动的命令行面板是乱码」2026-11-21）

**问题。** Windows 上热部署开的循环窗口（`scripts/hotdeploy-window.mjs` 生成的 `bridge-window-<port>.ps1`）里，桥的日志中文全成乱码：`已启动` 变成 `宸插惎鍔紝`，还有 `锟斤拷锟斤拷: 系统…` 那种，`Tee-Object` 落到 `.scratch/hot-deploy/bridge-live.log` 的同样烂（那是同一份字符串）。窗口标题与 PowerShell 自己打的灰/青两行提示却是好的 —— 用户截图里正是这个形态。

**根因。** 桥是 node，往 stdout 写 UTF-8；PS 5.1 在**真控制台**里按控制台代码页（简中 936）解原生命令的输出。两套编码对不上，一次错位就是 `宸插惎鍔`；日志里再被加工一遍（含非法序列 → U+FFFD → 再按 UTF-8 写）就成 `锟斤拷`。`[Console]::OutputEncoding` 就是那条解码路径的开关。

**为什么以前没发现。** 同样的脚本把输出重定向到管道（`> file`、bun/bash 里 `-Command` 捕获）时**看不出**这个 bug：没有控制台时 .NET 退回按 UTF-8 解原生输出，中文反而正确。只有开真窗口（`Start-Process powershell`）才复现 —— 排查时别用管道版「验过了」。

**决定。** `windowScript()` 在 `while` 外面加一行：

```powershell
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
```

- **不加 `chcp 65001`。** 实测只改这一项，node 的日志与 PowerShell 自己打的 `Write-Host` 中文在同一扇窗口里都正常（PS 5.1 写自家字符串走 Unicode，不受代码页影响）。设完 `chcp` 仍报 **936**，变的只是 `[Console]::OutputEncoding`（`gb2312` → `utf-8`）—— 它换的是 .NET 解原生输出那一条路径，不动控制台代码页，所以再补 `chcp` 是多余动作。
- **必须 `$false`（无 BOM）。** 带 BOM 的 UTF-8 会让它在每次写到窗口时补一个 U+FEFF。
- **用 `try/catch` 包住。** 老系统或被改过的控制台可能不给设，设不了就退回原样，别让「开窗」这一步本身炸掉。
- **放 `while` 外面一次就够。** 进程级设置，热部署复用同一扇窗口换构建时不需要重设。

**同一处症状的另一个入口。** `.pi/skills/bridge-update/bin/restart.mjs` 生成的 `start-bridge.ps1`（`npm run start:nobuild 2>&1 | Tee-Object -FilePath …`）是 `AGENTS.md` 指定的「更新 / 重启 bridge」那条路，那扇窗口里一样烂：同一份 UTF-8 被按 936 解。同一个提交在它的 `Set-Location` 之后补了同一行。它中间多两层 `npm` / `cmd.exe` 转交字节，实测直接 `node` 与 `npm run` 两种形状都正常（见验证）。

**代价 / 可改。** 这扇窗口的原生输出从此只按 UTF-8 解：若哪天它要跑一个只吐 GBK 的老工具，那个工具的中文会反过来乱（现在窗口里只跑 node 与 `git rev-parse`，都 ASCII 或 UTF-8）。测试里读日志仍按 UTF-16（`Tee-Object` 在 PS 5.1 就是写 UTF-16LE），没跟着改。**没做**：把日志改成 UTF-8（那要换掉 `Tee-Object`，`ForEach-Object` 逐行 `Add-Content` 会拖慢每行日志）；`2>&1 |` 让 node 的 stderr 每行都被包成红色 `NativeCommandError`（`node.exe : …` + `所在位置`），那是 PS 5.1 的既定行为，这次没动。

**验证。** `npm run test:hotdeploy-window` 新增第 ④ 段（真窗口，`Start-Process powershell`，另起临时仓库与只打两行中文就退出的假桥，stdout / stderr 各一行），断言读回的日志原样含「中文测试 已启动 http://127.0.0.1:7998」「银锭拷：系统告警」，且不含 `涓枃` / `宸插惎鍔` / `閾跺畾` 三个已知乱码串。把那行编码设置注释掉复跑即红（实测日志开头 `涓枃娴嬭瘯 宸插惎鍔?http://127.0.0.1:7998`、`node.exe : 閾堕敪鎷凤細绯荤粺鍛婅`）；带上就绿。肉眼对照过两扇真窗口：不加这一行是「涓枃娴嬭瘯 node 鐨勬棩蹇 宸插惎鍔?http://…」，加了是「中文测试 node 打的日志 已启动 http://…」。`npm run test:hotdeploy` 仍 ok。另外单独验过 `npm run … | Tee-Object` 那条形状（临时 `package.json` + 只打两行中文的假脚本，真窗口跑 `restart.mjs` 生成的同款启动器）：不带这一行日志是「涓枃娴嬭瘯 宸插惎鍔?http://127.0.0.1:7998」「閾堕敪鎷凤細绯荤粺鍛婅」，带上就是「中文测试 已启动 http://127.0.0.1:7998」「银锭拷：系统告警」，npm 自己那两行 `> npmprobe@1.0.0 start:nobuild` 照旧正常。

## D379 商店审计的九条：名字撞车、冷门包搜不到、索引不可续、暴露方式那行文案（用户「下面的bug是否都存在：如果存在，直接修改」2026-11-22）

**问题。** 用户给了九条关于「隧道 / MCP 商店 / 扩展商店」的指控，要求核实并直接修。逐条核实后**五条不成立、四条成立**：

- 隧道默认 http2 —— 已不成立：`bridge/src/tunnel.ts:31` 的 `tunnelProtocol()` 早就默认 `"http2"`（D184 / #209）。
- 已安装标记用 name+transport 做包含判断 —— 已不成立：`web/src/app.ts` 的 `mcpInstalled` 是整词正则，`transport` 对远程项就是 URL（`bridge/src/extmgr.ts` 的 `transportOf`），尾斜杠也能命中。
- 每次搜索同步解析两遍 16MB 索引、前端每次输入发两遍请求（第 5 条）、扩展商店出错后不换关键词不重试（第 8 条）—— 已不成立：#308（`3bc81cc8`）的 `readIndexDisk` 按 mtime+size 缓存解析结果，前端的 `requestExtStore` / `requestMcpStore` 以 `${query}\u0000${limit}` 做在途去重。
- docker 选项丢掉用户填的 env —— 不成立：`mcpAddRequest` 只拼 `-e NAME`，值走 `base.env` 交给 docker CLI 进程；pi 的 `StdioTransport.start()` 用 `{...process.env, ...options.env}` 起容器，`docker run -e NAME` 正好从未经 argv 泄露的环境里取值（密钥因此不进 `ps`）。

成立的四条与它们的修法：

**① 服务名撞车。** `slug()` 把 `ac.inference.sh/mcp`、`ad.pantheon/mcp`… 都折成 `mcp`：真实索引 21,328 条里 987 个 slug 撞车、最大一组 2,240 个；而 `pi mcp add` 对同名只打一行 `Replaced` 就退出 0，于是第二个静默覆盖第一个。新的 `web/src/mcpstore.ts` 定三条规则：只保留 pi 认的 `[a-z0-9._-]`（点号折成 `-`，pi 的校验只放 `-`/`_`）；短名是泛称（`mcp`/`server`/`site`…）时借命名空间的最后一段（`ac.inference.sh` → `inference`）；与本机已装的撞名就加 `-2`…`-99`。撞车组从 2,240 降到 42，非法名从 3 降到 0。表单不再替用户默默改名：撞名给黄字「已有同名服务器（{p1}）：这一装会替换它的配置。」、按钮变「替换安装」并带 `overwrite: true`；空名或含 `[A-Za-z0-9_-]` 以外的字符都给红字并禁用（`checkName`）—— pi 的 `validateMcpServerConfig` 会直接拒（`invalid server name "…"`），放过去只是白失败一次。

同名分两档，表单与桥端都按「这次要写哪个 mcp.json」判：同档同名才是**替换**（黄字 + `overwrite`）；项目档同名而这次装全局，是**遮蔽** —— pi 解析时项目档盖住全局，装完也看不见，表单直接报错拦下；全局同名而这次装项目，是合法遮蔽，只给一句「项目档会盖住它」、正常安装。桥端 `mcp.install` 在 `writeLock` 里按 `mcpFilePath(local, cwd)` 算出目标文件：命中同一个文件且没有 `overwrite` 抛 `mcp_name_taken`；目标全局而命中项目档抛 `mcp_name_shadowed`；目标项目而命中全局时放行。绕开界面直接发帧也改不掉别人的配置。`fail()` 先前把 `errCode` 丢在了原地，这次一并透传（与同文件 `picli_public` 的写法一致）。

**② 冷门包搜不到。** `searchPackages` 只把 `keywords:pi-package <q>` 交给 npm、再按 popularity 权重取前 250 条，前端只在**这 250 条里**重排 —— 命中在 251 名之后的包永远不可见；用户说的「乱码查询搜不到」是同一件事：乱码不会命中任何关键词，于是列表空。改法两处：后端在「有查询词、且返回的结果里没有一个名字命中」时（零结果也算）再发一次不带 `keywords` 的 `text=<q>`（`store:loose:` 缓存 10 分钟，判据是 `needsLooseRecall`），只留 `keywords` 含 `pi-package` 的条目 —— 只在零结果时补仍然救不了「描述命中一堆、名字命中的一个在 251 名之后」；前端 `rankSearchResults` 改成五档 —— 名字精确 > 名字前缀 > 名字包含 > 描述/关键词命中 > 其余，**档内**才用用户选的排序（默认月下载量）。以前「描述里命中」和「完全无关」同档，于是一个月下载 40 万的包把名字里带查询词的冷门包压在底下。

**③ MCP 索引不可续、一页 4xx 全盘重来、starsComplete 误报。** 三件事在同一段代码里：`buildIndex` 从 `cursor=null` 走 300 页（分钟级），任何一页 4xx 直接抛出 → 60 秒冷却后**从第 0 页再来**；`fillStars` 只看 HTTP 状态和抛异常，于是 GraphQL 200 里的 `errors`、以及「仓库被删/改名/私有」返回的 `null` 节点全被当成「确认 0 星」，`starsComplete` 就说 true。改法：`walkIndex()` 把 (第 N 页之后的光标, 到第 N 页为止的条目) **一起**写进 `state/market/mcp-index.partial.json`（每 25 页一次；瞬态错误先落盘再抛），下次从断点续走，最多重走最近 25 页、不跳页；非 429/408 的 4xx 视为「注册表不给这页」，保留已抓的 200 页、以 `truncated: true` 收尾；`readStarsBatch()` 只把响应里真有 `stargazerCount` 的算作已知，`errors` 非空或节点为 `null` 都让 `starsComplete = false`。断点超过 6 小时就丢掉（注册表早就变了）；断点文件在**索引写盘之后**才删 —— 先删再写的话，两步之间崩一次，下次又得从第 0 页走。

**④ 暴露方式那行文案（表单状态三处）。** 默认项写的是「deferred：模型用 searchTools 找」，可 pi 的默认是 `codemode`，照它选会**白降一档**；另外两处：切换「运行方式」会把用户已填的 env / header 值清空；密钥提示里的变量名（`${NAME}` / `${服务名_HEADER}`）只在渲染时算一次，改服务名后就不再对。

**决定。** 名字规则放前端也放桥端（界面是给人看的，桥端才是最后一道门）。表单里撞名不禁用按钮 —— 替换是合法操作，禁止它反而逼人去手改 mcp.json；只把「这一下会覆盖」说清楚。索引断点用 json 整块覆写而不是追加日志：每次 16MB 的写入只有 12 次，比维护一份 NDJSON 的解析路径便宜；代价是崩溃时最多重走 25 页。

**验证。** 新增 `web/tests/mcpstore-unit.mjs`（11 项：短名 / 泛称借命名空间 / 只用合法字符 / 空名退回 / `freeName` / `nameKey` / 同档撞名与遮蔽两档 / 非法字符拦下 / `secretVarName` 与桥端同规则且去首尾下划线）、`bridge/tests/extmgr-names-unit.mjs`（6 项：`-`/`_` 等价、项目档也算、前缀相近不算撞、`mcpFilePath` 的全局/项目落点）、`bridge/tests/market-unit.mjs`（8 项：`pageRefused` 的 4xx/429 分界、`readStarsBatch` 的 errors/null/非 JSON、`walkToResume` 的 schema/过期/半写文件、`walkIndex` 三张连续页在第二页 5xx 后**从断点续走且不重取前两页**、4xx 页保留已抓部分、断点里的旧版本被新版本覆盖、`needsLooseRecall` 的名字命中/描述命中/CJK）；`web/tests/pluginmarket-unit.mjs` 加 3 项（冷门但名字命中的排在热门描述命中之前、描述档单列、档内尊重排序）。`npm run typecheck` 全绿；`npm run test:mcpstore / test:extmgr-names / test:market / test:pluginmarket / test:mcpmarket` 全绿。

**没进单测的。** 真索引 21,328 条的撞名统计（987 个重复 slug、最大一组 2,240 → 42）是本地拿 `state/…/mcp-index.json` 手工跑的，没进仓库夹具：那个文件 16 MB，放在测试里每次解析一遍不划算。`pi mcp add` 撞名只打 `Replaced`、名字只允许 `[A-Za-z0-9_-]`（`validateMcpServerConfig` 直接拒非法名）、项目档按名字替换全局档 —— 这三条都在 pi 自己的文档 / 源码里，落在 `docs/pi-integration-facts.md` §10 第 17-19 条。

**代价 / 可改。** `walkIndex` 的圈复杂度 21（`run-tests` 的 lens 会提示），换来的是三种失败路径写在一处；断点每 25 页一次是「重走量」与「写入量」的折中，可以调 `INDEX_CHECKPOINT`。`fillStars` 里查不到星的条目仍是 `stars: 0`（排序与界面都在做算术），诚实性交给 `starsComplete` 标志——**没做**：把未查到的改成 `null` 并让排序把 null 排最后（要动 `StoreMcp` 类型与前端两处渲染）。
## D380 Excel 的「显示几位小数」在十进制位上算：不用 `toFixed`，也不做相对补偿（2026-11-22）

**问题。** 数字格式与 `ROUND`/`FIXED`/`RATE` 都用 `abs + abs*1e-12` 去补二进制误差，而它是**相对**补偿：值越大补得越多。`1e12` 按 `0` 显示成 `1000000000001`，`123456789012345` → `…468`，`ROUND(12345678901234.5,0)` → `…247`，`1/3` 取 15 位小数 → `0.333333333333667`。`toFixed` 也不能直接用：它按二进制值截断，`1.005` 变成 `1.00`。`ROUNDUP`/`ROUNDDOWN` 又只对 `x * 10^d` 取 `ceil`/`floor`，负数方向反（`ROUNDUP(-2.1,0) = -2`），`ROUNDUP(2.67,2)` 还会被 `267.00000000000006` 抬成 `2.68`。

**决定。** 新增 `bridge/src/sheet/decimal.ts`：先把值写成 `Number#toExponential()` 的「有效数字 × 10^指数」，再按目标位数用 BigInt 取整（half-up / 朝 0 / 远离 0），最后拼回十进制串。数字格式、`ROUND`、`FIXED`/`RATE` 共用一个实现，方向按**绝对值**定。有效数字先截到 15 位（`SIG`），跟 Excel 的存储精度一致。

**为什么是 15 位。** Excel 单元格只存 15 位有效数字，`0.1+0.2` 在它那里就是 `0.3`。截到 15 位顺带把 `1.005`、`2.675` 这类「十进制下刚好落在 .xx5、二进制下差一点」的值拉回十进制直觉，不用为它们单独写特例。

**代价 / 可改。** 每个带格式的单元格多一次 `toExponential` + BigInt 运算（都是短串，`test:sheet` 仍是毫秒级）。位数离谱的输入要挡：`roundDecimal` 对 `d > 15` 原样返回（15 位之外没有可舍的位），`d < -308` 返回 0，避免 `10n ** BigInt(1e9)` 这种爆炸。`-0` 统一收成 `0`：值舍到 0 之后不再留负号（`-0.4` 按 `0` 显示为 `0`）。

## D381 退役「测试书」技能 `/pi-web-test-html`：验收统一走 `pi-web-e2e-test`（用户「需要删除本项目的 skill: /pi-web-test-html . 这个已经过时」2026-11-22）

**问题。** D247 那套测试书流水线（截图书 → xlsx 一 case 一 sheet → 复刻 Excel 的单文件 HTML）只用过 workclock 一本书：`cases/workclock.mjs` 把分区序号、按钮文案、接口路径写死，`build-xlsx.py` 的结论段与复跑步骤一度也是照那本书硬编码（#421 才改成 spec 驱动，至今未合）。换模块等于重写一遍用例，出的还是一份人要自己对着读的表；与此同时 e2e 技能已经能录像 + 红框/字幕/旁白 + 改前改后对照，两条验收路径并存只会让人挑错。

**决定。** 删除 `.pi/skills/pi-web-test-html/`（9 个文件）与命令 `.pi/prompts/pi-web-test-html.md`；README 三语里的「测试书」小节、`GLOSSARY.md` 的「测试书」词条、`pi-web-e2e-test/SKILL.md` 末尾那段「与 pi-web-test-html 的区别」一并删掉。D247 保留为历史记录，不再指向现有文件。

**为什么整条删、不留 `disabled`。** 技能、命令、文档是三处指引同一件事：留一个空目录或留着 `/pi-web-test-html` 命令，下次会话还会读到它、还会照它起环境跑脚本；`disable-model-invocation` 只挡自动触发，挡不住人照着 README 敲。

**代价 / 可改。**

- 未合并的 testbook 分支（`feat/testbook-video` / PR #421、`feat/testbook-catalog`）随之作废；要再合会撞 delete/modify 冲突，需先把用例重写成 e2e 技能的形式。
- 截图 + xlsx 这种「一 case 一 sheet、能拷走的验收表」没有替代品；真需要时按 e2e 技能的 `finalize` 输出改一份，而不是恢复旧流水线。
- 历史产物 `.scratch/testbook/`（workclock / translate-sync 两本书）仍在主检出里，不进版本库，也没被这次删除动到。
## D382 目录与分支合成一颗入口：`仓库名/子目录 ⎇ •`，单击恒开窗（用户「a 情况下目录和分支都显示太占空间；b 情况没有分支表示，用户也不知道能点」2026-11-22）

**问题。** 状态行原来有两套形态：cwd 在 git 仓库里时是「路径 chip + `⎇ main · 3`」两颗并排，占掉输入框下方大半行；cwd 不是仓库、但下面有 git 子目录时只剩一颗路径 chip，没有任何「可以点」或「这里有分支」的标记。窄屏还把路径 chip 整个藏掉（D263 留下的入口不可达）。

**决定。** A/B 统一成一颗扁平入口（样张 E）：

- 仓库内：`仓库名/相对子目录` + `⎇`，未提交时再一个 5px 圆点；**不写分支名、不写 dirty 数**。cwd 就是仓库根时只写仓库名。
- 非仓库：路径最后一段 + `›`，不探测子仓库。
- 单击恒为开窗：仓库内开「分支操作工作台」，非仓库开「目录与仓库」；不再兼复制。复制路径搬进两扇窗的标题栏（BranchSheet 新增一颗，ReposSheet 原本就有）。
- 完整路径、分支名、dirty 数、detached / empty 说明、Enter/Shift+Enter/粘贴截图提示全部放进 chip 的 `title`。
- 运行中只留这一颗：原尾部扁平 `⎇` 删除，忙态行 = chip + 转圈 + 活动 + 计时 + 中断，窄了先截断活动文本。
- 窄屏也显示入口，只把 `.cwd-sub` 藏掉（修 D263 的「入口不可达」）；桌面与窄屏都不再出现第二颗分支 chip。

**为什么。** 一颗入口同时回答「现在在哪」与「这里有没有 git」，A/B 两种目录形状看起来一致；分支名是长尾信息，悬停和窗里都有，不值得常驻一整段。若只留目录 + `⎇`（样张更窄），用户仍然不知道当前分支；若保留完整分支名，空间问题原样复发。

**代价 / 可改。** 同级多分支（`feat/a` 与 `feat/b`）在行内都只显示 `feat` 首段，要靠悬停或开窗分辨；窄屏藏掉子目录后同名仓库会重名；非仓库只显示末段，跨目录同名也要靠悬停。BranchSheet 标题栏多一颗按钮，窄版 embedded 时不重复加。**没做**：伞形目录的懒探测、点击 chip 直接切分支、分支名首段做成可配置。

**验证。** `probes/round15-git.mjs`：仓库内 chip 不含分支名/数字、title 含路径/分支/脏数/快捷键，点击开 BranchSheet 且标题栏有「复制分支名」「复制路径」，忙态仍只有一颗 chip 且排第一；非仓库 `not-a-repo ›` 点击开 ReposSheet。`probes/round21-cwd-line.mjs`：桌面 `alpha/web`、收起左栏仍在、点开窗复制路径、非仓库 `beta ›`、760px 入口仍在且 `.cwd-sub` 为 `display:none`、回到桌面恢复。两条探针均 ALL OK；`npm --prefix web run typecheck` 通过；真机截图见 `.scratch/cwd-branch-chip/ui-*.png`。D235 / D237 的「按 cwd 分叉两扇窗」不变；D244 的「左栏收起也显示」保留，D263 的「窄屏藏入口」被本条推翻。
## D383 一个技能一个入口：删掉 `pi-web-e2e-test` 的同名 `/` 命令（用户「做的时候，我只要求做一个skill。现在为啥会出现2份」2026-11-22）

**问题。** `41f1cb66` 把 `.pi/skills/pi-web-e2e-test/SKILL.md` 和 `.pi/prompts/pi-web-e2e-test.md` 一起提交了：命令补全里因此出现「模板 / 技能」两条同名条目，用户只要了一个技能，看到两份来问「为啥会出现2份」。模板是照 D196（`/whatsnew-write`）、D247（`/pi-web-test-html`）的形状写的薄外壳：14 行，指向 `SKILL.md` 并复述边界（bug 模式不改代码、信息不足先 `ask_user_question`、产物写 `.scratch/e2e/`、报告生成后单独问要不要 `open_preview`）。这些边界 `SKILL.md` 第 11 / 42 / 14 / 96 行本来就有，模板实际只多两件事：补全里的 `argument-hint`，和用 `$@` 把命令行后面的话拼进正文。

**决定。** 删 `.pi/prompts/pi-web-e2e-test.md`，README 的 e2e 小节改成 `/skill:pi-web-e2e-test`（标题 + 两条示例 + 说明段）。以后**新增技能不再顺手配同名模板命令**；确实需要人类友好的短命令时先问用户，别默认加。

**为什么。** 两个入口走同一份流程，多的那个只会让人在补全里挑错、让维护者在两处改同一句话；并且模板那条路要多一轮 `read`，还依赖模型照做「第一步先读完 SKILL.md」，技能入口把正文直接加载进来，不依赖模型守规矩。`/whatsnew-write` 仍保留「模板 + 技能」（D196）：它的模板承担的是「只改 `CHANGELOG.md`、没有新提交别开 PR、开完 PR 停」这类跨会话的操作纪律，和 e2e 的纯复述不是一回事。

**代价 / 可改。** 敲 `/pi-web-e2e-test` 不再有补全项，要打全 `/skill:pi-web-e2e-test`；补充要求照样能跟（`/skill:name` 后面的字作为用户请求追加到已加载指令后）。想恢复短命令就照 D196 的形状再加一个模板，但要先确认它带来的是 SKILL.md 里没有的边界。

**验证。** `git ls-files .pi/prompts` 只剩 `whatsnew-write.md`；`grep -n "/pi-web-e2e-test " README.md` 无输出（说明段里只剩 `.pi/skills/pi-web-e2e-test/` 这种路径）；技能本身没改，`node .pi/skills/pi-web-e2e-test/bin/e2e.mjs --help` 照常打印用法。

## D384 邮箱面板的外壳只建一次，`render()` 只换内容（用户「点击邮箱按钮，会连续弹出3次dialog」2026-11-22）

**问题。** `MailPanel.render()` 每次都 `new .mc-back` + `new .mc-console`，`this.root?.remove()` 再 `mountOverlay()` 挂新的；而一次 `open()` 会 render 三次（`open()` 自己一次、`mailConfig()` 回来一次、`loadFolders()` 置 `listLoading` 一次）。mac 材质给这两层挂的 `mac-fade-in 260ms` / `mac-window-in 460ms` 就跟着演三遍 —— 用户看到「点一下，面板闪三下」。重挂还顺带把正文滚动位置与输入焦点打回原点，并让每次重画都多一次全屏 `backdrop-filter` 重绘。

**决定。** 外壳（`.mc-back` + `.mc-console`）在 `open()` 里由新的 `mountShell()` 建一次并 `mountOverlay()`；`render()` 改为 `this.shell.replaceChildren(headEl(), bannerEl(), mainEl(), footEl())`，`close()` 把 `shell` 一起置空。重画不再碰外壳节点，入场动画只在真正开场时演一次。

**为什么。** 另一条路是照 `retireSheet()` 的做法给重画的新节点加 `mac-instant`（`mac.css:410` 已有规则），一行就能消掉重影；但节点仍然每次重建，滚动与焦点照丢，而且旧代码里 `render()` 末尾无条件 `mountOverlay()`，关闭后迟到的请求回来会把面板**重新挂出来** —— 这个副作用顺带被 `if (!this.shell) return` 堵掉了，`mac-instant` 路线堵不到。

**代价 / 可改。** 外壳自身的属性（`aria-label`）不再随重建刷新，改为在 `render()` 里重设；以后若想让某次重画**重演**入场，得显式加类触发，不能靠重建。`List` 与 `main` 仍是每次新建，滚动容器 `.mc-main` 原地重置到顶部，切分区的手感不变。

**验证。** `probes/mail-panel-single-mount.mjs`：改前一次点击挂载 3 次、带 `mac-window-in` 3 次、切分区累计 4 次（4 条全红）；改后 1 / 1 / 1，切分区不重挂、Esc 后不复活、`关闭前后没有新的挂载`（5 条全绿）。`npm --prefix web run typecheck` 通过；截屏 `.scratch/mail-single-mount/shots/panel-open.png`。

## D385 输入框的玻璃胶囊只长在 `.composer-input` 上，textarea 保持透明无框（用户「如图chat框内容很奇怪 / 边框边缘有三层」2026-11-22）

**问题。** `mac.css` 的 `html[data-ui="mac"] .composer textarea` 把整套胶囊画在 textarea 自己身上：`background: var(--mac-glass-strong)`、`border: 0.5px solid var(--mac-glass-line)`、`border-radius: 18px`、`box-shadow: var(--mac-shadow-panel)`，`:focus` 再叠一道 accent 边框与 `0 0 0 4px` 光晕。但 #317 之后 textarea 住进了 `.composer-input` 这个 wrapper（`styles.css:3026`：面板、1px 描边、焦点环、12px 圆角都在它身上，textarea 是透明无框的薄片），于是同一个框画了两套：外圈 1px accent / 12px 圆角，内圈 accent 55% / 18px 圆角，再加 textarea 自己的 4px 光晕与 `0 0 0 0.5px` 暗描边 —— 用户看到「边框边缘有三层」，两个半径还在四角互相错位。同一套规则还误伤了 `.composer textarea.paste-body`（优先级 0,2,2 压过 0,2,1），粘贴折叠块也被画成玻璃胶囊，内边距从 8px 变成 12/16px。

**决定。** 把 `mac.css` 那两条规则的选择器从 `.composer textarea` / `.composer textarea:focus` 改为 `.composer .composer-input` / `.composer .composer-input:focus-within`：底色、backdrop、描边颜色、18px 圆角、面板阴影、焦点光晕与 transition 全部落在 wrapper 上，边框宽度沿用 `styles.css` 的 1px（只换颜色成 `--mac-glass-line`，焦点时换 accent 55%）。textarea 只保留 `padding: 12px 16px`，且写成 `.composer .composer-input > textarea`，折叠块的 `8px 8px` 回到自己身上。

**为什么。** #317 的 mask（顶部 24px 文字淡出）只作用在 textarea 上，mask 带的是「整块元素绘制的 alpha」—— 任何画在 textarea 上的背景与边框都会被一起淡出，这正是当初把面板搬到 wrapper 的原因。所以不能反过来「把 wrapper 的背景撤掉、让 textarea 当面板」：滚动到中段时整个框会跟着渐隐。修法是让 mac 主题服从这条已经成立的宿主划分，而不是第二次把它画回去。

**代价 / 可改。** 三处可见变化，都是有意的：①mac 主题下描边宽度是 1px（`--line` → `--mac-glass-line`），不再是 0.5px hairline；玻璃质感靠 backdrop-filter 与面板阴影维持。若以后想让胶囊更细，把 wrapper 的 `border-width` 一起改，别再拆成两层。②外层圆角从 `styles.css` 的 12px 变成 mac 面的 18px（原本画在 textarea 上也是 18px，只是那时它套在 12px 里）；展开的粘贴折叠块（`styles.css:3034-3036` 按 12px 弧排的 8px 内缩与 8px 圆角）会不会出角，由探针 `17-paste-*.png` 一起截。③`:focus` 改成 `:focus-within`，焦点落进折叠块的 `.paste-body` 时整颗胶囊也亮光晕与 accent 描边 —— 语义上是对的（面板内的任何焦点都算这张面），但比原来只在主输入框聚焦时亮要宽一拍。`html[data-ui="mac"] .composer { background: transparent; border-top: 0 }` 原样保留。

**验证。** `probes/composer-grow.mjs` 新增第 17 段（mac-dark / mac-light 各跑一次）：两条边框里只有一条可见、textarea 的 border 与 radius 都是 0、焦点光晕只在 wrapper 上、textarea 背景透明而 wrapper 不是；展开一个粘贴折叠块，断言它仍是自己的 `8px 8px` 内边距、0 圆角与 1px 上 hairline（被误画时会变成 12/16px、18px、0.5px）；最后在「未聚焦的空输入框」上再断一次。四组截图：`17-capsule-*.png` / `17-paste-*.png` / `17-idle-*.png`。改前同一探针第 9 段先红（`no transition on the fade`，`0.3s, 0.16s` 来自被误画的 textarea transition；`inputBg` / `inputBorder` 也红）；改后 1–17 段全绿、`ALL OK`。探针同时补了一处既有红：`getBoundingClientRect` 在 `DEFAULT_SCALE = 1.25`（`app.ts:21188`）下返回的是缩放后的尺寸，而期望值全是布局 px，故开头把 `pi.prefs.scale` 钉到 1 再继续。`npm --prefix web run typecheck` 通过。`npm run test:composer-focus:ui` 仍红（新会话 sheet 的「新文件夹名」不可见），在未改动的 `mac.css` 上同样红，属既有失败。

## D386 打开一条**已归档**的会话 = 请它回来（取消归档 + 置顶到最前）（D146 的唯一例外；用户「打开已经归档的回话，现在会显示在 chat 框中，但是上面的所属回话，是一个已经其他的回话名……应该自动取消归档，并且自动置顶，这样就能导航到正确的工作区，回话名也正常」2026-11-22）

**问题。** 在「会话管理 → 状态=已归档 → 打开」打开一条归档回话，正文是对的，但画出的是别人的身份：顶栏那一行（★ 本区行）还是打开前那颗的名字，当前会话胶囊被整颗藏掉，这条会话也仍旧躺在「已归档」里、左栏回不到所属工作区。三处各有各的原因，叠在一起就是用户看到的样子：

- `openSession()`（`web/src/app.ts:1757`）只切视图（`switchDraft → currentId → setSelectedWs(null) → subscribe → renderAll()`），从不回写归档/置顶；`openFromList()`（管理面板「打开」与左栏卡片都走它）也只是改 hash 再调它。
- 桥一侧同样没有：`bridge/src/manage.ts` 的注释写明 **D146 废止了 D125「打开即置顶」**，`bridge/src/index.ts` 收到 `action:"opened"` 只回一份快照、什么都不写；而 `setArchived(on=true)` 又会把它从 `pin` 里摘掉 —— 归档一条会话等于把它从两个可见位置同时抹掉。
- 归属是现算的：`renderSessionRow()` 里 `setNowChipHidden(… || currentArchived())` 藏掉胶囊，`starredRow()` 把 `archived` 整个过滤掉，`web/src/tree.ts` 的 `buildTree()` 又 `continue` 掉归档会话。当前会话一旦在归档里，顶栏只剩别颗的名字（「上面写着别人的回话名」），左栏也放不回它的组。

**决定。** 只给「打开一条**已归档**的会话」开口子，D146 照旧管其它一切：

- 桥：`Manage.revive(id)` 在**一个** `state.update` 里取消归档、把它插到 `pin[0]`、从 `order` 摘掉；非归档会话调用是空操作。WS 动作名 `manage.action = "revive"`（`bridge/src/index.ts`，紧挨 `opened`），写完照常广播 `manage + workspace` 快照。
- 页面：`openSession()` 里 `if (this.manage.archived.includes(id)) this.reviveArchived(id)`，`reviveArchived()` 先**乐观**改本地 `manage`（从 `archived` 删、插 `pin` 首位、摘 `order`）再发 `{type:"manage", action:"revive", id}`；桥的快照回来再抹一次。两个入口都要盖到：`openSession()` 原来的 `if (this.currentId === id) return;` 会在「它已经是当前会话、只是被别处归档了」时把请求吞掉，所以那条早退里也补了一次；刷新 `#/s/<归档 id>` 时 `routeFromHash()` 跑在 `manage` 快照之前（那时 `archived` 还是空壳），所以 `case "manage"` 收到快照时发现当前会话归档了，再补发一次（同一颗只补一次，不认这个动作的旧桥不会来回刷）。

**为什么。** 三处现象是同一个「它既不在 pin 也不在归档之外」造成的，所以修在一个动作上，而不是分别去补胶囊/★ 行/tree 的兜底。`revive` 必须原子：分两步（先取消归档、再置顶）会露出「已取消归档但 ★ 行里还没有它」的中间态，顶栏那一瞬间仍然算不出归属。乐观更新同样是为了这个中间态 —— 等桥往返才改的话，画面上会先闪一帧「打开了、上面写着别人」，而这正是用户报的那个现象。只对归档会话生效，是为了不让 D146 重新变成「每开一个会话就重排一次 ★ 行」：普通会话的打开仍然什么都不改。

**代价 / 可改。** 打开归档会话会**改用户手工排的 ★ 顺序**（插到最前）—— 这是用户要的，但它确实推翻了 D146 的两句：标题里的「打开 ≠ 解归档」，以及它那条「**归档会话可以打开**，但它仍然在归档里；要出来得自己点「恢复」」（`docs/DECISIONS.md:2029`）—— 现在点开就是「恢复」。D146 的其余部分（普通会话打开不改排列、组内顺序是人手工拖的）原样生效，所以这是**唯一**的例外，不是把 D125 整体复活：D125 的「打开 = 置顶」对非归档会话仍然不成立。想改成「追加到末尾」只需改 `revive()` 里那一行拼接。带 `#/s/<id>` 的旧书签/外链指向一颗归档会话时，打开（含刷新后 `routeFromHash()` 那一次）即解除归档（不再静默打开）。**没做**：把「打开过的排在 ★ 行前面」推广成通用规则；也没做「归档时记住原位置、恢复时插回原处」，插到最前就够了。

**验证。** `.pi/skills/pi-web-e2e-test` 的 change 模式（同一份 case 跑改前/改后）：改前 3 条红 —— ★ 行里没有刚打开的那颗、★ 行只剩原来那颗、打开后它仍在「已归档」；改后全绿，顶栏与 ★ 行都写对了名字。`npm run typecheck`（bridge + peer + web，含 i18n 与 viewport 守卫）通过；`npm run test:nowchip` / `test:wsmanage` / `test:ws-row` 通过。

## D387 子进程一律 `windowsHide: true`：没有控制台的父进程 spawn 控制台程序会弹出真窗口（用户「[pi-web-e2e-test] 会启动启动很多控制台弹窗，会干扰用户，比如用户正在输入，弹出控制台，输入被打断了」2026-11-22）

**问题。** 跑 `pi-web-e2e-test` 时，屏幕上会冒出一串控制台窗口（Windows Terminal 里标题是 `git.exe` / `npm root`），正在打字的人被打断。根因不是「谁忘了关窗口」这么随意：本地 bridge 与测试环境的桥都是 `detached + windowsHide` 拉起的，也就是**根本没有控制台**的进程（`DETACHED_PROCESS`）。这种进程再 spawn 一个控制台程序（git / npm / taskkill / powershell）时，若参数里没有 `windowsHide: true`，Windows 会为它新建一个真控制台、按默认终端显示并抢焦点。**「父进程自己有没有窗口」不是判据，「父进程有没有控制台」才是** —— 于是从带伪控制台的终端（比如 agent 的 bash 工具链）里测，一个窗口都不会出现，症状只在桥、后台 worker、定时任务里复现。

**决定。** 会被「没有控制台的进程」拉起来的树（`bridge/src`、`bridge/ext`、`peer/src`、`scripts`、`tools`、`.pi/skills`）里，所有 `spawn` / `spawnSync` / `exec` / `execFile` / `execFileSync` / `fork` 调用都带 `windowsHide: true`，`shell: true` 的分支同样要带（宿主进程是 `cmd.exe` 时它自己也带控制台，一样弹）。唯一例外是「弹出的窗口就是功能本身」：`bridge/src/terminal.ts:286`（打开文件管理器）与 `:319`（用本机程序打开文件）—— 这两处保留 `windowsHide: false`，并在调用行或上面两行写 `spawn-visible-ok: <理由>`。守卫 `tools/check-spawn-hidden.mjs` 已挂进 `npm run typecheck` 与 `npm run test:spawn-hidden`。

**不在守卫范围里的树。** `bridge/tests`（实测 141 处没写）与 `probes`（57 处）不扫：这两处都由终端直接跑，父进程有控制台，缺这个开关不会弹窗；一次改两百多处的噪音会淹没真正的回归。要查就显式传路径：`node tools/check-spawn-hidden.mjs bridge/tests`。反过来，`bridge/ext` 是编进桥进程的（`tsconfig.ext.json`），必须扫。

**为什么用守卫而不是靠自觉。** 这条规则的失效模式是「某天新加了一个 `execFileSync("git", …)`」，代码审查时完全看不出来错（在带控制台的终端里试也是好的），只有用户那边被打断才暴露。所以判据必须能在 CI / typecheck 里当场红。守卫按文件解析 `child_process` 的 import 名单（含命名空间别名、`require` 解构），只认真实引用的调用方；取实参用「从 `(` 扫到配对 `)`、跳过字符串与注释」的方式，因此多行 options 与注释里的 `windowsHide` 都不会骗过它。

**代价 / 可改。** ①父进程是 `detached + windowsHide` 时，它自己也**没有控制台**，`execFileSync(..., { stdio: "inherit" })` 拿到的是空管道而不是终端 —— 本来也没有终端可用，后续依赖 `isTTY` 的分支会走非交互路径，这是既有行为，不是本次引入的。②真正需要把窗口给人看的脚本（比如 `scripts/hotdeploy.mjs` 里 `Start-Process powershell` 另起一个可见窗口那条分支）不受影响：它压根不走 `windowsHide`，可见性由 `Start-Process` 决定。③守卫按「同一行 / 上面两行内有 `spawn-visible-ok:`」认标记；想给整段豁免就在循环外标注，别在调用的上一行再塞别的东西（中间隔一行就认不到了）。

**验证。** `node tools/check-spawn-hidden.mjs` 改前 42 个文件里报 31 处（`bridge/src/pi.ts:95` 的 `npm root -g`、`bridge/src/hotdeploy.ts:108/407` 的 git 与 worktree-remove、`scripts/hotdeploy.mjs:257/465` 的起桥与 build、`.pi/skills/pi-web-client-test-dev/bin/env.mjs` 9 处、`.pi/skills/bridge-update/bin/restart.mjs` 4 处等），改后 0 处；范围加上 `bridge/ext` 与别名/options 识别后是 43 个文件 0 处；`node tools/check-spawn-hidden.mjs --self-test` 的夹具里 4 条反例（漏写、`windowsHide: false`、`promisify(execFile)` 别名、options 常量写 false）全红，4 条正例（inline、`spawn-visible-ok` 标记、options 常量、`RegExp.exec`）全绿；守卫还有 `MIN_FILES = 30` 下限与「路径不存在即红」，免得目录改名后静默变绿。`npm run typecheck`（含新接的守卫）通过，`npm run test:spawn-hidden` 通过。机制实测（`.scratch/popup-probe/leak2.mjs`，父进程 = `detached + windowsHide` 拉起、真的没有控制台）：旧写法 `spawn(node)` 与 `spawnSync("npm",["root","-g"],{shell:true})` 各自让可见窗口数从 31 涨到 34（新增标题正是 `node.exe` / `npm root` 那一类），同样两条换上 `windowsHide: true` 后新增为 0 —— 证明这个开关就是修法本身。**没做到的**：没能把「改后的 31 处逐一从无控制台父进程跑一遍并数出 0」做成可复现的探针 —— 外部按「新增标题」采样会被机器上常驻的旧桥（还没更新到这份代码）自己弹的 `git.exe` / `npm root` 污染（`noop` 基线轮也能数到它们），而改成在子进程内部数窗口时，对照组也数不到（`ping` 存活 1.5 秒仍报 0，原因未查清），所以覆盖度靠静态守卫保证，不靠这一次窗口计数。

## D388 同一份文件再「打开」一次是幂等的：只抬面板，不重建（用户报障 2026-11-22）

**症状。** 问卷里点「在预览里打开」，预览开了，紧接着又开了一次，画面闪一下（iframe 白一下 / 表格浮窗闪一下）。

**根因。** 同一次「打开」被两条路各调一遍 `openPreview`：问卷按钮的即时打开（D344）先开；模型拿到答案后照交付提示词再调 `open_preview` → `bridge/ext/open-preview.ts` → `POST /api/preview/open` → 桥发 `preview.open` → `answerPreviewOpen()` → 再开一次。第二次**不是**原地刷新：`openPreview` 无条件 `v.info = null; v.text = null; v.pane = "preview"` 再 `paintViewer()`（`body.replaceChildren()` + 「正在打开…」），而 `/api/preview` 每次都签发新 token，回来的 iframe `src` 就变了 → 重建、重载；xlsx / slides 更狠，`closeViewer()` + `openSheet()`，浮窗整个销毁重开。`pushStep` 只去重历史栈，不阻止渲染。

**决定。**
- `openPreview` 拆成薄壳 + `openPreviewNow`。薄壳按 `sessionId + normPath(path)` 记住正在打开的那一趟（`previewOpens`），同路径的重复投递直接复用同一个 promise —— 否则两个响应各自 `paintViewer()` 仍然闪。键必须归一：题干里的路径是模型写的（多为 `/`），桥回来的 `info.abs` 是 Windows 原生 `\`，不归一就合并不上。`replace === true`（⟳ / 返回前进）不进这张表，它要的是重新读一遍。
- `alreadySeen()` 在未保存询问 / `rememberScroll` / `pushStep` / `ensureViewer` **之前**判定：同 sessionId、`samePath()`、面板在 `preview` 态（`browse` 目录页不算、`error` 允许重试）、内容未变（静默 `api.preview()` 比对 `mtime` / `size`）→ `raiseWindow()` 后 `return true`。`replace === true`（⟳ 刷新、返回/前进）一律绕过。
- 编辑态有未保存草稿（D50）：同路径再打开只抬窗口，切回预览交给用户自己点。
- 表格 / 幻灯片 / CSV 浮窗按**对象**记自己那份 `PreviewInfo`（`dockFiles` WeakMap）：两扇浮窗可以并存（`openSheet` 只拆自己那扇），单槽会抬错窗；浮窗内保存 / 改结构后回写 `mtime` / `size`（`saveSheet` / `saveStruct`），否则下次同路径投递会被当成「别的内容」整扇重开。
- 为什么不改成「让模型别调第二次」：模型不知道前端已经开过，照交付提示词再调一次是合理的；幂等放在唯一入口更稳。

**代价 / 可改。** ①命中时要多一次静默 `/api/preview` 来核对 `mtime` / `size`（换回一个不重建的 iframe）；它签发的新 token 落在 500 个的 LRU 里，只有连开 500 份不同文件才会把正在看的那份挤掉 —— 本会话正常用法碰不到。**没做**：换文件时的 stale-while-revalidate（先留着旧内容不白屏）；xlsx 第一次打开仍会先建 viewer 再换浮窗（独立票，与「第二次」无关）。

**验证。** `probes/preview-reopen.mjs` 11 项全绿（同路径再投：`iframeRemoved / loading / bodyCleared / viewerRemoved` 全 0；`fs.appendFileSync` 改过内容后**并发**两趟再投 → 新 src 且只重载一次（`iframeRemoved: 1`），之后第三次又回到 0；xlsx 两次投递后同一个 `section.sd` 节点）。把 `web/src/app.ts` 的改动 `git stash` 掉重新 build，同一探针 8/11（红的 3 条正是症状：`iframeRemoved:1, loading:1, bodyCleared:2`，`section.sd` 被摘又加）。`npm run build:bridge`、`npm run build:web`、`npm --prefix web run typecheck` 通过。


## D388 帧的词表与帧表：两侧各 128 个 `msg.type` 进类型，9 个最要命的帧进一张表（feat/frame-vocab；用户选「先 9 个帧 / 一个 PR 全做完 / 就地改 + 返回重画清单 / 先记基线读数」2026-11-22）

**问题。** 桥与页面之间那条 WS 上没有帧的模型：`bridge/src/index.ts:2675` 的 `ws.on("message", …)` 里 `switch (msg.type)` 约 128 个臂，`web/src/app.ts` 的 `private onMessage(msg: any)` 里也是 128 个，入口签名是 `(msg: any) => void`（`web/src/ws.ts`）。`web/src/types.ts` 只有载荷类型、没有帧种类，桥从不 import 页面的类型，两边一致全靠注释互指（`bridge/src/extmgr.ts`「与 web/src/mcpstore.ts 的 nameKey 同规则」）。后果不是「丑」，是**页面帧处理是整个客户端最脏的地方却没人测**：20 多类帧既无单测也无探针断言，而手抄的重复（`execPlanRounds` 在 session 与 items 各算一遍、审批/问答四臂把同一串五连画抄 4 遍）和漏画只能等用户的「数字不对」暴露。D77 第 8 条删过 `shared/protocol.ts`（#32），理由是「没人 import 的旧协议草稿，`t:` 与实际 `type:` 对不上」——那次失败的不是「共享类型」这个主意，是「先画一张草稿、没人接线」。

**决定。** 帧的名字与这 9 个最要命的帧的载荷/构造器住进 `bridge/src/frames.ts`，页面侧 `web/src/frames.ts` 第一行 `export *` 转发，再用一张表实现「帧 → 改什么字段 + 重画什么」。

- **词表是叶子**：0 import，只有类型与字符串常量。它不能 import `bridge/src/index.ts`（末行 `main()` 会真的起服务）或 `web/src/app.ts`（头两行 import CSS，桥侧编不过）。
- **两个方向分开**：`ServerFrameType`（桥→页面 128 个）与 `ClientFrameType`（页面→桥 128 个）不合成一张扁表——有 9 个名字两个方向都有但载荷不同（presence / commands / manage / term.list / runtime.stats / ext.inventory / subagents.agents / market.list / mcp.store）。名字从两侧**现有的 switch 标签**生成，不是重新设计。
- **载荷只收窄 9 个**：usage / stats / copilot / ctxlog / pi.status / approval.add / approval.remove / ask.add / ask.remove，`TypedServerFrame` 是它们的联合；其余 119 帧不带载荷类型。
- **两侧 switch 只改判据**：`switch (msg.type as ServerFrameType)`（页面）与 `as ClientFrameType`（桥），128 个臂一行没动。写错的 case 标签当场 TS2678（实测两条：`Type '"nope.not.a.frame"' is not comparable to type 'ClientFrameType'.` 与 `Type '"typo.frame"' is not comparable to type 'ServerFrameType'.`）。
- **表在页面**：`applyFrame(view, frame, now)` 9 个 case，返回 `RedrawKey[]`（15 个键）；App 的 `redraw(k)` 一个 case 一句绘制；`FrameView` 是 App 必须实现的那一小块（23 字段 + 3 方法），因此只有一处 `this as unknown as FrameView`（注释指向守卫单测），没有为了过编译把 20 个字段改 public。
- **`copilotFromFrame` 搬进 `web/src/copilot.ts`**：它本来就是纯函数，搬过去两处调用点与桥侧共用同一份读法。
- **`FRAMES_CAP = "frames.v1"`** 与词表同住一个文件，进 hello 的 caps，页面按 `bridgeCaps` 认（与 `ws.create.dir` / `ws.resolve.dir` / `exec.child.subscribe` 同一套）。新旧错配沿用 `default: break` 静默跳过。

**为什么这层壳有深度、而直接拆 App 没有。** 删除测试：只删掉那两个联合，两侧 switch 的标签立刻回到裸字符串，下一次改名还是两端各改一遍、拼错靠人眼——复杂度散回 128×2 处，而不是集中到别处，所以这层壳不自欺。App（22 462 行、688 成员）反过来：删掉一个「框架」不成立的中间层，复杂度只会搬家。真正的接缝是「帧 → 视图模型」这条，它与 App 的 HTTP / WS / 绘制细节可以分开演进；**同一个形状的第二个实例是 `web/src/peer/main.ts`（4 139 行）**，等它也要这张表时再谈把表抽成不依赖 App 的形态。

**为什么不用 index signature 的「松袋子帧」。** 原设计是 `{ type: ServerFrameType | ClientFrameType } & Record<string, any>`，写的时候被 lint 拦下（`Record<K, any>` 不给调用方任何契约）。用 `unknown` 会逼着改 119 个未迁移臂里的几百处 `as`，而收益只有「字段名拼错也被抓」——这一片要抓的是**词表**（case 标签、命令名），那部分 `any` 抓不到、`unknown` 也不需要。于是改成「只在 switch 判据上铸型」，干净且不改任何臂。

**代价 / 可改。** ①`approval.add.approval`、`ask.add.ask`、`ask.add.tool` 的参数类型是 `unknown`：形状归页面（`ApprovalRequest` / `AskRequest` 住在 `web/src/types.ts`），复制一份只会多一处会分叉的定义。②`pi.status` 的 5 个无条件重画照原样保留，没有顺手收窄——这一片要的是「行为一字不差」，收窄留给下一次有读数可比对的时候。③`web` 目录里出现一条指向 `bridge/src/frames.ts` 的相对路径（`bridge/tsconfig.json` 的 `rootDir: "src"` 让它只能背自己的文件，没有 npm workspaces）。④页面 `switch` 里的 119 个未迁移臂仍是 `any`，名字拼错只能靠 TS2678 抓 case 标签这一层。

**验证。** `node --experimental-strip-types web/tests/frames-unit.mjs` 26 项全绿（9 帧的字段 / 重画清单 / 别的会话 / 缺省语义，加构造器键名漂移、`FrameView`↔`app.ts` 的 `private` 对齐、`RedrawKey`↔`redraw()` 覆盖三条守卫；后两条读源码断言，改一个名字就红）。`npm --prefix web run build`（含 i18n-check）与 `npm --prefix bridge run build` 通过。`.scratch/frame-vocab/baseline.txt` 的 6 条探针改后逐条比对：`pending-badge` 的 4 条 OK 与 ALL OK 一字不差，`round5-asklost` 的 `after reload the panel remembers: 2 marked option(s)` 一致，`copilot-panel-resubscribe` 8 条 ok 一致，`ask-preview` 仍 1/2 且仍卡在 `whatsnew-back` 浮层拦截，`copilot-on-subscribe` 仍因「7864 上现场没有带 copilot 用量的会话」未跑成（与基线同因，不参与判定）。`probes/rail-ask.mjs` 的「ghost 被新载入的两格吃掉」在**主检出**上 3 次里也只过 1 次，是既有的时机抖动，不是这次引入的。`web/src/app.ts` 22 462 → 22 376 行。

**下一步（没做）。** 剩下 119 帧逐步按同样形状（一个帧一族字段 + 一个重画键）搬进表；`pi.status` 的 5 个无条件重画可以按 `runSince` / `phase` 是否真的变了收窄。

## D389 提醒中心：页面在前台也叫得到，且与「通知」分家（grill 结论 2026-11-23）

**问题。** 桥端只有一个推送判据：`shouldNotify = () => notifier.enabled && !anyPresent()`（`bridge/src/index.ts:2498`）。`anyPresent()` 的定义是「有页面**可见且窗口有焦点**」（`bridge/src/presence.ts`）——所以**你正看着页面时，一条都不推**，这是 D91 为了不吵而定的。代价是：你在页面里、视线在中间，别的会话在等你审批/回答，页面上**没有任何信号**。唯一的跨会话痕迹是左栏会话卡片上那行「待确认 N」（`web/src/app.ts:217`），而左栏一收起（`◧`）就彻底看不见；右栏「需要你」只画**当前会话**的那几张卡。于是「它一直在等我，我以为它没在等我」这件事没有任何东西兜住 —— 而 `D120` 的看门狗**刻意不** abort 挂着审批/问卷的会话，所以一张审批可以挂一整夜。

**决定。**

1. **词分家。** 「通知」继续指越过屏幕的那个动作（Web Push / 微信，D24）；新的东西叫**提醒 / 提醒中心**（顶栏角标 + 清单）。写 issue、测试名、变量名时不要混。
2. **提醒中心是时间线，不是新的操作面。** 右栏「需要你」仍是「此刻谁在等我」的运算符，提醒中心记「这件事后来怎样了」。同一条事件在两处出现是正常的，因为它们答的不是同一个问题。清单**只负责跳转**，不复制审批/问答 UI。
3. **触发：只弹别的会话的「待确认」与「待回答」**（`sessions.on("approval")` / `sessions.on("ask")` 两条流）。当前会话的卡本来就在正文里，弹它等于双重提示 —— 但它**计入角标**（见第 4 条）。
4. **角标 = 全部在等的**，含当前会话；一张审批卡、一份问卷各算 1。否则会出现「角标 1 但清单里找不到那一条」。吐司与角标的分工：吐司只报**增量**（别的会话新的等待），角标报**全局真值**。
5. **形态：右上角吐司（自己消失）+ 常驻角标钉在 ★ 行（会话层）最右端 + 点角标开清单。** 原型（`proto/reminders`）把三种摆放都试了一遍：**顶栏**（那儿已经十颗按钮，多一颗会被淹）、**右侧抽屉**（吃掉 320px 正文）、**输入框上方的全宽面板**（读长文时盖住底部）—— 都不如「★ 行右端一颗角标 + 贴在它下面的小下拉」。清单**两种读法、一个切换**：默认按事件流水（最新在上、按天分组），表头切一下按会话分组（一张卡一个会话）；切换键是纯前端状态，不进桥。 点清单里一条 = 切到那个会话**并滚到那张卡**（审批要看命令原文才批得下去，不滚到卡等于白去）；当前会话的滚动位置、草稿、正文都留在原处，标签行/★ 行能把人带回来。
6. **节流：同一会话 30 秒内合成一条吐司。** 一个会话在循环要审批时会连着要十次，一条一次能把屏幕刷满。
7. **通用入口 `POST /api/notify`**（脚本 / 定时任务 / 构建）进来的算**非阻塞类**，进同一份清单、带类别标签；默认**不弹**吐司，只让角标涨。它没有「被处理」这个动作，所以**点一下就消**（= 已读）—— 不这么定的话角标会一直亮着。
8. **寿命**：「在等的 + 已处理的」都留着，7 天或 500 条封顶（按天分组，超了从最旧的丢）。已处理的条目可点，只跳会话、不滚到卡。
9. **「静音这个会话」**：该会话的提醒不弹、不计角标、**也不推**，但清单里仍在（灰着）。压推送这一条是为了与内网通现有的会话静音同一个语义（`PeerHost.pollThreads()` 的压制条件里静音本来就压推送）。
10. **开关**：设置 →「通知」页里新增「页面内提醒」一组 —— 一档总开关（关掉 = 不弹，**角标照常**）+ 一档「阻塞 / 其它」分类开关。关掉的是「打断」，不是「知情」。
11. **推送白名单不动**：审批 / 提问 / 内网通新消息照旧推（D4 / D299）；非阻塞类**不推**。这条是本决定里唯一「什么都没改」的部分，写下来是为了不让下一个人以为「提醒中心上了就不用推了」。
12. **桥重启 → 所有还「在等」的转「已失效」。** 桥一死，`pi --mode rpc` 子进程跟着死，那些审批卡本身已经不存在了，留着就是骗人。

**为什么。** ①真正的缺口不是「看不见审批卡」，是「不知道别的会话在等我」—— 所以要补的是**信号**，不是再造一个能批卡的界面；②审批 UI 复制一份到清单里，等于两套状态机、两套测试，窄屏下还会把当前会话挤没，收益（少点一次）抵不上；③吐司弹「别的会话」而不是所有会话，是因为弹当前会话那张卡等于在你已经看着的屏幕上再加一次提示，纯噪音；④角标含当前会话是为了让数字与清单永远对得上 —— 这条最容易在实现时被「只数别处」带偏；⑤非阻塞提醒「点一下就消」不是省事，是因为它没有别的消亡路径：构建失败不会有人去「处理」它；⑥静音既然叫静音，就不能只压页面内 —— 否则你静音了一个会话，半夜它照样推微信。

**代价 / 可改。** ①7 天 / 500 条 / 30 秒这三个数是我按默认值定的（`REMINDER_KEEP_DAYS` / `REMINDER_CAP` / `REMINDER_COALESCE_MS`），改起来都是改常量。②吐司挂进 `#app`（跟随字号缩放），所以**不许**写裸 `vh` / `vw`；`npm run test:viewport` 会红。③「已处理」的条目只在清单里灰着，不进聊天或左栏，不做跨设备已读（桥端是唯一真源，多个页面各自连 WS 拿同一份）。④静音与已读**不走 `requireStepUp()`**（低风险，跟 `notify.set` 那个总开关不同）。⑤`POST /api/notify` 的鉴权：页面用 cookie，脚本用 `state/notify-token`（首次启动生成、权限 600）走 `X-Notify-Token` —— 不想给脚本发 token 的话，删掉这条分支只留 cookie 也可以。

**没做。** 免打扰时段、按类别逐条白名单、微信单独关、清单里直接批/答、把非阻塞提醒也推出去、提醒中心与内网通的未读合并成一处。

**状态。** 词进了 `GLOSSARY.md`，实现拆在 `docs/PLAN-reminders.md`。形态与状态机各有一份一次性原型（分支 `proto/reminders`，`proto/reminders-ui/` 与 `proto/reminders-logic/`）：UI 选了「★ 行右端的角标 + 贴角标的小下拉 + 流水/分组切换」；状态机的四个归宿（waiting / handled / read / stale）跑过五个场景都成立，另带两条要盯的坑（`lastToastAt` 不能用时间戳当「没有记录」；`badge()` 与清单必须共用一个谓词）。代码未动。

## D390 Mac 材质改由挂载点打标记，手抄的四张名单退场（#644；用户「mac 主题优化」）

**问题。** 主界面的 Mac 材质写在 `mac.css` 里四张手抄的类名名单上（遮罩 12 个 / 窗口 13 / 菜单 18 / 吐司 5，合计 43 个类名、129 条规则），外加 `.mac-leaving > :is(...)` 一张退场名单。每加一个面板、每抄一套新控制台，都得记得回去补名字，而 CSS 不会报错：漏了就静默退回「深黑遮罩 + 纯色面板 + 没有入场」。已经复发两次 —— D352 是 Everything / Jira / 邮箱 / 笔记（那时把名单集中到 `mac.css` 一处，只解决了「散落」，没解决「要人记」），D389 的提醒中心又漏了四个。同一张名单还带来一个语义陷阱：`:is(.modal form)` 让整条选择器的特异性变成 `(0,2,2)`，`repos-sheet` 的窄屏复位写 `(0,2,1)` 会静默失效（D352 已经踩过一次）。

另外三个浮层挂在 `document.body` 上（`.note-handoff` 三处、`.peer-pick` 两处、横条标签的改名输入框），不在 `#app` 里，所以「外观 → 字号」调到 125% 以上时它们仍按 100% 渲染。

**决定。**

1. **材质由标记挑，不再由名单挑。** 新增 `markSurface(node, kind)`（`web/src/modal.ts`，与统一退场 `retireOverlay()` 同住）：浮层在**创建处**打上 `data-mac-surface`，`mac.css` 只认这个属性。
2. **材质级五档**：`window`（带遮罩的窗：`window` 的根是遮罩、直接子元素是面板）/ `menu` / `toast` / `dock`（贴边的窗：预览右栏、终端）/ `paper`（登记在案、故意不套材质：表格与幻灯片浮窗）。规格里写的是四档；`paper` 是落地时多出来的一档 —— 把「表格浮窗永远是纸」从一张豁免名单换成一个正经的取值，于是豁免表可以空着（见第 7 条）。入场是第二个维度 `data-mac-enter`：`drawer`（手机上非居中的 sheet）/ `side`（随手问那类右侧抽屉）/ `alert`（两三选项的小弹窗：缩放淡入）/ `none`（居中但不演，笔记面板用这档）。灯箱更暗的遮罩走 `data-mac-dim="dark"`。
3. **四张名单整块退场**：`mac.css` 里的遮罩组 / 窗口组 / 菜单组 / 吐司组与 `.mac-leaving > :is(...)` 全部删掉，换成 `[data-mac-surface="…"]` 与 `[data-mac-enter="…"]`。D352 记的那条特异性陷阱随之消失 —— 那个特异性本来就是名单给的。
4. **`overlaysOpen()` 不再另抄第四份名单**：判据改成 `[data-mac-surface]`（`paper` 也算开着，表格浮窗开着时同样不该往上叠）。
5. **补上六个漏面**：预览右栏 = `dock`（底保持不透明 `var(--bg)`、内侧 14px 圆角、头部玻璃、窗影）；提醒清单 = `menu`；提醒吐司 = `toast`（仍独立浮在右上角）；笔记工具条弹层与「交给 agent」= `menu`；横条标签改名输入框 = `paper`。
6. **挂 body 的三个浮层搬进 `#app`**（`.note-handoff` / `.peer-pick` / 改名输入框）。它们用 `getBoundingClientRect()` 量锚点、写 `style.left/top`，进 `#app` 后会吃一次 `zoom`，所以新增 `appZoom()`：量到的视觉 px 除一次缩放再写回。
7. **探针改成「按模板比」而不是「跟某一层比」**：`probes/mac-dialogs.mjs` 的每一行按它自己的 `data-mac-surface` 去比一张「材质级 → 玻璃 / 圆角 / 阴影 / 入场」的期望表（不再拿「产物」当对照组 —— 对照组本身也可能被改坏）；骨架自带标记；**新增全局扫描**：页面上任何可见、`fixed`/`absolute`、`z-index ≥ 40` 的块，要么带标记、要么有个带标记的祖先。**豁免表是空的**：`.pin-flyer`、改名输入框这些「不该套材质」的都走 `paper` 标记，所以没有「可以不遵守」的名单可腐烂。另加两段：三套主题各量一遍窗口材质（材质不跟主题走），以及字号 150% 下双击标签改名、量输入框宽度是否等于标签宽度（验 `appZoom()` 那一次除法）。
8. **内网通页面不动代码**：它的浮层材质本来就齐（`peer-mac.css` 有专门一段），这轮只跑回归。

**为什么是标记而不是「再抄一份更全的名单」。** 名单的核心问题不是漏了几个名字，是**谁负责记得**：它把「新面板长什么样」这件必须发生的事，变成一件可以忘记的事，而忘记的代价用户半年后才看到。标记把这件事挪到创建浮层的那一行 —— 就在写 `el("div", "xxx-pop")` 的旁边，代码评审一眼能看见；漏了则由探针的全局扫描兜住，CI 当场红。另一个收益是特异性：名单是「一堆类名塞进一个 `:is()`」，它的特异性由参数里最高的那个决定，改一处覆盖会踩到看不见的坑；按属性命中就只有一个属性选择器的权重。

**代价 / 可改。** ①`window` 的面板约定是**直接子元素**：新写的外壳如果外面多包一层，材质会落错地方 —— 探针的期望表会红，但要知道原因。②`app.ts` 里非居中的 `.sheet-back` 要显式写 `enter: "drawer"`（现在 10 处），不再靠 `:not(.center)` 推断；这是有意的：结构变了就该有人看一眼。③挂进 `#app` 的三个浮层要除 `appZoom()`，以后新增「按视口坐标摆放」的浮层都要走这一条。④`paper` 档意味着表格 / 幻灯片浮窗永远不跟深色主题，这是 D166 的既有取向，不是这次漏的。⑤探针的期望表是手写的常量：改材质就该改它，改不动就说明改错了地方。

**验证。** `node probes/mac-dialogs.mjs` 28 个外壳全绿（含新增的六面、抽屉 / 侧抽屉 / alert 三档入场、灯箱暗遮罩、`paper` 纸）；全局扫描在真开 Everything / 产物 / 笔记 / 设置四个面时都跑一遍，没有裸浮层。`npm --prefix web run typecheck`（tsc + i18n-check + viewport 守卫 + `theme-unit.mjs`）全绿，其中新增四条：CSS 里不许再有手抄外壳名单、材质级两侧一致、**每个创建点打的是这一面该有的材质级**（把 `remind-pop` 与 `remind-toast` 的档互换会当场红，删一行也会红）、`notesheet.ts` 不再往 body 上挂。真开的四个面仍是 Everything / 产物 / 笔记 / 设置 —— 提醒中心与预览右栏要各自的真实数据（有人在等你 / 真有一份文件），探针里造这两个入口比它验到的东西贵，接线由上面那条创建点守卫负责。`node probes/mac-chat.mjs` 全过（三套主题的气泡与对比度）；`probes/theme-switcher.mjs` 的两条失败与本次无关 —— 它在 main 上就红（设置左栏多了一个「对话」页，断言还写着四项）。

## D391 工作区的「上次的会话」：切回一个工作区就打开你上次停下的那颗（#647；用户「现在从当前会话，切换到另一个工作区时，另一个默认进入的是该工作区的第一个会话，而不是之前的会话切换的会话。现在想要会话在切换工作区时具有记忆功能。」2026-11-23）

**问题。** 六个切组入口 —— 标签行上的标签、`＋N` 两段、壳 B 工作区浮层的段头、壳 C 竖列、壳 D 色点条、新建工作区对话框里的「带你过去」—— 最后都走 `gotoGroup()`，开的是 `group.sessions[0]`。这个「最上面」读的是 `当前会话 > ★ 第一颗 > 手排顺序 > 最新新建`，与「你上次在这个工程里干到哪」无关。于是从 A 工程切到 B 处理一下别的事、再切回 A，落在的是一颗陌生会话，用户得在左栏里重新找一遍。D374 的「选中的工作区」解决的是另一个缺口（空工作区切不过去），它不记会话。

**决定。**

1. **每个工作区记一颗「上次的会话」**：值是会话 id，键是**组 id**（不是目录、不是会话名）。派生组的 id 就是目录路径的小写形式，所以同目录删了重建接得上；手动组是 `manual:<随机>`，删了重建就从头开始 —— 删掉的工作区本来也不该「复活」记忆。
2. **落点只有一个纯函数**（`web/src/wsmemory.ts` 的 `pickLanding()`）：记忆命中（那颗仍在本组可见会话里）→ 它；否则 `updatedAt` 最大那颗；并列取会话数组里靠前那颗（树序，确定性）；空组 → `null`，交回 D374 的空态路径。`updatedAt` 是会话文件最近写过的时刻（D162：打开会话本身不刷它），与「组的天」（D290）同一个口径。
3. **一条规则覆盖全场：有记忆开记忆，没记忆开最近活动。** 升级后第一次切到某个组、清过浏览器缓存、换了浏览器，都走同一条兜底 —— 不分成「老组 / 新组」两套行为。
4. **写入时机：任何来源成为当前会话都写。** 定义一句话：当前会话是哪颗，它所在工作区的记忆就是哪颗。覆盖左栏 / ★ 行 / 搜索 / 切组 / 深链 `#/s/<id>` / 刷新 / 新建会话 / 归档或删组后的自动落点；收敛成页面里一个 `noteLastSession()`，被「打开会话」「`session` 帧」「`hello`（深链与刷新跑在快照之前）」三处调用，同组同颗不重写。
5. **只改一个切组动作。** `gotoGroup()` 的「开第一颗」换成 `wsLanding()`；六个入口本来就都走它，不新增入口、不写第二套。落点用**未过滤**的树算（左栏搜索不该决定打开哪颗，与 `emptyWs()` 同一条理由），也不带「当前会话排第一」的偏置。
6. **存在 `localStorage` 的 `pi.ws.last`**，与 D374 的 `pi.ws.selected` 同一层：刷新、换标签页都还在，同一台设备上的多个页面共享。**不进桥**：每次切会话都写盘 + 广播整份工作区快照，两台设备会互相覆盖「上次在哪」，而「我在哪」本来就是每台设备自己的事。
7. **旧桥没有工作区快照时也一样：**没有组 id 就没有记忆可谈，落点直接按「最近活动」算 —— 不为它留一条「还是开 ★ 第一颗」的特例，也不存在「跌进空工作区那条路」的风险（组由 cwd 现推，组里有会话就有落点，一颗都没有才走 D374 的空态）。
8. **范围到这里为止（有意的不一致）：** `landAfterWsDrop()`（删掉当前工作区后落到相邻组）仍开邻居排最上面那颗，刷新停在 `#/` 空路由时也不自动打开会话。这两个都不是「用户在自己导航」——一个是补救，一个是「我只想看一眼列表」。改它们之前先想清楚这条。
9. **没有可见线索、没有新文案**：不给标签加 title、不给组头打标记、不加提示条。用户能感知到的变化只有一处：切回一个工作区，中栏里是上次那颗。
10. **坏数据与私密模式都不拦路**：`JSON.parse` 失败、条目结构不对 → 当作少几条记忆；写入抛错（配额 / private mode）静默；剪枝是懒的但**两个时机都剪** —— 每次切组（读时）顺手丢掉「组已经不在了」和「这颗已不在这一组」的条目，每次写记忆时再丢一遍不存在的组；上限 64 条。桥、协议、`workspaces.json` 一个字都不改。

**为什么。** ①「最近活动」比「★ 第一颗」更接近事实：★ 是「我想常回到它」的标记，`updatedAt` 才是「我最后在它上面」，记忆失效时拿它兜底比拿 ★ 兜底更像用户脑子里的顺序；②但也不能只用最近活动：别的标签页 / agent 刚跑过的会话会把落点抢走，「上次我看的那颗」经常不是它 —— 所以记忆优先、最近活动只做兜底；③存组 id 而不是目录，是让「删掉的工作区」与「删了又建的工作区」两种情形都有唯一答案，不用为手动组写第二条回退规则；④不把这套放进桥，是因为它是「每台设备各自的视线」，跨设备同步的代价（写盘频率 + 两台设备互相覆盖）比收益大。

**代价 / 可改。** ①同一台设备的多个标签页共享一份记忆（`localStorage`），谁最后打开会话谁说了算 —— 这是「本机视线」的应有之义，但两个窗口同时用时落点会被对方改掉；②落点从「★ 第一颗」变成「最近活动」是一个**行为变化**，升级后第一次切组就能感觉到；不想要的话把 `pickLanding()` 的兜底换回 `sessions[0]` 即可（改一个函数）；③记忆只有一颗，找不回「上周在这里做的另外三件事」；④`LAST_CAP = 64` 与 `at` 时间戳只是防 localStorage 长毛，不做过期（半年前去过的组也接得上）。

**验证。** `npm run test:ws-memory` → `web/tests/ws-memory-unit.mjs`（15 条：记忆命中 / 死记忆 / 无记忆取最近活动 / 并列取数组靠前 / 空组 / `updatedAt` 坏值当 0 / `pi.ws.last` 的解析与坏 JSON / 条目结构不对只丢那一条 / 写入覆盖与 64 条上限 / 剪枝不动原表时返回同一对象）；`probes/ws-memory.mjs`（桩桥 + 真 Chromium，12 段）：深链写记忆、无记忆落 `updatedAt` 最大、记忆压过更新的那颗、刷新后仍在、记忆被删 / 被归档的兜底、空组仍是 D374 空态、左栏搜索过滤不影响落点、壳 C 竖列 / 壳 D 色点条 / 壳 B 浮层段头三个入口、`session` 帧送来的新会话也写记忆（切走再切回来是它）、旧桥（hello 里没有 workspace）也按同一条规则落到最近活动那颗 —— 那一段特意把 ★ 压在另一颗上，好让「★ 第一颗」与「最近活动」分得开。探针只读两次 `pi.ws.last`：「死记忆被换掉」与「空组没写记忆」在界面上看不出差别。回归：`rail-click` / `empty-workspace` / `pin-delete-current` / `pin-archive-jitter`（STEADY）/ `round16-pin` / `workspace-tree` 全绿；`npm --prefix web run typecheck`（含 i18n-check 与 viewport 守卫）、`npm run build:web` 通过。**在 `origin/main` 的另一份检出上逐条复跑确认过的既红项、本轮不救**：`workspace-layout` / `workspace-tabs` / `workspace-shells` / `a11y-workspace` / `workspace-settings` / `nowchip` / `pin-auto-open`（本机开局就是收起的左栏，等不到可见的 `.session-card`）、`workspace-drag`（落点线实测 3px 期望 2px 等 3 条）、`workspace-migrate`（`.ws-intro-sheet` 预览那组旧期望）。
## D392 翻译对照：块级并发 4 路，落盘仍按节、并且只能往前推（grill 结论 2026-11-23）
> **D392 修订（2026-11-23，默认模型跟随 pi）。** `TR_DEFAULT_MODEL = "copilot/gpt-6-luna"` 是写死的，而它只在登了 copilot 的机器上存在 —— 没有 copilot 的机器上，模型的预选就落到目录第一项，实测正好落在连不通的 provider（`wb2api` → `192.168.31.36`，本机在 `192.168.1.17`）上，一整篇翻译每个块都是 `Connection error`。改成 `trDefaultModel()`：读 pi 全局设置的 `defaultProvider` + `defaultModel`（`settingsPath("global")`，**只读文件、不 spawn pi**），拿不到就返回空串、页面让用户挑一次并记住（`translate/prefs.json`）。设置页那张卡从「出厂默认」改成「pi 默认模型」，没设时「恢复默认」置灰。代价：pi 设置里只写了一半（有 provider 没 model）时按「没设」处理；这台机器的「默认」从此跟着 pi 走，换全局默认模型会连带改变翻译的预选（用户已经手动选过的仍然优先）。

> **D392 修订（2026-11-23，块切小 + 提示可见）。** ① `CHUNK_CHARS` 4000 → **1400**：并发之后仅剩的尾巴是「最大那一块的生成时间」，实测一份 6.7 KB / 4 块的文档里最大一块一个人拉了 18–25 s（4 路总 30.3 s），切小之后尾巴跟着块长线性下降；代价是块数变多，`limit` 调成 1–2 时会比原来慢。② 提示：顶栏下加一条 2px 进度条、状态行加「已用 N s」、正文末尾画一条骨架 + 「还有 N 节在队列里 · 正在翻 K 块」（`paintTrLive` 每 1.2 s 刷新已用时间、块数与骨架那行）。这三处都只动前端与一个常量，不动缓存。③ **「视口优先」没做**：它与「前缀落盘」直接冲突 —— 用户在文档中段点「译」，想先读眼前那一节，就得允许缓存里出现「第 10 节好了、第 1–9 节还空着」的空洞，而 `readDoc()` 会把这些节整条丢掉、保存译文那条路（`translateJobs.patch`）也假定每节都有 `out`。要做得先改这个契约（另立一条决定），不能顺手塞进这一票。

> **D392 修订（2026-11-23，视口优先 = 缓存允许空洞）。** 前一段写「没做」的那件事现在做了，代价是缓存契约变了一条：`sections` **长度永远等于原文的节数**，没翻到的节是空壳（`{heading, src, gen:"", out:""}`）。于是「第 10 节好了、第 1–9 节还空着」是合法状态，页面能先读眼前那一节。配套三处：
>
> 1. `readDoc()` 不再丢掉 `out` 为空的节（只丢没有 `src` 的），但**整份都是空壳时仍然当「没有译文」**——否则页面会显示一排空骨架、却没有任何任务在跑。
> 2. 页面传 `at`（0–1 的滚动位置）给 `/api/translate/start`，桥自己换成节号（`startFrom()`）：客户端不用跟着 `cutSections` 的规则走，免得两边漂移。调度只改**派活顺序**（`from` 往后绕一圈），落盘还是每节翻完就写。
> 3. 进度语义从「落盘到哪一节」改回「已经翻好几节」（`onProgress.done`）；`onSection` 每次给整份数组。页面上空壳节画成骨架（左原文、右「还没翻到这一节」），有空洞时把「改译文 / 同步原文」换成「继续翻译」——编辑整篇会把没翻的节当空白提交。
>
> 代价：旧缓存是「连续前缀」，读回来仍然合法（只是后面几节不在数组里）；`/api/translate/save` 的分节数校验对空洞文档没有意义（UI 已经不给入口，接口本身没加保护）。**没做**：空洞的「过期」判定（现在仍按 mtime/size 整篇算）、按节重排（拖顺序）后再续翻。


**问题。** 一次翻译的耗时几乎全在「等一个往返开始」：`bridge/src/translate.ts`（D245）每 4000 字一块、**每块各起一个** `pi --mode text` 子进程，节与节严格串行（`translateDoc` 的 for 循环）。本机实测（macOS，`--mode text --no-extensions`，`sensenova-platform/deepseek-flash`）：

- 极小输入 **1.74 s** —— 这就是一次往返的固定成本（node + pi 启动 + 一次极短回答）；
- 280 字一块 9.2 / 15.0 / 15.1 s；1800 字一块 **31.1 s**，同一输入重跑一次 **79.0 s**（2.5× 抖动）；
- 连打三个请求就吃 `429 RateLimitExceeded.EndpointRPMExceeded`；
- `--mode text` **不流式**：78.83 s 时首字节才到，22 个 256 字节块在同一刻吐完。

也就是说：块的大小、正文长短对总时长影响很小，**往返的个数**才是。D245 记下的「1.7 KB 日文文档 36 s」是 6 个往返各 5–8 s，和今天的复现对得上。原来还有两个小毛病：取消只在节边界上生效（最坏要等一整节，几十秒），以及「进度」只在节翻完时才动。

**决定。**

1. **块级并发，默认 4 路。** 把 (节, 块) 摊平成一个任务队列，`translateDoc` 里用一个带上限的在飞池跑；`TR_CONCURRENCY = 4`、`TR_CONCURRENCY_MAX = 8`。**块**（一次模型调用的单位）才是并发的单位，不是节：一节里可能切出好几块，长节不会被串行卡住尾巴。
2. **落盘只能按原文顺序往前推（前缀）。** 缓存里出现「第 4 节好了、第 2 节空着」是不合法的：`readDoc()` 会把 `out`/`src` 为空的节过滤掉，`paintTranslate` 又是按下标配对左右栏，缺一节就整篇错位。所以某节完成时只有它是「当前前缀的下一节」才写缓存；慢的那一节会挡住后面显示，**但翻译本身照旧并行**。
3. **取消立刻全杀。** `TrRunner` 多一个 `signal`（`{aborted, onAbort(fn)}`），`runPiTranslate` 把「kill 这个子进程」登记进去；`TranslateJobs.cancel()` 置标志后当场执行所有登记的回调。已经落盘的节留着 —— 与原来「边翻边落盘」的语义一致，只是不再等节边界。
4. **429 不是「这块翻坏了」。** 撞限流 → 在飞上限砍半（最低 1）、指数退避重发（基数 3 s，上限 60 s，最多 5 次），**不占** `MAX_RETRY` 的名额（那个是给「表格散架 / 照抄原文」用的）。5 次都用完才按失败处理：保留原文 + 一条 warning，与既有语义一致。
5. **主进度仍按节，并发只上副行。** `JobView.done/total` 还是节，且 `done` 的含义改成「**落盘到哪一节**」；新增 `JobView.inflight`（正在翻的块数），页面在 `翻译中 3/6` 右边写一句「正在翻 2 块」。用户读的数还是「还差几节能读完」，不用重新理解一个量。
6. **旋钮进设置。** 设置 →「预览与翻译」多一行「同时翻几块」（1–8，默认 4），与「翻译用的默认模型」同一组，存 `statePath("translate","prefs.json")` 的 `TrPrefs.concurrency`；**译文缓存一个字段都不动**，旧缓存照读、不会被作废。缺省/坏值夹进 1–8。
7. **`keep` 复用不进并发池。** 原文没变的节直接沿用旧译文，不占名额也不调模型；整篇都命中时一场都不跑。

**为什么。** ①真正的杠杆是把**固定成本叠起来**，而不是减少字节或调大分块 —— 1800 字一块与 280 字一块的墙钟差 2–3 倍，而两者都只含一次启动与一次首字节等待；②落盘按前缀不是保守，是被现有代码逼出来的：`readDoc` 的过滤与 `paintTranslate` 的下标配对都假定缓存是连续前缀，改这个假定等于同时改读取、渲染与「更新」的配对逻辑，超出「一个 PR、缓存照读」的机子；③取消必须能 kill，否则并发之后最坏等一整节，比串行时更糟（一串行时取消最多等 1 块）；④限流与「翻坏了」必须分开：前者等一会儿就好，后者重试也没用 —— 混在一起会让一次 429 吃掉这块唯一的重试名额，用户看到的却是「这一段保留原文」；⑤进度按节而不是按块，是因为用户读的是「还差几节」，块数只解释「为什么还没到下一节」。

**代价 / 可改。** ①**瞬时费用峰值 ×4**：并发把同一分钟的 token 量抬上去，按分钟限流的 provider 更容易撞 429（实测 `deepseek-flash` 几乎每调用一次就限流，退避把 36 s 的活拖成几分钟）——撞了会慢，但不会丢块；想彻底避开只能换 provider 或把默认路数调低。②**慢节挡显示**：前缀落盘下，第一节特别慢时后面翻好了也看不到（`inflight` 那句副行是唯一的「其实在动」信号）。③`onProgress.done` 的语义从「翻完几节」变成「落盘到哪一节」，`bridge/src/translatejob.ts` 的 job 进度与 `paintTranslate` 共用这一个数。④并发被砍半之后**不会自动恢复**到用户设的路数，只有下一次任务才回到默认。⑤旋钮只存本机 prefs（跟模型偏好一样），不同步到别的机器。⑥`probes/translate-ui.mjs` 是 Windows-only（`netstat -ano` / `taskkill`），这台 Mac 上跑出「0 项」，这次没用它验收 UI。

**没做。** 术语表 / 跨块上下文接力（同一个词在两个块里仍可能两种译法）；流式输出（`--mode text` 不流式，要边翻边填字只能换常驻的 `--mode rpc` 子进程，另一个量级）；扩大覆盖面（表格 / 幻灯片 / PDF / 聊天正文 / 更多目标语言）；对照与写回的手感（逐段 diff、撤销写回、多标签页 `out` 的版本号）；按模型目录分档的并发（快模型 6 路、其余 2 路）；把砍半后的并发在限流窗口过去后升回去。

**验证。**

- 单元 `bridge/tests/translate-unit.mjs` **81/81**（新增 14 条）：并发与串行逐节一致；同时在飞不超过 limit（实测 peak 3 / limit 3）；`onSection` 每次只多一节、不回头（`[1..8]`）；`onProgress.done` 单调不减且到顶；`onInflight` 报过正数、结尾归零；`keep` 命中时一场也不跑；429 退避后仍翻成且不产生「保留原文」；连续限流用尽才记失败；取消立刻抛 `Aborted` 且**在飞的 4 块全被杀**；`clampConcurrency` 与 prefs 的夹紧/回读。
- 速度探针 `probes/translate-speed.mjs`（新增，`npm run probe:translate-speed`）：桩（每调用睡 250 ms、20 块）串行 **5.0 s** → 4 路 **1.3 s**，**×4.00**；真模型 `wb2_mac/cn:glm-5.3-flash`、6 节 **12 块**：串行 **148.5 s** → 4 路 **55.8 s**，**×2.66**，24 次调用 **0 次限流**、0 块没翻成、结构（节数 / 标题 / 表格形状）与串行一致。真模型两次的措辞不会一样，所以探针只比结构、不比文字。
- 反例（写在这里是为了记住退避基数为啥从 0.8 s 拉到 3 s）：`sensenova-platform/deepseek-flash` 27 次调用里 19 次 429，1.5 s 起步的退避只够再吃一次限流 —— 串行那趟还撞上一次 180 s 超时，两趟都有块没翻成（×4.88 那个数因此不当作验收）。
- `npm run test:translate:e2e` 全部通过；`npm run typecheck`（bridge / peer / web + i18n-check + viewport + layers + spawn-hidden）通过。
- 1.7 KB / 6 块这种小文档只有 **2 波**，收益约 2×（不是 4×）；吃满 4 路要 20 块以上的长文 —— 这也是验收线定在「≥20 块、≥2.5×」的原因。

## D393 依赖清单的版本从「钉死」改成「下限」：低于它必须升，高于它不降级（#649）

**问题：** `npm install` 无条件把 pi 装成 `@latest`（当时是 1.6.0），而清单里钉死的 `pi-subagents@0.86.0` 比它早两周、比当时的最新版（0.90.0）落后四个小版本 —— 新机器上是一个谁都没验过的组合。而已经装着 0.86.0 的机器更尴尬：整备按包名判「已装就不动」，它们会**永远**停在 0.86.0，不管 pi 涨到多少。这种不匹配又是静默的：桥直接读 `pi-subagents` 落在 `%TEMP%` 下的 `status.json` / `events.jsonl` / `workflow-receipt.json`，布局一变，网页不报错，只是后台卡与子代理面板悄悄变空。当初钉住正是为了挡这件事，结果钉子自己成了「和不认识的那版 pi 搭班」的来源。

**查证（决定前先查，不是推测）：** 这台机器就是 pi 1.6.0 + 0.86.0，桥一直在跑，`bridge-live.log` 1695 行里没有一条 `extension_error`。pi 1.6.0 的 Breaking Changes 只有一条跟扩展有关 —— 组件 `render()` 返回只读数组、`Container` 复用缓存数组，是 TUI 渲染面，而桥用 `pi --mode rpc` 根本不渲染 TUI。`pi-subagents` 0.90.0 的 CHANGELOG 里唯一提 1.6 的一条是「对着 Pi 1.6 修好类型检查，**没有**改依赖钉法」。0.86 → 0.90 之间网页依赖的字段（`state` / `outputFile` / `workflow.value.children` / `workflowChildren.children` / `steps[].sessionName` / `parentWorkflowRunId` / `events.jsonl` / `workflow-receipt.json`）全部还在。所以问题不是「钉子必须拆」，而是「钉子太靠后」。

**决定：**

1. **清单里的 `version` 语义改成「最低可接受版本」。** 判据还是同一个纯函数（`bridge/src/deps.ts` 的 `depStatus` + `depAction`），脚本与页面共用：没装 → `install`；装了但低于下限 → `upgrade`；其余（含比下限新、读了但读不出版本号）→ `keep`。**不降级**：自己装了 0.92.0 的人不会被按回 0.90.0，页面上也不提「你太新了」。
2. **`pi-subagents` 0.86.0 → 0.90.0；`MIN_PI_VERSION` 1.5.0 → 1.6.0。** 下限已经跟 pi 1.6 同期，1.5 那组组合没人验过；`npm install` 本来就会把低于下限的 pi 升到 latest，所以这条不额外增负担。两个 `@juicesharp` 包今天本就等于 latest，同一条机制对它们无动作；`pi-web-access` 仍然不写下限（只调它的工具，不解析输出）。
3. **启动关卡把「旧」当「缺」。** `npm start` 前那一查（D224）原来只拦缺的包；低于下限一样拦，并说出现在是哪版、该升到哪版，以及一条能粘贴的 `pi install` 命令（缺的、旧的都列出命令，不只是关了自动安装的时候）。`--check` 也把「旧」判为不及格（退出码非 0），但仍然一个字节都不写全局目录。
4. **用一份真样本兜住静默失效。** `bridge/tests/fixtures/pi-subagents-0.90.0/` 是隔离的 agent 目录里真跑出来的 async 单跑 + workflow 产物（路径换成占位、长正文截断），`test:bgruns` 拿它回放同一个解析器；`test:deps` 断言样本 `meta.json` 的版本 == 清单里的下限 —— **换了钉子却忘了重取样本，单测先红**，而不是等用户报「卡片空了」。样本版本是手写在 `meta.json` 里的，所以这条守卫挡的是「忘了重取」与「重取了忘了改名」，不是上游偷偷换版本（那由 `test:bgruns` 的字段断言挡）。
5. **页面那句话说它会发生的事。** 「比 x 旧，能用」改成「比 x 旧，下次 npm install 会升上去」：它不再是安慰，而是预告。

**为什么不直接改成不写版本（跟 latest）：** 那样确实能让新机器拿到最新版，但对已经装着 0.86.0 的机器零效果（判据还是「已装就不动」），而静默失效的风险一分钟都没减少 —— 换来的只是「每次 npm install 落点不确定，回滚没有确定坐标」。上游一旦改布局，`install` 到 latest 也修不好，只会让下一个人拿到的还是坏的。

**代价 / 可改：**

- 升级发生在 `npm install`，跑着的桥要重启才用上新版本（与装扩展一贯如此）。
- **热部署 / `bridge-update` 不跑整备，所以它们不会把旧版本升上去，也不会被拦。** `scripts/hotdeploy.mjs` 只跑 `npm run build` 然后直接 `spawn bridge/dist/index.js`；`bridge-update` 的 `restart.mjs` 起的是 `npm run start:nobuild`（即同一个入口）—— 两者都不经过 `scripts/bootstrap.mjs`，而 D224 那个关卡只挂在 `npm start` 上。结果：只靠热部署的机器会一直停在旧版，页面一直挂着「要升级」，功能不受影响（桥不在运行期校验下限）。想让它们对齐，只能自己跑一次 `npm install`。没在 hotdeploy 里顺手加 `npm install`：那会在杀进程前动 `node_modules` 与用户的全局目录，与 D220「装东西只在用户按下 `npm install` 时」的边界冲突，也会把「构建失败时旧服务原样活着」这条保证弄复杂。
- 启动关卡现在会拦「旧」：低于下限的人下次 `npm start` 起不来，得先 `npm install`。这是故意的 —— 不拦的话「已装就不动」会让这批人继续停在旧版本上。
- 样本是某一版的快照，会过时；它守的是「网页认的字段还在不在」，不是「上游行为完全没变」。换下限时按 fixture 里的 README 重取一次（约两分钟，两次副代理调用）。
- 想回到「旧了只提示」：把 `depAction` 的 `upgrade` 分支去掉、页面文案改回一句即可，真样本与版本一致性断言在任何方案下都成立。
- 页面的「本项目需要」只在**失败**时说原因（`bootstrap.error`）；成功装了 / 升了什么只留在状态文件的 `installed[]` 里，没有单独列表。这次没加那块界面。
- 顺手修了 `bridge/tests/deps-ui.mjs` 里一句陈旧断言（「三个包都在清单里」——清单早就是四个，`main` 上就红）。一行、不改行为，与本次同一块代码，所以没拆出去。

**验证：** `npm run test:deps`（三份 README 的表对账、四态判据、样本版本断言）、`npm run test:start-check`（新增「低于下限就拦」「整备脚本真的升到下限」「`--check` 判旧不及格」「到了下限就记住、不再问 `pi list`」）、`npm run test:bgruns`（0.90.0 真样本回放：单跑、workflow、脚本式 workflow 的 receipt 回填、前台派活按 `parentWorkflowRunId` 认孩子）、`npm run test:deps:ui`、`npm --prefix bridge run typecheck`。**`npm run typecheck` 这一条在这台机器上过不了**：`web` 那半截挂在 `src/translateview.ts` 的两条中文没走 `tr()` 与 en/ja 缺键上（D392 那批留下的），在 `main` 上逐字相同 —— 与本次改动无关，也不该由这次顺手改别人的在飞代码。

## D394 图标换成一套手绘线性 SVG，emoji 从界面与词典里退场（#653；用户「按照 mac 的主题，重新设计一下本项目所有的图标」）

**问题：** 界面上的图标其实有**四套**：`app.ts` 那批 24×24 内联 SVG（归档 / 复原 / 删除）、`dirpicker.ts` 的文件夹与上一级（16×16）、`peer/main.ts` 与 `peer/emoji.ts` 的 ICONS 表，其余全是 emoji（📂 📁 🌐 🐞 💭 📮 🔷 🔎 🖼 📎 🗑 …）。后者的毛病不是「不好看」而是不成立：每个平台一套字形（macOS 的 📁 是蓝的、Windows 的是卡其色）、跟着字号变彩色、宽度占不进图标那一列（`.icon-btn` 里 emoji 与 `>_` 混排时基线永远差一两像素），还有 28 条 i18n 文案把 emoji 写进了 key（`"📂 产物"`），顶栏宽按钮靠 `splitWideLabel()` 在第一个空格处把它切出来当图标用（D138）—— 换图标就得改词典。唯一做对的是内网通表情面板（`peer/emoji.ts`）：那轮已经把底栏 9 个 emoji 换成了手绘线条图标，注释写着「不用彩色 emoji 当图标 —— 那正是旧面板看着乱的原因」。

**查证（决定前先数的，不是估的）：** 当成图标用的单字形字面量 149 处（`app.ts` 52、`chat.ts` 14、`notesheet.ts` 12、`branchsheet.ts` 10…），涉及 26 个源文件 + `styles.css`；词典里 28 条 key 带 emoji；排版符号（★ ▾ ▸ ✓ ✗ ✕ ● ○ ◌ ⎇ ⌘ ⌂ ⑂ ＋）另算，不在这次范围里。SF Symbols 是 Apple 的资产，不能随包分发（D-侵权那一轮已经确认仓库里没有任何外部图标 / 字体 / 位图），所以这套是**照 SF 的量感手绘**：16×16 画布、1.5px 描边、圆头圆角。

**决定：**

1. **一个源：`web/src/icons.ts`。** 50 个图形（`sidebar` / `layers` / `terminal` / `folder` / `bug` / `users` / `bubble` / `lozenge` / `mail` / `search` / `sliders` / `trash` / `pencil` / `archive` / `unarchive` / `plus` / `close` / `chevron` / `star` / 四个文件类型 / `link` / `monitor` / `clip` / `expand` / `collapse` / `home` / `save` / `laptop` / `clock` / `arrowUp` / `updown` / `checklist` / `bolt` / `shield` / `lock` / `refresh` / `image` / `box` / `sparkle` / `tool` / `pointer` / `palette` / `eye` / `slide` / `table` / `alert` / `scissors` / `window` / `dots`），每条 1–3 段路径。`icon(name)` 给 DOM 节点、`iconMarkup(name)` 给字符串、`face(nameOrText)` 给「图标名或现成文字」这两种脸（菜单行、状态按钮用），`fileIcon(path)` 把原来 `chat.ts` / `app.ts` 各一份的扩展名映射合成一处。
2. **颜色只有两种：`currentColor`，以及破坏性与状态的语义色。** `tint` 只给垃圾桶 / ⚡ / ⚠ / 锁 / 盾（bug 不带色，见第 4 条）；功能入口（产物、文件夹、邮箱、内网通、Jira）一律灰 —— 顶栏九颗要是五颗同色，换强调色时整排跟着变，比 emoji 更吵。
3. **实心强调色底上自动退回单色。** 语义色走 `--ico-tint` 变量，`.btn.primary` / `.chip.on` / `.pin-chip.cur` / `.viewer-seg button.on` 里由一条 CSS 把它覆盖成 `currentColor`（新加的实心面记得进这一串，或就地给图标加 `.ico-flat`）。不这么做就会出现「红垃圾桶压蓝底、白字里冒出黄闪电」。
4. **记录那颗平时是灰的，有待处理才红**（`.notes-btn.has-pending`）。样张里它常红，落地时改了这一处：顶栏一排灰图标里唯一一颗红点太像报错，而「红 = 有活没干」才是这颗按钮真正的状态。
5. **排版符号不进图标表。** `★ ☆ ▾ ▸ ✓ ✗ ✕ ● ○ ◌ ⎇ ⌘ ⌂ ⑂ ＋` 继续留在文案里：它们跟着字重字号走、可选中可复制、有的还能当字读（★ 本身是那颗可点的置顶开关）。**按钮的「脸」用图标，列表与句子里的状态符号用文字** —— 这是这次唯一的划线标准。git 操作动词表格（`git-ops.ts` 的 `glyph`）也按这条留着：那是密集动词网格，`⎇` `✖` `❖` 比 16px 图标好读。
6. **文案与图标彻底分开。** 28 条 key 里的 emoji 全部摘掉（`"📂 产物"` → `"产物"`），顶栏宽按钮改成 `wideBtn(TOPBAR_ICON.artifacts, tr("产物"))`，`splitWideLabel()` 退休。句子中间提到图标的地方改说法（「在左栏🗑里可以还原」→「在左栏的垃圾箱里可以还原」，提示语里的 🌐 改「那颗浏览器图标」）。「文件管理器」在顶栏用带上下文后缀的键 `文件管理器|顶栏按钮`（→ Files / ファイル），别处的同一个词仍是 File manager。
7. **顺手修掉 i18n-check 误报。** 原来它拿整个模板串的 `getText()` 判中文，`\`${tr("还有 {n} 节在队列里")}${tail}\`` 这种「中文全在里面的 tr() 里」的串会被当成漏翻；D392 之后 `main` 上就一直红着两条（连 en/ja 缺 `正在翻 {k} 块` 一起）。现在只看模板串的字面量段，缺的两个键也补了 —— `npm run typecheck` 在 `main` 上红了几天，这次一起回绿。

**代价 / 可改：**

- 13px 以下（窄屏方块按钮、行内小图标）线条会发灰；比起 emoji 的「一眼认出」，线性图标要靠形状记。样张里备过 1.9px 加粗版（B）与圆角底板版（D），都能一行切回去。
- `tool`（扳手）现在读着更像一把小锤子，`archive` / `unarchive` 只差箭头方向 —— 想改就是改 `icons.ts` 里那几段 `d`，不用动任何调用处。
- 内网通的两个 ICONS 表（`main.ts` 的头像/动作、`emoji.ts` 的贴纸分类）**没有**并进来：它们本来就已是线性 SVG，词汇与主界面不重叠（杯子、熊、车、旗）。要收的话是下一轮的事。
- `.ico` 的垂直对齐用 `vertical-align: -0.14em` 凑基线，换字号时可能要再调一次；`gap` 与内边距在 `icon-btn` / `mib` 这类容器里各自定，不统一。
- 探针里凡按 emoji 选元素的都得改：`bug-notes-ui.mjs` 改成断言 `svg.ico` 存在且没有文字，`fs-ui.mjs` 那颗「引用路径」改成按 `title` 选（它本来就因为别的原因在 `main` 上红着）。

**验证：** `npm run typecheck`（bridge / peer / web + i18n-check 4141 键 × 3 语 + viewport + layers + theme）通过；`node probes/chrome-topbar.mjs`（四档宽度、切英文后标签、不横向溢出）全过；`node probes/mac-chat.mjs`（三套底色、对比度、气泡贴边）全过；`node probes/round21-cwd-line.mjs`、`node probes/notes-panel-regress.mjs` 与 `main` 一致通过（`round24-pinactions` / `round15-git` / `archive-switch` / `fs-ui` / `bug-notes-ui` 在 `main` 上已经红，不是这次引入）。三套底色 + 设置抽屉 + 记录面板的截图在原型目录里（`.scratch/icons-sheet/`，不进版本库）。

## D395 一份桥日志封顶 16 MB，临时状态目录不再开机扫全盘（#654；用户「为啥本项目在我这台 mac 上占用这么多内存」「还有硬盘空间」2026-11-24）

**问题：** 这台机器上 40 GB 是 pi-web-client 占的，其中 38 GB 全在 `.scratch/` 里，而里面**只有两样东西**：28.9 GB 的 `logs/bridge.log`，加 9.0 GB 的 `filesearch.db` 副本（313 份，单份到 1.2 GB）。两者都不是功能要的，是没人设上限的副作用：

- `log()` 是纯 `appendFileSync`，没有轮转、没有上限。单个文件实测长到 **17 GB**（`feat-code-review-panel/.scratch/session-flags/`），7.9 GB 一份的还有一个、1.8 GB 的第三个。日志本身是给「刚才发生了什么」用的，GB 级的日志既打不开也没人读。
- 每份桥启动时 `if (st.state === "off") fileIndex.start()` —— 「开库不耗时，没有索引才起首次扫描」。但测试 / 探针 / 第二实例各自都有一份空的状态目录，于是**每一份都扫一遍整盘**：1.2 GB 的库 + 满盘 IO。那天 11 个桥里 9 个是探针 / 测试组留下的，load average 顶到 20，SIGTERM 之后还要 SIGKILL 才肯退。

**查证（先数的）：** `.scratch/` 合计 38.0 GB = logs 28.9 GB + filesearch.db 9.0 GB + 其他 0.2 GB；313 份索引副本；`rg` 过 `bridge/tests/`，只有 `fileindex.mjs`（直接 import `FileIndex` 的单元测试）碰索引，没有一条 UI 用例看搜索面板。前端也只在打开搜索面板时发 `filesearch.status`，`filesearch.scan` 只由「开始」按钮触发 —— 开机自动扫描是纯背景便利，不是面板需要的东西。

**决定：**

1. **`RotatingLog`（`bridge/src/logfile.ts`）**：默认 8 MB 一代，越过上限把这一代搬成 `bridge.log.1`，只留一代，所以一份日志最多 16 MB。`PI_WEB_LOG_MAX_BYTES` 改上限，`0` 回到老行为（永不轮转）。
2. **两条不对称的规则，各自对应各自的现场**：运行中越限 → 搬成 `.1`（刚写满的那 8 MB 就是最近的现场，值得留）；**开写时发现已经越限** → 直接截断不搬 —— 那说明文件是没上限时代留下的怪物，或者上一次进程没来得及轮转就被杀，把它改名成 `.1` 只是让怪物换个名字继续占盘。
3. **开机自动扫描只给「用户自己的那份状态目录」**（`stateDirIsDefault()`，`bridge/src/fileindex.ts` 的 `autoScanOnBoot()`）。测试 / 探针 / 第二实例都用 `PI_WEB_STATE` 指到别处，它们不搜文件；要它们也扫就 `PI_WEB_FILEINDEX=1`。`PI_WEB_FILEINDEX=0` 仍然是无条件关闭。
4. **没做「多份桥共享同一份索引」**：索引是每实例一份，因为一次扫描会重写 `gen` 并删掉 `gen < thisGen` 的行（`DELETE FROM files WHERE gen < ?`），两个桥同扫一份库会互相删掉对方的行。共享要么加跨进程扫描锁，要么把 `gen` 换成「按实例分段」——两者都比这次的收益（9 GB，且只在跑测试时才长）贵得多。测试改成不自动扫之后，这 9 GB 不再产生。

**代价 / 可改：**

- 日志只留一代：要更长的历史得调 `PI_WEB_LOG_MAX_BYTES`，或者从 `.1` 里翻。找「昨天那次」不可能了 —— 之前也没有人翻得动 17 GB。
- `PI_WEB_STATE` 指到别处的**真实**用户（第二份个人实例）不会自动建索引，得在面板里按一次「开始」或设 `PI_WEB_FILEINDEX=1`。默认状态目录的用户行为一字未变。
- 每个会话的 pi stderr 日志（`state/logs/<session>.log`，`rpc.ts` 的 `createWriteStream`）**没有**封顶：那是诊断页要读的原样输出，量级几十 MB 以内，先不动。真要封顶得先决定诊断页怎么表达「被截断」，那是另一个决定。
- `.1` 在 Windows 上被别的进程打开时改不了名，`rotate()` 退化成原地截断 —— 少一代，不会写不进去。

**验证：** `node --experimental-strip-types bridge/tests/logfile-unit.mjs`（新增，`npm run test:logfile`：不越限不产生 `.1`、越限搬一代且只留一代、开门就是怪物时截断、`maxBytes=0` 保持老行为、写失败照旧抛、环境变量四种读法）；`node bridge/tests/fileindex.mjs`（新增 `autoScanOnBoot` 四态）；`npm run typecheck`；`npm run build:bridge` 后用 `PI_WEB_STATE=<tmp> PI_WEB_LOG_MAX_BYTES=600` 真起一份桥，日志里是 `filesearch: off (0 entries)，临时状态目录不自动扫描`，`filesearch.db` 只有开库的 96 KB（不再有 1.2 GB 的索引）。

## D396 日志风暴罩子：一秒超过 500 行就不再逐条写（#656；用户「为啥会产生这么多 log」2026-11-24）

**问题（先数出来的量级，不是"感觉日志多"）：**

- 正常一份桥：11-18 之后 5 天，主桥 `bridge.log` 一共 **834 行 / 62 KB**（≈ 0.14 B/s）。
- 历史遗留的大头不是正常量：那份 8 MB 日志里 **98.6% 是同一行** `[peer] … 在线 N 台`（112,574 / 114,187 行，每 6 秒一行，8 天 7 MB）。那行在 `ad1c4b7`（D313）已经删掉，11-18 之后一条都没有。
- 但 GB 级的那几份不能用"累积"解释：`.scratch/session-flags/` 那份 **17 GB / 50 分钟 = 5.8 MB/s**，比正常快 **约 4000 万倍**。按 62 字节一行是 2.9 亿行；按 `log()` 里 4000 字符上限的异常行算，是 **1521 行/秒，持续 50 分钟**。

**真正的代价不是盘：** `log()` 写盘是 `appendFileSync`，**同步**的。1500 行/秒意味着事件循环里每秒多 1500 次同步系统调用 —— 那份桥自己先卡死。这也是为什么那批残留桥 SIGTERM 不退、要 SIGKILL，以及那天的 load average 顶到 20。D395 的轮转只把磁盘封在 16 MB，同步写这一半没管。

**为什么查不出是哪一条在刷：** 那份 17 GB 已经随清理删掉了（用户确认过）。能写 `bridge.log` 的只有三条路：桥自己的 82 个 `log()` 调用点、`bridge/src/peer.ts` 里 `[peer]` 子进程 stdout/stderr 的**逐行全量转发**、`uncaughtException` / `unhandledRejection`（每条带栈、截 4000 字符）。后两条都可能在热路径上失控，但没有证据就不指认。

**决定（`LogStorm`，`bridge/src/logfile.ts`）：**

1. **写之前先算频率**：1 秒窗口内超过 `maxPerSecond`（默认 500）行 → 写**一条** `⚠️ 日志风暴：一秒内超过 N 行（样本：<被吞的第一条，截 200 字符>）`，之后的每一行只计数：不碰盘、不碰 stdout（`console.log` 也在 sink 里，所以控制台一起安静）。
2. **降下来要说话**：某个窗口的行数掉到阀值一半以下才收工，写一条 `⚠️ 日志风暴结束：N 秒里吞掉 M 行（最后一条：…）`。留一半的余量是为了「抖一下别结束」。
3. **结尾那行由窗口定时器兜住**：只靠 `write()` 驱动的收工有个洞 —— 刷一阵之后彻底安静的桥永远不会再写，尾巴就永远不落。所以风暴期间挂一个 `unref()` 的 1 秒定时器，每轮自己推进窗口，安静了就写尾巴。`unref` 保证它不会拖住进程退出。
4. **`PI_WEB_LOG_MAX_LINES_PER_S=0` 关掉整个罩子**，正整数改阀值。
5. **不做的**：不去重、不聚合相似行。被吞掉的行本来也没人看，但「什么形状的行、什么速率、持续多久」正是要查的东西，头尾两条把它说全了。也不给 `console.log` 另做一套限流 —— 统一从 sink 出去，一处管住。

**代价 / 可改：**

- **阀值以下的慢速刷屏照样能写满 16MB**（比如 100 行/秒刷半小时）：那由 D395 的轮转兜底，磁盘不会失控，只是那 16 MB 里全是同一条。真遇上再降 `PI_WEB_LOG_MAX_LINES_PER_S`。
- 风暴里被吞的行没有逐条副本：事后只能看到首尾两条样本。想留全量就得接一个环形缓冲或单独开 debug 通道 —— 那是另一个决定。
- 阀值 500/秒是拍出来的：正常一份桥一秒最多几条（开机 7 行、一次 ask 一行），500 已经差了两个数量级以上，同时远低于失控时的 1500/秒。
- 收工判定有最多 1 秒延迟（要等一个完整窗口），所以风暴尾巴可能比实际安静晚一行。

**验证：** `npm run test:logfile` 12 项全过（轮转 6 项 + 风暴 6 项：阀值内不透传、超限只写头、安静写尾并带上吞了多少与最后样本、刷完彻底安静时靠定时器落尾、样本截断到 200 字符、`maxPerSecond=0` 全关、环境变量四种读法；时钟与定时器都是注入的假实现，不真等一秒）。真桥冒烟两次：`PI_WEB_LOG_MAX_LINES_PER_S=1` 时开机 8 行变成 3 行（头 + 尾 + 第一条），尾巴是 `2.0 秒里吞掉 5 行`；默认阀值下开机 6 行一字不少、没有 ⚠️。`npm --prefix bridge run typecheck`、`npm run build:bridge` 通过。

## D397 问卷残影跟着会话走：切到别的会话不再挂在输入框上方（#659；用户「在调用表单提问时，点击了中断后，有时候，chat 框上面出现撤销提示。但是这个提示，出现了跨会话情况。导致错乱」2026-11-24）

**问题：** 中断一份答了一半的问卷时，输入框上方会留一块「问卷没答完就关闭了：… 把已填答案放进输入框 / 忽略」（Q-010）。它存在 `App.askLost` 这一个整页槽位里，`renderAsks()` 只看「`askLost` 有值且当前没有待答问卷」就画 —— 不看这是哪个会话。于是在 A 里中断、切到 B，B 的输入框上方照样挂着 A 的残影；点「把已填答案放进输入框」，A 的答案就进了 B 的草稿。两个会话的草稿与上下文就这样串了。

**决定：**

1. `askLost` 记下 `sessionId`（`ask.remove` 那一帧的会话），`keepLostAsk()` 照旧只给当前会话建残影。
2. 显示条件收进纯函数 `lostAskHere(view)`（`web/src/frames.ts`）：`askLost` 存在、`currentId` 就是它、且这个会话当前没有别的问卷在等，才返回它。`renderAsks()` 只看这个函数的返回值。
3. 切走不清掉它：切回来残影还在（答案仍然只属于那个会话），只是不再跟到别处。

**为什么放在 frames.ts 而不是 App 里：** 这是「这一帧状态该不该画」的纯判定，与 `continueState()` 同类；放纯函数里，`web/tests/frames-unit.mjs` 不用开浏览器就能钉住「别的会话不画」。

**代价 / 可改：**

- 残影仍然只有一个槽位：A 的还没处理，B 又丢了一份，A 的会被 B 的顶掉。真需要同时留多份再改成按会话的 Map。
- `askLost` 不落盘：刷新页面后残影消失（已填答案仍在 `askDrafts` / localStorage 里，重新弹同一份问卷能带回来）。这与 Q-010 原样一致，不是这次改的。
- 「别的会话（不是当前会话）里问卷被中断」仍然不建残影，和原来一样：`ask.remove` 到达时当前会话对不上就不记。

**验证：** `node probes/round5-asklost.mjs` 新增第二个会话：切过去 `.ask-lost` 必须是 0（改前红：`found 1`），切回来还在，答案只落到原会话输入框、另一个会话的草稿仍是空的。`node --experimental-strip-types web/tests/frames-unit.mjs` 27/27（新增「残影只属于丢问卷的那个会话：切到别的会话不画它」）。

## D398 记录面板撤掉「发送给好友」：只剩「提交给好友」，顺带给提交加体积护栏（#663；用户「发送给好友没有提交给好友好用」2026-11-24）

**问题：** bug 反馈面板的「内网通连动 ▾」里，两项对同一个意图给出两条路：发送 = 一条普通 `text` 帧（标题 + 空行 + Markdown 正文，≤32 KB，允许未保存的草稿，对端没有任何按钮）；提交 = 打包 note 帧 + 逐张补图，对端看到卡片、可只读预览、可接受进记录。用户报「功能重复，发送没有提交好用，想删掉发送」。顺带查出一个既有窟窿：**提交侧没有任何体积护栏** —— 正文超 200 KB 时只有服务端 400「正文太长」，用户点完、选完人才知道；而唯一提到体积的那句话（32 KB）偏偏挂在发送身上。

**决定：**

- **删发送，菜单留一项**：`peerMenu()` 只画「提交给好友」。菜单本体不动 ——「内网通连动 ▾」这个入口、「正在问内网通…」的占位、未启用 / 正在重启 / 连不上时的置灰 + 原因，以及**归档只读视图里照旧保留这颗菜单**（不脏时 `saveAndWait()` 直接返回，发得出去）。删掉的东西：`sendTextToPeer()`、`PEER_TEXT_BYTES`、`noteTextForPeer()` 与它的注释、`md-input-unit.mjs` 那条断言，以及 en/ja 的「发送给好友」「已发送给 {p1}」「标题 + Markdown 正文」「正文 {p1} KB，超过 32 KB，改用「提交给好友」」四条译文。共用的键不动（「发送中…」`mail.ts` 也在用、「没发出去：{p1}」`app.ts` 在用、「先写点东西」「连不上内网通：{p1}」提交自己也用）。
- **护栏抽成纯函数**：新文件 `web/src/notes/peer-guard.ts`，`NOTE_TITLE_MAX 200` / `NOTE_BODY_MAX 200_000` / `NOTE_SHOTS_MAX 24` 照抄 `peer/src/note.ts`（web 包不能 import peer 包），`notePeerGuard(title, body, shots)` 只返回结构 `null | { blocked, actual, limit }`，文案由记录面板用 `tr()` 拼 —— 模型层不写中文。顺序 **正文 → 标题 → 截图**：正文是用户真能改的那条，标题多半是保存时从首行推出来的（60 字），先报标题会把人指去改一个他没写过的字段。正文按 UTF-8 字节、标题按 `String.length`（并先 trim）、截图按张数，全部与服务端一致。
- **只判这三条，不判整帧 256 KB**：三条都在上限内时整帧必然小于 `MAX_NOTE_BYTES`。最坏算过：正文 200 KB + 标题 200 字（UTF-8 约 600 B）+ 24 张清单（文件名 200 字 + sha 64 位 + size ≈ 700 B × 24 ≈ 17 KB）≈ 217 KB。整帧体积要等每张图的 sha256 才知道，那是 `/api/notes/measure` 的活（现在的调用点在选人之后），不为它把菜单从「立刻出来」拖成「等一下」。
- **判定只在菜单里做一次**：按 `fullNote(note)` 算（`editing.note.body` 随输入实时同步，所以这就是编辑器里现在的内容），落盘后不再复算 —— `save()` 不重写正文，只补空标题（首行 60 字），不会凭空变大。
- **提示只说第一条超的，带数值**：「正文 {p1} KB，上限 {p2} KB」/「标题 {p1} 字，上限 {p2} 字」/「截图 {p1} 张，上限 {p2} 张」。菜单宽 300px、hint 只有一行 11px 小字，塞不下三条；正文按 1000 进算 KB，跟服务端那句「上限 200 KB」对得上。正常态仍是「打包标题、正文、分类、状态与 {p1} 张图」。

**取舍：** 记录面板的**纯文字出口整个没了** —— D317 本来就是用这两项换掉「复制 Markdown」的，删掉发送之后没法把一条记录拷成文字带到微信 / 飞书 / 邮件，也没法不落盘就先发草稿，对方只是「看一眼给个意见」也得先点接受。这三条是用户明确接受的代价，不是遗漏。也没走「留着发送、只是折进二级菜单」（重复本身没解决，只是藏起来），没走「发送改成复制 Markdown」（用户要的是只剩一项），没顺手扫其它面板的重复入口（只收记录面板这一处）。守卫常量在前端再写一份确实是重复，靠单测直接 import `peer/src/note.ts` 对齐来防漂。

**验证：** 新增 `web/tests/peer-guard-unit.mjs`（6 条：三条上限与服务端同源、正常能发、正文 200_000 / 200_001 字节与多字节边界、标题 200 / 201 与两端空白、截图 24 / 25、同时超时先报正文），挂进 `npm run test:notes` 的第三段；`web/tests/notes-sheet-browser.mjs` 第 15 段改成断言「菜单只剩一项 → 选人在线/离线/排除自己 → 确认页四项 → sendnote + sendfile → 空记录置灰说『先写点东西』→ 正文 210 KB 置灰且 hint 是『正文 211 KB，上限 200 KB』」，并去掉 `/api/peer/send` 的断言。`npm --prefix web run typecheck`（含 i18n 键集比对）通过。`npm run test:notes` 里 `md-input-unit` / `peer-guard-unit` / `notes-rich-unit` 全绿，而 `notes-editor-browser` 与 `notes-sheet-browser` **在本机 origin/main 上就已经红**（`.notes-console` 多出一个 `.fail-wrap` 子元素、编辑器回车那条 `onEnter` 断言），与本条无关；第 15 段因此另用 `.scratch/peer-send-dup/peer-menu.mjs` 探针单独跑过：一项菜单 / 空记录 / 超长正文 / 超长标题 / 25 张图 / 正常提交 / 归档里仍在，全绿，且全程没有 `/api/peer/send`。
## D399 GitHub 通道：一个 `gh` 壳 + 会话级账号，PR 拿回右栏看（#661）

**问题（三件事叠在一起）：**

1. **AI 建的 PR，第一手证据恰恰是页面上点不动的地方。** `gh pr create` 的输出落在工具卡里（纯文本），只有模型**复述**在正文里的裸 URL 才有锚点。而 GitHub 页面永远嵌不进来（实测 `x-frame-options: deny` + `frame-ancestors 'none'`），所以「在应用里看 PR」只能是桥拿 API 重画。
2. **建 PR 这件事完全不经过桥。** 模型自己在 shell 里跑 `gh`，桥既不知道用了哪个账号、也不知道 PR 号，事后也补不回来。
3. **账号是机器级的。** 这台机器上 `gh` 登着两个账号（`Yang-Code01` active、`qingmin-new`），用哪个由 active 决定；想「这一次会话用另一个」只能靠 agent 读文档手搓 `GH_TOKEN=$(gh auth token --user X)`。换个会话就得再记一遍，忘了就是把 PR 建到别人名下。

**为什么不是「给模型一套 `github_*` 工具」**（`bridge/ext/mail.ts` 那条路）：仓库里 41 处文档写的都是 `gh …`（`AGENTS.md` 9、`docs/agents/issue-tracker.md` 25、`whatsnew-write` 技能 7）。换工具要全改，**而且**模型习惯性敲 `gh` 时没有兜底，会退回机器上的 active 账号 —— 正是要消灭的那种失败。

**决定（三层，各管一件事）：**

1. **壳**（`bridge/src/github-shim.ts` → `<状态目录>/github/bin/gh` 与 `gh.cmd`，由 `ensureGithubBin()` 写）：只挂在**桥起的 pi 子进程**的 PATH 最前面（`sessions.ts` 的 `env:`，与 `PI_WEB_LOOPBACK` 同一处）。三件事，顺序不能变：问桥「这个会话是谁」（令牌**一次一取**，不留在子进程环境里，否则一次 `printenv` 就进聊天记录）→ 有真 gh 就带 `GH_TOKEN` 透传、没有就用 REST 实现 PR 核心 → 收尾把 argv / 退出码 / 输出尾巴回报给桥。未实现的子命令退出码 1 且说清「只覆盖 PR 核心」，桥不在 / 不认识这个会话也大声失败。
2. **桥**（`bridge/src/github.ts`）：账号解析 **会话临时选定 > 工作区 `githubAccount` > 全局同键 > gh 的 active**；令牌来自 `gh auth token --user`（10 分钟缓存，绝不同步 spawn）或页面里存的 fine-grained PAT（`dpapi.ts` 加密落盘）；`/api/github/*` 一组只读接口 + 两条 shim 回环口。
3. **页面**：链接卡（工具卡输出 / AI 正文 / **你自己发的消息**三处，滚进视口才要标题）+ `gh pr create` 成功后右栏自动推开面板（`github.pr` 帧）。面板**摘要优先**：标题、一行事实、四格数字（文件 / 新增 / 删除 / 评论）、逐文件一行（点行去 GitHub 看差异），**面板里不铺代码差异** —— 560px 里铺并排 diff 每边只剩 270px，折行反而更难读。

**两条上一轮栽过的坑（写进决定里，别重犯）：**

- **shim 的两条 HTTP 口必须站在 cookie 闸前面**（只认回环对端 + `x-pi-loopback` 会话令牌）。落到闸门后面就会拿到 `unauthorized`，而模型不会停：它会 `which gh` → 检查 `/opt/homebrew/bin/gh` → 最后用 `~/.local/bin/gh` 的真 gh 绝对路径跑通 —— 整套账号机制当场作废。
- **链接卡要挂到工具卡**（AI 自己跑 `gh` 的输出），不只是用户的 `!cmd` 卡；只挂后者的话一个卡都不会出现。

**合并 vs 建 PR**：建 PR 是 AI 的本职活，不拦；把代码合进 main 是人的决定 —— `approval-gate.ts` 的 `SHELL_PATTERNS` 三条路都拦：`gh pr merge`（`gh` / `pr` / `merge` 之间放开，`gh -R a/b pr merge 1` 这类全局参数插中间也命中）、`gh api` 的 `…/merge` / `…/merges`、graphql 的 `mergePullRequest` / `enqueuePullRequest` / `enablePullRequestAutoMerge`，反斜杠续行在匹配前先接回去 —— 只拦一条等于留个后门。与已有的 `git push` 同一机制。面板那颗「合并 PR」因此**不自己打 GitHub**：它把一句话交给 agent（`gh pr merge <n>`），照样过审批闸，而不是第二条写路线。

**两个开关**（设置 → 外观 → 对话，`pi.prefs` 跟着设备走）：`githubCards`（主）与 `githubAutoPanel`。主开关关掉时 `autoPanel` 跟着失效（`githubFeature()`）—— 否则会出现「面板弹出来了、聊天里却一张卡都没有」这种没法理解的状态。

**代价 / 可改：**

- **壳只能影响桥起的 pi 子进程**：终端里的 pi、用户自己的 shell 还是机器上的 active 账号（刻意，不往用户的 PATH 里塞东西）。
- **壳可以被绕过**：它坏了的时候模型会去找真 gh。所以壳失败必须大声失败，这是设计约束不是巧合。
- **`gh auth status` 的文本是解析来的**（新版才有 `--json`）：解析不出来就当作「登录态读不到」，不猜 —— 猜错就是把 PR 建到别人名下。
- **checks 与评论是示例样本**：真 checks 要按 commit 拉 check-runs、真评论要拉 review comments，这一版没做，界面上标着「示例数据」。
- **卡片的标题是异步补的**（滚进视口才请求）：一屏之外的那些卡，标题会晚一点出现。
- **PAT 只在非 Windows 上是明文 + 0600**：Windows 走 DPAPI，换机器 / 换用户解不开，表现为「凭据读不到」，不会静默退回明文。

**spec 评审后补的四条（都是它判 BLOCK 的实盘问题）：**

- **工作区默认账号能写了**：之前只有读端（`githubAccount` 没人写）。新增 `POST /api/github/project-account`（写 `<cwd>/.pi/settings.json`，隧道 403），面板菜单加「设为这个工作区的默认」。
- **没令牌也能读**：壳的内置实现原来一进 `api()` 就 die，连 `pr list` 都读不了公开仓库 —— 与「只能读公开仓库、写需要 PAT」正好相反。现在只有写（非 GET）才拦。
- **点一行文件落到那个文件的差异**：锚点是 `#diff-<sha256(路径)>`，由桥算好放在 `files[].anchor` 里。算法对着真页面核过：`/pull/659/files` 的 HTML 里 `docs/DECISIONS.md` 那个块正是 `diff-1ea199fcea0d29740c9d…`，与桥算出来的前 15 位逐位相同。算错的最坏结果也只是落到 Files changed 顶部。
- **跨仓链接卡不会显示本仓同号 PR**：卡片带 `repo`，`/api/github/pr` 显式传它；之前只传号，桥按会话 cwd 回落，点别人的卡会显示本仓同号的 PR（错数据）。

**第二轮评审（23 条）后补的（都是实盘漏洞，不是格式问题）：**

- **读接口先校验再拼上游**：`repo` 只认 `owner/name`、`cwd` 只认存在的绝对路径且不带 `..`；再加一层 `ctx.sessionCwd` —— 会话存在时以**会话自己的 cwd** 为准，URL 里那个作废。读接口对隧道访客是开着的，这三条是它够不着「任意 GitHub 端点 / 任意目录」的关键。
- **示例样本不再全绿**：checks 掺一条失败、一条在跑，评论人换成 `octocat` / `hubot`。编的 CI 与挂在真人名下的假评审最容易被人当真（样本本身是这版的决定，不删）。
- **壳的测试缝改走 identity 响应**：壳跑在 pi 子进程底下，而 `piChildEnv()` 会剥掉所有 `PI_WEB_*`，原来那条 `PI_WEB_GITHUB_REAL_GH_JS` 分支实际不可达；名字统一到桥里已有的 `PI_WEB_GH_JS`。
- **起会话的那几处兜底**：PATH 覆盖**已有的键名**（Windows 上通常叫 `Path`，否则壳目录静默失效）、`ensureGithubBin()` 写盘失败只 warn 不让会话起不来、删掉没人读的 `PI_WEB_GITHUB_SHIM`。
- **面板四条**：换 PR（含换仓库）时清 `detail`、列表带上 `repo`、checks 的分子改成**通过**条数、账号菜单关的时候把 document 监听一起摘掉。
- **两张请求键缓存加上限**（`CACHE_MAX=200`，FIFO）：键来自请求，只靠 TTL 不管大小，长跑的桥会慢慢吃内存。

**两份解析器是刻意留的**：桥的 `seenLinks()` 与页面的 `ghLinksIn()` 跨包，共享要新造第三处分包。代价用一条测试兜住 —— `bridge/tests/github-e2e.mjs` 里「口径一致」那条拿六组样本比对两边的 `kind|repo|id`，分叉就红。

**验证：** `npm run test:github` 三段共 50 条 —— 桥的 HTTP 面 28 条（账号解析四种来源的优先级、工作区默认账号的写与读、逐文件锚点、跨仓 repo 透传、`repo`/`cwd` 校验与「会话 cwd 优先」、两份解析器口径一致、仓库识别、PR 列表/详情的归一化、没有远端时 409、上游 401 映射、隧道写 403、卡片缓存命中、PAT 存取与删除、shim 身份与记账三种帧）；前端纯函数 10 条（链接识别去重与标点、相对时间四档、`+/−` 文案、两个开关默认值与连坐、两个新帧不改纯视图状态）；壳 12 条（没令牌时还能读公开仓库、写才拦；令牌交到真 gh、`pr create` 链接回报、退出码透传、没 gh 时内置实现真建 PR / `pr list` / `pr view --json` / `pr merge`、未实现子命令明确失败、没 origin 时明确失败、桥不在说人话、PATH 注入且本机 PATH 没被动过）。`npm run typecheck` 全绿（含 37 条新 i18n 键、`test:viewport`、`test:layers`、`test:theme`）。真机冒烟（隔离实例，真 gh 真令牌）：默认 `gh api user --jq .login` → `Yang-Code01`；会话切到 `qingmin-new` 后 → `qingmin-new`；`gh pr view 659` → 桥发出 `github.seen` 并认出 pull #659；面板接口真数据（20 条开着的 PR、#659 `+105 −21`、5 个文件）。

## D400 代码评审：OCR 的确定性分片 + 一次性只读 pi 子进程（#651，grill 结论 2026-11-23）

**问题。** 改完之后没有任何地方能回答「这次改动有没有问题」。现在只有两条路：开 PR 等人看，或者在会话里让 AI 顺手读一遍 diff。后者是粗放的 —— 模型的上下文只装得下它自己挑的那几段，跨文件、跨模块的问题它看不见；结论只活在聊天记录里，没有落盘、不能逐条处理、重跑一次全重来、也没人知道上次那批意见后来怎样了。

**决定。**

1. **用 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（CLI 名 `ocr`）的 delegation mode，不用 native mode。** 只有两个子命令进链路：`ocr delegate preview` 给出「这次评哪些文件、基准提交是谁、哪些被排除及原因」，`ocr delegate rule <paths>` 给出命中的规则文本。**评审推理不归 OCR** —— 那是我们自己的模型。
2. **推理跑在一个一次性的 `pi -p --mode json` 子进程里。** 不是 `--mode text`（那种没有工具，读不了 diff）；不是当前会话（评审要对**任意仓库**跑、要能中断、不该占用户对话的上下文）；也不是每跑一次开一个新会话（左栏会长出一堆「评审」会话）。
3. **子进程只读，由 argv 保证：** `--tools read,bash,grep,find,ls`（整份替换默认工具，`edit`/`write` 根本不存在）、`-nc` 不读 AGENTS.md、`-ne` 不加载任何扩展、`--no-session`。评审改不了工作区，也不靠提示词求它别改。
4. **串行。** `preview` 给的分组按顺序一个子进程走完，结果合成一份。不做每组一个进程的并发：那要把桥同时养几个 pi 进程，内存与额度都成倍，而收益只是墙钟。
5. **三种范围都进面板**：工作区改动 / 分支 vs 主干（`--from <base> --to HEAD`）/ 单个提交（`-c <sha>`），与 `delegate preview` 的三种模式一一对应。
6. **面板是右栏第四颗页签**（`QueueTab` 加 `"review"`），300px 宽：文件分组 + 一行一条 + 就地展开代码与建议。**不在栏里画 diff** —— 点 `文件:行` 打开分支操作工作台的「差异」页签，选中那个文件并把命中的那行标出来。
7. **意见的身份是 `path + 类别 + 命中的代码片段`**（正是 OCR 自己 `session compare` 的口径）：不用行号（改一行就全漂）、不用文案（界面切语言就被重写一遍）。处理态（接受 / 忽略 / 误报）按这个键记在**仓库**上，跨轮次；重跑分 新增 / 仍在 / 已解决。
8. **落盘按仓库一份**（`<状态目录>/review/<repoKey>.json`），历史**全留**，另给一颗「清理历史」；`repoKey` 走 `realpath` —— macOS 上 `/tmp/x` 与 `/private/tmp/x` 是同一个仓库，不归一就会落盘分家。
9. **`ocr` 是可选件。** `scripts/bootstrap.mjs` 在 `npm install` 时检测一次（缺了或 < 1.9.0 就装一次，与 pi 本体同一口径），装不上只写进 `bootstrap.json`，**不把整次安装判红**；面板里另有一颗「装 ocr」，输出流进面板。
10. **没有闸。** 隧道 / 局域网访客同样能发起评审。这是**有意例外**：仓库里其它重口（`ask-user`、`open_preview`、邮箱工具口）全是 loopback-only，分支工作台的写操作才按 D240 开到「登录后本机 / 局域网 / 公网」。评审比它们都重（起本机进程、读任意源文件、烧额度），仍然选了不设闸。**风险照实写在这里：拿到隧道 URL 的人（cloudflared 的域名会泄漏、可枚举）能跑评审、读本机代码、花你的额度。** 要改这一条，先改这条记录。
11. **意见文案跟界面语言走**（`getLang()` 写进提示词），每条记下语种；**界面文案**仍走 `tr()` 三语。切语言后旧意见保留原文，但按第 7 条仍认得出来。
12. **`too_large` / 超预算没评的文件必须显式列出来**（`preview.excluded_files` 与模型自己报的 `skipped` 合成一张表），点开看原因。静默丢掉等于说谎。
13. **「停止」= 杀子进程 + 保留已收到的**（整次标 `stopped`）；桥重启时盘上写着 `running` 的一次性转 `stale`（开机 `sweepStaleRuns()`），面板说「重跑一次就行」。
14. **顺手补了 `/api/git/diff` 的「工作区」模式**（`worktree: true`，右侧直接读盘、未跟踪文件从 `ls-files --others` 补）。原来它只会比两个提交，于是「工作区改动」那次评审的意见跳过去只能看到「两边没有差异」。

**修订（2026-11-24，默认 PR + PR 检索 + 来源说明 + 详情 dialog）。** 用户在测试里提了五条，落成：

1. **默认范围改成「GitHub PR」**（`reviewView` 的 `mode` 缺省值）。另外三种范围（工作区 / 分支 / 提交）仍在，但主用法是从 PR 里挑一个来评。
2. **PR 可检索**：检索框按 `#号 / 标题 / 头分支 / 基分支 / 作者` 过滤（大小写不敏感、带不带 `#` 都认），列表旁边写「N 个 open PR」。几十个 PR 时不用在一长条下拉里翻。
3. **来源说明**：面板底部常驻一行「评审内核：阿里巴巴开源的 open code review（ocr）／以后会接入更多评审方式」——这不是本仓库自研的东西，别让人以为是；也给「以后接别的评审内核」留了位置（D398 第 1 条只锁了「现在用谁」）。
4. **时间线 + 详情 dialog**：桥把每件事写成一行日志（开始 → 取 PR → 分片 → 每组开始/完成 → 完成/失败），**并且落进这次记录**（进度帧走完就没了，不落盘的话跑完就看不到）。面板里显示最后 4 行 + 「查看详情」；dialog 左边全量时间线、右边结果（意见 / 没评的文件 / 已解决），跑着时实时刷新、跑完就是完整结果。
5. **「什么都没答」先重试一次**：某组退出码 0 但一句话没给（工具调用把轮次/上下文吃掉）时，追加一句「别再调工具，直接交 JSON」重跑该组；仍为空才判 `child_no_output`，并在错误里写清「已用 Nk token，可以换更便宜的模型或缩小范围」。

**修订（2026-11-24，分组跑 + 「没答」不算成功 + 跑完给提示）。** 用户报「不确定有没有真正评审成功，没有信息提示」，查下去发现三次 PR 评审都是 `done`、**0 条意见、0 token**：31 个文件一次塞给一个子进程，它把 46 万 token 花在满仓库逛、最后**一个字都没答**，而 exit code 是 0，于是被记成了「完成」。四处改：

1. **分组**：`GROUP_FILES = 8`，一个子进程评一组（`chunkFiles()`），串行跑完再合并 —— 这也是 D400 原本写的「串行跑完所有分组」，之前只写了没说清是一组一个进程。
2. **退出 0 但一句话都没答 = 失败**（`child_no_output`），不能记成「完成」；某一组非零退出也记失败并保留已完成那几组的意见。
3. **跑完弹一句**：完成 N 条（带严重/高计数）、一条没有、失败原因、已停止 —— 只提示**本页签发起**的那一次。
4. **提示词收紧**：先看 diff，判断不了才读整个文件，别在全仓检索无关代码（那次 46 万 token 大半花在这上面）；`run` 记录补上 `from`/`to`/`mergeBase`（以前 `finish()` 只 patch 部分字段，盘上留着初始值，看起来像「评的是 main 工作区」）。

实测（本仓库 PR #640，5 个文件）：分组后 **4 个文件 / 136 秒 / 61.8 万 token / 6 条意见**，不再出现空答复。

**修订（2026-11-24，选分支 + 评 GitHub PR）。** 范围从三种变成四种：多了「GitHub PR」。

1. **分支范围改成两把下拉**（目标 / 对照），候选来自 `api.gitRefs` 的本地 + 远程 ref，`HEAD` 永远在第一项。以前对照侧是一个带补全的输入框、目标恒 HEAD —— 评不了「另一条分支 vs 主干」。
2. **PR 的代码取到本地再评**：`gh pr view N --json baseRefName` 知道对照分支 → `git fetch origin refs/pull/N/head:refs/pi-web/pr-N --force` + `git fetch origin <base>` → 走「范围」同一条链路（`--from origin/<base> --to refs/pi-web/pr-N`）。**不动工作区、不动当前分支**，只往 `.git` 写一条 `refs/pi-web/pr-N`。为什么不只拿 `gh pr diff`：`ocr delegate preview` 认的是本地 ref，拿不到分片就丢掉这次评审最值钱的那一半（确定性分片 + 排除原因）。`refs/pull/N/head` 对 fork 来的 PR 同样存在，所以不需要知道 fork 的仓库地址。
3. **PR 列表**在切到 PR 模式时由桥跑一次 `gh pr list --state open --limit 30`，按仓库缓存 60 秒；失败分四类说人话（`gh_missing` / `gh_failed` / `no_remote` / `not_github`），列表拉不到时号输入框照样能用（`gh pr view` 对已合/已关的 PR 也工作，所以手输老号能评）。
4. **落盘多了 `pr` 字段**：三态只跟**同一个 PR 号**比；`range` 改成「目标与对照两侧都对上」才算同一件事（以前只比对照分支，换个目标分支会把整批意见写成「已解决」）。

代价：PR 模式要联网 + 本机 `gh` 已登录；`refs/pi-web/pr-N` 评完不删（重跑省一次 fetch，`git fetch --prune` 也不会动它，要清得手删）；关闭/合并的 PR 不在下拉里，只能手输号。

**修订（2026-11-24，模型 chip 复用现成的弹层）。** 面板上那颗模型一开始是自画的 `<select>`，与输入框那颗 chip 各说各的。改成复用输入框背后同一个「模型与思考」弹层：`openModelSheet(false, { start, onPick })` 多一条 **pick 模式** —— 确认时把挑中的模型交回面板、**不发 `setModel`**，所以不看会话有没有写入权；默认落在「全部模型」并把所有来源展开（否则开场是一排折叠标题），提示语也从「这个会话没有写入权」换成「点一行挑一个评审用的模型」。代价：`openModelSheet` 多了一个可空参数与三处 `pick` 分支；「本会话 / 思考档位」这两个面板在 pick 模式下仍然画着，但只影响草稿、不影响评审子进程（它固定 `--thinking low`）。

**为什么。**

- **delegation 而不是 native**：native 要多一份 API key、一份独立账单，还和页面上的模型选择器脱节；delegation 复用当前 pi 的模型目录，换模型即全局生效。
- **一次性子进程而不是会话**：面板对的是「当前会话所在目录」，但评审不该绑定那个会话的生命周期；子进程死了只是这一次失败，不会弄脏用户正在聊的上下文。
- **身份用代码片段而不是行号**：重跑的场景就是「代码变了」，行号必然漂；而同一段代码被重新缩进不该算新问题。文案会因语言而变，代码不会。
- **显式列出没评的文件**：这台机器上 OCR 会把超过提示预算的文件整份丢掉（`too_large`），组超预算也会 skip —— 不列出来，用户会以为评全了，那比不评更危险。
- **串行**：`--effort` 与并发都不是免费的；一次评审三十秒到几分钟，可接受，而并发要养多个 pi 进程与多份 token。

**代价 / 可改。**

- **召回率是按设计调的低的**：OCR 官方明说以精度换噪音，规则集（NPE、线程安全、MyBatis SQL）是 Java 场景练出来的 —— 本项目是 Node + TS，「规则命中」那一块的收益有限，真正拿到的是确定性分片与行级锚点。别拿「它应该发现所有问题」当验收标准。本机实测（一个 13 行的 demo 文件）：三次跑分别出 2–4 条意见、7–10 秒、9.1–9.8k tokens，命中率与措辞每次都略有不同。
- **只看 OCR 内置规则**：不往提示词里塞本仓库 AGENTS.md，也不落 `.opencodereview/rule.json`。所以它会报一批「本仓库故意这么做」的写法（`tr()` 包一层、多轨 `grid-template-rows`）。噪音大到不能忍时，正确的出口是给仓库补一份 `rule.json`（另立一票），而不是把 AGENTS.md 塞进提示词。
- **没有闸**：见决定 10。想改的话最小改动是「未登录只读」。
- **历史全留**：一个仓库跑几十次之后文件会很大；「清理历史」只清评审、**保留**处理态（那些是「这条我判过了」）。
- **工作区模式没有行号**：分支工作台的差异视图本来就不带行号（`lines` 只有左右两格文字），所以「定位到行」是靠**匹配那段代码**实现的；代码在 diff 里找不到时只选中文件、不标行。

**没做。** native mode / CI 门禁。把意见发成 PR review comments。一键应用建议改代码。每一轮自动评审。评审历史跨机器同步。`.opencodereview/rule.json`。替换现有 `code-review` 技能（那个走「标准/规格」两轴，与这条不是一件事，见 GLOSSARY 的「两轴自审」）。

**验证。**

- 单元：`bridge/tests/review-unit.mjs` **21 条**（preview 解析用真实 `ocr 1.14.2` 的输出抄成 fixture、提示词、子进程 argv 的只读工具面、模型输出归一、`findingKey` 的稳定性、三态匹配、落盘全留）；`web/tests/review-unit.mjs` **13 条**（视图模型的六种态、分组与排序、未锚定的排最后、没评的文件、历史计数）。
- 真链路（macOS，`ocr 1.14.2`，`pi 1.6.0`，默认模型）：`/tmp` 下一个 13 行的 demo 仓库，workspace 模式 **36 秒 / 10.3k tokens / 4 条意见**（high×3 + medium×1，行号与类别都对）；停止路径立刻标 `stopped`；伪造一次 `running` 后 `sweepStaleRuns()` 转 `stale`。
- 探针 `probes/code-review.mjs`（真 Chromium + 隔离真桥 + 真 ocr）**12 项全过**：没装 ocr 的屏给安装命令且「开始评审」置灰；真跑一次 → 意见分组落进栏里、带严重度与耗时/token；展开看「交给 AI 修」；点 `文件:行` 打开分支工作台的「差异」页签（标题是新增的「变更文件 · 工作区改动」）并标出命中行；「交给 AI 修」把话放进输入框；中途停止标「没跑完」；字号 150% 下按钮仍在视口里。
- `npm run typecheck`（bridge / peer / web + i18n-check + viewport + layers + spawn-hidden）通过 —— 顺手修掉了 main 上已经红着的两处 i18n（`出厂默认` 是没人用的键、`正在翻 {k} 块` 缺 en/ja），否则这次没法判绿。
- **全量套件没有全绿，原因不在这一票**：`npm run test:all` 在这台 macOS worktree 上 137/170 通过，剩下 33 个逐个查过 —— 同一批在 main 检出上跑同样红（`dirpage` 的盘符断言、`gitops-unit` 的 git 输出比较按英文写死而本机 git 是中文、worktree 里 `bridge/dist/core/trust-manager.js` 解析不到的 `repos-ui` / `git-history-ui`、以及 `tools/playwright.mjs` 只找 `~/npm-cache/_npx` 而 macOS 的 playwright 在 `~/.npm/_npx`，需 `PW_PATH=` 才行）。唯一与 main 有差的是 `deps-ui`（陈旧断言「三个包」），而它已被 main 上的 #652 改成「四个包」—— 变基过来之后即通过。与本票相关的四个面（`deps-ui`、`gitops-unit`、`git-history-ui`、`i18n-ui`）单独重跑的结果与 main 一致。

## D401 链接卡上那颗「代码评审」：只填号不开跑、跨仓不评；建完 PR 默认不再自动开面板（#666，grill 结论 2026-11-24）

**问题。** 两件都不顺。一、AI 跑完 `gh pr create` 右栏面板自己推开（`githubAutoPanel` 默认开），正要看别的东西时被抢栏位，想关掉得进一次 设置 → 对话，换个浏览器又回来。二、聊天里的**链接卡**点开只能看摘要，想评这次改动得自己跑到右栏切「代码评审」、把号记下来再填进去 —— PR 就摆在眼前，却没有「评它」这一下手，而评审面板本来就默认「GitHub PR」那一档。

**决定。**

1. **`githubAutoPanel` 的默认值翻成关，且只认显式的 `true`。** 老用户（存过 `pi.prefs` 但没有这个键）跟着新默认走关，不会出现「只有全新浏览器才是新默认」。D399 里「两个开关默认都开」那段被这一条改掉一半；主开关 `githubCards` 的默认与连坐不变。
2. **PR 卡拆成「主区 + 右缘一颗「代码评审」」，两块是兄弟不是嵌套。** `button` 套 `button` 是非法 DOM，点击还会冒泡到主区。只有 PR 卡有这颗钮 —— issue 没东西可评，commit 这次不做入口。
3. **点它只把号交过去，不自动开跑**：关掉挡着的 GitHub 面板（两扇都是右栏 dock）、右栏收着就展开、范围设 GitHub PR、号填好，然后切到评审页签。评审要几分钟、烧模型额度、同一仓库同时只允许一次评审 —— 误点的代价是钱和时间，开跑这一下留给「开始评审」那颗按钮。
4. **跨仓的卡不评，前端灰掉 + 桥上兜底拒。** 根因是评审在**会话目录**里跑：`gh pr view <号>` 与 `git fetch refs/pull/<号>/head` 都拿 cwd，拿别仓的卡去点，会静默评成本仓同号那只（D399 记过完全同类的错数据）。判据是 `/api/github/state` 的 `repo` 与卡片链接里的仓库名，大小写不算差异。**判据还没问回来时按钮先亮着**：宁可点到后由桥拒并说明理由，也不要让人看到一屏灰钮再齐刷刷变亮。桥上 `review.run` 多一个可选 `expectRepo`，在解析 PR（也就是 fetch）之前比对本地 origin 的仓库名，不符就抛 `pr_foreign_repo`；字段缺省时行为完全不变（手输号、别的入口不受影响）。
5. **判据按 `会话id|cwd` 缓存**，到手之后重刷已经画出来的钮（不重画聊天：历史里几十张卡重绘一次太贵）。这一发 `/api/github/state` 是**按需**打的 —— 只有真的画出了 PR 卡才会问。
6. **建完 PR 不再加任何提示**（吐司 / 高亮都不加）：卡片就挂在 `gh pr create` 那张工具卡的输出下面，右栏不动。
7. **文案走 `tr()`**，中英日同键；桥拒的那句用 `bridge.err.pr_foreign_repo`（带 `{p1}`/`{p2}` 两个仓库名），中文界面直接看桥写的 message。

**为什么。**

- **默认值一刀切**：半新半旧（老用户开、新用户关）要长期维护两套口径，而这一项随时能在设置里一键打开。
- **右缘竖排而不是标题行一颗小钮**：点击区更大、和「看摘要」的主区一眼分得开；窄栏（右栏展开）下宽度固定 82px，不跟标题抢伸缩。
- **不在卡片上直接开跑**：见决定 3；而且「已经在跑」会从罕见错误变成常见错误。
- **桥上也拦一道**：前端那句「判据没到先亮着」留了一个真能点进去的窗口，别的入口以后也可能长出来；评审评错号的代价是给出一份**看起来正常**的错误结论，比报错贵得多。

**代价 / 可改。**

- **多一发 `/api/github/state`**（每个会话一次，按需）：换来的是跨仓卡在点之前就灰掉。想省掉它就得让判据晚到、只靠桥拒。
- **卡片结构变了**：三条挂卡路径（工具卡输出 / AI 正文 / 用户消息）一起改，任何一条的排版回归都要靠探针发现。
- **GitHub 面板开着时那颗钮其实点不到**（面板贴在视口右缘，正好盖住卡片右缘）—— 「点钮顺手关面板」因此是防御性的；面板能拖窄到 380px 之后仍然盖住，留着这一段是为了以后布局变化时不用想。
- **没做**：commit 卡评那个提交、issue 卡的任何入口、从 GitHub 面板跳到评审、跨仓库评审、自动开跑。

**验证。**

- `web/tests/github-unit.mjs`：默认值翻转 + 乱值不算开；`reviewAffordance()` 四种组合（同仓 / 跨仓 / 判据空 / issue 卡，大小写不敏感）。
- `bridge/tests/review-unit.mjs`：`expectRepoMismatch()` 六种输入；`startReview()` 拿别仓的号**在 fetch 之前**就抛 `pr_foreign_repo`，且不落状态文件。
- `probes/github-card-review.mjs`（真桥 + 假 gh + 真 Chromium）**22 项全过**：判据未到时两张卡都是亮的；判据到了同仓可点、跨仓灰掉且 title 里两个仓库都在、issue 卡不拆结构；点主区照旧开 GitHub 面板；折叠右栏后点那颗钮 → 展开 + 切页签 + 填好 `#661` + 没有「中断评审」+ 状态目录里没有评审记录；灰钮点了什么都不发生；设置里「建完 PR 自动打开面板」默认关、点一下能开、刷新后还在。
- `npm run typecheck`（bridge / web，含 i18n-check 与 viewport / layers 守卫）与 `npm run build` 通过。

## D402 评审要出网的那两步：直连 → 代理候选 → 现探本机 → 整轮重试，失败时把每条路都写出来（#668，2026-11-25）

**问题。** 用户点「代码评审」，几秒后右栏「评审详情」是 `失败`，结果栏只有一句 `error: RPC failed; curl 56 Recv failure: Connection was reset`。根因不在评审的分片与模型那半边，而在**取 PR 提交**这一步：`gitpr.ts` 的 `run()` 把 `process.env` 原样交给 `git`/`gh`，也就是「只有直连一条路」—— 直连被中间设备重置/掐断时没有第二个候选、也没有重试，整次评审就死在这一步，界面看到的是 git stderr 的首行。热部署早就按 D376 做了「候选顺序 + 每路限时 + 整轮重试」，评审一直没跟上。

**决定。**

1. **新增 `bridge/src/netroute.ts`：候选发现 + 通用路由。** 第一段候选是「有人明确说过用哪个」：pi 设置 `httpProxy` → 系统代理（win 注册表 / macOS `scutil`）→ 进程 env 的 6 个代理变量（`HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`/`ALL_PROXY`/`all_proxy`，大小写各一份），同一代理只留一次。**这段里没有写死的端口**（D272）：热部署那份实现尾部挂着的 18791 是历史遗留，评审不再照抄。与 `scripts/hotdeploy-git.mjs` 的另一处有意差异是不认 `BILLION_CONTEXT_PROXY` —— 那是模型网关的占位主机名（`http://billion-context.inline`），本机实测它排到第二位、真去连只会白等满 90s。两份实现而不共用的原因：bridge 是 TS、单测直接 `--experimental-strip-types` 跑源码，`scripts/` 不在 `bridge/tsconfig.json` 的 rootDir 里；顺序与这条差异由 `bridge/tests/netroute-unit.mjs` 锁住，改一处必须改另一处。
2. **第二段是现探：谁都没配、直连又挂了，就看本机在听什么。** `listListeners()` 拉一条 `netstat -ano -p tcp`（macOS `lsof -nP -iTCP -sTCP:LISTEN -F n`、Linux `ss -ltn`），只留环回与通配（通配归一到 `127.0.0.1`），按端口排、一次最多探 64 个；`probeHttpProxy()` 对每个端口发一个不依赖本机 DNS 的 `CONNECT example.com:443`，回 `200`（同意开隧道）或 `407`（要鉴权，但确实是代理）才算命中，400/404/405 这类普通 HTTP 服务一律不算。全部并行、每个 400ms 上限；结果在进程里缓存 60s。写死端口的替代品不是「猜更多端口」，而是**问机器现在在听什么**。
3. **`viaRoutes()` 的顺序与时限**：直连（先摘掉进程里挂的代理变量，并置 `GIT_TERMINAL_PROMPT=0`）→ 第一段候选 → 还没有才调 `discover` → 全失败且有路可试时等 3s 整轮重来。每路限时（fetch：直连 20s / 代理 90s，两轮，总预算 240s；`gh` 小请求：20s / 40s，一轮，70s），总时长封顶用 deadline 夹住单次超时。一条代理都没有（配置空、现探也空）时不空转重试 —— 那只是把同一件事再做一遍。现探只在「前面全挂」时才跑：直连就通的机器不会为这件事花一次 `netstat` 加 50 次端口试探。
4. **连 `gh pr list` / `gh pr view` / `gh pr view --json …` 一起走路由**：同一台机器上，fetch 要走代理就意味着 `gh` 也得出得去；否则面板列不出 PR，评审仍然开不了。候选函数是**惰性**求值的：直连就通的机器不会为了探代理去读注册表。
5. **失败信息汇总每一次尝试**，格式 `直连：<原因>；代理 <url>：<原因>`，并前置「取不到 PR #N 的提交：」。用户不再只看到一句 Connection was reset，而能看出「直连被重置、代理没起来、本机也没探到代理」这种可操作的组合。取 PR 提交单独提成 `fetchPullRequestRef()`，成为测试与文案的落点。
6. **`RouteOptions` 只给测试用**（钉死候选、现探结果与计划）：否则测试会去探本机系统代理和在听端口，结果跟着机器上装了什么跑。

**为什么。**

- **现探而不是写死端口**：写死一个端口等于把「哪台机器上能用」编进代码 —— 18791 在本机早就不在听，换台机器更是赌运气。端口该由机器自己回答：谁在听、听的那个是不是 HTTP 代理，一次 `CONNECT` 就问出来了。代价是这一小段代码只在本机跑（不在别人的 CI 里），所以把 `listeners` / `probe` 都做成可注入，测试用假数据锁协议。
- **现探放在最后一步**：它能发现的东西是「用户没告诉我们的」，可信度天然低于显式设置；而且它有实打实的成本（一次进程调用 + 几十个端口并行试探）。等到前面全挂再花，是唯一不白花的位置。
- **重复一份候选顺序而不是抽公共模块**：`scripts/` 不在 bridge 的 tsconfig `rootDir` 内，抽出来要么改构建拓扑、要么让 bridge 依赖 dist；两份各几十行、由测试对齐，比动构建便宜。这条与 D376 同源，早晚该合成一处，届时以 `netroute.ts` 为准把 hotdeploy 改过来。
- **失败时汇总而不是取首行**：这次现场的首行恰好是最不具信息量的一句；「直连挂在哪、每个代理挂在哪」才是用户能据以行动的。代价是错误文案变长（右栏详情框能换行）。
- **不做 SSH-443 换传输（D377）**：那条路要本机 SSH key 可用，评审的默认用户没有；这一轮先把「有代理就走代理」补齐。

**代价 / 可改。**

- **现探只在失败路径上花钱**：一次 `netstat`（本机实测约 30ms）+ 最多 64 个端口的并行 `CONNECT`（实测本机 50 个监听 696ms），结果缓存 60s。最坏情况仍是 4 分钟预算封顶（评审本来就要几分钟，可接受；`gh` 小请求 70s）。
- **会向本机在听的服务发一个 `CONNECT`**：只发一行就断开，400ms 上限；但确实会碰到路径上无关的本地服务。想更保守就把 `limit` 调小，代价是排在后面的代理探不到。
- **代理 URL 一律 `http://`**：探测只认 HTTP `CONNECT`，纯 SOCKS 端口探不出来（Clash 这类 mixed 端口两样都收，不受影响）。
- **`pr_foreign_repo` 等既有错误码不变**：路由失败仍然归到 `pr_fetch_failed` / `gh_failed`，前端文案无需改。

**验证。**

- `bridge/tests/netroute-unit.mjs`（纯逻辑）：代理 URL 归一；Windows 的两种 `ProxyServer` 写法与 macOS `scutil` 解析；候选顺序与去重且**没有默认端口兜底**；`readPiHttpProxy()` 读临时 `PI_AGENT_DIR`；`directEnv()` 摘 6 个代理变量但不动 `NO_PROXY`；`proxyEnv()` 同写 6 个名字；`parseListeners()` 三家输出（netstat / lsof / ss）与通配归一；`probeHttpProxy()` 对真 TCP 服务验 200 / 407 / 404 / 哑端口；`discoverLocalProxies()` 的端口序、限额、探测抛异常；`viaRoutes()` 的直连短路（不探代理）、候选顺序、**现探只在候选全挂后调用一次**、现探与已配重复时不重试、`discover` 抛错不进错误汇总、整轮重试与原因汇总、无候选不重试、单次超时被预算夹住、attempt 抛异常算失败。
- `bridge/tests/gitpr-fetch-route-e2e.mjs`（真 git，离线）：坏 origin（`info/refs` 正常、POST `git-upload-pack` 回 200 后重置 TCP）复现用户那句 stderr；配好 `httpProxy` 时 `fetchPullRequestRef()` 自己绕到正向代理上把 `refs/pull/636/head` 取回且与被评提交一致；没配代理时报错里带 `直连：error: RPC failed; curl 56 Recv failure: Connection was reset`；谁都没配时靠现探那一步把提交取回来。
- 真机：`listListeners()` 在本机列出 50 个环回监听，`discoverLocalProxies()` 只用 696ms 就从中认出 `http://127.0.0.1:7899`（唯一命中）；`PI_AGENT_DIR=<临时目录，httpProxy=http://127.0.0.1:7899>` 下 `resolvePullRequest(<本仓>, 636)` 取回 `refs/pi-web/pr-636`（3.7s）；`npm --prefix bridge run typecheck` 通过。

## D403 正文里只写号的 PR（「PR：**#669**」）也出卡：猜出来的那张必须被桥证实，证不实就整张撤掉（#670，2026-11-25）

**问题。** 一次 `/review-followup` 的会话收尾时 AI 写「已修完并开了 PR：**#669**」，回复里**没有卡片**。卡片一直只认完整 URL（`ghLinksIn()` 的 `LINK_RE` 要求 `https://github.com/<owner>/<repo>/pull/<n>`），而模型转述已经做完的动作时习惯只写号。同一会话的工具卡输出里确实有那条链接、也确实画了卡 —— 只是它已经被滚到上一屏，用户看到的最后一句什么都没有。

**决定。**

1. **「PR / pull」后面紧跟的号也出 PR 卡**：`PR #669`、`PR: #669`、`PR：#669`、`PR#669`、`PR：**#669**`（全角冒号、加粗的号都认）。正则 `REF_RE = /(?:\bPR\b|\bpull\b)\s*[:：]?\s*(?:\*\*|__|`)?\s*#(\d{1,7})(?![\w-])/gi`。
2. **裸 `#669` 不认。** 本仓库 issue 与 PR 共用一套编号，`#669` 可能是任何一个；把 issue 号画成 PR 卡，就是 D399 记过的那种「看起来正常的错数据」。宁可少一张卡，不要一张可能错的卡。
3. **仓库取本会话仓库**（`/api/github/state` 的 `repo`）。判据还没回来时**先画一张只有号的卡**，`refreshGithubCards()` 到货后补上 `link.repo` / `link.url` 再开始取标题 —— 不为等一个网络答复先把正文留空。
4. **猜出来的卡必须由桥证实。** `/api/github/card` 回 `pull: null`（不是 PR / 不存在）就**把整张卡从 DOM 里摘掉**；URL 给的卡失败时照旧留一张「取不到标题，点开看」的残卡 —— 那是有依据的链接，删了等于吞掉用户自己贴的东西。
5. **URL 优先、同号去重。** 同一段文本里既有该 PR 的链接又有转述时只画 URL 那张（有依据的先画）；去重按 `仓库#号`，**别仓同号不吞掉本仓的猜测卡**（跨仓同号是两件事）。
6. **卡片上的评审钮与「点开」读 `link.repo` 的当时值**，不再在建卡时复制一份 `repo`：猜测卡的仓库是晚补的，复制出去就会永远灰着或点错仓库。

**为什么。**

- **符号（`PR`）而不是形状（`#n`）才是判据**：模型写「PR #669」时已经说出了类型，这是唯一能白拿的线索；只贴号时它没说，代码就不该替它猜。
- **猜错要撤，不能留残卡**：留下的残卡会长期显示一个不存在的 PR，比没有卡更误导；而「先画后撤」比「等证实再画」快 —— 卡片出现的位置就在原位，撤掉时正文自然回流。
- **不额外发一次探测**：`/api/github/card` 本来就要为卡片标题发一次，猜测卡复用它当判据，没有新增往返。

**代价 / 可改。**

- **`PRs #12` 这种复数写法不认**（`\bPR\b` 在 `PRs` 里没有词边界）。要么放宽成 `PRs?`，要么就这样 —— 现在选后者，等真的踩到再说。
- **猜测卡有一段「先有号后有标题」的过渡**：判据到之前 `.ghlink-title` 是空的，只有号与「点开在右栏里看」；这段时间点它什么都不做（没有仓库可开）。
- **撤卡依赖 `/api/github/card` 的答复**：桥那边网络挂掉时答的也是 `null`，于是猜测卡被撤。方向是故意的 —— 猜的东西，证实不了就当没有。
- **没做**：`commit b8fe7e8e` 这种只写短 sha 的转述、`#669` 裸号。

**验证。**

- `web/tests/github-unit.mjs` 21 项：全角冒号 + 加粗的号、`PR #12` / `PR: #13` / `PR：#14` / `pull #15` / `PR#16` / 一行两个 / 同号去重；裸 `#669`、`issue #7`、`http://127.0.0.1:7864/#669` 一律不出卡；仓库未到时的空 repo 形态；`ghCardLinks()` 的三条去重规则与 `max` 截断。
- `probes/github-card-review.mjs`（真桥 + 假 gh + 真 Chromium）26 项全过：新增的四项是「正文里只写 `PR：**#669**` 也出卡」「猜出来的卡补上本会话仓库、真取到标题」「猜出来的卡也是同仓，评审钮可点」「号对不上真 PR 的 `#424242` 自己撤掉」；原有 22 项（判据未到先亮、跨仓灰掉、issue 不拆结构、点主区开面板、折叠右栏后点钮、灰钮点不动、设置默认值与持久化）不变。
- 真机：把用户那句原文（`4 条都核实成立，已修完并开了 PR：**#669**（…）`）喂给 `ghCardLinks()`，得到 `pull #669` 一张猜测卡。
## D404 评审面板「评什么」属于会话：换会话就整组回默认值（#674，2026-11-25）

**问题。** 用户报「评审信息串会话」：在会话 A 把 PR 号填成 `#661`，切到会话 B（另一个仓库）打开右栏第四颗页签，号还在。点「开始评审」，桥会拿 `#661` 去评 B 目录的仓库 —— 号碰巧存在就出事更糟：得到一份**看起来正常**的别人的结论，没有任何报错。根因是 `syncReviewSession()` 只清了「响应 / 进度」那一半（`reviewState`、`reviewProgress`、`reviewError`…），输入区那组字段（`reviewMode / reviewBase / reviewTarget / reviewCommit / reviewPr / reviewPrQuery / reviewPrInfo / reviewPrs* / reviewRepo / reviewRemoteRepo / reviewRefs`）是 App 级的，从没被清。

**决定。**

1. **「评什么」= 会话级**：切会话（或会话目录变了）时整组复位到默认值 —— PR 模式、base `main`、target `HEAD`、号为空、`prInfo` 空、PR 列表 / 仓库名 / 分支名册作废。复位点就是 `syncReviewSession()`，它已经是面板每次渲染的第一句；不新增第二处「记得清一下」的地方。
2. **偏好不在此列**：`reviewOcr / reviewInstalling / reviewInstallLog`（这台机器装没装 ocr）跨会话保留 —— 它们是人的偏好和机器事实，不是「这一次评什么」。（`reviewModel` 原先也在这里，D409 起改成**按会话各记一份**：A 挑过的评审模型不许被 B 顶掉。）
3. **列表与分支名册一起作废**：`reviewPrsAsked` 清空后，切过去打开页签会为新目录重新拉一遍（`loadPullRequests`）；否则会把上个仓库的 PR 列表画在新会话上。列表到达时「没选过就挑第一项」的顺手逻辑保留，它挑的是**新目录**的第一个 PR。
4. **入口要先结算再赋值**：`openReviewForPull()`（链接卡那颗「代码评审」）在赋值前显式调一次 `syncReviewSession()`。首次画面板时 `reviewSessionKey` 还是空的，那里的复位会把刚设的号当成残留清掉 —— 于是「点卡片 → 号没了」。`reviewExpectRepo` 原本就有同类顺序约定（放在切页签之后设）。

**为什么。** 不做「每个会话各自记住上次填的号」：那需要按 `sessionId|cwd` 存一份 map，还要决定什么时候过期，换来的是「切走再回来号还在」这点便利 —— 而这个 bug 的代价是**静默评错对象**，任何一点不确定性都不值得保留。默认值本身是安全的：没号时 `.rv-run` 是灰的，`startReview()` 也会拦一道。

**代价 / 可改。** 切走再回来，刚填的号、刚选的范围都没了（要重新填一次，或从 PR 列表点一个）。列表与 refs 会多拉一次（每个会话一次，本来也是要拉的）。

**验证。**

- `probes/review-session-leak.mjs`（`npm run probe:review-session`）：真桥 + 假 gh + 真 Chromium，两个不同仓库的会话来回切 —— A 里填成 `#661`；切到 B 后框是空的；`.rv-run` 是 disabled；`state/review` 里没有评审记录（桥没收到 `review.run`）。修前第 2 条红（`#661` 跟着过来），修后四条全绿。
- `probes/github-card-review.mjs` 全绿（入口顺序那条决定没有把卡片路径弄坏）。
- `npm --prefix web run typecheck` 通过（含 i18n、viewport、theme 三段）。

## D405 评审详情窗改成「运行台」：进度、日志、意见同屏，且不再每帧重建（#675，2026-11-25）

**问题。** 旧窗只有两列「进度 / 结果」，跑的时候右栏一句「评审还在跑，意见会陆续出现。」—— 用户很久都判断不了它到底在干什么、还剩多少、卡在哪。更糟的是 `refresh()` 每帧把左右两列 `replaceChildren()` 重画：用户展开一条意见、或者正看日志，大约 900 帧里滚动位置与展开态每隔几百毫秒被清一次。根因在桥侧：进度帧只带 `group/groups/currentFile/tokens`，既没有每组的文件数与条数，也没有「跑到一半已经定形的意见」，前端除了重画中文日志文本无路可走。

**决定。**

1. **桥给结构化进度，页面不解析日志**：`ReviewProgress` / `ReviewRun` 加可选 `plan?: ReviewGroupPlan[]`（`index / files / findings / state / startedAt / finishedAt`），`ReviewProgress.findings?: ReviewFinding[]`（跑到一半已收到的意见）、`ReviewFinding.group?: number`、`log[].group?: number`。全部可选 —— 老桥、老记录不带这些字段时页面退回「单段运行记录」，不画假数据。
2. **窗分四层**：抬头（PR 标题 + 状态 chip + `head → base`）、仪表三格（进度分段条 / tokens 与模型 / 用时与剩余估算）、当前文件条、主体两列（左＝按组折叠的日志，右＝意见流 + 正在读的骨架）。失败态的整段报错留在意见栏顶上，当前文件条只写「停在第 N 组」，不重复长句。
3. **不再每帧重画**：只改文本与属性；日志在「阶段签名」变了才重建，意见列表在「`key/mark/severity/filter/...` 签名」变了才重建，重建前后收集并还原展开项（`data-key`）与 `scrollTop`。
4. **意见在窗里是卡**（一文件一卡、左侧严重度色条、`.rv-finding[data-sev]`）；面板里的行式排版不变 —— 300px 的栏里卡片只会更挤。
5. **窗高按 `--vh1` 给死**（`min(calc(var(--vh1) * 84), 880px)`），日志与意见各自滚，底栏永远贴底。

**为什么。** 运行中的透明感只能来自真实数据：有 `plan` 才能画「第 2/4 组 · 8 文件 · 2 条」与分段进度；有 `findings` 才能让意见随组落地。字段做成可选，是因为 `state/review.json` 里已经有老记录，不能为了新界面让旧记录显示成空。

**代价 / 可改。**

- **进度帧变重**：每组结束时把已收意见整批塞进 `ReviewProgress`，一份 30 条意见的评审大约多几 KB 帧流量。可改成一有就增量发，现在按组发已经够用。
- **窗口高度定死**：内容少时底下留白（原型 A 也是这样）；想改成内容自适应就得让 `.rv-sheet-body` 不 `flex: 1`，那样运行中意见变多时窗会跳高。
- **`reviewView()` 多了 `runFiles` / `prHead` / `prBase`**：失败记录没有 `meta`，没有这几个字段就画不出「16 / 29 个文件」。
- **样式要压过 `.st-console`**：`settings-console.css` 晚于 `styles.css` 加载，它的 `display: grid; height: min(840px, 100%)` 同权重会赢，仪表被挤成 0 高 —— 所以选择器写成 `.st-console.rv-sheet`。探针加了一条「仪表条没被外层网格挤掉（高 > 40）」把这件事钉住。

**验证。**

- `probes/code-review.mjs`（真桥 + 真 `ocr` + 真模型，20 项）全过：新增「详情 dialog 有分组日志与结果」「仪表条没被外层网格挤掉」，旧的第 221 行起 `.rv-sheet .rv-tl` 改成 `.rv-stg`；顺手修了探针在 Windows 上 `execFileSync("ocr")` 找不到 `ocr.cmd`（跟桥一样过 `cmd.exe /c`）导致整段静默跳过的问题。
- `npm --prefix web run typecheck`（tsc + i18n + viewport + layers + theme）与 `npm --prefix bridge run typecheck` 通过；新文案 30 条补进 `en.ts` / `ja.ts`，删掉 4 条失效键。
- 本地样张台（真组件 + 假数据，未提交）按运行 / 完成 / 失败 × 1440 / 900 六张截图核对；设计蓝本留在 `.scratch/review-sheet-redesign/prototype/`（A 运行台为选定方向）。

## D406 更新日志改「阅读态」：桥端解析成结构化条目，页面与弹窗共用一套渲染（用户要求照 vibe-hub 的 changelog 重排，2026-11-25）

**问题。** 设置 → 更新日志 那两页一直是「一坨 markdown」：pi 那一侧把上游 CHANGELOG 整篇塞进 `renderMarkdown`，本项目那一侧同样，只是前面多了颗开关。七十多批堆在一栏里，没有月份定位、没有类型区分、条目末尾的 `#671` / `D365` 是死文本 —— 用户想找「哪一版改掉了什么」只能从头翻。启动弹窗也画的是同一坨 markdown，与设置页长得不一样，两处要改文案得改两遍。

**决定。**

1. **桥端解析、页面只渲染。** `takeWhatsnew` 的返回值加了 `log: SelfLog`（`bridge/src/changelog.ts` 的 `parseSelfLog()`）与 `repo: {owner,name}`（`repoFromRemote()` 读 `git remote get-url origin`，只认 github.com）。页面不再自己解析 markdown：`GET /api/changelog?scope=self` 一次拿到批次、条目、类型、引用、月份计数、统计数字。
2. **一条批次 = 一个 `LogBatch`**：`date`（`null` 表示未发布）、`title`、`intro`（首组之前那几行，`> ` 引用单独标记）、`groups`（`新增 / 修复 / 设计决定` 三种 kind，未知小节归 `新增`）、`items`（每条带 `refs`）。
3. **引用是结构不是文字**：条目结尾的 ` #671` / ` D365` 从正文里摘出来变成 `refs: [{kind:"pr",n}, {kind:"d",n}]`，排成一排 chip —— PR 有仓库地址时是 `<a target="_blank">` 直开 GitHub，`D365` 是 `<button>`：先往对话里写一句「打开 docs/DECISIONS.md，搜 D365」，再走 `pi-preview` 打开那个文件。**不做行锚点**：`md.ts` 的标题不生成 id，`pi-preview` 也只认 `{path}`。
4. **阅读态：这一页把设置的外壳拆掉。** `settingsTab` 是 `changelog` / `whatsnew` 时给 `.st-console` 挂 `data-reader="true"`，CSS 里藏 `.st-head` / `.st-foot` / `.st-dirty` / `.st-nav`、`.st-main` 收成单列、`.st-pane` 去掉内边距，`grid-template-rows` 钉成 `minmax(0,1fr)`（藏了头尾还不钉行数，`main` 会掉进 `auto` 行、不再自己滚 —— 这个坑在 D320 上踩过一次）。页面自己画「‹ 设置」返回（`chevron` 图标 CSS 转 180°）与右上 ✕；返回落在**进来之前那一格**（`settingsReturnTab`），因为阅读态没有左栏可点。
5. **筛选按批不按条**：点「修复」只留含修复的批次，批内其它条目照常显示，月份计数跟着筛后的批次走；页头右上那排 pills 不挂数字（数字在左栏月份上）。
6. **弹窗复用同一套条目**：`openWhatsnew` 拿 `log` 里 `headerOf(b) === batch.title` 找对应批次（桥那边 `decision.batch.title` 是 `## ` 那一行的**原文**，`未发布` 与 `日期 · 主题` 两种形状都要拼得回去），命中就用 `renderBatch()`，对不上（旧桥、日志刚改过）才退回原来的 markdown。两套画法用不同外层类名（`.whatsnew-md` 与 `.whatsnew-log`），否则 markdown 那套 12.5px 灰字会把主题行压下去。退回 markdown 的两处（设置页与弹窗）各自保留主题行与 `openPath`：少了前者只是没标题，少了后者 `docs/DECISIONS.md` 这类链接就点不动了。
7. **条目里的链接只放行 http(s)、mailto 与相对地址**（`web/src/md-inline.ts` 的 `safeHref`，判定前先抹掉空白与控制字符，免得 ` java\tscript:` 这种写法绕过）。条目正文是 `innerHTML`，`href` 就是页面自己的执行上下文；放不过去的地址只留文字。这是一条长期规则，不是只挡今天这份日志。
8. **续行不重拆整条**：只在续行上找引用、接到已有 `refs` 后面（`last.refs.push(...cont.refs)`）。原来的写法拿「首行 md + 续行」重新拆一次，而首行末尾那些引用上一轮已经从 `md` 里摘走了 —— 合并的字符串里根本没有它们，于是引用、统计与 chip 一起丢。

**为什么。** 解析放桥端而不是页面：同一份解析要给「页面」「弹窗」「未读判定（`seenTitle`）」三处用，放页面就要么复制三份、要么为弹窗再引一次页面模块；桥端一次算完，页面只做 DOM。chip 用真链接/真按钮而不是「看起来像链接的 span」：用户在日志里看到 `#671` 的第一反应就是点它，点了没反应比不可点更糟。

**代价 / 可改。**

- 开关与「上次看到」按用户要求挪到了**日志页最下方**（原来在页首，D358 当年写的理由是「翻到底要滚几十屏」）。按现在的数据那一页有 89 批、三万多像素高，页底确实很难自己滚到 —— 用户看过样张后仍然选了页底，接受这个代价。要改回页首只是一处 `page.append(this.whatsnewPrefs(out))` 的位置。
- `repo` 依赖 `git remote get-url origin`：没有 remote（压缩包、离线副本）时 chip 退化成不可点的 `<span>`，D chip 不受影响。
- 未发布批次的标题可能为空（`## 未发布`），此时页面上只有日期标签、没有主题行；弹窗认得出来靠的是「标题原文 = `未发布`」。
- 左栏月份统计的是**筛后**的批次，而统计卡（批 / 条 / PR）仍是全局 —— 和参考站一致，但如果有人把它当「筛后条数」会读错。

**验证。**

- `node probes/changelog-page.mjs`（真桥 + 真 Chromium，十二段）：阅读态外壳（头尾导航都不在、`data-reader` 在）、统计卡与自解析的 CHANGELOG 对得上（89 批 / 553 条 / 272 PR）、月份栏、PR 是 `<a href="…/pull/671">`、D chip 是 `<button>`、点「修复」后只剩含修复的批次（63 批）、点月份滚到那一批且圆点跟着高亮、`上次看到这里` 落在 `seenTitle` 那批下面、页底开关行是横条、150% 字号下无横向溢出且 ✕ 与开关行都还在 pane 里、pi 那侧仍是 markdown 且页头与正文同一条中线、`‹ 设置` 返回后 `data-reader` 摘掉、左栏与头部都回来；最后两段把 `/api/changelog?scope=self` 与 `?scope=self&unread=1` 的响应改成「没有 `log`」（旧桥的形状），验退回 markdown 时时间线不在、`docs/DECISIONS.md` 仍点得开预览、弹窗仍带主题行。两段都要重启一次桥（弹窗闸门每个进程只判一次），闸门判完再 `page.reload()`（同 hash 的 `goto` 不会重载）。
- `node probes/whatsnew-dialog.mjs` 全绿（弹窗改成结构化条目后，标题、日期、脚本重写等断言都按新选择器收紧；`.whatsnew-log` 的选择器必须收窄到 `.whatsnew-body >`，不然会摸到「还有 N 批更早的」里那一批）。
- `node --experimental-strip-types --test bridge/tests/changelog-unit.mjs` 13 条（切批、分组、引用、引言、续行、续行不吞首行引用、无引用续行、月份、统计、空文件、CRLF+BOM、无标题日期、远程地址三种形状）+ `whatsnew-popup-unit.mjs` 10 条。
- `npm --prefix web run typecheck`（tsc + i18n + viewport + layers + theme + `web/tests/changelog-inline-unit.mjs` 8 条：转义、行内代码与粗体、http/mailto、相对地址、`javascript:`/`data:`/`vbscript:` 只留文字、`safeHref` 判据含前导空格与夹 tab、地址里的 `&`、链接文字里的粗体）通过。

## D407 壳 / 脑分层：热部署不再打断正在跑的会话（#634）

**问题。** 热部署过去是「杀掉整个桥 → 起新桥」。pi 子进程是桥的孩子，匿名管道随父进程一起消失，于是正在跑的那一轮跟着断。用户的原话是「能不能让热部署不打断已经在跑的回话」——他要的不是「重启快一点」，而是那一轮**照跑完**。

**决定。** 拆成两层：**壳**（`bridge/dist/host.js`）持有公网端口、内网通连接、隧道与所有 pi 子进程的管道；**脑**（`bridge/dist/index.js`，原来整个桥）只负责解释 pi 的协议、画页面、答 HTTP。热部署只换脑，壳与子进程不动。

**为什么这样做。** 管道不是数据，是内核对象，只有持有它的进程还活着才传得下去 —— 所以必须有一个进程**比换代长寿**，而且它得自己持有 pipe 句柄，不能只「转发 HTTP」（把 pi 挂到别处再转发，等于把管道搬走，死法不变）。壳是那唯一一个。

**机制要点。**
- 控制通道：Windows 命名管道 / POSIX unix socket，NDJSON，`\n` 分帧（口子是字符串，不是字节流，按 `\n` 切不会切坏多字节字符）。
- 每条 pi 输出行带壳发的 `seq`。脑处理完回 `ack{sessionId,seq}`；没 ack 的行留在壳里（单会话上限 8 MB），下一个 attach 的脑原样拿走。**seq 由壳发号**：壳是唯一写者，它的计数器就是真相，老脑排队帧不会因它退出而消失。
- 写 stdin 只认「当前 owner 脑」，非 owner 的帧回 `stale-owner` 并丢弃 —— 防止两代脑同时往一个 pi 里写字。
- 换脑：新脑 hello → `ready` → 壳**先观察 5 秒**（用户选了「切完老脑立刻退」，所以观察只能在切换之前）→ 设新 owner、发 `activate`、老脑 `retire` 后 3 秒关连接、5 秒强杀；切换失败保留老脑，页面上的失败看得见。
- **换完要接管，不然页面会退回「只读预览」**（2026-11-22 用户实测打回）：新脑在 `activate` 时把壳 snapshot 里的会话逐个 `attach`（`adoptOnly`：壳里没有就失败，绝不顺手新开一个 pi，否则同一条会话会多出两个写者），`owned` 一直是 true，页面那一段正文不会重画、WS 重连后接着往下接。
- **「这一轮还在跑」要跟着壳走**：壳按 pi 自己的 `agent_start` / `agent_end` 记每个会话在不在跑，snapshot 带 `turnActive`，新脑 adopt 时用它恢复 `running`。不然页面会以为这轮结束了 ——「思考中」消失、「重讲」亮起，用户再发一句，pi 回一句英文 `Agent is already processing`。真撞上这句时的兜底：纠正状态并按插话重发一次。
- **被换下的脑绝不 `sessions.shutdown()`**：子进程这时归壳持有、正在跑，关会话就是 `rpc.kill()`，等于亲手把正在写的那一轮杀掉 —— 这就是最初报的那个 bug。retire 只做三件事：收隧道、把锁交出去（`releaseLocks`，新脑要能立刻 `takeLock`）、退出。
- 来源标识：壳转发时**删掉客户端带来的 `x-pi-peer` 与所有 `x-forwarded-*`**，按真实 `remoteAddress` 重写 `x-pi-peer: loopback|remote`；脑的 5 处回环守卫改成读它。转发之后 `remoteAddress` 全是 127.0.0.1，这层要是不做，回环口就对公网开了。
- 用量账本：壳里 append-only（`state/host/usage.jsonl`，超 1 MB 压缩成每会话一条），跨换代、跨整组重启都在；脑换代后拿 `usage-snapshot` 接上。
- 关窗保留、后台接着跑；90 秒没有可用脑才整组自尽（不把孤儿 pi 留在机器上）。
- pid 语义：pid 文件与 `/healthz` 的空闲 pid 现在指**壳**；会话 pid 由壳的状态快照给出（运行面板的采样不变）。
- 启动链四处分派到 `scripts/start.mjs` / `bridgeEntry()`：热部署窗口、`npm start`（`start:nobuild`）、看门狗、`restart.mjs`。逃生口 `PI_HOST_DISABLE=1`：当它等于 1 时全部退回老的单进程 index.js。
- 壳自己变了（`dist/host.js` 与 `dist/host/*.js` 指纹不同）：不换脑，提示整组重启 —— 用户选的就是「壳变了就整组重启」。

**代价 / 可改。** 多一个常驻进程（约 40–50 MB）。壳里出现 bug 时，最坏情况下整个桥都起不来 —— 所以 `PI_HOST_DISABLE=1` 必须长期留着，它是这个设计的保险丝。单轮里还没被确认的行超过 8 MB（极少）时这一轮不跨代，界面会明说。

**验证。** `node bridge/tests/host-broker-unit.mjs`（未确认窗口与按轮清理、8 MB 降级与按轮重置、owner 规则）、`node bridge/tests/host-ledger-unit.mjs`（账本重放与压缩）、`node bridge/tests/host-shell-e2e.mjs`（真壳 + **假脑** + 假 pi：peer 头改写、tick 回脑、写入往返、kill 通知、attach 交回窗口、账本落盘、停机干净退出）、`node bridge/tests/host-real-brain-e2e.mjs`（真壳 + **真脑** + 假 pi，走 WS：开一轮 → 答一次审批 → 换脑 → **pi 的 pid 不变、这一轮还在跑、答过的审批不重问** → kill -9 脑让壳重拉并接管 → `/api/host/stop` 整组收掉）。真浏览器的验收在 `.scratch/e2e/20261122-1050-hot-deploy-keeps-turn/`：`change` 模式下「换完之后页面没退回只读预览」「换脑没换掉子进程（还是同一个 pid）」「部署前后页面没被刷新」三条，改前全红、改后全绿。

## D408 提问卡片按「自由文本」显示：字面 `\n` 折行、反引号片段成行内代码（#640；用户「提问卡片有bug。竟然出现了奇怪的格式，并且还有代码」2026-11-22）

**症状。** 用户报卡片出现奇怪格式，还夹带代码。查本机这几天的问卷载荷，两处真实形态：一张的题干里横着字面的 `\n\n`（模型把换行二次转义了一次），后面紧跟一条 `F:/…/architecture-review.html`；另一张的选项说明里写着 `` `bridge/src/rpc.ts` `` 与 Windows 路径。卡片是纯文本渲染，于是反斜杠、反引号和路径原样摊开来，看起来就像漏了代码进来。用户当时在另一台机器上测，没留截图，所以没有把「那张」钉到具体某一条。

**修法。** 新增 `web/src/ask-text.ts` 三个纯函数，`App.askText()` / `appendAskText()` 用它们拼节点：

- `unfoldNewlines(s)`：`\n` 折成真换行，但**只在整段没有真换行时**才折 —— 已经分行的文本里出现 `\n`，多半是代码或正则本身，折了才是错。
- `splitInlineCode(s)`：按**等长反引号串**配对（CommonMark 的规矩），成对的进 `<code>`、反引号本身不进文字；找不到另一半的头/尾串（落单的一枚、三个连续的代码栅栏、没闭合的两枚）全留作普通字符。两枚包一枚（`` `x` ``）时里面的反引号是内容，不被当成开合。
- `cardPieces(s)`：**先切反引号，再只对普通文字折行**。顺序反过来会误伤在**谈论** `\n` 本身的文本（「把字面的 `\n` 折成换行」这种题干），反引号还没切出来就整段被折了。代码片段里的是内容，一个字都不动。
- CSS：`.ask-prompt` / `.ask-opt .l` / `.ask-opt .d` 一律 `pre-wrap` + `overflow-wrap: anywhere`（长路径顶出卡片的问题），行内代码用等宽小字 + `--panel-3` 底色。

**覆盖到哪几处。** 同一段模型文字在五个地方出现，全走 `askText()`：题干（`.ask-prompt`）、选项标题（`.ask-opt .l`）、选项说明（`.ask-opt .d`）、多题 tab 标签（`.ask-tab`，`x.label`）、已填 / 另写那两行（`.ask-draft`；CSS 里那条 `.ask-draft code` 之前是空挂的，现在真有节点）。收起条（`.ask-strip`）只取一行：用 `cardPieces` 分段折行后再取第一行，代码片段里的 `\n` 不会被当成断行。会话历史里那张「需要你回答」卡（`askCard()` 的 `.m`）同样拼 `appendAskText` + `\n` 分隔，否则同一份题干在面板里正常、翻回历史又露一遍反斜杠。

**误伤收窄。** 按段折行之后，「真换行 + 字面 `\n`」混在一段里的题干也能修好（老规则看整段，一有换行就整段放过）；反引号包住的 `\n` 现在一个字都不动。仍然保留的老规矩：一段没分行、也没有反引号的文本里出现 `\n`，一律当二次转义折掉 —— 正则 `/a\nb/` 这种裸写法还是会被折，代价写在 `unfoldNewlines()` 的注释里。

**为什么不去猜那张卡的像素级形态。** 没有截图，凭猜改版式只会改错地方；这几条是无论哪张卡都会犯的毛病，且都能用纯函数钉住。真正的排版判断（要不要渲染 Markdown 粗体/列表）没做 —— 卡片只需要「读得懂」，不需要渲染引擎。

**没做。** ①选项的 `preview` 字段卡片完全不显示（多选预览只在单选用）；如果用户看到的是「预览里的 ASCII 图被塞进说明」，那是另一件事。②`\t` 与字面 `\r` 没折。③没有改 `question` / `questionnaire` 两个旧工具名的载荷路径，它们与 `ask_user_question` 共用同一段渲染。

**验证。** `node --experimental-strip-types --test web/tests/ask-text-unit.mjs` 12 项（折行 / 真换行不误伤 / 空串 / 切段 / 不配对反引号 / 纯代码 / 先切后折 / 反引号内不折 / 混合情形 / 等长串配对 / 连续三枚 / 落单的一枚），`web/tests/ask-tab-unit.mjs` + `ask-card-unit.mjs` 共 24 项不回归，`npm --prefix web run typecheck`（含 i18n-check、视口单位与层叠守卫，以及新挂进链里的 `ask-text-unit`）与 `npm --prefix web run build` 通过。单测另有根脚本 `npm run test:ask-text`，与 `test:ask-tab` / `test:ask-card` 同一口径。

## D409 评审用的模型按会话记：A 挑过的模型不许被 B 顶掉（#680，2026-11-25）

**问题。** 用户报（原话）：「代码评审有bug。跨会话模型继承没有问题。但是已经执行过 codeReview 的会话已经设置过的模型，要记住，不能其他会话切换模型后，会同步已经执行过的 codeReview 的会话」。评审面板那颗模型 chip 只有一个存储点：`web/src/app.ts` 的 App 级字段 `private reviewModel = ""`。A 里挑成 X，切到 B 挑成 Y，回到 A 面板上是 Y —— 而 `startReview()` 发 `review.run` 读的就是它，A 下一次点「开始评审」会拿 Y 去跑，没有任何提示。D404 第 2 条当初把它当「人的偏好、跨会话保留」，正是这个 bug 的来历。

**决定。**

1. **模型 = 会话级状态**：存成 `private reviewModels = new Map<string, string>()`（`会话id → provider/id`），外面保留同名 getter / setter，读写都落到当前会话。`reviewPanelInput()`（chip 文字与 title）、`startReview()`（`review.run` 的 `model`）、模型弹层的 `start`（打勾的那一行）三处一个字都没改 —— 它们读到的自然就是「这个会话的模型」。
2. **不落 localStorage / 不落盘**：只活在这一次页面里，刷新回「默认模型」。会话的模型属于会话；「这台机器默认拿什么评」是另一件事，不该被某一次会话里的临时选择改写。
3. **没有会话时 set 直接丢弃**（欢迎页点 chip），别在空 key 上攒一份。
4. **D404 第 2 条据此收窄**：跨会话保留的偏好只剩 ocr（`reviewOcr / reviewInstalling / reviewInstallLog`，机器事实），模型归入会话级状态。

**为什么不照 D404 对 PR 号的做法「一律回默认值」。** 号是「评谁」的**身份**：串了会静默评错对象（D404 的代价分析），所以宁可让人重填。模型不是身份 —— 串了仍然评对的对象，只是拿错的模型静默跑一轮（更贵 / 更弱 / 更慢）。而「会话」在我们这儿就是一个任务上下文（同一个仓库、同一段事），评审模型是这条任务的属性；清成默认值等于逼用户每次切回来都重挑一次，是纯成本。按会话记也不引入新的不确定性：key 就是 `currentId`，与面板自己用的 `sessionId|cwd` 同源。

**代价 / 可改。** `reviewModels` 里每个挑过模型的会话留一条字符串，会话删了没人来回收，所以留了上限 `REVIEW_MODEL_MEMORY = 200` 条（超了丢最早挑的那条，那一次会话回落到默认模型）。刷新后回默认模型 —— 以后真觉得烦，可以按会话落在设置里（别全局存一份，那就是回退这个决定）。

**验证。** `probes/review-session-leak.mjs`（`npm run probe:review-session`）在原有「评什么」三段之后加了四段：A 挑模型 → chip 换成挑中的；切到 B → chip 是「默认模型」；B 挑另一个模型；回到 A → 还是 A 自己那个。修前第 5、6 段红（B 显示 A 的 `wb2api/cn:hy4flash`；回 A 显示 B 的 `wb2api/cn:kimi-k3-1`），修后八条全绿。`npm --prefix web run typecheck`（含 i18n、viewport、theme 三段）通过。

## D410 PR 详情面板排成「一篇短报告」：描述全文摊开，数字收进署名行（#682；用户 2026-11-25「如图是 pr 展开面板。重新设计一下」）

**问题。** 用户拿 #640 的详情截图说「重新设计一下」。560px 宽的面板里：hero 卡把标题、状态、作者、分支、checks 挤成五行，描述被塞进 `max-height:150px` 的滚动框，正好切在半行字上；紧接的四格数字（文件 / 增 / 删 / 评论）占掉四分之一屏高，说的却是署名行一行能说完的事；8 个文件每行都挂一遍「在 GitHub 看 ↗」；评论只露最后一条，后面跟一句死的「还有 1 条」；「示例数据」在 hero 与评论区各标一次，于是两处都没人当回事。

**做法。** 改成文档流，自上而下：kicker（`#640 · 打开 · 2/4 checks 通过` + 唯一的「示例数据」pill）→ 标题（18px，可两行）→ 署名行（`Yang-Code01 · fix/ask-card-text → main · 5 分钟前更新 · 8 个文件 +226 −11`）→ 一条细线 → 描述走 `renderMarkdown(body, { doc: true })` 原样摊开 → 文件两列 → 讨论（左侧一条竖线串起每条评论）→ 底栏（合并 / 在 GitHub 看差异）。四格数字与 hero 卡整块删掉。

- 描述不再设 `max-height` / `overflow`：详情本来就是来读的，一屏滚动交给面板自己（面板本身 `overflow:auto`）。
- 文件清单两列、`@container (max-width: 470px)` 降一列。**这条 @container 必须写在 `.ghp-filegrid` 基础规则之后**：同权重、后定义的赢，写在前面会被基础规则盖掉（探针当场抓到：420px 时仍是两列）。
- checks 有失败时用 warn 色、全绿才 ok 色 —— 一片绿会让 `2/4` 读起来像 `4/4`。

**为什么不做成「判定条 + 逐条 checks」那种（样张 C）。** 首屏要知道的是「这个 PR 干了什么、能不能合」，不是每一路 check 的耗时；逐条状态在 GitHub 上看得更全，面板里复制一份只会把正文挤下去。代价：想知道是哪两路红，得点「看差异」去 GitHub（checks 名字不列出来）——可接受，因为合并本来就要走审批闸，人在那里会再看一眼。

**代价。** 描述很长（几百行）时面板要滚很久，中途没有折叠。判断是：PR 描述一般几十行，折叠带来的「展开/收起」状态与滚动位置问题（D316 那类闪动）比它值钱；真遇到超长描述，用户也在滚一个面板，不是滚一个 150px 的洞。

**验证。** `node probes/pr-detail-layout.mjs`（真桥 + 假 gh 卡片 + 真 Chromium，19 项）：hero/四格数字不在、「示例数据」只有一个、kicker 带 `2/4` 且非绿、描述 `overflow:visible` 且 `scrollHeight<=clientHeight`、markdown 的 h2 / code / li 成了真元素、8 个文件都在且 560px 两列 / 420px 一列、两条评论都在且没有「还有 N 条」、底栏两颗钮还在；截图 `.scratch/shots/pr-detail-560.png` / `pr-detail-400.png`。另跑 `node probes/github-card-review.mjs`（卡片与评审钮不回归）、`npm --prefix web run typecheck`（i18n 三语补键）。

## D411 随手问的输入框与对话栏同一个盒子：打字、折块、粘贴归属一套行为（2026-11-25）

**问题。** 两个输入框长着同一张脸，动作却是两套。随手问的 textarea 是 `rows = 3` + `min-height: 84px` 的固定三行盒，打十行也只在自己内部滚；大段粘贴不折块，整屏代码糊在框里把上面的对话挤出去；右侧一颗「发送」按钮，而它发不出去的时候只会置灰 —— 唯一的状态信号是一个灰掉的按钮；粘贴只挂在它自己的 textarea 上，所以 dialog 开着、焦点不在框里时，截图会落进背后那个看不见的主会话。用户的原话：「随手问的输入框和 chat 输入框，动作统一」。

**决定。**

1. **发送只靠 Enter**：Enter 发送、Shift+Enter 换行，删掉「发送」按钮，底行只留 📎（左）与提示（右）。与对话栏同一条理由 —— 那颗按钮的位置聊天区留给了工具权限键，不为同一件事提供两种发送姿势。
2. **1 行起自动增高**：`rows = 1`，`fitInput()` 先量 `height: auto` 下的内容高度再写 px；上限读 CSS 的 `max-height`（`38vh`，约 dialog 的一半），因此在 `#app { zoom: var(--ui-scale) }` 下只乘一次。到顶后框内滚动，滚动到中段时顶部 24px 渐隐（`has-hidden-top`，判据照抄 `.composer textarea` 的 #317）。
3. **折块阈值抽成一份**：`web/src/paste.ts` 导出 `PASTE_LINES = 6`、`PASTE_CHARS = 400`、`shouldFoldPaste(text)`，对话栏与随手问共用。发送时 `body = [...折块原文, 手打的字].join("\n\n")`（#202 在对话栏已经这么拼），折块原文照发，不在 `trim()` 上丢缩进与末尾空行。
4. **粘贴/拖拽归眼前那个框**：dialog 打开期间，页面级 `paste` / `drop` 一律转进随手问（`App.onPaste` 里先判 `this.scratch.isOpen`，且 `target.closest(".scratch-sheet")` 时不转发 —— 框里的粘贴由它自己的 handler 收，转发会收两次）。关掉 dialog 才回主输入框。
5. **发不出去要说出原因**：跑着 / 已暂停 / 上一条没回话 / 当前模型看不了图，四种都写进 📎 那一行，2.6 秒后自己消失；输入框不再随状态 `disabled`（一个灰掉且不说话的框，比一句「跑着呢：这轮做完才能发下一条」难懂得多）。跑着时的占位文案也换成这句。
6. **清空仍等回显**（D368 不变），但只清「还与发出时一致」的部分：`clearEchoed()` 比对文字、按原文移除已回显的折块，打字期间新加的折块不被一起抹掉。

**没做（都是这次显式排除的）。** `/` 命令与 `@` 文件补全不搬 —— 随手问的 cwd 是空的临时目录（`bridge/src/paths.ts:140`），列出来的是空目录里的东西。跑着时仍是一问一答，不做 steer / followUp / 排队条（用户选的）；技能、文件选择器、模型 chip 也不进输入行（模型与思考档位仍在 header 下拉里）。

**代价 / 可改。** 上限 `38vh` 与对话栏的「半个对话区」不是同一个意思，因为 dialog 比对话区小；折块展开时上限在框和展开的块之间平分（a 个折块切成 a+1 份），否则两块各自要一个上限就能把对话区挤没。发送后立即清空（对话栏的行为，`app.ts` 的 `sendPrompt()`）没有跟过来：随手问的一问一答里，等回显才清更不容易丢字。

**验证。** `probes/scratch-input.mjs`（`npm run probe:scratch-input`，替身桥 + 真 Chromium）八段：空框一行高、8 行长高且不越过上限、12 行折成一块、Enter 发出的 body 是「折块原文 + 空行 + 手打的字」且回显后清干净、跑着时 Enter 被挡并闪原因且 3 秒内消失、dialog 开着时框外粘贴归随手问、关掉后折块回对话栏、字号 150% 时输入框上限只乘一次且底行仍在视口里。`web/tests/paste-unit.mjs` 4 项钉住阈值（5 行 / 399 字符不折，6 行 / 400 字符折，CRLF 与末尾换行不算多一行），已挂进 `npm --prefix web run typecheck`；`npm run build:web` 通过。
## D412 评审记录收成卡片：删「清理历史」、点开看那一次、切模型能接着评（#687；用户 2026-11-25「删除清空按钮。之前的评审记录做成一个卡片」）

**问题。** 用户原话（2026-11-25，配图）：看见 #683 那条评审的卡片后说「1、如图是已经 codeReview 后的。我清空后，切换模型，后，不能评审了。因此我希望。1、删除清空按钮。之前的评审记录做成一个卡片。点开后能看到详细信息。使用什么模型，等等。2、切换模型后，能够重新评审」。

现场核下来是三个独立的毛病叠在一起：**（a）** 面板上那颗「清理历史」是唯一的「清空」入口，而它 `cleanRuns()` 只写 `runs: []`，不碰 PR 号、不碰处理态、也不碰正在跑的进程 —— 用户点完看到历史消失，很自然把后面所有不顺都归到它头上。**（b）** 唯一一次评审的面板上没有「记录」这个概念：`reviewView()` 里 `const asRun = s => s.runs[s.runs.length-1]`，以前评过几次只剩最后一份能看，模型 chip 显示的还是**现在选中的**模型而不是那一次用的。**（c）** 真正确認过的「点不动」是按钮灰：`canRun = mode !== "loading" && … && !missing`，`missing` 在 `pr` 模式下等于 PR 号为空，而灰按钮旁边**不写任何理由**。号为什么空：`syncReviewSession()` 在 `currentId|cwd` 一变就把 `reviewPr` 等「评什么」整组重置，切会话再切回来必然丢；页面刷新也会丢（只活在内存里）。

**决定。**

1. **删掉「清理历史」**（`web/src/review.ts` 控制条底部那颗 `rv-clean` 与 `ReviewActions.onClean` 全部移除）。用户要的是「别让我担心一点就毁了什么」，而不是「给我个更安全的清理」。桥上 `cleanRuns()` 留着（注释写明：留给排障与测试，别从别处调它清用户历史），`review.clean` 帧也留着兼容旧页面。
2. **历史就是面板主体**：`reviewView()` 多一个 `focus` 入参（空 = 停在列表）与 `runs: ReviewRunCard[]`（**新的在前**）。`active = focused ?? latest`，phase / 意见 / 时间线 / 统计 / 失败原因一律按 `active` 算；只有「active 就是最新那次且还在跑」时实时帧（`input.progress`）才算数 —— 拿别的 run 的进度去画旧记录是错误的来源。
3. **版式选「列表即主体」（用户从三份样张里挑的 B）**：面板打开就是记录列表（两行卡片：`PR #683 / 标题 / 时间` + `完成 · 4 条意见 · 27 秒 · 1 个文件` + 模型 chip），点一条在**面板里**换成那一次的详情（`‹ 记录` 返回、`完整详情 ›` 开原来的 `ReviewSheet` 浮层）。左窄栏那种（C）在 420px 宽的面板里把意见挤窄了，一行式（A）又把每次的模型与耗时藏进 tooltip。
4. **详情说的是「那一次」**：`ReviewSheet` 抬头按 `view.runs.find(r => r.id === view.focus)` 取标题 / 时间 / 条数 / 模型，不再用 `this.input.modelName`（当前选中项）。为此 `ReviewRun` 加 `provider` 字段（目录里的 id 是 `cn:glm-5.4` 这种带冒号的，光有 `model` 认不出是哪个 provider），显示用 `runModelId(run)` = `provider/model`；面板再用模型目录把它翻成 `hy4flash · x0.03 · 960K`，查不到就显示 id。
5. **只留最近 20 次**（`RUN_KEEP = 20`，在 `startReview()` 加完新记录后 `slice(-RUN_KEEP)` —— **不放 `writeReviewState()`**：写盘是所有改动的窄口，标一条意见、改一次 pick 都会走它，在那里截会把用户正点开看着的那一条也截掉，`reviewFocus` 一拍就跳回最新一条）。用户选的是「只留最近 20 次，更早自动滚掉」：一次 run 实测 5–8KB，不设上限的话评几百次会变成几 MB 的 json，而这东西是每次 `review.state` 都整份发到页面的。
6. **「评什么」按会话记**（`ReviewPick { mode, pr, base, target, commit }`，落 `<state>/review/<repo>/<session>.json` 的 `pick` 字段，前端在 `mode / pr / base / target / commit` 变化时发 `review.pick`）。旧的做法连「刷新都丢」都不算 bug 被记过，但它是 (c) 的另一半：**记忆是让按钮变灰这件事少发生**，而灰按钮旁边必须写理由（`missingWhy`：PR 模式「先选一个 PR（或填个号）」、commit 模式「先填一个提交号」、range 模式「两边分支都选一下」）。
7. **PR 号自动带上当前分支那条**（用户选的）：`review.prs` 到达时先找 `headRefName === git.branch` 的那条，找不到才退到第一项。拿不到（没 remote / 没有对应的 PR）就还是空 + 理由，不造一个假号。

**为什么不干脆让「切模型」自动重跑一轮。** 重跑要花几分钟与一笔 token，而且在同一个 PR 上重复贴同一批意见；用户要的是「能评」而不是「替我评」。

**代价 / 可改。**
- 20 次是**按会话**滚，不是按仓库；同一个 PR 在不同会话里评过几次，各算各的（与 D404「历史全留」的存盘粒度一致）。想改就动 `RUN_KEEP` 一个数。
- 记录卡的「模型」要靠页面还在会话里报过模型（`session.model`）；会话从没报过模型（比如从没跑过一轮）时卡片上是「没记模型」，这是诚实的，不是 bug。
- `pick` 是「这个人最后一次把面板摆成什么样」，不是权威：桥只把它当默认值回灌，用户改了就以页面为准（`applyReviewPick()` 每个会话只回灌一次，避免「用户改了又被桥按回去」）。
- 详情里「这次用的模型」只对**新记录**准确；旧的 run 没有 `provider` 字段，退化成显示 `model`（`cn:glm-5.4` 这种），可能仍分不清 provider。

**验证。** `node probes/code-review.mjs`（真桥 + 真 Chromium，30 项全绿）：面板里没有「清理历史」；跑完出现 `.rv-run-card`；点卡片进 `.rv-focus`、里面写着「这次用的模型」、`‹ 记录` 能回列表；`完整详情 ›` 开的浮层还是老样子（分组日志 + 意见 + 一键交给 agent）；PR 模式填号能评；刷新后范围与号自己接上（`pr / 7`）；字号 150% 下按钮仍在视口。`npm --prefix web run typecheck`（tsc + i18n 三语 4366 键 + viewport + layers + 三个 node --test）通过。`npm --prefix bridge run typecheck` 通过，`node --experimental-strip-types bridge/tests/review-unit.mjs` 全绿（新增两条：「写盘本身不裁剪」与「加新记录时留最后 20 次」、「评什么」存得下也读得回）。

# pi-web-client · 实施计划

> 基线事实来自 `docs/pi-integration-facts.md`（子代理实测，`@earendil-works/pi-coding-agent@1.4.0`）。
> 决策与理由见同目录 `DECISIONS.md`。本文只写「怎么做」。

## 0. 一句话

在你这台 Windows 上常驻一个 bridge，它为每个会话 spawn 一个 `pi --mode rpc` 子进程，把 stdio 上的 JSONL 转成 WebSocket；浏览器里是一个卡片流 + 队列的单页应用，手机与桌面同一套组件。**不用在终端里开 pi**，随时能看、能发、能批。

## 1. 进程与边界

```
浏览器 ──https──> cloudflared (quick tunnel, 可选) ──> bridge :7864 ──stdio──> pi --mode rpc (每会话一个)
   └──http(局域网)────────────────────────────────────────┘                        └── 加载 approval-gate 扩展
```

- bridge 是唯一写者/唯一对外口；**不做**多进程分片、不做集群。bridge 的外部依赖只有 `ws` 和 `web-push`（VAPID + RFC 8291 自己手写不划算）。
- 每个 `pi --mode rpc` 子进程带两个东西：`--extension ./ext/approval-gate.ts`（拦截 + 策略）和会话 id（`--session <path>`，已存在的会话就 resume）。
- 终端里那个 pi 进程**不被接管**：bridge 只以只读方式 tail 它的 `.jsonl`。

## 2. 目录结构

```
F:/pi-web-client/
  package.json            # workspaces: bridge, web
  bridge/
    src/index.ts          # http + ws 入口、登录、静态资源
    src/auth.ts           # 口令哈希(scrypt)、HMAC cookie、限流
    src/tunnel.ts         # 起 cloudflared、解析 URL、写 state
    src/sessions.ts       # 会话注册表：spawn/回收/复活/列表
    src/rpc.ts            # RpcChild：stdio JSONL 读写、请求-响应配对、事件分发
    src/approval.ts       # pending 审批表、超时、广播、应答回写
    src/tail.ts           # 终端会话只读 tail（byte offset + truncate 检测）
    src/notify.ts         # iLink Bot 发送 + 降级队列
    src/state.ts          # %LOCALAPPDATA%/pi-web-client 下的锁/队列/设置
    ext/approval-gate.ts  # 装进子进程的 pi 扩展：tool_call 钩子 + ctx.ui.confirm
  web/
    src/main.ts           # 挂载、路由（会话/队列）
    src/store.ts          # 事件归约成视图状态（卡片、队列、连接态）
    src/views/*           # 卡片流、队列、控制条、输入框、登录页
    src/proto.css 派生    # 从 prototype/d-mix.html 的 token 与卡片规则提取
  docs/ # 本计划、事实报告、样张（不进产物）
```

## 3. 关键机制

### 3.1 会话与进程

- 一进程一会话。`spawn(process.execPath, [cliJs, '--mode','rpc','--session',path,'--no-extensions','-e',gateJs], {cwd})`，stdio 三通。
  - **不走 `pi.cmd`**（.cmd 里带 `title`/`%COMSPEC%`，spawn 后行为脏）；直接 `node <…>/dist/bundle/cli.js`。cli 路径按序解析：`PI_BIN` 环境变量 → `npm prefix -g` 下的 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` → 内置兜底路径。
  - 不加载 `pi-lens`、`question`、`questionnaire`（原因见 D18/2.3）。
- 新建会话 = 生成新 session path（`~/.pi/agent/sessions/<slug>.jsonl`）+ 新进程；cwd 从「最近使用列表」选，手输兜底（DECISIONS D7）。
- 空闲回收：无 WS 订阅且无进行中任务，2 小时后 `abort` + kill；下次打开列表时「复活」= 重新 spawn 同 session path。
- 崩溃恢复：子进程退出码非 0 → 会话标记 `crashed`，列表里给「重启」按钮（不自动重试，避免循环炸）。

### 3.2 状态重建

- RPC 事件没有 seq、没有 replay，`message_update` 只有 delta。所以：
  - **首连/重连**：一律调 `get_entries` 拿快照（全量条目，含工具调用结果），再开始接收事件。
  - **在线增量**：把 `message_update` 的 delta 拼到本地缓冲；`message_end` 到了用完整消息覆盖，防止漂移。
  - 客户端断线重连 = 丢弃本地 buffer、用 `get_entries(since=<最后一条 entryId>)` 增量拿（实测 since 排他），拿不到就全量。
  - 事件字段以 `docs/json.md` 为准：`tool_execution_end` 自带 `durationMs`（卡片耗时直接用它）、`message_update` 的 `assistantMessageEvent` 只有 delta、`turn_end` 带 `message`+`toolResults`。
- 工具卡片的状态由 `tool_execution_start` / `tool_execution_end` 配对，键用 `toolCallId`。

### 3.3 审批闭环（核心，已实测）

1. gate 扩展在 `tool_call` 钩子里跑策略（D1：危险模式才拦）。
2. 要拦 → `ctx.ui.confirm(title, msg, { timeout: 300000 })` → pi 发 `extension_ui_request{method:"confirm", id, title, message, timeout}` → bridge 存 pending、广播、触发通知。
3. 网页「批准」两段式 → bridge 回 `{"type":"extension_ui_response","id":<原样>, "confirmed":true}`。
4. 拒绝 → `confirmed:false`；超时 → **pi 自己**在 5 分钟到点时以 `false` resolve（D17），扩展返回 `{block:true, reason}`，agent 收到并自己换路（D2）。
5. 「中断」按钮 = 先把所有 pending confirm 应答 `cancelled:true`，再发 `abort`（D19，实测必须这个顺序）。
6. 「本会话允许这个模式」= 往 gate 的进程内 allowlist 加一条正则，随子进程结束失效。
7. 已实测：批准、拒绝、`cancelled`、超时四条路径全部走通，run 都能正常 settle。

### 3.4 写者锁与只读 tail

- bridge 自己的锁文件：`sessionPath → { owner, pid, since }`，只由 bridge 维护。接管终端会话 v1 不做——终端那个进程序列化在它自己手里。
- 会话文件实测**严格 append-only**（182 文件 / 28548 行 / 非法行 0；唯一破坏性重写是 version<3 迁移，本机全 v3）。所以只读 tail 可行，但要三件套检测（D27）：
  1. `stat.size < offset` → 截断/重写 → 全量重扫；
  2. 前 512 B 的 sha 比对 → 兜住「size 没变但原地重写」；
  3. 只消费到最后一个 `
`，尾部半行留在缓冲。
- 轮询用 `stat`（200–500 ms），`fs.watch` 只当唤醒信号（Windows 上对别的进程 append 不可靠）；只轮询当前打开的那一个会话。
- UI 必须显式标注：列表项 `tty · 只读`，会话顶部常驻横幅「这个会话在终端里，审批要回终端做」。

### 3.5 鉴权

- 单口令（首次启动在终端打印），`scrypt` 存盐哈希；登录成功发 `HttpOnly; SameSite=Strict; Secure` 的 HMAC cookie，30 天。
- 限流：按 IP 5 次/分钟，超了 429 + 退避。**没有域名就没有 Cloudflare Access**，这道口令是公网上唯一的门（D3）。
- 所有 API 走同一 cookie 校验中间件；未登录只回登录页 + `/api/health`。
- **公网降级（D15）**：非私网地址来的连接只读；写/批要再输一次口令换 10 分钟 step-up 标记。

### 3.6 通知（微信主力 + Web Push 兜底，D24）

- 触发只有三类：等审批、出错/中止、长任务（>5 分钟）结束（D4）。
- 通道 1 微信：读 `~/.pi/agent/wechat-assistant/credentials.json`（只读），`POST {baseUrl}/ilink/bot/sendmessage`，`Authorization: Bearer <token>`，正文 800 字符分片 + ≥1 条/秒软限速。**必须同时判 `ret` 与 `errcode`**（`errcode:-14` 是登录过期，没有 `ret` 字段，只看 `ret` 会当成功，D25）。
- 通道 2 Web Push：VAPID 密钥首次启动生成；`/sw.js` + `pushManager.subscribe`；微信失败即刻转 Web Push。
- 通道 3 页面内：标题与 favicon 角标（页面开着时）。
- 微信 `ret:-2 prepare failed` = 会话太久没活跃，UI 给可执行话术「给 bot 发一条任意消息就会恢复」，并在下次提醒前自动重试一次。
- 正文：会话名 + 命令摘要 + 当前公网 URL（URL 每次重启都变，必须现取）。

### 3.6b 会话列表与历史读取（D26）

- 列表阶段只 `stat` + 读每个文件前 4 KB 的 header（`id` / `version` / `cwd` / `timestamp`）——本机有 290 MB 的单文件，绝不能列表阶段 parse 全文。会话身份以 header `id` 为准。
- 打开会话才流式读：1 MiB 分块、单轮上限 4 MiB；entry 是 parentId 树，需保留 `id→parentId` 全图。
- 磁盘上没有 leaf 指针，外部等价物是「最后一行 = leaf」；`label` 是追加型条目，维护 `Map<targetId,label>`。
- 列表排序按 mtime，按 cwd 分组；`tty · 只读` 与 `running/idle/crashed` 徽标从 stat + 我们的锁文件推断。

### 3.7 控制面

- 顶部 `模型 ▾`（`get_available_models` 填充，`set_model` 落）、`思考档位 ▾`（`set_thinking_level`）、`■ 中断`（`abort`）、`/compact`。
- 不做 slash 全集（D5）。输入框里以 `/` 开头的仍原样发给 pi（模型自己会处理）。

### 3.8 图片

- 粘贴 / 相册 / 拍照 → canvas 压到长边 ≤ 2048、≤ 4MB → `prompt(text, { images: [dataUrl] })`。
- 上传文件落 `%LOCALAPPDATA%/pi-web-client/uploads/<date>/`，7 天清理。

### 3.9 隧道与托盘（D29）

- 起 `C:\Program Files (x86)\cloudflared\cloudflared.exe tunnel --url http://127.0.0.1:7864`，注入 `HTTPS_PROXY=$BILLION_CONTEXT_PROXY`（先 curl 验 200，验不过就不注入）。
- **读 stderr** 抓 URL（stdout 恒空），正则 `\|\s{1,}(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)\s{0,}\|`；15 s 等 URL，30 s 等首个 200。
- 进程退出或公网探测拿到 530/`errorCode:1033` → 整进程重拉 + 重新解析 URL + 推送「地址变了」（URL 每次启动都不同，绝不能缓存）。
- 停止用 `taskkill /F /PID`；注意它额外占 `127.0.0.1:20241` 的 metrics 端口。
- 托盘：PowerShell WinForms `NotifyIcon` 小脚本（零 npm 依赖）——显示运行态/URL、打开网页、停/启 cloudflared、退出整个 bridge。开机自启用「启动文件夹快捷方式」。

## 4. 里程碑（每个都能单独验收）

| # | 内容 | 验收 |
|---|---|---|
| M0 | bridge 骨架：http+ws、口令登录、静态页、health | 手机浏览器登录进得去，口令错被限流 |
| M1 | 一个会话跑通：spawn、发消息、流式事件、中断 | 在手机上说「列一下当前目录」，能流式看到 bash 卡片 |
| M2 | 会话管理：列表/新建/重回/回收/首连快照 | 刷新页面后历史还在；两小时后进程自己退了，再点开会话能复活 |
| M3 | 审批闭环：gate 扩展 + 策略 + 超时 + 两段式 + 队列 | `rm -rf` 被拦、手机批了才跑、5 分钟不理自动拒 |
| M4 | 写者锁 + 终端 tail | 终端会话在列表里显示「只读」，顶部有横幅，点审批按钮不存在 |
| M5 | 通知 + 隧道 + 托盘 + 自启 | 关掉页面，微信收到「有件事等你」，点链接回到审批；微信被 `ret:-2` 拒时 Web Push 补上 |
| M6 | 打磨：图片、diff、控制条、移动端手势 | 手机相册选图能发；diff 有行号；模型能切 |

**进度（实现后更新）**：M0–M4 已实现并端到端验证（`bridge/tests/e2e.mjs` PASS：流式、审批 add/remove、拒绝后 blocking、abort settled；`bridge/tests/browser.mjs` 跑真实 Chromium：手机 390×844 与桌面 1440×900 截图都能出全流程）。M5 的代码（Web Push + 微信 + cloudflared）已写但**没有实测过公网**；M6 只做了图片（2048px JPEG 压缩）与模型/思考档位的 WS 命令，diff 卡片与手势未做。**计划外的加做（D50）：文件资源管理器**——顶栏 `📁 文件` 打开 viewer 的「浏览/预览/编辑」三态，走盘符、就地编辑并保存（`node bridge/tests/save-check.mjs` + `node probes/fs-ui.mjs` 全绿）。

## 5. 最终验收（照你最初那句）

一个真实任务（比如重构某个模块），从手机上发起，中间有两次审批（一次 approve、一次 timeout），跑完 20 分钟；回到桌前打开终端，`pi` 的会话历史里能看到同一段对话、同一个 diff。

## 6. 实施前核对：已全部验完

验证记录：`probes/rpc-probe-findings.md`、`probes/wechat-tail-probe.md`、`probes/cloudflared-probe.md`。

| # | 待验项 | 结果 |
|---|---|---|
| 1 | 扩展加载 / 事件流 / 审批四路径 | ✅ 批准、拒绝、`cancelled`、`timeout` 全走通，run 都正常 settle |
| 2 | 中断与挂起审批的关系 | ✅ 必须先 `cancelled` 再 `abort`，否则 abort 永不返回（D19） |
| 3 | `--session` 复活 + 中文/空格路径 | ✅ 16 消息 / 18 条目 / 同 leafId；CJK+空格路径正常 |
| 4 | `get_entries` 增量 | ✅ `since` 排他；但**无 limit/offset** → 历史改读文件（D28） |
| 5 | 会话文件 append-only | ✅ 182 文件 / 28548 行 / 非法行 0；仅 v<3 迁移会整体重写 |
| 6 | 微信能否外部进程发送 | ✅ 能发（无 IP 白名单）；但 `ret:-2` 会话不活跃时拒收 → Web Push 兜底（D24） |
| 7 | cloudflared 装与跑 | ✅ 2026.10.6 已装；URL 在 stderr；~20 s 就绪；死隧道是 530 |
| 8 | 公网来源识别 | ✅ `cf-connecting-ip=112.20.92.2`、peer=127.0.0.1、`x-forwarded-proto=https` |
| 9 | 多浏览器并发 | 自家代码，写测试验（无外部不确定性） |

## 7. v1 明确不做

- 多用户、共享链接、协作。
- 接管终端会话（只读 tail）。
- 终端 / 文件浏览 / git 面板 / MCP 配置界面。
- 移动端原生 App、离线模式。
- slash 命令全集面板。

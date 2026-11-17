# 内网通 v2：照 QQ 的聊天模型重做会话与消息

> 状态：**已实现（2026-11-18，一个 PR）。** 方向与分层见 `docs/DECISIONS.md` D299；下面 §4 的每一片都已在 `peer/`、`web/src/peer/`、`bridge/` 落地，§8 是实际验过的部分。
> 本文只写「QQ 是怎么做的」「我们差在哪」「打算怎么补」，不写逐行施工清单。
> 取证日期 2026-11-18，目标 `QQ 7.0.3-54395`（QQNT，Electron 分支）。

## 0. 一句话

内网通的传输已经够用（组播发现 + HTTP 直达 + Outbox 补投），差的是**聊天模型**：一条消息只是 `{text}`、一个会话只是一个 nodeId、没有未读、没有序号、没有撤回、没有引用、没有输入中。QQ 把这些都做成独立的管理器，我们也照它的**分层**补，而不是往 `Entry` 上继续加字段。

## 1. QQ 侧证据

REA（`rea-agents@6.9.0`，node 26.13.1）。证据分三级，后面设计里引用时标级别：**[观测]** 运行中的 QQ 上直接看到、**[静态]** 从发行物里读出来的字节/符号、**[推断]** 由上面两者推的。

### 1.1 静态：包是加密的，静态拿不到 JS

- `Contents/Resources/app/application.asar` 1436 个文件 / 31.6 MB，**逐文件 AES 块加密**（每个文件长度都是 16 的倍数，`package.json` 80 字节、`renderer/index.html` 同样读不出明文）。`package.json` 的 `isByteCodeShell: true` 与之对应。`renderer/` 下只有 `img/ css/ fonts/ html/`，**没有任何 `.js`** —— 界面代码运行时才解密。**[静态]**
- `Contents/Frameworks/QQNT.framework/Versions/A/QQNT`（370 MB，QQ 自己的 Electron 分支）的 fuses：`RunAsNode=enabled`、`EnableNodeOptionsEnvironmentVariable=enabled`、`EnableNodeCliInspectArguments=enabled`、`EnableEmbeddedAsarIntegrityValidation=disabled`。主程序 `Contents/MacOS/QQ` 里没有 fuse sentinel（是启动壳）。**[静态，`ev_4939709a`]**

### 1.2 运行时：CDP 这条路走不通（实测三次）

fuses 看着都开着，但**实际都不生效**：

| 试法 | 结果 |
| --- | --- |
| `QQ --remote-debugging-port=9222` | 进程 argv 里留着这个开关，**9222 没有监听**，日志里没有 `DevTools listening` |
| `NODE_OPTIONS=--require <hook>`（hook 里 `app.commandLine.appendSwitch`） | 环境变量确实进了主进程（`ps eww` 可见），**hook 没被执行** |
| `NODE_OPTIONS=--inspect=9229` | 同上，**9229 没有监听** |

所以 QQ 的主进程既不认命令行上的 Chromium 开关，也不认 `NODE_OPTIONS`。**拿明文渲染层代码只有两条路**：逆 `wrapper.node` 里的 asar 解密例程，或者改 bundle 重签名（会碰它自己的完整性检查）。两条都超出「优化内网通」的性价比，这次没做。

### 1.3 静态替代：`wrapper.node` 里的 `nt::im_core` 骨架

`Resources/app/wrapper.node`（191 MB，Node addon，内含 QQNT 的 IM 原生核）没剥符号 —— 类型名成串留在里面。抽出 itanium 名字 26 373 个、demangle 之后得到 `nt::im_core::*` 的**类名表**。这比 JS 更接近「QQ 的模型」，因为它就是状态机本身（渲染层只是画它）。

按我们关心的问题挑出来（全部 **[静态]**）：

| 问题 | QQ 的类 |
| --- | --- |
| 一条消息是什么 | `TextMsgElem` `FaceMsgElem` `PicMsgElem` `FileMsgElem` `PttMsgElem` `VideoMsgElem` `ReplyMsgElem` `MultiForwardMsgElem` `GrayTipsMsgElem` `ArkMsgElem` `MarkDownMsgElem` `StructMsgElem` … —— **消息 = 元素列表**，不是一段文本 |
| 撤回 | `MsgRecallMgr` `IMsgRecallMgrApi` `IMsgRecallEvent` `FileRecallMgr` `GroupMsgRecallWorker` `PaiYiPaiMsgRecallWorker`；**落成灰条** `GrayTipsMsgElem` + `GrayTipMsgManager`；引用与撤回联动 `ProcessReplyMsgWhenRecallOriginalMsg` |
| 未读 | `MsgUnreadCntMgr` `LocalMsgUnreadCntMgr` `IMsgUnreadSetApi`；**三个处理器** `MsgUnreadCntProcessor` / `MsgUnreadManualProcessor` / `MsgUnreadTimeProcessor`，事件 `IMsgUnreadNotifyEvent` |
| 会话列表 | `IRecentContactMgr` `RecentContactDbMgr`；**置顶是独立管理器** `IRecentContactTopMgr`；`IRecentContactMergeWindowApi`（同一个会话的连发合成一次变更）；`IMsgHiddenSessionMgr`（会话隐藏）；`MsgDraftMgr`（草稿） |
| 顺序与补拉 | `IMsgSeqPullApi` `MsgSeqPullMgr` `MsgSeqPullWorker` `IMsgSyncMgr`；离线/漫游 `*OfflineMsgWorker` `IRoamMsgManager` |
| 发送状态 | `IMsgSendStatusCheckEvent` |
| 输入中 | `AioInPutStateMgr` `AioInputStateWorker` |
| 在线 | `OnlineStatusMgr` `OnlineStatusService` `OnlineStatusNetWorker` `OnlineStatusPush` |
| 通知 | `MsgNotifyMgr`（与未读分开：未读是状态，通知是投递） |

配套的中文文案（同一文件里的 UTF-8 串，含 `modules/im_core/msg/element/gray_tips_msg_elem.cc` 这样的源码路径）**[静态]**：

```
你撤回了一条消息 / {} 撤回了一条消息 / 原消息已被撤回
超过撤回时间，不能被撤回 / 若对方QQ版本过低，可能无法撤回。
对方正在输入... / 对方正在讲话...
查看{}条转发消息 / [合并转发]该消息不支持查看
对方切换为离线发送
```

### 1.4 观测：会话列表的解剖

2026-11-18 00:09 在跑着的 QQ 主窗口（截图只在本地，没进仓库，因为里面有别人的头像和昵称）。**[观测]**

- 左轨是入口栏（消息 / 联系人 / 收藏 / 群 / 空间 / 文件 / 邮件 / 手机 / 更多），**红点挂在入口上**（联系人、群、更多各一颗）。
- 会话行：48 px 头像 | 名字 16 px | **时间右对齐**，格式是「今天 `HH:mm` / 昨天 `昨天HH:mm` / 更早 `YYYY/MM/DD`」。
- 第二行是**摘要**，长名字带来源前缀（`店长: @全体成员 新教学…`、`江老师: @全体成员`），单行截断。
- **静音会话在摘要行末尾画一个斜杠铃铛**（四个群/人都是这样），而不是把整行变灰。
- 未读数字徽标这次没看到（列表里都是已读），**不对它的位置下结论**。

## 2. 内网通现状（带坐标）

栈：组播 announce（`peer/src/discovery.ts:7`，10 秒一次、30 秒判离线）+ 本机 HTTP（`peer/src/http.ts`）+ 补投队列（`peer/src/outbox.ts`）。前端 `web/src/peer/main.ts`，桥只做转发（`bridge/src/index.ts:802` 起）。

| 现在是什么 | 在哪 |
| --- | --- |
| 一条消息就是 `{id, at, from, to, kind, text?, file?, ack?, via?}`，`text` 是**单个字符串** | `peer/src/history.ts:21` |
| 会话摘要 = 文件里最后一条 `kind:"text"` 的 entry，`count` = 文本条数 | `peer/src/history.ts:107-150` |
| 会话排序 = 最后一条的 `at` 降序，**没有置顶/静音/未读** | `peer/src/history.ts:150` |
| 送达状态靠**另写一条 `kind:"receipt"` 的 entry** | `peer/src/index.ts:31`、`peer/src/messages.ts:146` |
| 补投：串行、指数退避（上限 60 s）、24 小时过期 | `peer/src/outbox.ts:23,94,108` |
| 重发 = 拿原文再 `POST /send` 一次，**产生新 id 的新消息** | `web/src/peer/main.ts:1090` |
| 「发送中」根本不可见：只有存在 receipt entry 时才画已送达/失败 | `web/src/peer/main.ts:935` |
| 摘要没有作者前缀；回执 entry 直接把摘要变成「已送达」 | `web/src/peer/main.ts:629` |
| 轮询：状态 5 s、会话 4 s、联系人 6 s、消息 2.5 s、传输 1.2 s | `web/src/peer/main.ts:1723-1754` |
| 在线只有「30 秒内有 announce」一档，没有离开/忙碌/最后活跃展示 | `peer/src/discovery.ts:30` |

## 3. 差距表

| 面 | QQ | 内网通 | 结论 |
| --- | --- | --- | --- |
| 消息本体 | 元素列表（文本/图片/文件/语音/引用/灰条…） | 单个 `text` + 一个 `file` 字段 | **本轮不抄**（见 §7），但 `Entry` 要能挂 `replyTo` 与 `recall` |
| 未读 | 独立计数管理器 + 三个处理器 + 通知事件 | 没有 | 必须补，否则「会话列表」这一页永远只是历史记录列表 |
| 会话属性 | 置顶 / 静音 / 隐藏 / 草稿各有管理器 | 全无 | 补置顶 / 静音 / 草稿（隐藏不做） |
| 顺序 | seq + pull 补洞 | 时间戳 | 补 thread 内 `seq`，用于同毫秒排序与「有没有漏消息」 |
| 撤回 | 灰条 + 时限 + 版本协商 | 没有 | 补灰条式撤回（不删原消息） |
| 引用 | `ReplyMsgElem` | 没有 | 补 `replyTo`，且撤回要联动 |
| 输入中 | `AioInputStateWorker` 推状态 | 没有 | 补轻量心跳 |
| 发送状态 | 独立检查事件 | 只有成功/失败两条 receipt | 补三态（sending/delivered/failed），重发复用原消息 id |
| 在线 | 在线/离开/忙碌 + 推送 | 在线/离线 | 补离开（空闲推导），不做手动状态 |
| 通知 | `MsgNotifyMgr` 独立于未读 | 没有（bridge 的 `Notifier` 只服务 pi 会话） | 复用 `bridge/src/notify.ts` 的 `Notifier.notify()` |

## 4. 设计：四片

四片按依赖排（P1 定义「会话元数据」这层存储，P2/P3 都要往里加字段），但**交付上合成一个 PR**：四片改的是同一批文件（`history.ts` / `messages.ts` / `main.ts`），拆开反而每次都重解同一个冲突。

### P1 会话列表 + 未读

**模型**：新增 `peer/src/threads.ts` 的 `ThreadMeta`，落 `statePath("threads.json")`：

```ts
interface ThreadMeta {
  nodeId: string;
  read?: { at: number; id: string };   // 已读水位：双键，同毫秒也不含糊
  pinned?: boolean;
  muted?: boolean;
  draft?: string;                      // 字数上限与消息同（32 KB）
}
```

- **水位为什么是 `{at, id}` 而不是一个时间戳**：`uuidv7` 同毫秒内是随机的（`peer/src/messages.ts:14` 的注释已经写了），拿 `at` 单键会让「同一毫秒里先收到的那条」永远算未读。判定用 `(e.at, e.id) > (read.at, read.id)` 的字典序，纯本地比较，对时钟漂移只影响本机，不影响对端。
- **未读数别人发来的消息**（`text` 与 `file`，`from.nodeId !== me`），回执与撤回记录不算。文件也算：D300 之后谁都能传文件，不计数就会出现「文件悄悄落到会话里、列表上没动静」。
- **`/threads` 增加字段**：`unread: number`、`pinned`、`muted`、`lastMine: boolean`（最后一条是不是我发的，给「你:」前缀）、`draft`。
- **新接口**（都只认回环，口径同 `/peer/add`）：
  - `POST /threads/read { nodeId, at, id }`
  - `POST /threads/pin { nodeId, pinned }`
  - `POST /threads/mute { nodeId, muted }`
  - `POST /threads/draft { nodeId, text }`
- **打水位的时机**（照 QQ 的「看见才算」）：会话打开 + 页面可见（`document.visibilityState === "visible"`）+ 滚到底。`document.hidden` 时收到的消息**不打**水位。
- **排序**：`pinned` 组在前（组内按最后消息时间降序），其余按最后消息时间降序。**本地发送不改变未读**，但会改变会话在列表里的位置（QQ 也是这样，只是它用 `RecentContactMergeWindow` 把连发合成一次）。
- **UI**（`web/src/peer/main.ts` 的 `renderThreadList` / `preview`）：
  - 会话行右侧：未读时画数字徽标（>99 显示 `99+`）；静音会话画**不带数字的小圆点**（QQ 的斜杠铃铛在摘要行，我们的行更窄，放右上角更省地方 —— 这是**设计选择，不是从 QQ 观测到的**）。
  - 摘要前缀：最后一条是我发的 → `你: `；静音会话摘要变灰。
  - 右键菜单（已有 `threadMenu`）加：置顶/取消置顶、消息免打扰、标记为已读。

**测试**：`bridge/tests/peer-history.mjs` 加「水位双键」用例；新 `peer-unread.mjs`（起两份 peer，A 发 N 条、B 不打开 → `/threads` 未读 N；B 打水位到第 k 条 → 未读 N-k；A 再发一条 → 未读 +1）。注意这三个 peer 用例在 `tools/run-tests.mjs` 的 `SERIAL` 表里（同机多份会互相发现）。

### P2 消息状态机 + 重发

**现状的坑**：`resend()` 走 `POST /send` 会造一条新消息（`web/src/peer/main.ts:1090`），所以失败一次重发一次，历史里就多一对气泡；而「发送中」这个状态在页面上完全不存在 —— 入队到送达之间页面什么都不显示。

- **`Entry` 加 `seq?: number`**（thread 内单调，发送方分配；接收方记下来用于补洞检测，但**不重排已到的历史**，只在排序同 `at` 时当第二键）。
- **状态是派生的，不落盘**：`/messages` 与 `/threads` 返回时把 `outbox.pendingFor(peerId)` 合并成 `sending`；settle 之后写的那条 receipt 不变，渲染层把它折成 `delivered|failed`。这样历史文件格式不变，旧版本读新文件不会炸。
- **重发复用原 id**：`POST /send/retry { peer, id }` —— 从历史取回原 entry，重新 `outbox.add({id, ...})`。Outbox 的 `settle()` 已经是按 id 过滤（`peer/src/outbox.ts:118`），同 id 重入天然幂等。
- **UI**：气泡 meta 行三态 —— `发送中…`（转圈）/ `已送达`（✓）/ `发送失败 · 重发`（红），失败时整条气泡加 `.failed` 淡红底。会话列表摘要对失败态加前缀 `! `。
- **兼容**：旧对端不认识 `seq`，忽略即可。

**测试**：`peer-e2e.mjs` 加「同一 id 重投被去重」「24 小时过期后 UI 拿到 failed」；`peer-ui.mjs` 加三态断言。

### P3 撤回 + 引用 + 输入中

三种都是**控制面**，共用 `/peer/inbox` 与 `outbox`（D104 的路子，不新开通道）：

- **撤回**：`kind: "recall"`，`{ id, at, from: {nodeId}, target: <原消息 id> }`。
  - 发送侧只允许 `now - entry.at <= 120_000`（QQ 单聊的窗口），过期直接 `400 {retryable:false}`，页面灰条提示「超过撤回时间，不能被撤回」。
  - 接收侧**不删原 entry**，追加一条 `Entry{kind:"recall", ref: target}`；渲染时把原气泡换成灰条「{X} 撤回了一条消息」，正文不再显示（历史文件里还在，符合「留痕但不外显」）。
  - 过期的补投（对端 24 小时内才上线）在发送侧就已经判过期了，不会发出。
- **引用**：`Entry.replyTo?: { id: string; from: string; excerpt: string }`（`excerpt` 截 120 字符，避免把整段原文塞进信封）。气泡上方画一条竖线引用块 + 点击滚到原消息；**原消息被撤回时引用块显示「原消息已撤回」**（对应 QQ 的 `ProcessReplyMsgWhenRecallOriginalMsg`）。
- **输入中**：`POST /peer/typing { peer, at }` —— 不落盘、不进 outbox、丢了就丢了；接收侧记 `typingUntil = now + 3000`，`/threads` 带上 `typing: boolean`。页面每 2 秒最多发一次，停止输入 3 秒后自然消失。UI 在会话行摘要位置与聊天页标题下显示「对方正在输入…」。

**测试**：新 `peer-recall.mjs`（撤回成功/超时/对方离线）；`peer-ui.mjs` 加引用块与输入中提示。

### P4 在线状态 + 通知策略

- **`Announce` 加 `status: "online" | "away" | "busy" | "hidden"`**（`hidden` 已有，`peer/src/config.ts:31`）：`away` 由本机推导（10 分钟无页面 `presence`、无 pi 消息），不做手动切换。`/status` 与 `/threads` 暴露 `status` 与 `lastSeen`。
- **通知**：页面侧未静音 + 非当前会话 + `document.hidden` → `new Notification()`；页面不在线时由 bridge 用 `Notifier.notify()`（`bridge/src/notify.ts:157`）推 Web Push，点开落到 `/peer`。免打扰（`cfg.dnd`，`peer/src/config.ts:31`）在两侧都判：只挡通知，不挡未读。
- **不做**：手动改状态、状态说说、忙碌自动回复。

## 5. 协议兼容：**不升 `PROTO`**

沿用 D234 的结论与做法：`PROTO` 保持 1，新 `kind`（`recall`、`typing`）与新增字段（`seq`、`replyTo`、`status`）都是**加性**的。旧对端对未知 `kind` 回 `400 {retryable:false}`（`peer/src/messages.ts:124`），Outbox 直接丢掉、不重投 —— 也就是「旧版收不到撤回通知，但消息本身照旧」。

代价（要认）：**旧版与新版混跑时，撤回只在新版之间生效**，且旧版看到的是被撤回的原消息。不为此加能力位协商：内网通是无中心的，协商会让双方都依赖对端在线。

## 6. 存储格式

- `Entry` 只加可选字段（`seq`、`replyTo`、`kind:"recall"` + `ref`），JSONL 一行一条不变，`History.read()` 的尾部切片不受影响。
- 新增 `statePath("threads.json")`（会话元数据），`statePath("outbox.json")` 不变。没有迁移脚本：缺字段按默认值处理，第一次写才补。

## 7. 明确不抄的

- **元素列表**（`*MsgElem`）：我们没有图片/语音/表情渲染链，硬抄只会得到一个没人填的容器。等真有第二种富媒体再加。
- **云端漫游 / 多端同步**（`IRoamMsgManager`、`*OfflineMsgWorker`）：内网通是「两台机器直连、历史存在各自盘上」，没有中心存储，抄不了。
- **群**：`GLOSSARY.md` 写的是 v1.1 才有群；这次四片都不碰 `to.kind === "group"`。
- **seq-pull 补洞**：QQ 靠 seq 向服务端要漏掉的消息，我们没有服务端。`seq` 只用来排序与「本机发现中间缺号」时在 UI 上提示一次，不实现补拉。

## 8. 施工顺序与验收

| 片 | 内容 | 验收（`bridge/tests/peer-e2e.mjs` 的对应断言） |
| --- | --- | --- |
| P1 | 会话元数据 + 未读 + 置顶/静音/草稿 | 未读按对方发来的条数算；打水位后归零、之后只算新来的；置顶排最前；静音与草稿只在本机 |
| P2 | `seq` + 三态 + 原 id 重发 | 消息带会话内单调的 `seq`；重发同 id 两边都还是一条；送达后 `state=delivered` |
| P3 | 撤回 + 引用 + 输入中 | 撤回后两边都折叠成 `recalled`（原文留在文件里）；重复撤回 400；超过 2 分钟 400 + 文案；输入中 3 秒窗口自己消失 |
| P4 | away 状态 + 通知 | `/status` 与在线表都带状态；`/presence` 打一次就是 online |

UI 侧另有 `bridge/tests/peer-ui.mjs` 的两条断言（未读徽标在头像上、静音只画小圆点）。

合之前的验证：`npm run build`、`npm --prefix web run typecheck`（含 i18n 与 viewport 守卫）、`node bridge/tests/peer-e2e.mjs`、`node bridge/tests/peer-history.mjs`、`node bridge/tests/peer-ui.mjs`（**串行**：同机多份内网通会互相发现）。界面文案一律 `tr()`，`en.ts` / `ja.ts` 已同步补 26 条。

## 9. 需要拍板的三件事

1. **未读徽标的位置**：QQ 在左侧入口挂红点、会话行里这次没观测到数字。我们照「会话行右上角数字 + 静音时小圆点」做，还是也把总未读挂在页面入口上？
2. **撤回窗口**：QQ 单聊是 2 分钟。内网通对端可能离线，2 分钟够不够？（更长会让「离线补投」与「已经不能撤回」撞在一起。）
3. **草稿要不要进 P1**：QQ 有独立 `MsgDraftMgr`，但这个页面重度使用人数少，草稿可以挪到 P1 之后单独一片。

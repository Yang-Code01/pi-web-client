# 内网通 v2：按 QQ 的会话逻辑重做

目标：把内网通从「能发文字的文件快递」升级成「像 IM 的 IM」——消息有生命周期、会话有未读、
有群、有草稿、有撤回和引用。设计基准是 QQ 9.9.19 的会话层（见「证据」一节），不是凭空发挥。

## 1. 证据

本机安装：`F:/soft/QQ/versions/9.9.19-35469`。REA 分析对象与结论：

| 产物 | 大小 | 结论 |
|---|---|---|
| `resources/app/wrapper.node` | 101,965,128 | 只有 OpenCV `cv::Mat` + llhttp 导出（50 个），**不是** IM 内核；sha256 `69377a3b…` |
| `resources/app/major.node` | 78,129,992 | 无 PE 导出，但字符串表里是 QQNT 内核的 N-API 绑定：**104 个 `nodeIKernel*Service/Listener`**；sha256 `4d6fe821…` |
| `resources/app/application.asar` | 14,731,336 | 1005 个文件全部解出，但 **JS/CSS/HTML 整体加密**（`.js` 是 80 字节密文块），拿不到前端实现 |
| 版本根 `QQNT.dll` | 191,459,656 | 内核本体，未展开（字符串层面的契约已足够） |

REA 证据 id（可复查）：

- `ev_369c93c0fd70ba76afdda1a18ab7356c850b65ff8ccd6041e2497ece9e1c7ff9` → `wrapper.node` 导出视图 `ev_3e6c75f9a662267e9338fdbc34ac02fa731fbe0ecb9f8d2a4a7117bf9f0a53ef`
- `ev_61526288a3792f700d10733da83efd07405b925f0298d11de2142338f115ac0c` → `major.node` 摘要 `ev_9e9a0423386bf3c7e894244d456dbf4bbc24566eec04c5b499977f339d76b3bf`

另一条走不通的路：本机 QQ 从未登录，`%APPDATA%/Tencent/QQ(NT)` 只有 `STemp`，全盘没有 `nt_msg.db`，
所以拿不到 SQLite schema，模型只能来自绑定层字符串 + 可观察行为。这一点决定了本文的每条设计都
标注「来自哪个符号」，而不是「QQ 应该是这样」。

## 2. QQ 的模型（绑定层证据）

### 消息记录

| 概念 | QQ 符号 | 说明 |
|---|---|---|
| 身份 | `msgId` / `msgSeq` | `msgId` 全局唯一；`msgSeq` 会话内单调，分页与未读都靠它 |
| 时间 | `msgTime` / `saveTime` | 发送时间 vs 落库时间，时钟偏差时后者排序 |
| 归属 | `peerUid` + `chatType` | 会话 = (对端, 类型)，群与 1:1 同一套记录 |
| 来源 | `sendType` | `kSendTypeSelf` / `kSendTypeLocal` / `kSendTypeOtherDevice` / `kSendTypeRecv` / `kSendTypeSelfForward` |
| 状态 | `sendStatus` | `kSending` / `kSuccess` / `kSuccessNoSeq` / `kSendFailed` |
| 内容 | `elements[]` | `kElemType{Text,Face,Pic,Ptt,File,Ark,Giphy,Markdown,MultiForward,OnlineFile,OnlineFolder,GrayTip}` |
| 撤回 | `recallTime` + `recallMsg(s)` | 撤回后原位留痕（GrayTip），不是直接消失 |
| 引用 | `forwardMsgWithComment` / reply 元素 | 引用是消息的一部分，不另建关系 |

关键点：**消息从创建那一刻就有状态**。`onAddSendMsg` 先在本地插一条 `kSending`，HTTP
（对 QQ 是长连接）返回后再由 `onSendStatusChange` 推到 `kSuccess`；`onTempMsgId` 把临时 id 换成
服务端 id。**没有「发出去才知道存不存在」这一档。**

### 已读与未读

- `setMsgRead`（本地标记）+ `setMsgReadAndReport`（上报）是**两个动作**，QQ 明确区分：
  读了不一定上报，上报才让对方看到已读。
- 未读是**算出来的**，不是存出来的：`unreadCnt`、`atMeUnreadCnt`、`atAllCnt`、`totalUnreadCnt`
- 定位未读：`getFirstUnreadMsgs` / `getFirstUnreadCommonMsg` / `getFirstUnreadAtMsg` /
  `getFirstUnreadAtallMsg` / `getFirstUnreadAtmeMsg`，配 `kUnreadJump`
- 会话内标记：`setUnreadPoint`；角标：`setUnreadBadge`；清零：`clearUnread` / `clearMsgUnreadCount`

### 会话（RecentContact）

`convId`、`peerUid`、`chatType`、`msgTime`、**`msgAbstract`**（摘要，如「[图片]」）、
`remark`（备注）、`isTop` + `topTime`（置顶且有独立的置顶时间，决定排序）、`unreadCnt`、
`atMeCnt`、`draft` / `draftTime` / `draftMsgElements` / `draftItems`。

### 事件

`onRecvMsg`、`onAddSendMsg`、`onSendStatusChange`、`onMsgInfoListUpdate`、`onMsgsDelete`、
`onRecentContactListChanged`、`onUnreadCntUpdate`、`onTempMsgId`、`draftChanged`、`typing`。

## 3. 内网通现状与差距

| 维度 | 内网通 v1 | 差距 |
|---|---|---|
| 消息状态 | `ack.status: delivered \| failed` | 没有 `sending`；没有已读；**「已送达」是本地伪造的** |
| 回执 | `acceptReceipt()` 只写日志 | 收端不落状态，发端 `outbox.settled` 自己 append 一条 `kind:"receipt"` |
| 顺序 | 无 `seq`，按文件行序 | 并发/补投会让顺序错乱，无法做「第 N 条」语义 |
| 内容 | `kind: text \| receipt \| file` 单一字段 | 不能引用、不能撤回、不能有系统提示 |
| 会话 | `last` 原文 + 在线标志 | 没有摘要/置顶/草稿/免打扰/未读 |
| 群 | 无（只有 `to.kind:"group"` 的位置） | — |
| 输入中 | 无 | — |
| 搜索 | 无 | — |

`acceptReceipt` 的现状（`peer/src/messages.ts`）是 bug 不是设计：

```ts
private acceptReceipt(receipt: any): InboxResult {
  const status = receipt.ack.status === "failed" ? "failed" : "delivered";
  this.ctx.log(`回执 ${ackId.slice(0, 8)} → ${status}`);   // 只打日志，不落状态
  return { status: 200, body: { ok: true } };
}
```

而发端的「已送达」来自 `peer/src/index.ts` 里 `outbox.settled` 自己写的一条 `kind:"receipt"`——
投递到对方的 HTTP 口就算「送达」，对方有没有存、有没有看，发端一无所知。

## 4. v2 协议设计

### 4.1 会话

```ts
type ChatType = "c2c" | "group";
type ConvId = `n:${string}` | `g:${string}`;   // n:nodeId / g:groupId
```

`Entry.to` 升级为 `{ kind, id }`（已有形状，保留），但新增 `conv: ConvId` 便于索引。

### 4.2 消息

```ts
interface Msg {
  v: 2;
  id: string;              // 发送方生成 uuidv7，全生命周期不变（不做临时 id：P2P 没有服务端改号）
  seq: number;             // 会话内单调递增；由发送方分配，接收方校验并回填缺口
  conv: ConvId;
  from: PeerIdentity;
  at: number;              // 发送方时钟
  saveAt: number;          // 本机落库时间（排序兜底，对齐 QQ 的 saveTime）
  sendType: "self" | "recv" | "otherDevice" | "selfForward";
  sendStatus: "sending" | "success" | "failed";
  elements: Elem[];
  quote?: { id: string; fromNode: string; abstract: string };
  recall?: { at: number; by: string };   // 撤回：留痕，不删除
}
```

`sendStatus` 只对 `sendType: "self"` 有意义（对收到的消息，状态恒为 `success`）。
与 QQ 的差别：不做 `kSuccessNoSeq`（我们没有「本地提示消息」这类无 seq 项，系统提示统一用
`gray` 元素但**也分配 seq**，这样未读与「跳到未读」不必特判）。

### 4.3 消息元素

```ts
type Elem =
  | { type: "text"; text: string }
  // face / image 留在类型里没实现：表情先用 unicode，图片走 file 元素（v2 不加缩略图管线）
  | { type: "face"; name: string }
  | { type: "file"; name: string; size: number; mime: string; sha256?: string; transferId?: string }
  | { type: "image"; name: string; size: number; mime: string; sha256?: string }  // 图片预览 = file + 内联缩略
  | { type: "gray"; tip: string; tone?: "system" | "danger" }        // 入群、撤回痕迹、群公告
  | { type: "at"; nodeId: string; nickname: string };                // 群里 @
```

单条上限：全部元素文本合计 32 KB（沿用 `MAX_TEXT_BYTES`），超出改用文件。

### 4.4 状态与持久化

历史仍是每会话一个 append-only JSONL（`~/.pi-peer/history/<convKey>.jsonl`），但**行有 op**：

```ts
type Line =
  | { op: "msg"; msg: Msg }
  | { op: "patch"; id: string; at: number; patch: Partial<Pick<Msg, "sendStatus" | "recall">> }
```

读取时 fold：`msg` 建条目、`patch` 改状态；「对方读到哪」不进历史，落在 `state.json` 的 `peerReadSeq`（它是个水位，不是可回溯的事件流）。
崩溃语义和现在一样便宜（最多丢最后半行）。

小状态（置顶/免打扰/草稿/已读位置）放 `~/.pi-peer/state.json`，原子写（`writeJson` 已有 tmp+rename）。

```ts
interface ConvState {
  seq: number;              // 本会话已分配到的最大 seq（发消息时先取号）
  readSeq: number;         // 我已读到哪（我发出的 read 的 seq）
  peerReadSeq: number;     // 对方读到哪（用于把 self 消息升成「已读」）
  draft?: { text: string; at: number };
  pinned?: { at: number };  // 对齐 QQ 的 isTop + topTime
  muted?: boolean;
}
```

### 4.5 控制消息（inbox 上的 `kind`）

沿用现有 `verifySource` + outbox（补投、去重、IP 校验白捡）。新增：

| kind | 载荷 | 作用 |
|---|---|---|
| `read` | `{ conv, seq }` | 对方读到 `seq`；发端把 `seq <= seq` 的 self 消息标「已读」 |
| `typing` | `{ conv }` | 输入中，接收方 5 秒过期；发送方节流 3 秒 |
| `recall` | `{ conv, id }` | 撤回请求；2 分钟内有效，接收方改为 `recall` + gray 元素 |
| `group-invite` | `{ group, members }` | 邀请入群，收端建群记录 |
| `group-sync` | `{ group }` | 成员表/群名变更（成员变更后由发起者扇出） |
| `group-leave` | `{ groupId }` | 退群 |

群消息复用 `kind:"text"`，只是 `conv` 为 `g:`。**扇出**：发送方对每个成员各投一次
（局域网内是毫秒级，成员上限先定 32）。没有中心节点，因此不保证全序，`seq` 由发送者各自维护、
接收方按 `(seq, id)` 排序——这就是 QQ 在弱网下的表现，也是 P2P 的现实。

### 4.6 已读的时序（对齐 `setMsgRead` / `setMsgReadAndReport`）

1. 收端进入会话且文档可见 → `readSeq = max(readSeq, 最后一条 seq)`
2. 落 `state.json`，并向对端发 `kind:"read"`
3. 对端 `acceptRead()` → 落一条 `read` 行 → 自己所有 `seq <= readSeq` 的 self 消息变「已读」
4. 前端双勾：`success` 单勾、「已读」双勾（QQ 的两次勾）

「读了不一定上报」也保留：窗口未聚焦时只本地标记，不上报（`document.visibilityState`）。

### 4.7 向后兼容

- `PROTO` 保持 1：旧对端收到未知 `kind` 回 400 retryable:false（已实现），只丢那一条控制消息。
- 旧历史行（无 `op`）在 fold 时当作 `{ op:"msg", msg: <旧 Entry> }` 读入。
- 前端 `Entry` 视图类型保留旧字段（`text`/`file`/`ack`），从 v2 `elements` 投影出来，避免一次性重写。

## 5. 落地情况（2026-11-18）

已实现：`peer/src/model.ts`（类型与 conv 助手）、`store.ts`（state.json：seq/readSeq/peerReadSeq/draft/pinned/muted）、`history.ts`（JSONL fold + patch + threads/search）、`messages.ts`（发送三态、已读上报、引用、撤回、转发、输入中、群）、`http.ts`（`/read /typing /recall /forward /search /conv /draft /groups /group/*`，并在 `wire()` 里把 v2 投影回 v1 字段）、`index.ts`（扇出计数 → `success/failed`）。界面按 QQ 的会话层重做（深色石墨 + 薄荷、置顶/未读/草稿/引用/撤回/群）。

刻意没做：`face`/`image` 元素、多端同步（`otherDevice` 只在类型里）、合并转发、群公告与群权限、「跳到未读」的键盘导航（只做了分隔线与未读计数）。`PROTO` 仍是 1。

### 5.1 2026-11-18 追加（D301）

- **文件不再要求好友**：`files.begin()`、`/files/send`、`/files/upload` 里的 `relations.isFriend` 门槛删掉，好友关系只剩「在不在好友列表」。安全边界换成「来源 IP 必须对得上 hello 过的节点」（`verify()`）+ `pauseFiles` + 收件盘余量。
- **下载 / 预览**：`GET /files` 认 `dl=1`（`content-disposition: attachment`），不带则按类型 inline；`GET /api/peer/meta` 给出落盘绝对路径，网页客户端拿它走 `openPreview`（收件箱在 D209 的 previewPins 里，会话目录之外也开得了）。
- **未读角标 / 系统通知**：客户端每 6s 拉一次 `/api/peer/threads`，把各会话 `unread` 求和画到内网通按钮上；总数变大时给最新一条非免打扰会话发浏览器通知（点击聚焦并打开面板）。
- **发文件的会话错位**：会话 key 改成 conv 之后，选择器把 nodeId 塞回 `S.thread`，界面看起来「跳到了一个没选好友的空会话」—— 现在 `pickerPeer` 单独记住这次发给谁，`convTarget()` 兜底。

## 6. 分期

见 `.scratch/qq-align/PLAN.md`（本地）。顺序按依赖排：存储 fold → 状态机 → 已读未读 → 会话列表 →
撤回/引用 → 输入中 → 群 → UI → 测试。

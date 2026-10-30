# 微信主动发送 + pi 会话文件尾部读取：实测报告

> 采信日期：2026-10-30（本机实测，非推测）
> 环境：Windows / MSYS bash / Node v24.11.1 / pi 1.4.0（`C:\Users\GG_Bond\AppData\Local\nvm\v23.11.1\node_modules\@earendil-works\pi-coding-agent`）
> 插件：`pi-wechat-assistant@0.6.4`（`C:\Users\GG_Bond\.pi\agent\npm\node_modules\pi-wechat-assistant`）

## 结论速览

1. **发送接口可以被任意非插件进程直接调用**：纯 HTTPS POST，鉴权只有 `Authorization: Bearer <bot_token>`，没有 IP 白名单、没有签名、没有设备指纹、没有会话 Cookie。本报告里的探针就是一个跟插件完全无关的 `node xxx.mjs`。
2. **但「能不能主动发出去」不取决于鉴权，取决于会话活跃度**。本次实测：HTTP 200 + `{"ret":-2,"errmsg":"prepare failed"}`。同一份 token 调 `getconfig` / `notifystart` 都返回 `ret:0`，说明 token 有效、只有 sendmessage 被拒。`ret=-2` 是 iLink 的「这段会话当前不允许 bot 主动发起」语义；插件自己的 FAQ 给的解法就是「从微信发一条新消息再重试」。
3. 认证失败**不是** `-2`：故意改坏 token 后返回 `{"errcode":-14,"errmsg":"session timeout"}`（HTTP 仍是 200）。注意这是 `errcode` 而**没有** `ret` 字段 —— 插件 `parseJsonResponse` 只在 `typeof body.ret === "number"` 时才抛错，所以这种响应会被插件当成**成功**。网页控制台自己实现时**必须同时检查 `ret` 与 `errcode`**。
4. 会话文件是**严格 append-only**（除了下面列出的 3 处 `_rewriteFile`）；实测本会话在 3 分钟内从 1787143 B 长到 1800654 B，首 2048 B 与 offset=100000 处 2048 B 的 sha 完全没变。逐行 JSON 解析 182 个文件 / 28548 行，**非法行 0**。所以「记住字节偏移、只读新增」是可行的，最低检测手段是 `size 变小` + `首行 header 比对`。

---

## 任务一：微信主动发送

### 1.1 凭证与状态文件结构（值已打码）

打码规则：**字符串只保留前 4 个字符 + 原长度**（`8fba…(len=58)`）；数字/时间戳原样；不含任何中间片段。本报告与所有探针输出都走这套规则。

`C:\Users\GG_Bond\.pi\agent\wechat-assistant\credentials.json`（254 B，5 个字段）：

| key | 类型 | 打码后的样子 | 含义 |
|---|---|---|---|
| `token` | string | `8fba…(len=58)` | bot token，直接进 `Authorization: Bearer` |
| `baseUrl` | string | `http…(len=29)` | 实测值 `https://ilinkai.weixin.qq.com`（29 字符） |
| `accountId` | string | `8fba…(len=19)` | `ilink_bot_id`，与 token 前缀同 4 位 |
| `userId` | string | `o9cq…(len=38)` | 绑定微信用户的 openid，发送时的 `to_user_id` |
| `savedAt` | string | `2026…(len=24)` | ISO 时间戳 |

`C:\Users\GG_Bond\.pi\agent\wechat-assistant\context-tokens.json`（264 B）：

```jsonc
{
  "lastUserId": "o9cq…(len=38)",
  "tokens": {
    "<userId@im.wechat>": "AARz…(len=136)"   // 键是 openid + "@im.wechat"，值是 context_token
  }
}
```

同目录另外三个状态文件（与发送无关，但别在控制台里读错）：`cursor.json`（`{cursor: ChAI…(len=104), updatedAt}`，getupdates 游标）、`seen-ids.json`（`{ids: string[40], updatedAt}`）、`session.lock`（`{pid:number, sessionId:string(len=52), protocol:1, timestamp:number}`，13 位毫秒时间戳）。

### 1.2 发送接口完整规格

源码位置：`C:\Users\GG_Bond\.pi\agent\npm\node_modules\pi-wechat-assistant\src\wechat\api.ts`

| 项 | 值 | 源码行 |
|---|---|---|
| method | `POST` | `api.ts:90-110`（`apiPost`） |
| URL | `{baseUrl}/ilink/bot/sendmessage`，即 `https://ilinkai.weixin.qq.com/ilink/bot/sendmessage` | `api.ts:135-158` |
| Content-Type | `application/json` | `buildHeaders`, api.ts:54-60 |
| 自定义头 1 | `AuthorizationType: ilink_bot_token` | api.ts:57 |
| 自定义头 2 | `Authorization: Bearer <token>` | api.ts:58 |
| 自定义头 3 | `X-WECHAT-UIN: <base64(十进制随机 uint32 的 ASCII)>`，进程级常量，每次进程启动随机一次 | api.ts:45-52 + 59 |
| 超时 | **15 000 ms**（`apiPost(..., 15_000)`），用 `AbortSignal.timeout`；通用默认 40 000 ms | api.ts:158 / api.ts:95 |
| 重试 | 无 network 重试；**仅** `ret=-2` 时去掉 `context_token` 重发一次 | `client.ts:221-231` |

请求体（`SendMessageReq`，见 `src/wechat/types.ts:126-140`）：

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<credentials.userId>",
    "client_id": "<randomUUID()>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<context-tokens.json 里 tokens[userId]>",
    "item_list": [{ "type": 1, "text_item": { "text": "正文" } }]
  },
  "base_info": { "channel_version": "1.0.0" }
}
```

- `message_type`：1=USER、2=BOT；`message_state`：0=NEW、1=GENERATING、2=FINISH（`types.ts:17-23`）。发消息固定 2/2。
- `item_list[].type`：1=TEXT、2=IMAGE、3=VOICE、4=FILE、5=VIDEO（`types.ts:25-31`）。媒体走同一个 URL 的 `sendMediaMessage`（`api.ts:293-315`），只是 `item_list` 换 item，且要先 `getuploadurl` + CDN 上传。
- `client_id` 每条消息必须是新 UUID（去重键）。

`context_token` 从哪来 / 怎么过期：

- 来源：只在**收到用户消息**时才有。`client.ts:398-409` `rememberContext()` 要求 `raw.message_type === 1 && from_user_id === 绑定 userId && raw.context_token` 才落盘；`client.ts:192` 启动时只恢复**属于当前绑定用户**的那个 token。
- 过期判断：**没有本地时间戳过期逻辑**，只有服务端反馈。`ret=-2` → 提示「从微信发一条新消息」；`errcode=-14` → `isSessionExpired()` 判为登录过期（`api.ts:236-238`），需要 `/wechat login --force` 重新扫码。
- 失败返回：`parseJsonResponse`（api.ts:63-88）—— HTTP 非 2xx 抛 `ApiError{status, code=errcode}`；HTTP 2xx 且 `ret !== 0` 抛 `ApiError{status, code: errcode ?? ret}`；**HTTP 2xx 且只有 `errcode`（无 `ret`）时不抛错，直接返回 payload**（这是我们实测到的 `errcode:-14` 分支，是个坑）。

### 1.3 实测结果（真发）

探针脚本（可留档重跑）：

- `./probes/tmp/wechat-send-probe.mjs` — 按 `api.ts` 规格原样构造请求并发送「pi-web-client 探针测试 <时间>」，失败时按插件的 `-2` 兜底再发一次
- `./probes/tmp/wechat-auth-probe.mjs` — 坏 token / getconfig / notifystart 三连，用来区分「鉴权失败」和「会话不活跃」
- `./probes/tmp/wechat-ctx-probe.mjs` — 伪造 context_token 与省略字段，测 `-2` 的语义边界

| # | 请求 | HTTP | 耗时 | 响应原文（≤500 字符） |
|---|---|---|---|---|
| 1 | sendmessage + 真 context_token | **200 OK** | **345 ms** | `{"ret":-2,"errmsg":"prepare failed"}` |
| 2 | sendmessage 无 context_token（兜底） | 200 OK | 269 ms | `{"ret":-2,"errmsg":"prepare failed"}` |
| 3 | sendmessage + 伪造 context_token | 200 OK | 333 ms | `{"ret":-2,"errmsg":"prepare failed"}` |
| 4 | sendmessage 省略 context_token 字段 | 200 OK | 255 ms | `{"ret":-2,"errmsg":"prepare failed"}` |
| 5 | sendmessage + 改坏 token（末 6 位改 AAAAAA） | 200 OK | 112 ms | `{"errcode":-14,"errmsg":"session timeout"}` |
| 6 | getconfig（真 token + 真 ctx） | 200 OK | 232 ms | `{"ret":0,"typing_ticket":"AARTBK8FAAAB…"}`（截断） |
| 7 | notifystart（真 token） | 200 OK | 314 ms | `{"ret":0}` |

响应头形态（每次一样）：`connection: keep-alive`、`content-type: application/octet-stream`（**不是** `application/json`，别按 header 判断）、`content-length: 36`。

**判定：这次没能发出去。** 消息没有到达微信，正文一个字都没送达（`ret=-2` 表示服务端在 prepare 阶段就拒了）。这不是网络、不是 token、不是 IP 白名单问题，而是**当前这段会话没有「活跃上下文」**：`context-tokens.json` 落盘时间 2026-10-28 01:46，本次发送是 2026-10-30 23:2x，中间用户约 **2.7 天**没有从微信发过消息。

「什么条件下会失败」的判定表（全部为实测或源码确证）：

| 现象 | 结论 | 依据 |
|---|---|---|
| `ret=0` | 成功送达 | 源码 `ret !== 0` 才抛错 |
| `ret=-2 / prepare failed` | 会话不活跃 / 无法主动发起。去掉或伪造 `context_token` **结果完全一样**（实测 #2 #3 #4），所以它不是「token 值无效」，而是「这段会话现在不接受 bot 主动消息」 | 实测 + `docs/faq.zh.md:18` |
| `errcode=-14 / session timeout` | token 本身失效（登录过期）→ 需要重新扫码 | 实测 #5 + `api.ts:236-238` |
| 网络层异常 | `AbortSignal.timeout(15000)` → `TimeoutError`；或 `fetch failed` + `cause.code`（DNS/ECONNREFUSED/TLS） | `api.ts:95-108` |
| IP 白名单 | **不存在**。本机直连 `https://ilinkai.weixin.qq.com/` 返回 404（连通），未配置任何代理也正常 | 实测 |

**恢复办法（供控制台 UI 提示用）**：让用户在微信里给 bot 发一条任意消息 → 插件（或任何消费 `getupdates` 的进程）收到后 `rememberContext` 写入新的 `context_token` → 再发即可。想立刻验证，重跑 `node ./probes/tmp/wechat-send-probe.mjs`。

### 1.4 能不能被非插件进程调用 / 会不会冲突 / 有没有频率限制

**能。** 发送是**无状态 HTTPS 请求**：服务端不认识「哪个进程」，只看 bot token + 目标 openid + context_token。已经实测由外部 node 进程发出请求并拿到 200 与业务态 JSON。

**与插件同时运行会不会冲突**：

- 发送本身不冲突。iLink 不用长连接/独占会话来做发消息，N 个进程并发 POST 不会互相顶掉。
- 会冲突的是**本地状态文件**和**收消息**：
  - `session.lock`（PID 锁）只保护「谁在轮询 getupdates」，不保护「谁在发消息」。`src/bridge/bridge-lock.ts:19-31` 用 `process.kill(pid, 0)` 判活，`ESRCH` → `stale`；本机现在的 `session.lock` 是 **2026-10-28 01:46 的僵尸锁**（`pid:26744` 已被无关的 bash 复用），所以桥接当前没在跑。
  - `context-tokens.json` / `cursor.json` 被插件**整文件重写**（`transport-state.ts:60-63` 写临时→rename，`client.ts:414-419` 节流写）。外部进程**只读**这两个文件是安全的；**不要写**，也不要高频读后缓存做长期判断。
  - 两个 `getupdates` 轮询者会互相推进 cursor → 丢消息。若控制台要收消息，必须走插件（或自己拿锁），不能与桥接并行轮询。
- 结论：控制台**只发不收**时可以不碰锁；要收消息必须尊重 `session.lock`。

**频率限制**：源码里**没有**任何发送端限流（无 429 处理、无最小间隔、无令牌桶；只有收消息轮询的指数退避 `POLL_RETRY_BASE_MS=1000 → POLL_RETRY_MAX_MS=10000`，`shared/constants.ts:7-8`）。唯一的「节流」是**长文本分片**：`splitAndFilterMarkdown(text, 800)`，默认 800 字符/条（`src/messaging/message.ts:2-3`），逐片串行 `await sendText`。服务端是否有隐藏配额本报告无法证明；建议控制台自行做 ≥1 条/秒 的软限速 + 失败退避。

---

## 任务二：pi 会话文件能否安全只读 tail

### 2.1 目录与文件命名规则

根目录 `C:\Users\GG_Bond\.pi\agent\sessions\`，下辖 **16 个目录 / 182 个 `.jsonl`**，共 634.3 MB。

目录名 = cwd 编码，规则在 `dist/core/session-manager.js:290-295`：

```js
const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
return join(resolvedAgentDir, "sessions", safePath);
```

即：去掉开头的 `/` 或 `\`，把 `/`、`\`、`:` 全换成 `-`，两边包 `--`。实例（与 cwd 一一对应）：

| 目录 | 对应 cwd |
|---|---|
| `--F--pi-web-client--` | `F:\pi-web-client` |
| `--C--Users-GG_Bond--` | `C:\Users\GG_Bond` |
| `--C----` | `C:\`（`C:\` → 去前导 `\` 剩 `C:` → `C-` → `--C---`） |
| `--c--Users-GG_Bond-WorkBuddy-2026-09-21-00-41-51--` | 小写盘符 `c:` 的另一种写法，说明**大小写/写法不同会产生不同目录**，不能互相推导 |

文件名 = `{ISO 时间戳，冒号与点换成 -}_{sessionId}.jsonl`，例如
`2026-10-30T14-26-00-308Z_01a18d34-09f4-724b-9a44-a0d9dd46e0fa.jsonl`（源码 `session-manager.js:705-707`）。

体积分布（重要）：中位数 ≈ 116 KB，最大 **290.3 MB**（`--C--ai-library-performance-library--\2026-10-19T18-11-09-055Z_01a1555c-367f-7050-9581-f622773c5b05.jsonl`），另有 74.4 MB、44.7 MB 各一。**外部读取绝不能每次从头全文 parse**。

### 2.2 行结构

- 第一行恒为 header：`{"type":"session","version":3,"id":"<uuid>","timestamp":"2026-10-30T14:26:00.308Z","cwd":"F:\\pi-web-client"}`，可选 `parentSession`。实测 182 个文件 **100% 是 `type:"session"` 且 `version:3`**。
- 之后每行一个 entry，都有 `type`、`id`（**8 位短 hex**，如 `10688343`，不是 uuid）、`parentId`、`timestamp`；`message` 类还有 `message: {role, content, ...}`。构成 parentId 树（branch 就靠它），不是线性日志。
- 每行以 `\n` 结尾，文件末尾也有换行（实测 182 个文件**全部**以 `\n` 结束，无一例外）。

**逐行 `JSON.parse` 统计（全量 182 文件）**：

| 指标 | 值 |
|---|---|
| 总行数 | 28 548 |
| **非法 JSON 行** | **0** |
| 空文件 | 0 |
| 无尾换行 | 0 |
| header 版本 | `v3` × 182 |

`type` 分布（全量）：

| type | 次数 |
|---|---|
| `message` | 27 258 |
| `custom` | 454 |
| `model_change` | 311 |
| `thinking_level_change` | 215 |
| `session` | 182 |
| `context_edit` | 121 |
| `custom_message` | 4 |
| `compaction` | 3 |

最近 3 个会话文件（按 mtime）：

| 文件 | 字节 | 逻辑行 | 非法行 | type 分布 |
|---|---|---|---|---|
| `--F--pi-web-client--/2026-10-30T14-26-00-308Z_01a18d34-….jsonl` | 1 764 079 | 220 | 0 | `session`:1, `model_change`:1, `thinking_level_change`:1, `message`:216, `custom`:1 |
| `--F--meeting-translate--/2026-10-25T13-26-14-285Z_01a1733d-….jsonl` | 460 423 | 105 | 0 | `session`:1, `model_change`:1, `thinking_level_change`:1, `message`:81, `custom`:21 |
| `--C--ai-library-performance-library--/2026-10-19T18-11-36-762Z_01a1555c-….jsonl` | 15 331 926 | 311 | 0 | `session`:1, `model_change`:2, `thinking_level_change`:1, `message`:265, `custom`:42 |

（注：最近 3 个里没出现 `label` / `compaction` / `context_edit`；它们在全量里存在，见上表。`custom` 的 `customType` 例：`pi-checkpoint`，`data` 里带 `beforeCommit` / `afterCommit` / `turnId`。）

样例（首 4 行的 type/keys）：

```text
line1 type=session              keys=type,version,id,timestamp,cwd
line2 type=model_change         keys=type,id,parentId,timestamp,provider,modelId
line3 type=thinking_level_change keys=type,id,parentId,timestamp,thinkingLevel
line4 type=message              keys=type,id,parentId,timestamp,message
```

### 2.3 `_rewriteFile` 的调用点清单

`_rewriteFile()` 定义在 `dist/core/session-manager.js:754-766`：

```js
_rewriteFile() {
    if (!this.persist || !this.sessionFile) return;
    const fd = openSync(this.sessionFile, "w");          // ← 截断式打开
    try {
        for (const entry of this.fileEntries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    } finally { closeSync(fd); }
}
```

**全 `dist/` 只有这一处 `openSync(this.sessionFile, "w")`**（`dist/bundle/chunks/chunk-MM3LKT73.js` 里把同一份代码 inline 后又出现一次，运行时走的是 bundle 那份，3 个调用点完全相同）。调用点只有 3 个：

| # | 位置 | 触发操作 | 触发条件 | 对旧文件的破坏性 |
|---|---|---|---|---|
| 1 | `session-manager.js:665-689`（`_setSessionFile` 内） | 打开/恢复一个**已存在**的会话文件 | 文件存在、解析出的 entries **为空**、且 `statSync.size === 0` → `newSession()` + `_rewriteFile()` 写 header。若 size > 0 但解析不出任何 entry，**直接抛错** `Session file is not a valid pi session: <path>`，不动文件 | 文件本来就是 0 字节，无损失 |
| 2 | `session-manager.js:719-724`（`_loadEntries` 内） | **打开（resume / --session / 列表载入）一个旧版本会话文件** | `migrateToCurrentVersion(this.fileEntries)` 返回 true，即 header `version < CURRENT_SESSION_VERSION(=3)`（`session-manager.js:11`, `75-85`；v1→v2、v2→v3） | **整体重写、内容可能变化**（迁移会改 entry 形状）。当前 182 个文件全是 v3，所以现在不会触发；但老文件一被打开就中 |
| 3 | `session-manager.js:1205-1292`（`createBranchedSession` 内） | `/branch`、fork（`agent-session-runtime.js:220,240`） | 有 conversation 时 `_rewriteFile()` | 写的是**新文件**（`this.sessionFile = newSessionFile` 在前），旧文件不受影响 |

**明确不会重写/截断的操作**（都只 append）：

- 发/收消息、工具调用结果 → `appendMessage` → `_appendEntry` → `_persist` → `appendFileSync`（`session-manager.js:812`）
- 改 label → `appendLabelChange`（`session-manager.js:1034-1058`，调用点 `agent-session.js:2797, 3388, 3401`、`modes/interactive/interactive-mode.js:4705`）追加 `type:"label"` entry
- 压缩 `/compact` → `appendCompaction`（`session-manager.js:880-895`）追加 `type:"compaction"`
- 编辑历史上下文 → `appendContextEdit`（`session-manager.js:958-990`）追加 `type:"context_edit"`
- 扩展自定义消息 → `appendCustomMessageEntry`（`session-manager.js:948-957`）追加 `type:"custom_message"`
- 分支跳转 `branch()` / `resetLeaf()`（`session-manager.js:1161-1174`）**只改内存里的 `leafId`，不写文件**
- `_appendEntry` 是**唯一**调用 `_persist` 的地方（`session-manager.js:814-820`），所以「所有新增都经过 appendFileSync」这一点是结构性的，不是约定

另外两处**会写**但都是「新建文件」：`_persist` 首次落盘用 `openSync(sessionFile, "wx")`（`session-manager.js:800`，`wx` = 已存在则 EEXIST 失败，不会截断已有文件）；静态 fork 用 `writeFileSync(newSessionFile, ..., {flag:"wx"})`（`session-manager.js:1406`）。

还有一个**容易被漏掉的写**：`loadEntriesFromFile`（`session-manager.js:325-368`）在读完一个「最后一行没有 `\n`」的文件后，会 `appendFileSync(resolvedFilePath, "\n")` 补一个换行（第 367 行）。这不破坏偏移，但 tail 端要有心理准备：**文件 size 可能在两次 stat 之间莫名 +1，且新增字节只有 `\n`**。

### 2.4 tail 会读到坏数据的场景

从 0 读到 EOF、记住 `offset`、之后只读 `[offset, size)` 的方案，只在下面这些时刻会读到坏数据：

1. **打开旧版本（version < 3）会话文件** → 调用点 2 的整体重写。文件 size 可能变大也可能变小，行内容与行顺序都可能变；offset 之后的内容跟之前不再连续。
2. **重写进行中的瞬时状态** → `openSync("w")` 先截断到 0，再逐 entry `writeFileSync`。中间任一时刻的文件都是「前缀完整、尾部半行」；tail 若在这个窗口读到，会拿到被切断的 JSON，或者读到 size=0 而误判「没有新数据」。
3. **文件被换成另一个更小的文件**（迁移后、或人工替换）→ offset 超过 size，读到空，看起来「没有新数据」，实际上整段历史都换了。
4. **尾部半行**（正常 append 也会遇到）：`appendFileSync` 是一次系统调用写整行，但 reader 读到的瞬间仍可能是「行还没写完」的前缀。**这不是坏数据，只是要等下一次读**。

注意第 4 点与 1–3 本质不同：前者只要「只消费到最后一个 `\n` 之前」即可；后者必须**丢弃 offset 重新从 0 扫**。

实测的 append-only 证据（2026-10-30 15:12:48 → 15:16 之间，本会话正在被 pi 写入）：

```text
baseline: size=1787143  head2048.sha=e72cb63ba7774d01  mid@100000.sha=0e07b9e083072966
later   : size=1800654  head2048.sha=e72cb63ba7774d01  mid@100000.sha=0e07b9e083072966   (delta=+13511)
```

即：**只增不改**，历史字节完全稳定。

### 2.5 tail 安全实现建议（最小检测手段）

推荐顺序（越靠前越便宜；越靠后越兜底）：

1. **`size` 单调性检查（必须）**：`st.size < offset` → 判定被截断/重写 → **offset 归 0，清空已解析状态，全量重扫**。最便宜的检测，覆盖场景 2、3 的绝大多数。
2. **`size === 0 && offset > 0`**：正在被 `openSync("w")` 重写 → 不要立刻重置，先 sleep 50–200 ms 再 stat（内容会很快长回来）。用「连续 2 次观察到 0」判定为真重置。
3. **首行 header 校验（必须）**：读前 4096 B（pi 自己也是用 `SESSION_HEADER_READ_BUFFER_SIZE = 4096` 读 header 的，`session-manager.js:304`），取出第一行 `session` entry，记住 `{id, version, cwd, timestamp}`。与上次不同 → 换文件了 / 被重写成另一个会话 → 重扫。顺带用 header 的 `id` 当「这是哪个会话」的唯一键，比文件名可靠（文件名里虽含 sessionId，但别依赖它）。
4. **首行哈希 / 哨兵字节比对（推荐，成本极低）**：记住 `sha256(file[0..512))`（或干脆记住 header 行的原始字节），每次读新数据前重读这 512 B 比对。重写会把 header 重新序列化，即使语义相同、字节也可能变（迁移会改字段），所以这一个检查同时兜住「size 恰好没变的小改写」。
5. **只消费完整行**：读 `[offset, size)` 后，仅在**最后一个 `\n`** 处切分；`\n` 之后的不完整片段留在内存缓冲，`offset` 只推进到最后一个 `\n` 的下一字节。**绝不**把「没有 `\n` 结尾的最后一行」当数据解析，也**绝不**为了凑行去阻塞等待。
6. **解析失败容错**：单行 `JSON.parse` 失败 → 计数并跳过（pi 自己也是 skip malformed，见 `parseSessionEntries` / `parseSessionEntryLine`）；若**连续 ≥3 行**失败，或本次新增里失败行占比 >10%，视为被重写 → 回到第 1 步全量重扫。这样能容忍一次瞬时半行，又不会被真正的损坏带走。
7. **单次读取上限**：大文件（本机有 290 MB 的）首次全量读要分块（pi 用 1 MiB 缓冲，`SESSION_READ_BUFFER_SIZE = 1024*1024`），增量读也要设上限（如每轮最多 4 MiB），否则一次追平大文件会卡死事件循环。
8. **轮询节奏**：`fs.watch` 在「另一个进程 append」场景下于 Windows 上并不可靠（可能漏事件、可能在写入未完成时触发）。建议 `fs.watch` 只做「提前唤醒」信号，真实触发仍是 200–500 ms 的 stat 轮询。
9. **只读打开**：`openSync(path, "r")` / `createReadStream`，绝不 `"r+"`；每次读前重取 `statSync`，不缓存 stat。

关于「当前 leaf / 当前 label 状态」的警告（对控制台展示很关键）：

- 文件里**没有**「当前 leaf 指针」。`branch()` / `resetLeaf()` 只改内存（`session-manager.js:1161-1174`）。外部读者唯一能用的近似是「最后一行 = leaf」，这与 pi **重新打开文件时**的行为一致（`_buildIndex` 按行序把 `leafId` 覆盖成最后一个 entry，`session-manager.js:729-748`）。
- `label` 是**追加型 entry**，不是对目标行的就地修改：最新一条 `{targetId, label}` 生效，`label` 为空串表示清除（`_buildIndex` 里 `labelsById.delete(targetId)`）。要正确解析 label，全量扫一遍即可；增量场景维护一个 `Map<targetId, label>` 就够。
- entry 是树（`parentId`），不是线性日志。要在 UI 里画分支，必须保留全量 entry 或至少维护 id→parentId 图；只 tail 新增部分时，若新 entry 的 `parentId` 指向更早的 entry，需要历史索引仍在内存里 —— 这也是「首行 header 变了就必须全量重建」的原因。

### 2.6 一句话回答交付问题

- **能安全只读 tail 吗？** 能。文件在正常使用中严格 append-only（唯一重写路径是旧版本迁移，而本机全部是 v3）。
- **哪些操作会读到坏数据？** 只有「打开 version < 3 的老会话」触发的那次整体重写，以及重写瞬间的中间态。
- **最小检测手段？** `st.size < offset`（截断/OOM 型重写）+ 首行 header 的 `{id, version}` 或前 512 B 哈希变化（换文件/原地重写）+ 只消费到最后一个 `\n`（半行）。三个条件任一命中就丢弃 offset、从 0 重扫。

---

## 附：本次留下的探针脚本

| 路径 | 作用 | 是否可重跑 |
|---|---|---|
| `./probes/tmp/wechat-send-probe.mjs` | 按插件规格发一条测试消息，带 `-2` 兜底 | 是（用户从微信发消息后可立即复验） |
| `./probes/tmp/wechat-auth-probe.mjs` | 坏 token（`errcode:-14`）/ getconfig / notifystart 三连 | 是（notifystart 会让 bot 显示上线，轻微副作用） |
| `./probes/tmp/wechat-ctx-probe.mjs` | 伪造 / 省略 context_token，验证 `-2` 语义 | 是 |

三个脚本都只读 `credentials.json` 与 `context-tokens.json`，不改任何状态文件；输出中的 token/openid 一律 `前4位…(len=N)` 打码。

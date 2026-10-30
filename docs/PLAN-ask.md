# PLAN · 网页端「问用户」通道（ask-user）

目标：模型在**网页会话**里调用 `question` / `questionnaire` 时，问题能到达网页，用户作答后模型继续；
不再是 `Error: UI not available (running in non-interactive mode)`。

## 为什么原来不行（已核实）

1. `~/.pi/agent/extensions/question.ts:57` 与 `~/.pi/agent/extensions/questionnaire.ts:76`
   都有 `if (ctx.mode !== "tui") return errorResult(...)` —— 桥用 `pi --mode rpc` 起的子进程，`ctx.mode === "rpc"`。
2. 就算放开这个门，桥也扛不住：`bridge/src/sessions.ts:587-607` 的 `onUiRequest` 只认
   `confirm|select|input|editor`，把 `req.options` 丢掉、塞进一个 `ApprovalRequest{title,message}`；
   `answerApproval` 只会回 `{confirmed:true|false}` / `{cancelled:true}`，**永远不回 `value`**。
3. pi 的 RPC 子协议（`pi/docs/rpc-extension-ui.md`）只暴露 select/confirm/input/editor，
   `ctx.ui.custom()` 在 rpc 下返回 `undefined` —— 多题 tab UI 根本表达不出来。

## 方案（三条已定）

- **通道**：桥内部 HTTP 旁路。扩展在 `ctx.mode === "rpc"` 时把完整问题 payload POST 到
  `http://127.0.0.1:<port>/api/ask`（env 注入 `PI_WEB_ASK` + 每子进程一个 token，照 `PI_WEB_ALLOW_FILE` 的旧例），
  桥推 WS、等答案、原样返回 `{questions, answers}`。不走 pi 的 RPC 对话框，所以不碰终端的 UI 语义。
- **扩展**：原地改全局 `question.ts` / `questionnaire.ts`（先备份 `.bak.<时间戳>`），不另发一份工具。
- **留痕**：答过的 Q/A 落成聊天里的气泡 —— 从 tool item 的 `args` + `result` 文本重建，刷新后仍在。

## 顺带定掉的（沿用现有约定，不再问）

| 点 | 做法 |
| --- | --- |
| 鉴权 | `answer` 与 `approve` 同级，走 `requireStepUp()`（`bridge/src/index.ts:301`） |
| 推送 | 复用 `sessions.on("approval")` 那条路（`bridge/src/index.ts:281-285`），一份问卷只推一次 |
| 重连 | pending ask 只在桥内存，`snapshot()` 随快照补发（照 approvals 的做法），不落盘 |
| 取消 | `abort()` 里 `clearAsks()`，以 `cancelled` 收尾；迟到的答案丢弃并回 notice |
| 独占 | 只有 `owned` 会话能产生问题 |
| 超时 | **无超时**（Q1 推荐项）：一直挂在桥里，只有「作答 / abort / 进程退出」能结束；HUD/队列要显示还有几个待答 |
| 多题 | tab + 显式「提交」，可回改前面的题；单题点选即答；都带「取消」 |
| 位置 | 底部抽屉（选项/描述/自己写都在里面）+ composer 上方一条「1 个待答 · 点此回答」 |

## Wire

服务端 → 客户端（WS，和 `approval.add` 同层）：

```ts
{ type: "ask.add", sessionId, ask: AskRequest }
{ type: "ask.remove", sessionId, id, status: "answered" | "cancelled", answers?: Answer[] }
```

```ts
interface AskOption { value: string; label: string; description?: string }
interface AskQuestion { id: string; label: string; prompt: string; options: AskOption[]; allowOther?: boolean }
interface AskRequest { id; sessionId; sessionName; questions: AskQuestion[]; createdAt: number }
interface Answer { id: string; value: string; label: string; wasCustom?: boolean }
```

客户端 → 服务端：

```ts
{ type: "answer", sessionId, askId, answers: Answer[] }   // 需 step-up
{ type: "answer", sessionId, askId, cancelled: true }
```

子进程 → 桥：

```
POST /api/ask   x-pi-web-token: <token>
{ sessionId, token, tool: "question"|"questionnaire", questions: AskQuestion[] }
→ 200 { answers: Answer[] | null, cancelled: boolean }
```

防护：该路由**必须放在 `if (!ok)` 鉴权闸之前**（子进程没有 cookie），自带三道检查 ——
`isTunnelRequest(headers)` 为真直接 403（公网永远进不来）、peer 必须是回环、token 必须匹配某个 session。

## 改动清单

1. `bridge/src/sessions.ts` — `AskRequest/AskQuestion/Answer` 类型；`Session.asks`（`Map<id, PendingAsk>`）+
   `askToken`；`ask(questions)` 返回 `Promise<{answers,cancelled}>`；`answerAsk` / `cancelAsk` / `clearAsks`；
   `state.asks` 计数；`snapshot()` 带 `asks`；`abort()` / `close()` / exit / `sweepGc` 里照顾 pending ask；
   `startLive` 注入 env；`SessionManager.byAskToken()`。
2. `bridge/src/index.ts` — `POST /api/ask` 路由（闸前）；WS `answer` 分支（闸后，`requireStepUp`）；`ask` 事件 → 推送；
   `new SessionManager(pi.cli, { askUrl })`。
3. `web/src/types.ts` — 三个 ask 类型 + `SessionState.asks`。
4. `web/src/app.ts` — `asks` 状态；`ask.add`/`ask.remove` 处理；`renderAsks()` 顶条；`openAskSheet()` 抽屉；
   `renderQueue()` 加「等你回答」；会话卡待答徽标。
5. `web/src/chat.ts` — `question`/`questionnaire` 的 tool 卡：等待中显示提示，答完渲染 Q/A 气泡。
6. `web/src/styles.css` — `.askbar` / `.ask-sheet` / `.qa` 三组样式。
7. `~/.pi/agent/extensions/question.ts`、`questionnaire.ts` — rpc 分支（`askOverBridge`），TUI 分支一行不动。

## 实现状态（已落地）

- 桥：`bridge/src/sessions.ts`（`ask/answerAsk/cancelAsk/clearAsks`、`askToken`、`snapshot().asks`）、`bridge/src/index.ts`（`POST /api/ask` 闸前 + WS `answer` 闸后 + `ask` → push）。
- 世界：`web/src/{types,app,chat}.ts` + `styles.css`；扩展：`~/.pi/agent/extensions/{question,questionnaire}.ts`（`.bak.20261031-031735`）。
- 测试：`npm run test:ask`（unit + e2e，13 项）、`npm run test:ask:ui`（Chromium，19 项）、截图 `.scratch/shots/ask-*.png`。
- 决定记录：`DECISIONS.md` D47。

## 验收清单

- [x] 网页会话里让模型调 `question`：问题出现在抽屉 + 顶条，选一个 → 模型拿到 `User selected: N. xxx` 继续。
- [x] `questionnaire` 两题：tab 切换、改前一题、提交后两题答案一起到达（`Q1: user selected…` 两行）。
- [x] 「自己写」输入 → `User wrote: ...`。
- [x] 抽屉里点「取消」→ 模型收到取消结果，不再空等。
- [x] 提问期间刷新页面：快照补发，抽屉重新出现，答完不丢。
- [x] 提问期间点「停止运行」：pending ask 以 `cancelled` 收尾，HTTP 请求返回，子进程不悬挂。
- [x] 公网隧道访问 `/api/ask` → 403；错 token → 403；非 loopback → 403。
- [x] 终端里跑 `question` 行为与改动前完全一致（TUI 分支未被触碰）—— 代码路径未改，未实机复验。
- [x] `npm --prefix bridge run typecheck`、`npm --prefix web run build` 通过。

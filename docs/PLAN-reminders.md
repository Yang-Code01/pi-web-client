# PLAN · 提醒中心（reminders）

目标一句话：**你正看着页面时，别的会话在等你审批/回答，页面上要有个东西当场叫到你**；叫过的事留得下痕迹，吵不吵得自己拧。

决定与理由在 `docs/DECISIONS.md` 的 **D389**，词义在 `GLOSSARY.md` 的「提醒 / 提醒中心」「非阻塞提醒」。这份文件只管怎么落地。

**不做**（D389 已列）：免打扰时段、按类别逐条白名单、微信单独关、清单里直接批/答、把非阻塞提醒也推出去、与内网通未读合并。

## 已核实的事实（写代码前看这些，别再翻一遍）

| 事实 | 位置 |
| --- | --- |
| 唯一的推送判据是「有页面可见且聚焦就不推」 | `bridge/src/index.ts:2498` 的 `shouldNotify` + `bridge/src/presence.ts` 的 `anyPresent()` |
| 页内唯一的跨会话痕迹是左栏会话卡上那行「待确认 N」/「待回答 N」 | `web/src/app.ts:217`（`s.approvals` / `s.asks` 数） |
| 会话状态里**只有计数、没有文案** | `bridge/src/sessions.ts:260-261`（`approvals: number`、`asks?: number`） |
| 两条要接的流 | `bridge/src/index.ts:2515`（`sessions.on("approval")`）、`:2523`（`sessions.on("ask")`） |
| 处理动作的落点（批 / 拒 / 取消 / 过期） | `bridge/src/sessions.ts:2056` `answerApproval`、`:2142` `cancelAsk`、`:3233`/`:3234` 没人看时过期、`:2084`/`:2154` 整轮结束时清理 |
| 设置页「通知」那一屏 | `web/src/app.ts:13740` 的 `paintNotify()`（开关、Web Push 设备、发测试通知） |
| 状态目录读写 | `bridge/src/paths.ts:113` `statePath()`、`:193` `writeJson()` |
| 帧词表（D388 的规矩：词表是叶子，0 import） | `bridge/src/frames.ts` |
| `node tools/notices.mjs` 是**第三方许可**清单，与提醒无关 | 别被名字骗 |

## 数据模型（新文件 `bridge/src/reminders.ts`）

```ts
export type ReminderKind = "approval" | "ask" | "notice";
export type ReminderState = "waiting" | "handled" | "read" | "stale";
export type ReminderOutcome = "approved" | "rejected" | "answered" | "read" | "stale";

export interface Reminder {
  id: string;              // 桥端生成；approval/ask 直接复用那两边的 id，便于去重
  kind: ReminderKind;
  sessionId?: string;      // notice 类可能没有
  sessionName: string;
  title: string;           // 「需要你批准 · api-重构」
  body: string;            // 一行摘要（审批命令 / 第一题题干 / 脚本给的正文），≤ 140 字
  createdAt: number;
  state: ReminderState;
  outcome?: ReminderOutcome;
  settledAt?: number;
}
```

常量（D389 说这三个数是默认值，可改）：

```ts
const REMINDER_KEEP_DAYS = 7;
const REMINDER_CAP = 500;
const REMINDER_COALESCE_MS = 30_000;
```

落盘 `state/reminders.json`：`{ items: Reminder[], muted: string[] }` 一个文件、整份 `writeJson()`（≤500 条，重写不心疼）。**不写 JSONL**：这里没有「只追加」的需求，已处理是原地改一行。

三条不变量，写单测盯住：

1. 同一 `sessionId + kind` 在 `REMINDER_COALESCE_MS` 内只留**一条**吐司（计数不合并，角标照涨）。
2. `waiting` 的条目在桥启动时**一律**转 `stale`（`outcome: "stale"`）—— 那些 `pi --mode rpc` 子进程已经死了，卡本身不存在了。
3. 超出 `REMINDER_CAP` 或早于 `REMINDER_KEEP_DAYS` 的，从**最旧的**开始丢；`waiting` 的一条都不丢。

## 桥端接线

1. `Reminders` 实例挂在 `bridge/src/index.ts`（挨着 `notifier`）。
2. 两条流各加一段：有 `sessionId` 就 `reminders.add({kind:"approval"|"ask", …})`，**先记后推**（记完广播，再走原来的 `notifier.notify`；推送行为本身不动，D389 第 11 条）。
3. 处理落点：`answerApproval` / `cancelAsk` / 过期清理三处各回一次 `reminders.settle(id, outcome)`。**不要**在 `index.ts` 的 WS `approval.answer` 臂里写 —— 过期、整轮结束、终端那边答的都不会经过那条臂。
4. 停用某会话：`reminders.mute(sessionId, on)`，与 D389 第 9 条一致（不弹、不计角标、不推 —— **推**这一半要落在 `shouldNotify()` 的调用处，加一个 `!reminders.mutedSession(sessionId)`）。
5. 桥启动：`reminders.markStaleAll()` 在 `main()` 起来、会话表建立**之前**跑一次。
6. 帧（`bridge/src/frames.ts`）：`ServerFrameType` 加 `"reminders"`（载荷整份列表 + 开关状态），`ClientFrameType` 加 `"reminder.mute"` / `"reminder.read"`。这两个动作**不走** `requireStepUp()`（低风险，与 `notify.set` 那个总开关不同）。
7. HTTP：
   - `GET /api/reminders` → 整份列表（刷新/重连用；平时靠 WS 帧）。
   - `POST /api/notify` → `{ title, body, url?, sessionId? }`，落成 `kind:"notice"` 的提醒。鉴权：页面 cookie，或脚本 `X-Notify-Token: <state/notify-token>`（首次启动生成、权限 600）。
   - `/api/me` 加 `reminders: { enabled, blocking, others }`，给设置页读。
8. 路径（清单里一条非阻塞提醒点了去哪）：`url` 有这个字段，有就发一个「打开这个地址」给页面，没有就不可点。

## 页面

新文件 `web/src/reminders.ts`（数据 + 清单渲染）与 `web/src/remind-toast.ts`（吐司队列），`app.ts` 只负责接线：

- **角标**：`button.remind-badge` 插在顶栏 `collapseRight` 之前（`web/src/app.ts:1008` 那个 `topbar.append(...)` 一行里加）。零条时 `hidden`，数字 = `waiting` 条数（含当前会话）。
- **清单**：点角标开 `div.remind-pop`，跟现有浮层的开关语义一致（点外面关、Esc 关、不做模态 dialog）。分组：`等你` / 已处理（按天分组，折叠）。
- **跳转**：`openSession(id)` 之后滚到那张卡 —— 审批卡 `approvalCard(a)`（`app.ts:17475`）、问答卡走 `askCard`，给两种卡加一个稳定的 `data-reminder-id`，跳转时 `querySelector` 然后 `scrollIntoView({ block: "center" })`，加一次 `.pulse` 高亮。会话已经不在（被删 / 归档）→ 那一条灰掉不可点。
- **吐司**：右上角，6 秒，悬停暂停，最多同时 3 条（多了排队）。整块挂进 `#app`（跟随 `--ui-scale`），**不许写裸 `vh` / `vw`**；`npm run test:viewport` 会红。窄版用 `@container` 判宽，不用 `@media`。
- **静态样式**：照 `.fail-toast`（`web/src/styles.css:4171`）那套来，别另发明一套视觉。

设置 →「通知」（`paintNotify()`）加一组「页面内提醒」：

| 行 | 控件 | 文案要点 |
| --- | --- | --- |
| 页面内提醒 | 开关 | 关掉只是不弹，顶栏角标照常计数 |
| 阻塞类（审批 / 提问） | 开关 | 弹右上角 |
| 其它（脚本 / 构建 / 定时） | 开关 | 只进清单，默认不弹 |

与现有的「需要你时发通知」那一行分工要写清：那一行管**越过屏幕**，新的一组管**就在屏幕里**。

## i18n

所有界面文案 `tr("中文原文")`，`en.ts` / `ja.ts` 各补一条 —— 漏一条 `npm --prefix web run typecheck` 会红（`web/i18n-check.mjs`）。桥端 `notifyTitle()` 那套三语已在 `bridge/src/index.ts` 里，`reminders.ts` 造标题时复用同一份，不要另写一份中文。

## 测试

1. `bridge/tests/reminders-unit.mjs`（纯函数，挂在 `npm run test:reminders`）：
   - 30 秒合并：同会话 3 条审批 → 1 条吐司、3 条提醒；
   - cap / 天数：丢最旧、`waiting` 一条不丢；
   - 启动 `markStaleAll()`；
   - 静音后 `waiting` 数不含它，但清单里仍在；
   - `settle` 的 outcome 映射（approve→approved、reject→rejected、cancel/过期→stale? 见下）。
2. `probes/reminders.mjs`（Playwright，`newContext({ locale: "zh-CN" })`，照 `probes/ask-e2e.mjs` 的路子起两个会话）：
   - 会话 A 触发一条要审批的命令 → 切到会话 B → **A 的吐司出现在 B 的页面上**、角标 = 1；
   - 点吐司/清单一条 → 切到 A 且那张卡进了视口（`scrollIntoView` 之后 `getBoundingClientRect().top` 在视口内）;
   - 同一会话连要 3 次审批 → 吐司只有 1 条、角标 = 3；
   - 静音该会话 → 不再弹、角标 0、清单里仍在（灰）；
   - 关总开关 → 不弹、角标照常；
   - `POST /api/notify` 塞一条 → 角标 +1、**不弹**、点一下就消；
   - 左栏收起（`◧`）状态下同样能看见角标。
3. `npm run typecheck`（含 i18n、viewport、spawn-hidden、notices）、`npm run build:bridge`、`npm run build:web`。

## 分步（一个 PR 一条，按这个顺序）

1. **桥端 store + 单测**（不碰 UI，先让不变量有守卫）。
2. **帧 + HTTP + `/api/me`**（页面还看不见，用 `curl` 验）。
3. **顶栏角标 + 清单**（能看见、能跳，还没有吐司）。
4. **吐司 + 合并 + 静音**。
5. **设置页那一组 + i18n 三份 + 探针**。

每步跑一遍 `npm run typecheck`；改过 `web/src` 就顺手看 `THIRD-PARTY-NOTICES.md` 有没有新增浏览器依赖（没有就不用动）。

## 仓库规矩

`AGENTS.md`：不在 main 上改。这份计划所在的分支就不合并 —— 改代码要先说一声，开自己的 worktree、提 PR、**不自己合 main**。

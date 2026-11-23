# 翻译对照 · 并发落地计划（D390）

> 决定与理由在 `docs/DECISIONS.md` 的 `D390`；这里只写「怎么做的、还剩什么」。
> 词表：**节**是落盘与对齐的单位，**块**是一次模型调用的单位（见 `GLOSSARY.md`）。

## 一句话

`translateDoc` 从「一节一节串行、每块各起一个 `pi --mode text`」改成「(节, 块) 摊平成任务队列、最多 4 块在飞、按原文顺序往前落盘」，用户能调 1–8 路，撞限流自动降并发并退避重发。

## 改到的代码

| 文件 | 改了什么 |
| --- | --- |
| `bridge/src/translate.ts` | 新增 `CancelSignal` / `Aborted` / `isRateLimit` / `Pool`；`translateDoc` 改成块级并发 + 前缀 flush；`translateChunk` 把「限流重发」与「翻坏了重试」分开；`translateSection` 保留成串行薄壳；`TrRun.backoffMs`（测试传 0）；`TrPrefs.concurrency` + `clampConcurrency` |
| `bridge/src/translatejob.ts` | `JobView.inflight`；`signal` 带 `onAbort`；`cancel()` 当场执行所有登记的 kill；`start()` 接受 `limit` |
| `bridge/src/index.ts` | `/api/translate/prefs` 收 `concurrency`；`/api/translate/start` 用 `readTrPrefs().concurrency` |
| `web/src/types.ts` / `api.ts` | `TrJob.inflight`、`TrPrefs.concurrency`、`api.trPrefs(model?, concurrency?)` |
| `web/src/translateview.ts` | `trNote()`：副行拼「节标题 · 正在翻 N 块」 |
| `web/src/app.ts` | `trConcurrency` 状态；三处读 prefs（doc/prefs/设置页）；`paintTrLive` 用 `trNote`；设置 →「预览与翻译」新增「同时翻几块」1–8 |
| `web/src/i18n/{en,ja}.ts` | 四条新文案 |
| `GLOSSARY.md` | **翻译对照** / **节** / **块** 三条 |

## 不变的东西（刻意的）

- **译文缓存一个字没动**：`TrDoc` / `TrSection` 的形状、`cacheFile()` 的键、`readDoc()` 的过滤规则都照旧 —— 已有的译文继续可用，不会被作废重翻。
- **分节 / 分块 / 表格校验 / 照抄检测 / 代码段不翻**：`cutSections`、`packChunks`、`tableDiff`、`looksUntranslated` 全部原样。
- **`keep` 复用规则**：原文没变、且不是「失败节」的节照旧沿用；`keep` 命中的节不占并发名额。
- **反向写回（`planSync` / `applySync`）**：这次完全没碰。

## 不变量（写测试时按这三条断）

1. **顺序**：并发跑完拼出来的每一节 `out`，必须与串行逐字节相同（桩下可断言）。
2. **前缀**：`onSection` 每次只多一节、不回头；`onProgress.done` 是「落盘到哪一节」，不是「翻完几节」。
3. **上限**：同时在飞的调用数 ≤ `limit`；429 之后 ≤ 上限的一半；`limit` 先夹到 1–8。

## 验收清单

- [x] `node --experimental-strip-types bridge/tests/translate-unit.mjs` → **81/81**（14 条新增：顺序 / 上限 / 前缀 / inflight / keep / 429 / 取消 / 夹紧）
- [x] `npm run test:translate:e2e` → 全部通过（桩 pi 跑通 start→save→sync→apply）
- [x] `npm run typecheck`（bridge / peer / web + i18n-check + viewport + layers + spawn-hidden）
- [x] `node probes/translate-speed.mjs` → 桩 20 块 ×4.00；`--real`：`wb2_mac/cn:glm-5.3-flash` 12 块 ×2.66、0 限流、0 失败
- [ ] 在真页面上点一次「译」，看 `翻译中 {done}/{total}` 右边那行「正在翻 N 块」，并中途点「取消」确认几块当场停（这台 Mac 没有可用的 UI 探针：`probes/translate-ui.mjs` 是 Windows-only）
- [ ] 在 Windows 上跑一次 `npm run probe:translate`（同一份桩语境下的 UI 回归）
- [ ] 拿一份**旧的**译文缓存（改动前生成的）打开一次，确认照读、不重翻

## 剩下的活（下一票）

1. **术语表与跨块上下文接力**：同一个词在两个块里可能两种译法；要修就得把术语 / 上一块的尾巴带进下一块的 `--system-prompt`，并可能要在缓存里记「这一篇用的术语」。缓存要加字段 —— 与本次「缓存照读」互斥，得单独立一条决定。
2. **流式输出**：`--mode text` 一次性吐完（实测首字节在结束时才到），要边翻边填字只能换常驻的 `--mode rpc` 子进程。
3. **覆盖面**：表格 / 幻灯片 / PDF / 聊天正文 / 内网通对话的翻译入口；目标语言从 4 种放开到任意。
4. **对照与写回的手感**：逐段 diff、撤销写回、多标签页 `out` 的版本号（现在后写覆盖前写）。
5. **按模型分档的并发**：目录里的快模型给 6 路、其余 2 路；以及限流窗口过去之后把砍半的并发升回去。

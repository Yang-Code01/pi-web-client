# Copilot 积分（credits）

pi 用 `github-copilot` 模型时，GitHub 扣的不是「按价格表折算的美元」，而是**积分（AI credits）**：1 积分 = $0.01，月度额度用完就从额度里扣、不够再按超额计费。这个功能把「这一轮到底花了多少积分、本月还剩多少」显示在界面上，其它 provider 仍然显示美元（D307）。

**全部在 pi-web-client 内部完成，不装任何 pi 扩展、不额外起进程。**

## 一句话架构

```text
会话 JSONL（pi 自己写的，每次请求的 usage.cost 就在里面）
        │
        ├─ bridge/src/copilot-credits.ts
        │     CopilotTally 按字节 offset 增量读 → provider=github-copilot 的 cost × 100 = 积分
        │     账号额度：bridge 自己 GET /copilot_internal/user（30 秒节流、8 秒超时）
        │
        ↓  ws 帧 { type: "copilot", sessionId, …CopilotView }
        ↓  同一份也挂在 `session` 帧的 `copilot` 字段上（订阅 / 重连 / 切会话时立刻有，D322）
web/src/app.ts  → 执行面板主格子 + 「Copilot 积分」专项块 / 模型弹层累计费用 / 状态栏芯片
```

为什么不需要扩展：积分的**唯一未知量**是「这次请求值多少积分」，而 GitHub 的定价是固定比率 —— `1 积分 = $0.01`，pi 已经把每次请求的价算进会话条目的 `usage.cost.total`（含 cache read / write），所以 `credits = usd × 100`。实测两边**逐位相等**（见下）。扩展能拿到 provider 响应里的 `copilot_usage.total_nano_aiu`，但那是同一个数，不值得为它多一个必须安装的组件（D307）。

## 数据来源与换算

| 来源 | 字段 | 用途 |
| --- | --- | --- |
| 会话条目的 `message.usage.cost.total`（美元） | × 100 = 积分 | 每轮 / 会话累计；UI 标「估算」 |
| `GET https://api.github.com/copilot_internal/user` | `quota_snapshots.premium_interactions` | 本月已用 / 剩余 / 额度 / 重置时间（精确） |
| 会话条目 `customType: "copilot-credits"` | `credits` / `nanoAiu` | 真值（将来 pi 自己吐、或手工写入时优先，UI 标「真值」） |

实测等价性（`claude-haiku-4.5`，2026-11-18）：pi 写的 `cost.total = 0.0080125`（input + output + cacheWrite），`× 100 = 0.80125`；同一次请求 GitHub 响应里的 `total_nano_aiu = 801250000`，`/ 1e9 = 0.80125`。**完全一致**，cache write 也计在内。所以 `cost × 100` 不是粗估，只在 pi 内置价格表落后于 GitHub 改价时才会系统性偏 —— 而那种偏正好被对账（见下）抓出来。

`copilot_internal/user` 的 `quota_snapshots` 结构（Business 席位实测）：

```json
{ "premium_interactions": { "entitlement": 500000, "remaining": 469980.4, "credits_used": 30020,
                            "percent_remaining": 93.9, "unlimited": false, "overage_permitted": true },
  "quota_reset_date": "2026-12-01", "quota_reset_date_utc": "2026-12-01T00:00:00.000Z" }
```

`chat` / `completions` 两个快照是 `unlimited: true`，不显示进度条。字段缺失一律当 `null`，不猜 0（`entitlement` 缺失时「本月已用」只写数字，不写 `x / y`）。

凭据用 pi 存在 `~/.pi/agent/auth.json` 里的 `github-copilot.refresh`（`COPILOT_GITHUB_TOKEN` 优先）。没登录 copilot / 断网 / 响应形状变了 → 那两格显示「—」，不影响别的。

## 真值条目（可选，不存在也正常）

```json
{ "type": "custom", "customType": "copilot-credits",
  "data": { "model": "claude-haiku-4.5", "nanoAiu": 1300000, "credits": 0.0013,
            "tokens": { "input": 8, "output": 1, "cacheRead": 0, "cacheWrite": 0 },
            "at": "2026-11-18T00:00:00.000Z" } }
```

一个会话里只要出现过一条 `copilot-credits`，累计就**整段用真值**（不再叠加 `cost × 100`），徽标从「估算」变「真值」。老版本遗留的 `copilot-account` 条目仍然认，但额度现在由 bridge 直接拉，不再需要它。

## 计数规则（别自己发明）

- **`:credits` 是本会话累计**：扫描到的所有 copilot 请求的积分相加。
- **「本轮」与执行面板同口径**：和现有「本轮费用」一样是快照差值（`beginExecRound` 时记基线，`roundMetrics()` 里 `delta`），所以子代理那一轮也算在内 —— 决策 29 要的就是这个，不要另外按 user prompt 重新切分。
- **`otherCost`**：本会话里 provider **不是** `github-copilot` 的 assistant 消息 `usage.cost.total` 之和。它有值且会话里出现过 copilot，就是**混合会话**（决策 26）：主格子保留「本轮费用」一格写 `积分 + $X`，专项块的「本轮 / 会话累计」只写 copilot 那部分。
- **账户额度刷新**：每条 assistant 消息落盘（`message_end`）、轮末（`agent_end` / `agent_settled`）与订阅/接管/重载（`subscribe` / `claim` / `reload`）时增量扫 JSONL 并触发额度刷新，最小间隔 30 秒（决策 23、D339）。间隔内沿用旧快照，专项块脚注里写「额度更新于 2m」，不假装是新的。
- **随 `session` 帧一起下发**：bridge 的 `snapshot()` 带最近一份积分视图，订阅（页面重连 / 切会话 / stepup 重同步都会重发 `session` 帧）那一刻前端就有数据，不必等下一轮结束（D322）。前端 `case "session"` 读 `msg.copilot`，**不要**在会话帧里把它清成 null。
- **对账**：拿到新额度快照时，比较「上一份快照以来账号的增量」与「本机记账增量」，`accountDelta ≥ 10` 才比；偏差 > 2% 在专项块底部出一行小字。样本太小或者月度重置（`used` 变小）就不比，清掉提示。

## 精度与文案

`web/src/copilot.ts` 的 `formatCredits`：`< 1` 三位、`< 100` 两位、`≥ 100` 取整并加千分位。美元用 `creditsToUsd`（`< $0.01` 四位、`< $1` 三位）。界面文案全走 `tr()`，`en.ts` / `ja.ts` 各有一份对照。

## 排查

**看不到专项块**：只有会话历史里出现过 `provider === "github-copilot"`（或本会话有 `copilot-credits` 条目）才显示（决策 24）。

**专项块「一开始有、几轮之后没了」**：这是 D322 修掉的毛病 —— `subscribe` 只发 `session` 帧，而积分只在 boot / 轮末推，中间那条路上没人补。现在会话帧自带一份；`probes/copilot-on-subscribe.mjs` 直接量这条（订阅后 3 秒内拿不拿得到），`probes/copilot-panel-resubscribe.mjs` 量前端那一半（切会话 / 重连之后块还在不在）。

**积分是 0 或没变**：老会话在 pi 记价格之前跑的（`usage.cost` 为 0 / 缺失）就没有积分；`copilot_internal/user` 的 `remaining` 在几分钟内也可能不动（服务端缓存），本机记账与账号额度允许不同步。

**怎么确认没算错**：`cost × 100` 与 GitHub 响应的 `total_nano_aiu / 1e9` 应逐位相等 —— 想复验时用 `pi -p 'hi' --model github-copilot/claude-haiku-4.5 --no-tools`，再把会话 JSONL 里那条 assistant 的 `usage.cost.total × 100` 与额度页的扣减对比。对账那行小字就是这件事的自动版。

## 验证

```bash
node --experimental-strip-types bridge/tests/copilot-credits-unit.mjs   # 增量读 / 换算口径 / 分账 / 对账 / 额度解析
node --experimental-strip-types web/tests/copilot-unit.mjs              # 精度三档 / 重置时间 / 混合判定
node --experimental-strip-types web/tests/exec-view-unit.mjs            # 执行面板模型带 credits/otherCost
node probes/copilot-on-subscribe.mjs                                    # 订阅之后拿得到积分（真桥，只读；未修复的 bridge 上应当 2/2 红）
node probes/copilot-panel-resubscribe.mjs                               # 切会话 / 重连之后专项块还在（桩桥 + 真前端，八条）
npm --prefix web run typecheck                                          # i18n 三语 + 视口守卫
```

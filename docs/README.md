# 文档

代码之外的东西都在这里：为什么这么设计、pi 的 RPC 到底长什么样、哪些结论是实测出来的。

| 文件 | 内容 |
| --- | --- |
| [`pi-integration-facts.md`](pi-integration-facts.md) | **先读这篇。** `@earendil-works/pi-coding-agent@1.4.0` 对外集成面的事实报告：RPC 是什么、会话文件格式、审批钩子、没有锁、没有 replay……每条都标了证据路径。 |
| [`PLAN.md`](PLAN.md) | 实施计划：进程与边界、里程碑、每个里程碑的验收标准。 |
| [`PLAN-ask.md`](PLAN-ask.md) | 「提问通道」（`question` / `questionnaire` 在网页上弹抽屉）的专项计划。 |
| [`DECISIONS.md`](DECISIONS.md) | 决策记录，约 50 KB。每条都是「决定了什么 + 为什么 + 怎么验证的」。踩过的坑基本都在这里，改代码前值得搜一下关键词。 |
| [`probes/rpc-probe-findings.md`](probes/rpc-probe-findings.md) | RPC 实测结论：哪些命令能跑通、三个必须绕开的坑（`--resume` 污染 stdout、`extension_ui_request` 无超时会永久挂起、`ctx.ui.custom()` 在 RPC 下是 `undefined`）。 |
| [`probes/cloudflared-probe.md`](probes/cloudflared-probe.md) | quick tunnel 实测：启动时间、URL 变化、header 与限流行为。 |
| [`probes/wechat-tail-probe.md`](probes/wechat-tail-probe.md) | 微信通知通道的接口实测与失败码语义（`-2` / `-14`）。 |
| [`shots/`](shots/) | README 里的截图。 |

## 关于文中的 `.scratch/…` 路径

这些文档写作时的样张、截图和探针原始输出都放在本机工作目录 `.scratch/` 里（已在 `.gitignore` 中，不随仓库发布）。文中提到的 `.scratch/ops-failure/shots/…` 之类路径只作溯源线索，指不到仓库里的文件；能复现的脚本都在仓库的 `probes/` 和 `bridge/tests/` 下，用 `node <文件名>` 直接跑。

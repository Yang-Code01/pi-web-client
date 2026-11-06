---
name: bridge-update
description: 把正在跑的 pi-web-client bridge 更新到 main 最新并重启（pull → build → 杀旧进程 → 开新窗口），一步到位；附 build 版本提示与健康检查看门狗。当用户说「更新 bridge」「重启 bridge」「把 7864 换成最新 main」「服务生效一下」「刚合了 PR，重启一下」时使用。
---

# bridge-update

把 7864 上的 bridge 换成 main 最新代码。旧进程只有在 build **成功之后**才会被停，所以编译失败时线上一直是旧的、不中断；build 成功才换进程，期间短暂不可用，前端会自己重连。

## 一、先判断要不要动

```bash
node .pi/skills/bridge-update/bin/restart.mjs --check --dir <仓库根>
```

前台跑，安全：只 `git fetch` + 比 SHA，不 build、不杀进程。输出一行 JSON：

- `{"behind": false, ...}` → 已经是最新（含 dist 与 HEAD 一致），回用户一句「已是最新（`<fromSha>`）」就结束，别再往下走。
- `{"behind": true, ...}` → 继续第 2 步。

`--check` 会把 `git fetch` 的代理退路也走一遍（直连不通时自动带 `BILLION_CONTEXT_PROXY`）。

## 二、把没做完的事落盘（如果这轮任务还没完）

重启会切断当前 turn 的 pi 子进程。动手前把「接着要做什么」写进：

```
<仓库根>/.scratch/bridge-update/pending.md
```

内容三行以内就够：用户的原话意图、已完成的部分、下一步的第一个动作。只服务下一次会话，不要写成长篇复盘。这轮本来就没有未完成的任务，就不要留旧文件——先删掉过期的 `pending.md`。

## 三、交给独立进程（必须 detached）

**不要在会话里前台跑完整流程**：杀 bridge 时会把 pi 子进程一起带走，前台跑等于自己把自己掐死。

```powershell
Start-Process node -WindowStyle Hidden -ArgumentList `
  '<仓库根>\.pi\skills\bridge-update\bin\restart.mjs','--dir','<仓库根>'
```

- `Start-Process`（不是 `&`）才有独立进程组；`-WindowStyle Hidden` 避免闪一个黑框。
- 路径都写绝对路径，带反斜杠；有空格或中文就照原样放进单引号。
- 想只看编译、不换进程：加 `--dry-run`。只想停：`--no-start`。
- **异构实例**（测试环境、别的端口）：`--dir <另一份检出> --port <端口>`，同一个脚本能更新任意一份。

启动后立刻结束本轮输出：告诉用户「正在更新，7864 会重启，好了刷新页面」。不要等它、不要轮询——等不到，进程也会被一起杀。

## 四、用户回来问「好了没」时

读 `<仓库根>/.scratch/bridge-update/last-run.json`：

| `result` | 含义 | 怎么说 |
| --- | --- | --- |
| `ok` | 新 build 已在服务，`fromSha`→`toSha`，`newPid` 是新进程 | 报新 build id 和 pid，让他刷新 |
| `up-to-date` | fetch 完发现没变化 | 本来就不用重启 |
| `merge-failed` | 主检出有未提交改动或历史分叉 | **没有 stash、没有杀进程**；把 `error` 给用户，问怎么处理 |
| `build-failed` | 编译挂了 | 旧进程还在服务旧代码；把 `update.log` 尾部贴给用户 |
| `kill-failed` | 旧进程杀不掉 | 服务仍在旧代码上；让用户手工关窗口 |
| `start-failed` | 新进程 45s 内没起来 | 看 `.scratch/bridge-update/bridge-live.log` |

`pendingUnread: true` 且存在 `pending.md` → 先把里面的事做完，再把 `last-run.json` 里的 `pendingUnread` 改成 `false`。这是 AGENTS.md 启动检查约定的一半，别忘。

## 五、看门狗（一次性安装）

更新器本身不常驻。想让它崩了自动回来，装一个用户级计划任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .pi\skills\bridge-update\bin\install-watchdog.ps1
```

每 1 分钟探测 `/healthz`；不通且没在更新（`restart.lock` 新鲜）就 detached 拉起 `node bridge/dist/index.js`。5 分钟内只拉一次，避免崩循环刷进程。

- 不想让它自己重启（演示、调试）：`node .pi/skills/bridge-update/bin/watchdog.mjs --stop`；恢复 `--start`。
- 卸载任务：同一脚本加 `-Uninstall`。
- 日志：`.scratch/bridge-update/watchdog.log`。

## 六、边界

- 合并只做 `git merge --ff-only origin/main`，**绝不** `stash`、`rebase`、`reset`，也绝不替用户提交他工作区的改动。dirty 或分叉就停（`merge-failed`）。
- 绝不 `taskkill /T`：进程树里可能连着别的会话；只按 pid 杀 bridge 本体，再单独清它自己的 `pi` 子进程。
- 不要自动 reload 页面。build 变了前端只在顶部显示「服务已更新，刷新后生效」，让用户自己点——他可能正在输入框里打字。

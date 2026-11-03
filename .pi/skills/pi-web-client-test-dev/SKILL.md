---
name: pi-web-client-test-dev
description: 给 pi-web-client 起一套隔离的测试环境（bridge + 内网通 peer），口令固定 test，端口自动探测、支持多开。用于验收改动、复现 bug、给用户现场演示，而不碰正式跑在 7864 上的那份。当用户说「起个测试环境」「验一下这个分支」「多开一份对比」「别动我正在用的 web」时使用。
---

# pi-web-client 测试环境

一条命令起一份能和正式实例并存的 web；每份实例独占一套端口，多开互不干扰。

本技能随仓库分发，就在 `.pi/skills/pi-web-client-test-dev/`。pi 在**本仓库或其子目录**里跑时自动发现它（项目级技能，不需要 `pi install`）；换到别的目录跑 pi 就看不见了。

## 先确认，再启动

**不要**在没确认代码来源时启动——否则测的是别人的分支。用 `question` 工具一次问清：

1. **测哪份代码**：当前工作区（列出 `git -C <dir> rev-parse --abbrev-ref HEAD` 与是否有未提交改动）、其它 worktree（`git worktree list`）、指定分支（允许手输分支名）。
2. **几份**（默认 1）。

指定分支没被任何 worktree 检出时，按仓库既有习惯建一个：

```bash
git worktree add <仓库父目录>/<仓库名>-wt/<slug> <branch>   # slug = 分支名去掉 feat/，/ 换成 -
```

测完要么 `git worktree remove <path>`，要么明确告诉用户目录留在哪。

## 启动

脚本在本技能目录的 `bin/env.mjs`，**直接 node 跑，不要包启动器**：

```bash
node <skill>/bin/env.mjs start --dir <仓库或 worktree 绝对路径> [--name t1] [--peers 1] [--build]
node <skill>/bin/env.mjs list
node <skill>/bin/env.mjs stop --id t1 | --all
node <skill>/bin/env.mjs ports [--peers 2]
```

- **口令恒为 `test`**：脚本用 `node bridge/dist/index.js --passphrase test` 先写进该实例自己的 state，再正常启动。没有改口令的参数，也不要去改。
- **端口先探再用**：从 17864 起，每个实例要 bridge / peer / announce(UDP) 三个端口（`--peers N` 再各加两个）。探测分两步——先对 127.0.0.1 真连一次，再以 `exclusive` 独占绑定（Windows 上只靠 `listen` 会因为 SO_REUSEADDR「绑得上但抢别人端口」），UDP 单独探。7864 / 7865 / 7866 永远保留给正式实例。
- 端口与实例登记在 `~/.pi/agent/state/pi-web-test-dev/instances.json`，不同 worktree 的实例都在同一张表里，所以多开不需要人工指定端口。
- 缺 `dist` 会自动装依赖并 `npm run build`；已有构建默认复用（输出里写明「复用已有构建 @HEAD」），要重建加 `--build`；工作区脏会提示。
- 启动末尾会**真的 POST `/api/login` 试口令**，打印 `登录自检 HTTP 200（口令 test 生效）`——不是只看 pid。

## 启动后自检

```bash
curl -s -m 3 http://127.0.0.1:<bridge>/healthz
curl -s -m 3 -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' \
     -d '{"passphrase":"test"}' http://127.0.0.1:<bridge>/api/login      # 期望 200
curl -s -m 3 http://127.0.0.1:<peer>/status                             # 期望 ok:true + 昵称
```

失败先看 `~/.pi/agent/state/pi-web-test-dev/<id>/bridge.err.log`（peer 的日志在同目录 `peer-*.out.log`）。

## 交给用户看

按 AGENTS.md：产物能开就直接开。用 `question` 问「要现在打开吗」，选打开就按平台来：

```bash
# Windows（本机实测过）
powershell -NoProfile -Command "Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList '--new-window','http://127.0.0.1:<bridge>/'"

# macOS（未实测）
open -n -a "Microsoft Edge" "http://127.0.0.1:<bridge>/"

# Linux（未实测）
xdg-open "http://127.0.0.1:<bridge>/"
```

`--new-window` / `-n` 是必需的：浏览器常驻时丢 URL 只会在后台开标签、不抢焦点，用户那边看到的还是「没打开」。页面首次打开要输口令 `test`。

判据：

- **Windows** —— 窗口标题变了才算开成。开前后各跑一次，多出一条新标题（新窗口的名字就是页面 `<title>`）：
  ```bash
  powershell -NoProfile -Command "Get-Process msedge -EA SilentlyContinue | ? {$_.MainWindowTitle} | select -Expand MainWindowTitle"
  ```
  退出码什么都证明不了；中文标题经 bash stdout 可能显示成乱码，比的是「变了没有」，不是内容对不对。
- **macOS / Linux** —— 没有等价的可靠判据（未实测）。用 `curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<bridge>/` 确认页面在服务，再让用户自己确认窗口开没开。

## 多开

- 同一份代码起两份（两个身份 / 并发）：`--name t1`、`--name t3`，端口自动错开。
- 两份不同代码（不同 worktree 或分支）：各自 `start --dir <目录>`，`list` 里同时可见。
- 同一个 `--name` 不能重复，重名会直接拒绝并提示先 stop。

## 收尾

`stop --all` 之后告诉用户两件事：① 端口已经放掉；② state 目录 `~/.pi/agent/state/pi-web-test-dev/<id>/` 还在（登录状态、peer 的 nodeId、内网通的历史与收件箱），要干净就删。

## 坑

- **不要碰 7864**：那是用户正在用的正式实例。脚本把 7864/7865/7866 硬编码保留。
- **不要用启动器（`Start-Process` 之类）起这些进程**：子进程会继承 bash 管道，工具调用会挂到超时；直接 `node <skill>/bin/env.mjs`。（Windows 上额外注意：`$_` 会被 MSYS 展开成 `/usr/bin/bash`；含中文的 `.ps1` 必须存 UTF-8 **with BOM**。）
- 判断成败看 HTTP 状态码，不看退出码（Windows `Start-Process` 永远返回 0）。
- 本机历史遗留：`.scratch/peer-test/` 那套老实例不在本技能的 registry 里，`list` 看不到；先停掉它，再用本技能重起一份。
- 早于 #45 的分支没有 `peer/`：脚本会跳过 peer 并提示「只能测主页面」，此时只有 bridge 端口。
- 杀进程之后端口要几百毫秒才放掉（Windows 走 `taskkill /T /F`，POSIX 给进程组发 `SIGTERM`，见 `bin/env.mjs` 的 `killTree()`）；脚本等 600ms 再报结果，别手动去抢刚释放的端口。
- 脚本本身跨平台（`process.platform` 分支）；但 17864 起的独占端口探测只在 Windows 验过，mac/Linux 上先跑 `ports` 看一眼结果再起。
- 一定要用 `--name` 起第二个时，名字写进昵称（`测试机 t3`），多实例的在线列表里能一眼分清。

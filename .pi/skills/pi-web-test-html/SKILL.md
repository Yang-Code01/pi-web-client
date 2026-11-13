---
name: pi-web-test-html
description: 把某个模块的验收流程跑成一份「测试书」：起隔离测试环境 → 逐步截图 → xlsx（一 case 一 sheet）→ 1:1 复刻该 Excel 的单文件 HTML → 关环境。当用户说「跑个测试书」「验收一下这个模块」「出一份 xx 的测试 excel / 测试报告」「把测试流程做成 excel 再转 html」时使用；也可用 /pi-web-test-html 命令直接呼出。
disable-model-invocation: true
---

# pi-web-test-html — 把一次验收跑成「测试书」

一条命令把某个模块的验收流程变成三样东西：**截图证据 → xlsx 测试书（一 case 一 sheet）→ 1:1 复刻该 xlsx 的单文件 HTML**，最后关掉测试环境。

由 `/pi-web-test-html [模块] [额外要求]` 呼出。本技能随仓库分发，在 `.pi/skills/pi-web-test-html/`，项目里跑 pi 时自动可见。

## 硬规则

- **不改产品代码。** 跑出 bug 就记录在测试书里（判定「失败」+ 现象），不要顺手修；要修另开 worktree、另开 PR。
- **产物不进 worktree 的 `.scratch`。** `git worktree remove` 删未跟踪文件不打招呼——本仓库真把整本书这么删过一次。`bin/run-book.mjs` 默认把产物写到**主检出**的 `.scratch/testbook/<用例集>/`，即使在 worktree 里运行。
- **不碰正式实例。** 只对 17876 起的隔离环境跑（`bin/env.sh` 调的是 `pi-web-client-test-dev` 技能），7864 上那份别动。
- **跑完关环境**：`bin/env.sh down`，并确认记录器/计划任务这类系统副作用已卸干净（用例里该有用例负责卸）。

## 流程

### 1. 定对象

用户可能只说了模块名。缺信息就用 `question` 一次问清（别在正文里列问题）：

- 测哪个模块 / 用例集（`ls cases/` 里已有的，或「新写一集」）；
- 测哪份代码（当前工作区 / 某个 worktree / 指定分支）；
- 有没有要额外覆盖的场景（写进用例集的补充要求）。

已有用例集时跳过第 2 步。没有就按 `references/writing-cases.md` 写 `cases/<name>.mjs`。

### 2. 起干净环境

```bash
bash .pi/skills/pi-web-test-html/bin/env.sh fresh <仓库或 worktree 绝对路径> wk <用例集>
```

`fresh` = 关旧实例 → 跑 `setup/<用例集>.sh`（模块自己的系统级清场：卸计划任务、杀记录器）→ 删该实例状态目录 → 重起。要保留上一轮数据就换 `up`。

输出里会打印 `http://127.0.0.1:<port>/` 与「登录自检 HTTP 200」。记下端口，后面 `--base` 用它（默认 17876）。

### 3. 跑用例

```bash
node .pi/skills/pi-web-test-html/bin/run-book.mjs --case <用例集> [--base http://127.0.0.1:17876]
```

产物：`<主检出>/.scratch/testbook/<用例集>/spec.json` + `shots/*.png`。摘要会打印每条用例的判定；有「失败」时退出码 1 —— **先看失败再往下做**，失败可能是产品 bug、也可能是用例写错了（本轮就出现过三处：选择器读到兄弟节点、时间种子落在未来、元素截图撞上重渲染）。

### 4. 生成 xlsx

```bash
python .pi/skills/pi-web-test-html/bin/build-xlsx.py --dir .scratch/testbook/<用例集>
```

一 case 一 sheet（总览 / 环境与准备在最前），列宽行高按文字量估，图片按原始像素贴。写出的 `layout.json` 供下一步复刻；末尾用 LibreOffice（若装了）重算公式缓存值，让总览的 COUNTIF 在没打开过 Excel 的机器上也显示数字。产物名取自 `cases/*.mjs` 的 `meta.output`。

### 5. 生成 1:1 HTML

```bash
node .pi/skills/pi-web-test-html/bin/build-html.mjs --dir .scratch/testbook/<用例集>
```

照 `layout.json` 渲染 Excel 观感（绿标题栏、名称框 + fx 栏、A–G 列标与行号、格线、底部工作表页签），截图与 xlsx 全部内联成 data URI —— 一个 `.html` 单独拷走就能看。

### 6. 交付、收尾

- 用 `question` 问「要不要在预览里打开」（推荐「打开」），选打开才 `open_preview(<HTML 绝对路径>)`；同一份文件只问一次。
- xlsx 能让用户自己从 HTML 里下载（HTML 里有 `下载 xlsx` 按钮），不必单独再问一次。
- `bash .pi/skills/pi-web-test-html/bin/env.sh down wk`；确认没有残留：记录器计划任务（`Get-ScheduledTask -TaskName 'pi-web-client-workclock'`）、记录器进程、测试实例端口。
- 在回复里给出三个路径：HTML、xlsx、`spec.json`（含原始截图目录）。

## 目录

```
bin/run-book.mjs      驱动：浏览器、登录、按步截图、写 spec.json（--case/--base/--out/--root）
bin/build-xlsx.py     spec.json → xlsx + layout.json（openpyxl，可选 LibreOffice 重算）
bin/build-html.mjs    layout.json → 单文件 HTML（图片与 xlsx 内联）
bin/env.sh            up / fresh / down，包一层 pi-web-client-test-dev
cases/<name>.mjs      用例集（只写用例，不写驱动）
setup/<name>.sh       该模块的系统级清场（可选）
references/writing-cases.md  用例集怎么写、判定口径、截图对象
references/pitfalls.md       已经踩过的坑（时区、未来事件、i18n 选择器、截图重试…）
```

## 写新用例集

读 `references/writing-cases.md`：导出一个 `async function (h)`，用 `h.openCase / h.step / h.ok / h.fail / h.shot` 四件套；`meta` 里写标题、模块、分支、PR、D 编号与 `output`（产物名）。判定只有三种：通过、失败、人工（要有一步写明为什么人工、怎么补）。

有系统副作用（装计划任务、写用户目录、占用设备）的用例，在 `setup/<name>.sh` 里写清怎么回到干净状态，并在用例末尾自己卸掉。

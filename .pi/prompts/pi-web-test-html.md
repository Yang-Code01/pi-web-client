---
description: 跑一本「测试书」：起隔离环境 → 逐步截图 → xlsx（一 case 一 sheet）→ 1:1 复刻 Excel 的单文件 HTML → 关环境
argument-hint: "[用例集，例如 workclock；再往后写额外要求]"
---
把测试流程跑成一本测试书。流程写在 `.pi/skills/pi-web-test-html/SKILL.md`，**第一步就用 read 把它读完**，再按里面的顺序做：定对象 → `bin/env.sh fresh` 起环境 → `bin/run-book.mjs` 跑用例 → `build-xlsx.py` → `build-html.mjs` → 交付 → `bin/env.sh down`。

- 用例集默认 `workclock`（本机管理 / 上下班）；命令行第一个词是别的名字就换成它，`cases/` 里没有就按 `references/writing-cases.md` 写一集。
- 只产出测试书与截图，**不改产品代码**；跑出失败就如实记在书里。
- 开始跑之前，如果「测哪份代码」还不明确（当前工作区、某个 worktree、某个分支），用 `question` 问一次，别猜。
- 产物落在主检出的 `.scratch/testbook/<用例集>/`；跑完关环境，并确认记录器计划任务之类没残留。

补充要求（命令行后面跟的字，没有就忽略这行）：$@

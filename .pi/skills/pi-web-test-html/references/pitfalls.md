# 已经踩过的坑

跑测试书这件事在本仓库踩过下面这些；新用例集开始前扫一遍，能省掉一轮假失败。

## 时间

- **别用 `toISOString()` 写测试书时间**：它给 UTC，测试书里会出现「执行时间 16:08」而本机是 00:08。用本地墙钟（`getHours()` 那一套）。
- **种子时刻要相对 `now`**：写死 `09:04 / 12:01 / 13:02 / 18:33`，凌晨跑时这些时刻在未来，产品按「未来事件不算」过滤掉，首解锁变成 `--:--:--`，于是「倒计时在走」类断言全假失败。白天（今天已过 ≥620 分钟）才用真实剧本，其余时间把一天压缩到已过的区间里，断言写成「过去则大字以 `+` 开头，否则匹配 `HH:MM:SS`」。
- **倒计时断言带容差**：`|target − now − remainingMs| ≤ 3000`。

## 选择器与 i18n

- 文案会随语言变：关闭按钮是「关闭 / Close / 閉じる」；「本机管理」在英文界面是 `Machine`。用 `/关闭|Close|閉じる/`、`/本机管理|Machine|マシン管理/` 这种正则，或按稳定的 `data-*` / 位置（`.sys-nav__item` 顺序固定）定位。
- 断言读错节点是常事：记录器的 `pid` 在 `.sys-wk-agent`，而「自启 / 见过锁屏」在兄弟节点 `.sys-wk-facts`；`pid` 文案是小写。动手前先 `allInnerTexts()` 打一遍看看。
- 列表顺序别猜：今日明细按时间升序（首行最早），「近 30 天」按日期倒序。

## 截图

- `Element is not attached to the DOM`：首次 `load()` 落地会整块重渲染，截图前等骨架屏过去；驱动已内置 4 次重试，仍失败说明这一步本身在闪烁，把等待写进用例。
- 长表格用元素滚动偏移，别 `scrollIntoView`（sticky 头会盖住首行）。
- 一张整页图看不清细节时，再截几个局部（表格、记录器卡片、按钮组）；xlsx 里会自动往下贴。

## Windows / PowerShell

- 在 MSYS bash 里拼内联 PS 管道（`Get-CimInstance … | ForEach-Object { $_.ProcessId }`）会被 bash 吃掉 `$_`，报 127/空输出。写成 `.ps1` 文件再执行，或用单引号把整段包住、内部用 `''` 转义。
- 计划任务：`Stop-ScheduledTask` + `Unregister-ScheduledTask -Confirm:$false`，两步都要 `-ErrorAction SilentlyContinue`，否则首次运行时任务不存在会中断脚本。
- 非管理员读不到 Security 4801（回填要 UAC）；`ConsentPromptBehaviorAdmin=5` 的机器上 UAC 会弹框，这类步骤只能标「人工」。

## 产物与目录

- **产物不要放 worktree 的 `.scratch`**：`git worktree remove` 直接删未跟踪文件，本仓库整本书丢过一次（HTML + xlsx + 18 张截图）。驱动的默认输出是**主检出**的 `.scratch/testbook/<用例集>/`。
- 截图文件名带 case 与 step 序号，`spec.json` 里存相对路径；xlsx/html 都按相对路径找图，换机器时整目录一起搬。
- `open_preview` 要绝对路径；相对路径会按主检出解析（在 worktree 里跑时尤其注意）。

## xlsx

- 不设 `fitToPage` / 横向 / `fitToWidth=1`，LibreOffice 导 PDF 会按 A4 竖版把 C 列之后切掉。
- A 列太窄（6）会让「用例编号」「前置条件」折行后被 21pt 行高切掉，用 9。
- openpyxl 写出的公式没有缓存值，Python 侧读到的是公式串；装了 LibreOffice 就让 `recalc()` 转一遍再替换。
- 图片按原始像素贴，贴图前把行高按 `h * 0.75` 铺出来（OneCellAnchor 不缩放）。

## HTML 复刻

- 三个 sticky 轨道要分 z 序：角块 6 > 列标 5 > 行号 4，否则滚动时列标被行号盖住。
- 单元格边框用 `box-shadow: inset -1px -1px 0`，别用 `border` —— 相邻格子叠加会变成双线。
- 截图与 xlsx 都内联成 data URI：单文件可拷走，也不会因为移动目录断图。
- 生成顺序：`run-book` → `build-xlsx` → `build-html`；shell 里别用 `&&` 串起来，`run-book` 有失败时退出码是 1，会把后面两步吞掉。

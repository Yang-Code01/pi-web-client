# 本机 WPS 的表格（ET）长什么样，我们跟到哪一步（D266）

这份文档是「拿本机的 WPS 当参照物」这件事的落点：先说明**怎么逆**（可复现），再给出逆出来的
**功能区 / 数字格式 / 函数清单**，最后是一张**对照表**——WPS 有、我们有、还是只读、以及为什么不做。

起因是一句话：「本项目有 Excel 的预览和编辑功能，但是不完善，用 rea 逆向一下本机的 wps」。
上一轮的表格预览已经照 WPS 排过一次（D256–D262），但排法靠的是记忆和截图；这一轮把**参照物
本身**读出来，于是「缺哪几样」不再靠感觉。

## 1. 怎么逆的

两条路，都不需要跑起来、也不需要联网：

```bash
# ① 先把这台机器上装的是什么搞清楚（REA：只读，启动 0 次 WPS）
rea inspect-desktop-application /Applications/wpsoffice.app --detail summary

# ② 表格的界面是声明式资源，直接读 XML / cfg（本仓库的脚本，输出 Markdown）
node tools/wps-inventory.mjs            # 六个页签 → 组 → 项（含嵌套下拉）
node tools/wps-inventory.mjs --funcs    # 函数名清单（406 个）
```

`rea` 那一趟的结论（明细见 `.scratch/wps/app-inventory.json`，不提交）：

- **WPS 6.11.0（build 8885）**，`com.kingsoft.wpsoffice.mac`，1.3 GB；
- 一共 10932 个条目、扫了 6316 个文件头：**没有 Electron / 没有 JS 包**，是原生的 Mach-O + Qt
  （框架名都带 `Kso` 后缀），所以「逆向」不是解 asar，而是读资源 + 认 bunde 里的模块分工；
- 表格（ET）落在这些 framework 里，界面、内核、计算、读写、画格子是分开的：

  | 框架 | 管什么 |
  | --- | --- |
  | `etmain.framework`（45 MB） | 表格主程序：窗口、功能区、对话框 |
  | `etcore.framework` | 文档模型内核 |
  | `etsolver.framework` | 公式计算 |
  | `etapi.framework` | 对外 API（VBA / JS 宏那套） |
  | `excelrw` / `excel2003htmlrw` / `etxmlrw` / `ethtmlrw2` | 各种格式的读写 |
  | `griddrawer.framework` | 网格绘制 |

- 界面资源是纯文本 XML，落在 `Contents/Resources/office6/res/`：

  | 路径 | 内容 |
  | --- | --- |
  | `commands/et/ongmani/CT_{Home,Insert,Layout,Formulas,Data,Review,View}.kuip` | 七个页签的 ribbon 定义（组、项、`hotKey`、`shortcutHint`、嵌套下拉） |
  | `etcommon.kuip` / `etentries.kuip` / `etongmani.kui` | 命令表与入口 |
  | `res/commands/et/PopupMenu.kuip` | 右键菜单 |
  | `mui/zh_CN/config/numberformat.cfg` | 特殊数字格式（中文大写、万元、正负号…） |
  | `mui/zh_CN/config/datetimeformat.cfg` | 日期时刻格式表 |
  | `mui/zh_CN/config/etfunctionhelp.cfg` | 函数清单（406 个名字） |

- **没能读出来的**：`mui/zh_CN/*.qm` 是 Qt 翻译文件（表头 16 字节不是标准 QM，解不出中英对照）。
  所以功能区的**英文键名**是我读出来的、**中文写法**是按 WPS 的习惯对回去的；`numberformat.cfg`
  里的中文（"中文大写数字" / "人民币大写" / "单位：万元"…）是文件里就写着的，逐字照抄。

## 2. 逆出来的：WPS 表格的功能区

下面是 `node tools/wps-inventory.mjs` 的原样输出（`?xxx` 表示那条命令定义在别的资源里、名字没解出来）。

（完整输出见该命令；这里只留结构，细节随 WPS 版本会变。）

| 页签 | 组（WPS 原样） |
| --- | --- |
| 开始 | 剪贴板 / 字体 / 对齐 / 数字格式 / 格式（条件格式 · 套用表格 · 单元格样式）/ 数据处理（自动求和 · 筛选 · 排序 · 填充）/ 单元格（行和列 · 工作表） |
| 插入 | 表格（数据透视表 · 数据透视图）/ 插图 / 图表 / 迷你图 / 符号 / 超链接 |
| 页面 | 打印设置（页边距 · 方向 · 纸张大小 · 打印区域 · 缩放 · 打印标题 · 页眉页脚 · 打印预览）/ 主题 / 分页设置 |
| 公式 | 快捷函数（求和 ▾ · 最近使用）/ 函数库（财务 · 逻辑 · 文本 · 日期与时间 · 查找与引用 · 数学与三角 · 其他函数）/ 定义名称 / 公式审核 / 计算 |
| 数据 | 筛选排序 / 排序 / 重复项（删除重复）/ 数据工具（填充 · 数据验证 · 下拉列表 · 合并计算 · 模拟分析）/ 分级显示（分类汇总）/ 拆分合并 / 获取外部数据 |
| 审阅 | 校对（拼写检查 F7）/ 语言（繁简转换）/ 批注（上一条 · 下一条 · 显示批注 · 显示所有批注 · 重置）/ 共享与保护 |
| 视图 | 工作簿视图（普通 · 分页预览 · 页面布局 · 自定义视图 · 全屏 · 阅读版式）/ 显示 / 缩放 / 窗口（冻结窗格 ▾ · 全部重排 · 拆分 · 新建窗口） |

几个特别值得抄的细节：

- **开始 → 单元格 → 行和列** 是一折长长的下拉：行高、自动调整行高、列宽、自动调整列宽、标准宽度、
  插入单元格（含 `Alt+↑` 上方插行 / `Alt+↓` 下方插行）、删除单元格、隐藏与取消隐藏。
- **开始 → 数据处理 → 填充** 里有「向下 / 向右 / 向上 / 向左 / 序列…」，序列里再分等差、等比、
  日期、自动填充。
- **视图 → 冻结窗格** 是一折下拉：取消冻结 / 冻结窗格 / 冻结首行 / 冻结首列。
- **公式 → 快捷函数** 的求和不只是一个按钮，右边带 ▾（求和 / 平均值 / 计数 / 最大值 / 最小值 / 其他函数）。

## 3. 逆出来的：数字格式与日期格式

`numberformat.cfg` 里的「特殊格式」（**文件里的原话**，我们照抄进功能区）：

| 显示名 | 格式代码 |
| --- | --- |
| 邮政编码 | `000000` |
| 中文小写数字 | `[DBNum1][$-804]G/通用格式` |
| 中文大写数字 | `[DBNum2][$-804]G/通用格式` |
| 中文大写数字 2 | `[DBNum20][$-804]G/通用格式` |
| 人民币大写 | `[DBNum2][$RMB]G/通用格式;[红色][DBNum2][$RMB]G/通用格式` |
| 单位：万元 | `0"."0,"万元"` |
| 万 / 百万 / 千万 / 亿 / 百万元 / 千万元 / 亿元 | `0"."0,"万"` / `0.00,,"百万"` / … / `0"."00,,"亿"` |
| 正负号 | `+0;-0;0;@` |

`datetimeformat.cfg`（区域 2052）的日期时刻表：`yyyy-M-d`、`yyyy年M月d日`、`yyyy年M月d日星期W`、
`yyyy/M/d`、`yy.M.d`、`yyyy年M月`、`h时m分s秒`、`h时m分`、`H:mm:ss`、`AMPMh时m分`。

这两张表直接落进了两处：`bridge/src/sheet/numfmt.ts`（显示）和 `web/src/sheet/ribbon.ts`
的数字格式菜单（`SPECIAL_FORMATS`），所以从预览里选「中文大写数字」，写进文件的代码就是
WPS 自己写的那一串。

## 4. 逆出来的：函数清单

`etfunctionhelp.cfg` 里 406 个函数名（`node tools/wps-inventory.mjs --funcs`）。我们这一轮把
求值器从 51 个补到 **215 个**（`calc.ts` 51 + `functions.ts` 164），补的是「报表里真会遇到」的那批：

- **文本**：TEXT / TEXTJOIN / VALUE / NUMBERVALUE / SEARCH / REPLACE / EXACT / PROPER / CHAR / CODE / CLEAN / FIXED / DOLLAR / T / CONCAT…
- **日期时间**：DATE / DATEVALUE / TIME / TIMEVALUE / HOUR / MINUTE / SECOND / WEEKDAY / WEEKNUM /
  DAYS360 / EDATE / EOMONTH / DATEDIF / YEARFRAC / WORKDAY / NETWORKDAYS
- **数学**：CEILING / FLOOR / MROUND / TRUNC / QUOTIENT / EVEN / ODD / GCD / LCM / FACT / COMBIN /
  PERMUT / SUMPRODUCT / SUMSQ / SUMX2MY2 / SUMX2PY2 / SUMXMY2 / LOG / LN / PI / 三角反三角 / ROMAN…
- **统计**：COUNTIFS / SUMIFS / AVERAGEIFS / MAXIFS / MINIFS / COUNTBLANK / MEDIAN / MODE / LARGE /
  SMALL / RANK / PERCENTILE / QUARTILE / STDEV(.S/.P) / VAR(.S/.P) / DEVSQ / GEOMEAN / HARMEAN /
  AVEDEV / SKEW / KURT / TRIMMEAN / STANDARDIZE / CORREL / SLOPE / INTERCEPT / RSQ / STEYX / FORECAST
- **查找**：HLOOKUP / LOOKUP / XLOOKUP / XMATCH / CHOOSE / ROW / COLUMN / ROWS / COLUMNS
- **逻辑**：IFS / SWITCH / XOR / TRUE / FALSE
- **信息**：N / NA / ISERR / ISNA / ISLOGICAL / ISNONTEXT / ISEVEN / ISODD / TYPE / ERROR.TYPE
- **财务**：PMT / PPMT / IPMT / FV / PV / NPER / RATE / NPV / IRR / MIRR / XNPV / XIRR / SLN / SYD / DB / DDB
- **工程**：BIN/OCT/HEX 互转，DELTA / GESTEP

**明确不做的**（不是漏，是决定）：数组公式与动态数组（FILTER / SORT / UNIQUE / SEQUENCE /
MAKEARRAY / LAMBDA / LET）、外部工作簿引用、迭代计算、宏表函数（EVALUATE / GET.CELL）、
复杂数函数（IM*）、统计分布函数（NORM.* / T / F / CHI 这一族）——预览不是计算器，这些要么
需要数组语义，要么一条公式错就会把整张表算歪，宁可显示 `#NAME?` 让人去 WPS 里算。

## 5. 对照表：WPS 有，我们呢

| WPS 的命令 | 我们 | 说明 |
| --- | --- | --- |
| 开始 · 剪贴板（粘贴/复制/剪切/格式刷） | ✅ 复制 / 剪切 / 格式刷；粘贴走 Ctrl+V | 不读系统剪贴板是有意的（浏览器权限） |
| 开始 · 字体（字体名、字号、B/I/U、字色、填充） | ✅ 全部 | 字色/填充是一按切换 + 侧边箭头开色板（WPS 也是这个形状） |
| 开始 · 对齐（六个方向、换行、缩进、方向、合并） | ✅ 方向 / 换行 / 合并 ▾；❌ 缩进 / 文字方向 | 缩进要改 `xf.indent` 的写回，不是这一轮 |
| 开始 · 数字格式（常规…文本 + 特殊十六种 + 加减小数位） | ✅ 全部 | 见上面第 3 节；自定义代码会造 `<numFmt>` 写回 |
| 开始 · 格式（条件格式 / 套用表格 / 单元格样式） | 🔶 只清条件格式（清格式按钮） | 新建规则/样式表要整块新引擎 |
| 开始 · 数据处理（自动求和 ▾ / 筛选 / 排序 ▾ / 填充） | ✅ 求和 ▾ / 筛选 / 排序 ▾；✅ 填充柄（拖拽） | 序列对话框不做，拖拽够日常 |
| 开始 · 单元格（行高列宽、插删行列、隐藏、工作表） | 🔶 插删行列 + 拖列宽行高；❌ 隐藏行列 / 工作表增删 | 工作表增删要改 workbook.xml 与 rels |
| 插入 · 表格/插图/图表/迷你图/符号/超链接 | ❌ 全部禁用（悬停说明原因） | 预览画的是文件里**已有**的图和图表；新插要会写 drawing XML |
| 页面 · 打印设置（页边距/方向/纸张/打印区域/页眉页脚/预览） | 🔶 只做了纸张视图与缩放 | 打印设置属于「输出」，预览里不做 |
| 公式 · 快捷函数与函数库 | ✅ 函数库七个类目 + 自动求和 ▾ | 点一个函数把 `=SUM(` 填进公式栏 |
| 公式 · 定义名称 / 公式审核 / 计算 | ❌ | 名称管理器要读写 `definedNames` |
| 数据 · 排序筛选 / 重复项 / 数据验证 / 分类汇总 / 拆分合并 | 🔶 排序 / 筛选 / 序列下拉（已有）；❌ 其余 | 分级汇总、合并计算是另一个量级 |
| 审阅 · 校对 / 语言 / 批注 / 保护 | 🔶 批注只读展示（红角 + 悬停正文） | 增删批注要写 `comments*.xml` |
| 视图 · 工作簿视图 / 显示 / 缩放 / 窗口（冻结 ▾） | ✅ 冻结（含首行/首列）/ 网格线 / 公式视图 / 缩放 | 分页预览、拆分窗口不做 |
| 右键菜单（单元格/行头/列头） | ❌ | 还没做；WPS 那份在 `res/commands/et/PopupMenu.kuip` |

灯位说明：✅ 能用且形状照 WPS；🔶 只做了其中一部分，剩下的在右边写明；❌ 禁用按钮/没有入口，悬停或本文档给原因。

## 6. 这一轮按它补了什么

| 位置 | 补的东西 |
| --- | --- |
| `bridge/src/sheet/numfmt.ts` | 重写成一套完整的格式代码解释器：分区（正;负;零;文本）、`#`/`0`/`?` 三种占位、千分位与缩放逗号、百分比、科学记数、分数、`[h]` 累计时长、`[DBNum1/2/3]` 中文数字、`$`/`[红色]` 一类的方括号、引号字面量 |
| `bridge/src/sheet/functions.ts` | 新增 164 个函数（见第 4 节） |
| `bridge/src/sheet/style-write.ts` | `nf` 现在也接受**格式代码**：没有对应的内置 id 就在 `xl/styles.xml` 里造一条 `<numFmt>`（从 164 起、按代码去重、`<numFmts>` 插在 schema 要求的位置） |
| `web/src/sheet/ribbon.ts` | 数字格式菜单（11 个常用 + 9 个特殊）、字色/填充色板（主题 12 + 标准 12）、边框菜单、清除菜单、合并 ▾、格式刷、自动求和 ▾、排序 ▾、公式函数库、冻结首行/首列 |
| `web/src/sheet/grid.ts` | 填充柄拖拽（等差/循环/带尾号文本）、Ctrl+方向键与 Ctrl+Shift+方向键、Ctrl+A、Tab/Enter 走位、Alt+Enter 格内换行、选区求和/平均/计数、空单元格也能上色上边框 |
| `web/src/sheet/fmt.ts` | 功能区选完格式后**立刻**改样子（不等存盘）：只认菜单里那 20 来个代码，认不出就退回桥端的显示串 |
| `bridge/tests/sheet-*.mjs` | 三份单元测试：数字格式 60 条、公式 148 条、自定义 numFmt 写回 9 条（`npm run test:sheet`） |

## 7. 重新生成这份对照

WPS 升级后资源会变，重跑这两条就行：

```bash
node tools/wps-inventory.mjs          # 功能区清单
node tools/wps-inventory.mjs --funcs  # 函数名
```

`mui/zh_CN/*.qm`（中英对照）目前解不出来；要读中文标签，最省事的路是 `rea capture-native-ui-scenario`
把真实的 WPS 窗口点一遍读 AX 树，那需要在本机真启动 WPS——这一轮没做。

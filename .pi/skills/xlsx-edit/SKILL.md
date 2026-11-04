---
name: xlsx-edit
description: 改这张机器上的 .xlsx / .xlsm 时用。只改单元格的值或公式，禁止用 exceljs / openpyxl「整本读进来再吐出去」——那会把图表、透视表、条件格式静默丢掉。改完网页预览（D116）会自动刷新。
---

# 改 xlsx：只动单元格，整本重写会吃图表

用户让你改一份表格（「把 B3 改成 100」「这几行金额算错了」）时，按这里的做法走。

## 铁律

1. **不要整本重写**。`exceljs` 读一份带图表的 xlsx 再 `writeFile`，图表和透视表会消失
   （exceljs#2607 / #261，复现过多次）；`openpyxl` 同理，而且掉的东西更多。
   网页里的表格预览（D116）之所以能保住图表，是因为它只 patch 被改的那几个 xml part。
2. **只改用户点名的那几格**。范围外的格式、列宽、隐藏行列、合并单元格都别动。
3. **改公式就写公式**，不要自己算出结果写死。缓存值留空，让 Excel 打开时重算。
4. **写之前确认自己真的只写了这一格**：用一个最小脚本读回那一格的值，跟预期比一遍。

## 推荐做法（按可用工具挑一条）

### A. 走专门的单元格 patch（最稳，和网页预览同一套语义）

网页的 `/api/sheet/save` 就是这条路：只重写 `<c r="B3">`，其余 part 原样搬运。
在仓库里可以直接用这段桥端代码：

```js
// bridge/src/xlsx-write.ts
import { applyCellEdits } from "./bridge/src/xlsx-write.js";
const { bytes, mode } = applyCellEdits(fs.readFileSync(file), [
  { sheet: "変更履歴", edits: [{ r: 2, c: 1, t: "s", v: "新しい値" }] }, // r/c 都是 0-based
]);
fs.writeFileSync(file, bytes);
```

`t` 的取值：`n` 数字、`s` 文本、`b` 布尔、`f` 公式（`v` 不带 `=`）、`clear` 清空内容。

### B. Python + openpyxl（只读单元格、只写单元格）

```python
import openpyxl
wb = openpyxl.load_workbook(path)          # 不要 keep_vba=False 以外的花招
ws = wb["変更履歴"]
ws["B3"] = 100                              # 只动这一格
wb.save(path)
```

`openpyxl` 保存仍然会丢一部分 Excel 私有部件（图表、切片器、部分条件格式）。
文件的图表很重要时，用 A，或者**另存成新文件**再交给用户，别覆盖原件。

### C. 从零生成一份新的表

`openpyxl` / `exceljs` / `xlsxwriter` 都行 —— 反正没有既有图表要保。

## 别做的事

- 别 `wb = load_workbook(...)` 之后 `wb.save()` 一个你没改几个格子的文件（整本重写）。
- 别把值写成字符串却期待它参与计算（"100" 不是 100）。
- 别改 `.xlsm` 的宏：`vbaProject.bin` 不能碰。
- 别用 `to_csv()` 再转回来 —— 样式、合并、公式全没了。

## 改完怎么确认

1. 读回那一格：值/公式对得上。
2. 文件里原来有的图表还在：`unzip -l <file>` 里 `xl/charts/` 和 `xl/pivotTables/` 与改之前一样多。
3. 网页里打开这份文件（或它已经开着）：预览 1.5 秒内自动刷新；没刷新就点 ⟳。

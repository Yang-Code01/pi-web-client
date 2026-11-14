#!/usr/bin/env python
"""把 run-book.mjs 写的 spec.json 变成测试书 xlsx，同时写出 layout.json 给 HTML 复刻用。

    python .pi/skills/pi-web-test-html/bin/build-xlsx.py --dir .scratch/testbook/workclock

一 case 一 sheet；总览 + 环境两页放在最前。图片按原始像素贴，行高按图片高度铺出来。
"""
import argparse
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import PageSetupProperties

ap = argparse.ArgumentParser()
ap.add_argument("--dir", default=".scratch/testbook/workclock", help="spec.json 与 shots/ 所在目录")
ap.add_argument("--name", default="", help="产物文件名（不含扩展名），默认取 spec.output 或 spec.module")
args = ap.parse_args()

ROOT = Path(args.dir).resolve()
SPEC = json.loads((ROOT / "spec.json").read_text(encoding="utf8"))
NAME = args.name or SPEC.get("output") or SPEC.get("module", "测试书").replace(" / ", "-").replace("/", "-")

FONT = "Arial"
TH_FILL = PatternFill("solid", fgColor="1F2A37")
TITLE_FILL = PatternFill("solid", fgColor="0F172A")
LABEL_FILL = PatternFill("solid", fgColor="EEF2F7")
ZEBRA = PatternFill("solid", fgColor="F7F9FC")
PASS_FILL = PatternFill("solid", fgColor="DDF3E1")
PASS_FONT = Font(name=FONT, size=10, bold=True, color="166534")
FAIL_FILL = PatternFill("solid", fgColor="FCE4E2")
FAIL_FONT = Font(name=FONT, size=10, bold=True, color="9F1239")
MANUAL_FILL = PatternFill("solid", fgColor="FFF1D6")
MANUAL_FONT = Font(name=FONT, size=10, bold=True, color="92400E")
THIN = Side(style="thin", color="CBD5E1")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)

VERDICT_STYLE = {
    "通过": ("pass", PASS_FILL, PASS_FONT),
    "失败": ("fail", FAIL_FILL, FAIL_FONT),
    "人工": ("manual", MANUAL_FILL, MANUAL_FONT),
}

CASE_COLS = [9, 44, 40, 46, 9]


def px(width_chars: int) -> int:
    """Excel 列宽（字符数）→ 像素（Calibri/Arial 11 的经验值：7px/字符 + 5px 边距）。"""
    return width_chars * 7 + 5


def units(text: str) -> float:
    """中文按 2 个字符宽算，用来估换行数。"""
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in text)


def lines_for(text: str, width_chars: int) -> int:
    if not text:
        return 1
    per = max(4, width_chars - 1)
    return max(1, math.ceil(units(text) / per))


def row_height(texts_and_widths) -> float:
    lines = max((lines_for(t, w) for t, w in texts_and_widths), default=1)
    return max(18.0, lines * 14.5 + 5)


class Sheet:
    def __init__(self, name, widths):
        self.name = name
        self.widths = widths
        self.rows = []  # {"h": pt, "cells": [ {c, v, style, span} ], "images": [ {file, w, h, rows} ]}

    def add(self, height, cells, images=None):
        self.rows.append({"h": round(height, 1), "cells": cells, "images": images or []})

    def merged_row(self, style, value, height=22.0, span=None):
        self.add(height, [{"c": 0, "v": value, "style": style, "span": span or len(self.widths)}])


def case_sheet(case):
    sh = Sheet(case["id"], CASE_COLS)
    span = len(CASE_COLS)
    sh.merged_row("title", f'{case["id"]} · {case["title"]}', 30.0)
    sh.add(21, [
        {"c": 0, "v": "用例编号", "style": "meta-label"},
        {"c": 1, "v": case["id"], "style": "meta-value", "span": 2},
        {"c": 3, "v": "优先级", "style": "meta-label"},
        {"c": 4, "v": case["priority"], "style": "meta-value-center"},
    ])
    sh.add(21, [
        {"c": 0, "v": "模块", "style": "meta-label"},
        {"c": 1, "v": case["module"], "style": "meta-value", "span": 2},
        {"c": 3, "v": "结果", "style": "meta-label"},
        {"c": 4, "v": case["verdict"], "style": "verdict-" + VERDICT_STYLE[case["verdict"]][0]},
    ])
    sh.add(row_height([(case["precondition"], sum(CASE_COLS[1:]))]), [
        {"c": 0, "v": "前置条件", "style": "meta-label"},
        {"c": 1, "v": case["precondition"], "style": "meta-value", "span": span - 1},
    ])
    sh.add(21, [
        {"c": 0, "v": "执行时间", "style": "meta-label"},
        {"c": 1, "v": case["startedAt"][:19].replace("T", " "), "style": "meta-value", "span": 2},
        {"c": 3, "v": "步骤数", "style": "meta-label"},
        {"c": 4, "v": len(case["steps"]), "style": "meta-value-center"},
    ])
    sh.add(8, [])

    head = ["步骤", "操作", "预期", "实际", "判定"]
    sh.add(26, [{"c": i, "v": t, "style": "th"} for i, t in enumerate(head)])

    for step in case["steps"]:
        actual = step["actual"] or "—"
        if step["evidence"]:
            actual = actual + "\n证据：" + "；".join(step["evidence"])
        cells = [
            {"c": 0, "v": str(step["no"]), "style": "td-center"},
            {"c": 1, "v": step["action"], "style": "td"},
            {"c": 2, "v": step["expected"], "style": "td"},
            {"c": 3, "v": actual, "style": "td-mono" if step["evidence"] else "td"},
            {"c": 4, "v": step["verdict"], "style": "verdict-" + VERDICT_STYLE[step["verdict"]][0]},
        ]
        h = row_height([
            (step["action"], CASE_COLS[1]),
            (step["expected"], CASE_COLS[2]),
            (actual, CASE_COLS[3]),
        ])
        sh.add(h, cells)

        for shot in step.get("shots", []):
            n_rows = max(3, math.ceil(shot["h"] / 16))
            sh.add(n_rows * 12, [], [{"file": shot["file"], "w": shot["w"], "h": shot["h"], "rows": n_rows}])
            sh.add(6, [])

    sh.merged_row("note", "截图按 100% 原始像素贴入（不缩放）：截图宽度可能超过 A–E 列总宽，页面上往右拖一点即可看全。", 20.0)
    return sh


def overview_sheet():
    sh = Sheet("总览", [12, 52, 26, 10, 10, 10, 26])
    sh.merged_row("title", SPEC["title"], 34.0)
    sh.merged_row("subtitle", f'{SPEC["module"]}　分支 {SPEC["branch"]}　PR {SPEC["pr"]}　{SPEC["decision"]}　执行 {SPEC["runAt"][:19].replace("T", " ")}', 20.0)
    sh.add(8, [])
    sh.add(24, [{"c": i, "v": t, "style": "th"} for i, t in enumerate(["编号", "用例", "模块", "优先级", "结果", "步骤", "备注"])])
    first = len(sh.rows) + 1
    for case in SPEC["cases"]:
        note = "需人工执行（UAC / 锁屏）" if case["verdict"] == "人工" else ""
        sh.add(22, [
            {"c": 0, "v": case["id"], "style": "td-center"},
            {"c": 1, "v": case["title"], "style": "td"},
            {"c": 2, "v": case["module"], "style": "td"},
            {"c": 3, "v": case["priority"], "style": "td-center"},
            {"c": 4, "v": case["verdict"], "style": "verdict-" + VERDICT_STYLE[case["verdict"]][0]},
            {"c": 5, "v": len(case["steps"]), "style": "td-center"},
            {"c": 6, "v": note, "style": "td"},
        ])
    last = len(sh.rows)
    sh.add(8, [])
    n_pass = sum(1 for c in SPEC["cases"] if c["verdict"] == "通过")
    n_fail = sum(1 for c in SPEC["cases"] if c["verdict"] == "失败")
    n_manual = sum(1 for c in SPEC["cases"] if c["verdict"] == "人工")
    n_steps = sum(len(c["steps"]) for c in SPEC["cases"])
    sh.add(22, [
        {"c": 0, "v": "统计", "style": "meta-label"},
        {"c": 1, "v": "通过", "style": "meta-label"},
        {"c": 2, "v": f'=COUNTIF(E{first}:E{last},"通过")', "style": "meta-value-center", "calc": n_pass},
        {"c": 3, "v": "失败", "style": "meta-label"},
        {"c": 4, "v": f'=COUNTIF(E{first}:E{last},"失败")', "style": "meta-value-center", "calc": n_fail},
        {"c": 5, "v": "人工", "style": "meta-label"},
        {"c": 6, "v": f'=COUNTIF(E{first}:E{last},"人工")', "style": "meta-value-center", "calc": n_manual},
    ])
    sh.add(22, [
        {"c": 0, "v": "合计", "style": "meta-label"},
        {"c": 1, "v": "用例条数", "style": "meta-label"},
        {"c": 2, "v": f"=COUNTA(A{first}:A{last})", "style": "meta-value-center", "calc": len(SPEC["cases"])},
        {"c": 3, "v": "步骤条数", "style": "meta-label"},
        {"c": 4, "v": f"=SUM(F{first}:F{last})", "style": "meta-value-center", "calc": n_steps},
        {"c": 5, "v": "", "style": "meta-value"},
        {"c": 6, "v": "", "style": "meta-value"},
    ])
    sh.add(8, [])
    sh.merged_row("note", "结论：能自动跑的全部通过；TC-03（Win+L 锁屏解锁）与 TC-10（UAC 读 Security 日志）必须在真机上由人操作，脚本只记录操作前状态。", 22.0)
    return sh


def env_sheet():
    sh = Sheet("环境与准备", [22, 100])
    env = SPEC["env"]
    sh.merged_row("title", "测试环境与复跑方法", 30.0)
    sh.add(8, [])
    sh.add(22, [{"c": 0, "v": "项目", "style": "th"}, {"c": 1, "v": "值", "style": "th"}])
    items = [
        ("操作系统", env["os"]),
        ("账号", f'{env["user"]}（管理员：{env["hasAdmin"]}）'),
        ("Node", env["node"]),
        ("PowerShell", f'{env["powershell"]}（build {env["pwsh5"]}）'),
        ("测试实例", f'branch {SPEC["branch"]}，bridge {env["bridge"]}，登录口令 {env["passphrase"]}'),
        ("浏览器", f'Chromium（Playwright），locale {env["pageLocale"]}，viewport {env["viewport"]}'),
        ("数据目录", "测试实例用隔离状态目录 pi-web-test-dev/wk，跑完清空；不碰正式 7864 的 workclock 数据"),
        ("页面无 JS 错误", "是" if not SPEC["pageErrors"] else "；".join(SPEC["pageErrors"][:3])),
    ]
    for k, v in items:
        sh.add(row_height([(v, 100)]), [{"c": 0, "v": k, "style": "meta-label"}, {"c": 1, "v": v, "style": "meta-value"}])
    sh.add(10, [])
    sh.merged_row("section", "复跑", 24.0)
    for line in [
        "1. 起隔离环境： node .pi/skills/pi-web-client-test-dev/bin/env.mjs start --dir <仓库> --name wk   → 页面 127.0.0.1:17876，口令 test",
        "2. 复位到全新状态： bash .scratch/testbook/reset.sh（卸计划任务、杀记录器、删状态目录、重启 bridge）",
        "3. 跑测试书并截图： node .scratch/testbook/run.mjs   → .scratch/testbook/spec.json + shots/",
        "4. 生成产物： python .scratch/testbook/build_xlsx.py && node .scratch/testbook/build_html.mjs",
        "5. 收工： node .pi/skills/pi-web-client-test-dev/bin/env.mjs stop --id wk（本测试书跑完后已执行）",
    ]:
        sh.add(row_height([(line, 100)]), [{"c": 0, "v": "·", "style": "td-center"}, {"c": 1, "v": line, "style": "td-mono"}])
    sh.add(10, [])
    sh.merged_row("note", "说明：记录器用例（TC-02 / TC-09）改的是本机计划任务 pi-web-client-workclock，脚本每次跑前后都会核对外部真实状态；TC-06 / TC-07 的历史是脚本按记录器文件格式写入的种子数据，不经过 UI 伪造。", 34.0)
    return sh


def build():
    wb = Workbook()
    blank = wb.active
    if blank is not None:
        wb.remove(blank)
    sheets = [overview_sheet(), env_sheet()] + [case_sheet(c) for c in SPEC["cases"]]

    layout = {"title": SPEC["title"], "sheets": []}

    for sh in sheets:
        ws = wb.create_sheet(sh.name)
        for i, w in enumerate(sh.widths):
            ws.column_dimensions[get_column_letter(i + 1)].width = w
        ws.sheet_view.showGridLines = False
        # 打印时横向、按页宽缩到一页，导 PDF/打印出来跟屏幕上一样整行可见
        ws.page_setup.orientation = "landscape"
        ws.page_setup.paperSize = ws.PAPERSIZE_A4
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)

        for r, row in enumerate(sh.rows, start=1):
            ws.row_dimensions[r].height = row["h"]
            for cell in row["cells"]:
                col = cell["c"] + 1
                anchor = ws.cell(row=r, column=col)
                anchor.value = cell.get("v", "")
                style = cell.get("style", "td")
                apply_style(anchor, style)
                span = cell.get("span", 1)
                if span > 1:
                    ws.merge_cells(start_row=r, start_column=col, end_row=r, end_column=col + span - 1)
                    for c2 in range(col + 1, col + span):
                        ws.cell(row=r, column=c2).border = BORDER
            for img in row["images"]:
                path = ROOT / img["file"]
                if not path.exists():
                    print("missing image", path)
                    continue
                pic = XLImage(str(path.resolve()))
                pic.width = img["w"]
                pic.height = img["h"]
                pic.anchor = f"A{r}"
                ws.add_image(pic)

        layout["sheets"].append({
            "name": sh.name,
            "cols": [px(w) for w in sh.widths],
            "rows": [
                {
                    "h": row["h"],
                    "cells": [
                        {
                            "c": c["c"],
                            "v": str(c.get("calc", c.get("v", ""))),
                            "formula": str(c["v"]) if str(c.get("v", "")).startswith("=") else None,
                            "style": c.get("style", "td"),
                            "span": c.get("span", 1),
                        }
                        for c in row["cells"]
                    ],
                    "images": [
                        {"file": i["file"], "w": i["w"], "h": i["h"], "rows": i["rows"]} for i in row["images"]
                    ],
                }
                for row in sh.rows
            ],
        })

    out = ROOT / f"{NAME}.xlsx"
    wb.save(out)
    (ROOT / "layout.json").write_text(json.dumps(layout, ensure_ascii=False, indent=1), encoding="utf8")
    recalc(out)
    print("wrote", out, "sheets", len(sheets))


def recalc(path: Path) -> None:
    """openpyxl 写出去的下具公式没有缓存值；本机有 LibreOffice 就让它重算一遍并原地替换。"""
    soffice = Path(r"C:\Program Files\LibreOffice\program\soffice.exe")
    if not soffice.exists():
        print("skip recalc: LibreOffice not found（Excel 打开时会自己算）")
        return
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(path, tmp / "in.xlsx")
    subprocess.run(
        [str(soffice), "--headless", "--norestore", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", str(tmp / "out"), str(tmp / "in.xlsx")],
        check=False,
        capture_output=True,
        timeout=180,
    )
    conv = tmp / "out" / "in.xlsx"
    if conv.exists():
        shutil.copy(conv, path)
        print("recalculated via LibreOffice")
    else:
        print("skip recalc: LibreOffice conversion failed")


def apply_style(cell, style):
    cell.font = Font(name=FONT, size=10)
    cell.alignment = WRAP
    cell.border = BORDER
    if style == "title":
        cell.font = Font(name=FONT, size=15, bold=True, color="FFFFFF")
        cell.fill = TITLE_FILL
        cell.alignment = Alignment(vertical="center", indent=1)
    elif style == "subtitle":
        cell.font = Font(name=FONT, size=10, color="475569")
        cell.alignment = Alignment(vertical="center", indent=1)
    elif style == "section":
        cell.font = Font(name=FONT, size=11, bold=True, color="0F172A")
        cell.fill = LABEL_FILL
        cell.alignment = Alignment(vertical="center", indent=1)
    elif style == "th":
        cell.font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
        cell.fill = TH_FILL
        cell.alignment = CENTER
    elif style == "meta-label":
        cell.font = Font(name=FONT, size=10, bold=True, color="334155")
        cell.fill = LABEL_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True, indent=1)
    elif style == "meta-value":
        cell.font = Font(name=FONT, size=10, color="0F172A")
        cell.alignment = Alignment(vertical="center", wrap_text=True, indent=1)
    elif style == "meta-value-center":
        cell.font = Font(name=FONT, size=10, bold=True, color="0F172A")
        cell.alignment = CENTER
    elif style == "td-center":
        cell.alignment = CENTER
    elif style == "td-mono":
        cell.font = Font(name="Consolas", size=9, color="0F172A")
    elif style == "note":
        cell.font = Font(name=FONT, size=9, color="475569")
        cell.alignment = Alignment(vertical="center", wrap_text=True, indent=1)
    for kind, fill, font in VERDICT_STYLE.values():
        if style == f"verdict-{kind}":
            cell.fill = fill
            cell.font = font
            cell.alignment = CENTER


if __name__ == "__main__":
    build()

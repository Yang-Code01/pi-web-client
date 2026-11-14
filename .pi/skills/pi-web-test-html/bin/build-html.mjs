#!/usr/bin/env node
/**
 * 把 layout.json（build-xlsx.py 写的表格模型）渲染成一份 Excel 1:1 复刻的 HTML：
 * 列宽/行高/合并/填充/图片位置全部照抄，底部是工作表页签，截图与 xlsx 都内联成
 * data URI —— 一个 .html 单独拷走就能看。
 *
 *   node .pi/skills/pi-web-test-html/bin/build-html.mjs --dir .scratch/testbook/workclock
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ROOT = path.resolve(arg("dir", ".scratch/testbook/workclock"));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, "layout.json"), "utf8"));
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "spec.json"), "utf8"));
const NAME = arg("name", spec.output ?? spec.module ?? "测试书").replace(/[\\/:*?"<>|]/g, "-").trim();
const OUT = path.join(ROOT, `${NAME}.html`);
const XLSX = path.join(ROOT, `${NAME}.xlsx`);
const xlsxHref = fs.existsSync(XLSX)
  ? `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${fs.readFileSync(XLSX).toString("base64")}`
  : `./${NAME}.xlsx`;

const IMG_CACHE = new Map();
/** 截图内嵌成 data URI：HTML 单文件就能带着图走，预览/转发都不会丢图。 */
function dataUri(rel) {
  if (IMG_CACHE.has(rel)) return IMG_CACHE.get(rel);
  const file = path.join(ROOT, rel);
  let out = rel;
  try {
    out = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    console.warn("missing image", rel);
  }
  IMG_CACHE.set(rel, out);
  return out;
}

/** 录屏（run-book.mjs --video 的产物）：整段 mp4 内嵌，章节用 spec.video.marks 定位。 */
const REEL = (() => {
  const v = spec.video;
  if (!v?.file) return null;
  const file = path.join(ROOT, v.file);
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  const mime = v.file.endsWith(".webm") ? "video/webm" : "video/mp4";
  return {
    ...v,
    src: `data:${mime};base64,${bytes.toString("base64")}`,
    mb: (bytes.length / 1048576).toFixed(1),
    poster: v.poster && fs.existsSync(path.join(ROOT, v.poster)) ? dataUri(v.poster) : null,
  };
})();
const REEL_TAB = "测试录像";

const PT_TO_PX = 4 / 3;
const px = (pt) => Math.round(pt * PT_TO_PX);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i) => String.fromCharCode(65 + i);

const STYLE = {
  title: "font-size:15px;font-weight:700;color:#fff;background:#0f172a;padding-left:6px;display:flex;align-items:center",
  subtitle: "font-size:11px;color:#475569;padding-left:6px;display:flex;align-items:center",
  section: "font-size:11px;font-weight:700;color:#0f172a;background:#eef2f7;padding-left:6px;display:flex;align-items:center",
  th: "font-weight:700;color:#fff;background:#1f2a37;display:flex;align-items:center;justify-content:center;text-align:center",
  "meta-label": "font-weight:700;color:#334155;background:#eef2f7;padding-left:6px;display:flex;align-items:center",
  "meta-value": "color:#0f172a;padding-left:6px;display:flex;align-items:center",
  "meta-value-center": "font-weight:700;color:#0f172a;display:flex;align-items:center;justify-content:center",
  "td-center": "display:flex;align-items:flex-start;justify-content:center",
  "td-mono": "font-family:Consolas,monospace;font-size:10px;align-items:flex-start",
  note: "font-size:10px;color:#475569;padding-left:6px;display:flex;align-items:center",
  "verdict-pass": "background:#ddf3e1;color:#166534;font-weight:700;align-items:center;justify-content:center;display:flex;text-align:center",
  "verdict-fail": "background:#fce4e2;color:#9f1239;font-weight:700;align-items:center;justify-content:center;display:flex;text-align:center",
  "verdict-manual": "background:#fff1d6;color:#92400e;font-weight:700;align-items:center;justify-content:center;display:flex;text-align:center",
  td: "display:block;align-items:flex-start",
};

function renderSheet(sheet, index) {
  const cols = sheet.cols;
  const totalW = cols.reduce((a, b) => a + b, 0);
  const rowHeights = sheet.rows.map((r) => px(r.h));
  const totalH = rowHeights.reduce((a, b) => a + b, 0);
  const offX = (c) => cols.slice(0, c).reduce((a, b) => a + b, 0);
  const offY = (r) => rowHeights.slice(0, r).reduce((a, b) => a + b, 0);

  const headCols = cols
    .map((w, i) => `<div class="colhead" style="width:${w}px">${colName(i)}</div>`)
    .join("");
  const headRows = rowHeights
    .map((h, i) => `<div class="rowhead" style="height:${h}px">${i + 1}</div>`)
    .join("");

  const rowsHtml = sheet.rows
    .map((row, r) => {
      const cells = (row.cells ?? [])
        .map((cell) => {
          const span = cell.span ?? 1;
          const w = cols.slice(cell.c, cell.c + span).reduce((a, b) => a + b, 0);
          const h = px(row.h);
          const style = STYLE[cell.style] ?? STYLE.td;
          const align = cell.style === "td" || cell.style === "td-mono" ? "left" : "";
          return `<div class="cell s-${cell.style}" data-ref="${colName(cell.c)}${r + 1}" data-val="${esc(cell.v)}" style="left:${offX(cell.c)}px;width:${w}px;height:${h}px;${style};${align ? "display:block" : ""}"><span>${esc(cell.v)}</span></div>`;
        })
        .join("");
      return `<div class="r" style="height:${px(row.h)}px">${cells}</div>`;
    })
    .join("");

  const imgsHtml = sheet.rows
    .flatMap((row, r) => (row.images ?? []).map((img) => {
      const src = dataUri(img.file);
      return `<img class="shot" src="${esc(src)}" width="${img.w}" height="${img.h}" style="left:${offX(0)}px;top:${offY(r)}px" alt="">`;
    }))
    .join("");

  return `<section class="sheet${index === 0 ? " on" : ""}" data-sheet="${esc(sheet.name)}" style="--body-w:${totalW}px;--body-h:${totalH}px">
  <div class="grid">
    <div class="corner"></div>
    <div class="colstrip"><div class="colhead-row">${headCols}</div></div>
    <div class="rowstrip">${headRows}</div>
    <div class="body"><div class="rowlayer">${rowsHtml}</div><div class="imglayer">${imgsHtml}</div></div>
  </div>
</section>`;
}

const tabs = layout.sheets
  .map((s, i) => `<button class="tab${i === 0 ? " on" : ""}" data-tab="${esc(s.name)}">${esc(s.name)}</button>`)
  .join("") +
  (REEL ? `<button class="tab" data-tab="${REEL_TAB}">${REEL_TAB}</button>` : "");

/** 录像工作表：一段能直接放的视频 + 按用例步骤排的章节（点一下跳过去）。 */
function renderReel() {
  const chapters = (REEL.marks ?? []).length
    ? `<div class="reel-chapters">${(REEL.marks ?? [])
        .map(
          (m) =>
            `<button class="chap" data-t="${m.t.toFixed(2)}"><b>${esc(m.case)} · ${m.no}</b>${esc(m.label)}</button>`,
        )
        .join("")}</div>`
    : "";
  return `<section class="sheet reel-sheet" data-sheet="${REEL_TAB}">
  <div class="reel">
    <div class="reel-head"><b>测试录像</b><span>${esc(spec.title)} · ${REEL.seconds}s · ${REEL.mb} MB · ${REEL.w}×${REEL.h}</span></div>
    <video id="reel" controls autoplay muted playsinline ${REEL.poster ? `poster="${esc(REEL.poster)}"` : ""} src="${esc(REEL.src)}"></video>
    ${chapters}
  </div>
</section>`;
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(spec.title)}</title>
<style>
  :root { --line:#d6dbe1; --head:#f3f4f6; --text:#1f2328; }
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body { font: 12px/1.4 Arial, "Microsoft YaHei", sans-serif; color:var(--text); background:#eceff3; display:flex; flex-direction:column; overflow:hidden; }
  .xls-title { height:34px; display:flex; align-items:center; gap:10px; padding:0 12px; background:#217346; color:#fff; font-size:13px; }
  .xls-title b { font-weight:700; }
  .xls-title span { opacity:.8; font-size:11px; }
  .xls-title a { margin-left:auto; color:#fff; text-decoration:none; border:1px solid rgba(255,255,255,.5); border-radius:4px; padding:3px 9px; font-size:11px; }
  .xls-title a:hover { background:rgba(255,255,255,.12); }
  .fxbar { height:32px; display:flex; align-items:stretch; background:#f8f9fb; border-bottom:1px solid var(--line); }
  .namebox { width:96px; display:flex; align-items:center; justify-content:center; font-size:11px; border-right:1px solid var(--line); background:#fff; color:#333; }
  .fx { width:54px; display:flex; align-items:center; justify-content:center; border-right:1px solid var(--line); color:#666; font-style:italic; font-family:Georgia,serif; }
  .fxtxt { flex:1; display:flex; align-items:center; padding:0 8px; background:#fff; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pane { flex:1; overflow:auto; background:#fff; position:relative; }
  .sheet { display:none; }
  .sheet.on { display:block; }
  .grid { display:grid; grid-template-columns:40px max-content; grid-template-rows:22px max-content; align-items:start; }
  .corner { position:sticky; left:0; top:0; z-index:6; width:40px; height:22px; background:var(--head); border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
  .colstrip { position:sticky; top:0; z-index:5; height:22px; background:var(--head); }
  .colhead-row { display:flex; height:22px; }
  .colhead { flex:none; display:flex; align-items:center; justify-content:center; font-size:11px; color:#4b5563; background:var(--head); border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
  .rowstrip { position:sticky; left:0; z-index:4; width:40px; background:var(--head); }
  .rowhead { display:flex; align-items:center; justify-content:center; font-size:11px; color:#4b5563; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
  .body { position:relative; }
  .rowlayer { position:relative; }
  .r { position:relative; }
  .cell { position:absolute; top:0; font-size:11px; overflow:hidden; padding:2px 5px; line-height:1.3; white-space:pre-wrap; word-break:break-word; box-shadow: inset -1px -1px 0 var(--line); }
  .cell.s-td-center { justify-content:center; text-align:center; }
  .cell.s-th { padding:0; }
  .imglayer { position:absolute; inset:0; pointer-events:none; }
  .shot { position:absolute; box-shadow:0 0 0 1px var(--line); max-width:none; }
  .tabs { height:34px; display:flex; align-items:flex-end; gap:2px; padding:0 8px; background:#f3f4f6; border-top:1px solid var(--line); overflow-x:auto; }
  .tab { border:1px solid transparent; border-bottom:none; background:transparent; color:#4b5563; font:11px Arial,"Microsoft YaHei",sans-serif; padding:5px 12px; border-radius:5px 5px 0 0; cursor:pointer; white-space:nowrap; }
  .tab:hover { background:#e6e9ee; }
  .tab.on { background:#fff; border-color:var(--line); color:#0f172a; font-weight:700; box-shadow:0 -1px 0 #217346 inset; }
  .status { height:24px; display:flex; align-items:center; gap:14px; padding:0 12px; background:#f8f9fb; border-top:1px solid var(--line); font-size:11px; color:#57606a; }
  .status .grow { flex:1; }
  .badge { border-radius:9px; padding:1px 8px; font-weight:700; font-size:10px; }
  .badge.pass { background:#ddf3e1; color:#166534; }
  .badge.fail { background:#fce4e2; color:#9f1239; }
  .badge.manual { background:#fff1d6; color:#92400e; }
  .reel-sheet { height:100%; }
  .reel { height:100%; display:flex; flex-direction:column; gap:10px; padding:14px; background:#0f172a; }
  .reel-head { display:flex; align-items:baseline; gap:10px; color:#e2e8f0; font-size:12px; }
  .reel-head b { font-size:13px; }
  .reel-head span { color:#94a3b8; font-size:11px; }
  #reel { flex:1; min-height:0; width:100%; background:#000; border-radius:6px; box-shadow:0 0 0 1px #1e293b; }
  .reel-chapters { display:flex; flex-wrap:wrap; gap:6px; max-height:112px; overflow:auto; }
  .chap { display:flex; gap:6px; align-items:baseline; border:1px solid #334155; background:#1e293b; color:#cbd5e1; border-radius:5px; padding:4px 8px; font:11px Arial,"Microsoft YaHei",sans-serif; cursor:pointer; }
  .chap:hover { background:#273449; color:#fff; }
  .chap b { color:#7dd3fc; font-weight:700; }
</style>
</head>
<body>
  <div class="xls-title">
    <b>${esc(spec.title)}</b>
    <span>${esc(spec.branch)} · PR ${esc(spec.pr)} · ${esc(spec.decision)} · 只读</span>
    <a href="${xlsxHref}" download="${NAME}.xlsx">下载 xlsx</a>
  </div>
  <div class="fxbar">
    <div class="namebox" id="namebox">A1</div>
    <div class="fx">fx</div>
    <div class="fxtxt" id="fxtxt"></div>
  </div>
  <div class="pane" id="pane">
    ${layout.sheets.map(renderSheet).join("\n")}
    ${REEL ? renderReel() : ""}
  </div>
  <div class="tabs">${tabs}</div>
  <div class="status">
    <span>${layout.sheets.length + (REEL ? 1 : 0)} 个工作表</span>
    <span>${spec.summary.shots} 张截图</span>
    <span class="grow"></span>
    <span class="badge pass">通过 ${spec.summary.pass}</span>
    <span class="badge fail">失败 ${spec.summary.fail}</span>
    <span class="badge manual">人工 ${spec.summary.manual}</span>
    <span>${esc(spec.runAt.slice(0, 19).replace("T", " "))}</span>
  </div>
  <script>
    const pane = document.getElementById("pane");
    const namebox = document.getElementById("namebox");
    const fxtxt = document.getElementById("fxtxt");
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
        document.querySelectorAll(".sheet").forEach((s) => s.classList.toggle("on", s.dataset.sheet === tab.dataset.tab));
        pane.scrollTo({ top: 0, left: 0 });
        namebox.textContent = "A1";
        fxtxt.textContent = "";
      });
    });
    document.addEventListener("click", (e) => {
      const cell = e.target.closest(".cell");
      if (!cell) return;
      namebox.textContent = cell.dataset.ref;
      fxtxt.textContent = cell.dataset.val;
    });
    const reel = document.getElementById("reel");
    document.querySelectorAll(".chap").forEach((btn) => {
      btn.addEventListener("click", () => {
        reel.currentTime = Number(btn.dataset.t) || 0;
        reel.play().catch(() => {});
      });
    });
  </script>
</body>
</html>
`;

fs.writeFileSync(OUT, html, "utf8");
console.log("wrote", path.relative(process.cwd(), OUT), `${(html.length / 1024).toFixed(1)} KB`);

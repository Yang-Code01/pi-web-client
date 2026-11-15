#!/usr/bin/env node
/**
 * 把本机 WPS 的**表格**界面资源读成一份 Markdown 清单（D266）。
 *
 * 我们这份表格浮窗的功能区是照着 WPS 排的，可「WPS 到底有哪几个页签、每个组里有哪些项、
 * 哪些是下拉」这件事不该靠记忆。WPS 的界面是声明式的：`Contents/Resources/office6/res/`
 * 下的 `commands/et/ongmani/CT_*.kuip` 就是六个页签的 ribbon 定义（组、项、嵌套下拉都在），
 * `mui/zh_CN/config/*.cfg` 里则是数字格式、日期格式和函数清单。
 *
 * 用法：
 *   node tools/wps-inventory.mjs                       # 自动找 /Applications/wpsoffice.app
 *   node tools/wps-inventory.mjs --app <路径> --md     # 输出 Markdown（默认）
 *   node tools/wps-inventory.mjs --funcs               # 只列函数名
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args[i + 1] ?? "");
};
const has = (name) => args.includes(name);

const APP = flag("--app") || process.env.WPS_APP || "/Applications/wpsoffice.app";
const RES = path.join(APP, "Contents/Resources/office6");
const DIR = path.join(RES, "res/commands/et/ongmani");
const MUI = path.join(RES, "mui/zh_CN/config");

if (!fs.existsSync(DIR)) {
  console.error(`没找到 WPS 的表格界面资源：${DIR}\n用 --app 指定 .app 的路径。`);
  process.exit(1);
}

const TABS = [
  ["CT_Home.kuip", "开始"],
  ["CT_Insert.kuip", "插入"],
  ["CT_Layout.kuip", "页面"],
  ["CT_Formulas.kuip", "公式"],
  ["CT_Data.kuip", "数据"],
  ["CT_Review.kuip", "审阅"],
  ["CT_View.kuip", "视图"],
];

function attrs(src) {
  const out = {};
  for (const m of src.matchAll(/([A-Za-z_][\w.:-]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** 极简 XML 树：够用于这些 kuip（属性里没有裸 <>&）。 */
function tree(xml) {
  const root = { tag: "#root", attrs: {}, kids: [] };
  const stack = [root];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g)) {
    if (m[0].startsWith("<!") || m[0].startsWith("<?")) continue;
    const [, close, tag, attrSrc, selfClose] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { tag, attrs: attrs(attrSrc), kids: [] };
    stack[stack.length - 1].kids.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const clean = (s) =>
  (s ?? "")
    .replace(/^@/, "")
    .replace(/&#10;/g, "⏎")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** 一个命令节点 → 一行说明；带子项的（下拉 / 列表）展开成「主项{a / b}」。 */
function describe(node, byId, depth = 0) {
  const kids = [];
  for (const k of node.kids) {
    const target = k.tag === "command" && k.attrs.idQ ? byId.get(k.attrs.idQ) : k;
    if (!target || target.tag === "separator") continue;
    if (!target.attrs.text && !target.attrs.customTip && !target.attrs.id) continue;
    kids.push(target);
  }
  const label = clean(node.attrs.text ?? node.attrs.customTip ?? node.attrs.id);
  const hint = node.attrs.shortcutHint ? ` [${node.attrs.shortcutHint}]` : "";
  if (!kids.length || depth > 2) return `${label || node.attrs.id}${hint}`;
  return `${label || node.attrs.id}${hint}{${kids.map((k) => describe(k, byId, depth + 1)).filter(Boolean).join(" / ")}}`;
}

// 跨文件索引：页签里引用的命令常常定义在 etcommon.kuip 或别的页签文件里
const roots = new Map();
const byId = new Map();
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".kuip"))) {
  const root = tree(fs.readFileSync(path.join(DIR, file), "utf8"));
  roots.set(file, root);
  (function walk(node) {
    for (const k of node.kids) {
      if (k.attrs.id && !byId.has(k.attrs.id)) byId.set(k.attrs.id, k);
      walk(k);
    }
  })(root);
}

function findTag(node, tag) {
  for (const k of node.kids) {
    if (k.tag === tag) return k;
    const hit = findTag(k, tag);
    if (hit) return hit;
  }
  return null;
}

if (has("--funcs")) {
  const cfg = path.join(MUI, "etfunctionhelp.cfg");
  const names = [...fs.readFileSync(cfg, "utf8").matchAll(/^([A-Za-z][\w.]*)\s*=/gm)].map((m) => m[1].toUpperCase());
  console.log([...new Set(names)].sort().join(" "));
  process.exit(0);
}

const lines = [];
for (const [file, label] of TABS) {
  const root = roots.get(file);
  if (!root) continue;
  const layout = findTag(root, "ribbonLayout");
  if (!layout) continue;
  lines.push(`## ${label}（${file}）`);
  let n = 0;
  for (const group of layout.kids.filter((k) => k.tag === "ribbonGroup")) {
    const head = byId.get(group.attrs.idQ);
    const cap = clean(head?.attrs.text ?? head?.attrs.customTip ?? group.attrs.idQ);
    const items = [];
    const refs = group.kids.filter((k) => k.tag === "ribbonItem");
    if (refs.length) {
      for (const it of refs) {
        const target = byId.get(it.attrs.idQ);
        items.push(target ? describe(target, byId) : `?${it.attrs.idQ}`);
      }
    } else if (head) {
      for (const k of head.kids) {
        const target = k.tag === "command" && k.attrs.idQ ? byId.get(k.attrs.idQ) : k;
        if (!target || target.tag === "separator") continue;
        items.push(describe(target, byId));
      }
    }
    lines.push(`${++n}. **${cap}** — ${items.join(" ; ")}`);
  }
  lines.push("");
}

if (has("--json")) {
  console.log(JSON.stringify({ tabs: lines }, null, 2));
} else {
  console.log(lines.join("\n"));
}

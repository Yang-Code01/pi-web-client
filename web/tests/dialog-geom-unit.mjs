/**
 * 守卫：每一扇 `window` 浮层都接上了窗口几何（#755）。
 *
 * 上一版的问题不是「抓手不好用」，而是**漏一扇没人发现**：表现是那扇窗永远记不住，安安静静。
 * 这次要铺四十多扇窗，所以拿三道扫描盯着（都只看源码，不开浏览器 —— 真拖拽在
 * `dialog-geom-browser.mjs` 里量）：
 *
 *  1. **id 表 ⊆ 代码**：`WINDOW_IDS` 里每个 id 都得在源码里被真正用上（`attachWindowGeom("id"` 那一行，
 *     或者动态接线的 `// dialog-geom-ids:` 标一行）。表里加了 id 却没接线 = 红。
 *  2. **代码 ⊆ id 表**：源码里出现的 `attachWindowGeom("…")` 必须是表里的 id（拼错 = 红），
 *     豁免名单里的 id 不许接（它们本来就不装抓手）。
 *  3. **创建点不漏**：每个文件里 `window` 材质的创建点数量，不能多于「接线 + `// dialog-geom:` 豁免」的数量。
 *
 * 加一扇新窗：往 `dialoggeom-ids.ts` 补 id，创建它时调一次 `attachWindowGeom("<id>", …)`，这里自然就绿。
 *
 * Run: node --experimental-strip-types web/tests/dialog-geom-unit.mjs
 */
import fs from "node:fs";
import path from "node:path";

import { DOCK_IDS, EXEMPT_IDS, WINDOW_IDS } from "../src/dialoggeom-ids.ts";

const SRC = path.resolve(import.meta.dirname, "..", "src");

let bad = 0;
const fail = (msg) => {
  console.log(`FAIL ${msg}`);
  bad += 1;
};
const ok = (cond, msg) => {
  if (!cond) fail(msg);
  else console.log(`ok   ${msg}`);
};

/** 走一遍 src（含内网通页面、sheet / notes 等子目录）。 */
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({
  rel: path.relative(SRC, p).replace(/\\/g, "/"),
  lines: fs.readFileSync(p, "utf8").split("\n"),
}));

const ids = new Set([...WINDOW_IDS, ...DOCK_IDS]);
const exempt = new Set(EXEMPT_IDS);

// ---------------------------------------------------------------- 1 & 2. id 表 ↔ 代码

const wiredIds = [];
for (const f of files) {
  f.lines.forEach((line, i) => {
    const where = `${f.rel}:${i + 1}`;
    // 字面量第一参数：`attachWindowGeom("peer", …)`。
    const literal = /attachWindowGeom\(\s*"([a-z][a-z0-9-]*)"/.exec(line);
    if (literal) wiredIds.push({ id: literal[1], where });
    // 动态接线（id 是三元或变量）的那几处，用一行注释声明自己占用了谁：
    // `// dialog-geom-ids: share bug`。宁可多写一行，也不让扫描去猜表达式。
    for (const m of line.matchAll(/\/\/\s*dialog-geom-ids:\s*([a-z0-9- ]+)/g)) {
      for (const id of m[1].trim().split(/\s+/)) wiredIds.push({ id, where });
    }
  });
}

const wired = new Set(wiredIds.map((w) => w.id));
const missing = [...WINDOW_IDS].filter((id) => !wired.has(id));
ok(missing.length === 0, `id 表里的 ${WINDOW_IDS.length} 个窗口 id 都在源码里接上了${missing.length ? `（缺：${missing.join(", ")}）` : ""}`);

const unknown = [...wired].filter((id) => !ids.has(id) && !exempt.has(id));
ok(unknown.length === 0, `源码里没有表外的 id${unknown.length ? `（多出：${unknown.join(", ")}）` : ""}`);

const attachedExempt = wiredIds.filter((w) => exempt.has(w.id));
ok(attachedExempt.length === 0, `豁免的窗不接抓手${attachedExempt.length ? `（${attachedExempt.map((w) => `${w.id} @ ${w.where}`).join(", ")}）` : ""}`);

// ---------------------------------------------------------------- 3. 每个文件的创建点都要有去处

/** 接线或豁免的那一行：`attachWindowGeom(`，或 `// dialog-geom: <理由>`。 */
const WIRED_OR_EXEMPT = /attachWindowGeom\(|\/\/\s*dialog-geom:/g;

/**
 * `window` 材质的创建点：`markSurface(…, "window")`，以及 `overlay(...)` 里默认 / 显式 window 的。
 *
 * **不走正则、逐字符数括号**。试过的三种写法各有一个静默的坑（都在本文件的反证里）：
 * - 只看单行：实参拆到下一行（`markSurface(el(...),\n "window")`）的那处就不算创建点 ——
 *   而这个文件存在的理由正是「漏一扇没人发现」；
 * - `[^)]*`：实参里几乎一定有嵌套括号（`el("div", …)`），它在内层那个 `)` 上就停下，永远匹配不上；
 * - 不限长的懒匹配：一处 menu 调用（甚至注释里的示例）后面隔着几十行别处的 `"window"` 照样被连上。
 * 所以老实扫：遇到 `markSurface(` / `.overlay(` 就配对括号走到它自己的 `)`（字符串里的括号不算），
 * 只在**这一份实参**里找材质。注释里没有真正的调用跟着，自然不算。
 */
function windowSites(text) {
  const re = /(?:markSurface|\.overlay)\(/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex;
    let depth = 1;
    const args = [];
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j++;
        args.push(text.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
      args.push(c);
      i++;
    }
    const argText = args.join("");
    if (/"window"/.test(argText)) out.push("window");
    else if (m[0] === ".overlay(" && !/"(paper|dock|menu|toast)"/.test(argText)) out.push("default");
  }
  return out;
}

for (const f of files) {
  const text = f.lines.join("\n");
  const sites = windowSites(text).length;
  if (!sites) continue;
  const wiredCount = (text.match(WIRED_OR_EXEMPT) ?? []).length;
  ok(
    sites <= wiredCount,
    `${f.rel}：${sites} 个 window 创建点 / ${wiredCount} 处接线或豁免${sites > wiredCount ? "（有窗没接，或者参数拆到了多行而这里没数对）" : ""}`,
  );
}

// ---------------------------------------------------------------- 自检：多行创建点也要数得到，别处的不许数进来
{
  const multiLine = 'const back = markSurface(el("div", "sheet-back"),\n  "window",\n  { enter: "alert" },\n);\n';
  const single = 'const back = markSurface(el("div", "x"), "window");\n';
  const byDefault = 'this.overlay(back);\n';
  const sites = (t) => windowSites(t).length;
  ok(sites(multiLine) === 1, "创建点把实参拆到多行，守卫也数得到");
  ok(sites(single) === 1, "单行的创建点数 1");
  ok(sites(byDefault) === 1, "不写材质的 overlay() 默认是 window");
  ok(sites('this.overlay(dialog.root, "paper");') === 0, "paper / dock 材质不算 window");
  ok(
    sites('markSurface(a, "menu");\nmarkSurface(b, "window");\nmarkSurface(c, "window");\n') === 2,
    "两次 window 调用就数两处",
  );
  ok(
    sites('markSurface(a, "menu");\n' + "const unused = 1;\n".repeat(30) + 'tr("window");\n') === 0,
    "menu 调用后面隔着几十行才出现 \"window\" 字样，不算 window 创建点",
  );
  ok(
    sites(' * 只在**创建处**调一次：`markSurface(el("div", "remind-pop"), "menu")`。\n') === 0,
    "注释里的示例不算创建点",
  );
  // 字符串里的括号不许把配对带偏：`el("div", ")")` 里的那个 `)` 在字符串里。
  ok(
    sites('markSurface(el("div", ")"),\n  "window"\n);\n') === 1,
    "实参字符串里的括号不参与配对",
  );
}

// ---------------------------------------------------------------- 4. 抓手真的存在，两个页面都拿得到

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const grip = read("wingrip.css");
const css = read("styles.css");
ok(/\.win-grip\s*\{/.test(grip), "wingrip.css 里有 `.win-grip` 的样式");
ok(/--win-grip-size\s*:/.test(grip), "抓手边长只有 `--win-grip-size` 一个来源");
ok(/\.win-grip-panel\s*>\s*:is\(/.test(css), "底栏给抓手让位那条在，而且是**直接子元素**（别挤到嵌进来的子面板）");
// 内网通页面只加载 peer.css：那里不 import 的话，选文件浮层上的抓手是个 0 尺寸、无定位的空 div。
ok(/@import\s+"\.\.\/wingrip\.css"/.test(read("peer/peer.css")), "peer.css 也 import 了 wingrip.css（内网通页面拿得到抓手样式）");
ok(/@import\s+"\.\/wingrip\.css"/.test(css), "styles.css import 了 wingrip.css");
const allSrc = files.map((f) => f.lines.join("\n")).join("\n");
ok(!/\.term-resize/.test(css) && !/\.term-resize/.test(allSrc), "旧类名 `.term-resize` 已并进 `.win-grip`");

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条未通过`);
process.exit(bad === 0 ? 0 : 1);

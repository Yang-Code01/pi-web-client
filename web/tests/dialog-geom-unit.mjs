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

/**
 * 把注释换成等长的空白（**行数与列号一个不动**，报错时指得到原位置），但两类标记原样留下：
 * `// dialog-geom: <理由>` 与 `// dialog-geom-ids: a b` 本身就是豁免 / 接线的信号。
 * 字符串里的 `//` 与 `/*` 不算注释（先过一遍字符串）。
 */
function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (src.startsWith("//", i)) {
      let j = src.indexOf("\n", i);
      if (j < 0) j = src.length;
      const line = src.slice(i, j);
      out += /\/\/\s*dialog-geom(-ids)?:/.test(line) ? line : " ".repeat(line.length);
      i = j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? src.length : j + 2;
      const block = src.slice(i, j);
      // 块注释里也可能写标记（多行 JSDoc 里）
      out += /dialog-geom(-ids)?:/.test(block) ? block : block.replace(/[^\n]/g, " ");
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const files = walk(SRC).map((p) => {
  const raw = fs.readFileSync(p, "utf8");
  const code = stripComments(raw);
  return {
    rel: path.relative(SRC, p).replace(/\\/g, "/"),
    raw,
    code,
    /** 行号 → 原始行（报错用）。 */
    lineText: (pos) => raw.slice(0, pos).split("\n").length,
  };
});

const ids = new Set([...WINDOW_IDS, ...DOCK_IDS]);
const exempt = new Set(EXEMPT_IDS);

// ---------------------------------------------------------------- 1 & 2. id 表 ↔ 代码

/** 第一参数是字符串字面量的 `attachWindowGeom("id", …)`（任意引号；在剥过注释的文本上找，示例不算接线）。 */
const WIRED_CALL = /attachWindowGeom\(\s*(["'`])([A-Za-z][\w-]*)\1/g;
/** 动态接线（id 是三元或变量）的那几处，用一行标记声明自己占用了谁：`// dialog-geom-ids: share bug`。 */
const WIRED_IDS_MARK = /\/\/\s*dialog-geom-ids:\s*([\w- ]+)/g;

const wiredIds = [];
for (const f of files) {
  for (const m of f.code.matchAll(WIRED_CALL)) wiredIds.push({ id: m[2], where: `${f.rel}:${f.lineText(m.index)}` });
  for (const m of f.code.matchAll(WIRED_IDS_MARK)) {
    for (const id of m[1].trim().split(/\s+/)) wiredIds.push({ id, where: `${f.rel}:${f.lineText(m.index)}` });
  }
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
 * 一处「调用」在剥过注释的文本里的位置与实参：从 `markSurface(` / `.overlay(` 起，逐字符配对括号走到
 * 它自己的 `)`，字符串（`"` / `'` / `` ` ``）里的括号不算。返回实参原文与起止位置。
 *
 * **为什么不走正则**（三种写法各有一个静默的坑，都在下面的反证里）：只看单行漏多行实参；`[^)]*` 在嵌套
 * 括号上永远匹配不上；不限长懒匹配会把一处 menu 调用（甚至注释里的示例）连到几十行外的 `"window"`。
 */
function calls(text) {
  const re = /(?:markSurface|\.overlay)\(/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex;
    let depth = 1;
    const args = [];
    /** **顶层**字符串实参：没嵌在 `el(…)` / `{ … }` / 子调用里的那些 —— 材质只可能在这一层。 */
    const topStrings = [];
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
        const str = text.slice(i, j + 1);
        args.push(str);
        if (depth === 1) topStrings.push(str.slice(1, -1));
        i = j + 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
      args.push(c);
      i += 1;
    }
    out.push({ at: m.index, end: i, name: m[0], argText: args.join(""), topStrings });
  }
  return out;
}

/** 材质档位（与 `modal.ts` 的 `SurfaceKind` 同一张表）。 */
const KINDS = ["window", "paper", "dock", "menu", "toast"];

/**
 * 调用的材质实参 —— 只看**顶层**字符串（`calls()` 记的 `topStrings`）。
 * 不能拿「第一个 / 最后一个字符串」猜（第一个是 `el("div", …)` 的标签名，最后一个可能是 `{ enter: "alert" }`）；
 * 也不能在**全部**实参字符串里找材质词：`markSurface(el("div", "menu-host"), "window")` 的子调用里
 * 先出现 `menu`，全扫就会把一扇 window 当成 menu —— 那是漏报，正是这个守卫要防的那种。
 * 材质是 `markSurface(node, "window", …)` 的**第二个实参**、也就是顶层第一个材质词。认任意引号。
 */
function surfaceKind(call) {
  return call.topStrings.find((v) => KINDS.includes(v)) ?? (call.name === ".overlay(" ? "window" : null);
}

/** `window` 材质的创建点（位置）。 */
function windowSites(text) {
  return calls(text).filter((c) => surfaceKind(c) === "window").map((c) => ({ at: c.at, end: c.end }));
}

/** 「此处有接线或豁免」的位置：`attachWindowGeom(` 的调用，或 `// dialog-geom:` 标记。 */
function wiredMarks(text) {
  const out = [];
  for (const m of text.matchAll(/attachWindowGeom\(/g)) out.push(m.index);
  for (const m of text.matchAll(/\/\/\s*dialog-geom:/g)) out.push(m.index);
  return out.sort((a, b) => a - b);
}

/**
 * 创建点与「接线 / 豁免」**一对一就近配对**，不比总数、也不只看「附近有没有一个」：
 * - 每处创建点认领离它最近的一处接线或豁免；
 * - 一处接线只能被一扇窗认领（两扇窗抢同一处 = 其中一扇其实没接 —— 这正是上一版「只比总数」会漏掉的情形：
 *   同文件另一头多写一处豁免，就能把这扇的漏接抵掉）；
 * - 距离上限 150 行：控制台的构造函数很长（最长的 whatsnew 创建到接线 89 行），但再远就是「接在别处」了。
 */
const MAX_LINES = 150;
function pairUp(text, sites, marks) {
  const lineOf = (pos) => text.slice(0, pos).split("\n").length;
  const taken = new Set();
  const orphans = [];
  for (const site of sites) {
    const line = lineOf(site.at);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < marks.length; i++) {
      if (taken.has(i)) continue;
      const d = Math.abs(lineOf(marks[i]) - line);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best < 0 || bestDist > MAX_LINES) orphans.push({ site, line, bestDist: Number.isFinite(bestDist) ? bestDist : null });
    else taken.add(best);
  }
  return orphans;
}

for (const f of files) {
  const sites = windowSites(f.code);
  if (!sites.length) continue;
  const marks = wiredMarks(f.code);
  const orphan = pairUp(f.code, sites, marks)[0];
  ok(
    !orphan,
    `${f.rel}：${sites.length} 个 window 创建点，各自就近（≤${MAX_LINES} 行、一对一）都有接线或豁免${orphan ? `（第 ${orphan.line} 行那扇没有：接一次 attachWindowGeom，或写 // dialog-geom: <理由>）` : ""}`,
  );
}

// ---------------------------------------------------------------- 自检：扫描器自己的坑，每个都有一条反证
{
  const sites = (t) => windowSites(t).length;
  ok(sites('const back = markSurface(el("div", "sheet-back"),\n  "window",\n  { enter: "alert" },\n);\n') === 1, "创建点把实参拆到多行，守卫也数得到");
  ok(sites('const back = markSurface(el("div", "x"), "window");\n') === 1, "单行的创建点数 1");
  ok(sites("this.overlay(back);\n") === 1, "不写材质的 overlay() 默认是 window");
  ok(sites('this.overlay(dialog.root, "paper");') === 0, "paper / dock 材质不算 window");
  ok(sites('markSurface(a, "menu");\nmarkSurface(b, "window");\nmarkSurface(c, "window");\n') === 2, "两次 window 调用就数两处");
  ok(sites('markSurface(a, "menu");\n' + "const unused = 1;\n".repeat(30) + 'tr("window");\n') === 0, "menu 调用后面隔着几十行才出现 \"window\" 字样，不算 window 创建点");
  ok(sites(' * 只在**创建处**调一次：`markSurface(el("div", "remind-pop"), "menu")`。\n') === 0, "注释里的示例不算创建点");
  ok(sites('markSurface(el("div", ")"),\n  "window"\n);\n') === 1, "实参字符串里的括号不参与配对");
  ok(sites('markSurface(el("div", `fail-toast${bad ? " bad" : ""}`), "window");') === 1, "模板串里的括号与引号不参与配对");
  ok(sites("markSurface(el('div', 'x'), 'window');") === 1, "单引号的材质也算");
  // 子调用 / 选项里先出现别的材质词：材质只认顶层，不然这扇 window 会被当成 menu（漏报）。
  ok(sites('markSurface(el("div", "menu-host"), "window");') === 1, "子调用里先出现 \"menu\" 不影响顶层材质是 window");
  ok(sites('markSurface(el("div", "x"), "window", { enter: "toast" });') === 1, "选项里出现 \"toast\" 不影响顶层材质是 window");
  ok(sites('markSurface(el("div", "window-host"), "menu");') === 0, "反过来：子调用里的 \"window\" 也不该把 menu 当成 window");
  ok(sites('markSurface(x, "menu"); // 这里只是注释里的 "window"\n') === 0, "行注释里的 \"window\" 不算材质");
  ok(sites('markSurface(x, "menu"); /* 块注释 "window" */\n') === 0, "块注释里的 \"window\" 不算材质");
  // 就近配对：同文件另一头多出来的接线，抵不掉这一处的漏接（上一版只比总数，就是这样漏过的）。
  const far = "attachWindowGeom(\"a\", {});\n" + "const unused = 1;\n".repeat(200) + 'markSurface(el("div", "b"), "window");\n';
  ok(pairUp(far, windowSites(far), wiredMarks(far)).length === 1, "同文件远处多一处接线，抵不掉近处这扇的漏接");
  // 两扇窗挨着、中间只有一处接线：只能被一扇认领，另一扇算没接。
  const two = 'markSurface(a, "window");\nattachWindowGeom("x", {});\nmarkSurface(b, "window");\n';
  ok(pairUp(two, windowSites(two), wiredMarks(two)).length === 1, "两扇窗抢同一处接线，其中一扇算没接");
  // 一扇窗、两处接线（真的多写了一行豁免）：不算错。
  const extra = 'markSurface(a, "window");\nattachWindowGeom("x", {});\n// dialog-geom: 多写的\n';
  ok(pairUp(extra, windowSites(extra), wiredMarks(extra)).length === 0, "多写一处接线不算错");
  // 剥注释：注释里的 attachWindowGeom( 不算接线（否则虚绿）。
  ok(wiredMarks(stripComments('// 例：attachWindowGeom("x", {})\n')).length === 0, "注释里的 attachWindowGeom( 不算接线（剥过注释之后）");
  ok(wiredMarks('// dialog-geom: 不装 —— 几行字\n').length === 1, "豁免标记算一处去处");
  // 标记本身在剥过注释的文本里要留下来。
  ok(stripComments('// dialog-geom: 不装\nconst a = 1; // 普通注释 attachWindowGeom(\n').includes("dialog-geom"), "剥注释时保留 dialog-geom 标记");
}

// ---------------------------------------------------------------- 4. 抓手真的存在，两个页面都拿得到
{
  /** 文件不在了报一条 FAIL 就好（守卫自己不该先崩）。 */
  const read = (rel) => {
    const p = path.join(SRC, rel);
    if (!fs.existsSync(p)) {
      fail(`${rel} 不存在：抓手样式搬走了？这一节跟着改`);
      return "";
    }
    return fs.readFileSync(p, "utf8");
  };
  const grip = read("wingrip.css");
  const css = read("styles.css");
  const peer = read("peer/peer.css");
  // 只问「规则在不在、是不是直接子元素」，不绑死 `:is(` 的书写形态。
  const padRule = /\.win-grip-panel\s*>[^{]*\{[^}]*--win-grip-foot-pad[^}]*\}/;
  ok(/\.win-grip\s*\{/.test(grip), "wingrip.css 里有 `.win-grip` 的样式");
  ok(/--win-grip-size\s*:/.test(grip), "抓手边长只有 `--win-grip-size` 一个来源");
  ok(padRule.test(css) && padRule.test(grip), "底栏给抓手让位那条在（主界面在 styles.css、内网通在 wingrip.css），而且是直接子元素");
  // 内网通页面只加载 peer.css：那里不 import 的话，选文件浮层上的抓手是个 0 尺寸、无定位的空 div。
  ok(/@import\s+["'][^"']*wingrip\.css["']/.test(peer), "peer.css 也 import 了 wingrip.css（内网通页面拿得到抓手样式）");
  ok(/@import\s+["'][^"']*wingrip\.css["']/.test(css), "styles.css import 了 wingrip.css");
  const allSrc = files.map((f) => f.raw).join("\n");
  ok(!/\.term-resize/.test(css) && !/\.term-resize/.test(allSrc), "旧类名 `.term-resize` 已并进 `.win-grip`");
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条未通过`);
process.exit(bad === 0 ? 0 : 1);

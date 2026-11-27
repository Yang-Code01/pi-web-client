/**
 * 守卫：带遮罩的窗口点遮罩**不关**（D434 / #721）。
 *
 * 以前几乎每扇 `window` 窗都自己写一句「点击目标就是遮罩 → 关掉」，约 50 处；鼠标点偏一下、手机上手指
 * 蹭到遮罩，填了一半的表单 / 选了一半的东西就整扇没了。现在遮罩上的点击统一由 `web/src/modal.ts`
 * 处理：默认不关、面板轻弹一下；确实要「点外面就关」的层（只有图片灯箱）在创建处
 * `markSurface(node, "window", { dismiss: close })` 显式声明。
 *
 * 这条守卫防的是「照老习惯又写了一句」：
 *  - 扫 `web/src/**​/*.ts`（含内网通页面 `web/src/peer/`），注释不算；
 *  - `x.target === NAME` / `x.target !== NAME` / `NAME === x.target`，NAME 的最后一段是遮罩类名字
 *    （`back` / `root` / `modal` / `wrap` / `layer` / `picker` / `scrim` …），或者是本文件里交给
 *    `markSurface(…, "window")` / `this.overlay(…)` 的那个变量，就算违规；
 *  - 豁免：同一行写 `// backdrop-ok: <理由>`（理由必填）。只给「不是窗口遮罩」的东西用，比如内网通
 *    看图器的舞台 —— 它就是灯箱。
 *
 * Run: node web/tests/backdrop-close-unit.mjs        （已挂在 `npm --prefix web run typecheck`）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/** 遮罩 / 窗口根常用的变量名（取 `this.back` 这类的最后一段比较）。 */
const BACKDROP_NAMES = new Set([
  "back",
  "root",
  "modal",
  "wrap",
  "layer",
  "opLayer",
  "picker",
  "scrim",
  "overlay",
  "mask",
  "backdrop",
  "shade",
  "veil",
  "stage",
]);
const EXEMPT = /\/\/\s*backdrop-ok:\s*\S/;

let bad = 0;
const fail = (msg) => {
  console.log(` FAIL ${msg}`);
  bad += 1;
};
const ok = (msg) => console.log(`  ok   ${msg}`);

/** 去掉块注释与行注释，保留换行（行号不变）。字符串里的 `//`（URL）可能被误删，只会少报、不会多报。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, pre) => pre);
}

/** 本文件里被当成窗口根挂出去的变量名。 */
function surfaceNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/(?:const|let|var|this\.)\s*(\w+)\s*=\s*markSurface\([^;]*?,\s*"window"/g)) {
    names.add(m[1]);
  }
  // app.ts 的 `this.overlay(node)` 不写第二个参数就是 window 档。
  for (const m of code.matchAll(/this\.overlay\(\s*(\w+)\s*(?:\)|,\s*"window")/g)) names.add(m[1]);
  return names;
}

const COMPARE = [
  /\.target\s*[!=]==\s*((?:this\.)?[\w.]+)/g,
  /((?:this\.)?[\w.]+)\s*[!=]==\s*\w+\.target\b/g,
];

/** 返回违规行：`[{ line, text }]`。 */
export function findBackdropClose(source) {
  const code = stripComments(source);
  const local = surfaceNames(code);
  const rawLines = source.split("\n");
  const lines = code.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (EXEMPT.test(rawLines[i] ?? "")) continue;
    for (const re of COMPARE) {
      re.lastIndex = 0;
      for (const m of lines[i].matchAll(re)) {
        const name = m[1].split(".").pop();
        if (name === "target" || name === "currentTarget") continue;
        if (BACKDROP_NAMES.has(name) || local.has(name)) {
          hits.push({ line: i + 1, text: rawLines[i].trim() });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------- 自检：判据本身不能静默失效

const POSITIVE = [
  `back.onclick = (ev) => { if (ev.target === back) this.closeSheet(); };`,
  `this.back.addEventListener("click", (ev) => { if (ev.target === this.back) this.close(); });`,
  `root.addEventListener("mousedown", (ev) => {\n  if (ev.target === root) this.close();\n});`,
  `modal.onclick = (ev) => {\n  if (ev.target !== modal) return;\n  this.closeModal();\n};`,
  `const box = markSurface(el("div", "x"), "window");\nbox.onclick = (e) => { if (e.target === box) done(null); };`,
  `if (ev.target === this.opLayer) this.closeOp();`,
];
const NEGATIVE = [
  `if (ev.target === input) return;`,
  `if (ev.target !== card) return; // let the buttons own their keys`,
  `if (menu.contains(ev.target as Node) || ev.target === anchor) return;`,
  `// if (ev.target === back) this.close();  ← 注释里的不算`,
  `if (d && !d.moved && ev.target === stage) opts.onClose(); // backdrop-ok: 看图器舞台就是灯箱`,
  `const pop = markSurface(el("div", "m"), "menu");\npop.onclick = (ev) => { if (ev.target === pop) close(); };`,
];
POSITIVE.forEach((src, i) => {
  if (findBackdropClose(src).length) ok(`自检 正例 ${i + 1} 被抓到`);
  else fail(`自检 正例 ${i + 1} 没抓到：${src.split("\n")[0]}`);
});
NEGATIVE.forEach((src, i) => {
  const h = findBackdropClose(src);
  if (h.length) fail(`自检 反例 ${i + 1} 被误报：${h[0].text}`);
  else ok(`自检 反例 ${i + 1} 放过`);
});

// ---------------------------------------------------------------- 扫源码

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts") && !/\.test\.ts$/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
if (!files.length) fail("web/src 下没找到 .ts —— 路径变了？");
let total = 0;
for (const file of files) {
  for (const h of findBackdropClose(fs.readFileSync(file, "utf8"))) {
    total += 1;
    fail(`${path.relative(ROOT, file).replaceAll("\\", "/")}:${h.line}  ${h.text}`);
  }
}
if (total) {
  console.log(
    `\n点遮罩不关（D434）：删掉这些判断，关闭只走 ✕ / 取消 / Esc。` +
      `\n确实要点外面就关（灯箱那类）：markSurface(node, "window", { dismiss: close })；不是窗口遮罩的比较在行尾写 // backdrop-ok: <理由>。`,
  );
} else ok(`扫了 ${files.length} 个 .ts，没有「点遮罩就关」的写法`);

if (bad) {
  console.log(`\n${bad} 处失败`);
  process.exit(1);
}
console.log("\nbackdrop-close: 全部通过");

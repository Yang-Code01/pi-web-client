/**
 * 守卫：弹层的 z-index 层带要单调，尤其是「从弹层里打开的子层必须压得住父层」。
 *
 * 这一条以前没人守，于是同一个系统里出现了两种相反的补救：
 *  - `web/src/app.ts` 里 `openPreview` 曾被「先 `closeSheet()` 再开预览」绕开（产物 / 技能商店 /
 *    更新日志三处），代价是父层被销毁、关掉预览就回不去那一页；
 *  - 而差分弹窗里的「在查看器里打开」没关父层，预览开在 sheet 背后 → 点了像没反应。
 * 根因是 `.viewer` 只有 46/47，永远在 `.sheet-back`(60) 之下。D308 给了 `.viewer.hi`(63)。
 *
 * 判据（全在 `web/src/*.css` 与 `web/src/settings-console.css` 里取真实声明）：
 *  1. `.viewer` < `.sheet-back`：普通浮窗仍然在底部面板之下，D111 的层带没被改坏；
 *  2. `.viewer.hi` > `.sheet-back`、`.sheet-sub-back`、`.st-back`：从面板里开的预览要压得住父层；
 *  3. `.modal.hi` > `.viewer.hi`：口令框 /「更新 pi」这类模态还得压在它上面（设置台里看文档就是这条路）；
 *  4. `.choose-back` > `.modal.hi`，`.image-view` > `.choose-back`：已有的两层不被新数字挤掉；
 *  5. `.viewer.hi.front` 与 `.viewer.hi` 一样高：`raiseWindow` 会给聚焦的窗加 `.front`(47)，
 *     两个类同时存在时不能被按回普通层带。
 *
 * Run: node web/tests/layers-unit.mjs        （已挂在 `npm --prefix web run typecheck`）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
/** 层带要从这两张表里读：主样式 + 设置台外壳（`.st-back` 在那儿）。 */
const FILES = ["styles.css", "settings-console.css"].map((f) => path.join(SRC, f));

let bad = 0;
const fail = (msg) => {
  console.log(` FAIL ${msg}`);
  bad += 1;
};
const ok = (msg) => console.log(`  ok   ${msg}`);

/** selector（原样、去掉多余空白） → z-index 数字。同一条选择器出现两次以最后一次为准（层叠）。 */
const z = new Map();
for (const file of FILES) {
  if (!fs.existsSync(file)) {
    fail(`缺文件：${path.relative(ROOT, file)}`);
    continue;
  }
  const css = fs.readFileSync(file, "utf8")
    // 注释先抹成空格（保留换行），否则选择器那一截会把注释原文一起吃进来。
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = /z-index:\s*(-?\d+)/.exec(m[2]);
    if (!value) continue;
    for (const sel of m[1].split(",")) {
      const key = sel.trim().replace(/\s+/g, " ");
      if (!key || key.startsWith("@")) continue;
      z.set(key, Number(value[1]));
    }
  }
}

const get = (sel) => {
  if (!z.has(sel)) {
    fail(`${sel} 没有 z-index 声明（选择器改了名？）`);
    return null;
  }
  return z.get(sel);
};

/** a 必须严格小于 b。 */
const below = (a, b) => {
  const za = get(a);
  const zb = get(b);
  if (za === null || zb === null) return;
  if (za < zb) ok(`${a}(${za}) < ${b}(${zb})`);
  else fail(`${a}(${za}) 必须低于 ${b}(${zb})`);
};
/** a 必须严格大于 b。 */
const above = (a, b) => {
  const za = get(a);
  const zb = get(b);
  if (za === null || zb === null) return;
  if (za > zb) ok(`${a}(${za}) > ${b}(${zb})`);
  else fail(`${a}(${za}) 必须高于 ${b}(${zb})`);
};
const same = (a, b) => {
  const za = get(a);
  const zb = get(b);
  if (za === null || zb === null) return;
  if (za === zb) ok(`${a}(${za}) = ${b}(${zb})`);
  else fail(`${a}(${za}) 必须和 ${b}(${zb}) 同高`);
};

// 1. 普通浮窗仍在面板之下（D111）
below(".viewer", ".sheet-back");
// 2. 从面板里打开的预览高于它的父层（D308）
above(".viewer.hi", ".sheet-back");
above(".viewer.hi", ".sheet-sub-back");
above(".viewer.hi", ".st-back");
// 3. 模态还要压得住它（口令框 / 更新 pi）
above(".modal.hi", ".viewer.hi");
// 4. 已有两层别被挤掉
above(".choose-back", ".modal.hi");
above(".image-view", ".choose-back");
// 5. `.front` 不会把 `.hi` 按回普通层带
same(".viewer.hi.front", ".viewer.hi");

if (bad) {
  console.log(`\nlayers: ${bad} 处不合格 —— 层带见 docs/DECISIONS.md D111 / D308`);
  process.exit(1);
}
console.log("\nlayers: ok —— 弹层层带单调，从弹层里打开的子层压得住父层");

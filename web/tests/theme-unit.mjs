/**
 * 主题的纯数据单测（`node --experimental-strip-types --test web/tests/theme-unit.mjs`）。
 *
 * 这里只碰 theme.ts / palette.ts 里不依赖 DOM 的那部分：id 表、浅底标记、强调色选表、终端配色、
 * 老偏好的迁移纯函数，以及「主题令牌文件里到底有哪几块」。配色本身的观感靠 probes/theme-switcher.mjs。
 *
 * 外观只有 Mac 风格三套（浅色 / 深色 / 午夜蓝，D353）：七套配色主题已删，六色强调色表与文字亮度
 * 三档一起退役；强调色自 D438 起多一维饱和度（鲜艳 / 柔和），两张柔和表也在这里守。
 * 删掉的东西在这里反过来断言「不许回来」—— 表里多一套、CSS 里多一块都会红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MAC_ACCENTS, MAC_ACCENTS_LIGHT } from "../src/palette.ts";
import {
  ACCENT_TONES,
  DEFAULT_ACCENT_TONE,
  DEFAULT_THEME,
  TERM_THEMES,
  THEMES,
  THEME_IDS,
  accentFor,
  accentInk,
  accentTable,
  isAccentTone,
  isTheme,
  migrateThemePrefs,
  themeInfo,
} from "../src/theme.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// 主题 token 从 styles.css 拆到了 theme-tokens.css（主界面与内网通页面共用，D350）。
const CSS = fs.readFileSync(path.join(REPO, "web/src/theme-tokens.css"), "utf8");
// 三套主题真正的 `--panel`（theme-tokens.css）：小样卡里的 demo.panel 是设置页样张的底，不是正文底。
// 从 CSS 里读，不手抄：主题改底色时这里的对比度守卫要跟着量新值，否则会在不知情的情况下量错。
function panelOf(themeId) {
  const selector = themeId === "mac-light" ? ":root" : `:root[data-theme="${themeId}"]`;
  const start = CSS.indexOf(`${selector} {`);
  assert.ok(start >= 0, `theme-tokens.css 里找不到 ${themeId} 的块`);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  const panel = CSS.slice(open + 1, close).match(/--panel:\s*(#[0-9a-f]{3,8})/i)?.[1];
  assert.ok(panel, `theme-tokens.css 里找不到 ${themeId} 的 --panel`);
  return panel;
}
const PANEL = Object.fromEntries(THEME_IDS.map((id) => [id, panelOf(id)]));

/** 粗略的相对亮度：只用来分「浅底 / 深底」，不是精确对比度。 */
function luma(hex) {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 相对对比度：只给柔和档的守卫用。 */
function contrast(a, b) {
  const [hi, lo] = [luma(a), luma(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("只剩三套 Mac 主题：id 表、信息表、显示名一一对应，不重名", () => {
  assert.deepEqual([...THEME_IDS], ["mac-light", "mac-dark", "mac-midnight"]);
  assert.equal(THEMES.length, THEME_IDS.length);
  assert.deepEqual(
    THEMES.map((t) => t.id),
    [...THEME_IDS],
    "THEMES 的顺序就是设置里小样的顺序",
  );
  const labels = THEMES.map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length, `显示名重了：${labels.join(" / ")}`);
  assert.equal(DEFAULT_THEME, "mac-light");
  assert.equal(themeInfo(DEFAULT_THEME).id, DEFAULT_THEME);
});

test("isTheme 只认这三套：删掉的七套配色主题、以及各种错值一律不认", () => {
  for (const id of THEME_IDS) assert.ok(isTheme(id));
  for (const gone of ["midnight", "daylight", "ember", "fjord", "light", "dusk", "paper"]) {
    assert.ok(!isTheme(gone), `旧配色主题 ${gone} 不该再被认作主题`);
  }
  for (const bad of ["", null, undefined, "night", "Dark", "mac-light ", 42, {}]) assert.ok(!isTheme(bad), `不该认：${bad}`);
});

test("themeInfo 遇到不认识的 id 回默认那套，不抛", () => {
  assert.equal(themeInfo("nope").id, DEFAULT_THEME);
});

test("light 标记跟配色一致：说浅底的，底比字亮", () => {
  for (const t of THEMES) {
    const bg = luma(t.demo.bg);
    const text = luma(t.demo.text);
    if (t.light) assert.ok(bg > text, `${t.id} 标了浅底，但底(${t.demo.bg})比字(${t.demo.text})还暗`);
    else assert.ok(bg < text, `${t.id} 是深底，字应该比底亮`);
  }
});

test("强调色统一走 macOS 八色表：浅底用亮色表，深底用深色表，不认识的回系统蓝", () => {
  for (const tone of ACCENT_TONES) {
    for (const t of THEMES) {
      const table = accentTable(t.id, tone);
      for (const id of Object.keys(MAC_ACCENTS)) assert.deepEqual(accentFor(t.id, id, tone), table[id], `${t.id} / ${tone} / ${id} 取错了表`);
      assert.deepEqual(accentFor(t.id, "chartreuse", tone), table.blue, `${t.id} / ${tone} 不认识的颜色应回系统蓝`);
      assert.deepEqual(accentFor(t.id, "ice", tone), table.blue, `${t.id} / ${tone} 删掉的六色 id 应回系统蓝`);
    }
  }
  assert.deepEqual(accentFor("nope", "purple", "vivid"), MAC_ACCENTS_LIGHT.purple, "不认识的主题按默认那套（Mac 浅色）算");
});

test("强调色底上的字：亮的换深字、深的留白字，不认识的颜色按系统蓝算", () => {
  // 深底那张表：黄 / 橙 / 绿够亮，要深字；蓝 / 紫 / 粉 / 红 / 石墨留白字。
  for (const bright of ["yellow", "orange", "green"]) assert.equal(accentInk("mac-dark", bright, "vivid"), "#1d1d1f", `mac-dark / ${bright}`);
  for (const deep of ["blue", "purple", "pink", "red", "graphite"]) assert.equal(accentInk("mac-dark", deep, "vivid"), "#ffffff", `mac-dark / ${deep}`);
  // 浅底那张表的黄已经压深（#a05a00），白字才读得清。
  assert.equal(accentInk("mac-light", "yellow", "vivid"), "#ffffff");
  assert.equal(accentInk("mac-light", "graphite", "vivid"), "#ffffff");
  // 柔和档两套表都压得够暗：没有一颗该换深字（D438）。
  for (const id of Object.keys(MAC_ACCENTS)) {
    assert.equal(accentInk("mac-dark", id, "muted"), "#ffffff", `mac-dark / muted / ${id} 该留白字`);
    assert.equal(accentInk("mac-light", id, "muted"), "#ffffff", `mac-light / muted / ${id} 该留白字`);
  }
  assert.equal(accentInk("mac-dark", "constructor", "vivid"), accentInk("mac-dark", "blue", "vivid"), "不认识的颜色按系统蓝算");
});

test("柔和档（D438）：正文对面板 ≥4.5，按钮字按明暗各守各的线", () => {
  for (const t of THEMES) {
    for (const id of Object.keys(MAC_ACCENTS)) {
      const c = accentFor(t.id, id, "muted");
      assert.ok(contrast(c.accent, PANEL[t.id]) >= 4.5, `${t.id} / ${id} 柔和色作正文对面板不够（${c.accent}）`);
      const ink = accentInk(t.id, id, "muted");
      // 浅色实底守 4.5；深色实底沿用现状的白字（约 3.4），这是 D438 里明说的取舍。
      const floor = ink === "#ffffff" && !t.light ? 3.4 : 4.5;
      assert.ok(contrast(c.accent, ink) >= floor, `${t.id} / ${id} 实底上的字对比不够（${c.accent} on ${ink}）`);
    }
  }
});

test("饱和度只认 vivid / muted，没存过或错值落鲜艳，迁移幂等", () => {
  assert.deepEqual([...ACCENT_TONES], ["vivid", "muted"]);
  assert.equal(DEFAULT_ACCENT_TONE, "vivid");
  assert.equal(migrateThemePrefs({}).accentTone, "vivid");
  assert.equal(migrateThemePrefs({ accentTone: "muted" }).accentTone, "muted");
  for (const bad of ["Muted", "soft", "", null, 42, {}]) assert.equal(migrateThemePrefs({ accentTone: bad }).accentTone, "vivid", `不该认：${bad}`);
  for (const ok of ["vivid", "muted"]) assert.ok(isAccentTone(ok));
  for (const bad of ["Muted", "soft", "", null, 42, {}]) assert.ok(!isAccentTone(bad), `不该认：${bad}`);
});

test("终端配色：三套都齐 16 色 + 底/字/选区，浅底主题的底确实比字亮", () => {
  const ANSI = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ];
  for (const t of THEMES) {
    const p = TERM_THEMES[t.id];
    assert.ok(p, `${t.id} 没有终端配色`);
    for (const key of ["background", "foreground", "selectionBackground", ...ANSI]) {
      assert.match(p[key] ?? "", /^#[0-9a-f]{6}$/i, `${t.id} 的 ${key} 不成样子：${p[key]}`);
    }
    const bg = luma(p.background);
    const fg = luma(p.foreground);
    if (t.light) assert.ok(bg > fg, `${t.id} 是浅底，终端却给了深底`);
    else assert.ok(bg < fg, `${t.id} 是深底，终端却给了浅底`);
    assert.notEqual(p.selectionBackground, p.background, `${t.id} 的选区色跟底一样，选中了看不出来`);
  }
  assert.deepEqual(Object.keys(TERM_THEMES).sort(), [...THEME_IDS].sort(), "终端配色表只该有三套");
});

test("主题令牌：兜底即 Mac 浅色，深色与午夜蓝各一块，浅色不再重复一份", () => {
  assert.ok(/:root\s*\{[^}]*--bg:\s*#f5f5f7/m.test(CSS), "CSS 兜底（:root）是 Mac 浅色");
  assert.ok(/:root\s*\{[^}]*color-scheme:\s*light/m.test(CSS), "兜底得声明浅色配色方案");
  for (const id of ["mac-dark", "mac-midnight"]) {
    assert.ok(CSS.includes(`:root[data-theme="${id}"] {`), `${id} 缺少主题块`);
    assert.ok(/color-scheme:\s*dark/.test(CSS.slice(CSS.indexOf(`:root[data-theme="${id}"] {`))), `${id} 缺少深色配色方案`);
  }
  assert.ok(!CSS.includes(':root[data-theme="mac-light"]'), "浅色令牌只该有一处（兜底就是它）");
});

test("删掉的东西不许回来：七套配色主题与文字亮度三档在令牌文件里都不留规则", () => {
  for (const gone of ["midnight", "daylight", "ember", "fjord", "light", "dusk", "paper"]) {
    assert.ok(!CSS.includes(`[data-theme="${gone}"]`), `旧主题 ${gone} 的令牌还留在 CSS 里`);
  }
  assert.ok(!/\[data-text=/.test(CSS), "文字亮度三档的覆盖规则还在");
});

test("老偏好迁移：主题按明暗与色相落进三套，强调色按最近色落进 macOS 八色", () => {
  const cases = [
    // 蓝黑底那两套落午夜蓝；中性 / 暖深底落 Mac 深色；三套浅底落 Mac 浅色。
    ["midnight", "mac-midnight"],
    ["dusk", "mac-midnight"],
    ["fjord", "mac-dark"],
    ["ember", "mac-dark"],
    ["daylight", "mac-light"],
    ["light", "mac-light"],
    ["paper", "mac-light"],
  ];
  for (const [from, to] of cases) {
    assert.equal(migrateThemePrefs({ theme: from }).theme, to, `${from} 该落到 ${to}`);
  }
  const accents = [
    ["ice", "blue"],
    ["teal", "green"],
    ["violet", "purple"],
    ["amber", "yellow"],
    ["rose", "pink"],
    ["slate", "graphite"],
  ];
  for (const [from, to] of accents) {
    // 只有「存的主题是旧配色主题」时才搬强调色 —— 这里用旧主题当上下文。
    const out = migrateThemePrefs({ theme: "fjord", accent: from });
    assert.equal(out.macAccent, to, `旧强调色 ${from} 该落 ${to}`);
  }
});

test("迁移不碰已选 Mac 主题的人：主题原样、强调色原样", () => {
  for (const id of THEME_IDS) {
    assert.deepEqual(migrateThemePrefs({ theme: id, accent: "teal", macAccent: "pink" }), { theme: id, macAccent: "pink", accentTone: "vivid" }, `${id} 被改了`);
  }
});

test("D337 之前的偏好没有 theme 键：那时生效的 accent 照样要搬过去", () => {
  assert.deepEqual(migrateThemePrefs({ accent: "teal" }), { theme: DEFAULT_THEME, macAccent: "green", accentTone: "vivid" });
  assert.deepEqual(migrateThemePrefs({ scale: 1.25 }), { theme: DEFAULT_THEME, macAccent: "blue", accentTone: "vivid" });
});

test("迁移不认原型链上的名字：constructor / toString 这类值一律落默认", () => {
  assert.deepEqual(migrateThemePrefs({ theme: "constructor" }), { theme: DEFAULT_THEME, macAccent: "blue", accentTone: "vivid" });
  assert.deepEqual(migrateThemePrefs({ theme: "mac-dark", macAccent: "toString" }), { theme: "mac-dark", macAccent: "blue", accentTone: "vivid" });
  assert.deepEqual(migrateThemePrefs({ theme: "fjord", accent: "hasOwnProperty" }), { theme: "mac-dark", macAccent: "blue", accentTone: "vivid" });
  assert.deepEqual(accentFor("mac-dark", "constructor", "vivid"), MAC_ACCENTS.blue);
});

test("迁移对错值落默认，且幂等（迁过一次再迁不会再变）", () => {
  assert.deepEqual(migrateThemePrefs({}), { theme: DEFAULT_THEME, macAccent: "blue", accentTone: "vivid" });
  assert.deepEqual(migrateThemePrefs({ theme: "nope", accent: "chartreuse", macAccent: "nope" }), { theme: DEFAULT_THEME, macAccent: "blue", accentTone: "vivid" });
  const once = migrateThemePrefs({ theme: "dusk", accent: "teal" });
  assert.deepEqual(migrateThemePrefs(once), once, "已经是新值了，第二次迁移不该再动");
});

// ---------------------------------------------------------------- 材质由标记驱动（#644）
// 以前材质靠 mac.css 里四张手抄的类名名单（遮罩 / 窗口 / 菜单 / 吐司）：每加一个面板都要记得去补名字，
// 漏了就静默退回纯色板（D352 漏过一次、D389 又漏了四个）。现在由浮层自己在创建处打
// `data-mac-surface`，CSS 只认这个属性。下面这组断言守的是「名单不许回来」与「每个创建点都打了标记」。
const MAC_CSS = fs.readFileSync(path.join(REPO, "web/src/mac.css"), "utf8");

/** 曾经写在名单里的外壳类名。它们现在只允许作为「这一面自己的覆盖」出现，不许再被批量列进 :is()。 */
const OLD_SHELLS = [
  "st-back", "sheet-back", "sys-back", "jc-back", "mc-back", "jira-ask-back", "jira-picker", "sheet-sub-back",
  "choose-back", "peer-pick", "image-view", "st-console", "sys-console", "jc-console", "mc-console", "mc-confirm",
  "argdialog-panel", "jira-ask", "peer-pick-panel", "branch-sheet", "repos-sheet", "jira-picker-box",
  "ctx-menu", "pin-menu", "perm-menu", "term-menu", "fail-menu", "go-cmp-menu", "mk-menu", "ws-pop", "act-pop",
  "complete-pop", "jira-user-pop", "jira-handoff-pop", "skill-panel", "turn-note", "pin-note", "fail-toast", "update-bar",
];

test("材质级由标记驱动：mac.css 只认 data-mac-surface，四张手抄名单不许回来", () => {
  const kinds = new Set([...MAC_CSS.matchAll(/data-mac-surface="([a-z]+)"/g)].map((m) => m[1]));
  for (const k of ["window", "menu", "toast", "dock"]) {
    assert.ok(kinds.has(k), `mac.css 里没有 [data-mac-surface="${k}"] —— 材质级少了这一档`);
  }
  // 名单的判据：:is(...) 的参数里同时列了两个以上旧外壳类名。单条覆盖（.viewer、.notes-sheet）不算。
  const offenders = [];
  for (const m of MAC_CSS.matchAll(/:is\(([^)]*)\)/g)) {
    const hit = OLD_SHELLS.filter((c) => new RegExp(`\\.${c}(?![\\w-])`).test(m[1]));
    if (hit.length >= 2) offenders.push(hit.join(", "));
  }
  assert.deepEqual(offenders, [], `mac.css 里还有手抄的外壳名单：${offenders.join(" / ")}`);
});

test("材质级的取值表两侧一致：TS 的联合类型与 CSS 选择器用的是同一组值", async () => {
  const { SURFACE_KINDS } = await import("../src/modal.ts");
  // `paper` 故意没有 CSS 规则（它就是「不套材质」），所以 CSS 侧是四个材质级。
  const css = new Set([...MAC_CSS.matchAll(/data-mac-surface="([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...css].sort(), ["dock", "menu", "toast", "window"], "CSS 侧的材质级变了");
  assert.deepEqual([...SURFACE_KINDS].sort(), ["dock", "menu", "paper", "toast", "window"], "TS 侧的材质级变了");
  assert.match(MAC_CSS, /paper[^\n]*不套材质/, "mac.css 里要写明 paper 是「故意不套材质」的那一档");
});

test("每个浮层创建点都打了标记，且打的是这一面该有的材质级（换错档就红）", () => {
  // 逐**创建点**断言（不是逐文件）：把 remind-pop 和 remind-toast 的材质级互换，下面当场红。
  // 表外的模块由探针的全局扫描兜（页面上不许有裸浮层）。
  const MARKED = [
    ["web/src/reminders.ts", "remind-pop", "menu"],
    ["web/src/reminders.ts", "remind-toast", "toast"],
    ["web/src/notesheet.ts", "note-handoff", "menu"],
    ["web/src/notesheet.ts", "peer-pick", "window"],
    ["web/src/pinmenu.ts", "pin-menu", "menu"],
    ["web/src/pluginmarket.ts", "mk-menu", "menu"],
    ["web/src/jira.ts", "jira-handoff-pop", "menu"],
    ["web/src/jira.ts", "jira-user-pop", "menu"],
    ["web/src/branchsheet.ts", "go-cmp-menu", "menu"],
    ["web/src/app.ts", "ctx-menu", "menu"],
    ["web/src/app.ts", "ws-pop", "menu"],
    ["web/src/app.ts", "skill-panel", "menu"],
    ["web/src/app.ts", "update-bar", "toast"],
    ["web/src/app.ts", "fail-toast", "toast"],
    ["web/src/app.ts", "ws-tab-rename-input", "paper"],
  ];
  for (const [rel, cls, kind] of MARKED) {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    const re = new RegExp(`markSurface\\([^;]{0,200}?${cls}[^;]{0,160}?"${kind}"`);
    assert.match(src, re, `${rel} 里的 ${cls} 没有打上 "${kind}" — 材质级换了或这行被删了`);
  }
  // 走 app.overlay() 收口的那几档（sheet 走默认的 window，不在这里逐条列）。
  const app = fs.readFileSync(path.join(REPO, "web/src/app.ts"), "utf8");
  for (const kind of ["dock", "paper"]) {
    assert.match(app, new RegExp(`overlay\\([^;]{0,80}?"${kind}"`), `app.ts 里没有 overlay(…, "${kind}")`);
  }
  assert.match(app, /overlay\([^;]{0,80}"window", \{ dim: "dark"[^}]*\}/, "灯箱没有走 window + dim=dark");
});

test("浮层一律挂进 #app：笔记的两个浮层不再往 body 上塞", () => {
  const src = fs.readFileSync(path.join(REPO, "web/src/notesheet.ts"), "utf8");
  assert.ok(!/document\.body\.append/.test(src), "notesheet.ts 还在往 body 上挂浮层 —— 它们不会跟着字号缩放");
});

/**
 * 主题的纯数据单测（`node --experimental-strip-types --test web/tests/theme-unit.mjs`）。
 *
 * 这里只碰 theme.ts / palette.ts 里不依赖 DOM 的那部分：id 表、浅底标记、强调色选表、终端配色、
 * 老偏好的迁移纯函数，以及「主题令牌文件里到底有哪几块」。配色本身的观感靠 probes/theme-switcher.mjs。
 *
 * 外观只有 Mac 风格三套（浅色 / 深色 / 午夜蓝，D353）：七套配色主题已删，六色强调色表与文字亮度
 * 三档一起退役。删掉的东西在这里反过来断言「不许回来」—— 表里多一套、CSS 里多一块都会红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MAC_ACCENTS, MAC_ACCENTS_LIGHT } from "../src/palette.ts";
import {
  DEFAULT_THEME,
  TERM_THEMES,
  THEMES,
  THEME_IDS,
  accentFor,
  accentInk,
  isTheme,
  migrateThemePrefs,
  themeInfo,
} from "../src/theme.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// 主题 token 从 styles.css 拆到了 theme-tokens.css（主界面与内网通页面共用，D350）。
const CSS = fs.readFileSync(path.join(REPO, "web/src/theme-tokens.css"), "utf8");

/** 粗略的相对亮度：只用来分「浅底 / 深底」，不是精确对比度。 */
function luma(hex) {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
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
  for (const t of THEMES) {
    const table = t.light ? MAC_ACCENTS_LIGHT : MAC_ACCENTS;
    for (const id of Object.keys(MAC_ACCENTS)) assert.deepEqual(accentFor(t.id, id), table[id], `${t.id} / ${id} 取错了表`);
    assert.deepEqual(accentFor(t.id, "chartreuse"), table.blue, `${t.id} 不认识的颜色应回系统蓝`);
    assert.deepEqual(accentFor(t.id, "ice"), table.blue, `${t.id} 删掉的六色 id 应回系统蓝`);
  }
  assert.deepEqual(accentFor("nope", "purple"), MAC_ACCENTS_LIGHT.purple, "不认识的主题按默认那套（Mac 浅色）算");
});

test("强调色底上的字：亮的换深字、深的留白字，不认识的颜色按系统蓝算", () => {
  // 深底那张表：黄 / 橙 / 绿够亮，要深字；蓝 / 紫 / 粉 / 红 / 石墨留白字。
  for (const bright of ["yellow", "orange", "green"]) assert.equal(accentInk("mac-dark", bright), "#1d1d1f", `mac-dark / ${bright}`);
  for (const deep of ["blue", "purple", "pink", "red", "graphite"]) assert.equal(accentInk("mac-dark", deep), "#ffffff", `mac-dark / ${deep}`);
  // 浅底那张表的黄已经压深（#a05a00），白字才读得清。
  assert.equal(accentInk("mac-light", "yellow"), "#ffffff");
  assert.equal(accentInk("mac-light", "graphite"), "#ffffff");
  assert.equal(accentInk("mac-dark", "constructor"), accentInk("mac-dark", "blue"), "不认识的颜色按系统蓝算");
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
    assert.deepEqual(migrateThemePrefs({ theme: id, accent: "teal", macAccent: "pink" }), { theme: id, macAccent: "pink" }, `${id} 被改了`);
  }
});

test("D337 之前的偏好没有 theme 键：那时生效的 accent 照样要搬过去", () => {
  assert.deepEqual(migrateThemePrefs({ accent: "teal" }), { theme: DEFAULT_THEME, macAccent: "green" });
  assert.deepEqual(migrateThemePrefs({ scale: 1.25 }), { theme: DEFAULT_THEME, macAccent: "blue" });
});

test("迁移不认原型链上的名字：constructor / toString 这类值一律落默认", () => {
  assert.deepEqual(migrateThemePrefs({ theme: "constructor" }), { theme: DEFAULT_THEME, macAccent: "blue" });
  assert.deepEqual(migrateThemePrefs({ theme: "mac-dark", macAccent: "toString" }), { theme: "mac-dark", macAccent: "blue" });
  assert.deepEqual(migrateThemePrefs({ theme: "fjord", accent: "hasOwnProperty" }), { theme: "mac-dark", macAccent: "blue" });
  assert.deepEqual(accentFor("mac-dark", "constructor"), MAC_ACCENTS.blue);
});

test("迁移对错值落默认，且幂等（迁过一次再迁不会再变）", () => {
  assert.deepEqual(migrateThemePrefs({}), { theme: DEFAULT_THEME, macAccent: "blue" });
  assert.deepEqual(migrateThemePrefs({ theme: "nope", accent: "chartreuse", macAccent: "nope" }), { theme: DEFAULT_THEME, macAccent: "blue" });
  const once = migrateThemePrefs({ theme: "dusk", accent: "teal" });
  assert.deepEqual(migrateThemePrefs(once), once, "已经是新值了，第二次迁移不该再动");
});

/**
 * 主题的纯数据单测（`node --experimental-strip-types --test web/tests/theme-unit.mjs`）。
 *
 * 这里只碰 theme.ts / palette.ts 里不依赖 DOM 的那部分：id 表、浅底标记、强调色选表、
 * 终端配色，以及「每套主题在 styles.css 里真有那一块」。配色本身的观感靠 probes/theme-switcher.mjs。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACCENTS, ACCENTS_LIGHT } from "../src/palette.ts";
import {
  DEFAULT_THEME,
  TERM_THEMES,
  THEMES,
  THEME_IDS,
  accentFor,
  isTheme,
  themeInfo,
} from "../src/theme.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CSS = fs.readFileSync(path.join(REPO, "web/src/styles.css"), "utf8");

/** 粗略的相对亮度：只用来分「浅底 / 深底」，不是精确对比度。 */
function luma(hex) {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

test("七套主题：id 表、信息表、显示名一一对应，不重名", () => {
  assert.deepEqual([...THEME_IDS], ["midnight", "daylight", "ember", "fjord", "light", "dusk", "paper"]);
  assert.equal(THEMES.length, THEME_IDS.length);
  assert.deepEqual(
    THEMES.map((t) => t.id),
    [...THEME_IDS],
    "THEMES 的顺序就是设置里小样的顺序",
  );
  const labels = THEMES.map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length, `显示名重了：${labels.join(" / ")}`);
  assert.equal(DEFAULT_THEME, "midnight");
  assert.equal(themeInfo(DEFAULT_THEME).id, DEFAULT_THEME);
});

test("isTheme 只认表里的 id，别的（包括老版本可能存过的名字）一律不认", () => {
  for (const id of THEME_IDS) assert.ok(isTheme(id));
  for (const bad of ["", null, undefined, "night", "Dark", "midnight ", 42, {}]) assert.ok(!isTheme(bad), `不该认：${bad}`);
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

test("强调色选表：浅底用 ACCENTS_LIGHT，深底用 ACCENTS，不认识的 accent 回 ice", () => {
  for (const t of THEMES) {
    const table = t.light ? ACCENTS_LIGHT : ACCENTS;
    for (const id of Object.keys(ACCENTS)) {
      assert.deepEqual(accentFor(t.id, id), table[id], `${t.id} / ${id} 取错了表`);
    }
    assert.deepEqual(accentFor(t.id, "chartreuse"), table.ice);
  }
  assert.deepEqual(accentFor("nope", "ice"), ACCENTS.ice, "不认识的主题按默认那套（深底）算");
});

test("终端配色：每套主题都齐 16 色 + 底/字/选区，浅底主题的底确实比字亮", () => {
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
});

test("每套主题在 styles.css 里都有自己那一块（midnight 落在 :root 上，不另写）", () => {
  for (const t of THEMES) {
    if (t.id === DEFAULT_THEME) {
      assert.ok(/:root\s*\{[^}]*--bg:\s*#0b0d10/m.test(CSS), "默认那套应该就是 :root");
      continue;
    }
    assert.ok(CSS.includes(`:root[data-theme="${t.id}"] {`), `${t.id} 缺少主题块`);
    assert.ok(CSS.includes(`:root[data-theme="${t.id}"][data-text="soft"]`), `${t.id} 缺少「柔和」文字档`);
    assert.ok(CSS.includes(`:root[data-theme="${t.id}"][data-text="bright"]`), `${t.id} 缺少「明亮」文字档`);
  }
});

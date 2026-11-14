/**
 * 单元格样式（D167）：把 `xl/styles.xml` 的 numFmt / fonts / fills / borders / cellXfs
 * 与 `xl/theme/theme1.xml` 的主题色，合成前端能直接贴的一张样式表。
 *
 * 为什么要它：D166 那版只认「数字格式 + 横向对齐」，字体、底色、边框、自动换行、
 * 文件里写的行高全丢了，所以真文件的表格看起来像纯文本。这里按 Excel 的模型完整解析，
 * 颜色按 theme+tint / indexed / rgb 三种写法归一成 `#RRGGBB`，边框按边给 CSS 简写，
 * 前端只管贴（不在浏览器里重算规则）。
 *
 * 表结构：`codes[i]` 是 cellXfs[i] 的数字格式代码（服务端格式化数字用），
 * `index[i]` 是 cellXfs[i] 去重后的样式下标，`styles` 就是那份去重表。
 */
import { attr } from "./xml.ts";
import { formatCode } from "./numfmt.ts";

/** 字体：名称 / 字号（pt）/ 粗 / 斜 / 下划线 / 删除线 / 颜色。 */
export interface WireFont {
  n?: string;
  s?: number;
  b?: 1;
  i?: 1;
  u?: 1;
  st?: 1;
  c?: string;
}

/** 一条边的 CSS 简写（`1px solid #D9D9D9`）：算出样式是桥端的事，前端只贴。 */
export interface WireBorders {
  t?: string;
  r?: string;
  b?: string;
  l?: string;
}

/** 一条格子的样式：只有跟默认值不一样的部分才带，空对象就是默认样式。 */
export interface WireStyle {
  f?: WireFont;
  /** 填充底色。 */
  bg?: string;
  bd?: WireBorders;
  /** 水平对齐：l 左 / c 中 / r 右 / j 两端。常规（数字右、文本左）不带。 */
  h?: "l" | "c" | "r" | "j";
  /** 垂直对齐：默认 b（Excel 的「靠下」）。 */
  v?: "t" | "m" | "b";
  /** 自动换行。 */
  w?: 1;
  /** 缩进（字符数）。 */
  ind?: number;
  /** 缩小字体填充。 */
  sh?: 1;
  /** 文字旋转（度，整数）：只认 0/90/180/270 这类整档。 */
  rot?: number;
}

export interface StyleTable {
  /** 按 cellXfs 下标：数字格式代码；没格式就是 null。 */
  codes: (string | null)[];
  /** 按 cellXfs 下标：去重后的样式下标。 */
  index: number[];
  /** 去重后的样式表，`styles[0]` 是默认样式（空对象）。 */
  styles: WireStyle[];
}

/** 老式索引色（ECMA-376 §18.8.27）。只到 63；64 是「自动」。 */
const INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

/** 主题色槽位顺序（Excel 的 `theme="N"` 指这个数组）。 */
const THEME_SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/** `#RRGGBB` → 按 Excel 的 tint 算法调亮/调暗（在 HLS 的亮度上做）。 */
export function tint(rgb: string, t: number): string {
  if (!t) return rgb;
  const n = parseInt(rgb.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (x: number): number => {
    // HLS → RGB，色相绕回 [0,1]。
    let u = x;
    if (u < 0) u += 1;
    else if (u > 1) u -= 1;
    let v: number;
    if (u < 1 / 6) v = p + (q - p) * 6 * u;
    else if (u < 1 / 2) v = q;
    else if (u < 2 / 3) v = p + (q - p) * (2 / 3 - u) * 6;
    else v = p;
    return Math.round(v * 255);
  };
  return `#${[ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** 主题色板：`theme1.xml` 的 clrScheme，按 THEME_SLOTS 顺序给 `#RRGGBB`。 */
export function readTheme(xml: string | null): string[] {
  if (!xml) return [];
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0] ?? "";
  const out: string[] = [];
  for (const slot of THEME_SLOTS) {
    const block = new RegExp(`<a:${slot}>([\\s\\S]*?)</a:${slot}>`).exec(scheme)?.[1] ?? "";
    // 常规色写在 srgbClr 的 val 上，系统色（黑/白）写在 sysClr 的 lastClr 上。
    let hex = "";
    for (const cand of [attr(block, "val"), attr(block, "lastClr")]) {
      if (hex) break;
      if (cand && /^[0-9a-fA-F]{6}$/.test(cand)) hex = cand;
    }
    out.push(hex ? `#${hex.toUpperCase()}` : "");
  }
  return out;
}

const H_ALIGN: Record<string, "l" | "c" | "r" | "j"> = { left: "l", center: "c", right: "r", justify: "j" };

/** 一个 `<color>` 标签 → `#RRGGBB`；认不出（auto / 越界 theme）返回 null，交给默认色。 */
function colorOf(tag: string | undefined, theme: string[]): string | null {
  if (!tag) return null;
  const rgb = attr(tag, "rgb");
  if (rgb && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(rgb)) return `#${(rgb.length === 8 ? rgb.slice(2) : rgb).toUpperCase()}`;
  const idx = attr(tag, "indexed");
  if (idx !== null && /^\d+$/.test(idx)) {
    // 64 及以后是「自动 / 系统色」，别自作主张。
    return idx === "64" || idx === "65" ? null : `#${INDEXED[Number(idx)] ?? "000000"}`;
  }
  const th = attr(tag, "theme");
  if (th !== null && /^\d+$/.test(th)) {
    const base = theme[Number(th)];
    if (!base) return null;
    const t = Number(attr(tag, "tint") ?? "0");
    return tint(base, Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0);
  }
  return null;
}

/** 边框线型 → CSS 的 `宽 线型`；认不出就按细实线。 */
function edgeCss(style: string, color: string | null): string {
  const c = color ?? "#000000";
  switch (style) {
    case "medium":
      return `2px solid ${c}`;
    case "thick":
      return `3px solid ${c}`;
    case "double":
      return `3px double ${c}`;
    case "dashed":
    case "mediumDashed":
    case "dashDot":
    case "mediumDashDot":
    case "dashDotDot":
    case "mediumDashDotDot":
    case "slantDashDot":
      return `1px dashed ${c}`;
    case "dotted":
    case "hair":
      return `1px dotted ${c}`;
    default:
      return `1px solid ${c}`;
  }
}

interface RawFont {
  name?: string;
  size?: number;
  b: boolean;
  i: boolean;
  u: boolean;
  st: boolean;
  color: string | null;
}

function readFonts(xml: string, theme: string[]): RawFont[] {
  const block = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)?.[1] ?? "";
  const out: RawFont[] = [];
  for (const m of block.matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)) {
    const body = m[1] ?? "";
    const name = attr(/<name\b[^>]*\/?>/.exec(body)?.[0] ?? "", "val") ?? undefined;
    const sz = Number(attr(/<sz\b[^>]*\/?>/.exec(body)?.[0] ?? "", "val") ?? "11");
    const flag = (tag: string): boolean => {
      const t = new RegExp(`<${tag}\\b[^>]*/?>`).exec(body)?.[0];
      if (!t) return false;
      const v = attr(t, "val");
      return v === null || !/^(0|false)$/i.test(v);
    };
    out.push({
      ...(name ? { name } : {}),
      size: Number.isFinite(sz) && sz > 0 ? sz : 11,
      b: flag("b"),
      i: flag("i"),
      u: flag("u"),
      st: flag("strike"),
      color: colorOf(/<color\b[^>]*\/?>/.exec(body)?.[0], theme),
    });
  }
  return out;
}

function readFills(xml: string, theme: string[]): (string | null)[] {
  const block = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? "";
  const out: (string | null)[] = [];
  for (const m of block.matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/g)) {
    const body = m[1] ?? "";
    const pattern = /<patternFill\b([^>]*)>([\s\S]*?)<\/patternFill>/.exec(body);
    const kind = attr(pattern?.[1] ?? "", "patternType") ?? "";
    if (!pattern || kind === "none" || kind === "gray125" || kind === "") {
      out.push(null);
      continue;
    }
    const inner = pattern[2] ?? "";
    const fg = colorOf(/<fgColor\b[^>]*\/?>/.exec(inner)?.[0], theme);
    const bg = colorOf(/<bgColor\b[^>]*\/?>/.exec(inner)?.[0], theme);
    // 纯色填充：Excel 把颜色写在 fgColor 上；花纹填充只在超过 50% 密度的花纹上才算「看得出底色」。
    if (kind === "solid") out.push(fg ?? bg);
    else out.push(fg && /^(dark|medium)/i.test(kind) ? fg : bg ?? fg);
  }
  return out;
}

type Side = "left" | "right" | "top" | "bottom";

function readBorders(xml: string, theme: string[]): WireBorders[] {
  const block = /<borders\b[^>]*>([\s\S]*?)<\/borders>/.exec(xml)?.[1] ?? "";
  const out: WireBorders[] = [];
  for (const m of block.matchAll(/<border\b[^>]*?(?:\/>|>([\s\S]*?)<\/border>)/g)) {
    const body = m[1] ?? "";
    const bd: WireBorders = {};
    for (const side of ["top", "right", "bottom", "left"] as Side[]) {
      const el = new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`).exec(body);
      const style = attr(el?.[1] ?? "", "style");
      if (!el || !style) continue;
      bd[side[0] as "t" | "r" | "b" | "l"] = edgeCss(style, colorOf(/<color\b[^>]*\/?>/.exec(el[2] ?? "")?.[0], theme));
    }
    out.push(bd);
  }
  return out;
}

/**
 * 解析整份样式表。`styles.xml` 缺失时给一份只有默认样式的表（xlsx 里样式是可选的）。
 * 同一个样式被上千个 cellXfs 重复引用很常见，这里按序列化结果去重，前端只收一张小表。
 */
export function readStyles(stylesXml: string | null, themeXml: string | null): StyleTable {
  const theme = readTheme(themeXml);
  const defaults: StyleTable = { codes: [null], index: [0], styles: [{}] };
  if (!stylesXml) return defaults;
  const xml = stylesXml;

  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = attr(m[0], "formatCode");
    if (Number.isFinite(id) && code) custom.set(id, code);
  }
  const fonts = readFonts(xml, theme);
  const fills = readFills(xml, theme);
  const borders = readBorders(xml, theme);

  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const codes: (string | null)[] = [];
  const index: number[] = [];
  // 0 号永远是「默认样式」：这样格子不带 `s` 就等于默认，前提不被文件里的 xf[0] 抢走。
  const styles: WireStyle[] = [{}];
  const seen = new Map<string, number>([[JSON.stringify({}), 0]]);
  for (const m of block.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const numId = Number(attr(attrs, "numFmtId") ?? "0");
    codes.push(Number.isFinite(numId) ? formatCode(numId, custom) : null);

    const style: WireStyle = {};
    const font = fonts[Number(attr(attrs, "fontId") ?? "")];
    if (font) {
      const f: WireFont = {};
      if (font.name && font.name !== "Calibri") f.n = font.name;
      if (font.size && font.size !== 11) f.s = font.size;
      if (font.b) f.b = 1;
      if (font.i) f.i = 1;
      if (font.u) f.u = 1;
      if (font.st) f.st = 1;
      if (font.color) f.c = font.color;
      if (Object.keys(f).length) style.f = f;
    }
    const fill = fills[Number(attr(attrs, "fillId") ?? "")];
    if (fill) style.bg = fill;
    const bd = borders[Number(attr(attrs, "borderId") ?? "")];
    if (bd && (bd.t || bd.r || bd.b || bd.l)) style.bd = bd;

    const align = /<alignment\b[^>]*\/?>/.exec(inner)?.[0];
    if (align) {
      const h = H_ALIGN[attr(align, "horizontal") ?? ""];
      if (h) style.h = h;
      const v = attr(align, "vertical");
      if (v === "top") style.v = "t";
      else if (v === "center") style.v = "m";
      else if (v === "bottom") style.v = "b";
      if (/^(1|true)$/i.test(attr(align, "wrapText") ?? "")) style.w = 1;
      if (/^(1|true)$/i.test(attr(align, "shrinkToFit") ?? "")) style.sh = 1;
      const ind = Number(attr(align, "indent") ?? "0");
      if (Number.isFinite(ind) && ind > 0) style.ind = Math.min(15, Math.round(ind));
      const rot = Number(attr(align, "textRotation") ?? "0");
      if (Number.isFinite(rot) && rot > 0 && rot <= 180 && rot % 90 === 0) style.rot = rot;
    }

    const key = JSON.stringify(style);
    let at = seen.get(key);
    if (at === undefined) {
      at = styles.length;
      styles.push(style);
      seen.set(key, at);
    }
    index.push(at);
  }
  if (!styles.length) return defaults;
  return { codes, index, styles };
}

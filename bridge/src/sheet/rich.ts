/**
 * #436 富文本片段：一个共享字符串里可以有多个 `<r>`，每段带自己的字体。
 *
 * Excel 里「一个格子两种颜色/粗细」就是这么存的：`<si><r><rPr>…</rPr><t>前半</t></r><r>…`.
 * 我们平时只取拼起来的整串（复制、查找、编辑都用它），这里额外把分段与各自的字体读出来，
 * 渲染时按段画。没有 `<r>` 的字符串不在这里出现（调用方按普通文本处理）。
 */
import type { WireFont } from "./styles.ts";

export interface WireRun {
  t: string;
  f?: WireFont;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** `<rPr>` → 我们那套字体（只认直接写死的 rgb，主题色交给外层样式）。 */
function runFont(rPr: string): WireFont | undefined {
  if (!rPr) return undefined;
  const f: WireFont = {};
  const name = attrOf(/<rFont\b[^>]*>/.exec(rPr)?.[0] ?? "", "val");
  if (name) f.n = unescapeXml(name);
  const size = attrOf(/<sz\b[^>]*>/.exec(rPr)?.[0] ?? "", "val");
  if (size && Number(size) > 0) f.s = Number(size);
  // `<b/>` 是开，`<b val="0"/>` 是关。
  if (/<b\b(?![^>]*val="(?:0|false)")[^>]*\/?>/.test(rPr)) f.b = 1;
  if (/<i\b(?![^>]*val="(?:0|false)")[^>]*\/?>/.test(rPr)) f.i = 1;
  if (/<u\b(?![^>]*val="none")[^>]*\/?>/.test(rPr)) f.u = 1;
  if (/<strike\b(?![^>]*val="(?:0|false)")[^>]*\/?>/.test(rPr)) f.st = 1;
  const rgb = attrOf(/<color\b[^>]*>/.exec(rPr)?.[0] ?? "", "rgb");
  if (rgb && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(rgb)) f.c = `#${rgb.slice(-6).toUpperCase()}`;
  return Object.keys(f).length ? f : undefined;
}

/** 共享字符串表里所有「分段的」串：下标 → 片段数组。 */
export function readRichRuns(xml: string): Map<number, WireRun[]> {
  const out = new Map<number, WireRun[]>();
  if (!xml) return out;
  let index = 0;
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const body = (si[1] ?? "").replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "");
    const runs: WireRun[] = [];
    for (const r of body.matchAll(/<r\b[^>]*>([\s\S]*?)<\/r\b>/g)) {
      const inner = r[1] ?? "";
      const rPr = /<rPr\b[^>]*>([\s\S]*?)<\/rPr>/.exec(inner)?.[1] ?? "";
      const parts: string[] = [];
      for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) parts.push(unescapeXml(t[1] ?? ""));
      const text = parts.join("");
      if (!text) continue;
      const f = runFont(rPr);
      runs.push(f ? { t: text, f } : { t: text });
    }
    if (runs.length) out.set(index, runs);
    index++;
  }
  return out;
}

import { unzipSync } from "fflate";

/**
 * xlsx 里 exceljs 不肯给我们的那几样东西（D116）。
 *
 * exceljs 能读值、样式、合并、条件格式，但它**不读图表**，也不解析主题色/索引色（它把
 * `{theme:4,tint:0.4}` 原样丢回来）。所以这些都必须自己从 zip 里那几支小 xml 里挖：
 * `xl/theme/theme1.xml`（调色板）、`xl/workbook.xml` + rels（sheet 名 → 第几个 part）、
 * `xl/drawings/*.xml`（图表锚点）。
 *
 * 只解这几支小文件，不碰 worksheets —— 一份表几 MB，这几支加起来通常几十 KB。
 */

export type Palette = { theme: string[]; indexed: string[] };

/** OOXML 的 `theme` 索引顺序与 clrScheme 的书写顺序不同：0=lt1(背景),1=dk1(文字),2=lt2,3=dk2,4..9=accent。 */
const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/** Excel 的默认索引调色板（indexed="0".."63"），legacy 文件里常用。 */
const INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
].map((h) => `#${h}`);

const FALLBACK_THEME = [
  "#FFFFFF", "#000000", "#EEECE1", "#1F497D", "#4F81BD", "#C0504D", "#9BBB59", "#8064A2",
  "#4BACC6", "#F79646", "#0000FF", "#800080",
];

function tag(xml: string, name: string, from = 0): { body: string; at: number } | null {
  const open = xml.indexOf(`<${name}`, from);
  if (open < 0) return null;
  const close = xml.indexOf(`</${name}>`, open);
  const gt = xml.indexOf(">", open);
  if (gt < 0) return null;
  const selfClose = xml[gt - 1] === "/";
  if (selfClose) return { body: "", at: gt + 1 };
  if (close < 0) return { body: xml.slice(gt + 1), at: xml.length };
  return { body: xml.slice(gt + 1, close), at: close + name.length + 3 };
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");

/** `<a:srgbClr val="4472C4"/>` 或 `<a:sysClr lastClr="FFFFFF"/>`。 */
function schemeColor(inner: string): string {
  const srgb = /<a:srgbClr[^>]*val="([0-9A-Fa-f]{6})"/.exec(inner);
  if (srgb) return `#${srgb[1].toUpperCase()}`;
  const sys = /<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(inner);
  if (sys) return `#${sys[1].toUpperCase()}`;
  return "";
}

export function readPalette(zip: Record<string, Uint8Array>): Palette {
  const theme = [...FALLBACK_THEME];
  const raw = zip["xl/theme/theme1.xml"];
  if (raw) {
    const xml = new TextDecoder().decode(raw);
    const scheme = tag(xml, "a:clrScheme");
    if (scheme) {
      for (let i = 0; i < THEME_ORDER.length; i++) {
        const slot = tag(scheme.body, `a:${THEME_ORDER[i]}`);
        if (!slot) continue;
        const hex = schemeColor(slot.body);
        if (hex) theme[i] = hex;
      }
    }
  }
  return { theme, indexed: INDEXED };
}

/** theme + tint 或 indexed → `#RRGGBB`。认不出来就返回 null，交给上层用默认色。 */
export function resolveColor(color: any, pal: Palette): string | null {
  if (!color) return null;
  if (typeof color === "string") return color.startsWith("#") ? color.toUpperCase() : `#${color.slice(-6).toUpperCase()}`;
  if (color.argb) {
    const hex = String(color.argb).slice(-6).toUpperCase();
    return `#${hex}`;
  }
  if (typeof color.theme === "number") {
    const base = pal.theme[color.theme] ?? "#000000";
    return applyTint(base, Number(color.tint) || 0);
  }
  if (typeof color.indexed === "number") {
    const i = color.indexed;
    if (i === 64) return "#000000";
    if (i === 65) return "#FFFFFF";
    if (i >= 0 && i < pal.indexed.length) return applyTint(pal.indexed[i], Number(color.tint) || 0);
  }
  return null;
}

/** Excel 的 tint：正数往白里掺，负数往黑里压。 */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const n = parseInt(hex.replace("#", ""), 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = tint > 0 ? v + (255 - v) * tint : v * (1 + tint);
    return Math.max(0, Math.min(255, Math.round(x)));
  });
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const RELS = (part: string): string => {
  const at = part.lastIndexOf("/");
  return `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`;
};

export interface SheetPart {
  name: string;
  part: string;
}

/** sheet 名 → `xl/worksheets/sheetN.xml`。靠 `xl/_rels/workbook.xml.rels` 的 rId 对上。 */
export function sheetParts(zip: Record<string, Uint8Array>): SheetPart[] {
  const wb = zip["xl/workbook.xml"];
  const rels = zip["xl/_rels/workbook.xml.rels"];
  if (!wb || !rels) return [];
  const targets = new Map<string, string>();
  const relXml = new TextDecoder().decode(rels);
  for (const m of relXml.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) {
    let t = m[2];
    if (t.startsWith("/")) t = t.slice(1);
    else t = `xl/${t}`.replace(/\/\.\//g, "/");
    targets.set(m[1], t);
  }
  const out: SheetPart[] = [];
  const xml = new TextDecoder().decode(wb);
  for (const m of xml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (!name || !rid) continue;
    const part = targets.get(rid);
    if (part) out.push({ name: unescapeXml(name), part });
  }
  return out;
}

export interface ChartBox {
  /** 0-based 单元格坐标，右下角是开区间之外的那一格（Excel 的 to 语义）。 */
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  kind: string;
}

const CHART_KINDS = ["barChart", "bar3DChart", "lineChart", "line3DChart", "pieChart", "pie3DChart", "doughnutChart", "areaChart", "area3DChart", "scatterChart", "bubbleChart", "radarChart", "stockChart", "surfaceChart", "surface3DChart", "ofPieChart"];

function relTargets(relsXml: string, basePart: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = basePart.slice(0, basePart.lastIndexOf("/"));
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    let t = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (!id || !t) continue;
    if (!t.startsWith("/")) {
      // 相对 drawing 的路径：../charts/chart1.xml
      const segs = `${dir}/${t}`.split("/");
      const stack: string[] = [];
      for (const s of segs) {
        if (s === "..") stack.pop();
        else if (s !== ".") stack.push(s);
      }
      t = stack.join("/");
    } else t = t.slice(1);
    out.set(id, t);
  }
  return out;
}

/**
 * 一张 sheet 上的图表占位框。exceljs 读不到图表（`ws.model` 里根本没有），只能自己走
 * sheet xml → `<drawing r:id>` → drawing rels → drawing xml 的 anchor。
 * 单格锚点（oneCellAnchor）只有尺寸没有终点，按列宽/行高粗算成格子范围。
 */
export function chartBoxes(zip: Record<string, Uint8Array>, sheetPart: string): ChartBox[] {
  const sheetXml = zip[sheetPart] ? new TextDecoder().decode(zip[sheetPart]) : "";
  if (!sheetXml) return [];
  const drewId = /<drawing\b[^>]*r:id="([^"]+)"/.exec(sheetXml)?.[1];
  if (!drewId) return [];
  const sheetRels = relTargets(zip[RELS(sheetPart)] ? new TextDecoder().decode(zip[RELS(sheetPart)]) : "", sheetPart);
  const drawingPart = sheetRels.get(drewId);
  if (!drawingPart || !zip[drawingPart]) return [];
  const drawingXml = new TextDecoder().decode(zip[drawingPart]);
  const drawRels = relTargets(zip[RELS(drawingPart)] ? new TextDecoder().decode(zip[RELS(drawingPart)]) : "", drawingPart);
  const out: ChartBox[] = [];
  const anchorRe = /<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g;
  for (const m of drawingXml.matchAll(anchorRe)) {
    const body = m[2];
    const from = tag(body, "xdr:from");
    if (!from) continue;
    const r1 = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(from.body)?.[1] ?? 0);
    const c1 = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(from.body)?.[1] ?? 0);
    let r2 = r1 + 15;
    let c2 = c1 + 8;
    const to = tag(body, "xdr:to");
    if (to) {
      r2 = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(to.body)?.[1] ?? r2);
      c2 = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(to.body)?.[1] ?? c2);
    } else {
      const ext = tag(body, "xdr:ext");
      const cx = Number(/cx="(\d+)"/.exec(ext?.body ?? "")?.[1] ?? 0);
      const cy = Number(/cy="(\d+)"/.exec(ext?.body ?? "")?.[1] ?? 0);
      if (cx && cy) {
        c2 = c1 + Math.max(2, Math.round(cx / 9525 / 64));
        r2 = r1 + Math.max(4, Math.round(cy / 9525 / 20));
      }
    }
    let kind = "chart";
    const rid = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(body)?.[1];
    const chartPart = rid ? drawRels.get(rid) : undefined;
    if (chartPart && zip[chartPart]) {
      const chartXml = new TextDecoder().decode(zip[chartPart]);
      const plot = tag(chartXml, "c:plotArea");
      const area = plot?.body ?? chartXml;
      for (const k of CHART_KINDS) {
        if (area.includes(`<c:${k}`)) {
          kind = k.replace(/Chart$/, "").replace(/3D$/, "");
          break;
        }
      }
    }
    out.push({ r1, c1, r2, c2, kind });
  }
  return out;
}

export function isEncrypted(buf: Buffer): boolean {
  // 加密的 xlsx 是 OLE 复合文档（D0CF11E0），不是 zip。
  return buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
}

/** 只解需要的那几支；zip 读失败（加密 / 坏文件）返回 null。 */
export function readZipParts(buf: Buffer, only?: (name: string) => boolean): Record<string, Uint8Array> | null {
  try {
    return unzipSync(new Uint8Array(buf), only ? { filter: (f) => only(f.name) } : undefined);
  } catch {
    return null;
  }
}

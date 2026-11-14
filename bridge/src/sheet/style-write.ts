/**
 * 样式补丁（#433）：把「加粗 / 填充色 / 对齐 / 数字格式」这类改动写进 `xl/styles.xml`。
 *
 * 做法是**克隆**：拿格子原来的 `xf`、它指的 `font` / `fill`，复制一份改掉要改的属性，
 * 再按字符串去重塞回表里，最后把格子的 `s` 指向新的 `xf`。原表里的样式一个都不动，
 * 所以别的格子、别的表、条件格式都不受影响（Excel 自己也是这么做的）。
 *
 * 只认这几个开关：加粗/斜体/下划线、字号、字色、填充色、水平/垂直对齐、自动换行、
 * 内置数字格式 id。不碰边框、字体名、主题色、富文本 run。
 */

export type EdgeStyle = "thin" | "medium" | "thick" | "double" | "dashed" | "dotted" | "none";

/** 四边描边：`none` = 擦掉那条线，`undefined` = 不动。 */
export interface BorderPatch {
  t?: EdgeStyle;
  r?: EdgeStyle;
  b?: EdgeStyle;
  l?: EdgeStyle;
}

export interface CellStylePatch {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** 字体名（写在 `<name val="…"/>` 上）。 */
  fn?: string;
  /** 四边描边。 */
  bd?: BorderPatch;
  /** 字号（pt）。 */
  fs?: number;
  /** 字色 `#RRGGBB`。 */
  fc?: string;
  /** 填充色 `#RRGGBB`；null = 清成无填充。 */
  bg?: string | null;
  h?: "l" | "c" | "r" | null;
  v?: "t" | "m" | "b" | null;
  w?: boolean;
  /** 内置数字格式 id（0 常规 / 2 0.00 / 3 #,##0 / 4 #,##0.00 / 9 0% / 10 0.00% / 14 日期）。 */
  nf?: number;
}

const ARGB = /^[0-9a-fA-F]{6}$/;

function argb(color: string | null | undefined): string | null {
  if (!color) return null;
  const hex = color.replace(/^#/, "");
  return ARGB.test(hex) ? `FF${hex.toUpperCase()}` : null;
}

function entries(inner: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g");
  return [...inner.matchAll(re)].map((m) => m[0]);
}

function innerOf(entry: string, tag: string): string {
  const open = new RegExp(`^<${tag}\\b[^>]*?/?>`).exec(entry);
  if (!open) return "";
  const body = entry.slice(open[0].length);
  return body.endsWith(`</${tag}>`) ? body.slice(0, -`</${tag}>`.length) : "";
}

function wrap(tag: string, inner: string): string {
  return inner ? `<${tag}>${inner}</${tag}>` : `<${tag}/>`;
}

/** 确保字体里有 / 没有 `<b/>`、`<i/>`、`<u/>`。 */
function toggle(inner: string, tag: "b" | "i" | "u", on: boolean | undefined): string {
  if (on === undefined) return inner;
  const re = new RegExp(`<${tag}\\b[^>]*/>`, "g");
  const cleaned = inner.replace(re, "");
  if (!on) return cleaned;
  return `<${tag}/>${cleaned}`;
}

function setChild(inner: string, tag: string, piece: string | null): string {
  const re = new RegExp(`<${tag}\\b[^>]*/>`, "g");
  const cleaned = inner.replace(re, "");
  return piece ? piece + cleaned : cleaned;
}

const SIDES = { t: "top", r: "right", b: "bottom", l: "left" } as const;

function edgePiece(side: string, style: EdgeStyle): string {
  return style === "none" ? `<${side}/>` : `<${side} style="${style}"><color rgb="FF000000"/></${side}>`;
}

/** 重排一条 `<border>`：左/右/上/下按补丁换，剩下的（diagonal 等）原样留着。 */
function rebuildBorder(entry: string, patch: BorderPatch): string {
  const inner = innerOf(entry, "border");
  const find = (side: string): string => {
    const re = new RegExp(`<${side}\\b[^>]*/>|<${side}\\b[^>]*>[\\s\\S]*?</${side}>`);
    return re.exec(inner)?.[0] ?? `<${side}/>`;
  };
  const parts: string[] = [];
  for (const key of ["t", "r", "b", "l"] as const) {
    const side = SIDES[key];
    const want = patch[key];
    parts.push(want === undefined ? find(side) : edgePiece(side, want));
  }
  const diagonal = /<diagonal\b[^>]*\/>|<diagonal\b[^>]*>[\s\S]*?<\/diagonal>/.exec(inner)?.[0];
  return `<border>${parts.join("")}${diagonal ?? ""}</border>`;
}

function setAttr(tag: string, name: string, value: string | null): string {
  const m = new RegExp(`^(<\\w+)([^>]*?)(/?>)$`).exec(tag);
  if (!m) return tag;
  let attrs = m[2].replace(new RegExp(`\\s+${name}="[^"]*"`), "");
  if (value !== null) attrs += ` ${name}="${value}"`;
  return `${m[1]}${attrs}${m[3]}`;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

interface Section {
  tag: string;
  open: string;
  close: string;
  start: number;
  end: number;
  items: string[];
}

export class StyleBook {
  private fonts: string[];
  private fills: string[];
  private borders: string[];
  private xfs: string[];
  private sections: Section[] = [];
  private xml: string | null;
  private dirty = false;

  private constructor(xml: string | null) {
    this.xml = xml;
    this.fonts = [];
    this.fills = [];
    this.borders = [];
    this.xfs = [];
    if (!xml) return;
    for (const tag of ["fonts", "fills", "borders", "cellXfs"] as const) {
      const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`);
      const m = re.exec(xml);
      if (!m) continue;
      const innerTag = tag === "cellXfs" ? "xf" : tag.slice(0, -1);
      const items = entries(m[2], innerTag);
      this.sections.push({ tag, open: m[0].slice(0, m[0].indexOf(">") + 1), close: `</${tag}>`, start: m.index, end: m.index + m[0].length, items });
      if (tag === "fonts") this.fonts = items;
      else if (tag === "fills") this.fills = items;
      else if (tag === "borders") this.borders = items;
      else this.xfs = items;
    }
  }

  static read(xml: string | null): StyleBook {
    return new StyleBook(xml);
  }

  get changed(): boolean {
    return this.dirty;
  }

  /** 按补丁给「原来的 xf 下标」算一个新的 xf 下标。 */
  alloc(base: number, patch: CellStylePatch): number {
    const baseXf = this.xfs[base] ?? this.xfs[0] ?? `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
    let fontId = Number(attr(baseXf, "fontId") ?? 0) || 0;
    let fillId = Number(attr(baseXf, "fillId") ?? 0) || 0;
    let numFmtId = Number(attr(baseXf, "numFmtId") ?? 0) || 0;
    let borderId = Number(attr(baseXf, "borderId") ?? 0) || 0;
    let open = baseXf.slice(0, baseXf.indexOf(">") + 1);
    const body = baseXf.slice(open.length);
    const childInner = body.endsWith("</xf>") ? body.slice(0, -"</xf>".length) : "";
    let align = /<alignment\b[^>]*\/>/.exec(childInner)?.[0] ?? null;

    // 字体：克隆原字体再改开关 / 字号 / 字色。
    if (patch.b !== undefined || patch.i !== undefined || patch.u !== undefined || patch.fs !== undefined || patch.fc !== undefined || patch.fn !== undefined) {
      let inner = innerOf(this.fonts[fontId] ?? "<font/>", "font");
      inner = toggle(inner, "b", patch.b);
      inner = toggle(inner, "i", patch.i);
      inner = toggle(inner, "u", patch.u);
      if (patch.fs !== undefined && Number.isFinite(patch.fs)) {
        const pt = Math.max(1, Math.min(409, Math.round(patch.fs * 2) / 2));
        inner = setChild(inner, "sz", `<sz val="${pt}"/>`);
      }
      if (patch.fc) {
        const color = argb(patch.fc);
        if (color) inner = setChild(inner, "color", `<color rgb="${color}"/>`);
      }
      if (patch.fn) inner = setChild(inner, "name", `<name val="${patch.fn.replace(/[<>&"']/g, "")}"/>`);
      if (!inner.includes("<name")) inner += '<name val="Calibri"/>';
      fontId = this.pushFont(wrap("font", inner));
      open = setAttr(open, "applyFont", "1");
    }

    // 填充：整条换掉（只做 solid / none）。
    if (patch.bg !== undefined) {
      const color = argb(patch.bg);
      fillId = this.pushFill(
        color
          ? `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`
          : `<fill><patternFill patternType="none"/></fill>`,
      );
      open = setAttr(open, "applyFill", "1");
    }

    if (patch.bd) {
      let borderId0 = Number(attr(baseXf, "borderId") ?? 0) || 0;
      const base = this.borders[borderId0] ?? "<border><left/><right/><top/><bottom/><diagonal/></border>";
      const at = this.borders.indexOf(rebuildBorder(base, patch.bd));
      if (at >= 0) borderId0 = at;
      else {
        this.borders.push(rebuildBorder(base, patch.bd));
        this.dirty = true;
        borderId0 = this.borders.length - 1;
      }
      borderId = borderId0;
      open = setAttr(open, "applyBorder", "1");
    }

    if (patch.nf !== undefined && Number.isFinite(patch.nf)) {
      numFmtId = Math.max(0, Math.round(patch.nf));
      open = setAttr(open, "applyNumberFormat", "1");
    }

    if (patch.h !== undefined || patch.v !== undefined || patch.w !== undefined) {
      if (
        patch.h !== undefined ||
        patch.v !== undefined ||
        patch.w !== undefined
      ) {
        let tag = align ?? "<alignment/>";
        if (patch.h !== undefined) {
          tag = setAttr(tag, "horizontal", patch.h === null ? null : patch.h === "l" ? "left" : patch.h === "c" ? "center" : "right");
        }
        if (patch.v !== undefined) {
          tag = setAttr(tag, "vertical", patch.v === null ? null : patch.v === "t" ? "top" : patch.v === "m" ? "center" : "bottom");
        }
        if (patch.w !== undefined) tag = setAttr(tag, "wrapText", patch.w ? "1" : null);
        const bare = tag.replace(/\s+/g, " ").replace(/>$/, "");
        align = /\b(horizontal|vertical|wrapText)=/.test(bare) ? tag : null;
        open = setAttr(open, "applyAlignment", "1");
      }
    }

    open = setAttr(setAttr(setAttr(setAttr(open, "fontId", String(fontId)), "fillId", String(fillId)), "numFmtId", String(numFmtId)), "borderId", String(borderId));
    const xf = align ? `${open}${align}</xf>` : `${open.replace(/>$/, "/>")}`;
    return this.pushXf(xf);
  }

  private pushFont(entry: string): number {
    const at = this.fonts.indexOf(entry);
    if (at >= 0) return at;
    this.fonts.push(entry);
    this.dirty = true;
    return this.fonts.length - 1;
  }

  private pushFill(entry: string): number {
    const at = this.fills.indexOf(entry);
    if (at >= 0) return at;
    this.fills.push(entry);
    this.dirty = true;
    return this.fills.length - 1;
  }

  private pushXf(entry: string): number {
    const at = this.xfs.indexOf(entry);
    if (at >= 0) return at;
    this.xfs.push(entry);
    this.dirty = true;
    return this.xfs.length - 1;
  }

  /** 把表写回 XML（没动过就原样返回）。 */
  toXml(): string {
    if (!this.xml || !this.dirty) return this.xml ?? "";
    let out = this.xml;
    for (const section of [...this.sections].sort((a, b) => b.start - a.start)) {
      const items =
        section.tag === "fonts" ? this.fonts : section.tag === "fills" ? this.fills : section.tag === "borders" ? this.borders : this.xfs;
      const open = setAttr(section.open, "count", String(items.length));
      out = out.slice(0, section.start) + open + items.join("") + section.close + out.slice(section.end);
    }
    return out;
  }
}

/**
 * xlsx 里的图片（#427 补记）：`xl/drawings/drawingN.xml` 里的格子锚点 + `xl/media/*` 字节。
 *
 * 只认「锚在格子上」的两种：`twoCellAnchor`（左上/右下都在格子上，尺寸随行列走）与
 * `oneCellAnchor`（左上格 + 固定 ext 尺寸）。图表（graphicFrame）、形状、组合里的图
 * 一律跳过——那些不是「文件里的图片」这个语义。EMU 一步到位换成 CSS px（9525 EMU = 1px，96dpi）。
 */
import { entryBytes, type ZipEntry } from "./zip.ts";
import { attr, unescapeXml } from "./xml.ts";

const dec = new TextDecoder("utf-8");
/** 1 px = 9525 EMU（96 dpi）。 */
const EMU_PX = 9525;
/** 一张表最多认这么多张图：防病态文件把 meta 撑爆。 */
const MAX_IMAGES = 400;

export interface WireImage {
  /** zip 内路径（`xl/media/image3.png`）：前端拿它换字节，也是浏览器的缓存键。 */
  id: string;
  /** 左上：哪一列/行，格内偏移多少 px。 */
  c0: number;
  r0: number;
  ox: number;
  oy: number;
  /** 两格锚点的右下（一格锚点没有，尺寸看 w/h）。 */
  c1?: number;
  r1?: number;
  ox1?: number;
  oy1?: number;
  /** 一格锚点的固定尺寸（px）。 */
  w?: number;
  h?: number;
}

/** 浏览器画得了的才算：wmf/emf 是矢量图元文件，塞进 <img> 只会是裂图。 */
const OK_EXT = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

function text(buf: Uint8Array, dir: Map<string, ZipEntry>, name: string): string {
  const entry = dir.get(name);
  if (!entry) return "";
  // 图片部件可能很大，但 drawing/rels 都是几 KB 的 XML；这里只解 XML。
  return dec.decode(entryBytes(buf, entry));
}

/** `xl/worksheets/sheet1.xml` → `xl/worksheets/_rels/sheet1.xml.rels`。 */
function relsOf(part: string): string {
  const at = part.lastIndexOf("/");
  return `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`;
}

/** 把 `Target="../../media/image1.png"`（相对 drawing 的目录）解成 zip 里的规范路径。 */
function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") base.pop();
    else if (seg !== ".") base.push(seg);
  }
  return base.join("/");
}

/** rels 文件 → rId 到目标部件的表。 */
function relsMap(fromPart: string, xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) out.set(id, resolvePart(fromPart, target));
  }
  return out;
}

/** `<xdr:from>` / `<xdr:to>` 里的格子坐标。 */
interface Anchor {
  c: number;
  r: number;
  ox: number;
  oy: number;
}

function anchorOf(block: string, tag: "from" | "to"): Anchor | null {
  const body = new RegExp(`<xdr:${tag}\\b[^>]*>([\\s\\S]*?)</xdr:${tag}>`).exec(block)?.[1];
  if (!body) return null;
  const num = (name: string): number => {
    const v = new RegExp(`<xdr:${name}>\\s*(-?\\d+)\\s*</xdr:${name}>`).exec(body)?.[1];
    return v === undefined ? 0 : Number(v);
  };
  const c = num("col");
  const r = num("row");
  if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
  return { c, r, ox: num("colOff") / EMU_PX, oy: num("rowOff") / EMU_PX };
}

/**
 * 读一张表的图片。`sheetPart` 是 `xl/worksheets/sheetN.xml`。
 * 认不出 drawing 或 media 时返回空数组——图片缺失不该让整张表打不开。
 */
export function readSheetImages(buf: Uint8Array, dir: Map<string, ZipEntry>, sheetPart: string): WireImage[] {
  const sheetRels = relsMap(sheetPart, text(buf, dir, relsOf(sheetPart)));
  const out: WireImage[] = [];
  for (const drawingPart of sheetRels.values()) {
    if (!/^xl\/drawings\/[^/]+\.xml$/.test(drawingPart)) continue;
    const xml = text(buf, dir, drawingPart);
    if (!xml) continue;
    const media = relsMap(drawingPart, text(buf, dir, relsOf(drawingPart)));
    for (const m of xml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g)) {
      if (out.length >= MAX_IMAGES) return out;
      const block = m[2] ?? "";
      const embed = /<a:blip\b[^>]*\br:embed\s*=\s*"([^"]+)"/.exec(block)?.[1];
      if (!embed) continue; // graphicFrame（图表/表格）没有 blip
      const id = media.get(unescapeXml(embed));
      if (!id || !OK_EXT.test(id) || !dir.has(id)) continue;
      const from = anchorOf(block, "from");
      if (!from) continue;
      const base = { id, c0: from.c, r0: from.r, ox: from.ox, oy: from.oy };
      if (m[1] === "twoCellAnchor") {
        const to = anchorOf(block, "to");
        if (!to) continue;
        out.push({ ...base, c1: to.c, r1: to.r, ox1: to.ox, oy1: to.oy });
        continue;
      }
      // 一格锚点：尺寸在 <xdr:ext cx cy>，跟列宽无关。
      const ext = /<xdr:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(block);
      if (!ext) continue;
      const w = Number(ext[1]) / EMU_PX;
      const h = Number(ext[2]) / EMU_PX;
      if (!(w > 0 && h > 0)) continue;
      out.push({ ...base, w, h });
    }
  }
  return out;
}

/** 图片部件 → content-type。只给上面 OK_EXT 认过的这几种。 */
export function imageType(part: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(part)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

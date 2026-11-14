/**
 * #435 单元格上的两样「附件」：超链接与批注。
 *
 * 两者都不在 `<sheetData>` 里：超链接是 `<hyperlinks>` 一串 `<hyperlink ref="A1" r:id="rId3"/>`，
 * 目标是 `sheetN.xml.rels` 里的外部地址（或 `location` 的页内跳转）；批注是单独一个
 * `xl/comments1.xml`，靠同一份 rels 找到。这里只读不写——改超链接/批注不是预览该干的事。
 */
import { attrOf } from "./write.ts";
import { entryBytes, type ZipEntry } from "./zip.ts";

export interface SheetRefs {
  /** `"r:c"` → 链接地址（外部 http(s)/mailto，或 `#表!A1` 这种页内）。 */
  links: Map<string, string>;
  /** `"r:c"` → 批注正文（多段拼成一行）。 */
  notes: Map<string, string>;
}

function text(buf: Uint8Array, dir: Map<string, ZipEntry>, name: string): string {
  const entry = dir.get(name);
  if (!entry) return "";
  try {
    return new TextDecoder("utf-8").decode(entryBytes(buf, entry));
  } catch {
    return "";
  }
}

/** 只看 `<t>` 里的字，段落之间留一个空格。 */
function plain(xml: string): string {
  const out: string[] = [];
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out.push(m[1] ?? "");
  return out
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把 `../comments1.xml` 这种相对路径按 sheet part 的目录归一。 */
function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segs = fromPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") segs.pop();
    else if (seg !== ".") segs.push(seg);
  }
  return segs.join("/");
}

function relsOf(part: string): string {
  return part.replace(/([^/]+)$/, "_rels/$1.rels");
}

export function readSheetRefs(buf: Uint8Array, dir: Map<string, ZipEntry>, sheetPart: string): SheetRefs {
  const links = new Map<string, string>();
  const notes = new Map<string, string>();
  const relsXml = text(buf, dir, relsOf(sheetPart));
  const byId = new Map<string, { type: string; target: string }>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const a = m[1] ?? "";
    const id = attrOf(`<r ${a}`, "Id");
    const type = attrOf(`<r ${a}`, "Type") ?? "";
    const target = attrOf(`<r ${a}`, "Target") ?? "";
    if (id) byId.set(id, { type, target });
  }

  const sheetXml = text(buf, dir, sheetPart);
  for (const m of sheetXml.matchAll(/<hyperlink\b([^>]*?)\/?>/g)) {
    const a = m[1] ?? "";
    const ref = attrOf(`<h ${a}`, "ref");
    if (!ref) continue;
    const rid = attrOf(`<h ${a}`, "r:id");
    const loc = attrOf(`<h ${a}`, "location");
    const rel = rid ? byId.get(rid) : null;
    const url = rel?.target ? rel.target : loc ? `#${loc}` : "";
    if (!url) continue;
    // 一个 ref 可能是 "A1:B3"：整块都算链接。
    const box = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(ref.trim().toUpperCase());
    if (!box) continue;
    const idx = (n: string): number => {
      let v = 0;
      for (const ch of n) v = v * 26 + (ch.charCodeAt(0) - 64);
      return v - 1;
    };
    const c0 = idx(box[1] ?? "A");
    const r0 = Number(box[2]) - 1;
    const c1 = box[3] ? idx(box[3]) : c0;
    const r1 = box[4] ? Number(box[4]) - 1 : r0;
    for (let r = r0; r <= r1 && r < r0 + 2000; r++) for (let c = c0; c <= c1 && c < c0 + 200; c++) links.set(`${r}:${c}`, url);
  }

  const commentsRel = [...byId.values()].find((v) => /\/comments$/i.test(v.type));
  if (commentsRel) {
    const xml = text(buf, dir, resolvePart(sheetPart, commentsRel.target));
    for (const m of xml.matchAll(/<comment\b([^>]*?)>([\s\S]*?)<\/comment>/g)) {
      const ref = attrOf(`<c ${m[1] ?? ""}`, "ref");
      if (!ref) continue;
      const box = /^([A-Z]{1,3})(\d+)$/.exec(ref.trim().toUpperCase());
      if (!box) continue;
      let v = 0;
      for (const ch of box[1] ?? "") v = v * 26 + (ch.charCodeAt(0) - 64);
      const body = plain(m[2] ?? "");
      if (body) notes.set(`${Number(box[2]) - 1}:${v - 1}`, body);
    }
  }
  return { links, notes };
}

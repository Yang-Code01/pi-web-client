/**
 * #436 数据验证（`<dataValidations>`）：预览里最有用的是「从列表里选」。
 *
 * 文件里的写法有两种：`<formula1>"是,否,待定"</formula1>` 直接写死，或者
 * `<formula1>$E$2:$E$20</formula1>` 指向本表/别的表的一块区域。前者直接拆，
 * 后者在 `readBook` 里用同一份 sheet XML 把值读出来（只读一次，跟 meta 一起发）。
 * 其它类型（整数/小数/日期/文本长度/自定义）先只记下规则，用来在格子角上标「不合法」。
 */
export interface WireValid {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  /** 只认 list 的下拉；其它类型给 `null`，前端只用来画提示。 */
  options?: string[];
  /** `list` / `whole` / `decimal` / `date` / `textLength` / `custom` / `any`… */
  kind: string;
  /** 出错提示（文件里写的那句）。 */
  prompt?: string;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** `A1:C3` / `A1` → 行列盒；不认识的返回 null。 */
export function parseSqref(ref: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  const c0 = colIndex(m[1] ?? "A");
  const r0 = Number(m[2]) - 1;
  const c1 = m[3] ? colIndex(m[3]) : c0;
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  return { r0, c0, r1, c1 };
}

/** 一个 sqref 里可能是一串用空格隔开的盒子。 */
function boxes(sqref: string): { r0: number; c0: number; r1: number; c1: number }[] {
  const out = [];
  for (const part of sqref.trim().split(/\s+/)) {
    const box = parseSqref(part);
    if (box) out.push(box);
  }
  return out;
}

function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * 解析 `<dataValidations>`。`lookup(ref)` 负责把区域引用取成值列表（同一个表内），
 * 取不到就返回空数组——宁可没有下拉，也别给错选项。
 */
export function readValidations(xml: string, lookup: (ref: string) => string[]): WireValid[] {
  const out: WireValid[] = [];
  const block = /<dataValidations\b[^>]*>([\s\S]*?)<\/dataValidations>/.exec(xml)?.[1] ?? "";
  if (!block) return out;
  for (const m of block.matchAll(/<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
    const tag = `<d ${m[1] ?? ""}`;
    const sqref = attrOf(tag, "sqref") ?? "";
    const kind = attrOf(tag, "type") ?? "any";
    const prompt = unescapeXml(attrOf(tag, "prompt") ?? attrOf(tag, "error") ?? "");
    const body = m[2] ?? "";
    const f1 = unescapeXml(/<formula1\b[^>]*>([\s\S]*?)<\/formula1>/.exec(body)?.[1] ?? "").trim();
    let options: string[] | undefined;
    if (kind === "list" && f1) {
      if (f1.startsWith('"') && f1.endsWith('"')) {
        options = f1
          .slice(1, -1)
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      } else {
        const vals = lookup(f1.replace(/^=/, ""));
        if (vals.length) options = vals;
      }
    }
    for (const box of boxes(sqref)) out.push({ ...box, kind, options, ...(prompt ? { prompt } : {}) });
  }
  return out;
}

/** 从一张表的 XML 里取某个区域的「显示值」（下拉选项用，去重、最多 200 条）。 */
export function valuesInXml(xml: string, ref: string, strings: string[]): string[] {
  const box = parseSqref(ref.replace(/^'[^']*'!|^[^!]*!/, ""));
  if (!box) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = m[1] ?? "";
    const r = attrOf(`<c ${tag}`, "r");
    if (!r) continue;
    const pos = /^([A-Z]{1,3})(\d+)$/.exec(r.toUpperCase());
    if (!pos) continue;
    const c = colIndex(pos[1] ?? "A");
    const row = Number(pos[2]) - 1;
    if (row < box.r0 || row > box.r1 || c < box.c0 || c > box.c1) continue;
    const body = m[2] ?? "";
    const kind = attrOf(`<c ${tag}`, "t") ?? "n";
    let v = "";
    if (kind === "inlineStr") v = unescapeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? "");
    else {
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
      v = kind === "s" ? strings[Number(raw)] ?? "" : unescapeXml(raw);
    }
    v = v.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 200) break;
  }
  return out;
}

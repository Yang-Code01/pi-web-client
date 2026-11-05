/**
 * OOXML 文本小工具（D127）：xlsx.ts 与 cf.ts 都要解析 XML 片段，
 * 共享同一套实体反转义、属性读取与 A1 坐标解析，避免两处各写一份。
 */

export function unescapeXml(s: string): string {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (m, hex, num, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (num) return String.fromCodePoint(Number(num));
    switch (named) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return m;
    }
  });
}

export function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  if (!m) return null;
  return unescapeXml(m[2] ?? m[3] ?? "");
}

export function texts(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

export function colIndex(letters: string): number {
  let c = 0;
  for (const ch of letters.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

/** A1 → {r,c}，0 基。 */
export function refOf(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) };
}

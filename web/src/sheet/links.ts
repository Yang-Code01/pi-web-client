/**
 * #438 单元格超链接：把文件里的目标串拆成「哪张表 + 哪个区域」。
 *
 * 桥端 `refs.ts` 统一下发两种形状：外部地址原样（`https:` / `mailto:` / …），
 * 页内跳转一律以 `#` 开头。形状来自三种写法：
 *
 *   - WPS / Excel 的 `<hyperlink location="'01 基础格式'!A1"/>`；
 *   - openpyxl 把页内链接写成 relationship 的 `Target="#'01 基础格式'!A1"`；
 *   - 少数文件写 `#Sheet1!A1:B2`，表名没引号。
 *
 * 表名里可能有空格和单引号（Excel 用连续两个单引号转义），整条链接也可能被百分号
 * 转义过。这里只做纯字符串解析，不碰 DOM，方便单测。
 */

/** 一条能落到网格上的页内链接；`sheet` 为 null 表示当前表 / 命名区域没解析出来。 */
export interface SheetLink {
  /** 目标工作表名（已去引号、反转义）；null = 当前表。 */
  sheet: string | null;
  /** A1 式坐标或区域；链接只指到表时给 `A1`。 */
  ref: string;
}

/** 外部地址（浏览器 / 系统程序打开），不是页内跳转。 */
export function isExternalLink(raw: string): boolean {
  const s = raw.trim();
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s);
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 去掉 Excel 表名两边的单引号，并把 `''` 还原成 `'`。 */
function unquoteSheet(name: string): string {
  const s = name.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** `$A$1` / `a1:b2` / `A1` → `A1` / `A1:B2`；认不出返回 false。 */
function normalizeRef(ref: string): string | null {
  const s = ref.trim().replace(/\$/g, "").toUpperCase();
  if (/^[A-Z]{1,3}\d+$/.test(s)) return s;
  const m = /^([A-Z]{1,3}\d+):([A-Z]{1,3}\d+)$/.exec(s);
  if (!m) return null;
  const idx = (cell: string): [number, number] => {
    const at = /^([A-Z]{1,3})(\d+)$/.exec(cell);
    let c = 0;
    for (const ch of at?.[1] ?? "A") c = c * 26 + (ch.charCodeAt(0) - 64);
    return [Number(at?.[2] ?? 1) - 1, c - 1];
  };
  const [r0, c0] = idx(m[1]!);
  const [r1, c1] = idx(m[2]!);
  // 反向写（B2:A1）也认，统一成左上 / 右下。
  return `${colName(Math.min(c0, c1))}${Math.min(r0, r1) + 1}:${colName(Math.max(c0, c1))}${Math.max(r0, r1) + 1}`;
}

function colName(c: number): string {
  let out = "";
  let n = c + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 解析一条页内链接；不是页内链接 / 指向命名区域等认不出的目标返回 null。
 * 只给表名、没给坐标的（`#'说明'!`）落到 `A1`，和 Excel 的行为一致。
 */
export function parseSheetLink(raw: string): SheetLink | null {
  let s = decode(raw.trim());
  if (!s) return null;
  if (isExternalLink(s)) return null;
  // 多个 # 只去一层；`#'表'!A1` 与 `#表!A1` 都见过。
  if (s.startsWith("#")) s = s.slice(1);
  if (!s || s.startsWith("[")) return null; // 外部工作簿引用不在这里跳

  const at = s.lastIndexOf("!");
  if (at < 0) {
    // 没有 `!`：要么是当前表里的格子，要么是命名区域。只有前者能处理。
    const ref = normalizeRef(s);
    return ref ? { sheet: null, ref } : null;
  }
  const sheet = unquoteSheet(s.slice(0, at));
  if (!sheet || sheet.startsWith("[")) return null;
  const tail = s.slice(at + 1);
  if (!tail) return { sheet, ref: "A1" };
  const ref = normalizeRef(tail);
  return ref ? { sheet, ref } : null;
}

/** 表名匹配：先精确，再忽略大小写（Excel 的引用对大小写不敏感）。 */
export function matchSheetName(sheets: { name: string }[], wanted: string): string | null {
  const exact = sheets.find((s) => s.name === wanted);
  if (exact) return exact.name;
  const lc = wanted.toLocaleLowerCase();
  return sheets.find((s) => s.name.toLocaleLowerCase() === lc)?.name ?? null;
}

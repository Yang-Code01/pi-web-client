/**
 * D208: 产物弹窗要回答「这个文件改了什么」，所以得有一份「会话开始时 → 现在」的行级差异。
 *
 * 为什么自己写而不是拉一个 diff 包：这里只需要一种输出（带新旧行号的 hunk），依赖树里没有现成的，
 * 而 Myers 本身不到一百行；更重要的是上限必须握在自己手里 —— 一个 400 MB 的日志文件不能把桥的
 * 内存吃光，一次「整个文件重写」也不该生成三万行 hunk 塞进浏览器。
 *
 * 三个边界（都是真踩过的形状）：
 * - CRLF：Windows 的文件改一行会让每一行都变成「删除 + 新增」。比较前统一换行符。
 * - 二进制：NUL 字节只说明「不是文本」，逐行 diff 没有意义，调用方只要 size 变化。
 * - 大改动：Myers 的 O(ND) 在「两边完全不像」时最慢。超过编辑距离上限就退化成「整体重写」的统计。
 */

export type DiffLineKind = "+" | "-" | " ";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 基线里的 1-based 行号；新增行为 null。 */
  oldNo: number | null;
  /** 现在这份文件里的 1-based 行号；删除行为 null。 */
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffReason = "too-large" | "rewrite" | "binary";

export interface TextDiff {
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** 有内容没给全（hunk 太多、文件太大、整体重写）。 */
  truncated: boolean;
  reason?: DiffReason;
}

/** 单侧超过这个大小就不读行，只给 size 变化（与预览 / 编辑的上限一致）。 */
export const MAX_SIDE_BYTES = 2 * 1024 * 1024;
/** 单侧行数上限：再大也不是「看一眼改了什么」的场景。 */
export const MAX_SIDE_LINES = 5000;
/** Myers 的 d 上限。超过说明两边几乎不像，继续算只会更慢。 */
export const MAX_EDIT_DISTANCE = 1200;
/** 改动行数超过这个数只给统计，不给 hunk。 */
export const MAX_CHANGED_LINES = 3000;
export const MAX_HUNKS = 400;
/** 所有 hunk 加起来的行数上限。 */
export const MAX_OUTPUT_LINES = 20000;
/** hunk 上下各带几行。 */
export const CONTEXT = 3;

/** NUL 出现在前 8 KB 就按二进制看（与 git 的判法一致，够用）。 */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 统一换行符后按行切；结尾那一个换行不算多一行（否则每次保存都多一个空 hunk）。 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: DiffLineKind; text: string };

function backtrack(trace: Int32Array[], a: string[], b: string[], found: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = found; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "+", text: b[y - 1] });
        y--;
      } else {
        ops.push({ kind: "-", text: a[x - 1] });
        x--;
      }
    }
  }
  ops.reverse();
  return ops;
}

/** 经典 Myers；`null` = 编辑距离超过上限（两边基本不像）。 */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const cap = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = cap + 1;
  const v = new Int32Array(2 * cap + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= cap; d++) {
    // 记下第 d 步开始前的 V（回溯时按 d 取，索引是 k + d）。
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function number(ops: Op[]): DiffLine[] {
  let oldNo = 1;
  let newNo = 1;
  return ops.map((op) => {
    if (op.kind === " ") return { ...op, oldNo: oldNo++, newNo: newNo++ };
    if (op.kind === "-") return { ...op, oldNo: oldNo++, newNo: null };
    return { ...op, oldNo: null, newNo: newNo++ };
  });
}

function hunkOf(lines: DiffLine[], from: number, to: number): DiffHunk {
  const slice = lines.slice(from, to);
  const olds = slice.filter((l) => l.oldNo !== null);
  const news = slice.filter((l) => l.newNo !== null);
  // 纯新增的 hunk 没有旧行号：git 记作 `-0,0`，起点取「插在第几行之后 + 1」。
  const oldStart = olds.length ? (olds[0].oldNo as number) : (slice.find((l) => l.newNo !== null)?.newNo ?? 1) - 1;
  const newStart = news.length ? (news[0].newNo as number) : (slice.find((l) => l.oldNo !== null)?.oldNo ?? 1) - 1;
  const header = `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@`;
  return { header, oldStart, oldLines: olds.length, newStart, newLines: news.length, lines: slice };
}

function buildHunks(lines: DiffLine[]): { hunks: DiffHunk[]; truncated: boolean } {
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].kind !== " ") changed.push(i);
  if (!changed.length) return { hunks: [], truncated: false };

  // 先把「改动点 ± CONTEXT」折成互不相交的区间，再保证区间之间的空档至少留下一行，
  // 否则两个 hunk 会贴在一起，读起来像同一个。
  const ranges: { from: number; to: number }[] = [];
  for (const at of changed) {
    const from = Math.max(0, at - CONTEXT);
    const to = Math.min(lines.length, at + CONTEXT + 1);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  let total = 0;
  const hunks: DiffHunk[] = [];
  let truncated = false;
  for (const r of ranges) {
    if (hunks.length >= MAX_HUNKS || total >= MAX_OUTPUT_LINES) {
      truncated = true;
      break;
    }
    const end = Math.min(r.to, r.from + (MAX_OUTPUT_LINES - total));
    if (end < r.to) truncated = true;
    hunks.push(hunkOf(lines, r.from, end));
    total += end - r.from;
  }
  return { hunks, truncated };
}

/** 「会话开始时 → 现在」的差异。调用方负责判断二进制与大小。 */
export function diffTexts(before: string, after: string): TextDiff {
  if (Buffer.byteLength(before) > MAX_SIDE_BYTES || Buffer.byteLength(after) > MAX_SIDE_BYTES) {
    return { added: 0, removed: 0, hunks: [], truncated: true, reason: "too-large" };
  }
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_SIDE_LINES || b.length > MAX_SIDE_LINES) {
    return { added: 0, removed: 0, hunks: [], truncated: true, reason: "too-large" };
  }
  if (!a.length && !b.length) return { added: 0, removed: 0, hunks: [], truncated: false };

  const ops = myers(a, b);
  if (!ops) {
    return { added: b.length, removed: a.length, hunks: [], truncated: true, reason: "rewrite" };
  }
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
  }
  if (added + removed > MAX_CHANGED_LINES) {
    return { added, removed, hunks: [], truncated: true, reason: "rewrite" };
  }
  const built = buildHunks(number(ops));
  return { added, removed, hunks: built.hunks, truncated: built.truncated };
}

/** 只数行数（新增文件的 +N、删除文件的 −N），不跑 Myers。 */
export function countLines(text: string): number {
  return splitLines(text).length;
}

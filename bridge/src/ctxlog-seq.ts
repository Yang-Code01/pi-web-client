/**
 * ctxlog 的序号修复：旧版 `bridge/ext/context-log.ts` 在每次 `session_start`（桥重启、接管、
 * 切模型后重载）都把 `seq` / `turn` 清零，再接着往**同一个**文件追加。于是一个文件里会出现
 * 几段 1…N：`usage.atSeq`、事件的 `atSeq`、面板选中的请求全按 seq 对，撞号后就对错了行，
 * 「第 1 轮」也会出现好几次。
 *
 * 扩展现在会接着文件末尾续号；这里给已经落盘的旧文件兜底：每发现一次 seq 回退，就把这一段
 * 整体平移到上一段之后（seq 与 atSeq 一起移，turn 接着上一段最大的轮次往后数）。
 * 已经单调的文件原样返回（同一批对象，不复制）。
 */

interface SeqLine {
  seq: number;
  atSeq?: unknown;
  turn?: unknown;
  kind?: unknown;
  cats?: unknown;
}

function isRequest(l: SeqLine): boolean {
  return l.kind === "request" || (!l.kind && !!l.cats);
}

export function renumberCtxLog<T extends object>(input: T[]): T[] {
  const lines = input as unknown as SeqLine[];
  let prev = 0;
  let reset = false;
  for (const l of lines) {
    if (l.seq <= prev) {
      reset = true;
      break;
    }
    prev = l.seq;
  }
  if (!reset) return input;

  const out: SeqLine[] = [];
  let seqOffset = 0;
  let turnOffset = 0;
  let maxSeq = 0;
  let maxTurn = 0;
  let prevRaw = 0;
  for (const l of lines) {
    if (l.seq <= prevRaw) {
      // 新的一段：接在已经出现过的最大序号 / 轮次后面。
      seqOffset = maxSeq;
      turnOffset = maxTurn;
    }
    prevRaw = l.seq;
    const next: SeqLine = { ...l, seq: l.seq + seqOffset };
    // atSeq = 0 表示「还没有过请求」，不平移。
    if (typeof l.atSeq === "number" && l.atSeq > 0) next.atSeq = l.atSeq + seqOffset;
    if (isRequest(l) && typeof l.turn === "number") next.turn = l.turn + turnOffset;
    maxSeq = Math.max(maxSeq, next.seq);
    if (typeof next.turn === "number") maxTurn = Math.max(maxTurn, next.turn);
    out.push(next);
  }
  return out as unknown as T[];
}

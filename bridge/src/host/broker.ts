/**
 * 壳里的「管道账本」：pi 的输出行、页面→pi 的写、以及它们的跨代重放窗口。
 *
 * 为什么要有它：换脑时页面不能断、那一轮不能丢。壳把 pi 的三根管道握在手里以后，
 * 「哪一行已经进了老脑、哪一行还没人解释」「哪个脑此刻有权往 pi 里写」这两个问题就
 * 必须有唯一答案 —— 这个模块就是那个答案，别处不许自己再记一份。
 *
 * 分帧按字节缓冲、整行才解码（`0x0a` 切）：JSON 里的换行一定被转义，所以按行切是安全的；
 * 而按字符串切会把跨 chunk 的多字节字符切碎成 U+FFFD。
 */

export interface Line {
  seq: number;
  line: string;
}

/** 单条会话的未确认缓冲上限（字节）。超过就放弃这一轮的跨代重放，界面明说。 */
export const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * 字节流 → 行。只在拿到完整的 `\n` 之后解码，所以任意切法都不会把多字节字符切开。
 * 行尾的 `\r` 不进入内容（pi 的输出是 LF，但日志/转发层可能带 CRLF）。
 */
export class LineSplitter {
  private tail: Buffer = Buffer.alloc(0);
  private n = 0;

  push(chunk: Buffer): { lines: string[]; seqs: number[] } {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const lines: string[] = [];
    const seqs: number[] = [];
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      let end = nl;
      if (end > start && buf[end - 1] === 0x0d) end--;
      lines.push(buf.toString("utf8", start, end));
      seqs.push(++this.n);
      start = nl + 1;
    }
    this.tail = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
    return { lines, seqs };
  }

  /** 已经发出过的最后一条行的 seq。 */
  get seq(): number {
    return this.n;
  }

  /** 还没等到换行的半个行（含被切碎的多字节残片）。 */
  get pendingBytes(): number {
    return this.tail.length;
  }

  reset(): void {
    this.tail = Buffer.alloc(0);
    this.n = 0;
  }
}

export interface Pending {
  /** 第一条未确认行的 seq；没有未确认行时是 `toSeq + 1`。 */
  fromSeq: number;
  /** 已经吐出去的最后一条行的 seq（含未确认的）。 */
  toSeq: number;
  lines: Line[];
  /** 这一轮的行超过上限，已经没留下可重放的内容 —— 跨代只能退回「读会话文件尾巴」。 */
  overflowed: boolean;
}

interface Held {
  seq: number;
  line: string;
  bytes: number;
}

interface Entry {
  splitter: LineSplitter;
  owner: string | null;
  acked: number;
  held: Held[];
  heldBytes: number;
  overflowed: boolean;
  writeSeq: number;
  written: number;
}

export interface BrokerOptions {
  maxBytes?: number;
}

/**
 * 一个壳一份。所有方法按 sessionId 分账；没 attach 的会话收行直接丢 —— 壳不该为幽灵会话吃内存。
 */
export class Broker {
  private readonly maxBytes: number;
  private readonly conns = new Map<string, Entry>();

  constructor(opts: BrokerOptions = {}) {
    this.maxBytes = Math.max(1, opts.maxBytes ?? MAX_BUFFER_BYTES);
  }

  attach(sessionId: string): void {
    if (this.conns.has(sessionId)) return;
    this.conns.set(sessionId, {
      splitter: new LineSplitter(),
      owner: null,
      acked: 0,
      held: [],
      heldBytes: 0,
      overflowed: false,
      writeSeq: 0,
      written: 0,
    });
  }

  detach(sessionId: string): void {
    this.conns.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.conns.has(sessionId);
  }

  sessions(): string[] {
    return [...this.conns.keys()];
  }

  /**
   * 收一段 pi 的 stdout。返回这次成型的行（调用方负责交给 owner）；
   * 同时把它们记进未确认窗口，供下一次换脑重放。
   */
  push(sessionId: string, chunk: Buffer): Line[] {
    const e = this.conns.get(sessionId);
    if (!e) return [];
    const { lines, seqs } = e.splitter.push(chunk);
    const out: Line[] = [];
    for (let i = 0; i < lines.length; i++) {
      const seq = seqs[i];
      const line = lines[i];
      out.push({ seq, line });
      if (e.overflowed) continue;
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (e.heldBytes + bytes > this.maxBytes) {
        // 这一轮已经长到没法跨代了：把已留的行放掉，改由界面说「本轮不跨代」。
        e.overflowed = true;
        e.held = [];
        e.heldBytes = 0;
        continue;
      }
      e.held.push({ seq, line, bytes });
      e.heldBytes += bytes;
    }
    return out;
  }

  /** owner 处理到 seq 为止（含）；窗口随之裁剪。乱序/重复的 ack 不回退。 */
  ack(sessionId: string, seq: number): void {
    const e = this.conns.get(sessionId);
    if (!e || !Number.isFinite(seq) || seq <= e.acked) return;
    e.acked = seq;
    let cut = 0;
    while (cut < e.held.length && e.held[cut].seq <= seq) cut++;
    if (!cut) return;
    for (const h of e.held.splice(0, cut)) e.heldBytes -= h.bytes;
  }

  pending(sessionId: string): Pending {
    const e = this.conns.get(sessionId);
    if (!e) return { fromSeq: 1, toSeq: 0, lines: [], overflowed: false };
    const toSeq = e.splitter.seq;
    return {
      fromSeq: e.held.length ? e.held[0].seq : toSeq + 1,
      toSeq,
      lines: e.overflowed ? [] : e.held.map((h) => ({ seq: h.seq, line: h.line })),
      overflowed: e.overflowed,
    };
  }

  bufferedBytes(sessionId: string): number {
    return this.conns.get(sessionId)?.heldBytes ?? 0;
  }

  setOwner(sessionId: string, owner: string | null): void {
    const e = this.conns.get(sessionId);
    if (e) e.owner = owner;
  }

  ownerOf(sessionId: string): string | null {
    return this.conns.get(sessionId)?.owner ?? null;
  }

  isOwner(sessionId: string, brainId: string): boolean {
    return this.conns.get(sessionId)?.owner === brainId;
  }

  /**
   * 脑要求「往这个会话的 stdin 写一帧」。壳是唯一的写者：只有当前 owner 的请求会被收，
   * seq 也由壳发号 —— 换脑时老脑已经排队的帧不会因为它的进程消失而随之消失。
   * 不是 owner 时返回 null（调用方回 `stale-owner`，不要静默丢）。
   */
  enqueueWrite(sessionId: string, brainId: string, _data: string): number | null {
    const e = this.conns.get(sessionId);
    if (!e || e.owner !== brainId) return null;
    return ++e.writeSeq;
  }

  /** 壳已经把这帧写进 pi 的 stdin。 */
  written(sessionId: string, seq: number): void {
    const e = this.conns.get(sessionId);
    if (!e || !Number.isFinite(seq) || seq <= e.written) return;
    e.written = seq;
  }

  lastWritten(sessionId: string): number {
    return this.conns.get(sessionId)?.written ?? 0;
  }

  /** 老脑退场：留着未确认的行与写序号给下一任，只把「谁有权写」交出去。 */
  retireOwner(sessionId: string): void {
    const e = this.conns.get(sessionId);
    if (e) e.owner = null;
  }
}

/**
 * GBK 编码（#113）：Node 自带 GBK 解码器，没有编码器，所以从解码表反推一张正查表。
 *
 * 表约 2.4 万字，首次构建 20 ms 上下，之后缓存。前端不参与：保存时由这里按打开时的编码写回，
 * 浏览器只负责把解码后的文本还回来（D127：保存仍走文本通道）。
 */
let table: Map<string, number> | null = null;

function reverseTable(): Map<string, number> {
  if (table) return table;
  const dec = new TextDecoder("gbk");
  const map = new Map<string, number>();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead;
      pair[1] = trail;
      const ch = dec.decode(pair);
      if (ch.length === 1 && ch !== "\ufffd" && !map.has(ch)) map.set(ch, (lead << 8) | trail);
    }
  }
  table = map;
  return map;
}

export interface GbkEncoded {
  buf: Buffer;
  /** 表里没有、写不回去的字符（去重，保持出现顺序）。 */
  lost: string[];
}

/** 把文本编成 GBK 字节；编不出来的字符不静默替换，交给调用方决定报错还是兜底。 */
export function gbkEncode(text: string): GbkEncoded {
  const map = reverseTable();
  const out = Buffer.allocUnsafe(text.length * 2);
  let n = 0;
  const lost: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      out[n++] = code;
      continue;
    }
    const pair = map.get(ch);
    if (pair === undefined) {
      if (!lost.includes(ch)) lost.push(ch);
      continue;
    }
    out[n++] = pair >> 8;
    out[n++] = pair & 0xff;
  }
  return { buf: out.subarray(0, n), lost };
}

/** 严格 UTF-8 判定：不是合法 UTF-8 就按 GBK 看（#113 的嗅探规则，与前端一致）。 */
export function utf8Bytes(buf: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

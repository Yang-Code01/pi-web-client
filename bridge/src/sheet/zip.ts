/**
 * 最小 zip 目录读取器（#110）：只读中央目录，要哪个 part 再按偏移解哪个。
 *
 * fflate 的 `unzipSync` 会把整包一次性解成内存里的字节；大表光这一步就要几百 MB，
 * 而且表格 XML 一旦整张解出来，再想「只扫到第 100 行」也晚了。这里只读目录
 * （几十 KB），表 XML 交给 `entryStream` 边解边扫，扫够就停。
 */
import { Inflate, inflateSync } from "fflate";

export interface ZipEntry {
  name: string;
  /** 0 = store，8 = deflate。 */
  method: number;
  compSize: number;
  /** 未压缩大小。 */
  size: number;
  /** 本地文件头偏移。 */
  offset: number;
}

const utf8 = new TextDecoder("utf-8");

/** zip 里某个 part 解不开（数据损坏 / 压缩方式不认识）：归成「解码失败」，别把裸 inflate 错误端出去。 */
function decodeError(): Error {
  return Object.assign(new Error("这个文件解不开，用本机程序打开"), { code: "sheet_decode" });
}

function u16(dv: DataView, at: number): number {
  return dv.getUint16(at, true);
}

function u32(dv: DataView, at: number): number {
  return dv.getUint32(at, true);
}

/** 读中央目录；不是 zip / 目录损坏就返回 null，由调用方转成「这个格式不支持」。 */
export function zipIndex(buf: Uint8Array): Map<string, ZipEntry> | null {
  if (buf.length < 22) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (u32(dv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  let count = u16(dv, eocd + 10);
  let cd = u32(dv, eocd + 16);
  // Zip64：中央目录偏移/条数溢出时，真正的值在 Zip64 EOCD 里。
  if (count === 0xffff || cd === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(dv, loc) !== 0x07064b50) return null;
    const z = Number(dv.getBigUint64(loc + 8, true));
    if (z + 56 > buf.length || u32(dv, z) !== 0x06064b50) return null;
    count = Number(dv.getBigUint64(z + 32, true));
    cd = Number(dv.getBigUint64(z + 48, true));
  }

  const out = new Map<string, ZipEntry>();
  let p = cd;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(dv, p) !== 0x02014b50) return null;
    const method = u16(dv, p + 10);
    let compSize = u32(dv, p + 20);
    let size = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    let offset = u32(dv, p + 42);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      const end = p + 46 + nameLen + extraLen;
      for (let e = p + 46 + nameLen; e + 4 <= end; ) {
        const id = u16(dv, e);
        const len = u16(dv, e + 2);
        if (id === 0x0001) {
          // Zip64 extra：只补被写成 0xffffffff 的那几个字段，顺序固定。
          let q = e + 4;
          const limit = e + 4 + len;
          if (size === 0xffffffff && q + 8 <= limit) {
            size = Number(dv.getBigUint64(q, true));
            q += 8;
          }
          if (compSize === 0xffffffff && q + 8 <= limit) {
            compSize = Number(dv.getBigUint64(q, true));
            q += 8;
          }
          if (offset === 0xffffffff && q + 8 <= limit) offset = Number(dv.getBigUint64(q, true));
          break;
        }
        e += 4 + len;
      }
    }
    out.set(name, { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function dataStart(buf: Uint8Array, entry: ZipEntry): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (entry.offset + 30 > buf.length || u32(dv, entry.offset) !== 0x04034b50) throw new Error("zip 本地头损坏");
  const nameLen = u16(dv, entry.offset + 26);
  const extraLen = u16(dv, entry.offset + 28);
  return entry.offset + 30 + nameLen + extraLen;
}

/** 整条解出来：只给小 part（workbook / styles / sharedStrings）用。 */
export function entryBytes(buf: Uint8Array, entry: ZipEntry): Uint8Array {
  const at = dataStart(buf, entry);
  const comp = buf.subarray(at, at + entry.compSize);
  try {
    return entry.method === 0 ? comp : inflateSync(comp);
  } catch {
    throw decodeError();
  }
}

/**
 * 边解边喂：`onChunk` 返回 false 就停止喂压缩块（已经交付的字节不再回收）。
 * 只解到需要的行就停，深层窗口也不用把整张表解完。
 */
export function entryStream(buf: Uint8Array, entry: ZipEntry, onChunk: (chunk: Uint8Array) => boolean | void): void {
  const at = dataStart(buf, entry);
  const comp = buf.subarray(at, at + entry.compSize);
  if (entry.method === 0) {
    onChunk(comp);
    return;
  }
  if (entry.method !== 8) throw decodeError();
  let stop = false;
  try {
    const inf = new Inflate((chunk) => {
      if (stop) return;
      if (onChunk(chunk) === false) stop = true;
    });
    const STEP = 64 * 1024;
    for (let i = 0; i < comp.length && !stop; i += STEP) {
      inf.push(comp.subarray(i, Math.min(comp.length, i + STEP)), i + STEP >= comp.length);
    }
  } catch {
    throw decodeError();
  }
}

/**
 * 数一份 pptx 里有多少张幻灯片（D209：页数上限要在**启动 PowerPoint 之前**判，别转完再拒）。
 *
 * 不把整份包读进内存 —— 50 MB 的演示文稿只读中央目录就够了：
 * EOCD（从尾部 66 KB 里找）→ 中央目录 → 数 `ppt/slides/slideN.xml`。
 * 认不出来就回 `null`（加密包、Zip64、结构怪），调用方只做体积上限、不做页数上限。
 */
import fs from "node:fs";

const EOCD_SIG = 0x06054b50;
/** 中央目录超过这个大小就不数了：认输比吃掉几十兆内存好。 */
const MAX_CD_BYTES = 16 * 1024 * 1024;
const TAIL_BYTES = 66 * 1024;
const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/i;

export async function countSlides(file: string): Promise<number | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, "r");
    const { size } = await fh.stat();
    if (size < 22) return null;

    const tailLen = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;

    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdSize > MAX_CD_BYTES || cdOff === 0xffffffff) return null;
    // 中央目录紧挨着 EOCD，通常就在刚读的尾巴里；不在就补读一小段。
    const inTail = cdOff >= size - tailLen;
    const cd = inTail
      ? tail.subarray(cdOff - (size - tailLen), cdOff - (size - tailLen) + cdSize)
      : await readAt(fh, cdOff, cdSize);
    if (cd.length < cdSize) return null;

    let count = 0;
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (SLIDE_ENTRY.test(name)) count++;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return count;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function readAt(fh: fs.promises.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

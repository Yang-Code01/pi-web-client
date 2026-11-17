import fs from "node:fs";

/**
 * 只读文件头拿图片宽高（D305）。
 *
 * 为什么要宽高：QQ 的 `PicMsgElem` 自带尺寸，聊天里先用它把位置占住，缩略图下来时不会把
 * 整列消息顶得乱跳（`PicAioThumbDownMgr` 干的就是这件事）。我们照抄这一点：发/收的时候在
 * 本机读一次文件头，把 `w`/`h` 写进文件卡片，页面就能预留位置。
 *
 * 只认四种真正常见的容器：PNG / JPEG / GIF / WebP。认不出来就返回 null（页面退化成
 * 加载后再定尺寸），绝不为了「猜」去解一整个图片。
 */
export interface ImageSize {
  w: number;
  h: number;
}

/** 读文件头就够：JPEG 的 SOF 段可能被 EXIF 顶到几十 KB 之后，所以给 256 KB。 */
const HEAD_BYTES = 256 * 1024;

function sizeOf(buf: Buffer): ImageSize | null {
  // PNG：签名 + IHDR
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF：Logical Screen Descriptor
  if (buf.length >= 10 && buf.toString("ascii", 0, 4) === "GIF8") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP：RIFF....WEBP，三种子格式各有一套字段
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8X" && buf.length >= 30) {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
  }
  // JPEG：扫段，遇到 SOF0..SOF3 / SOF5..SOF15（排除 DHT/JPG/DAC）就是它
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = buf[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      // 无长度的标记：TEM / RSTn / SOI / EOI
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      const len = buf.readUInt16BE(at + 2);
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return { h: buf.readUInt16BE(at + 5), w: buf.readUInt16BE(at + 7) };
      }
      if (len < 2) return null;
      at += 2 + len;
    }
  }
  return null;
}

/** 读 `file` 的文件头判断尺寸；读不到 / 不是图片 / 认不出都返回 null。 */
export function imageSize(file: string): ImageSize | null {
  let fd = -1;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 16) return null;
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(st.size, HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return sizeOf(buf);
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不掉就算了 */
      }
    }
  }
}

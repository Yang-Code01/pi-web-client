import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.ts";
import { mimeOf } from "./files.ts";
import { imageSize } from "./image.ts";

/**
 * 「我的表情」：本机收藏的一组小图（`~/.pi-peer/stickers/`）。
 *
 * 只存在这台机器上，换浏览器也在；发的时候先复制一份进 `out/` 再走文件通道 ——
 * 文件索引指向那份副本，以后把收藏删了，已经发出去的消息照样能预览。
 * 文件名是内容的 sha256 前 16 位 + 扩展名：同一张图收藏两次只有一份。
 */

export const MAX_STICKER_BYTES = 5 * 1024 * 1024;
const MAX_STICKERS = 300;
const EXT = /^\.(png|jpe?g|gif|webp)$/i;
const ID = /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/i;

export interface Sticker {
  id: string;
  size: number;
  mime: string;
  w?: number;
  h?: number;
  at: number;
}

function dir(): string {
  const d = statePath("stickers");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function listStickers(): Sticker[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return [];
  }
  const out: Sticker[] = [];
  for (const id of names) {
    if (!ID.test(id)) continue;
    const file = path.join(dir(), id);
    try {
      const st = fs.statSync(file);
      const size = imageSize(file);
      out.push({ id, size: st.size, mime: mimeOf(id), at: st.mtimeMs, ...(size ? { w: size.w, h: size.h } : {}) });
    } catch {
      /* 读的时候被删了：跳过 */
    }
  }
  // 新收的排前面。
  return out.sort((a, b) => b.at - a.at);
}

export function addSticker(name: string, data: Buffer): Sticker {
  let ext = path.extname(name).toLowerCase();
  if (!EXT.test(ext)) throw new Error("只能收藏图片（png / jpg / gif / webp）");
  if (ext === ".jpeg") ext = ".jpg";
  if (!data.length) throw new Error("空文件");
  if (data.length > MAX_STICKER_BYTES) throw new Error("表情太大了（上限 5 MB）");
  if (listStickers().length >= MAX_STICKERS) throw new Error(`最多收藏 ${MAX_STICKERS} 个表情，先删掉几个`);
  const id = `${createHash("sha256").update(data).digest("hex").slice(0, 16)}${ext}`;
  const file = path.join(dir(), id);
  // 已经有了就只刷新时间：再收藏一次 = 挪到最前面。
  if (fs.existsSync(file)) fs.utimesSync(file, new Date(), new Date());
  else fs.writeFileSync(file, data);
  const st = fs.statSync(file);
  const size = imageSize(file);
  if (!size) {
    fs.rmSync(file, { force: true });
    throw new Error("认不出这张图");
  }
  return { id, size: st.size, mime: mimeOf(id), at: st.mtimeMs, w: size.w, h: size.h };
}

/** 收藏里那份文件的绝对路径；id 不合法 / 不存在都返回 null（不让 `..` 混进来）。 */
export function stickerPath(id: string): string | null {
  if (!ID.test(id)) return null;
  const file = path.join(dir(), id);
  return fs.existsSync(file) ? file : null;
}

export function removeSticker(id: string): boolean {
  const file = stickerPath(id);
  if (!file) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** 发之前复制一份到 `out/`：返回副本路径与对方看到的文件名。 */
export function stickerCopy(id: string): { path: string; name: string } {
  const file = stickerPath(id);
  if (!file) throw new Error("这个表情已经不在了");
  const ext = path.extname(id);
  const out = statePath("out");
  fs.mkdirSync(out, { recursive: true });
  const copy = path.join(out, `sticker-${randomUUID()}${ext}`);
  fs.copyFileSync(file, copy);
  return { path: copy, name: `表情${ext}` };
}

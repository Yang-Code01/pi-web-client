import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MAX_AVATAR_HISTORY, statePath } from "./config.ts";

/**
 * 自定义头像的字节层：落盘、按内容 hash 取、从对端拉。
 *
 * 为什么按 hash 存：广播里只有 `custom:<hash>`（见 `avatars.ts`），hash 就是内容地址，
 * URL / 文件名 / 缓存键三处共用同一个值。换一张图 → hash 变 → 页面上的 `<img>` 自然
 * 缓存失效，不需要版本号；同一张图反复存也只落一份。
 *
 * 放在 `~/.pi-peer/avatars/`，既有「我自己上传的」，也有「对端广播了 hash、我按需拉回来的」。
 * 两份混在一起没问题：内容寻址，谁的文件都只按 hash 认。
 */

/** 头像字节上限。192×192 的 WebP 通常只有几 KB，512 KB 是给用户直接传 PNG 留的余量。 */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** 本地最多留多少张（自己那张 + 最近见过的对端）。多出来的按 mtime 从旧到新删。 */
const MAX_CACHED = 64;

const AVATAR_EXTS = ["webp", "png", "jpg", "gif"] as const;

export interface StoredAvatar {
  hash: string;
  id: string;
  mime: string;
  ext: string;
  bytes: number;
}

interface ImageKind {
  mime: string;
  ext: string;
}

/** 只认四种能在 `<img>` 里直接画的格式，靠文件头判，不信请求里的 content-type。 */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (buf.toString("ascii", 0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  return null;
}

function dir(): string {
  return statePath("avatars");
}

function hashOf(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function validHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[0-9a-f]{16}$/.test(hash);
}

/**
 * 存一张上传的图。已经是同一张（hash 相同）就只返回元信息，不重复写盘。
 * 不是支持的图片 / 超过上限返回 null，调用方回 400。
 */
export function saveAvatarFile(buf: Buffer): StoredAvatar | null {
  const kind = sniffImage(buf);
  if (!kind || buf.length > MAX_AVATAR_BYTES) return null;
  const hash = hashOf(buf);
  const file = path.join(dir(), `${hash}.${kind.ext}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return { hash, id: `custom:${hash}`, mime: kind.mime, ext: kind.ext, bytes: buf.length };
}

/** 按 hash 找本地文件；扩展名是一次上传时按文件头定的，这里逐个试。 */
export function findAvatarFile(hash: unknown): { buf: Buffer; mime: string } | null {
  if (!validHash(hash)) return null;
  for (const ext of ["webp", "png", "jpg", "gif"]) {
    try {
      const buf = fs.readFileSync(path.join(dir(), `${hash}.${ext}`));
      const kind = sniffImage(buf);
      if (kind) return { buf, mime: kind.mime };
    } catch {
      /* 换下一个扩展名 */
    }
  }
  return null;
}

export function hasAvatarFile(hash: unknown): boolean {
  return Boolean(findAvatarFile(hash));
}

export interface AvatarUpload {
  hash: string;
  /** 广播 / 页面共用的 id：`custom:<hash>`。 */
  id: string;
  mime: string;
  bytes: number;
  /** 文件 mtime，给「上传过的」列表排序用。 */
  at: number;
}

/**
 * 「上传过的」列表：只认 `avatarHistory` 里的 hash，`avatars/` 里对端的缓存不算。
 * 文件已经不在了（手删 / 被清理）的条目直接跳过，不返回死链。
 */
export function listAvatarUploads(history: string[]): AvatarUpload[] {
  const out: AvatarUpload[] = [];
  const seen = new Set<string>();
  for (const hash of history) {
    if (out.length >= MAX_AVATAR_HISTORY) break;
    if (!validHash(hash) || seen.has(hash)) continue;
    seen.add(hash);
    const found = findAvatarFile(hash);
    if (!found) continue;
    let at = 0;
    for (const ext of AVATAR_EXTS) {
      try {
        at = fs.statSync(path.join(dir(), `${hash}.${ext}`)).mtimeMs;
        break;
      } catch {
        /* 换下一个扩展名 */
      }
    }
    out.push({ hash, id: `custom:${hash}`, mime: found.mime, bytes: found.buf.length, at });
  }
  return out;
}

/** 删一张本地图（只用于用户自己的上传记录）。返回是否真的删到了文件。 */
export function deleteAvatarFile(hash: unknown): boolean {
  if (!validHash(hash)) return false;
  let removed = false;
  for (const ext of AVATAR_EXTS) {
    try {
      fs.unlinkSync(path.join(dir(), `${hash}.${ext}`));
      removed = true;
    } catch {
      /* 没有这个扩展名就接着试 */
    }
  }
  return removed;
}

/** 旧缓存按 mtime 清掉，`keep` 里的 hash 永远不删（自己当前那张）。 */
export function pruneAvatarFiles(keep: string[] = [], max = MAX_CACHED): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return;
  }
  const protect = new Set(keep.filter(validHash));
  const rows: { file: string; hash: string; at: number }[] = [];
  for (const name of names) {
    const m = /^([0-9a-f]{16})\.(?:webp|png|jpg|gif)$/.exec(name);
    if (!m) continue;
    try {
      rows.push({ file: path.join(dir(), name), hash: m[1], at: fs.statSync(path.join(dir(), name)).mtimeMs });
    } catch {
      /* 文件刚好被删了 */
    }
  }
  if (rows.length <= max) return;
  rows.sort((a, b) => a.at - b.at);
  for (const row of rows.slice(0, rows.length - max)) {
    if (protect.has(row.hash)) continue;
    try {
      fs.unlinkSync(row.file);
    } catch {
      /* 删不掉就下次再说 */
    }
  }
}

/** 把对端自报的地址收拾成能拼进 URL 的 host（IPv4-mapped / IPv6 / 回环）。 */
function hostOf(addr: string): string {
  let host = addr.replace(/^::ffff:/, "");
  if (host === "::1") host = "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** 正在拉取的 hash：同一张图被好几个 `<img>` 同时要，别向对端发一串并发请求。 */
const inflight = new Map<string, Promise<{ buf: Buffer; mime: string } | null>>();

/**
 * 从对端拿图。只认内容 hash 对得上的响应（2 秒超时、512 KB 上限），
 * 拿到就落本地缓存；失败返回 null，页面退回首字母。
 */
export function fetchRemoteAvatar(addr: string, port: number, hash: string): Promise<{ buf: Buffer; mime: string } | null> {
  if (!validHash(hash) || !addr || !Number.isFinite(port) || port <= 0) return Promise.resolve(null);
  const cached = findAvatarFile(hash);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(hash);
  if (running) return running;
  const task = (async () => {
    try {
      const url = `http://${hostOf(addr)}:${Math.trunc(port)}/avatar?h=${hash}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_AVATAR_BYTES || hashOf(buf) !== hash) return null;
      const kind = sniffImage(buf);
      if (!kind) return null;
      fs.mkdirSync(dir(), { recursive: true });
      // 与 saveAvatarFile 一样先写临时名再 rename：并发的 readFile 不能读到半张图。
      const file = path.join(dir(), `${hash}.${kind.ext}`);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return { buf, mime: kind.mime };
    } catch {
      // 对端离线 / 端口换了 / 超时：下一次渲染再试，不缓存失败。
      return null;
    } finally {
      inflight.delete(hash);
    }
  })();
  inflight.set(hash, task);
  return task;
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { avatarHash } from "./avatars.ts";
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

/** 内存里留最近用过的多少张（每个 `<img>` 渲染都会来要一次，别每次 readFileSync）。 */
const MAX_CACHE = 16;

const AVATAR_EXTS = ["webp", "png", "jpg", "gif"] as const;

export interface StoredAvatar {
  hash: string;
  id: string;
  mime: string;
  ext: string;
  bytes: number;
}

export interface AvatarImage {
  hash: string;
  buf: Buffer;
  mime: string;
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

/** 临时文件名带上进程号 + 随机后缀：同进程里上传与对端拉取可能同时写同一个 hash。 */
function tmpPath(file: string): string {
  return `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

const cached = new Map<string, AvatarImage>();

function cachePut(entry: AvatarImage): void {
  cached.delete(entry.hash);
  cached.set(entry.hash, entry);
  while (cached.size > MAX_CACHE) {
    const oldest = cached.keys().next().value;
    if (!oldest) break;
    cached.delete(oldest);
  }
}

/** 文件被删 / 被清掉后调用方要顺带把内存缓存也丢掉，否则还会回一张已经不存在的图。 */
export function forgetAvatarFile(hash: string): void {
  cached.delete(hash);
}

/** 按 hash 找实际存在的文件路径（只 stat，不读内容）。扩展名在上传时按文件头定。 */
function avatarPath(hash: string): string | null {
  for (const ext of AVATAR_EXTS) {
    const file = path.join(dir(), `${hash}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * 存一张上传的图。已经是同一张（hash 相同）就只刷 mtime，不重复写盘。
 * 不是支持的图片 / 超过上限返回 null，调用方回 400。
 */
export function saveAvatarFile(buf: Buffer): StoredAvatar | null {
  const kind = sniffImage(buf);
  if (!kind || buf.length > MAX_AVATAR_BYTES) return null;
  const hash = hashOf(buf);
  const file = path.join(dir(), `${hash}.${kind.ext}`);
  if (fs.existsSync(file)) {
    // 同一张图被重新选回来：刷新 mtime，别让 prune 按「很久没写过」把它先删掉。
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      /* 时间戳刷不上就算了，不影响这张图可用 */
    }
  } else {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = tmpPath(file);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  cachePut({ buf, mime: kind.mime, hash });
  return { hash, id: `custom:${hash}`, mime: kind.mime, ext: kind.ext, bytes: buf.length };
}

/** 按 hash 找本地文件；扩展名是一次上传时按文件头定的，这里逐个试。命中后进内存缓存。 */
export function findAvatarFile(hash: unknown): AvatarImage | null {
  const h = avatarHash(hash);
  if (!h) return null;
  const hit = cached.get(h);
  if (hit) return hit;
  const file = avatarPath(h);
  if (!file) return null;
  try {
    const buf = fs.readFileSync(file);
    const kind = sniffImage(buf);
    if (!kind) return null;
    const entry = { buf, mime: kind.mime, hash: h };
    cachePut(entry);
    return entry;
  } catch {
    return null;
  }
}

/** 只判存在性：配置校验 / 启动检查不需要把整张图读进内存。 */
export function hasAvatarFile(hash: unknown): boolean {
  const h = avatarHash(hash);
  return Boolean(h) && Boolean(avatarPath(h));
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
    if (seen.has(hash)) continue;
    seen.add(hash);
    const found = findAvatarFile(hash);
    if (!found) continue;
    let at = 0;
    const file = avatarPath(found.hash);
    if (file) {
      try {
        at = fs.statSync(file).mtimeMs;
      } catch {
        /* mtime 读不到就当 0，只是排序会靠后 */
      }
    }
    out.push({ hash: found.hash, id: `custom:${found.hash}`, mime: found.mime, bytes: found.buf.length, at });
  }
  return out;
}

/** 删一张本地图（只用于用户自己的上传记录）。返回是否真的删到了文件。 */
export function deleteAvatarFile(hash: unknown): boolean {
  const h = avatarHash(hash);
  if (!h) return false;
  let removed = false;
  for (const ext of AVATAR_EXTS) {
    try {
      fs.unlinkSync(path.join(dir(), `${h}.${ext}`));
      removed = true;
    } catch {
      /* 没有这个扩展名就接着试 */
    }
  }
  if (removed) forgetAvatarFile(h);
  return removed;
}

/** 旧缓存按 mtime 清掉，`keep` 里的 hash 永远不删（自己当前那张 + 上传记录）。 */
export function pruneAvatarFiles(keep: string[] = [], max = MAX_CACHED): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return;
  }
  const protect = new Set(keep.map((hash) => avatarHash(hash)).filter(Boolean));
  const rows: { file: string; hash: string; at: number }[] = [];
  for (const name of names) {
    const m = /^([0-9a-f]{16})\.(?:webp|png|jpg|gif)$/.exec(name);
    if (!m) continue;
    const file = path.join(dir(), name);
    try {
      rows.push({ file, hash: m[1], at: fs.statSync(file).mtimeMs });
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
      forgetAvatarFile(row.hash);
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
const inflight = new Map<string, Promise<AvatarImage | null>>();

/**
 * 从对端拿图。只认内容 hash 对得上的响应（2.5 秒超时、512 KB 上限），
 * 拿到就落本地缓存；失败返回 null，页面退回首字母。
 */
export function fetchRemoteAvatar(addr: string, port: number, hash: string): Promise<AvatarImage | null> {
  const h = avatarHash(hash);
  if (!h || !addr || !Number.isFinite(port) || port <= 0) return Promise.resolve(null);
  const cachedHit = findAvatarFile(h);
  if (cachedHit) return Promise.resolve(cachedHit);
  const running = inflight.get(h);
  if (running) return running;
  const task = (async (): Promise<AvatarImage | null> => {
    try {
      const url = `http://${hostOf(addr)}:${Math.trunc(port)}/avatar?h=${h}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_AVATAR_BYTES || hashOf(buf) !== h) return null;
      const kind = sniffImage(buf);
      if (!kind) return null;
      fs.mkdirSync(dir(), { recursive: true });
      // 与 saveAvatarFile 一样先写临时名再 rename：并发的 readFile 不能读到半张图。
      const file = path.join(dir(), `${h}.${kind.ext}`);
      const tmp = tmpPath(file);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      const entry = { buf, mime: kind.mime, hash: h };
      cachePut(entry);
      return entry;
    } catch {
      // 对端离线 / 端口换了 / 超时：下一次渲染再试，不缓存失败。
      return null;
    } finally {
      inflight.delete(h);
    }
  })();
  inflight.set(h, task);
  return task;
}

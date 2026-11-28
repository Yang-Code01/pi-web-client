import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AVATAR_HASH_LEN, avatarHash, customAvatarId } from "./avatars.ts";
import { hostForUrl } from "./addr.ts";
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
const MIME_BY_EXT: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
};

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
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, AVATAR_HASH_LEN);
}

/** 临时文件名带上进程号 + 随机后缀：同进程里上传与对端拉取可能同时写同一个 hash。 */
function tmpPath(file: string): string {
  return `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * 落盘一张图：先写临时名再 rename（并发的 readFile 不能读到半张图）；
 * 写一半失败（磁盘满 / 权限）时把临时文件收掉 —— prune 只认正式文件名，
 * 这些 `.tmp-*` 留在 avatars/ 里就成了永久的垃圾（评审 3-3）。
 */
function writeAvatarFile(file: string, buf: Buffer): void {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = tmpPath(file);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 连删都删不掉就交给 pruneAvatarFiles 按年龄收 */
    }
    throw err;
  }
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
 * 不是支持的图片返回 null，调用方回 400。
 *
 * 体积**不靠这里兜**：HTTP 口子的 `readRaw(req, MAX_AVATAR_BYTES)` 边读边数，超限当场
 * 回 413，走到这里时 `buf.length` 必然 ≤ 上限。下面那个长度判断只是给将来别的调用方兜底，
 * 不是上传链路的大小检查点（评审 5-2）。
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
    writeAvatarFile(file, buf);
  }
  cachePut({ buf, mime: kind.mime, hash });
  return { hash, id: customAvatarId(hash), mime: kind.mime, ext: kind.ext, bytes: buf.length };
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
    // 只 stat 不读图：这个列表要的是 hash / mime / 字节数 / mtime，
    // 读整张图会阻塞事件循环、还会把缩略图缓存挤掉（评审 8-2）。
    const file = avatarPath(hash);
    if (!file) continue;
    const mime = MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()];
    if (!mime) continue;
    let at = 0;
    let bytes = 0;
    try {
      const info = fs.statSync(file);
      at = info.mtimeMs;
      bytes = info.size;
    } catch {
      continue;
    }
    out.push({ hash, id: customAvatarId(hash), mime, bytes, at });
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
    } catch (err) {
      // 只有「这个扩展名没有」才是正常的；EACCES / EPERM / EBUSY 是真删失败，
      // 吞掉会让调用方以为文件本来就不在，清掉历史记录后磁盘上还留着一张删不掉的图。
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  if (removed) forgetAvatarFile(h);
  return removed;
}

/** 写盘中途被杀的 `.tmp-<pid>-<rand>` 留多久算垃圾（正在写的临时文件别误删）。 */
const TMP_MAX_AGE = 60 * 60 * 1000;

/**
 * 旧缓存按 mtime 清掉，`keep` 里的 hash 永远不删（自己当前那张 + 上传记录）。
 *
 * 是 soft limit：被 keep 保护的行跳过之后不补删下一行，清完目录里可能仍多于 `max`，
 * 下一次 prune 再收（keep 最多 25 个，`max` 默认 64，不会一直涨）。
 */
export function pruneAvatarFiles(keep: string[] = [], max = MAX_CACHED): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return;
  }
  const protect = new Set(keep.map((hash) => avatarHash(hash)).filter(Boolean));
  const rows: { file: string; hash: string; at: number }[] = [];
  const now = Date.now();
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
    const file = path.join(dir(), name);
    // hash 长度只从 `avatarHash()` 来（`avatars.ts` 的 `AVATAR_HASH_LEN`），
    // 这里再写一份正则的话，改长度后 prune 会静默匹配不到任何文件、旧图只进不出（评审 5-1）。
    const hash = (AVATAR_EXTS as readonly string[]).includes(ext) && dot > 0 ? avatarHash(name.slice(0, dot)) : "";
    if (!hash) {
      // 不是正式文件名：只收「写盘中途被杀」留下的临时文件，其它一律别碰。
      if (!name.includes(".tmp-")) continue;
      try {
        if (now - fs.statSync(file).mtimeMs > TMP_MAX_AGE) fs.rmSync(file, { force: true });
      } catch {
        /* 刚好被删了 */
      }
      continue;
    }
    try {
      rows.push({ file, hash, at: fs.statSync(file).mtimeMs });
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
      const url = `http://${hostForUrl(addr)}:${Math.trunc(port)}/avatar?h=${h}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) {
        // 不读的 body 会占着这条连接直到超时 / GC；4xx/5xx 的 body 很小，直接取消（评审 6-12）。
        await res.body?.cancel().catch(() => {});
        return null;
      }
      // 对端是**不可信输入**：不能先 arrayBuffer() 再判大小，几百 MB 的 body 会在
      // 2.5 秒超时前就把内存吃满。先看 content-length，再边读边数，超了立刻 cancel（评审 8-1）。
      const announced = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(announced) && announced > MAX_AVATAR_BYTES) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.body) return null;
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          size += value.byteLength;
          if (size > MAX_AVATAR_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const buf = Buffer.concat(chunks, size);
      if (hashOf(buf) !== h) return null;
      const kind = sniffImage(buf);
      if (!kind) return null;
      // 和上传走同一条写盘路径：临时文件在失败时会被收掉（评审 3-3）。
      writeAvatarFile(path.join(dir(), `${h}.${kind.ext}`), buf);
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

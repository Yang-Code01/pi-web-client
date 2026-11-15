import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "./paths.ts";

/**
 * #455 上传暂存区：浏览器里选的非图片文件先落到 pi 本体这台机器的盘上，再把绝对路径插进输入框。
 *
 * 它和内网通的「收件箱」（`~/.pi-peer/inbox`）不是一回事：这里只收本页面自己上传的附件，
 * 按会话分目录，30 天没动就清。落点永远由桥算，请求里的会话 id 只用来查表。
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const UPLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_MAX = 120;

export function uploadsRoot(): string {
  return statePath("uploads");
}

/** 会话目录名只接受普通 id：路径分隔符与 `..` 一律拒绝，绝不把请求里的字符串拼出暂存区。 */
export function uploadsDir(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error(`会话 id 不能当目录名：${sessionId}`);
  }
  return path.join(uploadsRoot(), sessionId);
}

/**
 * 原始文件名 → 能落盘的名字。只取 basename（两种分隔符都切），洗掉控制字符与 Windows 非法字符，
 * 剪掉结尾的点和空格；超长按字符截断并保留扩展名。空名回退 `file`。
 */
export function safeName(raw: string): string {
  let name = path.basename(String(raw ?? "").replace(/\\/g, "/"));
  name = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !'<>:"|?*'.includes(ch);
    })
    .join("");
  name = name.replace(/[ .]+$/g, "");
  if (!name || name === "." || name === "..") name = "file";
  name = clampName(name);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function clampName(name: string): string {
  if (Array.from(name).length <= NAME_MAX) return name;
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? name.slice(dot) : "";
  if (Array.from(ext).length > 24) ext = "";
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  const room = NAME_MAX - Array.from(ext).length;
  return Array.from(base).slice(0, Math.max(1, room)).join("") + ext;
}

export interface SavedUpload {
  path: string;
  name: string;
  size: number;
}

/**
 * 写一份上传：先写同目录临时名，再链到最终名（原子且不覆盖），最后删临时名。重名在扩展名前
 * 加 `-2`、`-3`……；中途失败不会在盘上留下半份「看起来正常」的文件。
 */
export function saveUpload(sessionId: string, rawName: string, data: Buffer): SavedUpload {
  if (data.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error("too large"), { code: "too_large" });
  }
  const dir = uploadsDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const name = safeName(rawName);
  const tmp = path.join(dir, `.upload-${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data, { flag: "wx" });
  try {
    for (let n = 1; ; n++) {
      const dest = path.join(dir, n === 1 ? name : numbered(name, n));
      try {
        fs.linkSync(tmp, dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST") continue;
        // FAT / 某些网络盘不支持硬链接：退回 rename，并先自己挡一次同名。
        if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
          if (fs.existsSync(dest)) continue;
          fs.renameSync(tmp, dest);
          return { path: dest, name: path.basename(dest), size: data.length };
        }
        throw err;
      }
      fs.unlinkSync(tmp);
      return { path: dest, name: path.basename(dest), size: data.length };
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉就留给清理 */
    }
    throw err;
  }
}

/** 在最后一个扩展名前插序号：foo.tar.gz → foo.tar-2.gz。 */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}-${n}`;
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

/** 客户端回滚用：只肯删本会话目录里的直属文件。 */
export function removeUpload(sessionId: string, file: string): boolean {
  let dir: string;
  try {
    dir = path.resolve(uploadsDir(sessionId));
  } catch {
    return false;
  }
  const abs = path.resolve(file);
  const rel = path.relative(dir, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return false;
  try {
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动时清一次：`uploads/` 下一层的会话目录、以及根上残留的临时文件，最新 mtime 早于 30 天就删。
 * 只碰这个目录，删不掉只当没看见 —— 清理失败不该挡启动。
 */
export function pruneUploads(now = Date.now(), ttl = UPLOAD_TTL_MS): number {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(uploadsRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const abs = path.join(uploadsRoot(), entry.name);
    if (entry.isDirectory()) {
      if (now - newestMtime(abs) <= ttl) continue;
    } else if (!entry.isFile() || !entry.name.startsWith(".upload-")) {
      continue;
    } else if (now - newestMtime(abs) <= ttl) {
      continue;
    }
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 下次再试 */
    }
  }
  return removed;
}

function newestMtime(p: string): number {
  let newest = 0;
  const walk = (abs: string): void => {
    const st = fs.statSync(abs);
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
  };
  try {
    walk(p);
  } catch {
    /* 读不到就当 0：老得足够久，可以删 */
  }
  return newest;
}

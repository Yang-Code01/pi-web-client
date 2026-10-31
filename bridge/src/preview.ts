import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

/**
 * File preview for session artifacts (md / html / images / text).
 *
 * The logged-in page asks `/api/preview` for a file; if the path is inside the session's cwd or
 * the session transcript mentions it, the bridge hands out a capability token bound to a root
 * directory. `/raw/<token>/<rel>` then serves files under that root without a cookie, so a
 * sandboxed iframe (opaque origin, no cookies) can still load the page's relative css / images.
 * Everything served from /raw carries a CSP sandbox, so even when opened in its own tab a
 * previewed page cannot read the bridge's cookies or call its API.
 */

export type PreviewKind = "markdown" | "html" | "image" | "text" | "binary";

export interface PreviewInfo {
  token: string;
  rel: string;
  name: string;
  abs: string;
  size: number;
  mtime: number;
  kind: PreviewKind;
}

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TOKENS = 500;
const tokens = new Map<string, { root: string; at: number }>();

const MD = new Set([".md", ".markdown", ".mdx"]);
const HTML = new Set([".html", ".htm", ".xhtml"]);
const IMAGE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};
const OTHER_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

const isWin = process.platform === "win32";
const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

function isUnder(child: string, root: string): boolean {
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A few KB tell text from binary well enough: NUL bytes or too many control characters. */
function looksText(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let odd = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (b === 0) return false;
      if (b < 9 || (b > 13 && b < 32)) odd++;
    }
    return n === 0 || odd / n < 0.05;
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

const ATTACHABLE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"]);
const MAX_ATTACH_BYTES = 30 * 1024 * 1024;

/** Raw bytes of an image chosen in the file picker, to attach it like a pasted image. */
export function readAttachableImage(rawPath: string): { mime: string; data: Buffer } {
  const abs = path.resolve(rawPath.trim());
  const ext = path.extname(abs).toLowerCase();
  if (!path.isAbsolute(rawPath.trim()) || !ATTACHABLE.has(ext)) throw new Error("不是可以附加的图片");
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`文件不存在：${abs}`);
  }
  if (!st.isFile()) throw new Error(`不是文件：${abs}`);
  if (st.size > MAX_ATTACH_BYTES) throw new Error(`图片太大（${Math.round(st.size / 1024 / 1024)} MB）`);
  return { mime: IMAGE[ext], data: fs.readFileSync(abs) };
}

export function kindOf(file: string): PreviewKind {
  const ext = path.extname(file).toLowerCase();
  if (MD.has(ext)) return "markdown";
  if (HTML.has(ext)) return "html";
  if (IMAGE[ext]) return "image";
  return looksText(file) ? "text" : "binary";
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (HTML.has(ext)) return "text/html; charset=utf-8";
  if (IMAGE[ext]) return IMAGE[ext];
  if (OTHER_MIME[ext]) return OTHER_MIME[ext];
  if (MD.has(ext)) return "text/plain; charset=utf-8";
  return looksText(file) ? "text/plain; charset=utf-8" : "application/octet-stream";
}

function issue(root: string): string {
  const now = Date.now();
  for (const [t, v] of tokens) if (now - v.at > TOKEN_TTL_MS) tokens.delete(t);
  while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value!);
  const token = crypto.randomBytes(24).toString("base64url");
  tokens.set(token, { root, at: now });
  return token;
}

/** Throws a user-facing (Chinese) message when the path may not be previewed. */
export function openPreview(session: { cwd: string; file: string | null }, rawPath: string): PreviewInfo {
  const raw = rawPath.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/^file:\/\/\/?/i, "");
  if (!raw) throw new Error("路径为空");
  let decoded = raw;
  try {
    if (/%[0-9a-f]{2}/i.test(raw)) decoded = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  const abs = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(session.cwd, decoded);
  // Reads follow /api/dirs, which already lists any drive: a second, narrower rule here only made
  // the same path openable in one place and not the other (D50).
  const inCwd = isUnder(abs, session.cwd);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`文件不存在：${abs}`);
  }
  if (!st.isFile()) throw new Error(`不是文件：${abs}`);
  // Root = cwd when possible so `../assets/x.css` from a nested page still resolves.
  const root = inCwd ? path.resolve(session.cwd) : path.dirname(abs);
  const rel = path.relative(root, abs).split(path.sep).map(encodeURIComponent).join("/");
  return { token: issue(root), rel, name: path.basename(abs), abs, size: st.size, mtime: st.mtimeMs, kind: kindOf(abs) };
}

/**
 * Writable text files: only what this page opened through /api/preview, and only text ≤ 2 MB.
 * The token grants reads under a root directory, which is far wider than "this file" — writes
 * therefore never trust the token, only this registry (D50).
 */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
interface EditGrant {
  real: string;
  size: number;
  mtime: number;
  bom: boolean;
}
const editable = new Map<string, Map<string, EditGrant>>();

function hasBom(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(3);
    const n = fs.readSync(fd, b, 0, 3, 0);
    return n === 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

const canEdit = (info: PreviewInfo): boolean => (info.kind === "markdown" || info.kind === "text") && info.size <= MAX_EDIT_BYTES;

/** Remember a file as writable for this session, so `/api/save` has something to check against. */
export function rememberEditable(sessionId: string, info: PreviewInfo): void {
  if (!sessionId || !canEdit(info)) return;
  let m = editable.get(sessionId);
  if (!m) {
    m = new Map();
    editable.set(sessionId, m);
  }
  if (m.size >= 200) m.clear();
  m.set(norm(info.abs), { real: info.abs, size: info.size, mtime: info.mtime, bom: hasBom(info.abs) });
}

export interface SaveResult {
  path: string;
  mtime: number;
  size: number;
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function uniqueCopy(file: string): string {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let i = 1; i < 100; i++) {
    const cand = path.join(dir, i === 1 ? `${base}.copy${ext}` : `${base}.copy-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  fail(409, "副本文档太多了，先清理一下");
}

/**
 * Write back a file the page edited. Optimistic lock on mtime + size: a file pi changed while it was
 * open is refused with 409 instead of being silently overwritten. `copy: true` writes a sibling
 * `<name>.copy<ext>` instead (the conflict bar's third choice).
 */
export function savePreviewFile(
  sessionId: string,
  input: { path?: unknown; text?: unknown; mtime?: unknown; size?: unknown; copy?: unknown },
): SaveResult {
  const rawPath = String(input.path ?? "").trim();
  if (!rawPath) fail(400, "路径为空");
  if (typeof input.text !== "string") fail(400, "内容必须是字符串");
  const text = input.text;
  if (Buffer.byteLength(text, "utf8") > MAX_EDIT_BYTES) fail(400, `内容超过 2 MB，浏览器里改不了这么大的文件`);
  const grant = editable.get(sessionId)?.get(norm(rawPath));
  if (!grant) fail(403, "这个文件没有在本页打开过，不能直接保存");
  let st: fs.Stats;
  try {
    st = fs.statSync(grant.real);
  } catch {
    fail(404, `文件不见了：${grant.real}`);
  }
  if (!st.isFile()) fail(400, `不是文件：${grant.real}`);
  const copy = input.copy === true;
  let target = grant.real;
  if (copy) {
    target = uniqueCopy(grant.real);
  } else {
    const mtime = Number(input.mtime);
    const size = Number(input.size);
    if (!Number.isFinite(mtime) || Math.abs(st.mtimeMs - mtime) > 0.5 || st.size !== size) {
      fail(409, "文件在你编辑期间被改过了");
    }
  }
  const payload = (grant.bom ? "\ufeff" : "") + text;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename already moved it */
    }
    throw err;
  }
  const after = fs.statSync(target);
  editable.get(sessionId)!.set(norm(target), { real: target, size: after.size, mtime: after.mtimeMs, bom: grant.bom });
  return { path: target, mtime: after.mtimeMs, size: after.size };
}

/** `/raw/<token>/<rel>`: returns false when the url is not a raw url at all. */
export function serveRaw(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  const m = /^\/raw\/([A-Za-z0-9_-]+)\/(.*)$/.exec(pathname);
  if (!m) return false;
  const deny = (status: number, text: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    deny(405, "method not allowed");
    return true;
  }
  const grant = tokens.get(m[1]);
  if (!grant || Date.now() - grant.at > TOKEN_TTL_MS) {
    deny(404, "预览链接已失效，回到页面重新打开预览");
    return true;
  }
  grant.at = Date.now();
  let rel: string;
  try {
    rel = m[2].split("/").map(decodeURIComponent).join(path.sep);
  } catch {
    deny(400, "bad path");
    return true;
  }
  const abs = path.resolve(grant.root, rel);
  if (!isUnder(abs, grant.root)) {
    deny(403, "forbidden");
    return true;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    deny(404, "not found");
    return true;
  }
  if (!st.isFile()) {
    deny(404, "not found");
    return true;
  }
  res.writeHead(200, {
    "content-type": mimeOf(abs),
    "content-length": String(st.size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Opaque origin: scripts run, but cannot reach cookies, storage or the bridge API.
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    "referrer-policy": "no-referrer",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(abs).on("error", () => res.destroy()).pipe(res);
  return true;
}

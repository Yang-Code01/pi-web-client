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

// The transcript is the evidence for "this path showed up in the session": cache its lowercased
// text per file version, a couple of sessions at a time.
const transcriptCache = new Map<string, { key: string; text: string }>();

function transcript(file: string): string {
  try {
    const st = fs.statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = transcriptCache.get(file);
    if (hit?.key === key) return hit.text;
    const text = fs.readFileSync(file, "utf8").toLowerCase();
    transcriptCache.delete(file);
    transcriptCache.set(file, { key, text });
    while (transcriptCache.size > 3) transcriptCache.delete(transcriptCache.keys().next().value!);
    return text;
  } catch {
    return "";
  }
}

function mentioned(sessionFile: string | null, raw: string, abs: string): boolean {
  if (!sessionFile) return false;
  const text = transcript(sessionFile);
  if (!text) return false;
  const forms = new Set<string>();
  for (const p of [raw, abs]) {
    if (!p || p.length < 3) continue;
    const lower = p.toLowerCase();
    forms.add(lower);
    forms.add(lower.replace(/\\/g, "/"));
    forms.add(lower.replace(/\\/g, "\\\\")); // as JSON-escaped in the jsonl
  }
  for (const f of forms) if (text.includes(f)) return true;
  return false;
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
  const inCwd = isUnder(abs, session.cwd);
  if (!inCwd && !mentioned(session.file, decoded, abs)) {
    throw new Error("这个文件既不在会话工作目录里，也没在会话里出现过，不能预览");
  }
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

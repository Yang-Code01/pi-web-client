import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  [k: string]: unknown;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: any;
  [k: string]: any;
}

export interface SessionFileMeta {
  file: string;
  id: string;
  cwd: string;
  startedAt: string;
  /** Latest `session_info` name (pi appends a new one on every /name). */
  name: string | null;
  /** Timestamp of that entry, used to pick between a file name and a bridge override. */
  nameAt: string | null;
  firstUserText: string | null;
  mtime: number;
  size: number;
  /** Number of lines seen while scanning the head of the file (cheap proxy for "has content"). */
  headLines: number;
}

const HEAD_BYTES = 8192;
const TAIL_BYTES = 8192;

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Last parsable `session_info` in a chunk of jsonl. */
function lastSessionInfo(text: string, skipPartialFirstLine: boolean): { name: string; at: string | null } | null {
  const lines = text.split("\n");
  if (skipPartialFirstLine) lines.shift(); // chunk started mid-entry
  let found: { name: string; at: string | null } | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      found = { name: entry.name.trim(), at: typeof entry.timestamp === "string" ? entry.timestamp : null };
    }
  }
  return found;
}

/** Cheap metadata read: first line is the `session` header (docs/session-format.md). */
export function readMeta(file: string): SessionFileMeta | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const head = readHead(file, HEAD_BYTES);
  const lines = head.split("\n");
  let header: SessionHeader | null = null;
  try {
    const first = JSON.parse(lines[0]);
    if (first && first.type === "session") header = first as SessionHeader;
  } catch {
    return null;
  }
  if (!header) return null;

  let name: string | null = null;
  let nameAt: string | null = null;
  let firstUserText: string | null = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      break; // partial last line inside the head window
    }
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      name = entry.name.trim();
      nameAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
    }
    if (!firstUserText && entry?.type === "message" && entry.message?.role === "user") {
      const text = titleFromUserText(extractText(entry.message.content));
      if (text) firstUserText = text;
    }
  }

  // The first user message often sits behind a huge system-prompt entry that the head window cuts.
  if (!firstUserText && stat.size > HEAD_BYTES) firstUserText = scanFirstUserText(file, stat.size);

  // `/name` appends to the tail, so a long transcript's newest name is not in the head.
  if (stat.size > HEAD_BYTES) {
    const tail = lastSessionInfo(readTail(file, TAIL_BYTES), true);
    if (tail) {
      name = tail.name;
      nameAt = tail.at;
    }
  }

  return {
    file,
    id: String(header.id),
    cwd: String(header.cwd ?? ""),
    startedAt: String(header.timestamp ?? ""),
    name,
    nameAt,
    firstUserText,
    mtime: stat.mtimeMs,
    size: stat.size,
    headLines: lines.length - 1,
  };
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as any).type === "text") parts.push(String((c as any).text ?? ""));
  }
  return parts.join("\n");
}

/**
 * pi expands a `/skill:x` prompt before the model sees it *and* before it reaches the session file
 * (`_expandSkillCommand` in agent-session): the stored user message is
 * `<skill name="x" location="…">the whole SKILL.md</skill>` followed by whatever the user typed.
 * Everything the web client shows should be what the human typed, so parse that back here.
 * Display only — the file and the model's context keep the expansion.
 */
export interface SkillExpansion {
  name: string;
  /** The SKILL.md path pi recorded in `location`; kept for the chip's tooltip only. */
  location?: string;
  /** What the user typed after the command, trimmed. */
  args: string;
  /** `/skill:<name>`, or `/skill:<name> <args>`. */
  command: string;
}

/**
 * The opening tag is matched loosely and its attributes read separately: pi owns that tag, and an
 * added or reordered attribute must not put the whole SKILL.md back on screen. The body is greedy
 * on purpose — a SKILL.md may quote `</skill>` itself, and only the last close ends the block.
 */
const SKILL_BLOCK = /^\s*<skill\b([^>]*)>([\s\S]*)<\/skill>([\s\S]*)$/;
const NAME_ATTR = /\bname="([^"]*)"/;
const LOCATION_ATTR = /\blocation="([^"]*)"/;

export function skillExpansion(raw: string): SkillExpansion | null {
  const block = SKILL_BLOCK.exec(raw);
  if (!block) return null;
  // A `<skill>` without a name is nothing we can fold back; leave it as the stored text.
  const name = NAME_ATTR.exec(block[1])?.[1];
  if (!name) return null;
  const location = LOCATION_ATTR.exec(block[1])?.[1];
  const args = block[3].trim();
  return {
    name,
    args,
    command: args ? `/skill:${name} ${args}` : `/skill:${name}`,
    ...(location ? { location } : {}),
  };
}

/** What a user message should read as: a skill call folds back to `/skill:<name> args`. */
export function displayUserText(raw: string): string {
  return skillExpansion(raw)?.command ?? raw;
}

/** The skill a *typed* prompt calls (`/skill:<name>`), before pi expands it — for the live bubble. */
export function typedSkill(text: string): string | null {
  const m = /^\s*\/skill:(\S+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * Display text flattened for comparisons: `branchOff`'s fallback matches the web's folded command
 * against the file's expanded block, and pi's queue hands back the expanded text too.
 */
export function normalizeUserText(raw: string): string {
  return displayUserText(raw).replace(/\s+/g, " ").trim();
}

/** A sidebar title from a user message: the same text, flattened and cut to 120 chars. */
export function titleFromUserText(raw: string): string | null {
  const text = normalizeUserText(raw);
  return text ? text.slice(0, 120) : null;
}

const FIRST_USER_SCAN_BYTES = 4 * 1024 * 1024;
/** Deep scans are not free and the sidebar re-lists every few seconds: remember the answer. */
const firstUserCache = new Map<string, { size: number; text: string | null }>();
const USER_ROLE = Buffer.from('"role":"user"');

/** Walk whole lines (without parsing the big ones) until the first user message. */
function scanFirstUserText(file: string, size: number): string | null {
  const hit = firstUserCache.get(file);
  if (hit && (hit.text !== null || hit.size === size)) return hit.text;
  let text: string | null = null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(256 * 1024);
    let rest = Buffer.alloc(0);
    let pos = 0;
    outer: while (pos < Math.min(size, FIRST_USER_SCAN_BYTES)) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      let buf = Buffer.concat([rest, chunk.subarray(0, n)]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) break;
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (line.indexOf(USER_ROLE) < 0) continue;
        try {
          const entry = JSON.parse(line.toString("utf8"));
          if (entry?.type === "message" && entry.message?.role === "user") {
            text = titleFromUserText(extractText(entry.message.content));
            if (text) break outer;
          }
        } catch {
          /* not a whole entry */
        }
      }
      rest = Buffer.from(buf);
    }
  } catch {
    /* unreadable file: no title, same as before */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  firstUserCache.set(file, { size, text });
  return text;
}

/** The sidebar re-lists every few seconds: re-read a file's head/tail only when it changed. */
const metaCache = new Map<string, { mtime: number; size: number; meta: SessionFileMeta }>();

function cachedMeta(file: string): SessionFileMeta | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    metaCache.delete(file);
    return null;
  }
  const hit = metaCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.meta;
  const meta = readMeta(file);
  if (meta) metaCache.set(file, { mtime: stat.mtimeMs, size: stat.size, meta });
  else metaCache.delete(file);
  return meta;
}

function jsonlIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Session files live in `<root>/--<encoded cwd>--/<ts>_<id>.jsonl` (pi's default layout), or flat
 * in `<root>/<ts>_<id>.jsonl` when the user set a custom session dir (pi's listSessionsFromDir).
 * Both are read, and every file is listed: a per-folder cap used to hide older sessions silently.
 */
export function listSessionFiles(root: string): SessionFileMeta[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
  const files = [...jsonlIn(root), ...dirs.flatMap(jsonlIn)];
  const seen = new Set(files);
  for (const key of metaCache.keys()) if (!seen.has(key)) metaCache.delete(key);
  const out: SessionFileMeta[] = [];
  for (const file of files) {
    const meta = cachedMeta(file);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export interface LoadResult {
  entries: SessionEntry[];
  truncated: boolean;
  leafId: string | null;
  size: number;
  mtime: number;
}

/**
 * One image part of a `message` entry, by entry id and index among that message's image parts.
 *
 * The transcript view only carries image metadata (`mimeType`), so a thumbnail asks for the bytes
 * here. Streaming, not `loadEntries()`: that one empties every image's base64 as it reads (the
 * budget counts text, see `stripImageData()`) and may drop the head of a huge file. The line
 * prefilter is cheap — entry ids are uuids and base64 never contains a `-`.
 */
export async function loadEntryImage(file: string, entryId: string, index: number): Promise<{ mimeType: string; data: Buffer } | null> {
  if (!entryId || !Number.isInteger(index) || index < 0) return null;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes(entryId)) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.id !== entryId || entry.type !== "message") continue;
      const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const images = parts.filter((c: any) => c && c.type === "image");
      const hit = images[index];
      if (!hit || typeof hit.data !== "string") return null;
      return { mimeType: String(hit.mimeType ?? "image/png"), data: Buffer.from(hit.data, "base64") };
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * 一次最多读进内存多少原始字节。正常会话文件远小于它；再大就是病态输入（读一次要几秒、
 * 瞬时吃几百 MB 堆），退回「只读尾部」，剩下的交给 `loadEntries()` 的内容预算去裁。
 */
const MAX_READ_BYTES = 256 * 1024 * 1024;

/**
 * 把 `image` 部件的 base64 抹掉，返回省下的字节数。像素不参与正文渲染：`entriesToItems()`
 * 只把图片折成「[图片]」，真要像素由 `loadEntryImage()` 现从盘上取。
 */
function stripImageData(entry: any): number {
  const parts = entry?.message?.content;
  if (!Array.isArray(parts)) return 0;
  let freed = 0;
  for (const part of parts) {
    if (!part || part.type !== "image" || typeof part.data !== "string") continue;
    freed += part.data.length;
    part.data = "";
  }
  return freed;
}

/**
 * Reads entries from a session file. Never writes to it (ownership rule: pi owns the file).
 *
 * 预算（`maxBytes`）算的是**正文**字节，不是文件字节：图片读进来立刻抹掉（`stripImageData()`），
 * 一个字节都不占预算。按文件字节算的后果是「贴几张截图 = 开头那句话整条不见」—— 截图全在工具
 * 结果的 `image` 部件里，渲染层一个字都不用，却能把 16 MB 吃光（真实案例：70 MB 文件里 69 MB 是
 * base64，正文只有 1.4 MB，于是文件头部那条用户消息被无声丢掉，界面上连「还有更早的」都没有）。
 *
 * 正文也超预算时仍从尾部留够为止、头部整条丢掉，`truncated` 只在这时才是 true。
 */
export function loadEntries(file: string, maxBytes = 16 * 1024 * 1024): LoadResult {
  const stat = fs.statSync(file);
  const start = stat.size > MAX_READ_BYTES ? stat.size - MAX_READ_BYTES : 0;
  const length = stat.size - start;
  const fd = fs.openSync(file, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    raw = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1); // drop the partial first line

  const entries: SessionEntry[] = [];
  /** 与 `entries` 一一对应的正文字节数（抹掉图片之后），供下面的从头部裁剪用。 */
  const sizes: number[] = [];
  let total = 0;
  // 逐行走 indexOf 而不是 `split("\n")`：不复制整份文件（几十 MB 的字符串会再多占一份）。
  let at = 0;
  while (at < raw.length) {
    let nl = raw.indexOf("\n", at);
    if (nl < 0) nl = raw.length;
    const line = raw.slice(at, nl);
    at = nl + 1;
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; /* skip unparseable line */
    }
    if (!entry || typeof entry !== "object" || entry.type === "session") continue;
    const size = Buffer.byteLength(line) - stripImageData(entry);
    entries.push(entry as SessionEntry);
    sizes.push(size);
    total += size;
  }

  // 从头部丢到预算以里；至少留最后一条，否则界面上一片空白比截断更糟。
  let head = 0;
  while (head < entries.length - 1 && total > maxBytes) total -= sizes[head++];
  const kept = head ? entries.slice(head) : entries;
  return {
    entries: kept,
    truncated: start > 0 || head > 0,
    leafId: kept.length ? kept[kept.length - 1].id : null,
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

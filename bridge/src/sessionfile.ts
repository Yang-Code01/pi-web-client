import fs from "node:fs";
import path from "node:path";

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
 * A sidebar title from a user message: a `/skill:x` command reaches the file already expanded as
 * `<skill name="x" …>…</skill> args`, which would title the session with the skill's own prose.
 */
export function titleFromUserText(raw: string): string | null {
  let text = raw.trim();
  const skill = /^<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*([\s\S]*)$/.exec(text);
  if (skill) text = `/skill:${skill[1]}${skill[2].trim() ? ` ${skill[2].trim()}` : ""}`;
  text = text.replace(/\s+/g, " ").trim();
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
      let nl: number;
      while ((nl = buf.indexOf(10)) >= 0) {
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

/** Session files live in ~/.pi/agent/sessions/--<encoded cwd>--/<ts>_<id>.jsonl */
export function listSessionFiles(root: string, limitPerDir = 60): SessionFileMeta[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
  const out: SessionFileMeta[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    files.sort((a, b) => (a < b ? 1 : -1)); // timestamp prefix sorts desc
    for (const file of files.slice(0, limitPerDir)) {
      const meta = readMeta(file);
      if (meta) out.push(meta);
    }
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
 * Reads entries from a session file. Never writes to it (ownership rule: pi owns
 * the file). When the file is larger than maxBytes we keep only the tail and mark
 * the result truncated, because the viewer only needs the recent turns.
 */
export function loadEntries(file: string, maxBytes = 16 * 1024 * 1024): LoadResult {
  const stat = fs.statSync(file);
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
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
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && entry.type !== "session") entries.push(entry as SessionEntry);
    } catch {
      /* skip unparseable line */
    }
  }
  return {
    entries,
    truncated: start > 0,
    leafId: entries.length ? entries[entries.length - 1].id : null,
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

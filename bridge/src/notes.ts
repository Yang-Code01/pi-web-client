/**
 * 记录（bug / 变更 / 想法 / 杂事）—— 用户随手记的东西，落在状态目录，不进会话文件。
 *
 * 一个 JSON 装全部条目，截图单独落盘（`notes/assets/<id>/`），因为 base64 塞进 JSON 会让文件
 * 在几十张图后变成几 MB，每次列表都得整读整写。截图路径记绝对路径：交给 agent 时它要能直接读。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonChecked, statePath, writeJson } from "./paths.ts";

export const NOTE_KINDS = ["bug", "change", "idea", "chore"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_STATUSES = ["pending", "done", "dropped"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_MODES = ["quick", "form", "long"] as const;
export type NoteMode = (typeof NOTE_MODES)[number];
/** 生命周期：在列表里 → 归档 → 垃圾箱。跟 status（待处理/已处理/已忽略）是两回事。 */
export const NOTE_LIVES = ["active", "archived", "trashed"] as const;
export type NoteLife = (typeof NOTE_LIVES)[number];

export interface Note {
  id: string;
  kind: NoteKind;
  status: NoteStatus;
  mode: NoteMode;
  title: string;
  body: string;
  /** 桥这台机器上的绝对路径，按加入顺序。 */
  shots: string[];
  /** 静默记下：这条是在哪个会话里记的（列表不显示，导出 / 交给 agent 时用）。 */
  sessionId: string | null;
  sessionName: string | null;
  /** 处理完之后的凭据，可空。 */
  issue: string;
  commit: string;
  createdAt: number;
  updatedAt: number;
  /** 归档 / 丢进垃圾箱的时间；二者都没有就是正常在列表里。 */
  archivedAt: number | null;
  deletedAt: number | null;
}

interface Store {
  version: 1;
  notes: Note[];
}

const MAX_TITLE = 200;
const MAX_BODY = 200_000;
const MAX_SHOTS = 24;
const MAX_SHOT_BYTES = 20 * 1024 * 1024;
/** 上一次读盘失败的原因（null = 读到了）。读失败期间一律拒绝保存，见 save()。 */
let unreadable: string | null = null;

export function notesFile(): string {
  return statePath("notes", "bug-notes.json");
}

export function assetsDir(id: string): string {
  return statePath("notes", "assets", id);
}

export function listNotes(): Note[] {
  const res = readJsonChecked<Partial<Store>>(notesFile(), {});
  // 读失败 = 「不知道盘上有什么」，不是「盘上是空的」：记住它，保存一律拒绝（见 save）。
  if (res.ok) unreadable = null;
  else {
    if (res.error !== unreadable) console.error(`[notes] 读不到 ${notesFile()}（${res.error}）；保存会被拒绝，直到下一次能读到`);
    unreadable = res.error ?? "unknown";
  }
  const store = res.value;
  const notes = Array.isArray(store.notes) ? store.notes : [];
  // 改过的排前面（新建 / 编辑都会刷 updatedAt），列表顺序就是 updatedAt 降序。
  return notes
    .filter((n): n is Note => Boolean(n) && typeof (n as Note).id === "string")
    .map((n) => ({ ...n, shots: Array.isArray(n.shots) ? n.shots.filter((s) => typeof s === "string") : [] }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function save(notes: Note[]): Note[] {
  // 读失败时写回，就是把整本记录换成「只看得见这一次编辑」的一页 —— 不可逆，所以宁可不存。
  // 抛出去而不是静默 return：index.ts 的 notes.* 处理器会把 message 回给界面（notes.saved {error}），
  // 用户看得见「这次没存上」；沉默的 return 会让界面显示已保存、重启后消失。
  if (unreadable) throw new Error(`读不到 ${notesFile()}（${unreadable}），这次改动没有保存`);
  writeJson(notesFile(), { version: 1, notes } satisfies Store);
  return listNotes();
}

/** 只认枚举里有的；传了别的就报错，不静默退回默认值（否则打错一个字会悄悄变成 bug / 待处理）。 */
function pick<T extends string>(list: readonly T[], value: unknown, what: string, fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (!list.includes(value as T)) throw new Error(`不认识的 ${what}：${String(value)}`);
  return value as T;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function newId(): string {
  return `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface NoteInput {
  id?: string;
  kind?: NoteKind;
  status?: NoteStatus;
  mode?: NoteMode;
  title?: string;
  body?: string;
  sessionId?: string | null;
  sessionName?: string | null;
  issue?: string;
  commit?: string;
}

/** 新建或就地更新一条；`id` 不在（或已不存在）就当新建。 */
export function saveNote(input: NoteInput): Note {
  const notes = listNotes();
  const at = Date.now();
  const body = text(input.body, MAX_BODY);
  const title = text(input.title, MAX_TITLE).trim() || body.trim().split("\n")[0]?.slice(0, 60) || "未命名";
  const kind = pick(NOTE_KINDS, input.kind, "kind", "bug");
  const mode = pick(NOTE_MODES, input.mode, "mode", "quick");
  const status = pick(NOTE_STATUSES, input.status, "status", "pending");
  const existing = input.id ? notes.find((n) => n.id === input.id) : undefined;
  if (existing) {
    existing.kind = kind;
    existing.mode = mode;
    existing.title = title;
    existing.body = body;
    if (input.issue !== undefined) existing.issue = text(input.issue, 80);
    if (input.commit !== undefined) existing.commit = text(input.commit, 120);
    existing.updatedAt = at;
    save(notes);
    return existing;
  }
  const note: Note = {
    id: newId(),
    kind,
    status,
    mode,
    title,
    body,
    shots: [],
    sessionId: input.sessionId ?? null,
    sessionName: input.sessionName ?? null,
    issue: text(input.issue, 80),
    commit: text(input.commit, 120),
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
  };
  save([note, ...notes]);
  return note;
}

export function setNoteStatus(id: string, status: NoteStatus, patch: { issue?: string; commit?: string } = {}): Note | null {
  const notes = listNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) return null;
  note.status = pick(NOTE_STATUSES, status, "status", note.status);
  if (patch.issue !== undefined) note.issue = text(patch.issue, 80);
  if (patch.commit !== undefined) note.commit = text(patch.commit, 120);
  note.updatedAt = Date.now();
  save(notes);
  return note;
}

/**
 * 归档 / 复原 / 丢垃圾箱。复原一律回到「列表里」，不记「原来是在垃圾箱还是在归档」——
 * 记录不是树，多一层「从哪儿来的」只会在界面上多一条没人看的痕迹。
 */
export function setNoteLife(id: string, life: NoteLife): Note | null {
  const notes = listNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) return null;
  const at = Date.now();
  const want = pick(NOTE_LIVES, life, "life", "active");
  if (want === "active") {
    note.archivedAt = null;
    note.deletedAt = null;
  } else if (want === "archived") {
    note.archivedAt = at;
    note.deletedAt = null;
  } else {
    note.deletedAt = at;
  }
  note.updatedAt = at;
  save(notes);
  return note;
}

/** 清空垃圾箱（或只清一条）。`undefined` 就是「全清」。 */
export function purgeTrash(ids?: string[]): string[] {
  const notes = listNotes();
  const doomed = notes.filter((n) => n.deletedAt && (!ids || ids.includes(n.id)));
  if (!doomed.length) return [];
  save(notes.filter((n) => !doomed.includes(n)));
  for (const n of doomed) {
    try {
      fs.rmSync(assetsDir(n.id), { recursive: true, force: true });
    } catch {
      /* 目录本来就没有 */
    }
  }
  return doomed.map((n) => n.id);
}

/** 删条目连同它的截图目录：截图只属于这一条，留下就是垃圾。 */
export function deleteNote(id: string): boolean {
  const notes = listNotes();
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) return false;
  save(next);
  try {
    fs.rmSync(assetsDir(id), { recursive: true, force: true });
  } catch {
    /* 目录本来就没有 */
  }
  return true;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** `data:image/png;base64,…`（页面里 canvas 出来的就是这个）→ 文件。返回新的截图列表。 */
export function addShot(id: string, dataUrl: string): { shots: string[]; path: string } {
  const m = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) throw new Error("不是图片数据");
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) throw new Error(`不支持的图片类型：${m[1]}`);
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw new Error("图片是空的");
  if (data.length > MAX_SHOT_BYTES) throw new Error(`图片太大（${Math.round(data.length / 1024 / 1024)} MB）`);
  const notes = listNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) throw new Error("这条记录已经不在了");
  if (note.shots.length >= MAX_SHOTS) throw new Error(`一条最多 ${MAX_SHOTS} 张图`);
  const dir = ensureDir(assetsDir(id));
  let n = 1;
  while (fs.existsSync(path.join(dir, `shot-${n}.${ext}`))) n += 1;
  const file = path.join(dir, `shot-${n}.${ext}`);
  fs.writeFileSync(file, data);
  note.shots = [...note.shots, file];
  note.updatedAt = Date.now();
  try {
    save(notes);
  } catch (err) {
    // 索引没写成：图别留在盘上变成没人认领的孤儿（下一次 addShot 还会从 shot-1 重新数）。
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删不掉也只是多一个文件 */
    }
    throw err;
  }
  return { shots: note.shots, path: file };
}

/** 只删这条记录自己的图（别的记录的路径传进来一律不认）。 */
export function removeShot(id: string, file: string): string[] {
  const notes = listNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) throw new Error("这条记录已经不在了");
  const abs = path.resolve(file);
  const dir = path.resolve(assetsDir(id));
  const own = abs.startsWith(dir + path.sep) && note.shots.includes(file);
  note.shots = note.shots.filter((s) => s !== file);
  note.updatedAt = Date.now();
  // 先写索引再删图：反过来一旦保存失败，索引还指着已经不存在的文件（坏缩略图）。
  save(notes);
  if (own) {
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* 已经没了 */
    }
  }
  return note.shots;
}

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

/** 从内网通导入的记录从哪来：卡片在对方历史里的 id + 发送人（#508）。只读展示「来自 …」。 */
export interface NoteOrigin {
  peerEntryId: string;
  nodeId: string;
  nickname: string;
  hostname: string;
  at: number;
}

export interface Note {
  id: string;
  kind: NoteKind;
  status: NoteStatus;
  mode: NoteMode;
  title: string;
  body: string;
  /** 桥这台机器上的绝对路径，按加入顺序。 */
  shots: string[];
  createdAt: number;
  updatedAt: number;
  /** 归档 / 丢进垃圾箱的时间；二者都没有就是正常在列表里。 */
  archivedAt: number | null;
  deletedAt: number | null;
  /** 从内网通「提交给好友」导进来的才有（#508）。 */
  origin?: NoteOrigin;
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
    .map(readNote)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 只读认识的字段：老 JSON 里的 sessionId / sessionName / issue / commit 读到就丢（#514）。 */
function readNote(raw: Note): Note {
  // SAFETY: JSON 读回来的对象没有类型，逐字段按运行时值收窄；下面的 one/str/num 只接受对得上的值。
  const r = raw as unknown as Record<string, unknown>;
  // SAFETY: JSON 来自磁盘，类型只说「大致是 Note」；逐字段读前先当 unknown 校验。
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const one = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
    list.includes(v as T) ? (v as T) : fallback;
  return {
    id: str(r.id),
    kind: one(NOTE_KINDS, r.kind, "bug"),
    status: one(NOTE_STATUSES, r.status, "pending"),
    mode: one(NOTE_MODES, r.mode, "quick"),
    title: str(r.title),
    body: str(r.body),
    shots: Array.isArray(r.shots) ? r.shots.filter((s): s is string => typeof s === "string") : [],
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
    archivedAt: typeof r.archivedAt === "number" ? r.archivedAt : null,
    deletedAt: typeof r.deletedAt === "number" ? r.deletedAt : null,
    ...(readOrigin(r.origin) ? { origin: readOrigin(r.origin) } : {}),
  };
}

/** 只认完整的来源对象，缺字段就当作没有（老 JSON / 半截数据都不该让列表崩）。 */
function readOrigin(raw: unknown): NoteOrigin | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.peerEntryId !== "string" || typeof o.nodeId !== "string") return undefined;
  return {
    peerEntryId: o.peerEntryId,
    nodeId: o.nodeId,
    nickname: typeof o.nickname === "string" ? o.nickname : "",
    hostname: typeof o.hostname === "string" ? o.hostname : "",
    at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
  };
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
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
  };
  save([note, ...notes]);
  return note;
}

export function setNoteStatus(id: string, status: NoteStatus): Note | null {
  const notes = listNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) return null;
  note.status = pick(NOTE_STATUSES, status, "status", note.status);
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

/** 内网通记录包里的截图（文件名 + 字节），导入时按 sha 对过。 */
export interface ImportShot {
  name: string;
  data: Buffer;
}

/**
 * 导入一条记录包（#508）：先生成新 id、截图写进临时目录，全部写完再改名提交；
 * 中途失败只清临时目录，不动现有记录。`createdAt` 用导入时间（发送时间放 origin.at）。
 */
export function importNote(input: { title: string; body: string; kind?: string; shots?: ImportShot[]; origin: NoteOrigin }): Note {
  const notes = listNotes();
  const at = Date.now();
  const body = text(input.body, MAX_BODY);
  const title = text(input.title, MAX_TITLE).trim() || body.trim().split("\n")[0]?.slice(0, 60) || "未命名";
  const kind = pick(NOTE_KINDS, input.kind, "kind", "bug");
  const id = newId();
  const dir = assetsDir(id);
  const tmp = `${dir}.tmp-${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  ensureDir(path.dirname(dir));
  fs.mkdirSync(tmp, { recursive: true });
  const saved: string[] = [];
  try {
    for (const shot of input.shots ?? []) {
      if (saved.length >= MAX_SHOTS) break;
      if (shot.data.length > MAX_SHOT_BYTES) throw new Error(`图片太大（${Math.round(shot.data.length / 1024 / 1024)} MB）`);
      const ext = /^\.[a-z0-9]{1,5}$/i.exec(path.extname(shot.name))?.[0] ?? ".png";
      const name = `shot-${saved.length + 1}${ext.toLowerCase()}`;
      fs.writeFileSync(path.join(tmp, name), shot.data);
      saved.push(path.join(dir, name));
    }
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const note: Note = {
    id,
    kind,
    status: "pending",
    mode: "quick",
    title,
    body,
    shots: saved,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
    origin: input.origin,
  };
  try {
    save([note, ...notes]);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return note;
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

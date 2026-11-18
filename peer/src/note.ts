/** 记录包的载荷与上限（#507）：收 / 发共用，不依赖 Messages 类。 */
import type { NotePayload } from "./history.ts";

/** 记录包一帧的上限（#507）：正文 200 KB + 标题 + 截图清单（文件名与 sha）。 */
export const MAX_NOTE_BYTES = 256 * 1024;
export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BODY = 200_000;
export const MAX_NOTE_SHOTS = 24;

const NOTE_KINDS = ["bug", "change", "idea", "chore"] as const;
const NOTE_STATUSES = ["pending", "done", "dropped"] as const;
const SHA256 = /^[a-f0-9]{64}$/i;

/** 收 / 发两个方向共用：字段不合法就是 400，不进历史、不进补投。 */
export function normalizeNote(raw: unknown): NotePayload {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new Error("bad note");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const body = typeof value.body === "string" ? value.body : "";
  if (title.length > MAX_NOTE_TITLE) throw new Error(`标题太长（上限 ${MAX_NOTE_TITLE} 字）`);
  if (Buffer.byteLength(body, "utf8") > MAX_NOTE_BODY) throw new Error("正文太长（上限 200 KB）");
  const kind = NOTE_KINDS.find((k) => k === value.kind);
  if (!kind) throw new Error("不认识的分类");
  const status = NOTE_STATUSES.find((v) => v === value.status);
  if (!status) throw new Error("不认识的状态");
  const list = Array.isArray(value.shots) ? value.shots : [];
  if (list.length > MAX_NOTE_SHOTS) throw new Error(`截图太多（上限 ${MAX_NOTE_SHOTS} 张）`);
  const shots = list.map((item) => {
    const shot = item as Record<string, unknown> | null;
    const name = typeof shot?.name === "string" ? shot.name.slice(0, 200) : "";
    const size = Number(shot?.size);
    const sha256 = typeof shot?.sha256 === "string" ? shot.sha256.toLowerCase() : "";
    if (!name || !Number.isFinite(size) || size < 0 || !SHA256.test(sha256)) throw new Error("截图清单不合法");
    return { name, size, sha256 };
  });
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const note: NotePayload = {
    title,
    body,
    kind,
    status,
    shots,
    ...(num(value.noteCreatedAt) !== undefined ? { noteCreatedAt: num(value.noteCreatedAt) } : {}),
    ...(num(value.noteUpdatedAt) !== undefined ? { noteUpdatedAt: num(value.noteUpdatedAt) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(note), "utf8") > MAX_NOTE_BYTES) throw new Error("记录包太大（上限 256 KB）");
  return note;
}

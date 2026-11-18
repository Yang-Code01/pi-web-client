/**
 * 内网通「记录包」的桥端逻辑（#507 / #508）。
 *
 * 协议只负责把标题 / 正文 / 截图清单送到对方；截图本体逐张走文件通道，所以卡片和接受
 * 都要先把「清单里的第 i 张」对到「历史里的哪条 file」——这份对齐只在这里做一次，
 * 页面和接受导入共用，避免两边各算一套、算出不同的结果。
 */
import { readJsonChecked, statePath, writeJson } from "./paths.ts";

interface EntryLike {
  id: string;
  at: number;
  kind?: string;
  from?: { nodeId?: string; nickname?: string; hostname?: string };
  note?: { shots?: Array<{ sha256?: string }> };
  file?: { sha256?: string };
}

export interface AcceptedNote {
  noteId: string;
  at: number;
}

/** 接受状态放 sidecar（#508）：peer 的 JSONL 是 append-only，不改写它。 */
export function acceptedFile(): string {
  return statePath("peer", "notes-accepted.json");
}

export function readAccepted(): Record<string, AcceptedNote> {
  const res = readJsonChecked<Record<string, AcceptedNote>>(acceptedFile(), {});
  if (!res.ok || !res.value || typeof res.value !== "object") return {};
  return res.value;
}

export function markAccepted(entryId: string, noteId: string): void {
  const all = readAccepted();
  all[entryId] = { noteId, at: Date.now() };
  writeJson(acceptedFile(), all);
}

/**
 * 把一条记录包的截图清单对到文件条目上。返回与 `note.shots` 等长的数组，`null` = 还没到。
 *
 * 规则（#507）：同一个人发的、在记录包之后到达的、sha 对得上的、还没被更早的记录包认领的。
 * 按历史顺序扫一遍，先到的记录包先认领，避免两张卡抢同一张图。
 */
export function resolveNoteShots(entries: unknown[], noteId: string): Array<string | null> {
  const list = (Array.isArray(entries) ? entries : []) as EntryLike[];
  const note = list.find((e) => e.id === noteId && e.kind === "note");
  if (!note?.note) return [];
  const wanted = note.note.shots ?? [];
  const used = new Set<string>();
  for (const entry of list) {
    if (entry.kind !== "note" || !entry.note) continue;
    const picked: Array<string | null> = [];
    for (const shot of entry.note.shots ?? []) {
      const hit = list.find(
        (file, index) =>
          file.kind === "file" &&
          index > list.indexOf(entry) &&
          file.from?.nodeId === entry.from?.nodeId &&
          file.file?.sha256 === shot.sha256 &&
          !used.has(file.id),
      );
      if (hit) used.add(hit.id);
      picked.push(hit?.id ?? null);
    }
    if (entry.id === noteId) return picked.length === wanted.length ? picked : wanted.map((_, i) => picked[i] ?? null);
  }
  return wanted.map(() => null);
}

/** 给页面用的 note：把 entryId 与已接受状态一起带上（存盘的 JSONL 不动）。 */
export function decorateNotes(entries: unknown[]): unknown[] {
  const list = (Array.isArray(entries) ? entries : []) as Array<EntryLike & { note?: Record<string, unknown> }>;
  const accepted = readAccepted();
  for (const entry of list) {
    if (entry.kind !== "note" || !entry.note) continue;
    const slots = resolveNoteShots(list, entry.id);
    const shots = Array.isArray(entry.note.shots) ? entry.note.shots : [];
    (entry.note as Record<string, unknown>).shots = shots.map((shot, i) => ({ ...(shot as Record<string, unknown>), entryId: slots[i] }));
    (entry.note as Record<string, unknown>).accepted = accepted[entry.id] ?? null;
  }
  return list;
}

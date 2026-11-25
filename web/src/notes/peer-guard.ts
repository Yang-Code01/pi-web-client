/**
 * 「提交给好友」的体积护栏（#663）。
 *
 * 三条上限照抄 `peer/src/note.ts` 的 `MAX_NOTE_TITLE` / `MAX_NOTE_BODY` / `MAX_NOTE_SHOTS`：
 * web 包不能 import peer 包，只能在这里再写一份，改那边时记得同步这边。
 *
 * 为什么只判这三条：三条都在上限内时整帧必然小于 `MAX_NOTE_BYTES`（256 KB）。最坏算过 ——
 * 正文 200 KB + 标题 200 字（UTF-8 约 600 B）+ 24 张清单（文件名 200 字 + sha 64 位 + size
 * 约 700 B × 24 ≈ 17 KB）≈ 217 KB。整帧体积要等每张图的 sha256 才知道，那是
 * `/api/notes/measure` 的活（现在的调用点在选人之后），菜单阶段不为它多跑一遍。
 *
 * 只返回结构、不返回文案：文案是界面的事（`tr()` 在调用方）。
 */

/** 标题按 `String.length`（UTF-16 码元）算，与服务端一致；正文按 UTF-8 字节。 */
export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 200_000;
export const NOTE_SHOTS_MAX = 24;

/** 哪一条超了，以及数值（正文按字节、标题按字、截图按张），给提示文案用。 */
export interface PeerNoteBlock {
  blocked: "body" | "title" | "shots";
  actual: number;
  limit: number;
}

/**
 * 能提交就返回 `null`；否则返回第一条超上限的。
 *
 * 顺序是 正文 → 标题 → 截图：正文是用户能改的那一条，标题多半是保存时从首行推出来的，
 * 先报标题会把人指去改一个他没写过的字段。
 */
export function notePeerGuard(title: string, body: string, shots: number): PeerNoteBlock | null {
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > NOTE_BODY_MAX) return { blocked: "body", actual: bytes, limit: NOTE_BODY_MAX };
  const chars = title.trim().length;
  if (chars > NOTE_TITLE_MAX) return { blocked: "title", actual: chars, limit: NOTE_TITLE_MAX };
  if (shots > NOTE_SHOTS_MAX) return { blocked: "shots", actual: shots, limit: NOTE_SHOTS_MAX };
  return null;
}

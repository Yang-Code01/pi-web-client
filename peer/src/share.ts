/**
 * 共享卡的载荷与上限（D439）：收 / 发共用，不依赖 Messages 类。
 *
 * 卡片只带**清单与截断预览**：文件本体、会话全文、技能压缩包都走文件通道。这样一条
 * 共享进历史也只有几 KB，聊天记录不会因为一次共享膨胀。
 */
import type { SharePayload } from "./history.ts";

/** 一帧共享卡的上限：和记录包同量级（预览 8 KB + 50 条清单绰绰有余）。 */
export const MAX_SHARE_BYTES = 256 * 1024;
export const MAX_SHARE_TITLE = 200;
export const MAX_SHARE_SUMMARY = 600;
/** 卡片上带的正文预览上限：内容类超过它就是截断（卡片上标注），全文请共享成文件。 */
export const MAX_SHARE_BODY = 8 * 1024;
export const MAX_SHARE_FILES = 50;

const TYPES = ["file", "snippet", "skill", "session"] as const;
const ROLES = ["file", "skill", "session"] as const;
const SHA256 = /^[a-f0-9]{64}$/i;

/** 收 / 发两个方向共用：字段不合法就是 400，不进历史、不进补投。 */
export function normalizeShare(raw: unknown): SharePayload {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new Error("bad share");
  const type = TYPES.find((t) => t === value.type);
  if (!type) throw new Error("不认识的共享类型");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title) throw new Error("共享卡缺标题");
  if (title.length > MAX_SHARE_TITLE) throw new Error(`标题太长（上限 ${MAX_SHARE_TITLE} 字）`);
  const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, MAX_SHARE_SUMMARY) : "";
  const body = typeof value.body === "string" ? value.body : "";
  if (Buffer.byteLength(body, "utf8") > MAX_SHARE_BODY) throw new Error("预览太长（上限 8 KB）");
  const list = Array.isArray(value.files) ? value.files : [];
  if (list.length > MAX_SHARE_FILES) throw new Error(`文件太多（上限 ${MAX_SHARE_FILES} 个）`);
  const files = list.map((item) => {
    const file = item as Record<string, unknown> | null;
    const name = typeof file?.name === "string" ? file.name.slice(0, 200) : "";
    const size = Number(file?.size);
    const sha256 = typeof file?.sha256 === "string" ? file.sha256.toLowerCase() : "";
    const role = ROLES.find((r) => r === file?.role) ?? "file";
    if (!name || !Number.isFinite(size) || size < 0 || !SHA256.test(sha256)) throw new Error("文件清单不合法");
    return { name, size, sha256, role };
  });
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const share: SharePayload = {
    type,
    title,
    files,
    ...(summary ? { summary } : {}),
    ...(body ? { body } : {}),
    ...(num(value.bodyBytes) !== undefined ? { bodyBytes: num(value.bodyBytes) } : {}),
    ...(num(value.sourceAt) !== undefined ? { sourceAt: num(value.sourceAt) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(share), "utf8") > MAX_SHARE_BYTES) throw new Error("共享卡太大（上限 256 KB）");
  return share;
}

/** 回执：`ref` 是原共享卡的消息 id，`thread` 是它落在哪个会话（群 id 或发送者 nodeId）。 */
export function normalizeShareAck(raw: unknown): { ref: string; thread: string; at: number } {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new Error("bad share-ack");
  const ref = typeof value.ref === "string" ? value.ref.trim() : "";
  const thread = typeof value.thread === "string" ? value.thread.trim() : "";
  const at = Number(value.at);
  if (!ref || !thread) throw new Error("回执缺字段");
  return { ref, thread, at: Number.isFinite(at) ? at : Date.now() };
}

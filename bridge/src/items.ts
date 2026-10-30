import { extractText, type SessionEntry } from "./sessionfile.ts";

export interface ItemBase {
  id: string;
  ts?: string;
}
export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  images: { mimeType: string; size?: number }[];
}
export interface AssistantItem extends ItemBase {
  kind: "assistant";
  text: string;
  thinking: string;
  model?: string;
  stopReason?: string;
}
export interface ToolItem extends ItemBase {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: unknown;
  partialResult?: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "ok" | "error" | "unknown";
}
export interface NoticeItem extends ItemBase {
  kind: "notice";
  text: string;
  level?: "info" | "warn" | "error";
}
export type Item = UserItem | AssistantItem | ToolItem | NoticeItem;

export function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  const a = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "filePath", "pattern", "query", "url"]) {
    if (typeof a[key] === "string") return String(a[key]);
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return "";
  }
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as any[]) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text") parts.push(String(c.text ?? ""));
    else if (c.type === "image") parts.push("[图片]");
  }
  return parts.join("\n");
}

/** Convert pi session entries (from disk) into renderable items. */
export function entriesToItems(entries: SessionEntry[]): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, ToolItem>();

  for (const entry of entries) {
    if (entry.type === "compaction") {
      items.push({ id: entry.id, kind: "notice", text: "上下文已压缩", level: "info" });
      continue;
    }
    // Model switches are not a transcript event: the composer chip already carries the model
    // (plus context usage, output rate and thinking level), so an inline notice here is noise.
    if (entry.type === "model_change") continue;
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message;
    if (msg.role === "user") {
      const images = Array.isArray(msg.content)
        ? (msg.content as any[])
            .filter((c) => c && c.type === "image")
            .map((c) => ({ mimeType: String(c.mimeType ?? "image/png"), size: undefined }))
        : [];
      items.push({ id: entry.id, ts: entry.timestamp, kind: "user", text: contentText(msg.content), images });
    } else if (msg.role === "assistant") {
      let text = "";
      let thinking = "";
      const calls: any[] = [];
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (!c) continue;
        if (c.type === "text") text += String(c.text ?? "");
        else if (c.type === "thinking") thinking += String(c.thinking ?? "");
        else if (c.type === "toolCall") calls.push(c);
      }
      if (text.trim() || thinking.trim() || calls.length === 0) {
        items.push({ id: entry.id, ts: entry.timestamp, kind: "assistant", text, thinking, model: msg.model, stopReason: msg.stopReason });
      }
      for (const call of calls) {
        const item: ToolItem = {
          id: `${entry.id}:${call.id}`,
          ts: entry.timestamp,
          kind: "tool",
          toolCallId: String(call.id ?? ""),
          name: String(call.name ?? "tool"),
          args: call.arguments,
          status: "unknown",
        };
        toolIndex.set(item.toolCallId, item);
        items.push(item);
      }
    } else if (msg.role === "toolResult") {
      const target = toolIndex.get(String(msg.toolCallId ?? ""));
      if (target) {
        target.result = contentText(msg.content).slice(0, 20000);
        target.isError = Boolean(msg.isError);
        target.status = msg.isError ? "error" : "ok";
      }
    }
  }
  return items;
}

export function userTextOf(entries: SessionEntry[]): string | null {
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "user") {
      const t = extractText(e.message.content).trim();
      if (t) return t.slice(0, 120);
    }
  }
  return null;
}

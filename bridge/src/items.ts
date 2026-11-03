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
  /** pi's AssistantMessage.errorMessage when stopReason is "error" (provider failure, overflow…). */
  errorMessage?: string;
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
/** A command the user ran with `!cmd` / `!!cmd` (pi's RPC `bash`, stored as a bashExecution message). */
export interface BashItem extends ItemBase {
  kind: "bash";
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  /** `!!`: kept in the session, never sent to the model. */
  excludeFromContext?: boolean;
  status: "running" | "done";
  error?: string;
}
export type Item = UserItem | AssistantItem | ToolItem | NoticeItem | BashItem;

/** Output kept for a `!cmd` card (its tail: the end of a long output is what tells you how it went). */
export const BASH_KEEP = 20000;

export function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  const a = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "filePath", "pattern", "query", "url"]) {
    if (typeof a[key] === "string") return String(a[key]);
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
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

/**
 * The branch pi would resume: walk `parentId` up from the last entry (pi re-opens a file with its
 * last line as the leaf, docs/session-format.md; DECISIONS D26). Entries on other branches — left
 * behind by `/tree` or a resumed fork point — are dropped instead of being interleaved by file order.
 *
 * A missing parent (the head of a file read from its tail only) ends the walk there; a parentId
 * cycle (corrupt file) does too. Files whose entries carry no ids at all are returned unchanged.
 */
export function currentBranch(entries: SessionEntry[]): SessionEntry[] {
  if (!entries.length) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) if (e && typeof e.id === "string" && e.id) byId.set(e.id, e);
  const leaf = entries[entries.length - 1];
  if (!byId.size || typeof leaf?.id !== "string" || !leaf.id) return entries;
  // Pre-tree files (no parentId field) are linear by construction.
  if (entries.some((e) => e && !("parentId" in e))) return entries;
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let cur: SessionEntry | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** Convert pi session entries (from disk) into renderable items. */
export function entriesToItems(entries: SessionEntry[]): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, ToolItem>();

  for (const entry of currentBranch(entries)) {
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
        const errorMessage = typeof msg.errorMessage === "string" && msg.errorMessage ? msg.errorMessage : undefined;
        items.push({ id: entry.id, ts: entry.timestamp, kind: "assistant", text, thinking, model: msg.model, stopReason: msg.stopReason, ...(errorMessage ? { errorMessage } : {}) });
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
    } else if (msg.role === "bashExecution") {
      items.push({
        id: entry.id,
        ts: entry.timestamp,
        kind: "bash",
        command: String(msg.command ?? ""),
        output: String(msg.output ?? "").slice(-BASH_KEEP),
        exitCode: typeof msg.exitCode === "number" ? msg.exitCode : null,
        cancelled: Boolean(msg.cancelled),
        truncated: Boolean(msg.truncated),
        ...(typeof msg.fullOutputPath === "string" ? { fullOutputPath: msg.fullOutputPath } : {}),
        excludeFromContext: Boolean(msg.excludeFromContext),
        status: "done",
      });
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

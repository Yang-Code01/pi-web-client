import path from "node:path";
import { skillOfRead, type SkillEntry } from "./skills.ts";
import { extractText, skillExpansion, type SessionEntry } from "./sessionfile.ts";
import type { PlanSnapshot } from "./execplan.ts";

export interface ItemBase {
  id: string;
  ts?: string;
}
export interface UserItem extends ItemBase {
  kind: "user";
  /** Display text: a `/skill:<name> args` call reaches the file expanded and is folded back here. */
  text: string;
  /** Set when the message was a `/skill:<name>` call — the web client draws a chip for it. */
  skill?: string;
  /** The SKILL.md path pi wrote into the block (`location`), for the chip's tooltip. */
  skillPath?: string;
  images: { mimeType: string; size?: number }[];
  /**
   * #197: 启动期发出的消息在桥里的位置。`booting` 是「收了、还没交给 pi」，`sent` 是「交出去了」
   * （气泡上那枚「处理中…」由前端按运行态推，不再看这个字段），`failed` 是「没交出去」。
   * 正常（pi 已经在跑）发出的消息不带这个字段。
   */
  pending?: "booting" | "sent" | "failed";
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
  /** Snapshot after a todo update; null explicitly records a cleared plan. */
  plan?: PlanSnapshot | null;
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
  /** `queued`: 启动窗口里敲下的，还在等 pi 起来（D183）。 */
  status: "queued" | "running" | "done";
  error?: string;
}
/**
 * Text pi put into the context that is neither the user's nor the model's: a compaction summary,
 * the summary of a branch left behind by /tree, or a message an extension injected (#31).
 */
export interface SummaryItem extends ItemBase {
  kind: "summary";
  variant: "compaction" | "branch" | "custom";
  title: string;
  text: string;
}
/**
 * 模型自己加载了一个技能（隐式触发）：它在 `read` 里直接读了 SKILL.md。名字与一句话描述来自
 * frontmatter，`why` 是它读之前自己说的那句（没说话就用本轮用户消息）—— 记录里没有「动机」这个字段，
 * 这两样是能找到的最接近的东西，所以卡片说的是「触发线索」，不是「因为」。
 */
export interface SkillItem extends ItemBase {
  kind: "skill";
  name: string;
  description: string;
  /** 一句话理由的原文（已压成一行并截断）。 */
  why?: string;
  /** `model` = 它读之前说的那句；`user` = 退回本轮用户消息。 */
  whyFrom?: "model" | "user";
  /** SKILL.md 的绝对路径，卡上的「SKILL.md」出口用它。 */
  path?: string;
}
export type Item = UserItem | AssistantItem | ToolItem | SkillItem | NoticeItem | BashItem | SummaryItem;

/** 一行化：卡片正文只占一行，换行与缩进会把高度撑开。 */
export function oneLine(text: string, max = 120): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 技能卡：只在本轮（最后一条 user 之后）没画过同名卡时才给一张。
 * `items` 是「到目前为止」的画布，插卡就把结果写回去，下一张卡自然能在里面看到去重结果。
 */
export function skillItemFor(
  items: Item[],
  skills: SkillEntry[],
  call: { name?: string; args?: unknown },
  cwd?: string,
): SkillItem | undefined {
  const hit = skillOfRead(skills, call.name, call.args, cwd);
  if (!hit) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    if (it.kind === "skill" && it.name === hit.name) return undefined;
  }
  // 理由一律从「已经画到画布上」的本轮条目里取：实时与回放走同一段扫描，刷新前后不会变词。
  const fromModel = turnAssistantText(items);
  const why = fromModel || turnUserText(items);
  return {
    id: `skill:${hit.name}`,
    kind: "skill",
    name: hit.name,
    description: hit.description,
    path: path.join(hit.path, "SKILL.md"),
    ...(why ? { why, whyFrom: fromModel ? "model" : "user" } : {}),
  };
}

/** 本轮里模型最近说的一句（看完工具结果又说话也照取最近一条）。 */
function turnAssistantText(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return "";
    if (it.kind === "assistant") {
      const line = oneLine(it.text);
      if (line) return line;
    }
  }
  return "";
}

/** 本轮的起点（最后一条 user）之后那句用户原话。 */
function turnUserText(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return oneLine(it.text);
  }
  return "";
}

/**
 * 回放：磁盘上没有任何「我用了技能」的记录，唯一的痕迹是 `read …\SKILL.md` 这个工具调用。
 * 把卡插在那个 read 之前（客户端收到第一张工具卡才建 ops 模块，所以卡会落在模块上面），
 * 一轮一个技能一张；去重与理由都由 `skillItemFor` 从画布回扫得出，与实时路径同一段代码。
 */
export function withSkillItems(items: Item[], skills: SkillEntry[], cwd?: string): Item[] {
  if (!skills.length) return items;
  const out: Item[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const card = skillItemFor(out, skills, { name: item.name, args: item.args }, cwd);
      if (card) out.push({ ...card, id: `${item.id}:skill`, ts: item.ts });
    }
    out.push(item);
  }
  return out;
}

/** A custom (extension) message, if pi would show it: `display:false` ones stay hidden, like in the TUI. */
export function customMessageItem(id: string, ts: string | undefined, raw: any): SummaryItem | null {
  if (!raw || raw.display === false) return null;
  const text = contentText(raw.content).trim();
  if (!text) return null;
  return { id, ts, kind: "summary", variant: "custom", title: `扩展消息 · ${String(raw.customType ?? "custom")}`, text: text.slice(0, BASH_KEEP) };
}

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
export function entriesToItems(entries: SessionEntry[], todoSnapshots?: Map<string, PlanSnapshot | null>): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, ToolItem>();

  for (const entry of currentBranch(entries)) {
    if (entry.type === "compaction") {
      const before = typeof entry.tokensBefore === "number" ? `（压缩前约 ${Math.round(entry.tokensBefore / 1000)}K token）` : "";
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (summary.trim()) items.push({ id: entry.id, ts: entry.timestamp, kind: "summary", variant: "compaction", title: `上下文已压缩${before}`, text: summary });
      else items.push({ id: entry.id, kind: "notice", text: `上下文已压缩${before}`, level: "info" });
      continue;
    }
    if (entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (summary.trim()) items.push({ id: entry.id, ts: entry.timestamp, kind: "summary", variant: "branch", title: "另一条分支的摘要（/tree 切换分支时生成）", text: summary });
      continue;
    }
    if (entry.type === "custom_message") {
      const item = customMessageItem(entry.id, entry.timestamp, entry);
      if (item) items.push(item);
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
      const fullText = contentText(msg.content);
      // Parse the text parts only: `contentText` appends `[图片]` per image, which is not user prose
      // and would otherwise become the command's args (the image notice already says it).
      const skill = skillExpansion(extractText(msg.content));
      items.push({
        id: entry.id,
        ts: entry.timestamp,
        kind: "user",
        text: skill?.command ?? fullText,
        images,
        ...(skill ? { skill: skill.name } : {}),
        ...(skill?.location ? { skillPath: skill.location } : {}),
      });
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
    } else if (msg.role === "custom") {
      const item = customMessageItem(entry.id, entry.timestamp, msg);
      if (item) items.push(item);
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
        if (target.name === "todo" && todoSnapshots?.has(target.toolCallId)) target.plan = todoSnapshots.get(target.toolCallId) ?? null;
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

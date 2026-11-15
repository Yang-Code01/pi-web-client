/**
 * Context panel logging (#384), the web client's take on dsh-context's core value.
 *
 * pi's `get_session_stats` reports the *total* context tokens but never *what* the context is made
 * of. This companion extension rides pi's hooks and appends one JSON line per observation to a
 * per-session file under the bridge's state dir. The bridge tails that file and the web's Context
 * panel renders it (stats / token split / timing / current context / trend / browser / events /
 * file activity / command activity). Five kinds of lines share one `seq`:
 *   request   `context_with_system`, right before every LLM call: category totals plus a compact
 *             snapshot of the header and the context items (previews only, never full bodies)
 *   usage     `message_end` for an assistant message: provider usage for the request before it
 *   event     `session_compact` / `session_compact_failed` / `model_select` / `inject`
 *   activity  `tool_execution_end`: every tool call; file and shell calls keep extra metadata
 *
 * Token estimation is the same heuristic the web HUD already uses for turn chars: CJK chars ÷ 1.5,
 * everything else ÷ 4. It is an estimate — the provider's own usage numbers remain the source of
 * truth for totals (`stats` WS message); this file is the only source for the *split*.
 *
 * Privacy: activity lines never store a command's full text nor a tool's output. Shell commands
 * are reduced to the program name; file lines store the path, the operation and line deltas.
 * Context item previews are clipped to 160 characters; they exist so the browser can show what a
 * row *is*, not to mirror the transcript.
 *
 * Written by the bridge with LOG_DIR filled in (pisettings.ts install pattern, same as
 * session-lock.ts). Never throws: logging must not break the pi it rides on.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR: string = "__LOG_DIR__";
const VERSION = 2;
const MAX_PATH = 240;
const MAX_PREVIEW = 160;
const MAX_ITEMS = 400;
const MAX_TOOLS = 80;
const MAX_SECTIONS = 24;

type Cat = "sys" | "tools" | "user" | "inject" | "skill" | "asst" | "toolr";

interface Item {
  id: string;
  cat: Cat;
  label: string;
  tokens: number;
  kind?: string;
  sub?: string;
  preview?: string;
}

interface Cats {
  sys: number;
  tools: number;
  user: number;
  inject: number;
  skill: number;
  asst: number;
  toolr: number;
}

interface Split {
  reasoning: number;
  answer: number;
  calls: number;
}

/** CJK ÷ 1.5, others ÷ 4 — the web HUD heuristic (app.ts turnChars). */
function estTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK unified
      (c >= 0x3040 && c <= 0x30ff) || // kana
      (c >= 0xac00 && c <= 0xd7af) || // hangul
      (c >= 0xf900 && c <= 0xfaff)
    )
      cjk++;
  }
  return Math.round(cjk / 1.5 + (text.length - cjk) / 4);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function countLines(s: unknown): number {
  return typeof s === "string" && s ? s.split("\n").length : 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (typeof (b as any).text === "string") out += (b as any).text;
    else if (typeof (b as any).thinking === "string") out += (b as any).thinking;
  }
  return out;
}

function oneLine(s: string): string {
  return clip(s.replace(/\s+/g, " ").trim(), MAX_PREVIEW);
}

/** FNV-1a — stable fallback identity when a message carries no timestamp. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function messageKey(msg: any, index: number): string {
  const ts = msg?.timestamp ?? msg?.time;
  const role = String(msg?.role ?? "unknown");
  if (typeof ts === "number" || typeof ts === "string") return `${role}:${ts}`;
  if (msg?.toolCallId) return `${role}:${msg.toolCallId}`;
  return `${role}:${index}:${hash32(textOf(msg?.content))}`;
}

function toolTokens(tool: any): number {
  if (!tool) return 0;
  const parts = [String(tool.name ?? ""), typeof tool.description === "string" ? tool.description : ""];
  try {
    parts.push(JSON.stringify(tool.parameters ?? tool.inputSchema ?? {}));
  } catch {
    /* unserializable schema: name+description still count */
  }
  return estTokens(parts.join("\n"));
}

function argTokens(args: unknown): number {
  if (args == null) return 0;
  try {
    return estTokens(typeof args === "string" ? args : JSON.stringify(args));
  } catch {
    return 0;
  }
}

interface BlockInfo {
  kind: "text" | "thinking" | "toolCall" | "image" | "other";
  tokens: number;
  /** Full-ish text used only to estimate tokens; never written as-is for tools. */
  text: string;
  /** Privacy-safe preview written to the ctxlog item. */
  preview: string;
  toolName?: string;
  toolCallId?: string;
}

function blockInfo(b: any): BlockInfo {
  if (!b || typeof b !== "object") return { kind: "other", tokens: 0, text: "", preview: "" };
  if (b.type === "text") {
    const text = typeof b.text === "string" ? b.text : "";
    return { kind: "text", tokens: estTokens(text), text, preview: text };
  }
  if (b.type === "thinking" || b.type === "reasoning") {
    const text = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
    return { kind: "thinking", tokens: estTokens(text), text, preview: text };
  }
  if (b.type === "toolCall" || b.type === "tool_call") {
    const name = String(b.name ?? b.tool ?? b.toolName ?? "tool");
    const args = b.arguments ?? b.args ?? b.input ?? {};
    let keys = "";
    try {
      keys = args && typeof args === "object" ? Object.keys(args).slice(0, 6).join(", ") : "";
    } catch {
      keys = "";
    }
    // Never write command lines / file bodies into the preview; keys are enough to identify the call.
    return {
      kind: "toolCall",
      tokens: estTokens(name) + argTokens(args),
      text: name,
      preview: keys ? `${name}(${keys})` : name,
      toolName: name,
      toolCallId: typeof b.id === "string" ? b.id : typeof b.toolCallId === "string" ? b.toolCallId : undefined,
    };
  }
  if (b.type === "image") return { kind: "image", tokens: 1200, text: "", preview: "image" };
  let text = "";
  try {
    text = JSON.stringify(b);
  } catch {
    /* ignore */
  }
  return { kind: "other", tokens: text ? estTokens(text) : 0, text, preview: "" };
}

function contentBlocks(msg: any): BlockInfo[] {
  const content = msg?.content;
  if (typeof content === "string") return [{ kind: "text", tokens: estTokens(content), text: content, preview: content }];
  if (!Array.isArray(content)) return [];
  return content.map(blockInfo);
}

/** A message's category (non-system roles). */
function roleCat(role: string): Cat {
  if (role === "user") return "user";
  if (role === "assistant") return "asst";
  if (role === "toolResult" || role === "bashExecution") return "toolr";
  return "inject"; // custom / branchSummary / compactionSummary / future roles
}

/** System prompt sections: what is the prompt, what is injected context, what is skills. */
const SECTION_CAT: Record<string, Cat> = {
  preamble: "sys",
  tools: "sys",
  rules: "inject",
  docs: "inject",
  addendum: "inject",
  project_context: "inject",
  cwd: "inject",
  skills: "skill",
};

const SECTION_LABEL: Record<string, string> = {
  preamble: "system",
  tools: "tools-section",
  rules: "rules",
  docs: "docs",
  addendum: "addendum",
  project_context: "project-context",
  cwd: "cwd",
  skills: "skills",
};

/** Shell command → program name only. Never persist the full command line. */
function programOf(command: unknown): string {
  const raw = typeof command === "string" ? command.trim() : "";
  if (!raw) return "?";
  const parts = raw.split(/\s+/).filter(Boolean);
  while (parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]) || ["sudo", "env", "time", "nohup"].includes(parts[0]))) parts.shift();
  const first = (parts[0] ?? "?").replace(/^["']|["']$/g, "");
  return clip(first.split(/[\\/]/).pop() || first, 48);
}

/** pi's built-in file tools → the operation the Context panel aggregates by. */
const FILE_TOOLS: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  grep: "search",
  find: "search",
  ls: "search",
  glob: "search",
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

export default function contextLog(pi: any): void {
  let file: string | null = null;
  let seq = 0;
  let lastRequestSeq = 0;
  let requestStartedAt = 0;
  let currentModel = "";
  let turn = 0;
  let step = 0;
  let lastUserKey = "";
  const seenSections = new Map<string, string>();
  /** toolCallId → what `tool_execution_start` saw; `end` sometimes omits toolName / args. */
  const pending = new Map<string, { toolName: string; args: any; parent: boolean; start: number }>();

  const line = (obj: Record<string, unknown>): number => {
    const at = ++seq;
    if (!file) return at;
    try {
      const { v: _v, seq: _s, ts: _t, ...rest } = obj;
      void _v;
      void _s;
      void _t;
      fs.appendFileSync(file, `${JSON.stringify({ v: VERSION, seq: at, ts: Date.now(), ...rest })}\n`);
    } catch {
      /* logging must never break the ride */
    }
    return at;
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    file = null;
    seq = 0;
    lastRequestSeq = 0;
    requestStartedAt = 0;
    currentModel = "";
    turn = 0;
    step = 0;
    lastUserKey = "";
    seenSections.clear();
    pending.clear();
    try {
      const id = String(ctx.sessionManager?.getSessionId?.() ?? "");
      if (!id) return;
      const dir = path.join(LOG_DIR, id.slice(0, 8));
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${id}.ctx.jsonl`);
    } catch {
      file = null;
    }
  });

  pi.on("session_shutdown", async () => {
    file = null;
    pending.clear();
  });

  pi.on("context_with_system", async (event: any, ctx: any) => {
    if (!file) return;
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];

    const cats: Cats = { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, asst: 0, toolr: 0 };
    const split: Split = { reasoning: 0, answer: 0, calls: 0 };
    const roleCounts: Record<string, number> = {};
    const perMessage: Array<{ role: string; tokens: number; blocks: number; toolCalls: number }> = [];
    const items: Item[] = [];
    const headerSystem: Item[] = [];
    const headerTools: Item[] = [];
    let m = 0;
    let users = 0;
    let lastUserText = "";
    const injections: Array<{ label: string; tokens: number }> = [];

    for (const msg of messages) {
      m++;
      const role = String(msg?.role ?? "unknown");
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      if (role === "user") {
        users++;
        lastUserText = textOf(msg?.content);
      }

      if (role === "system") {
        let total = 0;
        const sections = msg?.sections;
        if (sections && typeof sections === "object") {
          const keys = Object.keys(sections).slice(0, MAX_SECTIONS);
          for (const key of keys) {
            const raw = (sections as Record<string, unknown>)[key];
            const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
            const tokens = estTokens(text);
            const cat = SECTION_CAT[key] ?? "inject";
            cats[cat] += tokens;
            total += tokens;
            if (tokens > 0) {
              const item: Item = {
                id: `sec:${key}`,
                cat,
                label: SECTION_LABEL[key] ?? key,
                tokens,
                kind: "section",
                preview: oneLine(text),
              };
              items.push(item);
              headerSystem.push(item);
              // A changed non-prompt section is an injection event: the dashboard lists it next
              // to compaction / model switches instead of making the reader diff the prompt.
              if (key !== "preamble" && key !== "tools") {
                const digest = hash32(`${key}\n${text}`);
                if (seenSections.get(key) !== digest) injections.push({ label: SECTION_LABEL[key] ?? key, tokens });
                seenSections.set(key, digest);
              }
            }
          }
        }
        const contentText = typeof msg?.content === "string" ? msg.content : "";
        if (contentText) {
          const tokens = estTokens(contentText);
          cats.sys += tokens;
          total += tokens;
          const item: Item = {
            id: "sec:content",
            cat: "sys",
            label: "system",
            tokens,
            kind: "section",
            preview: oneLine(contentText),
          };
          items.push(item);
          headerSystem.push(item);
        } else if (Array.isArray(msg?.content)) {
          // Some hosts pass the system prompt as content blocks instead of `sections`.
          contentBlocks(msg).forEach((b, bi) => {
            if (!b.tokens) return;
            cats.sys += b.tokens;
            total += b.tokens;
            const item: Item = {
              id: `sec:content:b${bi}`,
              cat: "sys",
              label: "system",
              tokens: b.tokens,
              kind: "section",
              preview: oneLine(b.text),
            };
            items.push(item);
            headerSystem.push(item);
          });
        }
        for (const tool of Array.isArray(msg?.toolsAdded) ? msg.toolsAdded : []) {
          const tokens = toolTokens(tool);
          cats.tools += tokens;
          total += tokens;
          const name = String(tool?.name ?? "tool");
          const item: Item = {
            id: `tool:${name}`,
            cat: "tools",
            label: name,
            tokens,
            kind: "tool",
            sub: clip(String(tool?.description ?? ""), 90),
            preview: clip(String(tool?.description ?? ""), MAX_PREVIEW),
          };
          items.push(item);
          headerTools.push(item);
        }
        perMessage.push({ role, tokens: total, blocks: 1, toolCalls: 0 });
        continue;
      }

      const blocks = contentBlocks(msg);
      let msgTotal = 0;
      let toolCalls = 0;
      const base = messageKey(msg, m);
      blocks.forEach((b, bi) => {
        msgTotal += b.tokens;
        let cat = roleCat(role);
        let kind: string = b.kind;
        let label = role;
        let sub: string | undefined;
        if (role === "assistant") {
          if (b.kind === "thinking") {
            split.reasoning += b.tokens;
            kind = "reasoning";
            label = "thinking";
          } else if (b.kind === "toolCall") {
            split.calls += b.tokens;
            toolCalls++;
            kind = "call";
            label = b.toolName ?? "toolCall";
            sub = "call";
          } else {
            split.answer += b.tokens;
            kind = "answer";
            label = "assistant";
          }
        } else if (role === "toolResult" || role === "bashExecution") {
          cat = "toolr";
          kind = "result";
          label = String(msg?.toolName ?? "result");
        } else if (role === "user") {
          cat = "user";
          kind = "user";
          label = "user";
        } else {
          cat = "inject";
          kind = "inject";
          label = String(msg?.customType ?? msg?.source ?? "inject");
        }
        cats[cat] += b.tokens;
        const item: Item = {
          id: `${base}:b${bi}`,
          cat,
          label,
          tokens: b.tokens,
          kind,
          ...(sub ? { sub } : {}),
          preview: oneLine(b.preview || b.text),
        };
        if (b.kind === "image") item.preview = "image";
        if (role === "toolResult" || role === "bashExecution") item.preview = String(msg?.toolName ?? "result");
        items.push(item);
      });
      if (!blocks.length) {
        // A message with no content is still one row in the browser (e.g. an empty custom notice).
        const cat = roleCat(role);
        items.push({ id: `${base}:empty`, cat, label: role, tokens: 0, kind: "empty" });
      }
      perMessage.push({ role, tokens: msgTotal, blocks: Math.max(1, blocks.length), toolCalls });
    }

    // turn/step: a new last-user message opens a turn; every request is one step.
    const userKey = `${users}:${clip(lastUserText, 200)}`;
    if (userKey !== lastUserKey) {
      lastUserKey = userKey;
      turn++;
      step = 1;
    } else {
      step++;
    }

    const total = cats.sys + cats.tools + cats.user + cats.inject + cats.skill + cats.asst + cats.toolr;
    const keptItems = items.slice(-MAX_ITEMS);
    const keptTools = headerTools.slice(0, MAX_TOOLS);
    requestStartedAt = Date.now();

    lastRequestSeq = line({
      kind: "request",
      cwd: ctx?.cwd ?? null,
      model: currentModel,
      turn,
      step,
      users,
      total,
      cats,
      split,
      messages: m,
      roles: roleCounts,
      perMessage: perMessage.slice(-MAX_ITEMS),
      perMessageOmitted: Math.max(0, perMessage.length - MAX_ITEMS),
      items: keptItems,
      itemsOmitted: Math.max(0, items.length - keptItems.length),
      header: {
        system: headerSystem.slice(0, MAX_SECTIONS),
        tools: keptTools,
        toolsOmitted: Math.max(0, headerTools.length - keptTools.length),
      },
    });
    for (const inj of injections) {
      line({ kind: "event", event: "inject", label: inj.label, tokens: inj.tokens, atSeq: lastRequestSeq });
    }
    // Return nothing: this hook only observes; the transcript goes out unchanged.
    return undefined;
  });

  // ---- Provider usage for the request above. `message_end` is the authoritative assistant message;
  // `usage` is where the provider's billed numbers live. Keep only numbers, never message content.
  pi.on("message_end", async (event: any) => {
    if (!file) return;
    const msg = event?.message;
    if (msg?.role === "custom") {
      line({
        kind: "event",
        event: "inject",
        label: String(msg?.customType ?? msg?.source ?? "custom"),
        tokens: estTokens(textOf(msg?.content)),
        atSeq: lastRequestSeq,
      });
      return;
    }
    if (msg?.role !== "assistant" || !lastRequestSeq) return;
    if (typeof msg?.model === "string" && msg.model) currentModel = msg.model;
    const u = msg?.usage ?? {};
    const usage = {
      input: num(u.input),
      output: num(u.output),
      cacheRead: num(u.cacheRead),
      cacheWrite: num(u.cacheWrite),
      reasoning: num(u.reasoning),
      totalTokens: num(u.totalTokens ?? u.total),
    };
    const out: Split = { reasoning: 0, answer: 0, calls: 0 };
    for (const b of contentBlocks(msg)) {
      if (b.kind === "thinking") out.reasoning += b.tokens;
      else if (b.kind === "toolCall") out.calls += b.tokens;
      else if (b.kind === "text") out.answer += b.tokens;
    }
    // `AssistantMessage` carries its own `timestamp` (request start) and `durationMs` (final
    // response duration); these are fields on the finalized message, not on the JSON event
    // envelope. If an older provider/legacy message lacks durationMs, fall back to the elapsed
    // wall time from our own request hook so the timing card never collapses to zero.
    const started = typeof msg?.timestamp === "number" ? msg.timestamp : requestStartedAt;
    const waitMs = requestStartedAt > 0 ? Math.max(0, Math.round(started - requestStartedAt)) : 0;
    const elapsed = requestStartedAt > 0 ? Math.max(0, Math.round(Date.now() - requestStartedAt)) : 0;
    line({
      kind: "usage",
      atSeq: lastRequestSeq,
      model: String(msg?.model ?? currentModel),
      stopReason: String(msg?.stopReason ?? ""),
      durationMs: num(msg?.durationMs) || elapsed,
      waitMs,
      usage,
      out,
    });
  });

  // ---- Explicit events. `atSeq` ties the event to the request it happened after, so the web
  // can put the ✂ marker on the very next request column instead of guessing from a token drop.
  pi.on("session_compact", async (event: any) => {
    if (!file) return;
    const before = Number(event?.compactionEntry?.tokensBefore);
    line({
      kind: "event",
      event: "compact",
      reason: typeof event?.reason === "string" ? event.reason : "manual",
      before: Number.isFinite(before) ? Math.round(before) : undefined,
      atSeq: lastRequestSeq,
      willRetry: !!event?.willRetry,
    });
  });

  pi.on("session_compact_failed", async (event: any) => {
    if (!file) return;
    line({
      kind: "event",
      event: "compact_failed",
      reason: typeof event?.reason === "string" ? event.reason : "manual",
      aborted: !!event?.aborted,
      atSeq: lastRequestSeq,
      willRetry: !!event?.willRetry,
    });
  });

  pi.on("model_select", async (event: any) => {
    if (!file) return;
    const next = String(event?.model?.id ?? event?.model?.name ?? "");
    if (next) currentModel = next;
    line({
      kind: "event",
      event: "model",
      model: next,
      previous: String(event?.previousModel?.id ?? event?.previousModel?.name ?? ""),
      atSeq: lastRequestSeq,
    });
  });

  // ---- Activity. `tool_execution_end` fires for every finalized call (even blocked/error ones),
  // so one line per call. Commands keep only the program name; no output, no full command text.
  pi.on("tool_execution_start", async (event: any) => {
    if (!file) return;
    const id = String(event?.toolCallId ?? "");
    if (!id) return;
    pending.set(id, {
      toolName: String(event?.toolName ?? ""),
      args: event?.args ?? {},
      parent: !!event?.parentToolCallId,
      start: Date.now(),
    });
  });

  pi.on("tool_execution_end", async (event: any) => {
    const id = String(event?.toolCallId ?? "");
    const started = pending.get(id);
    pending.delete(id);
    if (!file || !started) return;
    const name = String(event?.toolName ?? started.toolName ?? "");
    const common: Record<string, unknown> = {
      status: event?.isError ? "failed" : "ok",
      atSeq: lastRequestSeq,
    };
    if (typeof event?.durationMs === "number") common.durationMs = Math.round(event.durationMs);
    if (started.parent) common.parent = true;

    if (name === "skill") {
      line({
        kind: "event",
        event: "inject",
        label: `skill:${String(started.args?.name ?? started.args?.skill ?? "skill")}`,
        tokens: 0,
        atSeq: lastRequestSeq,
      });
    }

    if (name === "bash" || name === "powershell" || name === "user_bash") {
      line({ kind: "activity", activity: "command", tool: clip(name, 48), program: programOf(started.args?.command), ...common });
      return;
    }
    const op = FILE_TOOLS[name];
    if (!op) {
      // Every other tool still counts toward the tool ledger, even when it touches no file.
      line({ kind: "activity", activity: "tool", tool: clip(name || "?", 64), ...common });
      return;
    }
    const args = started.args ?? {};
    const p = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
    let added = 0;
    let removed = 0;
    if (op === "write") added = countLines(args.content);
    else if (op === "edit") {
      // pi 的 edit 工具用 edits[]；别的扩展也可能用顶层 oldText/newText。两种形状互斥，
      // 同时出现时只认 edits[]，避免同一处改动被数两遍。
      if (Array.isArray(args.edits)) {
        for (const e of args.edits) {
          removed += countLines(e?.oldText);
          added += countLines(e?.newText);
        }
      } else {
        removed = countLines(args.oldText);
        added = countLines(args.newText);
      }
    }
    line({ kind: "activity", activity: "file", tool: clip(name, 48), op, path: clip(p || "?", MAX_PATH), added, removed, ...common });
  });
}

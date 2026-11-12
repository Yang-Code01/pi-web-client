/**
 * Context panel logging (#384), the web client's take on dsh-context's core value.
 *
 * pi's `get_session_stats` reports the *total* context tokens but never *what* the context is made
 * of. This companion extension rides pi's hooks and appends one JSON line per observation to a
 * per-session file under the bridge's state dir. The bridge tails that file and the web's Context
 * sheet renders it (KPI row / composition detail / per-request trend / events / file activity /
 * command activity). Three kinds of lines share one `seq`:
 *   request   `context_with_system`, right before every LLM call: six-category composition
 *   event     `session_compact` / `session_compact_failed` / `model_select`: explicit events,
 *             instead of guessing compaction from a drop in the estimated total
 *   activity  `tool_execution_end`: file operations and shell commands, metadata only
 *
 * Token estimation is the same heuristic the web HUD already uses for turn chars: CJK chars ÷ 1.5,
 * everything else ÷ 4. It is an estimate — the provider's own usage numbers remain the source of
 * truth for totals (`stats` WS message); this file is the only source for the *split*.
 *
 * Privacy: activity lines never store a command's full text nor a tool's output. Shell commands
 * are reduced to the program name; file lines store the path, the operation and line deltas.
 *
 * Written by the bridge with LOG_DIR filled in (pisettings.ts install pattern, same as
 * session-lock.ts). Never throws: logging must not break the pi it rides on.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR: string = "__LOG_DIR__";
const VERSION = 1;
const MAX_PATH = 240;

interface Textish {
  text?: string;
  type?: string;
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

function blockText(b: Textish | undefined): string {
  if (!b) return "";
  if (typeof b.text === "string") return b.text;
  return "";
}

/** Sum estimated tokens of every text-bearing block of a message. */
function msgTokens(msg: any): { tokens: number; chars: number; toolCalls: number } {
  let tokens = 0;
  let chars = 0;
  let toolCalls = 0;
  const content = msg?.content;
  if (typeof content === "string") {
    tokens += estTokens(content);
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const b of content as Textish[]) {
      if (b?.type === "image") {
        tokens += 1200; // images are priced by the provider, not by chars; rough placeholder
        continue;
      }
      const t = blockText(b);
      if (t) {
        tokens += estTokens(t);
        chars += t.length;
      }
      if (b?.type === "toolCall") toolCalls++;
    }
  }
  return { tokens, chars, toolCalls };
}

/** A Tool declaration: name + description + JSON schema, as the provider serializes it. */
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

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function countLines(s: unknown): number {
  return typeof s === "string" && s ? s.split("\n").length : 0;
}

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

export default function contextLog(pi: any): void {
  let file: string | null = null;
  let seq = 0;
  let lastRequestSeq = 0;
  /** toolCallId → what `tool_execution_start` saw; `end` sometimes omits toolName / args. */
  const pending = new Map<string, { toolName: string; args: any; parent: boolean }>();

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

    const cats = { sys: 0, tools: 0, user: 0, inject: 0, asst: 0, toolr: 0 };
    const perMessage: Array<{ role: string; tokens: number; blocks: number; toolCalls: number }> = [];
    let m = 0;
    for (const msg of messages) {
      m++;
      const role = String(msg?.role ?? "unknown");
      if (role === "system") {
        const st = msgTokens(msg);
        cats.sys += st.tokens;
        for (const t of msg?.toolsAdded ?? []) cats.tools += toolTokens(t);
        perMessage.push({ role, tokens: st.tokens, blocks: 1, toolCalls: 0 });
        continue;
      }
      const mt = msgTokens(msg);
      if (role === "user") cats.user += mt.tokens;
      else if (role === "assistant") cats.asst += mt.tokens;
      else if (role === "toolResult" || role === "bashExecution") cats.toolr += mt.tokens;
      else cats.inject += mt.tokens; // custom / branchSummary / compactionSummary / future roles
      perMessage.push({ role, tokens: mt.tokens, blocks: Array.isArray(msg?.content) ? msg.content.length : 1, toolCalls: mt.toolCalls });
    }

    const total = cats.sys + cats.tools + cats.user + cats.inject + cats.asst + cats.toolr;
    lastRequestSeq = line({
      kind: "request",
      cwd: ctx?.cwd ?? null,
      total,
      cats,
      messages: m,
      perMessage,
    });
    // Return nothing: this hook only observes; the transcript goes out unchanged.
    return undefined;
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
    line({
      kind: "event",
      event: "model",
      model: String(event?.model?.id ?? event?.model?.name ?? ""),
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

    if (name === "bash" || name === "powershell" || name === "user_bash") {
      line({ kind: "activity", activity: "command", program: programOf(started.args?.command), ...common });
      return;
    }
    const op = FILE_TOOLS[name];
    if (!op) return;
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
    line({ kind: "activity", activity: "file", op, path: clip(p || "?", MAX_PATH), added, removed, ...common });
  });
}

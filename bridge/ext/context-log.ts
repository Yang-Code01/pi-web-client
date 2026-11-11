/**
 * Context panel logging (#384), the web client's take on dsh-context's core value.
 *
 * pi's `get_session_stats` reports the *total* context tokens but never *what* the context is made
 * of. This companion extension rides the `context_with_system` hook — it fires before every LLM
 * call with the full transcript (system prompt, tool declarations, user/assistant/tool messages) —
 * estimates the six-category composition, and appends one JSON line per request to a per-session
 * file under the bridge's state dir. The bridge tails that file and the web's Context sheet renders
 * it (KPI row / composition detail / per-request trend / events / file activity).
 *
 * Categories (dsh-context's split, adapted to pi's message roles):
 *   sys    system prompt (leading system message + mid-conversation prompt/tool patches)
 *   tools  tool declarations (SystemMessage.toolsAdded; each Tool = name+description+parameters)
 *   user   user messages
 *   inject injected context (custom / branchSummary / compactionSummary roles)
 *   asst   assistant messages (text + thinking + tool calls)
 *   toolr  tool results (toolResult role, bashExecution role, file results)
 *
 * Token estimation is the same heuristic the web HUD already uses for turn chars: CJK chars ÷ 1.5,
 * everything else ÷ 4. It is an estimate — the provider's own usage numbers remain the source of
 * truth for totals (`stats` WS message); this file is the only source for the *split*.
 *
 * Written by the bridge with LOG_DIR filled in (pisettings.ts install pattern, same as
 * session-lock.ts). Never throws: logging must not break the pi it rides on.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR: string = "__LOG_DIR__";
const VERSION = 1;

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

export default function contextLog(pi: any): void {
  let file: string | null = null;
  let seq = 0;

  const line = (obj: Record<string, unknown>) => {
    if (!file) return;
    try {
      fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
    } catch {
      /* logging must never break the ride */
    }
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    file = null;
    seq = 0;
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
        cats.sys += msgTokens(msg).tokens;
        for (const t of msg?.toolsAdded ?? []) cats.tools += toolTokens(t);
        perMessage.push({ role, tokens: msgTokens(msg).tokens, blocks: 1, toolCalls: 0 });
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
    seq++;
    line({
      v: VERSION,
      seq,
      ts: Date.now(),
      cwd: ctx?.cwd ?? null,
      total,
      cats,
      messages: m,
      perMessage,
    });
    // Return nothing: this hook only observes; the transcript goes out unchanged.
    return undefined;
  });
}

/**
 * Context panel logging (#384), the web client's take on dsh-context's core value.
 *
 * pi's `get_session_stats` reports the *total* context tokens but never *what* the context is made
 * of. This companion extension rides pi's hooks and appends one JSON line per observation to a
 * per-session file under the bridge's state dir. The bridge tails that file and the web's Context
 * panel renders it (stats / token split / timing / current context / trend / browser / events /
 * file activity / command activity). Six kinds of lines share one `seq`:
 *   request   `context_with_system`, right before every LLM call: category totals plus a compact
 *             snapshot of the header and the context items
 *   body      full-ish content for one item, written once per changed (id, digest) so the browser
 *             can expand system prompts, tool schemas, messages, arguments and tool results
 *   usage     `message_end` for an assistant message: provider usage for the request before it
 *   event     `session_compact` / `session_compact_failed` / `model_select` / `inject`
 *   activity  `tool_execution_end`: every tool call; file and shell calls keep extra metadata
 *
 * Token estimation is the same heuristic the web HUD already uses for turn chars: CJK chars ÷ 1.5,
 * everything else ÷ 4. It is an estimate — the provider's own usage numbers remain the source of
 * truth for totals (`stats` WS message); this file is the only source for the *split*.
 *
 * Privacy: this is the same machine-local evidence the session JSONL already holds. The browser
 * needs the actual prompt / schema / message / arguments / result to answer "what is in this
 * request", so `body` lines keep that content (capped at MAX_BODY). Activity lines still keep only
 * metadata: shell commands reduce to a program name and file lines to path + line deltas.
 *
 * Written by the bridge with LOG_DIR filled in (pisettings.ts install pattern, same as
 * session-lock.ts). Never throws: logging must not break the pi it rides on.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR: string = "__LOG_DIR__";
const VERSION = 3;
const MAX_PATH = 240;
const MAX_PREVIEW = 160;
const MAX_ITEMS = 400;
const MAX_TOOLS = 80;
const MAX_SECTIONS = 24;
const MAX_BODY = 64 * 1024;

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
/**
 * 已有日志的末尾状态：最后一行的 seq、最后一次请求的 seq / 轮 / 步 / userKey。
 * 文件不存在或读坏了就从零开始（和以前一样）。只解析最后一条请求行，其余行只看开头的 seq。
 */
function resumeState(file: string): { seq: number; lastRequestSeq: number; turn: number; step: number; userKey: string } {
  const out = { seq: 0, lastRequestSeq: 0, turn: 0, step: 0, userKey: "" };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const rows = text.split("\n");
  let sawRequest = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!.trim();
    if (!row) continue;
    if (!out.seq) {
      const m = /"seq":(\d+)/.exec(row.slice(0, 64));
      if (m) out.seq = Number(m[1]);
    }
    if (!sawRequest && row.includes('"kind":"request"')) {
      try {
        const req = JSON.parse(row);
        sawRequest = true;
        out.lastRequestSeq = typeof req.seq === "number" ? req.seq : 0;
        out.turn = typeof req.turn === "number" ? req.turn : 0;
        out.step = typeof req.step === "number" ? req.step : 0;
        out.userKey = typeof req.userKey === "string" ? req.userKey : "";
      } catch {
        /* 半行：再往前找 */
      }
    }
    if (out.seq && sawRequest) break;
  }
  return out;
}

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

function prettyArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
}

/** The same fold-back rule as `sessionfile.ts`: a SKILL.md may quote `</skill>`, so the last close ends it. */
const SKILL_BLOCK = /^\s*<skill\b([^>]*)>([\s\S]*)<\/skill>([\s\S]*)$/;
const SKILL_NAME = /\bname="([^"]*)"/;
const SKILL_LOCATION = /\blocation="([^"]*)"/;

function skillExpansion(raw: string): { name: string; location?: string; body: string; args: string; command: string } | null {
  const m = SKILL_BLOCK.exec(raw);
  if (!m) return null;
  const name = SKILL_NAME.exec(m[1])?.[1];
  if (!name) return null;
  const location = SKILL_LOCATION.exec(m[1])?.[1];
  const args = m[3].trim();
  return { name, ...(location ? { location } : {}), body: m[2], args, command: args ? `/skill:${name} ${args}` : `/skill:${name}` };
}

interface BlockInfo {
  kind: "text" | "thinking" | "toolCall" | "image" | "other";
  tokens: number;
  /** Full text / JSON used for the browser body; never placed in the compact preview. */
  text: string;
  /** One-line preview written to the ctxlog item. */
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
    // The preview stays privacy-safe (keys only); the full argument body goes to a `body` line.
    return {
      kind: "toolCall",
      tokens: estTokens(name) + argTokens(args),
      text: prettyArgs(args),
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
  /** item id → digest of the last body written; bodies are large, so only changes are appended. */
  const bodyDigests = new Map<string, string>();
  /** skill invocation message key → already emitted its inject event (the message stays in context). */
  const seenSkillKeys = new Set<string>();
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

  /** Full text for the Context Browser; unchanged items are not written again. */
  const body = (id: string, content: string, meta: Record<string, unknown> = {}): void => {
    if (!content) return;
    const text = content.length > MAX_BODY ? `${content.slice(0, MAX_BODY - 1)}…` : content;
    const digest = hash32(`${text}\n${JSON.stringify(meta)}`);
    if (bodyDigests.get(id) === digest) return;
    bodyDigests.set(id, digest);
    line({ ...meta, kind: "body", id, content: text });
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
    bodyDigests.clear();
    seenSkillKeys.clear();
    pending.clear();
    try {
      const id = String(ctx.sessionManager?.getSessionId?.() ?? "");
      if (!id) return;
      const dir = path.join(LOG_DIR, id.slice(0, 8));
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${id}.ctx.jsonl`);
      // 同一会话再次启动（桥重启 / 接管 / 重载）会接着往这个文件追加：序号与轮次要接着数，
      // 否则 usage / 事件的 atSeq 会和前一段撞号，面板把它们挂到错误的请求上。
      const tail = resumeState(file);
      seq = tail.seq;
      lastRequestSeq = tail.lastRequestSeq;
      turn = tail.turn;
      step = tail.step;
      lastUserKey = tail.userKey;
    } catch {
      file = null;
    }
  });

  pi.on("session_shutdown", async () => {
    file = null;
    bodyDigests.clear();
    seenSkillKeys.clear();
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
    const skillNames = new Set<string>();
    const callArgs = new Map<string, { name: string; args: unknown }>();

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
              body(item.id, text, { cat, label: item.label });
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
          body(item.id, contentText, { cat: "sys", label: "system" });
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
            body(item.id, b.text, { cat: "sys", label: "system" });
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
          let schema = "";
          try {
            schema = JSON.stringify({ name, description: tool?.description ?? "", parameters: tool?.parameters ?? tool?.inputSchema ?? {} }, null, 2);
          } catch {
            schema = String(tool?.description ?? name);
          }
          body(item.id, schema, { cat: "tools", label: name, kind: "tool" });
        }
        perMessage.push({ role, tokens: total, blocks: 1, toolCalls: 0 });
        continue;
      }

      const base = messageKey(msg, m);

      // A `/skill:<name>` prompt reaches pi expanded as `<skill name="…">SKILL.md</skill> args`.
      // dsh-context gives that block its own category (Skill Injections); keep the args as the
      // user message and do not let the whole SKILL.md hide inside the user row.
      const userText = role === "user" ? textOf(msg?.content) : "";
      const skill = userText ? skillExpansion(userText) : null;
      if (skill) {
        const blockText = skill.args ? userText.slice(0, Math.max(0, userText.length - skill.args.length)) : userText;
        const skillTokens = estTokens(blockText);
        const argsTokens = skill.args ? estTokens(skill.args) : 0;
        cats.skill += skillTokens;
        cats.user += argsTokens;
        skillNames.add(skill.name);
        const skillItem: Item = {
          id: `${base}:skill`,
          cat: "skill",
          label: skill.name,
          tokens: skillTokens,
          kind: "skill",
          sub: "skill",
          preview: oneLine(skill.body),
        };
        items.push(skillItem);
        body(skillItem.id, skill.body, { cat: "skill", label: skill.name, ...(skill.location ? { path: skill.location } : {}) });
        if (argsTokens) {
          const argsItem: Item = {
            id: `${base}:args`,
            cat: "user",
            label: "user",
            tokens: argsTokens,
            kind: "user",
            preview: oneLine(skill.args),
          };
          items.push(argsItem);
          body(argsItem.id, skill.args, { cat: "user", label: "user" });
        }
        const skillKey = `${base}:${skill.name}`;
        if (!seenSkillKeys.has(skillKey)) {
          seenSkillKeys.add(skillKey);
          injections.push({ label: `skill:${skill.name}`, tokens: skillTokens });
        }
        perMessage.push({ role, tokens: skillTokens + argsTokens, blocks: 1, toolCalls: 0 });
        continue;
      }

      const blocks = contentBlocks(msg);
      let msgTotal = 0;
      let toolCalls = 0;
      blocks.forEach((b, bi) => {
        msgTotal += b.tokens;
        let cat = roleCat(role);
        let kind: string = b.kind;
        let label = role;
        let sub: string | undefined;
        let meta: Record<string, unknown> = {};
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
            if (b.toolCallId) callArgs.set(b.toolCallId, { name: label, args: b.text });
            meta = { tool: label, kind: "call" };
          } else {
            split.answer += b.tokens;
            kind = "answer";
            label = "assistant";
          }
        } else if (role === "toolResult" || role === "bashExecution") {
          cat = "toolr";
          kind = "result";
          label = String(msg?.toolName ?? "result");
          const call = msg?.toolCallId ? callArgs.get(String(msg.toolCallId)) : undefined;
          meta = {
            tool: label,
            kind: "result",
            status: msg?.isError ? "failed" : "ok",
            ...(call?.args ? { args: String(call.args) } : {}),
            ...(typeof msg?.command === "string" ? { command: msg.command } : {}),
            ...(typeof msg?.exitCode === "number" ? { exitCode: msg.exitCode } : {}),
          };
        } else if (role === "user") {
          cat = "user";
          kind = "user";
          label = "user";
          meta = { kind: "user" };
        } else {
          cat = "inject";
          kind = "inject";
          label = String(msg?.customType ?? msg?.source ?? "inject");
          meta = { kind: "inject", label };
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
        if (b.kind !== "image") body(item.id, b.text, { cat, label, ...meta });
      });
      if (!blocks.length) {
        // A message with no content is still one row in the browser (e.g. an empty custom notice).
        const cat = roleCat(role);
        items.push({ id: `${base}:empty`, cat, label: role, tokens: 0, kind: "empty" });
      }
      perMessage.push({ role, tokens: msgTotal, blocks: Math.max(1, blocks.length), toolCalls });
    }

    // turn/step: a new last-user message opens a turn; every request is one step.
    // 存哈希：要写进请求行，重启后据此判断下一次请求是不是同一轮。
    const userKey = hash32(`${users}:${clip(lastUserText, 200)}`);
    if (userKey !== lastUserKey) {
      lastUserKey = userKey;
      turn++;
      step = 1;
    } else {
      step++;
    }

    const total = cats.sys + cats.tools + cats.user + cats.inject + cats.skill + cats.asst + cats.toolr;
    const foldedUser = skillExpansion(lastUserText)?.command ?? lastUserText;
    const keptItems = items.slice(-MAX_ITEMS);
    const keptTools = headerTools.slice(0, MAX_TOOLS);
    requestStartedAt = Date.now();

    lastRequestSeq = line({
      kind: "request",
      cwd: ctx?.cwd ?? null,
      model: currentModel,
      turn,
      step,
      userKey,
      users,
      total,
      cats,
      split,
      skills: [...skillNames],
      lastUser: clip(foldedUser.replace(/\s+/g, " ").trim(), 160),
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
    const totalCost = typeof u?.cost === "number" ? u.cost : u?.cost?.total;
    line({
      kind: "usage",
      atSeq: lastRequestSeq,
      model: String(msg?.model ?? currentModel),
      stopReason: String(msg?.stopReason ?? ""),
      durationMs: num(msg?.durationMs) || elapsed,
      waitMs,
      usage,
      out,
      ...(typeof totalCost === "number" && Number.isFinite(totalCost) ? { cost: totalCost } : {}),
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
    const skillName = name === "skill" ? String(started.args?.name ?? started.args?.skill ?? "skill") : "";
    if (skillName) common.skillName = clip(skillName, 120);

    if (name === "skill") {
      line({
        kind: "event",
        event: "inject",
        label: `skill:${skillName}`,
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
    if (op === "read") {
      // 隐式技能加载：模型直接读了 `<skill>/SKILL.md`，pi 没有 skill 工具调用可记。
      const skill = /([^/\\]+)[/\\]SKILL\.md$/i.exec(p);
      if (skill) line({ kind: "event", event: "inject", label: `skill:${skill[1]}`, tokens: 0, atSeq: lastRequestSeq });
    }
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

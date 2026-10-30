import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { RpcChild } from "./rpc.ts";
import { loadEntries, listSessionFiles, type SessionFileMeta } from "./sessionfile.ts";
import { entriesToItems, summarizeToolArgs, type Item, type ToolItem } from "./items.ts";
import { fileURLToPath } from "node:url";
import { ensureDir, sessionsRoot, statePath, readJson, writeJson } from "./paths.ts";
import { fetchModels, type ModelInfo } from "./pi.ts";
import { Manage } from "./manage.ts";
import { rankSkills, scanSkills, type SkillInfo } from "./skills.ts";

/** The approval gate ships next to the bridge sources, not inside dist. */
function approvalGatePath(): string {
  return process.env.PI_WEB_GATE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ext", "approval-gate.ts");
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  title: string;
  message: string;
  createdAt: number;
  deadline?: number;
}

// ---------------------------------------------------------------- ask-user
// The `question` / `questionnaire` extensions cannot run in rpc mode (no custom UI there), so the
// child POSTs the whole question to the bridge over loopback HTTP and the bridge holds the request
// open until somebody answers. This is the wire shape that travels both ways.
export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  label?: string;
  prompt: string;
  options: AskOption[];
  allowOther?: boolean;
}

export interface AskAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom?: boolean;
  index?: number;
}

export interface AskRequest {
  id: string;
  sessionId: string;
  sessionName: string;
  questions: AskQuestion[];
  createdAt: number;
}

export interface AskOutcome {
  answers: AskAnswer[] | null;
  cancelled: boolean;
}

interface PendingAsk extends AskRequest {
  resolve: (out: AskOutcome) => void;
}

export interface SessionState {
  id: string;
  name: string;
  cwd: string;
  file: string | null;
  owned: boolean; // this bridge is the writer
  origin?: "web" | "disk"; // "web" = this bridge created it; "disk" = came from a pi session file
  running: boolean;
  /** A turn finished after the user last looked at this session (cleared on subscribe/prompt). */
  done: boolean;
  model?: string; // provider-scoped model id, e.g. "cn:deepseek-v4.1-flash"
  modelName?: string; // human name from pi, e.g. "Deepseek-V4.1-Flash · x0.11 · 1M"
  thinkingLevel?: string;
  updatedAt: number;
  startedAt?: string;
  truncated?: boolean;
  approvals: number;
  asks?: number;
  /** Sidebar arrangement (bridge-side state/manage.json), only filled in by list(). */
  pinned?: boolean;
  archived?: boolean;
}

/** Only these fields ever leave the bridge; `resolve` is nobody else's business. */
function publicAsk(ask: PendingAsk): AskRequest {
  return {
    id: ask.id,
    sessionId: ask.sessionId,
    sessionName: ask.sessionName,
    questions: ask.questions,
    createdAt: ask.createdAt,
  };
}

const IDLE_GC_MS = 2 * 60 * 60 * 1000;

function lockPath(id: string): string {
  return statePath("locks", `${id}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = the process exists but belongs to someone else; ESRCH = gone.
    return err?.code === "EPERM";
  }
}

function dropLockFile(id: string): void {
  try {
    fs.unlinkSync(lockPath(id));
  } catch {
    /* another process may have cleaned it first */
  }
}

/**
 * A lock only counts while its writer is alive. Dead locks used to hide their sessions
 * from the list forever after a bridge crash, so a stale one is pruned on read.
 */
function readLock(id: string): { pid: number; at: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(id), "utf8")) as { pid?: number; at?: number };
    const pid = Number(raw?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      dropLockFile(id);
      return null;
    }
    if (pid !== process.pid && !pidAlive(pid)) {
      dropLockFile(id);
      return null;
    }
    return { pid, at: Number(raw?.at) || 0 };
  } catch {
    return null;
  }
}

function takeLock(id: string): boolean {
  const existing = readLock(id);
  if (existing && existing.pid !== process.pid) return false;
  ensureDir(path.dirname(lockPath(id)));
  fs.writeFileSync(lockPath(id), JSON.stringify({ pid: process.pid, at: Date.now() }));
  return true;
}

function releaseLock(id: string): void {
  const existing = readLock(id);
  if (existing && existing.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath(id));
  } catch {
    /* ignore */
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  // rpc events come in two shapes: a bare content array, or a ToolResult wrapping one. Extension
  // tools use the wrapped form, which used to render as an empty result in the transcript.
  const list = Array.isArray(content)
    ? content
    : Array.isArray((content as any)?.content)
      ? ((content as any).content as unknown[])
      : null;
  if (!list) return "";
  return list
    .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");
}

function derivePattern(message: string): string | null {
  const detail = message.split("→").pop()?.trim() ?? "";
  const tokens = detail.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const second = tokens[1] ?? "";
  return second && !second.startsWith("-") ? `${tokens[0]} ${second}` : tokens[0];
}

/** Context budget is one global number: `{"value": 200000}` in the state dir. */
function budgetFile(): string {
  return statePath("budget.json");
}

function readBudget(): number | null {
  const raw = readJson<{ value?: unknown }>(budgetFile(), {});
  const value = Number(raw?.value);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function writeBudget(value: number | null): void {
  try {
    writeJson(budgetFile(), { value });
  } catch {
    /* an unwritable state dir only costs persistence */
  }
}

/**
 * Sidebar names this bridge owns: `{"<sessionId>": {"name": "…", "at": 1699999999999}}`.
 * Only used when the session is not ours to rename through pi (read-only disk session) or as
 * a fallback when the pi process already died — the bridge never appends to a session file.
 */
type NameOverride = { name: string; at: number };

function namesFile(): string {
  return statePath("names.json");
}

let nameOverrides: Record<string, NameOverride> | null = null;

function readNameOverrides(): Record<string, NameOverride> {
  if (nameOverrides) return nameOverrides;
  const raw = readJson<Record<string, { name?: unknown; at?: unknown }>>(namesFile(), {});
  const out: Record<string, NameOverride> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (typeof value?.name === "string" && value.name.trim()) {
      out[id] = { name: value.name.trim().slice(0, 120), at: Number(value.at) || 0 };
    }
  }
  nameOverrides = out;
  return out;
}

function writeNameOverride(id: string, name: string): void {
  const all: Record<string, NameOverride> = { ...readNameOverrides(), [id]: { name, at: Date.now() } };
  nameOverrides = all;
  try {
    writeJson(namesFile(), all);
  } catch {
    /* an unwritable state dir only costs persistence */
  }
}

/** Drop a deleted session's label so a future session with the same id cannot inherit it. */
export function forgetName(id: string): void {
  const all = { ...readNameOverrides() };
  if (!(id in all)) return;
  delete all[id];
  nameOverrides = all;
  try {
    writeJson(namesFile(), all);
  } catch {
    /* an unwritable state dir only costs persistence */
  }
}

/** Newest rename wins: a pi-side session_info newer than our override takes the card back. */
function preferredName(id: string, name: string | null, nameAt: string | null): string | null {
  const override = readNameOverrides()[id];
  if (!override) return name;
  const fileAt = nameAt ? Date.parse(nameAt) : NaN;
  if (Number.isFinite(fileAt) && override.at < fileAt) return name;
  return override.name;
}

export class Session extends EventEmitter {
  readonly state: SessionState;
  items: Item[] = [];
  rpc: RpcChild | null = null;
  readonly approvals = new Map<string, ApprovalRequest>();
  readonly asks = new Map<string, PendingAsk>();
  /** Handed to the child in PI_WEB_ASK_TOKEN so only our own pi can post questions. */
  readonly askToken = crypto.randomUUID();
  /** Set by SessionManager: where the child posts asks (loopback only). */
  askUrl: string | null = null;

  /** Context-token ceiling the bridge enforces by compacting; null = off. Shared across sessions. */
  contextBudget: number | null = readBudget();
  /** Tokens the last get_session_stats reported, used to decide when the budget is blown. */
  private lastContextTokens: number | null = null;
  /** One auto-compaction per turn; the next agent_start re-arms it. */
  private autoCompactUsed = false;
  /** get_commands results, refreshed every couple of minutes. */
  private skillsCache: { at: number; list: SkillInfo[] } | null = null;

  private lastActivity = Date.now();
  private tailTimer: NodeJS.Timeout | null = null;
  private tailSig = "";
  private draftCounter = 0;
  private draftId: string | null = null;
  private userCounter = 0;

  constructor(
    private cli: string,
    meta: SessionFileMeta | null,
    opts: { id?: string; name?: string } = {},
  ) {
    super();
    const id = opts.id ?? meta?.id ?? "";
    const onDiskName = preferredName(id, meta?.name ?? null, meta?.nameAt ?? null);
    this.state = {
      id,
      name: opts.name ?? onDiskName ?? meta?.firstUserText?.slice(0, 40) ?? "新会话",
      cwd: meta?.cwd ?? process.cwd(),
      file: meta?.file ?? null,
      owned: false,
      origin: "disk",
      running: false,
      done: false,
      updatedAt: Date.now(),
      // Creation time is the sidebar's sort key, so a web-born session needs one too.
      startedAt: meta?.startedAt ?? new Date().toISOString(),
      approvals: 0,
      asks: 0,
    };
    if (meta) this.loadFromFile();
  }

  get live(): boolean {
    return Boolean(this.rpc?.alive);
  }

  /** The user opened this session: whatever finished before now has been seen. */
  markSeen(): void {
    if (this.state.done) this.setState({ done: false });
  }

  private emitWs(payload: any): void {
    this.emit("ws", payload);
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.state.updatedAt = Date.now();
  }

  private setState(patch: Partial<SessionState>, opts: { touch?: boolean } = {}): void {
    Object.assign(this.state, patch);
    if (opts.touch !== false) this.touch();
    this.emit("state", this.state);
  }

  // ---------------------------------------------------------------- file view
  private loadFromFile(): void {
    if (!this.state.file) return;
    try {
      const res = loadEntries(this.state.file);
      this.items = entriesToItems(res.entries);
      this.state.truncated = res.truncated;
    } catch {
      this.items = [];
    }
  }

  refreshFromFile(): void {
    if (!this.state.file || this.live) return;
    try {
      const stat = fs.statSync(this.state.file);
      const sig = `${stat.size}:${Math.round(stat.mtimeMs)}`;
      if (sig === this.tailSig) return;
      this.tailSig = sig;
      const before = this.items.length;
      this.loadFromFile();
      this.touch();
      if (this.items.length > before) {
        const added = this.items.slice(before);
        for (const item of added) this.emitWs({ type: "item.add", sessionId: this.state.id, item });
      }
      if (!this.items.length) this.emitWs({ type: "items", sessionId: this.state.id, items: [] });
    } catch {
      /* ignore */
    }
  }

  startTail(): void {
    if (this.tailTimer) return;
    this.refreshFromFile();
    this.tailTimer = setInterval(() => this.refreshFromFile(), 400);
  }

  stopTail(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = null;
  }

  /** Name learned from the file (e.g. a terminal `/name`); it is not a local edit. */
  adoptName(name: string): void {
    if (name === this.state.name) return;
    this.setState({ name }, { touch: false });
  }

  /**
   * Rename from the sidebar. A live session renames through pi (`set_session_name` appends a
   * `session_info` entry, so the terminal sees it too); a read-only disk session only gets a
   * bridge-side label — appending to a file pi may still be writing is the one thing D31 forbids.
   */
  async rename(raw: string): Promise<void> {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) throw new Error("名字不能是空的");
    if (name.length > 120) throw new Error("名字太长了（最多 120 字）");
    writeNameOverride(this.state.id, name);
    this.setState({ name }, { touch: false });
    if (!this.live) return;
    try {
      await this.rpc!.request("set_session_name", { name }, 15000);
    } catch (err: any) {
      this.emitWs({ type: "notice", sessionId: this.state.id, text: `pi 没把这个名字写进会话文件：${err?.message ?? err}`, level: "warn" });
    }
  }

  // ---------------------------------------------------------------- live (RPC)
  async startLive(opts: { resume: boolean; cwd?: string; name?: string }): Promise<void> {
    if (this.live) return;
    this.stopTail();
    const id = this.state.id || crypto.randomUUID();
    this.state.id = id;

    if (!takeLock(id)) {
      throw new Error("这个会话正被另一个进程写入（可能是终端里的 pi）。请先退出那边的会话。");
    }
    this.state.owned = true;
    // Provenance, not current writer path: a web-born session stays "web" after it is closed and reclaimed.
    if (!opts.resume) this.state.origin = "web";

    const args = ["--mode", "rpc"];
    if (process.env.PI_WEB_NO_EXT === "1") args.push("-ne");
    args.push("-e", approvalGatePath());
    if (opts.resume && this.state.file) args.push("--session", this.state.file);
    else args.push("--session-id", id);
    if (opts.name && !opts.resume) args.push("--name", opts.name);

    const cwd = opts.cwd || this.state.cwd || process.cwd();
    this.rpc = new RpcChild({
      cli: this.cli,
      args,
      cwd,
      logPath: statePath("logs", `${id}.log`),
      env: {
        PI_WEB_ALLOW_FILE: statePath("allow.json"),
        // The ask-user extensions post here instead of opening a dialog (see PLAN-ask.md).
        ...(this.askUrl ? { PI_WEB_ASK: this.askUrl, PI_WEB_ASK_TOKEN: this.askToken } : {}),
      },
    });

    this.rpc.on("event", (ev: any) => this.onPiEvent(ev));
    this.rpc.on("ui_request", (req: any) => this.onUiRequest(req));
    this.rpc.on("stderr", () => this.touch());
    this.rpc.on("log", (line: string) => this.emitWs({ type: "notice", sessionId: id, text: line, level: "warn" }));
    this.rpc.on("exit", (reason: string) => {
      const wasRunning = this.state.running;
      this.state.owned = false;
      this.setState({ running: false });
      releaseLock(id);
      this.clearApprovals();
      this.clearAsks();
      this.emitWs({ type: "notice", sessionId: id, text: `pi 进程已退出：${reason}`, level: "warn" });
      void wasRunning;
      // keep reading the file from now on so the transcript stays current
      this.startTail();
    });

    this.rpc.start();

    try {
      const st = await this.rpc.request<any>("get_state", {}, 30000);
      this.absorbState(st);
    } catch {
      /* get_state is best effort; events still work */
    }
    // A resumed session starts with the transcript pi already wrote to disk.
    if (opts.resume) this.loadFromFile();
    this.emitWs({ type: "items", sessionId: id, items: this.items });
    void this.refreshStats();
  }

  /** Token/context numbers for the composer HUD; best effort, never throws. */
  private async refreshStats(): Promise<void> {
    if (!this.rpc?.alive) return;
    try {
      const stats = await this.rpc.request<any>("get_session_stats", {}, 15000);
      const tokens = stats?.contextUsage?.tokens;
      this.lastContextTokens = typeof tokens === "number" ? tokens : null;
      this.emitWs({
        type: "stats",
        sessionId: this.state.id,
        tokens: stats?.tokens ?? null,
        cost: stats?.cost ?? null,
        context: stats?.contextUsage ?? null,
        budget: this.contextBudget,
      });
      void this.maybeAutoCompact();
    } catch {
      /* stats are decoration; the chat still works without them */
    }
  }

  private absorbState(st: any): void {
    if (!st || typeof st !== "object") return;
    const model = st.model?.id ?? st.modelId ?? st.model ?? undefined;
    if (typeof st.model?.name === "string") this.state.modelName = st.model.name;
    const thinking = st.thinkingLevel ?? st.thinking ?? undefined;
    const file = st.sessionFile ?? st.sessionPath ?? st.file ?? undefined;
    this.setState({
      model: typeof model === "string" ? model : this.state.model,
      thinkingLevel: typeof thinking === "string" ? thinking : this.state.thinkingLevel,
      file: typeof file === "string" ? file : this.state.file,
      cwd: typeof st.cwd === "string" ? st.cwd : this.state.cwd,
    });
  }

  private onPiEvent(ev: any): void {
    this.touch();
    switch (ev.type) {
      case "session_start":
      case "session_info_changed": {
        if (typeof ev.sessionFile === "string") this.setState({ file: ev.sessionFile });
        if (typeof ev.name === "string") this.setState({ name: ev.name });
        break;
      }
      case "agent_start":
        this.setState({ running: true, done: false });
        this.autoCompactUsed = false;
        this.emitWs({ type: "pi.status", sessionId: this.state.id, running: true });
        break;
      case "agent_end":
      case "agent_settled": {
        this.setState({ running: false, done: true });
        this.emitWs({ type: "pi.status", sessionId: this.state.id, running: false });
        void this.refreshStats();
        break;
      }
      case "message_start": {
        if (ev.message?.role === "assistant") {
          this.draftCounter += 1;
          this.draftId = `draft:${this.draftCounter}`;
          const item = {
            id: this.draftId,
            kind: "assistant",
            text: "",
            thinking: "",
            model: ev.message?.model,
          } as any;
          this.emitWs({ type: "item.add", sessionId: this.state.id, item });
        }
        break;
      }
      case "message_update": {
        const stev = ev.assistantMessageEvent;
        if (!this.draftId || !stev) break;
        const type = String(stev.type ?? "");
        if (type === "text_delta" && stev.delta) {
          this.emitWs({ type: "delta", sessionId: this.state.id, id: this.draftId, field: "text", text: String(stev.delta) });
        } else if (type === "thinking_delta" && stev.delta) {
          this.emitWs({ type: "delta", sessionId: this.state.id, id: this.draftId, field: "thinking", text: String(stev.delta) });
        }
        break;
      }
      case "message_end": {
        if (ev.message?.role !== "assistant") break;
        const msg = ev.message;
        let text = "";
        let thinking = "";
        const calls: any[] = [];
        for (const c of Array.isArray(msg.content) ? msg.content : []) {
          if (!c) continue;
          if (c.type === "text") text += String(c.text ?? "");
          else if (c.type === "thinking") thinking += String(c.thinking ?? "");
          else if (c.type === "toolCall") calls.push(c);
        }
        const draft = this.draftId;
        const item: Item = {
          id: `live:${this.draftCounter}`,
          kind: "assistant",
          text,
          thinking,
          model: msg.model,
          stopReason: msg.stopReason,
        };
        if (draft) {
          this.emitWs({ type: "item.replace", sessionId: this.state.id, id: draft, item });
          this.upsert(item, draft);
        } else {
          this.emitWs({ type: "item.add", sessionId: this.state.id, item });
          this.upsert(item);
        }
        this.draftId = null;
        if (msg.usage) this.emitWs({ type: "usage", sessionId: this.state.id, usage: msg.usage });
        void this.refreshStats();
        for (const call of calls) {
          const tool: ToolItem = {
            id: `live-tool:${call.id}`,
            kind: "tool",
            toolCallId: String(call.id ?? ""),
            name: String(call.name ?? "tool"),
            args: call.arguments,
            status: "running",
          };
          this.emitWs({ type: "item.add", sessionId: this.state.id, item: tool });
          this.upsert(tool);
        }
        break;
      }
      case "tool_execution_start": {
        this.emitWs({
          type: "tool",
          phase: "start",
          sessionId: this.state.id,
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          args: ev.args,
          summary: summarizeToolArgs(ev.args),
        });
        break;
      }
      case "tool_execution_update": {
        this.emitWs({ type: "tool", phase: "update", sessionId: this.state.id, toolCallId: ev.toolCallId, partial: contentText(ev.partialResult).slice(0, 8000) });
        break;
      }
      case "tool_execution_end": {
        {
          const at = this.items.findIndex((it) => it.kind === "tool" && it.toolCallId === String(ev.toolCallId));
          if (at >= 0) {
            const prev = this.items[at] as ToolItem;
            const next: ToolItem = {
              ...prev,
              status: ev.isError ? "error" : "ok",
              isError: Boolean(ev.isError),
              result: contentText(ev.result).slice(0, 20000),
              durationMs: ev.durationMs,
            };
            this.items[at] = next;
            this.emitWs({ type: "item.replace", sessionId: this.state.id, id: prev.id, item: next });
          }
        }
        this.emitWs({
          type: "tool",
          phase: "end",
          sessionId: this.state.id,
          toolCallId: ev.toolCallId,
          isError: Boolean(ev.isError),
          result: contentText(ev.result).slice(0, 20000),
          durationMs: ev.durationMs,
        });
        break;
      }
      case "queue_update": {
        this.emitWs({ type: "queue", sessionId: this.state.id, ...ev });
        break;
      }
      case "compaction_start":
        this.emitWs({ type: "notice", sessionId: this.state.id, text: "开始压缩上下文…", level: "info" });
        break;
      case "compaction_end":
        this.emitWs({
          type: "notice",
          sessionId: this.state.id,
          text: ev.aborted ? "压缩被中止" : ev.errorMessage ? `压缩失败：${ev.errorMessage}` : "上下文已压缩",
          level: ev.errorMessage ? "error" : "info",
        });
        break;
      case "extension_error":
        this.emitWs({ type: "notice", sessionId: this.state.id, text: `扩展错误：${ev.error}`, level: "error" });
        break;
      case "auto_retry_start":
        this.emitWs({ type: "notice", sessionId: this.state.id, text: `请求失败，重试中…`, level: "warn" });
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- approvals
  private onUiRequest(req: any): void {
    const id = String(req.id ?? "");
    if (!id) return;
    if (req.method === "confirm" || req.method === "select" || req.method === "input" || req.method === "editor") {
      const approval: ApprovalRequest = {
        id,
        sessionId: this.state.id,
        title: String(req.title ?? "需要确认"),
        message: String(req.message ?? req.prompt ?? ""),
        createdAt: Date.now(),
        deadline: typeof req.timeout === "number" ? Date.now() + req.timeout : undefined,
      };
      this.approvals.set(id, approval);
      this.state.approvals = this.approvals.size;
      this.emitWs({ type: "approval.add", sessionId: this.state.id, approval });
      this.emit("approval", approval);
      return;
    }
    // Unsupported dialog (custom UI etc.) — cancel so the agent never hangs.
    this.rpc?.uiRespond({ id, cancelled: true });
  }

  answerApproval(id: string, decision: "approve" | "reject" | "cancel" | "always"): void {
    const req = this.approvals.get(id);
    if (!req) return;
    if (decision === "always") {
      const pattern = derivePattern(req.message);
      if (pattern) {
        const file = statePath("allow.json");
        const data = readJson<{ patterns: string[] }>(file, { patterns: [] });
        if (!data.patterns.includes(pattern)) {
          data.patterns.push(pattern);
          writeJson(file, data);
        }
        this.emitWs({ type: "notice", sessionId: this.state.id, text: `已记住「${pattern}」，这一类不再问你`, level: "info" });
      }
    }
    this.approvals.delete(id);
    this.state.approvals = this.approvals.size;
    if (decision === "approve" || decision === "always") this.rpc?.uiRespond({ id, confirmed: true });
    else if (decision === "reject") this.rpc?.uiRespond({ id, confirmed: false });
    else this.rpc?.uiRespond({ id, cancelled: true });
    this.emitWs({ type: "approval.remove", sessionId: this.state.id, id, decision });
    this.emit("approval-resolved", this.state.id, id, decision);
  }

  clearApprovals(): void {
    for (const id of [...this.approvals.keys()]) this.answerApproval(id, "cancel");
  }

  // ------------------------------------------------------------------ asks
  /** Register a question and stay pending until answered, cancelled, or this session dies. No timeout on purpose. */
  ask(questions: AskQuestion[], tool: string): { id: string; outcome: Promise<AskOutcome> } {
    const ask: PendingAsk = {
      id: `ask_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: this.state.id,
      sessionName: this.state.name,
      questions,
      createdAt: Date.now(),
      resolve: () => {},
    };
    const pending = new Promise<AskOutcome>((resolve) => {
      ask.resolve = resolve;
    });
    this.asks.set(ask.id, ask);
    this.state.asks = this.asks.size;
    this.emitWs({ type: "ask.add", sessionId: this.state.id, ask: publicAsk(ask), tool });
    this.emit("ask", publicAsk(ask), tool);
    return { id: ask.id, outcome: pending };
  }

  answerAsk(id: string, answers: AskAnswer[]): void {
    const ask = this.asks.get(id);
    if (!ask) return;
    const clean: AskAnswer[] = [];
    for (const q of ask.questions) {
      const got = answers.find((a) => a.id === q.id);
      if (!got) continue;
      // Values must come from the offered options unless the question allowed free text.
      const known = q.options.find((o) => o.value === got.value);
      if (known)
        clean.push({ id: q.id, value: known.value, label: known.label, wasCustom: false, index: q.options.indexOf(known) + 1 });
      else if (q.allowOther !== false) clean.push({ id: q.id, value: String(got.value), label: String(got.label ?? got.value), wasCustom: true });
    }
    if (clean.length !== ask.questions.length) {
      this.emitWs({ type: "notice", sessionId: this.state.id, text: "答案不完整，仍等你作答", level: "warn" });
      return;
    }
    this.asks.delete(id);
    this.state.asks = this.asks.size;
    this.emitWs({ type: "ask.remove", sessionId: this.state.id, id, status: "answered", answers: clean });
    this.emit("ask-resolved", this.state.id, id, "answered");
    ask.resolve({ answers: clean, cancelled: false });
  }

  cancelAsk(id: string, reason = "用户取消"): void {
    const ask = this.asks.get(id);
    if (!ask) return;
    this.asks.delete(id);
    this.state.asks = this.asks.size;
    this.emitWs({ type: "ask.remove", sessionId: this.state.id, id, status: "cancelled", reason });
    this.emit("ask-resolved", this.state.id, id, "cancelled");
    ask.resolve({ answers: null, cancelled: true });
  }

  clearAsks(): void {
    for (const id of [...this.asks.keys()]) this.cancelAsk(id, "这一轮结束了");
  }

  // ---------------------------------------------------------------- commands
  async prompt(text: string, images?: { data: string; mimeType: string }[]): Promise<void> {
    if (!this.rpc?.alive) throw new Error("会话没在运行");
    const message: any = { type: "prompt", message: text };
    // pi rejects a bare prompt while a turn is streaming; queue it instead.
    if (this.state.running) message.streamingBehavior = "followUp";
    if (images?.length) {
      message.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    }
    this.upsert({
      id: `user:${++this.userCounter}`,
      kind: "user",
      text,
      images: (images ?? []).map((i) => ({ mimeType: i.mimeType })),
      ts: new Date().toISOString(),
    });
    const res = await this.rpc.request<any>("prompt", { ...message }, 60000);
    const disposition = res?.disposition;
    if (disposition === "handled" && res?.error) throw new Error(String(res.error));
  }

  abort(): void {
    // Fire and forget: abort's response can stall while a dialog is pending.
    this.clearApprovals();
    this.clearAsks();
    try {
      this.rpc?.fire("abort", {});
    } catch {
      /* ignore */
    }
  }

  async compact(): Promise<void> {
    await this.rpc?.request("compact", {} as any);
    void this.refreshStats();
  }

  /** Skills pi knows about (via get_commands), with a disk fallback for sessions with no rpc child. */
  async skills(): Promise<SkillInfo[]> {
    if (this.skillsCache && Date.now() - this.skillsCache.at < 120_000) return this.skillsCache.list;
    let list: SkillInfo[] = [];
    if (this.rpc?.alive) {
      try {
        const res = await this.rpc.request<any>("get_commands", {}, 8000);
        for (const c of res?.commands ?? []) {
          if (c?.source !== "skill") continue;
          const name = String(c.name ?? "").replace(/^skill:/, "");
          if (!name) continue;
          list.push({ name, description: String(c.description ?? ""), source: "user", uses: 0, lastUsed: 0 });
        }
      } catch {
        /* fall through to the disk scan */
      }
    }
    if (!list.length) list = scanSkills(this.state.cwd || process.cwd());
    const ranked = rankSkills(list);
    this.skillsCache = { at: Date.now(), list: ranked };
    return ranked;
  }

  /** Called after a pick so the next list reflects the new usage count. */
  dropSkillCache(): void {
    this.skillsCache = null;
  }

  /** Set (or clear) the context ceiling; persisted so it survives a bridge restart. */
  setContextBudget(value: number | null): void {
    this.contextBudget = value && value > 0 ? Math.round(value) : null;
    writeBudget(this.contextBudget);
    this.autoCompactUsed = false;
    this.emitWs({ type: "budget", sessionId: this.state.id, budget: this.contextBudget });
    void this.maybeAutoCompact();
  }

  /** Compact once per turn when the last measured context blew the budget. */
  private async maybeAutoCompact(): Promise<void> {
    const budget = this.contextBudget;
    const used = this.lastContextTokens;
    if (!budget || !used) return;
    if (used < budget) return;
    if (this.autoCompactUsed || this.state.running || !this.rpc?.alive) return;
    this.autoCompactUsed = true;
    this.emitWs({
      type: "notice",
      sessionId: this.state.id,
      text: `上下文 ${Math.round(used / 1000)}K 已超预算 ${Math.round(budget / 1000)}K，自动压缩…`,
      level: "warn",
    });
    try {
      await this.compact();
    } catch {
      /* a failed compaction should not break the turn */
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const data = await this.rpc?.request<any>("set_model", { provider, modelId });
    const name = typeof data?.name === "string" ? data.name : undefined;
    this.setState({ model: modelId, modelName: name ?? this.state.modelName });
    // pi may clamp the thinking level to what the new model supports.
    try {
      this.absorbState(await this.rpc?.request<any>("get_state", {}, 15000));
    } catch {
      /* best effort */
    }
  }

  async setThinking(level: string): Promise<void> {
    await this.rpc?.request("set_thinking_level", { level } as any);
    this.setState({ thinkingLevel: level });
  }

  /** Keeps the in-memory transcript in step with what we broadcast, so late joiners see history. */
  private upsert(item: Item, replaceId?: string): void {
    const key = replaceId ?? item.id;
    const at = this.items.findIndex((it) => it.id === key);
    if (at >= 0) this.items[at] = item;
    else this.items.push(item);
    this.state.updatedAt = Date.now();
  }

  snapshot(): {
    state: SessionState;
    items: Item[];
    approvals: ApprovalRequest[];
    asks: AskRequest[];
    budget: number | null;
  } {
    return {
      state: this.state,
      items: this.items,
      approvals: [...this.approvals.values()],
      asks: [...this.asks.values()].map(publicAsk),
      budget: this.contextBudget,
    };
  }

  idleFor(): number {
    return Date.now() - this.lastActivity;
  }

  async close(): Promise<void> {
    this.clearApprovals();
    this.clearAsks();
    this.stopTail();
    if (this.rpc) {
      const rpc = this.rpc;
      rpc.kill();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        rpc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      this.rpc = null;
    }
    if (this.state.owned) releaseLock(this.state.id);
    this.state.owned = false;
    this.setState({ running: false });
  }

  sleep(): void {
    if (this.state.running) return;
    void this.close().then(() => {
      this.emitWs({ type: "notice", sessionId: this.state.id, text: "会话已休眠（消息仍在，下次发消息会自动唤醒）", level: "info" });
      this.emitWs({ type: "session.state", session: this.state });
    });
  }
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private gcTimer: NodeJS.Timeout | null = null;
  private cache: { at: number; metas: SessionFileMeta[] } | null = null;
  private modelCache: { at: number; list: ModelInfo[] } | null = null;
  /** Pin / manual order / archive — the part of the sidebar the user owns (D46). */
  readonly manage = new Manage();

  constructor(
    private cli: string,
    /** Loopback URL the child posts asks to; null disables the whole feature. */
    private askUrl: string | null = null,
  ) {
    super();
  }

  /** Resolve the child that owns this token. Returns null for anything we did not spawn. */
  byAskToken(token: string): Session | null {
    if (!token) return null;
    for (const s of this.sessions.values()) if (s.askToken === token) return s;
    return null;
  }

  /**
   * The model catalog belongs to the pi install, not to a session, so it is fetched with a
   * throwaway rpc child and cached — models.json rarely changes mid-run.
   */
  async models(force = false): Promise<ModelInfo[]> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.list;
    const list = await fetchModels(this.cli);
    this.modelCache = { at: Date.now(), list };
    return list;
  }

  /** Session files on disk, cached briefly: reading 180+ headers on every message is wasteful. */
  private metas(): SessionFileMeta[] {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 5000) return this.cache.metas;
    const metas = listSessionFiles(sessionsRoot());
    this.cache = { at: now, metas };
    this.syncNames(metas);
    return metas;
  }

  /** A newer `session_info` in the file (a terminal `/name`) beats a sidebar label this bridge owns. */
  private syncNames(metas: SessionFileMeta[]): void {
    const byId = new Map(metas.map((m) => [m.id, m]));
    for (const session of this.sessions.values()) {
      if (session.live) continue; // live sessions hear about it through pi's session_info_changed
      const meta = byId.get(session.state.id);
      if (!meta) continue;
      const name = preferredName(meta.id, meta.name, meta.nameAt);
      if (name) session.adoptName(name);
    }
  }

  /** Disk sessions that no live process owns (read-only tail). */
  discover(): SessionFileMeta[] {
    return this.metas().filter((m) => !readLock(m.id));
  }

  list(): SessionState[] {
    const seen = new Set<string>();
    const out: SessionState[] = [];
    const manage = this.manage.snapshot();
    const flag = (id: string) => ({ pinned: manage.pin.includes(id), archived: manage.archived.includes(id) });
    for (const s of this.sessions.values()) {
      seen.add(s.state.id);
      // Copy: these flags must not leak into the live state a session broadcasts.
      out.push({ ...s.state, ...flag(s.state.id) });
    }
    for (const meta of this.discover()) {
      if (seen.has(meta.id)) continue;
      out.push({
        id: meta.id,
        name: preferredName(meta.id, meta.name, meta.nameAt) ?? meta.firstUserText?.slice(0, 40) ?? meta.id.slice(0, 8),
        cwd: meta.cwd,
        file: meta.file,
        owned: false,
        running: false,
        done: false,
        updatedAt: meta.mtime,
        startedAt: meta.startedAt,
        approvals: 0,
        asks: 0,
        ...flag(meta.id),
      });
    }
    // Pinned first, then the hand-made order, then the new ones by creation time (D45 + D46).
    out.sort((a, b) => this.manage.compare(a, b));
    return out;
  }

  /** Sessions that some other process owns (e.g. the terminal) — read-only. */
  lockedIds(): string[] {
    const out: string[] = [];
    for (const m of this.metas()) {
      const lock = readLock(m.id);
      if (lock && lock.pid !== process.pid) out.push(m.id);
    }
    return out;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Skill list for a session, or for a plain cwd when no session object is loaded yet. */
  async skillsFor(id: string, cwd?: string): Promise<SkillInfo[]> {
    const session = this.sessions.get(id);
    if (session) return session.skills();
    return rankSkills(scanSkills(cwd || process.cwd()));
  }

  private wire(session: Session): void {
    session.on("ws", (payload: any) => this.emit("ws", payload));
    session.askUrl = this.askUrl;
    session.on("state", (state: SessionState) => this.emit("ws", { type: "session.state", session: state }));
    session.on("approval", (approval: ApprovalRequest) => this.emit("approval", approval));
    session.on("ask", (ask: AskRequest, tool: string) => this.emit("ask", ask, tool));
    session.on("ask-resolved", (sessionId: string, id: string, status: string) =>
      this.emit("ask-resolved", sessionId, id, status),
    );
  }

  private ensure(id: string): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const meta = this.metas().find((m) => m.id === id) ?? null;
    const session = new Session(this.cli, meta, { id });
    this.wire(session);
    if (!session.live) session.startTail();
    this.sessions.set(id, session);
    return session;
  }

  async create(cwd: string, name?: string): Promise<Session> {
    const id = crypto.randomUUID();
    const session = new Session(this.cli, null, { id, name });
    session.state.cwd = cwd;
    this.wire(session);
    this.sessions.set(id, session);
    await session.startLive({ resume: false, cwd, name });
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  /** Sidebar rename. Live sessions also write the name into the session file through pi. */
  async rename(id: string, name: string): Promise<Session> {
    // Only rename sessions we can actually show: `ensure` would otherwise materialize a phantom.
    if (!this.sessions.has(id) && !this.metas().some((m) => m.id === id)) throw new Error("找不到这个会话");
    const session = this.ensure(id);
    await session.rename(name);
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  /** Opens an existing session as the live writer (resumes it if pi already wrote it). */
  /** Explicit takeover: the web becomes the single writer for a session file. */
  async claim(id: string): Promise<Session> {
    const session = await this.openLive(id);
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  async openLive(id: string): Promise<Session> {
    const session = this.ensure(id);
    if (session.live) return session;
    // D8: a file that changed seconds ago probably still has a terminal writer.
    const file = session.state.file;
    if (file) {
      try {
        const ageMs = Date.now() - fs.statSync(file).mtimeMs;
        if (ageMs < 20000) {
          throw new Error("这个会话 20 秒前还在被写入——终端里的 pi 可能还开着。先退出那边的会话，再在这里继续。");
        }
      } catch (e: any) {
        if (String(e?.message ?? "").includes("20 秒前")) throw e;
      }
    }
    await session.startLive({ resume: Boolean(session.state.file) });
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  /** The sidebar arrangement as a whole; the frontend sends what the DOM looks like after a drop. */
  arrange(pin: unknown, order: unknown): void {
    this.manage.arrange(pin, order);
  }

  setArchived(ids: string[], on: boolean): void {
    this.manage.setArchived(ids, on);
  }

  /**
   * Delete session files. The only destructive operation in the bridge: a live session or one with
   * a pending approval is never deleted (its writer would keep writing to a removed file), and a
   * session locked by the terminal is left alone.
   */
  async remove(ids: string[]): Promise<string[]> {
    const metas = new Map(this.metas().map((m) => [m.id, m]));
    const targets: { id: string; file: string | null }[] = [];
    const busy: string[] = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      const meta = metas.get(id);
      if (!session && !meta) continue;
      const name = session?.state.name ?? meta?.name ?? id.slice(0, 8);
      const lock = readLock(id);
      if (session?.live || (session && session.approvals.size > 0) || (lock && lock.pid !== process.pid)) {
        busy.push(name);
        continue;
      }
      targets.push({ id, file: session?.state.file ?? meta?.file ?? null });
    }
    if (busy.length) throw new Error(`${busy.length} 个会话正在运行/待确认，不能删：${busy.slice(0, 2).join("、")}`);
    for (const t of targets) {
      if (t.file) {
        try {
          fs.unlinkSync(t.file);
        } catch {
          /* already gone */
        }
      }
      const session = this.sessions.get(t.id);
      if (session) {
        try {
          await session.close();
        } catch {
          /* closing a read-only tail cannot fail the delete */
        }
        this.sessions.delete(t.id);
      }
      forgetName(t.id);
      this.manage.forget(t.id);
    }
    // The file scan is cached for a few seconds; a delete must not be resurrected by it.
    this.cache = null;
    return targets.map((t) => t.id);
  }

  snapshot(id: string) {
    // Handing a snapshot to a client is "the user is looking at it now".
    const session = this.ensure(id);
    session.markSeen();
    return session.snapshot();
  }

  respond(id: string, approvalId: string, decision: "approve" | "reject" | "cancel" | "always"): void {
    this.sessions.get(id)?.answerApproval(approvalId, decision);
  }

  answerAsk(id: string, askId: string, answers: AskAnswer[]): void {
    this.sessions.get(id)?.answerAsk(askId, answers);
  }

  cancelAsk(id: string, askId: string, reason?: string): void {
    this.sessions.get(id)?.cancelAsk(askId, reason);
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.close();
    session.startTail();
  }

  /** Dead writers' lock files leak when their session file is gone; sweep them on a timer. */
  sweepLocks(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(statePath("locks"));
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith(".lock")) readLock(name.slice(0, -5));
    }
  }

  startGc(): void {
    if (this.gcTimer) return;
    this.sweepLocks();
    this.gcTimer = setInterval(() => {
      this.sweepLocks();
      for (const s of this.sessions.values()) {
        if (!s.live) continue;
        if (s.state.running) continue;
        if (s.approvals.size) continue;
        if (s.asks.size) continue;
        if (s.idleFor() > IDLE_GC_MS) s.sleep();
      }
    }, 60_000);
    this.gcTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}

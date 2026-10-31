import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { RpcChild } from "./rpc.ts";
import { loadEntries, listSessionFiles, titleFromUserText, type SessionFileMeta } from "./sessionfile.ts";
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
  /** First user message (title-normalized); lets the manager search what a session was about. */
  preview?: string;
  /** Sidebar arrangement (bridge-side state/manage.json), only filled in by list(). */
  pinned?: boolean;
  archived?: boolean;
  /** Tool permission mode the approval gate enforces (state/allow/<id>.json `mode`). */
  permission?: PermissionMode;
  /** Another process (the pi terminal) holds the lock, so this one is read-only and undeletable. */
  locked?: boolean;
}

export interface RemoveReport {
  removed: string[];
  /** Ids left alone, with the reason the manager shows next to the name. */
  skipped: { id: string; name: string; reason: string }[];
}

/** One deleted session, parked in the bridge's own bin until it is emptied for real. */
export interface TrashItem {
  id: string;
  name: string;
  /** Where the file lived; restore puts it back here. */
  file: string;
  cwd?: string;
  deletedAt: number;
  size: number;
}

/** Trash payloads live next to the bridge's state, never in pi's sessions dir. */
function trashPayload(id: string): string {
  return statePath("trash", `${id}.jsonl`);
}

/** rename() answers EXDEV when the agent dir sits on another volume than the bridge state dir. */
function moveFile(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

function readTrash(): TrashItem[] {
  const raw = readJson<{ items?: unknown }>(statePath("trash.json"), {});
  const items = Array.isArray(raw.items) ? (raw.items as TrashItem[]) : [];
  return items.filter((it) => it && typeof it.id === "string" && typeof it.file === "string");
}

function writeTrash(items: TrashItem[]): void {
  writeJson(statePath("trash.json"), { items });
}

export type PermissionMode = "readonly" | "strict" | "ask" | "auto";
const PERMISSION_MODES: PermissionMode[] = ["readonly", "strict", "ask", "auto"];
const PERMISSION_LABEL: Record<PermissionMode, string> = {
  readonly: "只读",
  strict: "逐个确认",
  ask: "危险时确认",
  auto: "全自动",
};

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as string[]).includes(v);
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
const IDLE_EVICT_MS = 10 * 60 * 1000;

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

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "create_file", "str_replace"]);
/** Chained / redirected / substituted commands are never remembered (the gate refuses them too). */
const COMPOUND = /[;&|`<>\r\n]|\$\(/;

/**
 * What "本会话允许这类" remembers. A write is pinned to its exact path; a shell command to its
 * leading program (+ subcommand), and only when the command is a single plain command.
 */
function derivePattern(message: string): string | null {
  const arrow = message.indexOf("→");
  if (arrow < 0) return null;
  const tool = message.slice(0, arrow).trim().toLowerCase();
  const detail = message.slice(arrow + 1).trim();
  if (!detail) return null;
  if (WRITE_TOOLS.has(tool)) return detail;
  if (COMPOUND.test(detail)) return null;
  const tokens = detail.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const second = tokens[1] ?? "";
  return second && !second.startsWith("-") ? `${tokens[0]} ${second}` : tokens[0];
}

/** Remembered approvals are per session, matching the button's promise. */
function allowFile(id: string): string {
  return statePath("allow", `${id}.json`);
}

/** The gate re-reads this file on every tool call, so a change applies to the very next call. */
function readPermission(id: string): PermissionMode {
  if (!id) return "ask";
  const file = allowFile(id);
  if (!fs.existsSync(file)) return "ask";
  const mode = readJson<{ mode?: unknown }>(file, {})?.mode;
  return isPermissionMode(mode) ? mode : "ask";
}

function writePermission(id: string, mode: PermissionMode): void {
  const file = allowFile(id);
  const data = readJson<Record<string, unknown>>(file, {});
  writeJson(file, { ...(data && typeof data === "object" ? data : {}), mode });
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

/**
 * Sessions this bridge created. The file itself does not say who started it, and the sidebar must
 * tell web sessions from terminal (pi CLI) ones even after a bridge restart.
 */
let webOrigins: Set<string> | null = null;

function readWebOrigins(): Set<string> {
  if (webOrigins) return webOrigins;
  const raw = readJson<unknown>(statePath("web-sessions.json"), []);
  webOrigins = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  return webOrigins;
}

function setWebOrigin(id: string, on: boolean): void {
  const all = readWebOrigins();
  if (all.has(id) === on) return;
  if (on) all.add(id);
  else all.delete(id);
  try {
    writeJson(statePath("web-sessions.json"), [...all]);
  } catch {
    /* an unwritable state dir only costs persistence */
  }
}

export function forgetOrigin(id: string): void {
  setWebOrigin(id, false);
}

function originOf(id: string): "web" | "disk" {
  return readWebOrigins().has(id) ? "web" : "disk";
}

const DEFAULT_NAME = "新会话";

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
  /** Set while close() is taking pi down on purpose: its exit and shutdown noise are expected. */
  private closing = false;
  private closeQuietly = false;
  /** When our own pi last exited: writes up to then are ours, not a terminal's (see openLive D8). */
  ownExitAt = 0;
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
      name: opts.name ?? onDiskName ?? meta?.firstUserText?.slice(0, 40) ?? DEFAULT_NAME,
      cwd: meta?.cwd ?? process.cwd(),
      file: meta?.file ?? null,
      owned: false,
      origin: id ? originOf(id) : "disk",
      running: false,
      done: false,
      updatedAt: Date.now(),
      // Creation time is the sidebar's sort key, so a web-born session needs one too.
      startedAt: meta?.startedAt ?? new Date().toISOString(),
      approvals: 0,
      asks: 0,
      permission: readPermission(id),
      ...(meta?.firstUserText ? { preview: meta.firstUserText } : {}),
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

  applyPermission(mode: PermissionMode): void {
    if (this.state.permission === mode) return;
    this.setState({ permission: mode }, { touch: false });
    this.emitWs({ type: "notice", sessionId: this.state.id, text: `权限模式已切换为「${PERMISSION_LABEL[mode]}」，下一次工具调用起生效`, level: mode === "auto" ? "warn" : "info" });
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
    if (!opts.resume) {
      this.state.origin = "web";
      setWebOrigin(id, true);
    }

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
        PI_WEB_ALLOW_FILE: allowFile(id),
        // The ask-user extensions post here instead of opening a dialog (see PLAN-ask.md).
        ...(this.askUrl ? { PI_WEB_ASK: this.askUrl, PI_WEB_ASK_TOKEN: this.askToken } : {}),
      },
    });

    this.rpc.on("event", (ev: any) => this.onPiEvent(ev));
    this.rpc.on("ui_request", (req: any) => this.onUiRequest(req));
    this.rpc.on("stderr", () => this.touch());
    this.rpc.on("log", (line: string) => this.emitWs({ type: "notice", sessionId: id, text: line, level: "warn" }));
    this.rpc.on("exit", (reason: string) => {
      const closing = this.closing;
      const quiet = this.closeQuietly;
      this.closing = false;
      this.closeQuietly = false;
      this.ownExitAt = Date.now();
      this.state.owned = false;
      this.setState({ running: false });
      releaseLock(id);
      this.clearApprovals();
      this.clearAsks();
      // A stop the user asked for is not news; only an exit nobody asked for is worth the stderr tail.
      if (closing) {
        if (!quiet) this.emitWs({ type: "notice", sessionId: id, text: "已停止运行，历史留在磁盘，发消息会自动接管。", level: "info" });
      } else this.emitWs({ type: "notice", sessionId: id, text: `pi 进程意外退出：${reason}`, level: "warn" });
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
        // Shutting down mid-turn trips pi's own turn_end boundary; that is noise, not an extension bug.
        if (this.closing) break;
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
    // select / input / editor are questions, not approvals (e.g. ask_user_question's rpc fallback
    // walks its questionnaire with them). They go through the ask drawer and are answered with
    // `{value}`; answering them with `{confirmed}` made pi read every reply as a dismissal.
    if (req.method === "select" || req.method === "input" || req.method === "editor") {
      this.askViaDialog(id, req);
      return;
    }
    if (req.method === "confirm") {
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

  private askViaDialog(uiId: string, req: any): void {
    const options = req.method === "select" && Array.isArray(req.options) ? req.options.map(String) : [];
    const prompt = String(req.title ?? req.message ?? req.prompt ?? "").trim() || "请回答";
    const question: AskQuestion = {
      id: "q1",
      prompt,
      options: options.map((o: string) => ({ value: o, label: o })),
      allowOther: true,
    };
    const { id: askId, outcome } = this.ask([question], `ui.${req.method}`);
    // pi resolves its own dialog when the timeout runs out; take the drawer down with it.
    const timer = typeof req.timeout === "number" && req.timeout > 0 ? setTimeout(() => this.cancelAsk(askId, "超时了"), req.timeout) : null;
    void outcome.then((out) => {
      if (timer) clearTimeout(timer);
      const value = out.answers?.[0]?.value;
      if (out.cancelled || typeof value !== "string") this.rpc?.uiRespond({ id: uiId, cancelled: true });
      else this.rpc?.uiRespond({ id: uiId, value });
    });
  }

  answerApproval(id: string, decision: "approve" | "reject" | "cancel" | "always"): void {
    const req = this.approvals.get(id);
    if (!req) return;
    if (decision === "always") {
      const pattern = derivePattern(req.message);
      if (pattern) {
        const file = allowFile(this.state.id);
        const data = readJson<{ patterns: string[] }>(file, { patterns: [] });
        if (!Array.isArray(data.patterns)) data.patterns = [];
        if (!data.patterns.includes(pattern)) {
          data.patterns.push(pattern);
          writeJson(file, data);
        }
        this.emitWs({ type: "notice", sessionId: this.state.id, text: `已记住「${pattern}」，本会话内这一类不再问你`, level: "info" });
      } else {
        this.emitWs({ type: "notice", sessionId: this.state.id, text: "这是复合命令，只批准了这一次，不会记住", level: "info" });
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
    // A web-born session has no title until it says something; the terminal would show the first
    // message too. Sidebar-only: nothing is appended to the session file.
    if (this.state.name === DEFAULT_NAME || !this.state.preview) {
      const title = titleFromUserText(text);
      if (title) {
        const patch: Partial<SessionState> = {};
        if (!this.state.preview) patch.preview = title;
        if (this.state.name === DEFAULT_NAME) patch.name = title.slice(0, 40);
        this.setState(patch, { touch: false });
      }
    }
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
    let fromPi = false;
    if (this.rpc?.alive) {
      try {
        // A freshly spawned pi answers only after loading every extension; that can take >8s.
        const res = await this.rpc.request<any>("get_commands", {}, 30000);
        fromPi = true;
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
    // Only pi's own answer is worth keeping; a fallback list is retried on the next open.
    this.skillsCache = fromPi ? { at: Date.now(), list: ranked } : null;
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

  async close(opts: { quiet?: boolean } = {}): Promise<void> {
    this.clearApprovals();
    this.clearAsks();
    this.stopTail();
    if (this.rpc) {
      const rpc = this.rpc;
      this.closing = true;
      this.closeQuietly = Boolean(opts.quiet);
      // Ending stdin mid-turn kills pi before it persists the assistant message, and its turn_end
      // boundary then reports "could not resolve the persisted assistant entry ID". Abort first
      // and give the turn a moment to settle on disk.
      if (this.state.running && rpc.alive) {
        rpc.fire("abort");
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000);
          const check = () => {
            if (!this.state.running || !rpc.alive) {
              clearTimeout(t);
              this.off("state", check);
              resolve();
            }
          };
          this.on("state", check);
          check();
        });
      }
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
    void this.close({ quiet: true }).then(() => {
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
      const lock = readLock(s.state.id);
      // Copy: these flags must not leak into the live state a session broadcasts.
      out.push({ ...s.state, ...flag(s.state.id), locked: Boolean(lock && lock.pid !== process.pid) });
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
        origin: originOf(meta.id),
        permission: readPermission(meta.id),
        ...(meta.firstUserText ? { preview: meta.firstUserText } : {}),
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

  /** Where a session works and logs, whether or not it is loaded. */
  locate(id: string): { cwd: string; file: string | null } | null {
    const s = this.sessions.get(id);
    if (s) return { cwd: s.state.cwd, file: s.state.file };
    const meta = this.metas().find((m) => m.id === id);
    return meta ? { cwd: meta.cwd, file: meta.file } : null;
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
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      /* reported below */
    }
    if (!isDir) throw new Error(`工作目录不存在：${cwd}`);
    const id = crypto.randomUUID();
    const session = new Session(this.cli, null, { id, name });
    session.state.cwd = cwd;
    this.wire(session);
    this.sessions.set(id, session);
    await session.startLive({ resume: false, cwd, name });
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  /** Only ids this bridge spawned or found on disk; anything else from a client is refused. */
  private known(id: string): boolean {
    return Boolean(id) && (this.sessions.has(id) || this.metas().some((m) => m.id === id));
  }

  /** Sidebar rename. Live sessions also write the name into the session file through pi. */
  async rename(id: string, name: string): Promise<Session> {
    // Only rename sessions we can actually show: `ensure` would otherwise materialize a phantom.
    if (!this.known(id)) throw new Error("找不到这个会话");
    const session = this.ensure(id);
    await session.rename(name);
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  /** Composer permission button: persisted per session, picked up by the gate on the next tool call. */
  setPermission(id: string, mode: PermissionMode): Session {
    if (!this.known(id)) throw new Error("找不到这个会话");
    const session = this.ensure(id);
    writePermission(id, mode);
    session.applyPermission(mode);
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
    if (!this.known(id)) throw new Error("找不到这个会话");
    const session = this.ensure(id);
    if (session.live) return session;
    // D8: a file that changed seconds ago probably still has a terminal writer — unless the last
    // write came from our own pi, which has exited since (stop → reclaim right away must work).
    const file = session.state.file;
    if (file) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        const ageMs = Date.now() - mtime;
        const ours = session.ownExitAt > 0 && mtime <= session.ownExitAt + 1000;
        if (ageMs < 20000 && !ours) {
          throw new Error("这个会话 20 秒前还在被写入——终端里的 pi 可能还开着。先退出那边的会话，再在这里继续。");
        }
      } catch (e: any) {
        if (String(e?.message ?? "").includes("20 秒前")) throw e;
      }
    }
    await session.startLive({ resume: Boolean(session.state.file) });
    this.emit("ws", { type: "session.state", session: session.state });
    if (session.state.origin !== "web") {
      // pi's TUI reads the session file once at startup: an open terminal will not see what the web adds.
      this.emit("ws", {
        type: "notice",
        sessionId: id,
        level: "warn",
        text: `网页已接管这个终端会话。终端里如果还开着它，那边不会同步网页里的对话，也不要在那边继续输入（会分叉）——请先在终端退出 pi。要回终端接着聊：点「让回终端」，再运行 pi --session ${id}`,
      });
    }
    return session;
  }

  /** The sidebar arrangement as a whole; the frontend sends what the DOM looks like after a drop. */
  arrange(pin: unknown, order: unknown): void {
    this.manage.arrange(pin, order);
  }

  /** Q-022: 置顶横条的 ＋ 建出来的会话，落到 pin 列表末尾。 */
  pinLast(id: string): void {
    this.manage.pinLast(id);
  }

  setArchived(ids: string[], on: boolean): void {
    this.manage.setArchived(ids, on);
  }

  /**
   * Delete session files. The only destructive operation in the bridge: a live session or one with
   * a pending approval is never deleted (its writer would keep writing to a removed file), and a
   * session locked by the terminal is left alone.
   *
   * Partial success on purpose: a busy session no longer cancels the whole batch. It used to throw
   * before any unlink, so the client cleared its selection, nothing was deleted, no `session.gone`
   * was broadcast, and the cards stayed on screen with no visible reason.
   *
   * Deleting only moves the file into the bin (`purge` is the one irreversible step). The file leaves
   * pi's sessions dir, which is why pi itself and the list stop showing it.
   */
  async trash(ids: string[]): Promise<RemoveReport> {
    const metas = new Map(this.metas().map((m) => [m.id, m]));
    const targets: { id: string; name: string; file: string | null; cwd?: string }[] = [];
    const skipped: RemoveReport["skipped"] = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      const meta = metas.get(id);
      if (!session && !meta) continue;
      const name = session?.state.name ?? meta?.name ?? id.slice(0, 8);
      const lock = readLock(id);
      const why = session?.live
        ? "正在运行"
        : session && session.approvals.size > 0
          ? "有待批准的请求"
          : lock && lock.pid !== process.pid
            ? "终端正在使用"
            : "";
      if (why) {
        skipped.push({ id, name, reason: why });
        continue;
      }
      targets.push({ id, name, file: session?.state.file ?? meta?.file ?? null, cwd: session?.state.cwd ?? meta?.cwd });
    }
    const binned: TrashItem[] = [];
    for (const t of targets) {
      if (!t.file) {
        skipped.push({ id: t.id, name: t.name, reason: "找不到会话文件" });
        continue;
      }
      try {
        const size = fs.statSync(t.file).size;
        moveFile(t.file, trashPayload(t.id));
        binned.push({ id: t.id, name: t.name, file: t.file, cwd: t.cwd, deletedAt: Date.now(), size });
      } catch (err: any) {
        skipped.push({ id: t.id, name: t.name, reason: `文件移不进垃圾箱（${err?.code ?? err}）` });
        continue;
      }
      const session = this.sessions.get(t.id);
      if (session) {
        try {
          await session.close();
        } catch {
          /* closing a read-only tail cannot fail the move */
        }
        this.sessions.delete(t.id);
      }
      forgetName(t.id);
      forgetOrigin(t.id);
      this.manage.forget(t.id);
    }
    if (binned.length) {
      const gone = new Set(binned.map((b) => b.id));
      writeTrash([...readTrash().filter((it) => !gone.has(it.id)), ...binned]);
    }
    // The file scan is cached for a few seconds; a move must not be resurrected by it.
    this.cache = null;
    return { removed: binned.map((t) => t.id), skipped };
  }

  /** Newest first. Rows whose payload vanished are dropped instead of shown as dead entries. */
  trashList(): TrashItem[] {
    const items = readTrash();
    const alive = items.filter((it) => fs.existsSync(trashPayload(it.id)));
    if (alive.length !== items.length) writeTrash(alive);
    return alive.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Put files back where they came from. Locks and approvals do not apply: nothing is running. */
  restore(ids: string[]): { restored: string[]; skipped: { id: string; reason: string }[] } {
    const items = readTrash();
    const byId = new Map(items.map((it) => [it.id, it]));
    const restored: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const it = byId.get(id);
      if (!it) {
        skipped.push({ id, reason: "不在垃圾箱里" });
        continue;
      }
      try {
        moveFile(trashPayload(id), it.file);
        restored.push(id);
      } catch (err: any) {
        skipped.push({ id, reason: `还原失败（${err?.code ?? err}）` });
      }
    }
    if (restored.length) {
      const back = new Set(restored);
      writeTrash(items.filter((it) => !back.has(it.id)));
      this.cache = null;
    }
    return { restored, skipped };
  }

  /** The one irreversible action. No ids empties the whole bin. */
  purge(ids?: string[]): { purged: string[] } {
    const items = readTrash();
    const want = ids?.length ? new Set(ids) : null;
    const purged: string[] = [];
    for (const it of items) {
      if (want && !want.has(it.id)) continue;
      try {
        fs.unlinkSync(trashPayload(it.id));
      } catch {
        /* already gone */
      }
      purged.push(it.id);
    }
    if (purged.length) {
      const gone = new Set(purged);
      writeTrash(items.filter((it) => !gone.has(it.id)));
    }
    return { purged };
  }

  snapshot(id: string) {
    if (!this.known(id)) throw new Error("找不到这个会话");
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
    const terminal = session.state.origin !== "web";
    await session.close({ quiet: terminal });
    session.startTail();
    if (terminal) {
      this.emit("ws", {
        type: "notice",
        sessionId: id,
        level: "info",
        text: `已让回终端。在终端运行 pi --session ${id} 打开它，就能看到网页里的全部对话（已经开着的旧 pi 窗口不会自己刷新，要重开）。`,
      });
    }
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

  /**
   * `isWatched` says whether some client is looking at a session right now. Read-only sessions
   * nobody watches are dropped after a while: each one holds its transcript and a 400ms file poll.
   */
  startGc(isWatched: (id: string) => boolean = () => false): void {
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
      for (const [id, s] of this.sessions) {
        if (s.live || s.state.running || s.state.done) continue;
        if (s.approvals.size || s.asks.size) continue;
        // A web-born session with no file yet only exists in memory; evicting it would lose it.
        if (!s.state.file) continue;
        if (isWatched(id) || s.idleFor() < IDLE_EVICT_MS) continue;
        s.stopTail();
        s.removeAllListeners();
        this.sessions.delete(id);
      }
    }, 60_000);
    this.gcTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}

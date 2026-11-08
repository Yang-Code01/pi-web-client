import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { RpcChild } from "./rpc.ts";
import { displayUserText, loadEntries, listSessionFiles, normalizeUserText, readMeta, titleFromUserText, typedSkill, type SessionEntry, type SessionFileMeta } from "./sessionfile.ts";
import { BASH_KEEP, currentBranch, customMessageItem, entriesToItems, summarizeToolArgs, type BashItem, type Item, type ToolItem, type UserItem } from "./items.ts";
import { fileURLToPath } from "node:url";
import { piModule } from "./pimods.ts";
import { describeLaunch, launchArgs, readLaunch, writeLaunch, type LaunchOptions } from "./launch.ts";
import { lessonFile } from "./lessons.ts";
import { DELIVERY_HINT } from "./delivery.ts";
import { ensureDir, scratchCwd, scratchSessionsDir, sessionsRoot, sessionsRootInfo, statePath, readJson, writeJson } from "./paths.ts";
import { fetchModels, type ModelInfo } from "./pi.ts";
import { Manage } from "./manage.ts";
import { Workspaces } from "./workspaces.ts";
import { rankSkills, scanSkills, type SkillInfo } from "./skills.ts";
import { matchDialog, parseQuestionnaire, replyFor, type QuestionnaireQuestion } from "./questionnaire.ts";
import { lifecycle, gcTickMs, capProtectMs, type Lifecycle, type LifecycleThresholds } from "./lifecycle.ts";
import { absentFor } from "./presence.ts";
import { sampleMemory } from "./runtime.ts";
import { defaultPermission } from "./permissiondefault.ts";
import { BgRuns, type BgRun, type BgRunView, type BgView } from "./bgruns.ts";
import { isProtocolWidgetLines } from "./extwidgets.ts";
import { itemsFrame, type SessionHistory } from "./history.ts";

/** The approval gate ships next to the bridge sources, not inside dist. */
function approvalGatePath(): string {
  return process.env.PI_WEB_GATE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ext", "approval-gate.ts");
}

/** #224：`open_preview` 只属于网页会话 —— 它做的事就是把文件交给网页的预览面板。 */
function previewToolPath(): string {
  return process.env.PI_WEB_PREVIEW_TOOL ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ext", "open-preview.ts");
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  title: string;
  message: string;
  createdAt: number;
  deadline?: number;
}

/** What an approval was about, short enough to name it in a notice: the command it asked for. */
function summarizeApproval(approval: ApprovalRequest): string {
  const text = approval.message.replace(/\s+/g, " ").trim() || approval.title.trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
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
  /** 多选：答案带 `picks`（1 起的选项序号）和可选的 `text`。 */
  multiSelect?: boolean;
}

export interface AskAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom?: boolean;
  index?: number;
  /** 多选题选中的选项序号（1 起）。 */
  picks?: number[];
  /** 多选题另外写的话。 */
  text?: string;
}

export interface AskRequest {
  id: string;
  sessionId: string;
  sessionName: string;
  questions: AskQuestion[];
  createdAt: number;
  /** Q-033：发问方给的超时（毫秒）。只作参考，卡片不会因此消失。 */
  timeoutMs?: number;
}

export interface AskOutcome {
  answers: AskAnswer[] | null;
  cancelled: boolean;
}

interface PendingAsk extends AskRequest {
  resolve: (out: AskOutcome) => void;
}

/** D90: one `ask_user_question` call whose dialogs are answered from a single web ask. */
interface OpenQuestionnaire {
  askId: string;
  questions: QuestionnaireQuestion[];
  /** null until the user submits (or cancels) the web ask. */
  outcome: AskOutcome | null;
  /** Questions whose dialog already arrived. */
  taken: Set<string>;
  /** Dialogs that arrived before the answers did. */
  waiting: { uiId: string; req: any; question: QuestionnaireQuestion }[];
}

/** One running pi, as the runtime panel lists it (D120 / #77). */
export interface RuntimeSession {
  id: string;
  name: string;
  running: boolean;
  /** Since the last pi event — the same clock `sleepIdleSessions` reads, in milliseconds. */
  idleMs: number;
  /** Resident bytes, only when the sample was trustworthy and the table listed this pid. */
  bytes?: number;
}

/**
 * `runtime.stats`: who is running, what they cost, and whether that number is real. `totalBytes`
 * is `null` whenever nothing was measured (no running pi) or the reading failed (`unavailable`).
 */
export interface RuntimeStats {
  running: number;
  totalBytes: number | null;
  unavailable: boolean;
  /** Idle longest first. */
  sessions: RuntimeSession[];
  /**
   * The two thresholds in force, so the panel can show them and prove a change took (#78). Read on
   * every call, which is the same read the GC tick does — nothing is cached between ticks.
   * `abortGraceMs` stays inside: it is a test seam, not a number for the page.
   */
  lifecycle: LifecycleThresholds;
}

/** A session 「全部休眠」 had to leave alone (#80 / D120). `why` is a fixed id, not a sentence. */
export interface SleepSkipped {
  id: string;
  name: string;
  why: "running";
}

export interface SessionState {
  id: string;
  name: string;
  cwd: string;
  file: string | null;
  owned: boolean; // this bridge is the writer
  origin?: "web" | "disk"; // "web" = this bridge created it; "disk" = came from a pi session file
  /**
   * 随手问 (#86): not a session in the user's sense at all — it is hidden from every list, exempt
   * from the idle rule (it has its own longer one), exempt from the memory watermark and exempt from
   * auto-compaction. Its pi writes to its own session dir, so nothing ever scans it in. One flag,
   * read by all four rules, so they cannot drift apart.
   */
  scratch?: boolean;
  /** True while the pi child is still booting (extensions load there: ~8 s with a big set, D122). */
  starting?: boolean;
  running: boolean;
  /**
   * D162: the last turn finished and nothing has started since. Unlike the old "unread" flag this
   * survives opening the session, another device, a bridge restart and GC; agent_start, prompt(),
   * or the terminal writing the session file again clears it.
   */
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
  /** 工作区（一级分组 = 工程）的组 id，只有 list() 填（#72/#94）。空串 = 没有 cwd，不属于任何工作区。 */
  ws?: string;
  /** Tool permission mode the approval gate enforces (state/allow/<id>.json `mode`). */
  permission?: PermissionMode;
  /** Another process (the pi terminal) holds the lock, so this one is read-only and undeletable. */
  locked?: boolean;
  /**
   * D170: 派出去的后台子代理还在跑。会话自己的 `running` 已经落回 false —— 这正是要单列一块的原因，
   * 「继续」按钮和左栏徽标都靠它。纯内存态：桥重启就没了（会话文件里查不到 runner 的死活）。
   */
  bg?: BgView | null;
  /** Launch options chosen when the session was created on the web (#28), as one line. */
  launch?: string;
}

export interface RemoveReport {
  removed: string[];
  /** Ids left alone, with the reason the manager shows next to the name. */
  skipped: { id: string; name: string; reason: string }[];
  /** Ids that were running and got released on the way out (the page says so out loud). */
  released: string[];
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
    // A move must not look like a fresh write: D162 compares mtime with the finish mark.
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
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

export interface ExtUiState {
  status: { key: string; text: string }[];
  widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
  title: string | null;
}

/** Extensions style their text for the terminal; the page only wants the characters. */
export function stripAnsi(text: string): string {
  // CSI sequences, then OSC sequences (terminated by BEL or ST).
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

export interface TreeNode {
  /** Entry id of the user message. */
  id: string;
  /** Nearest earlier user message on its path, or null at the root. */
  parent: string | null;
  text: string;
  ts: string | null;
  /** On the branch pi would resume. */
  current: boolean;
}

/** pi's folder name for a cwd under the default sessions dir (session-manager.js getDefaultSessionDirPath). */
/** First line of a session file, parsed (or null). */
export function readHeader(file: string): { type?: string; version?: number; id?: string; cwd?: string } | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const line = buf.subarray(0, n).toString("utf8").split("\n")[0];
      const head = JSON.parse(line);
      return head?.type === "session" ? head : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function encodeCwd(cwd: string): string {
  return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

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
    ...(ask.timeoutMs ? { timeoutMs: ask.timeoutMs } : {}),
  };
}

const IDLE_EVICT_MS = 10 * 60 * 1000;
/** 模型目录的缓存寿命：models.json / 装的扩展很少在一次运行中间变，两段各自记一份。 */
const MODEL_TTL_MS = 10 * 60_000;

/** Rounded-up whole units for the watchdog's notices: 30 minutes and 60 seconds read like D120. */
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms: number): number => Math.max(1, Math.round(ms / 1000));

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

/**
 * #30: a terminal pi that runs the session-lock extension (bridge/ext/session-lock.ts) holds
 * `<locks>/<id>.tty.json` while the session is open there. Dead pids are pruned on read.
 */
export function readTtyLock(id: string): { pid: number } | null {
  const file = statePath("locks", `${id}.tty.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const pid = Number(JSON.parse(fs.readFileSync(file, "utf8"))?.pid);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) return { pid };
  } catch {
    /* unreadable: treat as stale */
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  return null;
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
/** Same list as bridge/ext/approval-gate.ts SHELL_TOOLS. */
const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "shell", "run_command", "execute", "exec", "terminal"]);

function derivePattern(message: string): string | null {
  const arrow = message.indexOf("→");
  if (arrow < 0) return null;
  const tool = message.slice(0, arrow).trim().toLowerCase();
  const detail = message.slice(arrow + 1).trim();
  if (!detail) return null;
  if (WRITE_TOOLS.has(tool)) return detail;
  // #29: strict mode also asks for tools the gate knows nothing about (MCP, extensions). For those
  // "always" means the tool itself — its arguments are JSON, not a command line with a prefix.
  if (!SHELL_TOOL_NAMES.has(tool)) return `tool:${tool}`;
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

/**
 * D161: the file also says where its mode came from. `from: "default"` means nobody ever chose it
 * by hand — that is the only kind of session 「应用到现有会话」 may rewrite later.
 */
interface PermissionFile {
  mode: PermissionMode;
  from: "default" | null;
}

function readPermissionFile(id: string): PermissionFile | null {
  if (!id) return null;
  const file = allowFile(id);
  if (!fs.existsSync(file)) return null;
  const data = readJson<{ mode?: unknown; from?: unknown }>(file, {});
  const mode = data?.mode;
  return { mode: isPermissionMode(mode) ? mode : "ask", from: data?.from === "default" ? "default" : null };
}

/** Cwds compare the way the platform does: case-insensitive on Windows, trailing separator ignored. */
function normalizeDir(dir: string): string {
  if (!dir) return "";
  const abs = path.resolve(dir).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** The gate re-reads this file on every tool call, so a change applies to the very next call. */
function readPermission(id: string): PermissionMode {
  return readPermissionFile(id)?.mode ?? "ask";
}

/** `from: "default"` marks a pinned default; a manual pick (no third argument) clears the marker. */
function writePermission(id: string, mode: PermissionMode, from: "default" | null = null): void {
  const file = allowFile(id);
  const data = readJson<Record<string, unknown>>(file, {});
  const next: Record<string, unknown> = { ...(data && typeof data === "object" ? data : {}), mode };
  if (from) next.from = from;
  else delete next.from;
  writeJson(file, next);
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

/**
 * D162: 「最后一轮已完成」是会话的状态，不是某个页面的未读 —— 打开、换设备、桥重启、GC 回收
 * 都不该抹掉它；下一轮运行、网页发消息，或终端又把会话文件写长了才清。存成
 * `{"<sessionId>": <finishedAt>}`，与 names.json 同一种「桥自己拥有、写失败只损失持久化」的口径。
 * 存时间戳而不是布尔：以后要在卡片上写「完成于 …」时不用再改文件格式。
 */
function finishedFile(): string {
  return statePath("finished.json");
}

let finishedAt: Record<string, number> | null = null;

function readFinishedMap(): Record<string, number> {
  if (finishedAt) return finishedAt;
  const raw = readJson<Record<string, unknown>>(finishedFile(), {});
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    const at = Number(value);
    if (id && Number.isFinite(at) && at > 0) out[id] = at;
  }
  finishedAt = out;
  return out;
}

function readFinishedAt(id: string): number | null {
  if (!id) return null;
  return readFinishedMap()[id] ?? null;
}

function writeFinishedAt(id: string, at: number | null): void {
  if (!id) return;
  const all = { ...readFinishedMap() };
  if (at) {
    all[id] = at;
  } else {
    if (!(id in all)) return;
    delete all[id];
  }
  finishedAt = all;
  try {
    writeJson(finishedFile(), all);
  } catch {
    /* an unwritable state dir only costs persistence */
  }
}

/** Drop a deleted session's completion mark so a future id cannot inherit it. */
export function forgetFinished(id: string): void {
  writeFinishedAt(id, null);
}

/** A file's mtime can lag the moment we recorded the finish (or the filesystem rounds it). */
const FINISHED_SKEW_MS = 1000;

/** D162: the session file was written after the finish was recorded — that 完成 is stale. */
function finishedIsStale(finishedAt: number | null, mtime: number | undefined): boolean {
  return Boolean(finishedAt && mtime && mtime > finishedAt + FINISHED_SKEW_MS);
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

/** 随手问 (#86): what it is called, and the only tools it ever gets. Not user-settable — the point
 * of the fixed list is that a write tool cannot be talked into existing. */
const SCRATCH_NAME = "随手问";
/**
 * 读本机文件 + 联网查，仍然不写、不改、不跑命令。
 *
 * 联网那几个由 `pi-web-access` 扩展提供；没装的时候写在这里也无害 —— 实测 pi 对 `--tools`
 * 里不存在的名字只当没写，不会起不来（.scratch/tool-name-probe.mjs 验过）。
 */
const SCRATCH_TOOLS = "read,grep,find,ls,web_search,fetch_content,source_check,get_search_content";
/** 随手问的问题通常一句两句就说完：默认关思考，省 token 也快（按模型能力由 pi 自行 clamp）。 */
const SCRATCH_THINKING = "off";

/**
 * #197 / #200：启动窗口期收下、还没交给 pi 的一条消息。气泡已经落地（`pending: "booting"`），
 * 消息本体留在桥里；失败后原件挪进 `bootFailed`，重试时按原顺序送回队首。
 */
type BootEntry = { id: string; text: string; images?: { data: string; mimeType: string }[]; behavior: "steer" | "followUp" };

/** #200：失败的原因决定那句人话怎么说 —— 界面不出现 exit code 这类内部话术。 */
type BootFailure = "boot" | "stopped" | "refused";

/**
 * #198：交下一条之前等「这一轮真的开始」的上限。等不到就裸发 —— 宁可让 pi 自己开一轮，也不能
 * 让用户盯着一个气泡干等（第一条可能被 `disposition: "handled"` 就地吃掉，压根没有 agent_start）。
 */
const BOOT_RUN_WAIT_MS = 10_000;

/** `session` 帧的载荷：一条会话可画的全部内容（#219 起 `session` 帧里的 `items` 只装末尾一页）。 */
export interface SessionSnapshot {
  state: SessionState;
  items: Item[];
  approvals: ApprovalRequest[];
  asks: AskRequest[];
  budget: number | null;
  ext: ExtUiState;
  queue: { steering: string[]; followUp: string[] };
}

export class Session extends EventEmitter {
  readonly state: SessionState;
  items: Item[] = [];
  rpc: RpcChild | null = null;
  readonly approvals = new Map<string, ApprovalRequest>();
  readonly asks = new Map<string, PendingAsk>();
  /** D90：还没结束的 `ask_user_question` 问卷，按 toolCallId。 */
  private questionnaires = new Map<string, OpenQuestionnaire>();
  /** Handed to the child in PI_WEB_LOOPBACK_TOKEN so only our own pi can call back into the bridge. */
  readonly loopbackToken = crypto.randomUUID();
  /** Set by SessionManager: loopback origin the child posts to (asks, preview opens). */
  loopbackUrl: string | null = null;

  /** Context-token ceiling the bridge enforces by compacting; null = off. Shared across sessions. */
  contextBudget: number | null = readBudget();
  /** Tokens the last get_session_stats reported, used to decide when the budget is blown. */
  private lastContextTokens: number | null = null;
  /** One auto-compaction per turn; the next agent_start re-arms it. */
  private autoCompactUsed = false;
  /** get_commands results, refreshed every couple of minutes. */
  private skillsCache: { at: number; list: SkillInfo[] } | null = null;

  private lastActivity = Date.now();
  /**
   * #81: when the watchdog aborted this run. Set once the abort is out, so the following ticks only
   * wait out `abortGraceMs` before ending the process; null while no abort is pending.
   */
  private stuckAbortedAt: number | null = null;
  /** One notice per silent run: the tick fires every minute, and none of them would be news. */
  private stuckNoticed = false;
  private tailTimer: NodeJS.Timeout | null = null;
  private tailSig = "";
  /** 上一次读会话文件失败的原因；null = 上次读成功了。同一句错只通知一次。 */
  private readError: string | null = null;
  /** D170：后台子代理。变化只往 `state.bg` 写一小块摘要（see `publishBg`）。 */
  private readonly bgRuns = new BgRuns(() => this.publishBg());

  /**
   * D170: 后台子代理只有两件事会变 —— 又起了一个、结束了一个。折成 `state.bg` 的一小块再广播；
   * 秒数由前端自己滴答，不走桥。
   */
  private publishBg(): void {
    const next = this.bgRuns.view();
    const cur = this.state.bg;
    // 字段会随「只剩刚跑完的」增减，逐个比不如比串形（见 `BgView`：n/since/recent/finishedAt/lastMs）。
    if (JSON.stringify(cur ?? null) === JSON.stringify(next ?? null)) return;
    // touch:false —— 后台跑着不算「这个会话有新动静」，左栏的时间别跟着跳。
    // 显式 `null` 而不是 `undefined`：`undefined` 过 JSON 会被整条丢掉，页面就永远清不掉提示条。
    this.setState({ bg: next ?? null }, { touch: false });
  }

  /** D170 详情：这个会话的后台任务（含刚跑完的）。没接过手的会话返回空。 */
  bgList(): BgRunView[] {
    return this.bgRuns.list();
  }

  /** D170 详情：一个 run 的活动记录尾 + 最终答复（只读临时目录里的痕迹文件）。 */
  bgLog(runId: string, limit?: number): { run?: BgRun; log?: string; out?: string } {
    return this.bgRuns.readLog(runId, limit);
  }  private draftCounter = 0;
  /** Set while close() is taking pi down on purpose: its exit and shutdown noise are expected. */
  private closing = false;
  private closeQuietly = false;
  /** When our own pi last exited: writes up to then are ours, not a terminal's (see openLive D8). */
  ownExitAt = 0;
  private draftId: string | null = null;
  private userCounter = 0;
  /**
   * Open while pi is compacting (ours or its own threshold/overflow run). pi throws on any prompt
   * submitted in that window (agent-session.js: "Cannot submit a prompt while compaction is in
   * progress"), so prompt() waits on it instead of bouncing the user's message.
   */
  private compaction: { done: Promise<void>; resolve: () => void } | null = null;

  /**
   * 这一轮是「⚡ 自动复盘」开的（D164 延伸）：复盘本来就在谈失败，D169 的当场叫住再插一嘴就是噪音。
   * 由 `failures.review` 置上、prompt 结束时落下；只影响 `failures.remind` 一个入口。
   */
  reviewing = false;
  /** User items sent while a run was active, i.e. sitting in pi's queue until delivered or cleared. */
  private queuedUser: { id: string; text: string }[] = [];
  /**
   * #197 / D178: 启动窗口期（`starting` 为真）收到的消息。气泡已经落地并广播，消息本身留在这里等
   * pi 起来 —— 只在桥内存里，桥重启就没了（代价见 D178）。就绪时按到达顺序交出去。
   */
  private bootQueue: BootEntry[] = [];
  /**
   * #200：启动期没交出去的那几条，等用户点「重试」。和 `bootQueue` 分开是因为它们不再排队等就绪
   * —— 它们在等一个人来点一下；点下去才回到队首（先拉起 pi，再按原顺序补发）。
   */
  private bootFailed: BootEntry[] = [];
  /**
   * #202 / D183: 启动窗口里敲下的 `!` 命令。bash 走 RPC，pi 没起来就没有通道，所以先排在这里，
   * 就绪后由 `flushBootBash` 逐条跑。已经发出去的 `!` 不随撤回退回（见 D183 的取舍）。
   */
  private bootBash: { itemId: string; command: string; excludeFromContext: boolean }[] = [];
  /** 补发泵一次只跑一条：并发跑会把顺序搅乱，也会把「这一轮开始了吗」的判断搞坏。 */
  private flushingBoot = false;
  /** 启动窗口里的 `!` 同理，一次只跑一条。 */
  private flushingBash = false;
  /** #198：泵挂在等 `agent_start` 的时候放这里，`agent_start` / 进程退出时把它叫醒。 */
  private bootRunWait: { resolve: () => void; timer: NodeJS.Timeout } | null = null;
  /** pi's queue as of the last queue_update, so a page opened mid-run sees it too (#14). */
  private queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  /** The `!cmd` running right now; pi streams its output as bash_execution_update (#16). */
  private bashRun: { itemId: string; output: string } | null = null;
  private bashCounter = 0;
  /**
   * What extensions put on screen with ctx.ui.setStatus / setWidget / setTitle. These are
   * fire-and-forget in RPC (no response), so the bridge keeps the latest state for late joiners.
   */
  private extStatus = new Map<string, string>();
  private extWidgets = new Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>();
  private extTitle: string | null = null;

  constructor(
    private cli: string,
    meta: SessionFileMeta | null,
    opts: { id?: string; name?: string } = {},
  ) {
    super();
    const id = opts.id ?? meta?.id ?? "";
    const onDiskName = preferredName(id, meta?.name ?? null, meta?.nameAt ?? null);
    const finished = readFinishedAt(id);
    // D162: 桥停机期间终端续写过这个会话（文件比完成标记新），旧的「完成」已经过期。
    const finishedStale = finishedIsStale(finished, meta?.mtime);
    if (finishedStale) writeFinishedAt(id, null);
    this.state = {
      id,
      name: opts.name ?? onDiskName ?? meta?.firstUserText?.slice(0, 40) ?? DEFAULT_NAME,
      cwd: meta?.cwd ?? process.cwd(),
      file: meta?.file ?? null,
      owned: false,
      origin: id ? originOf(id) : "disk",
      running: false,
      done: Boolean(finished) && !finishedStale,
      // D162: 打开一个老会话不是新活动 —— 时间停在文件最后一次真正被写的时刻，
      // 否则列表会在点开的一瞬间从「39分钟前」跳成「刚刚」。
      updatedAt: Math.round(meta?.mtime ?? Date.now()),
      // Creation time is the sidebar's sort key, so a web-born session needs one too.
      startedAt: meta?.startedAt ?? new Date().toISOString(),
      approvals: 0,
      asks: 0,
      permission: readPermission(id),
      ...(meta?.firstUserText ? { preview: meta.firstUserText } : {}),
    };
    const launch = id ? describeLaunch(readLaunch(id)) : "";
    if (launch) this.state.launch = launch;
    if (meta) this.loadFromFile();
  }

  get live(): boolean {
    return Boolean(this.rpc?.alive);
  }

  /** The pi child's pid while it is alive — what the runtime panel samples memory for (D120 §2). */
  get pid(): number | null {
    return this.rpc?.pid ?? null;
  }

  /**
   * D161: pin the default permission the first time the bridge ever looks at this session.
   *
   * 「第一次看见」 is creation, opening, or the startup scan — first one wins, and an existing file
   * is never touched again: a manual pick, or an earlier pin, is a decision already made. The
   * resolved value (project → global → ask) is written with `from: "default"` so 「应用到现有会话」
   * later knows which sessions are still nobody's choice.
   */
  async pinPermission(): Promise<void> {
    const id = this.state.id;
    if (!id) return;
    if (fs.existsSync(allowFile(id))) {
      // Already decided elsewhere: make sure a session built before the file existed agrees with it.
      const file = readPermissionFile(id);
      if (file && file.mode !== this.state.permission) this.applyPermission(file.mode);
      return;
    }
    let mode: PermissionMode = "ask";
    try {
      mode = (await defaultPermission(this.cli, this.state.cwd)).mode;
    } catch {
      /* 读设置失败不该挡住开关会话：退回 ask，下一次开会话再试 */
    }
    writePermission(id, mode, "default");
    this.applyPermission(mode);
  }

  /** D162: 完成过期 —— 新一轮开始，或会话文件被 tail 之外的东西续写。 */
  private clearFinished(): void {
    if (this.state.done) this.setState({ done: false }, { touch: false });
    writeFinishedAt(this.state.id, null);
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
  /**
   * 读盘的结果只有两种：读到了（`true`），或者没读到（`false`，内存里的对话保持原样）。
   * 读失败绝不能写成 `items = []` —— 前端收到一次 `items: []` 就会清屏，而磁盘上的会话好好的，
   * 用户看到的是「对话没了」。第一次读失败没内容可保，也要说一句为什么。
   */
  private loadFromFile(): boolean {
    if (!this.state.file) return true;
    try {
      const res = loadEntries(this.state.file);
      this.items = this.keepUnsentBubbles(entriesToItems(res.entries));
      this.state.truncated = res.truncated;
      this.readError = null;
      return true;
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      // 同一句错只报一次：刷新是 400ms 一次，重试期间不能每 tick 刷一条通知。
      if (reason !== this.readError) {
        this.readError = reason;
        this.notice(`读不到会话文件：${reason}；恢复后会自动重新加载`, "error", {
          code: "session_file_unreadable",
          params: { p1: reason },
        });
      }
      return false;
    }
  }

  refreshFromFile(): void {
    if (!this.state.file || this.live) return;
    try {
      const stat = fs.statSync(this.state.file);
      const sig = `${stat.size}:${Math.round(stat.mtimeMs)}`;
      if (sig === this.tailSig) return;
      // D162: 第一次读盘只是「打开」，不是一次活动 —— updatedAt 取文件自己的 mtime。
      // 之后文件真变了才 touch；终端里继续写也意味着上一轮完成状态过期了。
      const first = !this.tailSig;
      const before = this.items;
      // 读失败就不推进 tailSig：下一 tick 拿同一个签名再比一次、再读一次，文件恢复的那一刻自己接上。
      if (!this.loadFromFile()) return;
      this.tailSig = sig;
      if (first) {
        this.state.updatedAt = Math.round(stat.mtimeMs);
        // D162: a write while we were not tailing (terminal, or the bridge was stopped) expires
        // an older 完成; a file at or before the mark is just the run we already recorded.
        if (finishedIsStale(readFinishedAt(this.state.id), stat.mtimeMs)) this.clearFinished();
      } else {
        this.touch();
        this.clearFinished();
      }
      // Usually the file only grew, so the old transcript is a prefix of the new one. A branch
      // switch in the terminal (/tree, then a new message) replaces part of it: resend everything.
      const prefix = before.length <= this.items.length && before.every((it, i) => it.id === this.items[i].id);
      if (!prefix) {
        // #221: 分支切换换掉的是整条对话 —— 与首帧同一个规矩，只推末尾一页 + `history`。
        this.emitWs({ type: "items", sessionId: this.state.id, ...this.tailFrame() });
      } else {
        // Same ids can still carry new content: a tool card gets its result from a later line.
        for (let i = 0; i < before.length; i++) {
          if (JSON.stringify(before[i]) !== JSON.stringify(this.items[i])) {
            this.emitWs({ type: "item.replace", sessionId: this.state.id, id: before[i].id, item: this.items[i] });
          }
        }
        for (const item of this.items.slice(before.length)) this.emitWs({ type: "item.add", sessionId: this.state.id, item });
      }
    } catch {
      /* ignore */
    }
  }

  startTail(): void {
    if (this.tailTimer) return;
    this.refreshFromFile();
    this.tailTimer = setInterval(() => this.refreshFromFile(), 400);
  }

  /**
   * #201: 读回磁盘历史会把「还在桥这儿、pi 还没收到」的气泡冲掉 —— 它们本来就不在文件里。
   * 接管一个只读会话时正是这种局面（先是气泡，然后才拉起 pi 重读文件）：不接回来，用户刚打的
   * 那句会凭空消失，而消息其实还排在队列里，一会儿又交出去了。
   *
   * `bootFailed` 里的也算：它们是「没发出去、等重试」的那几条，重试会重新排队 —— 气泡要是先被
   * 读文件冲掉，重试时就找不到东西可标了。
   *
   * 顺序按 `this.items` 里原来的先后，接在历史后面 —— 那也正是它们被发出去的顺序。
   */
  private keepUnsentBubbles(items: Item[]): Item[] {
    if (!this.bootQueue.length && !this.bootFailed.length) return items;
    const unsent = new Set([...this.bootQueue, ...this.bootFailed].map((q) => q.id));
    const have = new Set(items.map((it) => it.id));
    const keep = this.items.filter((it) => unsent.has(it.id) && !have.has(it.id));
    return keep.length ? [...items, ...keep] : items;
  }

  stopTail(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = null;
    // D162: a resumed tail is not new activity — without this the first read after stop/sleep
    // looks like an external write and would drop 完成.
    this.tailSig = "";
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
  async startLive(opts: { resume: boolean; cwd?: string; name?: string; ws?: string }): Promise<void> {
    if (this.live) return;
    // A pi we are just spawning counts as activity on this session's clock: the watermark's
    // protection window (#79) starts here, whether or not pi has said anything yet.
    this.touch();
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
    args.push("-e", previewToolPath());
    const cwd = opts.cwd || this.state.cwd || process.cwd();
    // #28: the flags chosen at creation, every time this session's pi starts (resume included).
    const launch = readLaunch(id);
    args.push(...launchArgs(launch));
    // D164 延伸：这个工作区的老毛病跟着 spawn 一起进系统提示词（`PI_WEB_LESSONS=0` 可关）。
    // 传文件而不是长文本：用户手填的那段自己就能占 20000 字，命令行塞不下两条这么长的。
    // ws 由调用方（SessionManager）算：它手里才有工作区表，Session 自己不知道 cwd 属于哪个组。
    if (process.env.PI_WEB_LESSONS !== "0" && opts.ws) {
      const lessons = lessonFile(opts.ws);
      if (lessons) args.push("--append-system-prompt", lessons);
    }
    // #226 / D191：告诉模型它跑在网页客户端里，附交付礼仪（`PI_WEB_HINT=0` 可关）。
    // 与上面那段各自追加：pi 的 `--append-system-prompt` 可重复，两个开关互不影响，谁关了都不顶掉另一个。
    // 顺序是「用户手填 → 工作区教训 → 交付提示」：事实在前、这次会话的规矩在后（离对话最近）。
    if (process.env.PI_WEB_HINT !== "0") args.push("--append-system-prompt", DELIVERY_HINT);
    this.state.launch = describeLaunch(launch) || undefined;
    if (opts.resume && this.state.file) args.push("--session", this.state.file);
    else args.push("--session-id", id);
    // 随手问 (#86): pi writes into its own throwaway session dir, outside the root that every
    // listing scans — that is what makes "no record" a fact rather than a filtered display.
    if (this.state.scratch) args.push("--session-dir", scratchSessionsDir());
    if (opts.name && !opts.resume) args.push("--name", opts.name);
    this.rpc = new RpcChild({
      cli: this.cli,
      args,
      cwd,
      logPath: statePath("logs", `${id}.log`),
      env: {
        PI_WEB_ALLOW_FILE: allowFile(id),
        // The ask-user / preview extensions post here instead of opening a dialog (see PLAN-ask.md).
        ...(this.loopbackUrl ? { PI_WEB_LOOPBACK: this.loopbackUrl, PI_WEB_LOOPBACK_TOKEN: this.loopbackToken } : {}),
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
      // A pi that died while still booting must not leave the page on 「正在启动…」 forever.
      this.setState({ running: false, starting: false });
      // 进程没了，等「这一轮开始」的那条路也断了：先放它下来，它自己会看到 rpc 已死并标红剩下的。
      this.wakeRunStart();
      // #197 / D178: 启动期收下的消息跟着这个进程一起没戏了 —— 气泡标红、给一句人话，不静默吞掉。
      const lost = this.bootQueue.splice(0);
      if (lost.length) this.failBoot(lost, closing ? "stopped" : "boot");
      releaseLock(id);
      this.clearApprovals();
      this.clearAsks();
      this.endCompaction();
      // The extensions that drew these live in the process that just ended.
      this.resetExtUi();
      this.setQueue([], []);
      this.bashRun = null;
      // #202 / D183: 排着还没跑的 `!` 也随这个进程作废，否则卡片会一直停在「等待 pi 启动」。
      for (const b of this.bootBash.splice(0)) this.failBash(b.itemId, "pi 进程退出了，这条命令没有跑");
      // A stop the user asked for is not news; only an exit nobody asked for is worth the stderr tail.
      if (closing) {
        if (!quiet) this.emitWs({ type: "notice", sessionId: id, text: "已停止运行，历史留在磁盘，发消息会自动接管。", level: "info" });
      } else {
        // #200 AC6 / D183: 退出原因里的 exit code / signal 是给日志看的，界面只留人话。
        console.log(`[exit] ${id} pi 进程退出：${reason}`);
        this.emitWs({ type: "notice", sessionId: id, text: "pi 进程意外退出了（可能有别的终端占着这个会话）。历史留在磁盘，发消息会重新接管。", level: "warn" });
      }
      // keep reading the file from now on so the transcript stays current
      this.startTail();
    });

    this.rpc.start();

    // 不把调用方（新建会话对话框）卡在 pi 的启动上：带着一整套扩展冷启实测要 8 秒（本机 12 个 npm
    // 扩展 + 5 个本地扩展；机器忙时 15 秒），而那几秒里页面唯一能做的就是盯着「启动中…」。
    // get_state 照旧发，回来之后补上 model / file；`starting` 只是让页面知道「还没好」。
    this.setState({ starting: true }, { touch: false });
    const bootAt = Date.now();
    void this.rpc
      .request<any>("get_state", {}, 30000)
      .then((st) => this.absorbState(st))
      .catch(() => {
        /* best effort: events still work */
      })
      .finally(() => {
        // 这一行是「新会话为什么慢」的唯一可观测出口：桥日志里能直接看到每次冷启花了多久。
        console.log(`[boot] ${id} pi 启动完成 ${Date.now() - bootAt} ms`);
        this.setState({ starting: false }, { touch: false });
        // #197 / D178: 启动窗口期收下的消息在这里交出去。
        this.flushBootQueue();
        // #202 / D183: 启动窗口里敲的 `!` 同理，等通道通了再跑。
        this.flushBootBash();
      });
    // A resumed session starts with the transcript pi already wrote to disk.
    if (opts.resume) this.loadFromFile();
    // #221: 唤醒续接同样只推末尾一页，不然休眠一个大会话再叫醒，页面又要等整段。
    this.emitWs({ type: "items", sessionId: id, ...this.tailFrame() });
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
        this.clearFinished();
        this.autoCompactUsed = false;
        // A new run is a new verdict: a previous abort's grace clock must not carry over (#81).
        this.stuckAbortedAt = null;
        this.stuckNoticed = false;
        this.emitWs({ type: "pi.status", sessionId: this.state.id, running: true });
        // #197 / #200: 这一轮真的开始了，启动期（或失败重试）剩下没交出去的消息现在可以按插话送。
        // #198: 泵可能正挂在等这个信号 —— 先叫醒它（它在等的时候占着 `flushingBoot`）。
        this.wakeRunStart();
        this.flushBootQueue();
        break;
      case "agent_end":
        // Not the end of the run: retries, overflow recovery, compaction, steering and follow-ups
        // can all carry on after it (docs/rpc.md "Run lifecycle"). Only agent_settled is idle.
        void this.refreshStats();
        break;
      case "agent_settled": {
        // Whatever was queued has been delivered or cleared by now.
        this.queuedUser = [];
        this.setQueue([], []);
        // #198: 一轮结束还没等到下一轮的开始信号？泵在等的就是「有没有这一轮」，放它走。
        this.wakeRunStart();
        // The run answered its abort (or ended on its own): nothing left for the watchdog to end (#81).
        this.stuckAbortedAt = null;
        this.stuckNoticed = false;
        this.setState({ running: false, done: true });
        // D162: 完成状态跟着会话走：桥重启、GC 回收、换设备都还能看到，直到下一次运行。
        writeFinishedAt(this.state.id, Date.now());
        this.emitWs({ type: "pi.status", sessionId: this.state.id, running: false });
        // #200: 泵在「第一条开出的那一轮」里等过 agent_start；这一轮已经结束而队里还有东西（那条
        // 正好没赶上插话），就当下一轮的开头送出去 —— 别让它们等在一条再也不会出现的启动信号上。
        this.flushBootQueue();
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
        } else if (ev.message?.role === "user" || ev.message?.role === "custom") {
          // D170: runner 的完成通知也可能直接把空闲会话唤醒（不进队列）—— 这一条也要收。
          // `custom` 是扩展 `pi.sendMessage()` 注进来的那条；不一起认，就只剩 queue_update 一条路。
          this.bgRuns.noteText(contentText(ev.message?.content));
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
        if (ev.message?.role === "custom") {
          // An extension's pi.sendMessage(): shown like the TUI shows it (display:true only), #31.
          const item = customMessageItem(`custom:${Date.now()}`, new Date().toISOString(), ev.message);
          if (item) {
            this.upsert(item);
            this.emitWs({ type: "item.add", sessionId: this.state.id, item });
          }
          break;
        }
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
          ...(typeof msg.errorMessage === "string" && msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
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
        if (ev.toolName === "ask_user_question") this.openQuestionnaire(String(ev.toolCallId ?? ""), ev.args);
        // D187: 前台派活（`async:false`）的 run 不会出现在结果 details 里，卡片得在开始这刻立。
        this.bgRuns.noteToolStart(String(ev.toolName ?? ""), ev.args, String(ev.toolCallId ?? ""));
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
        this.closeQuestionnaire(String(ev.toolCallId ?? ""));
        const at = this.items.findIndex((it) => it.kind === "tool" && it.toolCallId === String(ev.toolCallId));
        const seen = at >= 0 ? (this.items[at] as ToolItem) : undefined;
        // D170: pi 只在结果里承认一次「有这么个 run」（`details.runId`）。
        // D172: `args` 里是模型写的那份原文（pi-subagents 落盘时把 task 打成 [prompt redacted]）。
        this.bgRuns.noteToolEnd(
          String(ev.toolName ?? ""),
          (ev.result as any)?.details,
          contentText(ev.result),
          seen?.args,
          String(ev.toolCallId ?? ""),
          Boolean(ev.isError),
        );
        {
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
        // D170: 完成通知是 steering，不是普通消息 —— 从这儿把对应的 run 结束掉。
        this.bgRuns.noteText([...(ev.steering ?? []), ...(ev.followUp ?? [])].map(String).join("\n"));
        this.setQueue(ev.steering, ev.followUp);
        break;
      }
      case "bash_execution_update": {
        const run = this.bashRun;
        if (!run || typeof ev.delta !== "string") break;
        run.output = (run.output + ev.delta).slice(-BASH_KEEP);
        this.emitWs({ type: "bash.delta", sessionId: this.state.id, id: run.itemId, text: ev.delta });
        break;
      }
      case "compaction_start":
        this.beginCompaction();
        this.emitWs({ type: "notice", sessionId: this.state.id, text: "开始压缩上下文…", level: "info" });
        break;
      case "compaction_end":
        // A compaction that will be retried is still in progress for prompt()'s purposes.
        if (!ev.willRetry) this.endCompaction();
        if (!ev.aborted && !ev.errorMessage && typeof ev.result?.summary === "string" && ev.result.summary.trim()) {
          // Same card the file view draws for a compaction entry (#31): the summary is what the model now sees.
          const before = typeof ev.result.tokensBefore === "number" ? `（压缩前约 ${Math.round(ev.result.tokensBefore / 1000)}K token）` : "";
          const item: Item = { id: `compaction:${Date.now()}`, ts: new Date().toISOString(), kind: "summary", variant: "compaction", title: `上下文已压缩${before}`, text: ev.result.summary };
          this.upsert(item);
          this.emitWs({ type: "item.add", sessionId: this.state.id, item });
          break;
        }
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
      case "auto_retry_start": {
        const attempt = Number(ev.attempt);
        const max = Number(ev.maxAttempts);
        const delay = Number(ev.delayMs);
        const count = Number.isFinite(attempt) && Number.isFinite(max) && max > 0 ? `（第 ${attempt}/${max} 次）` : "";
        const wait = Number.isFinite(delay) && delay > 0 ? `${Math.round(delay / 1000)} 秒后` : "";
        const why = typeof ev.errorMessage === "string" && ev.errorMessage ? `：${ev.errorMessage.slice(0, 300)}` : "";
        this.emitWs({ type: "notice", sessionId: this.state.id, text: `请求失败${why}。${wait}重试${count}…`, level: "warn" });
        break;
      }
      case "auto_retry_end":
        if (ev.success) this.emitWs({ type: "notice", sessionId: this.state.id, text: "重试成功，继续。", level: "info" });
        else
          this.emitWs({
            type: "notice",
            sessionId: this.state.id,
            text: `重试后仍失败${typeof ev.finalError === "string" && ev.finalError ? `：${ev.finalError.slice(0, 500)}` : ""}`,
            level: "error",
          });
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- approvals
  private onUiRequest(req: any): void {
    const id = String(req.id ?? "");
    if (!id) return;
    // Fire-and-forget methods: pi does not wait for (or expect) a response to these.
    if (this.onExtUi(req)) return;
    // select / input / editor are questions, not approvals (e.g. ask_user_question's rpc fallback
    // walks its questionnaire with them). They go through the ask drawer and are answered with
    // `{value}`; answering them with `{confirmed}` made pi read every reply as a dismissal.
    if (req.method === "select" || req.method === "input" || req.method === "editor") {
      // Q-033: 记下发问方给的时长（不再采用），下次排查「题目自己消失」时有据可查。
      this.logUiTimeout(String(req.method), req.timeout);
      if (this.fillFromQuestionnaire(id, req)) return;
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

  /** Q-032: 把「为什么没发生」写进用户正在看的那段聊天，而不是默默失败。`code` 让界面按语言重写。 */
  notice(text: string, level: "info" | "warn" | "error" = "info", i18n?: { code: string; params?: Record<string, string> }): void {
    this.emitWs({ type: "notice", sessionId: this.state.id, text, level, ...i18n });
  }

  private logUiTimeout(method: string, timeout: unknown): void {
    const ms = typeof timeout === "number" && timeout > 0 ? timeout : null;
    if (ms !== null) this.notice(`ui.${method} 请求带了 ${Math.round(ms / 1000)} 秒超时，已忽略（提问不设上限）`, "info");
  }

  /**
   * D90: the whole `ask_user_question` questionnaire goes to the page as one ask the moment the
   * tool starts; the walker's one-question-at-a-time dialogs are then answered from it.
   */
  private openQuestionnaire(toolCallId: string, args: unknown): void {
    if (!toolCallId || this.questionnaires.has(toolCallId)) return;
    const questions = parseQuestionnaire(args);
    if (!questions) return;
    const { id, outcome } = this.ask(
      questions.map(({ key: _key, ...q }) => q),
      "ask_user_question",
    );
    const open: OpenQuestionnaire = { askId: id, questions, outcome: null, taken: new Set(), waiting: [] };
    this.questionnaires.set(toolCallId, open);
    void outcome.then((out) => {
      open.outcome = out;
      for (const w of open.waiting.splice(0)) this.replyFromQuestionnaire(open, w.uiId, w.req, w.question);
    });
  }

  /** The tool is over (answered, cancelled, aborted): an ask still on screen has nobody to answer. */
  private closeQuestionnaire(toolCallId: string): void {
    const open = this.questionnaires.get(toolCallId);
    if (!open) return;
    this.questionnaires.delete(toolCallId);
    if (this.asks.has(open.askId)) this.cancelAsk(open.askId, "提问已结束");
  }

  /** True when the dialog belongs to an open questionnaire and will be answered from it. */
  private fillFromQuestionnaire(uiId: string, req: any): boolean {
    const title = String(req.title ?? req.message ?? req.prompt ?? "");
    for (const open of this.questionnaires.values()) {
      const question = matchDialog(open.questions, title, open.taken);
      if (!question) continue;
      // The walker asks each question once; a second dialog for it (e.g. a reply it did not
      // accept) is asked on its own instead of answered with the same reply again.
      open.taken.add(question.id);
      if (open.outcome) this.replyFromQuestionnaire(open, uiId, req, question);
      else open.waiting.push({ uiId, req, question });
      return true;
    }
    return false;
  }

  private replyFromQuestionnaire(open: OpenQuestionnaire, uiId: string, req: any, question: QuestionnaireQuestion): void {
    const out = open.outcome!;
    if (out.cancelled || !out.answers) {
      this.rpc?.uiRespond({ id: uiId, cancelled: true });
      return;
    }
    const answer = out.answers.find((a) => a.id === question.id);
    const lines = Array.isArray(req.options) ? req.options.map(String) : [];
    const value = answer ? replyFor(question, answer, String(req.method), lines) : null;
    if (value === null) this.askViaDialog(uiId, req);
    else this.rpc?.uiRespond({ id: uiId, value });
  }

  /**
   * Q-033: a question waits forever — `req.timeout` is logged, never obeyed. pi 那边到点会自己
   * 结算（`uiRespond` 变成空操作），所以这里再按它的时长把卡片撤掉只会丢题；晚到的回答由
   * `answerAsk()` 的 no-op 兜住。
   */
  private askViaDialog(uiId: string, req: any): void {
    const options = req.method === "select" && Array.isArray(req.options) ? req.options.map(String) : [];
    const prompt = String(req.title ?? req.message ?? req.prompt ?? "").trim() || "请回答";
    const question: AskQuestion = {
      id: "q1",
      prompt,
      options: options.map((o: string) => ({ value: o, label: o })),
      allowOther: true,
    };
    const { outcome } = this.ask([question], `ui.${req.method}`, req.timeout);
    void outcome.then((out) => {
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
  /** Register a question and stay pending until answered, cancelled, or this session dies. No timeout on purpose (Q-033). */
  ask(questions: AskQuestion[], tool: string, timeoutMs?: unknown): { id: string; outcome: Promise<AskOutcome> } {
    const asked = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
    const ask: PendingAsk = {
      id: `ask_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: this.state.id,
      sessionName: this.state.name,
      questions,
      createdAt: Date.now(),
      ...(asked ? { timeoutMs: asked } : {}),
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
      if (q.multiSelect) {
        const picks = [...new Set((got.picks ?? []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length).sort((a, b) => a - b);
        const text = q.allowOther === false ? "" : String(got.text ?? "").trim();
        if (!picks.length && !text) continue;
        const label = [...picks.map((n) => q.options[n - 1].label), ...(text ? [text] : [])].join("、");
        clean.push({ id: q.id, value: label, label, picks, ...(text ? { text } : {}) });
        continue;
      }
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
    this.questionnaires.clear();
    for (const id of [...this.asks.keys()]) this.cancelAsk(id, "这一轮结束了");
  }

  // ---------------------------------------------------------------- commands
  /**
   * `clientId` is the id the sending page gave its optimistic bubble: the broadcast carries it so
   * that page adopts the bubble instead of drawing a second one, and every other page draws it.
   */
  async prompt(
    text: string,
    images?: { data: string; mimeType: string }[],
    clientId?: string,
    behavior: "steer" | "followUp" = "steer",
  ): Promise<void> {
    if (!this.rpc?.alive) throw new Error("会话没在运行");
    // D162: 发消息就是开始下一轮 —— 完成徽标在消息发出的这一刻让位，不必等 pi 的 agent_start。
    this.clearFinished();
    // pi throws on a prompt submitted mid-compaction: hold it until the compaction is over.
    if (this.compaction) {
      this.emitWs({ type: "notice", sessionId: this.state.id, text: "正在压缩上下文，这条消息会在压缩完成后发出。", level: "info" });
      await this.compaction.done;
      if (!this.rpc?.alive) throw new Error("会话已经停止，这条消息没有发出");
    }
    // #197 / D178 + #202 / D183: `starting` 或补发泵还没把队列清空时都收 —— 后者表示更早的消息
    // 还在桥里等着交给 pi，新消息必须排到队尾，否则会插到它们前面。
    const booting = this.state.starting === true || this.bootQueue.length > 0;
    const userId = this.landUserPrompt(text, images, clientId, booting);
    // #197 / D178: 启动窗口期到此为止。交给 pi 得等它把扩展加载完（get_state 回来），否则这一句会
    // 撞上一个还没准备好的进程；消息先进桥自己的队列，气泡已经落地（带 `pending: "booting"`）。
    if (booting) {
      this.bootQueue.push({ id: userId, text, images, behavior });
      return;
    }
    const message: any = { type: "prompt", message: text };
    // pi rejects a bare prompt while a run is active; queue it instead. `running` spans
    // agent_start … agent_settled, so retries and overflow recovery count as running too.
    // Like the terminal: Enter steers the current task, Alt+Enter waits until it is done (#14).
    if (this.state.running) message.streamingBehavior = behavior === "followUp" ? "followUp" : "steer";
    if (images?.length) {
      message.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    }
    if (message.streamingBehavior) this.queuedUser.push({ id: userId, text });
    const res = await this.rpc.request<any>("prompt", { ...message }, 60000);
    if (res?.disposition === "handled" && res?.error) throw new Error(String(res.error));
  }

  /**
   * 把一枚用户消息落地：upsert + 广播 + 命名，返回它在 items 里的 id。
   *
   * #201: 广播这一步不能藏在 `prompt()` 里 —— 只读会话的第一句得**先于**拉着 pi 的握手出去，
   * 所以「落地」与「交给 pi」拆成两件事。`booting` 决定气泡上带不带待发标记。
   */
  private landUserPrompt(
    text: string,
    images: { data: string; mimeType: string }[] | undefined,
    clientId: string | undefined,
    booting: boolean,
  ): string {
    const userId = `user:${++this.userCounter}`;
    // A `/skill:x` send is marked right away so the bubble does not swap styles when pi's expanded
    // copy lands in the file (~400 ms); the tooltip's path only comes with the file read.
    const typed = typedSkill(text);
    const userItem: Item = {
      id: userId,
      kind: "user",
      text,
      images: (images ?? []).map((i) => ({ mimeType: i.mimeType })),
      ...(typed ? { skill: typed } : {}),
      ...(booting ? { pending: "booting" as const } : {}),
      ts: new Date().toISOString(),
    };
    this.upsert(userItem);
    // Other pages watching this session (phone + desktop) only learn about the message from here.
    this.emitWs({ type: "item.add", sessionId: this.state.id, item: userItem, ...(clientId ? { clientId } : {}) });
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
    return userId;
  }

  /**
   * #201: 只读会话（磁盘上有、pi 没在跑）里发消息 = 自动接管。调用方接着去 `openLive()`，但气泡
   * 必须**在那之前**就广播出去 —— 拉起 pi、等 get_state 是几秒的事，让刚打的字跟着一起等最难受。
   *
   * 返回气泡的 item id（接管没成时要靠它标红）；会话已经在跑就返回 null，那时调用方照常走
   * `prompt()`（启动窗口由 `prompt()` 自己收）。
   */
  acceptBeforeBoot(
    text: string,
    images: { data: string; mimeType: string }[] | undefined,
    clientId: string | undefined,
    behavior: "steer" | "followUp",
  ): string | null {
    if (this.live) return null;
    const userId = this.landUserPrompt(text, images, clientId, true);
    this.bootQueue.push({ id: userId, text, images, behavior });
    return userId;
  }

  /**
   * #201: `acceptBeforeBoot` 收下的消息没等到 pi —— 接管被拒（终端里的 pi 还开着、会话 20 秒前还在
   * 被写、进程起不来）。从队列里摘掉、把气泡标红，原件挪进 `bootFailed`：和启动期失败的那几条
   * 一样，「重试」会先拉起 pi 再按原顺序补发（#200）。
   *
   * 不在这里补 notice：拒的原因本来就是 WS 那一层抛出来的错、它自己会说一句，这里再说一遍就是同一
   * 件事说两遍。
   */
  failBeforeBoot(id: string): void {
    const at = this.bootQueue.findIndex((q) => q.id === id);
    if (at < 0) return;
    const [entry] = this.bootQueue.splice(at, 1);
    if (!this.bootFailed.some((f) => f.id === entry.id)) this.bootFailed.push(entry);
    this.markUserPending(id, "failed");
  }

  /**
   * #197: `starting` 翻假 = pi 的 get_state 回来了（扩展已经加载完），这时候才把启动期收下的
   * 消息按到达顺序交给它 —— 桥自己排队，所以这一段不必等页面重发。第一条开一轮；后面的等这一轮
   * 真的开始（`agent_start`）再逐条插话，因为 pi 只在正在流式输出时才认 `streamingBehavior`，
   * 塞不进这一轮的自然变成下一轮（合并是尽力而为，见 D178）。
   * #200 的「重试」走同一条泵：失败项回到队首，再跑一遍就是「拉起 pi 后按原顺序补发」。
   */
  private flushBootQueue(): void {
    if (this.flushingBoot || !this.bootQueue.length) return;
    const rpc = this.rpc;
    if (!rpc?.alive) {
      this.failBoot(this.bootQueue.splice(0), "boot");
      return;
    }
    this.flushingBoot = true;
    void this.pumpBootQueue(rpc).finally(() => {
      this.flushingBoot = false;
      // 泵可能在 `agent_start` 刚到、运行态还没翻过来的那一瞬收工；队里还有就再走一遍，
      // 别把消息押在一个已经过去了的信号上。
      if (this.state.running) this.flushBootQueue();
    });
  }

  /**
   * 一条一条地交。发完一条就看运行态：还在跑就接着插下一条，没在跑就停下来等 `agent_start`
   * （那才是「这一轮开始了」的信号）。
   */
  private async pumpBootQueue(rpc: RpcChild): Promise<void> {
    while (this.bootQueue.length && rpc === this.rpc && rpc.alive) {
      const next = this.bootQueue.shift() as BootEntry;
      const message: any = { type: "prompt", message: next.text };
      if (this.state.running) message.streamingBehavior = next.behavior === "followUp" ? "followUp" : "steer";
      if (next.images?.length) message.images = next.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
      if (message.streamingBehavior) this.queuedUser.push({ id: next.id, text: next.text });
      this.markUserPending(next.id, "sent");
      let res: any;
      try {
        res = await rpc.request<any>("prompt", { ...message }, 60000);
      } catch {
        // 交出去的那一刻 pi 死了：这一条和后面的一起算没发出去，人可以点「重试」再来一遍。
        this.failBoot([next, ...this.bootQueue.splice(0)], "boot");
        return;
      }
      if (res?.disposition === "handled" && res?.error) {
        // pi 起来了但不收这一条（比如模型那头拒了）：同样的失败路 —— 保留、标红、可重试。
        this.failBoot([next], "refused");
        continue;
      }
      if (res?.disposition === "handled") {
        // #198: pi 把这条就地处理掉了、一轮都没开 —— 别再等 `agent_start`，下一条裸发让它自己开一轮。
        continue;
      }
      if (message.streamingBehavior && res?.disposition !== "queued") {
        // #198: 它带着插话标记却没进队列 = 那一轮在送出去的瞬间已经结束，pi 单开了新一轮。
        // 这一条就不在队列里了，右栏不能说它还排着。
        this.unqueueUser(next.id);
      }
      // 第一条开出这一轮，但 `agent_start` 还没到（运行态还是假的）：剩下的等它再送（#198 的上限
      // 是 10 秒，等不到就裸发，不让气泡干等）。
      if (!this.state.running) await this.waitRunStart();
    }
  }

  /** #198: 等这一轮开始。等不到（10 秒上限）也算 —— 裸发兜底，不让气泡干等。 */
  private waitRunStart(): Promise<void> {
    if (this.state.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wakeRunStart(), BOOT_RUN_WAIT_MS);
      this.bootRunWait = { resolve, timer };
    });
  }

  /** #198: 放下等待（`agent_start` 来了、或进程退出）。重复调用无害。 */
  private wakeRunStart(): void {
    const wait = this.bootRunWait;
    if (!wait) return;
    this.bootRunWait = null;
    clearTimeout(wait.timer);
    wait.resolve();
  }

  /** 这一条不在 pi 的队列里了（送出去时那一轮已结束），右栏与撤回都别再把它算进去。 */
  private unqueueUser(id: string): void {
    this.queuedUser = this.queuedUser.filter((q) => q.id !== id);
  }

  /**
   * #200：把失败的那几条放回队首并标回「启动中」，然后走一次泵。点「重试」时桥已经先把 pi 拉
   * 起来了（`claim` 的接管路径：重新 spawn、钉权限、锁检查），这里只负责把消息重新排上。
   */
  retryBootMessages(): void {
    const retry = this.bootFailed.splice(0);
    if (!retry.length) return;
    // 排在前面：它们比窗口期之后收下的那几条发得更早，顺序不能倒。
    this.bootQueue.unshift(...retry);
    for (const entry of retry) this.markUserPending(entry.id, "booting");
    // 刚 spawn 的那一瞬 pi 连扩展都没加载完（`starting`）：等 get_state 落地后的那一次 flush。
    if (!this.state.starting) this.flushBootQueue();
  }

  /**
   * #197 / #200: 启动期收下的消息没能交给 pi。气泡留着（不删），改成标红，再给一句人话；
   * 原件进 `bootFailed`，等用户点「重试」。
   */
  private failBoot(entries: BootEntry[], cause: BootFailure): void {
    if (!entries.length) return;
    for (const entry of entries) {
      if (!this.bootFailed.some((f) => f.id === entry.id)) this.bootFailed.push(entry);
      this.markUserPending(entry.id, "failed");
    }
    const what = entries.length > 1 ? "这几条消息" : "这条消息";
    const why = cause === "refused" ? "pi 没收下" : cause === "stopped" ? "pi 已经停了" : "pi 没能起来";
    const next =
      cause === "refused"
        ? "点「重试」会重新发一次。"
        : "点「重试」会先拉起 pi，再按原顺序补发。";
    this.emitWs({ type: "notice", sessionId: this.state.id, text: `${what}没有发出去：${why}。${next}`, level: "error" });
  }

  /** 改气泡上的待发标记并发 `item.replace`：这是别的标签页唯一能看见它的途径。 */
  private markUserPending(id: string, pending: NonNullable<UserItem["pending"]>): void {
    const at = this.items.findIndex((it) => it.id === id);
    if (at < 0) return;
    const item = { ...(this.items[at] as UserItem), pending };
    this.items[at] = item;
    this.emitWs({ type: "item.replace", sessionId: this.state.id, id, item });
  }

  abort(): void {
    this.clearApprovals();
    this.clearAsks();
    const rpc = this.rpc;
    if (!rpc?.alive) return;
    // `abort` alone leaves queued messages in place and pi runs them as soon as it is idle
    // (docs/rpc-commands.md clear_queue). Clear first: pi handles clear_queue synchronously, and
    // commands are dispatched in arrival order, so the queue is empty before abort starts.
    const withdrawn = this.withdrawQueue();
    // Fire and forget: abort's response can stall while a dialog is pending.
    try {
      rpc.fire("abort", {});
    } catch {
      /* ignore */
    }
    void withdrawn;
  }

  /**
   * Take everything out of pi's queue and hand the text back to the editor (`queue.restore`),
   * dropping the bubbles of those messages: they were never sent. Used by stop and by the queue
   * bar's 撤回 button (#9, #14).
   *
   * #199: the same frame also empties the bridge's own `bootQueue` — during the boot window (#197)
   * that IS the queue, and clearing only one of the two would either drop bubbles whose text comes
   * back (`half cleared`) or leave messages that get delivered after the human withdrew them.
   * #200 / D183: `bootFailed`（没发出去、只在等「重试」的那批）同样退回 —— 「重试」是选择，不是唯一出路。
   */
  async withdrawQueue(): Promise<number> {
    const rpc = this.rpc;
    // Splice first, synchronously: flushBootQueue can only run between microtasks, so from here on
    // it cannot find these messages any more. The order kept here is the order they were typed in.
    // 失败的那批发得更早（启动期整批失手或补发被拒），退回文本里排在 bootQueue 前面。
    const failed = this.bootFailed.splice(0);
    const booted = this.bootQueue.splice(0);
    const bootTexts = [...failed, ...booted].map((q) => q.text);
    const bootIds = [...failed, ...booted].map((q) => q.id);
    // 进程已经没了：pi 那边没有队列可清，但桥自己记着的这两批仍然要还给人（#202 AC）。
    if (!rpc?.alive) {
      if (!bootTexts.length) return 0;
      this.restoreWithdrawn(bootTexts, bootIds, []);
      return bootTexts.length;
    }
    const cleared = rpc.request<{ steering?: unknown[]; followUp?: unknown[] }>("clear_queue", {}, 10000);
    // Snapshot now: agent_settled may be processed before this response's promise callback runs.
    const queued = this.queuedUser.slice();
    let data: { steering?: unknown[]; followUp?: unknown[] };
    if (this.state.starting) {
      // A booting pi has not taken over its stdin yet: waiting for this answer would tie the
      // withdrawal to the boot again (that is the wait #197 removed). The command still goes out —
      // commands are dispatched in order, and pi's own queue is empty while prompts land in
      // `bootQueue` — but the answer is not on the human's path.
      void cleared.catch(() => {});
      data = {};
    } else {
      try {
        data = await cleared;
      } catch {
        // an old pi without clear_queue: the boot-window part was never with pi, so still hand it back
        data = {};
      }
    }
    // pi expands the command before it queues it, so `clear_queue` hands back the whole SKILL.md;
    // fold it back on the way to the editor, and compare the same way the bubbles were recorded.
    const piTexts = [...(data?.steering ?? []), ...(data?.followUp ?? [])].map((t) => normalizeUserText(String(t))).filter((t) => t.trim());
    const texts = [...bootTexts, ...piTexts];
    if (!texts.length) return 0;
    this.restoreWithdrawn(texts, bootIds, queued);
    return texts.length;
  }

  /**
   * #199 / #200: 把撤回的文本退给编辑器、删掉对应气泡。`bootIds` 是桥能按 id 认出的那批；
   * pi 队列里的只带回文本，按文本匹配（`queued` 是发送时刻的快照）。
   */
  private restoreWithdrawn(texts: string[], bootIds: string[], queued: { id: string; text: string }[]): void {
    // Same as the terminal's Esc / Alt+Up: the queued text goes back to the editor.
    this.emitWs({ type: "queue.restore", sessionId: this.state.id, texts });
    const ids = [...bootIds];
    const pool = [...queued];
    for (const text of texts.slice(bootIds.length)) {
      const at = pool.findIndex((q) => normalizeUserText(q.text) === text);
      if (at >= 0) ids.push(pool.splice(at, 1)[0].id);
    }
    this.queuedUser = this.queuedUser.filter((q) => !ids.includes(q.id));
    this.applyWithdraw(ids, texts.length);
  }

  private setQueue(steering: unknown, followUp: unknown): void {
    // pi queues prompts it has already expanded: the bar shows what the human typed.
    const list = (v: unknown) => (Array.isArray(v) ? v.map((t) => displayUserText(String(t))) : []);
    const next = { steering: list(steering), followUp: list(followUp) };
    if (JSON.stringify(next) === JSON.stringify(this.queue)) return;
    this.queue = next;
    this.emitWs({ type: "queue", sessionId: this.state.id, ...next });
  }

  /** `!cmd` (`!!cmd` = excludeFromContext): pi's RPC bash, streamed into a card of its own (#16). */
  async bash(command: string, excludeFromContext: boolean): Promise<void> {
    const rpc = this.rpc;
    if (!rpc?.alive) throw new Error("会话没在运行");
    // #202 / D183: 启动窗口里不再拒绝 —— 卡片先落地（queued），命令进 `bootBash`，就绪后按顺序跑。
    // 票面 AC 要的是「不被拦下、pi 起来后执行」：晚几秒跑只改变时机，命令本身一个字不动。
    if (this.state.starting) {
      const item = this.landBash(command, excludeFromContext, "queued");
      this.bootBash.push({ itemId: item.id, command, excludeFromContext });
      return;
    }
    if (this.bashRun) throw new Error("上一条 ! 命令还在跑，等它结束或先停掉它");
    const item = this.landBash(command, excludeFromContext, "running");
    await this.runBash(item, command, excludeFromContext);
  }

  /** 落地一枚 bash 卡片（upsert + 广播）；启动期先标 `queued`，跑起来时再换成 `running`。 */
  private landBash(command: string, excludeFromContext: boolean, status: BashItem["status"]): BashItem {
    const item: BashItem = {
      id: `bash:${++this.bashCounter}`,
      kind: "bash",
      command,
      output: "",
      excludeFromContext,
      status,
      ts: new Date().toISOString(),
    };
    this.upsert(item);
    this.emitWs({ type: "item.add", sessionId: this.state.id, item });
    return item;
  }

  /** 通道检查之后的那一段：真跑一条 `!`，把输出流进卡片。`bash()` 与 `flushBootBash()` 共用。 */
  private async runBash(item: BashItem, command: string, excludeFromContext: boolean): Promise<void> {
    const rpc = this.rpc;
    if (!rpc?.alive) throw new Error("会话没在运行");
    if (this.bashRun) throw new Error("上一条 ! 命令还在跑，等它结束或先停掉它");
    if (item.status !== "running") {
      item = { ...item, status: "running" };
      this.upsert(item, item.id);
      this.emitWs({ type: "item.replace", sessionId: this.state.id, id: item.id, item });
    }
    const run = { itemId: item.id, output: "" };
    this.bashRun = run;
    let done: BashItem;
    try {
      // A shell command can run for a long time; pi answers when it exits or is aborted.
      const r = await rpc.request<any>("bash", { command, ...(excludeFromContext ? { excludeFromContext: true } : {}) }, 24 * 3600 * 1000);
      done = {
        ...item,
        output: String(r?.output ?? run.output).slice(-BASH_KEEP),
        exitCode: typeof r?.exitCode === "number" ? r.exitCode : null,
        cancelled: Boolean(r?.cancelled),
        truncated: Boolean(r?.truncated),
        ...(typeof r?.fullOutputPath === "string" ? { fullOutputPath: r.fullOutputPath } : {}),
        status: "done",
      };
    } catch (err: any) {
      done = { ...item, output: run.output, status: "done", error: String(err?.message ?? err) };
    } finally {
      if (this.bashRun === run) this.bashRun = null;
    }
    this.upsert(done, item.id);
    this.emitWs({ type: "item.replace", sessionId: this.state.id, id: item.id, item: done });
  }

  /**
   * #202 / D183: pi 就绪之后把启动窗口里排下的 `!` 按顺序跑完。一条接一条（bash 一次只能跑一条），
   * 中途失败只作废那一条，后面的照跑。
   */
  private flushBootBash(): void {
    if (this.flushingBash || !this.bootBash.length) return;
    this.flushingBash = true;
    void (async () => {
      try {
        while (this.bootBash.length) {
          const next = this.bootBash.shift() as { itemId: string; command: string; excludeFromContext: boolean };
          const item = this.items.find((it) => it.id === next.itemId);
          if (!item || item.kind !== "bash") continue;
          if (!this.rpc?.alive) {
            this.failBash(next.itemId, "pi 没能起来，这条命令没有跑");
            continue;
          }
          try {
            await this.runBash(item, next.command, next.excludeFromContext);
          } catch (err: any) {
            this.failBash(next.itemId, String(err?.message ?? err));
          }
        }
      } finally {
        this.flushingBash = false;
      }
    })();
  }

  /** 一条 `!` 彻底没跑成：卡片停在「失败」，别让它一直挂着「等待 pi 启动」。 */
  private failBash(itemId: string, message: string): void {
    const item = this.items.find((it) => it.id === itemId);
    if (!item || item.kind !== "bash") return;
    const done: BashItem = { ...item, status: "done", error: message };
    this.upsert(done, itemId);
    this.emitWs({ type: "item.replace", sessionId: this.state.id, id: itemId, item: done });
  }

  abortBash(): void {
    if (this.bashRun) this.rpc?.fire("abort_bash", {});
  }

  private applyWithdraw(ids: string[], count: number): void {
    if (ids.length) {
      const drop = new Set(ids);
      this.items = this.items.filter((it) => !drop.has(it.id));
      // Targeted removal, not a full `items` resend: that would also wipe the live draft mid-run.
      this.emitWs({ type: "item.remove", sessionId: this.state.id, ids });
    }
    this.emitWs({ type: "notice", sessionId: this.state.id, text: `已撤回 ${count} 条排队中的消息，放回了输入框。`, level: "info" });
  }

  /** Compaction is long (minutes on a big context); its events, not a short timeout, bound it. */
  /** `instructions` = what `/compact <text>` adds in the terminal: what the summary must keep. */
  async compact(instructions?: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc?.alive) return;
    this.beginCompaction();
    try {
      await rpc.request("compact", instructions ? { customInstructions: instructions } : {}, 30 * 60 * 1000);
    } finally {
      this.endCompaction();
    }
    void this.refreshStats();
  }

  /**
   * 「清空」 for 随手问 (#86): pi starts a fresh session **inside the same process** — no cold start,
   * and the context and token count go back to zero. The old file is deleted, so 「不落盘」 stays
   * true after the first clear as well; the page replaces its own timeline with an empty one.
   *
   * The bridge-side id deliberately stays put: everything the page holds is keyed by it, and pi's
   * new id is internal. Only `state.file` follows pi, because that is what a later wake-up resumes.
   */
  async scratchClear(): Promise<void> {
    if (!this.state.scratch) throw new Error("这个会话不是随手问");
    const rpc = this.rpc;
    if (!rpc?.alive) throw new Error("随手问没有在运行");
    const before = this.state.file;
    const res = await rpc.request<any>("new_session", {}, 60_000);
    if (res?.cancelled) throw new Error("pi 取消了新会话");
    let file: string | null = null;
    try {
      const st = await rpc.request<any>("get_state", {}, 15_000);
      if (typeof st?.sessionFile === "string") file = st.sessionFile;
      else if (typeof st?.sessionPath === "string") file = st.sessionPath;
    } catch {
      /* the next wake-up just starts a new file again */
    }
    this.items = [];
    this.autoCompactUsed = false;
    this.setState({ file, truncated: false }, { touch: false });
    this.emitWs({ type: "items", sessionId: this.state.id, items: [], history: { hasMore: false, total: 0 } });
    this.touch();
    if (before && before !== file) {
      try {
        fs.rmSync(before, { force: true });
      } catch {
        /* a leftover file only costs disk; the next startup wipes the whole dir anyway */
      }
    }
    void this.refreshStats();
  }

  private beginCompaction(): void {
    if (this.compaction) return;
    let resolve = () => {};
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.compaction = { done, resolve };
  }

  private endCompaction(): void {
    const current = this.compaction;
    this.compaction = null;
    current?.resolve();
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

  /**
   * Everything `/` can reach in this session (#25): extension commands, prompt templates and skills,
   * as pi reports them (get_commands). Without a live pi only the skills on disk are known.
   */
  async commands(): Promise<{ name: string; description: string; source: string }[]> {
    if (this.rpc?.alive) {
      try {
        const res = await this.rpc.request<any>("get_commands", {}, 30000);
        return (res?.commands ?? [])
          .filter((c: any) => c && typeof c.name === "string" && c.name)
          .map((c: any) => ({ name: String(c.name), description: String(c.description ?? ""), source: String(c.source ?? "") }));
      } catch {
        /* fall through */
      }
    }
    return scanSkills(this.state.cwd || process.cwd()).map((sk) => ({ name: `skill:${sk.name}`, description: sk.description, source: "skill" }));
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
    // 随手问 (#86) is never compacted behind the user's back: the summary would be exactly the
    // 上下文干扰 it exists to avoid. It gets a reminder instead, and 「清空」 is the only reset.
    if (this.state.scratch) return;
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

  /**
   * Settings a running pi can take without a restart (#26): queue delivery modes, automatic
   * compaction, automatic retry. Everything else in settings.json needs /reload.
   */
  async applyRuntime(r: { steeringMode?: string; followUpMode?: string; autoCompaction?: boolean; autoRetry?: boolean }): Promise<string[]> {
    const rpc = this.rpc;
    if (!rpc?.alive) return [];
    const done: string[] = [];
    const mode = (m: unknown) => (m === "all" || m === "one-at-a-time" ? m : null);
    if (mode(r.steeringMode)) {
      await rpc.request("set_steering_mode", { mode: r.steeringMode }, 15000);
      done.push("引导消息处理方式");
    }
    if (mode(r.followUpMode)) {
      await rpc.request("set_follow_up_mode", { mode: r.followUpMode }, 15000);
      done.push("后续消息处理方式");
    }
    if (typeof r.autoCompaction === "boolean") {
      await rpc.request("set_auto_compaction", { enabled: r.autoCompaction }, 15000);
      done.push("自动压缩");
    }
    if (typeof r.autoRetry === "boolean") {
      await rpc.request("set_auto_retry", { enabled: r.autoRetry }, 15000);
      done.push("自动重试");
    }
    return done;
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

  /** notify / setStatus / setWidget / setTitle / set_editor_text (docs/rpc-extension-ui.md). */
  private onExtUi(req: any): boolean {
    switch (req.method) {
      case "notify": {
        const kind = String(req.notifyType ?? "info");
        const level = kind === "error" ? "error" : kind === "warning" ? "warn" : "info";
        const text = stripAnsi(String(req.message ?? "")).trim();
        if (text) this.emitWs({ type: "notice", sessionId: this.state.id, text, level });
        return true;
      }
      case "setStatus": {
        const key = String(req.statusKey ?? "");
        const text = typeof req.statusText === "string" ? stripAnsi(req.statusText).trim() : "";
        if (!key) return true;
        if (text) this.extStatus.set(key, text.slice(0, 300));
        else this.extStatus.delete(key);
        this.emitExtUi();
        return true;
      }
      case "setWidget": {
        const key = String(req.widgetKey ?? "");
        if (!key) return true;
        if (Array.isArray(req.widgetLines)) {
          const lines = req.widgetLines.slice(0, 40).map((l: unknown) => stripAnsi(String(l ?? "")).slice(0, 400));
          // 扩展塞过来的协议载荷（pi-subagents 的 `PI_SUBAGENT_ASYNC_JSON:{…}`）当文本铺出来就是
          // 一坨被 400 字截断的原始 JSON，见 `extwidgets.ts`。「子代理在跑」另有 D170 的提示条。
          if (isProtocolWidgetLines(lines)) {
            if (this.extWidgets.delete(key)) this.emitExtUi();
            return true;
          }
          this.extWidgets.set(key, { lines, placement: req.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" });
        } else this.extWidgets.delete(key);
        this.emitExtUi();
        return true;
      }
      case "setTitle": {
        const title = stripAnsi(String(req.title ?? "")).trim();
        this.extTitle = title ? title.slice(0, 200) : null;
        this.emitExtUi();
        return true;
      }
      case "set_editor_text":
        this.emitWs({ type: "editor.set", sessionId: this.state.id, text: String(req.text ?? "") });
        return true;
      default:
        return false;
    }
  }

  extUi(): ExtUiState {
    return {
      status: [...this.extStatus].map(([key, text]) => ({ key, text })),
      widgets: [...this.extWidgets].map(([key, w]) => ({ key, ...w })),
      title: this.extTitle,
    };
  }

  private emitExtUi(): void {
    this.emitWs({ type: "ext.ui", sessionId: this.state.id, ext: this.extUi() });
  }

  private resetExtUi(): void {
    if (!this.extStatus.size && !this.extWidgets.size && !this.extTitle) return;
    this.extStatus.clear();
    this.extWidgets.clear();
    this.extTitle = null;
    this.emitExtUi();
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      items: this.items,
      approvals: [...this.approvals.values()],
      asks: [...this.asks.values()].map(publicAsk),
      budget: this.contextBudget,
      ext: this.extUi(),
      queue: this.queue,
    };
  }

  /**
   * #219：`session` 帧只带末尾一页。`items` 仍然是这一页的原文，同帧用 `history` 说清
   * 还有没有更早的、整段一共多少条 —— 老前端不认 `history`，照旧只画这一页。
   * 随手问例外：它没有「载入更早」，整段下发（`itemsFrame`）。
   */
  pagedSnapshot(): SessionSnapshot & { history: SessionHistory } {
    return { ...this.snapshot(), ...this.tailFrame() };
  }

  /**
   * 三处整页帧（分支切换 / 唤醒续接 / 快照）共用的正文：普通会话是末尾一页，随手问整段。
   * 随手问若也切页，累积超过一页后前面的话会在下一次唤醒时静默消失 —— 界面上没有入口能取回来。
   */
  private tailFrame(): { items: Item[]; history: SessionHistory } {
    return itemsFrame(this.items, { full: Boolean(this.state.scratch) });
  }

  idleFor(): number {
    return Date.now() - this.lastActivity;
  }

  async close(opts: { quiet?: boolean } = {}): Promise<void> {
    this.clearApprovals();
    this.clearAsks();
    this.stopTail();
    // D170: runner 是 pi 的子进程，跟着它走；表留着只会在重开的会话里挂一堆假任务。
    this.bgRuns.reset();
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
    this.setState({ running: false, starting: false });
  }

  /**
   * #81 (D120): one watchdog step, called from the lifecycle tick. A `running` turn that has seen no
   * pi event for `cfg.idleMs` is stuck — unless something is in flight (`busy()`), in which case the
   * silence is expected and the run only gets one notice; a pending approval or question is a
   * person's call, not a hang. A stuck run is aborted first, so the turn still lands on disk, and the
   * process is ended only if it has not settled `cfg.abortGraceMs` later.
   */
  checkStuckRun(cfg: Lifecycle): void {
    if (!this.live || this.closing || !this.state.running) {
      // The run ended or the process went away on its own: whatever was pending is moot.
      this.stuckAbortedAt = null;
      this.stuckNoticed = false;
      return;
    }
    if (this.idleFor() <= cfg.idleMs) {
      // Still talking: a later silence gets its own verdict, and its own notice.
      if (this.stuckAbortedAt === null) this.stuckNoticed = false;
      return;
    }
    // A compaction is long and silent by nature ("minutes on a big context"): not a hang either.
    if (this.compaction) return;
    if (this.busy()) {
      // A tool or a `!cmd` in flight explains the silence; the decision to stop stays with the user.
      if (this.stuckNoticed) return;
      this.stuckNoticed = true;
      this.emitWs({
        type: "notice",
        sessionId: this.state.id,
        code: "stuck_run_busy",
        text: `这个会话好像卡住了：${minutes(cfg.idleMs)} 分钟没有任何事件，但还有工具或命令在跑。没有中止它 —— 要不要停由你定。`,
        params: { p1: minutes(cfg.idleMs) },
        level: "warn",
      });
      return;
    }
    if (this.approvals.size || this.asks.size) return;
    if (this.stuckAbortedAt !== null) {
      if (Date.now() - this.stuckAbortedAt < cfg.abortGraceMs) return;
      this.stuckAbortedAt = null;
      this.emitWs({
        type: "notice",
        sessionId: this.state.id,
        code: "stuck_run_ended",
        text: "中止了但一直没有回音，已关掉这个会话的 pi 进程。消息都在，发一条消息会重新启动它。",
        level: "warn",
      });
      this.endStuckProcess();
      return;
    }
    this.stuckAbortedAt = Date.now();
    this.stuckNoticed = true;
    this.emitWs({
      type: "notice",
      sessionId: this.state.id,
      code: "stuck_run_aborted",
      text: `这一轮 ${minutes(cfg.idleMs)} 分钟没有任何事件，也没有工具在跑，判定为卡住：已请求中止，${seconds(cfg.abortGraceMs)} 秒内还不结束就关掉进程。`,
      params: { p1: minutes(cfg.idleMs), p2: seconds(cfg.abortGraceMs) },
      level: "warn",
    });
    // The stop button's abort, minus the queue dance: give the turn its chance to land on disk.
    this.abort();
  }

  /** Is something actually working? A tool pi has not finished, or a `!cmd` still running (#81). */
  private busy(): boolean {
    return Boolean(this.bashRun) || this.items.some((it) => it.kind === "tool" && it.status === "running");
  }

  /**
   * #81: end a run that ignored its abort. `close()`'s bookkeeping, without the abort-and-wait: that
   * happened a grace period ago, and another five seconds of waiting buys nothing.
   */
  private endStuckProcess(): void {
    const rpc = this.rpc;
    if (!rpc?.alive) return;
    this.closing = true;
    this.closeQuietly = true;
    // The exit handler below already does the rest (running:false, lock, tail); this only keeps the
    // dead child from making the next close() wait for an exit that has already happened.
    rpc.once("exit", () => {
      if (this.rpc === rpc) this.rpc = null;
    });
    rpc.kill();
  }

  /**
   * The one sleep path for every reason (idle, memory cap, 「全部休眠」). Resolves once the process is
   * gone, which is what 「全部休眠」 needs: its receipt is followed by numbers that have already dropped.
   */
  sleep(): Promise<void> {
    if (this.state.running) return Promise.resolve();
    return this.sleepNow();
  }

  /**
   * #82/D120: the approval or the questionnaire on screen is waiting on nobody. Two clocks have to
   * agree before it is dropped — nobody has had a page in front for the whole threshold, *and* this
   * card has been hanging for the whole threshold itself. Without the second clock a card that pops
   * up 30 minutes after you left would be thrown away on the very next tick, before you could even
   * come back. Expired ones get a line in the timeline saying which died; the session sleeps only
   * when nothing is left pending, and `close()` aborts first, so the interrupted turn still lands on
   * disk.
   */
  expireUnattended(cfg: Lifecycle): void {
    const now = Date.now();
    const hanging = (since: number) => now - since >= cfg.idleMs;
    for (const approval of [...this.approvals.values()]) {
      if (!hanging(approval.createdAt)) continue;
      const which = summarizeApproval(approval);
      this.answerApproval(approval.id, "cancel");
      this.notice(`「${which}」这条审批没有人看，已过期；那次工具调用已丢弃，需要的话重新发一次。`, "info", {
        code: "approval_expired",
        params: { p1: which },
      });
    }
    for (const ask of [...this.asks.values()]) {
      if (!hanging(ask.createdAt)) continue;
      this.cancelAsk(ask.id, "没有人看，已过期");
      this.notice("这个提问没有人看，已过期；这次提问已丢弃。", "info", { code: "ask_expired" });
    }
    // A card too young to expire is still somebody's to answer: taking the process down would drop
    // exactly the thing this rule exists to keep alive.
    if (this.approvals.size || this.asks.size) return;
    void this.sleepNow();
  }

  /** The process goes, messages and session file stay, the next message wakes it (D120). */
  private sleepNow(): Promise<void> {
    // Not re-entrant: the exit takes a while, and a second pass must not emit a second notice
    // (#79: the cap and 「全部休眠」 walk the same list the idle rule does).
    if (this.closing) return Promise.resolve();
    return this.close({ quiet: true }).then(() => {
      this.notice("会话已休眠（消息仍在，下次发消息会自动唤醒）", "info", { code: "session_slept" });
      this.emitWs({ type: "session.state", session: this.state });
    });
  }
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private gcTimer: NodeJS.Timeout | null = null;
  private cache: { at: number; metas: SessionFileMeta[] } | null = null;
  private modelCache: { at: number; list: ModelInfo[] } | null = null;
  /** D150：`-ne` 的快速清单与带扩展的完整清单各自缓存、各自去重。 */
  private fastCache: { at: number; list: ModelInfo[] } | null = null;
  private fastLoading: Promise<ModelInfo[]> | null = null;
  private fullLoading: Promise<ModelInfo[]> | null = null;
  /** Pin / manual order / archive — the part of the sidebar the user owns (D46). */
  readonly manage = new Manage();
  /** 工作区 = 工程（一级分组），由 cwd 推导、拖过的用 override 钉死（#94）。 */
  readonly workspaces = new Workspaces();

  constructor(
    private cli: string,
    /** Loopback origin the child posts to; null disables the whole loopback channel. */
    private loopbackUrl: string | null = null,
  ) {
    super();
  }

  /** Resolve the child that owns this token. Returns null for anything we did not spawn. */
  byLoopbackToken(token: string): Session | null {
    if (!token) return null;
    for (const s of this.sessions.values()) if (s.loopbackToken === token) return s;
    return null;
  }

  /**
   * The model catalog belongs to the pi install, not to a session, so it is fetched with a
   * throwaway rpc child and cached — models.json rarely changes mid-run.
   *
   * Two passes (D150). `modelsFast()` is the `-ne` child: 1–2 s, but it only knows the models the
   * pi install itself declares. `models()` is the full boot with extensions: 12–15 s here, and it
   * adds whatever extensions register (`qwen-pool/…`). The UI is handed the fast list first and
   * the full one when it lands, so a slow boot can no longer blank out the model sheet.
   */
  async modelsFast(force = false): Promise<ModelInfo[]> {
    if (!force && this.fastCache && Date.now() - this.fastCache.at < MODEL_TTL_MS) return this.fastCache.list;
    if (this.fastLoading) return this.fastLoading;
    this.fastLoading = fetchModels(this.cli, { fast: true })
      .then((list) => {
        this.fastCache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        this.fastLoading = null;
      });
    return this.fastLoading;
  }

  async models(force = false): Promise<ModelInfo[]> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_TTL_MS) return this.modelCache.list;
    if (this.fullLoading) return this.fullLoading;
    this.fullLoading = fetchModels(this.cli)
      .then((list) => {
        this.modelCache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        this.fullLoading = null;
      });
    return this.fullLoading;
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
    // 工作区：override 优先，否则跟 cwd 的工程根走（只查缓存，不跑 git）。
    const flag = (id: string, cwd?: string) => ({ pinned: manage.pin.includes(id), archived: manage.archived.includes(id), ws: this.workspaces.groupFor(id, cwd ?? "") });
    for (const s of this.sessions.values()) {
      seen.add(s.state.id);
      // 随手问 is not one of the user's sessions (#86): it has no place in any listing, not even
      // for a moment. Defence in depth — its files already sit outside the scanned root.
      if (s.state.scratch) continue;
      const lock = readLock(s.state.id);
      // Copy: these flags must not leak into the live state a session broadcasts.
      out.push({ ...s.state, ...flag(s.state.id, s.state.cwd), locked: Boolean((lock && lock.pid !== process.pid) || (!s.live && readTtyLock(s.state.id))) });
    }
    for (const meta of this.discover()) {
      if (seen.has(meta.id)) continue;
      const finished = readFinishedAt(meta.id);
      out.push({
        id: meta.id,
        name: preferredName(meta.id, meta.name, meta.nameAt) ?? meta.firstUserText?.slice(0, 40) ?? meta.id.slice(0, 8),
        cwd: meta.cwd,
        file: meta.file,
        owned: false,
        running: false,
        // D162: 桥停机期间终端续写过（文件比完成标记新）就不算完成 —— 与 Session 构造同一判据。
        done: finished !== null && !finishedIsStale(finished, meta.mtime),
        updatedAt: Math.round(meta.mtime),
        startedAt: meta.startedAt,
        approvals: 0,
        asks: 0,
        origin: originOf(meta.id),
        permission: readPermission(meta.id),
        ...(meta.firstUserText ? { preview: meta.firstUserText } : {}),
        ...flag(meta.id, meta.cwd),
        ...(readTtyLock(meta.id) ? { locked: true } : {}),
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
    session.loopbackUrl = this.loopbackUrl;
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

  async create(cwd: string, name?: string, launch: LaunchOptions = {}, opts: { scratch?: boolean } = {}): Promise<Session> {
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      /* reported below */
    }
    if (!isDir) throw new Error(`工作目录不存在：${cwd}`);
    const id = crypto.randomUUID();
    writeLaunch(id, launch);
    const session = new Session(this.cli, null, { id, name });
    session.state.cwd = cwd;
    // Before startLive: the spawn reads these (--session-dir, and the gate's allow file).
    if (opts.scratch) {
      session.state.scratch = true;
      session.state.permission = "readonly";
      writePermission(id, "readonly");
    }
    // D161: before startLive — the gate reads the allow file when pi spawns.
    await session.pinPermission();
    this.wire(session);
    this.sessions.set(id, session);
    await session.startLive({ resume: false, cwd, ws: this.workspaces.groupFor(id, cwd), name });
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  // ------------------------------------------------------------ 随手问 (#86)

  /** The one live 随手问. Bridge-side only: nothing is persisted, so a restart forgets it. */
  private scratchId: string | null = null;

  /**
   * 随手问 (#86): a session that is on no list, has its own longer idle rule and is never reaped by
   * the watermark. Opened lazily — the first click pays the cold start, nothing after it does — and
   * woken the ordinary way (resume) when it has slept.
   */
  async scratchSession(): Promise<Session> {
    if (this.scratchId) {
      const existing = this.sessions.get(this.scratchId);
      if (existing) {
        if (!existing.live) await this.openLive(this.scratchId);
        return existing;
      }
      this.scratchId = null;
    }
    ensureDir(scratchCwd());
    ensureDir(scratchSessionsDir());
    const session = await this.create(scratchCwd(), SCRATCH_NAME, { tools: SCRATCH_TOOLS, thinking: SCRATCH_THINKING }, { scratch: true });
    this.scratchId = session.state.id;
    return session;
  }

  /** 「清空」: a fresh session inside the same pi process (#86), no cold start. */
  async clearScratch(): Promise<Session> {
    const session = await this.scratchSession();
    await session.scratchClear();
    return session;
  }

  /**
   * `/reload` (#26): pi re-reads settings, extensions, skills, templates and context files only at
   * startup over RPC, so the web's reload is a restart of this session's pi — history stays on disk.
   */
  async reload(id: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session?.live) throw new Error("这个会话没有在运行，下次接管时自然就是最新的设置");
    if (session.state.running) throw new Error("这一轮还在跑，结束后再重新加载");
    await session.close({ quiet: true });
    session.ownExitAt = Date.now();
    return this.openLive(id);
  }

  // ------------------------------------------------------------ tree / fork / clone / import (#17)

  /**
   * The session's user messages as a tree: each one hangs under the nearest earlier user message
   * on its own path. `current` marks the branch pi would resume (D74). Read straight from the file,
   * so it works for read-only sessions too.
   */
  tree(id: string): { nodes: TreeNode[]; truncated: boolean } {
    const where = this.locate(id);
    if (!where?.file || !fs.existsSync(where.file)) return { nodes: [], truncated: false };
    const { entries, truncated } = loadEntries(where.file);
    const byId = new Map<string, SessionEntry>();
    for (const e of entries) if (e?.id) byId.set(e.id, e);
    const onBranch = new Set(currentBranch(entries).map((e) => e.id));
    const isUser = (e: SessionEntry | undefined) => e?.type === "message" && e.message?.role === "user";
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (!isUser(e)) continue;
      let parent: string | null = null;
      const seen = new Set<string>();
      let cur = typeof e.parentId === "string" ? byId.get(e.parentId) : undefined;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (isUser(cur)) {
          parent = cur.id;
          break;
        }
        cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
      }
      const text = titleFromUserText(contentText(e.message.content)) ?? "（图片）";
      nodes.push({ id: e.id, parent, text: text.slice(0, 160), ts: e.timestamp ?? null, current: onBranch.has(e.id) });
    }
    return { nodes, truncated };
  }

  /**
   * `/fork` (before a user message: the history up to it becomes a new session and the message's
   * text comes back for the editor) and `/clone` (the current branch, whole).
   *
   * Done with pi's own SessionManager loaded from the installed package, in this process:
   * `open()` only reads the source and `createBranchedSession()` writes the *new* file exactly as
   * pi's /fork would (header with parentSession, labels, compaction re-chaining). A throwaway
   * `pi --mode rpc --session <file>` was tried first and rejected: opening a session runs model
   * resolution, which can append a thinking_level_change entry to the SOURCE file — a second
   * writer on a file a terminal may own (D8).
   */
  async branchOff(id: string, how: { entryId?: string; index?: number; text?: string } | "clone"): Promise<{ sessionId: string; text: string | null }> {
    const where = this.locate(id);
    if (!where?.file || !fs.existsSync(where.file)) throw new Error("这个会话还没有写到磁盘，发过一条消息之后才能分叉 / 复制");
    // open() migrates v1/v2 files by rewriting them in place: never do that to a file we do not own.
    const header = readHeader(where.file);
    if (header?.version !== 3) throw new Error("这个会话文件是旧格式，先在终端里用 pi 打开一次让它升级，再来分叉");
    const { SessionManager: PiSessions } = await this.piSessionModule();
    const sm = PiSessions.open(where.file, path.dirname(where.file));
    let targetLeafId: string | null;
    let text: string | null = null;
    if (how === "clone") {
      targetLeafId = sm.getLeafId();
      if (!targetLeafId) throw new Error("这个会话是空的，没有可复制的内容");
    } else {
      const isUser = (e: any) => e?.type === "message" && e.message?.role === "user";
      let entry = how.entryId ? sm.getEntry(how.entryId) : undefined;
      if (!isUser(entry) && typeof how.index === "number") {
        // Live items carry bridge ids, not entry ids: find the message among the current branch's.
        // Both sides go through normalizeUserText: the file holds `/skill:x` expanded, the web sends
        // the folded command back, so compare what a human would see, not the stored bytes.
        const users = (sm.getBranch(sm.getLeafId()) as any[]).filter(isUser);
        const byIndex = users[how.index];
        if (byIndex && (!how.text || normalizeUserText(contentText(byIndex.message.content)) === normalizeUserText(how.text))) entry = byIndex;
        else if (how.text) {
          const want = normalizeUserText(how.text);
          entry = [...users].reverse().find((u) => normalizeUserText(contentText(u.message.content)) === want);
        }
      }
      if (!isUser(entry)) throw new Error("在会话文件里找不到这条消息（可能还没写盘），刷新后再试");
      targetLeafId = entry.parentId ?? null;
      text = displayUserText(contentText(entry.message.content));
    }
    if (targetLeafId) {
      const file = sm.createBranchedSession(targetLeafId);
      if (file && fs.existsSync(file)) {
        this.cache = null;
        const meta = readMeta(file);
        this.emit("ws", { type: "sessions.list", sessions: this.list(), workspace: this.workspaces.snapshot() });
        return { sessionId: meta?.id ?? "", text };
      }
    }
    // Forking at the very first message leaves nothing to keep (pi writes no empty file either):
    // that is a new session in the same folder with the message back in the editor.
    let cwdOk = false;
    try {
      cwdOk = fs.statSync(where.cwd).isDirectory();
    } catch {
      /* reported below */
    }
    if (!cwdOk) throw new Error(`会话的工作目录已经不存在：${where.cwd}`);
    const fresh = await this.create(where.cwd);
    return { sessionId: fresh.state.id, text };
  }

  /** pi's session-manager module from the installed package (see pimods.ts). */
  private piSessionModule(): Promise<any> {
    return piModule(this.cli, "core/session-manager.js");
  }

  /**
   * `/import <path>`: what pi's importFromJsonl does — copy the file (never move, never overwrite)
   * into the session folder for its cwd, then it is an ordinary session on the list.
   */
  importFile(source: string): { sessionId: string } {
    const src = path.resolve(source.trim().replace(/^"(.*)"$/, "$1"));
    if (!src.endsWith(".jsonl") || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`不是一个存在的 .jsonl 文件：${src}`);
    const meta = readMeta(src);
    if (!meta) throw new Error("文件第一行不是 pi 的会话头（type: session），不能导入");
    if (this.metas().some((m) => m.id === meta.id)) throw new Error(`会话 ${meta.id} 已经在列表里了`);
    const root = sessionsRootInfo();
    // pi's layout: a custom session dir is flat; the default one has a folder per cwd.
    const dir = root.source === "default" || root.source === "PI_AGENT_DIR" ? path.join(root.dir, encodeCwd(meta.cwd)) : root.dir;
    fs.mkdirSync(dir, { recursive: true });
    const { name, ext } = path.parse(path.basename(src));
    let dest = path.join(dir, `${name}${ext}`);
    for (let n = 1; fs.existsSync(dest); n++) dest = path.join(dir, `${name}-${n}${ext}`);
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    this.cache = null;
    this.emit("ws", { type: "sessions.list", sessions: this.list(), workspace: this.workspaces.snapshot() });
    return { sessionId: meta.id };
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

  /**
   * D161: the startup scan. Every session on disk gets pinned on the run that first sees it, and
   * never again (the file exists after that) — so this is a one-time cost per session, not per boot.
   */
  async pinAll(): Promise<number> {
    let pinned = 0;
    for (const meta of this.metas()) {
      // The file is the whole point of the pin, and it is also the early exit: `ensure()` here would
      // give every never-opened session on disk a Session object plus its 400 ms tail timer.
      if (fs.existsSync(allowFile(meta.id))) continue;
      try {
        const mode = (await defaultPermission(this.cli, meta.cwd)).mode;
        writePermission(meta.id, mode, "default");
        // A session that happens to be live keeps its in-memory state in step; disk-only ones need
        // nothing beyond the file — the gate reads it at spawn time.
        this.sessions.get(meta.id)?.applyPermission(mode);
        pinned++;
      } catch (err) {
        // One unwritable file must not stop the sweep, but it should be visible in the log.
        console.error(`[permission] 钉不住 ${meta.id}：`, err);
      }
    }
    return pinned;
  }

  /**
   * Sessions still sitting on a pinned default (`from: "default"`, or no file at all). `cwd` limits
   * it to one project — the settings sheet asks for the scope it is editing.
   */
  permissionDefaultSessions(cwd: string | null): { total: number } {
    return { total: this.defaultPermissionSessions(cwd).length };
  }

  /** The sessions behind `permissionDefaultSessions`, with the cwd each one pins against. */
  private defaultPermissionSessions(cwd: string | null): { id: string; cwd: string }[] {
    // Live sessions may not have a file on disk yet (a fake pi never writes one), so walk both.
    // 随手问 is not the user's session (#86) and its readonly mode is not a pinned default.
    const where = new Map<string, string>();
    for (const meta of this.metas()) where.set(meta.id, meta.cwd ?? "");
    for (const s of this.sessions.values()) {
      if (s.state.scratch) continue;
      if (!where.has(s.state.id)) where.set(s.state.id, s.state.cwd ?? "");
    }
    const want = cwd ? normalizeDir(cwd) : "";
    const out: { id: string; cwd: string }[] = [];
    for (const [id, dir] of where) {
      if (want && normalizeDir(dir) !== want) continue;
      const file = readPermissionFile(id);
      if (file && file.from !== "default") continue;
      out.push({ id, cwd: dir });
    }
    return out;
  }

  /**
   * 「应用到现有会话」: rewrite every pinned default to today's default, each session against its own
   * cwd (project settings differ per project). Manual picks are never touched.
   */
  async applyDefaultPermission(cwd: string | null): Promise<number> {
    let applied = 0;
    for (const target of this.defaultPermissionSessions(cwd)) {
      let mode: PermissionMode;
      try {
        mode = (await defaultPermission(this.cli, target.cwd || null)).mode;
      } catch (err) {
        console.error(`[permission] 解析不了 ${target.id} 的默认权限：`, err);
        continue;
      }
      writePermission(target.id, mode, "default");
      // Same as pinAll: only a live session has state to nudge, and `ensure()` would create one.
      this.sessions.get(target.id)?.applyPermission(mode);
      applied++;
    }
    return applied;
  }

  /** Explicit takeover: the web becomes the single writer for a session file. */
  async claim(id: string): Promise<Session> {
    const session = await this.openLive(id);
    // #200: 接管也是「重试」的入口 —— pi 已经活着时 `openLive` 什么也不做，但失败的那几条还在
    // 等一个人点一下，所以直接沿这条现成的路径补发，不新增协议帧。
    session.retryBootMessages();
    this.emit("ws", { type: "session.state", session: session.state });
    return session;
  }

  /**
   * #201: 一个会话同时只拉起一次 pi。接管与发消息是两条独立的 WS 命令，而 `openLiveNow()` 在
   * `pinPermission()` 上要 await 一段 —— 用户点完「接管」接着打字时，后一条命令完全来得及看见
   * `!live` 再起一支 pi，后一支会把前一支顶掉（同一份会话文件两个写者）。后来的调用直接等那一次
   * 在飞的拉起，成为之后才删除自己的那一条。
   */
  private opening = new Map<string, Promise<Session>>();

  openLive(id: string): Promise<Session> {
    const inFlight = this.opening.get(id);
    if (inFlight) return inFlight;
    const opening: Promise<Session> = this.openLiveNow(id).finally(() => {
      if (this.opening.get(id) === opening) this.opening.delete(id);
    });
    this.opening.set(id, opening);
    return opening;
  }

  /**
   * #201: 只读会话发消息 = 自动接管。先把消息收进那个会话的待发队列（气泡当场广播），**再**去
   * `openLive()` —— 拉起 pi 再等 get_state 要几秒，不能让这句「刚打的字」跟着一起等。
   *
   * 返回气泡的 item id（接管没成时要靠它标红）；会话不认识就返回 null，让 `openLive()` 照常报
   * 「找不到这个会话」。
   */
  acceptBeforeOpen(
    id: string,
    text: string,
    images: { data: string; mimeType: string }[] | undefined,
    clientId: string | undefined,
    behavior: "steer" | "followUp",
  ): string | null {
    if (!this.known(id)) return null;
    return this.ensure(id).acceptBeforeBoot(text, images, clientId, behavior);
  }

  /** Opens an existing session as the live writer (resumes it if pi already wrote it). */
  private async openLiveNow(id: string): Promise<Session> {
    if (!this.known(id)) throw new Error("找不到这个会话");
    const session = this.ensure(id);
    if (session.live) return session;
    // #30: a terminal pi with the session-lock extension says so explicitly — no guessing by mtime.
    const tty = readTtyLock(id);
    if (tty) throw new Error(`终端里的 pi（PID ${tty.pid}）正开着这个会话。先在那边退出（/quit）或换个会话，再在这里接管。`);
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
    await session.pinPermission();
    await session.startLive({ resume: Boolean(session.state.file), ws: this.workspaces.groupFor(id, session.state.cwd ?? "") });
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

  /**
   * 工作区分组的地基（#94）：给缓存里还没有的 cwd 补一次工程根，worktree 在这就并回主仓。
   * 有改动返回 true —— 调用方必须广播 `sessions.list` / `workspaces`，否则页面还停在按 cwd
   * 分的临时组上。读路径（`list()`）永远只查缓存，不等这里的子进程。
   */
  async resolveWorkspaces(): Promise<boolean> {
    const cwds: string[] = [];
    for (const s of this.sessions.values()) if (!s.state.scratch) cwds.push(s.state.cwd);
    for (const m of this.metas()) cwds.push(m.cwd);
    return this.workspaces.resolve(cwds);
  }

  /** Q-022: 置顶横条的 ＋ 建出来的会话，落到 pin 列表末尾。 */
  pinLast(id: string): void {
    this.manage.pinLast(id);
  }

  setArchived(ids: string[], on: boolean): void {
    this.manage.setArchived(ids, on);
  }

  /**
   * Delete session files. The only destructive operation in the bridge.
   *
   * A running session is *released first*, not refused: the person asked to delete it, and a writer
   * still holding the file makes the move either fail (EBUSY) or park a copy that keeps growing in
   * the bin. `Session.close()` aborts the in-flight turn and waits for it to land on disk, so the
   * last messages are still inside the file that gets parked — the turn is not lost, just stopped.
   * The one case left alone is a session locked by the terminal: that pi is not our child, so there
   * is nothing here that could hand its lock back.
   *
   * Partial success on purpose: a session that cannot be released no longer cancels the whole batch.
   * It used to throw before any unlink, so the client cleared its selection, nothing was deleted, no
   * `session.gone` was broadcast, and the cards stayed on screen with no visible reason.
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
      // 终端里的 pi 不是本桥的子进程：杀不掉，也不能替它交还写者身份。
      if (lock && lock.pid !== process.pid) {
        skipped.push({ id, name, reason: "终端正在使用" });
        continue;
      }
      targets.push({ id, name, file: session?.state.file ?? meta?.file ?? null, cwd: session?.state.cwd ?? meta?.cwd });
    }
    // 有文件才搬（进垃圾箱）；没有文件的（刚建、pi 还没落盘的空会话）关掉就行 —— 磁盘上本来就
    // 没东西可丢，也没东西可还原。
    const binnable = targets.filter((t) => Boolean(t.file) && fs.existsSync(t.file as string));
    // 运行中的先交还写者，多个并行：一个卡住的 rpc 不该让整批按 7 秒一个排队等（close 的两次等待）。
    const held = targets.map((t) => this.sessions.get(t.id)).filter((s): s is Session => Boolean(s?.live));
    const released: string[] = [];
    const settled = await Promise.allSettled(held.map((s) => s.close({ quiet: true })));
    settled.forEach((r, i) => {
      const s = held[i];
      if (r.status === "fulfilled") released.push(s.state.id);
      else skipped.push({ id: s.state.id, name: s.state.name, reason: `停止这个会话失败（${r.reason?.message ?? r.reason}）` });
    });
    const blocked = new Set(skipped.map((s) => s.id));
    const binned: TrashItem[] = [];
    const gone: string[] = [];
    for (const t of targets) {
      if (blocked.has(t.id)) continue;
      if (binnable.includes(t)) {
        const file = t.file as string;
        try {
          const size = fs.statSync(file).size;
          moveFile(file, trashPayload(t.id));
          binned.push({ id: t.id, name: t.name, file, cwd: t.cwd, deletedAt: Date.now(), size });
        } catch (err: any) {
          skipped.push({ id: t.id, name: t.name, reason: `文件移不进垃圾箱（${err?.code ?? err}）` });
          continue;
        }
      }
      gone.push(t.id);
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
      // D162: 进垃圾箱不是删除 —— 完成标记留着，restore() 回来时还能显示「完成」。
      // 只有 purge()（永久删）才清 finished.json。
      forgetOrigin(t.id);
      this.manage.forget(t.id);
      // 会话没了，它被拖进某个工作区的那条 override 也要跟着走，否则留下悬空指向（#94）。
      this.workspaces.forget(t.id);
    }
    if (binned.length) {
      const ids = new Set(binned.map((b) => b.id));
      writeTrash([...readTrash().filter((it) => !ids.has(it.id)), ...binned]);
    }
    // The file scan is cached for a few seconds; a move must not be resurrected by it.
    this.cache = null;
    return { removed: gone, skipped, released };
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
      // D162: 永久删除才丢完成标记；trash() 有意保留，restore() 后「完成」还在。
      forgetFinished(it.id);
    }
    if (purged.length) {
      const gone = new Set(purged);
      writeTrash(items.filter((it) => !gone.has(it.id)));
    }
    return { purged };
  }

  snapshot(id: string) {
    if (!this.known(id)) throw new Error("找不到这个会话");
    // D162: handing a snapshot to a client no longer clears 完成 —— 打开只是看，不是新的一轮。
    const session = this.ensure(id);
    return session.snapshot();
  }

  /** #219: `session` 帧只带末尾一页，和老前端看到的整段是同一份数据的尾巴。 */
  pagedSnapshot(id: string) {
    if (!this.known(id)) throw new Error("找不到这个会话");
    return this.ensure(id).pagedSnapshot();
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
   * Who is running and what the bridge's own pi children cost (D120 / #77). The pid set comes from
   * the `RpcChild` handles this manager holds and from nothing else, so no line of the process
   * table but ours can be counted. A reading that cannot be trusted is `null` + `unavailable`,
   * never an estimate: #79 will reap sessions with these numbers.
   *
   * Reusable rather than panel-specific: the watermark rule (#79) asks the same question on the
   * same tick. With no live pi it spawns nothing.
   */
  async runtimeStats(): Promise<RuntimeStats> {
    const live = [...this.sessions.values()].filter((s) => s.live);
    const pids: number[] = [];
    for (const s of live) if (s.pid !== null) pids.push(s.pid);
    const sample = await sampleMemory(pids);
    const sessions = live
      .map((s): RuntimeSession => {
        const pid = s.pid;
        const bytes = sample.failure === null && pid !== null ? sample.bytes.get(pid) : undefined;
        return {
          id: s.state.id,
          name: s.state.name,
          running: s.state.running,
          idleMs: s.idleFor(),
          ...(bytes === undefined ? {} : { bytes }),
        };
      })
      .sort((a, b) => b.idleMs - a.idleMs);
    const totalBytes = sample.failure === null && sessions.length ? [...sample.bytes.values()].reduce((sum, n) => sum + n, 0) : null;
    const cfg = lifecycle();
    return {
      running: sessions.length,
      totalBytes,
      unavailable: sample.failure !== null,
      sessions,
      // Only what the panel shows and may edit. The full `Lifecycle` also carries `abortGraceMs`,
      // which is a test seam (D120 §3): it is not sent to the page.
      lifecycle: { idleMs: cfg.idleMs, watermarkBytes: cfg.watermarkBytes },
    };
  }

  /**
   * 「全部休眠」(#80): sleep every live session that is not mid-run, and name the ones that were
   * skipped so the page can say who is still working. A running turn is never touched — that is the
   * whole point of the button (no silent interruption of work), and it is also why nothing else here
   * overrides `sleep()`'s own guard. Resolves when the sleeping ones have really let go of their pi.
   */
  async sleepAll(): Promise<{ slept: string[]; skipped: SleepSkipped[] }> {
    const slept: string[] = [];
    const skipped: SleepSkipped[] = [];
    const pending: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (!s.live) continue;
      if (s.state.running) {
        skipped.push({ id: s.state.id, name: s.state.name, why: "running" });
        continue;
      }
      slept.push(s.state.id);
      pending.push(s.sleep());
    }
    await Promise.all(pending);
    return { slept, skipped };
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
      void this.lifecycleTick();
      for (const [id, s] of this.sessions) {
        // D162: done 不再是「未读」，不能拿它当免死金牌 —— 回收后 ensure 会从 finished.json 读回来。
        if (s.live || s.state.running) continue;
        if (s.approvals.size || s.asks.size) continue;
        // A web-born session with no file yet only exists in memory; evicting it would lose it.
        if (!s.state.file) continue;
        if (isWatched(id) || s.idleFor() < IDLE_EVICT_MS) continue;
        s.stopTail();
        s.removeAllListeners();
        this.sessions.delete(id);
      }
    }, gcTickMs());
    this.gcTimer.unref?.();
  }

  /**
   * One pass of the process-lifecycle rules, always in the same order (D120): a stuck run first, so
   * the memory cap can never be what ends a session the watchdog was about to abort; idle reaping
   * before the cap, so the cheap reason wins and the cap only sees what is left.
   *
   * Async for the cap's one look at the process table (#79). That reading is also what the panel is
   * pushed with (#77), so a tick samples once, pushes once, and no timer exists for either.
   */
  private async lifecycleTick(): Promise<void> {
    const cfg = lifecycle();
    this.endStuckRuns(cfg);
    this.sleepIdleSessions(cfg);
    const stats = await this.runtimeStats();
    this.sleepOverCap(cfg, stats);
    this.emit("runtime", stats);
  }

  /** Watchdog for a `running` turn that stopped sending events — #81. */
  private endStuckRuns(cfg: Lifecycle): void {
    for (const s of this.sessions.values()) s.checkStuckRun(cfg);
  }

  /**
   * A finished run with no pi event for `idleMs` sleeps: the process goes, messages and session file
   * stay, and the next message wakes it (D120). Nobody watching counts as activity — a tab left open
   * unattended is exactly what this reaps. A pending approval or ask is the one thing that can hold
   * a session longer, and only while nobody is in front of a page *and* the card is itself that old
   * (#82) — a card cannot be expired by an absence that started before it existed.
   */
  private sleepIdleSessions(cfg: Lifecycle): void {
    // Whether a pending approval is still worth keeping is a fact about the person, not the session:
    // as long as some page is in front, nothing expires (#82).
    const unattended = absentFor();
    for (const s of this.sessions.values()) {
      if (!s.live) continue;
      if (s.approvals.size || s.asks.size) {
        // A pending approval means its turn is in flight, so this branch has to sit before the
        // `running` guard: that turn is exactly what sits there waiting on nobody (#82).
        if (unattended > cfg.idleMs) s.expireUnattended(cfg);
        continue;
      }
      if (s.state.running) continue;
      // 随手问 gets its own, longer rule (#86): being still there later is the whole point of it.
      if (s.idleFor() > (s.state.scratch ? cfg.scratchIdleMs : cfg.idleMs)) void s.sleep();
    }
  }

  /**
   * Memory cap (#79): with every live pi together above `cfg.watermarkBytes`, the sessions that have been
   * silent longest sleep until the total is back under it — the same `sleep()`, and so the same
   * notice, as the idle rule. Three of them are never candidates: a session mid-turn, one still
   * inside the wake-up protection window, and one holding an approval or a question (a person's
   * decision, not a memory figure).
   *
   * `stats` is the tick's reading, and a reading that cannot be trusted reaps nobody (D120 §6):
   * the panel may say 「不可用」, the two rules next to this one do not need the numbers and still run.
   * One live pi always stays, so the bridge cannot reap its way to zero.
   */
  private sleepOverCap(cfg: Lifecycle, stats: RuntimeStats): void {
    // One live pi is always left standing, so with one (or none) this level may not touch anything.
    if (stats.running <= 1) return;
    if (stats.unavailable || stats.totalBytes === null) {
      // D120 §6: a number we cannot trust is not a reason to guess. Say it and reap nobody.
      console.error("[lifecycle] 内存采样不可用：这一轮不按水位收会话");
      return;
    }
    if (stats.totalBytes <= cfg.watermarkBytes) return;
    const protectMs = capProtectMs();
    let total = stats.totalBytes;
    let left = stats.running;
    // `stats.sessions` is longest-idle first, which is exactly the order to reap in.
    for (const row of stats.sessions) {
      if (total <= cfg.watermarkBytes || left <= 1) return;
      const session = this.sessions.get(row.id);
      // No bytes means the table did not list this pid: reaping it would not move the total.
      if (!session?.live || row.bytes === undefined) continue;
      if (row.running || session.approvals.size || session.asks.size) continue;
      // Never a candidate (#86): the memory figure does not get to decide this one's fate.
      if (session.state.scratch) continue;
      if (row.idleMs < protectMs) continue;
      session.sleep();
      total -= row.bytes;
      left -= 1;
    }
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}

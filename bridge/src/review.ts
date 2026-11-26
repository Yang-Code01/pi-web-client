/**
 * 代码评审（#651）。
 *
 * 一次评审 = 三步：
 *   1. `ocr delegate preview` 说清这次该评哪些文件、基准提交是谁（确定性分片，OCR 的活）；
 *   2. 一个**一次性 `pi -p --mode json` 子进程**按分片去读 diff、出意见（推理的活，我们的模型）；
 *   3. 意见归一成固定形状、按 `path + 类别 + 代码片段` 认出「还是那一条」，落盘进状态目录。
 *
 * 为什么推理不挂在当前会话上：评审要对**任意仓库**跑、要能中断、要不占用户对话的上下文。
 * 为什么子进程只有只读工具：它读的是本机代码，而「只读」由 argv 保证，不靠提示词自觉
 * （`edit` / `write` 根本不在 `--tools` 里）。这几条见 docs/DECISIONS.md 的 D400。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { ensureDir, piChildEnv, quarantineStateFile, readJsonChecked, statePath } from "./paths.ts";
import { resolvePi } from "./pi.ts";
import { localRepoName, resolvePullRequest } from "./gitpr.ts";
import type {
  ReviewCategory,
  ReviewFinding,
  ReviewGroupPlan,
  ReviewLogLine,
  ReviewMark,
  ReviewMode,
  ReviewOcrStatus,
  ReviewPick,
  ReviewProgress,
  ReviewRun,
  ReviewRunStatus,
  ReviewSeverity,
  ReviewSkip,
  ReviewState,
} from "./frames.ts";

// 形状住在 `frames.ts`（桥与页面共用一份），这里给本文件与其它桥模块沿用原来的名字。
export type { ReviewFinding, ReviewMark, ReviewMode, ReviewRun, ReviewRunStatus, ReviewSkip, ReviewState } from "./frames.ts";
export type Severity = ReviewSeverity;
export type Category = ReviewCategory;

export type Mark = ReviewMark;
export type RunStatus = ReviewRunStatus;

/** 一个子进程最多评几个文件：31 个文件一次塞给模型，它会把 46 万 token 花在逛仓库上、最后什么都不答。 */
export const GROUP_FILES = 8;

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const CATEGORIES: Category[] = ["bug", "security", "performance", "maintainability", "test", "style", "documentation", "other"];

export class ReviewError extends Error {
  code: string;
  /** 可选：给界面翻译用的参数（`bridge.err.<code>` 里的 `{p1}` 之类）。 */
  params?: Record<string, string | number>;
  constructor(code: string, message: string, params?: Record<string, string | number>) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.params = params;
  }
}

// ---------------------------------------------------------------------------
// preview：ocr 说的话
// ---------------------------------------------------------------------------

export interface PreviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** 没评的文件与原因（太大 / 规则排除 / 超预算 / 模型没说）。静默丢掉等于说谎。 */
type PreviewSkip = ReviewSkip;

export interface Preview {
  mode: ReviewMode;
  from: string;
  to: string;
  mergeBase: string;
  files: PreviewFile[];
  skipped: PreviewSkip[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * 读 `ocr delegate preview --format json`。文档没有对这份结构做版本化承诺，所以这里只认
 * 「路径一定在、其余字段能认就认」：别名（`reviewable_files` / `excluded`）、未知字段、
 * stdout 前后混进日志，都不能把一次评审判死。
 */
export function parsePreview(stdout: string): Preview {
  const text = stdout ?? "";
  if (!text.trim()) throw new ReviewError("preview_empty", "ocr 没有返回任何内容");
  const body = sliceJson(text);
  let raw: any;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ReviewError("preview_unparsable", "读不懂 ocr 的 preview 输出（不是 JSON）");
  }
  if (!raw || typeof raw !== "object") throw new ReviewError("preview_unparsable", "preview 输出不是一个对象");

  const filesRaw = Array.isArray(raw.files)
    ? raw.files
    : Array.isArray(raw.reviewable_files)
      ? raw.reviewable_files
      : Array.isArray(raw.reviewableFiles)
        ? raw.reviewableFiles
        : null;
  if (!filesRaw) throw new ReviewError("preview_unparsable", "preview 里没有可评文件清单");

  const files: PreviewFile[] = [];
  for (const item of filesRaw) {
    const filePath = str((item as any)?.path).trim();
    if (!filePath) continue;
    files.push({
      path: filePath,
      status: str((item as any)?.status).trim(),
      additions: num((item as any)?.insertions ?? (item as any)?.additions ?? (item as any)?.added),
      deletions: num((item as any)?.deletions ?? (item as any)?.removed),
    });
  }

  const skipped: PreviewSkip[] = [];
  for (const item of arr(raw.excluded_files ?? raw.excluded ?? raw.skipped_files ?? raw.skipped)) {
    const filePath = str((item as any)?.path).trim();
    if (!filePath) continue;
    skipped.push({ path: filePath, reason: str((item as any)?.reason).trim() || "excluded" });
  }

  const mode = ((): ReviewMode => {
    const m = str(raw.mode);
    return m === "range" || m === "commit" || m === "workspace" ? m : "workspace";
  })();

  return {
    mode,
    from: str(raw.from),
    to: str(raw.to),
    mergeBase: str(raw.merge_base ?? raw.mergeBase ?? raw.base),
    files,
    skipped,
  };
}

/** 从一段可能带日志的 stdout 里抠出最外层的 JSON 对象。 */
function sliceJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + 1);
}

/** ocr 挂掉时分个类，好让面板说人话（装 / 升 / 修）。 */
export function classifyOcrFailure(stderr: string, code: number | null): "" | "ocr_missing" | "ocr_too_old" | "failed" {
  if (code === 0) return "";
  const text = stderr ?? "";
  if (/unknown flag|flag provided but not defined|unknown shorthand flag/i.test(text)) return "ocr_too_old";
  if (/ENOENT|not found|executable file not found|is not recognized/i.test(text)) return "ocr_missing";
  return "failed";
}

export interface PreviewTarget {
  mode: ReviewMode;
  base?: string;
  target?: string;
  commit?: string;
  cwd: string;
}

/** `ocr delegate preview` 的 argv（不含 ocr 自身）。三种模式一一对应。 */
export function previewArgs(t: PreviewTarget): string[] {
  const args = ["delegate", "preview"];
  if (t.mode === "range" || t.mode === "pr") {
    args.push("--from", String(t.base ?? "").trim() || "HEAD", "--to", String(t.target ?? "").trim() || "HEAD");
  } else if (t.mode === "commit") {
    args.push("-c", String(t.commit ?? "").trim() || "HEAD");
  }
  args.push("--format", "json");
  return args;
}

/** 提示词里给 agent 的那条取 diff 的命令：要求它与 ocr 的分片口径一致。 */
export function diffCommandFor(p: Preview, file: string): string {
  const target = p.to || "HEAD";
  if (p.mode === "commit") return `git --no-pager diff ${target === "HEAD" ? "HEAD" : target}~1 ${target} -- ${file}`;
  if (p.mode === "range" || p.mode === "pr") {
    const base = p.mergeBase || p.from || "HEAD";
    return `git --no-pager diff ${base}..${target} -- ${file}`;
  }
  return `git --no-pager diff HEAD -- ${file}`;
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const LANG_NAME = { zh: "中文", en: "English", ja: "日本語" } as const;
export type ReviewLang = keyof typeof LANG_NAME;

const PROTOCOL = `你是代码评审员。只按下面给的规则与文件清单工作，不去改任何文件。

输出协议（必须严格遵守）：
- 最后**只输出一个 JSON 对象**，不要解释、不要寒暄；可以用一个 \`\`\`json 围栏包住。
- 形状：
  {"findings":[{"path":"相对路径","content":"一句话说清问题与影响","start_line":12,"end_line":14,"category":"bug|security|performance|maintainability|test|style|documentation|other","severity":"critical|high|medium|low","existing_code":"命中的原文片段（必须逐字来自文件）","suggestion_code":"可选的修改片段"}],"skipped":[{"path":"相对路径","reason":"为什么没评"}]}
- 清单里的**每一个文件**都要交代：出现在 findings 里算 reviewed，没评的放 skipped 并写 reason，不许漏。
- 先看 diff（git --no-pager diff / git show）。只有光看 diff 判断不了时才读整个文件，**不要**在整个仓库里检索无关代码 —— 那些 token 不会让意见变准。
- 定位必须指向改动的那几行；找不到确切行就给 start_line: 0，不要编行号。
- 只报真问题：没有缺陷就别硬凑，findings 允许是空数组。
- 不报风格偏好、不报「建议加注释」这类空话；说不清影响的不报。`;

/** 把可评文件切成若干组（每组的文件由一个子进程评完）。 */
export function chunkFiles<T>(files: readonly T[], size = GROUP_FILES): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < files.length; i += Math.max(1, size)) out.push(files.slice(i, i + Math.max(1, size)));
  return out;
}

/** 一次评审的提示词。规则来自 `ocr delegate rule`（可能为空），语言跟着界面走。 */
export function buildPrompt(p: Preview, lang: ReviewLang, rules: string, group?: { index: number; total: number }): string {
  const files = p.files.map((f) => `- ${f.path}${f.status ? `（${f.status}）` : ""}`).join("\n");
  const cmd = diffCommandFor(p, "<文件>");
  const range =
    p.mode === "commit"
      ? `这次评的是单个提交 ${p.to || "HEAD"}。`
      : p.mode === "pr"
        ? `这次评的是一个 GitHub PR：${p.from || "?"} 到 ${p.to || "HEAD"}（合并基准 ${p.mergeBase || "未知"}）。`
        : p.mode === "range"
          ? `这次评的是 ${p.from || "?"} 到 ${p.to || "HEAD"} 的改动（合并基准 ${p.mergeBase || "未知"}）。`
          : `这次评的是工作区里未提交的改动。`;
  const rulesBlock = rules.trim() ? `\n## 这个仓库命中的规则\n\n${rules.trim()}\n` : "";
  return [
    PROTOCOL,
    "",
    group && group.total > 1 ? `## 分组\n\n这次评审分了 ${group.total} 组，你只负责第 ${group.index} 组：只评下面这些文件，评完就把 JSON 交回来，不要去看别的文件。\n` : "",
    `## 本次范围\n\n${range}`,
    "",
    `取 diff 的命令（把 <文件> 换成清单里的路径）：\`${cmd}\``,
    "需要更多上下文时，可以读整个文件、也可以在仓库里检索；不要改文件、不要跑测试、不要提交。",
    rulesBlock,
    `## 要评的文件\n\n${files}`,
    "",
    `## 语言\n\ncontent / reason 用${LANG_NAME[lang]}写；existing_code 与 suggestion_code 必须是原文代码，不翻译。`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 子进程参数
// ---------------------------------------------------------------------------

/**
 * 评审子进程的 argv（不含 node 与 pi 的 cli 路径）。
 *
 * `--tools` 是**整份替换**默认工具：只留 read/bash/grep/find/ls，`edit`/`write` 根本不存在，
 * 所以「评审进程改不了工作区」是 argv 保证的，不是提示词求它别改。`-ne` 让扩展一个都不加载，
 * `-nc` 不读 AGENTS.md（评审口径只认 OCR 的规则，不认本仓库的自述）。
 */
export function reviewArgs(o: { model?: string; provider?: string; thinking?: string }): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--tools",
    "read,bash,grep,find,ls",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "-ne",
    "--thinking",
    o.thinking || "low",
  ];
  if (o.provider) args.push("--provider", o.provider);
  if (o.model) args.push("--model", o.model);
  return args;
}

// ---------------------------------------------------------------------------
// 模型输出 → 意见
// ---------------------------------------------------------------------------

export interface Finding {
  path: string;
  startLine: number;
  endLine: number;
  category: Category;
  severity: Severity;
  content: string;
  existingCode: string;
  suggestionCode: string;
  /** `start_line: 0` = 定位不到行（模型说不出确切位置），面板要区别对待。 */
  anchored: boolean;
  /** 第几组发现它的（合流后才填）。 */
  group?: number;
}

export interface ParsedFindings {
  findings: Finding[];
  skipped: PreviewSkip[];
}

const pick = (o: any, ...keys: string[]): unknown => {
  for (const key of keys) if (o?.[key] !== undefined && o?.[key] !== null) return o[key];
  return undefined;
};

/**
 * 把模型那段话归一成意见。读不懂就当没说过（空结果），绝不把半截文本塞进面板：
 * 一条没有 path 或没有 content 的「意见」只会变成噪音。
 */
export function toFindings(raw: string): ParsedFindings {
  const body = sliceJson(raw ?? "");
  if (!body.trim().startsWith("{")) return { findings: [], skipped: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { findings: [], skipped: [] };
  }

  const findings: Finding[] = [];
  for (const item of arr(parsed?.findings)) {
    const filePath = str(pick(item, "path", "file")).trim();
    const content = str(pick(item, "content", "message", "text")).trim();
    if (!filePath || !content) continue;
    const startLine = num(pick(item, "start_line", "startLine", "line"));
    const endRaw = num(pick(item, "end_line", "endLine"));
    const category = str(pick(item, "category")).trim() as Category;
    const severity = str(pick(item, "severity")).trim().toLowerCase() as Severity;
    findings.push({
      path: filePath,
      startLine: startLine > 0 ? startLine : 0,
      endLine: endRaw > 0 ? endRaw : startLine > 0 ? startLine : 0,
      category: CATEGORIES.includes(category) ? category : "other",
      severity: SEVERITIES.includes(severity) ? severity : "low",
      content,
      existingCode: str(pick(item, "existing_code", "existingCode", "code")).trim(),
      suggestionCode: str(pick(item, "suggestion_code", "suggestionCode", "suggestion")).trim(),
      anchored: startLine > 0,
    });
  }

  const skipped: PreviewSkip[] = [];
  for (const item of arr(parsed?.skipped)) {
    const filePath = str(pick(item, "path", "file")).trim();
    if (!filePath) continue;
    skipped.push({ path: filePath, reason: str(pick(item, "reason")).trim() || "skipped" });
  }

  return { findings, skipped };
}

// ---------------------------------------------------------------------------
// 还是那一条吗
// ---------------------------------------------------------------------------

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * 一条意见的身份：`path + 类别 + 命中的代码片段`。
 *
 * 不用行号（改一行就全漂）、不用文案（界面切语言就被重写一遍）、不整段哈希（同一段被重新
 * 缩进不算新问题）。这也正是 OCR 自己 `session compare` 的口径。
 */
export function findingKey(f: Pick<Finding, "path" | "category" | "existingCode">): string {
  return crypto
    .createHash("sha1")
    .update(`${f.path}\u0000${f.category}\u0000${squash(f.existingCode)}`)
    .digest("hex")
    .slice(0, 16);
}

export type MergedFinding = ReviewFinding;

export interface MergeResult {
  findings: MergedFinding[];
  /** 上一轮有、这一轮没有的那几条（key + 路径，面板要说得出是哪个文件）。 */
  resolved: string[];
  resolvedPaths: string[];
}

/** 这一轮的意见对上一轮：新的 / 还在的，外加上一轮消失了的那批。 */
export function mergeFindings(
  prev: readonly Pick<Finding, "path" | "category" | "existingCode">[],
  next: readonly Finding[],
  marks: Record<string, Mark>,
): MergeResult {
  const prevByKey = new Map<string, string>();
  for (const f of prev) if (!prevByKey.has(findingKey(f))) prevByKey.set(findingKey(f), f.path);
  const findings = next.map((f) => {
    const key = findingKey(f);
    return {
      ...f,
      key,
      state: (prevByKey.has(key) ? "persisting" : "new") as "new" | "persisting",
      mark: (marks[key] ?? "") as Mark | "",
    };
  });
  const nextKeys = new Set(findings.map((f) => f.key));
  const resolved: string[] = [];
  const resolvedPaths: string[] = [];
  for (const [key, p] of prevByKey) {
    if (nextKeys.has(key)) continue;
    resolved.push(key);
    if (!resolvedPaths.includes(p)) resolvedPaths.push(p);
  }
  return { findings, resolved, resolvedPaths };
}

/**
 * 两次评审是不是「同一个范围」：工作区 / 分支 vs 主干（同一对照分支）/ 同一个提交。
 *
 * 不判这个的话，拿工作区那次当基线去比一次提交评审，会把整批意见都写成「已解决」。
 */
export function sameScope(
  run: Pick<ReviewRun, "mode" | "from" | "to" | "mergeBase" | "pr">,
  next: Pick<ReviewRun, "mode" | "from" | "to" | "mergeBase" | "pr">,
): boolean {
  if (run.mode !== next.mode) return false;
  if (run.mode === "pr") return run.pr > 0 && run.pr === next.pr;
  if (run.mode === "range") return run.from === next.from && run.to === next.to;
  if (run.mode === "commit") return run.to === next.to;
  return true;
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/** 同一个仓库只有一个 key：尾斜杠与大小写差异（macOS / Windows 常见）不该分家。 */
export function repoKey(dir: string): string {
  // `realpath` 不能省：macOS 上 `/tmp/x` 与 `/private/tmp/x` 是同一个仓库，会话 cwd 常常是前者、
  // `git rev-parse --show-toplevel` 给的是后者。不归一就会被当成两个仓库，落盘分家、面板读不到。
  let abs = path.resolve(dir);
  try {
    abs = fs.realpathSync.native(abs);
  } catch {
    /* 目录还不存在：用 resolve 的结果就够 */
  }
  const norm = abs.replace(/[\\/]+$/, "").toLowerCase();
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

export function reviewDir(): string {
  return statePath("review");
}

/** 会话 id 直接进文件名不安全（可能带奇怪字符），换成短哈希。 */
export function sessionKey(session: string): string {
  const text = String(session ?? "").trim();
  if (!text) return "_nosession";
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * 评审状态按「仓库 + 会话」分（#651）：同一个仓库开两个会话，各自有自己的一批评审。
 * 以前只按仓库分，于是「在一个会话里评过，切到另一个会话还看得到」——用户报的就是这个。
 */
export function reviewStateFile(repo: string, session = ""): string {
  return path.join(reviewDir(), repoKey(repo), `${sessionKey(session)}.json`);
}

export function readReviewState(repo: string, session = ""): ReviewState {
  const file = reviewStateFile(repo, session);
  const read = readJsonChecked<ReviewState>(file, { repo, runs: [], marks: {} });
  if (!read.ok) {
    // 读坏了就留档、从空状态起步：一次瞬时读失败不该让这个仓库的历史永远消失。
    quarantineStateFile(file);
    return { repo, runs: [], marks: {} };
  }
  const value = read.value;
  const state: ReviewState = {
    repo: str(value?.repo) || repo,
    runs: Array.isArray(value?.runs) ? value.runs : [],
    marks: value?.marks && typeof value.marks === "object" ? value.marks : {},
  };
  // 没记过就**不挂这个键**（挂个 `undefined` 会让 `deepEqual({repo, runs, marks})` 的调用方多出一个字段）。
  const pick = readPick(value?.pick);
  if (pick) state.pick = pick;
  return state;
}

/** `pick` 是老文件里没有的字段：认不出就当成「没记过」，由页面自己用默认值。 */
function readPick(raw: unknown): ReviewPick | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const mode = str(v.mode);
  if (mode !== "workspace" && mode !== "range" && mode !== "commit" && mode !== "pr") return undefined;
  return {
    mode,
    pr: Number(v.pr) || 0,
    base: str(v.base),
    target: str(v.target),
    commit: str(v.commit),
  };
}

/**
 * 面板上「评什么」这一格的选择，按会话落盘。
 *
 * 不这么做的话：切会话再切回来（`syncReviewSession()` 会把前端那几格清空）、或者刷新一次页面，
 * PR 号就没了，于是「开始评审」永远灰着 —— 用户报的「不能评审了」就是这条路。
 */
export function setPick(repo: string, pick: ReviewPick, session = ""): ReviewState {
  const state = readReviewState(repo, session);
  state.pick = pick;
  writeReviewState(repo, state, session);
  return state;
}

/** 历史只留最近这么多次：一次评审的记录几 KB，全留会让状态文件长成几百 KB，而界面只画得下几条。 */
export const RUN_KEEP = 20;

/**
 * 把历史截到 `RUN_KEEP` 条（新的留下）。只该在「加了一条新记录」后调（`startReview()`）。
 * 不要接到 `writeReviewState()` 上：标一条意见、改一次 pick 也走写盘，在那里截会把用户
 * 正点开看着的那一条截掉。
 */
export function trimRuns(state: ReviewState): void {
  if (state.runs.length > RUN_KEEP) state.runs = state.runs.slice(-RUN_KEEP);
}

export function writeReviewState(repo: string, state: ReviewState, session = ""): void {
  const file = reviewStateFile(repo, session);
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function isMark(value: unknown): value is Mark {
  return value === "accept" || value === "ignore" || value === "false-positive";
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** 用户给某一条标的处理态：跨轮次写在仓库上，重跑不改它。 */
export function markFinding(repo: string, key: string, mark: Mark | "", session = ""): ReviewState {
  const state = readReviewState(repo, session);
  if (mark) state.marks[key] = mark;
  else delete state.marks[key];
  for (const run of state.runs) for (const f of run.findings) if (f.key === key) f.mark = mark;
  writeReviewState(repo, state, session);
  return state;
}

/** 「清理」只清历史评审（留着 marks：那些是「这条我判过了」，不该因为清历史又复活）。 */
export function cleanRuns(repo: string, session = ""): ReviewState {
  // 面板上那颗按钮已经删了（历史改成一段可点的记录列表，留不留下不再是用户要点的决定）；
  // 这个能力留给排障与测试用，别从别处直接调它去清用户的历史。
  const state = readReviewState(repo, session);
  state.runs = [];
  writeReviewState(repo, state, session);
  return state;
}

// ---------------------------------------------------------------------------
// 跑一次
// ---------------------------------------------------------------------------

const REVIEW_TIMEOUT_MS = 30 * 60_000;

/** 面板轮询/广播的那个「现在到哪了」。 */
export type Progress = ReviewProgress;

interface Active {
  cancel: () => void;
}

/** 一个仓库同时只跑一次；key 与落盘同一个 `repoKey`。 */
const active = new Map<string, Active>();
const progressMap = new Map<string, Progress>();

const activeKey = (repo: string, session: string) => `${repoKey(repo)}\u0000${sessionKey(session)}`;

export function reviewProgress(repo: string, session = ""): Progress | null {
  return progressMap.get(activeKey(repo, session)) ?? null;
}

/** 桥重启后，盘上还写着 running 的那几次永远不会再有人收尾 —— 开机时统一转成「已失效」。 */
export function sweepStaleRuns(): number {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(reviewDir(), { withFileTypes: true })) {
      const full = path.join(reviewDir(), entry.name);
      if (entry.isDirectory()) {
        for (const f of fs.readdirSync(full)) if (f.endsWith(".json")) files.push(path.join(full, f));
      } else if (entry.name.endsWith(".json")) {
        files.push(full); // 老版本按仓库单文件放的，一起收拾
      }
    }
  } catch {
    return 0;
  }
  let changed = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ReviewState;
      let dirty = false;
      for (const run of raw.runs ?? []) {
        if (run.status !== "running") continue;
        run.status = "stale";
        run.errorCode = "bridge-restart";
        run.error = "桥重启了，这次评审没跑完";
        dirty = true;
      }
      if (!dirty) continue;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      changed += 1;
    } catch {
      /* 坏文件留给读取那一侧去 quarantine */
    }
  }
  return changed;
}

/** 仓库根：意见里的 path 是相对它写的，点击跳转也要靠它。 */
export function gitRoot(dir: string): string {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return out ? path.resolve(out) : path.resolve(dir);
  } catch {
    throw new ReviewError("not_git", "这个目录不是 git 仓库，没有东西可评");
  }
}

// ---------------------------------------------------------------------------
// 「评审仓库」钉子：这个会话评哪个目录
// ---------------------------------------------------------------------------

/**
 * 会话 → 钉住的目录；空着就是「跟着会话目录走」。
 *
 * 为什么落盘在桥上：用户选的是「大文件夹底下的那个子仓库」，刷新页面、换个页签、甚至重启桥
 * 之后还得算数 —— 只存在前端的话，切一下会话回来就又变成「这个目录不是 git 仓库」了。
 * 按会话分文件：同一台机器上的两个会话常常开在不同目录，不该互相牵连。
 */
export function reviewPinFile(session = ""): string {
  return path.join(reviewDir(), "pins", `${sessionKey(session)}.json`);
}

export function readReviewPin(session = ""): string {
  const read = readJsonChecked<{ dir?: unknown }>(reviewPinFile(session), {});
  if (!read.ok) return "";
  return str((read.value as Record<string, unknown> | null)?.dir);
}

/** 记一颗钉子；`dir` 为空 = 拔掉。返回真正存下的目录（调用方负责先归一成仓库根）。 */
export function setReviewPin(dir: string, session = ""): string {
  const file = reviewPinFile(session);
  const raw = String(dir ?? "").trim();
  if (!raw) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 本来就没有 */
    }
    return "";
  }
  const abs = path.resolve(raw);
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ dir: abs }, null, 2));
  fs.renameSync(tmp, file);
  return abs;
}

/**
 * 「这个会话到底评哪个目录」的单一真值：钉住的那个仓库优先，否则就是会话目录。
 *
 * 钉子失效（目录被删、或者那几个目录后来不再是仓库）时清掉它并回落 —— 否则面板永远停在
 * 「这个目录不是 git 仓库」，用户也找不到能点的地方，等于把自己锁在门外。
 */
export function effectiveReviewDir(dir: string, session = ""): { repo: string; pinned: string } {
  const pin = readReviewPin(session);
  if (pin) {
    try {
      const repo = gitRoot(pin);
      return { repo, pinned: repo };
    } catch {
      setReviewPin("", session);
    }
  }
  return { repo: gitRoot(dir), pinned: "" };
}

/**
 * `ocr` 怎么起。POSIX 直接靠 PATH；Windows 上 npm 装出来的是 `ocr.cmd`，Node ≥ 18.20 拒绝
 * 不带 shell 去跑 `.cmd`，所以过一层 `cmd.exe /c`（参数逐条加引号，路径里有空格也不会拆坏）。
 */
function ocrInvocation(): { cmd: string; prefix: string[] } {
  const override = process.env.OCR_BIN;
  if (override) return { cmd: override, prefix: [] };
  if (process.platform === "win32") return { cmd: "cmd.exe", prefix: ["/c", "ocr"] };
  return { cmd: "ocr", prefix: [] };
}

function runCapture(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: piChildEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ReviewError("timeout", `${Math.round(timeoutMs / 1000)} 秒没有回应`)));
    }, timeoutMs);
    signal?.addEventListener("abort", () => {
      child.kill();
      finish(() => reject(new ReviewError("cancelled", "已停止")));
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(new ReviewError(err?.code === "ENOENT" ? "ocr_missing" : "failed", err?.message ?? String(err))));
    });
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
  });
}

async function runOcr(argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const { cmd, prefix } = ocrInvocation();
  const args = prefix.length ? [...prefix, ...quoteForCmd(argv)] : argv;
  const out = await runCapture(cmd, args, cwd, timeoutMs, signal);
  const kind = classifyOcrFailure(out.stderr, out.code);
  if (kind === "ocr_missing") throw new ReviewError("ocr_missing", "没装 ocr");
  if (kind === "ocr_too_old") throw new ReviewError("ocr_too_old", "ocr 版本太老（需要 1.9.0+）");
  if (kind === "failed") throw new ReviewError("ocr_failed", firstLine(out.stderr) || `ocr 退出码 ${out.code}`);
  return out;
}

/** 过 `cmd.exe /c` 时把参数逐条加引号：`Program Files` 这种路径不能被空格拆开。 */
function quoteForCmd(args: string[]): string[] {
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
}

function firstLine(text: string): string {
  return (text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

async function rulesFor(repo: string, files: string[], signal?: AbortSignal): Promise<string> {
  const paths = files.slice(0, 200);
  if (!paths.length) return "";
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += 40) chunks.push(paths.slice(i, i + 40));
  const out: string[] = [];
  for (const chunk of chunks) {
    try {
      const { stdout } = await runOcr(["delegate", "rule", ...chunk], repo, 60_000, signal);
      if (stdout.trim()) out.push(stdout.trim());
    } catch {
      // 拿不到规则照样能评：规则只是加分项，不是这次评审的前提。
      return out.join("\n\n");
    }
  }
  return out.join("\n\n").slice(0, 8000);
}

export interface StartOptions {
  /** 会话 cwd 或仓库目录；桥自己找仓库根。 */
  dir: string;
  mode: ReviewMode;
  base?: string;
  target?: string;
  commit?: string;
  /** `mode: "pr"` 时要评的 PR 号。 */
  pr?: number;
  /**
   * #666：这个号属于哪个仓库（从链接卡点过来时带上的）。
   * 缺省（手输号、别的入口）不拦 —— 这里只堵「拿别的仓库的卡点了评审」这一条。
   */
  expectRepo?: string;
  /** 哪个会话发起的：评审状态按「仓库 + 会话」分开存。 */
  session?: string;
  model?: string;
  provider?: string;
  lang: ReviewLang;
  onProgress?: (p: Progress) => void;
  /** 开始 / 结束各叫一次：让页面重新拉整份状态。 */
  onState?: () => void;
}

/**
 * 「这张卡属于的仓库」与「会话仓库」不是同一个吗？
 *
 * 任一方为空就不算不符：认不出本地仓库时不该把正常评审也堵死，老页面也不带这个字段。
 */
export function expectRepoMismatch(localRepo: string, expectRepo: string): boolean {
  const local = (localRepo ?? "").trim().toLowerCase();
  const want = (expectRepo ?? "").trim().toLowerCase();
  if (!local || !want) return false;
  return local !== want;
}

export function startReview(o: StartOptions): { runId: string; repo: string } {
  const root = gitRoot(o.dir);
  // #666：评审只在**会话目录**里跑（`gh pr view <号>` 与 `git fetch refs/pull/<号>/head` 都拿 cwd），
  // 号是别仓的那只就会把本仓同号的 PR 静默评掉（D399 记过同类错数据）。先拒，比给出错结果便宜。
  if (o.mode === "pr" && o.expectRepo) {
    const local = localRepoName(root);
    if (expectRepoMismatch(local, o.expectRepo)) {
      throw new ReviewError(
        "pr_foreign_repo",
        `这张卡是 ${o.expectRepo} 的 PR，本会话评的是 ${local || "另一个仓库"} —— 评审只在会话目录里跑`,
        { p1: o.expectRepo, p2: local || "?" },
      );
    }
  }
  const session = String(o.session ?? "");
  const key = activeKey(root, session);
  if (active.has(key)) throw new ReviewError("busy", "这个会话已经在评了");

  const state = readReviewState(root, session);
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const run: ReviewRun = {
    id: runId,
    mode: o.mode,
    from: o.base ?? "",
    to: o.mode === "commit" ? o.commit ?? "HEAD" : "HEAD",
    mergeBase: "",
    pr: o.mode === "pr" ? Number(o.pr) || 0 : 0,
    prTitle: "",
    prHead: "",
    prBase: "",
    status: "running",
    startedAt,
    finishedAt: "",
    model: o.model ?? "",
    provider: o.provider ?? "",
    lang: o.lang,
    findings: [],
    resolved: [],
    resolvedPaths: [],
    skipped: [],
    reviewedFiles: 0,
    totalFiles: 0,
    tokens: 0,
    error: "",
    errorCode: "",
    log: [],
  };
  state.runs.push(run);
  // 历史只留最近 `RUN_KEEP` 次。裁剪放在「加一条新记录」这里，不放 `writeReviewState()`：
  // 那是所有改动的窄口，标一条意见、改一次 pick 都会走它 —— 在那里截，会把用户正
  // 点开看着的那一条也截掉（`reviewFocus` 指向的记录一拍就跳回最新一条）。
  trimRuns(state);
  writeReviewState(root, state, session);

  const abort = new AbortController();
  const emit = (patch: Partial<Progress>) => {
    const prev = progressMap.get(key);
    const next: Progress = {
      repo: root,
      runId,
      status: "running",
      phase: "preview",
      totalFiles: 0,
      reviewedFiles: 0,
      currentFile: "",
      tokens: 0,
      startedAt,
      error: "",
      errorCode: "",
      group: 0,
      groups: 0,
      log: prev?.log ?? [],
      ...prev,
      ...patch,
    };
    progressMap.set(key, next);
    o.onProgress?.(next);
  };

  active.set(key, {
    cancel: () => {
      abort.abort();
    },
  });
  /** 往时间线里加一行并发出去（面板与详情 dialog 都吃它）。 */
  const note = (text: string, group?: number) => {
    const prev = progressMap.get(key);
    const line: ReviewLogLine = { at: Date.now(), text, ...(group ? { group } : {}) };
    const log = [...(prev?.log ?? []), line].slice(-40);
    emit({ log });
  };
  emit({});
  note(
    o.mode === "pr"
      ? `开始评审：PR #${Number(o.pr) || 0}`
      : o.mode === "range"
        ? `开始评审：${o.target || "HEAD"} vs ${o.base || "主干"}`
        : o.mode === "commit"
          ? `开始评审：提交 ${o.commit || "HEAD"}`
          : "开始评审：工作区改动",
  );
  o.onState?.();

  void execute({ root, run, opts: o, session, signal: abort.signal, emit, note })
    .catch((err: any) => {
      // execute 自己兜底写盘；这里只防「兜底本身抛了」把进程带走。
      console.error("[review] 收尾失败", err?.message ?? err);
    })
    .finally(() => {
      active.delete(key);
      o.onState?.();
    });

  return { runId, repo: root };
}

export function cancelReview(dir: string, session = ""): boolean {
  const key = activeKey(dir, session);
  const running = active.get(key);
  if (!running) return false;
  running.cancel();
  return true;
}

/** 上一次**同一个范围**里完成的评审：三态只跟它比。 */
function prevDoneRun(state: ReviewState, scope: Pick<ReviewRun, "mode" | "from" | "to" | "mergeBase" | "pr">): ReviewRun | null {
  for (let i = state.runs.length - 1; i >= 0; i -= 1) {
    const run = state.runs[i];
    if (run.status !== "done") continue;
    if (sameScope(run, scope)) return run;
  }
  return null;
}

/**
 * 没被交代的文件也要列出来：`preview` 说可评、模型既没给意见也没说 skip 的那些，
 * 说明这一轮它没看到 —— 归到 `not_reported`，不许当「评过了没问题」。
 */
export function unaccounted(preview: Preview | null, reported: PreviewSkip[], findings: readonly Finding[]): PreviewSkip[] {
  const out: PreviewSkip[] = [...(preview?.skipped ?? [])];
  for (const item of reported) if (!out.some((x) => x.path === item.path)) out.push(item);
  // 有意见的文件当然算交代过了 —— 只看 skipped 会把它们误报成「模型没说」。
  const handled = new Set([...out.map((s) => s.path), ...findings.map((f) => f.path)]);
  for (const file of preview?.files ?? []) {
    if (handled.has(file.path)) continue;
    handled.add(file.path);
    out.push({ path: file.path, reason: "not_reported" });
  }
  return out;
}

interface ExecuteCtx {
  root: string;
  session: string;
  run: ReviewRun;
  opts: StartOptions;
  signal: AbortSignal;
  emit: (patch: Partial<Progress>) => void;
  /** 往时间线里加一行（`group` = 这行属于第几组，详情窗按组折叠）。 */
  note: (text: string, group?: number) => void;
}

async function execute(ctx: ExecuteCtx): Promise<void> {
  const { root, session, run, opts, signal, emit, note } = ctx;
  const key = activeKey(root, session);
  let tokens = 0;
  let currentFile = "";
  let preview: Preview | null = null;

  const finish = (patch: Pick<ReviewRun, "status"> & Partial<ReviewRun>) => {
    const state = readReviewState(root, session);
    const onDisk = state.runs.find((r) => r.id === run.id);
    // 先把最后一行写进时间线，再连同日志一起落盘（顺序反了，日志就永远追不上这次写盘）。
    if (patch.status === "done") note(`完成：${patch.findings?.length ?? 0} 条意见`);
    else if (patch.status === "failed") note(`失败：${patch.error || patch.errorCode || ""}`);
    else if (patch.status === "stopped") note("已停止");
    const prevProgress = progressMap.get(key);
    // 进度帧一消失日志就没了 —— 记录里留一份，面板/dialog 跑完还能看时间线。
    (patch as Partial<ReviewRun>).log = prevProgress?.log ?? [];
    // 分组计划同理：完成态要看「哪组出了几条」，不能只剩一个总数。
    (patch as Partial<ReviewRun>).plan = prevProgress?.plan ?? patch.plan ?? [];
    if (onDisk) Object.assign(onDisk, patch);
    else state.runs.push({ ...run, ...patch });
    writeReviewState(root, state, session);
    emit({
      status: patch.status,
      phase: "done",
      tokens,
      currentFile: "",
      reviewedFiles: patch.reviewedFiles ?? prevProgress?.reviewedFiles ?? 0,
      totalFiles: patch.totalFiles ?? prevProgress?.totalFiles ?? 0,
      error: patch.error ?? "",
      errorCode: patch.errorCode ?? "",
    });
    progressMap.delete(key);
  };

  /** 起一个子进程评一组：边跑边发进度，结束时把它答的那段话交回来。 */
  const runChild = (prompt: string) =>
    new Promise<{ code: number | null; text: string; stderr: string; aborted: boolean; touched: Set<string>; tokens: number; lines: number; silent: boolean }>((resolve) => {
      const pi = resolvePi();
      const proc = spawn(process.execPath, [pi.cli, ...reviewArgs({ model: opts.model, provider: opts.provider })], {
        cwd: root,
        env: piChildEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      let text = "";
      let localTokens = 0;
      let outLines = 0;
      let silent = false;
      let lastOut = Date.now();
      const touched = new Set<string>();
      let settled = false;
      const finishChild = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        clearInterval(silence);
        signal.removeEventListener("abort", onAbort);
        try {
          proc.stdout?.destroy();
        } catch {
          /* 已经关了 */
        }
        resolve({ code, text, stderr, aborted: signal.aborted, touched, tokens: localTokens, lines: outLines, silent });
      };
      const guard = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* 已经退了 */
        }
      }, REVIEW_TIMEOUT_MS);
      // 一行输出都没有超过 90 秒：正常跑着的 pi 最迟几秒就会吐 session/turn_start。
      const silence = setInterval(() => {
        if (Date.now() - lastOut < 90_000) return;
        silent = true;
        clearInterval(silence);
        try {
          proc.kill();
        } catch {
          /* 已经退了 */
        }
      }, 5_000);
      const onAbort = () => {
        try {
          proc.kill();
        } catch {
          /* 已经退了 */
        }
      };
      signal.addEventListener("abort", onAbort);
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
      proc.stdin?.end(prompt);
      const lines = readline.createInterface({ input: proc.stdout! });
      lines.on("line", (line) => {
        outLines += 1;
        lastOut = Date.now();
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev?.type === "tool_execution_start") {
          const rel = relativeTo(root, ev.args?.path || ev.args?.pattern || ev.args?.command || "");
          if (rel) currentFile = rel.slice(0, 120);
          if (ev.toolName === "read" && rel) touched.add(rel);
          emit({ currentFile });
          return;
        }
        if (ev?.type === "message_end") {
          const usage = ev.message?.usage;
          if (usage && typeof usage.totalTokens === "number") {
            tokens += usage.totalTokens;
            localTokens += usage.totalTokens;
          }
          if (ev.message?.role === "assistant" && Array.isArray(ev.message.content)) {
            const answered = ev.message.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
            if (answered.trim()) text = answered;
          }
          emit({ tokens });
        }
      });
      proc.on("error", (err) => {
        stderr = `${stderr}\n${(err as Error)?.message ?? String(err)}`;
        finishChild(-1);
      });
      proc.on("close", (code) => finishChild(code));
    });

  try {
    let base = opts.base;
    let target = opts.target;
    if (opts.mode === "pr") {
      // PR 的代码不在本地：先把 `refs/pull/N/head` 与 base 分支 fetch 下来（不动工作区），
      // 再按普通的「范围」走 —— 分片、规则、三态全复用。
      emit({ phase: "fetch" } as Partial<Progress>);
      const resolved = await resolvePullRequest(root, Number(opts.pr) || 0, (line) => emit({ currentFile: line } as Partial<Progress>));
      base = resolved.from;
      target = resolved.to;
      run.pr = resolved.pr;
      run.prTitle = resolved.title;
      run.prHead = resolved.headRefName;
      run.prBase = resolved.baseRefName;
      run.from = resolved.from;
      run.to = resolved.to;
      note(`PR #${resolved.pr} 的提交已取到：${resolved.to}（对照 ${resolved.from}）`);
    }
    const spec: PreviewTarget = { mode: opts.mode, base, target, commit: opts.commit, cwd: root };
    const { stdout } = await runOcr(previewArgs(spec), root, 120_000, signal);
    preview = parsePreview(stdout);
    run.mergeBase = preview.mergeBase;
    run.from = preview.from || run.from;
    run.to = preview.to || run.to;
    run.totalFiles = preview.files.length;
    note(`ocr 分片：可评 ${preview.files.length} 个文件` + (preview.skipped.length ? `，另有 ${preview.skipped.length} 个被排除` : ""));
    emit({ phase: "rules", totalFiles: preview.files.length });

    if (!preview.files.length) {
      finish({ status: "done", finishedAt: new Date().toISOString(), skipped: preview.skipped });
      return;
    }

    // 31 个文件一次塞给一个子进程，实测它把 46 万 token 花在逛仓库上、最后什么都不答 ——
    // 分组跑：每组一个子进程、一份小提示词，各自交 JSON，最后合起来。
    const rules = (await rulesFor(root, preview.files.map((f) => f.path), signal)).slice(0, 4000);
    const groups = chunkFiles(preview.files);
    const plan: ReviewGroupPlan[] = groups.map((files, i) => ({
      index: i + 1,
      files: files.length,
      findings: 0,
      state: "pending",
      startedAt: "",
      finishedAt: "",
    }));
    const emitPlan = () => emit({ plan: plan.map((p) => ({ ...p })) });
    emitPlan();
    note(`分 ${groups.length} 组跑，每组最多 ${GROUP_FILES} 个文件`);
    const collected: Finding[] = [];
    const lastSkipped: PreviewSkip[] = [];
    const accountedPaths = new Set<string>();
    let answered = false;
    let lastChildWhy = "";
    let failed: { code: number | null; stderr: string; group: number } | null = null;

    for (let i = 0; i < groups.length; i += 1) {
      if (signal.aborted) break;
      emit({ phase: "review", currentFile: groups[i][0]?.path ?? "", group: i + 1, groups: groups.length });
      plan[i].state = "running";
      plan[i].startedAt = new Date().toISOString();
      emitPlan();
      note(`第 ${i + 1}/${groups.length} 组开始：${groups[i].length} 个文件`, i + 1);
      const sub: Preview = { ...preview, files: groups[i] };
      const prompt = buildPrompt(sub, opts.lang, rules, { index: i + 1, total: groups.length });
      let res = await runChild(prompt);
      if (res.aborted) break;
      if (res.code !== 0) {
        failed = { code: res.code, stderr: res.stderr, group: i + 1 };
        plan[i].state = "failed";
        plan[i].finishedAt = new Date().toISOString();
        emitPlan();
        break;
      }
      if (!res.text.trim()) {
        // 退出码 0、一句话没有：多半是工具调用把轮次/上下文吃掉了。重试一次，明确让它「别再调工具」。
        const why = res.silent
          ? "90 秒没有任何输出"
          : firstLine(res.stderr) || `退出码 ${res.code}、输出 ${res.lines} 行`;
        lastChildWhy = why;
        note(`第 ${i + 1} 组没给结论（${why}；已用 ${Math.round(res.tokens / 1000)}k token），重试一次`, i + 1);
        const nudge = `${prompt}\n\n## 立即收尾\n\n不要再调用任何工具。根据你已经看到的内容直接输出上面那个 JSON 对象；宁可少报，也要把 JSON 交回来。`;
        res = await runChild(nudge);
        if (res.aborted) break;
        if (res.code !== 0) {
          failed = { code: res.code, stderr: res.stderr, group: i + 1 };
          // 重试也失败依旧是「这一组失败」：不标就会在计划里一直挂着 running（落盘后失败详情会显示成进行中）。
          plan[i].state = "failed";
          plan[i].finishedAt = new Date().toISOString();
          emitPlan();
          break;
        }
      }
      const parsed = toFindings(res.text);
      if (res.text.trim()) answered = true;
      for (const f of parsed.findings) f.group = i + 1;
      collected.push(...parsed.findings);
      for (const f of parsed.findings) accountedPaths.add(f.path);
      for (const sk of parsed.skipped) accountedPaths.add(sk.path);
      lastSkipped.push(...parsed.skipped);
      plan[i].state = "done";
      plan[i].findings = parsed.findings.length;
      plan[i].finishedAt = new Date().toISOString();
      note(`第 ${i + 1} 组完成：${parsed.findings.length} 条`, i + 1);
      emitPlan();
      // 跑的过程中也要能看到意见：只发「已定形」的字段，key/三态等收尾时统一算。
      emit({
        reviewedFiles: accountedPaths.size,
        findings: collected.map((f) => ({ ...f, key: findingKey(f), state: "new" as const, mark: "" as const })),
      });
    }

    const stopped = signal.aborted;
    if (stopped) {
      for (const p of plan) if (p.state === "running") p.state = "pending";
      emitPlan();
    }
    const state = readReviewState(root, session);
    const prevRun = prevDoneRun(state, { mode: opts.mode, from: run.from, to: run.to, mergeBase: preview.mergeBase, pr: run.pr });
    const merged = mergeFindings(prevRun?.findings ?? [], collected, state.marks);
    const skipped = unaccounted(preview, lastSkipped, collected);
    const total = preview.files.length;

    if (!stopped && failed) {
      finish({
        status: "failed",
        finishedAt: new Date().toISOString(),
        findings: merged.findings,
        resolved: merged.resolved,
        resolvedPaths: merged.resolvedPaths,
        skipped,
        totalFiles: total,
        reviewedFiles: accountedPaths.size,
        tokens,
        from: run.from,
        to: run.to,
        mergeBase: preview.mergeBase,
        pr: run.pr,
        prTitle: run.prTitle,
        prHead: run.prHead,
        prBase: run.prBase,
        error: firstLine(failed.stderr) || `第 ${failed.group} 组的评审进程退出码 ${failed.code}`,
        errorCode: "child_failed",
      });
      return;
    }
    if (!stopped && !answered) {
      // 退出码 0、一个字都没答：这不是「没问题」，是这次没评成。别把空结果写成 done。
      // 重试已经在组里做过一次了，这里把「哪一组、花了多少」说清楚，并给两条能自己动手的路。
      finish({
        status: "failed",
        finishedAt: new Date().toISOString(),
        findings: [],
        skipped,
        totalFiles: total,
        reviewedFiles: accountedPaths.size,
        tokens,
        from: run.from,
        to: run.to,
        mergeBase: preview.mergeBase,
        pr: run.pr,
        prTitle: run.prTitle,
        prHead: run.prHead,
        prBase: run.prBase,
        error:
          `重试后仍然没有给出结论（已用 ${Math.round(tokens / 1000)}k token）。` +
          (lastChildWhy ? `子进程原话：${lastChildWhy}。` : "") +
          "可以换个更便宜的模型，或把范围缩小（少选几个文件 / 换一次提交）再跑。",
        errorCode: "child_no_output",
      });
      return;
    }
    finish({
      status: stopped ? "stopped" : "done",
      finishedAt: new Date().toISOString(),
      findings: merged.findings,
      resolved: merged.resolved,
      resolvedPaths: merged.resolvedPaths,
      skipped,
      totalFiles: total,
      reviewedFiles: accountedPaths.size,
      tokens,
      from: run.from,
      to: run.to,
      mergeBase: preview.mergeBase,
      pr: run.pr,
      prTitle: run.prTitle,
      prHead: run.prHead,
      prBase: run.prBase,
      ...(stopped ? { error: "已停止", errorCode: "stopped" } : {}),
    });
  } catch (err: any) {
    const code = String(err?.code ?? "failed");
    const cancelled = signal.aborted || code === "cancelled";
    finish({
      status: cancelled ? "stopped" : "failed",
      finishedAt: new Date().toISOString(),
      totalFiles: preview?.files.length ?? 0,
      reviewedFiles: 0,
      tokens,
      skipped: preview?.skipped ?? [],
      error: cancelled ? "已停止" : String(err?.message ?? err),
      errorCode: cancelled ? "stopped" : code,
    });
  } finally {
    // 每个子进程在 close 时自己关 stdout（`runChild` 里），这里没有要收拾的。
  }
}

/** 把子进程报的绝对路径折成仓库相对路径（`message` 里的 path 是相对仓库根写的）。 */
function relativeTo(root: string, value: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (path.isAbsolute(text)) {
    const rel = path.relative(root, text);
    return rel.startsWith("..") ? "" : rel.split(path.sep).join("/");
  }
  return text.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// ocr 装没装
// ---------------------------------------------------------------------------

export type OcrStatus = ReviewOcrStatus;

const MIN_OCR_VERSION = [1, 9, 0] as const;

function parseVersion(text: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
}

function olderThan(v: number[], floor: readonly number[]): boolean {
  if (!v.length) return false;
  for (let i = 0; i < floor.length; i += 1) {
    if ((v[i] ?? 0) < floor[i]) return true;
    if ((v[i] ?? 0) > floor[i]) return false;
  }
  return false;
}

/**
 * 探活得给足时间。`ocr` 在 Windows 上不是一个二进制，而是 `node launcher → Go 二进制` 两层
 * （launcher 每 18 分钟还会 detached 拉一次版本检查）。本机实测：裸 exe ~1.2s，走 launcher
 * 冷时 0.4s、2.4s、5.2s、7.0s、**16.3s**——以前只给 5 秒，慢一发就被记成 installed:false，
 * 面板上直接变成「还没装 ocr」（用户明明装着）。
 */
const OCR_PROBE_TIMEOUT_MS = 30_000;
/** 探到了就记一会儿：面板一次打开会问好几遍（WS `review.get` 补帧、HTTP `/api/review/state`）。 */
const OCR_MEMO_MS = 30 * 60_000;

let ocrMemo: { status: OcrStatus; at: number } | null = null;
let ocrInFlight: Promise<OcrStatus> | null = null;

/**
 * 探版本失败怎么记账。**只有「这个命令根本没有」才算没装**；超时、跑崩了都不冒充结论——
 * 把错误原样带回去，让评审本身去报真正的毛病。否则装着 ocr 的人只会看到「装 ocr」。
 */
export function ocrStatusFromFailure(code: string, message: string): OcrStatus {
  if (code === "ocr_missing") return { installed: false, version: "", tooOld: false, error: "missing" };
  // 老到认不出 `--format` 的那种：面板要劝「升」，不是劝「装」。
  if (code === "ocr_too_old") return { installed: true, version: "", tooOld: true, error: "too-old" };
  return { installed: true, version: "", tooOld: false, error: code || message };
}

async function probeOcr(): Promise<OcrStatus> {
  try {
    const { stdout, stderr } = await runOcr(["version"], process.cwd(), OCR_PROBE_TIMEOUT_MS);
    const parts = parseVersion(`${stdout}\n${stderr}`);
    const version = parts.length ? parts.join(".") : "";
    return { installed: true, version, tooOld: olderThan(parts, MIN_OCR_VERSION), error: "" };
  } catch (err: any) {
    return ocrStatusFromFailure(String(err?.code ?? "failed"), String(err?.message ?? err));
  }
}

/**
 * 面板打开时问一句就够了；不要放到每次刷新里（一次 spawn 几十毫秒到几秒）。
 * `refresh` 用于「刚装完」这种必须重新看一眼的场合。
 */
export async function ocrStatus(opts: { refresh?: boolean } = {}): Promise<OcrStatus> {
  if (!opts.refresh && ocrMemo && Date.now() - ocrMemo.at < OCR_MEMO_MS) return ocrMemo.status;
  // 并发问（面板一次打开会同时走 WS 和 HTTP）只许 spawn 一个：多开一份冷启动，谁都更容易超时。
  if (ocrInFlight) return ocrInFlight;
  ocrInFlight = probeOcr()
    .then((status) => {
      // 只记正的：没装的人点完「装 ocr」要能立刻看到结果，别让缓存把「没装」焊死。
      ocrMemo = status.installed ? { status, at: Date.now() } : null;
      return status;
    })
    .finally(() => {
      ocrInFlight = null;
    });
  return ocrInFlight;
}

/** 面板上那颗「装 ocr」：把 npm 的输出一行行流回去，装完由页面重拉状态。 */
export function installOcr(onLine: (line: string) => void): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const child = spawn(win ? "npm.cmd" : "npm", ["i", "-g", "@alibaba-group/open-code-review"], {
      // npm 在 Windows 上是 `npm.cmd`：Node ≥ 18.20 拒绝不带 shell 去跑 `.cmd`。参数是常量，走 shell 没有注入面。
      shell: win,
      env: piChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    const feed = (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        tail = (tail + "\n" + text).slice(-2000);
        onLine(text.slice(0, 400));
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => feed(d));
    child.stderr?.on("data", (d: string) => feed(d));
    child.on("error", (err) => resolve({ ok: false, error: err?.message ?? String(err) }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true, error: "" } : { ok: false, error: firstLine(tail) || `npm 退出码 ${code}` }));
  });
}

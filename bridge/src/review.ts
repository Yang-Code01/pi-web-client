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
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { ensureDir, piChildEnv, quarantineStateFile, readJsonChecked, stateDir, statePath } from "./paths.ts";
import { resolvePi } from "./pi.ts";
import { localRepoName, resolvePullRequest } from "./gitpr.ts";
import { isCommitSha, tipTargetOf } from "./frames.ts";
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
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
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
/** 自动评审的轮次另算一份预算：够它自己回头翻几轮，又不至于无限长。 */
export const AUTO_RUN_KEEP = 40;

/**
 * 把历史截到 `RUN_KEEP` 条（新的留下）。只该在「加了一条新记录」后调（`startReview()`）。
 * 不要接到 `writeReviewState()` 上：标一条意见、改一次 pick 也走写盘，在那里截会把用户
 * 正点开看着的那一条截掉。
 */
export function trimRuns(state: ReviewState): void {
  // D457：自动评审的轮次与手动开的那几条各算一份预算 —— 一次自动评审 4–12 轮，
  // 挤同一个 RUN_KEEP 会把用户手动评过的历史刷掉一半。
  const manual = state.runs.filter((r) => !r.auto);
  const auto = state.runs.filter((r) => r.auto);
  const keepManual = manual.slice(-RUN_KEEP);
  const keepAuto = auto.slice(-AUTO_RUN_KEEP);
  const keep = new Set([...keepManual, ...keepAuto]);
  state.runs = state.runs.filter((r) => keep.has(r));
}

// ---------------------------------------------------------------------------
// 过时（#741）：完成态的评审记录对着「现在的 tip」核一遍
// ---------------------------------------------------------------------------

/** 一次面板打开最多核对几个 PR：每个 PR 一次 `ls-remote` 网络往返，历史再多也不该拖住面板。 */
export const TIP_PR_LIMIT = 3;

/** 一条要核对的记录：核对谁（`ref`）、走哪条路（`pr > 0` 才要网络）、以及 `HEAD` 当时在哪条分支。 */
export interface TipTarget {
  /** `ReviewState.tips` 的键，也是记录里的 `to`：`HEAD` / `feat/x` / `refs/pi-web/pr-N`。 */
  ref: string;
  /** PR 号（0 = 本地分支：`git rev-parse` 就够，不碰网络）。 */
  pr: number;
  /** 记录里的 `headRef`（只有 `to` 是 `HEAD` 的记录才有）：评的时候 HEAD 在哪条分支上。 */
  headRef?: string;
}

/**
 * 该核对 tip 的记录，新的在前、按 ref 去重（同一个分支评过两次，核对一次就够）。
 *
 * 「哪条记录该核」的判据在 `frames.ts` 的 `tipTargetOf()`：页面也 import 同一份，
 * 两边不许各写一遍（判据一旦漂成两份，表现就是「桥核了、页面不标」这种静默的错）。
 */
export function tipTargets(runs: readonly ReviewRun[]): TipTarget[] {
  const picked: { target: TipTarget; at: number }[] = [];
  for (const run of runs ?? []) {
    const target = tipTargetOf(run);
    if (target) picked.push({ target: { ...target, headRef: str(run.headRef) }, at: Date.parse(run.startedAt ?? "") || 0 });
  }
  picked.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const out: TipTarget[] = [];
  for (const item of picked) {
    if (seen.has(item.target.ref)) continue;
    seen.add(item.target.ref);
    out.push(item.target);
  }
  return out;
}

/** 从要核对的那批里挑出远端那批：按 PR 号去重（留最新那条的 ref），最多 `TIP_PR_LIMIT` 个。 */
export function remoteTipTargets(targets: readonly TipTarget[]): TipTarget[] {
  const seen = new Set<number>();
  const out: TipTarget[] = [];
  for (const item of targets ?? []) {
    if (item.pr <= 0 || seen.has(item.pr)) continue;
    seen.add(item.pr);
    out.push(item);
    if (out.length >= TIP_PR_LIMIT) break;
  }
  return out;
}

/** 一份 tips 快照：`tips` 是 key→sha，`at` 是**这份值**是什么时候问到的（0 = 不知道）。 */
export interface TipSet {
  tips: Record<string, string>;
  at: number;
}

/**
 * 本地那半：`git rev-parse` 一下就有，离线可用。
 *
 * 判的是**本地** ref（不是远端）：`range` 重评读的就是本地 target，所以「本地没变」= 再评一次
 * 结果一样，不该点亮那颗标（Q10）。`revParse` 认不出这个 ref（分支被删了）就不给 key。
 *
 * `HEAD` 那条要不要采信「得看是哪条分支」—— 但这是**每条记录**的事（同一个 `HEAD` 底下可能
 * 躺着好几条别的分支留下来的记录），所以判断在 `frames.ts` 的 `tipForRun()` 里按记录做，
 * 这里只管回答「`HEAD` 现在指向哪个提交」。分支名随帧发下去（`tipsBranch`）。
 */
export async function localTips(
  runs: readonly ReviewRun[],
  revParse: (ref: string) => Promise<string>,
): Promise<TipSet> {
  const wanted = tipTargets(runs).filter((item) => item.pr <= 0);
  // 各 ref 互不相干：并行问，别让 N 个 ref 串成一串（每个上限 5 秒）。
  const answers = await Promise.all(wanted.map((item) => revParse(item.ref).catch(() => "")));
  const out: Record<string, string> = {};
  wanted.forEach((item, i) => {
    // 校验形状再写：注入进来的东西（测试 / 换个实现）也一样不许把带换行的一坨当成 sha。
    const sha = str(answers[i]);
    if (isCommitSha(sha)) out[item.ref] = sha;
  });
  return { tips: out, at: Date.now() };
}

/**
 * 收尾时给这条记录补的「评到了哪里」（#741）：被评的提交；`to` 是 `HEAD` 时再加「当时那条分支」。
 *
 * 取不到（ref 被删 / 不是仓库 / 分离头指针）就不写那一项 —— 面板宁可不说，也不编一个值。
 * 依赖是注入的：这是本票最容易悄悄错的一处（记错了就天天误报），得能单测。
 */
export async function headStamp(
  run: Pick<ReviewRun, "to">,
  deps: { shaOf: (ref: string) => Promise<string>; branch: () => Promise<string> },
): Promise<Partial<Pick<ReviewRun, "headSha" | "headRef">>> {
  const ref = str(run.to);
  const out: Partial<Pick<ReviewRun, "headSha" | "headRef">> = {};
  const sha = ref ? str(await deps.shaOf(ref)) : "";
  if (sha) out.headSha = sha;
  if (isHeadName(ref)) {
    const branch = str(await deps.branch());
    if (branch) out.headRef = branch;
  }
  return out;
}

/**
 * `headStamp()` 的兜底版本：**记不上就不记**。
 *
 * 这条跑在评审收尾那一刻，而收尾外面套着一个 `catch`（它会把状态改写成 `failed`）：
 * 补一条元数据时抛异常，一次**已经完成**的评审就会被重写成失败、真实结果一起丢掉。
 * 少记一项的代价只是面板上少一颗标。
 */
export async function safeHeadStamp(
  run: Pick<ReviewRun, "to">,
  deps: { shaOf: (ref: string) => Promise<string>; branch: () => Promise<string> },
): Promise<Partial<Pick<ReviewRun, "headSha" | "headRef">>> {
  try {
    return await headStamp(run, deps);
  } catch {
    return {};
  }
}

/** `ref` 是不是那个会随风漂的 `HEAD`（`HEAD` / `head` 都算，写进来的是 ocr 回显的原文）。 */
export const isHeadName = (ref: string): boolean => str(ref).toUpperCase() === "HEAD";

/**
 * 远端那半（`pr` 模式）：一次 `ls-remote` 拿一批。「远端没答」与「远端答了但失败」都**不给 key** ——
 * 缺 key 是「不知道」，空串会变成「没变」。
 */
export async function remoteTips(
  runs: readonly ReviewRun[],
  lsRemote: (prs: number[]) => Promise<{ heads: Record<number, string>; at: number }>,
): Promise<TipSet> {
  const picked = remoteTipTargets(tipTargets(runs));
  if (!picked.length) return { tips: {}, at: 0 };
  let answer: { heads: Record<number, string>; at: number } = { heads: {}, at: 0 };
  try {
    answer = (await lsRemote(picked.map((item) => item.pr))) ?? { heads: {}, at: 0 };
  } catch {
    // 超时 / 没网 / 没登录：一条 key 都不给，界面就不标（宁可不说，不能说错）。
    return { tips: {}, at: 0 };
  }
  const out: Record<string, string> = {};
  for (const item of picked) {
    const sha = str(answer.heads[item.pr]);
    if (isCommitSha(sha)) out[item.ref] = sha;
  }
  return { tips: out, at: Object.keys(out).length ? Number(answer.at) || 0 : 0 };
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

/** 一个会话最多同时在评几条（D420）。数的是**会话**，不是仓库：换个仓库也共用这份额度。 */
export const MAX_RUNS_PER_SESSION = 2;

/** 面板轮询/广播的那个「现在到哪了」。 */
export type Progress = ReviewProgress;

/**
 * 一次评审交给独立进程时带的全部输入。
 *
 * **不许**把 `ghEnv` / 回调放进来：这份东西要落盘（`review/jobs/<runId>.json`），
 * 界面选的 GitHub 令牌只从 spawn 时的环境变量传下去。
 */
export interface ReviewJobOpts {
  mode: ReviewMode;
  base?: string;
  target?: string;
  commit?: string;
  pr?: number;
  model?: string;
  provider?: string;
  lang: ReviewLang;
  /** D457：这是自动评审的一轮（不画进记录列表、单独算留存预算）。 */
  auto?: boolean;
}

/**
 * 换脑之后新脑靠这份文件认回「还在跑的评审」。
 *
 * 评审以前跑在脑里：换脑 = 老脑 exit，正在跑的 OCR / pi 子进程连同内存里的 findings 一起没了。
 * 现在执行进程是 detached 的，脑只是转发进度；这份文件是两边唯一的契约。
 */
export interface ReviewJob {
  runId: string;
  repo: string;
  session: string;
  /** 与盘上 `ReviewRun.startedAt` 对齐：pid 会被系统复用，同一次评审才对得上。 */
  startedAt: string;
  opts: ReviewJobOpts;
  /** 执行进程的 pid。脑 spawn 之后补写；测试注入的 launch 没有。 */
  pid?: number;
}

export function reviewJobsDir(): string {
  return path.join(reviewDir(), "jobs");
}

export function reviewJobFile(runId: string): string {
  return path.join(reviewJobsDir(), `${runId}.json`);
}

export function reviewProgressFile(runId: string): string {
  return path.join(reviewJobsDir(), `${runId}.progress.json`);
}

export function reviewCancelFile(runId: string): string {
  return path.join(reviewJobsDir(), `${runId}.cancel`);
}

/** worker 每 5 秒写一次的心跳：pid 会被系统复用，只有这份文件能证明它还是那个 worker。 */
function reviewBeatFile(runId: string): string {
  return path.join(reviewJobsDir(), `${runId}.beat`);
}

function reviewLogFile(runId: string): string {
  return path.join(reviewJobsDir(), `${runId}.log`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const MODES = new Set<ReviewMode>(["workspace", "range", "commit", "pr"]);
const MARKS = new Set<ReviewMark>(["accept", "ignore", "false-positive"]);
const PLAN_STATES = new Set<ReviewGroupPlan["state"]>(["pending", "running", "done", "failed"]);

/** job 里的 opts 来自盘上，不能直接 `as ReviewJobOpts`：至少 mode/lang 得是认识的枚举值。 */
function readJobOpts(raw: unknown): ReviewJobOpts | null {
  if (!isRecord(raw)) return null;
  const mode = str(raw.mode);
  const lang = str(raw.lang);
  if (!MODES.has(mode as ReviewMode) || !Object.prototype.hasOwnProperty.call(LANG_NAME, lang)) return null;
  const pr = Number(raw.pr);
  return {
    mode: mode as ReviewMode,
    lang: lang as ReviewLang,
    base: str(raw.base) || undefined,
    target: str(raw.target) || undefined,
    commit: str(raw.commit) || undefined,
    pr: Number.isInteger(pr) && pr > 0 ? pr : undefined,
    model: str(raw.model) || undefined,
    provider: str(raw.provider) || undefined,
  };
}

function readReviewJob(file: string): ReviewJob | null {
  try {
    // JSON.parse 的返回类型是 any；这里先当 unknown，逐字段校验后再收窄，别把盘上的任意形状当契约。
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(raw)) return null;
    const runId = str(raw.runId);
    const repo = str(raw.repo);
    // session 允许空串（未选会话的本地评审），repo/runId 则必须有内容；两种判法不同是故意的。
    const session = typeof raw.session === "string" ? raw.session : null;
    const opts = readJobOpts(raw.opts);
    const startedAt = str(raw.startedAt);
    const pid = Number(raw.pid);
    if (!runId || !repo || session === null || !opts || !startedAt) return null;
    return {
      runId,
      repo,
      session,
      startedAt,
      opts,
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    };
  } catch {
    return null;
  }
}

/** worker 启动到写回 pid 之间的窗口：这段时间没有 pid 不能当成「已经死了」。
 *  60 秒覆盖了换脑观察期（30s HELLO）+ 新脑启动；worker 一跑起来就会写心跳接管判断。 */
const WORKER_START_GRACE_MS = 60_000;
/** 有 pid 之后 worker 该立刻写第一份心跳；只给极慢文件系统留一个很短的窗口，
 *  不能沿用 60 秒 —— worker 被 SIGKILL 后没心跳，60 秒内会被当成还在跑。 */
const WORKER_PID_GRACE_MS = 15_000;
/** 心跳间隔与过期阈值。30 秒足够跨过一次脑崩溃 / 换脑，又不会让复用的 pid 一直冒充 worker。 */
const WORKER_BEAT_MS = 5_000;
const WORKER_BEAT_STALE_MS = 30_000;

/** 这个 pid 还活着吗。Windows 上 `taskkill` / `process.kill(pid, 0)` 都认这一条。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 进程存在但不属于我们（EPERM）也算活着：真正去杀的时候会再失败一次，别在这里误判成「已经没了」。
    const code = isRecord(err) ? err.code : "";
    return code === "EPERM";
  }
}

export function reviewJobAlive(job: ReviewJob | null | undefined): boolean {
  return pidAlive(Number(job?.pid ?? 0));
}

/**
 * worker 每 5 秒写一次心跳。`startedAt` 用来对同一次评审，避免 pid 被复用时把无关进程
 * （或者上一轮的 worker）当成这条评审的执行进程。
 */
function readBeatFile(runId: string): { at: number; pid: number; startedAt: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(reviewBeatFile(runId), "utf8")) as unknown;
    if (!isRecord(raw)) return null;
    const at = Number(raw.at);
    const pid = Number(raw.pid);
    const startedAt = str(raw.startedAt);
    if (!Number.isFinite(at) || !Number.isInteger(pid) || pid <= 0 || !startedAt) return null;
    return { at, pid, startedAt };
  } catch {
    return null;
  }
}

/**
 * 这个 pid 现在还是不是**这次评审**的 worker？只靠 `process.kill(pid, 0)` 不够：
 * worker 在脑不在时退出后，pid 会被系统复用，sweep / resume 会把无关进程当成评审还活着。
 * 有心跳就以心跳为准；引擎刚起、还没来得及写第一份心跳时，才给启动宽限。
 */
function reviewJobRunning(job: ReviewJob | null | undefined): boolean {
  if (!job || !reviewJobAlive(job)) return false;
  const beat = readBeatFile(job.runId);
  if (beat) {
    return beat.pid === Number(job.pid) && beat.startedAt === job.startedAt && Date.now() - beat.at < WORKER_BEAT_STALE_MS;
  }
  const started = Date.parse(job.startedAt);
  const grace = job.pid ? WORKER_PID_GRACE_MS : WORKER_START_GRACE_MS;
  return Number.isFinite(started) && Date.now() - started < grace;
}

/**
 * 刚 spawn、pid 还没写回文件。换脑如果正好卡在这一瞬，不能把仍在启动的 worker 判死：
 * 新脑开机 sweep 会把 run 标成「桥重启」，worker 随后读到非 running 就直接退了。
 */
function workerStarting(job: ReviewJob | null | undefined): boolean {
  if (!job || job.pid) return false;
  const started = Date.parse(job.startedAt);
  return Number.isFinite(started) && Date.now() - started < WORKER_START_GRACE_MS;
}

/** 心跳能不能单独证明这条 review 还活着：job 文件读不出来（写到一半/杀软占用）时也得能查。 */
function beatProvesLive(runId: string, startedAt = ""): boolean {
  const beat = readBeatFile(runId);
  if (!beat) return false;
  if (startedAt && beat.startedAt !== startedAt) return false;
  if (Date.now() - beat.at >= WORKER_BEAT_STALE_MS) return false;
  return pidAlive(beat.pid);
}

/** worker 已经写了心跳、job 里却还没有 pid（脑在 spawn 后写 pid 前被杀）：用心跳把 pid 补回来。 */
function adoptBeatPid(job: ReviewJob): void {
  if (job.pid) return;
  const beat = readBeatFile(job.runId);
  if (!beat || beat.startedAt !== job.startedAt || Date.now() - beat.at >= WORKER_BEAT_STALE_MS) return;
  if (pidAlive(beat.pid)) job.pid = beat.pid;
}

/** 盘上那次评审的执行进程还活着吗（按 runId + startedAt + 心跳对，防 pid 复用）。 */
function liveJobForRun(runId: string, startedAt = ""): ReviewJob | null {
  const job = readReviewJob(reviewJobFile(runId));
  if (!job) return null;
  if (startedAt && job.startedAt && job.startedAt !== startedAt) return null;
  adoptBeatPid(job);
  if (reviewJobRunning(job) || workerStarting(job)) return job;
  return null;
}

/** 桥起来之后接一次：换脑重连的评审也走这同一对回调发帧。 */
export interface ReviewNotify {
  onProgress?: (job: ReviewJob, progress: Progress) => void;
  onState?: (job: ReviewJob) => void;
  /**
   * D453：「这个会话在跑几条评审」变了（起跑、收尾、取消收尾、接回、整组停机）。
   * 页面拿它改会话徽标（`评审中` / `评审中 2`），所以要在**每一处**增删在跑集合之后喊一次。
   */
  onActive?: (session: string) => void;
}

let notify: ReviewNotify = {};

export function setReviewNotify(next: ReviewNotify): void {
  notify = next;
}

/**
 * 测试用的统一注入点：`review-unit` 只考额度 / 判重 / 停止这些登记逻辑，
 * 生产不调它，默认仍然起独立进程。
 */
let launcher: ((job: ReviewJob) => void) | null = null;

export function setReviewLauncher(fn: ((job: ReviewJob) => void) | null): void {
  launcher = fn;
}

interface Active {
  cancel: () => void;
  /** 这条属于谁：判重与额度都按「会话」算，停止时还要核对是不是这一个仓库。 */
  repo: string;
  session: string;
  mode: ReviewMode;
  /** pr 模式下现在正在评的号（判重靠它）；其它模式是 0。 */
  pr: number;
  /** 用户已经请求取消：worker 死后要收成 stopped，不能记成 worker-lost。 */
  cancelRequested?: boolean;
  /** 独立执行进程；测试注入的 launch 没有。 */
  job?: ReviewJob;
}

/** 主键是 runId：同一个会话可以同时跑两条（D420），插入顺序就是开跑顺序。 */
const active = new Map<string, Active>();
const progressMap = new Map<string, Progress>();

/**
 * 在跑集合的唯一两个入口（D453）：额度、进度、徽标都以这份集合为准，
 * 所以「变了几条」只在这里喊一次 `notify.onActive` —— 别在调用处各写一份判断。
 */
function trackActive(runId: string, item: Active): void {
  active.set(runId, item);
  notify.onActive?.(item.session);
}

function untrackActive(runId: string): void {
  const removed = active.get(runId);
  if (!removed) return;
  active.delete(runId);
  notify.onActive?.(removed.session);
}

/** 这个会话现在在跑的几条（跨仓库共用额度）。 */
function runningFor(session: string): Array<[string, Active]> {
  const want = sessionKey(session);
  return [...active].filter(([, a]) => sessionKey(a.session) === want);
}

/**
 * D453：这个会话此刻在跑几条**评审记录**（0–2）。会话徽标「评审中」读它，
 * 快照与单会话状态帧都从这一个函数取，页面不自己从进度帧攒一份。
 */
export function reviewRunningCount(session: string): number {
  return runningFor(session).length;
}

/** 某个仓库 + 会话现在在跑的那几条的进度（页面按 runId 分别画）。 */
export function reviewProgresses(repo: string, session = ""): Progress[] {
  const wantRepo = repoKey(repo);
  const wantSession = sessionKey(session);
  const out: Progress[] = [];
  for (const [id, a] of active) {
    if (repoKey(a.repo) !== wantRepo || sessionKey(a.session) !== wantSession) continue;
    const progress = progressMap.get(id);
    if (progress) out.push(progress);
  }
  return out;
}

/**
 * 开机扫出来的那条提示要随下一次 `review.get` 交给页面（boot 时还没有客户端连着）。
 * 取一次就清零，别让第二条消息再提示一遍。
 */
let sweptCount = 0;

export function takeSweptCount(): number {
  const n = sweptCount;
  sweptCount = 0;
  return n;
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
      let hits = 0;
      for (const run of raw.runs ?? []) {
        if (run.status !== "running") continue;
        // 换脑时老脑退出，但评审执行进程是 detached 的：它还在跑就别把记录标成失效，
        // 新脑随后会把进度接回来（resumeReviewJobs）。只有真的没进程了才收尾。
        // job 文件读不出来时（写到一半 / 杀软占用）心跳还能单独证明 worker 活着。
        if (liveJobForRun(run.id, run.startedAt) || beatProvesLive(run.id, run.startedAt)) continue;
        run.status = "stale";
        run.errorCode = "bridge-restart";
        run.error = "桥重启了，这次评审没跑完";
        dirty = true;
        hits += 1; // 按「条」数：一个文件里可能同时躺着两条（D420）
      }
      if (!dirty) continue;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      changed += hits;
      sweptCount += hits;
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

/** 这几个 git 查询一次最多等多久（面板在等人看，卡住比答不出更难受）。 */
const TIP_GIT_TIMEOUT_MS = 5_000;

/** 跑一条 git，拿到 stdout 的第一行（失败 / 超时 → 空串）。**异步**：不许卡住消息主循环。 */
function gitOut(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      { encoding: "utf8", timeout: TIP_GIT_TIMEOUT_MS, windowsHide: true },
      (err: any, stdout: any) => resolve(err ? "" : String(stdout ?? "").trim()),
    );
  });
}

/**
 * 某个 ref 此刻指向哪个提交（认不出 / 不是仓库 → 空串）。
 *
 * 只读、不 fetch、不动任何 ref：过时判定只能基于本地看得见的东西（#741）。
 * 走异步 `execFile`：`review.get` 在 WebSocket 的消息主循环上，这里同步一次就是把所有
 * 会话的帧一起卡住（历史里不同分支多的话还会串成 N 次）。
 */
export async function gitShaOf(dir: string, ref: string): Promise<string> {
  const name = str(ref);
  if (!name) return "";
  const out = await gitOut(dir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  return isCommitSha(out) ? out : "";
}

/**
 * 现在 HEAD 在哪条分支上（分离头指针时给空串）。
 *
 * 只给「`to` 是 `HEAD` 的记录」记一份：见 `ReviewRun.headRef` 与 `localTips()`。
 * 分离头指针时给空串是**故意**的 —— 那时没有分支名可比，退回「照旧比 sha」比编一个名字好。
 */
export async function gitBranchOf(dir: string): Promise<string> {
  const out = await gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out && out !== "HEAD" ? out : "";
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

export interface ChildEvent {
  /** 助手这轮答的话（非助手消息没有）。 */
  text?: string;
  /** 这条消息的用量（有 `usage.totalTokens` 才有；0 与「没有」对调用方是一回事：加 0）。 */
  tokens?: number;
  /** pi 替 provider 转达的原话：`stopReason: "error"` 时才有（连不上 / 401 / 限流…）。 */
  error?: string;
}

/** `--mode json` 里我们读的那一小块。其余字段不声明 —— 别让这个类型跟着 pi 的 JSON 走。 */
export interface ChildEventLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: { totalTokens?: unknown };
    stopReason?: string;
    errorMessage?: unknown;
  };
}

/** 一条消息的正文：只拼 `{ type: "text" }` 块（thinking / tool 块不算「回答」）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text") parts.push(String(b.text ?? ""));
  }
  return parts.join("");
}

/**
 * 一行 `--mode json` 事件里外层关心的三样东西。
 *
 * 关键是 `error`：真机那次网关掉线，子进程退出码 0、37 行事件、0 token，外面只剩「输出 37 行」——
 * 而真正的原因（`connect EHOSTDOWN 192.168.31.36:7863`）就在 assistant 那条 `message_end` 的
 * `errorMessage` 里，以前谁也没读它（D454）。
 */
export function readChildEvent(ev: ChildEventLine | null | undefined): ChildEvent {
  if (ev?.type !== "message_end") return {};
  const msg = ev.message;
  const out: ChildEvent = {};
  const total = msg?.usage?.totalTokens;
  if (typeof total === "number") out.tokens = total;
  if (msg?.role !== "assistant") return out;
  if (msg.stopReason === "error") {
    const why = String(msg.errorMessage ?? "").trim();
    if (why) out.error = why;
  }
  const text = textOf(msg.content);
  if (text.trim()) out.text = text;
  return out;
}

/** 一次评审子进程跑下来的结果（`runChild` 交回来的就是它）。 */
export interface ChildResult {
  code: number | null;
  text: string;
  stderr: string;
  aborted: boolean;
  touched: Set<string>;
  tokens: number;
  lines: number;
  silent: boolean;
  /** pi 替 provider 转达的原话（`stopReason: "error"` 的 errorMessage），没有就是空串。 */
  error: string;
}

/**
 * 「子进程一句话没答」的原因：它自己报的错最有用（`stopReason: "error"` 的 errorMessage，
 * 比如 `connect EHOSTDOWN 192.168.31.36:7863`），其次沉默超时，最后才是「退出码 0、输出 N 行」。
 * 最后那条对定位几乎没用：正常的子进程也是三四十行、也是退出码 0（D454）。
 */
export function childWhy(res: Partial<ChildResult>): string {
  const own = String(res.error ?? "").trim();
  if (own) return own;
  if (res.silent) return "90 秒没有任何输出";
  return firstLine(String(res.stderr ?? "")) || `退出码 ${res.code ?? "-"}、输出 ${res.lines ?? 0} 行`;
}

/**
 * 原话可能是一整段上游响应（含内网地址、请求 id、甚至回显的头部）：用户要的是线索，不是搬运。
 * 截断放在「拼进给人看的文案」这一步，子进程交上来的原话本身不丢。
 */
export function clip(text: string, max = 300): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 「来源整个连不上」的原话 —— 只收**建立连接那一步**的失败：解析不到、路由不到、连接被拒、
 * 连接超时。这几种跟评什么文件无关，下一组只会撞同一堵墙。
 *
 * **不收**只属于单次请求的瞬时故障：`ECONNRESET`（流被重置）、`EPIPE`（对端先关）、裸的
 * `ETIMEDOUT`（一次读超时）、`connection reset by peer`、`Headers Timeout` —— 这些重试一次
 * 往往就过去了，跟 429 同一类，走重试那条路（D454 三轮评审意见 1）。
 *
 * 也不用 `network` / `socket` / `proxy` 这类宽泛词：会命中 `Invalid connection header`
 * 这种与网络无关的 provider 报错。
 */
const UNREACHABLE =
  /\b(EHOSTDOWN|EHOSTUNREACH|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN)\b|\bconnect (ETIMEDOUT|ECONNRESET|EPIPE)\b|Connect Timeout|getaddrinfo/i;

/** 这条原话是不是「来源整个连不上」。既决定文案，也决定要不要继续跑剩下的组。 */
export function unreachable(why: string): boolean {
  return UNREACHABLE.test(String(why ?? ""));
}

/** 「一次都没给出结论」的失败文案（有子进程原话时以它为准）。 */
export function noOutputMessage(why: string, tokens: number): string {
  const own = String(why ?? "").trim();
  // 这个数是**整轮**（含答出来的组）的累计用量：写清楚是「本次共用」，别让人当成这一组烧掉的（D454 意见 3）。
  const used = `本次共用 ${Math.round(tokens / 1000)}k token`;
  if (own && unreachable(own)) {
    return (
      `模型那边没连上：${clip(own)}。` +
      "这跟评审范围和模型贵不贵都无关 —— 先确认这个来源通不通（网关 / 网络 / 凭据），换个来源也能先跑起来。"
    );
  }
  if (own) return `重试后仍然没有给出结论（${used}）。子进程原话：${clip(own)}。可以换个模型或来源，或把范围缩小（少选几个文件 / 换一次提交）再跑。`;
  return `重试后仍然没有给出结论（${used}）。可以换个模型或来源，或把范围缩小（少选几个文件 / 换一次提交）再跑。`;
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
  /**
   * 这个会话选的 GitHub 账号（`{ GH_TOKEN }`，由 `github.ts` 的 `sessionGhAccount()` 算好）。
   * 不传就沿用桥自己的环境 —— 也就是 gh 的机器 active 账号（多账号机器上经常不是同一个）。
   */
  ghEnv?: NodeJS.ProcessEnv;
  model?: string;
  provider?: string;
  lang: ReviewLang;
  /** D457：这是自动评审的一轮（不画进记录列表，留存另算一份预算）。 */
  auto?: boolean;
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
  const running = runningFor(session);
  const prNumber = Number(o.pr) || 0;

  // D420：同一个号在本会话里正在评，就别再开一条 —— 同一份 diff 白烧一遍 token。
  // 判在 fetch 之前，跟上面那道闸同一个理由。
  if (prNumber > 0) {
    const same = running.find(([, a]) => a.mode === "pr" && a.pr === prNumber && repoKey(a.repo) === repoKey(root));
    if (same) throw new ReviewError("dup_pr", `这个会话已经在评 #${prNumber} 了`, { p1: String(prNumber) });
  }
  // 额度按会话算：另一个会话、另一条 PR 都还能开，但同一个会话最多两条同时在跑。
  if (running.length >= MAX_RUNS_PER_SESSION) {
    throw new ReviewError("busy", `这个会话已经有 ${MAX_RUNS_PER_SESSION} 个在评了，先停一个再开`, {
      p1: String(MAX_RUNS_PER_SESSION),
    });
  }

  const state = readReviewState(root, session);
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const run: ReviewRun = {
    id: runId,
    mode: o.mode,
    from: o.base ?? "",
    to: o.mode === "commit" ? o.commit ?? "HEAD" : "HEAD",
    mergeBase: "",
    pr: o.mode === "pr" ? prNumber : 0,
    prTitle: "",
    prHead: "",
    prBase: "",
    status: "running",
    startedAt,
    finishedAt: "",
    ...(o.auto ? { auto: true } : {}),
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

  const opts: ReviewJobOpts = {
    mode: o.mode,
    base: o.base ?? "",
    target: o.target ?? "",
    commit: o.commit ?? "",
    pr: prNumber,
    model: o.model ?? "",
    provider: o.provider ?? "",
    lang: o.lang,
  };
  const job: ReviewJob = { runId, repo: root, session, startedAt, opts };
  // 先把「刚开始」那份进度落盘：worker 起来之前页面就能画出来，worker 起来之后接着这份写。
  const seeded: Progress = {
    ...freshProgress(job),
    log: [{ at: Date.now(), text: startText(opts) }],
  };
  progressMap.set(runId, seeded);
  writeJsonAtomic(reviewJobFile(runId), job);
  writeJsonAtomic(reviewProgressFile(runId), seeded);

  trackActive(runId, {
    cancel: () => requestCancel(job),
    repo: root,
    session,
    mode: o.mode,
    pr: prNumber,
    job,
  });
  notify.onProgress?.(job, seeded);
  notify.onState?.(job);

  try {
    if (launcher) launcher(job);
    else spawnReviewWorker(job, o.ghEnv);
  } catch (err) {
    // 进程没起来（node 不可执行 / spawn 失败）：当场收尾，别让面板一直转圈等一个不存在的 worker。
    markWorkerSpawnFailed(job, err);
  }
  // 注入 launcher 的测试没有真正的 worker，起 ticker 只会在宽限结束后把测试记录改成 stale。
  if (!launcher) ensureReviewTicker();

  return { runId, repo: root };
}

/**
 * 停一条（D420）。给了 `runId` 就只停那一条，并要求它确实属于这个仓库 + 会话；
 * 不给则停这个仓库 + 会话下所有在跑的（老页面只发 dir+session，语义不变）。
 * 这里**不**把记录移出 `active`：子进程还可能在退出的路上（fetch 甚至不认 abort），
 * 额度与同号查重等它真正收尾（execute 的 finally）再放开 —— 否则同一份 diff
 * 会有两个进程一起烧 token。页面那边本来也要等记录变成「已停止」才解锁。
 */
export function cancelReview(dir: string, session = "", runId = ""): boolean {
  const wantRepo = repoKey(dir);
  const wantSession = sessionKey(session);
  const owns = (a: Active) => repoKey(a.repo) === wantRepo && sessionKey(a.session) === wantSession;
  if (runId) {
    const one = active.get(runId);
    if (!one || !owns(one)) return false;
    one.cancel();
    return true;
  }
  let stopped = false;
  for (const a of active.values()) {
    if (!owns(a)) continue;
    a.cancel();
    stopped = true;
  }
  return stopped;
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
  /** 这份进度现在在哪：worker 里是自己的内存副本，脑里是 progressMap。 */
  getProgress?: () => Progress | undefined;
}

async function execute(ctx: ExecuteCtx): Promise<void> {
  const { root, session, run, opts, signal, emit, note } = ctx;
  const runId = run.id;
  let tokens = 0;
  let currentFile = "";
  let preview: Preview | null = null;

  const finish = async (patch: Pick<ReviewRun, "status"> & Partial<ReviewRun>) => {
    // #741：记下「这一次评到了哪里」（被评的提交，`HEAD` 时还有当时那条分支）。
    // 只给 done 记：`tipTargetOf()` 对失败 / 停止的那几条本来就返回 null。
    // **读盘之前**先算完：这个 await 之后才读→写，中间不留窗口，别把别人刚标的一条盖回去。
    if (patch.status === "done") {
      Object.assign(patch, await safeHeadStamp(run, { shaOf: (ref) => gitShaOf(root, ref), branch: () => gitBranchOf(root) }));
    }
    const state = readReviewState(root, session);
    const onDisk = state.runs.find((r) => r.id === run.id);
    // 先把最后一行写进时间线，再连同日志一起落盘（顺序反了，日志就永远追不上这次写盘）。
    if (patch.status === "done") note(`完成：${patch.findings?.length ?? 0} 条意见`);
    else if (patch.status === "failed") note(`失败：${patch.error || patch.errorCode || ""}`);
    else if (patch.status === "stopped") note("已停止");
    // 完成态要清掉上一轮可能留下的 errorCode：ticker 收尾时会把 run.errorCode 原样带出去。
    if (patch.status === "done") {
      patch.error = "";
      patch.errorCode = "";
    }
    const prevProgress = ctx.getProgress?.() ?? progressMap.get(runId);
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
    // 生产路径的 execute 只跑在 worker 里，worker 的 progressMap 为空；脑侧由 tickOneReview
    // 自己删。这里保留删除只会让人误以为脑里还有一份。
  };

  /** 起一个子进程评一组：边跑边发进度，结束时把它答的那段话交回来。 */
  const runChild = (prompt: string) =>
    new Promise<ChildResult>((resolve) => {
      const pi = resolvePi();
      const proc = spawn(process.execPath, [pi.cli, ...reviewArgs({ model: opts.model, provider: opts.provider })], {
        cwd: root,
        env: piChildEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      let text = "";
      // 子进程自己报的错（`stopReason: "error"` 的 `errorMessage`）：网关连不上 / 401 / 限流…
      // 以前这里丢掉了它，于是面板只能说「退出码 0、输出 37 行」——把网络故障说成了模型问题（D454）。
      let childError = "";
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
        resolve({ code, text, stderr, aborted: signal.aborted, touched, tokens: localTokens, lines: outLines, silent, error: childError });
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
          const got = readChildEvent(ev);
          if (typeof got.tokens === "number") {
            tokens += got.tokens;
            localTokens += got.tokens;
          }
          if (got.text) text = got.text;
          if (got.error) childError = got.error;
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
      const resolved = await resolvePullRequest(root, Number(opts.pr) || 0, (line) => emit({ currentFile: line } as Partial<Progress>), {
        env: opts.ghEnv,
      });
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
      await finish({ status: "done", finishedAt: new Date().toISOString(), skipped: preview.skipped });
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
    let lastChildWhy = "";
    /** 有哪几组一个字都没交回来：有它就说明覆盖不全，这次不能记成 done（哪怕别的组给了意见）。 */
    const unresolvedGroups: { group: number; why: string }[] = [];
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
        // 子进程崩了（或守卫把它杀了）也照样以它自己报的原话为先：网关掉线时它可能先吐了
        // `EHOSTDOWN` 再非 0 退出，只报「退出码 N、stderr 首行」等于把原因丢了（D454 二轮评审意见 6）。
        failed = { code: res.code, stderr: res.error || res.stderr, group: i + 1 };
        plan[i].state = "failed";
        plan[i].finishedAt = new Date().toISOString();
        emitPlan();
        break;
      }
      // 这一组没交回话：计划里标 failed（不是「完成 0 条」），并记下来让收尾时把整轮算失败。
      // 只在**真的结束**时调：重试之后答上了就不该再留这一笔（否则全组答完也判失败）。
      const markGroupFailed = (index: number, why: string) => {
        plan[index].state = "failed";
        plan[index].finishedAt = new Date().toISOString();
        unresolvedGroups.push({ group: index + 1, why });
        emitPlan();
      };
      if (!res.text.trim()) {
        const why = childWhy(res);
        lastChildWhy = why;
        // 来源整个连不上（EHOSTDOWN 这类）：pi 已经在子进程里自己重试过 3 次，同一份提示词再发一遍
        // 只会再撞一次同一堵墙、还每组白发 ~25 秒。这组判失败，后面的组也别再跑了（D454）。
        if (res.error && unreachable(why)) {
          markGroupFailed(i, why);
          note(`第 ${i + 1} 组失败（${clip(why, 160)}）`, i + 1);
          break;
        }
        // 其余（没答也没报错，或 429 / ECONNRESET / 超上下文这种只影响一组的错）：照老规矩再问一次，
        // 明确让它「别再调工具」—— 单次限流就靠这一次翻盘（D454 评审意见 1）。
        note(`第 ${i + 1} 组没给结论（${clip(why, 160)}；已用 ${Math.round(res.tokens / 1000)}k token），重试一次`, i + 1);
        const nudge = `${prompt}\n\n## 立即收尾\n\n不要再调用任何工具。根据你已经看到的内容直接输出上面那个 JSON 对象；宁可少报，也要把 JSON 交回来。`;
        res = await runChild(nudge);
        if (res.aborted) break;
        if (res.code !== 0) {
          failed = { code: res.code, stderr: res.stderr, group: i + 1 };
          // 重试也挂掉依旧是「这一组失败」：不标就会在计划里一直挂着 running（落盘后失败详情会显示成进行中）。
          markGroupFailed(i, childWhy(res));
          break;
        }
        if (!res.text.trim()) {
          lastChildWhy = childWhy(res);
          markGroupFailed(i, lastChildWhy);
          note(`第 ${i + 1} 组没给出结论（${clip(lastChildWhy, 160)}）`, i + 1);
          // 重试这一轮可能换了一种错（刚才限流、这回网关掉了）：照样按**新的**原因决定要不要收工。
          if (res.error && unreachable(lastChildWhy)) break;
          continue;
        }
      }
      const parsed = toFindings(res.text);
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
      await finish({
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
    if (!stopped && unresolvedGroups.length) {
      // 有组一个字都没交回来（网关连不上 / 模型逛到没话说）：这不是「没问题」，是这次没评全。
      // 别的组给了意见也照样算失败 —— 把已有意见带回去，但状态不能写成 done。
      // 文案交给 `noOutputMessage()`：子进程自己报了错就照它说，别再一律建议「换个更便宜的模型」
      // （真机上那句话把「网关掉线」指成了「模型不划算」，D454）。
      const why = unresolvedGroups[unresolvedGroups.length - 1].why || lastChildWhy;
      await finish({
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
        error: noOutputMessage(why, tokens),
        errorCode: "child_no_output",
      });
      return;
    }
    await finish({
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
      ...(stopped ? { error: "", errorCode: "stopped" } : {}),
    });
  } catch (err: any) {
    const code = String(err?.code ?? "failed");
    const cancelled = signal.aborted || code === "cancelled";
    await finish({
      status: cancelled ? "stopped" : "failed",
      finishedAt: new Date().toISOString(),
      totalFiles: preview?.files.length ?? 0,
      reviewedFiles: 0,
      tokens,
      skipped: preview?.skipped ?? [],
      error: cancelled ? "" : String(err?.message ?? err),
      errorCode: cancelled ? "stopped" : code,
    });
  } finally {
    // 每个子进程在 close 时自己关 stdout（`runChild` 里），这里没有要收拾的。
  }
}

/** 盘上的 plan 是分段进度，坏一条就丢一条；别把 `[{}]` 原样发给页面。 */
function readPlan(raw: unknown): ReviewGroupPlan[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReviewGroupPlan[] = [];
  raw.forEach((item, i) => {
    if (!isRecord(item)) return;
    const state = str(item.state);
    if (!PLAN_STATES.has(state as ReviewGroupPlan["state"])) return;
    out.push({
      index: num(item.index) || i + 1,
      files: num(item.files),
      findings: num(item.findings),
      state: state as ReviewGroupPlan["state"],
      startedAt: str(item.startedAt),
      finishedAt: str(item.finishedAt),
    });
  });
  return out.length || raw.length === 0 ? out : undefined;
}

/** 跑的过程中出来的意见同样逐条校验：页面会直接拿它渲染，不能把半截对象当 ReviewFinding。 */
function readFindings(raw: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReviewFinding[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const key = str(item.key);
    const file = str(item.path);
    if (!key || !file) continue;
    const category = str(item.category);
    const severity = str(item.severity);
    const group = Number(item.group);
    const state = str(item.state);
    // 进度帧里只该有 new/persisting；done/dropped 是别的阶段的语义，不能冒充 new 再标一次。
    if (state && state !== "new" && state !== "persisting") continue;
    const mark = str(item.mark);
    out.push({
      key,
      path: file,
      startLine: num(item.startLine),
      endLine: num(item.endLine),
      category: CATEGORIES.includes(category as Category) ? (category as Category) : "other",
      severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : "medium",
      content: str(item.content),
      existingCode: str(item.existingCode),
      suggestionCode: str(item.suggestionCode),
      anchored: item.anchored === true,
      state: state === "persisting" ? "persisting" : "new",
      mark: MARKS.has(mark as ReviewMark) ? (mark as ReviewMark) : "",
      ...(Number.isInteger(group) && group > 0 ? { group } : {}),
    });
  }
  return out.length || raw.length === 0 ? out : undefined;
}

/** 执行 worker 当前写到哪了。读不到（还没写 / 正在 rename）就当没有。 */
function readProgressFile(job: ReviewJob): Progress | null {
  try {
    const raw = JSON.parse(fs.readFileSync(reviewProgressFile(job.runId), "utf8")) as unknown;
    if (!isRecord(raw)) return null;
    if (raw.runId !== job.runId) return null;
    const status = str(raw.status);
    const phase = str(raw.phase);
    if (!["running", "done", "stopped", "failed", "stale"].includes(status)) return null;
    if (!["preview", "fetch", "rules", "review", "done"].includes(phase)) return null;
    // 盘上的进度是脑广播给页面的输入：逐字段归一化，别把 `tokens:"7"` / 半截 plan 原样发出去。
    const log: ReviewLogLine[] = Array.isArray(raw.log)
      ? raw.log
          .filter(isRecord)
          .map((line) => ({
            at: num(line.at),
            text: str(line.text),
            ...(typeof line.group === "number" ? { group: line.group } : {}),
          }))
      : [];
    const plan = readPlan(raw.plan);
    const findings = readFindings(raw.findings);
    return {
      repo: str(raw.repo) || job.repo,
      runId: job.runId,
      status: status as ReviewRunStatus,
      phase: phase as Progress["phase"],
      totalFiles: num(raw.totalFiles),
      reviewedFiles: num(raw.reviewedFiles),
      currentFile: str(raw.currentFile),
      tokens: num(raw.tokens),
      startedAt: str(raw.startedAt) || job.startedAt,
      error: str(raw.error),
      errorCode: str(raw.errorCode),
      group: num(raw.group),
      groups: num(raw.groups),
      ...(plan ? { plan } : {}),
      ...(findings ? { findings } : {}),
      log,
    };
  } catch {
    return null;
  }
}

function freshProgress(job: ReviewJob): Progress {
  return {
    repo: job.repo,
    runId: job.runId,
    status: "running",
    phase: "preview",
    totalFiles: 0,
    reviewedFiles: 0,
    currentFile: "",
    tokens: 0,
    startedAt: job.startedAt,
    error: "",
    errorCode: "",
    group: 0,
    groups: 0,
    log: [],
  };
}

function startText(opts: ReviewJobOpts): string {
  switch (opts.mode) {
    case "pr":
      return `开始评审：PR #${Number(opts.pr) || 0}`;
    case "range":
      return `开始评审：${opts.target || "HEAD"} vs ${opts.base || "主干"}`;
    case "commit":
      return `开始评审：提交 ${opts.commit || "HEAD"}`;
    default:
      return "开始评审：工作区改动";
  }
}

function reapReviewJob(job: ReviewJob): void {
  for (const file of [
    reviewJobFile(job.runId),
    reviewProgressFile(job.runId),
    reviewCancelFile(job.runId),
    reviewBeatFile(job.runId),
    reviewLogFile(job.runId),
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 清不掉也不影响这一次评审的结果 */
    }
  }
}

function killReviewPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      // worker 可能还带着 OCR / pi 子进程：整棵树收掉，别留下读着 diff 的孤儿。
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      // detached 的 worker 是自己那一组的组长：杀负 pid 才能把 OCR / pi 子进程一起带走。
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* 已经退了 */
  }
}

/** 请 worker 自己收尾（写 stopped）；10 秒还不走才强杀。 */
function requestCancel(job: ReviewJob): void {
  try {
    writeJsonAtomic(reviewCancelFile(job.runId), { at: Date.now() });
  } catch {
    /* 写不下取消文件时，后面的超时强杀仍然兜底 */
  }
  const activeJob = active.get(job.runId);
  if (activeJob?.job === job) activeJob.cancelRequested = true;
  const timer = setTimeout(() => {
    // 先确认这一条还在跑：worker 正常收尾之后 pid 可能被系统复用，不能拿旧 pid 去杀别人。
    if (active.get(job.runId)?.job !== job) return;
    if (reviewJobRunning(job)) killReviewPid(Number(job.pid));
  }, 10_000);
  timer.unref?.();
}

let tickTimer: NodeJS.Timeout | null = null;
/** 同一条评审的同一个错误只记一次，避免盘满 / 广播炸时每 500ms 刷一行日志。 */
const tickErrors = new Map<string, string>();

function ensureReviewTicker(): void {
  if (tickTimer) return;
  tickTimer = setInterval(tickReviewJobs, 500);
  tickTimer.unref?.();
}

/** 一条评审的一轮转发。抛错由 `tickReviewJobs()` 隔离，不能让一条拖垮整个脑。 */
function tickOneReview(runId: string, a: Active): void {
  const job = a.job;
  if (!job) return;

  // 换脑可能赶在 worker 写回 pid 之前：每一轮都从盘上补一次，补到之后 cancel 超时才有 pid 可杀。
  if (!job.pid) {
    const fresh = readReviewJob(reviewJobFile(runId));
    if (fresh?.pid) job.pid = fresh.pid;
    // job 还没被 worker 补写 pid 时，心跳文件本身就是证据：别把已经开始干活的 worker 判死。
    adoptBeatPid(job);
  }

  const progress = readProgressFile(job);
  if (progress && JSON.stringify(progress) !== JSON.stringify(progressMap.get(runId))) {
    // 先广播再记账：广播抛错时下一轮还会重试这一帧，不会永远停在上一格。
    notify.onProgress?.(job, progress);
    progressMap.set(runId, progress);
  }
  if (reviewJobRunning(job)) return;
  // 刚 spawn 的 worker 还没把 pid 写回来：再等一会儿，别把「正在起」判成「已经死」。
  if (workerStarting(job)) return;

  const state = readReviewState(job.repo, job.session);
  const run = state.runs.find((r) => r.id === runId);
  if (!run) {
    untrackActive(runId);
    progressMap.delete(runId);
    reapReviewJob(job);
    return;
  }
  if (run.status === "running") {
    // 用户已经点过停止（cancel 文件先于 worker 死亡存在）时，worker 被 10 秒兜底强杀
    // 不能记成「进程丢失」——那是用户主动停止，前端要显示 stopped。
    const cancelled = a.cancelRequested === true || fs.existsSync(reviewCancelFile(runId));
    // worker 写状态之前就死了（崩了 / 被系统杀了）：这条不能永远转圈。错误文案由 errorCode
    // 在前端按语言渲染，桥里不再写一份中文，否则外语界面会把它当 detail 重复拼在后面。
    run.status = cancelled ? "stopped" : "stale";
    run.errorCode = cancelled ? "stopped" : "worker-lost";
    run.error = "";
    run.finishedAt = new Date().toISOString();
    writeReviewState(job.repo, state, job.session);
  }
  // worker 可能刚写完最后一帧就删了心跳；再读一次进度文件，终态的 log / findings / plan
  // 要以 worker 的末帧为准，不能退回 ticker 上一轮读到的 running 帧。
  const last = readProgressFile(job) ?? progressMap.get(runId) ?? progress;
  const final: Progress = {
    ...(last ?? freshProgress(job)),
    status: run.status,
    phase: "done",
    currentFile: "",
    tokens: last?.tokens || run.tokens,
    reviewedFiles: last?.reviewedFiles || run.reviewedFiles,
    totalFiles: last?.totalFiles || run.totalFiles,
    error: run.errorCode === "stopped" ? "" : run.error ?? "",
    errorCode: run.errorCode ?? "",
  };
  notify.onProgress?.(job, final);
  notify.onState?.(job);
  progressMap.delete(runId);
  untrackActive(runId);
  reapReviewJob(job);
}

/**
 * 脑侧的转发器：worker 写进度文件，这里读出来广播；执行进程没了就把这一条收尾。
 *
 * 用轮询而不是 `fs.watch`：watch 在 Windows / 网络盘上会漏事件，而 500ms 的人眼延迟无所谓，
 * 漏一次却会让面板永远停在上一格。
 */
function tickReviewJobs(): void {
  for (const [runId, a] of [...active]) {
    try {
      tickOneReview(runId, a);
      tickErrors.delete(runId);
    } catch (err) {
      // readReviewState / writeReviewState 碰到 ENOSPC、EACCES、网络盘瞬断，或 broadcast 写
      // socket 抛错，都只能影响这一条；不能让 setInterval 的未捕获异常把整个脑带走。
      const message = err instanceof Error ? err.message : String(err);
      if (tickErrors.get(runId) !== message) {
        tickErrors.set(runId, message);
        console.error(`[review] 转发评审 ${runId} 失败：${message}`);
      }
    }
  }
  if (!active.size && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** 构建目录里用 `.js`，`npm run dev`（直接跑 .ts）时回退到源码入口。 */
function reviewWorkerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.join(here, "review-worker.js");
  return fs.existsSync(built) ? built : path.join(here, "review-worker.ts");
}

function markWorkerSpawnFailed(job: ReviewJob, err: unknown): void {
  if (active.get(job.runId)?.job !== job) return;
  const state = readReviewState(job.repo, job.session);
  const onDisk = state.runs.find((r) => r.id === job.runId);
  if (onDisk && onDisk.status === "running") {
    onDisk.status = "failed";
    onDisk.finishedAt = new Date().toISOString();
    onDisk.error = err instanceof Error ? err.message : String(err);
    onDisk.errorCode = "worker_spawn";
    writeReviewState(job.repo, state, job.session);
  }
  untrackActive(job.runId);
  progressMap.delete(job.runId);
  reapReviewJob(job);
  notify.onState?.(job);
}

/** 只把 GitHub 身份相关的键带进子进程；别把脑的 PI_WEB_* / 测试开关顺带漏下去。 */
function ghEnvOnly(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    if (key.startsWith("GH_") || key.startsWith("GITHUB_")) out[key] = value;
  }
  return out;
}

/** 起一次 detached 执行进程。ghEnv（会话选的 GitHub 令牌）只走环境变量，不落盘。 */
function spawnReviewWorker(job: ReviewJob, ghEnv?: NodeJS.ProcessEnv): void {
  const entry = reviewWorkerEntry();
  const args = entry.endsWith(".ts") ? ["--experimental-strip-types", entry, reviewJobFile(job.runId)] : [entry, reviewJobFile(job.runId)];
  ensureDir(reviewJobsDir());
  const logFd = fs.openSync(reviewLogFile(job.runId), "a");
  const env: NodeJS.ProcessEnv = { ...piChildEnv(), ...ghEnvOnly(ghEnv) };
  env.PI_WEB_STATE = stateDir();
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(process.execPath, args, {
      cwd: job.repo,
      env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
    });
  } catch (err) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* 已经关了 */
    }
    throw err;
  }
  try {
    fs.closeSync(logFd);
  } catch {
    /* 已经关了 */
  }
  proc.on("error", (err) => {
    try {
      markWorkerSpawnFailed(job, err);
    } catch (cause) {
      // spawn 失败本身已经够糟了；这里的收尾（读/写状态、广播）再抛错不能变成进程级 unhandled。
      console.error(`[review] 处理 worker 启动失败时又出错：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  proc.unref();
  if (proc.pid) {
    job.pid = proc.pid;
    try {
      writeJsonAtomic(reviewJobFile(job.runId), job);
    } catch {
      /* 写不进去也不影响本代转发；只是换脑后认不回来 */
    }
  }
}

/** 文件名 → runId。临时文件（`<runId>.json.<pid>.tmp`）也要能归位，不能让它永远堆在 jobs 里。 */
function reviewRunIdOf(name: string): string | null {
  const tmp = /^(.*)\.\d+\.tmp$/.exec(name);
  const base = tmp ? tmp[1] : name;
  for (const suffix of [".progress.json", ".cancel", ".beat", ".log", ".json"]) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return null;
}

/**
 * 脑开机后把上一代交给 worker 的评审接回来（换脑 / 脑崩溃 / 更新重启都走这条路）。
 * 必须 `setReviewNotify()` 之后再调：接回来的第一条进度就是从这里广播出去的。
 */
export function resumeReviewJobs(): number {
  let names: string[] = [];
  try {
    names = fs.readdirSync(reviewJobsDir());
  } catch {
    return 0;
  }
  const live = new Set<string>();
  let resumed = 0;
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".progress.json")) continue;
    let job: ReviewJob | null = null;
    let tracked: ReviewJob | null = null;
    try {
      job = readReviewJob(path.join(reviewJobsDir(), name));
      if (!job) {
        try {
          fs.rmSync(path.join(reviewJobsDir(), name), { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      const j = job;
      adoptBeatPid(j);
      const state = readReviewState(j.repo, j.session);
      const run = state.runs.find((r) => r.id === j.runId);
      if (
        !run ||
        run.status !== "running" ||
        (!reviewJobRunning(j) && !workerStarting(j)) ||
        (run.startedAt && j.startedAt && run.startedAt !== j.startedAt)
      ) {
        // 已经收尾、进程没了、或 pid 已经被别的进程复用：这份 job 文件只是碎屑。
        reapReviewJob(j);
        continue;
      }
      tracked = j;
      trackActive(j.runId, {
        cancel: () => requestCancel(j),
        repo: j.repo,
        session: j.session,
        mode: j.opts.mode ?? run.mode,
        // run.pr 是 execute 解析后的真实号（opts.pr 可能是 0 或链接里的旧号），判重以它为准。
        pr: run.pr || Number(j.opts.pr) || 0,
        cancelRequested: fs.existsSync(reviewCancelFile(j.runId)),
        job: j,
      });
      const progress =
        readProgressFile(j) ?? {
          ...freshProgress(j),
          totalFiles: run.totalFiles,
          reviewedFiles: run.reviewedFiles,
          tokens: run.tokens,
        };
      progressMap.set(j.runId, progress);
      notify.onProgress?.(j, progress);
      notify.onState?.(j);
      live.add(j.runId);
      resumed += 1;
    } catch (err) {
      // 一条 job 接不回来（状态文件读不了 / 广播炸了）只该少了这一条，不能让整个脑启动失败。
      if (tracked) {
        live.delete(tracked.runId);
        untrackActive(tracked.runId);
        progressMap.delete(tracked.runId);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[review] 接回评审 ${job?.runId ?? name} 失败：${message}`);
    }
  }
  // 没有 job 文件的进度 / 取消 / 心跳 / 日志是上一代留下的碎屑，清掉；别让下一次开机又当成活任务。
  for (const name of names) {
    if (name.endsWith(".json") && !name.endsWith(".progress.json")) continue;
    const runId = reviewRunIdOf(name);
    if (!runId || live.has(runId)) continue;
    try {
      fs.rmSync(path.join(reviewJobsDir(), name), { force: true });
    } catch {
      /* ignore */
    }
  }
  if (resumed) ensureReviewTicker();
  return resumed;
}

/**
 * 整组优雅停机：评审不能跨「用户主动关桥」活着（那会把子进程留到 30 分钟超时）。
 * 换脑（retire）**不**走这里 —— 那条路正是要让评审继续跑。
 */
export async function stopAllReviews(waitMs = 3000): Promise<number> {
  const jobs = [...active.values()]
    .map((a) => a.job)
    .filter((job): job is ReviewJob => !!job);
  if (!jobs.length) return 0;
  for (const job of jobs) requestCancel(job);
  const until = Date.now() + waitMs;
  while (Date.now() < until && jobs.some((job) => active.get(job.runId)?.job === job && reviewJobRunning(job))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const job of jobs) {
    if (active.get(job.runId)?.job === job && reviewJobRunning(job)) killReviewPid(Number(job.pid));
    untrackActive(job.runId);
    progressMap.delete(job.runId);
    reapReviewJob(job);
  }
  // 同一会话的多条评审共用一份 state：读一次、改一次、写一次。逐条读改写既浪费，
  // 也给 ticker / 另一个停机流程留下后写覆盖前写的窗口。
  const groups = new Map<string, { repo: string; session: string; jobs: ReviewJob[] }>();
  for (const job of jobs) {
    const key = JSON.stringify([job.repo, job.session]);
    const group = groups.get(key);
    if (group) group.jobs.push(job);
    else groups.set(key, { repo: job.repo, session: job.session, jobs: [job] });
  }
  for (const group of groups.values()) {
    const state = readReviewState(group.repo, group.session);
    let changed = false;
    for (const job of group.jobs) {
      const run = state.runs.find((r) => r.id === job.runId);
      if (run && run.status === "running") {
        run.status = "stopped";
        run.finishedAt = new Date().toISOString();
        run.error = "";
        run.errorCode = "stopped";
        changed = true;
      }
    }
    if (changed) writeReviewState(group.repo, state, group.session);
  }
  return jobs.length;
}

/**
 * worker 入口：读 job → 跑 `execute` → 把进度写文件。取消看 `<runId>.cancel`，不看信号：
 * Windows 上 detached 进程收不到 SIGTERM，文件是唯一三平台一致的通道。
 */
export async function runReviewJob(jobFile: string): Promise<void> {
  const job = readReviewJob(jobFile);
  if (!job) {
    console.error(`[review-worker] 读不出 job 文件：${jobFile}`);
    return;
  }
  // 自己把 pid 补进 job 文件：脑可能在 spawn 之后、写 pid 之前就崩了，
  // 这一行是「换脑后还认不认得出这条评审」的最后一道保险。
  job.pid = process.pid;
  try {
    writeJsonAtomic(reviewJobFile(job.runId), job);
  } catch {
    /* 写不进去也不影响本次执行，只是换脑后接不回来 */
  }
  const state = readReviewState(job.repo, job.session);
  const run = state.runs.find((r) => r.id === job.runId);
  if (!run || run.status !== "running") {
    // 脑已经先收尾了（停机 / 换脑后判死 / 用户取消）：别把自己刚补的 job 文件留成碎屑。
    try {
      fs.rmSync(reviewJobFile(job.runId), { force: true });
      fs.rmSync(reviewProgressFile(job.runId), { force: true });
      fs.rmSync(reviewCancelFile(job.runId), { force: true });
      fs.rmSync(reviewBeatFile(job.runId), { force: true });
    } catch {
      /* 清不掉就留给下次开机 */
    }
    return;
  }

  // 心跳只证明「这个 pid 还是这个 worker」：换脑期间脑不在，pid 可能被系统复用；
  // 没有它，sweep / resume 会把无关进程当成评审还在跑。
  const beat = () => {
    try {
      writeJsonAtomic(reviewBeatFile(job.runId), { pid: process.pid, startedAt: job.startedAt, at: Date.now() });
    } catch {
      /* 心跳写不下不影响评审本身 */
    }
  };
  beat();
  const beatTimer = setInterval(beat, WORKER_BEAT_MS);
  beatTimer.unref?.();

  let progress: Progress = readProgressFile(job) ?? freshProgress(job);
  let flushTimer: NodeJS.Timeout | null = null;
  const writeNow = () => {
    try {
      writeJsonAtomic(reviewProgressFile(job.runId), progress);
    } catch {
      /* 下一次 emit 会再试；写不了也不影响评审本身 */
    }
  };
  const schedule = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      writeNow();
    }, 200);
    flushTimer.unref?.();
  };
  const emit = (patch: Partial<Progress>) => {
    progress = { ...progress, ...patch, repo: job.repo, runId: job.runId, startedAt: job.startedAt };
    schedule();
  };
  const note = (text: string, group?: number) => {
    const line: ReviewLogLine = { at: Date.now(), text, ...(group ? { group } : {}) };
    progress = { ...progress, log: [...progress.log, line].slice(-40) };
    schedule();
  };

  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const cancelPoll = setInterval(() => {
    if (!fs.existsSync(reviewCancelFile(job.runId))) return;
    stop();
    clearInterval(cancelPoll);
  }, 300);
  cancelPoll.unref?.();

  try {
    await execute({
      root: job.repo,
      session: job.session,
      run,
      opts: {
        dir: job.repo,
        mode: job.opts.mode,
        base: job.opts.base,
        target: job.opts.target,
        commit: job.opts.commit,
        pr: job.opts.pr,
        session: job.session,
        // 会话选的账号已经在 spawn 时注进环境；这里把它交给 gh/git 子进程。
        ghEnv: ghEnvOnly(process.env),
        model: job.opts.model,
        provider: job.opts.provider,
        lang: job.opts.lang,
      },
      signal: abort.signal,
      emit,
      note,
      getProgress: () => progress,
    });
  } finally {
    clearInterval(cancelPoll);
    clearInterval(beatTimer);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeNow();
    try {
      fs.rmSync(reviewCancelFile(job.runId), { force: true });
    } catch {
      /* ignore */
    }
    // worker 正常收尾后心跳必须一起消失：否则 pid 被系统复用时，`reviewJobRunning()`
    // 还会凭这份 30 秒内的心跳把无关进程当成评审，stopAllReviews 就可能误杀。
    try {
      fs.rmSync(reviewBeatFile(job.runId), { force: true });
    } catch {
      /* ignore */
    }
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

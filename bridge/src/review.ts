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
 * （`edit` / `write` 根本不在 `--tools` 里）。这几条见 docs/DECISIONS.md 的 D394。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { ensureDir, piChildEnv, quarantineStateFile, readJsonChecked, statePath } from "./paths.ts";
import { resolvePi } from "./pi.ts";

export type ReviewMode = "workspace" | "range" | "commit";
export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "bug" | "security" | "performance" | "maintainability" | "test" | "style" | "documentation" | "other";
export type Mark = "accept" | "ignore" | "false-positive";
export type RunStatus = "running" | "done" | "stopped" | "failed" | "stale";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const CATEGORIES: Category[] = ["bug", "security", "performance", "maintainability", "test", "style", "documentation", "other"];

export class ReviewError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
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

/** 没评的文件与原因（太大 / 规则排除 / 超预算）。面板要把它们列出来 —— 静默丢掉等于说谎。 */
export interface PreviewSkip {
  path: string;
  reason: string;
}

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
  if (t.mode === "range") {
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
  if (p.mode === "range") {
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
- 定位必须指向改动的那几行；找不到确切行就给 start_line: 0，不要编行号。
- 只报真问题：没有缺陷就别硬凑，findings 允许是空数组。
- 不报风格偏好、不报「建议加注释」这类空话；说不清影响的不报。`;

/** 一次评审的提示词。规则来自 `ocr delegate rule`（可能为空），语言跟着界面走。 */
export function buildPrompt(p: Preview, lang: ReviewLang, rules: string): string {
  const files = p.files.map((f) => `- ${f.path}${f.status ? `（${f.status}）` : ""}`).join("\n");
  const cmd = diffCommandFor(p, "<文件>");
  const range =
    p.mode === "commit"
      ? `这次评的是单个提交 ${p.to || "HEAD"}。`
      : p.mode === "range"
        ? `这次评的是 ${p.from || "?"} 到 ${p.to || "HEAD"} 的改动（合并基准 ${p.mergeBase || "未知"}）。`
        : `这次评的是工作区里未提交的改动。`;
  const rulesBlock = rules.trim() ? `\n## 这个仓库命中的规则\n\n${rules.trim()}\n` : "";
  return [
    PROTOCOL,
    "",
    `## 本次范围\n\n${range}`,
    "",
    `取 diff 的命令（把 <文件> 换成清单里的路径）：\`${cmd}\``,
    "需要更多上下文时，可以读整个文件、也可以在仓库里检索；不要改文件、不要跑测试、不要提交。",
    rulesBlock,
    `## 要评的文件\n\n${files}`,
    "",
    `## 语言\n\ncontent / reason 用${LANG_NAME[lang]}写；existing_code 与 suggestion_code 必须是原文代码，不翻译。`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
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
  const text = raw ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { findings: [], skipped: [] };
  let body: any;
  try {
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { findings: [], skipped: [] };
  }

  const findings: Finding[] = [];
  for (const item of arr(body?.findings)) {
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
  for (const item of arr(body?.skipped)) {
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

export interface MergedFinding extends Finding {
  key: string;
  state: "new" | "persisting";
  mark: Mark | "";
}

export interface MergeResult {
  findings: MergedFinding[];
  /** 上一轮有、这一轮没有的那几条的 key（面板标「已解决」）。 */
  resolved: string[];
}

/** 这一轮的意见对上一轮：新的 / 还在的，外加上一轮消失了的那批。 */
export function mergeFindings(
  prev: readonly Pick<Finding, "path" | "category" | "existingCode">[],
  next: readonly Finding[],
  marks: Record<string, Mark>,
): MergeResult {
  const prevKeys = new Set(prev.map((f) => findingKey(f)));
  const findings = next.map((f) => {
    const key = findingKey(f);
    return {
      ...f,
      key,
      state: (prevKeys.has(key) ? "persisting" : "new") as "new" | "persisting",
      mark: (marks[key] ?? "") as Mark | "",
    };
  });
  const nextKeys = new Set(findings.map((f) => f.key));
  const resolved: string[] = [];
  for (const f of prev) {
    const key = findingKey(f);
    if (!nextKeys.has(key) && !resolved.includes(key)) resolved.push(key);
  }
  return { findings, resolved };
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

export interface ReviewRun {
  id: string;
  dir: string;
  mode: ReviewMode;
  from: string;
  to: string;
  mergeBase: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  model: string;
  lang: ReviewLang;
  findings: MergedFinding[];
  resolved: string[];
  /** 模型说没评的 + preview 就没给的文件，合成一张表给面板列出来。 */
  skipped: PreviewSkip[];
  reviewedFiles: number;
  totalFiles: number;
  tokens: number;
  error: string;
  errorCode: string;
}

export interface ReviewState {
  repo: string;
  runs: ReviewRun[];
  /** 用户标的处理态，按 `findingKey` 记在仓库上：跨轮次，不跟某一次评审走。 */
  marks: Record<string, Mark>;
}

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

export function reviewStateFile(repo: string): string {
  return path.join(reviewDir(), `${repoKey(repo)}.json`);
}

export function readReviewState(repo: string): ReviewState {
  const file = reviewStateFile(repo);
  const read = readJsonChecked<ReviewState>(file, { repo, runs: [], marks: {} });
  if (!read.ok) {
    // 读坏了就留档、从空状态起步：一次瞬时读失败不该让这个仓库的历史永远消失。
    quarantineStateFile(file);
    return { repo, runs: [], marks: {} };
  }
  const value = read.value;
  return {
    repo: str(value?.repo) || repo,
    runs: Array.isArray(value?.runs) ? value.runs : [],
    marks: value?.marks && typeof value.marks === "object" ? value.marks : {},
  };
}

export function writeReviewState(repo: string, state: ReviewState): void {
  const file = reviewStateFile(repo);
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
export function markFinding(repo: string, key: string, mark: Mark | ""): ReviewState {
  const state = readReviewState(repo);
  if (mark) state.marks[key] = mark;
  else delete state.marks[key];
  for (const run of state.runs) for (const f of run.findings) if (f.key === key) f.mark = mark;
  writeReviewState(repo, state);
  return state;
}

/** 「清理」只清历史评审（留着 marks：那些是「这条我判过了」，不该因为清历史又复活）。 */
export function cleanRuns(repo: string): ReviewState {
  const state = readReviewState(repo);
  state.runs = [];
  writeReviewState(repo, state);
  return state;
}

// ---------------------------------------------------------------------------
// 跑一次
// ---------------------------------------------------------------------------

const REVIEW_TIMEOUT_MS = 30 * 60_000;

/** 面板轮询/广播的那个「现在到哪了」。 */
export interface Progress {
  repo: string;
  runId: string;
  status: RunStatus;
  phase: "preview" | "rules" | "review" | "done";
  totalFiles: number;
  reviewedFiles: number;
  currentFile: string;
  tokens: number;
  startedAt: string;
  error: string;
  errorCode: string;
}

interface Active {
  cancel: () => void;
}

/** 一个仓库同时只跑一次；key 与落盘同一个 `repoKey`。 */
const active = new Map<string, Active>();
const progressMap = new Map<string, Progress>();

export function reviewProgress(repo: string): Progress | null {
  return progressMap.get(repoKey(repo)) ?? null;
}

/** 桥重启后，盘上还写着 running 的那几次永远不会再有人收尾 —— 开机时统一转成「已失效」。 */
export function sweepStaleRuns(): number {
  let files: string[] = [];
  try {
    files = fs.readdirSync(reviewDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  let changed = 0;
  for (const name of files) {
    const file = path.join(reviewDir(), name);
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
  const args = prefix.length ? [...prefix, ...quoteForCmd(prefix, argv)] : argv;
  const out = await runCapture(cmd, args, cwd, timeoutMs, signal);
  const kind = classifyOcrFailure(out.stderr, out.code);
  if (kind === "ocr_missing") throw new ReviewError("ocr_missing", "没装 ocr");
  if (kind === "ocr_too_old") throw new ReviewError("ocr_too_old", "ocr 版本太老（需要 1.9.0+）");
  if (kind === "failed") throw new ReviewError("ocr_failed", firstLine(out.stderr) || `ocr 退出码 ${out.code}`);
  return out;
}

/** 过 `cmd.exe /c` 时把参数逐条加引号：`Program Files` 这种路径不能被空格拆开。 */
function quoteForCmd(prefix: string[], args: string[]): string[] {
  if (!prefix.length) return args;
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
  model?: string;
  provider?: string;
  lang: ReviewLang;
  onProgress?: (p: Progress) => void;
  /** 开始 / 结束各叫一次：让页面重新拉整份状态。 */
  onState?: () => void;
}

export function startReview(o: StartOptions): { runId: string; repo: string } {
  const root = gitRoot(o.dir);
  const key = repoKey(root);
  if (active.has(key)) throw new ReviewError("busy", "这个仓库已经在评了");

  const state = readReviewState(root);
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const run: ReviewRun = {
    id: runId,
    dir: root,
    mode: o.mode,
    from: o.base ?? "",
    to: o.mode === "commit" ? o.commit ?? "HEAD" : "HEAD",
    mergeBase: "",
    status: "running",
    startedAt,
    finishedAt: "",
    model: o.model ?? "",
    lang: o.lang,
    findings: [],
    resolved: [],
    skipped: [],
    reviewedFiles: 0,
    totalFiles: 0,
    tokens: 0,
    error: "",
    errorCode: "",
  };
  state.runs.push(run);
  writeReviewState(root, state);

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
  emit({});
  o.onState?.();

  void execute({ root, run, opts: o, signal: abort.signal, emit })
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

export function cancelReview(dir: string): boolean {
  const key = repoKey(dir);
  const running = active.get(key);
  if (!running) return false;
  running.cancel();
  return true;
}

interface ExecuteCtx {
  root: string;
  run: ReviewRun;
  opts: StartOptions;
  signal: AbortSignal;
  emit: (patch: Partial<Progress>) => void;
}

async function execute(ctx: ExecuteCtx): Promise<void> {
  const { root, run, opts, signal, emit } = ctx;
  const key = repoKey(root);
  let tokens = 0;
  let reviewed = 0;
  let currentFile = "";
  let preview: Preview | null = null;
  let partialText = "";
  let child: ReturnType<typeof spawn> | null = null;

  const finish = (patch: Pick<ReviewRun, "status"> & Partial<ReviewRun>) => {
    const state = readReviewState(root);
    const onDisk = state.runs.find((r) => r.id === run.id);
    if (onDisk) Object.assign(onDisk, patch);
    else state.runs.push({ ...run, ...patch });
    writeReviewState(root, state);
    const prevProgress = progressMap.get(key);
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

  try {
    const target: PreviewTarget = { mode: opts.mode, base: opts.base, target: opts.target, commit: opts.commit, cwd: root };
    const { stdout } = await runOcr(previewArgs(target), root, 120_000, signal);
    preview = parsePreview(stdout);
    run.mergeBase = preview.mergeBase;
    run.from = preview.from || run.from;
    run.to = preview.to || run.to;
    run.totalFiles = preview.files.length;
    emit({ phase: "rules", totalFiles: preview.files.length });

    if (!preview.files.length) {
      finish({ status: "done", finishedAt: new Date().toISOString(), skipped: preview.skipped });
      return;
    }

    const rules = await rulesFor(root, preview.files.map((f) => f.path), signal);
    emit({ phase: "review" });

    const pi = resolvePi();
    const prompt = buildPrompt(preview, opts.lang, rules);
    const args = [pi.cli, ...reviewArgs({ model: opts.model, provider: opts.provider })];
    const proc = spawn(process.execPath, args, {
      cwd: root,
      env: piChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = proc;
    const guard = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* 已经退了 */
      }
    }, REVIEW_TIMEOUT_MS);
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* 已经退了 */
      }
    };
    signal.addEventListener("abort", onAbort);

    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    proc.stdin?.end(prompt);

    const touched = new Map<string, true>();
    const lines = readline.createInterface({ input: proc.stdout! });
    lines.on("line", (line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev?.type === "tool_execution_start") {
        const rel = relativeTo(root, ev.args?.path || ev.args?.pattern || ev.args?.command || "");
        if (rel) currentFile = rel.slice(0, 120);
        if (ev.toolName === "read" && rel) touched.set(rel, true);
        emit({ reviewedFiles: touched.size, currentFile });
        return;
      }
      if (ev?.type === "message_end") {
        const usage = ev.message?.usage;
        if (usage && typeof usage.totalTokens === "number") tokens += usage.totalTokens;
        if (ev.message?.role === "assistant") {
          const text = Array.isArray(ev.message.content)
            ? ev.message.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("")
            : "";
          if (text.trim()) partialText = text;
          reviewed += 0;
        }
        emit({ tokens, reviewedFiles: touched.size });
      }
    });

    const code: number | null = await new Promise((resolve) => proc.on("close", (c) => resolve(c)));
    clearTimeout(guard);
    signal.removeEventListener("abort", onAbort);

    if (signal.aborted) {
      const partial = toFindings(partialText);
      finish({
        status: "stopped",
        finishedAt: new Date().toISOString(),
        findings: partial.findings.map((f) => ({ ...f, key: findingKey(f), state: "new" as const, mark: (readReviewState(root).marks[findingKey(f)] ?? "") as Mark | "" })),
        skipped: [...(preview?.skipped ?? []), ...partial.skipped],
        reviewedFiles: touched.size,
        tokens,
        error: "已停止",
        errorCode: "stopped",
      });
      return;
    }

    if (code !== 0) {
      finish({
        status: "failed",
        finishedAt: new Date().toISOString(),
        reviewedFiles: touched.size,
        tokens,
        skipped: preview.skipped,
        error: firstLine(stderr) || `评审进程退出码 ${code}`,
        errorCode: "child_failed",
      });
      return;
    }

    const parsed = toFindings(partialText);
    const state = readReviewState(root);
    const prevRun = [...state.runs].reverse().find((r) => r.id !== run.id && r.status === "done");
    const merged = mergeFindings(prevRun?.findings ?? [], parsed.findings, state.marks);
    const skipped = [...preview.skipped, ...parsed.skipped];
    const accounted = new Set([...parsed.findings.map((f) => f.path), ...parsed.skipped.map((s) => s.path)]);
    const total = preview.files.length;
    finish({
      status: "done",
      finishedAt: new Date().toISOString(),
      findings: merged.findings,
      resolved: merged.resolved,
      skipped,
      totalFiles: total,
      reviewedFiles: accounted.size,
      tokens,
    });
  } catch (err: any) {
    const code = String(err?.code ?? "failed");
    const cancelled = signal.aborted || code === "cancelled";
    finish({
      status: cancelled ? "stopped" : "failed",
      finishedAt: new Date().toISOString(),
      totalFiles: preview?.files.length ?? 0,
      reviewedFiles: reviewed,
      tokens,
      skipped: preview?.skipped ?? [],
      error: cancelled ? "已停止" : String(err?.message ?? err),
      errorCode: cancelled ? "stopped" : code,
    });
  } finally {
    try {
      child?.stdout?.destroy();
    } catch {
      /* 进程已经没了 */
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

export interface OcrStatus {
  installed: boolean;
  version: string;
  /** delegation 的 `--format json` 要 1.9.0 起；低于它按「太老」扱。 */
  tooOld: boolean;
  error: string;
}

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

/** 面板打开时问一句就够了；不要放到每次刷新里（一次 spawn 几十毫秒）。 */
export async function ocrStatus(): Promise<OcrStatus> {
  try {
    const { stdout, stderr } = await runOcr(["version"], process.cwd(), 15_000);
    const parts = parseVersion(`${stdout}\n${stderr}`);
    const version = parts.length ? parts.join(".") : "";
    return { installed: true, version, tooOld: olderThan(parts, MIN_OCR_VERSION), error: "" };
  } catch (err: any) {
    const code = String(err?.code ?? "failed");
    return { installed: false, version: "", tooOld: false, error: code === "ocr_too_old" ? "too-old" : code === "ocr_missing" ? "missing" : String(err?.message ?? err) };
  }
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

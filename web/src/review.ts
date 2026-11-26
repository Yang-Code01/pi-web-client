/**
 * 右栏第四颗页签「代码评审」(#651)。
 *
 * 分两半：
 * - `reviewView()` 把桥发来的状态压成一个普通对象（要显示什么、按什么顺序）；单测只测它。
 * - `ReviewPanel` 那一半把对象机械地画成 DOM，不在这里做任何判断。
 *
 * 意见不在这里改代码：一条意见旁边只有「交给 AI 修」，把位置与原文送进输入框，
 * 修不修、怎么修仍由会话决定（与分支工作台的「交给 AI」同口径，D235）。
 */
import { createEl as el } from "./chat.ts";
import { fmtDate, fmtTime, tr } from "./i18n/index.ts";

import type {
  ReviewFinding,
  ReviewGroupPlan,
  ReviewMark as Mark,
  ReviewMode,
  ReviewOcrStatus as OcrStatus,
  ReviewProgress,
  ReviewRun,
  ReviewSeverity as Severity,
  ReviewSkip,
  ReviewState,
} from "./frames.ts";

export type { Mark, OcrStatus, ReviewFinding, ReviewMode, ReviewProgress, ReviewRun, ReviewSkip, ReviewState, Severity };

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  draft: boolean;
  author: string;
}

export interface ReviewInput {
  state: ReviewState | null;
  /** 现在在跑的那几条的进度（D417：一个会话可以同时跑两条，按 runId 分）。 */
  progresses?: ReviewProgress[];
  /** 一个会话最多同时在评几条（桥在帧里给的，跟 `MAX_RUNS_PER_SESSION` 对齐）。 */
  cap?: number;
  ocr: OcrStatus | null;
  installing: boolean;
  error: string;
  notGit: boolean;
  /**
   * 这个会话实际评的仓库根（大文件夹底下的那个仓库）；空串 = 还不知道 / 没有。
   *
   * 会话目录本身不是仓库时，这里就是用户选的那个子仓库；`repoPinned` 说明它是不是钉住的。
   */
  repo?: string;
  /** 上面那个目录是用户钉住的（而不是会话目录本身就是仓库）。 */
  repoPinned?: boolean;
  /** 面板自己记住的那几样（不属于桥的状态）。 */
  mode?: ReviewMode;
  /** `range` 的对照分支。 */
  base?: string;
  /** `range` 要评的那条分支（目标）。 */
  target?: string;
  commit?: string;
  /** `pr` 模式要评的 PR 号（字符串，输入框原样）。 */
  pr?: string;
  /** PR 那一格里的文字（可以是号，也可以是检索词）。 */
  prQuery?: string;
  /** 那个列表弹层现在开没开（面板会重画，状态得放在外面）。 */
  prMenuOpen?: boolean;
  prs?: PullRequest[];
  prsLoading?: boolean;
  prError?: string;
  model?: string;
  /**
   * 面板现在展开的是哪一次评审（`ReviewRun.id`，空串 = 停在记录列表）。
   *
   * 以前面板永远只画「最新那一次」，历史只能靠「清理历史」删除；现在历史是主体，
   * 所以「看哪一次」变成一个显式的东西 —— 它也决定意见、时间线、统计、模型名都取自哪条记录。
   */
  focus?: string;
  /** 每条记录那次用的模型怎么显示（app 查模型目录得到，按 run id 索引；查不到就不给）。 */
  modelLabels?: Record<string, string>;
}

/** 记录列表里的一张卡：`reviewView()` 算好文案，`renderReview()` 只负责画。 */
export interface ReviewRunCard {
  id: string;
  /** 「评什么」：`PR #683` / `工作区改动` / `HEAD ← main` / `提交 3fa9c21`。 */
  target: string;
  /** PR 标题或分支描述（没有就是空串）。 */
  title: string;
  status: string;
  running: boolean;
  /** ISO 时间（画的时候才转成本地时间）。 */
  when: string;
  durationMs: number | null;
  count: number;
  files: number;
  totalFiles: number;
  tokens: number;
  /** 这次用的模型展示名（空 = 老记录没记，界面显示 id）。 */
  model: string;
  /** `provider/id`（tooltip 用）。 */
  modelId: string;
  /** 失败 / 中断的原因（`errorText()` 已翻好中文）。 */
  error: string;
  /** 跑着的时候的实时进度（每条在跑的卡各有各的；D417 之前只有最新那条有）。 */
  live: { reviewed: number; total: number; current: string } | null;
}

export type ReviewPhase = "loading" | "no-ocr" | "not-git" | "empty" | "running" | "done" | "stopped" | "failed" | "stale";

export interface ReviewView {
  phase: ReviewPhase;
  running: boolean;
  canRun: boolean;
  /** 这个会话现在有几条在跑（D417 起可能是 2）。 */
  runningCount: number;
  /** 跑满了额度：按钮要灰，并说清上限。 */
  atCap: boolean;
  cap: number;
  /** 评的是哪个仓库根（空串 = 还没有）。 */
  repo: string;
  /** 那个仓库的显示名（路径最后一节）。 */
  repoName: string;
  /** 是用户钉住的（可以拔），还是就是会话目录。 */
  repoPinned: boolean;
  needsInstall: boolean;
  needsUpgrade: boolean;
  /** 完成但一条意见都没有：要明说「评过，没问题」，而不是空白。 */
  empty: boolean;
  error: string;
  serverVersion: string;
  /** 正在装 ocr：面板要说「正在装…」而不是把按钮再摆出来。 */
  installing: boolean;
  mode: ReviewMode;
  base: string;
  target: string;
  commit: string;
  pr: string;
  /** 按 `prQuery` 过滤之后的 PR 列表。 */
  prs: PullRequest[];
  prAll: number;
  prQuery: string;
  prMenuOpen: boolean;
  /** 时间线：桥每做一件事加一行。`group` = 属于第几组（准备阶段的没有）。 */
  timeline: { at: number; text: string; group?: number }[];
  group: { index: number; total: number } | null;
  /** 分组计划：每组几个文件、出了几条、跑没跑完（老桥没有，就是空数组）。 */
  plan: ReviewGroupPlan[];
  /** PR 的标题（`pr` 模式才有）。 */
  prTitle: string;
  prHead: string;
  prBase: string;
  /** 这一次跑了多久（跑着时按现在算）。 */
  elapsedMs: number | null;
  /** 有没有「这一次」可看：（正在跑也算）。 */
  hasRun: boolean;
  prsLoading: boolean;
  prError: string;
  /** 这个模式下该填的那一格空着：按钮要点不着。 */
  missing: boolean;
  model: string;
  progress: { totalFiles: number; reviewedFiles: number; currentFile: string; tokens: number } | null;
  meta: { files: number; reviewed: number; skipped: number; unresolved: number; tokens: number; durationMs: number | null; when: string } | null;
  groups: { path: string; worst: Severity; findings: ReviewFinding[] }[];
  severity: Record<Severity, number>;
  skipped: ReviewSkip[];
  resolved: number;
  resolvedPaths: string[];
  history: number;
  /** 现在展开的那一次（空串 = 记录列表）。 */
  focus: string;
  /** 记录列表，**新的在前**（面板从上往下画就是这个顺序）。 */
  runs: ReviewRunCard[];
  /** 展开的那一次用的模型（展示名 / `provider/id`）：详情里要写清「这次」是谁评的。 */
  activeModel: string;
  activeModelId: string;
  /** 展开的那一次的「评什么」（自己那条记录的目标，不是面板上现在选的目标）。 */
  activeTarget: string;
  /** 按钮为什么点不着（有值就画在按钮旁边；空串 = 不是缺东西造成的）。 */
  missingWhy: string;
  /** 这次评审碰到过多少文件（进度帧没了之后仍然要能画分段条与「N / M 个文件」）。 */
  runFiles: { reviewed: number; total: number; tokens: number };
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * 从用户输入里认出 PR 号：`#658` / `658` / `https://github.com/o/r/pull/658` 都算。
 *
 * **不能**直接 `raw.replace(/[^0-9]/g, "")` —— GitHub 链接里有账号名（`Yang-Code01`），
 * 那样会拼出 `01658`，于是 `gh pr view 1658` 报 "could not resolve to a PullRequest"（用户实测踩到）。
 */
export function parsePrNumber(raw: string): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const fromUrl = /\/pull\/(\d+)/i.exec(text);
  if (fromUrl) return Number(fromUrl[1]) || null;
  const bare = /^#?\s*(\d+)\s*$/.exec(text);
  return bare ? Number(bare[1]) || null : null;
}

/** 从一段粘贴的 GitHub 链接里认出 `owner/repo`（认不出就给空串）。 */
export function repoFromUrl(raw: string): string {
  const text = (raw ?? "").trim();
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+)(?:[/.]|$)/i.exec(text);
  return m ? `${m[1]}/${m[2]}`.replace(/\.git$/i, "").toLowerCase() : "";
}

/**
 * 桥带回来的 `errorCode` 才是给用户看的那句话（中文兜底只留给认不出的码）：
 * 直接画 `run.error` 会让英文 / 日文界面里冒出一句桥写死的中文。
 */
function errorText(run: ReviewRun | null, fallback: string): string {
  const code = (run?.errorCode || "").trim();
  const known: Record<string, string> = {
    stopped: tr("已停止"),
    "bridge-restart": tr("桥重启了，这次评审没跑完。重跑一次就行。"),
    busy: tr("这个会话已经有两个在评了，先停一个再开"),
    dup_pr: tr("这个会话已经在评这个 PR 了"),
    not_git: tr("这个目录不是 git 仓库，没有东西可评。"),
    ocr_missing: tr("没装 ocr（代码评审要用）"),
    ocr_too_old: tr("ocr 版本太老，需要 1.9.0 以上"),
    ocr_failed: tr("ocr 出错，没能说清这次要评哪些文件"),
    child_failed: tr("评审进程挂了"),
    timeout: tr("评审超时了"),
    cancelled: tr("已停止"),
    not_reported: tr("模型没交代这个文件"),
  };
  if (code && known[code]) {
    const detail = (run?.error || "").trim();
    return detail && detail !== known[code] ? known[code] + tr("：{p1}", { p1: detail }) : known[code];
  }
  return (run?.error || fallback || "").trim();
}

const asRun = (s: ReviewState | null): ReviewRun | null => {
  if (!s || !Array.isArray(s.runs) || !s.runs.length) return null;
  return s.runs[s.runs.length - 1];
};

const durationOf = (run: ReviewRun): number | null => {
  const from = Date.parse(run.startedAt ?? "");
  const to = Date.parse(run.finishedAt ?? "");
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
};

/** 这次评审「评的是什么」——记录卡第一行与详情抬头都用它，而不是面板上现在还选着的目标。 */
export function runTarget(run: ReviewRun): string {
  if (run.mode === "pr") return run.pr > 0 ? `PR #${run.pr}` : tr("GitHub PR");
  if (run.mode === "commit") return tr("提交 {p1}", { p1: (run.to || "?").slice(0, 7) });
  // 分支名可能是 `origin/main` 这种；卡片上只容纳一句话，去掉远程前缀（不是本机分支就换个地方看）。
  if (run.mode === "range") return `${shortRef(run.to) || "HEAD"} ← ${shortRef(run.from) || "?"}`;
  return tr("工作区改动");
}

/** `origin/main` → `main`（只用于显示）。 */
const shortRef = (ref: string): string => (ref || "").trim().replace(/^origin\//, "");

/**
 * 目录的显示名：路径最后一节（`D:/work/erp/api` → `api`）。
 *
 * 盘根（`D:/`）这种没有最后一节的，整条路径就是名字 —— 否则 chip 会变成空白。
 */
export function repoNameOf(dir: string): string {
  const raw = (dir || "").trim();
  const text = raw.replace(/[\\/]+$/, "");
  if (!text) return "";
  // 盘根（`E:/`）去掉尾斜杠就只剩 `E:`，那一节不是目录名：原样交回去。
  if (/^[a-zA-Z]:$/.test(text)) return raw || text;
  const cut = text.split(/[\\/]/).pop() ?? "";
  return cut || text;
}

/** 灰按钮旁边那句「还差什么」——没有就回空串。 */
function missingHint(mode: ReviewMode): string {
  if (mode === "pr") return tr("先选一个 PR（或填个号）");
  if (mode === "commit") return tr("先填一个提交号");
  if (mode === "range") return tr("两边分支都选一下");
  return "";
}

/** 那次用的模型的完整标识（`provider/id`，老记录没有 provider 就只是 id）。 */
export function runModelId(run: ReviewRun): string {
  const model = (run.model || "").trim();
  const provider = (run.provider || "").trim();
  return model && provider ? `${provider}/${model}` : model;
}

/**
 * 桥的状态 → 面板要显示的东西。
 *
 * 排法：文件按「最坏事的那条」从重到轻；同一文件里也按严重度；同为严重度时能定位的按行号、
 * 定位不到的（`start_line: 0`）排最后 —— 它们是「说不清在哪」的那批，不该插在精确意见之间。
 */
export function reviewView(input: ReviewInput): ReviewView {
  const ocr = input.ocr;
  const state = input.state;
  // 记录按时间正序落盘；面板从新到旧画，所以这里先翻过来，画的时候不用再想顺序。
  const allRuns = Array.isArray(state?.runs) ? state.runs : [];
  const latest = asRun(state);
  // 面板展开的那一次；认不出来（记录被裁掉了 / 换了会话 / 刷新后不记得了）就回落到最新那一次。
  const focused = input.focus ? allRuns.find((r) => r.id === input.focus) ?? null : null;
  const active = focused ?? latest;
  const activeRunning = Boolean(active && active.status === "running");
  // D417：一个会话可以同时跑两条，每条一帧进度 —— 按 runId 认，别再拿「最新那条」顶替。
  const progresses = Array.isArray(input.progresses) ? input.progresses : [];
  const progressById = new Map(progresses.map((item) => [item.runId, item]));
  // 实时帧只属于「展开且还在跑」的那一次：翻旧记录时不能拿别人的意见冒充那一次的结果。
  const live = activeRunning && active ? progressById.get(active.id) ?? null : null;
  const marks = state?.marks ?? {};
  const running = activeRunning;
  const cap = Math.max(1, Number(input.cap) || 2);
  const runningCount = allRuns.filter((r) => r.status === "running").length;
  const atCap = runningCount >= cap;
  const labels = input.modelLabels ?? {};
  // 「评审仓库」：可能就与会话目录重合（没钉），也可能是大文件夹底下选中的那个子仓库。
  const repo = (input.repo ?? "").trim();

  const needsInstall = Boolean(ocr && !ocr.installed);
  const needsUpgrade = Boolean(ocr && ocr.installed && ocr.tooOld);

  let phase: ReviewPhase;
  // 「读状态」只在**一点信息都还没有**时出现：桥回了错、或者已经有评审记录，就不该死等 ocr 那一帧
  // （用户报过「一直显示在读评审状态」——正是 ocr 帧丢了之后永远停在这一屏）。
  if (input.notGit) phase = "not-git";
  else if (input.error && !active) phase = "failed";
  else if (!ocr && !active) phase = "loading";
  else if (needsInstall || needsUpgrade) phase = "no-ocr";
  else if (activeRunning) phase = "running";
  else if (!active) phase = "empty";
  else if (active.status === "done") phase = "done";
  else if (active.status === "stopped") phase = "stopped";
  else if (active.status === "stale") phase = "stale";
  else phase = "failed";

  // 有实时帧且它**带了** findings 字段（哪怕是空数组）就以它为准 —— 那才是这次跑出来的；
  // 字段缺省（老版桥）才回退到记录里那份。用「有没有这个字段」判，不拿长度判：
  // 长度为零时回退到旧记录，会把上一次的意见当成这一次的显示。
  const liveFindings = live?.findings;
  const findings = (liveFindings ?? active?.findings ?? []).map((f) => {
    const key = f.key || "";
    return { ...f, key, severity: f.severity ?? "low", mark: (f.mark || marks[key] || "") as Mark | "" };
  });

  const severity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) severity[f.severity] = (severity[f.severity] ?? 0) + 1;

  const byFile = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.path);
    if (list) list.push(f);
    else byFile.set(f.path, [f]);
  }
  const groups = [...byFile.entries()]
    .map(([path, list]) => {
      const sorted = [...list].sort((a, b) => {
        if (RANK[a.severity] !== RANK[b.severity]) return RANK[a.severity] - RANK[b.severity];
        const al = a.anchored === false || !a.startLine ? Number.POSITIVE_INFINITY : a.startLine;
        const bl = b.anchored === false || !b.startLine ? Number.POSITIVE_INFINITY : b.startLine;
        if (al !== bl) return al - bl;
        return a.key.localeCompare(b.key);
      });
      return { path, worst: sorted[0].severity, findings: sorted };
    })
    .sort((a, b) => (RANK[a.worst] !== RANK[b.worst] ? RANK[a.worst] - RANK[b.worst] : a.path.localeCompare(b.path)));

  // 没评的文件：preview 与模型各说一批，同一个文件只说一次（先到的那个原因算数）。
  const skipped: ReviewSkip[] = [];
  const seenSkip = new Set<string>();
  for (const item of active?.skipped ?? []) {
    const p = (item?.path ?? "").trim();
    if (!p || seenSkip.has(p)) continue;
    seenSkip.add(p);
    skipped.push({ path: p, reason: (item?.reason ?? "").trim() || "skipped" });
  }

  // 默认落在「GitHub PR」：从 PR 里挑一个来评是主要用法，另外三种范围是备选。
  const mode: ReviewMode = input.mode ?? "pr";
  const base = input.base ?? "main";
  const target = input.target ?? "HEAD";
  const commit = input.commit ?? "";
  const pr = String(input.pr ?? "").trim();
  const allPrs = Array.isArray(input.prs) ? input.prs : [];
  const prQuery = String(input.prQuery ?? "").trim();
  const q = prQuery.replace(/^#/, "").toLowerCase();
  const prs = q
    ? allPrs.filter((item) =>
        [`#${item.number}`, String(item.number), item.title, item.headRefName, item.baseRefName, item.author]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : allPrs;
  const missing =
    mode === "range" ? !target.trim() || !base.trim() : mode === "commit" ? !commit.trim() : mode === "pr" ? !pr : false;
  // 按钮灰着的时候得说清为什么：用户就是卡在一颗没解释的灰按钮上（报告的原话「不能评审了」）。
  // 填漏了先说填漏（补上就能开）；填齐了还被挡，才是额度用完了（D417）。
  const missingWhy = missing ? missingHint(mode) : atCap ? tr("已满 {p1} 个，先停一个再开", { p1: cap }) : "";
  const canRun = phase !== "loading" && phase !== "not-git" && phase !== "no-ocr" && !atCap && !input.installing && !missing;
  // 跑着看进度帧的日志，跑完看记录里存的那份（进度帧已经没了）。
  const log = (live?.log?.length ? live.log : active?.log ?? []).slice(-40);
  const group =
    live && live.groups ? { index: live.group || 0, total: live.groups } : null;
  const plan = [...(live?.plan?.length ? live.plan : active?.plan ?? [])];
  const startedAt = live?.startedAt || active?.startedAt || "";
  const elapsedMs = activeRunning
    ? Math.max(0, Date.now() - (Date.parse(startedAt) || Date.now()))
    : active
      ? durationOf(active)
      : null;

  const progress = live
    ? {
        totalFiles: live.totalFiles,
        reviewedFiles: live.reviewedFiles,
        currentFile: live.currentFile,
        tokens: live.tokens,
      }
    : null;

  const meta =
    active && !activeRunning && active.status !== "failed"
      ? {
          files: active.totalFiles ?? 0,
          reviewed: active.reviewedFiles ?? 0,
          skipped: skipped.length,
          unresolved: findings.filter((f) => !f.mark).length,
          tokens: active.tokens ?? 0,
          durationMs: durationOf(active),
          when: active.startedAt ?? "",
        }
      : null;

  // 记录列表：正在跑的置顶（同时跑的按开跑时间倒序），其余也按时间倒序。
  // 每张卡带上自己的实时进度。模型名由 app 查目录后传进来（视图不做目录查询，
  // 不然它的单测就得养一份假目录）。
  const ordered = [...allRuns].sort((a, b) => {
    const la = a.status === "running" ? 1 : 0;
    const lb = b.status === "running" ? 1 : 0;
    if (la !== lb) return lb - la;
    return (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0);
  });
  const runs: ReviewRunCard[] = ordered.map((run) => {
    const mine = run.status === "running" ? progressById.get(run.id) : undefined;
    const modelId = runModelId(run);
    return {
      id: run.id,
      target: runTarget(run),
      title: (run.pr ? run.prTitle : "").trim(),
      status: run.status,
      running: run.status === "running",
      when: run.startedAt ?? "",
      durationMs: durationOf(run),
      count: run.findings?.length ?? 0,
      files: run.reviewedFiles ?? 0,
      totalFiles: run.totalFiles ?? 0,
      tokens: run.tokens ?? 0,
      model: labels[run.id] ?? "",
      modelId,
      error: errorText(run, ""),
      live: mine ? { reviewed: mine.reviewedFiles, total: mine.totalFiles, current: mine.currentFile } : null,
    };
  });

  return {
    phase,
    running,
    canRun,
    runningCount,
    atCap,
    cap,
    repo,
    repoName: repoNameOf(repo),
    repoPinned: Boolean(repo) && input.repoPinned === true,
    needsInstall,
    needsUpgrade,
    empty: phase === "done" && findings.length === 0,
    error: errorText(active, input.error),
    serverVersion: ocr?.version ?? "",
    installing: input.installing,
    mode,
    base,
    target,
    commit,
    pr,
    prs,
    prAll: allPrs.length,
    prQuery,
    prMenuOpen: Boolean(input.prMenuOpen),
    timeline: log,
    group,
    plan,
    prTitle: active?.prTitle ?? "",
    prHead: active?.prHead ?? "",
    prBase: active?.prBase ?? "",
    elapsedMs,
    hasRun: Boolean(active),
    prsLoading: Boolean(input.prsLoading),
    prError: (input.prError ?? "").trim(),
    missing,
    missingWhy,
    model: input.model ?? active?.model ?? "",
    progress,
    meta,
    groups,
    severity,
    skipped,
    resolved: active?.resolved?.length ?? 0,
    resolvedPaths: active?.resolvedPaths ?? [],
    history: allRuns.length,
    focus: active && focused ? active.id : "",
    runs,
    activeModel: active ? labels[active.id] ?? active.model ?? "" : "",
    activeModelId: active ? runModelId(active) : "",
    activeTarget: active ? runTarget(active) : "",
    runFiles: {
      reviewed: active?.reviewedFiles ?? 0,
      total: active?.totalFiles ?? 0,
      tokens: active?.tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

export interface ReviewActions {
  onMode: (mode: ReviewMode) => void;
  onBase: (value: string) => void;
  onTarget: (value: string) => void;
  onPr: (value: string) => void;
  /** 输入框每敲一个字：只把值记下来（重画会让正在输入的框换节点、光标乱跳）。 */
  onPrInput: (value: string) => void;
  /** 重拉一次 PR 列表（`gh` 挂了 / 刚在 GitHub 上开了新 PR）。 */
  onRefreshPrs: () => void;
  /** PR 那一格里的文字（只记值，不重画，免得输入框换节点）。 */
  onPrQuery: (value: string) => void;
  /** 展开 / 收起 PR 列表。 */
  onPrMenu: (open: boolean) => void;
  /** 打开「评审详情」dialog（跑着看时间线，跑完看结果）。 */
  onDetails: () => void;
  onCommit: (value: string) => void;
  /** 打开「模型与思考」那个弹层（复用输入框那颗 chip 的同一个），挑评审用的模型。 */
  onPickModel: () => void;
  onRun: () => void;
  /** 停掉指定的那一条（D417 起每条在跑的记录各有自己的停止）。 */
  onStopRun: (runId: string) => void;
  onMark: (key: string, mark: Mark | "") => void;
  /** 开着分支工作台「差异」页签并定位到这一行。 */
  onOpen: (path: string, line: number) => void;
  /** 把这条意见连同位置送进输入框（不自动发送）。 */
  onFix: (finding: ReviewFinding) => void;
  /** 「一键交给 agent」：一批意见合成一段话（全部 / 按严重度）。 */
  onFixMany: (findings: ReviewFinding[]) => void;
  /** 打开「PR 信息」dialog。 */
  onPrInfo: () => void;
  onInstall: () => void;
  /** 点开某一次记录（`ReviewRun.id`）。 */
  onOpenRun: (runId: string) => void;
  /** 从某一次记录回到列表。 */
  onBack: () => void;
  /** 打开「评审仓库」选择器：换一个（子）仓库来评。 */
  onPickRepo: () => void;
  /** 拔掉钉子，回到跟着会话目录走。 */
  onClearRepo: () => void;
}

export interface ReviewPanelInput {
  view: ReviewView;
  /** 面板上那颗模型 chip 的文字（空 = 还没选，按设置里的默认走）。 */
  modelName: string;
  /** chip 的 tooltip：`provider/id`。 */
  modelId: string;
  refs: string[];
  installLog: string[];
  markLabels: Record<Mark, string>;
  severityLabels: Record<Severity, string>;
  actions: ReviewActions;
}

const duration = (ms: number | null): string => {
  if (ms === null) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return tr("{p1} 秒", { p1: sec });
  return tr("{p1} 分 {p2} 秒", { p1: Math.floor(sec / 60), p2: sec % 60 });
};

/** 一条意见的位置：`path:line`，定位不到的只写路径。 */
const placeOf = (f: ReviewFinding): string => (f.anchored && f.startLine ? `${f.path}:${f.startLine}` : f.path);

function severityBadge(sev: Severity, labels: Record<Severity, string>): HTMLElement {
  return el("span", `rv-sev ${sev}`, labels[sev] ?? sev);
}

/**
 * 面板主体。所有判断都在 `reviewView()` 里做完了，这里只是照着画 —— 所以它不需要单测，
 * 端到端由 `probes/code-review.mjs` 盯着。
 */
/**
 * 意见那一整块（已解决 / 空态 / 没评的文件 / 按文件分组的一行一条）。
 * 面板与「评审详情」dialog 共用同一份，宽度不同只是 CSS 的事。
 */
export function renderFindings(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  // `rv-scope` 是面板与 dialog 共用的样式域：同一份意见在两处长得一样
  // （以前样式全挂在 `.review` 上，dialog 里的意见行就成没样式的一坨）。
  const root = el("div", "rv-findings rv-scope");
  // ---- 已解决：只给个数会让人问「哪几条」，把文件列出来
  if (view.resolvedPaths.length) {
    const box = el("details", "rv-skipped") as HTMLDetailsElement;
    box.append(el("summary", "", tr("已解决 {p1} 条", { p1: view.resolved })));
    for (const p of view.resolvedPaths) box.append(el("div", "rv-skip-row", p));
    root.append(box);
  }

  // ---- 空态
  if (view.empty) {
    root.append(el("div", "empty", tr("评过了，一条意见都没有。"))) ;
  }

  // ---- 没评的文件（先摆出来：不许让人以为评全了）
  if (view.skipped.length) {
    const box = el("details", "rv-skipped") as HTMLDetailsElement;
    box.append(el("summary", "", tr("{p1} 个文件没评", { p1: view.skipped.length })));
    for (const item of view.skipped) {
      const row = el("div", "rv-skip-row");
      row.append(el("code", "", item.path), el("span", "rv-why", item.reason));
      box.append(row);
    }
    root.append(box);
  }

  // ---- 意见：文件分组 + 一行一条
  for (const group of view.groups) {
    const box = el("div", "rv-file");
    const head = el("div", "rv-file-head");
    head.append(el("code", "", group.path), el("span", "rv-count", String(group.findings.length)));
    box.append(head);

    for (const f of group.findings) {
      const row = el("div", "rv-finding");
      row.dataset.key = f.key;
      row.dataset.sev = f.severity;
      const line = el("button", "rv-line") as HTMLButtonElement;
      line.type = "button";
      line.append(severityBadge(f.severity, input.severityLabels));
      line.append(el("span", "rv-text", f.content));
      if (f.mark) line.append(el("span", "rv-mark", input.markLabels[f.mark]));
      if (f.state === "persisting") line.append(el("span", "rv-persist", tr("上次就有")));
      line.onclick = () => {
        const open = row.classList.toggle("open");
        body.hidden = !open;
      };
      row.append(line);

      const body = el("div", "rv-body");
      body.hidden = true;
      const place = el("button", "rv-place", placeOf(f)) as HTMLButtonElement;
      place.type = "button";
      place.onclick = () => actions.onOpen(f.path, f.anchored ? f.startLine : 0);
      body.append(place);
      if (f.existingCode) {
        const pre = el("pre", "rv-code");
        pre.textContent = f.existingCode;
        body.append(pre);
      }
      if (f.suggestionCode) {
        const pre = el("pre", "rv-code rv-sugg");
        pre.textContent = f.suggestionCode;
        body.append(pre);
      }
      const acts = el("div", "rv-acts");
      for (const [mark, label] of Object.entries(input.markLabels) as [Mark, string][]) {
        const btn = el("button", `btn ghost rv-mark-btn${f.mark === mark ? " on" : ""}`, label) as HTMLButtonElement;
        btn.type = "button";
        btn.onclick = () => actions.onMark(f.key, f.mark === mark ? "" : mark);
        acts.append(btn);
      }
      const fix = el("button", "btn ghost rv-fix", tr("交给 AI 修")) as HTMLButtonElement;
      fix.type = "button";
      fix.onclick = () => actions.onFix(f);
      acts.append(fix);
      body.append(acts);
      row.append(body);
      box.append(row);
    }
    root.append(box);
  }

  return root;
}

export function renderReview(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  const root = el("div", "review rv-scope");

  // ---- 控制条
  const form = el("div", "rv-form");

  const modeRow = el("div", "rv-row");
  const mode = el("select", "rv-mode") as HTMLSelectElement;
  // D417：跑着的时候这张表描述的是「下一条要评什么」，所以不再整张禁用。
  for (const [value, label] of [
    ["workspace", tr("工作区改动")],
    ["range", tr("分支 vs 主干")],
    ["commit", tr("单个提交")],
    ["pr", tr("GitHub PR")],
  ] as [ReviewMode, string][]) {
    const opt = el("option", "", label) as HTMLOptionElement;
    opt.value = value;
    if (value === view.mode) opt.selected = true;
    mode.append(opt);
  }
  mode.onchange = () => actions.onMode(mode.value as ReviewMode);
  modeRow.append(mode);

  const refSelect = (label: string, value: string, onPick: (v: string) => void): HTMLElement => {
    const row = el("div", "rv-row");
    row.append(el("span", "rv-lab", label));
    const pick = el("select", "rv-ref") as HTMLSelectElement;
    // HEAD 永远在第一项：评「当前」是最常见的用法，而它不在 refs 里。
    const values = ["HEAD", ...input.refs.filter((r) => r !== "HEAD")];
    for (const ref of values) {
      const opt = el("option", "", ref) as HTMLOptionElement;
      opt.value = ref;
      if (ref === value) opt.selected = true;
      pick.append(opt);
    }
    if (!values.includes(value) && value) {
      const opt = el("option", "", value) as HTMLOptionElement;
      opt.value = value;
      opt.selected = true;
      pick.append(opt);
    }
    pick.onchange = () => onPick(pick.value);
    row.append(pick);
    return row;
  };

  if (view.mode === "range") {
    form.append(refSelect(tr("目标分支"), view.target, actions.onTarget), refSelect(tr("对照分支"), view.base, actions.onBase));
  } else if (view.mode === "pr") {
    // 一个格子同时干三件事：输号、检索、从列表里点。分成「搜索框 + 下拉 + 号输入」三行
    // 在 300px 里又挤又丑（用户直接说了），所以合成一个 combobox。
    const box = el("div", "rv-prbox");
    const input = el("input", "rv-prq") as HTMLInputElement;
    // 选过就在框里显示 `#N`（用户要能看到「现在选的是哪个」），一聚焦就全选，接着打字即是搜索。
    input.value = view.prQuery || (view.pr ? `#${view.pr}` : "");
    input.placeholder = tr("输号或搜：号 / 标题 / 分支");
    input.autocomplete = "off";
    input.spellcheck = false;
    // 弹层里的行与「没匹配」那行，输入时只改可见性（重画会把焦点和滚动位置一起丢掉）。
    let menuRows: HTMLElement[] = [];
    let menuEmpty: HTMLElement | null = null;
    const filterMenu = (raw: string) => {
      if (!menuRows.length) return;
      // 纯数字当「号」处理：按号的前缀收窄（输 646 只剩 #646），而不是全文匹配
      // 也不是「什么都不筛」—— 后者会让「输号然后点第一条」点到别的 PR 上去。
      const chosenText = view.pr ? `#${view.pr}` : "";
      if (chosenText && raw.trim() === chosenText) {
        for (const row of menuRows) row.hidden = false;
        if (menuEmpty) menuEmpty.hidden = true;
        return;
      }
      const digits = /^\s*#?\s*(\d+)\s*$/.exec(raw);
      const q = (digits ? digits[1] : raw.replace(/^#/, "").trim()).toLowerCase();
      let shown = 0;
      for (const row of menuRows) {
        const hit = !q
          ? true
          : digits
            ? String(row.dataset.num ?? "").startsWith(q)
            : (row.dataset.search ?? "").includes(q);
        row.hidden = !hit;
        if (hit) shown += 1;
      }
      if (menuEmpty) menuEmpty.hidden = shown > 0;
    };
    input.oninput = () => {
      const raw = input.value;
      actions.onPrQuery(raw);
      // `#658` / `658` / GitHub 链接都能认出号来（链接里带账号名，不能只挑数字）。
      const asNumber = parsePrNumber(raw);
      actions.onPrInput(asNumber ? String(asNumber) : "");
      if (runBtn) runBtn.disabled = !asNumber;
      filterMenu(asNumber ? String(asNumber) : raw);
      actions.onPrMenu(true);
    };
    input.onfocus = () => {
      input.select();
      actions.onPrMenu(true);
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Escape") actions.onPrMenu(false);
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const first = view.prs[0];
      const parsed = parsePrNumber(input.value);
      if (parsed) actions.onPr(String(parsed));
      else if (first) actions.onPr(String(first.number));
      actions.onPrMenu(false);
    };
    const toggle = el("button", "rv-prtoggle", "▾") as HTMLButtonElement;
    toggle.type = "button";
    toggle.setAttribute("aria-label", tr("展开 PR 列表"));
    toggle.onclick = () => actions.onPrMenu(!view.prMenuOpen);
    box.append(input, toggle);
    form.append(box);

    if (view.prMenuOpen) {
      const menu = el("div", "rv-prmenu");
      if (view.prError) menu.append(el("div", "rv-hint", view.prError));
      else if (view.prsLoading) menu.append(el("div", "rv-hint", tr("正在拉 PR 列表…")));
      else if (!view.prs.length) menu.append(el("div", "rv-hint", view.prQuery ? tr("没有匹配的 PR") : tr("没有 open 的 PR")));
      else {
        menuEmpty = el("div", "rv-hint", tr("没有匹配的 PR"));
        menuEmpty.hidden = true;
        menu.append(menuEmpty);
        for (const item of view.prs.slice(0, 40)) {
          const row = el("button", `rv-prrow${String(item.number) === view.pr ? " on" : ""}`) as HTMLButtonElement;
          row.type = "button";
          row.dataset.num = String(item.number);
          row.dataset.search = [`#${item.number}`, String(item.number), item.title, item.headRefName, item.baseRefName, item.author]
            .join(" ")
            .toLowerCase();
          const head = el("span", "rv-prrow-head", `${item.draft ? tr("[草稿] ") : ""}#${item.number}`);
          const title = el("span", "rv-prrow-title", item.title);
          const meta = el("span", "rv-prrow-meta", `${item.headRefName} → ${item.baseRefName}`);
          row.append(head, title, meta);
          row.onclick = () => {
            actions.onPr(String(item.number));
            actions.onPrMenu(false);
          };
          menu.append(row);
          menuRows.push(row);
        }
        // 打开时可能已经带着检索词（先打字再展开 ▾）：按当前文字收窄一次。
        filterMenu(input.value);
      }
      form.append(menu);
    }
    if (!view.prMenuOpen) {
      const chosen = view.prs.find((item) => String(item.number) === view.pr) ?? null;
      if (chosen) {
        // 以前这里是一行淡字，没人看出能点（用户原话：「用户不知道」）。改成一张有边框的卡片，
        // 右边明写「详情 ›」，整张都能点。
        const picked = el("button", "rv-picked") as HTMLButtonElement;
        picked.type = "button";
        picked.title = `#${chosen.number} ${chosen.title}`;
        picked.onclick = () => actions.onPrInfo();
        const top = el("span", "rv-picked-top");
        top.append(el("span", "rv-picked-num", `#${chosen.number}`), el("span", "rv-picked-title", chosen.title));
        const bottom = el("span", "rv-picked-meta");
        bottom.append(el("span", "", `${chosen.headRefName} → ${chosen.baseRefName}`), el("span", "rv-picked-more", tr("详情 ›")));
        picked.append(top, bottom);
        form.append(picked);
      } else if (view.prAll > 1) {
        form.append(el("div", "rv-hint", tr("{p1} 个 open PR，可搜号 / 标题 / 分支", { p1: view.prs.length })));
      }
    }
  } else if (view.mode === "commit") {
    const sha = el("input", "rv-ref") as HTMLInputElement;
    sha.value = view.commit;
    sha.placeholder = tr("提交号");
    sha.onchange = () => actions.onCommit(sha.value.trim());
    modeRow.append(sha);
  }
  form.append(modeRow);

  const actRow = el("div", "rv-row");
  const model = el("button", "rv-model", input.modelName || tr("默认模型")) as HTMLButtonElement;
  model.type = "button";
  // D417：换模型只影响**下一条**（每条记录自己存一份 model/provider），所以跑着时也能换。
  model.title = input.modelId || tr("用设置里的默认模型");
  model.onclick = () => actions.onPickModel();
  actRow.append(model);

  let runBtn: HTMLButtonElement | null = null;
  // 一直是「开始评审」：跑着的时候它开的是**下一条**，停哪一条由记录卡上的「停止」决定（D417）。
  {
    const run = el("button", "btn rv-run", tr("开始评审")) as HTMLButtonElement;
    run.type = "button";
    run.disabled = !view.canRun;
    run.onclick = () => actions.onRun();
    runBtn = run;
    actRow.append(run);
  }
  form.append(actRow);
  // 按钮灰着就得说清为什么 —— 用户就是卡在这颗没解释的灰按钮上（「不能评审了」）。
  // 只解释「某一格没填」这一种灰：没装 ocr / 不是 git 仓库 / 正在读 / 正在跑，各有自己的块，
  // 在这里再补一句会与它们打架（同一句话在两处出现，等于两处都没人看）。
  if ((view.missing || view.atCap) && view.missingWhy && !["no-ocr", "not-git", "loading"].includes(view.phase)) {
    form.append(el("div", "rv-hint rv-why", view.missingWhy));
  }
  // 模式下拉钉在最上面：PR / 分支那些行是后加的，不 reorder 就会把它挤到下面去。
  form.prepend(modeRow);
  // ---- 评审仓库：评的是哪一个目录（大文件夹底下的子仓库就靠这一行换）
  // 没仓库时这一行不画：not-git 那一块自己带「选一个仓库」的按钮，两处都摆只会更乱。
  // 也要避开 not-git：那一屏的 `repo` 是桥回引的会话目录（解析失败也会带回来），
  // 拿它当 chip 会把「这里不是仓库」和「评审仓库：文件夹名」同时写在脸上。
  if (view.repo && view.phase !== "not-git") {
    const repoRow = el("div", "rv-repo");
    repoRow.append(el("span", "rv-repo-lab", tr("评审仓库")));
    const chip = el("button", "rv-repo-chip", view.repoName) as HTMLButtonElement;
    chip.type = "button";
    chip.title = `${view.repo}\n${tr("点一下换一个仓库")}`;
    chip.onclick = () => actions.onPickRepo();
    repoRow.append(chip);
    if (view.repoPinned) {
      const clear = el("button", "rv-repo-x", "×") as HTMLButtonElement;
      clear.type = "button";
      clear.title = tr("回到会话目录");
      clear.setAttribute("aria-label", tr("回到会话目录"));
      clear.onclick = () => actions.onClearRepo();
      repoRow.append(clear);
    }
    root.append(repoRow);
  }
  root.append(form);

  if (view.phase === "loading") root.append(el("div", "rv-hint", tr("正在读评审状态…")));

  // ---- 装 ocr
  if (view.phase === "no-ocr") {
    const box = el("div", "rv-install");
    box.append(
      el(
        "div",
        "rv-hint",
        view.needsUpgrade
          ? tr("ocr 版本太老（{p1}），代码评审要 1.9.0 以上。", { p1: view.serverVersion || "?" })
          : tr("还没装 ocr（阿里巴巴开源的代码评审 CLI），装好就能评。"),
      ),
    );
    if (view.installing) {
      box.append(el("div", "rv-hint", tr("正在装…")));
      const log = el("pre", "rv-log");
      log.textContent = input.installLog.slice(-8).join("\n");
      box.append(log);
    } else {
      const install = el("button", "btn rv-install-btn", tr("装 ocr")) as HTMLButtonElement;
      install.type = "button";
      install.onclick = () => actions.onInstall();
      box.append(install);
      box.append(el("code", "rv-cmd", "npm i -g @alibaba-group/open-code-review"));
    }
    root.append(box);
  }

  // ---- 不是 git 仓库
  if (view.phase === "not-git") {
    // 以前这里只有一句「没有东西可评」，人就卡死了：大文件夹底下的仓库当初根本没地方可选。
    const box = el("div", "rv-notgit");
    box.append(el("div", "empty", tr("这个目录不是 git 仓库，没有东西可评。")));
    box.append(el("div", "rv-hint", tr("它的子目录里如果有仓库，选一个来评审。")));
    const pick = el("button", "btn rv-pickrepo", tr("选一个仓库")) as HTMLButtonElement;
    pick.type = "button";
    pick.onclick = () => actions.onPickRepo();
    box.append(pick);
    root.append(box);
    return root;
  }

  // ---- 主体：要么是「这个会话评过哪些次」，要么是点开的那一次
  if (view.focus) root.append(renderFocusedRun(input));
  else root.append(renderRunList(input));

  // ---- 来源说明：评审内核不是本仓库自研，别让人以为是
  const credit = el("div", "rv-credit");
  credit.append(
    el("span", "", tr("评审内核：阿里巴巴开源的 open code review（ocr）")),
    el("span", "", tr("以后会接入更多评审方式")),
  );
  root.append(credit);

  return root;
}

/** 记录卡上的状态词（讲的是那一次自己的结局，与面板当前 phase 无关）。 */
function runStatusText(card: ReviewRunCard): string {
  if (card.running) return tr("运行中");
  if (card.status === "done") return tr("完成");
  if (card.status === "stopped") return tr("已停止");
  if (card.status === "stale") return tr("没跑完");
  return tr("失败");
}

/** 时间：今天的只给时:分，更早的把日期也带上（跨天的记录不能只给一个 09:58）。 */
function whenText(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const at = new Date(ts);
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? fmtTime(at) : `${fmtDate(at)} ${fmtTime(at)}`;
}

/** 卡的第二行：状态 · 意见数 · 用时 · 文件数 · 模型（模型带 tooltip 写全 `provider/id`）。 */
function runMetaRow(card: ReviewRunCard): HTMLElement {
  const meta = el("div", "rv-run-meta");
  meta.append(el("span", `rv-run-status ${card.running ? "running" : card.status}`, runStatusText(card)));
  const bits: string[] = [];
  if (card.running && card.live) {
    bits.push(tr("{p1}/{p2} 个文件", { p1: card.live.reviewed, p2: card.live.total }));
  } else {
    bits.push(tr("{p1} 条意见", { p1: card.count }));
    const took = duration(card.durationMs);
    if (took) bits.push(took);
    if (card.files) bits.push(tr("{p1} 个文件", { p1: card.files }));
  }
  for (const bit of bits) meta.append(el("span", "rv-run-bit", bit));
  const model = card.model || card.modelId;
  if (model) {
    const chip = el("span", "rv-run-model", model);
    chip.title = card.modelId || model;
    meta.append(chip);
  } else {
    // 老记录没记模型：不要装作知道，写清楚「没记」。
    meta.append(el("span", "rv-run-model none", tr("没记模型")));
  }
  return meta;
}

/** 记录列表：一条一张卡，新的在上（view.runs 已经是新在前）。 */
function renderRunList(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  const box = el("div", "rv-runs");
  const head = el("div", "rv-runs-head");
  head.append(
    el(
      "span",
      "",
      view.runs.length
        ? view.runningCount > 0
          ? tr("评过 {p1} 次 · {p2} 个在跑", { p1: view.runs.length, p2: view.runningCount })
          : tr("这个会话评过 {p1} 次", { p1: view.runs.length })
        : tr("还没有评审记录"),
    ),
    el("span", "rv-runs-hint", view.runs.length ? tr("点一条展开") : ""),
  );
  box.append(head);
  if (!view.runs.length) {
    box.append(el("div", "rv-hint", tr("上面选好范围、点「开始评审」，结果会记在这里。")));
    return box;
  }
  for (const card of view.runs) {
    const cls = ["rv-run-card", card.running ? "is-live" : "", card.status === "failed" ? "is-fail" : ""]
      .filter(Boolean)
      .join(" ");
    // 卡片里要放「停止」这颗按钮，所以不能再整个是 `<button>`（按钮里套按钮点起来会乱）。
    const row = el("div", cls);
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.onclick = () => actions.onOpenRun(card.id);
    row.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      actions.onOpenRun(card.id);
    };

    const top = el("div", "rv-run-top");
    top.append(el("span", "rv-run-target", card.target));
    if (card.title) top.append(el("span", "rv-run-title", card.title));
    top.append(el("span", "rv-run-at", whenText(card.when)));
    row.append(top, runMetaRow(card));

    if (card.running && card.live?.current) row.append(el("div", "rv-run-current", card.live.current));
    if (card.error && !card.running) row.append(el("div", "rv-run-err", card.error));
    if (card.running) {
      const stop = el("button", "rv-run-stop", tr("停止")) as HTMLButtonElement;
      stop.type = "button";
      stop.title = tr("只停这一条");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        actions.onStopRun(card.id);
      };
      row.append(stop);
    }
    box.append(row);
  }
  return box;
}

/** 点开的那一次：抬头（返回 / 评什么 / 完整详情）+ 那一次的统计与意见。 */
function renderFocusedRun(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  const box = el("div", "rv-focus");
  const card = view.runs.find((item) => item.id === view.focus) ?? null;

  const head = el("div", "rv-focus-head");
  const back = el("button", "rv-back", tr("‹ 记录")) as HTMLButtonElement;
  back.type = "button";
  back.title = tr("回到这个会话的评审记录");
  back.onclick = () => actions.onBack();
  const target = el("span", "rv-focus-target", card?.target || view.activeTarget);
  const more = el("button", "rv-focus-more", tr("完整详情 ›")) as HTMLButtonElement;
  more.type = "button";
  more.onclick = () => actions.onDetails();
  head.append(back, target, more);
  if (card?.running) {
    // 展开的那一条没在列表里露脸（列表被换成了这一页），停止得跟过来，不然点了展开就没法停。
    const stop = el("button", "rv-focus-stop", tr("停止")) as HTMLButtonElement;
    stop.type = "button";
    stop.onclick = () => actions.onStopRun(card.id);
    head.append(stop);
  }
  box.append(head);

  // 第二行写清这次是谁评的、什么时候、跑多久 —— 记录卡的价值就在这些「详细信息」。
  if (card) {
    box.append(runMetaRow(card));
    if (card.title) box.append(el("div", "rv-focus-title", card.title));
    const modelText = card.model || card.modelId;
    if (modelText) {
      // 先给目录里的名字（`hy4flash · x0.03 · 960K`），hover 能看到那个 id；老记录只有 id 就直接写 id。
      const line = el("div", "rv-focus-model", tr("这次用的模型：{p1}", { p1: modelText }));
      line.title = card.modelId || modelText;
      box.append(line);
    }
  }

  // ---- 进度 / 统计
  if (view.running && view.progress) {
    const p = view.progress;
    const line = el("div", "rv-progress");
    line.append(el("span", "rv-meta", tr("评审中 · {p1}/{p2} 个文件", { p1: p.reviewedFiles, p2: p.totalFiles })));
    if (p.currentFile) line.append(el("span", "rv-current", p.currentFile));
    box.append(line);
  } else if (view.meta) {
    const parts = [
      tr("{p1} 个文件", { p1: view.meta.files }),
      view.meta.skipped ? tr("{p1} 个没评", { p1: view.meta.skipped }) : "",
      duration(view.meta.durationMs),
      view.meta.tokens ? tr("{p1} tokens", { p1: view.meta.tokens }) : "",
      view.resolved ? tr("已解决 {p1} 条", { p1: view.resolved }) : "",
    ].filter(Boolean);
    box.append(el("div", "rv-meta", parts.join(" · ")));
  }

  // ---- 时间线（面板里只留最后几行，完整的那份在「评审详情」浮层里）
  if (view.timeline.length) box.append(renderTimeline(view, 4));

  // ---- 失败 / 停止 / 失效
  if (view.phase === "failed" && view.error) {
    box.append(el("div", "rv-error", view.error));
  } else if (view.phase === "stopped") {
    box.append(el("div", "rv-hint", tr("这次没跑完就停了，已经收到的意见在下面。")));
  } else if (view.phase === "stale") {
    box.append(el("div", "rv-hint", tr("桥重启了，这次评审没跑完。重跑一次就行。")));
  }

  box.append(renderFindings(input));
  return box;
}

/** 把一条意见折成送进输入框的一段话（不自动发送）。 */
/** 时间线：面板里截最后几行，详情 dialog 给全量。 */
export function renderTimeline(view: ReviewView, limit = 0): HTMLElement {
  const list = limit > 0 ? view.timeline.slice(-limit) : view.timeline;
  const box = el("div", "rv-timeline");
  if (!list.length) {
    box.append(el("div", "rv-hint", tr("还没有进度")));
    return box;
  }
  for (const item of list) {
    const row = el("div", "rv-tl");
    row.append(el("span", "rv-tl-dot"), el("span", "rv-tl-at", fmtTime(item.at)), el("span", "rv-tl-text", item.text));
    box.append(row);
  }
  return box;
}

/** 「交给 agent」时那段话要带的上下文：哪个仓库、哪个 PR / 分支。 */
export interface FixContext {
  repo?: string;
  pr?: number;
  prTitle?: string;
  prHead?: string;
  prBase?: string;
  mode?: ReviewMode;
  /** `range`/`commit` 模式下的两侧描述。 */
  from?: string;
  to?: string;
}

const SEVERITY_NAME: Record<Severity, () => string> = {
  critical: () => tr("严重"),
  high: () => tr("高"),
  medium: () => tr("中"),
  low: () => tr("低"),
};

/** 一段「这条意见在哪个 PR / 分支上」的抬头，让 agent 找得到地方。 */
function whereText(ctx?: FixContext): string {
  if (!ctx) return "";
  const bits: string[] = [];
  if (ctx.repo) bits.push(tr("仓库：{p1}", { p1: ctx.repo }));
  if (ctx.pr) {
    const title = ctx.prTitle ? ` ${ctx.prTitle}` : "";
    const refs = ctx.prHead || ctx.prBase ? tr("（{p1} → {p2}）", { p1: ctx.prHead || "?", p2: ctx.prBase || "?" }) : "";
    bits.push(tr("PR #{p1}{p2}{p3}", { p1: ctx.pr, p2: title, p3: refs }));
  } else if (ctx.mode === "range") {
    bits.push(tr("分支：{p1} → {p2}", { p1: ctx.to || "HEAD", p2: ctx.from || "?" }));
  } else if (ctx.mode === "commit") {
    bits.push(tr("提交：{p1}", { p1: ctx.to || "" }));
  } else if (ctx.mode === "workspace") {
    bits.push(tr("工作区改动（HEAD 之前）"));
  }
  if (ctx.from && ctx.to && ctx.mode === "pr" && !ctx.prHead) bits.push(`${ctx.from} → ${ctx.to}`);
  return bits.join(tr("；"));
}

/**
 * 把一条意见折成送进输入框的一段话（不自动发送）。
 *
 * 两个要点：①抬头写明**哪个 PR / 哪条分支**，agent 才知道去哪儿看；
 * ②明确要求它先判断这条意见**是否真的成立** —— 评审是模型给的，会有误报。
 */
export function fixPrompt(f: ReviewFinding, ctx?: FixContext): string {
  const head = f.anchored ? `${f.path}:${f.startLine}` : f.path;
  const where = whereText(ctx);
  const lines: string[] = [];
  lines.push(where ? tr("代码评审意见（{p1}）", { p1: where }) : tr("代码评审意见"));
  lines.push("");
  lines.push(tr("{p1} · {p2} · {p3}", { p1: head, p2: SEVERITY_NAME[f.severity](), p3: f.category }));
  lines.push(f.content);
  if (f.existingCode) lines.push("", tr("命中的代码："), "```", f.existingCode, "```");
  if (f.suggestionCode) lines.push("", tr("建议的改法："), "```", f.suggestionCode, "```");
  lines.push(
    "",
    tr("先判断这条意见是否真的成立（对着改动读一遍相关代码）：不成立就说明理由、不要改代码；成立再动手，并说明改了什么。"),
  );
  return lines.join("\n");
}

/**
 * 「一键交给 agent」：把一批意见合成一段话。按严重度筛选只是少写几条，开头同样要求逐条核实。
 */
export function fixPromptMany(findings: readonly ReviewFinding[], ctx?: FixContext): string {
  const where = whereText(ctx);
  const lines: string[] = [];
  lines.push(where ? tr("代码评审意见（{p1}）", { p1: where }) : tr("代码评审意见"));
  lines.push(tr("一共 {p1} 条，逐条核实并处理：", { p1: findings.length }));
  for (const [i, f] of findings.entries()) {
    const head = f.anchored ? `${f.path}:${f.startLine}` : f.path;
    lines.push(`${i + 1}. ${head} · ${SEVERITY_NAME[f.severity]()} · ${f.category} — ${f.content}`);
    if (f.existingCode) lines.push("   ```", ...f.existingCode.split("\n").map((l) => `   ${l}`), "   ```");
  }
  lines.push(
    "",
    tr("每条都先判断是否真的成立：不成立就说明理由、跳过；成立就修掉，并说明改了什么。不要为了对齐意见而改无关代码。"),
  );
  return lines.join("\n");
}

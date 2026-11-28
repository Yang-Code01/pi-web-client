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
import { icon, type IconName } from "./icons.ts";
import { renderGhCard, type GhCardActions, type GhCardData } from "./gh-setup.ts";

import { isRunOutdated, tipForRun } from "./frames.ts";
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
  /** 现在在跑的那几条的进度（D420：一个会话可以同时跑两条，按 runId 分）。 */
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
  /**
   * 人在下拉里**显式选**的那个账号（`accounts.json` 的会话映射）；空串 = 跟随工作区。
   *
   * 多账号机器上「机器 gh 登的是谁」和「这个会话该用谁」常常不是一个人：`ISID/cas3-onecas-api`
   * 那种私有仓，换个人就是 `Could not resolve to a Repository`（#17545）。所以号摆出来，也能换。
   */
  account?: string;
  /** 按当前设置**实际**用的号（会话 → 工作区 → 全局 → gh active）：跟随工作区时它通常非空。 */
  accountUsed?: string;
  /** 能切到的账号（没读到 / 只有一个时可以不画下拉）。 */
  accounts?: { login: string; pat: boolean }[];
  /**
   * 「gh 没就绪」那张卡（D428）。`null` = 还没探测到 / 已经就绪且人不再想看。
   * 数据来自 `GhSetupStore.card()`，这里只当一份普通输入往下传。
   */
  gh?: GhCardData | null;
  model?: string;
  /**
   * 「完整详情」浮层现在看的是哪一次评审（`ReviewRun.id`，空串 = 没开浮层，按最新那一次算）。
   *
   * 记录卡本身不再是入口（D429）：意见、时间线、统计、模型名只在浮层里出现，
   * 但浮层抬头必须按**点开的那张卡**写，而不是「最新那一次」—— 所以这个焦点还留着。
   */
  focus?: string;
  /** 每条记录那次用的模型怎么显示（app 查模型目录得到，按 run id 索引；查不到就不给）。 */
  modelLabels?: Record<string, string>;
  /**
   * 这些 ref 现在各指向哪个提交（#741，`review.state` 帧的兄弟字段）：key 是记录里的 `to`。
   *
   * 缺 key = 核对不了（未登未联网 / 离线 / `ls-remote` 超时 / 老桥不发这个字段），
   * 与「没变」必须分开 —— 少见到一个 key 就当不知道，不标。
   */
  tips?: Record<string, string>;
  /** 那张快照是什么时候拍的（`Date.now()`，0 = 桥没给）：比这条记录还旧的快照不拿来判。 */
  tipsAt?: number;
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
  /** 跑着的时候的实时进度（每条在跑的卡各有各的；D420 之前只有最新那条有）。 */
  live: { reviewed: number; total: number; current: string } | null;
  /** 这一次评到的那个提交（空串 = 没记 / 老记录）。 */
  headSha: string;
  /** 现在这个 ref 指向的提交（空串 = 没核对到）。 */
  tipSha: string;
  /** 评审之后又新提交了（#741）：卡片上多一颗标，底行多一颗「重新评审」。 */
  outdated: boolean;
  /** 那颗标的 hover：评的时候基于哪个提交、现在到哪个。 */
  outdatedNote: string;
  /** 底行那颗「重新评审」出现了但点不着时的那句人话（空 = 能点；它只在过时时出现）。 */
  rerunWhy: string;
}

export type ReviewPhase = "loading" | "no-ocr" | "not-git" | "empty" | "running" | "done" | "stopped" | "failed" | "stale";

export interface ReviewView {
  phase: ReviewPhase;
  running: boolean;
  canRun: boolean;
  /** 这个会话现在有几条在跑（D420 起可能是 2）。 */
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
  /** 在下拉里显式选中的账号（空串 = 跟随工作区）。 */
  account: string;
  /** 实际在用哪个号（跟随工作区时也非空，用来说人话）；空串 = 一个都没有。 */
  accountUsed: string;
  /** 能切到的账号（第一个是当前用的那个）。 */
  accounts: { login: string; pat: boolean }[];
  /** 见 `ReviewInput.gh`。 */
  gh: GhCardData | null;
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
  /** 「完整详情」浮层看的那一次（空串 = 按最新那一次算）。 */
  focus: string;
  /** 记录列表，**新的在前**（面板从上往下画就是这个顺序）。 */
  runs: ReviewRunCard[];
  /** 浮层看的那一次用的模型（展示名 / `provider/id`）：详情里要写清「这次」是谁评的。 */
  activeModel: string;
  activeModelId: string;
  /** 浮层看的那一次的「评什么」（自己那条记录的目标，不是面板上现在选的目标）。 */
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
    busy: tr("这个会话的评审额度满了，先停一个再开"),
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

/** 提交号只露 7 位：整条 sha 在 hover 里也装不下，比大小也不需要（浮层也用它）。 */
export const shortSha = (sha: string): string => (sha || "").trim().slice(0, 7);

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
  // 「完整详情」浮层看的那一次（D429 之后面板本身不再展开任何一次）；认不出来（记录被裁掉了 /
  // 换了会话 / 刷新后不记得了）就回落到最新那一次。
  const focused = input.focus ? allRuns.find((r) => r.id === input.focus) ?? null : null;
  const active = focused ?? latest;
  const activeRunning = Boolean(active && active.status === "running");
  // D420：一个会话可以同时跑两条，每条一帧进度 —— 按 runId 认，别再拿「最新那条」顶替。
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
  // 填漏了先说填漏（补上就能开）；填齐了还被挡，才是额度用完了（D420）。
  let missingWhy = "";
  if (missing) missingWhy = missingHint(mode);
  else if (atCap) missingWhy = tr("已满 {p1} 个，先停一个再开", { p1: cap });
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
  /**
   * 「重新评审」现在点了会不会被拒（提前拦：点了才报错最难堪）。
   *
   * 与主按钮同一套闸：同一 PR 在跑、额度满、以及 ocr 没就绪（那时主按钮是灰的，
   * 重评按钮没道理还能点 —— 点下去只会多一条失败的记录）。
   */
  const rerunBlocked = (run: ReviewRun): string => {
    if (run.mode === "pr" && run.pr > 0) {
      const same = allRuns.some((r) => r.status === "running" && r.mode === "pr" && r.pr === run.pr);
      if (same) return tr("这个会话已经在评这个 PR 了");
    }
    if (atCap) return tr("已满 {p1} 个，先停一个再开", { p1: cap });
    if (input.installing) return tr("正在装 ocr，装好再重评");
    if (needsInstall) return tr("没装 ocr（代码评审要用）");
    if (needsUpgrade) return tr("ocr 版本太老，需要 1.9.0 以上");
    return "";
  };

  const runs: ReviewRunCard[] = ordered.map((run) => {
    const mine = run.status === "running" ? progressById.get(run.id) : undefined;
    const modelId = runModelId(run);
    // #741：「过时」= 完成的那一次评的提交 ≠ 这个 ref 现在指向的提交。
    // 判据与桥共用一份（`frames.ts` 的 `tipForRun` / `isRunOutdated`）：没记 sha 的老记录、
    // 没核对到 tip 的（离线 / 超时）、以及**比这条记录还旧的快照**都在那里归成「不知道」= 不标。
    // 卡片上的 `tipSha`（hover / 详情那一行）也走同一个函数 —— 判据不许散成两份。
    const headSha = (run.headSha ?? "").trim();
    const tipSha = tipForRun(run, input.tips, input.tipsAt);
    // hover 里那条 ref 的名字：`pr` 模式下 `to` 是 `refs/pi-web/pr-7` 这种内部名字，
    // 人认的是分支名（`prHead`），没记就退回 ref 本身。
    const refLabel = run.mode === "pr" && run.prHead ? run.prHead : shortRef(run.to);
    const outdated = isRunOutdated(run, input.tips, input.tipsAt);
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
      headSha,
      tipSha,
      outdated,
      // hover 要说清「评的是哪个提交、哪条分支，现在到哪个」：`pr` 模式下 `to` 是
      // `refs/pi-web/pr-7` 这种内部 ref 名，人认的是分支名（`prHead`），没记才退回 ref 名。
      outdatedNote: outdated
        ? tr("评审基于 {p1} · {p2}，现在是 {p3}", { p1: shortSha(headSha), p2: refLabel, p3: shortSha(tipSha) })
        : "",
      // 灰着就说清为什么：同一个 PR 已在跑（`dup_pr`）、或会话额度满了（`busy`）——
      // 那是点了也只会吃一条报错的情形，不如提前拦下来。
      rerunWhy: outdated ? rerunBlocked(run) : "",
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
    gh: input.gh ?? null,
    account: (input.account ?? "").trim(),
    accountUsed: (input.accountUsed ?? "").trim(),
    accounts: input.accounts ?? [],
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
  /** 换一个 gh 账号查 PR（空串 = 回到「跟随工作区」）。 */
  onAccount: (login: string) => void;
  /** PR 那一格里的文字（只记值，不重画，免得输入框换节点）。 */
  onPrQuery: (value: string) => void;
  /** 展开 / 收起 PR 列表。 */
  onPrMenu: (open: boolean) => void;
  /** 打开「评审详情」dialog：看**这一条**（跑着看时间线，跑完看结果）。 */
  onDetails: (runId: string) => void;
  onCommit: (value: string) => void;
  /** 打开「模型与思考」那个弹层（复用输入框那颗 chip 的同一个），挑评审用的模型。 */
  onPickModel: () => void;
  onRun: () => void;
  /** 停掉指定的那一条（D420 起每条在跑的记录各有自己的停止）。 */
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
  /** 按那条记录自己的范围再评一次（#741：只在它过时的时候出现）。 */
  onRerun: (runId: string) => void;
  /** 重新核对一批记录有没有新提交（打开面板时本来就会核一次，这是兜底那颗）。 */
  onRefreshTips: () => void;
  onInstall: () => void;
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
  /** gh 卡的八颗动作：宿主直接给 `ghCardActions()`，面板不再自己映射一遍（评审 #33）。 */
  ghActions: GhCardActions;
  actions: ReviewActions;
}

const duration = (ms: number | null): string => {
  if (ms === null) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return tr("{p1} 秒", { p1: sec });
  return tr("{p1} 分 {p2} 秒", { p1: Math.floor(sec / 60), p2: sec % 60 });
};

/**
 * 面板主体。所有判断都在 `reviewView()` 里做完了，这里只是照着画 —— 所以它不需要单测，
 * 端到端由 `probes/code-review.mjs` 盯着。
 */

export function renderReview(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  const root = el("div", "review rv-scope");

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

  // ---- 评什么：四块磁贴（范围）+ 目标 + 模型/账号 + 全宽主按钮（D 方案）
  // 磁贴取代了原来的 `<select>`：四个范围是这一页唯一的“第一步”，摆成四块能一眼扫完；
  // 跑着的时候它们描述的是**下一条**，所以不整张禁用（D420）。
  const form = el("div", "rv-form");
  form.append(el("div", "rv-lead", tr("评什么")));

  const tiles = el("div", "rv-tiles");
  const modeBoard: { value: ReviewMode; label: string; hint: string; icon: IconName }[] = [
    { value: "workspace", label: tr("工作区改动"), hint: tr("HEAD 之前的改动"), icon: "pencil" },
    { value: "range", label: tr("分支 vs 主干"), hint: tr("两条分支之间"), icon: "branch" },
    { value: "commit", label: tr("单个提交"), hint: tr("一个提交"), icon: "commit" },
    { value: "pr", label: tr("GitHub PR"), hint: tr("GitHub 上 open 的 PR"), icon: "pr" },
  ];
  for (const item of modeBoard) {
    const on = view.mode === item.value;
    const tile = el("button", `rv-tile rv-mode${on ? " on" : ""}`) as HTMLButtonElement;
    tile.type = "button";
    tile.dataset.mode = item.value;
    tile.title = item.label;
    // `aria-pressed` 是这组磁贴的唯一状态来源：`selectOption()` 那种玩法换成页面里读属性即可。
    tile.setAttribute("aria-pressed", String(on));
    tile.append(icon(item.icon, { size: 15 }), el("span", "rv-tile-t", item.label), el("span", "rv-tile-s", on ? tileValue(view) || item.hint : item.hint));
    tile.onclick = () => actions.onMode(item.value);
    tiles.append(tile);
  }
  form.append(tiles);

  const target = el("div", "rv-target");
  const opts = el("div", "rv-opts");

  const refSelect = (label: string, value: string, onPick: (v: string) => void): HTMLElement => {
    const row = el("div", "rv-field");
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

  let runBtn: HTMLButtonElement | null = null;

  if (view.mode === "range") {
    target.append(refSelect(tr("目标分支"), view.target, actions.onTarget), refSelect(tr("对照分支"), view.base, actions.onBase));
  } else if (view.mode === "commit") {
    const sha = el("input", "rv-ref rv-sha") as HTMLInputElement;
    sha.value = view.commit;
    sha.placeholder = tr("提交号");
    sha.onchange = () => actions.onCommit(sha.value.trim());
    target.append(sha);
  } else if (view.mode === "pr") {
    const gh = view.gh;
    if (gh) target.append(renderGhCard(gh, input.ghActions));
    // 没装 gh 又没 PAT：这一格没有任何东西可输，整块换成安装卡（D428）。
    if (gh?.mode !== "full") {
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
      target.append(box);

      if (view.prMenuOpen) {
        const menu = el("div", "rv-prmenu");
        if (view.prError) {
          menu.append(el("div", "rv-hint", view.prError));
          // 查不到仓库时，人第一件事就是怀疑「是不是用错号了」：把号直接写出来（#17545）。
          // 写的是**实际用的**那个（跟随工作区时它也非空），不是下拉里选的那一项。
          const used = view.accountUsed || view.account;
          if (used) menu.append(el("div", "rv-hint rv-acct-why", tr("用的是账号：{p1}", { p1: used })));
        } else if (view.prsLoading) menu.append(el("div", "rv-hint", tr("正在拉 PR 列表…")));
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
        target.append(menu);
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
          target.append(picked);
        } else if (view.prAll > 1) {
          target.append(el("div", "rv-hint", tr("{p1} 个 open PR，可搜号 / 标题 / 分支", { p1: view.prs.length })));
        }
      }

      /**
       * 查 PR 用的 gh 账号。
       *
       * 多账号机器上「机器 gh 登的是谁」与「这个会话该用谁」往往不是一个人：私有仓/组织仓
       * 换个账号就是 `Could not resolve to a Repository`（#17545 就是这么失败的，而且提示指向代理）。
       * 所以号要写出来、也要能就地换；换了立刻按新号重拉列表（`onAccount` 里做）。
       */
      if (view.accounts.length || view.account) {
        const pick = el("select", "rv-acct-pick rv-ref") as HTMLSelectElement;
        pick.disabled = view.running;
        // 这一格在 `rv-opts` 里没有可见标签（旁边是模型 chip），读屏软件只能靠 aria-label 认出它是什么；
        // title 只给鼠标悬停，不算无障碍名称。
        pick.setAttribute("aria-label", tr("查 PR 用的账号"));
        pick.title = view.account ? tr("现在按 {p1} 查 PR", { p1: view.account }) : tr("按会话默认的账号查 PR");
        const follow = el("option", "", view.accountUsed && !view.account ? tr("跟随工作区（{p1}）", { p1: view.accountUsed }) : tr("跟随工作区")) as HTMLOptionElement;
        follow.value = "";
        // 选中判断只能看「人显式选的那个」：`view.account` 在跟随工作区时是空的，
        // 实际用的号在 `accountUsed` —— 拿它判断的活，这一项永远不会被选中（评审 #700）。
        follow.selected = !view.account;
        pick.append(follow);
        let listed = false;
        for (const account of view.accounts) {
          const opt = el("option", "", `${account.login}${account.pat ? ` · ${tr("PAT")}` : ""}`) as HTMLOptionElement;
          opt.value = account.login;
          if (account.login === view.account) {
            opt.selected = true;
            listed = true;
          }
          pick.append(opt);
        }
        // 解析出来的号不在 gh 账号表里（PAT-only / active 那个被删了）：也得摆出来，
        // 否则下拉停在「跟随工作区」上，人看不出现在到底按谁在查。
        if (view.account && !listed) {
          const opt = el("option", "", view.account) as HTMLOptionElement;
          opt.value = view.account;
          opt.selected = true;
          pick.append(opt);
        }
        pick.onchange = () => actions.onAccount(pick.value);
        opts.append(pick);
      }
    }
  } else {
    // 工作区改动没有要填的东西：一句话说清评的是什么，别留一块空白。
    target.append(el("p", "rv-hint rv-ws-hint", tr("评 HEAD 之前未提交的改动。")));
  }

  form.append(target);

  // ---- 模型（chip）：点开输入框那颗 chip 背后的同一个「模型与思考」弹层。
  const model = el("button", "rv-model", input.modelName || tr("默认模型")) as HTMLButtonElement;
  model.type = "button";
  // D420：换模型只影响**下一条**（每条记录自己存一份 model/provider），所以跑着时也能换。
  model.title = input.modelId || tr("用设置里的默认模型");
  model.onclick = () => actions.onPickModel();
  opts.prepend(model);
  form.append(opts);

  // ---- 主按钮：一直是「开始评审」，跑着的时候它开的是**下一条**（D420）
  const run = el("button", "btn primary rv-run", tr("开始评审")) as HTMLButtonElement;
  run.type = "button";
  run.disabled = !view.canRun;
  run.onclick = () => actions.onRun();
  runBtn = run;
  form.append(run);

  // 按钮灰着就得说清为什么 —— 用户就是卡在这颗没解释的灰按钮上（「不能评审了」）。
  // 只解释「某一格没填」这一种灰：没装 ocr / 不是 git 仓库 / 正在读 / 正在跑，各有自己的块，
  // 在这里再补一句会与它们打架（同一句话在两处出现，等于两处都没人看）。
  if ((view.missing || view.atCap) && view.missingWhy && !["no-ocr", "not-git", "loading"].includes(view.phase)) {
    form.append(el("div", "rv-hint rv-why", view.missingWhy));
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

  // ---- 记录：这个会话评过的每一次（时间线）。意见与时间线在「完整详情」浮层里（D429）。
  root.append(renderRunList(input));

  // ---- 来源说明：评审内核不是本仓库自研，别让人以为是
  const credit = el("div", "rv-credit");
  credit.append(
    el("span", "", tr("评审内核：阿里巴巴开源的 open code review（ocr）")),
    el("span", "", tr("以后会接入更多评审方式")),
  );
  root.append(credit);

  return root;
}

/** 磁贴副标题：选中的那块写「现在评的是什么」，没选中的写这块是干什么的。 */
function tileValue(view: ReviewView): string {
  if (view.mode === "range") return `${shortRef(view.target) || "HEAD"} ← ${shortRef(view.base) || "main"}`;
  if (view.mode === "commit") return (view.commit || "").slice(0, 7);
  if (view.mode === "pr") return view.pr ? `#${view.pr}` : "";
  return "";
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
  // #741：状态词说的是「那一次跑成了没」，过时是另一回事 —— 所以立在旁边一颗标，
  // 不抢状态词的语义（跑完并带 35 条意见的结果不该被叫成「没跑完」）。
  // 不可点、不可聚焦：D426 之后卡片正文不是入口，真正的入口在底行。
  if (card.outdated) {
    const stale = el("span", "rv-run-stale", tr("有新提交"));
    stale.title = card.outdatedNote;
    meta.append(stale);
  }
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

/**
 * 记录列表：一条一个时间线节点，新的在上（view.runs 已经是新在前）。
 *
 * 卡片正文不是入口（D426）：拖选卡上的文字不该误触浮层，键鼠唯一的入口是底行那颗
 * 「完整详情」。在跑的那条多一颗「停止」，以及一条按文件数走的进度条。
 */
function renderRunList(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  const box = el("div", "rv-runs");
  const head = el("div", "rv-runs-head");
  let count = tr("还没有评审记录");
  if (view.runs.length && view.runningCount > 0) {
    count = tr("评过 {p1} 次 · {p2} 个在跑", { p1: view.runs.length, p2: view.runningCount });
  } else if (view.runs.length) {
    count = tr("这个会话评过 {p1} 次", { p1: view.runs.length });
  }
  head.append(el("span", "rv-runs-lab", tr("评审记录")), el("span", "rv-runs-count", count));
  // 兜底：打开面板 / 切到这一页时已经核过一次，人想再确认一下就点这颗（只重核，不动 pick）。
  const reload = el("button", "rv-runs-reload") as HTMLButtonElement;
  reload.type = "button";
  reload.title = tr("重新核对有没有新提交");
  reload.setAttribute("aria-label", tr("重新核对有没有新提交"));
  reload.append(icon("refresh", { size: 13 }));
  reload.onclick = () => actions.onRefreshTips();
  head.append(reload);
  box.append(head);
  if (!view.runs.length) {
    box.append(el("div", "rv-hint rv-runs-empty", tr("上面选好范围、点「开始评审」，结果会记在这里。")));
    return box;
  }

  const tl = el("div", "rv-tl");
  for (const card of view.runs) {
    const cls = ["rv-run-card", card.running ? "is-live" : "", card.status === "failed" ? "is-fail" : ""]
      .filter(Boolean)
      .join(" ");
    const row = el("div", cls);
    row.append(el("span", `rv-run-dot ${card.running ? "running" : card.status}`));

    const body = el("div", "rv-run-body");
    const top = el("div", "rv-run-top");
    top.append(el("span", "rv-run-target", card.target));
    top.append(el("span", "rv-run-at", whenText(card.when)));
    body.append(top);
    if (card.title) body.append(el("div", "rv-run-title", card.title));
    body.append(runMetaRow(card));

    if (card.running && card.live) {
      // 进度条：`reviewed / total` 个文件。total 为 0（老桥）时不画，只留文字。
      if (card.live.total > 0) {
        const bar = el("div", "rv-run-bar");
        const fill = el("i");
        fill.style.width = `${Math.max(4, Math.round((card.live.reviewed / card.live.total) * 100))}%`;
        bar.append(fill);
        body.append(bar);
      }
      if (card.live.current) body.append(el("div", "rv-run-current", card.live.current));
    }
    if (card.error && !card.running) body.append(el("div", "rv-run-err", card.error));

    // 底行右对齐：跑着的那条先「停止」，再「重新评审」（只在过时时有），最后「完整详情」。
    const foot = el("div", "rv-run-foot");
    if (card.running) {
      const stop = el("button", "rv-run-stop", tr("停止")) as HTMLButtonElement;
      stop.type = "button";
      stop.title = tr("只停这一条");
      stop.onclick = () => actions.onStopRun(card.id);
      foot.append(stop);
    }
    if (card.outdated) {
      // #741：按**那条记录自己的范围**再评一次（不是面板上现在选着的那一格）。
      const again = el("button", "rv-run-again", tr("重新评审")) as HTMLButtonElement;
      again.type = "button";
      again.disabled = Boolean(card.rerunWhy);
      again.title = card.rerunWhy || card.outdatedNote;
      again.onclick = () => actions.onRerun(card.id);
      foot.append(again);
    }
    const more = el("button", "rv-run-more", tr("完整详情 ›")) as HTMLButtonElement;
    more.type = "button";
    more.onclick = () => actions.onDetails(card.id);
    foot.append(more);
    body.append(foot);

    row.append(body);
    tl.append(row);
  }
  box.append(tl);
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

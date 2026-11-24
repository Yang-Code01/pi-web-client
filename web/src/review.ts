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
import { fmtTime, tr } from "./i18n/index.ts";

import type {
  ReviewFinding,
  ReviewMark as Mark,
  ReviewMode,
  ReviewOcrStatus as OcrStatus,
  ReviewProgress,
  ReviewRun,
  ReviewSeverity as Severity,
  ReviewSkip,
  ReviewState,
} from "./frames.ts";

export type { Mark, OcrStatus, ReviewFinding, ReviewMode, ReviewProgress, ReviewRun, ReviewSkip, ReviewState };

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
  progress: ReviewProgress | null;
  ocr: OcrStatus | null;
  installing: boolean;
  error: string;
  notGit: boolean;
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
}

export type ReviewPhase = "loading" | "no-ocr" | "not-git" | "empty" | "running" | "done" | "stopped" | "failed" | "stale";

export interface ReviewView {
  phase: ReviewPhase;
  running: boolean;
  canRun: boolean;
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
  /** 时间线：桥每做一件事加一行。 */
  timeline: { at: number; text: string }[];
  group: { index: number; total: number } | null;
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
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * 桥带回来的 `errorCode` 才是给用户看的那句话（中文兜底只留给认不出的码）：
 * 直接画 `run.error` 会让英文 / 日文界面里冒出一句桥写死的中文。
 */
function errorText(run: ReviewRun | null, fallback: string): string {
  const code = (run?.errorCode || "").trim();
  const known: Record<string, string> = {
    stopped: tr("已停止"),
    "bridge-restart": tr("桥重启了，这次评审没跑完。重跑一次就行。"),
    busy: tr("这个仓库已经在评了"),
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

/**
 * 桥的状态 → 面板要显示的东西。
 *
 * 排法：文件按「最坏事的那条」从重到轻；同一文件里也按严重度；同为严重度时能定位的按行号、
 * 定位不到的（`start_line: 0`）排最后 —— 它们是「说不清在哪」的那批，不该插在精确意见之间。
 */
export function reviewView(input: ReviewInput): ReviewView {
  const ocr = input.ocr;
  const state = input.state;
  const latest = asRun(state);
  const marks = state?.marks ?? {};
  const running = Boolean(latest && latest.status === "running");

  const needsInstall = Boolean(ocr && !ocr.installed);
  const needsUpgrade = Boolean(ocr && ocr.installed && ocr.tooOld);

  let phase: ReviewPhase;
  // 「读状态」只在**一点信息都还没有**时出现：桥回了错、或者已经有评审记录，就不该死等 ocr 那一帧
  // （用户报过「一直显示在读评审状态」——正是 ocr 帧丢了之后永远停在这一屏）。
  if (input.notGit) phase = "not-git";
  else if (input.error && !latest) phase = "failed";
  else if (!ocr && !latest) phase = "loading";
  else if (needsInstall || needsUpgrade) phase = "no-ocr";
  else if (running) phase = "running";
  else if (!latest) phase = "empty";
  else if (latest.status === "done") phase = "done";
  else if (latest.status === "stopped") phase = "stopped";
  else if (latest.status === "stale") phase = "stale";
  else phase = "failed";

  const findings = (latest?.findings ?? []).map((f) => {
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
  for (const item of latest?.skipped ?? []) {
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
  const canRun = phase !== "loading" && phase !== "not-git" && phase !== "no-ocr" && !running && !input.installing && !missing;
  // 跑着看进度帧的日志，跑完看记录里存的那份（进度帧已经没了）。
  const log = (input.progress?.log?.length ? input.progress.log : latest?.log ?? []).slice(-40);
  const group =
    input.progress && input.progress.groups
      ? { index: input.progress.group || 0, total: input.progress.groups }
      : null;
  const startedAt = input.progress?.startedAt || latest?.startedAt || "";
  const elapsedMs = running
    ? Math.max(0, Date.now() - (Date.parse(startedAt) || Date.now()))
    : latest
      ? durationOf(latest)
      : null;

  const progress = input.progress
    ? {
        totalFiles: input.progress.totalFiles,
        reviewedFiles: input.progress.reviewedFiles,
        currentFile: input.progress.currentFile,
        tokens: input.progress.tokens,
      }
    : null;

  const meta =
    latest && !running && latest.status !== "failed"
      ? {
          files: latest.totalFiles ?? 0,
          reviewed: latest.reviewedFiles ?? 0,
          skipped: skipped.length,
          unresolved: findings.filter((f) => !f.mark).length,
          tokens: latest.tokens ?? 0,
          durationMs: durationOf(latest),
          when: latest.startedAt ?? "",
        }
      : null;

  return {
    phase,
    running,
    canRun,
    needsInstall,
    needsUpgrade,
    empty: phase === "done" && findings.length === 0,
    error: errorText(latest, input.error),
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
    elapsedMs,
    hasRun: Boolean(latest),
    prsLoading: Boolean(input.prsLoading),
    prError: (input.prError ?? "").trim(),
    missing,
    model: input.model ?? latest?.model ?? "",
    progress,
    meta,
    groups,
    severity,
    skipped,
    resolved: latest?.resolved?.length ?? 0,
    resolvedPaths: latest?.resolvedPaths ?? [],
    history: state?.runs?.length ?? 0,
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
  onStop: () => void;
  onMark: (key: string, mark: Mark | "") => void;
  /** 开着分支工作台「差异」页签并定位到这一行。 */
  onOpen: (path: string, line: number) => void;
  /** 把这条意见连同位置送进输入框（不自动发送）。 */
  onFix: (finding: ReviewFinding) => void;
  onInstall: () => void;
  onClean: () => void;
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
    modeRow.remove();
    form.append(refSelect(tr("目标分支"), view.target, actions.onTarget), refSelect(tr("对照分支"), view.base, actions.onBase));
  } else if (view.mode === "pr") {
    modeRow.remove();
    // 一个格子同时干三件事：输号、检索、从列表里点。分成「搜索框 + 下拉 + 号输入」三行
    // 在 300px 里又挤又丑（用户直接说了），所以合成一个 combobox。
    const box = el("div", "rv-prbox");
    box.append(el("span", "rv-lab", "PR"));
    const input = el("input", "rv-prq") as HTMLInputElement;
    input.value = view.prQuery || (view.pr ? `#${view.pr}` : "");
    input.placeholder = tr("输号或搜：号 / 标题 / 分支");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.oninput = () => {
      const raw = input.value;
      actions.onPrQuery(raw);
      const digits = raw.replace(/[^0-9]/g, "");
      // 纯数字（或 `#123`）直接当成号：边打边能点「开始评审」，不用再敲一次回车。
      const asNumber = /^\s*#?\s*\d+\s*$/.test(raw) ? digits : "";
      actions.onPrInput(asNumber);
      if (runBtn) runBtn.disabled = !asNumber;
      actions.onPrMenu(true);
    };
    input.onfocus = () => actions.onPrMenu(true);
    input.onkeydown = (ev) => {
      if (ev.key === "Escape") actions.onPrMenu(false);
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const first = view.prs[0];
      const digits = input.value.replace(/[^0-9]/g, "");
      if (digits) actions.onPr(digits);
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
        for (const item of view.prs.slice(0, 40)) {
          const row = el("button", `rv-prrow${String(item.number) === view.pr ? " on" : ""}`) as HTMLButtonElement;
          row.type = "button";
          row.dataset.num = String(item.number);
          const head = el("span", "rv-prrow-head", `${item.draft ? tr("[草稿] ") : ""}#${item.number}`);
          const title = el("span", "rv-prrow-title", item.title);
          const meta = el("span", "rv-prrow-meta", `${item.headRefName} → ${item.baseRefName}`);
          row.append(head, title, meta);
          row.onclick = () => {
            actions.onPr(String(item.number));
            actions.onPrMenu(false);
          };
          menu.append(row);
        }
      }
      form.append(menu);
    }
    if (view.prAll > 1 && !view.prMenuOpen) form.append(el("div", "rv-hint", tr("{p1} 个 open PR，可搜号 / 标题 / 分支", { p1: view.prs.length })));
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
  model.title = input.modelId || tr("用设置里的默认模型");
  model.onclick = () => actions.onPickModel();
  actRow.append(model);

  let runBtn: HTMLButtonElement | null = null;
  if (view.running) {
    const stop = el("button", "btn ghost rv-stop", tr("停止")) as HTMLButtonElement;
    stop.type = "button";
    stop.onclick = () => actions.onStop();
    actRow.append(stop);
  } else {
    const run = el("button", "btn rv-run", tr("开始评审")) as HTMLButtonElement;
    run.type = "button";
    run.disabled = !view.canRun;
    run.onclick = () => actions.onRun();
    runBtn = run;
    actRow.append(run);
  }
  if (view.hasRun) {
    const details = el("button", "btn ghost rv-details", tr("查看详情")) as HTMLButtonElement;
    details.type = "button";
    details.onclick = () => actions.onDetails();
    actRow.append(details);
  }
  form.append(actRow);
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
    root.append(el("div", "empty", tr("这个目录不是 git 仓库，没有东西可评。")));
    return root;
  }

  // ---- 进度 / 统计
  if (view.running && view.progress) {
    const p = view.progress;
    const line = el("div", "rv-progress");
    line.append(el("span", "rv-meta", tr("评审中 · {p1}/{p2} 个文件", { p1: p.reviewedFiles, p2: p.totalFiles })));
    if (p.currentFile) line.append(el("span", "rv-current", p.currentFile));
    root.append(line);
  } else if (view.meta) {
    const parts = [
      tr("{p1} 个文件", { p1: view.meta.files }),
      view.meta.skipped ? tr("{p1} 个没评", { p1: view.meta.skipped }) : "",
      duration(view.meta.durationMs),
      view.meta.tokens ? tr("{p1} tokens", { p1: view.meta.tokens }) : "",
      view.resolved ? tr("已解决 {p1} 条", { p1: view.resolved }) : "",
      view.history > 1 ? tr("第 {p1} 次", { p1: view.history }) : "",
    ].filter(Boolean);
    root.append(el("div", "rv-meta", parts.join(" · ")));
  }

  // ---- 时间线（面板里只留最后几行，完整的那份在「评审详情」dialog 里）
  if (view.timeline.length) root.append(renderTimeline(view, 4));

  // ---- 失败 / 停止 / 失效
  if (view.phase === "failed" && view.error) {
    root.append(el("div", "rv-error", view.error));
  } else if (view.phase === "stopped") {
    root.append(el("div", "rv-hint", tr("这次没跑完就停了，已经收到的意见在下面。")));
  } else if (view.phase === "stale") {
    root.append(el("div", "rv-hint", tr("桥重启了，这次评审没跑完。重跑一次就行。")));
  }

  root.append(renderFindings(input));

  // ---- 来源说明：评审内核不是本仓库自研，别让人以为是
  const credit = el("div", "rv-credit");
  credit.append(
    el("span", "", tr("评审内核：阿里巴巴开源的 open code review（ocr）")),
    el("span", "", tr("以后会接入更多评审方式")),
  );
  root.append(credit);

  // ---- 清理
  if (view.history > 0) {
    const foot = el("div", "rv-foot");
    const clean = el("button", "btn ghost rv-clean", tr("清理历史")) as HTMLButtonElement;
    clean.type = "button";
    clean.title = tr("清掉以前那些评审；已经标过的处理态保留");
    clean.onclick = () => actions.onClean();
    foot.append(clean);
    root.append(foot);
  }

  return root;
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

export function fixPrompt(f: ReviewFinding): string {
  const head = f.anchored ? `${f.path}:${f.startLine}` : f.path;
  const lines = [tr("代码评审意见（{p1}）：", { p1: head }), "", f.content];
  if (f.existingCode) lines.push("", tr("命中的代码："), "```", f.existingCode, "```");
  if (f.suggestionCode) lines.push("", tr("建议的改法："), "```", f.suggestionCode, "```");
  lines.push(
    "",
    f.anchored ? tr("请在这个位置修掉它，并说明改了什么。") : tr("请先找到这段代码再修掉它，并说明改了什么。"),
  );
  return lines.join("\n");
}

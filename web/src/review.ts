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
import { tr } from "./i18n/index.ts";

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

export interface ReviewInput {
  state: ReviewState | null;
  progress: ReviewProgress | null;
  ocr: OcrStatus | null;
  installing: boolean;
  error: string;
  notGit: boolean;
  /** 面板自己记住的那三样（不属于桥的状态）。 */
  mode?: ReviewMode;
  base?: string;
  commit?: string;
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
  commit: string;
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
  if (code && known[code]) return known[code];
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
  if (input.notGit) phase = "not-git";
  // 还没问出 ocr 装没装：先说「读状态」，别先喊「没装」再把按钮收回去。
  else if (!ocr) phase = "loading";
  else if (needsInstall || needsUpgrade) phase = "no-ocr";
  else if (running) phase = "running";
  else if (input.error && !latest) phase = "failed";
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

  const canRun = phase !== "loading" && phase !== "not-git" && phase !== "no-ocr" && !running && !input.installing;
  const progress = input.progress
    ? {
        totalFiles: input.progress.totalFiles,
        reviewedFiles: input.progress.reviewedFiles,
        currentFile: input.progress.currentFile,
        tokens: input.progress.tokens,
      }
    : null;

  const meta =
    latest && !running
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
    mode: input.mode ?? "range",
    base: input.base ?? "main",
    commit: input.commit ?? "",
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
  onCommit: (value: string) => void;
  onModel: (value: string) => void;
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
  models: { value: string; label: string }[];
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
export function renderReview(input: ReviewPanelInput): HTMLElement {
  const { view, actions } = input;
  const root = el("div", "review");

  // ---- 控制条
  const form = el("div", "rv-form");

  const modeRow = el("div", "rv-row");
  const mode = el("select", "rv-mode") as HTMLSelectElement;
  for (const [value, label] of [
    ["workspace", tr("工作区改动")],
    ["range", tr("分支 vs 主干")],
    ["commit", tr("单个提交")],
  ] as [ReviewMode, string][]) {
    const opt = el("option", "", label) as HTMLOptionElement;
    opt.value = value;
    if (value === view.mode) opt.selected = true;
    mode.append(opt);
  }
  mode.onchange = () => actions.onMode(mode.value as ReviewMode);
  modeRow.append(mode);

  if (view.mode === "range") {
    const list = el("input", "rv-ref") as HTMLInputElement;
    list.value = view.base;
    list.setAttribute("list", "rv-refs");
    list.placeholder = tr("主干分支");
    list.onchange = () => actions.onBase(list.value.trim());
    const dl = el("datalist");
    dl.id = "rv-refs";
    for (const ref of input.refs.slice(0, 40)) {
      const opt = el("option") as HTMLOptionElement;
      opt.value = ref;
      dl.append(opt);
    }
    modeRow.append(list, dl);
  } else if (view.mode === "commit") {
    const sha = el("input", "rv-ref") as HTMLInputElement;
    sha.value = view.commit;
    sha.placeholder = tr("提交号");
    sha.onchange = () => actions.onCommit(sha.value.trim());
    modeRow.append(sha);
  }
  form.append(modeRow);

  const actRow = el("div", "rv-row");
  const model = el("select", "rv-model") as HTMLSelectElement;
  const current = view.model || input.models[0]?.value || "";
  for (const item of input.models) {
    const opt = el("option", "", item.label) as HTMLOptionElement;
    opt.value = item.value;
    if (item.value === current) opt.selected = true;
    model.append(opt);
  }
  if (!input.models.length) model.append(el("option", "", tr("用设置里的默认模型")));
  model.onchange = () => actions.onModel(model.value);
  actRow.append(model);

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
    actRow.append(run);
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

  // ---- 失败 / 停止 / 失效
  if (view.phase === "failed" && view.error) {
    root.append(el("div", "rv-error", view.error));
  } else if (view.phase === "stopped") {
    root.append(el("div", "rv-hint", tr("这次没跑完就停了，已经收到的意见在下面。")));
  } else if (view.phase === "stale") {
    root.append(el("div", "rv-hint", tr("桥重启了，这次评审没跑完。重跑一次就行。")));
  }

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

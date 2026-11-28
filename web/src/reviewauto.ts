/**
 * 自动评审的页面那一半（D462，原型选的是三屏都 B）。
 *
 *   ① 设置 dialog   —— 上半两个模型槽 + 轮数上限 + 自动合并，下半**预演时间线**（看清会发生什么）
 *   ② 自动评审卡    —— **横向阶段条**：顶上每轮一格，下面当前轮与最近一轮的明细，暂停态三颗按钮
 *   ③ 轮次专用窗    —— **摘要带 + 双栏**：顶上一行事实，左意见宽、右侧叠「本轮改动」与「回执原文」
 *
 * 判定全在桥端（`bridge/src/reviewauto.ts`）：这里只照着 `AutoStateView` 画，外加几个纯函数
 * （阶段条怎么切、一行话怎么拼）留给 `web/tests/reviewauto-unit.mjs`。
 */
import { tr } from "./i18n/index.ts";
import { markSurface, mountOverlay, pushEscLayer } from "./modal.ts";
import type { ReviewFinding, ReviewRun, Severity } from "./review.ts";

/**
 * 与 `chat.ts` 的 `createEl` 同一个东西，就地写一份：那个模块会顺着 `github-cards` 把
 * `github-panel.css` 带进来，`node --experimental-strip-types` 的单测加载不了 CSS。
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// 类型（与桥端 `bridge/src/reviewauto.ts` 的落盘形状同构，只带页面要用的字段）
// ---------------------------------------------------------------------------

export interface AutoModelRef {
  provider: string;
  model: string;
  label: string;
}

export interface AutoVerdict {
  path: string;
  line: number;
  verdict: "fixed" | "false-positive" | "wontfix";
  why: string;
}

export interface AutoFixView {
  promptAt: string;
  shaBefore: string;
  shaAfter: string;
  files: number;
  added: number;
  removed: number;
  pushed: boolean;
  dismissed: number;
  fixed: number;
  note: string;
  /** 真实提交标题（桥读 `git log -1 --format=%s`）；老记录没有。 */
  subject?: string;
}

export interface AutoRoundView {
  n: number;
  slot: "A" | "B";
  label: string;
  model: string;
  provider: string;
  runId: string;
  status: "running" | "clean" | "findings" | "failed" | "skipped";
  sha: string;
  findings: number;
  severity: Record<string, number>;
  note: string;
  fix?: AutoFixView;
  verdicts?: AutoVerdict[];
}

export type AutoStatus = "running" | "paused" | "signed" | "merged" | "stopped" | "failed";

export interface AutoStateView {
  session: string;
  status: AutoStatus;
  wait: "" | "review" | "fix" | "merge";
  cur: number;
  rounds: AutoRoundView[];
  reason: string;
  reasonCode: string;
  tokens: number;
  summary: string;
  startedAt: string;
  endedAt: string;
  config: {
    mode: string;
    pr: number;
    branch: string;
    maxRounds: number;
    autoMerge: boolean;
    models: { a: AutoModelRef; b: AutoModelRef };
    repo: string;
  };
  merge: { pr: number; state: string; note: string };
}

/** 面板里那块的位置与内容。 */
export interface AutoPanelInput {
  state: AutoStateView | null;
  /** 现在能不能开（与「开始评审」同一个判据）。 */
  canStart: boolean;
  /** 不能开时写在按钮下面那句。 */
  why: string;
  /** 这一条评的是哪种范围（`review.ts` 的 `modeLabel()`，宿主给，别在这里抄一份标签表）。 */
  modeName: string;
}

export interface AutoActions {
  onSettings: () => void;
  onStop: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onOpenRound: (round: number) => void;
}

// ---------------------------------------------------------------------------
// 纯函数（单测打这里）
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<AutoRoundView["status"], string> = {
  running: "进行中",
  clean: "零意见",
  findings: "有意见",
  failed: "失败",
  skipped: "已跳过",
};

export function roundStatusLabel(r: Pick<AutoRoundView, "status">): string {
  return tr(STATUS_LABEL[r.status] ?? r.status);
}

/** 单位也走 `tr()`：`i18n-check` 只扫中文字面量，`tok` 这种写死的英文漏翻它抓不到。 */
const TOK_UNIT = "tok";

export function fmtTok(tokens: number): string {
  const n = Number(tokens) || 0;
  const unit = tr(TOK_UNIT);
  if (n < 1000) return `${n} ${unit}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k ${unit}`;
  return `${(n / 1_000_000).toFixed(1)}M ${unit}`;
}

const WORST: Severity[] = ["critical", "high", "medium", "low"];

/** 这一轮最严重的意见是什么色（阶段条上的小点用它）。 */
export function worstSeverity(r: Pick<AutoRoundView, "severity">): Severity | "" {
  const counts = r.severity ?? {};
  return WORST.find((s) => (counts[s] ?? 0) > 0) ?? "";
}

/**
 * 轮数上下限：**桥端是权威**（`bridge/src/reviewauto.ts` 的 MIN_ROUNDS / MAX_ROUNDS_CAP /
 * DEFAULT_MAX_ROUNDS）。页面这边只能有一份，别把 2 / 30 / 10 散着写。
 */
const ROUNDS_MIN = 2;
const ROUNDS_MAX = 30;
const ROUNDS_DEFAULT = 10;

/** 阶段条最多画几格（轮数上限 30，全画出来会切成一根根细线谁也点不中）。 */
const STAGE_CHIP_MAX = 6;

/** 轮次按号排好（桥给的就是这个顺序，别在两处各写一遍排序）。 */
function byRound(a: AutoRoundView, b: AutoRoundView): number {
  return a.n - b.n;
}

/**
 * 横向阶段条要画哪些格子：已经跑过的轮次各一格（**不画**「下一条待评」）。
 *
 * 最多 `STAGE_CHIP_MAX` 格。
 */
export function stageChips(state: Pick<AutoStateView, "rounds">): AutoRoundView[] {
  return [...state.rounds].sort(byRound).slice(-STAGE_CHIP_MAX);
}

/** 卡片上「现在在干什么」那一句。 */
export function waitText(state: Pick<AutoStateView, "wait" | "status" | "cur" | "merge">): string {
  if (state.status === "running" && state.wait === "merge") return tr("正在合并 PR #{p1}", { p1: String(state.merge.pr ?? "") });
  if (state.status === "running" && state.wait === "fix") return tr("等会话把这一轮的意见修完");
  if (state.status === "running") return tr("第 {p1} 轮正在评", { p1: String(state.cur || 1) });
  return "";
}

/** 卡片抬头上那枚状态。 */
export function statePill(state: Pick<AutoStateView, "status" | "cur" | "config">): { text: string; tone: "run" | "ok" | "warn" | "stop" } {
  const max = state.config.maxRounds || ROUNDS_DEFAULT;
  if (state.status === "signed") return { text: tr("两家已签收"), tone: "ok" };
  if (state.status === "merged") return { text: tr("已合并"), tone: "ok" };
  if (state.status === "stopped") return { text: tr("已停止"), tone: "stop" };
  if (state.status === "failed") return { text: tr("失败"), tone: "warn" };
  if (state.status === "paused") return { text: tr("已暂停 · 第 {p1} 轮", { p1: String(state.cur || 1) }), tone: "warn" };
  return { text: tr("第 {p1} / {p2} 轮", { p1: String(state.cur || 1), p2: String(max) }), tone: "run" };
}

/**
 * 底行：花了多少、跑了多久。
 *
 * 没有 `endedAt` 时只有**还在跑 / 暂停中**才用「现在」当结束：已经停下 / 签收 / 合并的记录
 * 若缺 `endedAt`（老状态），拿 `Date.now()` 会让用时每次重绘都往上涨。
 */
export function footerText(state: Pick<AutoStateView, "rounds" | "tokens" | "startedAt" | "endedAt" | "status">): string {
  const start = Date.parse(state.startedAt || "");
  const alive = state.status === "running" || state.status === "paused";
  const end = Date.parse(state.endedAt || "") || (alive ? Date.now() : 0);
  const ms = Number.isFinite(start) && end > 0 ? Math.max(0, end - start) : 0;
  const min = Math.round(ms / 60000);
  const bits = [tr("{p1} 轮", { p1: String(state.rounds.length) }), fmtTok(state.tokens)];
  if (ms > 0) bits.push(min < 1 ? tr("不到 1 分钟") : tr("{p1} 分钟", { p1: String(min) }));
  return bits.join(" · ");
}

/** 轮次上那些「为什么停 / 为什么算干净」的码 → 人话（桥只写码，界面文案归页面）。 */
const NOTE_TEXT: Record<string, string> = {
  dismissed: "回执全判误报",
  "no-changes": "零改动",
  "no-evidence": "没有回执也没有改动",
  uncommitted: "改了没提交",
  skipped: "你跳过了这一轮",
  // 「评审层把这一轮停掉了」与「这一轮评失败」是两件事，但都不用再细分到模型层
  stopped: "评审被停掉了",
  takeover: "你接管了会话",
  stale: "桥重启了，这一轮没跑完",
  failed: "评审失败",
};

export function noteText(note: string): string {
  if (!note) return "";
  const hit = NOTE_TEXT[note];
  return hit ? tr(hit) : note; // 认不出来的（老记录 / 模型写的理由）原样给，别吞掉
}

/** 干净的一轮签收在哪一路（表驱动：加一种就加一行，别再往上叠三元）。 */
const CLEAN_TEXT: Record<string, string> = {
  dismissed: "判为误报 · 签收",
  "no-changes": "没改动 · 签收",
  "": "零意见 · 签收",
};

/** 一轮的结论（**不含** `#3 A` 抬头）：阶段条的 title 与明细行拼的是这一份。 */
export function roundResult(r: AutoRoundView): string {
  if (r.status === "clean") return tr(CLEAN_TEXT[r.note] ?? CLEAN_TEXT[""]);
  if (r.status === "skipped") return `${tr("已跳过")}${r.note ? ` · ${noteText(r.note)}` : ""}`;
  if (r.status === "failed") return `${tr("失败")}${r.note ? ` · ${noteText(r.note)}` : ""}`;
  if (r.status === "running") return tr("正在评");
  const fixed = r.fix ? tr("→ 已修 {p1} 个文件", { p1: String(r.fix.files) }) : "";
  return `${tr("{p1} 条意见", { p1: String(r.findings) })} ${fixed}`.trim();
}

/** 一轮的「#3 A · 2 条意见 → 已修」。 */
export function roundLine(r: AutoRoundView): string {
  return `#${r.n} ${r.slot} · ${roundResult(r)}`;
}

/** 轮次窗里「这条意见的判定」。 */
export function verdictOf(r: AutoRoundView | null, f: Pick<ReviewFinding, "path" | "startLine">): AutoVerdict | null {
  if (!r?.verdicts?.length) return null;
  return (
    r.verdicts.find((v) => v.path === f.path && v.line && v.line === f.startLine) ??
    r.verdicts.find((v) => v.path === f.path && !v.line) ??
    null
  );
}

/** 意见卡上那枚判定标的样式类：三种判定三种颜色（「误报」与「不改」不能长一个样）。 */
const VERDICT_CLASS: Record<AutoVerdict["verdict"], string> = { fixed: "fixed", "false-positive": "fp", wontfix: "wont" };

export function verdictLabel(v: AutoVerdict["verdict"] | ""): string {
  if (v === "fixed") return tr("已修");
  if (v === "false-positive") return tr("误报");
  if (v === "wontfix") return tr("不改");
  return "";
}

// ---------------------------------------------------------------------------
// ② 自动评审卡（面板里那一段）
// ---------------------------------------------------------------------------

export function renderAutoPanel(input: AutoPanelInput, actions: AutoActions): HTMLElement {
  const box = el("div", "rv-auto-scope");
  const state = input.state;

  // ---- 还没跑过：只摆那颗按钮（与「开始评审」在同一块里，下面是自动评审）
  const entry = el("button", "btn rv-auto-open", tr("自动评审…")) as HTMLButtonElement;
  entry.type = "button";
  entry.disabled = !input.canStart;
  entry.title = input.canStart ? tr("两个模型交替评，修完再评，直到两家都没意见") : input.why;
  entry.onclick = () => actions.onSettings();
  box.append(entry);
  if (!input.canStart && input.why) box.append(el("div", "rv-hint rv-why", input.why));

  if (!state) return box;

  const pill = statePill(state);
  const card = el("article", `rv-auto rv-auto-${state.status}`);
  const head = el("header", "rv-auto-head");
  const icon = el("span", "rv-auto-ic", state.status === "signed" || state.status === "merged" ? "✓" : "↻");
  const titleBox = el("div", "rv-auto-title");
  const title = state.config.pr
    ? tr("自动评审 · PR #{p1}", { p1: String(state.config.pr) })
    : tr("自动评审 · {p1}", { p1: state.config.branch || tr("工作区改动") });
  titleBox.append(el("b", "", title), el("i", "", state.config.mode === "pr" ? `${state.config.branch} → ${tr("主干")}` : input.modeName));
  const right = el("div", "rv-auto-right");
  right.append(el("span", `rv-auto-pill ${pill.tone}`, pill.text));
  if (state.status === "running") {
    const stop = el("button", "rv-auto-stop", tr("停止")) as HTMLButtonElement;
    stop.type = "button";
    stop.onclick = () => actions.onStop();
    right.append(stop);
  }
  head.append(icon, titleBox, right);
  card.append(head);

  // ---- 横向阶段条
  const chips = stageChips(state);
  if (chips.length) {
    const stages = el("div", "rv-auto-stages");
    for (const r of chips) {
      const chip = el("button", `rv-auto-stage ${stageClass(r, state)}`) as HTMLButtonElement;
      chip.type = "button";
      chip.title = roundLine(r);
      chip.onclick = () => actions.onOpenRound(r.n);
      const top = el("div", "rv-auto-stage-top");
      top.append(el("b", "", `#${r.n} ${r.slot}`), el("span", "rv-auto-stage-st", roundStatusLabel(r)));
      chip.append(top);
      chip.append(el("div", "rv-auto-stage-sub", stageSub(r)));
      const bar = el("span", "rv-auto-stage-bar");
      bar.append(el("i", "", ""));
      chip.append(bar);
      const sev = worstSeverity(r);
      if (sev) chip.append(el("span", `rv-auto-sev ${sev}`, ""));
      stages.append(chip);
    }
    card.append(stages);
  }

  // ---- 当前轮 / 最近一轮的明细（最多两行）
  const detail = el("div", "rv-auto-detail");
  const recent = [...state.rounds].sort(byRound).slice(-2);
  for (const r of recent) {
    const row = el("button", `rv-auto-row ${r.status === "running" ? "on" : ""}`) as HTMLButtonElement;
    row.type = "button";
    row.onclick = () => actions.onOpenRound(r.n);
    const line1 = el("div", "rv-auto-row1");
    line1.append(el("span", "rv-auto-no", `#${r.n}`), el("span", `rv-auto-slot ${r.slot === "B" ? "b" : "a"}`, r.slot), el("span", "rv-auto-model", r.label || `${r.provider}/${r.model}`), el("span", "rv-auto-res", roundResult(r)));
    const line2 = el("div", "rv-auto-row2");
    if (r.sha) line2.append(el("span", "rv-auto-sha", r.sha.slice(0, 7)));
    if (r.fix && (r.fix.files || r.fix.added || r.fix.removed)) {
      const d = el("span", "rv-auto-diff");
      d.append(el("span", "add", `+${r.fix.added}`), el("span", "del", `−${r.fix.removed}`));
      line2.append(d);
    }
    // 「正在评第几轮」只写给**当前轮**那一行：`waitText` 用的是 `state.cur`，
    // 顺手套到别的 running 行（桥重启后没收口的旧轮）上会把别处的轮号写进这一行。
    if (r.status === "running") line2.append(el("span", "", (r.n === state.cur ? waitText(state) : "") || tr("正在评")));
    if (r.note && r.status !== "clean") line2.append(el("span", "rv-auto-note", noteText(r.note)));
    if (r.status === "clean" && r.note === "dismissed") line2.append(el("span", "rv-auto-note", noteText(r.note)));
    row.append(line1, line2);
    if (r.status === "running") {
      const bar = el("div", "rv-auto-bar");
      bar.append(el("i", "", ""));
      row.append(bar);
    }
    detail.append(row);
  }
  if (detail.childElementCount) card.append(detail);

  // ---- 暂停 / 失败：原因 + 三颗按钮
  if (state.status === "paused" || state.status === "failed") {
    const pauseBox = el("div", "rv-auto-pause");
    pauseBox.append(el("div", "rv-auto-reason", state.reason || tr("停下来了，需要你看一眼")));
    const acts = el("div", "rv-auto-acts");
    // 「stopping」= 已经按过停止、正在等这一轮跑完：这时只需要一颗「停止」等在那里，
    // 不能再并排摆第二颗一模一样的，也不该让「跳过这一轮」跟「正在停」打架。
    const stopping = state.reasonCode === "stopping";
    const cont = el("button", "btn primary", stopping ? tr("停止") : tr("继续")) as HTMLButtonElement;
    cont.type = "button";
    cont.onclick = () => (stopping ? actions.onStop() : actions.onContinue());
    acts.append(cont);
    if (!stopping) {
      const skip = el("button", "btn", tr("跳过这一轮")) as HTMLButtonElement;
      skip.type = "button";
      skip.onclick = () => actions.onSkip();
      const stop = el("button", "btn ghost", tr("停止")) as HTMLButtonElement;
      stop.type = "button";
      stop.onclick = () => actions.onStop();
      acts.append(skip, stop);
    }
    pauseBox.append(acts);
    card.append(pauseBox);
  }

  // ---- 底行
  const foot = el("footer", "rv-auto-foot");
  foot.append(el("span", "", footerText(state)));
  card.append(foot);
  box.append(card);
  return box;
}

/** 阶段条副文案（表驱动：加一个状态就加一行，别再往上叠三元）。 */
const STAGE_SUB: Record<AutoRoundView["status"], (r: AutoRoundView) => string> = {
  findings: (r) => tr("{p1} 条意见", { p1: String(r.findings) }),
  running: () => tr("正在评"),
  clean: () => tr("签收"),
  skipped: () => tr("跳过"),
  failed: () => tr("失败"),
};

function stageSub(r: AutoRoundView): string {
  return (STAGE_SUB[r.status] ?? STAGE_SUB.failed)(r);
}

/**
 * 轮次窗里「这一轮推没推」那一行。
 *
 * 只要这一轮有提交（`fix.shaAfter`）就要给一句话：以前只在 `findings` 时写「只在本地」，
 * `skipped` / `failed` 的轮次带着提交却什么都不说，人看到 sha 不知道推没推。
 */
function pushHint(pushed: boolean): string {
  if (pushed) return tr("已推到远端");
  return tr("只在本地（这个范围不需要推送）");
}

/** 阶段条那一格的样式类（`now` / `ok` / `done` / `skip` / `bad`）：`done` 是「跑完、有意见」的那一轮。 */
export function stageClass(r: AutoRoundView, state: Pick<AutoStateView, "cur">): string {
  if (r.status === "running") return "now";
  if (r.status === "clean") return "ok";
  if (r.status === "skipped") return "skip";
  if (r.status === "failed") return "bad";
  if (r.n === state.cur) return "now";
  return "done";
}

// ---------------------------------------------------------------------------
// ① 设置 dialog（变体 B：带预演时间线）
// ---------------------------------------------------------------------------

export interface AutoSettingsValues {
  models: { a: AutoModelRef; b: AutoModelRef };
  maxRounds: number;
  autoMerge: boolean;
}

export interface AutoSettingsOpts {
  /** 面板上此刻的默认模型（= 评审模型 chip 那个），用来预填 A。 */
  defaultModel: AutoModelRef | null;
  /** 上次用过的设置（同一个会话里再打开时接着用）。 */
  last: AutoSettingsValues | null;
  /** 要评的是什么，只用来显示一行抬头。 */
  where: string;
  /** 「GitHub PR」才给自动合并那颗开关（别的范围没有 PR 可合）。 */
  canMerge: boolean;
  onPick: (slot: "a" | "b") => void;
  onStart: (values: AutoSettingsValues) => void;
}

const slotLabel = (slot: "A" | "B"): string => (slot === "A" ? tr("模型 A") : tr("模型 B"));

/** 设置 dialog：上半设置、下半预演；`render()` 可重复调（挑完模型重画那两行 chip）。 */
export class AutoSettingsSheet {
  private readonly back: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly start: HTMLButtonElement;
  private readonly values: AutoSettingsValues;
  private readonly opts: AutoSettingsOpts;
  private popEsc: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(opts: AutoSettingsOpts) {
    this.opts = opts;
    const empty: AutoModelRef = { provider: "", model: "", label: "" };
    // `last` 是宿主传来的「上次用的设置」：缺 models / 缺某一路时按默认起手，别在打开 dialog 时抛。
    const lastA = opts.last?.models?.a;
    const lastB = opts.last?.models?.b;
    this.values = {
      models: {
        a: lastA?.model ? { ...lastA } : opts.defaultModel ? { ...opts.defaultModel } : { ...empty },
        b: lastB?.model ? { ...lastB } : { ...empty },
      },
      maxRounds: opts.last?.maxRounds || ROUNDS_DEFAULT,
      autoMerge: Boolean(opts.last?.autoMerge),
    };

    // dialog-geom: 抓手由挂它的人接（app.ts 的 `openAutoSettings()`）—— 这个文件要能在 node 下加载，顶层不 import DOM 模块
    this.back = markSurface(el("div", "sheet-back center rv-auto-back"), "window");
    const sheet = el("section", "st-console rv-auto-sheet");
    this.panel = sheet;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tr("自动评审"));

    const head = el("header", "rv-auto-sheet-head");
    const headBox = el("div", "");
    headBox.append(el("div", "rv-auto-kicker", tr("代码评审")), el("h2", "", tr("自动评审")), el("div", "rv-auto-sub", opts.where));
    const close = el("button", "btn ghost", tr("取消")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    head.append(headBox, close);

    this.body = el("div", "rv-auto-sheet-body");

    const foot = el("footer", "rv-auto-sheet-foot");
    const note = el("span", "rv-auto-foot-note", tr("最少 2 轮：同一份 diff 上两家各签收一次"));
    const right = el("div", "rv-auto-foot-right");
    this.start = el("button", "btn primary", tr("开始自动评审")) as HTMLButtonElement;
    this.start.type = "button";
    this.start.onclick = () => {
      if (!this.values.models.b.model) return;
      this.opts.onStart({ models: { a: { ...this.values.models.a }, b: { ...this.values.models.b } }, maxRounds: this.values.maxRounds, autoMerge: this.values.autoMerge && this.opts.canMerge });
    };
    right.append(this.start);
    foot.append(note, right);

    sheet.append(head, this.body, foot);
    this.back.append(sheet);
    this.render();
  }

  /**
   * `_parent` 只为与别的 sheet 的 `mount(parent)` 签名兼容（`ReviewSheet` 那一套）；实际挂载点由 `mountOverlay` 决定。
   * `attachGeom`（#755）：这个文件要能在 node 下加载（`reviewauto-unit.mjs` 直接 import 它取纯函数），
   * 所以**不**在顶层 import `dialoggeom.ts`；窗口几何由挂它的人（app.ts，一定在浏览器里）传进来。
   */
  mount(_parent: HTMLElement, attachGeom?: (back: HTMLElement, panel: HTMLElement) => void): void {
    attachGeom?.(this.back, this.panel);
    mountOverlay(this.back);
    this.popEsc = pushEscLayer({ el: this.back, onEsc: () => this.close() });
  }

  close(): void {
    this.popEsc?.();
    this.popEsc = null;
    this.back.remove();
    this.onClose?.();
  }

  /** 挑完模型之后把值写回去（app 那边拿不到这里的私有状态）。 */
  setModel(slot: "a" | "b", model: AutoModelRef): void {
    this.values.models[slot] = { ...model };
    this.render();
  }

  render(): void {
    this.body.textContent = "";
    // ---- 模型排班
    const models = el("div", "rv-auto-fld");
    models.append(el("div", "rv-auto-lab", tr("模型排班")));
    for (const slot of ["a", "b"] as const) {
      const row = el("div", "rv-auto-chiprow");
      const who = el("span", `rv-auto-who ${slot}`);
      who.append(el("i", "dot"), el("span", "", slotLabel(slot.toUpperCase() as "A" | "B")));
      const chip = el("button", `rv-auto-mchip ${this.values.models[slot].model ? "" : "empty"}`) as HTMLButtonElement;
      chip.type = "button";
      const m = this.values.models[slot];
      chip.append(el("span", "", m.label || m.model || (slot === "a" ? tr("选一个模型") : tr("再选一个不同的"))));
      if (m.provider) chip.append(el("span", "pid", m.provider));
      chip.append(el("span", "chev", "▾"));
      chip.onclick = () => this.opts.onPick(slot);
      row.append(who, chip);
      models.append(row);
    }
    models.append(el("div", "rv-auto-lede", tr("顺序 A → B → A → B 交替；任何改动落盘，两家签收一起作废。")));

    const limits = el("div", "rv-auto-fld");
    limits.append(el("div", "rv-auto-lab", tr("上限")));
    const stepper = el("div", "rv-auto-stepper");
    const minus = el("button", "", "−") as HTMLButtonElement;
    minus.type = "button";
    minus.onclick = () => {
      this.values.maxRounds = Math.max(ROUNDS_MIN, this.values.maxRounds - 1);
      this.render();
    };
    const value = el("b", "", String(this.values.maxRounds));
    const plus = el("button", "", "+") as HTMLButtonElement;
    plus.type = "button";
    plus.onclick = () => {
      this.values.maxRounds = Math.min(ROUNDS_MAX, this.values.maxRounds + 1);
      this.render();
    };
    stepper.append(minus, value, plus, el("span", "unit", tr("轮")));
    limits.append(stepper);
    const fuse = el("div", "rv-auto-check");
    fuse.append(el("span", "bx", "✓"), el("span", "", tr("同一批意见连续两轮还在就停")));
    limits.append(fuse);

    const merge = el("div", "rv-auto-fld");
    merge.append(el("div", "rv-auto-lab", tr("完成后")));
    const swCard = el("button", `rv-auto-sw-card ${this.values.autoMerge && this.opts.canMerge ? "on" : ""}`) as HTMLButtonElement;
    swCard.type = "button";
    swCard.disabled = !this.opts.canMerge;
    const txt = el("span", "txt");
    txt.append(el("b", "", tr("自动合并 PR")), el("i", "", this.opts.canMerge ? tr("checks 全绿 + mergeable 才合，用 merge commit") : tr("这次评的不是 PR，没有可合的")));
    const sw = el("span", `sw ${this.values.autoMerge && this.opts.canMerge ? "on" : ""}`);
    swCard.append(txt, sw);
    swCard.onclick = () => {
      if (!this.opts.canMerge) return;
      this.values.autoMerge = !this.values.autoMerge;
      this.render();
    };
    merge.append(swCard);

    const top = el("div", "rv-auto-cols");
    top.append(models, limits, merge);

    // ---- 预演：按下开始之后会发生什么
    const preview = el("div", "rv-auto-rehearse");
    preview.append(el("div", "rv-auto-cap", tr("按下开始之后会发生什么")));
    const rail = el("div", "rv-auto-rail");
    const nodes: { text: string }[] = [
      { text: tr("#1 {p1} 评", { p1: "A" }) },
      { text: tr("#2 {p1} 评", { p1: "B" }) },
      { text: tr("#3 有意见就修 → 提交") },
      { text: tr("#4 A 复评 …") },
    ];
    for (const [i, node] of nodes.entries()) {
      if (i) rail.append(el("span", "ar", "→"));
      const nd = el("span", "nd");
      nd.textContent = node.text;
      rail.append(nd);
    }
    preview.append(rail);
    preview.append(
      el("div", "rv-auto-tail", tr("末两轮必须评同一份 diff 且两家都零意见；最多 {p1} 轮，撞线或意见重复就停下来等你。", { p1: String(this.values.maxRounds) })),
    );

    this.body.append(top, preview);
    this.start.disabled = !this.values.models.a.model || !this.values.models.b.model;
  }
}

// ---------------------------------------------------------------------------
// ③ 轮次专用窗（变体 B：摘要带 + 双栏）
// ---------------------------------------------------------------------------

export interface AutoRoundSheetInput {
  state: AutoStateView;
  round: AutoRoundView | null;
  /** 这一轮的评审记录（意见就在里面；老的 / 删掉的可能没有）。 */
  run: ReviewRun | null;
}

export class AutoRoundSheet {
  private readonly back: HTMLElement;
  private readonly sheet: HTMLElement;
  private popEsc: (() => void) | null = null;
  private input: AutoRoundSheetInput;
  onClose: (() => void) | null = null;
  onStep: ((delta: number) => void) | null = null;

  constructor(input: AutoRoundSheetInput) {
    this.input = input;
    // dialog-geom: 同上，由 app.ts 的 `openAutoRound()` 接
    this.back = markSurface(el("div", "sheet-back center rv-auto-round-back"), "window");
    this.sheet = el("section", "st-console rv-auto-round");
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-label", tr("自动评审 · 这一轮"));
    this.back.append(this.sheet);
    this.render();
  }

  /** 同 `AutoSettingsSheet.mount`：`attachGeom` 由 app.ts 传（这个文件不在顶层碰 DOM 模块）。 */
  mount(_parent: HTMLElement, attachGeom?: (back: HTMLElement, panel: HTMLElement) => void): void {
    attachGeom?.(this.back, this.sheet);
    mountOverlay(this.back);
    this.popEsc = pushEscLayer({ el: this.back, onEsc: () => this.close() });
  }

  update(input: AutoRoundSheetInput): void {
    this.input = input;
    this.render();
  }

  close(): void {
    this.popEsc?.();
    this.popEsc = null;
    this.back.remove();
    this.onClose?.();
  }

  private render(): void {
    const { state, round, run } = this.input;
    this.sheet.textContent = "";
    const r = round;
    const head = el("header", "rv-auto-sheet-head");
    const box = el("div", "");
    box.append(
      el("div", "rv-auto-kicker", r ? tr("自动评审 · 第 {p1} 轮", { p1: String(r.n) }) : tr("自动评审")),
      el("h2", "", r ? tr("{p1} 评 {p2}", { p1: r.label || `${r.provider}/${r.model}`, p2: (r.sha || "").slice(0, 7) || "…" }) : tr("还没有轮次")),
    );
    const right = el("div", "rv-auto-head-right");
    // 轮号不保证连续（跳过 / 旧记录被裁）：边界按**存在的那几个号**算，别拿 `rounds.length` 当上界。
    const nos = state.rounds.map((x) => x.n).sort((a, b) => a - b);
    const prev = el("button", "btn ghost", tr("上一轮")) as HTMLButtonElement;
    prev.type = "button";
    prev.disabled = !r || nos.indexOf(r.n) <= 0;
    prev.onclick = () => this.onStep?.(-1);
    const next = el("button", "btn ghost", tr("下一轮")) as HTMLButtonElement;
    next.type = "button";
    next.disabled = !r || nos.indexOf(r.n) < 0 || nos.indexOf(r.n) >= nos.length - 1;
    next.onclick = () => this.onStep?.(1);
    const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    right.append(prev, next, close);
    head.append(box, right);
    this.sheet.append(head);

    if (!r) {
      this.sheet.append(el("div", "rv-auto-empty", tr("这一条自动评审还没有跑过任何一轮。")));
      return;
    }

    // ---- 摘要带
    const findings = run?.findings ?? [];
    const verdicts = r.verdicts ?? [];
    const fixed = verdicts.filter((v) => v.verdict === "fixed").length;
    const fp = verdicts.filter((v) => v.verdict === "false-positive").length;
    const wont = verdicts.filter((v) => v.verdict === "wontfix").length;
    const strip = el("div", "rv-auto-strip");
    const fact = (label: string, value: string, cls = ""): HTMLElement => {
      const span = el("span", `rv-auto-fact ${cls}`);
      span.append(el("b", "", value), el("i", "", label));
      return span;
    };
    strip.append(fact(tr("意见"), String(findings.length || r.findings)));
    // 三个数只数**回执里的判定**：①以前「不改」为 0 时拿整轮意见数兜底，一轮「回执全判误报」
    // 会写成 `0 / 3 / 3`（同一条意见数两遍）；②没有回执的一轮回执为空，也不能写成 `0 / 0 / 0`
    // —— 那和下面「这一轮没有回执」自相矛盾。
    strip.append(fact(tr("已修 / 误报 / 不改"), verdicts.length ? `${fixed} / ${fp} / ${wont}` : tr("没有回执")));
    const fx = r.fix;
    strip.append(
      (() => {
        const span = el("span", "rv-auto-fact");
        const b = el("b", "");
        b.append(el("span", "", `${fx?.files ?? 0} `), el("span", "add", `+${fx?.added ?? 0}`), el("span", "del", `−${fx?.removed ?? 0}`));
        span.append(b, el("i", "", tr("改动")));
        return span;
      })(),
    );
    if (r.sha) strip.append(fact(tr("提交"), r.sha.slice(0, 7), "mono"));
    strip.append(fact(tr("这一轮"), roundStatusLabel(r)));
    this.sheet.append(strip);

    // ---- 双栏：左意见、右侧改动 + 回执原文
    const body = el("div", "rv-auto-round-body");
    const left = el("div", "rv-auto-panel");
    const lhead = el("div", "rv-auto-ph");
    lhead.append(el("span", "", tr("意见")), el("span", "n", tr("{p1} 条 · 逐条带结论", { p1: String(findings.length || r.findings) })));
    left.append(lhead);
    const lbody = el("div", "rv-auto-pb");
    if (!findings.length) {
      lbody.append(el("div", "rv-auto-hint", r.status === "clean" ? tr("这一轮零意见。") : tr("这一轮的意见没留下来（记录被清过 / 换了仓库）。")));
    }
    for (const f of findings) {
      const v = verdictOf(r, f);
      const card = el("div", "rv-auto-finding");
      const top = el("div", "rv-auto-f-top");
      top.append(el("span", `tag ${f.severity}`, sevName(f.severity)), el("span", "path", f.anchored === false ? f.path : `${f.path}:${f.startLine}`));
      if (v) top.append(el("span", `tag ${VERDICT_CLASS[v.verdict] ?? "fp"}`, verdictLabel(v.verdict)));
      card.append(top, el("div", "txt", f.content));
      if (v?.why) card.append(el("div", "why", `→ ${v.why}`));
      lbody.append(card);
    }
    left.append(lbody);
    body.append(left);

    const side = el("div", "rv-auto-side");
    const change = el("div", "rv-auto-panel");
    change.append(el("div", "rv-auto-ph", tr("本轮改动")));
    const cbody = el("div", "rv-auto-pb");
    if (fx && fx.shaAfter) {
      const top = el("div", "rv-auto-fixrow");
      top.append(el("span", "rv-auto-sha", fx.shaAfter.slice(0, 7)), el("span", "add", `+${fx.added}`), el("span", "del", `−${fx.removed}`), el("span", "dim", tr("{p1} 个文件", { p1: String(fx.files) })));
      cbody.append(top);
      cbody.append(el("div", "rv-auto-hint", pushHint(fx.pushed)));
      const commit = el("div", "rv-auto-json");
      // 桥给了真实提交标题就显示它；老记录没有这一格时退回「约定的格式」，不要伪装成真提交。
      commit.textContent = fx.subject || tr("约定：fix(review): 按第 {p1} 轮评审意见修复", { p1: String(r.n) });
      cbody.append(commit);
    } else {
      cbody.append(el("div", "rv-auto-hint", r.status === "clean" ? tr("这一轮没有改代码（零意见或判为误报）") : tr("还没有提交")));
    }
    change.append(cbody);
    side.append(change);

    const receipt = el("div", "rv-auto-panel grow");
    receipt.append(el("div", "rv-auto-ph", tr("回执原文")));
    const rbody = el("div", "rv-auto-pb");
    if (verdicts.length) {
      const json = el("pre", "rv-auto-json");
      json.textContent = JSON.stringify({ verdicts, note: r.fix?.note ?? "" }, null, 2);
      rbody.append(json);
    } else {
      rbody.append(el("div", "rv-auto-hint", tr("这一轮没有回执（零意见 / 会话没按格式回）。")));
    }
    receipt.append(rbody);
    side.append(receipt);
    body.append(side);
    this.sheet.append(body);
  }
}

const SEV_NAME: Record<Severity, string> = { critical: "严重", high: "高", medium: "中", low: "低" };
const sevName = (s: Severity): string => tr(SEV_NAME[s] ?? s);

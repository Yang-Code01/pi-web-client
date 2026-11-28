/**
 * 自动评审（D462）：两个模型交替轮值，评 → 修 → 再评，直到同一份 diff 上两家都签收，
 * 或者撞上熔断 / 你按停。
 *
 * 形态：**由 ticker 驱动的状态机**，不是一条长跑 async 函数。理由与 D446 同一套 ——
 * 换脑、崩溃、页面关掉都得能接回来，而「现在停在等哪一步」是可以落盘的一句话：
 *
 *   wait = "review"  正在等第 cur 轮的评审 run 跑完（run 本身是 detached worker，见 D446）
 *   wait = "fix"     正在等会话里的 agent 把这一轮的意见修完（agent_settled）
 *   wait = "merge"   正在等会话里的 agent 合并 PR
 *
 * 每完成一次状态迁移就整份落盘；脑开机时 `AutoRunner.resume()` 把 `running` 的那几条接回来。
 * 评审 run 的进度、意见、token 都从盘上（`review.ts` 的 job/state）读，这里不另存一份。
 *
 * 这个模块**不碰** fs 之外的系统能力：起评审、读进度、跑 git、给会话发话、合并 PR、打标记
 * 全部走注入的 `AutoHost`，所以纯逻辑部分能单测（`bridge/tests/reviewauto-unit.mjs`）。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson, readJsonChecked, statePath, writeJson } from "./paths.ts";
import { sessionKey } from "./review.ts";
import type { ReviewLang } from "./review.ts";
import type { ReviewFinding, ReviewMark, ReviewMode, ReviewRunStatus } from "./frames.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface AutoModel {
  provider: string;
  model: string;
  /** 面板上显示的名字（`ModelInfo.name`）；空就退回 `provider/model`。 */
  label: string;
}

/** 这一条自动评审评的是什么（与手动「开始评审」的四块一对一）。 */
export interface AutoScope {
  mode: ReviewMode;
  base: string;
  target: string;
  commit: string;
  pr: number;
}

export interface AutoConfig extends AutoScope {
  models: { a: AutoModel; b: AutoModel };
  /** 轮数上限（熔断之一）。最小 2：双签至少要两轮。 */
  maxRounds: number;
  autoMerge: boolean;
  /** 评审仓库根（评审跑在这里）。 */
  repo: string;
  /** 会话 cwd（git 命令、push 都在这里跑）。 */
  cwd: string;
  /** 开始时的本地分支（PR 模式要求它就是 PR 的 head）。 */
  branch: string;
  /** 这个仓库的 `owner/name`（从 origin 认，认不出空串）：限时授权拿它拒掉同名别仓。 */
  slug: string;
  /**
   * 「工作区改动」模式的起点 sha：第一轮评的是 `git diff HEAD`，之后每轮都有提交，
   * 所以第二轮起改按 `baseSha..HEAD` 评（D462 第 9 条），否则会「0 条意见」假签收。
   */
  baseSha: string;
  lang: ReviewLang;
}

export type VerdictKind = "fixed" | "false-positive" | "wontfix";

export interface Verdict {
  path: string;
  line: number;
  verdict: VerdictKind;
  why: string;
}

/** 修复那一轮：谁改的、改成了什么、推没推上去。 */
export interface AutoFix {
  promptAt: string;
  shaBefore: string;
  shaAfter: string;
  files: number;
  added: number;
  removed: number;
  pushed: boolean;
  /** 回执里「判为误报 / 不值得改」的条数。 */
  dismissed: number;
  fixed: number;
  note: string;
  /** 真实提交的标题（`git log -1 --format=%s`）：页面直接显示它，不再按模板自造一句。 */
  subject?: string;
  /** 提交了但会话没按格式回执（git 事实兜底；这种轮次不会走「误报签收」）。 */
  noReceipt?: boolean;
  /**
   * 「改了没提交」那句话已经补过一次了（只补一次，第二次直接暂停）。
   *
   * 单独一格，不拿 `note` 兼任：`note` 也装回执里的理由 / `uncommitted` 这类码，一旦混用，
   * 哪次回执带了 note 就会把「已经提醒过」这件事抹掉，变成无限提醒。
   */
  nudged?: boolean;
}

export type RoundStatus = "running" | "clean" | "findings" | "failed" | "skipped";

export interface AutoRound {
  /** 从 1 开始。 */
  n: number;
  slot: "A" | "B";
  model: string;
  provider: string;
  label: string;
  runId: string;
  at: string;
  finishedAt: string;
  status: RoundStatus;
  /** 这一轮评的是哪个 sha（workspace 模式第一轮是当时的 HEAD）。 */
  sha: string;
  findings: number;
  severity: Record<string, number>;
  /** 意见的 `findingKey`：认「还是那一条」（跨轮判「原地打转」）。 */
  keys: string[];
  tokens: number;
  ms: number;
  /** 失败原因 / 「判为误报」这类一句话。 */
  note: string;
  fix?: AutoFix;
  /** 收尾时要打上去的标记（修掉的 → 接受，误报 → 误报）。 */
  marks: { key: string; mark: ReviewMark }[];
  /** 会话回执（逐条的判定与理由）：轮次专用窗的「回执」那一栏就读它。 */
  verdicts: Verdict[];
}

export type AutoStatus = "running" | "paused" | "signed" | "merged" | "stopped" | "failed";
export type AutoWait = "" | "review" | "fix" | "merge";

export interface AutoState {
  id: string;
  session: string;
  config: AutoConfig;
  status: AutoStatus;
  wait: AutoWait;
  /** 当前轮（`rounds` 里 `n === cur` 的那条）。 */
  cur: number;
  rounds: AutoRound[];
  /** 暂停 / 停止的原因（给卡片看）。`reasonCode` 给 i18n 与测试认。 */
  reason: string;
  reasonCode: string;
  /** 按了「停止」但还在等修复轮跑完（D462 第 13 条）。 */
  stopping: boolean;
  startedAt: string;
  endedAt: string;
  tokens: number;
  merge: { pr: number; state: "waiting" | "merged" | "failed"; note: string; /** 合并那句话发出去的时刻（有值才开始等 turn 结束）。 */ at: string };
  /** 卡片底行的一句话结论。 */
  summary: string;
}

/** 脑给这个模块的全部能力（好让纯逻辑能单测）。 */
export interface AutoHost {
  start(o: {
    dir: string;
    scope: AutoScope;
    session: string;
    model: AutoModel;
    lang: ReviewLang;
  }): Promise<{ runId: string; repo: string }>;
  /** 某一轮已经跑完的意见（「继续」要拿它重发提示词）。 */
  findings(repo: string, session: string, runId: string): ReviewFinding[] | null;
  /** 评审 run 现在到哪了（进度帧那份；没有进度就看记录）。 */
  progress(repo: string, session: string, runId: string): { status: ReviewRunStatus; findings: ReviewFinding[]; tokens: number } | null;
  cancel(repo: string, session: string, runId: string): void;
  /** 会话：在不在跑、发一句话、最后一条 assistant 文本、这一轮有没有报错。 */
  session(id: string): {
    running: boolean;
    prompt(text: string): Promise<void>;
    /** 我们最后那句 prompt 之后的那条 assistant：文本与报错**一次取回**，保证来自同一条消息。 */
    lastReply(since: string): { text: string; error: string };
  } | null;
  /**
   * 这个会话归不归这个桥管（只认名册，不建对象）。与 `session()` 的区别：换脑开机时壳里活着的
   * 会话要过几秒才被认领进来 —— 那段时间 `session()` 是 null，但会话**不是没了**。
   */
  known(id: string): boolean;
  head(cwd: string): string;
  /** `git status --porcelain` 有没有东西（修完没提交也算改过）。 */
  dirty(cwd: string): boolean;
  /** 这一轮改了什么（`git diff --shortstat` 口径）。 */
  diffstat(cwd: string, from: string): { files: number; added: number; removed: number };
  /** 某个提交的标题（`git log -1 --format=%s`）：页面「本轮改动」显示真实的那句。 */
  subject(cwd: string, sha: string): string;
  /** 把这一轮的分支推上去（PR 模式才用；失败返回原因）。 */
  push(cwd: string, branch: string): Promise<{ ok: boolean; note: string }>;
  /** PR 的 checks 绿不绿、合没合（PR 模式 + 自动合并用）。 */
  prChecks(config: AutoConfig, session: string): Promise<{ ok: boolean; note: string }>;
  prState(config: AutoConfig, session: string): Promise<{ merged: boolean; note: string }>;
  /** 授权：运行期间只放行这一个 PR 的合并（D462 第 5 条）。 */
  grant(session: string, g: { pr: number; repo: string; branch: string; slug: string } | null): void;
  /** 收尾：打标记 + 往会话上挂一条结论 + 徽标。 */
  finish(state: AutoState, text: string, marks: { repo: string; session: string; key: string; mark: ReviewMark }[]): void;
  /** 每次状态变化都广播给页面。 */
  emit(state: AutoState): void;
  log(line: string): void;
}

// ---------------------------------------------------------------------------
// 纯逻辑（单测直接打这里）
// ---------------------------------------------------------------------------

export const MIN_ROUNDS = 2;
/** 补过「还没提交」那句提醒之后，等它回话的宽限期（过了还这样才判「改了没提交」）。 */
export const NUDGE_GRACE_MS = 2 * 60 * 1000;
/** 换脑后等壳里的会话被认领进来的宽限（`activate` 比 `resume` 晚几秒；超了才判「会话没了」）。 */
export const SESSION_GRACE_MS = 60 * 1000;
/** 合并那句话发出后，至少等这么久再去问 PR 状态（prompt 可能还排在会话的队里）。 */
export const MERGE_MIN_WAIT_MS = 15 * 1000;
export const MAX_ROUNDS_CAP = 30;
export const DEFAULT_MAX_ROUNDS = 10;

/** 注入进会话的那段话的抬头标记：页面靠它把长提示词折成一张轮次卡。 */
export const AUTO_MARK = "[pi-web:auto]";

export function clampRounds(n: unknown): number {
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v < MIN_ROUNDS) return DEFAULT_MAX_ROUNDS;
  return Math.min(MAX_ROUNDS_CAP, v);
}

/** 第 n 轮用哪个槽：A 先，之后交替（D462 第 1 条）。 */
export function slotOf(n: number): "A" | "B" {
  return n % 2 === 1 ? "A" : "B";
}

/**
 * 这一批意见算不算「没意见」：0 条就是。**判为误报 / 不值得改**由修复轮的回执决定，
 * 那一路走 `isCleanRound(round)`。
 */
export function isCleanRound(r: Pick<AutoRound, "status">): boolean {
  return r.status === "clean";
}

/**
 * 「同一份 diff 上两家各签一次」：末两轮都干净、且评的是同一个 sha。
 * 交替轮值下这两轮的模型必然不同（`slotOf`），所以不用再比槽位。
 *
 * 「同一份 diff」只按 head sha 比，不看 base 有没有动（PR 模式下 base 前进了、merge base 变了，
 * 这一条仍算签收）：真去核 base 只能靠每次轮询问远端，代价远大于收益 —— 两家评的都是
 * **同一个 head 上的同一段改动**，这就够「都看过了」。
 */
export function signedOff(rounds: readonly AutoRound[]): boolean {
  const list = rounds.filter((r) => r.status !== "running" && r.status !== "skipped");
  if (list.length < 2) return false;
  const [a, b] = list.slice(-2).reverse();
  if (!isCleanRound(a) || !isCleanRound(b)) return false;
  // 跳过 / 重跑会打乱交替的奇偶：同一个模型连签两次不算「两家都没意见」。
  if (a.slot === b.slot) return false;
  return Boolean(a.sha) && a.sha === b.sha;
}

/** 熔断之一：同一个 `findingKey` 连续两轮还在（改了也没消掉 / 两家对着提）。 */
export function repeatedKeys(rounds: readonly AutoRound[]): string[] {
  const done = rounds.filter((r) => r.status === "findings");
  if (done.length < 2) return [];
  const prev = new Set(done[done.length - 2].keys);
  return done[done.length - 1].keys.filter((k) => prev.has(k));
}

/** 熔断检查：返回原因码，没撞线就是空串。 */
export function fuseReason(state: Pick<AutoState, "rounds" | "config">): { code: string; keys: string[] } | null {
  const counted = state.rounds.filter((r) => r.status !== "skipped");
  if (counted.length >= clampRounds(state.config.maxRounds)) return { code: "max-rounds", keys: [] };
  const dup = repeatedKeys(state.rounds);
  if (dup.length) return { code: "repeat", keys: dup };
  return null;
}

/** 一条 check（口径与右栏 PR 详情那份一样：`state` 是 success / pending / failure…）。 */
export interface AutoCheck {
  name: string;
  state: string;
}

/**
 * 合并前的 checks 闸。
 *
 * 与右栏 PR 详情**同一口径**：一条检查都没有（仓库没接 CI）算过；有就一律要求 success。
 * `mergeable === false` 直接不过；`null`（GitHub 还在算）不当「能合」也不当「不能合」——
 * 真去合并那一步会自己报错并停下来，不在这里提前否定。
 * `truncated` = checks 没读全（翻页中途出错 / 到页数上限）：那就不能说「全绿」。
 *
 * 判定写在这里（而不是脑的 `prChecks` 里），是因为它曾经拿一份**没有 `checks` 字段**的
 * PR 结构去读：`info.checks` 恒为 `undefined`，于是「CI 没过」静默判成「没有 checks」。
 */
export function checksGate(checks: readonly AutoCheck[], mergeable: boolean | null, truncated = false): { ok: boolean; note: string } {
  if (mergeable === false) return { ok: false, note: "PR 现在合不了：有冲突或者被锁住了" };
  if (truncated) return { ok: false, note: "checks 没读全（翻页中途出错），看不出是不是全绿" };
  const bad = checks.filter((c) => c.state !== "success");
  if (bad.length) {
    return { ok: false, note: `${bad.length} 个 check 没过：${bad.slice(0, 3).map((c) => `${c.name}（${c.state}）`).join("、")}` };
  }
  return { ok: true, note: checks.length ? `${checks.length} 个 check 全过` : "没有 checks" };
}

/**
 * 合并到底成没成。
 *
 * GitHub 合完 `state` 仍是 `closed`（与「关掉没合」同一个值），所以只有 `merged` 或 `MERGED` 算合上；
 * 别拿 `state === "CLOSED"` 当「没合」的判据，否则合成功也会被当成失败暂停（自动合并永远走不到 `merged`）。
 */
export function mergeResult(view: { merged: boolean; state: string }): { merged: boolean; note: string } {
  const state = String(view?.state ?? "").toUpperCase();
  if (view?.merged || state === "MERGED") return { merged: true, note: "" };
  return { merged: false, note: `PR 还是 ${state || "未知"} 状态：合并那句话没有生效` };
}

/** 下一轮：还没开始就 A，否则接在最后一轮后面。 */
export function nextRoundNo(rounds: readonly AutoRound[]): number {
  return rounds.reduce((max, r) => Math.max(max, r.n), 0) + 1;
}

/** 一轮评审该按什么范围评（workspace 第一轮之后升成 `baseSha..HEAD`）。 */
export function scopeForRound(config: AutoConfig, n: number): AutoScope {
  const base: AutoScope = {
    mode: config.mode,
    base: config.base,
    target: config.target,
    commit: config.commit,
    pr: config.pr,
  };
  if (config.mode !== "workspace" || !config.baseSha) return base;
  if (n <= 1) return base;
  // 第二轮起：第一轮的修复已经提交，`git diff HEAD` 是空的了 —— 改按起点..HEAD 评。
  return { ...base, mode: "range", base: config.baseSha, target: "HEAD" };
}

const VERDICT_KINDS: VerdictKind[] = ["fixed", "false-positive", "wontfix"];

/** 把模型回执里那些宽松写法归一：`false positive` / `false_positive` / `FP` 都算误报。 */
export function normVerdict(raw: unknown): VerdictKind | "" {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (VERDICT_KINDS.includes(t as VerdictKind)) return t as VerdictKind;
  if (["fp", "falsepositive", "误报", "invalid", "no"].includes(t)) return "false-positive";
  if (["fix", "fixed", "修了", "已修", "done", "yes"].includes(t)) return "fixed";
  if (["skip", "wontfix", "won-t-fix", "不改", "不值得改", "later"].includes(t)) return "wontfix";
  return "";
}

/**
 * 从一条 JSON 里挑出 verdicts 数组（容忍模型少写一层、或者键名变体）。
 *
 * 参数是 `any`：这是模型写的自由文本解析出来的 JSON，进来时形状完全未知，
 * 只能逐层 `Array.isArray` 探。**出去**以后一律按 `Verdict` 收口，`any` 不出这个函数。
 */
function verdictList(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.verdicts)) return raw.verdicts;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.findings)) return raw.findings;
  if (raw.verdicts && typeof raw.verdicts === "object") return Object.values(raw.verdicts);
  return [];
}

/**
 * 解析修复轮的回执。
 *
 * 找一个 `{"verdicts":[…]}` / `{"items":[…]}` 形状的 JSON —— 优先最后一个 ```json 围栏，
 * 没有围栏就在整段里从后往前试括号；解析不了就返回 `ok:false`，交给 git 事实兜底。
 */
export function parseVerdict(text: string): { ok: boolean; verdicts: Verdict[]; note: string } {
  const raw = String(text ?? "");
  if (!raw.trim()) return { ok: false, verdicts: [], note: "" };
  const candidates: string[] = [];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  // 没有围栏（或围栏里不是我们要的形状）：从后往前，给每个 `{` 找配对的 `}` 再试一次。
  // 不能「就近找左括号」—— 那样会先撞上数组元素 `{"path":…}`，永远拼不出外层对象。
  const starts: number[] = [];
  for (let i = raw.length - 1; i >= 0 && starts.length < 40; i--) if (raw[i] === "{") starts.push(i);
  for (const start of starts) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(raw.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const text of candidates) {
    // `any`：这是模型自由文本里抠出来的 JSON，形状未知，逐层探（`verdictList` 才是收口的地方）
    let parsed: any;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      continue;
    }
    const list = verdictList(parsed);
    if (!list.length) continue;
    const verdicts: Verdict[] = [];
    for (const item of list) {
      const v = normVerdict(item?.verdict ?? item?.result ?? item?.status);
      if (!v) continue;
      verdicts.push({
        path: String(item?.path ?? item?.file ?? "").trim(),
        line: Number(item?.line ?? item?.startLine ?? item?.start_line ?? 0) || 0,
        verdict: v,
        why: String(item?.why ?? item?.reason ?? item?.note ?? "").trim(),
      });
    }
    if (!verdicts.length) continue;
    return { ok: true, verdicts, note: String(parsed?.note ?? parsed?.summary ?? "").trim() };
  }
  return { ok: false, verdicts: [], note: "" };
}

/** 回执里「这条不用改」的比例够不够把这一轮算成签收（D462 第 2 条的「误报签收」）。 */
export function dismissalMarks(
  findings: readonly Pick<ReviewFinding, "key" | "path" | "startLine">[],
  verdicts: readonly Verdict[],
): { all: boolean; marks: { key: string; mark: ReviewMark }[] } {
  if (!findings.length) return { all: false, marks: [] };
  const marks: { key: string; mark: ReviewMark }[] = [];
  // 一条 verdict 只能用在一处。不占位的话，同一份文件里「只写了路径」的那一条会被**每条**意见
  // 各认一次（三条意见共用一条判定），另外两条其实没被看过，这一轮也会被算成签收。
  const used = new Set<number>();
  const take = (f: { path: string; startLine: number }): number => {
    for (const [i, v] of verdicts.entries()) {
      if (used.has(i) || !v.path || v.path !== f.path) continue;
      // `-1` 是「整份文件」：这一条能对上文件里的任何一行
      if (v.line && (v.line === f.startLine || v.line === -1)) return i;
    }
    for (const [i, v] of verdicts.entries()) {
      if (used.has(i) || !v.path || v.path !== f.path) continue;
      // 只写了路径、没写行号：顺序上认领一条（同一文件多条意见时对不上具体是哪条，
      // 但只占一条，不会让一条判定给整份文件的所有意见背书）
      if (!v.line) return i;
    }
    return -1;
  };
  let handled = 0;
  for (const f of findings) {
    const i = take(f);
    if (i < 0) continue;
    used.add(i);
    handled++;
    const hit = verdicts[i];
    if (hit.verdict === "false-positive") marks.push({ key: f.key, mark: "false-positive" });
    else if (hit.verdict === "fixed") marks.push({ key: f.key, mark: "accept" });
  }
  const all = handled === findings.length && marks.every((m) => m.mark !== "accept");
  return { all, marks };
}

/**
 * 注入提示词的第一行：**机器可读**（`round=3 findings=2` / `merge pr=747`），
 * 页面据此拼一张本地化的轮次卡标题 —— 桥写的中文不直接当界面文案用（`tr()` 规矩）。
 */
export function markerLine(kind: "round", n: number, findings: number): string;
export function markerLine(kind: "merge", pr: number): string;
export function markerLine(kind: "round" | "merge", a: number, b = 0): string {
  return kind === "round" ? `${AUTO_MARK} round=${a} findings=${b}` : `${AUTO_MARK} merge pr=${a}`;
}

/**
 * 注入会话的修复提示词（D462 第 3 条）：逐条意见 + 规矩 + 最后那段固定 JSON 回执。
 * 开头必须是 `AUTO_MARK`：页面靠它把这段折成一张轮次卡。
 */
export function fixPrompt(o: {
  round: number;
  findings: readonly ReviewFinding[];
  config: AutoConfig;
  where: string;
}): string {
  const { round, findings, config, where } = o;
  const lines: string[] = [];
  lines.push(markerLine("round", round, findings.length));
  lines.push(where ? `代码评审意见（${where}）` : "代码评审意见");
  lines.push("");
  lines.push(`一共 ${findings.length} 条，逐条核实并处理：`);
  for (const [i, f] of findings.entries()) {
    const head = f.anchored === false || !f.startLine ? f.path : `${f.path}:${f.startLine}`;
    lines.push(`${i + 1}. ${head} · ${f.severity} · ${f.category} — ${f.content}`);
    if (f.existingCode) {
      const code = String(f.existingCode);
      // 围栏要比源码里最长的一串反引号更长：源码自己带 ``` 时，三反引号会被提前闭合，
      // 后面的源码行就跑到代码块外面，变成对 agent 的指令（prompt injection）。
      const longest = (code.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push(`   ${fence}`, ...code.split("\n").map((l) => `   ${l}`), `   ${fence}`);
    }
  }
  lines.push("");
  lines.push("每条都先判断是否真的成立：不成立就说明理由、跳过；成立就修掉，并说明改了什么。不要为了对齐意见而改无关代码。");
  lines.push("");
  lines.push("自动评审的规矩（必读）：");
  lines.push("- 只改这些意见涉及的地方，不顺手重构、不改无关文件。");
  lines.push("- 改完跑一次与改动相关的检查（typecheck / 相关单测），失败了先修到过；不跑全量、不跑 e2e。");
  lines.push(`- 把这一轮的改动提交成一个 commit，提交信息用 \`fix(review): …\`${config.mode === "pr" ? "（不用 push，自动评审负责推）" : ""}。`);
  lines.push("- 最后**只输出一个 JSON 对象**，不要解释、不要寒暄，形状：");
  lines.push('  {"verdicts":[{"path":"相对路径","line":42,"verdict":"fixed|false-positive|wontfix","why":"一句话"}],"note":"这一轮做了什么"}');
  lines.push("- `verdict` 只能是三个值之一：`fixed`（按意见改了）/ `false-positive`（意见不成立）/ `wontfix`（成立但不该在这一轮改）。");
  return lines.join("\n");
}

/** 合并那一步交给会话的那句话：只做合并，别顺手干别的（D462 第 15 条）。 */
export function mergePrompt(o: { pr: number; rounds: number; models: string }): string {
  return [
    markerLine("merge", o.pr),
    `两个模型都签收了同一份 diff（${o.rounds} 轮 · ${o.models}），checks 已经全绿。`,
    `合并方式用 merge commit：\`gh pr merge ${o.pr} --merge\`。`,
    "只做合并这一件事：不要拉本地 main、不要删远端分支、不要动代码。",
  ].join("\n");
}

/** 会话里那条结论消息（收尾时挂到自动评审卡上；也发一条 notice）。 */
export function summaryText(state: AutoState): string {
  const rounds = state.rounds.length;
  const tokens = state.tokens;
  const signed = state.status === "merged" || state.status === "signed";
  if (state.status === "merged") return `自动评审结束：${rounds} 轮 · 两家签收 · 已合并 #${state.config.pr} · ${fmtTok(tokens)}`;
  if (signed) return `自动评审结束：${rounds} 轮 · 两家签收（${state.config.mode === "pr" ? `PR #${state.config.pr}` : "本地 diff"}）· ${fmtTok(tokens)}`;
  if (state.status === "stopped") return `自动评审已停止：停在第 ${state.cur || rounds} 轮 · ${fmtTok(tokens)}`;
  if (state.status === "failed") return `自动评审失败：${state.reason || "没有跑到签收"} · ${fmtTok(tokens)}`;
  if (state.status === "paused") return `自动评审已暂停：${state.reason || "需要你处理"} · 停在第 ${state.cur || rounds} 轮`;
  return `自动评审进行到第 ${state.cur || 1} 轮 · ${fmtTok(tokens)}`;
}

export function fmtTok(tokens: number): string {
  const n = Number(tokens) || 0;
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

/** 一条自动评审该不该继续把进度帧推出去（免得 800ms 一帧把页面刷爆）。 */
export function sameProgress(a: AutoState | null, b: AutoState | null): boolean {
  if (!a || !b) return false;
  return hashState(a) === hashState(b);
}

function hashState(s: AutoState): string {
  return JSON.stringify([s.status, s.wait, s.cur, s.rounds.length, s.rounds.at(-1)?.status, s.rounds.at(-1)?.runId, s.reasonCode, s.stopping, s.merge.state]);
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

export function autoDir(): string {
  return statePath("review", "auto");
}

export function autoFile(session: string): string {
  return path.join(autoDir(), `${sessionKey(session)}.json`);
}

export function readAuto(session: string): AutoState | null {
  const read = readJsonChecked<AutoState | null>(autoFile(session), null);
  if (!read.ok || !read.value || typeof read.value !== "object") return null;
  return normalizeAuto(read.value);
}

/** 严重度计数：只留「值是数字」的那几格（数组 / 字符串计数会让 `+ 1` 变成字符串拼接）。 */
function normalizeSeverity(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

const MARKS: ReviewMark[] = ["accept", "ignore", "false-positive"];

/** 一条「收尾时要打上去的标记」：`mark` 只认三个已知值（`finish()` 会把它直接交给桥打标）。 */
function normalizeMark(raw: unknown): { key: string; mark: ReviewMark } | null {
  const m = raw as { key?: unknown; mark?: unknown } | null;
  const key = typeof m?.key === "string" ? m.key : "";
  const mark = MARKS.includes(m?.mark as ReviewMark) ? (m?.mark as ReviewMark) : null;
  return key && mark ? { key, mark } : null;
}

function normalizeMarks(raw: unknown): { key: string; mark: ReviewMark }[] {
  if (!Array.isArray(raw)) return [];
  const out: { key: string; mark: ReviewMark }[] = [];
  for (const item of raw as unknown[]) {
    const one = normalizeMark(item);
    if (one) out.push(one);
  }
  return out;
}

function normalizeVerdicts(raw: unknown): Verdict[] {
  if (!Array.isArray(raw)) return [];
  const out: Verdict[] = [];
  for (const item of raw as unknown[]) {
    const one = normalizeVerdict(item);
    if (one) out.push(one);
  }
  return out;
}

/** 一条回执判定：`verdict` 只认三个已知值，其余按「没写」丢掉。 */
function normalizeVerdict(raw: unknown): Verdict | null {
  const v = raw as { path?: unknown; line?: unknown; verdict?: unknown; why?: unknown } | null;
  const verdict = VERDICT_KINDS.includes(v?.verdict as VerdictKind) ? (v?.verdict as VerdictKind) : null;
  const path = typeof v?.path === "string" ? v.path : "";
  if (!verdict || !path) return null;
  const line = Number(v?.line);
  return { path, line: Number.isFinite(line) ? line : 0, verdict, why: String(v?.why ?? "") };
}

/** 修复那一轮：字段逐个收口（`{...raw}` 会把盘上任意键一起带进内存与页面）。 */
function normalizeFix(raw: any): AutoFix {
  return {
    promptAt: String(raw?.promptAt ?? ""),
    shaBefore: String(raw?.shaBefore ?? ""),
    shaAfter: String(raw?.shaAfter ?? ""),
    files: Number(raw?.files) || 0,
    added: Number(raw?.added) || 0,
    removed: Number(raw?.removed) || 0,
    pushed: Boolean(raw?.pushed),
    dismissed: Number(raw?.dismissed) || 0,
    fixed: Number(raw?.fixed) || 0,
    note: String(raw?.note ?? ""),
    subject: String(raw?.subject ?? ""),
    noReceipt: Boolean(raw?.noReceipt),
    nudged: Boolean(raw?.nudged),
  };
}

/**
 * 老状态 / 半截写入都补齐成现在的形状：读出来不该因为少个字段就崩。
 *
 * `raw` 是 `any`：盘上那份可能是上一个大版本写的，也可能是写到一半的文件，逐字段 `?.` 探测。
 */
export function normalizeAuto(raw: any): AutoState {
  const config: AutoConfig = {
    mode: ["workspace", "range", "commit", "pr"].includes(raw?.config?.mode) ? raw.config.mode : "workspace",
    base: String(raw?.config?.base ?? ""),
    target: String(raw?.config?.target ?? ""),
    commit: String(raw?.config?.commit ?? ""),
    pr: Number(raw?.config?.pr) || 0,
    maxRounds: clampRounds(raw?.config?.maxRounds),
    autoMerge: Boolean(raw?.config?.autoMerge),
    repo: String(raw?.config?.repo ?? ""),
    cwd: String(raw?.config?.cwd ?? ""),
    branch: String(raw?.config?.branch ?? ""),
    slug: String(raw?.config?.slug ?? ""),
    baseSha: String(raw?.config?.baseSha ?? ""),
    lang: ["zh", "en", "ja"].includes(raw?.config?.lang) ? raw.config.lang : "zh",
    models: {
      a: { provider: String(raw?.config?.models?.a?.provider ?? ""), model: String(raw?.config?.models?.a?.model ?? ""), label: String(raw?.config?.models?.a?.label ?? "") },
      b: { provider: String(raw?.config?.models?.b?.provider ?? ""), model: String(raw?.config?.models?.b?.model ?? ""), label: String(raw?.config?.models?.b?.label ?? "") },
    },
  };
  const rounds: AutoRound[] = (Array.isArray(raw?.rounds) ? raw.rounds : []).map((r: any) => ({
    n: Number(r?.n) || 0,
    slot: r?.slot === "B" ? "B" : "A",
    model: String(r?.model ?? ""),
    provider: String(r?.provider ?? ""),
    label: String(r?.label ?? ""),
    runId: String(r?.runId ?? ""),
    at: String(r?.at ?? ""),
    finishedAt: String(r?.finishedAt ?? ""),
    status: ["running", "clean", "findings", "failed", "skipped"].includes(r?.status) ? r.status : "running",
    sha: String(r?.sha ?? ""),
    findings: Number(r?.findings) || 0,
    severity: normalizeSeverity(r?.severity),
    keys: Array.isArray(r?.keys) ? r.keys.map((k: unknown) => String(k ?? "")).filter(Boolean) : [],
    tokens: Number(r?.tokens) || 0,
    ms: Number(r?.ms) || 0,
    note: String(r?.note ?? ""),
    marks: normalizeMarks(r?.marks),
    verdicts: normalizeVerdicts(r?.verdicts),
    ...(r?.fix && typeof r.fix === "object" ? { fix: normalizeFix(r.fix) } : {}),
  }));
  return {
    id: String(raw?.id ?? ""),
    session: String(raw?.session ?? ""),
    config,
    status: ["running", "paused", "signed", "merged", "stopped", "failed"].includes(raw?.status) ? raw.status : "paused",
    wait: ["", "review", "fix", "merge"].includes(raw?.wait) ? raw.wait : "",
    cur: Number(raw?.cur) || 0,
    rounds,
    reason: String(raw?.reason ?? ""),
    reasonCode: String(raw?.reasonCode ?? ""),
    stopping: Boolean(raw?.stopping),
    startedAt: String(raw?.startedAt ?? ""),
    endedAt: String(raw?.endedAt ?? ""),
    tokens: Number(raw?.tokens) || 0,
    merge: {
      pr: Number(raw?.merge?.pr) || 0,
      state: ["waiting", "merged", "failed"].includes(raw?.merge?.state) ? raw.merge.state : "waiting",
      note: String(raw?.merge?.note ?? ""),
      at: String(raw?.merge?.at ?? ""),
    },
    summary: String(raw?.summary ?? ""),
  };
}

export function writeAuto(state: AutoState): void {
  ensureDir(autoDir());
  writeJson(autoFile(state.session), state);
}

/**
 * 盘上所有的自动评审（换脑接回时逐个 `resume`）。
 *
 * 一个会话只有一份：`start()` 直接覆盖同名文件，上一次的轮次也跟着被换掉（卡片看的是新的那一次）。
 */
export function listAuto(): AutoState[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(autoDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AutoState[] = [];
  for (const name of names) {
    try {
      // `any`：盘上那份可能是上一个大版本 / 半截写入，形状未知（`normalizeAuto` 逐字段收口）
      const raw = readJson<any>(path.join(autoDir(), name), null);
      if (raw && typeof raw === "object" && raw.session) out.push(normalizeAuto(raw));
    } catch {
      /* 半截写入：跳过，下一次运行会覆盖它 */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 编排器
// ---------------------------------------------------------------------------

export interface StartAutoInput {
  session: string;
  config: AutoConfig;
}

export interface AutoResult {
  ok: boolean;
  code: string;
  error: string;
  state: AutoState | null;
}

/** 「这一段意见在哪个 PR / 分支上」：与手动评审的 `whereText()` 同一套说法。 */
export function whereOf(config: AutoConfig): string {
  if (config.mode === "pr") return config.pr ? `PR #${config.pr}${config.branch ? ` · ${config.branch}` : ""}` : "";
  if (config.mode === "range") return `分支：${config.target || "HEAD"} → ${config.base || "main"}`;
  if (config.mode === "commit") return `提交：${config.commit || "HEAD"}`;
  return "工作区改动（HEAD 之前）";
}

const nowIso = (): string => new Date().toISOString();

/**
 * 编排器：一个会话一条。所有外部能力走 `AutoHost`，这里只管「现在该干什么」。
 * `tick()` 由脑的定时器每 800ms 调一次；每次状态迁移都落盘（换脑 / 崩溃都能接回来）。
 */
export class AutoRunner {
  private states = new Map<string, AutoState>();
  /** 每条自动评审「进入内存」的时刻：会话对象还没被认领时的宽限从它算。 */
  private enteredAt = new Map<string, number>();
  /** 每个会话当前正在 await 的外部动作（起评审 / 发提示词 / 合并）：防重入。 */
  private busy = new Set<string>();
  private host: AutoHost;

  constructor(host: AutoHost) {
    this.host = host;
  }

  get(session: string): AutoState | null {
    return this.states.get(session) ?? null;
  }

  /** 盘上那份（页面 first paint 时可能还没接回内存）。 */
  read(session: string): AutoState | null {
    return this.get(session) ?? readAuto(session);
  }

  start(input: StartAutoInput): AutoResult {
    const session = String(input.session ?? "");
    const config = input.config;
    if (!session) return { ok: false, code: "no_session", error: "没有会话：自动评审评的是它的目录", state: null };
    const cur = this.states.get(session);
    if (cur && cur.status === "running") return { ok: false, code: "busy", error: "这个会话已经有一条自动评审在跑了", state: cur };
    if (!config.models.a.model) return { ok: false, code: "no_model", error: "第一个模型没选：交替轮值要两个", state: null };
    if (!config.models.b.model) return { ok: false, code: "no_model", error: "第二个模型没选：交替轮值要两个", state: null };
    if (!config.repo) return { ok: false, code: "not_git", error: "这个目录不是 git 仓库，没有东西可评。", state: null };
    const state: AutoState = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      session,
      config: { ...config, maxRounds: clampRounds(config.maxRounds) },
      status: "running",
      wait: "",
      cur: 0,
      rounds: [],
      reason: "",
      reasonCode: "",
      stopping: false,
      startedAt: nowIso(),
      endedAt: "",
      tokens: 0,
      merge: { pr: config.pr, state: "waiting", note: "", at: "" },
      summary: "",
    };
    this.states.set(session, state);
    this.enteredAt.set(session, Date.now());
    this.host.grant(session, config.autoMerge && config.mode === "pr" && config.pr ? { pr: config.pr, repo: config.repo, branch: config.branch, slug: config.slug } : null);
    this.save(state);
    this.host.log(`auto-review start ${session.slice(0, 8)} · ${config.mode}${config.pr ? ` #${config.pr}` : ""} · max ${state.config.maxRounds}`);
    void this.beginRound(state);
    return { ok: true, code: "", error: "", state };
  }

  /** 停止（D462 第 13 条）：评审立即 cancel；正在改代码的那一轮让它跑完再收。 */
  stop(session: string): AutoResult {
    const state = this.states.get(session) ?? readAuto(session);
    if (!state) return { ok: false, code: "none", error: "这个会话没有自动评审", state: null };
    return this.act(session, state, () => {
      // 终态（签收 / 已合并 / 已停 / 失败）点「停止」不该改写结论 —— 那不是停止，
      // 是把「两家签收」覆盖成「已停止」。什么都不做，把原样交回去。
      if (state.status !== "running" && state.status !== "paused") return false;
      state.stopping = true;
      if (state.wait === "review") {
        const round = this.roundOf(state);
        if (round?.runId) this.host.cancel(state.config.repo, session, round.runId);
        state.status = "stopped";
        state.reason = "你按了停止";
        state.reasonCode = "user-stopped";
        this.finish(state);
        return true;
      }
      if (state.wait === "merge") {
        state.status = "stopped";
        state.reason = "你按了停止";
        state.reasonCode = "user-stopped";
        this.finish(state);
        return true;
      }
      // wait === "fix"：让它跑完（下面 tick 里 settle 之后收）
      state.reason = "跑完这一轮就停";
      state.reasonCode = "stopping";
      this.save(state);
      return true;
    });
  }

  /**
   * 你在会话里发言 = 接管（D462 第 14 条）：停在「已暂停」，进度保留，之后能【继续】。
   * 正在跑的评审立即 cancel；正在改代码的那一轮不 abort（会留半成品工作区）。
   */
  handOver(session: string): AutoResult {
    const state = this.states.get(session) ?? readAuto(session);
    if (!state) return { ok: false, code: "none", error: "这个会话没有自动评审", state: null };
    return this.act(session, state, () => {
      if (state.status !== "running") return false;
      const round = this.roundOf(state);
      if (state.wait === "review") {
        // 这一轮没跑完：作废（继续时会同号重跑），别让它继续烧 token
        if (round?.runId) this.host.cancel(state.config.repo, session, round.runId);
        if (round) {
          round.status = "skipped";
          round.note = "takeover";
          round.finishedAt = nowIso();
        }
      } else if (state.wait === "fix") {
        // 修复轮交给你的话去接管：这一轮**作废**（skipped），不再替它发下一条，继续时直接开下一轮。
        // 以前只清 wait、这一轮还停在「有意见」上 —— 时间线上它永远显示「有意见但没修」。
        if (round) {
          round.status = "skipped";
          round.note = "takeover";
          round.finishedAt = nowIso();
        }
        state.wait = "";
      }
      this.pause(state, "user-takeover", "你在会话里接管了，自动评审停在这里");
      return true;
    });
  }

  /** 继续：从暂停处重跑被打断的那一步。 */
  continue(session: string): AutoResult {
    const state = this.states.get(session) ?? readAuto(session);
    if (!state) return { ok: false, code: "none", error: "这个会话没有自动评审", state: null };
    return this.act(session, state, () => {
      if (state.status !== "paused") return false;
      state.status = "running";
      state.stopping = false;
      state.reason = "";
      state.reasonCode = "";
      this.host.grant(session, state.config.autoMerge && state.config.mode === "pr" && state.config.pr ? { pr: state.config.pr, repo: state.config.repo, branch: state.config.branch, slug: state.config.slug } : null);
      const round = this.roundOf(state);
      if (state.wait === "review") {
        // 上一次那一轮没跑完：同号重跑（签收要的是「这一份 diff 上」的结论，重跑不改语义）
        if (round) {
          round.runId = "";
          round.status = "running";
          round.note = "";
          state.rounds = state.rounds.filter((r) => r.n <= state.cur);
          void this.beginReview(state, round);
        } else {
          void this.beginRound(state);
        }
        this.save(state);
        return true;
      }
      if (state.wait === "fix") {
        // 继续 = 让它把这一轮再修一次（上一次没跑完 / 卡在没提交）
        const findings = round ? this.findingsFor(state, round) : [];
        if (round && findings.length) {
          round.fix = undefined;
          void this.injectFix(state, round, findings);
        } else {
          // 走 pause()：它会收回刚发出去的授权、打日志、写 summary —— 手写这三行会漏掉授权，
          // 于是「已经暂停」的会话还捏着一张 6 小时的推送 / 合并许可。
          this.pause(state, "lost-findings", "找不到那一轮的意见了，重开一条吧");
        }
        return true;
      }
      if (state.wait === "merge") {
        // 两种暂停要分开：
        //   • 接管 / 会话报错暂停（指令已发、结果未明）：**不重发**，只把上次查到的结果忘掉，
        //     让 stepMerge 再去问一次 PR —— 它可能已经合了；
        //   • 上次查完确认没合（merge-failed）：指令那一下没生效，把「发过了」撤回、从 checks
        //     重新走一遍。不清的话 beginMerge 直接 return，用户会陷进「继续 → 立刻又失败」的空转。
        if (state.merge.state === "failed") state.merge.at = "";
        state.merge.state = "waiting";
        state.merge.note = "";
        void this.beginMerge(state);
        this.save(state);
        return true;
      }
      void this.beginRound(state);
      return true;
    });
  }

  /** 跳过这一轮：永不计入签收（D462 第 12 条）。 */
  skip(session: string): AutoResult {
    const state = this.states.get(session) ?? readAuto(session);
    if (!state) return { ok: false, code: "none", error: "这个会话没有自动评审", state: null };
    return this.act(session, state, () => {
      if (state.status !== "paused" && state.status !== "running") return false;
      const round = this.roundOf(state);
      // 会话正在改代码时不能跳：下一轮评的是它改到一半的工作区，而且会给正在跑的会话再排一条
      // 修复指令 —— 两条修复叠在一起。要跳，先等它改完（或者按「停止」）。
      if (state.wait === "fix") {
        const sess = this.host.session(session);
        if (sess?.running) return false;
      }
      if (round && (state.wait === "review" || state.wait === "fix")) {
        // 评审 run 早就结束了，这里 cancel 的是「万一还没跑完」；修复轮没有 run 可取消。
        if (round.runId && state.wait === "review") this.host.cancel(state.config.repo, session, round.runId);
        round.status = "skipped";
        round.note = "skipped";
        round.finishedAt = nowIso();
      }
      state.stopping = false;
      state.reason = "";
      state.reasonCode = "";
      if (state.wait === "merge") {
        // 停在合并那一步被跳过：算签收但没合并
        state.status = "signed";
        this.finish(state);
        return true;
      }
      state.status = "running";
      void this.beginRound(state);
      return true;
    });
  }

  /** 开机接回上一代留下的自动评审（D462 第 4 条）。 */
  resume(): number {
    let n = 0;
    for (const state of listAuto()) {
      if (!state.session) continue;
      if (state.status !== "running" && !(state.status === "paused" && state.reasonCode === "stopping")) continue;
      this.states.set(state.session, state);
      this.enteredAt.set(state.session, Date.now());
      // 会话没了 / 目录没了：停在原地等人，而不是自己去点一遍。
      // 「会话没了」只看**名册**：换脑开机时壳里活着的会话要过几秒才被认领进来，那一刻
      // `session()` 还是 null —— 以前就是在这里把每条 running 都判成了 session-gone。
      if (!this.host.known(state.session) || !state.config.cwd) {
        state.status = "paused";
        state.reason = "会话没在运行，接不回来了";
        state.reasonCode = "session-gone";
        this.save(state);
        continue;
      }
      if (state.config.autoMerge && state.config.mode === "pr" && state.config.pr && state.status === "running") {
        this.host.grant(state.session, { pr: state.config.pr, repo: state.config.repo, branch: state.config.branch, slug: state.config.slug });
      }
      n++;
      this.host.log(`auto-review resume ${state.session.slice(0, 8)} · wait=${state.wait || "-"} · round ${state.cur}`);
    }
    return n;
  }

  /** 全局定时器：每个会话推进一小步。 */
  tick(): void {
    for (const state of [...this.states.values()]) {
      if (state.status !== "running") continue;
      void this.step(state);
    }
  }

  // ------------------------------------------------------------------ 步骤

  private async step(state: AutoState): Promise<void> {
    if (this.busy.has(state.session)) return;
    const session = this.host.session(state.session);
    if (!session) {
      // 名册里有、对象还没有：多半是换脑后壳里的会话还没被认领进来（`activate` 比 `resume` 晚几秒）。
      // 给一段宽限让它被接回来；名册里都没有、或者等过头了，才是真的接不回来。
      if (this.host.known(state.session) && Date.now() - this.resumedAt(state) < SESSION_GRACE_MS) return;
      this.pause(state, "session-gone", "会话没在运行，自动评审接不回来");
      return;
    }
    if (state.wait === "review") return this.stepReview(state);
    if (state.wait === "fix") return this.stepFix(state);
    if (state.wait === "merge") return this.stepMerge(state);
  }

  private stepReview(state: AutoState): void {
    const round = this.roundOf(state);
    if (!round || !round.runId) return;
    const p = this.host.progress(state.config.repo, state.session, round.runId);
    if (!p || p.status === "running") return;
    if (state.stopping) {
      this.host.cancel(state.config.repo, state.session, round.runId);
      round.status = "skipped";
      round.note = "stopped";
      round.finishedAt = nowIso();
      state.status = "stopped";
      state.reason = "你按了停止";
      state.reasonCode = "user-stopped";
      this.finish(state);
      return;
    }
    if (p.status !== "done") {
      round.status = "failed";
      round.note = p.status;
      round.finishedAt = nowIso();
      this.pause(state, p.status === "stale" ? "review-stale" : "review-failed", round.note);
      return;
    }
    this.completeReview(state, round, p.findings ?? [], p.tokens ?? 0);
  }

  private stepFix(state: AutoState): void {
    const round = this.roundOf(state);
    if (!round || !round.fix) return;
    const sess = this.host.session(state.session);
    if (!sess) {
      this.pause(state, "session-gone", "会话没在运行，修完没修完看不出来");
      return;
    }
    if (sess.running) return;
    if (state.stopping) {
      state.status = "stopped";
      state.reason = "你按了停止";
      state.reasonCode = "user-stopped";
      this.finish(state);
      return;
    }
    if (this.busy.has(state.session)) return; // 上一次的收尾（可能要推几分钟）还没回来
    void this.completeFix(state, round, sess);
  }

  private stepMerge(state: AutoState): void {
    if (!state.merge.at) return;
    const sess = this.host.session(state.session);
    if (!sess) {
      this.pause(state, "session-gone", "会话没在运行，合并结果看不出来");
      return;
    }
    if (sess.running) return;
    // 那句话刚发出去时 `running` 可能还没翻上来（followUp 在队里、pi 还没开始跑）：
    // 立刻查 PR 只会得到「还是 OPEN：合并那句话没有生效」。给一个最小等待。
    if (Date.now() - Date.parse(state.merge.at) < MERGE_MIN_WAIT_MS) return;
    this.busy.add(state.session);
    void this.host
      .prState(state.config, state.session)
      .then((out) => {
        if (state.stopping || state.status !== "running") return;
        if (out.merged) {
          state.merge.state = "merged";
          state.merge.note = out.note;
          state.status = "merged";
          this.finish(state);
        } else {
          state.merge.state = "failed";
          state.merge.note = out.note || "合并没有成功";
          this.pause(state, "merge-failed", state.merge.note);
        }
      })
      .catch((err: any) => this.pause(state, "merge-failed", String(err?.message ?? err)))
      .finally(() => this.busy.delete(state.session));
  }

  /** 起第 n 轮（n = 已有最大号 + 1）。 */
  private async beginRound(state: AutoState): Promise<void> {
    if (state.status !== "running") return;
    // 轮数上限在这里也要查一次：以前只在「有意见」的分支查，两轮都干净但 sha 不同时会开出
    // 第 maxRounds+1 轮 —— 上限实际比设置的多一轮。
    const cap = clampRounds(state.config.maxRounds);
    if (state.rounds.filter((r) => r.status !== "skipped").length >= cap) {
      this.pause(state, "max-rounds", `到了轮数上限（${cap} 轮）`);
      return;
    }
    // 「停止」落在收尾途中（推一次可能要几分钟，期间 `step()` 一直在等 busy）：
    // 修完就停，别再起一轮新的评审去烧 token —— 那正是 stop() 的字面语义。
    if (state.stopping) {
      state.status = "stopped";
      state.reason = "你按了停止";
      state.reasonCode = "user-stopped";
      this.finish(state);
      return;
    }
    const n = nextRoundNo(state.rounds);
    const slot = slotOf(n);
    const model = slot === "A" ? state.config.models.a : state.config.models.b;
    const round: AutoRound = {
      n,
      slot,
      model: model.model,
      provider: model.provider,
      label: model.label || `${model.provider}/${model.model}`,
      runId: "",
      at: nowIso(),
      finishedAt: "",
      status: "running",
      sha: this.host.head(state.config.cwd) || "",
      findings: 0,
      severity: {},
      keys: [],
      tokens: 0,
      ms: 0,
      note: "",
      marks: [],
      verdicts: [],
    };
    state.rounds.push(round);
    state.cur = n;
    state.wait = "review";
    this.save(state);
    await this.beginReview(state, round);
  }

  private async beginReview(state: AutoState, round: AutoRound): Promise<void> {
    this.busy.add(state.session);
    try {
      const scope = scopeForRound(state.config, round.n);
      const slot = round.slot;
      const model = slot === "A" ? state.config.models.a : state.config.models.b;
      const out = await this.host.start({ dir: state.config.repo, scope, session: state.session, model, lang: state.config.lang });
      round.runId = out.runId;
      // 起的过程中被按停 / 接管：状态已经不是 running 了，这条 run 没人会去读 —— 取消掉，
      // 别让它在后台把一整轮 token 烧完（stop() 那边拿不到 runId，取消不了）。
      if (state.status !== "running") {
        this.host.cancel(state.config.repo, state.session, out.runId);
        return;
      }
      round.sha = this.host.head(state.config.cwd) || round.sha;
      this.save(state);
    } catch (err: any) {
      round.status = "failed";
      round.note = String(err?.message ?? err);
      round.finishedAt = nowIso();
      this.pause(state, String(err?.code ?? "start-failed"), round.note);
    } finally {
      this.busy.delete(state.session);
    }
  }

  private completeReview(state: AutoState, round: AutoRound, findings: ReviewFinding[], tokens: number): void {
    round.finishedAt = nowIso();
    round.tokens = tokens;
    round.findings = findings.length;
    round.keys = findings.map((f) => String(f.key ?? ""));
    round.severity = {};
    for (const f of findings) round.severity[f.severity] = (round.severity[f.severity] ?? 0) + 1;
    state.tokens = state.rounds.reduce((sum, r) => sum + (r.tokens || 0), 0);
    state.rounds = state.rounds.map((r) => (r.n === round.n ? round : r));
    if (!findings.length) {
      round.status = "clean";
      this.save(state);
      if (signedOff(state.rounds)) return this.settle(state);
      void this.beginRound(state);
      return;
    }
    round.status = "findings";
    this.save(state);
    const fuse = fuseReason(state);
    if (fuse) {
      this.pause(
        state,
        fuse.code,
        fuse.code === "max-rounds" ? `到了轮数上限（${clampRounds(state.config.maxRounds)} 轮）` : `同一批意见连续两轮还在（${fuse.keys.length} 条）`,
      );
      return;
    }
    void this.injectFix(state, round, findings);
  }

  private async completeFix(state: AutoState, round: AutoRound, sess: NonNullable<ReturnType<AutoHost["session"]>>): Promise<void> {
    const fix = round.fix;
    if (!fix) return;
    // 一次取回：各读一次的话，两次之间 items 被追加，文本与报错就会落在不同的消息上。
    const reply = sess.lastReply(fix.promptAt);
    const text = reply.text;
    const err = reply.error;
    const parsed = parseVerdict(text);
    const findings = this.findingsFor(state, round);
    const shaAfter = this.host.head(state.config.cwd) || "";
    const dirty = this.host.dirty(state.config.cwd);
    const changed = Boolean(shaAfter && shaAfter !== fix.shaBefore);

    if (err && !parsed.ok) {
      this.pause(state, "session-error", err.slice(0, 200));
      return;
    }

    if (!changed && !dirty) {
      // 什么都没动：只有**回执逐条说「不成立 / 不改」**才算签过（D462 第 2 条的误报签收）。
      // 没有可用的回执就停下来问人 —— 「它没干活」与「它判过不改」在 git 上长得一样，
      // 不能拿「没改动」当签收的证据（D462 第 3 / 12 条）。
      const judged = parsed.ok ? dismissalMarks(findings, parsed.verdicts) : { all: false, marks: [] as { key: string; mark: ReviewMark }[] };
      if (!judged.all) {
        round.note = "no-evidence";
        this.pause(state, "no-evidence", "这一轮既没有提交、也没有可用回执 —— 看不出它判了什么");
        return;
      }
      round.status = "clean";
      round.note = "dismissed";
      round.marks = judged.marks;
      round.verdicts = parsed.verdicts;
      fix.dismissed = parsed.verdicts.filter((v) => v.verdict !== "fixed").length;
      fix.fixed = parsed.verdicts.filter((v) => v.verdict === "fixed").length;
      fix.note = parsed.note;
      this.save(state);
      if (signedOff(state.rounds)) return this.settle(state);
      void this.beginRound(state);
      return;
    }

    if (dirty) {
      // 工作区还脏着（不管有没有提交）：改了没提交，或者提交了一部分、还留着半截没提交。
      // 两种都不能往下走 —— 推上去 / 开下一轮评的都是**不含脏改动**的 HEAD，签收后合并的
      // 就是个不完整的修复。再提醒一次（只提醒一次，第二次还没提交就停下来）。
      // 「提醒过没有」用 `nudged` 记，不借用 `note` —— 那格装着回执的理由。
      if (!fix.nudged) {
        fix.nudged = true;
        fix.note = "uncommitted";
        this.save(state);
        void this.nudgeCommit(state, round, changed);
        return;
      }
      // 补过提醒了：还要给它一点时间。没有新的 assistant 消息 = 那句提醒可能还排在队里
      // （会话在跑时它是 followUp），这时候立刻判死等于把它刚排上的队作废；但也不能无限等 ——
      // 过了宽限期还是没有动静，就按「改了没提交」停下来问人。
      if (!text && Date.now() - Date.parse(fix.promptAt || "") < NUDGE_GRACE_MS) return;
      this.pause(state, "uncommitted", "这一轮改完没有提交（改了但没 commit）");
      return;
    }

    // 有提交：记下改了什么，PR 模式把分支推上去
    fix.shaAfter = shaAfter;
    fix.subject = this.host.subject(state.config.cwd, shaAfter);
    const stat = this.host.diffstat(state.config.cwd, fix.shaBefore);
    fix.files = stat.files;
    fix.added = stat.added;
    fix.removed = stat.removed;
    fix.dismissed = parsed.verdicts.filter((v) => v.verdict !== "fixed").length;
    fix.fixed = parsed.verdicts.filter((v) => v.verdict === "fixed").length;
    if (parsed.note) fix.note = parsed.note;
    // 提交了、但没按格式回执：git 事实兜底往下走（下一轮评的是真代码），但记一笔「无回执」——
    // 这种轮次永远走不到「误报签收」，面板与日志都该看得出它和「回了」的区别。
    if (!parsed.ok) fix.noReceipt = true;
    if (parsed.ok) {
      const judged = dismissalMarks(findings, parsed.verdicts);
      round.marks = judged.marks;
      round.verdicts = parsed.verdicts;
    }
    if (state.config.mode === "pr") {
      this.busy.add(state.session);
      let push: { ok: boolean; note: string };
      try {
        push = await this.host.push(state.config.cwd, state.config.branch);
      } catch (err: any) {
        push = { ok: false, note: String(err?.message ?? err) };
      } finally {
        this.busy.delete(state.session);
      }
      fix.pushed = push.ok;
      if (!push.ok) {
        this.save(state);
        this.pause(state, "push-failed", push.note || "推送没成功");
        return;
      }
    }
    this.save(state);
    void this.beginRound(state);
  }

  private async injectFix(state: AutoState, round: AutoRound, findings: ReviewFinding[]): Promise<void> {
    const sess = this.host.session(state.session);
    if (!sess) {
      this.pause(state, "session-gone", "会话没在运行，没法把意见交给它");
      return;
    }
    const text = fixPrompt({ round: round.n, findings, config: state.config, where: whereOf(state.config) });
    round.fix = {
      promptAt: nowIso(),
      shaBefore: round.sha || this.host.head(state.config.cwd) || "",
      shaAfter: "",
      files: 0,
      added: 0,
      removed: 0,
      pushed: false,
      dismissed: 0,
      fixed: 0,
      note: "",
    };
    state.wait = "fix";
    this.save(state);
    this.busy.add(state.session);
    try {
      await sess.prompt(text);
    } catch (err: any) {
      this.pause(state, "prompt-failed", String(err?.message ?? err));
    } finally {
      this.busy.delete(state.session);
    }
  }

  /** 「改了没提交」时补一句话，不算新的一轮（`fix.nudged` 记着已经补过）。 */
  private async nudgeCommit(state: AutoState, round: AutoRound, partly: boolean): Promise<void> {
    const sess = this.host.session(state.session);
    if (!sess) return;
    const at = nowIso();
    if (round.fix) round.fix.promptAt = at;
    this.busy.add(state.session);
    // 「已经提交了一部分」要说清：不然 agent 以为自己已经交过差了，不知道还剩着半截。
    const what = partly ? "还有改动没有提交（上一部分已经提交了，剩下的还没）" : "还有改动没有提交";
    try {
      await sess.prompt(`${AUTO_MARK} 自动评审 · 第 ${round.n} 轮：${what}\n把剩下的改动也提交（\`fix(review): …\`），不要改代码本身。提交完就停。`);
    } catch (err: any) {
      this.pause(state, "prompt-failed", String(err?.message ?? err));
    } finally {
      this.busy.delete(state.session);
    }
  }

  /** 签收：要么直接结束，要么进合并那一步。 */
  private settle(state: AutoState): void {
    const pr = state.config.mode === "pr" ? state.config.pr : 0;
    if (!state.config.autoMerge || !pr) {
      state.status = "signed";
      state.wait = "";
      this.finish(state);
      return;
    }
    state.wait = "merge";
    state.merge.state = "waiting";
    // 合并那句话要过审批闸：授权必须**在**（pause / finish 才收）。
    this.host.grant(state.session, { pr, repo: state.config.repo, branch: state.config.branch, slug: state.config.slug });
    this.save(state);
    void this.beginMerge(state);
  }

  private async beginMerge(state: AutoState): Promise<void> {
    // 合并那句话已经发过（接管 / 暂停之后再「继续」）：不再发第二遍 —— gh 会报错，
    // 更糟的是「它其实已经合了」时又发一次。接着等 `prState` 就够（tick 里的 `stepMerge`），
    // 真没合上会在那里暂停并说清状态。
    if (state.merge.at) return;
    const pr = state.config.pr;
    this.busy.add(state.session);
    try {
      const checks = await this.host.prChecks(state.config, state.session);
      if (state.status !== "running") return;
      if (!checks.ok) {
        this.pause(state, "checks", checks.note || "checks 没绿");
        return;
      }
      const sess = this.host.session(state.session);
      if (!sess) {
        this.pause(state, "session-gone", "会话没在运行，没法让它合并");
        return;
      }
      state.merge.at = nowIso();
      this.save(state);
      await sess.prompt(
        mergePrompt({
          pr,
          rounds: state.rounds.length,
          models: [state.config.models.a, state.config.models.b].map((m) => m.label || `${m.provider}/${m.model}`).join(" / "),
        }),
      );
    } catch (err: any) {
      // 那句话没发出去（会话刚停 / 压缩超时）：把「发过了」撤回，否则之后「继续」会以为已经发过、
      // 永远不再重发，只能在 stepMerge 里反复查出一个「没合」。
      state.merge.at = "";
      this.pause(state, "merge-failed", String(err?.message ?? err));
    } finally {
      this.busy.delete(state.session);
    }
  }

  // ------------------------------------------------------------------ 收尾与工具

  private pause(state: AutoState, code: string, reason: string): void {
    if (state.status === "stopped" || state.status === "signed" || state.status === "merged") return;
    state.status = "paused";
    state.reasonCode = code;
    state.reason = reason;
    state.stopping = false;
    state.summary = summaryText(state);
    // 暂停就把授权收回去：「继续」会重新给 —— 授权跟着「正在跑」而不是跟着会话。
    this.host.grant(state.session, null);
    this.save(state);
    this.host.log(`auto-review pause ${state.session.slice(0, 8)} · ${code} · ${reason}`);
  }

  private finish(state: AutoState): void {
    state.endedAt = nowIso();
    state.wait = "";
    state.stopping = false;
    state.summary = summaryText(state);
    this.host.grant(state.session, null);
    this.save(state);
    const marks: { repo: string; session: string; key: string; mark: ReviewMark }[] = [];
    for (const round of state.rounds) for (const m of round.marks ?? []) marks.push({ repo: state.config.repo, session: state.session, key: m.key, mark: m.mark });
    try {
      this.host.finish(state, state.summary, marks);
    } catch (err: any) {
      this.host.log(`auto-review finish hook failed: ${String(err?.message ?? err)}`);
    }
  }

  private save(state: AutoState): void {
    state.tokens = state.rounds.reduce((sum, r) => sum + (r.tokens || 0), 0);
    state.summary = summaryText(state);
    try {
      writeAuto(state);
    } catch (err: any) {
      this.host.log(`auto-review save failed: ${String(err?.message ?? err)}`);
    }
    this.host.emit(state);
  }

  private resumedAt(state: AutoState): number {
    return this.enteredAt.get(state.session) ?? 0;
  }

  private roundOf(state: AutoState): AutoRound | null {
    return state.rounds.find((r) => r.n === state.cur) ?? null;
  }

  private findingsFor(state: AutoState, round: AutoRound): ReviewFinding[] {
    return this.host.findings(state.config.repo, state.session, round.runId) ?? [];
  }

  /** 包一层：同一个会话同一时刻只让一个动作进来。 */
  private act(session: string, state: AutoState, fn: () => boolean): AutoResult {
    this.states.set(session, state);
    let ok = false;
    try {
      ok = fn();
    } catch (err: any) {
      return { ok: false, code: "failed", error: String(err?.message ?? err), state };
    }
    if (!ok) return { ok: false, code: "noop", error: "现在没有可做的", state };
    return { ok: true, code: "", error: "", state };
  }
}

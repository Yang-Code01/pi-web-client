/**
 * #484 上下文策略：把「模型窗口的百分之多少」这一件事算清楚，别处只负责调它。
 *
 * 三个来源叠起来，近的赢：会话 > 项目 > 全局。全局/项目存在 pi 的 `settings.json` 里（`web.*`，
 * 与 `web.defaultPermission` 同一个命名空间），会话覆盖存在自己的状态文件里。都没有时：压缩 70%、
 * 交接关（关的时候没有百分比，避免「开都没开却有个数」）。
 *
 * 线再被 pi 自己的压缩线夹一次：pi 在 `窗口 − reserveTokens`（默认 16384）会自己压，桥的线落在
 * 它下面才有意义。所以「设了 70%」不等于「真的在 70% 触发」—— 32K 的窗口上 70% 已经越过 pi 的线，
 * 实际生效的是 ~42.5%。这套夹取写在 `effectiveLine()` 里，前端拿同一份数字显示。
 *
 * 纯函数，不碰 IO：单测直接调，`sessions.ts` 只把 stats 和设置喂进来。
 */

/** 两条线都允许的范围：太小会一直触发，太大就没机会触发（尤其是小窗口模型）。 */
export const PERCENT_MIN = 5;
export const PERCENT_MAX = 90;
/** 两条线离得太近会互相抢；保存时按解析后的值校验，不是按某一层填的那个数。 */
export const PERCENT_GAP = 5;
/** pi 的 `compaction.reserveTokens` 默认值（dist/core/settings-defaults.js）。 */
export const PI_RESERVE_TOKENS = 16384;
/** 越过线那一刻还要给这次回答留的地方：不然压完只剩几千 token，等于白压。 */
export const SAFETY_MARGIN_TOKENS = 2000;
/** 出厂默认：压缩 70%。交接默认关，所以没有默认百分比。 */
export const DEFAULT_COMPACT_PERCENT = 70;
/** 「打开自动交接」时表单里预填的值；只是建议，用户改什么都行。 */
export const SUGGESTED_HANDOFF_PERCENT = 85;

export type SettingSource = "session" | "project" | "global" | "default";

/** 一层设置。`undefined` = 这层没说话（跟随下层）；`null` 与 `undefined` 同义，写盘时用 null 表示「删掉」。 */
export interface ContextSettings {
  autoCompactPercent?: number | null;
  autoHandoffEnabled?: boolean | null;
  autoHandoffPercent?: number | null;
}

export interface ContextLayers {
  global: ContextSettings;
  project: ContextSettings;
  session: ContextSettings;
}

export interface ResolvedContext {
  /** 生效的压缩线（百分比，未经夹取）。 */
  compactPercent: number;
  compactFrom: SettingSource;
  /** pi 自己的 `compaction.enabled`：关掉它，桥也不再自动压缩（否则 pi 不压、桥偷偷压）。 */
  compactOn: boolean;
  handoffOn: boolean;
  handoffFrom: SettingSource;
  /** null = 交接开着却没设百分比：这时不触发，界面上提示去设。 */
  handoffPercent: number | null;
  handoffPercentFrom: SettingSource;
}

/** 夹取后的真实线。`percent` 是这条线在窗口里的真实占比（一位小数），`clamped` 表示被 pi 的线压过。 */
export interface ContextLine {
  line: number;
  percent: number;
  clamped: boolean;
}

export type ContextAction = "none" | "compact" | "handoff";

export interface ContextDecision extends ContextLine {
  action: ContextAction;
  used: number | null;
  window: number | null;
}

/** 保存时的拒绝理由。文本由调用方（网页 tr() / 桥的通知）自己出，这里只给原因。 */
export type ContextError =
  | { code: "range"; field: "compact" | "handoff" }
  | { code: "equal" }
  | { code: "gap" }
  /** 自动交接要靠用户的 /handoff 技能，没装它就别把开关打开。 */
  | { code: "skill" };

const none = (used: number | null, window: number | null): ContextDecision => ({
  action: "none",
  line: 0,
  percent: 0,
  clamped: false,
  used,
  window,
});

/** 设置文件里可能是数字、数字字符串、null —— 只有前两种、且落在范围内才算「这层说了话」以外的数。 */
export function parsePercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function pick(layers: ContextLayers, key: keyof ContextSettings): { value: number | boolean; from: SettingSource } | null {
  for (const from of ["session", "project", "global"] as const) {
    const raw = layers[from]?.[key];
    if (raw === undefined || raw === null) continue;
    if (key === "autoHandoffEnabled") {
      if (typeof raw === "boolean") return { value: raw, from };
      continue;
    }
    const n = parsePercent(raw);
    if (n !== null) return { value: n, from };
  }
  return null;
}

/** `web.*` 三键从一份 settings.json 里取出来（pi 的 schema 不认识它们，桥自己读）。 */
export function contextFromSettings(json: Record<string, unknown> | unknown): ContextSettings {
  const web = (json && typeof json === "object" ? (json as Record<string, unknown>).web : null) as Record<string, unknown> | null;
  if (!web || typeof web !== "object") return {};
  const out: ContextSettings = {};
  const compact = parsePercent(web.autoCompactPercent);
  if (compact !== null) out.autoCompactPercent = compact;
  if (typeof web.autoHandoffEnabled === "boolean") out.autoHandoffEnabled = web.autoHandoffEnabled;
  const handoff = parsePercent(web.autoHandoffPercent);
  if (handoff !== null) out.autoHandoffPercent = handoff;
  return out;
}

/** pi 的 `compaction.enabled`（没有就是用 pi 的默认 true）。 */
export function compactionEnabledFrom(json: Record<string, unknown> | unknown): boolean | null {
  const compaction = (json && typeof json === "object" ? (json as Record<string, unknown>).compaction : null) as Record<string, unknown> | null;
  if (!compaction || typeof compaction !== "object") return null;
  return typeof compaction.enabled === "boolean" ? compaction.enabled : null;
}

/** 三层合一。缺省：压缩 70%、交接关。 */
export function resolveContext(layers: ContextLayers, compactionEnabled = true): ResolvedContext {
  const compact = pick(layers, "autoCompactPercent");
  const enabled = pick(layers, "autoHandoffEnabled");
  const handoff = pick(layers, "autoHandoffPercent");
  return {
    compactPercent: typeof compact?.value === "number" ? compact.value : DEFAULT_COMPACT_PERCENT,
    compactFrom: compact?.from ?? "default",
    compactOn: compactionEnabled,
    handoffOn: enabled?.value === true,
    handoffFrom: enabled?.from ?? "default",
    handoffPercent: typeof handoff?.value === "number" ? handoff.value : null,
    handoffPercentFrom: handoff?.from ?? "default",
  };
}

/**
 * 百分比 → 真实触发线。窗口未知（还没有 stats）时返回 null：宁可不动，也不要拿一个猜的窗口去压。
 * 夹取后可能低于 `PERCENT_MIN`（很小的窗口），这不算配置错 —— 是模型本身没有空间。
 */
export function effectiveLine(percent: number, window: number | null | undefined): ContextLine | null {
  if (!window || !Number.isFinite(window) || window <= 0) return null;
  const pct = Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, Math.round(percent)));
  const raw = Math.round((window * pct) / 100);
  const cap = Math.max(0, window - PI_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS);
  const line = Math.min(raw, cap);
  return {
    line,
    percent: Math.round((line / window) * 1000) / 10,
    clamped: line < raw,
  };
}

/**
 * 这一刻该做什么。交接开着时压缩自动让位 —— 两条都开时低的那条决定谁触发，而压缩会把上下文压回去，
 * 让交接永远到不了；所以两者在策略上互斥，交接赢。#484 的 D 条目里写了理由。
 */
export function decideContext(input: {
  used: number | null;
  window: number | null;
  policy: ResolvedContext;
}): ContextDecision {
  const { used, window, policy } = input;
  if (!used || used < 0 || !window) return none(used, window);
  if (policy.handoffOn && policy.handoffPercent !== null) {
    const line = effectiveLine(policy.handoffPercent, window);
    if (line && used >= line.line) return { ...line, action: "handoff", used, window };
    return none(used, window);
  }
  if (!policy.compactOn) return none(used, window);
  const line = effectiveLine(policy.compactPercent, window);
  if (line && used >= line.line) return { ...line, action: "compact", used, window };
  return none(used, window);
}

/**
 * 保存前校验「解析后」的值：会话层填 70%、项目层 74% 撞上时，该报错的是保存这一刻，而不是触发时。
 * 交接没开（或没设百分比）时不参与比较 —— 那条线根本不会触发。
 */
export function validateContext(policy: ResolvedContext): ContextError | null {
  if (policy.compactOn && (policy.compactPercent < PERCENT_MIN || policy.compactPercent > PERCENT_MAX)) {
    return { code: "range", field: "compact" };
  }
  if (policy.handoffOn && policy.handoffPercent !== null) {
    if (policy.handoffPercent < PERCENT_MIN || policy.handoffPercent > PERCENT_MAX) return { code: "range", field: "handoff" };
    if (policy.compactOn) {
      const gap = Math.abs(policy.handoffPercent - policy.compactPercent);
      if (gap === 0) return { code: "equal" };
      if (gap < PERCENT_GAP) return { code: "gap" };
    }
  }
  return null;
}

/** 一条给页面看的完整策略：三层原值（表单要回显）+ 生效值 + 夹取后的两条真实线。 */
export interface ContextPolicyView {
  layers: ContextLayers;
  policy: ResolvedContext;
  window: number | null;
  used: number | null;
  /** 夹取后的压缩线；pi 自己的开关关着时为 null。 */
  compact: ContextLine | null;
  /** 夹取后的交接线；没开或没设百分比时为 null。 */
  handoff: ContextLine | null;
  /** 当前排在前面的动作（和 `decideContext` 同一口径），页面照着说「再涨 12% 就压缩」。 */
  decision: ContextDecision;
}

/** 把三层 + 一次测量折成页面/桥都想看的那一份。纯函数：读设置由调用方做。 */
export function policyView(input: {
  layers: ContextLayers;
  compactionEnabled: boolean;
  window: number | null;
  used: number | null;
}): ContextPolicyView {
  const policy = resolveContext(input.layers, input.compactionEnabled);
  return {
    layers: input.layers,
    policy,
    window: input.window,
    used: input.used,
    compact: policy.compactOn ? effectiveLine(policy.compactPercent, input.window) : null,
    handoff: policy.handoffOn && policy.handoffPercent !== null ? effectiveLine(policy.handoffPercent, input.window) : null,
    decision: decideContext({ used: input.used, window: input.window, policy }),
  };
}

/** 通知里用的「哪一层说了话」，桥不译，前端自己 tr()。 */
export const SOURCE_ORDER: SettingSource[] = ["session", "project", "global", "default"];

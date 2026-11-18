/**
 * Copilot 的计费口径：pi 的价格表算的是美元，而 Copilot 实际扣的是「积分」（1 credit = $0.01）。
 * bridge 把 copilot 请求的 `usage.cost × 100` 累加成积分（会话里若出现 `copilot-credits` 真值条目
 * 就优先用它），账号额度由 bridge 自己问 GitHub，二者合成一个 `copilot` 帧推过来。
 *
 * 这里只放纯函数，方便单测；界面文案由调用方 `tr()`。
 */

/** bridge 端 `CopilotAccountView` 的镜像。 */
export interface CopilotAccount {
  entitlement: number | null;
  used: number | null;
  remaining: number | null;
  percentRemaining: number | null;
  /** ISO 时间；账号没给就是 null。 */
  resetUtc: string | null;
  plan: string | null;
  sku: string | null;
  unlimited: boolean;
  overagePermitted: boolean;
  /** 拉取这份额度的时刻（ISO）。 */
  at: string;
}

/** bridge 端 `CopilotView` 的镜像。 */
export interface CopilotView {
  hasCopilot: boolean;
  /** 会话累计积分；没记过账时是 null。 */
  credits: number | null;
  /** 记过账的请求数。 */
  requests: number;
  /** 最后一条记账的时间（ISO），没有就是 null。 */
  lastAt: string | null;
  /** 积分是按 pi 的价格表换算的（true）还是有 provider 真值（false）。 */
  estimated?: boolean;
  /** 同一会话里别的 provider 花的美元（分账用）；纯 copilot 会话是 0。 */
  otherCost: number;
  account: CopilotAccount | null;
  /** 对账：相邻两份额度快照之间，本机记账增量与账号增量的偏差（决策 30）。 */
  reconcile: CopilotReconcile | null;
}

/** 对账结果；只有本机偏多才算异常（别的客户端也在花同一个账号的额度）。 */
export interface CopilotReconcile {
  gapPercent: number;
  accountDelta: number;
  localDelta: number;
}

export const EMPTY_COPILOT: CopilotView = { hasCopilot: false, credits: null, requests: 0, lastAt: null, estimated: true, otherCost: 0, account: null, reconcile: null };

/** 1 积分 = $0.01 —— 对账、副标题换算都用它。 */
export const CREDITS_PER_USD = 100;

/**
 * 积分精度：<1 三位、<100 两位、≥100 取整。真值是 nano-AIU 折出来的浮点数，
 * 整数档不加小数；千分位只在 ≥1000 时出现，免得 0.013 这种被写成 0.0,13。
 */
export function formatCredits(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value).toLocaleString("en-US");
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

/** 积分折成美元，只用于「≈ $X」这类副信息。 */
export function creditsToUsd(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const usd = value / CREDITS_PER_USD;
  let digits = 2;
  if (usd < 0.01) digits = 4;
  else if (usd < 1) digits = 3;
  return `$${usd.toFixed(digits)}`;
}

/** 美元折成积分（`cost × 100` —— 会话里没有真值条目时就是这个口径）。 */
export function usdToCredits(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value * CREDITS_PER_USD;
}

/**
 * 账号重置时间：UTC 与本地并列（决策 27）。
 * 输入不是 ISO 或者解析不了就返回 null，调用方整行不显示。
 */
export function formatReset(resetUtc: string | null | undefined, now = Date.now()): { utc: string; local: string; daysLeft: number } | null {
  if (typeof resetUtc !== "string" || !resetUtc) return null;
  const at = Date.parse(resetUtc);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const utc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  const local = `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const daysLeft = Math.max(0, Math.ceil((at - now) / 86_400_000));
  return { utc, local, daysLeft };
}

/** 是不是混合会话：本会话既走过 copilot，又走过花钱的其它 provider（决策 26）。 */
export function isMixed(view: CopilotView | null | undefined): boolean {
  return Boolean(view?.hasCopilot && view.otherCost > 0);
}

/**
 * 「N 分钟前刷新」：额度快照的年龄（决策 23 的最小间隔会让它经常不是 0）。
 * 解析不了就返回 null，调用方不显示这一段。
 */
export function formatAge(iso: string | null | undefined, now = Date.now()): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/** 额度用掉的比例（0–100），进度条用；`unlimited` 或拿不到额度时返回 null。 */
export function usedPercent(account: CopilotAccount | null | undefined): number | null {
  if (!account || account.unlimited) return null;
  const entitlement = account.entitlement;
  const used = account.used;
  if (typeof entitlement !== "number" || !Number.isFinite(entitlement) || entitlement <= 0) return null;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.min(100, Math.max(0, (used / entitlement) * 100));
}

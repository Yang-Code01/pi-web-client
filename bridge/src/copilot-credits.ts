/**
 * Copilot 积分（AI credits）—— 全部在 bridge 里算，不依赖任何 pi 扩展。
 *
 * 两个数，来源不同：
 *
 * 1. **每个会话花了多少积分**：pi 把每次请求的价算进会话条目的 `usage.cost.total`（美元），
 *    而 GitHub 的规矩是 1 积分 = $0.01，所以 `credits = usd × 100`。实测两边逐位相等
 *    （含 cache write；见 docs/COPILOT-CREDITS.md）。会话里如果出现 `copilot-credits` 条目
 *    （将来 pi 自己吐真值，或手工写入），优先用它，不再乘。
 * 2. **这个账号本月还剩多少**：GET `https://api.github.com/copilot_internal/user`，用 pi 存在
 *    `auth.json` 里的 GitHub 凭据。这份快照顺便用来对账（见 `applyAccount`）。
 *
 * 只读：会话文件由 pi 写，这里只按字节 offset 增量读；GitHub 那边只读不算数的账号接口。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 真值条目的 customType（pi 扩展或手工写入时才存在）。 */
export const COPILOT_CREDIT_ENTRY = "copilot-credits";
/** 老版本扩展写的额度快照条目；现在额度由 bridge 自己拉，读到也认。 */
export const COPILOT_ACCOUNT_ENTRY = "copilot-account";
/** 1 AI credit = $0.01（GitHub 2026-06 起的 token 计费），所以积分 → 美元是固定 ÷100。 */
export const CREDITS_PER_USD = 100;

export interface CopilotAccountView {
  /** 本月额度上限；`unlimited` 时是 0 或 null。 */
  entitlement: number | null;
  used: number | null;
  remaining: number | null;
  percentRemaining: number | null;
  /** 额度重置时刻（UTC ISO），账号级字段。 */
  resetUtc: string | null;
  plan: string | null;
  sku: string | null;
  unlimited: boolean;
  overagePermitted: boolean;
  /** 这个快照是什么时候抓的。 */
  at: string;
}

export interface CopilotView {
  /** 这个会话的历史里出现过 copilot（面板据此决定显不显示）。 */
  hasCopilot: boolean;
  /** 本会话累计积分。`estimated` 为 false 时是真值，true 时是 `cost × 100`。 */
  credits: number;
  /** 至少有一笔带价格的请求；`credits === 0` 时靠它区分「没花」与「还没记」。 */
  requests: number;
  lastAt: string | null;
  /** 这些积分是不是按 pi 的价格表换算出来的（没有真值条目时为 true）。 */
  estimated: boolean;
  /**
   * 同一个会话里**别的 provider** 花的美元（分账用）：copilot 的积分不应当和它们的 $ 混成一个数。
   * 纯 copilot 会话这里是 0，前端据此判「混合会话」。
   */
  otherCost: number;
  account: CopilotAccountView | null;
  /**
   * 对账（决策 30）：相邻两次额度快照之间，账号侧的积分增量与本机记账增量对不上时才有值。
   * 别的客户端（VS Code / 其它机器）也会花这个账号的额度，所以只有本机偏多才算异常。
   */
  reconcile: CopilotReconcile | null;
}

export interface CopilotReconcile {
  /** (本机增量 - 账号增量) / 账号增量 × 100。 */
  gapPercent: number;
  accountDelta: number;
  localDelta: number;
}

const EMPTY: CopilotView = {
  hasCopilot: false,
  credits: 0,
  requests: 0,
  lastAt: null,
  estimated: true,
  otherCost: 0,
  account: null,
  reconcile: null,
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function accountOf(data: any): CopilotAccountView | null {
  if (!data || typeof data !== "object") return null;
  const used = num(data.used);
  const remaining = num(data.remaining);
  const at = typeof data.at === "string" ? data.at : new Date().toISOString();
  if (used === null && remaining === null) return null;
  return {
    entitlement: num(data.entitlement),
    used,
    remaining,
    percentRemaining: num(data.percentRemaining),
    resetUtc: typeof data.resetUtc === "string" ? data.resetUtc : null,
    plan: typeof data.plan === "string" ? data.plan : null,
    sku: typeof data.sku === "string" ? data.sku : null,
    unlimited: data.unlimited === true,
    overagePermitted: data.overagePermitted === true,
    at,
  };
}

/**
 * 收下一份新的额度快照，顺便对账：它承接上一份快照以来的本机记账增量。
 * 返回「归属于这份快照的本机累计」，调用方存下来给下一次用。
 * 账号侧重置（used 变小）或样本太小时（< 10 积分）不比 —— 那会把百分比放大成噪声。
 */
function applyAccount(view: CopilotView, prevCredits: number, account: CopilotAccountView): number {
  const prev = view.account;
  view.account = account;
  if (!prev || prev.used === null || account.used === null || prev.at === account.at) return prevCredits;
  const accountDelta = account.used - prev.used;
  if (!(accountDelta >= 10)) {
    view.reconcile = null;
    return view.credits;
  }
  const localDelta = view.credits - prevCredits;
  const gapPercent = ((localDelta - accountDelta) / accountDelta) * 100;
  view.reconcile = { gapPercent, accountDelta, localDelta };
  return view.credits;
}

/** 一行条目里的积分与美元：真值条目优先，没有就按 `usage.cost × 100` 换算。 */
interface Ledger {
  /** 真值条目累计。 */
  exact: number;
  /** `cost × 100` 累计。 */
  converted: number;
  /** 有没有真值条目；有就整段用真值，避免两种口径混着加。 */
  sawExact: boolean;
  requests: number;
  otherCost: number;
  hasCopilot: boolean;
  lastAt: string | null;
}

function emptyLedger(): Ledger {
  return { exact: 0, converted: 0, sawExact: false, requests: 0, otherCost: 0, hasCopilot: false, lastAt: null };
}

function absorbLedger(ledger: Ledger, entry: any): void {
  if (!entry || typeof entry !== "object") return;
  if (entry.type === "custom") {
    const data = entry.data;
    if (entry.customType === COPILOT_CREDIT_ENTRY && data && typeof data === "object") {
      const credits = num(data.credits) ?? (num(data.nanoAiu) !== null ? (num(data.nanoAiu) as number) / 1e9 : null);
      if (credits !== null) {
        ledger.exact += credits;
        ledger.sawExact = true;
      }
      ledger.requests += 1;
      ledger.hasCopilot = true;
      if (typeof data.at === "string") ledger.lastAt = data.at;
    } else if (entry.customType === COPILOT_ACCOUNT_ENTRY) {
      const account = accountOf(data);
      if (account) applyAccount(ledgerView(ledger), ledger.exact, account);
    }
    return;
  }
  if (entry.type !== "message" || entry.message?.role !== "assistant") return;
  const message = entry.message;
  const usd = num(message.usage?.cost?.total);
  if (message.provider === "github-copilot") {
    ledger.hasCopilot = true;
    if (usd !== null) {
      ledger.converted += usd * CREDITS_PER_USD;
      ledger.requests += 1;
      if (typeof message.timestamp === "string") ledger.lastAt = message.timestamp;
      else if (typeof entry.timestamp === "string") ledger.lastAt = entry.timestamp;
    }
    return;
  }
  if (usd !== null) ledger.otherCost += usd;
}

/** `applyAccount` 需要一个 view 形态的账本；额度只存在 view 上，这里借壳。 */
const ledgerViews = new WeakMap<Ledger, CopilotView>();

function ledgerView(ledger: Ledger): CopilotView {
  let view = ledgerViews.get(ledger);
  if (!view) {
    view = { ...EMPTY };
    ledgerViews.set(ledger, view);
  }
  view.credits = ledger.sawExact ? ledger.exact : ledger.converted;
  view.requests = ledger.requests;
  view.hasCopilot = ledger.hasCopilot;
  view.otherCost = ledger.otherCost;
  view.lastAt = ledger.lastAt;
  view.estimated = !ledger.sawExact;
  return view;
}

function viewOf(ledger: Ledger): CopilotView {
  return ledgerView(ledger);
}

/**
 * 增量扫会话 JSONL：只读上次之后新追加的完整行（末尾半行留给下一次）。
 * 文件被截断 / 换掉就从头再来。
 */
export class CopilotTally {
  private offset = 0;
  private ledger: Ledger = emptyLedger();
  /** 上一份额度快照那个时刻的本机累计（对账基线）。 */
  private creditsAtSnapshot = 0;

  reset(): void {
    this.offset = 0;
    this.ledger = emptyLedger();
    this.creditsAtSnapshot = 0;
  }

  /** 读一次；文件不在或读不了时返回上一次的结果（新会话还没有文件）。 */
  read(file: string): CopilotView {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return this.snapshot();
    }
    if (size < this.offset) this.reset();
    if (size > this.offset) {
      let chunk = "";
      try {
        const length = size - this.offset;
        const buf = Buffer.allocUnsafe(length);
        const fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, buf, 0, length, this.offset);
        } finally {
          fs.closeSync(fd);
        }
        const text = buf.toString("utf8");
        const end = text.lastIndexOf("\n");
        if (end >= 0) chunk = text.slice(0, end + 1);
      } catch {
        return this.snapshot();
      }
      if (chunk) {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            continue; // 坏行（或正在写的半行）跳过，下一次还会读到它后面的
          }
          const account = accountIn(entry);
          if (account) {
            this.creditsAtSnapshot = applyAccount(this.view(), this.creditsAtSnapshot, account);
            continue;
          }
          absorbLedger(this.ledger, entry);
        }
        this.offset += Buffer.byteLength(chunk, "utf8");
      }
    }
    return this.snapshot();
  }

  /** 交一份额度快照进来（bridge 自己拉的那种）；游标不动，只更新账号数字。 */
  acceptAccount(account: CopilotAccountView): CopilotView {
    this.creditsAtSnapshot = applyAccount(this.view(), this.creditsAtSnapshot, account);
    return this.snapshot();
  }

  private view(): CopilotView {
    return viewOf(this.ledger);
  }

  private snapshot(): CopilotView {
    const view = this.view();
    return {
      ...view,
      account: view.account ? { ...view.account } : null,
      reconcile: view.reconcile ? { ...view.reconcile } : null,
    };
  }
}

/** 会话条目里的额度快照（老版本扩展写的）；不是就返回 null。 */
function accountIn(entry: any): CopilotAccountView | null {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "custom" || entry.customType !== COPILOT_ACCOUNT_ENTRY) return null;
  return accountOf(entry.data);
}

/** 扫一遍已经读进内存的条目（子会话走这条路：那台 pi 的文件已经是 `loadEntries()` 的结果）。 */
export function copilotFromEntries(entries: Array<{ type?: string; customType?: string; data?: any; message?: any }>): CopilotView {
  const ledger = emptyLedger();
  let creditsAtSnapshot = 0;
  for (const entry of entries) {
    const account = accountIn(entry);
    if (account) {
      creditsAtSnapshot = applyAccount(ledgerView(ledger), creditsAtSnapshot, account);
      continue;
    }
    absorbLedger(ledger, entry);
  }
  return viewOf(ledger);
}

// ---------------------------------------------------------------------------- 账号额度（bridge 自己拉）

const ACCOUNT_TIMEOUT_MS = 8_000;

/** pi 存在 `~/.pi/agent/auth.json` 里的 GitHub 凭据（Copilot OAuth 的 refresh 是长效的）。 */
export function githubToken(): string | null {
  const env = process.env.COPILOT_GITHUB_TOKEN;
  if (typeof env === "string" && env.trim()) return env.trim();
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    const cred = parsed?.["github-copilot"];
    if (typeof cred?.refresh === "string" && cred.refresh) return cred.refresh;
    if (typeof cred?.access === "string" && cred.access) return cred.access;
  } catch {
    /* 没登录 copilot 或者读不了文件 —— 面板上没有额度数字而已 */
  }
  return null;
}

function apiBase(): string {
  const env = process.env.COPILOT_API_BASE?.trim();
  if (env) return env.replace(/\/+$/, "");
  return "https://api.github.com";
}

/** `/copilot_internal/user` 的 `quota_snapshots`：优先 `premium_interactions`，退回第一个对象。 */
export function accountFrom(body: any, at: string = new Date().toISOString()): CopilotAccountView | null {
  const snapshots = body?.quota_snapshots;
  if (!snapshots || typeof snapshots !== "object") return null;
  const named = snapshots.premium_interactions;
  const fallback = Object.values(snapshots).find((one: any) => one && typeof one === "object");
  const quota: any = named && typeof named === "object" ? named : fallback;
  if (!quota || typeof quota !== "object") return null;
  const resetRaw = body?.quota_reset_date_utc ?? body?.quota_reset_date ?? quota.quota_reset_at;
  let resetUtc: string | null = null;
  if (typeof resetRaw === "string" && resetRaw) {
    const parsed = Date.parse(resetRaw);
    resetUtc = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  } else if (typeof resetRaw === "number" && resetRaw > 0) {
    // 秒级时间戳；`0` 是「没有独立的重置时刻，用账号级的」。
    const ms = resetRaw > 1e12 ? resetRaw : resetRaw * 1000;
    resetUtc = new Date(ms).toISOString();
  }
  const used = num(quota.credits_used) ?? num(quota.used);
  const remaining = num(quota.remaining);
  if (used === null && remaining === null) return null;
  return {
    entitlement: num(quota.entitlement),
    used,
    remaining,
    percentRemaining: num(quota.percent_remaining),
    resetUtc,
    plan: typeof body?.copilot_plan === "string" ? body.copilot_plan : null,
    sku: typeof body?.sku === "string" ? body.sku : null,
    unlimited: quota.unlimited === true,
    overagePermitted: quota.overage_permitted === true,
    at,
  };
}

export type Fetcher = typeof fetch;

/** 拉一份账号额度；没凭据 / 网络不通 / 形状不认识都返回 null（面板显示「—」而不是报错）。 */
export async function fetchCopilotAccount(fetcher: Fetcher = fetch): Promise<CopilotAccountView | null> {
  const token = githubToken();
  if (!token) return null;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), ACCOUNT_TIMEOUT_MS);
  try {
    const res = await fetcher(`${apiBase()}/copilot_internal/user`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "x-github-api-version": "2026-06-01",
        "user-agent": "pi-web-client copilot-credits",
      },
      signal: timer.signal,
    });
    if (!res.ok) return null;
    return accountFrom(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

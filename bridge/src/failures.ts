/**
 * AI 出错记录（D164）—— 会话里「同一类错误犯了几次」的账本。
 *
 * 为什么在桥这边：会话 JSONL 里的失败原文只有桥读得到（`loadEntries`），前端拿着跑完 diagnose
 * 再回传一行摘要；账本本身是纯计数，放前端会随页面刷新丢掉，也会被两个标签页各写一份。
 *
 * 一个工作区一个文件：账本随工作区走（`SessionState.ws`，worktree 由 `workspaces.groupFor`
 * 并回主仓），删一个工作区不影响别人的计数，也不会让单文件长到几 MB。
 *
 * 只读约束由调用方（面板）保证，这里只认「已修复 / 忽略 / 删除」三个动作：已修复的再犯会复活，
 * 忽略的只静默加次数 —— 这是用户定的「不用每次纠正我」。
 */
import { createHash } from "node:crypto";
import { readJson, statePath, writeJson } from "./paths.ts";

export interface FailOcc {
  /** 会话 id。 */
  sid: string;
  /** 会话名（当时的名字，会话改名后这本账不跟着改）。 */
  name: string;
  /** ISO 时间。 */
  at: string;
  /** 当时的命令 / 参数摘要，一行。 */
  cmd: string;
  exit: number | null;
  /** 输出首行（已去掉 trailer，截 240 字）。 */
  out: string;
}

export interface FailEntry {
  /** `tool|code|sig` —— 去重键，见 web/src/failures.ts。 */
  key: string;
  tool: string;
  /** 语言无关的错误分类：path-missing / cmd-missing / perm / timeout / rate-limit / context / exit / abort / other。 */
  code: string;
  /** 命令形状（路径归一化后的头两段）。 */
  sig: string;
  count: number;
  first: string;
  last: string;
  /** 首次发生时的诊断：为什么没成 / 可复用修法。空串 = 当时没诊断出来。 */
  why: string;
  fix: string;
  /** 标了「已修复」的时间；再犯时清空。 */
  fixedAt: string | null;
  /** 标了「忽略」的时间；再犯只加次数，不改它。 */
  ignoredAt: string | null;
  /** 最近 20 次，新的在前。 */
  occ: FailOcc[];
}

export interface FailLedger {
  version: 1;
  ws: string;
  /** 工作区显示名（前端给，空串表示没拿过，按 ws 显示）。 */
  label: string;
  entries: FailEntry[];
  /** 会话 id → 最近一次入账。用来判断「这个会话还有没入账的失败」。 */
  sessions: Record<string, { at: string; n: number }>;
}

export type FailAction = "fixed" | "unfixed" | "ignore" | "unignore" | "delete";

const MAX_OCC = 20;
const MAX_ENTRIES = 200;
const MAX_TEXT = 240;
const UNDO_MS = 60_000;

export interface CommitItem {
  key: string;
  /** 这次失败发生的 ISO 时刻；缺省用整批的 at。 */
  at?: string;
  tool: string;
  code: string;
  sig: string;
  exit: number | null;
  cmd: string;
  out: string;
  why: string;
  fix: string;
}

function clean(s: unknown, max = MAX_TEXT): string {
  return String(s ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 工作区 id 当文件名（可读），尾部再挂 8 位哈希：`F:/a b` 与 `F:/a_b` 不会落进同一本账。 */
function fileFor(ws: string): string {
  const safe = ws.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 100) || "none";
  const tail = createHash("sha1").update(ws).digest("hex").slice(0, 8);
  return statePath("failures", `${safe}-${tail}.json`);
}

export function emptyLedger(ws: string): FailLedger {
  return { version: 1, ws, label: "", entries: [], sessions: {} };
}

export function readLedger(ws: string): FailLedger {
  const raw = readJson<Partial<FailLedger>>(fileFor(ws), {});
  const entries = Array.isArray(raw.entries) ? raw.entries.filter((e): e is FailEntry => Boolean(e) && typeof e.key === "string") : [];
  return {
    version: 1,
    ws,
    label: typeof raw.label === "string" ? raw.label : "",
    // 读的时候排一次：次数降序，同次数按最近时间（账本在盘上可能被手改过，不指望文件顺序）。
    entries: entries
      .map((e) => ({
        ...e,
        count: Number(e.count) || 0,
        occ: Array.isArray(e.occ) ? e.occ.slice(0, MAX_OCC) : [],
        fixedAt: e.fixedAt ?? null,
        ignoredAt: e.ignoredAt ?? null,
        why: String(e.why ?? ""),
        fix: String(e.fix ?? ""),
        sig: String(e.sig ?? ""),
      }))
      .sort(byWeight),
    sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
  };
}

/** 待修在前；同类内按次数、再按最近发生。 */
export function byWeight(a: FailEntry, b: FailEntry): number {
  const rank = (e: FailEntry) => (e.fixedAt || e.ignoredAt ? 1 : 0);
  return rank(a) - rank(b) || b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0);
}

function save(ledger: FailLedger): FailLedger {
  const seen = new Map<string, FailEntry>();
  for (const e of ledger.entries) if (!seen.has(e.key)) seen.set(e.key, e);
  const entries = [...seen.values()].sort(byWeight).slice(0, MAX_ENTRIES);
  const out = { ...ledger, entries };
  writeJson(fileFor(ledger.ws), out);
  return out;
}

/** 撤销快照：整本账很小（≤200 条、每条 20 行明细），存整份比重放补丁可靠。 */
const undoStack = new Map<string, { ws: string; ledger: FailLedger; at: number }>();

export interface MergeResult {
  ledger: FailLedger;
  token: string;
  added: number;
}

export function mergeFailures(input: {
  ws: string;
  label?: string;
  sid: string;
  sname: string;
  at: string;
  items: CommitItem[];
}): MergeResult {
  const ws = String(input.ws || "");
  if (!ws) throw new Error("没有工作区");
  const prev = readLedger(ws);
  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // 深拷一份：下面 `hit.count += 1` 会就地改 prev 里的对象，快照跟着变的话撤销就撤不回去了。
  undoStack.set(token, { ws, ledger: structuredClone(prev), at: Date.now() });
  for (const [k, v] of undoStack) if (Date.now() - v.at > UNDO_MS) undoStack.delete(k);

  const idx = new Map(prev.entries.map((e) => [e.key, e]));
  const at = input.at || new Date().toISOString();
  let added = 0;
  for (const item of input.items) {
    const key = clean(item.key, 200);
    if (!key) continue;
    const cmd = clean(item.cmd);
    const out = clean(item.out);
    const why = clean(item.why, 400);
    const fix = clean(item.fix, 400);
    const exit = typeof item.exit === "number" && Number.isFinite(item.exit) ? item.exit : null;
    // 每条用自己的发生时刻：一批里可能横跨几分钟，全写成入账时刻的话证据卡就全一样了。
    const when = typeof item.at === "string" && item.at ? item.at : at;
    const occ: FailOcc = { sid: input.sid, name: clean(input.sname, 120), at: when, cmd, exit, out };
    const hit = idx.get(key);
    if (!hit) {
      const entry: FailEntry = {
        key,
        tool: clean(item.tool, 40) || "tool",
        code: clean(item.code, 40) || "other",
        sig: clean(item.sig, 80),
        count: 1,
        first: when,
        last: when,
        why,
        fix,
        fixedAt: null,
        ignoredAt: null,
        occ: [occ],
      };
      idx.set(key, entry);
      added += 1;
      continue;
    }
    hit.count += 1;
    if (hit.last < when) hit.last = when;
    hit.occ = [occ, ...hit.occ].slice(0, MAX_OCC);
    // 诊断文案只补空，不覆盖：同一类错误第一次的「为什么」通常最完整。
    if (!hit.why && why) hit.why = why;
    if (!hit.fix && fix) hit.fix = fix;
    // 再犯 = 修法没起作用：无论当初是「已修复」还是「已修复后又忽略」，都退回未修。
    // （只清 fixedAt：忽略状态保留，不吵醒用户，只加次数。）
    hit.fixedAt = null;
    added += 1;
  }

  const ledger = save({
    ...prev,
    label: input.label && !prev.label ? clean(input.label, 120) : prev.label,
    entries: [...idx.values()],
    sessions: { ...prev.sessions, [input.sid]: { at, n: (prev.sessions[input.sid]?.n ?? 0) + input.items.length } },
  });
  return { ledger, token, added };
}

export function actOnFailure(ws: string, key: string, action: FailAction): FailLedger {
  const ledger = readLedger(ws);
  const now = new Date().toISOString();
  const hit = ledger.entries.find((e) => e.key === key);
  if (!hit) throw new Error("这条记录已经不在了");
  switch (action) {
    case "fixed":
      hit.fixedAt = now;
      break;
    case "unfixed":
      hit.fixedAt = null;
      break;
    case "ignore":
      hit.ignoredAt = now;
      break;
    case "unignore":
      hit.ignoredAt = null;
      break;
    case "delete":
      ledger.entries = ledger.entries.filter((e) => e.key !== key);
      break;
    default:
      throw new Error(`不认识的动作：${String(action)}`);
  }
  return save(ledger);
}

export function undoFailures(token: string): FailLedger {
  const snap = undoStack.get(token);
  if (!snap || Date.now() - snap.at > UNDO_MS) {
    undoStack.delete(token);
    throw new Error("撤销窗口已经过去了");
  }
  undoStack.delete(token);
  return save({ ...snap.ledger, entries: snap.ledger.entries });
}

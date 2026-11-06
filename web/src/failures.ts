/**
 * AI 出错记录（D160）的纯函数：把一次失败折成「哪一类」，再把一类写成给 agent 的交接稿。
 *
 * 这里刻意不碰 DOM、不碰 WS：去重键是这个功能的立身之本（同类加次数而不是又一行），
 * 所以它必须能单测（web/tests/failures-unit.mjs）。
 *
 * 键 = 工具 + 分类 + 命令形状：
 *   bash | path | cd <path>     ← `cd F:/a` 与 `cd /b` 同类
 *   edit | path | edit <path>
 *   任何工具 | rate | …
 * 分类从输出文本里认，因为 pi 的 item 只给 `isError`，没有错误码；exit 只从 trailer 解析。
 */
import { tr } from "./i18n/index.ts";

export interface FailOcc {
  sid: string;
  name: string;
  at: string;
  cmd: string;
  exit: number | null;
  out: string;
}

export interface FailEntry {
  key: string;
  tool: string;
  code: string;
  sig: string;
  count: number;
  first: string;
  last: string;
  why: string;
  fix: string;
  fixedAt: string | null;
  ignoredAt: string | null;
  occ: FailOcc[];
}

export interface FailLedger {
  version: 1;
  ws: string;
  label: string;
  entries: FailEntry[];
  sessions: Record<string, { at: string; n: number }>;
}

/** 面板里第一次失败时的原文，攒在 app 里等「总结」。 */
export interface SeenFail {
  callId: string;
  tool: string;
  cmd: string;
  out: string;
  at: string;
}

export type FailCode = "path" | "nocmd" | "perm" | "timeout" | "rate" | "context" | "exit" | "abort" | "other";

const CODE_LABEL: Record<FailCode, string> = {
  path: "路径不存在",
  nocmd: "命令不存在",
  perm: "权限不足",
  timeout: "超时",
  rate: "限流（429）",
  context: "上下文超限",
  exit: "命令失败",
  abort: "被中断",
  other: "其它失败",
};

export function codeLabel(code: string): string {
  return tr(CODE_LABEL[(code as FailCode) in CODE_LABEL ? (code as FailCode) : "other"]);
}

/** pi 的 trailer：`Command exited with code 2` / `Exit code: 1`（diagnose.ts 同一口径）。 */
export function exitOf(out: string): number | null {
  const m = /(?:exited with code|exit code:?)\s*(-?\d+)/i.exec(out);
  return m ? Number(m[1]) : null;
}

/** 一行输出：去掉 ANSI、去掉 trailer，留第一行有字的内容。 */
export function firstLine(out: string): string {
  const clean = String(out ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const pick = clean.find((s) => !/^(Command )?exited with code/i.test(s)) ?? clean[0] ?? "";
  return pick.slice(0, 240);
}

/**
 * 分类顺序就是优先级：一条失败常常同时像好几类（`cd 不存在 && …` 会带 exit 1），
 * 先认具体的（路径 / 命令 / 权限 / 限流），最后才退到「就是 exit N」。
 */
export function classify(tool: string, out: string, exit: number | null): FailCode {
  const s = String(out ?? "");
  if (/\b(aborted|cancell?ed|interrupted)\b|中断|已取消/i.test(s) && tool !== "bash") return "abort";
  if (tool === "bash" && /\b(aborted)\b|请求已中断/i.test(s)) return "abort";
  if (/(ENOENT|no such file or directory|file not found|does not exist|cannot find the path|找不到(该)?(文件|路径))/i.test(s)) return "path";
  if (/(command not found|not recognized as an internal|不是内部或外部命令|no such command)/i.test(s)) return "nocmd";
  if (/(EACCES|EPERM|permission denied|access is denied|权限不足|拒绝访问)/i.test(s)) return "perm";
  if (/(ETIMEDOUT|timed out|timeout|超时|killed after)/i.test(s)) return "timeout";
  if (/(\b429\b|rate.?limit|too many requests|quota exceeded|限流)/i.test(s)) return "rate";
  if (/(context (window|length)|too many tokens|maximum context|上下文(超|过)长)/i.test(s)) return "context";
  if (exit !== null && exit !== 0) return "exit";
  if (/\bexit(ed)? (with )?code [1-9]/i.test(s)) return "exit";
  return "other";
}

const PATHY = /^(?:[A-Za-z]:[\\/]|[\\/~.]{0,2}[\\/]|[A-Za-z0-9_.-]+[\\/][^\s]*)/;

function tok(t: string): string {
  const bare = t.replace(/^["'`]|["'`]$/g, "");
  if (PATHY.test(bare) || /^[A-Za-z0-9_.-]+\.(ts|tsx|js|mjs|json|css|html|md|py|go|rs|yml|yaml)$/i.test(bare)) return "<path>";
  // 端口、行号、次数都不该把同一类劈成两类：`:7864` 与 `:7888` 是同一个坑。
  return bare.replace(/\d+/g, "<n>").slice(0, 40);
}

/**
 * 命令形状：程序名 + 第一个非旗标参数（归一化后的）。管道取最后一段 —— 出事的通常是它
 * （`netstat | grep -E …` 没命中，是 grep 的空结果；shell 的 exit 也来自最后一段）。
 */
export function normalizeSig(cmd: string, tool = "bash"): string {
  const first = String(cmd ?? "").split("\n")[0] ?? "";
  const stage = first.split("|").pop() ?? first;
  const head = stage.split(/&&|;|\|\|/)[0] ?? stage;
  const words = head.split(/\s+/).filter(Boolean);
  if (!words.length) return tool === "bash" ? "" : `${tool} <path>`;
  const prog = tok(words[0]).replace(/^<path>$/, tool === "bash" ? "" : tool).split(/[\\/]/).pop() ?? "";
  const rest: string[] = [];
  for (const w of words.slice(1)) {
    if (/^[-<>]/.test(w)) continue;
    rest.push(tok(w));
    if (rest.length >= 2) break;
  }
  const name = tool === "bash" ? prog || words[0].slice(0, 30) : tool;
  return [name, ...rest].filter(Boolean).join(" ");
}

export function entryKey(tool: string, code: string, sig: string): string {
  return `${tool || "tool"}|${code}|${sig}`;
}

/** 一条失败 → 交给桥的那一行（不含 diagnose 的「为什么」，由调用方补）。 */
export interface CommitItem {
  key: string;
  tool: string;
  code: string;
  sig: string;
  exit: number | null;
  cmd: string;
  out: string;
  why: string;
  fix: string;
}

export function toCommit(fail: SeenFail, why = "", fix = ""): CommitItem {
  const out = String(fail.out ?? "");
  const exit = exitOf(out);
  const code = classify(fail.tool, out, exit);
  const sig = normalizeSig(fail.cmd, fail.tool);
  return {
    key: entryKey(fail.tool, code, sig),
    tool: fail.tool,
    code,
    sig,
    exit,
    cmd: String(fail.cmd ?? "").split("\n")[0].slice(0, 240),
    out: firstLine(out),
    why,
    fix,
  };
}

/** 账本里「还在烧」的那些：没标修复、没标忽略、也不是中断。tab 计数和按钮计数都按它。 */
export function ripeEntries(ledger: FailLedger | null): FailEntry[] {
  return (ledger?.entries ?? []).filter((e) => !e.fixedAt && !e.ignoredAt && e.code !== "abort");
}

export function entryState(e: FailEntry): "fixed" | "ignored" | "abort" | "open" {
  // 忽略压过修复：先点了「已修复」又决定「这类别再算」，安静的那一侧说了算。
  if (e.ignoredAt) return "ignored";
  if (e.fixedAt) return "fixed";
  if (e.code === "abort") return "abort";
  return "open";
}

export function stateLabel(e: FailEntry): string {
  const s = entryState(e);
  return s === "fixed" ? tr("已修复") : s === "ignored" ? tr("已忽略") : s === "abort" ? tr("已中断") : tr("待修");
}

/** 一行标题：分类名 + 退出码（有的话）。 */
export function entryTitle(e: FailEntry): string {
  const base = codeLabel(e.code);
  return e.code === "exit" && e.occ[0]?.exit != null ? base + tr("（exit {p1}）", { p1: String(e.occ[0].exit) }) : base;
}

export function clock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  return d.toDateString() === now.toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}-${p(d.getDate())}`;
}

/** 交给 agent 的正文：一类一条，带最近 3 次的原文。整类的次数说明这是「老毛病」还是「偶发」。 */
export function failureMarkdown(e: FailEntry, wsLabel: string): string {
  const lines = [
    "## " + entryTitle(e) + " · " + tr("{p1} 次", { p1: e.count }),
    "",
    tr("- 工具：{p1}", { p1: e.tool }),
    tr("- 分类：{p1} · 形状：{p2}", { p1: codeLabel(e.code), p2: e.sig || "—" }),
    tr("- 工作区：{p1}", { p1: wsLabel || "—" }),
    tr("- 首次 {p1} · 最近 {p2}", { p1: clock(e.first), p2: clock(e.last) }),
  ];
  if (e.why) lines.push("", tr("为什么没成：{p1}", { p1: e.why }));
  if (e.fix) lines.push("", tr("当时给的修法：{p1}", { p1: e.fix }));
  lines.push("", tr("最近 {p1} 次：", { p1: Math.min(3, e.occ.length) }));
  e.occ.slice(0, 3).forEach((o, i) => {
    lines.push(`${i + 1}. ${clock(o.at)} · ${o.name || o.sid} · ${o.cmd || "—"}${o.exit != null ? ` · exit ${o.exit}` : ""}`);
    if (o.out) lines.push(`   ${o.out}`);
  });
  return lines.join("\n");
}

export function ledgerMarkdown(ledger: FailLedger, wsLabel: string): string {
  const rows = [...ledger.entries].sort((a, b) => b.count - a.count);
  const head = tr("# AI 出错记录 · {p1}", { p1: wsLabel || ledger.ws });
  return [head, ""].concat(rows.map((e) => `${failureMarkdown(e, wsLabel)}\n---`)).join("\n\n");
}

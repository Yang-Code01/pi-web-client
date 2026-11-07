/**
 * AI 出错记录（D164）的纯函数：把一次失败折成「哪一类」，再把一类写成给 agent 的交接稿。
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
import { tr, fmtDate, fmtTime } from "./i18n/index.ts";
import { exitCodeOf } from "./diagnose.ts";

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
  /** 这一类里出现过的不同「为什么」（桥端去重、上限 4）。缺省时用 `why` 当唯一一条。 */
  causes?: string[];
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

/** 一行输出：去掉 ANSI、去掉 trailer，留第一行有字的内容。 */
export function firstLine(out: string): string {
  const clean = String(out ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
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
const FILEY = /^[A-Za-z0-9_.-]+\.(ts|tsx|js|mjs|cjs|json|css|scss|html|md|py|go|rs|yml|yaml|sh|ps1|txt)$/i;

/** 一条失败里只有「哪一步坏了」值得进钥匙，其余细节（端口、行号、次数）一律折平。 */
function tok(t: string): string {
  const bare = t.replace(/^["'`(]+|["'`)",;:]+$/g, "");
  if (PATHY.test(bare) || FILEY.test(bare)) return "<path>";
  // 端口、行号、次数都不该把同一类劈成两类：`:7864` 与 `:7888` 是同一个坑。
  return bare.replace(/\d+/g, "<n>").slice(0, 40);
}

/**
 * 切词：按空白切，但引号里的空白不切，引号本身不留 —— `grep -o "\.a {[^}]*}" f.css` 是一个参数，
 * 不是三个（旧版按空白硬切，签名里才会出现 `ja.ts"` 这种半截）。
 */
function words(stage: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of stage) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 把一条命令切成「会各自返回退出码的段」：`&&`、`||`、`;`、`|`、换行。
 * heredoc 之后的正文不是命令（`python - <<'PY'` 后面几十行都是载荷），在第一个 `<<` 处截断。
 */
function stages(cmd: string): string[] {
  const text = String(cmd ?? "");
  const cut = text.indexOf("<<");
  const src = cut >= 0 ? text.slice(0, cut) : text;
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      cur += ch;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 段里的程序名：跳过 `FOO=bar`、重定向和开头的旗标。 */
function progOf(stage: string): string {
  for (const w of words(stage)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (/^[-<>]/.test(w) || /^\d*[<>]/.test(w)) continue;
    return w;
  }
  return "";
}

/** 只是「先把环境摆好」或 shell 关键字：它们自己几乎不会失败，出事的是后面那步。 */
const SETUP = /^(?:cd|chdir|pushd|popd|export|set|setx|unset|source|\.|true|:|\.|do|then|else|elif|fi|done|esac|while|until|if|for|case)$/i;
const INTERP = /^(?:python[0-9.]*|py|node|nodejs|deno|bun|ruby|perl|php|lua|pwsh|powershell|bash|sh|zsh)$/i;

function baseOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * 输出里是否报过这个名字（按「命令位置」认：行首 `grep: …`、`bash: cd: …`、PowerShell 的 `ls : …`）。
 * 不按子串找：`console.log(…)` 里也有 `ls`，那就把签名挑到后面那段去了。
 */
function mentions(text: string, name: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(`${name}:`) || line.startsWith(`${name} :`)) return true;
    // `bash: cd: /nope: …` / `sh: node: command not found`：shell 前缀很短，看前 24 字就够。
    const at = line.indexOf(`: ${name}:`);
    if (at >= 0 && at < 24) return true;
  }
  return false;
}

/**
 * 挑「真正失败的那一段」。**证据优先**：某一段的程序名在错误输出里出现过（`node:internal/…`、
 * `grep: …`、`bash: cd: …`），那就是它，取最后一个命中的。没有证据就退到最后一段非序言段 ——
 * `&&` 链越靠后越可能才是出事的那步，而旧的「`&&` 取第一段」把全部 `cd X && …` 折成了 `cd <path>`
 * （账本里 9 次毫不相干的失败因此并成了一类）。
 */
export function failingStage(cmd: string, out = ""): string {
  const list = stages(cmd);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const body = list.filter((s) => !SETUP.test(baseOf(progOf(s))));
  const pool = body.length ? body : list;
  const text = String(out ?? "");
  let hit = "";
  // 证据在**所有**段里找，包括 `cd` 这种序言：`bash: cd: /nope: No such file` 会把签名拉回 cd，
  // 而这恰恰是「目录拼错」该被归在一起的那类（D164）。
  for (const s of list) {
    const name = baseOf(progOf(s)).replace(/[^A-Za-z0-9_.-]/g, "");
    if (name.length < 2) continue;
    if (mentions(text, name)) hit = s;
  }
  return hit || pool[pool.length - 1];
}

/**
 * 命令形状：**出事的那个程序** + 头两个非旗标参数（归一化后）。
 *
 * 旧版写死「管道取最后一段、`&&` 取第一段」：抽样的 46 次失败里有 31 次落在这种假类上 ——
 * `cd <path>` 9 次、`head` 9 次、`tail` 8 次，卡片上还共用第一次的诊断。现在先看错误输出认人，
 * 认不出来才按下标猜（见 `failingStage`）。
 */
export function normalizeSig(cmd: string, tool = "bash", out = ""): string {
  const stage = failingStage(cmd, out);
  const ws = words(stage);
  if (!ws.length) return tool === "bash" ? "" : `${tool} <path>`;
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || /^[-<>]/.test(ws[i]) || /^\d*[<>]/.test(ws[i]))) i++;
  const raw = ws[i] ?? ws[0];
  const name = tok(raw).replace(/^<path>$/, tool === "bash" ? "" : tool).split(/[\\/]/).pop() ?? "";
  // 脚本是内联的（`node -e`/`python -c`/`python -`/`powershell -Command "…"`）：载荷不进签名。
  const args = ws.slice(i + 1);
  const inline = args.some((a) => a === "-" || /^-[ce]$/.test(a) || a.length > 60);
  if (INTERP.test(name) && inline) return `${name} <code>`;
  const rest: string[] = [];
  let skipValue = false;
  for (const w of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (/^[-<>]/.test(w) || /^\d*[<>]/.test(w)) {
      // `git -c k=v push` / `git -C <path> status`：这两个旗标的值不是目标，要连值一起跳过。
      // 别的命令里的 `-c` 通常不是一个带值的旗标（`grep -c PATTERN` 下一项才是要数的模式）。
      if ((w === "-c" || w === "-C") && /^(git|hg)$/.test(name)) skipValue = true;
      continue;
    }
    if (w.includes("=") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // 设置项不是目标
    const t = tok(w);
    if (!t) continue;
    rest.push(t);
    if (rest.length >= 2) break;
  }
  const label = tool === "bash" ? name || cleanWord(ws[0]).slice(0, 30) : tool;
  return [label, ...rest].filter(Boolean).join(" ");
}

function cleanWord(w: string): string {
  return w.replace(/^["'`(]+|["'`)",;:]+$/g, "");
}

export function entryKey(tool: string, code: string, sig: string): string {
  return `${tool || "tool"}|${code}|${sig}`;
}

/** 一条失败 → 交给桥的那一行（不含 diagnose 的「为什么」，由调用方补）。 */
export interface CommitItem {
  key: string;
  /** 这次失败发生的时刻（不是点「总结」的时刻）。 */
  at: string;
  tool: string;
  code: string;
  sig: string;
  exit: number | null;
  cmd: string;
  out: string;
  why: string;
  fix: string;
}

/** 两条失败是不是同一类：按账本的归并键重算（toolCallId 只能区分「哪一次」，区分不了「哪一类」）。 */
export function sameFail(a: SeenFail, key: string): boolean {
  try {
    return entryKey(a.tool, classify(a.tool, a.out, exitCodeOf(a.out)), normalizeSig(a.cmd, a.tool, a.out)) === key;
  } catch {
    return false;
  }
}

/**
 * 桥注入的「复盘」那一轮的第一行（`bridge/src/lessons.ts` 的 `REVIEW_MARK`）。
 * 和 D169 的提醒同一个意思：这不是人说的话，得用一个不随语言变的东西认出来。
 */
export const REVIEW_MARK = "[pi-web:review]";

/** 复盘正文（去掉标记）；不是复盘就返回 null。 */
export function reviewBody(text: string): string | null {
  if (!text.startsWith(REVIEW_MARK)) return null;
  return text.slice(REVIEW_MARK.length).replace(/^\s+/, "");
}

/** 一类失败的摘要，给「发到会话复盘」用：键要能对上账本，次数要真。 */
export interface ReviewClass {
  key: string;
  tool: string;
  code: string;
  sig: string;
  n: number;
}

/** 这个会话见过的失败按账本键归并 → 给复盘用的类列表（桥端再按账本补累计次数）。 */
/** 提示词里的 `## 小节` 是写给模型的，屏幕上不该冒出井号。 */
export function reviewDisplay(body: string): string {
  return body.replace(/^#{1,6}[ 	]+/gm, "");
}

export function reviewClasses(fails: Iterable<SeenFail>): ReviewClass[] {
  const map = new Map<string, ReviewClass>();
  for (const f of fails) {
    try {
      const out = String(f.out ?? "");
      const code = classify(f.tool, out, exitCodeOf(out));
      const sig = normalizeSig(f.cmd, f.tool, out);
      const key = entryKey(f.tool, code, sig);
      const hit = map.get(key);
      if (hit) hit.n += 1;
      else map.set(key, { key, tool: f.tool || "tool", code, sig, n: 1 });
    } catch {
      /* 归不进类的那条就当没看见：复盘少一类，比整批发不出去强 */
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

export function toCommit(fail: SeenFail, why = "", fix = ""): CommitItem {  const out = String(fail.out ?? "");
  const exit = exitCodeOf(out);
  const code = classify(fail.tool, out, exit);
  const sig = normalizeSig(fail.cmd, fail.tool, out);
  return {
    key: entryKey(fail.tool, code, sig),
    at: fail.at,
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
  if (s === "fixed") return tr("已修复");
  if (s === "ignored") return tr("已忽略");
  if (s === "abort") return tr("已中断");
  return tr("待修");
}

/** 一行标题：分类名 + 退出码（有的话）。 */
export function entryTitle(e: FailEntry): string {
  const base = codeLabel(e.code);
  return e.code === "exit" && e.occ[0]?.exit != null ? base + tr("（exit {p1}）", { p1: String(e.occ[0].exit) }) : base;
}

/**
 * 这一类里出现过的不同「为什么」。老账本没 `causes`，就用首次那句 `why` 兵底 ——
 * 一句话解释整类只在「整类只有一种说法」时才成立，混了两种的下结论就是张冠李戴。
 */
export function causesOf(e: FailEntry): string[] {
  const list = Array.isArray(e.causes) ? e.causes.filter((s) => typeof s === "string" && s.trim()) : [];
  if (list.length) return list;
  return e.why ? [e.why] : [];
}

export function clock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? fmtTime(d) : fmtDate(d);
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
  const causes = causesOf(e);
  if (causes.length === 1) lines.push("", tr("为什么没成：{p1}", { p1: causes[0] }));
  else if (causes.length > 1) lines.push("", tr("为什么没成：本类混了 {p1} 种原因 —— {p2}", { p1: causes.length, p2: causes.join(tr("；")) }));
  if (e.fix) lines.push("", tr("当时给的修法：{p1}", { p1: e.fix }));
  lines.push("", tr("最近 {p1} 次：", { p1: Math.min(3, e.occ.length) }));
  e.occ.slice(0, 3).forEach((o, i) => {
    const exit = o.exit == null ? "" : ` · exit ${o.exit}`;
    lines.push(`${i + 1}. ${clock(o.at)} · ${o.name || o.sid} · ${o.cmd || "—"}${exit}`);
    if (!o.out) return;
    lines.push(`   ${o.out}`);
  });
  return lines.join("\n");
}

export function ledgerMarkdown(ledger: FailLedger, wsLabel: string): string {
  const rows = [...ledger.entries].sort((a, b) => b.count - a.count);
  const head = tr("# AI 出错记录 · {p1}", { p1: wsLabel || ledger.ws });
  return [head, ""].concat(rows.map((e) => `${failureMarkdown(e, wsLabel)}\n---`)).join("\n\n");
}

/**
 * 让「⚡ AI 出错记录」真的起作用（D164 的延伸）。
 *
 * 账本原来只给人看：面板按次数排，人读完改流程。可下一次的模型看不见它，同一类坑换个会话照踩。
 * 这里把账本压成几行「这个工作区的老毛病」，spawn 时用 `--append-system-prompt <文件>` 挂到
 * 系统提示词后面 —— pi 的这个参数可重复，不会顶掉用户手填的那一段（bridge/src/launch.ts:95）。
 *
 * 另有 `reminderText` / `allowRemind`：同一轮里第二次撞上同一类时，由桥往会话里补一条
 * 自动提醒（见 bridge/src/index.ts 的 failures.remind）。
 *
 * 只收「反复发生、还没修、没被忽略」的类：偶发失败是个案，标了「已修复」的说明已经解决，
 * 忽略了的是用户不想再听 —— 把这些也塞进系统提示词只会教模型疑神疑鬼。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { statePath } from "./paths.ts";
import { readLedger, type FailEntry, type FailLedger } from "./failures.ts";
import { readRules, ruleFor, type RuleBook, type RuleRec } from "./rules.ts";

/** 至少发生过几次才算「老毛病」。3 次是账本里「一派上用场」的门槛：2 次可能只是手滑。 */
const MIN_COUNT = 3;
const MAX_LINES = 6;
const MAX_CHARS = 1200;
/** 每条提醒行里修法的长度上限：系统提示词是每次 spawn 都要付的固定成本。 */
const MAX_ADVICE = 70;

/**
 * 按分类给的通用改法。规则表只写「这一类通常该怎么绕开」，不认识的就退回账本里那句诊断。
 * 顺序无关，靠 code 精确命中。
 */
const ADVICE: Record<string, string> = {
  path: "先确认目录/文件在不在（test -d / ls），建目录用 mkdir -p，别靠 cd 失败来发现路径写错",
  nocmd: "先确认命令装没装（command -v / where），或换等价的内置命令",
  perm: "先看 owner 与 ACL，别用 sudo 硬闯",
  timeout: "缩小范围或加超时（--max-count / -m），别整仓扫",
  rate: "退避之后再试，别连发",
  context: "分片读，别整文件灌进上下文",
};

const HEADER = [
  "## 这个工作区过去反复踩的坑（自动收录，来自之前几次会话）",
  "这些不是猜的：同样的形状在这个仓库里失败过多次。遇到相近情况先换做法，别重走同一条路。",
];

/** 一条教训：次数 · 工具 · 形状 —— 该怎么绕开。 */
export function lessonLine(e: FailEntry): string {
  const sig = e.sig || "（形状不明）";
  const advice = (ADVICE[e.code] ?? (e.fix || e.why || "照上次给的修法做，别重走同一条路")).replace(/\s+/g, " ").trim();
  return `- ${e.count} 次 · ${e.tool} · ${sig} —— ${advice.slice(0, MAX_ADVICE)}`;
}

/**
 * 这一类的「原因」够不够单一，能当成一句诊断写进提示词（PLAN §2）。
 * 归并键把几十次不相干的失败折成一类时，`why`/`fix` 会张冠李戴 —— 多因的只留形状，不给结论。
 * 老账本没有 `causes` 时退回 `why`：那正是它这一路的唯一说法。
 */
export function singleCause(e: FailEntry): boolean {
  return (e.causes ?? (e.why ? [e.why] : [])).length <= 1;
}

/** 值得写进系统提示词的那些类：反复、未修、未忽略、不是用户中断、原因单一。 */
export function ripeForLesson(ledger: FailLedger): FailEntry[] {
  return ledger.entries
    .filter((e) => e.count >= MIN_COUNT && e.code !== "abort" && !e.fixedAt && !e.ignoredAt && singleCause(e))
    .sort((a, b) => b.count - a.count || String(b.last ?? "").localeCompare(String(a.last ?? "")))
    .slice(0, MAX_LINES);
}

/** 系统提示词追加段：先「老毛病」，再「规矩」。没有值得记的就返回空串（调用方据此什么都不加）。 */
export function lessonText(ledger: FailLedger, book: RuleBook | null = null): string {
  const lessons = lessonsBlock(ledger);
  const rules = ruleText(book, ledger);
  return [lessons, rules].filter(Boolean).join("\n\n");
}

function lessonsBlock(ledger: FailLedger): string {
  const lines = ripeForLesson(ledger).map(lessonLine);
  if (!lines.length) return "";
  let text = [...HEADER, ...lines].join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;
  return text;
}

/**
 * 规矩那块（D164 延伸）：独立成段、独立限量。
 *
 * 不跟「N 次」那几条抢 `MAX_LINES`：规矩比次数值钱 —— 次数只说明「这坑常踩」，
 * 规矩说明「怎么绕开」。一次带 3 条就够，多了模型会挑顺眼的做。
 */
const MAX_RULES = 3;
const MAX_RULE_CHARS = 70;
const RULE_HEADER = [
  "## 这个工作区的「规矩」（上一轮复盘写下的，照做）",
  "这些是复盘时定下来的做法，遇到同类情况直接照做，别另起炉灶。",
];

/** 一条规矩：工具 · 形状 —— 那句做法。 */
export function ruleLine(r: RuleRec): string {
  return `- ${r.tool || "工具"} · ${r.sig || "（形状不明）"} —— ${r.rule.replace(/\s+/g, " ").trim().slice(0, MAX_RULE_CHARS)}`;
}

/**
 * 该带的规矩：有正文，且账本里这一类没被标「已修复 / 已忽略」（标了说明已经解决，再念就是噪音）。
 * 账本里还没有这一类的也带上 —— 复盘轮谈到的新坑，正是下一次最该记住的。
 */
export function ripeForRule(book: RuleBook | null, ledger: FailLedger | null): RuleRec[] {
  if (!book?.rules.length) return [];
  const byKey = new Map((ledger?.entries ?? []).map((e) => [e.key, e]));
  return book.rules
    .filter((r) => {
      if (!r.rule) return false;
      const e = byKey.get(r.key);
      return !(e && (e.fixedAt || e.ignoredAt));
    })
    .slice(0, MAX_RULES);
}

export function ruleText(book: RuleBook | null, ledger: FailLedger | null): string {
  const lines = ripeForRule(book, ledger).map(ruleLine);
  if (!lines.length) return "";
  return [...RULE_HEADER, ...lines].join("\n");
}

/**
 * 落到磁盘再返回路径：命令行长度有限（用户那段 `appendSystemPrompt` 自己就能占 20000 字），
 * 而 pi 接受「一个已存在的文件」。文件每次 spawn 重写，账本变了下次就是新的。
 */
export function lessonFile(ws: string): string | null {
  if (!ws) return null;
  let text = "";
  try {
    text = lessonText(readLedger(ws), readRules(ws));
  } catch {
    return null; // 账本 / 规矩读坏了不该拦住开会话
  }
  if (!text) return null;
  const safe = ws.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 100) || "none";
  const tail = createHash("sha1").update(ws).digest("hex").slice(0, 8);
  const dir = statePath("lessons");
  const file = statePath("lessons", `${safe}-${tail}.prompt.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${text}\n`, "utf8");
  } catch {
    return null;
  }
  return file;
}

/** 一个会话里最多提醒几次：提醒本身是打断，多了就成了噪音。 */
const MAX_PER_SESSION = 3;
/** sid → 已经提醒过的 key。进程内记账即可：重启后从头算，不会因为丢状态而漏提醒。 */
const reminded = new Map<string, Set<string>>();

/** 这一类在这个会话里还能不能提醒（同一类只提醒一次，整个会话最多 MAX_PER_SESSION 次）。 */
export function allowRemind(sid: string, key: string): boolean {
  if (!sid || !key) return false;
  const seen = reminded.get(sid) ?? new Set<string>();
  if (seen.has(key) || seen.size >= MAX_PER_SESSION) return false;
  seen.add(key);
  reminded.set(sid, seen);
  return true;
}

/** 测试用：清掉进程内的提醒记账。 */
export function resetReminders(): void { reminded.clear(); }

const MARK = "[pi-web:remind]";

/**
 * 当场叫住模型的那句话。pi 的 RPC 只有 prompt，所以它在会话里长得像一条 user 消息；
 * 开头用 ASCII 标记 `[pi-web:remind]`，前端据此把它画成「系统提醒」而不是「你说的话」
 * （刷新后从会话文件回放也一样认得出来）。
 */
export function reminderText(input: { tool?: unknown; sig?: unknown; why?: unknown; n?: unknown }): string {
  const r = remindBody(input);
  return r ? `${MARK}\n${r}` : "";
}

function remindBody(input: { tool?: unknown; sig?: unknown; why?: unknown; n?: unknown }): string {
  const tool = String(input.tool ?? "").trim().slice(0, 40);
  const sig = String(input.sig ?? "").trim().slice(0, 80);
  const why = String(input.why ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const n = typeof input.n === "number" && Number.isFinite(input.n) ? Math.max(2, Math.trunc(input.n)) : 0;
  if (!tool && !sig) return "";
  const what = [tool, sig].filter(Boolean).join(" · ");
  const lines = [
    `[自动提醒 · 老毛病重犯] 刚才那一步，和你在这个仓库里失败过的形状一样：${what}${n ? `（已出现 ${n} 次）` : "（出现过多次）"}。`,
    why ? `上次的诊断：${why}` : "",
    "先停下：别重复同样的尝试；确认前提（路径 / 命令 / 文件是否存在），或者直接换一种做法。",
  ];
  return lines.filter(Boolean).join("\n");
}

/** 复盘那一轮的标记：前端据此把它画成「⚡ 自动复盘」，而不是「你」说的一句话。 */
export const REVIEW_MARK = "[pi-web:review]";

/** 一次复盘最多谈几类：上下文有限，贪多必然敷衍。超出的在提示词里明说没列。 */
const MAX_REVIEW = 5;
const MAX_REVIEW_WHY = 120;

export interface ReviewClass {
  /** 账本的归并键 `tool|code|sig`。 */
  key: string;
  tool: string;
  code: string;
  sig: string;
  /** 本轮这一类栽了几次。 */
  n: number;
}

/**
 * 「发到会话复盘」发出去的那段话。
 *
 * 只带**账本视角**（累计次数 + 上次诊断 + 上次修法 + 上一轮的规矩），不带本轮失败的输出原文：
 * 那几步就在同一个会话里，模型自己看得见，重发一遍只是烧 token（D164 延伸）。
 *
 * 结尾给回写格式：模型照写一行 `[pi-web:rule] <键> :: <一句>`，前端解析后由 `rules.set` 落盘。
 * 解析不到就什么都不写（不拦对话），人也不会因此被卡住。
 */
export function reviewPrompt(input: { ledger: FailLedger; book: RuleBook | null; classes: ReviewClass[]; failures: number }): string {
  const byKey = new Map(input.ledger.entries.map((e) => [e.key, e]));
  // 账本里有的一类更值钱：它说明这是老毛病；同分时按本轮次数。
  const ranked = [...input.classes]
    .map((c) => ({ c, weight: byKey.get(c.key)?.count ?? 0 }))
    .sort((a, b) => b.weight - a.weight || b.c.n - a.c.n);
  const picked = ranked.slice(0, MAX_REVIEW).map((r) => r.c);
  const skipped = ranked.length - picked.length;

  const rows = picked.map((c) => {
    const e = byKey.get(c.key);
    const bits = [`本轮 ${c.n} 次`];
    bits.push(e ? `账本累计 ${e.count} 次` : "账本里还没有这一类");
    const why = (e ? (e.fix ? e.causes?.[0] || e.why : e.causes?.[0] || e.why) : "").replace(/\s+/g, " ").trim();
    if (why) bits.push(`上次诊断：${why.slice(0, MAX_REVIEW_WHY)}`);
    if (e?.fix) bits.push(`上次修法：${e.fix.replace(/\s+/g, " ").trim().slice(0, MAX_REVIEW_WHY)}`);
    return `- ${c.key} · ${c.tool} · ${c.sig || "（形状不明）"} —— ${bits.join("；")}`;
  });

  const others = input.ledger.entries.filter((e) => !picked.some((c) => c.key === e.key) && e.count >= MIN_COUNT && !e.fixedAt && !e.ignoredAt).length;
  const prior = picked
    .map((c) => ({ c, r: ruleFor(input.book, c.key) }))
    .filter((x): x is { c: ReviewClass; r: RuleRec } => Boolean(x.r));

  const lines = [
    REVIEW_MARK,
    `刚才这一轮里有 ${input.failures} 次失败，归成 ${input.classes.length} 类。这是一次自动复盘：只谈这些，不要重跑它们。`,
    "",
    "## 账本视角（这个工作区累计，不是这一轮的原文）",
    ...rows,
  ];
  if (skipped > 0) lines.push(`（还有 ${skipped} 类本轮没列出来；它们次数少，先不谈。）`);
  if (others > 0) lines.push(`（账本里另有 ${others} 类老毛病不在这次范围，和上面同类的才需要提。）`);
  lines.push(
    "",
    "## 要你给的两样东西",
    "1. 每类一句根因（一句话，别复述报错原文）。",
    "2. 每类一句**规矩**：下次在这个仓库里遇到同类情况，照做就能绕过。写成「先做 X，再 Y」这种能执行的句子，不写「要小心」「注意检查」这种话。",
    "",
    "只有确实要现在动手修才动手，且动手前先问我；否则只给结论，不要改仓库。",
    "",
    "## 回写格式（放在回答最后，每类各一行）",
    "[pi-web:rule] <键> :: <一句规矩，不超过 70 字>",
    "键照抄上面每行开头那个（形如 bash|path|cd <path>），不要自己编。",
  );
  if (prior.length) {
    lines.push("", "## 这些类上一轮写过的规矩（沿用就照抄；觉得不够好，写更好的覆盖它）");
    for (const { c, r } of prior) lines.push(`- ${c.key} → ${r.rule}`);
  }
  return lines.join("\n");
}

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

/** 值得写进系统提示词的那些类：反复、未修、未忽略、不是用户中断。 */
export function ripeForLesson(ledger: FailLedger): FailEntry[] {
  return ledger.entries
    .filter((e) => e.count >= MIN_COUNT && e.code !== "abort" && !e.fixedAt && !e.ignoredAt)
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .slice(0, MAX_LINES);
}

/** 系统提示词追加段。没有值得记的就返回空串（调用方据此什么都不加）。 */
export function lessonText(ledger: FailLedger): string {
  const lines = ripeForLesson(ledger).map(lessonLine);
  if (!lines.length) return "";
  let text = [...HEADER, ...lines].join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;
  return text;
}

/**
 * 落到磁盘再返回路径：命令行长度有限（用户那段 `appendSystemPrompt` 自己就能占 20000 字），
 * 而 pi 接受「一个已存在的文件」。文件每次 spawn 重写，账本变了下次就是新的。
 */
export function lessonFile(ws: string): string | null {
  if (!ws) return null;
  let text = "";
  try {
    text = lessonText(readLedger(ws));
  } catch {
    return null; // 账本读坏了不该拦住开会话
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
export function resetReminders(): void {
  reminded.clear();
}

/**
 * 当场叫住模型的那句话。写成一条普通 user 消息（pi 的 RPC 只有 prompt），所以开头要自称
 * 「自动提醒」，否则它看起来像用户本人临时加的指令。
 */
export function reminderText(input: { tool?: unknown; sig?: unknown; why?: unknown; n?: unknown }): string {
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

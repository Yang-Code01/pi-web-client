/**
 * D458：执行面板点开的「参数」对话框里，工具参数该怎么读。
 *
 * 以前这里只有一个 `JSON.stringify(args)`：bash 命令里的换行全是字面的 `\n`，一条十几行的
 * heredoc 被压成一坨两千多字的墙，读不了也扫不到（用户 2026-11-29 报的就是这条）。
 * 这里只做「怎么读」，不碰 DOM —— 对话框的壳在 app.ts 里拼。
 *
 * 三步：
 *   1. 参数可能是对象，也可能是一段 JSON 字符串（历史记录里两种都有）—— 能解析就先解析；
 *   2. 顶层的长字符串（command / content / prompt…）各成一「块」正文，短字段（path / offset /
 *      timeout…）收成一行事实胶囊，不再跟正文混在一起；
 *   3. 正文按真文本铺开，并给一个语法名（命令 = bash、写文件按路径猜、edit 排成 diff）；
 *      没有长字段的（ask_user_question / todo / MCP 那种嵌套对象）退回两格缩进 + JSON 上色。
 */
import { langOf } from "./highlight.ts";
import { tr } from "./i18n/index.ts";

/** 对话框里的一块正文。`text` 永远是给「复制」的原文，`label` / `grammar` 只影响怎么画。 */
export interface ArgBlock {
  label?: string;
  text: string;
  /** 给 highlight.js 的语言名（`bash` / `typescript` / …）；null 表示纯文本。 */
  grammar?: string | null;
}

/** 参数里除了正文之外的短字段，显示成对话框顶上的一排小胶囊。 */
export interface ArgFact {
  key: string;
  value: string;
}

export interface ToolArgsView {
  blocks: ArgBlock[];
  facts: ArgFact[];
}

/** 低于这个长度的字符串不值得单独占一块，跟其它短字段一样当事实。 */
const LONG_ENOUGH = 60;
/** 事实胶囊里的值再长就截断：胶囊是「扫一眼」用的，长正文已经在下面的块里了。 */
const FACT_MAX = 160;

const COMMAND_KEYS = new Set(["command", "cmd", "script", "shell"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 参数是对象就用它；是一段 JSON 文本（常见于从转录里读回来的旧工具调用）就解析成对象。 */
function parsedArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  const text = args.trim();
  if (!/^[[{]/.test(text)) return args;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return args;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function factValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null || value === undefined) text = String(value);
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > FACT_MAX ? `${flat.slice(0, FACT_MAX)}…` : flat;
}

function factsOf(obj: Record<string, unknown>, skip: ReadonlySet<string>): ArgFact[] {
  return Object.entries(obj)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== "")
    .map(([key, value]) => ({ key, value: factValue(value) }));
}

function blockLabel(key: string): string {
  if (COMMAND_KEYS.has(key)) return tr("命令");
  if (key === "content" || key === "text") return tr("内容");
  return key;
}

function blockGrammar(key: string, path: string | null): string | null {
  if (COMMAND_KEYS.has(key)) return "bash";
  if ((key === "content" || key === "text") && path) return langOf(path);
  return null;
}

/**
 * `edit` 的两种写法（一次改几处）：`edits[]` 里是 oldText / newText，排成 diff 比原样 JSON 好认。
 * 只要有一项形状不对就整个放弃，退回通用处理 —— 猜错了不如不猜。
 */
function diffBlocks(obj: Record<string, unknown>): ArgBlock[] | null {
  const edits = obj.edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const rows: { oldText: string; newText: string }[] = [];
  for (const edit of edits) {
    if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") return null;
    rows.push({ oldText: edit.oldText, newText: edit.newText });
  }
  return rows.map((row, index) => {
    const removed = row.oldText.split("\n").map((line) => `- ${line}`);
    const added = row.newText.split("\n").map((line) => `+ ${line}`);
    return {
      label: rows.length > 1 ? tr("改动 {p1}", { p1: index + 1 }) : tr("改动"),
      text: [...removed, ...added].join("\n"),
      grammar: "diff",
    };
  });
}

/** 工具参数 → 对话框里的块 + 事实。 */
export function toolArgsView(args: unknown): ToolArgsView {
  const parsed = parsedArgs(args);
  if (typeof parsed === "string") return { blocks: [{ label: tr("参数"), text: parsed }], facts: [] };
  if (!isRecord(parsed)) return { blocks: [{ label: tr("参数"), text: prettyJson(parsed), grammar: "json" }], facts: [] };

  const diff = diffBlocks(parsed);
  if (diff) return { blocks: diff, facts: factsOf(parsed, new Set(["edits"])) };

  const path = typeof parsed.path === "string" ? parsed.path : typeof parsed.file === "string" ? parsed.file : null;
  const long = Object.entries(parsed).filter(([, value]) => typeof value === "string" && (value.length > LONG_ENOUGH || value.includes("\n")));
  // 没有「一坨正文」的参数（ask / todo / MCP 的嵌套对象）：整份缩进 JSON 比拆成事实胶囊好读。
  if (!long.length) return { blocks: [{ label: tr("参数"), text: prettyJson(parsed), grammar: "json" }], facts: [] };

  const blocks: ArgBlock[] = long.map(([key, value]) => ({
    label: blockLabel(key),
    text: value as string,
    grammar: blockGrammar(key, path),
  }));
  return { blocks, facts: factsOf(parsed, new Set(long.map(([key]) => key))) };
}

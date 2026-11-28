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
 *      timeout…）收成一行事实胶囊，不再跟正文混在一起；一行压不平的、或里面还埋着长文本的
 *      字段排成结构提纲，那些长文本各占一块。
 *   3. 正文按真文本铺开，并给一个语法名（命令 = bash、写文件按路径猜、edit 排成 diff）。
 */
import { langOf } from "./highlight.ts";
import { tr } from "./i18n/index.ts";

/**
 * 对话框里的一块正文。`text` 就是这块显示的内容，也是「复制」拿到的那份（看到什么拷什么）；
 * `label` / `grammar` 只影响怎么画。
 */
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

/** 一个值压成事实胶囊里那一行（不截断：装不下的一律不进胶囊，见 `fitsFact()`）。 */
function flatValue(value: unknown): string {
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
  return text.replace(/\s+/g, " ").trim();
}

/** 胶囊里塞得下吗？塞不下的不能只靠 160 字截断 —— 那样全文就再也读不到了（评审 #759）。 */
function fitsFact(value: unknown): boolean {
  return flatValue(value).length <= FACT_MAX;
}

function blockLabel(key: string): string {
  if (COMMAND_KEYS.has(key)) return tr("命令");
  if (key === "content" || key === "text") return tr("内容");
  // 其余的标题就是参数自己的字段名（`prompt` / `query`…），跟事实胶囊一样刻意不翻：
  // 它指的是接口里的这个键，翻成中文反而对不上原文。
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

function isLongText(value: unknown): value is string {
  return typeof value === "string" && (value.length > LONG_ENOUGH || value.includes("\n"));
}

/** 结构 JSON 里被挑出去的长文本用这个占位：内容在它自己那块里，别在这儿再来一份转义的。 */
const ELIDED = "…";
/** 往下找埋着的长文本时最多钻几层：`questions[0].prompt` 是两层，再深就不值得挑了。 */
const NESTED_DEPTH = 3;

interface LongLeaf {
  path: string;
  text: string;
}

/** 把对象里埋着的长字符串连路径一起捞出来（顶层已经成块的不再重复捞）。 */
function longLeaves(value: unknown, path: string, out: LongLeaf[], depth = 0): void {
  if (depth > NESTED_DEPTH) return;
  if (typeof value === "string") {
    if (isLongText(value)) out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => longLeaves(item, `${path}[${index}]`, out, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) longLeaves(child, path ? `${path}.${key}` : key, out, depth + 1);
}

/** 同样的结构，长字符串换成 `…`：结构那块只当提纲，长正文在它自己那块出现一次。
 *  深度上限必须跟 `longLeaves()` 一致 —— 挑不出来的那些要是被省略了，就真丢了。 */
function elideLong(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return depth > 0 && depth <= NESTED_DEPTH && isLongText(value) ? ELIDED : value;
  if (Array.isArray(value)) return value.map((item) => elideLong(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, elideLong(child, depth + 1)]));
}

/** 工具参数 → 对话框里的块 + 事实。 */
export function toolArgsView(args: unknown): ToolArgsView {
  const parsed = parsedArgs(args);
  if (typeof parsed === "string") return { blocks: [{ label: tr("参数"), text: parsed }], facts: [] };
  if (!isRecord(parsed)) return { blocks: [{ label: tr("参数"), text: prettyJson(parsed), grammar: "json" }], facts: [] };

  // 正文按哪个文件的语言上色：write 用 `path`，少数工具用 `file`（两个都可能是别的东西，逐个认）。
  let path: string | null = null;
  for (const key of ["path", "file"]) {
    if (typeof parsed[key] === "string") {
      path = parsed[key] as string;
      break;
    }
  }
  const entries = Object.entries(parsed).filter(([, value]) => value !== undefined && value !== "");
  const long = entries.filter(([key, value]) => key !== "edits" && isLongText(value));
  const blocks: ArgBlock[] = long.map(([key, value]) => ({
    label: blockLabel(key),
    text: value as string,
    grammar: blockGrammar(key, path),
  }));
  const used = new Set(long.map(([key]) => key));
  // edit 的 edits[]：一块一张 diff。以前它跟长字段是二选一（先早退），别的长正文只能被压成事实胶囊。
  const diff = diffBlocks(parsed);
  if (diff) {
    blocks.push(...diff);
    used.add("edits");
  }

  // 其余字段：压成一行装得下、里面也没有长正文的，就当事实胶囊；其余（典型的是一坨嵌套结构，
  // 或一行压不平的）排成结构提纲，里面埋着的长文本各占一块 —— 不能只剩一个截断的胶囊，
  // 那样弹窗里再没有别处能读到全文，复制也拿不到。
  const facts: ArgFact[] = [];
  const overflow: { key: string; value: unknown; leaves: LongLeaf[] }[] = [];
  for (const [key, value] of entries) {
    if (used.has(key)) continue;
    const leaves: LongLeaf[] = [];
    longLeaves(value, key, leaves);
    if (leaves.length || !fitsFact(value)) overflow.push({ key, value, leaves });
    else facts.push({ key, value: flatValue(value) });
  }
  if (overflow.length) {
    // 深度从「这个字段的值」起算，跟 `longLeaves()` 同一套坐标（差一层就会把挑不出来的也省略掉）。
    const outline = Object.fromEntries(overflow.map(({ key, value }) => [key, elideLong(value)]));
    // 结构块只当提纲：挑出去的长文本换成 `…`，正文在它自己那块出现一次。
    blocks.push({ label: tr("参数"), text: prettyJson(outline), grammar: "json" });
    for (const { leaves } of overflow) blocks.push(...leaves.map((leaf): ArgBlock => ({ label: leaf.path, text: leaf.text })));
  }

  // 一块正文都没有（参数很短，或全是塞得进胶囊的杂项）：整份缩进 JSON 比一行行胶囊好读。
  if (!blocks.length) return { blocks: [{ label: tr("参数"), text: prettyJson(parsed), grammar: "json" }], facts: [] };
  return { blocks, facts };
}

/**
 * #503 浏览器面板第一步：把会话 items 里「调浏览器」的那些工具调用折成可读卡片。
 *
 * 这里只管数据，不碰 DOM、不产中文文案：子步骤只带 kind + target，渲染层再用 `tr()` 出话，
 * 所以单测不需要 i18n，前端也能随语言换词（D?? · 见 en.ts / ja.ts）。
 *
 * 为什么要这一层：`browser_exec(code)` 把十几次导航 / 点击 / JS 塞进一次工具调用，侧栏只看到一行
 * `mcp__browser_use 48.0 秒`，看不出它在点哪个按钮、是不是在同一个地方打转。
 */
import type { Item } from "./types.ts";

/** 子步骤类型。`call` 是认不出的自家函数，`raw` 是连函数名都拆不出的那行代码。 */
export type BrowserOpStepKind =
  | "nav"
  | "wait"
  | "js"
  | "click"
  | "cdp"
  | "read"
  | "print"
  | "tab"
  | "input"
  | "scroll"
  | "call"
  | "raw";

export interface BrowserOpStep {
  kind: BrowserOpStepKind;
  /** 网址 / 坐标 / 代码片段 / `Domain.method` / 函数名，按 kind 解释。 */
  target?: string;
  /** `call` 用：认不出的函数名。 */
  name?: string;
  /** 同一 (kind,target,name) 连续出现的次数，≥2 才写。 */
  repeat?: number;
}

/**
 * `stuck` = 疑似卡住（超阈值，红）。原型里叫 silent 的那一层与「无声」语义撞车，实现时改名，
 * 见 PR 说明。
 */
export type BrowserOpState = "running" | "slow" | "stuck" | "done" | "failed";

export interface BrowserOpCard {
  toolCallId: string;
  tool: string;
  /** 子代理名字；主会话调用是 null。 */
  subagent: string | null;
  startedAt: number;
  /** 整次工具调用耗时；还在跑的时候按 `now - startedAt` 算。 */
  durationMs: number | null;
  state: BrowserOpState;
  /** 跑着、且这次调用输出过东西，但 20 秒没新输出 —— 另一层「疑似卡住」。 */
  silent: boolean;
  /** 距最后一次新输出多少毫秒；这次调用还没输出过就是 null（不把「开始到现在」当「多久没输出」）。 */
  silentFor: number | null;
  /** 同一动作连续重复到 `loopCount` 次。 */
  looping: boolean;
  /** 调用前模型最后一段话；没有就空串。 */
  intent: string;
  steps: BrowserOpStep[];
  /** 工具输出（照片已压成 `[图片]`）；跑着的时候是这轮 partial 输出。渲染层负责截断。 */
  output: string;
  /** 有头 / 无头；看不出来是 null，不猜。 */
  headed: boolean | null;
}

export interface BrowserOpsSummary {
  cards: BrowserOpCard[];
  total: number;
  totalMs: number;
  slowestMs: number | null;
  current: { state: BrowserOpState; ms: number } | null;
  empty: boolean;
}

export interface BrowserOpsThresholds {
  slowMs: number;
  stuckMs: number;
  silentMs: number;
  loopCount: number;
}

/** 与原型一致，也写进了 issue #503 的 spec。 */
export const BROWSER_OPS_DEFAULTS: BrowserOpsThresholds = {
  slowMs: 60_000,
  stuckMs: 120_000,
  silentMs: 20_000,
  loopCount: 3,
};

/**
 * 默认白名单：`browser_use*` / `playwright*` 这类 MCP 前缀，加几个常见裸名。
 * 用户可编辑，所以列表放这里而不是各处硬编码。
 */
export const BROWSER_TOOL_PATTERNS: readonly string[] = [
  "browser_use",
  "browser-use",
  "playwright",
  "chrome_devtools",
  "puppeteer",
  "selenium",
  "browserbase",
  "lightpanda",
];

export interface BrowserOpsChildRun {
  name: string;
  items: Item[];
}

export interface BrowserOpsInput {
  items: Item[];
  /** 已订阅到 items 的子代理；只想看主会话时传空数组。 */
  childRuns?: BrowserOpsChildRun[];
  tools?: readonly string[];
  thresholds?: Partial<BrowserOpsThresholds>;
  /**
   * 每次调用「最后一次有新输出」的时刻（toolCallId → 毫秒）。只有界面侧记下来才有的数据，
   * 不传就没有「无声」这一层：宁可不标，也不拿「开始到现在」冒充「多久没输出」。
   */
  outputAt?: Record<string, number>;
  now: number;
}

type ToolItem = Extract<Item, { kind: "tool" }>;

/** 工具名是否算「在操作浏览器」。`mcp__browser_use` 这种带前缀的按子串认。 */
export function isBrowserTool(name: string, patterns: readonly string[] = BROWSER_TOOL_PATTERNS): boolean {
  const lower = name.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function browserOpsView(input: BrowserOpsInput): BrowserOpsSummary {
  const thresholds = { ...BROWSER_OPS_DEFAULTS, ...input.thresholds };
  const patterns = input.tools?.length ? input.tools : BROWSER_TOOL_PATTERNS;
  const outputAt = input.outputAt ?? {};
  const cards: BrowserOpCard[] = [];

  for (const run of input.childRuns ?? []) {
    cards.push(...cardsFrom(run.items, patterns, thresholds, input.now, run.name, outputAt));
  }
  cards.push(...cardsFrom(input.items, patterns, thresholds, input.now, null, outputAt));

  // 新→旧：只按发现顺序倒过来，不看时间 —— 时间戳可能缺失（缺失时 startedAt 只能拿 now 凑），
  // 而 `items` 本身是按时序排的，下标越大越新。
  const ordered = cards.map((card, index) => ({ card, index }));
  ordered.sort((a, b) => b.index - a.index);
  return summarize(ordered.map((entry) => entry.card));
}

function cardsFrom(
  items: Item[],
  patterns: readonly string[],
  thresholds: BrowserOpsThresholds,
  now: number,
  subagent: string | null,
  outputAt: Record<string, number>,
): BrowserOpCard[] {
  const cards: BrowserOpCard[] = [];
  let intent = "";
  for (const item of items) {
    if (item.kind === "assistant") {
      if (item.text.trim()) intent = item.text.trim();
      continue;
    }
    if (item.kind !== "tool" || !isBrowserTool(item.name, patterns)) continue;
    cards.push(card(item, intent, thresholds, now, subagent, outputAt[item.toolCallId]));
  }
  return cards;
}

function card(
  item: ToolItem,
  intent: string,
  thresholds: BrowserOpsThresholds,
  now: number,
  subagent: string | null,
  lastOutputAt: number | undefined,
): BrowserOpCard {
  const startedAt = item.ts ? Date.parse(item.ts) : now;
  const running = item.status === "running";
  const measured = running ? Math.max(0, now - startedAt) : item.durationMs ?? null;
  const steps = parseSteps(item.args, item.name);
  const silentFor = lastOutputAt === undefined ? null : Math.max(0, now - lastOutputAt);
  return {
    toolCallId: item.toolCallId,
    tool: item.name,
    subagent,
    startedAt: Number.isFinite(startedAt) ? startedAt : now,
    durationMs: measured,
    state: stateOf(item, measured ?? 0, thresholds),
    silent: running && silentFor !== null && silentFor >= thresholds.silentMs,
    silentFor,
    looping: steps.some((step) => (step.repeat ?? 1) >= thresholds.loopCount),
    intent: intent.slice(0, 280),
    steps,
    output: (running ? item.partialResult ?? item.result : item.result) ?? "",
    headed: headedOf(item),
  };
}

/** 最多拆多少步：一次 `browser_exec` 里塞几十行很常见，再多也读不完。 */
export const MAX_STEPS = 40;

const KIND_BY_NAME: Record<string, BrowserOpStepKind> = {
  goto_url: "nav",
  navigate: "nav",
  goto: "nav",
  open_url: "nav",
  open: "nav",
  click: "click",
  click_text: "click",
  click_selector: "click",
  click_at: "click",
  click_at_xy: "click",
  dblclick: "click",
  tap: "click",
  js: "js",
  evaluate: "js",
  evaluate_js: "js",
  run_js: "js",
  exec_js: "js",
  cdp: "cdp",
  send_cdp: "cdp",
  cdp_command: "cdp",
  cdp_send: "cdp",
  page_info: "read",
  get_page_info: "read",
  snapshot: "read",
  aria_snapshot: "read",
  accessibility_snapshot: "read",
  screenshot: "read",
  read_page: "read",
  print: "print",
  new_tab: "tab",
  switch_tab: "tab",
  activate_tab: "tab",
  select_tab: "tab",
  close_tab: "tab",
  list_tabs: "tab",
  type_text: "input",
  type: "input",
  fill: "input",
  press_key: "input",
  press: "input",
  scroll: "scroll",
  scroll_to: "scroll",
  scroll_into_view: "scroll",
  wheel: "scroll",
};

/** 等待类：名字带 wait / sleep / idle / loaded 的都算「在等」。 */
const WAIT_HINT = /(^|_)(wait|sleep|idle|loaded?)($|_)/;

/** 纯取值 / 拼接的壳子，不算「做了什么」，否则每行 print 都会被拆成三步。 */
const WRAPPERS = new Set([
  "print",
  "repr",
  "str",
  "len",
  "int",
  "float",
  "bool",
  "hasattr",
  "getattr",
  "isinstance",
  "list",
  "dict",
  "tuple",
  "any",
  "all",
  "sorted",
  "min",
  "max",
  "get",
  "set",
  "keys",
  "values",
  "items",
  "pop",
  "append",
  "extend",
  "update",
  "format",
  "join",
  "replace",
  "split",
  "strip",
  "trim",
  "slice",
  "then",
  "stringify",
  "dumps",
  "loads",
]);

interface RawCall {
  name: string;
  args: string;
}

/**
 * 从工具参数里拆出子步骤。
 *
 * browser-use 的实际形状是 `value.browser_exec(code=…)`：一段 python，里面依次调 `goto_url` /
 * `js` / `page_info` 这些自家函数。所以这里做的是「按语句切 → 找语句里的调用 → 认名字」，
 * 认不出就记函数名，连函数名都拆不出才整段落成 raw。不执行、不求值，纯文本。
 */
export function parseSteps(args: unknown, toolName = ""): BrowserOpStep[] {
  const code = codeOf(args);
  if (code === null) return structuredSteps(args, toolName);
  const steps = statements(code).flatMap(stepsOfStatement);
  if (!steps.length) {
    const raw = collapse(code).slice(0, 80);
    return raw ? [{ kind: "raw", target: raw }] : [];
  }
  return mergeRepeats(steps).slice(0, MAX_STEPS);
}

function codeOf(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const bag = args as Record<string, unknown>;
  const inner = bag.args && typeof bag.args === "object" ? (bag.args as Record<string, unknown>) : bag;
  const code = inner.code ?? inner.script ?? inner.source ?? bag.code;
  return typeof code === "string" ? code : null;
}

/** Playwright MCP 那种扁平参数：一个调用一步，能读出来的字段进 target。 */
function structuredSteps(args: unknown, toolName: string): BrowserOpStep[] {
  if (!args || typeof args !== "object") return [];
  const bag = args as Record<string, unknown>;
  const inner = bag.args && typeof bag.args === "object" ? (bag.args as Record<string, unknown>) : bag;
  const raw = (typeof bag.tool === "string" ? bag.tool : null) ?? (toolName ? lastSegment(toolName) : null);
  const kind = raw ? kindFor(structuredName(raw)) : null;
  const target = ["url", "selector", "element", "ref", "text", "name"]
    .map((key) => inner[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  const text = target ? collapse(target).slice(0, 80) : undefined;
  if (kind) return [{ kind, target: kind === "wait" || kind === "read" ? undefined : text }];
  return raw ? [{ kind: "call", name: structuredName(raw), target: text }] : [];
}

/** `browser_click` / `pw_click` → `click`：MCP 的裸名常带前缀。 */
function structuredName(name: string): string {
  return name.replace(/^(browser|page|pw)_/, "");
}

function kindFor(name: string): BrowserOpStepKind | null {
  return KIND_BY_NAME[name] ?? (WAIT_HINT.test(name) ? "wait" : null);
}

/** 连续相同的步骤（同一行代码重复跑）合并成 repeat，读起来才不刷屏。 */
function mergeRepeats(steps: BrowserOpStep[]): BrowserOpStep[] {
  const out: BrowserOpStep[] = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (last && last.kind === step.kind && last.target === step.target && last.name === step.name) {
      last.repeat = (last.repeat ?? 1) + 1;
      continue;
    }
    out.push({ ...step });
  }
  return out;
}

function stepsOfStatement(statement: string): BrowserOpStep[] {
  const text = statement.trim();
  if (!text || text.startsWith("#") || /^(import|from)\b/.test(text)) return [];
  const calls = findCalls(text);
  const actionable = calls.filter((call) => !WRAPPERS.has(lastSegment(call.name)));
  const picked = actionable.length ? actionable[0] : calls[0];
  if (!picked) return [];
  const name = lastSegment(picked.name);
  const kind = kindFor(name);
  if (!kind) return [{ kind: "call", name }];
  return [{ kind, target: targetOf(kind, picked.args) }];
}

function targetOf(kind: BrowserOpStepKind, argsRaw: string): string | undefined {
  if (kind === "wait" || kind === "read") return undefined;
  const literal = firstString(argsRaw);
  if (kind === "js" || kind === "print") return collapse(literal ?? argsRaw).slice(0, 80) || undefined;
  if (kind === "nav" || kind === "cdp" || kind === "tab" || kind === "input" || kind === "scroll") {
    return collapse(literal ?? argsRaw).slice(0, 80) || undefined;
  }
  // click：有字符串（选择器 / 文字）就用它，否则用坐标原样。
  const target = collapse(literal ?? argsRaw).replace(/^[\(\[\{]|[\]\)\}]$/g, "").trim();
  return target.slice(0, 80) || undefined;
}

function lastSegment(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1];
}

/** 按语句切代码：字符串里的换行与括号里的换行都不算语句边界。 */
function statements(code: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const end = stringEnd(code, i, ch.repeat(code.startsWith(ch.repeat(3), i) ? 3 : 1));
      buf += code.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "#") {
      const nl = code.indexOf("\n", i);
      i = nl < 0 ? code.length : nl;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if ((ch === "\n" || ch === ";") && depth === 0) {
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  out.push(buf);
  return out.map((line) => line.trim()).filter(Boolean);
}

/** 从引号处开始，返回整个字符串字面量之后的下标。 */
function stringEnd(code: string, start: number, quote: string): number {
  const triple = quote.length === 3;
  let i = start + quote.length;
  while (i < code.length) {
    if (!triple && code[i] === "\\") {
      i += 2;
      continue;
    }
    if (code.startsWith(quote, i)) return i + quote.length;
    i += 1;
  }
  return code.length;
}

/** 扫出语句里所有 `名字(` 调用（字符串里的不算），外层的先出现。 */
function findCalls(statement: string): RawCall[] {
  const calls: RawCall[] = [];
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i];
    if (ch === '"' || ch === "'") {
      i = stringEnd(statement, i, ch.repeat(statement.startsWith(ch.repeat(3), i) ? 3 : 1));
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) {
      i += 1;
      continue;
    }
    const match = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/.exec(statement.slice(i));
    if (!match) {
      i += 1;
      continue;
    }
    const name = match[0];
    let j = i + name.length;
    while (j < statement.length && /\s/.test(statement[j])) j += 1;
    if (statement[j] !== "(") {
      i += name.length;
      continue;
    }
    calls.push({ name, args: argsAt(statement, j) });
    i += name.length;
  }
  return calls;
}

/** 括号配对取出 `(` 到对应的 `)` 之间的原文。 */
function argsAt(text: string, open: number): string {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = stringEnd(text, i, ch.repeat(text.startsWith(ch.repeat(3), i) ? 3 : 1));
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
    i += 1;
  }
  return text.slice(open + 1);
}

/** 取第一个字符串字面量的内容。 */
function firstString(text: string): string | null {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch.repeat(text.startsWith(ch.repeat(3), i) ? 3 : 1);
      const end = stringEnd(text, i, quote);
      return text.slice(i + quote.length, Math.max(i + quote.length, end - quote.length));
    }
    i += 1;
  }
  return null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 有头 / 无头：代码里露了 headless 才算，没写就是 null（不猜）。 */
function headedOf(item: ToolItem): boolean | null {
  const args = item.args && typeof item.args === "object" ? JSON.stringify(item.args) : "";
  if (/headless"?\s*[:=]\s*true/i.test(args)) return false;
  if (/headless"?\s*[:=]\s*false/i.test(args)) return true;
  return null;
}

function stateOf(item: ToolItem, elapsedMs: number, thresholds: BrowserOpsThresholds): BrowserOpState {
  if (item.status === "running") {
    if (elapsedMs >= thresholds.stuckMs) return "stuck";
    if (elapsedMs >= thresholds.slowMs) return "slow";
    return "running";
  }
  if (item.status === "error" || item.isError) return "failed";
  return "done";
}

function summarize(cards: BrowserOpCard[]): BrowserOpsSummary {
  const totalMs = cards.reduce((sum, card) => sum + (card.durationMs ?? 0), 0);
  const durations = cards.map((card) => card.durationMs).filter((ms): ms is number => ms !== null);
  const current = cards.find((card) => card.state === "running" || card.state === "slow" || card.state === "stuck");
  return {
    cards,
    total: cards.length,
    totalMs,
    slowestMs: durations.length ? Math.max(...durations) : null,
    current: current ? { state: current.state, ms: current.durationMs ?? 0 } : null,
    empty: cards.length === 0,
  };
}

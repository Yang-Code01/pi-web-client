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
  | "launch"
  | "shot"
  | "run"
  | "call"
  | "raw"
  | "act"
  | "check"
  | "value"
  | "file";

export interface BrowserOpStep {
  kind: BrowserOpStepKind;
  /** 网址 / 坐标 / 代码片段 / `Domain.method` / 函数名，按 kind 解释。 */
  target?: string;
  /** `call` 用：认不出的函数名；`check` 失败时放 actual / expected。 */
  name?: string;
  /** `check` 用：断言过了没有。 */
  ok?: boolean;
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
  /**
   * 正在跑、而且实际执行里同一动作连续到 `loopCount` 次（运行输出里的重复，或连着几次一模一样的浏览器工具调用）。
   * 从代码里猜出来的重复（循环、多次读值）不算；调用一结束就不再标（D327）。
   */
  looping: boolean;
  /**
   * 步骤从哪来：`output` = 脚本自己在输出里报的（实际做了什么），`script` = 从脚本源码猜的（打算做什么），
   * `call` = 浏览器工具这次调用的参数 / 代码。
   */
  stepSource: "output" | "script" | "call";
  /** 调用前模型最后一段话；没有就空串。 */
  intent: string;
  steps: BrowserOpStep[];
  /** 工具输出（照片已压成 `[图片]`）；跑着的时候是这轮 partial 输出。渲染层负责截断。 */
  output: string;
  /** 有头 / 无头；看不出来是 null，不猜。 */
  headed: boolean | null;
  /**
   * 这次调用是「跑脚本」而不是 MCP 浏览器工具时，脚本的文件名（步骤是从脚本源码读出来的）。
   * 直接调 MCP 工具的是 null。
   */
  script: string | null;
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
  "browseruse",
  "cdp",
  "chrome",
  "chromedriver",
  "stagehand",
  "agentql",
  "skyvern",
  "notte",
  "steel",
  "browserless",
  "agent_browser",
  "agent-browser",
];

/**
 * 名字里有独立的 `browser` 一节（`agent_browser`、`browser_exec`、`desktop-touch_browser_click`）
 * 也算：名单是子串匹配，但浏览器工具的命名五花八门，光靠名单总会漏（D327 里 `agent_browser`
 * 用了 550 多次，一次都没进面板）。要求前后是分隔符，`subbrowsers` 这种不会误中。
 */
const BROWSER_WORD = /(?:^|[_\-.])browser(?:[_\-.]|$)/i;

/**
 * 跑脚本的 shell 工具。它们不在白名单里，但现实里最常见的一条路就是「写个 playwright 脚本，
 * 用 bash 跑 node」——只认 MCP 工具名会把整类操作漏掉（#505 验收时就是这么漏的）。
 */
const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "pwsh",
  "powershell",
  "cmd",
  "run",
  "exec",
  "terminal",
  "bg_run",
  "background",
  "spawn",
]);

/** 脚本源码里出现这些词，才认定它在驱动浏览器。 */
const DRIVER_HINTS: readonly string[] = [
  "playwright",
  "puppeteer",
  "selenium",
  "webdriver",
  "chrome-remote-interface",
  "devtools-protocol",
];

/** 命令行里的脚本文件（`node E:/x/a.mjs`、`python ./a.py`、`bash scripts/e2e.sh`）。 */
const SCRIPT_FILE = /\.(?:mjs|cjs|js|mts|cts|tsx?|py|sh|bash|ps1)$/i;

/** 内联代码里出现这些，就算在驱动浏览器 —— 未必写了 `import ... from 'playwright'`。 */
const DRIVER_CALL = /(?:chromium|firefox|webkit)\s*\.\s*launch|\.newPage\s*\(|page\s*\.\s*goto\s*\(/;

/** python 内联：真起了 / 连了浏览器才算，`python -c "import playwright"` 只是检查。 */
const PY_DRIVER_CALL =
  /\b(?:sync|async)_playwright\s*\(|\bconnect_over_cdp\s*\(|\.launch(?:_persistent_context)?\s*\(|\bwebdriver\.(?:Chrome|Edge|Firefox|Remote)\s*\(/;

/**
 * 不写 `import playwright`、直接调 page 对象的片段脚本（D327：交给项目自己的执行器跑，
 * `p.get_by_role(...).click()`）。这些写法几乎只在浏览器自动化里出现。
 */
const PAGE_API: readonly RegExp[] = [
  /\bget_by_(?:role|text|label|placeholder|test_id|title|alt_text)\s*\(/,
  /\bgetBy(?:Role|Text|Label|Placeholder|TestId|Title|AltText)\s*\(/,
  /\.locator\s*\(/,
  /\.goto\s*\(/,
  /\bwait_for_(?:timeout|selector|load_state|url|event|function)\s*\(/,
  /\bwaitFor(?:Timeout|Selector|LoadState|URL|Event|Function)\s*\(/,
  /\b(?:set_viewport_size|setViewportSize)\s*\(/,
  /\b(?:select_option|selectOption)\s*\(/,
  /\.keyboard\.(?:press|type|down|up)\s*\(/,
  /\.mouse\.(?:click|move|wheel|down|up)\s*\(/,
  /\.(?:find_element|findElement)\s*\(/,
  /\bexpect\s*\([^)]*\)\s*\.\s*(?:to_(?:be|have)|toBe|toHave)/,
];

/** 解释器：后面跟的第一个脚本才是「被跑的」，其余是参数。 */
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "python2",
  "py",
  "pythonw",
  "pytest",
  "bash",
  "sh",
  "zsh",
  "dash",
  "pwsh",
  "powershell",
]);

/** 能直接跑一段驱动代码的解释器（不含 shell）。 */
const CODE_INTERPRETERS = /^(?:node|nodejs|deno|bun|tsx|ts-node|python[0-9]?|py|pythonw)$/;

/** 解释器的「后面带一个值」的开关：`python -X utf8`、`node -r dotenv/config`。 */
const INTERPRETER_VALUE_FLAGS = new Set([
  "-x",
  "-w",
  "-r",
  "--require",
  "--import",
  "--loader",
  "-executionpolicy",
  "-file",
  "-o",
  "-p",
  "-k",
]);

/** 直接跑一段代码：`node -e`、`python -c`、`pwsh -Command`、`python -`（读 stdin / heredoc）。 */
const INLINE_FLAGS = new Set(["-e", "--eval", "-c", "-command", "-p", "--print", "-"]);

/** 套在命令外面的壳：`timeout 600 …`、`env A=1 …`、`npx …`。 */
const COMMAND_WRAPPERS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "{",
  "!",
  "time",
  "nohup",
  "exec",
  "env",
  "sudo",
  "xvfb-run",
  "stdbuf",
  "nice",
  "command",
  "builtin",
  "npx",
  "bunx",
  "call",
  "start",
]);

/** 浏览器自动化命令行：`agent-browser open …`、`browser-use open …`。 */
const BROWSER_CLIS = new Set(["agent-browser", "browser-use"]);

/** 命令行工具的管理子命令：装包、查版本、自检，不算操作浏览器。 */
const CLI_ADMIN = new Set(["install", "uninstall", "doctor", "help", "upgrade", "update", "setup", "init", "completion", "version", "config"]);

/** 命令行跑测试 / 跑工具（不是「写脚本再跑」，没有源码可读）。 */
const RUNNERS: readonly [RegExp, string][] = [
  [/\bplaywright\s+(?:test|codegen|screenshot|pdf|open)\b/i, "playwright test"],
  [/\bcypress\s+run\b/i, "cypress run"],
  [/\bwdio\s+(?:run\b|wdio\.conf)/i, "wdio run"],
  [/\bselenium-side-runner\b/i, "selenium-side-runner"],
  [/\bpytest\b[^\n]*--headed/i, "pytest --headed"],
  [/\bnpx\s+(?:-{1,2}[\w-]+\s+)*puppeteer\b/i, "puppeteer"],
];

/** 直接起浏览器：带无头 / 调试端口 / 指定 profile 才算「在自动化它」。 */
const BROWSER_BIN = /\b(?:chrome|chromium|msedge|firefox|brave)\b/i;
const BROWSER_AUTOMATION_FLAG = /(?:--headless|--remote-debugging-port|--app=|--user-data-dir)/;
/** 连 CDP 端点：`curl 127.0.0.1:9222/json/version`。 */
const CDP_ENDPOINT = /(?:127\.0\.0\.1|localhost):(\d{2,5})\/(?:json|devtools)/i;
/** 脚本里直接发 CDP 命令：`Page.navigate`、`Runtime.evaluate`、`Input.dispatchMouseEvent`。 */
const CDP_METHOD = /["'`](?:Page\.navigate|Page\.captureScreenshot|Runtime\.evaluate|Input\.dispatch\w+|Target\.createTarget)["'`]/;

interface ScriptSource {
  /** 归一化后的绝对路径（反斜杠 → `/`）。 */
  path: string;
  base: string;
  content: string;
  /** items 里的先后顺序，同一文件写过几次时取最后一次。 */
  order: number;
}

export interface BrowserOpsChildRun {
  name: string;
  items: Item[];
}

export interface BrowserOpsInput {
  items: Item[];
  /** 已订阅到 items 的子代理；只想看主会话时传空数组。 */
  childRuns?: BrowserOpsChildRun[];
  tools?: readonly string[];
  /**
   * 命令关键词：shell 命令里出现其中之一就算一次浏览器操作。兜底用 —— 项目自己的执行器
   * （`bash scripts/e2e.sh`）认不出脚本内容时，用户在面板齿轮里加上它的名字。默认空。
   */
  commands?: readonly string[];
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
  return BROWSER_WORD.test(name) || patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * 这次调用如果是浏览器工具，返回面板上显示的工具名；否则 null。
 *
 * 通用 MCP 网关（`mcp({ tool: "browser_exec" })`）与代理（`mcp__desktop_touch({ tool:
 * "desktop-touch_browser_click" })`）自己的名字说明不了什么，要看它转发的那个工具。
 * 只是列工具 / 查说明（没有 `tool` 字段）不算。
 */
export function browserToolLabel(
  name: string,
  args: unknown,
  patterns: readonly string[] = BROWSER_TOOL_PATTERNS,
): string | null {
  if (isBrowserTool(name, patterns)) return name;
  const inner = gatewayTool(name, args);
  return inner && isBrowserTool(inner, patterns) ? `${name} · ${inner}` : null;
}

/** 通用网关 / 代理转发的工具名（`mcp` / `mcp__x` 的 `args.tool`）。 */
function gatewayTool(name: string, args: unknown): string | null {
  const lower = name.toLowerCase();
  if (lower !== "mcp" && !/^mcp_/.test(lower)) return null;
  if (!args || typeof args !== "object") return null;
  const tool = (args as Record<string, unknown>).tool;
  return typeof tool === "string" && tool.trim() ? tool.trim() : null;
}

export function browserOpsView(input: BrowserOpsInput): BrowserOpsSummary {
  const thresholds = { ...BROWSER_OPS_DEFAULTS, ...input.thresholds };
  const patterns = input.tools?.length ? input.tools : BROWSER_TOOL_PATTERNS;
  const outputAt = input.outputAt ?? {};
  const commands = (input.commands ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean);
  const cards: BrowserOpCard[] = [];

  for (const run of input.childRuns ?? []) {
    cards.push(...cardsFrom(run.items, patterns, thresholds, input.now, run.name, outputAt, commands));
  }
  cards.push(...cardsFrom(input.items, patterns, thresholds, input.now, null, outputAt, commands));

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
  commands: readonly string[],
): BrowserOpCard[] {
  const cards: BrowserOpCard[] = [];
  const scripts = new Map<string, ScriptSource>();
  let intent = "";
  let order = 0;
  for (const item of items) {
    order += 1;
    if (item.kind === "assistant") {
      if (item.text.trim()) intent = item.text.trim();
      continue;
    }
    if (item.kind !== "tool") continue;
    // 先记账：这一轮里写过的脚本，后面 `bash node x.mjs` 才查得到源码。
    // 只记整份 `write`；`edit` 的增量不合并，所以步骤可能比脚本旧一点——比肎猜好。
    const written = writtenScript(item) ?? readScript(item);
    if (written) {
      scripts.set(written.path, { path: written.path, base: written.base, content: written.content, order });
    }
    // `cat > x.mjs <<'EOF' … EOF` 也算把脚本写下来了：后面 `node x.mjs` 才认得出。
    for (const copy of copiedScripts(commandOf(item), scripts)) scripts.set(copy.path, { ...copy, order });
    for (const heredoc of heredocsOf(commandOf(item))) {
      scripts.set(heredoc.path, {
        path: heredoc.path,
        base: baseName(heredoc.path),
        content: heredoc.content,
        order,
      });
    }
    const label = browserToolLabel(item.name, item.args, patterns);
    let scripted = label ? agentBrowserCall(item) : scriptedCall(item, scripts, commands);
    // D328：桥亲眼看到浏览器被拉起 / 被连上了，就不用猜命令是怎么写的。
    if (!label && !scripted && item.browser) scripted = evidenceCall(item);
    if (!label && !scripted) continue;
    const next = card(item, intent, thresholds, now, subagent, outputAt[item.toolCallId], scripted, label ?? item.name, label !== null);
    if (next.stepSource === "call" && isRunning(next) && repeatsPrevious(next, cards, thresholds.loopCount)) next.looping = true;
    cards.push(next);
  }
  return cards;
}

/** 只有桥的运行时证据、命令本身认不出来时的步骤：「运行 <命令>」+「启动浏览器 / 发 CDP」。输出里有步骤时仍以输出为准。 */
function evidenceCall(item: ToolItem): Scripted {
  const evidence = item.browser!;
  const steps: BrowserOpStep[] = [];
  const command = collapse(withoutHeredocBodies(commandOf(item))).slice(0, 80);
  if (command) steps.push({ kind: "run", target: command });
  steps.push(
    evidence.kind === "cdp"
      ? { kind: "cdp", target: `${evidence.browser} · 127.0.0.1:${evidence.port ?? "?"}` }
      : { kind: "launch", target: evidence.headless ? "headless" : undefined },
  );
  return { script: null, steps, headed: evidence.headless ? false : null };
}

/** 命令里直接写的文件（`cat > x.mjs <<'EOF' … EOF`）：把正文当脚本源码收进来看。 */
function heredocsOf(command: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const lines = command.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const head = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(lines[i]);
    if (!head) continue;
    const delimiter = head[2];
    const target = />\s*([^\s<>|;&'"]+)/.exec(lines[i]);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trimEnd() !== delimiter) {
      body.push(lines[j]);
      j += 1;
    }
    if (j < lines.length && target) out.push({ path: normPath(target[1]), content: body.join("\n") });
    i = j;
  }
  return out;
}

/** `write` 的整份内容：`{ path, content }`（不同工具的字段名不一样）。 */
function writtenScript(item: ToolItem): { path: string; base: string; content: string } | null {
  if (!item.args || typeof item.args !== "object") return null;
  const bag = item.args as Record<string, unknown>;
  const path = bag.path ?? bag.file_path ?? bag.filePath;
  const content = bag.content ?? bag.contents;
  if (typeof path !== "string" || typeof content !== "string" || !content.trim()) return null;
  const key = normPath(path);
  return { path: key, base: baseName(key), content };
}

/** `read` 读到的整份内容：项目里现成的执行器 / 脚本，会话里只读过、没写过。 */
function readScript(item: ToolItem): { path: string; base: string; content: string } | null {
  if (lastSegment(item.name).toLowerCase() !== "read") return null;
  if (!item.args || typeof item.args !== "object" || typeof item.result !== "string") return null;
  const bag = item.args as Record<string, unknown>;
  const path = bag.path ?? bag.file_path ?? bag.filePath;
  if (typeof path !== "string" || !SCRIPT_FILE.test(path.trim()) || !item.result.trim()) return null;
  // 只读了一段（offset / limit，或者太长被截断）：不是整份源码，别拿它盖掉前面写过的那份。
  if (bag.offset !== undefined || bag.limit !== undefined || /Use offset=\d+ to continue/.test(item.result)) return null;
  const key = normPath(path);
  return { path: key, base: baseName(key), content: item.result };
}

type Scripted = { script: string | null; steps: BrowserOpStep[]; headed: boolean | null };

/** 一条 shell 命令里「被跑的」脚本：`direct` 是解释器直接跑的，`args` 是交给它的脚本参数。 */
interface ShellRuns {
  direct: string[];
  args: string[];
  /** 解释器直接跑了一段代码（`-e` / `-c` / stdin）。 */
  inline: string[];
  /** 浏览器命令行（`agent-browser open …`）的参数。 */
  clis: string[][];
}

/**
 * 把命令拆成一条条简单命令再看每条跑了什么。只有「解释器 + 脚本」才算跑脚本：
 * `grep -n x run.py`、`sed -n 1,20p run.py`、`wc -l run.py` 只是在看，不该成卡（D327 实验时误报过）。
 */
function shellRuns(command: string): ShellRuns {
  const runs: ShellRuns = { direct: [], args: [], inline: [], clis: [] };
  for (const words of simpleCommands(command)) {
    const tokens = unwrap(words);
    if (!tokens.length) continue;
    const program = programOf(tokens[0]);
    if (BROWSER_CLIS.has(program)) {
      runs.clis.push(tokens.slice(1));
      continue;
    }
    let rest: string[];
    if (INTERPRETERS.has(program)) rest = tokens.slice(1);
    else if (SCRIPT_FILE.test(tokens[0])) rest = tokens;
    else continue;
    let first = true;
    let inline = false;
    let pytest = program === "pytest";
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      const lower = token.toLowerCase();
      if (first && INTERPRETERS.has(program) && token !== "-" && token.startsWith("-")) {
        if (INLINE_FLAGS.has(lower)) {
          inline = true;
          break;
        }
        if (lower === "-m") {
          // `python -m pytest a.py`：测试文件就是被跑的；`-m py_compile a.py` 只是编译检查。
          if (rest[i + 1] !== "pytest") {
            first = false;
            break;
          }
          pytest = true;
          i += 1;
          continue;
        }
        if (INTERPRETER_VALUE_FLAGS.has(lower) && lower !== "-file") i += 1;
        continue;
      }
      if (first && token === "-") {
        inline = true;
        break;
      }
      if (first && (program === "deno" || program === "bun") && token === "run") continue;
      if (!SCRIPT_FILE.test(token)) {
        if (first) break; // `node --version`、`bash -lc "…"` 之外的子命令：不是在跑脚本
        continue;
      }
      (first || pytest ? runs.direct : runs.args).push(normPath(token));
      first = false;
    }
    // 解释器后面什么脚本都没有、又喂了 heredoc（`node <<'EOF'`）：也是在跑 stdin 里的代码。
    // shell 自己（`bash -c` / `pwsh -Command`）不算：里面是别的命令，提到 playwright 不等于在跑它。
    const stdin = first && command.includes("<<") && !rest.some((token) => !token.startsWith("-"));
    if ((inline || stdin) && CODE_INTERPRETERS.test(program)) runs.inline.push(program);
  }
  return runs;
}

/** 拆成简单命令（`;` `&&` `||` `|` `&` 换行），引号里的不拆；heredoc 正文先去掉。 */
function simpleCommands(command: string): string[][] {
  const text = withoutHeredocBodies(command);
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  let quote = "";
  const endWord = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(dropRedirects(words));
    words = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "(" || ch === ")") {
      endCommand();
      continue;
    }
    // `2>&1` 里的 & 不是后台符。
    if (ch === "&" && !/[<>]$/.test(word)) {
      endCommand();
      continue;
    }
    word += ch;
  }
  endCommand();
  return out;
}

/** 去掉重定向：`> out.txt`、`2>&1`、`<<'EOF'`。 */
function dropRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (/^\d*(?:<<-?|>>|[<>])&?$/.test(word)) {
      i += 1; // 目标在下一个词
      continue;
    }
    if (/^\d*(?:<<|>>|[<>])/.test(word)) continue;
    out.push(word);
  }
  return out;
}

function withoutHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    const head = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(lines[i]);
    if (!head) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== head[2]) j += 1;
    i = j;
  }
  return out.join("\n");
}

/** 去掉套在外面的壳：环境变量赋值、`timeout 600`、`npx`、`uv run`、`cmd /c`。 */
function unwrap(words: string[]): string[] {
  let tokens = words;
  for (;;) {
    if (!tokens.length) return tokens;
    const program = programOf(tokens[0]);
    if (/^[A-Za-z_][\w]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
      continue;
    }
    if (program === "timeout") {
      let i = 1;
      while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
      tokens = tokens.slice(i + 1);
      continue;
    }
    if (COMMAND_WRAPPERS.has(program)) {
      let i = 1;
      while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
      tokens = tokens.slice(i);
      continue;
    }
    const sub = tokens[1]?.toLowerCase();
    if (["uv", "poetry", "pipenv", "pnpm", "yarn", "pdm", "hatch", "rye"].includes(program) && (sub === "run" || sub === "exec" || sub === "dlx")) {
      let i = 2;
      while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
      tokens = tokens.slice(i);
      continue;
    }
    if (program === "cmd" && sub === "/c") {
      tokens = tokens.slice(2);
      continue;
    }
    return tokens;
  }
}

/** `/c/Python/python.exe` → `python`。 */
function programOf(token: string): string {
  return baseName(token).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
}

/**
 * 这次调用是不是「用 shell 操作了浏览器」。
 *
 * 看得到源码就以源码为准：被跑的脚本得是这一轮写过 / 读过的，而且在驱动浏览器 —— 否则
 * `node build.mjs` 也会被当成浏览器操作。脚本可以是完整的 playwright 脚本，也可以是交给项目
 * 执行器跑的片段（`bash e2e.sh W TC-01.py`，D327）。看不到脚本时，再看命令本身：跑测试、
 * 连 CDP、起浏览器、浏览器命令行、内联驱动代码，最后是用户配的命令关键词。
 */
function scriptedCall(item: ToolItem, scripts: Map<string, ScriptSource>, keywords: readonly string[]): Scripted | null {
  if (!SHELL_TOOLS.has(lastSegment(item.name).toLowerCase())) return null;
  const command = commandOf(item);
  const runs = shellRuns(command);

  // 解释器直接跑的脚本要像个浏览器脚本；作为参数交给执行器的片段，用了一处 page API 就算。
  const entries: { ref: string; source: ScriptSource | null }[] = [];
  for (const ref of runs.direct) {
    const source = findScript([ref], scripts);
    if (source && (drivesBrowser(source.content, 2) || importsBrowserScript(source.content, scripts))) entries.push({ ref, source });
  }
  for (const ref of runs.args) {
    const source = findScript([ref], scripts);
    if (!source || drivesBrowser(source.content, 1)) entries.push({ ref, source });
  }
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = entry.source?.path ?? entry.ref;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.some((entry) => entry.source)) return scriptsCard(unique);

  // D328：脚本照约定打印了 `::browser …`，就算 —— 命令怎么写都行。
  if (MARKER_LINE.test(outputOf(item))) {
    const names = [...runs.direct, ...runs.args].map(baseName);
    const target = names[0] ?? collapse(withoutHeredocBodies(command)).slice(0, 80);
    return { script: names.length ? [...new Set(names)].join(", ") : null, steps: target ? [{ kind: "run", target }] : [], headed: null };
  }

  // 源码看不全（启动器 import 了没读过的执行器、片段是用 python / sed 改出来的）时，看它跑出来的东西：
  // 跑了脚本、输出里至少两条动作 / 断言，而且有浏览器的痕迹（存了截图 / 录像、提到浏览器）。
  if (runs.direct.length && reportsBrowserRun(outputOf(item))) {
    const names = [...runs.direct, ...runs.args].map(baseName);
    return { script: [...new Set(names)].join(", "), steps: names.map((name) => ({ kind: "run" as const, target: name })), headed: null };
  }

  // 只看命令本身，不看 heredoc 正文：提交说明、DECISIONS.md 里写到 `--remote-debugging-port` 不等于在起浏览器。
  const bare = withoutHeredocBodies(command);
  const runner = runnerOf(bare);
  if (runner) return { script: null, steps: [{ kind: "run", target: runner }], headed: null };
  const port = CDP_ENDPOINT.exec(bare)?.[1];
  if (port) return { script: null, steps: [{ kind: "cdp", target: `127.0.0.1:${port}` }], headed: null };
  const launch = launchOf(bare);
  if (launch) return { script: null, steps: [{ kind: "launch", target: launch }], headed: launch === "headed" };

  const cli = runs.clis.filter((args) => !isCliAdmin(args)).flatMap((args) => agentBrowserSteps(args).steps);
  if (cli.length) return { script: null, steps: mergeRepeats(cli).slice(0, MAX_STEPS), headed: null };

  // 看不到脚本时只认「命令里直接跑一段驱动代码」（`node -e "…playwright…"`、`python - <<EOF`）。
  // 不能只要命令里出现 playwright 就算 —— `npx playwright --version`、`npm i playwright`、
  // `grep -i playwright` 都会命中，一张面板就成噪音了（真实会话里一次就多出 12 张）。
  if (runs.inline.length && inlineDrives(command, runs.inline)) {
    const headed = headedOfScript(command);
    const steps = parseScriptSteps(command, headed);
    const raw = collapse(command).slice(0, 80);
    return { script: null, steps: steps.length || !raw ? steps : [{ kind: "raw", target: raw }], headed };
  }

  const lower = withoutHeredocBodies(command).toLowerCase();
  const keyword = keywords.find((word) => lower.includes(word));
  if (keyword) {
    const hit = simpleCommands(command).find((words) => words.join(" ").toLowerCase().includes(keyword));
    const target = collapse((hit ?? [keyword]).join(" ")).slice(0, 80);
    return { script: null, steps: [{ kind: "run", target }], headed: null };
  }
  return null;
}

/** 一次跑了几份脚本：只有一份就直接拆它；好几份就每份前面插一步「运行 x」。看不到源码的只留这一步。 */
function scriptsCard(entries: { ref: string; source: ScriptSource | null }[]): Scripted {
  const names = entries.map((entry) => entry.source?.base ?? baseName(entry.ref));
  const sources = entries.flatMap((entry) => (entry.source ? [entry.source.content] : []));
  const headed = sources.map(headedOfScript).find((value) => value !== null) ?? null;
  if (entries.length === 1 && entries[0].source) {
    const steps = parseScriptSteps(entries[0].source.content, headed);
    return { script: names[0], steps: steps.length ? steps : [{ kind: "run", target: names[0] }], headed };
  }
  const steps = entries.flatMap((entry, index): BrowserOpStep[] => [
    { kind: "run", target: names[index] },
    ...(entry.source ? parseScriptSteps(entry.source.content, headed) : []),
  ]);
  return { script: names.join(", "), steps: steps.slice(0, MAX_STEPS), headed };
}

/**
 * 源码是不是在驱动浏览器：点名了驱动库，或者用了足够多种 page API。
 * 交给执行器的片段不写 import，`minApi` 给 1；解释器直接跑的脚本给 2，免得偶然一个 `.goto(` 就算。
 */
function drivesBrowser(text: string, minApi: number): boolean {
  // 自己起浏览器、直接说 CDP（不引 playwright 的脚本）也算。
  if (mentionsDriver(text) || launchOf(text) || CDP_ENDPOINT.test(text) || CDP_METHOD.test(text)) return true;
  let hits = 0;
  for (const pattern of PAGE_API) {
    if (pattern.test(text)) hits += 1;
    if (hits >= minApi) return true;
  }
  return false;
}

function inlineDrives(command: string, programs: string[]): boolean {
  const python = programs.some((program) => program.startsWith("py"));
  // `python - <<EOF` 里读文件、`replace`、再写回去：是在改脚本，内容里的 playwright 调用只是被替换的文字。
  const editing = /\.replace\s*\(/.test(command) && /\.write(?:_text)?\s*\(/.test(command);
  if (python && !editing && PY_DRIVER_CALL.test(command)) return true;
  return programs.some((program) => !program.startsWith("py")) && (mentionsDriver(command) || DRIVER_CALL.test(command));
}

function isCliAdmin(args: string[]): boolean {
  const verbs = args.filter((arg) => !arg.startsWith("-"));
  if (!verbs.length) return true;
  if (args.some((arg) => /^(?:--version|-v|-V|--help|-h)$/.test(arg))) return true;
  return CLI_ADMIN.has(verbs[0].toLowerCase());
}

/** agent-browser 的命令：动作类型 + 至少几个参数（串联时靠它切开 `fill @e3 open click @e4`）。 */
const AB_COMMANDS: Record<string, { kind: BrowserOpStepKind; min: number }> = {
  open: { kind: "nav", min: 1 },
  goto: { kind: "nav", min: 1 },
  navigate: { kind: "nav", min: 1 },
  back: { kind: "nav", min: 0 },
  forward: { kind: "nav", min: 0 },
  reload: { kind: "nav", min: 0 },
  click: { kind: "click", min: 1 },
  dblclick: { kind: "click", min: 1 },
  hover: { kind: "click", min: 1 },
  check: { kind: "click", min: 1 },
  uncheck: { kind: "click", min: 1 },
  focus: { kind: "click", min: 1 },
  drag: { kind: "click", min: 2 },
  fill: { kind: "input", min: 2 },
  type: { kind: "input", min: 2 },
  select: { kind: "input", min: 2 },
  upload: { kind: "input", min: 2 },
  press: { kind: "input", min: 1 },
  key: { kind: "input", min: 1 },
  keyboard: { kind: "input", min: 1 },
  eval: { kind: "js", min: 1 },
  wait: { kind: "wait", min: 0 },
  snapshot: { kind: "read", min: 0 },
  get: { kind: "read", min: 1 },
  is: { kind: "read", min: 1 },
  find: { kind: "read", min: 1 },
  console: { kind: "read", min: 0 },
  errors: { kind: "read", min: 0 },
  screenshot: { kind: "shot", min: 0 },
  pdf: { kind: "shot", min: 0 },
  scroll: { kind: "scroll", min: 0 },
  scrollintoview: { kind: "scroll", min: 1 },
  tab: { kind: "tab", min: 0 },
  close: { kind: "tab", min: 0 },
  set: { kind: "call", min: 1 },
  batch: { kind: "call", min: 0 },
};

/** agent-browser 带一个值的全局开关。 */
const AB_VALUE_FLAGS = new Set([
  "--session",
  "--session-name",
  "--profile",
  "--cdp",
  "--state",
  "--provider",
  "--device",
  "--executable-path",
  "--user-agent",
  "--proxy",
  "--port",
  "--timeout",
  "--load",
  "--config",
  "--headers",
  "--extension",
  "--args",
]);

/**
 * 一串 agent-browser 参数拆成步骤。它允许一次串好几条命令：当前命令的参数够数了，
 * 下一个认得的命令词才开新的一条 —— 所以 `fill @e3 open` 里的 `open` 是要填的字，不是打开。
 */
function agentBrowserSteps(tokens: readonly unknown[]): { steps: BrowserOpStep[]; headed: boolean | null } {
  let headed: boolean | null = null;
  const commands: { name: string; args: string[] }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i]);
    if (token === "--headed") {
      headed = true;
      continue;
    }
    if (token === "--headless") {
      headed = false;
      continue;
    }
    if (token.startsWith("--") || /^-[a-zA-Z]$/.test(token)) {
      if (AB_VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    const current = commands.at(-1);
    const name = token.toLowerCase();
    const full = !current || current.args.length >= (AB_COMMANDS[current.name]?.min ?? 0);
    if (!current || (AB_COMMANDS[name] && full)) {
      commands.push({ name, args: [] });
      continue;
    }
    current.args.push(token);
  }
  return { steps: commands.map(agentBrowserStep), headed };
}

function agentBrowserStep(command: { name: string; args: string[] }): BrowserOpStep {
  const def = AB_COMMANDS[command.name];
  const [first, second] = command.args;
  const short = (text: string | undefined, max: number) => (text ? collapse(text).slice(0, max) : undefined);
  if (!def || def.kind === "call") return { kind: "call", name: command.name, target: short(command.args.join(" "), 60) || undefined };
  switch (def.kind) {
    case "nav":
    case "click":
      return { kind: def.kind, target: short(first, 80) };
    case "input":
      return def.min >= 2 && command.args.length >= 2
        ? { kind: "input", target: short(second, 60), name: short(first, 40) }
        : { kind: "input", target: short(first, 60) };
    case "js":
      return { kind: "js", target: short(command.args.join(" "), 80) };
    case "wait":
      if (first && /^\d+$/.test(first)) return { kind: "wait", target: `${first}ms` };
      return { kind: "wait", name: short(first, 40) };
    default:
      return { kind: def.kind };
  }
}

/**
 * pi-agent-browser 扩展的调用：`agent_browser({ args: ["open", url] })`、`batch` + stdin 里的命令数组、
 * `agent_browser_code` 的 code 里 `browser({ args: [...] })`。参数形状和 MCP 工具完全不同，单独拆。
 */
function agentBrowserCall(item: ToolItem): Scripted | null {
  if (!item.args || typeof item.args !== "object") return null;
  const outer = item.args as Record<string, unknown>;
  const inner = gatewayTool(item.name, item.args);
  if (!/agent[_-]?browser/i.test(inner ?? item.name)) return null;
  const bag = inner && outer.args && typeof outer.args === "object" ? (outer.args as Record<string, unknown>) : outer;
  const steps: BrowserOpStep[] = [];
  let headed: boolean | null = null;
  if (Array.isArray(bag.args)) {
    const parsed = agentBrowserSteps(bag.args);
    headed = parsed.headed;
    const batch = parsed.steps.length === 1 && parsed.steps[0].name === "batch";
    const lines = batch && typeof bag.stdin === "string" ? batchCommands(bag.stdin) : null;
    if (lines) for (const line of lines) steps.push(...agentBrowserSteps(line).steps);
    else steps.push(...parsed.steps);
  }
  const code = typeof bag.code === "string" ? bag.code : typeof bag.script === "string" ? bag.script : "";
  for (const match of code.matchAll(/\bbrowser\s*\(\s*\{\s*args\s*:\s*(\[[^\]]*\])/g)) {
    const list = jsonArray(match[1]);
    if (list) steps.push(...agentBrowserSteps(list).steps);
  }
  if (!steps.length) return null;
  return { script: null, steps: mergeRepeats(steps).slice(0, MAX_STEPS), headed };
}

/** batch 的 stdin：`[["open", url], ["click", "@e1"]]`。 */
function batchCommands(stdin: string): unknown[][] | null {
  const list = jsonArray(stdin);
  return list && list.every(Array.isArray) ? (list as unknown[][]) : null;
}

function jsonArray(text: string): unknown[] | null {
  for (const candidate of [text, text.replace(/'/g, '"')]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch {
      // 不是 JSON（拼了变量的数组）：就拆不出这一条
    }
  }
  return null;
}

/**
 * D328 手动标记：在执行面板上点「这是浏览器操作」时记下的命令关键词 —— 被跑的脚本名；没有脚本就用
 * 程序名（`python` / `git` 这类太泛的不要）。不是 shell 工具、或者挑不出合适的词时返回 null。
 */
export function markKeyword(item: ToolItem): string | null {
  if (!SHELL_TOOLS.has(lastSegment(item.name).toLowerCase())) return null;
  const command = commandOf(item);
  const runs = shellRuns(command);
  const ref = runs.direct[0] ?? runs.args[0];
  if (ref) return baseName(ref).toLowerCase();
  for (const words of simpleCommands(command)) {
    const program = programOf(unwrap(words)[0] ?? "");
    if (program.length > 2 && !INTERPRETERS.has(program) && !GENERIC_PROGRAMS.has(program)) return program;
  }
  return null;
}

const GENERIC_PROGRAMS = new Set([
  "cd", "echo", "printf", "ls", "cat", "grep", "rg", "sed", "awk", "head", "tail", "rm", "mkdir", "cp", "mv", "touch",
  "git", "gh", "npm", "pnpm", "yarn", "set", "export", "sleep", "true", "false", "test", "find", "curl", "wget", "tee", "xargs",
  "sort", "uniq", "wc", "cut", "tr", "date", "which", "where", "type", "pwd", "source", "exit", "wait", "kill", "chmod", "diff",
]);

function commandOf(item: ToolItem): string {
  if (!item.args || typeof item.args !== "object") return "";
  const bag = item.args as Record<string, unknown>;
  const command = bag.command ?? bag.cmd ?? bag.script;
  return typeof command === "string" ? command : "";
}

function runnerOf(command: string): string | null {
  for (const [pattern, label] of RUNNERS) {
    if (pattern.test(command)) return label;
  }
  return null;
}

/** 命令是不是在起一个可供自动化的浏览器（带无头 / 调试端口 / 指定 profile）。 */
function launchOf(command: string): "headed" | "headless" | null {
  if (!BROWSER_BIN.test(command) || !BROWSER_AUTOMATION_FLAG.test(command)) return null;
  return /--headless/.test(command) ? "headless" : "headed";
}

function mentionsDriver(text: string): boolean {
  const lower = text.toLowerCase();
  return DRIVER_HINTS.some((hint) => lower.includes(hint));
}

function findScript(refs: string[], scripts: Map<string, ScriptSource>): ScriptSource | null {
  let best: ScriptSource | null = null;
  for (const ref of refs) {
    const refBase = baseName(ref);
    for (const source of scripts.values()) {
      const hit = source.path === ref || source.path.endsWith(`/${ref}`) || source.base === refBase;
      if (!hit) continue;
      if (!best || source.order > best.order) best = source;
    }
  }
  return best;
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

/**
 * `cp cases/TC-01.py cases_zh/TC-01_zh.py`：源文件已经见过，副本就按同一份源码记下（后来的小改动不跟）。
 * 不记的话，复制一份再跑就认不出是浏览器脚本了。
 */
function copiedScripts(command: string, scripts: Map<string, ScriptSource>): { path: string; base: string; content: string }[] {
  const out: { path: string; base: string; content: string }[] = [];
  if (!command) return out;
  for (const words of simpleCommands(command)) {
    const tokens = unwrap(words);
    if (!COPY_COMMANDS.has(programOf(tokens[0] ?? ""))) continue;
    const paths = tokens.slice(1).filter((token) => !token.startsWith("-"));
    const dest = paths.pop();
    if (!dest) continue;
    for (const from of paths) {
      const source = findScript([from], scripts);
      if (!source) continue;
      const path = normPath(SCRIPT_FILE.test(dest) ? dest : `${dest.replace(/[\\/]+$/, "")}/${source.base}`);
      out.push({ path, base: baseName(path), content: source.content });
    }
  }
  return out;
}

const COPY_COMMANDS = new Set(["cp", "copy", "copy-item", "cpi"]);

/** 启动器脚本：自己不碰浏览器，但 import 了一份见过的、在驱动浏览器的脚本（`import run` → run.py）。 */
function importsBrowserScript(content: string, scripts: Map<string, ScriptSource>): boolean {
  const names = new Set<string>();
  for (const match of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
    names.add((match[1] ?? match[2]).split(".").pop() ?? "");
  }
  for (const match of content.matchAll(/(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    names.add(baseName(match[1]).replace(/\.[cm]?[jt]s$/, ""));
  }
  for (const source of scripts.values()) {
    const stem = source.base.replace(/\.[^.]+$/, "");
    if (names.has(stem) && drivesBrowser(source.content, 2)) return true;
  }
  return false;
}

/** 脚本跑出来的东西像不像一次浏览器操作：至少两条动作 / 断言，并且存了截图录像或提到了浏览器。 */
function reportsBrowserRun(output: string): boolean {
  if (!output) return false;
  const steps = outputSteps(output);
  if (steps.filter((step) => step.kind === "act" || step.kind === "check").length < 2) return false;
  return steps.some((step) => step.kind === "file") || BROWSER_OUTPUT.test(output);
}

const BROWSER_OUTPUT = /\b(?:chrom(?:e|ium)|playwright|puppeteer|selenium|webdriver|headless|devtools|cdp|browser|screenshot)\b/i;

function outputOf(item: ToolItem): string {
  return (item.status === "running" ? item.partialResult ?? item.result : item.result) ?? "";
}

function baseName(path: string): string {
  const parts = normPath(path).split("/");
  return parts[parts.length - 1] || path;
}

function isRunning(card: BrowserOpCard): boolean {
  return card.state === "running" || card.state === "slow" || card.state === "stuck";
}

/** 打转的另一种样子：模型连着几次调同一个浏览器工具、做同一件事（例如反复 snapshot 同一页）。 */
function repeatsPrevious(next: BrowserOpCard, cards: BrowserOpCard[], loopCount: number): boolean {
  const need = loopCount - 1;
  if (need < 1 || cards.length < need) return false;
  const sig = (card: BrowserOpCard) => `${card.tool} ${JSON.stringify(card.steps)}`;
  return cards.slice(-need).every((prev) => prev.stepSource === "call" && sig(prev) === sig(next));
}

function card(
  item: ToolItem,
  intent: string,
  thresholds: BrowserOpsThresholds,
  now: number,
  subagent: string | null,
  lastOutputAt: number | undefined,
  scripted: { script: string | null; steps: BrowserOpStep[]; headed: boolean | null } | null = null,
  label: string = item.name,
  direct = true,
): BrowserOpCard {
  const startedAt = item.ts ? Date.parse(item.ts) : now;
  const running = item.status === "running";
  const measured = running ? Math.max(0, now - startedAt) : item.durationMs ?? null;
  const output = (running ? item.partialResult ?? item.result : item.result) ?? "";
  // shell 跑的脚本：脚本自己在输出里报了做了什么，就以输出为准；输出里认不出东西（还没开跑、执行器不报）才用源码猜的。
  const reported = direct ? [] : outputSteps(output);
  const fromOutput = reported.some((step) => step.kind !== "run");
  const steps = fromOutput ? reported : scripted ? scripted.steps : parseSteps(item.args, item.name);
  const silentFor = lastOutputAt === undefined ? null : Math.max(0, now - lastOutputAt);
  return {
    toolCallId: item.toolCallId,
    tool: label,
    script: scripted?.script ?? null,
    subagent,
    startedAt: Number.isFinite(startedAt) ? startedAt : now,
    durationMs: measured,
    state: stateOf(item, measured ?? 0, thresholds),
    silent: running && silentFor !== null && silentFor >= thresholds.silentMs,
    silentFor,
    looping: running && fromOutput && steps.some((step) => (step.repeat ?? 1) >= thresholds.loopCount),
    stepSource: fromOutput ? "output" : direct ? "call" : "script",
    intent: intent.slice(0, 280),
    steps,
    output,
    headed: scripted ? scripted.headed : headedOf(item),
  };
}

/** 最多拆多少步：一次 `browser_exec` 里塞几十行很常见，再多也读不完。 */
export const MAX_STEPS = 40;

/** 从运行输出里最多留多少步：跑着的时候最新的最要紧，所以超了丢最前面的。 */
export const MAX_OUTPUT_STEPS = 80;

/**
 * 脚本运行输出里认得出的行，变成步骤：执行器自己报的动作（`step 手順1：…`）、断言（`OK …` / `NG …` / `✓` / `not ok`）、
 * 读到的值（`data: k = v`、`db: …`）、旁白（`note: …`）、存下的截图和录像、`=== 文件名` 段头。
 * 一行都认不出就是空数组，调用方回到源码去猜。
 */
export function outputSteps(output: string): BrowserOpStep[] {
  const steps: BrowserOpStep[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉终端颜色码
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const step = outputStep(raw.trim());
    if (step) steps.push(step);
  }
  return mergeRepeats(steps).slice(-MAX_OUTPUT_STEPS);
}

const OUT_HEADER = /^={2,}\s*(.+?)\s*=*$/;
const OUT_ACT = /^(?:\[(?:step|action)\]|(?:step|action)\s*[:：]?|>>|▶|►)\s*(.+)$/i;
const OUT_ACT_CJK = /^((?:手順|ステップ|步骤|操作)\s*\d*\s*[:：].+)$/;
const OUT_PASS = /^(?:\[?(?:OK|PASS(?:ED)?)\]?|ok\s+\d+(?:\s+-)?|✓|✔|√)\s*[:：]?\s+(.+)$/;
const OUT_FAIL = /^(?:\[?(?:NG|FAIL(?:ED)?|ERROR)\]?|not ok\s+\d+(?:\s+-)?|✗|✘|✖|×)\s*[:：]?\s+(.+)$/;
const OUT_VERDICT = /^=>\s*(OK|PASS(?:ED)?|NG|FAIL(?:ED)?|ERROR)\b\s*(.*)$/i;
const OUT_VALUE = /^(?:data|db|value|read|got)\s*[:：]\s*(.+)$/i;
const OUT_NOTE = /^(?:note|info)\s*[:：]\s*(.+)$/i;
const OUT_FILE = /^(?:video|shot|screenshot|saved?|wrote|录像|截图)\s*[:：]?\s+(\S.*\.(?:png|jpe?g|webp|gif|mp4|webm|pdf))$/i;

function outputStep(line: string): BrowserOpStep | null {
  if (!line) return null;
  const marker = MARKER.exec(line);
  if (marker) return markerStep((marker[1] ?? "").toLowerCase(), marker[2]?.trim() ?? "");
  const header = OUT_HEADER.exec(line);
  if (header) return /^(?:summary|results?|total)$/i.test(header[1]) ? null : { kind: "run", target: clip(header[1]) };
  const verdict = OUT_VERDICT.exec(line);
  if (verdict) return { kind: "check", ok: /^(?:OK|PASS)/i.test(verdict[1]), target: clip(verdict[2] || verdict[1]) };
  const act = OUT_ACT.exec(line) ?? OUT_ACT_CJK.exec(line);
  if (act) return { kind: "act", target: clip(act[1]) };
  const pass = OUT_PASS.exec(line);
  if (pass) return checkStep(true, pass[1]);
  const fail = OUT_FAIL.exec(line);
  if (fail) return checkStep(false, fail[1]);
  const value = OUT_VALUE.exec(line);
  if (value) return { kind: "value", target: clip(value[1]) };
  const note = OUT_NOTE.exec(line);
  if (note) return { kind: "print", target: clip(note[1]) };
  const file = OUT_FILE.exec(line);
  return file ? { kind: "file", target: file[1] } : null;
}

/**
 * D328 输出约定：脚本自己打印 `::browser <动作> <说明>`，面板逐行照抄。只要输出里有一行，这次调用就算浏览器操作，
 * 不管命令怎么写。动作：act/step、ok/pass、ng/fail、nav/open、click、fill/input、wait、shot/video/file、value、note、launch。
 * 不认识的动作连同说明一起当一步。
 */
export const MARKER = /^::browser(?:\s+(\S+))?(?:\s+(.*))?$/i;
const MARKER_LINE = /^\s*::browser(?:\s|$)/m;

function markerStep(verb: string, text: string): BrowserOpStep | null {
  switch (verb) {
    case "":
      return null;
    case "act":
    case "step":
      return { kind: "act", target: clip(text) };
    case "ok":
    case "pass":
      return checkStep(true, text);
    case "ng":
    case "fail":
      return checkStep(false, text);
    case "nav":
    case "open":
    case "goto":
      return { kind: "nav", target: clip(text, 80) };
    case "click":
      return { kind: "click", target: clip(text, 80) };
    case "fill":
    case "input":
    case "type":
      return { kind: "input", target: clip(text, 80) };
    case "wait":
      return { kind: "wait", target: clip(text, 40) || undefined };
    case "shot":
    case "screenshot":
    case "video":
    case "file":
      return { kind: "file", target: text };
    case "value":
    case "data":
      return { kind: "value", target: clip(text) };
    case "note":
      return { kind: "print", target: clip(text) };
    case "launch":
      return { kind: "launch", target: /headless/i.test(text) ? "headless" : /headed/i.test(text) ? "headed" : undefined };
    default:
      return { kind: "act", target: clip(`${verb} ${text}`) };
  }
}

/** 断言行：标题留下；没过的把 `actual=… expected=…` 也带上，过了的就不占地方。 */
function checkStep(ok: boolean, text: string): BrowserOpStep {
  const cut = /\s{2,}(?=actual\s*=|expected\s*=|got\s*=)/i.exec(text);
  const label = cut ? text.slice(0, cut.index) : text;
  const detail = cut ? collapse(text.slice(cut.index)) : "";
  return ok || !detail ? { kind: "check", ok, target: clip(label) } : { kind: "check", ok, target: clip(label), name: clip(detail) };
}

function clip(text: string, max = 160): string {
  const flat = collapse(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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

/** 脚本里当操作读的 Playwright 调用（长的写在前面，否则 `waitFor` 会先吃掉 `waitForTimeout`）。 */
const SCRIPT_ACTION =
  /\.(launchPersistentContext|launch_persistent_context|launch|goto|goBack|go_back|reload|fill|type|press|selectOption|select_option|click|dblclick|hover|check|setChecked|set_checked|waitForTimeout|wait_for_timeout|waitForLoadState|wait_for_load_state|waitForSelector|wait_for_selector|waitForURL|wait_for_url|waitFor|wait_for|screenshot|title|url|content|innerText|inner_text|textContent|text_content|inputValue|input_value|evaluate|newPage|new_page|newContext|new_context|connectOverCDP|connect_over_cdp)\s*\(/g;

/** python 的蛇形名对到 JS 的驼峰名：同一个 API，后面只认一种。 */
const SNAKE_ACTION: Record<string, string> = {
  launch_persistent_context: "launchPersistentContext",
  go_back: "goBack",
  select_option: "selectOption",
  set_checked: "setChecked",
  wait_for_timeout: "waitForTimeout",
  wait_for_load_state: "waitForLoadState",
  wait_for_selector: "waitForSelector",
  wait_for_url: "waitForURL",
  wait_for: "waitFor",
  inner_text: "innerText",
  text_content: "textContent",
  input_value: "inputValue",
  new_page: "newPage",
  new_context: "newContext",
  connect_over_cdp: "connectOverCDP",
};

const SCRIPT_KIND: Record<string, BrowserOpStepKind> = {
  connectOverCDP: "cdp",
  goto: "nav",
  goBack: "nav",
  reload: "nav",
  launch: "launch",
  launchPersistentContext: "launch",
  fill: "input",
  type: "input",
  press: "input",
  selectOption: "input",
  click: "click",
  dblclick: "click",
  hover: "click",
  check: "click",
  setChecked: "click",
  waitForTimeout: "wait",
  waitForLoadState: "wait",
  waitForSelector: "wait",
  waitForURL: "wait",
  waitFor: "wait",
  screenshot: "shot",
  title: "read",
  url: "read",
  content: "read",
  innerText: "read",
  textContent: "read",
  inputValue: "read",
  evaluate: "read",
  newPage: "tab",
  newContext: "tab",
};

/** `waitForLoadState('domcontentloaded')` 这种状态词不往界面上搬，反正都是等。 */
const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);

/**
 * 从一份 playwright 脚本源码里按出现顺序拆出操作。
 *
 * 这是块文本扫描：不执行、不解析 AST。变量绑定只跟一层（`const input = page.locator('#kw')`），
 * 所以 `input.fill('x')` 能说出它在哪个选择器上输入；再深一层就只剩动作本身。
 */
function parseScriptSteps(source: string, headed: boolean | null): BrowserOpStep[] {
  const steps: BrowserOpStep[] = [];
  const selectors = new Map<string, string>();
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith("#")) continue;
    const bind = /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line);
    if (bind) {
      const selector = selectorIn(bind[2]);
      if (selector) selectors.set(bind[1], selector);
    }
    const log = /^(?:console\.log|print)\s*\(\s*f?(['"`])([\s\S]*?)\1/.exec(line);
    if (log) steps.push({ kind: "print", target: collapse(log[2]).slice(0, 80) });
    // 自家执行器的旁白函数（`step('手順1：…')`、`test.step('…')`）：真动作多半封装在帮手函数里，这句话才说得清在做什么。
    const narrate = /^(?:await\s+)?(?:test\.)?(?:step|narrate|section|describe)\s*\(\s*f?(['"`])([\s\S]*?)\1/.exec(line);
    if (narrate) steps.push({ kind: "act", target: collapse(narrate[2]).slice(0, 120) });
    for (const match of line.matchAll(SCRIPT_ACTION)) {
      const action = SNAKE_ACTION[match[1]] ?? match[1];
      const kind = SCRIPT_KIND[action];
      if (!kind) continue;
      const start = match.index ?? 0;
      const argsRaw = argsAt(line, start + match[0].length - 1);
      const before = line.slice(0, start);
      const selector = selectors.get(receiverOf(before)) ?? selectorIn(before) ?? "";
      const step = scriptStep(action, kind, argsRaw, selector, headed);
      if (step) steps.push(step);
    }
  }
  return mergeRepeats(steps).slice(0, MAX_STEPS);
}

function scriptStep(
  action: string,
  kind: BrowserOpStepKind,
  argsRaw: string,
  selector: string,
  headed: boolean | null,
): BrowserOpStep | null {
  const literal = firstString(argsRaw);
  switch (kind) {
    case "nav":
    case "cdp":
      return { kind, target: literal ? collapse(literal).slice(0, 80) : undefined };
    case "launch":
      return { kind, target: headed === null ? undefined : headed ? "headed" : "headless" };
    case "tab":
      return { kind };
    case "input":
      return {
        kind,
        target: literal ? collapse(literal).slice(0, 60) : undefined,
        name: selector ? collapse(selector).slice(0, 40) : undefined,
      };
    case "click":
      return { kind, target: selector.trim() || (literal ? collapse(literal).slice(0, 40) : undefined) };
    case "wait": {
      const ms = /^\s*(\d+)\s*,?\s*$/.exec(argsRaw);
      if (action === "waitForTimeout" && ms) return { kind, target: `${ms[1]}ms` };
      // `waitFor({ state: 'visible' })` 的重点是等哪个元素，不是那个状态词。
      if (action === "waitFor" || action === "waitForSelector") {
        return { kind, name: selector ? collapse(selector).slice(0, 40) : undefined };
      }
      const named = literal ? collapse(literal).slice(0, 40) : "";
      return { kind, target: named && !LOAD_STATES.has(named) ? named : undefined };
    }
    case "print":
      return { kind, target: literal ? collapse(literal).slice(0, 80) : undefined };
    case "shot":
    case "read":
      return { kind };
    default:
      return { kind };
  }
}

/** 这一行往前的最后一个标识符：`input.click()` 的 `input`。 */
function receiverOf(before: string): string {
  const match = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
  return match ? match[1] : "";
}

/** 这一行里的选择器：`locator('#kw')` / `waitForSelector('#kw')` / `$('#kw')`。 */
function selectorIn(text: string): string {
  const role = /(?:get_by_|getBy)\w+\(\s*(['"`])([^'"`]+)\1(?:\s*,\s*\{?\s*name\s*[=:]\s*(['"`])([^'"`]+)\3)?/.exec(text);
  if (role) return collapse(role[4] ? `${role[2]} "${role[4]}"` : role[2]).slice(0, 60);
  const match = /(?:locator|waitForSelector|wait_for_selector|querySelector|query_selector|\$)\(\s*(['"`])([^'"`]+)\1/.exec(text);
  return match ? collapse(match[2]).slice(0, 60) : "";
}

/**
 * 脚本是有头还是无头。`headless: false` 最直接；没写的话，`launch()` 默认无头、
 * `launchPersistentContext()` 默认有头（Playwright 自己的默认，不是猜）。
 */
function headedOfScript(source: string): boolean | null {
  const explicit = /headless\s*[:=]\s*(true|false|True|False)\b/.exec(source);
  if (explicit) return explicit[1].toLowerCase() === "false";
  if (/launchPersistentContext\s*\(|launch_persistent_context\s*\(/.test(source)) return true;
  if (/\.launch\s*\(|chromium\.launch\(/.test(source)) return false;
  return null;
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

/** `browser_click` / `pw_click` / `desktop-touch_browser_click` → `click`：MCP 的裸名常带前缀。 */
function structuredName(name: string): string {
  const scoped = /(?:^|[_\-.])browser[_-](.+)$/i.exec(name);
  if (scoped) return scoped[1];
  return name.replace(/^(page|pw)_/, "");
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

/**
 * 折叠行里代表这次调用的动作：只说「对页面做了什么」——打开哪页、点了什么、输入了什么。
 *
 * 原来只取最后一个动作，而 playwright 脚本几乎都是「读一眼页面」收尾（`page.title()` /
 * `page.evaluate()` / `page.screenshot()`），于是几张脚本卡挤成同一行 `读取页面信息 ×2`，分不出
 * 谁是谁（真实会话里 8 张卡有 7 张）。所以这里按「操作」筛一遍，读页面 / 截图 / 等待 / 启动 /
 * 切标签这些**每支脚本都有的过场**只在没别的可列时兜底出现。
 *
 * 合并放在筛之后做：`page.title()` → `waitForTimeout()` → `page.evaluate()` 被那个 wait 隔开，
 * 中间夹的步被筛掉后会留下相邻的两行「读取页面信息」，那不是两件事。
 */
export function foldedSteps(steps: BrowserOpStep[]): BrowserOpStep[] {
  const ops = steps.filter((step) => FOLDED_OPS.includes(step.kind));
  const fallback = steps.filter((step) => !FOLDED_NOISE.includes(step.kind));
  return mergeRepeats(ops.length ? ops : fallback);
}

/** 折叠行认作「操作」的类型。`launch` / `tab` 不进来：「启动浏览器」「切换标签」每支脚本都写。 */
const FOLDED_OPS: readonly BrowserOpStepKind[] = ["nav", "click", "input", "js", "cdp", "scroll", "run", "call", "raw", "act"];

/** 兜底时也不要的：旁白与等待不是「做了什么」。 */
const FOLDED_NOISE: readonly BrowserOpStepKind[] = ["print", "wait"];

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

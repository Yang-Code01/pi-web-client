import { tr } from "./i18n/index.ts";

/**
 * Failure diagnosis: turn a raw tool failure into "它当时想干什么 / 为什么没成 / 影响是什么".
 *
 * The bridge gives us only `isError` + the tool's text output (`bridge/src/sessions.ts:596-625`):
 * no exit code field, no separate stderr. But pi appends a fixed trailer to every bash result
 * (`Command exited with code N` / `Command aborted`), and the text itself carries the rest.
 *
 * 读者是**人**，执行者是模型：所以这里不再写「下一步该怎么做」（那是给执行者的，而模型看到的是
 * 工具返回的原文，不是这张卡），而是回答两件人想知道的事——它为什么去调这一条（`intent`，优先取
 * 模型调用前说的那句话），以及这次失败动了什么、没动什么（`effect`）。`needsYou` 只在确实要人
 * 动手时才出现（代理、登录、批准）。
 *
 * Deliberately rule-based, not model-based: it has to run while the session is offline and answer
 * in one frame. Rules live here only — the DOM that draws them lives in `chat.ts`.
 */

export type Level = "fail" | "warn" | "benign" | "abort";

export interface FailureInput {
  /** Tool name as pi reported it (`bash`, `edit`, `read`, …). */
  tool: string;
  /** One-line argument summary (the command, the file path, …). */
  cmd: string;
  /** Raw result text, trailer included. */
  out: string;
  /**
   * 模型调这个工具之前自己说的那句话（`chat.ts` 从上一条 assistant 条目取）。空 = 没有原话，
   * 由 `inferIntent` 按工具名和参数粗推断——宁可粗一点，也别让「为什么」那一行空着。
   */
  intent?: string;
  /**
   * 这一轮里它后来怎么绕过去的（`chat.ts` 在同一轮后续工具跑通时填）：只写事实，不猜结果。
   * 例：「随后它改用 web_search，拿到了结果」。没有后续就不出现。
   */
  after?: string;
}

export interface Diagnosis {
  level: Level;
  /** 一句人话：这次发生了什么（卡片标题）。 */
  title: string;
  /** AI 想做什么：模型的原话（截断），没说话时是规则推断——不用用户的话冒充。 */
  intent: string;
  /** 为什么没成——不是复述错误码，而是它踩到了什么。 */
  cause: string;
  /** 影响：文件动没动、内容缺没缺、命令跑没跑起来。 */
  effect: string;
  /** 只有真需要人动手时才有（代理、登录、批准…）；没有就是纯 A 能自理的失败。 */
  needsYou?: string;
  /** 可复用的修法（人机通用一句话）：下次怎么不再犯；没有就不显示。 */
  improve?: string;
  /** Exit code parsed out of the trailer, or null when there is none. */
  exit: number | null;
  /** Output with ANSI stripped and the trailer removed. */
  body: string;
}

export interface Excerpt {
  /** All lines of the raw output, trailer included. */
  lines: string[];
  /** Line indexes to show, in order, flagged when they are the reason the diagnosis fired. */
  keep: Array<[number, boolean]>;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const TRAILER = /^\s*Command (?:exited with code \d+|aborted)\s*$/;
const TRAILER_TAIL = /\n*Command (?:exited with code \d+|aborted)\s*$/;

export const LEVEL_LABEL: Record<Level, string> = {
  fail: tr("失败"),
  warn: tr("可疑"),
  benign: tr("多半正常"),
  abort: tr("已中断"),
};

export function normalize(out: unknown): string {
  return String(out ?? "")
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n");
}

function exitCodeOf(out: string): number | null {
  const m = /Command exited with code (\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

function lastMatch(re: RegExp, text: string): string {
  let hit = "";
  for (const line of text.split("\n")) {
    if (re.test(line.trim())) hit = line.trim();
  }
  return hit;
}

/** 一句话压成一行并截断：原话常常是整段推理，卡片上只放得下一行。 */
function clip(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * 没有模型原话时的意图推断：只看工具名 + 参数 + 输出。粗糙是对的——它只是「AI 想做什么」那一行的
 * 兜底，有原话时永远用原话。
 */
function inferIntent(tool: string, cmd: string, out: string): string {
  const c = cmd ?? "";
  if (tool === "bash" || tool === "bash_run") {
    // 网络优先：`for u in …; do curl … | head -c 400; done` 里的 head 是管道，不是「找东西」。
    const urls = c.match(/https?:\/\//g)?.length ?? 0;
    if (/\b(curl|wget|Invoke-WebRequest|nc)\b/i.test(c) || urls > 0) {
      return urls > 1 ? tr("它想挨个抓这几个网页") : tr("它想抓这个网页的内容");
    }
    if (/\bdate\b|\btime\b/i.test(c)) return tr("它想拿当前日期 / 时间");
    if (/\bgit\b/.test(c)) return tr("它想看仓库状态 / 改了哪些文件");
    if (/\b(npm|pnpm|yarn|mvn|gradle|cargo|go|make|dotnet|python|node|javac)\b/.test(c)) return tr("它想跑构建、测试或脚本");
    // 只认「找东西」的主干命令：head / tail / cat / sed 常常只是管道的一部分。
    if (/\b(rg|grep|ag|ack|fd|find)\b/.test(c)) return tr("它想在文件里搜东西");
    if (/^\s*(ls|dir|tree|stat|wc)\b/.test(c)) return tr("它想看一眼目录里有什么");
    return tr("它想跑一条命令");
  }
  if (tool === "read") return tr("它想读这个文件");
  if (tool === "read_symbol" || tool === "read_enclosing") return tr("它想读这段代码的实现");
  if (tool === "edit") return tr("它想改这个文件");
  if (tool === "write") return tr("它想写这个文件");
  if (tool === "fetch_content") return tr("它想抓这个网页的内容");
  if (tool === "web_search") return tr("它想搜资料");
  if (tool === "bg_run") return tr("它想在后台跑一条命令");
  if (tool === "ask_user_question" || tool === "question" || tool === "questionnaire") return tr("它想问你一件事");
  if (tool === "lens_diagnostics") return tr("它想跑语言检查");
  if (tool === "peer_send" || tool === "peer_find") return tr("它想在内网通里找人");
  void out;
  return tr("它在用 {p1} 做一步操作", { p1: tool });
}

const PY_CAUSE: Record<string, string> = {
  UnicodeDecodeError: tr("按默认编码（本机 GBK）读了 UTF-8 / 二进制文件"),
  UnicodeEncodeError: tr("按 GBK 编码写出，但内容里有无 GBK 字符"),
  ModuleNotFoundError: tr("依赖没装，或跑在了别的 Python 环境里"),
  FileNotFoundError: tr("路径不存在（相对路径的 cwd 可能不是你以为的那个）"),
  AssertionError: tr("断言失败：程序跑到这行时假设不成立"),
  ParserError: tr("解析失败：输入格式不对，或流式数据被截断"),
  SyntaxError: tr("语法错误：转义写坏了，或多/少了括号"),
  TypeError: tr("类型不对：参数个数或类型不匹配"),
  AttributeError: tr("对象没有这个属性，多半是接口变了或返回了 null"),
  NameError: tr("变量没定义（笔误，或该在的作用域里没有）"),
  KeyError: tr("字典里没这个键，输入结构跟预期不符"),
};

const PY_FIX: Record<string, string> = {
  UnicodeDecodeError: tr("读文件时显式写 encoding='utf-8'，别用系统默认代码页"),
  UnicodeEncodeError: tr("print 中文前设 PYTHONIOENCODING=utf-8（或 python -X utf8）"),
  ModuleNotFoundError: tr("用项目的 venv，或先把依赖装上"),
  FileNotFoundError: tr("用绝对路径，或先 cd 到项目根"),
};

/** [match, 一句人话, 为什么没成, 影响, 可复用修法] — errno families worth naming. */
const ERRNO: Array<[RegExp, string, string, string, string]> = [
  [/ENOENT|No such file or directory/, tr("找不到文件 / 目录"), tr("这个路径不存在"), tr("命令没跑起来，文件一个没动"), tr("用绝对路径，或先确认 cwd")],
  [/EACCES|Permission denied/, tr("没有权限读写"), tr("权限不足，被系统挡住了"), tr("没读到 / 没写进去"), tr("换可写目录，或改文件权限")],
  [/EADDRINUSE|address already in use/i, tr("端口被占用"), tr("要绑的端口已经有人在用了"), tr("新服务没起来，旧的可能还占着端口"), tr("先停掉占端口的进程，或换个端口")],
  [/ECONNREFUSED|Connection refused/, tr("对方端口没开"), tr("连得到主机，但那个端口没服务在听"), tr("没连上，没拿到结果"), tr("确认服务起来了、端口对不对")],
  [/ETIMEDOUT|timed out/i, tr("等到超时"), tr("等太久没有响应，多半是卡住了"), tr("没拿到结果"), tr("拆小重试，或给它加超时")],
];

/** [match, 为什么没成, 影响, 可复用修法] */
const GIT_CAUSE: Array<[RegExp, string, string, string]> = [
  [/not a git repository/i, tr("当前目录不在 git 仓库里（cwd 不对）"), tr("仓库没变"), tr("cd 到仓库根目录再跑")],
  [/would be overwritten by merge/i, tr("工作区有未提交的改动挡着"), tr("工作区没动"), tr("先 commit 或 stash，再 pull")],
  [/has no upstream branch/i, tr("分支还没有上游"), tr("本地提交没推出去"), tr("git push -u origin <分支名>")],
  [/did not match any file/i, tr("路径 / 分支名写错了"), tr("仓库没变"), tr("核对名字，或 git ls-files 看一眼")],
];

/**
 * pi-lens 的编辑守卫：`🔄 RETRYABLE — <抬头>` / `⛔ RE-READ REQUIRED` / `✅ ALREADY APPLIED`。
 *
 * 这些都不是环境坏了，而是「工具没动手，按规矩重来」——所以一律算 `benign`（灰卡片）。
 * 抬头有十来种，原文是英文夹着文件路径，直接摊给用户等于没翻译，这里一句一种说法。
 * 注意 emoji 前缀不可省：`RETRYABLE` 这个词在同一份输出里也用来描述 HTTP 重试。
 */
const GUARD_HEAD = /(?:⛔|🔄|✅)\s*(RETRYABLE|RE-READ REQUIRED|ALREADY APPLIED)\s*—\s*([^\n]*)/;
const GUARD_DUPLICATE = /appears (\d+) times/;

function guardDiagnosis(out: string, base: { exit: number | null; body: string; intent: string }): Diagnosis | null {
  const head = GUARD_HEAD.exec(out);
  if (!head) return null;
  const kind = head[1];
  const headText = head[2].trim();
  const say = (title: string, cause: string, effect: string, improve?: string): Diagnosis => ({ ...base, level: "benign", title, cause, effect, ...(improve ? { improve } : {}) });

  if (kind === "ALREADY APPLIED")
    return say(
      tr("这处改动其实已经生效过，不用再提交"),
      tr("相同的 oldText 之前就应用过，重复提交会被拒"),
      tr("改动早就在文件里了，这次没有重复写"),
      tr("先确认这一处是否已改过，别重复提交"),
    );
  if (kind === "RE-READ REQUIRED")
    return say(
      tr("这段原文你已经试过一次，还是对不上"),
      tr("同样的 oldText 提交过还是没匹配上，说明凭记忆写的版本是错的"),
      tr("文件一个字节没动"),
      tr("同一段 oldText 别再原样重试，先重读文件"),
    );

  if (headText.startsWith("Edit target not found")) {
    const dup = GUARD_DUPLICATE.exec(out);
    if (dup)
      return say(
        tr("要替换的原文在文件里有 {p1} 处一模一样", { p1: dup[1] }),
        tr("工具不敢猜你要改哪一处，只能先拒掉"),
        tr("文件一个字节没动"),
        tr("oldText 带上下一行做唯一匹配"),
      );
    if (/could not be mapped to one raw file span/.test(out))
      return say(
        tr("这段原文能对上，但定位不到唯一的行"),
        tr("匹配到的内容跨在行尾、空白这类没法精确框定的地方"),
        tr("文件一个字节没动"),
        tr("oldText 只取连续完整的行"),
      );
    if (/was not found in the current file content/.test(out))
      return say(
        tr("要替换的原文在文件里找不到"),
        tr("oldText 要逐字节匹配：文件可能已被改过，或被空白、引号、全角半角绊住"),
        tr("文件一个字节没动"),
        tr("oldText 从刚 read 到的原文复制"),
      );
    return say(tr("要替换的原文没对上"), tr("工具在文件里定位不到这段 oldText"), tr("文件一个字节没动"), tr("oldText 从刚 read 到的原文复制"));
  }

  if (headText.startsWith("Edit without read")) {
    if (/you have not read/.test(headText))
      return say(
        tr("没读过这个文件，工具不让改"),
        tr("规矩是先 read 再 edit；用 bash 的 cat / sed / grep 看过的不算读过"),
        tr("文件一个字节没动"),
        tr("改文件前先 read 一遍；bash 里 cat / sed 看过的不算"),
      );
    if (/only covered part of/.test(headText))
      return say(
        tr("只改过这个文件的一部分，盖不住这次要改的位置"),
        tr("上一次写只覆盖了其中几行，缺的正好是这次要改的地方"),
        tr("文件一个字节没动"),
        tr("read 的范围要盖住要改的那几行"),
      );
    if (/write record .*expired/.test(headText))
      return say(
        tr("之前写过它，但写记录过期了，得重新读"),
        tr("写记录会按闲置时间过期（默认 30 分钟），过期后要重新读一次"),
        tr("文件一个字节没动"),
        tr("长时间空闲后先 read 再改"),
      );
    return say(tr("没读过这个文件，工具不让改"), tr("工具的 read 守卫先拦住了这次编辑"), tr("文件一个字节没动"), tr("改文件前先 read 一遍"));
  }

  if (headText.startsWith("File modified since your write"))
    return say(
      tr("你写之后文件又被改过，内容对不上了"),
      tr("会话写下的内容和磁盘上现在的不一致——别人或别的工具改过"),
      tr("这次编辑没有落盘"),
      tr("编辑前先 read 确认磁盘上的现状"),
    );
  if (headText.startsWith("File modified since read"))
    return say(
      tr("文件在你上次读过之后变了"),
      tr("磁盘内容和上次 read 到的不一致，手里的版本已经过期"),
      tr("这次编辑没有落盘"),
      tr("编辑前先 read 确认磁盘上的现状"),
    );
  if (headText.startsWith("Edit outside read range"))
    return say(
      tr("你要改的行不在读过的范围里"),
      tr("只 read 了文件的一段，这次要改的行落在外面"),
      tr("文件一个字节没动"),
      tr("read 覆盖到要改的行再 edit"),
    );
  if (headText.startsWith("Edit range changed since read"))
    return say(
      tr("读过之后，这几行的内容变了"),
      tr("要改的行和读到的内容对不上，可能被改过或整体挪了位置"),
      tr("文件一个字节没动"),
      tr("改之前重新 read 一遍"),
    );
  if (headText.startsWith("Overlapping edit spans"))
    return say(
      tr("同一批修改的行范围互相重叠"),
      tr("两处修改落在同一片行上，工具不知道先改哪个"),
      tr("文件一个字节没动"),
      tr("同一批编辑别落在重叠的行上"),
    );

  return say(
    tr("工具拦住了一次编辑"),
    headText.slice(0, 160) || tr("插件没说明原因"),
    tr("文件一个字节没动"),
  );
}

export function diagnose(input: FailureInput): Diagnosis {
  const out = normalize(input.out);
  const exit = exitCodeOf(out);
  const body = out.replace(TRAILER_TAIL, "").trim();
  const intent = input.intent?.trim() ? clip(input.intent) : inferIntent(input.tool, input.cmd, out);
  const base = { exit, body, intent };
  const say = (level: Level, title: string, cause: string, effect: string, needsYou?: string, improve?: string): Diagnosis => ({
    ...base,
    level,
    title,
    cause,
    effect,
    ...(needsYou ? { needsYou } : {}),
    ...(improve ? { improve } : {}),
  });

  if (/Command aborted/.test(out)) {
    const lines = body ? body.split("\n").length : 0;
    return say(
      "abort",
      tr("命令被中断，没有跑完"),
      tr("手动停止 / 会话被打断 / 超时 —— 不是命令自己报错{p1}", { p1: lines ? tr("（中断前已有 {p1} 行输出）", { p1: lines }) : "" }),
      tr("可能留下写到一半的状态，重跑前先看一眼"),
      undefined,
      tr("长命令拆成几步跑，或给它加超时"),
    );
  }

  const validation = /Validation failed for tool "([^"]+)"/.exec(out);
  if (validation) {
    const items = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "));
    const first = items.slice(0, 3).map((l) => l.slice(2)).join(tr("；"));
    return say(
      "warn",
      tr("参数不合格，{p1} 没执行（{p2} 处）", { p1: validation[1], p2: items.length }),
      first + (items.length > 3 ? " …" : ""),
      tr("工具没执行，什么都没改"),
      undefined,
      tr("按工具 schema 补齐字段——这是调用方要修的，不是环境"),
    );
  }

  const guard = guardDiagnosis(out, base);
  if (guard) return guard;

  // 插件把一条命令拦下来时，返回的往往是它自己的提示语（不是命令的报错）：context-mode 就要求
  // curl 走 MCP / 静默写文件，否则刷爆上下文。这种要看懂它的意思，不能当成「原因没认出来」；
  // 还要把是哪个插件写出来——「插件」两个字对排查没用。
  if (/MCP tools?|floods the context window|instead of inline HTTP clients/i.test(out) && /curl|wget|https?:\/\//i.test(input.cmd)) {
    const pluginName = /Use ([A-Za-z][\w.-]{1,30}) MCP tools/i.exec(out)?.[1] ?? /\b(context-mode|context_mode)\b/i.exec(out)?.[0];
    return say(
      "fail",
      tr("插件拦下了这条命令"),
      pluginName
        ? tr("它直接用 curl 抓网页，被 {p1} 插件拦下了：要求走 MCP 抓取或静默写文件（避免刷爆上下文）", { p1: pluginName })
        : tr("它直接用 curl 抓网页，插件要求走 MCP 抓取或静默写文件（避免刷爆上下文）"),
      tr("命令没执行，什么都没抓到"),
      undefined,
      pluginName
        ? tr("curl 用 `-s -o 文件` 静默写文件，或用 {p1} 的抓取工具", { p1: pluginName })
        : tr("curl 用 `-s -o 文件` 静默写文件，或用插件的抓取工具"),
    );
  }

  // 抓网页被拒：403 最常见，其次是 401（要登录）和 429（限速）。
  const http = /HTTP (\d{3})/.exec(out);
  if (http) {
    const code = http[1];
    const cause =
      code === "401"
        ? tr("这个站点要登录 / 带凭据才能访问，抓取端没有")
        : code === "403"
          ? tr("对方站点不让脚本抓（403），多半在挡爬虫 / 要验证码")
          : code === "429"
            ? tr("对方限速了（429），短时间内请求太多次")
            : tr("对方返回了 {p1}，不是能用的内容", { p1: code });
    return say(
      "fail",
      tr("网站拒绝了这次抓取（{p1}）", { p1: code }),
      cause,
      tr("这个页面没拿到，上下文里缺一块"),
      code === "401" ? tr("这个站点需要登录凭据") : undefined,
      code === "401"
        ? tr("给这个站点配凭据，或换成能登录的抓取方式")
        : code === "403"
          ? tr("挡爬虫的站点别直抓：改用 web_search，或加浏览器 UA")
          : code === "429"
            ? tr("放慢请求节奏，或换个来源")
            : tr("换个来源或稍后重试"),
    );
  }

  // fetch 工具自己的失败：DNS、被墙、TLS、代理没生效，都会长成同一句 "fetch failed"。
  if (/fetch failed|getaddrinfo|ENOTFOUND|ECONNRESET|ERR_TLS|CERT_/i.test(out)) {
    return say(
      "fail",
      tr("没连上这个网站"),
      tr("DNS 解析失败、被墙、证书不对、代理没生效——这几种在 fetch 里都报同一句"),
      tr("这个页面没拿到，上下文里缺一块"),
      tr("确认这台机器能直连这个域名；要走代理就配到 pi 的 httpProxy / HTTPS_PROXY"),
      tr("先 curl -I 试直连；确认要走代理再配 httpProxy / HTTPS_PROXY"),
    );
  }

  // Windows 教程里的 CMD 写法喂给 bash：`date /t`、`%USERPROFILE%`、`>nul`。这不是「路径不存在」，
  // 是「shell 不是它以为的那个」——只看 errno 会把人引去改路径，而真正要改的是命令写法。
  const cmdish = /(^|\s)\/[a-zA-Z](\s|$)/.test(input.cmd) || /%[A-Za-z_]+%/.test(input.cmd);
  if (input.tool === "bash" && cmdish && /invalid date '\/[a-zA-Z]'|: \/[a-zA-Z]+: (?:No such file or directory|command not found)/.test(out))
    return say(
      "fail",
      tr("按 Windows CMD 的写法跑在了 bash 里"),
      tr("`/t` 这类开关是 CMD 的语法：bash 把它当成要执行的路径，于是报「找不到」"),
      tr("命令没跑起来，文件一个没动"),
      undefined,
      tr("bash 里用 `date +%F`；CMD 的 /t 在这里不通用"),
    );

  if (/Could not find (?:the exact text|edits\[\d+\])/.test(out)) {
    const target = /(?:text in|edits\[\d+\] in) (.+?)\. The old text/.exec(out);
    return say(
      "fail",
      tr("没找到要替换的原文，文件没被改"),
      tr("oldText 必须逐字节匹配（含空白、换行、CRLF）{p1}", { p1: target ? tr("。目标：{p1}", { p1: target[1] }) : "" }),
      tr("文件一个字节没动"),
      undefined,
      tr("oldText 用刚 read 到的原文，别凭记忆"),
    );
  }

  const errLine = lastMatch(/^[A-Za-z_][\w.]*(?:Error|Exception)\b/, out);
  if (errLine) {
    const kind = /^([A-Za-z_][\w.]*(?:Error|Exception))/.exec(errLine)![1];
    return say(
      "fail",
      tr("Python 脚本报错：{p1}", { p1: kind }),
      PY_CAUSE[kind] ?? tr("程序抛了异常，栈顶在 Traceback 里"),
      tr("脚本中途退出，它前面几步可能已经写过文件"),
      undefined,
      PY_FIX[kind] ?? tr("看 Traceback 最后三行定位到文件:行再改"),
    );
  }

  // 127/126 是「命令没起来」（找不到命令 / 没执行权），此时 ENOENT 说的是那条命令本身，
  // 不是「你要的路径不存在」——交给兵底句解释，别把人引去改路径。
  const errno = exit === 127 || exit === 126 ? undefined : ERRNO.find(([re]) => re.test(out));
  if (errno) {
    const where = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => errno[0].test(l));
    return say("fail", errno[1], where ? tr("{p1}：{p2}", { p1: errno[2], p2: where.slice(0, 120) }) : errno[2], errno[3], undefined, errno[4]);
  }

  if (/Failed to connect|Could not resolve host|unable to access|SSL_ERROR|Proxy CONNECT aborted/i.test(out)) {
    return say(
      "fail",
      tr("网络不通，没连上对方"),
      // D114: 不再断言「本机直连是断的、要走 18791」——那只是作者那台机器的情况，
      // 在能直连的机器上这句会把人引到一个根本不存在的代理上。
      tr("连接失败：先确认这台机器能直连对方（curl -I https://github.com）"),
      tr("这条请求没拿到结果"),
      tr("确实要走代理时，填到 pi 的 httpProxy 设置或 HTTPS_PROXY 环境变量"),
      tr("先 curl -I 验证直连；要走代理就配 httpProxy / HTTPS_PROXY"),
    );
  }

  const gitFatal = lastMatch(/^fatal: /, out);
  if (gitFatal) {
    const known = GIT_CAUSE.find(([re]) => re.test(gitFatal));
    return say("fail", tr("git 拒绝了这条命令"), known ? known[1] : gitFatal, known ? known[2] : tr("仓库没变"), undefined, known ? known[3] : undefined);
  }

  const crossLine = lastMatch(/^✗ /, out);
  if (crossLine) {
    const problems = /(\d+) 个问题/.exec(out);
    return say(
      "fail",
      crossLine.replace(/^✗\s*/, "").slice(0, 90),
      problems ? tr("自检脚本报了 {p1} 个问题（第一个在上面）", { p1: problems[1] }) : tr("自检脚本判定不一致"),
      tr("自检只说问题，没写文件"),
      undefined,
      tr("按自检提示修；全量清单展开原始输出看"),
    );
  }

  const saysError = /\b(error|failed|fatal|cannot|denied|refused|exception)\b/i.test(body);
  const quiet = body ? body.split("\n").filter((l) => l.trim()).length <= 3 : true;
  if ((exit === 1 || exit === 2) && !saysError && quiet) {
    return say(
      "benign",
      tr("没有结果（exit {p1}），通常不算故障", { p1: exit }),
      tr("grep / rg / ls / find 这类工具「没找到」也返回非 0"),
      tr("只是没搜到，没有副作用"),
    );
  }

  if (exit === 0) {
    return say(
      "warn",
      tr("命令正常退出（exit 0），但被标成了失败"),
      tr("工具报了 isError，输出里没有可识别的错误行"),
      tr("命令已经执行完，改动是真实的"),
    );
  }

  const firstBad = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /\b(error|failed|fatal|cannot|denied|refused|exception)\b/i.test(l));
  // 127/126 是「命令根本没起来」，跟「跑到一半失败」是两件事——一个没副作用，一个可能写了一半。
  const neverStarted = exit === 127 || exit === 126;
  return say(
    "fail",
    exit === null
      ? tr("工具报错，原因没认出来")
      : neverStarted
        ? tr("命令没跑起来（exit {p1}）", { p1: exit })
        : tr("命令失败（exit {p1}）", { p1: exit }),
    firstBad ? firstBad.slice(0, 160) : tr("这段输出里没认出错误关键词，原文在最下面"),
    exit === null
      ? tr("这次调用没生效")
      : neverStarted
        ? tr("命令没跑起来，文件一个没动")
        : tr("命令中途失败，可能留下改了一半的状态"),
    undefined,
    neverStarted ? tr("确认命令存在，且 shell 是对的（bash / cmd）") : undefined,
  );
}

const HIT =
  /\b(?:error|failed|fatal|cannot|no such|denied|refused|timed out|exception|must have)\b|Could not find|Validation failed|✗|×/i;
/**
 * errno（ENOENT / EACCES…）单独一条、**大小写敏感**：并进上面那条带 /i 的分支会命中普通标识符，
 * `edits`（E-dit-s）和 `assertThat` 里的 `ertThat` 都被当「关键行」标红过。
 */
const ERRNO_LINE = /\bE[A-Z]{3,}\b/;

/**
 * Key lines only: a traceback collapses to its tail, everything else to the lines that fired the
 * diagnosis plus one line of context each. The trailer is dropped — the exit code is already in
 * the card header, repeating it as the last line is pure noise.
 */
export function excerpt(out: unknown): Excerpt {
  const lines = normalize(out).split("\n");
  const isHit = (i: number) => (HIT.test(lines[i]) || ERRNO_LINE.test(lines[i])) && !TRAILER.test(lines[i]);
  const keep = new Map<number, boolean>();

  const add = (i: number, hit: boolean) => {
    if (i < 0 || i >= lines.length) return;
    if (TRAILER.test(lines[i])) return;
    if (lines[i].trim() === "") return;
    keep.set(i, keep.get(i) === true || hit);
  };

  // 编辑守卫的多行报错（`Edit target not found` 的冲突位置图）：它的线索是 header + 「appears N
  // times」+ `• Line 180:` + 带 ← match 的那几行，而不是别的行里有没有 error 字样。
  const guardHead = lines.findIndex((l) => GUARD_HEAD.test(l));
  if (guardHead >= 0) {
    const DETAIL = /^edits\[\d+\]\.oldText|\bappears \d+ times\b|was not found in the current file content|could not be mapped to one raw file span/;
    const OCCURRENCE = /^\s*• Line \d+:/;
    const MATCH_MARK = /← match/;
    const ROW = /^\s*\d+ │ /;
    const WHY = /^\s*You (?:last read|read|are editing)\b|^Read the relevant section|^Re-read the/;
    /** 守卫自带的那行 `read path=… offset=… limit=…`：能直接拷贝执行的，值得给。 */
    const STEP = /^\s*(?:\d+\.\s+)?`?read path=/;
    add(guardHead, true);
    lines.forEach((line, i) => {
      if (i === guardHead) return;
      if (DETAIL.test(line.trim()) || OCCURRENCE.test(line)) add(i, true);
      else if (MATCH_MARK.test(line)) {
        add(i, true);
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= lines.length || !ROW.test(lines[j])) continue;
          if (/… \(\d+ more line\)/.test(lines[j])) continue;
          if (/^\s*\d+ │ \s*$/.test(lines[j])) continue;
          add(j, false);
        }
      } else if (WHY.test(line) || STEP.test(line)) add(i, false);
    });
    return { lines, keep: [...keep.entries()].sort((a, b) => a[0] - b[0]) };
  }

  if (lines.some((l) => /Traceback \(most recent call last\)/.test(l))) {
    let start = lines.length - 1;
    while (start > 0 && !/^[A-Za-z_][\w.]*(?:Error|Exception)\b/.test(lines[start].trim())) start--;
    for (let i = Math.max(start - 3, 0); i < lines.length; i++) add(i, isHit(i));
  } else {
    const hits = lines.map((_, i) => i).filter(isHit);
    for (const i of hits.slice(0, 4)) {
      add(i - 1, false);
      add(i, true);
      add(i + 1, false);
    }
    if (keep.size === 0) {
      // Nothing matched: the last couple of real lines are the best clue available.
      const tail: number[] = [];
      for (let i = lines.length - 1; i >= 0 && tail.length < 2; i--) {
        if (lines[i].trim() === "" || TRAILER.test(lines[i])) continue;
        tail.push(i);
      }
      for (const i of tail.reverse()) add(i, false);
    }
  }

  return { lines, keep: [...keep.entries()].sort((a, b) => a[0] - b[0]) };
}

/** How many non-blank, non-trailer lines the raw output has (for the "共 N 行" footer). */
export function lineCount(lines: string[]): number {
  return lines.filter((l) => l.trim() !== "" && !TRAILER.test(l)).length;
}

/**
 * Failure diagnosis: turn a raw tool failure into "what happened / why / what next".
 *
 * The bridge gives us only `isError` + the tool's text output (`bridge/src/sessions.ts:596-625`):
 * no exit code field, no separate stderr. But pi appends a fixed trailer to every bash result
 * (`Command exited with code N` / `Command aborted`), and the text itself carries the rest.
 * Measured over the 512 distinct failures in `~/.pi/agent/sessions`: exit 1 dominates (grep/ls
 * "not found" — not a real fault), then `XxxError:` tracebacks, edit misses, errno, validation,
 * interruptions. Each of those needs a different judgement, which is why a generic
 * "命令执行失败" is useless and this table exists.
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
}

export interface Diagnosis {
  level: Level;
  /** One sentence: what happened. This is the line the user reads first. */
  title: string;
  /** Why it happened. */
  cause: string;
  /** What to do about it. */
  next: string;
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
  fail: "失败",
  warn: "可疑",
  benign: "多半正常",
  abort: "已中断",
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

const PY_CAUSE: Record<string, string> = {
  UnicodeDecodeError: "按默认编码（本机 GBK）读了 UTF-8 / 二进制文件",
  UnicodeEncodeError: "按 GBK 编码写出，但内容里有无 GBK 字符",
  ModuleNotFoundError: "依赖没装，或跑在了别的 Python 环境里",
  FileNotFoundError: "路径不存在（相对路径的 cwd 可能不是你以为的那个）",
  AssertionError: "断言失败：程序跑到这行时假设不成立",
  ParserError: "解析失败：输入格式不对，或流式数据被截断",
  SyntaxError: "语法错误：转义写坏了，或多/少了括号",
  TypeError: "类型不对：参数个数或类型不匹配",
  AttributeError: "对象没有这个属性，多半是接口变了或返回了 null",
  NameError: "变量没定义（笔误，或该在的作用域里没有）",
  KeyError: "字典里没这个键，输入结构跟预期不符",
};

/** [match, title, why, next] — errno families worth naming. */
const ERRNO: Array<[RegExp, string, string, string]> = [
  [/ENOENT|No such file or directory/, "找不到文件 / 目录", "这个路径不存在", "确认拼写；相对路径要看 cwd 是不是你以为的那个"],
  [/EACCES|Permission denied/, "没有权限读写", "权限不足，被系统挡住了", "换个可写目录，或改文件权限 / 用管理员终端"],
  [/EADDRINUSE|address already in use/i, "端口被占用", "要绑的端口已经有人在用了", "netstat -ano 找出占用的 PID，杀掉或换端口"],
  [/ECONNREFUSED|Connection refused/, "对方端口没开", "连得到主机，但那个端口没服务在听", "确认服务起来了、端口号对不对"],
  [/ETIMEDOUT|timed out/i, "等到超时", "等太久没有响应，多半是卡住了", "拆小一点重跑，看卡在哪一步"],
];

const GIT_CAUSE: Array<[RegExp, string, string]> = [
  [/not a git repository/i, "当前目录不在 git 仓库里（cwd 不对）", "cd 到仓库根目录，或确认这个子目录有没有自己的 .git"],
  [/would be overwritten by merge/i, "工作区有未提交的改动挡着", "先 commit 或 stash，再 pull"],
  [/has no upstream branch/i, "分支还没有上游", "git push -u origin <分支名>"],
  [/did not match any file/i, "路径 / 分支名写错了", "核对名字，或 git ls-files 看一眼"],
];

export function diagnose(input: FailureInput): Diagnosis {
  const out = normalize(input.out);
  const exit = exitCodeOf(out);
  const body = out.replace(TRAILER_TAIL, "").trim();
  const base = { exit, body };

  if (/Command aborted/.test(out)) {
    const lines = body ? body.split("\n").length : 0;
    return {
      ...base,
      level: "abort",
      title: "命令被中断，没有跑完",
      cause: `手动停止 / 会话被打断 / 超时 —— 不是命令自己报错${lines ? `（中断前已有 ${lines} 行输出）` : ""}`,
      next: "只关心结果就重跑一次；这轮不看了也可以",
    };
  }

  const validation = /Validation failed for tool "([^"]+)"/.exec(out);
  if (validation) {
    const items = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "));
    const first = items.slice(0, 3).map((l) => l.slice(2)).join("；");
    return {
      ...base,
      level: "warn",
      title: `参数不合格，${validation[1]} 没执行（${items.length} 处）`,
      cause: first + (items.length > 3 ? " …" : ""),
      next: "补上这些字段再调一次 —— 这是调用方的问题，不是你的环境坏了",
    };
  }

  if (/Could not find (?:the exact text|edits\[\d+\])/.test(out)) {
    const target = /(?:text in|edits\[\d+\] in) (.+?)\. The old text/.exec(out);
    return {
      ...base,
      level: "fail",
      title: "没找到要替换的原文，文件没被改",
      cause: `oldText 必须逐字节匹配（含空白、换行、CRLF）${target ? `。目标：${target[1]}` : ""}`,
      next: "先 read 一遍确认现状（可能已被改过），再用更短、更独特的片段作 oldText",
    };
  }

  const errLine = lastMatch(/^[A-Za-z_][\w.]*(?:Error|Exception)\b/, out);
  if (errLine) {
    const kind = /^([A-Za-z_][\w.]*(?:Error|Exception))/.exec(errLine)![1];
    const hint =
      kind === "UnicodeDecodeError" || kind === "UnicodeEncodeError"
        ? "显式指定 encoding='utf-8'（或 errors='replace'）"
        : "看下面 Traceback 最后三行，定位到具体文件:行";
    return {
      ...base,
      level: "fail",
      title: `Python 报错：${kind}`,
      cause: PY_CAUSE[kind] ?? "程序抛了异常，栈顶在 Traceback 里",
      next: hint,
    };
  }

  const errno = ERRNO.find(([re]) => re.test(out));
  if (errno) {
    const where = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => errno[0].test(l));
    return { ...base, level: "fail", title: errno[1], cause: where ? `${errno[2]}：${where.slice(0, 120)}` : errno[2], next: errno[3] };
  }

  if (/Failed to connect|Could not resolve host|unable to access|SSL_ERROR|Proxy CONNECT aborted/i.test(out)) {
    return {
      ...base,
      level: "fail",
      title: "网络不通，没连上对方",
      cause: "连接失败（本机直连 GitHub 是断的，要走 127.0.0.1:18791 代理）",
      next: "带代理重试：git -c http.https://github.com/.proxy=http://127.0.0.1:18791 push；或先 curl 验证代理在不在",
    };
  }

  const gitFatal = lastMatch(/^fatal: /, out);
  if (gitFatal) {
    const known = GIT_CAUSE.find(([re]) => re.test(gitFatal));
    return {
      ...base,
      level: "fail",
      title: "git 拒绝执行",
      cause: known ? known[1] : gitFatal,
      next: known ? known[2] : "看下面完整输出",
    };
  }

  const crossLine = lastMatch(/^✗ /, out);
  if (crossLine) {
    const problems = /(\d+) 个问题/.exec(out);
    return {
      ...base,
      level: "fail",
      title: crossLine.replace(/^✗\s*/, "").slice(0, 90),
      cause: problems ? `自检脚本报了 ${problems[1]} 个问题（第一个在上面）` : "自检脚本判定不一致",
      next: "按提示跑修复命令；要全量清单就展开原始输出",
    };
  }

  const saysError = /\b(error|failed|fatal|cannot|denied|refused|exception)\b/i.test(body);
  const quiet = body ? body.split("\n").filter((l) => l.trim()).length <= 3 : true;
  if ((exit === 1 || exit === 2) && !saysError && quiet) {
    return {
      ...base,
      level: "benign",
      title: `没有结果（exit ${exit}），通常不算故障`,
      cause: "grep / rg / ls / find 这类工具「没找到」也返回非 0",
      next: "换个关键词或路径再看；真报错会带上 error / fatal 字样",
    };
  }

  if (exit === 0) {
    return {
      ...base,
      level: "warn",
      title: "命令正常退出（exit 0），但被标成了失败",
      cause: "工具报了 isError，输出里没有可识别的错误行",
      next: "展开原始输出看看",
    };
  }

  const firstBad = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /\b(error|failed|fatal|cannot|denied|refused|exception)\b/i.test(l));
  return {
    ...base,
    level: "fail",
    title: exit === null ? "工具报错" : `命令失败（exit ${exit}）`,
    cause: firstBad ? firstBad.slice(0, 160) : "输出里没有明显错误行，可能失败原因在上一段里",
    next: "看下面完整输出；说不清就问 pi",
  };
}

const HIT =
  /\b(?:error|failed|fatal|cannot|no such|denied|refused|timed out|exception|must have)\b|Could not find|Validation failed|E[A-Z]{3,}\b|✗|×/i;

/**
 * Key lines only: a traceback collapses to its tail, everything else to the lines that fired the
 * diagnosis plus one line of context each. The trailer is dropped — the exit code is already in
 * the card header, repeating it as the last line is pure noise.
 */
export function excerpt(out: unknown): Excerpt {
  const lines = normalize(out).split("\n");
  const isHit = (i: number) => HIT.test(lines[i]) && !TRAILER.test(lines[i]);
  const keep = new Map<number, boolean>();

  const add = (i: number, hit: boolean) => {
    if (i < 0 || i >= lines.length) return;
    if (TRAILER.test(lines[i])) return;
    if (lines[i].trim() === "") return;
    keep.set(i, keep.get(i) === true || hit);
  };

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


import { tr } from "./i18n/index.ts";

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

/** [match, title, why, next] — errno families worth naming. */
const ERRNO: Array<[RegExp, string, string, string]> = [
  [/ENOENT|No such file or directory/, tr("找不到文件 / 目录"), tr("这个路径不存在"), tr("确认拼写；相对路径要看 cwd 是不是你以为的那个")],
  [/EACCES|Permission denied/, tr("没有权限读写"), tr("权限不足，被系统挡住了"), tr("换个可写目录，或改文件权限 / 用管理员终端")],
  [/EADDRINUSE|address already in use/i, tr("端口被占用"), tr("要绑的端口已经有人在用了"), tr("netstat -ano 找出占用的 PID，杀掉或换端口")],
  [/ECONNREFUSED|Connection refused/, tr("对方端口没开"), tr("连得到主机，但那个端口没服务在听"), tr("确认服务起来了、端口号对不对")],
  [/ETIMEDOUT|timed out/i, tr("等到超时"), tr("等太久没有响应，多半是卡住了"), tr("拆小一点重跑，看卡在哪一步")],
];

const GIT_CAUSE: Array<[RegExp, string, string]> = [
  [/not a git repository/i, tr("当前目录不在 git 仓库里（cwd 不对）"), tr("cd 到仓库根目录，或确认这个子目录有没有自己的 .git")],
  [/would be overwritten by merge/i, tr("工作区有未提交的改动挡着"), tr("先 commit 或 stash，再 pull")],
  [/has no upstream branch/i, tr("分支还没有上游"), tr("git push -u origin <分支名>")],
  [/did not match any file/i, tr("路径 / 分支名写错了"), tr("核对名字，或 git ls-files 看一眼")],
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

function guardDiagnosis(out: string, base: { exit: number | null; body: string }): Diagnosis | null {
  const head = GUARD_HEAD.exec(out);
  if (!head) return null;
  const kind = head[1];
  const headText = head[2].trim();
  const say = (title: string, cause: string, next: string): Diagnosis => ({ ...base, level: "benign", title, cause, next });

  if (kind === "ALREADY APPLIED")
    return say(
      tr("这处改动其实已经生效过，不用再提交"),
      tr("相同的 oldText 之前就应用过，重复提交会被拒"),
      tr("跳过这一步，接着做后面的"),
    );
  if (kind === "RE-READ REQUIRED")
    return say(
      tr("这段原文你已经试过一次，还是对不上"),
      tr("同样的 oldText 提交过还是没匹配上，说明凭记忆写的版本是错的"),
      tr("重读文件，照磁盘上的内容重建 oldText；别再原样重试"),
    );

  if (headText.startsWith("Edit target not found")) {
    const dup = GUARD_DUPLICATE.exec(out);
    if (dup)
      return say(
        tr("要替换的原文在文件里有 {p1} 处一模一样", { p1: dup[1] }),
        tr("工具不敢猜你要改哪一处，只能先拒掉"),
        tr("oldText 上下多带一行做唯一匹配（消息里已给出冲突行号）"),
      );
    if (/could not be mapped to one raw file span/.test(out))
      return say(
        tr("这段原文能对上，但定位不到唯一的行"),
        tr("匹配到的内容跨在行尾、空白这类没法精确框定的地方"),
        tr("把 oldText 收成一段完整、连续的行再发"),
      );
    if (/was not found in the current file content/.test(out))
      return say(
        tr("要替换的原文在文件里找不到"),
        tr("oldText 要逐字节匹配：文件可能已被改过，或被空白、引号、全角半角绊住"),
        tr("重读目标那几行，照着磁盘上的原文重写 oldText"),
      );
    return say(tr("要替换的原文没对上"), tr("工具在文件里定位不到这段 oldText"), tr("重读目标那几行，再照着原文写 oldText"));
  }

  if (headText.startsWith("Edit without read")) {
    if (/you have not read/.test(headText))
      return say(
        tr("没读过这个文件，工具不让改"),
        tr("规矩是先 read 再 edit；用 bash 的 cat / sed / grep 看过的不算读过"),
        tr("先 read 要改的那几行，再原样重发这次 edit（消息里给了现成命令）"),
      );
    if (/only covered part of/.test(headText))
      return say(
        tr("只改过这个文件的一部分，盖不住这次要改的位置"),
        tr("上一次写只覆盖了其中几行，缺的正好是这次要改的地方"),
        tr("先 read 这次要改的那段，再重发 edit"),
      );
    if (/write record .*expired/.test(headText))
      return say(
        tr("之前写过它，但写记录过期了，得重新读"),
        tr("写记录会按闲置时间过期（默认 30 分钟），过期后要重新读一次"),
        tr("重新 read 这个文件，再改"),
      );
    return say(tr("没读过这个文件，工具不让改"), tr("工具的 read 守卫先拦住了这次编辑"), tr("先 read 要改的那几行，再原样重发这次 edit"));
  }

  if (headText.startsWith("File modified since your write"))
    return say(
      tr("你写之后文件又被改过，内容对不上了"),
      tr("会话写下的内容和磁盘上现在的不一致——别人或别的工具改过"),
      tr("重新 read 现状，再改"),
    );
  if (headText.startsWith("File modified since read"))
    return say(
      tr("文件在你上次读过之后变了"),
      tr("磁盘内容和上次 read 到的不一致，手里的版本已经过期"),
      tr("重新 read 现状，再改"),
    );
  if (headText.startsWith("Edit outside read range"))
    return say(
      tr("你要改的行不在读过的范围里"),
      tr("只 read 了文件的一段，这次要改的行落在外面"),
      tr("read 目标行附近再改（消息里给了 offset / limit）"),
    );
  if (headText.startsWith("Edit range changed since read"))
    return say(
      tr("读过之后，这几行的内容变了"),
      tr("要改的行和读到的内容对不上，可能被改过或整体挪了位置"),
      tr("重新 read 目标行，再按现在的内容改"),
    );
  if (headText.startsWith("Overlapping edit spans"))
    return say(
      tr("同一批修改的行范围互相重叠"),
      tr("两处修改落在同一片行上，工具不知道先改哪个"),
      tr("合并成一次修改再发"),
    );

  return say(
    tr("工具拦住了一次编辑"),
    headText.slice(0, 160) || tr("插件没说明原因"),
    tr("按消息里的提示改完再重试（这类拦截可以重试）"),
  );
}

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
      title: tr("命令被中断，没有跑完"),
      cause: tr("手动停止 / 会话被打断 / 超时 —— 不是命令自己报错{p1}", { p1: lines ? tr("（中断前已有 {p1} 行输出）", { p1: lines }) : "" }),
      next: tr("只关心结果就重跑一次；这轮不看了也可以"),
    };
  }

  const validation = /Validation failed for tool "([^"]+)"/.exec(out);
  if (validation) {
    const items = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "));
    const first = items.slice(0, 3).map((l) => l.slice(2)).join(tr("；"));
    return {
      ...base,
      level: "warn",
      title: tr("参数不合格，{p1} 没执行（{p2} 处）", { p1: validation[1], p2: items.length }),
      cause: first + (items.length > 3 ? " …" : ""),
      next: tr("补上这些字段再调一次 —— 这是调用方的问题，不是你的环境坏了"),
    };
  }

  const guard = guardDiagnosis(out, base);
  if (guard) return guard;

  if (/Could not find (?:the exact text|edits\[\d+\])/.test(out)) {
    const target = /(?:text in|edits\[\d+\] in) (.+?)\. The old text/.exec(out);
    return {
      ...base,
      level: "fail",
      title: tr("没找到要替换的原文，文件没被改"),
      cause: tr("oldText 必须逐字节匹配（含空白、换行、CRLF）{p1}", { p1: target ? tr("。目标：{p1}", { p1: target[1] }) : "" }),
      next: tr("先 read 一遍确认现状（可能已被改过），再用更短、更独特的片段作 oldText"),
    };
  }

  const errLine = lastMatch(/^[A-Za-z_][\w.]*(?:Error|Exception)\b/, out);
  if (errLine) {
    const kind = /^([A-Za-z_][\w.]*(?:Error|Exception))/.exec(errLine)![1];
    const hint =
      kind === "UnicodeDecodeError" || kind === "UnicodeEncodeError"
        ? tr("显式指定 encoding='utf-8'（或 errors='replace'）")
        : tr("看下面 Traceback 最后三行，定位到具体文件:行");
    return {
      ...base,
      level: "fail",
      title: tr("Python 报错：{p1}", { p1: kind }),
      cause: PY_CAUSE[kind] ?? tr("程序抛了异常，栈顶在 Traceback 里"),
      next: hint,
    };
  }

  const errno = ERRNO.find(([re]) => re.test(out));
  if (errno) {
    const where = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => errno[0].test(l));
    return { ...base, level: "fail", title: errno[1], cause: where ? tr("{p1}：{p2}", { p1: errno[2], p2: where.slice(0, 120) }) : errno[2], next: errno[3] };
  }

  if (/Failed to connect|Could not resolve host|unable to access|SSL_ERROR|Proxy CONNECT aborted/i.test(out)) {
    return {
      ...base,
      level: "fail",
      title: tr("网络不通，没连上对方"),
      // D114: 不再断言「本机直连是断的、要走 18791」——那只是作者那台机器的情况，
      // 在能直连的机器上这句会把人引到一个根本不存在的代理上。
      cause: tr("连接失败：先确认这台机器能直连对方（curl -I https://github.com）；确实要走代理时，填到 pi 的 httpProxy 设置或 HTTPS_PROXY 环境变量"),
      next: tr("重试一次；仍然不通就换网络或代理：git -c http.https://github.com/.proxy=<你的代理> push"),
    };
  }

  const gitFatal = lastMatch(/^fatal: /, out);
  if (gitFatal) {
    const known = GIT_CAUSE.find(([re]) => re.test(gitFatal));
    return {
      ...base,
      level: "fail",
      title: tr("git 拒绝执行"),
      cause: known ? known[1] : gitFatal,
      next: known ? known[2] : tr("看下面完整输出"),
    };
  }

  const crossLine = lastMatch(/^✗ /, out);
  if (crossLine) {
    const problems = /(\d+) 个问题/.exec(out);
    return {
      ...base,
      level: "fail",
      title: crossLine.replace(/^✗\s*/, "").slice(0, 90),
      cause: problems ? tr("自检脚本报了 {p1} 个问题（第一个在上面）", { p1: problems[1] }) : tr("自检脚本判定不一致"),
      next: tr("按提示跑修复命令；要全量清单就展开原始输出"),
    };
  }

  const saysError = /\b(error|failed|fatal|cannot|denied|refused|exception)\b/i.test(body);
  const quiet = body ? body.split("\n").filter((l) => l.trim()).length <= 3 : true;
  if ((exit === 1 || exit === 2) && !saysError && quiet) {
    return {
      ...base,
      level: "benign",
      title: tr("没有结果（exit {p1}），通常不算故障", { p1: exit }),
      cause: tr("grep / rg / ls / find 这类工具「没找到」也返回非 0"),
      next: tr("换个关键词或路径再看；真报错会带上 error / fatal 字样"),
    };
  }

  if (exit === 0) {
    return {
      ...base,
      level: "warn",
      title: tr("命令正常退出（exit 0），但被标成了失败"),
      cause: tr("工具报了 isError，输出里没有可识别的错误行"),
      next: tr("展开原始输出看看"),
    };
  }

  const firstBad = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /\b(error|failed|fatal|cannot|denied|refused|exception)\b/i.test(l));
  return {
    ...base,
    level: "fail",
    title: exit === null ? tr("工具报错") : tr("命令失败（exit {p1}）", { p1: exit }),
    cause: firstBad ? firstBad.slice(0, 160) : tr("这段输出里没认出错误关键词，原文在最下面"),
    next: tr("先展开完整输出；还看不懂就把这段贴给 pi"),
  };
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

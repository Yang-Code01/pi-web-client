/**
 * 本项目的 `CHANGELOG.md` 解析（D195 的写法 → 结构化批次，给设置页与启动弹窗共用）。
 *
 * 这里只做**纯解析**：不读盘、不起进程，测试直接喂字符串。读文件与问 git 在 `whatsnew.ts`。
 *
 * 文件约定（`docs/agents` 与 `.pi/skills/whatsnew-write` 都这么写）：
 *
 * ```
 * ## 2026-11-24 · 主题（#658、D400）      ← 一批；未发布的那几批写成 `## 未发布 · …`
 * 这一批要重装，先别走热部署。            ← 引言（可省，可以是 `> ` 引用或普通段落）
 * ### 新增                                ← 组：新增 / 修复 / 设计决定
 * - 说结果，不说过程 #658 D400            ← 条目；结尾的引用逐个空格分开
 * ```
 */

export type LogGroupKind = "new" | "fix" | "design";

export interface LogRef {
  kind: "pr" | "d";
  n: number;
}

export interface LogItem {
  /** 去掉结尾引用之后的行内 markdown。 */
  md: string;
  /** 结尾那串 `#N` / `D#`，按原文顺序。 */
  refs: LogRef[];
}

export interface LogGroup {
  kind: LogGroupKind;
  items: LogItem[];
}

export interface LogBatch {
  /** 在这份日志里的序号（0 是最新的一批），滚动锚点用它。 */
  id: string;
  /** `2026-11-24`；未发布批次是 null。 */
  date: string | null;
  /** 二级标题原文（含括号里的引用，标题就是这批的身份，不拆）。 */
  title: string;
  /** 批内引言；没有就是 null。 */
  intro: string | null;
  /** 引言原文是不是 `> ` 引用（弹窗与设置页给它不同的底色）。 */
  introQuoted: boolean;
  unpublished: boolean;
  groups: LogGroup[];
}

export interface LogMonth {
  /** `2026-11`：滚动定位用。 */
  key: string;
  year: number;
  month: number;
  /** 这个月里有多少批。 */
  count: number;
}

export interface SelfLog {
  stats: {
    batches: number;
    items: number;
    /** 不同的 PR 号有几个。 */
    prs: number;
    /** 未发布的批数（左栏那一条要用）。 */
    unpublished: number;
  };
  /** 有批次的月份，新→旧。 */
  months: LogMonth[];
  /** 文件顺序（最新在前，未发布通常最前）。 */
  batches: LogBatch[];
}

const GROUP_KINDS: Record<string, LogGroupKind> = {
  新增: "new",
  修复: "fix",
  设计决定: "design",
  设计: "design",
};

/** 结尾的引用：` #671` / ` D365`，按原文顺序收。 */
function splitRefs(raw: string): LogItem {
  let md = raw.trim();
  const refs: LogRef[] = [];
  for (;;) {
    const m = /\s(?:#(\d+)|D(\d+))$/.exec(md);
    if (!m) break;
    refs.unshift(m[1] ? { kind: "pr", n: Number(m[1]) } : { kind: "d", n: Number(m[2]) });
    md = md.slice(0, m.index).trimEnd();
  }
  return { md: md.trim(), refs };
}

/** `## ` 那一行 → 日期 + 标题 + 是不是未发布。 */
function splitHead(line: string): { date: string | null; title: string; unpublished: boolean } {
  const dated = /^(\d{4})-(\d{2})-(\d{2})\s*(?:·\s*(.*))?$/.exec(line);
  if (dated) return { date: `${dated[1]}-${dated[2]}-${dated[3]}`, title: (dated[4] ?? "").trim(), unpublished: false };
  if (/^未发布/.test(line)) {
    // `## 未发布` 与 `## 未发布 · 主题` 都算未发布；「未发布」这个词本身不当标题用。
    const rest = line.replace(/^未发布\s*(?:·\s*)?/, "").trim();
    return { date: null, title: rest, unpublished: true };
  }
  return { date: null, title: line, unpublished: true };
}

/**
 * 解析整份日志。空白 / 没有 `## ` 的文件返回空表（页面自己画空态）。
 *
 * HTML 注释（`<!-- 写到 <SHA> -->` 这类机器锚点）在这里抹掉：它们不是给人看的内容。
 */
export function parseSelfLog(text: string): SelfLog {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const batches: LogBatch[] = [];
  let cur: LogBatch | null = null;
  let group: LogGroup | null = null;
  let intro: string[] = [];
  let introQuoted = false;
  /** 条目换行写时接着上一行（日志里现在没有，但手写难免）。 */
  let last: LogItem | null = null;

  const flushIntro = (): void => {
    const joined = intro.join("\n").trim();
    // 只在真攒了东西时抹上去：批次收尾时会再 flush 一次，不能把已经落好的引言冲成 null。
    if (cur && joined) {
      cur.intro = joined;
      cur.introQuoted = introQuoted;
    }
    intro = [];
    introQuoted = false;
  };
  const flushGroup = (): void => {
    if (cur && group && group.items.length) cur.groups.push(group);
    group = null;
    last = null;
  };
  const flushBatch = (): void => {
    flushIntro();
    flushGroup();
    if (cur && (cur.groups.length || cur.intro || cur.title)) batches.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const head = /^##\s+(.+?)\s*$/.exec(line);
    if (head) {
      flushBatch();
      const { date, title, unpublished } = splitHead(head[1]);
      cur = { id: String(batches.length), date, title, intro: null, introQuoted: false, unpublished, groups: [] };
      continue;
    }
    if (!cur) continue; // 文档大标题与开头那段说明
    const sub = /^###\s+(.+?)\s*$/.exec(line);
    if (sub) {
      flushIntro();
      flushGroup();
      group = { kind: GROUP_KINDS[sub[1].trim()] ?? "new", items: [] };
      continue;
    }
    if (!line.trim()) {
      last = null;
      // 引言里的空行留着，段落之间不该粘成一句。
      if (!group && intro.length) intro.push("");
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      // 第一条 `- ` 之前的内容算引言（普通段落也行，不只 `> `）。
      if (!group) {
        intro.push(line);
        continue;
      }
      last = splitRefs(item[1]);
      group.items.push(last);
      continue;
    }
    if (!group) {
      if (/^>\s?/.test(line)) {
        introQuoted = true;
        intro.push(line.replace(/^>\s?/, ""));
      } else {
        intro.push(line.trimEnd());
      }
      continue;
    }
    if (last) {
      // 续行的末尾可能才带着引用（手写时容易这样），合并后再拆一次。
      const merged = splitRefs(`${last.md} ${line.trim()}`);
      last.md = merged.md;
      last.refs = merged.refs;
    }
  }
  flushBatch();

  // 未发布批次没有日期，不参与月份统计。
  const byMonth = new Map<string, LogMonth>();
  let items = 0;
  let unpublished = 0;
  const prs = new Set<number>();
  for (const b of batches) {
    if (b.unpublished || !b.date) {
      unpublished += 1;
      continue;
    }
    const key = b.date.slice(0, 7);
    const hit = byMonth.get(key);
    if (hit) hit.count += 1;
    else {
      const [y, m] = key.split("-");
      byMonth.set(key, { key, year: Number(y), month: Number(m), count: 1 });
    }
  }
  for (const b of batches) {
    for (const g of b.groups) {
      items += g.items.length;
      for (const it of g.items) for (const r of it.refs) if (r.kind === "pr") prs.add(r.n);
    }
  }
  const months = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  return { stats: { batches: batches.length, items, prs: prs.size, unpublished }, months, batches };
}

/**
 * `git remote get-url origin` 的输出 → `{owner, name}`；不是 GitHub 或认不出来就是 null。
 * 认的三个形状：`git@github.com:O/R.git`、`https://github.com/O/R.git`、`ssh://git@github.com/O/R.git`。
 */
export function repoFromRemote(url: string): { owner: string; name: string } | null {
  const s = url.trim();
  const m =
    /^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s) ??
    /^ssh:\/\/git@([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s) ??
    /^https?:\/\/(?:[^@/]+@)?([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  // 只认 GitHub：别的主机上 `#671` 拼不出能点的 PR 地址，宁可退成纯文本。
  if (!m || !/(^|\.)github\.com$/i.test(m[1])) return null;
  return { owner: m[2], name: m[3] };
}

/**
 * 输入框 `/` 菜单的过滤与排序（#25，D152）。
 *
 * 名字优先，描述兜底：只要名字有命中，就不拿描述来凑数。描述是自然语言，`hand` 会命中
 * `handle` / `handles` / `Hand the current…`，敲三个字母整个技能表都亮着，等于没过滤
 * （2026-11-06 用户报障：`/hand` 下列表照旧是六个互不相干的技能）。
 *
 * 名字这一侧还要认命名空间：pi 把技能报成 `skill:handoff`，人敲的是 `hand`，所以匹配
 * 看的是冒号后面那段（尾巴），而不是整串；尾巴内部再按 `:` `-` `_` `.` 空白切词，`/hand`
 * 能命中 `claude-handoff` 里的 `handoff`。用户自己敲了 `skill:` 也照样能剥掉，
 * `/skill:hand` 和 `/hand` 是一回事。
 */
export type CommandItem = { insert: string; label: string; desc?: string; tag?: string };

/** 菜单最多列这么多行（空输入和窄查询都按它截）。 */
const MAX_ITEMS = 40;
/** 尾巴切词：命名空间之外还有这些分隔符，`claude-handoff` / `foo_bar` / `a.b` 都算两个词。 */
const WORDS = /[:._\-\s]+/;
const words = (s: string) => s.split(WORDS).filter(Boolean);

/**
 * 名字命中的档位，越小越靠前；-1 = 没命中。
 *
 * 约定：`label` 带前导 `/`（`CommandItem` 都是这么拼的），`q` 已经小写、没有空白
 * （调用方 `app.ts` 的正则 `^\/([^\s]*)$` 挡住空白）。
 */
function nameRank(label: string, q: string): number {
  const name = label.slice(1).toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  // 只看第一个冒号：`mcp:tool:read` 的尾巴是 `tool:read`，敲 `/tool` 也认。
  const colon = name.indexOf(":");
  const tail = colon < 0 ? name : name.slice(colon + 1);
  // 命名空间是可选的：敲了就剥掉（`/skill:hand`），没敲就整串当查询（`/hand`）。
  // 无论哪种，命名空间本身都不参与子串匹配 —— 否则 `/kill` 会命中每一个 `skill:`。
  const ns = colon < 0 ? "" : name.slice(0, colon + 1);
  return tailRank(tail, ns && q.startsWith(ns) ? q.slice(ns.length) : q);
}

/** 尾巴这一侧的阶梯：前缀 → 某个词的前缀 → 包含。`t` 为空（只敲了 `skill:`）时前缀恒真。 */
function tailRank(tail: string, t: string): number {
  if (tail.startsWith(t)) return 2;
  if (words(tail).some((w) => w.startsWith(t))) return 3;
  return tail.includes(t) ? 4 : -1;
}

export function filterCommands(all: CommandItem[], query: string): CommandItem[] {
  const q = query.toLowerCase();
  if (!q) return all.slice(0, MAX_ITEMS);
  const named = all
    .map((item, i) => ({ item, i, rank: nameRank(item.label, q) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, MAX_ITEMS)
    .map((x) => x.item);
  if (named.length) return named;
  // 名字一个都没中才看描述；两个字母连描述也不看，否则半个技能表都能中。
  // 查描述用剥掉命名空间后的那段：`/skill:document` 该去描述里找 `document`。
  const colon = q.indexOf(":");
  const bare = colon < 0 ? q : q.slice(colon + 1);
  if (bare.length < 3) return [];
  return all.filter((x) => (x.desc ?? "").toLowerCase().includes(bare)).slice(0, MAX_ITEMS);
}

/**
 * 面板命令（#293）：顶栏那几颗按钮可以在「外观与语言」里关掉，关掉之后这三条斜杠命令是找回来的路。
 *
 * `id` 就是 `app.ts` 动作表（`runAction` / 快捷键）的动作 id —— 命令不另写一套打开逻辑，
 * 只把同一个动作叫一遍。`desc` 是中文原文键，和快捷键表里那三行的字一致（`tr` 在 app.ts 里翻）；
 * `label` 则由 id 拼成 `/<id>`，所以补全里敲 `/term` 就能选中 `/terminal`。
 */
export type PanelCommand = { id: "terminal" | "files" | "artifacts"; desc: string };
export const PANEL_COMMANDS: PanelCommand[] = [
  { id: "terminal", desc: "打开终端" },
  { id: "files", desc: "文件管理器" },
  { id: "artifacts", desc: "产物列表" },
];
